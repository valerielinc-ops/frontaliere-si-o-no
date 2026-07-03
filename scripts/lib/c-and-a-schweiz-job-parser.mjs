#!/usr/bin/env node
/**
 * C&A Schweiz job parser — Fetcher and job builder.
 *
 * Source: https://www.c-and-a.com/ch/de/corporate/company/jobs
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCAndASchweizJobs()  — Fetch and parse all jobs
 *   - isCAndASchweizJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const C_AND_A_SCHWEIZ_KEY = 'c-and-a-schweiz';
export const C_AND_A_SCHWEIZ_COMPANY_NAME = 'C&A Schweiz';
export const C_AND_A_SCHWEIZ_COMPANY_DOMAIN = 'c-and-a.com';

const CAREER_URL = 'https://www.c-and-a.com/ch/de/corporate/company/jobs';

// C&A's corporate site (SvelteKit) exposes its job board through two
// bespoke JSON endpoints (no public REST/OData ATS API — apply links
// resolve to a SuccessFactors instance, career5.successfactors.eu, but
// listing + detail data only exist on this custom front end):
//   1. POST <CAREER_URL>?/loadMoreJobs  (SvelteKit form action) — paginated
//      job listing, filterable by `locations` (ISO country codes).
//   2. GET  <job detail page>/__data.json — full job detail (description,
//      city/zip, apply URL) for a single slug, also SvelteKit-native.
const LOAD_MORE_URL = `${CAREER_URL}?/loadMoreJobs`;
const DETAIL_BASE_URL = 'https://www.c-and-a.com/ch/de/corporate/company/careers/jobs';
const PAGE_SIZE = 50;
const REQUEST_HEADERS = {
  'User-Agent': 'FrontaliereTicino-JobCrawler/2.0',
  Accept: 'application/json',
  Origin: 'https://www.c-and-a.com',
  Referer: `${CAREER_URL}?jobs_location=CH`,
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
 * Check if a job belongs to C&A Schweiz.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCAndASchweizJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === C_AND_A_SCHWEIZ_KEY ||
    key.startsWith('c-and-a-schweiz') ||
    company.includes('c&a schweiz') ||
    url.includes('c-and-a.com')
  );
}

/**
 * Validate that a URL belongs to C&A Schweiz's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'c-and-a.com' || host.endsWith('.c-and-a.com');
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

/* ── SvelteKit "devalue" flat-array un-flattener ──────────────────────
 * C&A's corporate site ships its server-loaded page data as a flat array
 * of values where object/array entries reference other array indices
 * (the `devalue` serialization format used internally by SvelteKit).
 * There is no `devalue` package in this repo, so this minimal generic
 * resolver reconstructs the nested object graph from index 0 (root).
 * Cycles are guarded against via `seen` (not expected in this payload,
 * but cheap to protect against). */
function unflattenDevalue(flat) {
  function resolve(index, seen) {
    if (typeof index !== 'number') return index;
    if (seen.has(index)) return seen.get(index);
    const raw = flat[index];
    if (Array.isArray(raw)) {
      const arr = [];
      seen.set(index, arr);
      for (const ref of raw) arr.push(resolve(ref, seen));
      return arr;
    }
    if (raw && typeof raw === 'object') {
      const obj = {};
      seen.set(index, obj);
      for (const key of Object.keys(raw)) obj[key] = resolve(raw[key], seen);
      return obj;
    }
    return raw;
  }
  return resolve(0, new Map());
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch one page of the CH job listing via the `loadMoreJobs` SvelteKit
 * form action. Returns `{ jobsTotalCount, jobs }` where each job is a
 * thin listing record: { title, slug, tags (locations), locale, category }.
 */
async function fetchJobListingsPage(offset) {
  const body = new URLSearchParams();
  body.set('offset', String(offset));
  body.set('categories', '[]');
  body.set('locations', '["CH"]');
  body.set('limit', String(PAGE_SIZE));

  const res = await fetch(LOAD_MORE_URL, {
    method: 'POST',
    headers: {
      ...REQUEST_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-sveltekit-action': 'true',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on loadMoreJobs offset=${offset}`);

  const payload = await res.json();
  if (payload?.type !== 'success' || typeof payload?.data !== 'string') {
    throw new Error(`Unexpected loadMoreJobs response shape at offset=${offset}`);
  }
  const flat = JSON.parse(payload.data);
  const root = unflattenDevalue(flat);
  return {
    jobsTotalCount: Number(root?.jobsTotalCount || 0),
    jobs: Array.isArray(root?.jobs) ? root.jobs : [],
  };
}

/** Fetch every CH job listing across all pages. */
async function fetchAllJobListings() {
  const all = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const { jobsTotalCount, jobs } = await fetchJobListingsPage(offset);
    total = jobsTotalCount;
    if (jobs.length === 0) break;
    all.push(...jobs);
    offset += jobs.length;
    await new Promise((r) => setTimeout(r, 250)); // Rate limiting
  }
  return all;
}

/**
 * Fetch the full detail record for a single job slug: description HTML,
 * city/postal code, ISO posted date and the real (SuccessFactors) apply URL.
 */
async function fetchJobDetail(slug) {
  const res = await fetch(`${DETAIL_BASE_URL}/${slug}/__data.json`, {
    headers: REQUEST_HEADERS,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on job detail ${slug}`);

  const payload = await res.json();
  const pageNode = Array.isArray(payload?.nodes)
    ? payload.nodes.find((node) => Array.isArray(node?.data) && node.data.some(
      (entry) => entry && typeof entry === 'object' && 'jobID' in entry,
    ))
    : null;
  if (!pageNode) return null;

  const root = unflattenDevalue(pageNode.data);
  const chLocation = root?.locations?.CH?.[0] || null;

  return {
    descriptionHtml: root?.description || '',
    city: chLocation?.city || '',
    postalCode: chLocation?.zipCode || '',
    createdIsoDate: root?.createdIsoDate || '',
    applyNowUrl: root?.applyNowUrl || '',
    jobLocale: root?.jobLocale || '',
  };
}

/**
 * Fetch all C&A Schweiz jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCAndASchweizJobs() {
  console.log(`🔍 Fetching C&A Schweiz jobs`);
  console.log(`   Source: ${CAREER_URL} (locations=["CH"])\n`);

  const listings = await fetchAllJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    const slug = listing.slug || '';
    if (!title || title.length < 3 || !slug) continue;

    const publicUrl = `${DETAIL_BASE_URL}/${slug}`;

    let detail = null;
    try {
      detail = await fetchJobDetail(slug);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${slug}: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 250)); // Rate limiting

    const rawLocationTag = Array.isArray(listing.tags) ? listing.tags[0] : '';
    const city = detail?.city || String(rawLocationTag || '').replace(/\s*\(CH\)\s*$/i, '').trim() || 'Zürich';
    const location = `${city} (CH)`;
    const canton = inferAnyCanton(city) || inferAnyCanton(rawLocationTag) || '';

    const descriptionHtml = detail?.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} c-and-a-schweiz ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `c-and-a-schweiz-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: C_AND_A_SCHWEIZ_COMPANY_NAME,
      companyKey: C_AND_A_SCHWEIZ_KEY,
      companyDomain: C_AND_A_SCHWEIZ_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — C&A Schweiz`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — C&A Schweiz` },
      location,
      canton,
      url: publicUrl,
      source: 'C&A Schweiz Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode: detail?.postalCode || '',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Commercio al dettaglio',
      currency: 'CHF',
      featured: false,
      postedDate: detail?.createdIsoDate || new Date().toISOString().split('T')[0],
      applyUrl: detail?.applyNowUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total C&A Schweiz jobs discovered: ${jobs.length}`);
  return jobs;
}
