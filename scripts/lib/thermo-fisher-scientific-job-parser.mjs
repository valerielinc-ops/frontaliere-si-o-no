#!/usr/bin/env node
/**
 * Thermo Fisher Scientific (Schweiz) AG job parser — Fetcher and job builder.
 *
 * Source: https://jobs.thermofisher.com/global/en/switzerland
 *
 * Career site runs on Phenom People (CareerConnect) — same widgets JSON
 * API pattern as Givaudan (scripts/lib/givaudan-job-parser.mjs). The
 * search widget returns listing teasers and a direct `applyUrl` that
 * points straight at the underlying Workday tenant
 * (thermofisher.wd5.myworkdayjobs.com) — verified live. The full
 * structured job description is only available on the Phenom detail
 * page (schema.org JobPosting JSON-LD), so we fetch that per-job.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllThermoFisherScientificJobs()  — Fetch and parse all jobs
 *   - isThermoFisherScientificJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { htmlToMarkdown } from './axpo-job-parser.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const THERMO_FISHER_SCIENTIFIC_KEY = 'thermo-fisher-scientific';
export const THERMO_FISHER_SCIENTIFIC_COMPANY_NAME = 'Thermo Fisher Scientific (Schweiz) AG';
export const THERMO_FISHER_SCIENTIFIC_COMPANY_DOMAIN = 'thermofisher.com';

const CAREER_URL = 'https://jobs.thermofisher.com/global/en/switzerland';
// Phenom People (CareerConnect) widgets endpoint.
const WIDGETS_URL = 'https://jobs.thermofisher.com/widgets';
const JOB_DETAIL_BASE = 'https://jobs.thermofisher.com/global/en/job';
const PAGE_SIZE = 50;

const HQ = { city: 'Reinach', canton: 'BL', postalCode: '4153', addressRegion: 'Basel-Landschaft' };

/** @param {string} locality @param {string} canton @param {string} [sourcePostalCode] */
export function thermoFisherPostalCode(locality, canton, sourcePostalCode = '') {
  return normalizeSpace(sourcePostalCode)
    || (canton === HQ.canton && normalize(locality) === normalize(HQ.city) ? HQ.postalCode : '');
}
const SECTOR = 'Life Sciences — Pharma Manufacturing & Quality';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Thermo Fisher Scientific (Schweiz) AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isThermoFisherScientificJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === THERMO_FISHER_SCIENTIFIC_KEY ||
    key.startsWith('thermo-fisher-scientific') ||
    company.includes('thermo fisher scientific') ||
    url.includes('thermofisher.com') ||
    url.includes('thermofisher.wd5.myworkdayjobs.com')
  );
}

/**
 * Validate that a URL belongs to Thermo Fisher Scientific (Schweiz) AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'thermofisher.com' ||
      host.endsWith('.thermofisher.com') ||
      host === 'thermofisher.wd5.myworkdayjobs.com'
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
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

function buildWidgetsBody(from) {
  return {
    lang: 'en_global',
    deviceType: 'desktop',
    country: 'global',
    ddoKey: 'refineSearch',
    sortBy: 'Most relevant',
    from,
    jobs: true,
    counts: true,
    size: PAGE_SIZE,
    clearAll: false,
    jdsource: 'facets',
    pageName: 'search-results',
    siteType: 'external',
    keywords: '',
    global: true,
    selected_fields: { country: ['Switzerland'] },
  };
}

/**
 * Only Swiss listings (widget is filtered server-side by country facet,
 * but we re-validate here as a strict CH-only post-filter).
 */
function pickSwissLocation(raw) {
  const country = normalize(raw?.country || '');
  const location = normalizeSpace(raw?.location || raw?.cityStateCountry || '');
  if (country === 'switzerland' || /switzerland/i.test(location)) {
    return location || normalizeSpace(raw?.city || '') || null;
  }
  return null;
}

async function fetchJobListings() {
  console.log(`   Fetching from: ${WIDGETS_URL} (Phenom widgets API)`);

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://jobs.thermofisher.com',
    Referer: CAREER_URL,
    'User-Agent': UA,
  };

  const listings = [];
  let from = 0;
  let totalHits = Infinity;
  let guard = 0;

  while (from < totalHits && guard < 50) {
    guard += 1;
    const payload = await fetchJson(WIDGETS_URL, {
      method: 'POST',
      headers,
      body: buildWidgetsBody(from),
    });
    const refine = payload?.refineSearch;
    const rawJobs = assertJsonListShape(refine?.data, { key: 'jobs', source: 'thermo-fisher-scientific' });
    if (Number.isFinite(Number(refine?.totalHits))) totalHits = Number(refine.totalHits);
    if (rawJobs.length === 0) break;

    for (const raw of rawJobs) {
      const swissLocation = pickSwissLocation(raw);
      if (!swissLocation) continue; // strict CH-only post-filter

      const jobId = String(raw.jobId || raw.reqId || raw.jobSeqNo || '').trim();
      const title = String(raw.title || '').trim();
      if (!jobId || !title) continue;

      const url = `${JOB_DETAIL_BASE}/${jobId}/${slugify(title) || 'job'}`;

      listings.push({
        title,
        location: swissLocation,
        rawLocation: normalizeSpace(raw?.location || raw?.cityStateCountry || raw?.city || ''),
        url,
        applyUrl: raw.applyUrl || url,
        postedAt: raw.postedDate || raw.dateCreated || '',
        description: raw.descriptionTeaser || '',
        jobReqId: jobId,
        category: raw.category || (Array.isArray(raw.multi_category) ? raw.multi_category[0] : ''),
        jobType: raw.type || '',
        postalCode: raw.postalCode || '',
        address: raw.address || '',
      });
    }

    from += PAGE_SIZE;
  }

  return listings;
}

/**
 * Fetch the FULL structured description for one Thermo Fisher job from
 * its Phenom detail page.
 *
 * The listing widget only carries a short flat `descriptionTeaser`
 * (1-2 sentences, no list structure). The SSR detail page (same URL
 * the listing builds) embeds a complete schema.org JobPosting
 * description in a JSON-LD <script> block, with real <ul>/<li>
 * bullets and headings (verified live: ~4500 chars per job). We
 * extract that HTML and convert it to markdown via the shared
 * htmlToMarkdown helper (same pattern used by the Givaudan parser).
 */
async function fetchThermoFisherDetailDescription(detailUrl) {
  try {
    const res = await fetch(detailUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!res.ok) return '';
    const html = await res.text();
    const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of blocks) {
      try {
        const jsonText = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
        const parsed = JSON.parse(jsonText);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const o of candidates) {
          if (String(o?.['@type'] || '').includes('JobPosting') && o?.description) {
            const { markdown } = htmlToMarkdown(String(o.description));
            if (markdown) return markdown;
          }
        }
      } catch {
        /* skip malformed JSON-LD block */
      }
    }
  } catch {
    /* network/timeout → caller falls back to teaser */
  }
  return '';
}

/**
 * Fetch all Thermo Fisher Scientific (Schweiz) AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllThermoFisherScientificJobs() {
  console.log(`🔍 Fetching Thermo Fisher Scientific (Schweiz) AG jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const sourceLocation = normalizeSpace(listing.rawLocation || listing.location || '');
    const geography = resolveSourceBackedSwissGeography(sourceLocation);
    if (!geography) {
      console.warn(`  ⚠️ Thermo Fisher Scientific: skipping unresolvable location "${sourceLocation}" (${title})`);
      continue;
    }
    const { location, canton } = geography;
    const addressLocality = normalizeSpace(location.split(',')[0]);
    const publicUrl = listing.url || CAREER_URL;
    const applyUrl = listing.applyUrl || publicUrl;

    if (seen.has(listing.jobReqId || publicUrl)) continue;
    seen.add(listing.jobReqId || publicUrl);

    // Prefer FULL structured detail-page description (markdown bullets)
    // over the flat listing teaser. Falls back to teaser on any fetch failure.
    const detailMarkdown = await fetchThermoFisherDetailDescription(publicUrl);
    const descriptionText = detailMarkdown || stripHtml(listing.description || '');

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} thermo-fisher-scientific ch`);
    const urlHash = createHash('sha1').update(listing.jobReqId || publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `thermo-fisher-scientific-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: THERMO_FISHER_SCIENTIFIC_COMPANY_NAME,
      companyKey: THERMO_FISHER_SCIENTIFIC_KEY,
      companyDomain: THERMO_FISHER_SCIENTIFIC_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Thermo Fisher Scientific (Schweiz) AG`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Thermo Fisher Scientific (Schweiz) AG` },
      location,
      canton,
      url: publicUrl,
      source: 'Thermo Fisher Scientific (Schweiz) AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality,
      postalCode: thermoFisherPostalCode(addressLocality, canton, listing.postalCode),
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: /part.?time/i.test(listing.jobType || '') ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(`${listing.jobType || ''} ${title}`),
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Thermo Fisher Scientific (Schweiz) AG jobs discovered: ${jobs.length}`);
  return jobs;
}
