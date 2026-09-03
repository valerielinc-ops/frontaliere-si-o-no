#!/usr/bin/env node
/**
 * Clariant job parser — SAP SuccessFactors Career Site Builder (Jobs2Web),
 * custom-domain tenant.
 *
 * ATS discovery (issue #3337 lists Clariant as "Custom" — WRONG, same
 * pattern as other rows in this backlog):
 *   1. https://www.clariant.com/en/Careers is a plain marketing page with NO
 *      job data — it links out to a SEPARATE subdomain:
 *        <a href="https://careers.clariant.com/">
 *   2. https://careers.clariant.com/ loads `/platform/js/j2w/*.min.js`
 *      assets (`j2w.core.min.js`, `j2w.agent.min.js`, `options-search.min.js`
 *      etc.) — the "j2w" prefix IS the SAP SuccessFactors "Jobs2Web" career
 *      site builder product. Confirmed live: `curl -s
 *      https://careers.clariant.com/search/?locationsearch=switzerland`
 *      returns a hidden `<a href="https://clariantinternationalltd.
 *      valhalla12.stage.jobs2web.com/">` anchor, exposing the real SF tenant
 *      ("clariantinternationalltd") behind the custom `careers.clariant.com`
 *      domain. So the "Custom" label is wrong: this is a known ATS
 *      (SuccessFactors) already partially supported in-tree via
 *      `./ats-clients/successfactors-client.mjs`.
 *   3. That shared client is NOT reused here for two reasons (same class of
 *      issue documented in `./barry-callebaut-job-parser.mjs`):
 *        a. `detectSuccessFactorsKind()`'s host allowlist doesn't recognise
 *           `careers.clariant.com` (would return `null` → zero jobs).
 *        b. Its generic jobs2web search-table parser (`parseJobs2WebSearchRows`)
 *           assumes a Title|Department|Location|Date column order. Clariant's
 *           `/search/` table is Title|Location|Department with NO Date
 *           column at all (verified live: `<td class="colLocation">` comes
 *           BEFORE `<td class="colDepartment">`, and the 4th `<td>` is
 *           empty) — wiring it into the shared parser would silently swap
 *           location↔department instead of failing loudly, so this file
 *           implements a bespoke listing/detail parser while still reusing
 *           the shared low-level fetch/HTML utilities.
 *
 * Source URLs:
 *   Listing: https://careers.clariant.com/search/?locationsearch=switzerland
 *            (&startrow=N, page size 20 — confirmed via the pagination shell
 *            "Results 1 – 20 of 103" / "Page 1 of 6" on the unfiltered feed)
 *   Detail:  https://careers.clariant.com{href} (href from listing tile,
 *            e.g. /job/Pratteln-Intern-Corporate-Strategy-&Innovation/1405838633/)
 *
 * Detail pages carry schema.org JobPosting MICRODATA (not JSON-LD):
 *   <span itemprop="title">…</span>
 *   <meta itemprop="datePosted" content="Thu Jun 18 00:00:00 UTC 2026">
 *   <meta itemprop="validThrough" content="…">
 *   <meta itemprop="hiringOrganization" content="Clariant">
 *   <meta itemprop="streetAddress" content="Pratteln, CH">  (city label, NOT
 *     a real street — SF populates this field with "{city}, {country}")
 * plus a free-text `<span class="jobdescription">` body that itself opens
 * with "Job ID: {n} | Location: {city}, {region}, {country} | Work Model: …"
 * — the internal SF requisition number is extracted from that preamble.
 *
 * HQ: Clariant AG, Rothausstrasse 61, 4132 Muttenz (BL) — confirmed via the
 * Swiss commercial register (Zefix `firm/356887.json`: legalSeat "Muttenz",
 * address street "Rothausstrasse" houseNumber "61", swissZipCode "4132").
 * Every Swiss Clariant listing observed to date is filed under "Pratteln,
 * CH" in the job data — the same physical HQ campus, which sits on the
 * Pratteln/Muttenz municipal border and which Clariant's OWN posting text
 * calls "our Global Headquarters in Pratteln, Switzerland". So
 * `resolveAddress()` below gates the street-address fallback on the
 * resolved city matching EITHER Muttenz (legal seat) OR Pratteln (the name
 * Clariant itself uses for the same site) — still a specific city-name
 * gate, never a canton-wide (BL) one, so a hypothetical future Clariant
 * posting at some other Basel-Landschaft town would NOT incorrectly inherit
 * this street address.
 */
import { createHash } from 'node:crypto';
import { fetchHtml, slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';
import { detectLang, guessCategory, normalizeContract, decodeHtmlEntities } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  isSuccessFactorsWidgetText,
  sanitizeSuccessFactorsField,
  stripSuccessFactorsMoreLocations,
} from './successfactors-jobs2web-widget-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CLARIANT_KEY = 'clariant';
export const CLARIANT_COMPANY_NAME = 'Clariant';
export const CLARIANT_COMPANY_DOMAIN = 'clariant.com';

const JOBS2WEB_HOST = 'careers.clariant.com';
const LISTING_URL = `https://${JOBS2WEB_HOST}/search/?locationsearch=switzerland&sortColumn=referencedate&sortDirection=desc`;
const DETAIL_BASE = `https://${JOBS2WEB_HOST}`;
const CAREER_URL = 'https://www.clariant.com/en/Careers';
const PAGE_SIZE = 20;
const MAX_PAGES = 10;

const SECTOR = 'Chimica Speciale';

/** HQ fallback — Clariant AG, Rothausstrasse 61, 4132 Muttenz (BL).
 * Verified via Zefix (Swiss commercial register, firm ehraid 356887). */
const HQ = {
  city: 'Muttenz',
  canton: 'BL',
  postalCode: '4132',
  streetAddress: 'Rothausstrasse 61',
  region: 'Basel-Landschaft',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/** Strip tags then decode the extended named-entity set (curly quotes,
 * en/em-dash, accented Latin letters, etc.) beyond stripHtml's narrower table. */
function cleanText(value = '') {
  return normalizeSpace(decodeHtmlEntities(stripHtml(value)));
}

/**
 * Resolve the best city / postal code / street address for a job, falling
 * back to the documented Clariant HQ ONLY when the resolved city text
 * itself matches Muttenz OR Pratteln (city-gated, never canton-only) — this
 * is what stops a hypothetical Clariant posting at a DIFFERENT
 * Basel-Landschaft town from incorrectly inheriting the Muttenz street
 * address just because it shares canton BL.
 *
 * Exported so tests exercise this exact gate instead of a duplicated regex.
 *
 * @param {{ city?: string, postalCode?: string, streetAddress?: string }} [raw]
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(raw = {}) {
  const city = normalizeSpace(raw.city || '') || HQ.city;
  const isHqCampus = /muttenz|pratteln/i.test(city);
  return {
    city,
    postalCode: normalizeSpace(raw.postalCode || '') || (isHqCampus ? HQ.postalCode : ''),
    streetAddress: normalizeSpace(raw.streetAddress || '') || (isHqCampus ? HQ.streetAddress : ''),
  };
}

/**
 * Resolve the canton for a job, or signal that it should be skipped.
 *
 * Mirrors the unresolved-canton skip guard in scripts/lib/planzer-job-parser.mjs:
 * when real location text was present but doesn't resolve to any known Swiss
 * canton, never fabricate the Muttenz HQ canton for a job that isn't
 * positively there (AGENTS.md Non-Negotiable #3) — return null so the caller
 * skips the job instead of defaulting to HQ.canton.
 *
 * @param {string} realLocationText - location text as scraped, BEFORE the HQ.city fallback
 * @param {string} rawLocation - realLocationText, or HQ.city when absent
 * @param {string} cityOnly - country-suffix-stripped city text, BEFORE
 * `resolveAddress()`'s HQ.city fallback. Passing `resolveAddress()`'s output
 * instead re-introduces the exact footgun this guard exists to close: an
 * empty `cityOnly` would resolve through `resolveAddress` to HQ.city
 * ('Muttenz'), which then trivially infers canton 'BL' here and silently
 * defeats the skip guard for real-but-unresolvable location text (e.g. a
 * tile whose location is only ", Switzerland").
 * @returns {string|null} canton code, or null meaning "skip this job"
 */
export function resolveClariantCanton(realLocationText, rawLocation, cityOnly) {
  const inferredCanton = inferSwissTargetCanton(rawLocation) || inferSwissTargetCanton(cityOnly);
  if (normalizeSpace(realLocationText) && !inferredCanton) {
    return null;
  }
  return inferredCanton || HQ.canton;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Clariant.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isClariantJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CLARIANT_KEY ||
    key.startsWith('clariant') ||
    company.includes('clariant') ||
    url.includes('clariant.com') ||
    url.includes(JOBS2WEB_HOST)
  );
}

/**
 * Validate a URL belongs to Clariant's own domain or its Jobs2Web career site.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === CLARIANT_COMPANY_DOMAIN ||
      host.endsWith(`.${CLARIANT_COMPANY_DOMAIN}`) ||
      host === JOBS2WEB_HOST
    );
  } catch {
    return false;
  }
}

/* ── Listing parse (jobs2web search-results table, Clariant column order) ── */

/**
 * Parse a Clariant `/search/` results page into raw rows.
 *
 * Markup per row (verified live, `sortDirection=desc`):
 *   <tr class="data-row">
 *     <td class="colTitle"><span class="jobTitle hidden-phone">
 *       <a href="/job/{slug}/{id}/" class="jobTitle-link">{title}</a>
 *     </span>…</td>
 *     <td class="colLocation hidden-phone"><span class="jobLocation">{city}, {cc}</span></td>
 *     <td class="colDepartment hidden-phone"><span class="jobDepartment">{dept}</span></td>
 *     <td class="hidden-phone"></td>   <!-- no Date column on this tenant -->
 *   </tr>
 *
 * @param {string} html
 * @returns {Array<{href: string, title: string, location: string, department: string}>}
 */
export function parseClariantListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const rowRx = /<tr\s+class="data-row">([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRx.exec(html))) {
    const row = m[1];
    const titleMatch = row.match(/<a\s+href="([^"]+)"\s+class="jobTitle-link">([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const href = decodeHtmlEntities(titleMatch[1].trim());
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const title = cleanText(titleMatch[2]);
    if (!title || title.length < 3) continue;
    // A row whose anchor text is j2w page chrome (cookie-consent widget,
    // search/alert box) isn't a job at all — discard the row, don't clean it,
    // or it becomes a posting with no title.
    if (isSuccessFactorsWidgetText(title)) continue;

    const locMatch = row.match(/class="colLocation[^"]*"[\s\S]*?class="jobLocation">([\s\S]*?)<\/span>/i);
    const deptMatch = row.match(/class="colDepartment[^"]*"[\s\S]*?class="jobDepartment">([\s\S]*?)<\/span>/i);

    out.push({
      href,
      title,
      // `</span>`-bounded match also swallows the nested `<small>+N
      // more&hellip;</small>` of multi-location rows — keep the visible office.
      location: locMatch ? stripSuccessFactorsMoreLocations(cleanText(locMatch[1])) : '',
      department: deptMatch ? cleanText(deptMatch[1]) : '',
    });
  }
  return out;
}

/* ── Detail page parse ────────────────────────────────────────*/

/**
 * Extract the free-text description body from a Clariant Jobs2Web detail
 * page (the `<span class="jobdescription">…</span>` block).
 *
 * The block's own closing tag can't be anchored with a simple lazy
 * `</span>` match — the body is full of nested styling `<span>`s (bold
 * labels, colored headers), so the first `</span></span>` pair appears just
 * a few words in, not at the real end. Instead this cuts the HTML at the
 * next stable structural marker that always follows the description on
 * this tenant's two-column detail template: `<div class="jobColumnTwo">`
 * (the sidebar column). Trailing unclosed tags left over from the cut are
 * harmless — `stripHtml` only removes markup, it doesn't leak tag noise
 * into the extracted text.
 */
export function extractClariantDetailContent(html = '') {
  if (!html || typeof html !== 'string') return '';
  const startMarker = '<span class="jobdescription">';
  const start = html.indexOf(startMarker);
  if (start === -1) return '';
  const rest = html.slice(start + startMarker.length);
  const end = rest.search(/<div\s+class="[^"]*\bjobColumnTwo\b[^"]*"/i);
  const raw = end === -1 ? rest : rest.slice(0, end);
  return normalizeSpace(decodeHtmlEntities(stripHtml(raw)));
}

/**
 * Extract the schema.org JobPosting microdata `<meta itemprop="…">` fields
 * present on every Clariant detail page.
 *
 * @param {string} html
 * @returns {{ datePosted: string|null, hiringOrganization: string, locationLabel: string }}
 */
export function parseClariantMicrodata(html = '') {
  const result = { datePosted: null, hiringOrganization: '', locationLabel: '' };
  if (!html || typeof html !== 'string') return result;

  const dateMatch = html.match(/itemprop="datePosted"\s+content="([^"]+)"/i);
  if (dateMatch) {
    const parsed = new Date(dateMatch[1]);
    if (!Number.isNaN(parsed.getTime())) {
      result.datePosted = parsed.toISOString().slice(0, 10);
    }
  }

  const orgMatch = html.match(/itemprop="hiringOrganization"\s+content="([^"]+)"/i);
  if (orgMatch) result.hiringOrganization = decodeHtmlEntities(orgMatch[1]).trim();

  // The tenant overloads `streetAddress` with a "{city}, {country}" label,
  // NOT a real street — used only as a location fallback, never surfaced as
  // the actual `streetAddress` structured-data field.
  const locMatch = html.match(/itemprop="streetAddress"\s+content="([^"]+)"/i);
  if (locMatch) result.locationLabel = decodeHtmlEntities(locMatch[1]).trim();

  return result;
}

/**
 * Extract the internal SF requisition number from the description
 * preamble ("Job ID: 41492 | Location: … | Work Model: …").
 */
export function parseClariantJobId(descriptionText = '') {
  const m = String(descriptionText || '').match(/Job\s*ID:\s*(\d+)/i);
  return m ? m[1] : '';
}

function buildListingPageUrl(page) {
  if (page <= 0) return LISTING_URL;
  const url = new URL(LISTING_URL);
  url.searchParams.set('startrow', String(page * PAGE_SIZE));
  return url.toString();
}

/* ── Fetch + Assemble ──────────────────────────────────────── */

/**
 * Fetch all Clariant jobs (Switzerland only — `locationsearch=switzerland`
 * filters at the source, confirmed live to return only genuinely Swiss rows).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllClariantJobs() {
  console.log(`🔍 Fetching ${CLARIANT_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (SAP SuccessFactors / Jobs2Web)\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const tiles = [];
  const seenHref = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let listingHtml;
    try {
      listingHtml = await fetchHtml(buildListingPageUrl(page), { timeoutMs });
    } catch (err) {
      if (page === 0) {
        console.warn(`⚠️ Clariant Jobs2Web listing fetch failed: ${err?.message || err}`);
        throw err;
      }
      console.warn(`  ⚠️ Clariant listing page ${page} fetch failed, stopping pagination: ${err?.message || err}`);
      break;
    }
    const rows = parseClariantListing(listingHtml);
    let added = 0;
    for (const row of rows) {
      if (seenHref.has(row.href)) continue;
      seenHref.add(row.href);
      tiles.push(row);
      added += 1;
    }
    if (rows.length < PAGE_SIZE || added === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!tiles.length) {
    console.warn('⚠️ No Switzerland-located openings parsed from Clariant Jobs2Web listing.');
    return [];
  }
  console.log(`  📋 Switzerland listings found: ${tiles.length}`);

  const jobs = [];
  for (const tile of tiles) {
    const publicUrl = new URL(tile.href, DETAIL_BASE).toString();

    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(publicUrl, { timeoutMs });
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${tile.title}: ${err?.message || err}`);
    }

    const microdata = parseClariantMicrodata(detailHtml);
    // Same j2w widget bleed can land in the description block; sanitize
    // before it's used verbatim (or falls back to the department line).
    const detailDescription = sanitizeSuccessFactorsField(extractClariantDetailContent(detailHtml));
    const jobReqId = parseClariantJobId(detailDescription);

    const title = tile.title;
    const realLocationText = tile.location || microdata.locationLabel || '';
    const rawLocation = realLocationText || HQ.city;
    // Strip a trailing ", CH"/", Switzerland" country suffix before resolving.
    const cityOnly = rawLocation.replace(/,\s*(CH|Switzerland|Schweiz|Suisse|Svizzera)\s*$/i, '').trim();
    const { city, postalCode, streetAddress } = resolveAddress({ city: cityOnly });
    const location = normalizeSpace(cityOnly || city);
    const canton = resolveClariantCanton(realLocationText, rawLocation, cityOnly);
    if (canton === null) {
      console.warn(` ⚠️ Clariant: skipping unresolvable location "${realLocationText}" (${title})`);
      continue;
    }

    const descParts = [];
    if (detailDescription) descParts.push(detailDescription);
    else if (tile.department) descParts.push(`Bereich: ${tile.department}`);
    const description = descParts.length
      ? descParts.join('\n\n')
      : `${title} — ${CLARIANT_COMPANY_NAME} (${location}).`;

    const sourceLang = detectLang(description || title, 'en');
    const jobSlug = slugify(`${title} clariant ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const contract = normalizeContract('', title, description);
    const employmentType = contract === 'part-time' ? 'PART_TIME' : 'FULL_TIME';
    const postedDate = microdata.datePosted || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${CLARIANT_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: microdata.hiringOrganization || CLARIANT_COMPANY_NAME,
      companyKey: CLARIANT_KEY,
      companyDomain: CLARIANT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Clariant Dedicated Parser (SuccessFactors Jobs2Web)',
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
      jobReqId: jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n📋 Total ${CLARIANT_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { CAREER_URL };
