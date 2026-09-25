#!/usr/bin/env node
/**
 * New Yorker (Schweiz) job parser — rexx systems ATS, "table" listing template.
 *
 * ATS discovery (issue #3337 lists New Yorker as "Custom" — WRONG, same
 * mislabel pattern as several other rows in this backlog):
 *   1. The corporate site newyorker.de/newyorker.com does NOT host its own
 *      job data. A country-selection group career portal lives on its own
 *      subdomain: https://jobs.newyorker.de/ (found via
 *      https://jobs.newyorker.de/country-selection, one country tenant per
 *      market — Switzerland's is https://jobs.newyorker.de/karriere-schweiz/).
 *   2. That subdomain's listing page footer embeds the literal
 *      `rexx systems — software for success` logo/link
 *      (`https://www.rexx-systems.com`, `bilder/rexx_systems_logo.svg`) —
 *      the SAME multi-tenant ATS already used by several Swiss
 *      hospital/foundation crawlers in this repo
 *      (`./rexx-systems-job-parser-common.mjs`: zgks, spital-schwyz,
 *      kantonsspital-uri). So the "Custom" label is wrong: this is a known,
 *      already partially-supported ATS.
 *   3. However New Yorker's tenant renders a DIFFERENT rexx systems template
 *      than any already-supported tenant: a plain HTML `<table id=
 *      "joboffers">` listing (`.real_table_col1/2/3` = title/Standort/
 *      Unternehmensbereich per `<tr>`) instead of the `.joboffer_container`
 *      div-card layout `parseRexxListing` in `./rexx-systems-job-parser-
 *      common.mjs` expects (verified: that regex never matches — 0 hits on
 *      this tenant's HTML). `createRexxSystemsParser`'s factory also bakes
 *      in a single `defaultCanton`/`defaultCity` per employer, which does
 *      not fit New Yorker: it is a nationwide retail chain, and the 42
 *      Swiss vacancies observed 2026-07 span at least 8 different cantons
 *      (ZH, BE, BS, AG, GR, LU, SG, SH) — there is no one "the" store city.
 *      Reusing the factory would also silently return zero jobs (listing
 *      shape mismatch) even if the single-city assumption were relaxed, so
 *      this file implements bespoke listing/detail parsing while still
 *      reusing the shared fetch/HTML utilities (`fetchHtml`/`slugify`/
 *      `normalizeSpace`/`stripHtml` from `./crawler-template.mjs`;
 *      `detectLang`/`guessCategory`/`normalizeContract`/`decodeHtmlEntities`
 *      from `./dedicated-crawler-common.mjs`; `inferSwissTargetCanton`/
 *      `getCantonForLocation` from `./target-swiss-locations.mjs` and
 *      `./crawler-location-config.mjs`) rather than reimplementing them.
 *   4. Detail pages are BETTER than the typical rexx heading-scrape: each
 *      one embeds a full `<script type="application/ld+json">` schema.org
 *      `JobPosting` block with a real per-posting `jobLocation.address`
 *      (streetAddress/addressLocality/addressRegion/postalCode/
 *      addressCountry), `datePosted`, `validThrough`, `employmentType` and
 *      `hiringOrganization.name`. This is parsed directly instead of
 *      scraping headings/paragraphs — far more robust than text-matching
 *      "Ihre Aufgaben"/"Ihr Profil" style headline markers.
 *      CAVEAT: the source's own `employmentType` is a constant "FULL_TIME"
 *      on every posting observed (even ones titled "…50%"/"…60%"), so it is
 *      NOT trusted for our own PART_TIME/FULL_TIME derivation — that is
 *      derived from the title's workload percentage via the shared
 *      `normalizeContract()` (matches how every other percentage-in-title
 *      Swiss retail crawler in this repo derives contract type).
 *   5. No `baseSalary` field exists anywhere in the JSON-LD or HTML — per
 *      repo Non-Negotiable #3 this is emitted as a safe default (absent
 *      value, never a fabricated number), same treatment as other
 *      dedicated crawlers with no source salary data.
 *
 * Source URLs:
 *   Listing: https://jobs.newyorker.de/karriere-schweiz/stellenangebote.html
 *            (server-rendered HTML table, one page, no pagination — 42 CH
 *            openings observed 2026-07; small enough that no paging exists)
 *   Detail:  https://jobs.newyorker.de/karriere-schweiz/{slug}-de-j{id}.html
 *            (URL taken verbatim from the listing table's title-column link)
 *
 * The `/karriere-schweiz/` path is itself the Swiss-only tenant (New
 * Yorker's group portal has one such path per country — see
 * https://jobs.newyorker.de/country-selection), so no additional
 * per-listing country filter is structurally required. As defense-in-depth
 * (New Yorker is a 45+-country multinational and this listing template has
 * no per-row canton/country column of its own beyond the free-text
 * "Standort" city), every parsed job's detail-page `jobLocation.address.
 * addressCountry` is still asserted against `CH` before being kept, and any
 * mismatch is dropped with a warning rather than silently ingested.
 *
 * HQ verification — "NEW YORKER (Schweiz) GmbH", Rietbrunnen 2, 8808
 * Pfäffikon SZ (legal seat registered as the municipality "Freienbach"),
 * UID CHE-112.007.794 — cross-checked across 3 independent sources:
 *   1. Zefix (official Swiss Central Business Names Index) REST API,
 *      https://www.zefix.ch/ZefixREST/api/v1/firm/768755.json — legalSeat
 *      "Freienbach", address.street "Rietbrunnen", houseNumber "2",
 *      address.town "Pfäffikon SZ", swissZipCode "8808".
 *   2. northdata.com/NEW YORKER (Schweiz) GmbH/CHE-112.007.794 (aggregates
 *      the same Zefix/SHAB register data) — same seat + UID.
 *   3. moneyhouse.ch company profile "NEW YORKER (Schweiz) GmbH in
 *      Pfäffikon SZ" (search-result snippet) — same town + legal form.
 * None of the 42 observed Swiss vacancies are actually posted in Pfäffikon
 * (it is the administrative office, not a store) — the HQ fallback below
 * is a last-resort path exercised only if a detail-page fetch/parse fails
 * and no per-job address is available at all.
 */
import { fetchHtml, slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';
import { detectLang, guessCategory, normalizeContract, decodeHtmlEntities } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { getCantonForLocation } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const NEW_YORKER_KEY = 'new-yorker';
export const NEW_YORKER_COMPANY_NAME = 'New Yorker';
export const NEW_YORKER_COMPANY_DOMAIN = 'newyorker.de';

const ATS_HOST = 'jobs.newyorker.de';
const LISTING_URL = 'https://jobs.newyorker.de/karriere-schweiz/stellenangebote.html';
const CAREER_URL = 'https://jobs.newyorker.de/karriere-schweiz/';

const SECTOR = 'Retail / Fashion (abbigliamento)';

/** HQ fallback — NEW YORKER (Schweiz) GmbH, Rietbrunnen 2, 8808 Pfäffikon SZ.
 * Verified via Zefix (official CH commercial register API) AND cross-checked
 * against northdata.com + moneyhouse.ch (see module docblock for sources). */
const HQ = {
  city: 'Pfäffikon',
  canton: 'SZ',
  postalCode: '8808',
  streetAddress: 'Rietbrunnen 2',
  region: 'Schwyz',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value = '') {
  return normalizeSpace(decodeHtmlEntities(stripHtml(value)));
}

/**
 * Resolve the best city / postal code / street address for a job, falling
 * back to the documented Pfäffikon SZ HQ ONLY when the resolved city text
 * itself matches Pfäffikon (city-gated, never canton-only).
 *
 * IMPORTANT national-ambiguity guard: "Pfäffikon" is NOT unique in
 * Switzerland — there is a second, unrelated "Pfäffikon" near Wetzikon in
 * canton ZH (~30km from this HQ, a different canton entirely). A plain
 * substring match on "pfäffikon" would misattribute the Schwyz HQ street
 * address to that unrelated ZH town if it were ever spelled without its
 * canton qualifier. Guard against this by rejecting any city text that
 * carries an explicit "ZH" qualifier alongside the name.
 *
 * @param {{ city?: string, postalCode?: string, streetAddress?: string }} [raw]
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(raw = {}) {
  const city = normalizeSpace(raw.city || '') || HQ.city;
  const isPfaeffikonSz = /pf(ä|ae)ffikon/i.test(city) && !/\bzh\b/i.test(city);
  return {
    city,
    postalCode: normalizeSpace(raw.postalCode || '') || (isPfaeffikonSz ? HQ.postalCode : ''),
    streetAddress: normalizeSpace(raw.streetAddress || '') || (isPfaeffikonSz ? HQ.streetAddress : ''),
  };
}

/* ── Company matchers ──────────────────────────────────────── */

export function isNewYorkerJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === NEW_YORKER_KEY ||
    company === 'new yorker' ||
    company.includes('new yorker') ||
    url.includes(NEW_YORKER_COMPANY_DOMAIN) ||
    url.includes(ATS_HOST)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === NEW_YORKER_COMPANY_DOMAIN || host.endsWith(`.${NEW_YORKER_COMPANY_DOMAIN}`)) return true;
    if (host === ATS_HOST) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Listing parse (rexx systems "table" template) ────────── */

/**
 * Parse the New Yorker rexx systems listing page (`<table id="joboffers">`)
 * into raw rows.
 *
 * Markup (per row):
 *   <tr class="alternative_1">
 *     <td class="real_table_col1"><a target="_self" href="{url}">{title}</a>
 *       <div class="mobile"><div class="umobile1">{city}</div>
 *       <div class="umobile2">{dept}</div></div>
 *     </td>
 *     <td class="real_table_col2">{city}</td>
 *     <td class="real_table_col3">{dept}</td>
 *   </tr>
 *
 * Splitting on the `<tr class="alternative_` marker (both `_0`/`_1` zebra
 * classes) avoids relying on a single global regex across the whole table,
 * since every row shares the identical `<td>` class names.
 *
 * @param {string} html
 * @returns {Array<{href: string, title: string, location: string, department: string}>}
 */
export function parseNewYorkerListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const rowRx = /<tr\s+class="alternative_[01]">([\s\S]*?)<\/tr>/g;
  const out = [];
  const seen = new Set();
  let rowMatch;
  while ((rowMatch = rowRx.exec(html))) {
    const row = rowMatch[1];
    const titleMatch = row.match(/<td\s+class="real_table_col1">\s*<a[^>]*href="([^"]+)">([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const href = titleMatch[1].trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const title = cleanText(titleMatch[2]);
    if (!title || title.length < 3) continue;

    const locMatch = row.match(/<td\s+class="real_table_col2">([\s\S]*?)<\/td>/i);
    const deptMatch = row.match(/<td\s+class="real_table_col3">([\s\S]*?)<\/td>/i);

    out.push({
      href,
      title,
      location: locMatch ? cleanText(locMatch[1]) : '',
      department: deptMatch ? cleanText(deptMatch[1]) : '',
    });
  }
  return out;
}

/* ── Detail page parse (JSON-LD JobPosting) ───────────────── */

/**
 * Extract the `application/ld+json` `JobPosting` block from a New Yorker
 * detail page and normalize it into the flat shape this crawler needs.
 * Returns `null` if no valid JobPosting JSON-LD is present/parseable.
 *
 * @param {string} html
 * @returns {{
 *   title: string, description: string, datePosted: string,
 *   validThrough: string, employmentTypeRaw: string,
 *   hiringOrganizationName: string, streetAddress: string, city: string,
 *   region: string, postalCode: string, country: string,
 * } | null}
 */
export function extractNewYorkerJsonLd(html = '') {
  if (!html || typeof html !== 'string') return null;
  const scriptMatch = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (!scriptMatch) return null;

  let data;
  try {
    data = JSON.parse(scriptMatch[1]);
  } catch {
    return null;
  }
  if (!data || data['@type'] !== 'JobPosting') return null;

  const address = data.jobLocation?.address || {};
  const descParts = [data.description, data.responsibilities, data.qualifications, data.jobBenefits]
    .map((part) => cleanText(part))
    .filter(Boolean);

  return {
    title: cleanText(data.title || ''),
    description: descParts.join('\n\n'),
    datePosted: typeof data.datePosted === 'string' ? data.datePosted : '',
    validThrough: typeof data.validThrough === 'string' ? data.validThrough : '',
    employmentTypeRaw: typeof data.employmentType === 'string' ? data.employmentType : '',
    hiringOrganizationName: cleanText(data.hiringOrganization?.name || '') || NEW_YORKER_COMPANY_NAME,
    streetAddress: cleanText(address.streetAddress || ''),
    city: cleanText(address.addressLocality || ''),
    region: cleanText(address.addressRegion || ''),
    postalCode: cleanText(address.postalCode || ''),
    country: cleanText(address.addressCountry || ''),
  };
}

/* ── Fetch + Assemble ──────────────────────────────────────── */

/**
 * True if a `jobLocation.address.addressCountry` value from the detail-page
 * JSON-LD indicates Switzerland. Exported so the multi-country filtering
 * this crawler relies on (New Yorker's group portal serves 45+ countries;
 * the `/karriere-schweiz/` listing path scopes the tenant but has no
 * per-row country column of its own) is directly testable rather than only
 * exercised indirectly through the live network fetch.
 *
 * Missing/empty input is treated as Swiss (`true`) — the listing itself is
 * already CH-scoped by URL, so an absent field (e.g. detail fetch failed)
 * must not cause a real Swiss posting to be silently dropped; an explicit
 * non-CH value is what triggers the drop.
 */
export function isSwissCountry(country = '') {
  if (!country) return true; // no signal — defer to the CH-scoped listing path itself
  return /^ch$|schweiz|switzerland|suisse|svizzera/i.test(country);
}

/**
 * Fetch all New Yorker Switzerland jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllNewYorkerJobs() {
  console.log(`🔍 Fetching ${NEW_YORKER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (rexx systems, table template)\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ New Yorker rexx systems listing fetch failed: ${err?.message || err}`);
    throw err;
  }

  const rows = parseNewYorkerListing(listingHtml);
  if (!rows.length) {
    console.warn('⚠️ No openings parsed from New Yorker rexx systems listing.');
    return [];
  }
  console.log(`  📋 Listings found: ${rows.length}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const jobs = [];
  const seen = new Set();

  for (const row of rows) {
    // Strip the per-session `?sid=<32-hex>` token the rexx listing stamps
    // into every href before persisting. It changes on every crawl session
    // (observed: commit 491149eb9 → 66e895808 rotated it on all 40 jobs), so
    // keeping it makes the job's URL byte-different across runs and every
    // URL-keyed identity downstream churns — the same session-token class
    // that duplicated the pictet slice (assembleUrlKey + the url-keyed 3-way
    // slice merge in git-commit-data.sh union per-run variants). The detail
    // page serves identically without it (verified live 2026-07-10, HTTP 200).
    // The stable merge key is unaffected either way (job-url-key.mjs Rule X
    // already keys rexx URLs on the `-j<digits>.html` leaf id).
    const urlObj = new URL(row.href, CAREER_URL);
    urlObj.searchParams.delete('sid');
    const publicUrl = urlObj.toString();
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(publicUrl, { timeoutMs });
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${row.title}: ${err?.message || err}`);
    }

    const detail = extractNewYorkerJsonLd(detailHtml);

    if (detail && detail.country && !isSwissCountry(detail.country)) {
      console.warn(`  ⏭️ Skipping non-Swiss posting (${detail.country}): ${row.title}`);
      continue;
    }

    const title = detail?.title || row.title;
    const rawCity = detail?.city || row.location || HQ.city;
    const { city, postalCode, streetAddress } = resolveAddress({
      city: rawCity,
      postalCode: detail?.postalCode,
      streetAddress: detail?.streetAddress,
    });
    const location = normalizeSpace(row.location || city);
    const canton =
      getCantonForLocation(detail?.region || '') ||
      inferSwissTargetCanton(location) ||
      inferSwissTargetCanton(city) ||
      HQ.canton;

    const descParts = [];
    if (detail?.description) descParts.push(detail.description);
    if (row.department) descParts.push(`Bereich: ${row.department}`);
    const description = descParts.length
      ? descParts.join('\n\n')
      : `${title} — ${NEW_YORKER_COMPANY_NAME} (${location}).`;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} new yorker ${location}`);
    const idSeed = row.href.match(/-j(\d+)\.html/i)?.[1] || row.href;
    const id = `${NEW_YORKER_KEY}-${idSeed}`;
    const contract = normalizeContract('', title, description);
    const employmentType = contract === 'part-time' ? 'PART_TIME' : 'FULL_TIME';
    const postedDate = detail?.datePosted || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: NEW_YORKER_COMPANY_NAME,
      companyKey: NEW_YORKER_KEY,
      companyDomain: NEW_YORKER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'New Yorker Dedicated Parser (rexx systems)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: canton === HQ.canton ? HQ.region : canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: guessCategory(title, description),
      contract,
      employmentType,
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n📋 Total ${NEW_YORKER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
