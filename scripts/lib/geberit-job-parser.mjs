#!/usr/bin/env node
/**
 * Geberit job parser — Fetcher and job builder.
 *
 * Source: https://jobs.geberit.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGeberitJobs()  — Fetch and parse all jobs
 *   - isGeberitJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GEBERIT_KEY = 'geberit';
export const GEBERIT_COMPANY_NAME = 'Geberit';
export const GEBERIT_COMPANY_DOMAIN = 'geberit.com';

const CAREER_URL = 'https://jobs.geberit.com/';

// HQ fallback (Rapperswil-Jona, SG) per recon.
const HQ = {
  city: 'Rapperswil-Jona',
  canton: 'SG',
  postalCode: '8645',
  addressRegion: 'St. Gallen',
};

const SECTOR = 'Industrial / Sanitary technology (manufacturing)';

// Posting host of the SuccessFactors RMK tenant (branded CNAME).
const ATS_HOST = 'jobs.geberit.com';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Geberit.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGeberitJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GEBERIT_KEY ||
    key.startsWith('geberit') ||
    company.includes('geberit') ||
    url.includes('geberit.com')
  );
}

/**
 * Validate that a URL belongs to Geberit's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Primary domain + subdomains (keeps the unit test green) …
    if (host === 'geberit.com' || host.endsWith('.geberit.com')) return true;
    // … plus the real ATS posting host(s): the branded SuccessFactors RMK
    // tenant (jobs.geberit.com — already covered above) and its underlying
    // SuccessFactors infrastructure.
    if (host === ATS_HOST) return true;
    if (host.endsWith('.successfactors.eu') || host.endsWith('.successfactors.com')) return true;
    return false;
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

/* ── SuccessFactors RMK / Career Site Builder JSON API ─────────
 * The Geberit careers site is a SAP SuccessFactors "Career Site Builder"
 * SPA: search rows and job-detail bodies are rendered client-side from a
 * JSON search API, and the server HTML carries NO JSON-LD and only ~500
 * chars of chrome — the sitemap likewise exposes only title + URL. The SPA
 * itself calls a public Azure-Search-backed endpoint with a publishable
 * api-key embedded in the page; one POST returns the FULL job records
 * (rich HTML description + structured address + dates + job type) for an
 * OData filter, so we query Swiss jobs directly — no headless render, no
 * per-job detail fetch, real descriptions that clear the boilerplate gate.
 */

const SEARCH_API_URL = 'https://production.api.recruiting-solutions.org/search';
// Publishable (pk_) frontend key — the SPA ships it in plain JS; not a secret.
const SEARCH_API_KEY =
  'pk_geberit-prod_wbymYncbyHVbHzffXBqsBBBGQsyWJQEAnbmrthowOTtUchrxCjEEKgKyJvsGlvcfMxGXJpNAbqPTXBgTZQKeldlzFKscNjWJ';
const SEARCH_CUSTOMER_ID = 'geberit-prod';
// OData filter: every job with at least one Swiss address (data label is German "Schweiz").
const SWISS_FILTER = "addresses/any(a: a/country eq 'Schweiz')";
const PAGE_SIZE = 100;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Map a SuccessFactors locale code (de_DE, en_US, fr_FR, it_IT) → our 2-letter locale. */
function localeToLang(code = '') {
  const lc = String(code || '').slice(0, 2).toLowerCase();
  return ['it', 'de', 'fr', 'en'].includes(lc) ? lc : 'de';
}

/**
 * Convert the RMK description HTML (<h2>/<p>/<ul><li>) into markdown so the
 * list/heading structure survives (the parser-quality audit flags flat prose
 * with no bullets). Falls back to a plain-text strip for anything else.
 */
function htmlToMarkdown(html = '') {
  let s = String(html || '');
  s = s.replace(/<\s*(h[1-6])[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (_m, _t, inner) => `\n\n## ${stripHtml(inner).trim()}\n`);
  s = s.replace(/<\s*li[^>]*>([\s\S]*?)<\/\s*li\s*>/gi, (_m, inner) => `\n- ${stripHtml(inner).trim()}`);
  s = s.replace(/<\s*\/\s*(p|div|ul|ol)\s*>/gi, '\n');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = stripHtml(s);
  s = s.replace(/&#13;/g, '').replace(/ /g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/** POST the search API with transient retry. Returns the parsed JSON or throws. */
async function postSearch(body, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(SEARCH_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'x-api-key': SEARCH_API_KEY,
          customerid: SEARCH_CUSTOMER_ID,
          privatejobboard: 'false',
          internal: 'false',
          'User-Agent': UA,
          Referer: CAREER_URL,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from search API`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        // Configurable base delay (matches JOBS_CRAWLER_RETRY_BASE_MS used by
        // transient-fetch.mjs) so tests that deliberately trigger this retry
        // path via a 5xx response don't have to eat the real 1s/2s/4s backoff.
        const baseMs = Number(process.env.JOBS_CRAWLER_RETRY_BASE_MS ?? 1000);
        await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

/** Fetch every Swiss Geberit job record (with full description) from the RMK API. */
async function fetchSwissJobRecords() {
  const collected = [];
  let skip = 0;
  let total = Infinity;
  // Hard cap to avoid a runaway loop if the API ignores skip.
  for (let page = 0; page < 50 && skip < total; page++) {
    const data = await postSearch({
      count: true,
      facets: [],
      search: '*',
      filter: SWISS_FILTER,
      skip,
      top: PAGE_SIZE,
    });
    if (page === 0) total = Number(data?.['@odata.count'] ?? 0);
    const value = Array.isArray(data?.value) ? data.value : [];
    if (value.length === 0) break;
    collected.push(...value);
    skip += value.length;
    if (collected.length >= total) break;
  }
  return collected;
}

/**
 * Fetch all Geberit jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGeberitJobs() {
  console.log(`🔍 Fetching Geberit (Switzerland) jobs`);
  console.log(`   Source: SuccessFactors RMK search API (filter: Swiss addresses)\n`);

  let records;
  try {
    records = await fetchSwissJobRecords();
  } catch (err) {
    console.error(`❌ Failed to fetch Geberit jobs from RMK API: ${err?.message || err}`);
    return [];
  }
  console.log(`  📋 Swiss job records returned: ${records.length}`);

  const jobs = [];
  const seenInternal = new Set();
  // Prefer one locale per physical job: de (CH primary) > it > fr > en.
  const LANG_RANK = { de: 0, it: 1, fr: 2, en: 3 };
  const sorted = [...records].sort(
    (a, b) => (LANG_RANK[localeToLang(a.language)] ?? 9) - (LANG_RANK[localeToLang(b.language)] ?? 9),
  );

  for (const rec of sorted) {
    const title = normalizeSpace(rec.title || '');
    if (!title || title.length < 3) continue;

    // jobId = "<internalId>-<locale>" (e.g. "1799-de_DE"). Dedup physical jobs
    // across locale variants on the internal id.
    const internalId = String(rec.jobId || '').split('-')[0] || String(rec.jobId || '');
    if (!internalId) continue;
    if (seenInternal.has(internalId)) continue;

    // The OData filter `addresses/any(a: a/country eq 'Schweiz')` matches records
    // with *at least one* Swiss address — the Swiss one is not guaranteed to be
    // at index [0] (multi-site records can list a foreign plant first). Pick the
    // Swiss address explicitly so location/postalCode/streetAddress never come
    // from a foreign address and mis-tag a foreign job as CH/SG.
    const addrs = Array.isArray(rec.addresses) ? rec.addresses : [];
    const addr = addrs.find((a) => a && a.country === 'Schweiz') || addrs[0] || {};
    const location = normalizeSpace(addr.city || HQ.city);
    const canton = inferSwissTargetCanton(`${location} ${addr.postalCode || ''}`) || HQ.canton;

    const description = htmlToMarkdown(rec.description || '');
    if (!description || description.length < 30) continue; // skip empties → never synthesise

    seenInternal.add(internalId);

    const sourceLang = localeToLang(rec.language);
    // Keep the ORIGINAL slug formula (`${title} geberit ch`) so already-indexed
    // Geberit URLs do not change — the source swap (sitemap → RMK API) must not
    // re-slug the employer slice (reviewer 🔴 on #1857: a re-slug would orphan the
    // previousSlugs redirect bridge and 404 the old `…-geberit-ch` URLs).
    const jobSlug = slugify(`${title} geberit ch`);
    const id = `geberit-${internalId}`;

    const publicUrl =
      rec.link && /^https?:\/\//i.test(rec.link)
        ? rec.link
        : `https://${ATS_HOST}/job-invite/${internalId}/?locale=${rec.language || 'de_DE'}`;

    const postedDate = String(rec.datePosted || '').slice(0, 10) ||
      new Date().toISOString().split('T')[0];

    const empType = rec?.jobType?.code === 'Full-Time'
      ? 'FULL_TIME'
      : rec?.jobType?.code === 'Part-Time'
        ? 'PART_TIME'
        : detectEmploymentType(`${title} ${rec?.jobType?.label || ''}`);

    const job = {
      // ── Required fields ──
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GEBERIT_COMPANY_NAME,
      companyKey: GEBERIT_KEY,
      companyDomain: GEBERIT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Geberit Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: addr.postalCode || (location === HQ.city ? HQ.postalCode : undefined),
      streetAddress: addr.street || undefined,
      addressRegion: canton === HQ.canton ? HQ.addressRegion : undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      employmentType: empType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Geberit (CH) jobs discovered: ${jobs.length}`);
  return jobs;
}
