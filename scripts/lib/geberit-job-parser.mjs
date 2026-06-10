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
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GEBERIT_KEY = 'geberit';
export const GEBERIT_COMPANY_NAME = 'Geberit';
export const GEBERIT_COMPANY_DOMAIN = 'geberit.com';

const CAREER_URL = 'https://jobs.geberit.com/';
const SITEMAP_URL = 'https://jobs.geberit.com/sitemap.xml';

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

/**
 * City tokens that mark a Swiss job slug per recon. Each entry maps the
 * slug-prefix token to a human-readable location + canton. Order matters:
 * longest/most-specific prefix first so 'Rapperswil-Jona' wins over 'Jona'.
 * German plants (Pfullendorf, Haldensleben, Lichtenstein/Saxony, …) are NOT
 * listed → they fall through the filter and are excluded.
 */
const SWISS_CITY_TOKENS = [
  { token: 'Rapperswil-Jona', location: 'Rapperswil-Jona', canton: 'SG' },
  { token: 'Aussendienst-Schweiz', location: 'Aussendienst Schweiz', canton: null },
  { token: 'Jona', location: 'Jona', canton: 'SG' },
  { token: 'Pfaeffikon', location: 'Pfäffikon', canton: 'SZ' },
  { token: 'Pfäffikon', location: 'Pfäffikon', canton: 'SZ' },
  { token: 'Givisiez', location: 'Givisiez', canton: 'FR' },
];

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

/* ── Sitemap listing fetcher ──────────────────────────────────
 * The Geberit careers site runs on a branded SAP SuccessFactors RMK
 * (jobs2web) tenant. Its search rows are AJAX-injected and the job-detail
 * pages are JS-rendered with NO server-side JSON-LD, so the only reliable
 * machine-readable source is the single sitemap.xml: one <url> block per
 * job, with <loc>.../job/{City-Slug}/{jobId}/</loc> and a <lastmod> date.
 * We derive the title from the slug and the location from the leading city
 * token, filtering to Swiss jobs by that token (recon chFilter).
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Match a Swiss city token at the START of the slug path segment. */
function matchSwissCityToken(slugSegment = '') {
  const seg = String(slugSegment || '');
  for (const entry of SWISS_CITY_TOKENS) {
    if (seg.toLowerCase().startsWith(entry.token.toLowerCase() + '-') ||
        seg.toLowerCase() === entry.token.toLowerCase()) {
      return entry;
    }
  }
  return null;
}

/**
 * Turn the remaining slug (after the city token) into a human title.
 * Slug words are dash-joined and may carry a trailing percentage band
 * (e.g. "...-(a)-80-100" / "...-100"). We keep those — they are part of
 * the real posting title — and just restore spaces.
 */
function slugToTitle(rest = '') {
  return rest
    .split('-')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse <url> blocks out of the sitemap XML. */
function parseSitemap(xml = '') {
  const out = [];
  const blockRe = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const loc = (block.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    const lastmod = (block.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1];
    if (loc) out.push({ loc: loc.trim(), lastmod: (lastmod || '').trim() });
  }
  return out;
}

async function fetchJobListings() {
  let xml;
  try {
    xml = await fetchHtml(SITEMAP_URL, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' } });
  } catch (err) {
    console.error(`❌ Failed to fetch sitemap: ${err?.message || err}`);
    return [];
  }

  const entries = parseSitemap(xml);
  console.log(`  🗺️  Sitemap entries: ${entries.length}`);

  const listings = [];
  for (const { loc, lastmod } of entries) {
    // Path shape: /job/{City-Slug}/{jobId}/
    const pathMatch = loc.match(/\/job\/([^/]+)\/(\d+)\/?$/i);
    if (!pathMatch) continue;

    const rawSlug = pathMatch[1];
    const jobReqId = pathMatch[2];
    // Decode %28a%29 → (a), %C3%B6 → ö, etc.
    let decoded;
    try {
      decoded = decodeURIComponent(rawSlug);
    } catch {
      decoded = rawSlug;
    }

    const cityHit = matchSwissCityToken(decoded);
    if (!cityHit) continue; // non-CH (German plants, Lichtenstein/Saxony, …)

    // Strip the city token prefix to get the title remainder.
    const rest = decoded.slice(cityHit.token.length).replace(/^-+/, '');
    const title = slugToTitle(rest) || cityHit.location;

    listings.push({
      title,
      location: cityHit.location,
      cantonHint: cityHit.canton, // may be null → HQ fallback later
      url: loc,
      postedAt: lastmod || '',
      jobReqId,
    });
  }

  return listings;
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
  console.log(`   Source: ${SITEMAP_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seenIds = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || HQ.city;
    // Prefer the city-token canton; otherwise infer from the location string;
    // otherwise fall back to the HQ canton (recon: SG).
    const canton =
      listing.cantonHint || inferSwissTargetCanton(location) || HQ.canton;

    // No server-side description available (JS-rendered detail pages, no
    // JSON-LD) → derive a minimal description from the title. The AI pipeline
    // enriches/localizes downstream.
    const descriptionText = stripHtml(listing.description || '');
    const description = descriptionText || `${title} — Geberit, ${location}`;
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} geberit ch`);
    // Stable id from the SuccessFactors jobReqId when present, else URL hash.
    const idSeed = listing.jobReqId || publicUrl;
    const urlHash = createHash('sha1').update(String(idSeed)).digest('hex').slice(0, 12);
    const id = `geberit-${urlHash}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    // Normalize <lastmod> (YYYY-MM-DD or ISO) to a date-only string.
    const postedDate = (listing.postedAt || '').slice(0, 10) ||
      new Date().toISOString().split('T')[0];

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
      postalCode: location === HQ.city ? HQ.postalCode : undefined,
      addressRegion: canton === HQ.canton ? HQ.addressRegion : undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      employmentType: detectEmploymentType(title),
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
