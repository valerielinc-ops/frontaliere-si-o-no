#!/usr/bin/env node
/**
 * Benteler job parser — Fetcher and job builder.
 *
 * Source: https://career.benteler.jobs/search/?locale=en_US
 *
 * ISSUE #3797 FALSE-NEGATIVE FIX: the previous parser targeted
 * `career.benteler.com` (a TYPO3 marketing site, not a job board at all)
 * with invented SuccessFactors API URLs that never existed. Benteler's
 * real job board lives on a completely different domain: a SAP
 * SuccessFactors "Jobs2Web" career site at `career.benteler.jobs`. It is
 * fully server-rendered HTML (no JS/API needed) — listing rows are
 * `<tr class="data-row">` blocks with `jobTitle-link`/`jobLocation`
 * spans, paginated via `?startrow=N` (25 rows/page), and detail pages
 * carry schema.org `JobPosting` microdata.
 *
 * ISSUE #3893 DETAIL-STAGE FIX (verified live 2026-07-11): this tenant's
 * `PostalAddress` microdata emits NO `postalCode` itemprop, so the old
 * strict 4-field-in-order address regex could never match. Postings can
 * also carry SEVERAL `itemprop="address"` blocks (multi-location rows show
 * "+1 more…" in the listing), so a Swiss location can hide behind a
 * non-Swiss visible location. The detail parser now reads every address
 * block field-by-field (each field optional) and prefers the CH one;
 * multi-location listing rows are kept for a detail-page country check.
 * Note: Benteler has no Ticino entity — its active Swiss entities are in
 * Zug/Baar (Zefix: Benteler Trading International AG, Benteler Mobility
 * GmbH, BENTELER HOLON Verwaltungs AG), hence the Zug fallbacks.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBentelerJobs()  — Fetch and parse all jobs
 *   - isBentelerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';
import {
  hasSuccessFactorsMoreLocations,
  isSuccessFactorsWidgetText,
  sanitizeSuccessFactorsField,
} from './successfactors-jobs2web-widget-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BENTELER_KEY = 'benteler';
export const BENTELER_COMPANY_NAME = 'Benteler';
export const BENTELER_COMPANY_DOMAIN = 'benteler.com';

const CAREER_HOST = 'career.benteler.jobs';
const CAREER_URL = `https://${CAREER_HOST}/search/?locale=en_US`;
const HQ = getCompanyDefaults('benteler');

const PAGE_SIZE = 25;
const MAX_PAGES = 40; // safety cap (40 * 25 = 1000 rows)

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Benteler.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBentelerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BENTELER_KEY ||
    key.startsWith('benteler') ||
    company.includes('benteler') ||
    url.includes('benteler.com') ||
    url.includes('benteler.jobs')
  );
}

/**
 * Validate that a URL belongs to Benteler's domain (marketing site or the
 * SuccessFactors Jobs2Web career board, which lives on `benteler.jobs`).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'benteler.com' ||
      host.endsWith('.benteler.com') ||
      host === 'benteler.jobs' ||
      host.endsWith('.benteler.jobs')
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

/* ── Jobs2Web listing + detail (server-rendered HTML) ─────── */

/**
 * Check if a location string indicates a Swiss target location.
 *
 * Jobs2Web location text is formatted "City, RegionCode, CountryCode" (e.g.
 * "Paderborn, NW, DE" or "Sierre, VS, CH"). A trailing 2/3-letter country
 * code, when present, is authoritative and MUST be checked before falling
 * back to fuzzy canton/city matching: Swiss canton abbreviations collide
 * with foreign region codes (e.g. "NW" = Nidwalden in Switzerland, but also
 * Nordrhein-Westfalen in Germany) — without this guard, `isTargetSwissLocation()`
 * false-positives on every German posting whose region code happens to
 * match a Swiss canton code.
 *
 * Exported for tests.
 */
export function isSwissLocation(location = '') {
  const loc = String(location || '').trim();
  if (!loc) return false;
  if (/\b(schweiz|switzerland|suisse|svizzera)\b/i.test(loc)) return true;
  const parts = loc.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].toUpperCase();
    if (/^[A-Z]{2,3}$/.test(last)) {
      return last === 'CH';
    }
  }
  return isTargetSwissLocation(loc);
}

/**
 * Parse one Jobs2Web search-results page (server-rendered `<tr class="data-row">`
 * table). Returns `{ rows, total }` where `total` is the "Results X to Y of
 * TOTAL" count parsed from the page (0 if not found).
 *
 * `hasMoreLocations` flags multi-location rows ("+N more…" marker): their
 * extra locations are NOT in the listing HTML, so a Swiss site can hide
 * behind a non-Swiss visible location — the caller must check the detail
 * page's address microdata before discarding them.
 *
 * Exported for tests (fixture-based).
 */
export function parseSearchPage(html = '') {
  const rows = [];
  const blocks = String(html || '').split('<tr class="data-row">').slice(1);
  for (const block of blocks) {
    const titleM = block.match(/class="jobTitle-link">([^<]*)</);
    const hrefM = block.match(/href="([^"]+)"\s*class="jobTitle-link"/);
    const locM = block.match(/<span class="jobLocation">\s*([^<]*?)\s*</);
    const facM = block.match(/class="jobFacility">([^<]*)</);
    const locCellM = block.match(/<td[^>]*class="[^"]*colLocation[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (!titleM || !hrefM) continue;
    const rowTitle = normalizeSpace(titleM[1]);
    // A row whose anchor text is j2w page chrome (cookie-consent widget,
    // search/alert box) isn't a job at all — discard the row, don't clean it,
    // or it becomes a posting with no title.
    if (isSuccessFactorsWidgetText(rowTitle)) continue;
    rows.push({
      title: rowTitle,
      href: hrefM[1],
      locationText: locM ? normalizeSpace(locM[1]) : '',
      facility: facM ? normalizeSpace(facM[1]) : '',
      // Scope the marker probe to the location cell when the row has one: the
      // shared matcher spans de/en/fr/it, so probing the WHOLE row would let a
      // "+2 altri"-shaped title or href flip the flag and keep a non-Swiss row.
      hasMoreLocations: hasSuccessFactorsMoreLocations(locCellM ? locCellM[1] : block),
    });
  }
  const totalM = html.match(/Results\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i);
  return { rows, total: totalM ? Number(totalM[1]) : 0 };
}

/**
 * Fetch every Jobs2Web search-results page, then filter client-side for
 * Swiss locations. Note: on this tenant `jobFacility` holds a business-unit
 * name (e.g. "BENTELER Steel/Tube"), not a country, so filtering relies on
 * the `jobLocation` text via `isSwissLocation()`. Multi-location rows
 * ("+N more…") are kept too: their hidden locations can be Swiss, and the
 * detail page's address microdata is the only place they are listed —
 * `fetchAllBentelerJobs()` drops them if no CH address shows up there.
 */
async function listSwissJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const allRows = [];
  let startrow = 0;
  let expectedTotal = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${CAREER_URL}&startrow=${startrow}`;
    let html;
    try {
      html = await fetchHtml(url, { timeoutMs });
    } catch (err) {
      if (startrow === 0) console.warn(`⚠️ Failed to fetch Jobs2Web listing: ${err.message}`);
      break;
    }
    const { rows, total } = parseSearchPage(html);
    if (page === 0) expectedTotal = total;
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (expectedTotal > 0 && allRows.length >= expectedTotal) break;
    startrow += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  const swissRows = allRows.filter(
    (r) => isSwissLocation(r.locationText) || r.hasMoreLocations,
  );
  console.log(
    `  🎯 Filtered ${allRows.length} total → ${swissRows.length} Swiss/multi-location candidates`,
  );
  return swissRows;
}

/**
 * Parse every schema.org `PostalAddress` microdata block on a detail page.
 *
 * Field-by-field and order-independent, because this tenant emits NO
 * `postalCode` itemprop at all (the old strict locality→region→postalCode→
 * country regex could therefore never match) and multi-location postings
 * carry several `itemprop="address"` blocks.
 */
function parseAddressBlocks(html = '') {
  const addresses = [];
  const chunks = String(html || '').split(/itemprop="address"[^>]*>/).slice(1);
  for (const chunk of chunks) {
    // Confine the scan to this PostalAddress block (metas are adjacent;
    // the block ends at its closing </span>).
    const end = chunk.indexOf('</span>');
    const scope = end !== -1 ? chunk.slice(0, end) : chunk.slice(0, 600);
    const get = (name) => {
      const m = scope.match(new RegExp(`itemprop="${name}" content="([^"]*)"`));
      return m ? normalizeSpace(m[1]) : '';
    };
    const addr = {
      addressLocality: get('addressLocality'),
      addressRegion: get('addressRegion'),
      postalCode: get('postalCode'),
      addressCountry: get('addressCountry').toUpperCase(),
    };
    if (addr.addressLocality || addr.addressCountry) addresses.push(addr);
  }
  return addresses;
}

/**
 * Parse a job detail page (schema.org `JobPosting` microdata, server-rendered
 * — no JS needed). Pure function, exported for tests (fixture-based).
 *
 * Returns all address blocks plus the "best" one flattened for convenience:
 * the CH address when present (multi-location postings list every site),
 * otherwise the first.
 */
export function parseJobDetailHtml(html = '', url = '') {
  const addresses = parseAddressBlocks(html);
  const best = addresses.find((a) => a.addressCountry === 'CH') || addresses[0] || {};
  const dateM = String(html || '').match(/itemprop="datePosted" content="([^"]*)"/);

  let descriptionHtml = '';
  const startMarker = '<span class="jobdescription">';
  const start = String(html || '').indexOf(startMarker);
  if (start !== -1) {
    const from = start + startMarker.length;
    const endMarker = '<p class="job-location">';
    const end = html.indexOf(endMarker, from);
    descriptionHtml = html.slice(from, end !== -1 ? end : from + 20000);
  }

  let postedDate = '';
  if (dateM) {
    // Tenant emits Java-style dates, e.g. "Wed Jun 17 02:01:00 UTC 2026".
    const d = new Date(dateM[1]);
    if (!Number.isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
  }

  return {
    addresses,
    addressLocality: best.addressLocality || '',
    addressRegion: best.addressRegion || '',
    postalCode: best.postalCode || '',
    addressCountry: best.addressCountry || '',
    postedDate,
    descriptionHtml,
    url,
  };
}

/**
 * Fetch and parse a job detail page.
 */
async function fetchJobDetail(href) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const url = href.startsWith('http') ? href : `https://${CAREER_HOST}${href}`;
  let html;
  try {
    html = await fetchHtml(url, { timeoutMs });
  } catch (err) {
    console.warn(`⚠️ Detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
  return parseJobDetailHtml(html, url);
}

/**
 * Fetch all Benteler jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export async function fetchAllBentelerJobs() {
  console.log(`🔍 Fetching Benteler jobs from ${CAREER_URL}`);
  console.log(`   Filter: Switzerland (jobLocation text)\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings found on the Jobs2Web board.');
    return [];
  }

  console.log(`  📋 Swiss job listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    if (!listing.href) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(listing.href);
    if (!detail) continue;

    // Multi-location candidates ("+N more…") were kept past the listing
    // filter only to inspect their full address microdata: drop them unless
    // one of the addresses is actually Swiss.
    const visiblySwiss = isSwissLocation(listing.locationText);
    const detailSwiss = (detail.addresses || []).some((a) => a.addressCountry === 'CH');
    if (!visiblySwiss && !detailSwiss) {
      console.log(`     ↳ skipped (no Swiss site among ${detail.addresses?.length || 0} locations)`);
      continue;
    }

    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Listing locationText is "City, Region, CC" — keep only the city part
    // as fallback when the microdata has no locality.
    const listingCity = normalizeSpace((listing.locationText || '').split(',')[0]);
    const location = normalizeSpace(detail.addressLocality || listingCity) || HQ?.city || 'Zug';
    const canton = inferAnyCanton(`${location} ${detail.addressRegion || ''}`) || HQ?.canton || '';
    // Detail-page description can also be j2w page chrome (same widget bleed
    // as the title); sanitize before it can fall through to the fallback text.
    const descriptionText = sanitizeSuccessFactorsField(stripHtml(detail.descriptionHtml || ''));
    const publicUrl = detail.url;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} benteler ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);

    const desc = descriptionText || `${title} — Stelle bei Benteler in ${location}, Schweiz. Benteler ist ein globaler Automobil- und Stahlzulieferer mit Schweizer Gesellschaften im Raum Zug.`;

    const job = {
      id: `benteler-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BENTELER_COMPANY_NAME,
      companyKey: BENTELER_KEY,
      companyDomain: BENTELER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Benteler Dedicated Parser (Jobs2Web)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: detail.addressRegion || canton || HQ?.addressRegion || 'ZG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: detail.postalCode || HQ?.postalCode || '6300',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Automotive / Industria siderurgica',
      currency: 'CHF',
      featured: false,
      postedDate: detail.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Benteler jobs discovered: ${jobs.length}`);
  return jobs;
}
