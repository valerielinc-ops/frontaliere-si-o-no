#!/usr/bin/env node
/**
 * Globus job parser — Fetcher and job builder.
 *
 * Source: https://jobs.globus.ch/stellenangebote.html
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGlobusJobs()  — Fetch and parse all jobs
 *   - isGlobusJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GLOBUS_KEY = 'globus';
export const GLOBUS_COMPANY_NAME = 'Globus';
export const GLOBUS_COMPANY_DOMAIN = 'globus.ch';

const CAREER_URL = 'https://jobs.globus.ch/stellenangebote.html';
// rexx Systems ATS host that actually serves the job postings (same registrable
// domain as the primary, but kept explicit for clarity / future-proofing).
const ATS_HOST = 'jobs.globus.ch';
const SECTOR = 'Retail (department store / luxury)';

// HQ fallback (Impressum: Lintheschergasse 7, CH-8001 Zürich, canton ZH).
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8001',
  addressRegion: 'Zürich',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Globus.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGlobusJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GLOBUS_KEY ||
    key.startsWith('globus') ||
    company.includes('globus') ||
    url.includes('globus.ch')
  );
}

/**
 * Validate that a URL belongs to Globus's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'globus.ch' ||
      host.endsWith('.globus.ch') || // covers the rexx ATS host jobs.globus.ch
      host === ATS_HOST
    );
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

// rexx Systems ATS (custom-html). No JSON/XML feed exists, so we crawl in two
// steps:
//   1. GET the listing page → extract distinct job-detail URLs.
//   2. GET each detail page → parse the <script type="application/ld+json">
//      JobPosting (full PostalAddress, title, datePosted, employmentType, …).
// The whole board is Switzerland-only (Globus is a CH department-store chain),
// so no country filter is needed.

/** Extract distinct job-detail URLs from the listing HTML. */
function extractDetailUrls(html = '') {
  const urls = new Set();
  const re = /href="(https:\/\/jobs\.globus\.ch\/[^"]*-j\d+\.html)"/g;
  let m;
  while ((m = re.exec(html)) !== null) urls.add(m[1]);
  return [...urls];
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

async function fetchJobListings() {
  console.log(`   Fetching listing: ${CAREER_URL}`);

  let listingHtml = '';
  try {
    listingHtml = await fetchHtml(CAREER_URL, { headers: { 'User-Agent': UA } });
  } catch (err) {
    console.warn(`  ⚠️ Failed to fetch listing: ${err.message}`);
    return [];
  }

  const detailUrls = extractDetailUrls(listingHtml);
  console.log(`   Detail URLs: ${detailUrls.length}`);

  const listings = [];
  for (const url of detailUrls) {
    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(url, { headers: { 'User-Agent': UA } });
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch ${url}: ${err.message}`);
      continue;
    }

    const posting = extractJobPosting(detailHtml);
    if (!posting?.title) continue;

    const address = posting.jobLocation?.address || {};
    const locality = address.addressLocality || '';
    listings.push({
      title: posting.title,
      url,
      location: locality || HQ.city,
      description: posting.description || '',
      postedAt: posting.datePosted || '',
      employmentType: posting.employmentType || '',
      streetAddress: address.streetAddress || '',
      postalCode: address.postalCode || '',
      addressRegion: address.addressRegion || '',
      jobReqId: (url.match(/-j(\d+)\.html$/) || [])[1] || '',
    });

    await new Promise((r) => setTimeout(r, 300)); // polite rate limit
  }

  return listings;
}

/**
 * Fetch all Globus jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGlobusJobs() {
  console.log(`🔍 Fetching Globus jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = normalizeSpace(listing.location || HQ.city);
    // Whole board is CH-only; infer canton from the locality, fall back to HQ.
    const canton = inferSwissTargetCanton(location) || HQ.canton;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} globus ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    // baseSalary is null at source → safe default (omit, never fabricate).
    // Prefer the canonical schema.org employmentType from the JSON-LD; otherwise
    // infer from the title (workload % cues like "80-100%").
    const rawEmp = (listing.employmentType || '').toUpperCase();
    const employmentType = rawEmp.includes('PART')
      ? 'PART_TIME'
      : rawEmp.includes('FULL')
        ? 'FULL_TIME'
        : detectEmploymentType(title);

    const job = {
      // ── Required fields ──
      id: `globus-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GLOBUS_COMPANY_NAME,
      companyKey: GLOBUS_KEY,
      companyDomain: GLOBUS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${GLOBUS_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${GLOBUS_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'Globus Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      streetAddress: listing.streetAddress || '',
      postalCode: listing.postalCode || HQ.postalCode,
      addressRegion: listing.addressRegion || HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Globus jobs discovered: ${jobs.length}`);
  return jobs;
}
