#!/usr/bin/env node
/**
 * Migros HQ Zürich job parser — jobs.migros.ch sitemap + JSON-LD consumer.
 *
 * Source: https://jobs.migros.ch/de/sitemap.xml
 *
 * Migros-Genossenschafts-Bund (the HQ / national holding entity, Limmatstrasse
 * 152, 8005 Zürich) publishes its openings on the same Nuxt SSR portal as every
 * other Migros group company, under the `/unsere-unternehmen/job/
 * migros-genossenschafts-bund/<title-slug>/<uuid>` path. We scope to that one
 * company slug so this crawler stays HQ-only (#3797).
 *
 * NOTE (2026-07): the previous SmartRecruiters tenant
 * (api.smartrecruiters.com/v1/companies/Migros) is dead — `totalFound: 0` on
 * every query, and jobs.smartrecruiters.com/Migros 30x-redirects to the
 * generic SmartRecruiters homepage (the confirmed dead-tenant signature in
 * this codebase). This file now sources live data from jobs.migros.ch instead.
 *
 * The JSON-LD `description` field on jobs.migros.ch detail pages is only a
 * brief overview teaser (~400 chars observed) — the full responsibilities /
 * requirements / benefits content lives in HTML `<section>` blocks. We reuse
 * `./migros-job-parser.mjs`'s `extractMigrosStructuredData()` (already built
 * for exactly this on the same portal) rather than duplicating that parsing.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMigrosHqJobs()  — Fetch and parse all jobs
 *   - isMigrosHqJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { extractMigrosStructuredData } from './migros-job-parser.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MIGROS_HQ_KEY = 'migros-hq';
export const MIGROS_HQ_COMPANY_NAME = 'Migros HQ Zürich';
export const MIGROS_HQ_COMPANY_DOMAIN = 'migros.ch';

const SITEMAP_URL = 'https://jobs.migros.ch/de/sitemap.xml';
// Company slug segment that scopes this crawler to Migros-Genossenschafts-Bund
// (HQ) only — every other slug in the sitemap (genossenschaft-migros-zurich,
// denner-ag, galaxus, …) belongs to a different group company/co-op and is
// out of scope here (some are covered by the sibling `migros-ticino` crawler,
// see scripts/update-migros-jobs.mjs).
const COMPANY_PATH_SEGMENT = '/job/migros-genossenschafts-bund/';
// A trailing UUID-shaped segment is the reliable signal of an actual job
// posting — non-job company/brand pages (e.g. "arbeiten-bei-uns") don't have
// one.
const JOB_URL_RE = /\/unsere-unternehmen\/job\/migros-genossenschafts-bund\/[^/]+\/[0-9a-f-]{20,}\/?$/i;

// HQ fallback (Impressum: Limmatstrasse 152, CH-8005 Zürich, canton ZH).
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8005',
  addressRegion: 'Zürich',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Migros HQ Zürich.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMigrosHqJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MIGROS_HQ_KEY ||
    key.startsWith('migros-hq') ||
    company.includes('migros hq') ||
    url.includes('migros.ch') ||
    url.includes('migros.com')
  );
}

/**
 * Validate that a URL belongs to Migros HQ Zürich's domain.
 * Migros HQ is published on jobs.migros.ch, the same Nuxt SSR portal used by
 * every Migros group company — this crawler scopes to the
 * migros-genossenschafts-bund company slug (see COMPANY_PATH_SEGMENT above).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'migros.ch' || host.endsWith('.migros.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch the sitemap and extract distinct Migros-Genossenschafts-Bund job
 * detail URLs.
 *
 * The sitemap lists every job across every Migros group company; we filter
 * to the `/job/migros-genossenschafts-bund/` path segment (present regardless
 * of locale prefix — some sitemap entries omit the leading `/de/`) and to
 * URLs ending in a UUID-shaped id, which excludes non-job company/brand pages
 * (e.g. "arbeiten-bei-uns", "karrieremoeglichkeiten").
 */
async function fetchHqJobUrls() {
  console.log(`  📄 Fetching sitemap: ${SITEMAP_URL}`);
  const xml = await fetchHtml(SITEMAP_URL, { headers: { Accept: 'application/xml,text/xml,*/*' } });

  const allUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
  const jobUrls = [...new Set(allUrls.filter((url) => url.includes(COMPANY_PATH_SEGMENT) && JOB_URL_RE.test(url)))];

  console.log(`  📦 Migros HQ (migros-genossenschafts-bund) job URLs in sitemap: ${jobUrls.length}`);
  return jobUrls;
}

/** Parse the first JobPosting JSON-LD block from a detail page's HTML. */
function extractJobPosting(html = '') {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : data?.['@graph'] || [data];
    for (const item of items) {
      if (item?.['@type'] === 'JobPosting') return item;
    }
  }
  return null;
}

async function fetchJobListings(jobUrls) {
  const listings = [];

  for (const url of jobUrls) {
    let html = '';
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch ${url}: ${err.message}`);
      continue;
    }

    const posting = extractJobPosting(html);
    if (!posting?.title) {
      console.warn(`  ⚠️ No JobPosting JSON-LD found: ${url}`);
      continue;
    }

    const address = posting.jobLocation?.address || {};
    // The JSON-LD `description` is a brief overview teaser only — prefer the
    // fuller HTML section content (responsibilities/requirements/benefits)
    // extracted by the shared migros-job-parser.mjs helper, falling back to
    // the JSON-LD description when the page doesn't expose those sections.
    const structured = extractMigrosStructuredData(html);
    const description = structured?.description || posting.description || '';

    listings.push({
      title: posting.title,
      url,
      description,
      postedAt: posting.datePosted || '',
      employmentType: posting.employmentType || '',
      streetAddress: address.streetAddress ? normalizeSpace(address.streetAddress) : '',
      postalCode: address.postalCode || '',
      addressLocality: address.addressLocality || '',
    });

    await new Promise((r) => setTimeout(r, 300)); // polite rate limit
  }

  return listings;
}

/**
 * Fetch all Migros HQ Zürich jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMigrosHqJobs() {
  console.log(`🔍 Fetching Migros HQ Zürich jobs`);
  console.log(`   Source: ${SITEMAP_URL}\n`);

  const jobUrls = await fetchHqJobUrls();
  if (!jobUrls || jobUrls.length === 0) {
    console.warn('⚠️ No Migros HQ job URLs found in sitemap.');
    return [];
  }

  const listings = await fetchJobListings(jobUrls);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings parsed.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const locality = normalizeSpace(listing.addressLocality || '');
    // All migros-genossenschafts-bund postings are HQ Zürich; prefer resolving
    // canton from the JSON-LD locality, falling back to the HQ default.
    const canton = (locality && inferAnyCanton(locality)) || HQ.canton;
    const location = locality || HQ.city;
    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} migros-hq ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const rawEmp = (listing.employmentType || '').toUpperCase();
    const employmentType = rawEmp.includes('PART')
      ? 'PART_TIME'
      : rawEmp.includes('FULL') || rawEmp.includes('FESTANSTELLUNG')
        ? 'FULL_TIME'
        : detectEmploymentType(listing.employmentType || title);

    const job = {
      // ── Required fields ──
      id: `migros-hq-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MIGROS_HQ_COMPANY_NAME,
      companyKey: MIGROS_HQ_KEY,
      companyDomain: MIGROS_HQ_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${MIGROS_HQ_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${MIGROS_HQ_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'Migros HQ Zürich Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      streetAddress: listing.streetAddress || '',
      postalCode: listing.postalCode || HQ.postalCode,
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Retail',
      currency: 'CHF',
      featured: false,
      postedDate: (listing.postedAt || new Date().toISOString()).slice(0, 10),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      // baseSalary: no numeric value at source (JSON-LD only sets currency +
      // unitText, no `value`) → safe default is to omit rather than fabricate,
      // same convention as scripts/lib/globus-job-parser.mjs.
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Migros HQ Zürich jobs discovered: ${jobs.length}`);
  return jobs;
}
