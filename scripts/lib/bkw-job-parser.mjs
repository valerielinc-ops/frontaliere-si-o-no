#!/usr/bin/env node
/**
 * BKW job parser — Fetcher and job builder.
 *
 * Source: https://job.bkw.com/?lang=en
 *
 * BKW runs its own prospective.ch "careercenter" (id 1003018) embedded at
 * job.bkw.com. The listing is server-rendered HTML returned by a self-POST
 * form (offset/limit/lang/query/place/radius). limit=2000 returns every open
 * position in one shot. Each job is an <a id="job-{id}"> row carrying
 * data-location / data-workload / title / href (→ /offene-stellen/{slug}/{uuid}).
 *
 * The careercenter is GROUP-WIDE (140+ subsidiaries) and ~half the postings
 * are in Germany/Austria. There is NO working server-side CH filter, so we
 * filter Switzerland-only client-side: the authoritative signal is the
 * job-detail page JSON-LD "addressCountry":"Schweiz". We pre-filter the list
 * by Swiss canton inference (cheap, drops the obvious DE/AT cities) and then
 * confirm each survivor against the detail-page JSON-LD addressCountry.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBkwJobs()  — Fetch and parse all jobs
 *   - isBkwJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BKW_KEY = 'bkw';
export const BKW_COMPANY_NAME = 'BKW';
export const BKW_COMPANY_DOMAIN = 'bkw.ch';

const CAREER_URL = 'https://job.bkw.com/?lang=en';
// The careercenter self-POST endpoint (same URL, POST form). limit=2000
// returns all open positions in a single response.
const LISTING_URL = 'https://job.bkw.com/?lang=en';
const LISTING_HOST = 'job.bkw.com';
const SECTOR = 'Energy / Buildings / Infrastructure (utilities & engineering services)';

// Realistic browser UA — the front (www.bkw.ch) is Akamai-protected and 403s
// generic agents; the careercenter accepts a Safari UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// HQ fallback (BKW Energie AG, Bern) when a detail page omits an address field.
const HQ = { city: 'Bern', canton: 'BE', postalCode: '3013', region: 'Bern' };

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to BKW.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBkwJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BKW_KEY ||
    key.startsWith('bkw') ||
    company.includes('bkw') ||
    url.includes('bkw.ch') ||
    url.includes('job.bkw.com')
  );
}

/**
 * Validate that a URL belongs to BKW's domain (or its careercenter ATS host).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      // Primary domain + subdomains.
      host === 'bkw.ch' ||
      host.endsWith('.bkw.ch') ||
      // Real job-posting host (careercenter) + the prospective.ch ATS that
      // actually serves the listing/redirects.
      host === 'job.bkw.com' ||
      host.endsWith('.bkw.com') ||
      host === 'prospective.ch' ||
      host.endsWith('.prospective.ch')
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

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/**
 * Pull one HTML attribute value out of an <a …> tag string.
 * The leading (?:^|\s) boundary prevents `href` from matching inside
 * `data-href` (the careercenter row carries BOTH attributes).
 */
function attr(tag, name) {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

/**
 * POST the careercenter form and return the raw listing HTML.
 * fetchHtml() is GET-only, so we issue the POST directly here.
 */
async function fetchListingHtml() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(LISTING_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
      },
      body: 'offset=0&limit=2000&lang=en&query=&place=&radius=50000',
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from listing POST`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the careercenter HTML into raw listing rows.
 * Each row: { title, location, url, workload }.
 */
function parseListingRows(html) {
  const rows = [];
  const seen = new Set();
  const ANCHOR_RE = /<a\s+id="job-\d+"[^>]*>/gi;
  let m;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const tag = m[0];
    const url = attr(tag, 'href');
    if (!/^https:\/\/job\.bkw\.com\/offene-stellen\/[a-z0-9-]+\/[0-9a-f-]{36}$/.test(url)) {
      continue;
    }
    if (seen.has(url)) continue; // stable UUID dedup
    seen.add(url);
    rows.push({
      title: attr(tag, 'title'),
      location: attr(tag, 'data-location'),
      workload: attr(tag, 'data-workload'),
      url,
    });
  }
  return rows;
}

/** Extract the JobPosting JSON-LD object from a detail page, or null. */
function extractJobPostingJsonLd(html) {
  const RE = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = RE.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw.includes('JobPosting')) continue;
    try {
      const data = JSON.parse(raw);
      const candidates = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const c of [].concat(candidates)) {
        if (c && c['@type'] === 'JobPosting') return c;
      }
    } catch {
      /* malformed block — skip */
    }
  }
  return null;
}

/**
 * Enrich one listing row by fetching its detail page and reading the
 * authoritative JSON-LD JobPosting. Returns an enriched listing object, or
 * null if the job is not in Switzerland (addressCountry !== "Schweiz") or the
 * detail page can't be read.
 */
async function enrichListing(row) {
  let html;
  try {
    html = await fetchHtml(row.url, { headers: { 'User-Agent': UA } });
  } catch (err) {
    console.warn(`   ⚠️ detail fetch failed (${err.status || err.code || 'err'}): ${row.url}`);
    return null;
  }
  const jp = extractJobPostingJsonLd(html);
  if (!jp) return null;

  const addr = (jp.jobLocation && jp.jobLocation.address) || {};
  const country = String(addr.addressCountry || '').trim();
  // Authoritative Switzerland-only filter.
  if (country && country.toLowerCase() !== 'schweiz') return null;
  // No country in JSON-LD → fall back to the list-anchor canton inference.
  if (!country && !inferSwissTargetCanton(row.location)) return null;

  return {
    title: row.title,
    location: addr.addressLocality || row.location,
    workload: row.workload,
    url: row.url,
    description: jp.description || '',
    postedDate: jp.datePosted || '',
    employmentType: jp.employmentType || '',
    addressLocality: addr.addressLocality || '',
    postalCode: addr.postalCode || '',
    addressRegion: addr.addressRegion || '',
    streetAddress: addr.streetAddress || '',
    jsonLdTitle: jp.title || '',
  };
}

/**
 * Fetch the listing, then enrich + Switzerland-filter each candidate.
 * Returns an array of raw listing objects ready for the assembly loop.
 */
async function fetchJobListings() {
  console.log(`   Fetching listing: POST ${LISTING_URL} (limit=2000)`);
  const html = await fetchListingHtml();
  const rows = parseListingRows(html);
  console.log(`  📋 Listing rows: ${rows.length}`);

  // Cheap pre-filter: drop the obvious German/Austrian cities before we pay
  // for a detail-page fetch. inferSwissTargetCanton returns null for them.
  // (Ambiguous names like "Baden-Baden" survive here but are caught by the
  // authoritative JSON-LD addressCountry check inside enrichListing.)
  const candidates = rows.filter((r) => inferSwissTargetCanton(r.location));
  console.log(`  🇨🇭 Swiss-candidate rows (pre-filter): ${candidates.length}`);

  const enriched = [];
  for (const row of candidates) {
    const job = await enrichListing(row);
    if (job) enriched.push(job);
    await new Promise((r) => setTimeout(r, 250)); // rate limiting
  }
  console.log(`  ✅ Switzerland-confirmed jobs: ${enriched.length}`);
  return enriched;
}

/**
 * Fetch all BKW jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBkwJobs() {
  console.log(`🔍 Fetching ${BKW_COMPANY_NAME} jobs`);
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

    const location = normalizeSpace(listing.location || '') || HQ.city;
    const canton = inferSwissTargetCanton(location) || HQ.canton;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} bkw ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const employmentType =
      listing.employmentType || detectEmploymentType(listing.workload || title);

    const job = {
      // ── Required fields ──
      id: `bkw-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BKW_COMPANY_NAME,
      companyKey: BKW_KEY,
      companyDomain: BKW_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${BKW_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${BKW_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'BKW Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: listing.addressLocality || location,
      postalCode: listing.postalCode || HQ.postalCode,
      addressRegion: listing.addressRegion || HQ.region,
      streetAddress: listing.streetAddress || undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${BKW_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
