#!/usr/bin/env node
/**
 * Croix-Rouge fribourgeoise (Fribourg cantonal Red Cross section) job parser.
 *
 * Discovery note (issue #3342 row 85, last of the 85-company backlog): the
 * public careers page (https://www.croix-rouge-fr.ch/fr/emploi) itself only
 * links two seasonal PDF volunteer flyers plus a "Postuler via Jobup" button
 * pointing at `https://company.jobcloud.ch/fr/job-list/{listId}?embedded=yes`.
 * That `company.jobcloud.ch` host is JobCloud's (the jobup.ch/jobs.ch parent
 * group) "Company Page" product — a Webflow-hosted micro-site the employer
 * configures once, NOT one of the ATS clients already shared in
 * `scripts/lib/ats-clients/` (Workday/Greenhouse/Lever/SuccessFactors/
 * Personio/csod/SmartRecruiters) and not the older jobup.ch "mask" JSON feed
 * either (`scripts/lib/jobup-ch-feed-common.mjs`, a *different* JobCloud
 * integration keyed on a `masks/{key}` URL). No shared client exists for this
 * Webflow "job-list" shape in this codebase, so this is a bespoke scraper.
 *
 * Confirmed live (no anti-bot fence, plain `fetch` returns 200): the listing
 * page (`https://company.jobcloud.ch/fr/job-list/{listId}`) is a Webflow CMS
 * collection rendered FULLY server-side — every open job card (`href`,
 * title, location, workload %, contract type) is already present in the raw
 * HTML with no client JS/API call needed (Finsweet `cmsfilter`/`cmsload`
 * attributes only handle in-browser filtering of the already-rendered list,
 * not initial data fetch — verified `?..._page=2` returns byte-identical
 * content to page 1, i.e. no real pagination at this employer's current
 * volume of 3 open postings). Each job detail page
 * (`https://company.jobcloud.ch/fr/jobs/{uuid}`) is ALSO fully server-rendered
 * HTML — title (`<h1>`), full rich-text body, "Date de publication"/
 * "Taux d'activité"/"Type de contrat"/"Lieu de travail" key-info rows, and
 * the outbound jobup.ch apply link — no JSON-LD JobPosting block is present,
 * so this parser builds the description from the visible rich-text block.
 *
 * If the embedded Company Page stops exposing its cards, the employer's
 * Jobup company profile is used as a same-publisher fallback. This preserves
 * the fail-closed behavior for an actually unreadable source while avoiding a
 * false zero when JobCloud changes the embedded page URL or markup.
 *
 * The listing phase keeps three outcomes apart (issue 11077): job links are
 * crawled; a fetch failure is thrown, never read as an empty listing, so the
 * crawler pipeline records its real cause; and a zero is only *proven* when
 * BOTH sources render their own "no open positions" state (JobCloud's
 * server-rendered `initialJobs: []` plus "Aucun poste ouvert", Jobup's
 * `company-no-vacancies` block) — then the empty batch is stamped with
 * `markAuthoritativeEmptySnapshot`. Any other zero stays the fail-closed
 * `no-jobs-parsed` abort (markup drift keeps the previous slice live).
 *
 * Small volume (3 open postings, confirmed live) is expected and normal for
 * a cantonal Red Cross section of this size — same class as Hospice général
 * (4) / EPI Genève (11), not a sign of a broken source.
 *
 * One of the 3 live postings ("Alarme Croix-Rouge" telecare coordinator) is
 * published as TWO separate job-detail pages — one in French, one in German
 * — each with its OWN uuid, apply link, publish date and contract-type
 * (temporary vs permanent). These are kept as two distinct job records
 * (mirrors what a real visitor sees on the source: two live, independently
 * clickable postings), not merged — the generic per-company dedupe/merge
 * step downstream operates on stable per-URL ids, same as any other crawler
 * with a locale-split source.
 *
 * Croix-Rouge fribourgeoise HQ: Rue G.-Techtermann 2, 1700 Fribourg FR —
 * confirmed live from the org's own /fr/contact page (case postale mailing
 * code is 1701, but 1700 is the street-address postal code the org's own job
 * postings themselves display under "Lieu de travail", so 1700 is used here
 * for consistency with the source data). All 3 live postings are based in
 * Fribourg itself — `resolveAddress()` gates the HQ street/postal fallback on
 * the job's own resolved CITY TEXT literally naming Fribourg, never on canton
 * alone (AGENTS.md non-negotiable #7 recurring bug class), so a posting
 * anywhere else in canton Fribourg (Bulle, Marly, Romont, ...) would NOT
 * silently inherit the HQ street address.
 *
 * Exports the functions required by the crawler template:
 *   - fetchAllCroixRougeFribourgeoiseJobs() — Fetch and parse all jobs
 *   - isCroixRougeFribourgeoiseJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()                     — Validate URLs belong to this company
 *   - resolveAddress()                      — City-gated HQ address resolution
 *   - slugify() / stripHtml()               — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, slugify, stripHtml, normalizeSpace, stripScriptsAndStyles } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { parseSwissShortDate } from './hospital-custom-html-helpers.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CROIX_ROUGE_FRIBOURGEOISE_KEY = 'croix-rouge-fribourgeoise';
export const CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME = 'Croix-Rouge fribourgeoise';
export const CROIX_ROUGE_FRIBOURGEOISE_COMPANY_DOMAIN = 'croix-rouge-fr.ch';

const LISTING_ID = '1773421929172x328595190866247700';
const ATS_HOST = 'company.jobcloud.ch';
// locale-segment-ok: '/fr/' is JobCloud's own Company Page URL path, the org only publishes this listing in French
const LISTING_URL = `https://${ATS_HOST}/fr/job-list/${LISTING_ID}`;
const JOBUP_HOST = 'www.jobup.ch';
const JOBUP_COMPANY_URL = 'https://www.jobup.ch/fr/societes/26216-croix-rouge-fribourgeoise/emplois/';

// Jobup renders the employer's own cards inside a dedicated list container.
// Keep the selector list explicit and fail closed: the profile also contains
// related/recommended links elsewhere in the document, and UUID-shaped detail
// URLs alone do not prove that a posting belongs to this employer.
const JOBUP_PROFILE_JOB_LIST_SELECTORS = [
  '[data-cy="company-jobs-list"]',
  '[data-cy="company-job-list"]',
  '[data-cy="company-jobs"]',
  '[data-testid="company-jobs-list"]',
  '[data-testid="company-job-list"]',
  '[data-testid="company-jobs"]',
  '#company-jobs-list',
  '#company-job-list',
  '#company-jobs',
  '[class~="company-jobs-list"]',
  '[class~="company-job-list"]',
  '[class~="company-jobs"]',
].join(',');
// The source's own "no open positions" states. JobCloud's Next.js company page
// serialises its server-side list as `initialJobs` inside the RSC payload
// (quotes escaped) and renders a visible "Aucun poste ouvert" notice; Jobup's
// profile renders a dedicated `company-no-vacancies` block instead of the list.
const JOBCLOUD_EMPTY_INITIAL_JOBS_RE = /\\?"initialJobs\\?"\s*:\s*\[\s*\]/;
const JOBCLOUD_NON_EMPTY_INITIAL_JOBS_RE = /\\?"initialJobs\\?"\s*:\s*\[\s*[^\]\s]/;
const JOBCLOUD_NO_POSITIONS_TEXT_RE = /Aucun poste ouvert/i;
const JOBUP_NO_VACANCIES_SELECTOR = '[data-cy="company-no-vacancies"]';
const JOBUP_DETAIL_PATH_RE = /^\/(?:fr\/emplois|en\/jobs)\/detail\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

const SECTOR = 'Sociale / Socio-sanitario';

// Croix-Rouge fribourgeoise HQ — Rue G.-Techtermann 2, 1700 Fribourg FR. See
// module docblock for the org's own /fr/contact page source + the
// 1700-vs-1701 postal-code note.
const HQ = {
  city: 'Fribourg',
  canton: 'FR',
  postalCode: '1700',
  streetAddress: 'Rue G.-Techtermann 2',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Decode numeric HTML entities (`&#x27;` hex, `&#39;` decimal) that survive
 * `stripHtml()` (which only decodes the small named-entity set). The source
 * markup double-quotes apostrophes this way in titles (e.g. `l&#x27;Alarme`).
 */
function decodeNumericEntities(s = '') {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Croix-Rouge fribourgeoise.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCroixRougeFribourgeoiseJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const url = normalize(job?.url || '');

  return (
    key === CROIX_ROUGE_FRIBOURGEOISE_KEY ||
    key.startsWith('croix-rouge-fribourgeoise') ||
    company.includes('croix-rouge fribourgeoise') ||
    url.includes('croix-rouge-fr.ch') ||
    (url.includes(ATS_HOST) && url.includes(LISTING_ID))
  );
}

/**
 * Validate that a URL belongs to Croix-Rouge fribourgeoise's own domain or
 * one of the two JobCloud-hosted public job pages used by this parser.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === ATS_HOST ||
      host === CROIX_ROUGE_FRIBOURGEOISE_COMPANY_DOMAIN ||
      host === `www.${CROIX_ROUGE_FRIBOURGEOISE_COMPANY_DOMAIN}` ||
      host === JOBUP_HOST ||
      host === 'jobup.ch'
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment-type detection ───────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(responsable|direction|chef|leiter|directeur|directrice)\b/.test(t)) return 'Amministrazione';
  if (/\b(alarme|notruf|soutien.{0,15}domicile|soins?|santé|pflege)\b/.test(t)) return 'Sanità / Ospedali';
  return 'Sanità / Ospedali'; // default for a health/social-services employer
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(apprenti|stagiaire|stage|praktikant|lernende?)\b/.test(t)) return 'intern';
  if (/\b(responsable|direction|directeur|directrice|chef|leiter|membre de la direction)\b/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Derive schema.org `employmentType` from the posting's workload-percentage
 * range (e.g. "80 - 100%") plus a title-based apprenticeship override.
 */
function detectEmploymentType(occupationRange = '', title = '') {
  const t = normalize(title);
  if (/\b(apprenti|stagiaire|stage|praktikant|lernende?)\b/.test(t)) return 'INTERN';
  if (/\bpart[\s-]?time|teilzeit|temps\s+partiel/.test(normalize(occupationRange))) return 'PART_TIME';
  if (/\bfull[\s-]?time|vollzeit|temps\s+plein/.test(normalize(occupationRange))) return 'FULL_TIME';
  const matches = [...String(occupationRange || '').matchAll(/(\d{1,3})\s*%/g)].map((m) => Number(m[1]));
  const max = matches.length ? Math.max(...matches) : null;
  if (max !== null && max > 0 && max < 90) return 'PART_TIME';
  return 'FULL_TIME';
}

/**
 * Map the source's own French contract-duration label to the site's
 * `contract` vocabulary ('full-time' | 'temporary'). Distinct from
 * `employmentType` (workload %), same separation as
 * `scripts/lib/jobup-ch-feed-common.mjs`.
 */
function detectContract(contractTypeRaw = '') {
  const t = normalize(contractTypeRaw);
  if (/temporaire|befristet|cdd/.test(t)) return 'temporary';
  return 'full-time';
}

/* ── Address resolution ───────────────────────────────────────
 * All 3 currently-live postings are based in Fribourg itself, but
 * resolveAddress() gates the HQ street/postal fallback on the job's own
 * resolved CITY TEXT literally naming Fribourg, NEVER on canton (FR) alone —
 * mirrors scripts/lib/selecta-job-parser.mjs's resolveAddress() (AGENTS.md
 * #7). A posting located elsewhere in canton Fribourg (e.g. "Bulle",
 * "Marly") would resolve to canton FR but NOT inherit the HQ street address.
 */
export function resolveAddress(rawLocation = '') {
  const cleaned = normalizeSpace(decodeNumericEntities(rawLocation));
  // Source's own "Lieu de travail" format is "<postal>, <city>" (e.g.
  // "1700, Fribourg"). Split it out when present; otherwise treat the whole
  // string as the city.
  const postalCityMatch = cleaned.match(/^(\d{4}),?\s*(.+)$/);
  const postalFromSource = postalCityMatch ? postalCityMatch[1] : '';
  const city = postalCityMatch ? normalizeSpace(postalCityMatch[2]) : cleaned;

  const isHqCity = /\bfribourg\b/i.test(city) || /\bfreiburg\b/i.test(city);
  if (city) {
    return {
      city,
      canton: inferAnyCanton(city) || HQ.canton,
      postalCode: isHqCity ? (postalFromSource || HQ.postalCode) : postalFromSource,
      streetAddress: isHqCity ? HQ.streetAddress : '',
    };
  }

  // Unmapped/empty location → safe HQ fallback, never dropped.
  return {
    city: HQ.city,
    canton: HQ.canton,
    postalCode: HQ.postalCode,
    streetAddress: HQ.streetAddress,
  };
}

/* ── HTML extraction ───────────────────────────────────────── */

/**
 * Extract every distinct job-detail link from the listing page's
 * server-rendered CMS collection markup.
 * @param {string} html Listing page HTML.
 * @returns {string[]} Unique relative hrefs, e.g. ["/fr/jobs/{uuid}", ...].
 */
export function extractListingLinks(html = '') {
  const re = /href\s*=\s*(["'])((?:https?:\/\/company\.jobcloud\.ch)?\/[a-z]{2}\/jobs\/[0-9a-fA-F-]{36}\/?(?:[?#][^"']*)?)\1/gi;
  const seen = new Set();
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(html)) !== null) {
    const rawHref = decodeNumericEntities(m[2]).replace(/&amp;/g, '&');
    try {
      const parsed = new URL(rawHref, `https://${ATS_HOST}`);
      if (parsed.hostname.toLowerCase() !== ATS_HOST) continue;
      seen.add(rawHref.startsWith('/') ? `${parsed.pathname}${parsed.search}` : parsed.href);
    } catch {
      // Ignore malformed source links and keep scanning the listing page.
    }
  }
  return [...seen];
}

/**
 * True only when the JobCloud company page itself states it has no open
 * position: an empty server-side `initialJobs` list, no non-empty one, the
 * visible "Aucun poste ouvert" notice, and no detail link. A page missing any
 * of these is unreadable (markup drift), not empty.
 */
export function isJobCloudListingProvenEmpty(html = '') {
  const source = String(html || '');
  if (!source) return false;
  return JOBCLOUD_EMPTY_INITIAL_JOBS_RE.test(source)
    && !JOBCLOUD_NON_EMPTY_INITIAL_JOBS_RE.test(source)
    && JOBCLOUD_NO_POSITIONS_TEXT_RE.test(stripScriptsAndStyles(source))
    && extractListingLinks(source).length === 0;
}

/**
 * True only when the Jobup company profile renders its own "no vacancies"
 * block and no job-list container.
 */
export function isJobupProfileProvenEmpty(html = '') {
  if (!html) return false;
  const dom = new JSDOM(String(html));
  try {
    const doc = dom.window.document;
    return Boolean(doc.querySelector(JOBUP_NO_VACANCIES_SELECTOR))
      && !doc.querySelector(JOBUP_PROFILE_JOB_LIST_SELECTORS);
  } finally {
    dom.window.close();
  }
}

/**
 * Extract Jobup company-profile detail links. Jobup currently renders these
 * cards server-side, but the profile has used both relative and absolute
 * hrefs (and both quote styles) over time.
 */
export function extractJobupListingLinks(html = '') {
  if (!html) return [];

  const dom = new JSDOM(String(html));
  const seen = new Set();
  try {
    const containers = dom.window.document.querySelectorAll(JOBUP_PROFILE_JOB_LIST_SELECTORS);
    for (const container of containers) {
      const hrefs = [...container.querySelectorAll('a[href]')]
        .map((anchor) => anchor.getAttribute('href') || '')
        .filter((href) => isJobupDetailUrl(href));
      if (!hrefs.length) continue;

      for (const rawHref of hrefs) {
        try {
          const parsed = new URL(decodeNumericEntities(rawHref).replace(/&amp;/g, '&'), `https://${JOBUP_HOST}`);
          seen.add(parsed.href);
        } catch {
          // Ignore malformed source links and keep scanning the own-job container.
        }
      }
      // The first matching container is the profile's own job list. Do not
      // continue into a later related/recommended list after collecting it.
      break;
    }
  } finally {
    dom.window.close();
  }
  return [...seen];
}

/**
 * Extract a single "key info" row's value by its label
 * (e.g. "Date de publication" → "30.6.2026"), tolerant of an optional
 * trailing colon on the label (the source markup is inconsistent about it).
 * @param {string} html Detail page HTML.
 * @param {string} label Exact French label text (no colon).
 * @returns {string}
 */
function extractKeyInfoValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<div[^>]*>\\s*${escaped}:?\\s*</div>\\s*<div[^>]*class=["'][^"']*\\btext-size-small\\b[^"']*["'][^>]*>([\\s\\S]*?)</div>`,
    'i',
  );
  const m = html.match(re);
  return m ? normalizeSpace(decodeNumericEntities(stripHtml(m[1]))) : '';
}

/**
 * Extract the job detail page's visible rich-text body block (company
 * blurb + role title + tasks/profile prose), stopping before the
 * "job_details_content-right" sidebar (apply button + key-info panel) so
 * that sidebar text never leaks into the description.
 * @param {string} html Detail page HTML.
 * @returns {string} Raw (still-HTML) content block, or '' if not found.
 */
function extractRichTextBlock(html = '') {
  const startTag = 'text-rich-text w-richtext">';
  const startIdx = html.indexOf(startTag);
  if (startIdx === -1) return '';
  const contentStart = startIdx + startTag.length;
  const endIdx = html.indexOf('job_details_content-right', contentStart);
  const slice = endIdx === -1 ? html.slice(contentStart) : html.slice(contentStart, endIdx);
  return slice;
}

/**
 * Extract the outbound jobup.ch apply link.
 * @param {string} html Detail page HTML.
 * @returns {string}
 */
function extractApplyUrl(html = '') {
  const m = html.match(/<a\b[^>]*href\s*=\s*(["'])([^"']+)\1[^>]*id\s*=\s*(["'])job-ad-apply-btn\3/i);
  return m ? decodeNumericEntities(m[2]).replace(/&amp;/g, '&') : '';
}

function extractJobupPostingJsonLd(html = '') {
  const blocks = html.match(/<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    const payload = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const parsed = JSON.parse(payload);
      const candidates = [
        ...(Array.isArray(parsed) ? parsed : [parsed]),
        ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : []),
      ];
      const posting = candidates.find((candidate) => {
        const type = candidate?.['@type'];
        return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      });
      if (posting) return posting;
    } catch {
      // A page can carry unrelated or malformed JSON-LD before JobPosting.
    }
  }
  return null;
}

function extractJobupLocation(posting) {
  const rawLocation = Array.isArray(posting?.jobLocation) ? posting.jobLocation[0] : posting?.jobLocation;
  const address = rawLocation?.address || {};
  const postalCode = normalizeSpace(address.postalCode || '');
  const city = normalizeSpace(address.addressLocality || rawLocation?.name || '');
  return [postalCode, city].filter(Boolean).join(', ');
}

function extractJobupDescription(html, posting) {
  const jsonLdDescription = posting?.description;
  const jsonLdText = jsonLdDescription
    ? normalizeSpace(stripHtml(decodeNumericEntities(jsonLdDescription)))
    : '';

  const bodyMatch = html.match(/<[^>]+class=["'][^"']*\bC_PBODYHTML\b[^"']*["'][^>]*>([\s\S]*?)(?:<h2\b[^>]*>\s*Autres recherches|<\/main>|$)/i);
  const bodyText = bodyMatch ? normalizeSpace(stripHtml(bodyMatch[1])) : '';

  // Jobup sometimes exposes only a short teaser in JSON-LD while the
  // employer's full source text remains in C_PBODYHTML. Prefer that visible
  // body when the JSON-LD value cannot clear the shared source floor; never
  // pass a sub-floor source body on to an indexable job page.
  if (meetsSourceBodyFloor(jsonLdText)) return jsonLdText;
  return meetsSourceBodyFloor(bodyText) ? bodyText : '';
}

function normalizePostedDate(rawDate = '') {
  const value = normalizeSpace(rawDate);
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return parseSwissShortDate(value);
}

function isJobupDetailUrl(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl, `https://${JOBUP_HOST}`);
    const host = parsed.hostname.toLowerCase();
    return (host === JOBUP_HOST || host === 'jobup.ch')
      && JOBUP_DETAIL_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

function toDetailUrl(rawHref = '') {
  if (isJobupDetailUrl(rawHref)) return new URL(rawHref, `https://${JOBUP_HOST}`).href;
  return new URL(rawHref, `https://${ATS_HOST}`).href;
}

/**
 * Fetch and parse a single job detail page.
 * @param {string} href Relative path, e.g. "/fr/jobs/{uuid}".
 * @returns {Promise<object>} Parsed detail fields. A fetch failure is thrown;
 *   the caller decides whether one failed detail is tolerable.
 */
async function fetchJobDetail(href) {
  const detailUrl = toDetailUrl(href);
  const isJobupDetail = isJobupDetailUrl(detailUrl);
  const html = await fetchHtml(detailUrl);
  const visibleHtml = stripScriptsAndStyles(html);
  const posting = isJobupDetail ? extractJobupPostingJsonLd(html) : null;
  const titleMatch = visibleHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = normalizeSpace(decodeNumericEntities(posting?.title || (titleMatch ? stripHtml(titleMatch[1]) : '')));
  const description = isJobupDetail
    ? extractJobupDescription(html, posting)
    : normalizeSpace(stripHtml(extractRichTextBlock(html)));
  const datePosted = isJobupDetail
    ? normalizePostedDate(posting?.datePosted)
    : parseSwissShortDate(extractKeyInfoValue(html, 'Date de publication'));
  const occupationRange = isJobupDetail
    ? normalizeSpace(posting?.employmentType || visibleHtml.match(/\b\d{1,3}(?:\s*[–-]\s*\d{1,3})?\s*%/)?.[0] || '')
    : extractKeyInfoValue(html, 'Taux d’activité');
  const contractTypeRaw = isJobupDetail
    ? normalizeSpace(posting?.employmentType || '')
    : extractKeyInfoValue(html, 'Type de contrat');
  const lieuDeTravail = isJobupDetail
    ? extractJobupLocation(posting)
    : extractKeyInfoValue(html, 'Lieu de travail');
  const applyUrl = isJobupDetail ? '' : extractApplyUrl(html);
  const employmentType = isJobupDetail ? normalizeSpace(posting?.employmentType || '') : '';

  return { detailUrl, title, description, datePosted, occupationRange, contractTypeRaw, lieuDeTravail, applyUrl, employmentType };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Croix-Rouge fribourgeoise jobs (Switzerland — cantonal Fribourg
 * employer with no other market).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllCroixRougeFribourgeoiseJobs() {
  console.log(`🔍 Fetching ${CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (JobCloud Company Page)\n`);

  let links = [];
  let jobCloudError = null;
  let jobCloudProvenEmpty = false;
  try {
    const listingHtml = await fetchHtml(LISTING_URL);
    links = extractListingLinks(listingHtml);
    jobCloudProvenEmpty = !links.length && isJobCloudListingProvenEmpty(listingHtml);
  } catch (err) {
    jobCloudError = err;
    console.warn(`⚠️ ${CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME}: JobCloud listing unavailable: ${err?.message || err}`);
  }

  if (!links.length) {
    console.warn(jobCloudError
      ? '⚠️ JobCloud listing failed; trying the Jobup company profile fallback.'
      : `⚠️ JobCloud listing exposed no job links (own "no open positions" state: ${jobCloudProvenEmpty}); trying the Jobup company profile fallback.`);
    let jobupHtml;
    try {
      jobupHtml = await fetchHtml(JOBUP_COMPANY_URL);
    } catch (err) {
      // A fetch failure is not an empty listing: let the crawler pipeline
      // classify it (connection-level soft exit or HTTP error) instead of
      // publishing a cause-less no-jobs-parsed abort.
      console.warn(`⚠️ ${CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME}: Jobup fallback unavailable: ${err?.message || err}`);
      throw err;
    }
    links = extractJobupListingLinks(jobupHtml);
    if (links.length) {
      console.log(`  📋 Jobup listings found: ${links.length}`);
    } else {
      // JobCloud never answered: one empty fallback does not prove the
      // employer has no openings, and the fetch failure is the real cause.
      if (jobCloudError) throw jobCloudError;
      if (jobCloudProvenEmpty && isJobupProfileProvenEmpty(jobupHtml)) {
        console.log('  ✅ Both JobCloud and Jobup state that no position is open.');
        return markAuthoritativeEmptySnapshot(
          [],
          'JobCloud company page initialJobs=[] with "Aucun poste ouvert"; Jobup profile company-no-vacancies',
        );
      }
      console.warn('⚠️ No job listings found, and the sources do not both state an empty board (markup drift?).');
      return [];
    }
  }
  console.log(`  📋 Listings found: ${links.length}`);

  const jobs = [];
  let detailFailures = 0;
  let firstDetailError = null;
  for (const href of links) {
    let detail;
    try {
      detail = await fetchJobDetail(href);
    } catch (err) {
      detailFailures += 1;
      firstDetailError ??= err;
      console.warn(`  ⚠️ ${CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME}: failed to fetch detail ${toDetailUrl(href)}: ${err?.message || err}`);
      continue;
    }
    const {
      detailUrl,
      title,
      description,
      datePosted,
      occupationRange,
      contractTypeRaw,
      lieuDeTravail,
      applyUrl,
      employmentType: sourceEmploymentType,
    } = detail;
    if (!title || title.length < 3) continue;

    const { city, canton, postalCode, streetAddress } = resolveAddress(lieuDeTravail);
    const descriptionText = meetsSourceBodyFloor(description) ? description : '';
    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} croix-rouge-fribourgeoise ${city}`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
    const employmentType = sourceEmploymentType || detectEmploymentType(occupationRange, title);
    const postedDate = datePosted || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${CROIX_ROUGE_FRIBOURGEOISE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME,
      companyKey: CROIX_ROUGE_FRIBOURGEOISE_KEY,
      companyDomain: CROIX_ROUGE_FRIBOURGEOISE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city || HQ.city,
      canton,
      url: detailUrl,
      source: detailUrl.includes('jobup.ch')
        ? 'Croix-Rouge fribourgeoise Dedicated Parser (Jobup company profile)'
        : 'Croix-Rouge fribourgeoise Dedicated Parser (JobCloud Company Page)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, AGENTS.md #3) ──
      hiringOrganization: { name: CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME },
      addressLocality: city || HQ.city,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: detectContract(contractTypeRaw),
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: applyUrl || detailUrl,
      department: '',
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      _targetScope: { canton, location: city || HQ.city },
    };

    jobs.push(job);
  }

  // One unreachable detail is tolerated; every detail failing is a fetch
  // failure of the whole board, not an empty one.
  if (detailFailures > 0 && detailFailures === links.length) throw firstDetailError;

  console.log(`\n📋 Total ${CROIX_ROUGE_FRIBOURGEOISE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
