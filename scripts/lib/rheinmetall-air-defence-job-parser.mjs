#!/usr/bin/env node
/**
 * Rheinmetall Air Defence AG job parser — first-party corporate JSON API on
 * rheinmetall.com (Nuxt/CMS-driven careers portal, no third-party ATS).
 *
 * Rheinmetall Air Defence AG (formerly Oerlikon Contraves) is the Swiss air
 * defence systems subsidiary of the German Rheinmetall AG group. Registered
 * office: Birchstrasse 155, 8050 Zürich (UID CHE-101.403.861). Also operates
 * a test centre in Studen (canton Schwyz — "Test Centre Ochsenboden",
 * Ochsenbodenstrasse 80, 8845 Studen/SZ — NOT to be confused with the
 * similarly-named municipality Studen BE near Biel).
 *
 * Source: https://www.rheinmetall.com/en/career/vacancies
 *   Listing API (single request, no auth):
 *     GET https://www.rheinmetall.com/api/en/career/vacancies
 *         ?filter={"companyName":["Rheinmetall Air Defence AG"]}&size=200
 *   IMPORTANT — pagination instability: the backend's page=1..N sequential
 *   pagination (10/page) returns unstable/overlapping result sets (verified:
 *   only 64 of 79 unique jobs recovered across 8 pages, with duplicate IDs
 *   landing on non-adjacent pages). Requesting the full set via `size=200` in
 *   ONE request avoids this entirely and was verified byte-identical across
 *   3 repeated runs. Do NOT reintroduce page-by-page pagination here.
 *
 *   Detail API: GET https://www.rheinmetall.com/api{listing.url}
 *     Returns `elements.jobBlocks[]` — HTML <ul><li> sections (title + content)
 *     that must be concatenated and HTML-stripped for the description, plus
 *     structured metadata (referenceNumber, workingHoursValue, contractType,
 *     entryLevel, departmentName, cities, countries, companyName, date).
 *
 * Job content is authored in German regardless of the /en/ URL locale prefix
 * (the /en/ path is simply the only working locale segment for this listing
 * endpoint — /de/career/vacancies 404s), so sourceLang is 'de'.
 */
import { createHash } from 'node:crypto';
import {
  slugify,
  stripHtml,
  normalizeSpace,
  fetchJson,
} from './crawler-template.mjs';

export const RHEINMETALL_AIR_DEFENCE_KEY = 'rheinmetall-air-defence';
export const RHEINMETALL_AIR_DEFENCE_COMPANY_NAME = 'Rheinmetall Air Defence AG';
export const RHEINMETALL_AIR_DEFENCE_COMPANY_DOMAIN = 'rheinmetall.com';

const API_BASE = 'https://www.rheinmetall.com/api';
const LISTING_URL =
  `${API_BASE}/en/career/vacancies?filter=${encodeURIComponent(
    JSON.stringify({ companyName: [RHEINMETALL_AIR_DEFENCE_COMPANY_NAME] })
  )}&size=200`;

const TRUSTED_HOSTS = new Set(['www.rheinmetall.com', 'rheinmetall.com']);

// City -> { canton, postalCode, streetAddress } lookup. Covers every city
// observed live in the 79-job dataset (Zürich + a data-entry glitch "Zrich",
// plus the Studen/SZ test centre). Falls back to the Zürich HQ default for
// any future/unseen city so structured-data fields are never omitted
// (AGENTS.md Non-Negotiable #3 — safe default, never a missing field).
const LOCATION_BY_CITY = {
  'zürich': { city: 'Zürich', canton: 'ZH', postalCode: '8050', streetAddress: 'Birchstrasse 155' },
  'zrich': { city: 'Zürich', canton: 'ZH', postalCode: '8050', streetAddress: 'Birchstrasse 155' }, // upstream data glitch (missing ü)
  'studen': { city: 'Studen', canton: 'SZ', postalCode: '8845', streetAddress: 'Ochsenbodenstrasse 80' },
};
const DEFAULT_LOCATION = LOCATION_BY_CITY.zürich;

function resolveLocation(rawCity) {
  const key = normalizeSpace(rawCity || '').toLowerCase();
  return LOCATION_BY_CITY[key] || DEFAULT_LOCATION;
}

function buildEmploymentType(workingHoursValue) {
  const v = normalizeSpace(workingHoursValue || '').toLowerCase();
  if (v.includes('teilzeit') || v.includes('part')) return 'PART_TIME';
  if (v.includes('vollzeit') || v.includes('full')) return 'FULL_TIME';
  return 'OTHER';
}

function parseDate(dateStr) {
  // API returns "2025-07-14 00:00:00" — take the date portion.
  if (!dateStr) return null;
  const datePart = String(dateStr).split(' ')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

function firstOf(nestedArr) {
  // Fields like cities/countries come back as [["Zürich"]] — unwrap safely.
  if (Array.isArray(nestedArr) && Array.isArray(nestedArr[0])) return nestedArr[0][0];
  if (Array.isArray(nestedArr)) return nestedArr[0];
  return nestedArr;
}

function buildDescription(jobBlocks) {
  if (!Array.isArray(jobBlocks) || jobBlocks.length === 0) return '';
  const parts = [];
  for (const block of jobBlocks) {
    const title = normalizeSpace(block?.title?.data || '');
    const contentHtml = block?.content?.data || '';
    const content = stripHtml(contentHtml);
    if (!content) continue;
    parts.push(title ? `${title}\n${content}` : content);
  }
  return normalizeSpace(parts.join('\n\n'));
}

function extractSearchResults(payload) {
  const areablock = payload?.elements?.areablock;
  if (!Array.isArray(areablock)) return [];
  const searchBlock = areablock.find((b) => b?.type === 'search');
  const results = searchBlock?.data?.search?.results;
  return Array.isArray(results) ? results : [];
}

async function fetchListingResults() {
  const payload = await fetchJson(LISTING_URL);
  return extractSearchResults(payload);
}

async function fetchJobDetail(relativeUrl) {
  const detailUrl = `${API_BASE}${relativeUrl}`;
  const payload = await fetchJson(detailUrl);
  return payload?.elements || null;
}

function buildJob(listing, detail) {
  const url = `https://www.rheinmetall.com${listing.url}`;
  const id = `${RHEINMETALL_AIR_DEFENCE_KEY}-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`;

  const title = normalizeSpace(detail?.title || listing.title || '');
  const description = buildDescription(detail?.jobBlocks);

  const rawCity = firstOf(detail?.cities) || firstOf(listing.cities) || '';
  const loc = resolveLocation(rawCity);

  const slug = slugify(`${title}-${RHEINMETALL_AIR_DEFENCE_COMPANY_NAME}-${loc.city}`);
  const sourceLang = 'de';
  const postedDate = parseDate(detail?.date) || parseDate(listing.date);
  const crawledAt = new Date().toISOString();

  return {
    // REQUIRED
    id,
    slug,
    slugByLocale: { [sourceLang]: slug },
    company: RHEINMETALL_AIR_DEFENCE_COMPANY_NAME,
    companyKey: RHEINMETALL_AIR_DEFENCE_KEY,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: loc.city,
    canton: loc.canton,
    url,
    source: 'Rheinmetall Air Defence AG Dedicated Parser (corporate careers API)',
    sourceLang,
    crawledAt,

    // RECOMMENDED
    companyDomain: RHEINMETALL_AIR_DEFENCE_COMPANY_DOMAIN,
    addressLocality: loc.city,
    postalCode: loc.postalCode,
    streetAddress: loc.streetAddress,
    addressRegion: loc.canton,
    addressCountry: 'CH',
    country: 'CH',
    category: normalizeSpace(detail?.occupationalArea || listing.occupationalArea || '') || undefined,
    contract: buildEmploymentType(detail?.workingHoursValue) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: buildEmploymentType(detail?.workingHoursValue),
    experienceLevel: normalizeSpace(detail?.entryLevel || listing.entryLevel || '') || undefined,
    sector: 'Difesa / Industria',
    currency: 'CHF',
    postedDate: postedDate || undefined,
    applyUrl: url,
    featured: false,

    // Extra metadata (not part of the ParsedJob contract, kept for debugging /
    // future enrichment — harmless extra field, ignored by the pipeline).
    _rheinmetallMeta: {
      referenceNumber: detail?.referenceNumber || null,
      departmentName: detail?.departmentName || listing.departmentName || null,
      contractTypeLabel: detail?.contractType || null,
    },
  };
}

export async function fetchAllRheinmetallAirDefenceJobs() {
  const results = await fetchListingResults();
  console.log(`📋 Rheinmetall Air Defence AG: ${results.length} listings found`);

  const seen = new Set();
  const jobs = [];
  for (const listing of results) {
    if (!listing?.url || !listing?.id) continue;
    if (seen.has(listing.url)) continue;
    seen.add(listing.url);

    let detail = null;
    try {
      detail = await fetchJobDetail(listing.url);
    } catch (err) {
      console.warn(`⚠️  Failed to fetch detail for ${listing.url}: ${err?.message || err}`);
    }

    try {
      const job = buildJob(listing, detail || {});
      if (job.title && job.description) {
        jobs.push(job);
      } else {
        console.warn(`⚠️  Skipping incomplete job (missing title/description): ${listing.url}`);
      }
    } catch (err) {
      console.warn(`⚠️  Failed to build job for ${listing.url}: ${err?.message || err}`);
    }
  }

  console.log(`✅ Rheinmetall Air Defence AG: ${jobs.length} jobs parsed`);
  return jobs;
}

export function isRheinmetallAirDefenceJob(job) {
  if (!job) return false;
  if (job.companyKey === RHEINMETALL_AIR_DEFENCE_KEY) return true;
  const company = normalizeSpace(job.company || '').toLowerCase();
  if (company === RHEINMETALL_AIR_DEFENCE_COMPANY_NAME.toLowerCase()) return true;
  try {
    const host = new URL(job.url || '').hostname.replace(/^www\./, '');
    if (host === RHEINMETALL_AIR_DEFENCE_COMPANY_DOMAIN && company.includes('rheinmetall')) return true;
  } catch {
    /* invalid URL, ignore */
  }
  return false;
}

export function isTrustedDomain(url) {
  try {
    const host = new URL(url).hostname;
    return TRUSTED_HOSTS.has(host);
  } catch {
    return false;
  }
}
