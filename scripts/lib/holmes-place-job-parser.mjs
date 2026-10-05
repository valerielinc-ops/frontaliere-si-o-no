#!/usr/bin/env node
/**
 * Holmes Place (Switzerland) job parser — bespoke Playwright DOM scrape.
 *
 * ATS discovery (issue #3337 backlog tags Holmes Place as "Custom" — many
 * rows in that backlog turned out to be mislabeled well-known ATS vendors,
 * so this was independently re-verified rather than taken on faith):
 *
 *   1. https://www.holmesplace.ch/de/karriere (and the plain /karriere
 *      alias) both return a genuine Cloudflare bot-management challenge
 *      ("Attention Required! | Cloudflare") to a raw `curl`, regardless of
 *      User-Agent/header sophistication — confirmed via direct HTML
 *      inspection of the 403 body. This is real CF Bot Management, not just
 *      a naive UA sniff (those are usually bypassable with a realistic UA;
 *      this one was not).
 *   2. robots.txt on holmesplace.ch does not reference or disallow any
 *      third-party ATS path (no `/wd/`, `/successfactors`, `/greenhouse`,
 *      `/lever`, `/smartrecruiters`, `/personio`, `/prescreen`, `/onlyfy`,
 *      `/jobcloud`, `/ostjob`, `/jobup`, `/talentsoft`, `/cornerstone`,
 *      `/icims`, `/taleo`, `/bamboohr`, `/recruitee`, `/softgarden`, `/rexx`,
 *      `/umantis`, `/beetween`, `/teamtailor`, `/join`, `/honeypot`,
 *      `/stepstone`, or a `jobs.ch`/JobCloud widget embed) — none of the
 *      ~25 known vendor fingerprints this repo has previously found behind
 *      other "Custom"-labeled sites showed up.
 *   3. Holmes Place DOES use a third-party recruiting SaaS elsewhere in the
 *      group: `prescreen.io`/`jobbase.io` (rebranded `onlyfy.jobs`), an
 *      Austrian recruiting-software product. Several plausible Swiss-tenant
 *      subdomains were probed on both `*.jobbase.io` and `onlyfy.jobs`; the
 *      only tenant that resolves is the GERMANY one, and its own embedded
 *      Next.js page payload declares `"countries":[{"id":"de"}]` — i.e. it
 *      explicitly does NOT cover Switzerland. This rules out a hidden CH
 *      Prescreen/onlyfy tenant; the Swiss market is served by the in-house
 *      site instead. (Documented here because it's the kind of thing that
 *      looks like a false "Custom" verdict at first glance but isn't.)
 *   4. Wayback Machine snapshots of holmesplace.ch from 2024 (pre-dating
 *      whatever more aggressive CF Bot Management rule now blocks curl)
 *      show a genuinely bespoke in-house component: JS bundle names like
 *      `CareerTable.<hash>.chunk.js`, CSS classes `.c-careerTable`,
 *      `.c-careerTable__table`, `.cvHolder`, and an inline apply widget
 *      (submit/success/error states baked into the same bundle, no
 *      redirect to an external application form). Grepping that bundle for
 *      the same ~25 ATS vendor name patterns found nothing. Conclusion:
 *      "Custom" is CORRECT for the Swiss market specifically.
 *   5. Checked `scripts/lib/ats-clients/` for a fitness/gym-chain client and
 *      grepped existing `*-job-parser.mjs` files for any other gym-chain
 *      crawler to reuse markup/selectors from — none exists in this repo.
 *      No shared parser fits, so this file is bespoke, but it reuses:
 *        - `./ats-clients/playwright-runtime.mjs` (the same CF-hardened
 *          browser helper already used by 11 other bespoke CF-gated sites:
 *          bucherer, heineken-ch, hilti, bobst, pictet, richemont,
 *          salina-reha, stadtspital-zuerich, vaudoise, hofweissbad).
 *        - `./strip-contact-pii.mjs` (`stripContactPII`) — gym-chain
 *          postings are branch-run and sometimes leak a branch manager's
 *          direct name/phone/email inline in the description; this is the
 *          exact same class of leak `stripContactPII` was built for
 *          (Allianz erasure request, 2026-06-05), so it is reused here
 *          rather than re-implemented.
 *
 *   Live DOM selectors: the current main page was verified as job cards with
 *   same-domain `/jobs/{slug}` links, and the companion CareerTable markup
 *   was verified through its current rendered table. The nested class names
 *   can still drift, so the scrape is anchored to semantic detail URLs,
 *   table rows, and location metadata rather than treating every career-page
 *   anchor as a job title. An unrecognised/blocked page returns `[]` with a
 *   fetch outcome, allowing the existing slice guard to preserve the last
 *   good data instead of silently replacing it.
 *
 * The current Swiss career page exposes a real `/jobs/{slug}` detail URL for
 * each card, while the companion `checkout.holmesplace.ch` CareerTable uses a
 * tabular listing. The parser keeps those detail URLs as the job identity and
 * enriches each row from its own detail page before publishing. The CareerTable
 * remains a source fallback when the main page is blocked or its card layout
 * changes.
 *
 * HQ / per-branch addresses — Holmes Place Switzerland runs MULTIPLE
 * physical gym branches, not one office, so a single canton-wide HQ
 * fallback would be wrong (a Genève posting must never inherit an Oberrieden
 * street just because a job's canton lookup happens to run through ZH by
 * accident, and — the trickier case — a generic "Zürich" posting must not
 * silently inherit the Oberrieden HQ street just because Zürich shares
 * canton ZH with the HQ). `resolveAddress()` below is gated on branch/city
 * TEXT matches (never canton-only), following the same discipline as
 * `staubli-job-parser.mjs`'s `resolveAddress()`. Registered legal seat
 * confirmed via 2 independent sources:
 *   1. Zefix (https://www.zefix.ch) public register API — firm search
 *      "Holmes Place" → "Holmes Place (Schweiz) GmbH", Seestrasse 97, 8942
 *      Oberrieden ZH.
 *   2. jobs.ch company profile page (independent third-party listing) —
 *      same address.
 * NOTE: the legal form converted AG → GmbH in 2024 (SHAB-confirmed via the
 * Zefix mutation history) — several third-party sources (jobs.ch prose,
 * general web search results) still say "Holmes Place AG"; that is stale.
 * Per-branch street addresses for the other 4 Swiss clubs (Zürich ×2,
 * Genève, Lausanne) were cross-checked across independent directory
 * listings (search.ch, local.ch, opencorpdata.com) since Holmes Place does
 * not publish a single combined "our locations" address table.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHolmesPlaceJobs()   — Fetch and parse all jobs
 *   - isHolmesPlaceJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - HOLMES_PLACE_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 * Plus pure, independently-testable helpers:
 *   - resolveAddress()            — city/branch-gated address resolution
 *   - normalizeHolmesPlaceListing() — raw DOM-scrape row -> clean listing
 *   - detectCategory() / detectEmploymentType()
 */
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, normalizeSpace } from './crawler-template.mjs';
import { bodyTextOf, extractJsonLd } from './prospector/extract.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
  BrowserLaunchError,
  NavigationTimeout,
  AntiBotBlockError,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOLMES_PLACE_KEY = 'holmes-place';
export const HOLMES_PLACE_COMPANY_NAME = 'Holmes Place';
export const HOLMES_PLACE_COMPANY_DOMAIN = 'holmesplace.ch';

const CAREER_URL = 'https://www.holmesplace.ch/karriere/';
const CAREER_FALLBACK_URL = 'https://checkout.holmesplace.ch/fr/homepage/carrieres/';
const CAREER_URLS = [CAREER_URL, CAREER_FALLBACK_URL];
const SECTOR = 'Fitness / Wellness';

/**
 * Registered HQ (see header docblock for the 2-source verification).
 * Also the generic canton/postal fallback exposed via
 * `crawler-location-config.mjs` (`getCompanyDefaults('holmes-place')`) —
 * kept in sync here for the concrete street, which the shared config file
 * intentionally omits (see the comment on that entry).
 */
const CONFIG_HQ = getCompanyDefaults(HOLMES_PLACE_KEY) || {
  city: 'Oberrieden',
  canton: 'ZH',
  postalCode: '8942',
  addressRegion: 'ZH',
};

/**
 * The 5 known Swiss branches, each gated on a text match against the raw
 * job's title/location — NEVER matched by canton alone. Order matters: more
 * specific brand/keyword matches are checked before the generic city-name
 * fallback so e.g. a "Crowne Plaza" posting located in "Zürich" resolves to
 * that specific club rather than falling through to the ambiguous
 * city-only branch below.
 */
const BRANCHES = [
  {
    key: 'oberrieden',
    city: 'Oberrieden',
    canton: 'ZH',
    postalCode: '8942',
    streetAddress: 'Seestrasse 97',
    addressRegion: 'ZH',
    match: /oberrieden|hauptsitz|headquarters/i,
  },
  {
    key: 'zurich-crowne-plaza',
    city: 'Zürich',
    canton: 'ZH',
    postalCode: '8040',
    streetAddress: 'Badenerstrasse 420',
    addressRegion: 'ZH',
    match: /crowne\s*plaza|altstetten|z[uü]rich\s*west/i,
  },
  {
    key: 'zurich-jelmoli',
    city: 'Zürich',
    canton: 'ZH',
    postalCode: '8001',
    streetAddress: 'Steinmühleplatz 1',
    addressRegion: 'ZH',
    match: /jelmoli|z[uü]rich\s*city\b/i,
  },
  {
    key: 'geneve',
    city: 'Genève',
    canton: 'GE',
    postalCode: '1204',
    streetAddress: 'Rue du Rhône 50',
    addressRegion: 'GE',
    match: /gen[eè]ve|geneva|genf/i,
  },
  {
    key: 'lausanne',
    city: 'Lausanne',
    canton: 'VD',
    postalCode: '1003',
    streetAddress: 'Rue de la Mercerie 12',
    addressRegion: 'VD',
    match: /lausanne/i,
  },
];
const HQ = BRANCHES[0];

// City names shared by MORE THAN ONE branch — a bare city-name match on one
// of these is ambiguous and must NOT resolve to a street address (only a
// brand/keyword match above can disambiguate it). This is what stops a
// generic "Zürich" posting from silently inheriting either Zürich branch's
// street, and — more importantly per the task's negative control — from
// inheriting the Oberrieden HQ street just because Zürich and Oberrieden
// share canton ZH.
const AMBIGUOUS_CITIES = new Set(['zürich', 'zurich']);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Resolve the best city / postal code / street address for a job.
 *
 * Real per-job data (explicit `raw.streetAddress`/`raw.postalCode`) always
 * wins when present. Absent that, a branch is resolved by:
 *   1. a brand/keyword match against the combined title+location text
 *      (handles e.g. "Crowne Plaza" appearing in either field), else
 *   2. a bare city-name match — but ONLY for branch cities that are not
 *      shared by another branch (Oberrieden/Genève/Lausanne are each
 *      unique; "Zürich" is excluded because 2 branches share it), else
 *   3. the HQ branch itself — but ONLY when there is no location text at
 *      all (nothing to disambiguate), never for an ambiguous non-HQ city.
 *
 * This mirrors `staubli-job-parser.mjs`'s `resolveAddress()` gating
 * discipline (city-text-gated, never canton-only), extended to multiple
 * branches instead of a single HQ.
 *
 * @param {{ title?: string, location?: string, city?: string, streetAddress?: string, postalCode?: string }} [raw]
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(raw = {}) {
  const explicitCity = normalizeSpace(raw.city || raw.location || '');
  const explicitStreet = normalizeSpace(raw.streetAddress || '');
  const explicitPostal = normalizeSpace(raw.postalCode || '');
  const searchText = `${raw.title || ''} ${raw.location || ''} ${raw.city || ''}`;

  const brandMatch = BRANCHES.find((b) => b.match.test(searchText));
  const uniqueCityMatch =
    !brandMatch && explicitCity
      ? BRANCHES.find(
          (b) =>
            !AMBIGUOUS_CITIES.has(b.city.toLowerCase()) &&
            new RegExp(b.city, 'i').test(explicitCity),
        )
      : null;
  const branch = brandMatch || uniqueCityMatch || (!explicitCity ? HQ : null);

  // A brand/keyword match (e.g. "Crowne Plaza") may come from raw text that
  // is a venue/club name rather than a plain city name (e.g. location field
  // literally reading "Crowne Plaza" with no city at all) — in that case
  // trust the canonical branch.city rather than the raw text so `city`
  // stays a real Swiss city for structured data. A `uniqueCityMatch` (or no
  // match at all) means `explicitCity` was already a genuine city string, so
  // it is kept as-is.
  const city = brandMatch ? brandMatch.city : explicitCity || (branch ? branch.city : HQ.city);

  return {
    city,
    postalCode: explicitPostal || (branch ? branch.postalCode : ''),
    streetAddress: explicitStreet || (branch ? branch.streetAddress : ''),
  };
}

/**
 * Resolve canton/addressRegion for a job, matched by postalCode (unique per
 * branch — city alone is ambiguous for the 2 Zürich branches). Falls through
 * to city-text canton inference (never straight to the HQ canton) so a job
 * posted from a city outside the 5 known branches — a scrape drift or a
 * genuinely new location — doesn't get silently mislabeled as Oberrieden/ZH.
 *
 * @param {string} postalCode
 * @param {string} city
 * @param {string} [location]
 * @returns {string} canton/addressRegion code
 */
export function resolveCantonFallback(postalCode, city, location = '') {
  return (
    BRANCHES.find((b) => b.postalCode === postalCode)?.canton ||
    inferAnyCanton(city || location) ||
    CONFIG_HQ.canton
  );
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Holmes Place.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHolmesPlaceJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HOLMES_PLACE_KEY ||
    key.startsWith('holmes-place') ||
    company.includes('holmes place') ||
    url.includes('holmesplace.ch')
  );
}

/**
 * Validate that a URL belongs to Holmes Place's own domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === HOLMES_PLACE_COMPANY_DOMAIN || host.endsWith(`.${HOLMES_PLACE_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

/* ── Category / Employment detection (fitness-chain taxonomy) ─ */

/**
 * Fitness/gym-chain category taxonomy — deliberately NOT the generic
 * office-job taxonomy used by other parsers (`Ingegneria`/`Amministrazione`
 * etc. would misclassify almost every Holmes Place posting).
 */
export function detectCategory(title = '') {
  const t = normalize(title);
  if (/personal\s*train|pt\b/.test(t)) return 'Personal Trainer';
  if (/group\s*fitness|instructor|kursleit|cours\s*collectif/.test(t)) return 'Group Fitness';
  if (/reception|empfang|réception|club\s*admin|front\s*desk/.test(t)) return 'Club Admin / Reception';
  if (/sales|verkauf|vente|membership|mitgliederberat/.test(t)) return 'Sales';
  if (/spa|wellness|massage|beaut/.test(t)) return 'Spa / Wellness';
  if (/nutrition|ernährung|diét/.test(t)) return 'Nutrition';
  if (/facility|maintenance|techni|hausmeister|unterhalt/.test(t)) return 'Facility / Maintenance';
  if (/manager|leiter|director|directeur|responsab/.test(t)) return 'Management';
  return 'Altro';
}

export function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|temps\s*partiel)\b/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|temps\s*plein)\b/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Listing normalization (pure, testable) ──────────────────── */

/**
 * Normalize a raw DOM-scrape row (as returned by `page.evaluate`, or a test
 * fixture standing in for one) into a clean listing object. Pure function —
 * no network/Playwright involved — so it is unit-testable with fixture rows
 * without spinning up a browser.
 *
 * @param {{ title?: string, location?: string, category?: string, url?: string, description?: string, postedDate?: string, datePosted?: string, postingDateSource?: string }} raw
 * @returns {{ title: string, location: string, category: string, description?: string, url?: string, postedDate?: string, datePosted?: string, postingDateSource?: string } | null}
 */
export function normalizeHolmesPlaceListing(raw = {}) {
  const title = normalizeSpace(raw.title || '');
  if (!title || title.length < 3) return null;
  const listing = {
    title,
    location: normalizeSpace(raw.location || ''),
    category: normalizeSpace(raw.category || ''),
    ...(raw.postingDateSource ? mergeSourcePostingDates({}, raw) : {}),
  };
  const url = normalizeSpace(raw.url || '');
  if (url) listing.url = url;
  const description = String(raw.description || '').trim();
  if (description) listing.description = description;
  return listing;
}

/* ── Fetch (Playwright, semantic DOM scrape) ─────────────────── */

const JOB_DETAIL_PATH_RE = /\/jobs\/[^/?#]+/i;
const JOB_DETAIL_SLUG_RE = /\/jobs\/([^/?#]+)\/?$/i;
const GENERIC_CTA_RE = /^(?:mehr erfahren|sich bewerben|see more|apply(?: now)?|postuler|en savoir plus|learn more|go to club|career(?:s)?|karriere|carri[eè]res?|jobs?|stellenangebote?|offres? d['’]?emploi)[.!?]*$/i;
const BRANCH_LOCATION_RE = /\b(?:oberrieden|zürich|zurich|geneva|gen[eè]ve|genf|lausanne|crowne\s+plaza|jelmoli)\b/i;
const CAREER_MARKER_RE = /(?:karriere|carri[eè]re|career|stellen(?:angebote)?|postes|offres? d['’]?emploi|jobangebote?|bewerb|candidatur|online[- ]tool|travaill(?:ez|er)\s+(?:bei|chez)|work(?:ing)?\s+(?:at|for))/i;
const CAREER_TABLE_CONTAINER_SELECTOR = '.c-careerTable, .c-careerTable__table, .cvHolder';
const CAREER_TABLE_ROW_SELECTOR = 'tr, .c-careerTable__row, [data-job-id], [data-career-id]';
const CAREER_CONTEXT_SELECTOR = '.section-two-text-wrapper, .beginnen-paragraph';
const DETAIL_BODY_SELECTORS = [
  '[data-job-description]',
  '[data-description]',
  '.job-detail__description',
  '.job-description',
  '.career-detail__content',
  '.career-detail',
  '.job-detail',
  '.job-content',
  '.career-content',
];
const DETAIL_NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  '[role="navigation"]',
  '[class*="apply"]',
  '[class*="related"]',
  '[class*="share"]',
  '[class*="cookie"]',
  '[class*="consent"]',
].join(', ');
const PER_DETAIL_DELAY_MS = 1_500;
const DETAIL_WAIT_NETWORK_IDLE_MS = 10_000;

function annotateListings(listings, fetchOutcome, fetchDetail = '') {
  Object.defineProperties(listings, {
    discoveredCount: { value: listings.length, enumerable: false },
    fetchOutcome: { value: fetchOutcome, enumerable: false },
    fetchDetail: { value: fetchDetail, enumerable: false },
  });
  return listings;
}

function nodeText(node) {
  return normalizeSpace(node?.textContent || '');
}

function nodeMetadata(node) {
  if (!node) return '';
  return normalizeSpace(
    `${node.getAttribute?.('class') || ''} ${node.getAttribute?.('id') || ''} ${node.getAttribute?.('aria-label') || ''}`,
  );
}

function isMeaningfulTitle(value) {
  const title = normalizeSpace(value);
  return title.length >= 3 && !GENERIC_CTA_RE.test(title);
}

function isJobDetailHref(rawHref, baseUrl = CAREER_URL) {
  try {
    const url = new URL(rawHref, baseUrl);
    return isTrustedDomain(url.href) && JOB_DETAIL_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeHolmesPlaceJobUrl(rawHref, baseUrl = CAREER_URL) {
  if (!rawHref) return '';
  try {
    const url = new URL(rawHref, baseUrl);
    if (!isTrustedDomain(url.href) || !JOB_DETAIL_PATH_RE.test(url.pathname)) return '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function extractHolmesPlaceDetailSlug(rawUrl = '') {
  try {
    const url = new URL(rawUrl, CAREER_URL);
    const rawSlug = url.pathname.match(JOB_DETAIL_SLUG_RE)?.[1] || '';
    try {
      return decodeURIComponent(rawSlug);
    } catch {
      return rawSlug;
    }
  } catch {
    return '';
  }
}

function buildHolmesPlaceJobSlug(title, city, jobUrl, urlHash = '') {
  const detailSlug = extractHolmesPlaceDetailSlug(jobUrl);
  const disambiguator = detailSlug || urlHash || createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);
  return slugify(`${title} holmes-place ${city} ${disambiguator}`);
}

function metadataText(root, pattern) {
  const elements = [root, ...(root?.querySelectorAll?.('*') || [])];
  return elements
    .filter((element) => pattern.test(nodeMetadata(element)))
    .map(nodeText)
    .find(Boolean) || '';
}

function branchLocationFromText(value) {
  const match = String(value || '').match(BRANCH_LOCATION_RE);
  return match ? normalizeSpace(match[0]) : '';
}

function directCells(row) {
  return [...row.querySelectorAll('th, td')].filter((cell) => cell.parentElement === row);
}

function findMeaningfulHeading(root) {
  return [...root.querySelectorAll('h2, h3, h4, [role="heading"]')]
    .find((heading) => isMeaningfulTitle(nodeText(heading))) || null;
}

function findJobCard(link) {
  let ancestor = link.parentElement;
  let fallback = null;
  for (let depth = 0; ancestor && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
    const heading = findMeaningfulHeading(ancestor);
    if (!heading) continue;
    const detailLinks = [...ancestor.querySelectorAll('a[href]')]
      .filter((candidate) => isJobDetailHref(candidate.getAttribute('href') || ''));
    if (detailLinks.length > 4) continue;

    const candidate = {
      root: ancestor,
      heading,
      location: metadataText(ancestor, /location|club|standort|lieu|city/i),
      category: metadataText(ancestor, /category|department|bereich|secteur/i),
    };
    if (candidate.location || detailLinks.length <= 1 || /career|job|vacan|position|offer/i.test(nodeMetadata(ancestor))) {
      return candidate;
    }
    fallback ||= candidate;
  }
  return fallback;
}

function collectCareerTableRows(document) {
  const rows = new Set();
  for (const container of document.querySelectorAll(CAREER_TABLE_CONTAINER_SELECTOR)) {
    for (const row of container.querySelectorAll(CAREER_TABLE_ROW_SELECTOR)) rows.add(row);
  }
  return [...rows];
}

function extractHolmesPlaceCareerContext(document) {
  return [...document.querySelectorAll(CAREER_CONTEXT_SELECTOR)]
    .map((node) => bodyTextOf(node.innerHTML))
    .filter((text) => CAREER_MARKER_RE.test(text) && /holmes\s+place|team/i.test(text))
    .sort((left, right) => right.length - left.length)[0] || '';
}

function sourceBackedDescription(...parts) {
  const description = parts.map((part) => normalizeSpace(part)).filter(Boolean).join('\n\n');
  return meetsSourceBodyFloor(description) ? description : '';
}

/**
 * Parse the rendered career document without treating CTA anchors as jobs.
 * The live page has appeared both as cards with `/jobs/...` links and as the
 * `CareerTable` table, so rows are parsed first and cards second. The helper
 * is deliberately DOM-based and exported through `__testables` for fixtures.
 */
export function extractHolmesPlaceListingsFromDocument(document, baseUrl = CAREER_URL) {
  const listings = [];
  const seen = new Set();
  const careerContext = extractHolmesPlaceCareerContext(document);

  const pushListing = (raw, { allowMissingUrl = false } = {}) => {
    const listing = normalizeHolmesPlaceListing(raw);
    if (!listing) return;

    let detailUrl = normalizeHolmesPlaceJobUrl(raw.url || raw.href, baseUrl);
    if (!detailUrl && raw.jobId) {
      try {
        const fallbackUrl = new URL(baseUrl);
        fallbackUrl.hash = `job-${encodeURIComponent(String(raw.jobId))}`;
        detailUrl = fallbackUrl.toString();
      } catch {
        detailUrl = '';
      }
    }
    if (!detailUrl && allowMissingUrl) {
      try {
        const fallbackUrl = new URL(baseUrl);
        fallbackUrl.hash = `job-${slugify(`${listing.title}-${listing.location}`)}`;
        detailUrl = fallbackUrl.toString();
      } catch {
        detailUrl = '';
      }
    }
    if (!detailUrl && !allowMissingUrl) return;
    if (detailUrl) listing.url = detailUrl;

    const key = `${listing.title.toLowerCase()}|${listing.location.toLowerCase()}|${detailUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    listings.push(listing);
  };

  const rows = collectCareerTableRows(document);
  for (const row of rows) {
    const cells = directCells(row);
    const anchors = [...row.querySelectorAll('a[href]')];
    const titleLink = anchors.find((link) => isMeaningfulTitle(nodeText(link)));
    const detailLink = anchors.find((link) => isJobDetailHref(link.getAttribute('href') || ''));
    const heading = findMeaningfulHeading(row);
    const firstCell = cells[0];
    const titleNode = heading || titleLink || firstCell;
    if (!titleNode || (firstCell?.tagName === 'TH' && !heading && !titleLink)) continue;
    if (!isMeaningfulTitle(nodeText(titleNode))) continue;

    const location =
      metadataText(row, /location|club|standort|lieu|city/i) ||
      nodeText(cells[1]) ||
      branchLocationFromText(nodeText(row));
    const category = metadataText(row, /category|department|bereich|secteur/i);
    const summary = [...row.querySelectorAll('p')].map(nodeText).find(Boolean) || '';
    pushListing(
      {
        title: nodeText(titleNode),
        location,
        category,
        description: sourceBackedDescription(summary, careerContext),
        href: detailLink?.getAttribute('href') || titleLink?.getAttribute('href') || '',
        jobId: row.getAttribute('data-job-id') || row.getAttribute('data-career-id') || '',
      },
      { allowMissingUrl: Boolean(row.closest(CAREER_TABLE_CONTAINER_SELECTOR)) },
    );
  }

  const detailLinks = [...document.querySelectorAll('a[href]')]
    .filter((link) => isJobDetailHref(link.getAttribute('href') || ''));
  for (const link of detailLinks) {
    const card = findJobCard(link);
    if (!card) continue;
    pushListing({
      title: nodeText(card.heading),
      location: card.location || branchLocationFromText(nodeText(card.root)),
      category: card.category,
      description: sourceBackedDescription(
        [...card.root.querySelectorAll('p')].map(nodeText).find(Boolean) || '',
        careerContext,
      ),
      href: link.getAttribute('href') || '',
    });
  }

  return listings;
}

export function extractHolmesPlaceListingsFromHtml(html = '', baseUrl = CAREER_URL) {
  const dom = new JSDOM(String(html || ''), { url: baseUrl });
  try {
    return extractHolmesPlaceListingsFromDocument(dom.window.document, baseUrl);
  } finally {
    dom.window.close();
  }
}

export function hasHolmesPlaceCareerMarkup(html = '', baseUrl = CAREER_URL) {
  const dom = new JSDOM(String(html || ''), { url: baseUrl });
  try {
    const document = dom.window.document;
    const visibleText = nodeText(document.body);
    const tableHeader = /(?:berufsbezeichnung|intitul[eé] du poste|job title|standort|lieu)/i.test(visibleText);
    const knownContainer = Boolean(document.querySelector(CAREER_TABLE_CONTAINER_SELECTOR));
    return tableHeader || knownContainer || CAREER_MARKER_RE.test(visibleText);
  } finally {
    dom.window.close();
  }
}

function extractJsonLdJobDescription(document) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed;
    try {
      parsed = JSON.parse(script.textContent || '');
    } catch {
      continue;
    }
    const candidates = [
      ...(Array.isArray(parsed) ? parsed : [parsed]),
      ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : []),
    ];
    const jobPosting = candidates.find((candidate) => {
      const type = candidate?.['@type'];
      return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
    });
    const description = bodyTextOf(jobPosting?.description || '');
    if (meetsSourceBodyFloor(description)) return description;
  }
  return '';
}

function sourceBodyFromDetailElement(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll(DETAIL_NOISE_SELECTOR).forEach((node) => node.remove());
  return bodyTextOf(clone.innerHTML || '');
}

/**
 * Extract only the vacancy body from a rendered Holmes Place detail page.
 * Generic page chrome is removed before the shared source-body floor is
 * applied; a short page therefore cannot become publishable by accident.
 */
export function extractHolmesPlaceDetailDescriptionFromHtml(html = '', baseUrl = CAREER_URL) {
  const dom = new JSDOM(String(html || ''), { url: baseUrl });
  try {
    const structuredDescription = extractJsonLdJobDescription(dom.window.document);
    if (structuredDescription) return structuredDescription;

    for (const selector of DETAIL_BODY_SELECTORS) {
      for (const element of dom.window.document.querySelectorAll(selector)) {
        const description = sourceBodyFromDetailElement(element);
        if (meetsSourceBodyFloor(description)) return description;
      }
    }
    return '';
  } finally {
    dom.window.close();
  }
}

async function fetchHolmesPlaceDetailFields(context, detailUrl, title) {
  const empty = { description: '', ...mergeSourcePostingDates({}, {}) };
  if (!isJobDetailHref(detailUrl)) return empty;
  let page = null;
  try {
    page = await fetchWithRateLimit(context, detailUrl, { minDelayMs: PER_DETAIL_DELAY_MS });
    try {
      await page.waitForLoadState('networkidle', { timeout: DETAIL_WAIT_NETWORK_IDLE_MS });
    } catch {
      /* networkidle is best-effort; inspect the rendered DOM regardless */
    }
    const html = await page.content();
    const description = extractHolmesPlaceDetailDescriptionFromHtml(html, page.url() || detailUrl);
    const records = extractJsonLd(html, detailUrl);
    const record = records.find((candidate) => normalizeSpace(candidate.title).toLowerCase() === title.toLowerCase()
      && (candidate.urlExplicit ? candidate.url === detailUrl : records.length === 1));
    if (!description) {
      console.warn(`   ⚠️ Holmes Place detail page has no source body: ${detailUrl}`);
    }
    return { description, ...mergeSourcePostingDates({}, record || {}) };
  } catch (err) {
    console.warn(`   ⚠️ Holmes Place detail fetch failed for ${detailUrl}: ${err?.message || err}`);
    return empty;
  } finally {
    await page?.close().catch(() => undefined);
  }
}

async function enrichHolmesPlaceListings(context, listings) {
  const enriched = [];
  for (const listing of listings) {
    let description = listing.description || '';
    let publication = mergeSourcePostingDates({}, listing);
    if (listing.url) {
      const detail = await fetchHolmesPlaceDetailFields(context, listing.url, listing.title);
      publication = mergeSourcePostingDates(publication, detail);
      if (meetsSourceBodyFloor(detail.description)) description = detail.description;
    }
    enriched.push({ ...listing, ...(description ? { description } : {}), ...publication });
  }
  return enriched;
}

function annotateNormalizedJobs(jobs, rawListings, fallbackOutcome = 'selector_miss') {
  const rawOutcome = rawListings?.fetchOutcome;
  Object.defineProperties(jobs, {
    discoveredCount: {
      value: Number.isFinite(rawListings?.discoveredCount)
        ? rawListings.discoveredCount
        : Array.isArray(rawListings)
          ? rawListings.length
          : 0,
      enumerable: false,
    },
    fetchOutcome: {
      value: jobs.length > 0 ? 'ok' : rawOutcome || fallbackOutcome,
      enumerable: false,
    },
  });
  return jobs;
}

async function fetchJobListings() {
  let browser = null;
  try {
    browser = await createBrowser();
  } catch (err) {
    if (err instanceof BrowserLaunchError) {
      console.warn(`   ⚠️ chromium launch failed (${err.message}); returning [].`);
      return annotateListings([], 'connection_error', 'browser_launch');
    }
    throw err;
  }

  try {
    const context = await createPoliteContext(browser);
    let sawRecognizedPage = false;
    let sawPage = false;
    let sawAntiBotBlock = false;
    let sawConnectionError = false;

    for (const sourceUrl of CAREER_URLS) {
      console.log(`   Fetching from: ${sourceUrl}`);
      let page = null;
      try {
        page = await fetchWithRateLimit(context, sourceUrl);
        sawPage = true;
        try {
          await page.waitForLoadState('networkidle', { timeout: 10_000 });
        } catch {
          /* networkidle is best-effort; carry on with the rendered DOM */
        }

        const html = await page.content();
        const listings = extractHolmesPlaceListingsFromHtml(html, page.url() || sourceUrl);
        if (hasHolmesPlaceCareerMarkup(html, page.url() || sourceUrl)) sawRecognizedPage = true;
        if (listings.length > 0) {
          const enrichedListings = await enrichHolmesPlaceListings(context, listings);
          return annotateListings(
            enrichedListings,
            'ok',
            `${sourceUrl} listings=${listings.length} detailEnriched=${enrichedListings.filter((listing) => listing.description).length}`,
          );
        }
        console.warn(`   ⚠️ Holmes Place career page rendered but exposed no validated job rows: ${sourceUrl}`);
      } catch (err) {
        if (err instanceof AntiBotBlockError) {
          sawAntiBotBlock = true;
          console.warn(
            `   ⚠️ Holmes Place returned an anti-bot block ` +
              `(status=${err.status ?? 'n/a'}, title=${JSON.stringify(err.title ?? '')}); trying the fallback source.`,
          );
        } else if (err instanceof NavigationTimeout) {
          sawConnectionError = true;
          console.warn(`   ⚠️ Holmes Place navigation timed out for ${sourceUrl}; trying the fallback source.`);
        } else {
          sawConnectionError = true;
          console.warn(`   ⚠️ Holmes Place scrape failed for ${sourceUrl}: ${err?.message || err}`);
        }
      } finally {
        await page?.close().catch(() => undefined);
      }
    }

    const outcome = sawRecognizedPage
      ? 'selector_miss'
      : sawAntiBotBlock && !sawPage
        ? 'anti_bot_block'
        : sawConnectionError && !sawPage
          ? 'connection_error'
          : 'selector_miss';
    return annotateListings([], outcome, `sources=${CAREER_URLS.length}`);
  } finally {
    await closeAll(browser);
  }
}

/**
 * Fetch all Holmes Place jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllHolmesPlaceJobs() {
  console.log(`🔍 Fetching ${HOLMES_PLACE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const rawListings = await fetchJobListings();
  if (!rawListings || rawListings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return annotateNormalizedJobs([], rawListings, 'selector_miss');
  }

  const listings = rawListings.map(normalizeHolmesPlaceListing).filter(Boolean);
  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const { title } = listing;
    const { city, postalCode, streetAddress } = resolveAddress({
      title: listing.title,
      location: listing.location,
    });
    const location = normalizeSpace(listing.location || city);

    const description = stripContactPII(listing.description || '');
    if (!meetsSourceBodyFloor(description)) continue;

    const sourceLang = detectLang(`${title} ${listing.location}`, 'de');
    const jobUrl = listing.url || CAREER_URL;
    const urlHash = createHash('sha1')
      .update(jobUrl)
      .digest('hex')
      .slice(0, 12);
    const jobSlug = buildHolmesPlaceJobSlug(title, city, jobUrl, urlHash);
    const employmentType = detectEmploymentType(`${title} ${listing.category}`);

    const job = {
      // ── Required fields ──
      id: `${HOLMES_PLACE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HOLMES_PLACE_COMPANY_NAME,
      companyKey: HOLMES_PLACE_KEY,
      companyDomain: HOLMES_PLACE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      // Matched by postalCode (unique per branch — city alone is ambiguous
      // for the 2 Zürich branches) rather than re-deriving from resolveAddress.
      canton: resolveCantonFallback(postalCode, city, location),
      url: jobUrl,
      source: 'Holmes Place Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: resolveCantonFallback(postalCode, city, location),
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, listing),
      applyUrl: jobUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${HOLMES_PLACE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return annotateNormalizedJobs(jobs, rawListings, listings.length > 0 ? 'ok' : 'selector_miss');
}

export const __testables = {
  CAREER_URL,
  CAREER_FALLBACK_URL,
  CAREER_URLS,
  extractHolmesPlaceListingsFromDocument,
  extractHolmesPlaceListingsFromHtml,
  hasHolmesPlaceCareerMarkup,
  extractHolmesPlaceDetailDescriptionFromHtml,
  buildHolmesPlaceJobSlug,
};
