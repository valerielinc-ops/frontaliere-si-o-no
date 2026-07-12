#!/usr/bin/env node
/**
 * UBS job parser — Taleo ATS API (jobs.ubs.com).
 *
 * UBS uses Oracle Taleo for recruitment. The public-facing career portal
 * at jobs.ubs.com exposes an Angular app backed by REST-like AJAX endpoints.
 *
 * Flow:
 *   1. GET the search page to obtain session cookies + CSRF token (RFT)
 *   2. POST /TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs with `pageNumber`
 *      (1-indexed) for each page of the full tenant result set. The sibling
 *      /TgNewUI/Search/Ajax/MatchedJobs endpoint (used by the site's own UI
 *      only for the very first render) accepts `StartRow`/`EndRow` but the
 *      live tenant silently ignores them and always returns page 1 — using
 *      it for pagination collapsed every "page" onto the same ~8 Swiss jobs
 *      (issue #3259). ProcessSortAndShowMoreJobs is what the site's own
 *      "show more" / page-number UI calls, confirmed against the shipped
 *      Angular bundle (TGNewUI search.min.js, `sortJobs()`).
 *   3. Parse the Jobs.Job[] array from the response
 *
 * Each job in the search results includes: reqid, jobtitle, jobdescription,
 * formtext23 (region), formtext2 (city), department, formtext21 (category),
 * lastupdated, jobreqlanguage, formtext22 (job type).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllUbsJobs()  — Fetch and parse all jobs
 *   - isUbsJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()  — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { assertJsonListShapeMultiKey } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const UBS_KEY = 'ubs';
export const UBS_COMPANY_NAME = 'UBS';
export const UBS_COMPANY_DOMAIN = 'ubs.com';

/** Taleo search page template — used to bootstrap session + CSRF token per siteId. */
function buildSearchPageUrl(siteId) {
  return `https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=${PARTNER_ID}&siteid=${siteId}&PageType=searchResults`;
}

/** Taleo MatchedJobs endpoint — first-page search only (see ShowMore note below). */
const MATCHED_JOBS_URL = 'https://jobs.ubs.com/TgNewUI/Search/Ajax/MatchedJobs';

/**
 * Taleo pagination endpoint — the site's own "page N" / "show more" UI posts
 * here with a 1-indexed `pageNumber`, NOT to MatchedJobs with StartRow/EndRow
 * (which the live tenant ignores, always returning page 1; issue #3259).
 */
const SHOW_MORE_JOBS_URL = 'https://jobs.ubs.com/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs';

/** Deterministic sort so page boundaries stay stable across requests. */
const SORT_TYPE = 'LastUpdated';

/** Taleo partner identifier — shared across all UBS Taleo site tenants. */
const PARTNER_ID = '25008';

/**
 * Taleo site identifiers for the UBS Switzerland tenants (issue #3055 item 1):
 *   - 5012: main UBS Switzerland career site
 *   - 5054: apprendistati (apprenticeships)
 *   - 5131: graduati (graduate programs)
 * Each is fetched independently (own session/pagination) and merged.
 */
const SITE_IDS = ['5012', '5054', '5131'];

/**
 * Cathedral CH-wide expansion (2026-05-10):
 * The parser no longer applies a Taleo `formtext2` city facet — instead we
 * fetch ALL Swiss UBS jobs (the Taleo result set is naturally Swiss because
 * jobs.ubs.com siteid 5012 IS UBS Switzerland) and let the downstream
 * `canton-quorum-gate` (BFS-strict + 2-of-3) tag each job's canton. This
 * unlocks per-canton URLs for ZH, GE, BS, BE, … without hard-coding a city
 * list.
 */

/** Taleo language code → ISO 639-1 */
const TALEO_LANG_MAP = { 1: 'en', 23: 'de', 34: 'fr', 6: 'it' };

/** Postal codes for Valais cities */
const VS_POSTAL_CODES = {
 brig: '3900',
 crans: '3963',
 gstaad: '3780',
  martigny: '1920',
  naters: '3904',
  sion: '1950',
  sierre: '3960',
  susten: '3952',
  'susten-leuk': '3952',
  visp: '3930',
  zermatt: '3920',
  monthey: '1870',
  verbier: '1936',
 'saas-fee': '3906',
 leuk: '3952',
};

const SWISS_REGION_PREFIX_RE = /^(schweiz|suisse|svizzera|switzerland)\b/i;
const SWISS_MACRO_REGION_LOCATION = [
 { re: /\bostschweiz\b/i, location: 'Ostschweiz', canton: 'SG' },
 { re: /\bplateau\b/i, location: 'Plateau suisse', canton: 'BE' },
 { re: /\bsuisse\s+romande\b/i, location: 'Suisse romande', canton: 'VD' },
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}


/**
 * Extract a named field from the Taleo Questions array.
 * Each job in the Taleo response has a Questions[] array where
 * each entry has { QuestionName, Value }.
 */
function getField(questions = [], name = '') {
  const q = questions.find((q) => q.QuestionName === name);
  return q?.Value || '';
}

/**
 * Parse Taleo date format "DD-MMM-YYYY" → "YYYY-MM-DD".
 * e.g. "08-Apr-2026" → "2026-04-08"
 */
function parseTaleoDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Build public job detail URL on the Taleo portal.
 */
function buildJobUrl(reqId, siteId = SITE_IDS[0]) {
  return `https://jobs.ubs.com/TGnewUI/Search/Home/HomeWithPreLoad?partnerid=${PARTNER_ID}&siteid=${siteId}&jobid=${encodeURIComponent(reqId)}&PageType=jobdetails`;
}

/**
 * Infer postal code from city name. Returns '' when the city is not a
 * Valais branch we know about; the crawler normalisation step uses
 * COMPANY_HQ defaults (UBS HQ = Zürich 8001 post-Cathedral) instead.
 */
function inferPostalCode(city = '') {
  return VS_POSTAL_CODES[normalize(city)] || '';
}

/**
 * Extract the first/primary city from a potentially multi-city string.
 * e.g. "Brig, Naters, Susten, Susten-Leuk, Visp, Zermatt" → "Brig".
 * Returns '' when the source field is empty (canton-quorum-gate handles
 * blank locations downstream).
 */
function primaryCity(cityStr = '') {
 return normalizeSpace(cityStr.split(',')[0]);
}

function isSwissRegion(region = '') {
 return SWISS_REGION_PREFIX_RE.test(normalizeSpace(region));
}

function fallbackLocationFromRegion(region = '') {
 const clean = normalizeSpace(region);
 for (const entry of SWISS_MACRO_REGION_LOCATION) {
  if (entry.re.test(clean)) return entry.location;
 }
 const parts = clean.split(/\s+-\s+/).map((part) => normalizeSpace(part)).filter(Boolean);
 return parts.length > 1 ? parts.slice(1).join(' - ') : '';
}

function fallbackCantonFromRegion(region = '') {
 const clean = normalizeSpace(region);
 return SWISS_MACRO_REGION_LOCATION.find((entry) => entry.re.test(clean))?.canton || '';
}

/**
 * Infer canton from the city + region string.
 * Taleo formtext23 uses patterns like "Schweiz - Zürich", "Suisse - Genève",
 * "Schweiz - Valais". CH-wide post-Cathedral: detect all 26 cantons via
 * canton names (DE/FR/IT/EN aliases) before falling back to the shared
 * inference helper. Returns '' when undetermined — canton-quorum-gate
 * downstream handles blank canton tags.
 */
function inferCanton(city = '', region = '') {
 const lower = normalize(`${city} ${region}`);
  // Region-string canton heuristics — Taleo uses "Schweiz - {Canton}".
  if (lower.includes('valais') || lower.includes('wallis')) return 'VS';
  if (lower.includes('zurich') || lower.includes('zürich') || lower.includes('zuerich')) return 'ZH';
  if (lower.includes('geneva') || lower.includes('geneve') || lower.includes('genève') || lower.includes('genf')) return 'GE';
  if (lower.includes('basel-stadt') || lower.includes('bâle-ville')) return 'BS';
  if (lower.includes('basel-land') || lower.includes('bâle-campagne')) return 'BL';
  if (lower.includes('vaud') || lower.includes('waadt')) return 'VD';
  if (lower.includes('ticino') || lower.includes('tessin')) return 'TI';
  if (lower.includes('graub') || lower.includes('grigion') || lower.includes('grisons')) return 'GR';
  if (lower.includes('bern') || lower.includes('berne')) return 'BE';
  if (lower.includes('lucerne') || lower.includes('luzern')) return 'LU';
  if (lower.includes('aargau') || lower.includes('argovi')) return 'AG';
  if (lower.includes('st.gall') || lower.includes('saint-gall') || lower.includes('san gallo')) return 'SG';
  if (lower.includes('fribourg') || lower.includes('freiburg') || lower.includes('friburgo')) return 'FR';
  if (lower.includes('neuchât') || lower.includes('neuchat') || lower.includes('neuenburg')) return 'NE';
  if (lower.includes('jura')) return 'JU';
  if (lower.includes('schaffhaus')) return 'SH';
  if (lower.includes('thurgau') || lower.includes('thurgovie')) return 'TG';
  if (lower.includes('solothurn') || lower.includes('soleure')) return 'SO';
  if (lower.includes('schwyz')) return 'SZ';
  if (lower.includes('zug') || lower.includes('zoug')) return 'ZG';
  if (lower.includes('uri')) return 'UR';
  if (lower.includes('glarus') || lower.includes('glaris')) return 'GL';
  if (lower.includes('appenzell-ausserrhoden') || lower.includes('appenzell ar')) return 'AR';
  if (lower.includes('appenzell-innerrhoden') || lower.includes('appenzell ai')) return 'AI';
  if (lower.includes('obwalden')) return 'OW';
  if (lower.includes('nidwalden')) return 'NW';
  // Gstaad is in Berne (BE).
  if (lower.includes('gstaad')) return 'BE';
  // Try the shared inference function (returns a canton code or null).
 return inferAnyCanton(city) || inferAnyCanton(region) || '';
}

function resolveSwissLocation(cityStr = '', region = '') {
 const city = primaryCity(cityStr);
 // A populated region that does NOT look Swiss must never be overridden by a
 // city-name alias match (inferAnyCanton/inferCanton can match a foreign city
 // whose name happens to alias a Swiss canton). A blank region is left
 // unaffected — the Cathedral CH-wide expansion above relies on resolving
 // canton from a bare city when no region string is present at all.
 // See issue #3055 item 2 (sibling of the Galenica fix, item 3).
 const regionLooksForeign = Boolean(region) && !isSwissRegion(region);
 const canton = inferCanton(city, region) || fallbackCantonFromRegion(region);
 if (city && canton) return regionLooksForeign ? null : { city, canton };
 if (city && inferAnyCanton(city)) return regionLooksForeign ? null : { city, canton: inferAnyCanton(city) };
 if (!isSwissRegion(region) && !canton) return null;
 return {
  city: city || fallbackLocationFromRegion(region) || 'Svizzera',
  canton,
 };
}

function extractRequestVerificationToken(html = '') {
  const source = String(html || '');
  const inputMatch = source.match(/<input\b[^>]*name=(["'])__RequestVerificationToken\1[^>]*>/i);
  const input = inputMatch?.[0] || '';
  const valueMatch = input.match(/\bvalue=(["'])([^"']+)\1/i);
  if (valueMatch?.[2]) return valueMatch[2];

  const looseMatch = source.match(/__RequestVerificationToken[\s\S]{0,300}?\bvalue=(["'])([^"']+)\1/i);
  return looseMatch?.[2] || '';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to UBS.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isUbsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === UBS_KEY ||
    key.startsWith('ubs') ||
    company.includes('ubs') ||
    url.includes('ubs.com')
  );
}

/**
 * Validate that a URL belongs to UBS's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ubs.com' || host.endsWith('.ubs.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(categoryStr = '', title = '') {
  const t = normalize(`${categoryStr} ${title}`);
  if (/\b(kundenberatung|client\s*advis|relationship\s*manag|conseil.*client)/.test(t)) return 'Commerciale';
  if (/\b(geschäftsstelle|branch|filial)/.test(t)) return 'Commerciale';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|verwaltung|administrat)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(it|software|develop|programm|data|digital)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|wealth|asset|invest|trading|portfolio)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|compliance)/.test(t)) return 'Legale';
  if (/\b(audit|risk|control)/.test(t)) return 'Finanza';
  return 'Finanza'; // Default for a bank
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|talent\s*program)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(jobTypeStr = '', title = '') {
  const t = normalize(`${jobTypeStr} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(tempor|contract|befristet|cdd)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── Taleo Session Bootstrap ──────────────────────────────── */

/**
 * Fetch the Taleo search page to obtain session cookies and the
 * CSRF token (__RequestVerificationToken / RFT).
 *
 * Returns { cookies, rft } or throws on failure.
 */
async function bootstrapSession(siteId) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(buildSearchPageUrl(siteId), {
      method: 'GET',
      headers: {
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        Accept: 'text/html',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Failed to load Taleo search page: HTTP ${res.status}`);
    }

    // Extract cookies from response headers
    const setCookieHeaders = res.headers.getSetCookie?.() || [];
    const cookieStr = setCookieHeaders
      .map((h) => h.split(';')[0])
      .join('; ');

    // Extract RFT from HTML
    const html = await res.text();
    const rft = extractRequestVerificationToken(html);
    if (!rft) {
      throw new Error('Could not extract CSRF token (RFT) from Taleo page');
    }

    return { cookies: cookieStr, rft };
  } finally {
    clearTimeout(timer);
  }
}

/* ── API Client ────────────────────────────────────────────── */

/**
 * Call the Taleo MatchedJobs endpoint — the FIRST page of results only.
 *
 * Cathedral CH-wide expansion (2026-05-10): no city facet is applied —
 * the unfiltered result on jobs.ubs.com siteid=5012 is the full Swiss
 * UBS tenant across 26 cantons.
 *
 * NOTE (issue #3259): this endpoint accepts `StartRow`/`EndRow` but the
 * live tenant ignores them and always returns the same first page — it
 * must NOT be used to paginate past page 1. Use searchMoreJobs() (real
 * pagination via ProcessSortAndShowMoreJobs) for subsequent pages.
 *
 * @param {string} cookies - Session cookies from bootstrapSession
 * @param {string} rft - CSRF token from bootstrapSession
 * @returns {Promise<{jobs: object[], totalCount: number}>}
 */
async function searchJobs(cookies, rft, siteId) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    PartnerId: PARTNER_ID,
    SiteId: siteId,
    Keyword: '',
    Location: '',
    KeywordCustomSolrFields: '',
    LocationCustomSolrFields: '',
    // No facet filter — fetch the full Swiss tenant result set.
    FacetFilterFields: { Facet: [] },
    TurnOffHttps: false,
    Latitude: 0,
    Longitude: 0,
    PowerSearchOptions: { PowerSearchOption: [] },
    encryptedsessionvalue: '',
    StartRow: 0,
    EndRow: 50,
  };

  try {
    const res = await fetch(MATCHED_JOBS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        Cookie: cookies,
        RFT: rft,
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Taleo MatchedJobs API returned HTTP ${res.status}`);
    }

    const data = await res.json();
    // Taleo MatchedJobs envelope nests the list at `Jobs.Job`; a drift (renamed
    // wrapper, error body, single non-array object) now warns instead of silently
    // yielding []. The `|| []` also returned a truthy non-array as-is — the helper
    // skips that and warns.
    const jobList = assertJsonListShapeMultiKey(data, { keys: ['Jobs.Job'], source: 'ubs' });
    const totalCount = data?.JobsCount || 0;

    return { jobs: jobList, totalCount };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the Taleo ProcessSortAndShowMoreJobs endpoint — real pagination,
 * 1-indexed `pageNumber`. This is what the site's own "show more" / page
 * links call (confirmed against the shipped TGNewUI Angular bundle); unlike
 * MatchedJobs it actually advances through the full result set (#3259).
 *
 * @param {string} cookies - Session cookies from bootstrapSession
 * @param {string} rft - CSRF token from bootstrapSession
 * @param {number} pageNumber - 1-indexed page to fetch (page 1 == first 50)
 * @returns {Promise<{jobs: object[], totalCount: number}>}
 */
async function searchMoreJobs(cookies, rft, pageNumber, siteId) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    partnerId: PARTNER_ID,
    siteId,
    keyword: '',
    location: '',
    keywordCustomSolrFields: '',
    locationCustomSolrFields: '',
    facetfilterfields: { Facet: [] },
    linkId: '',
    Latitude: 0,
    Longitude: 0,
    powersearchoptions: { PowerSearchOption: [] },
    SortType: SORT_TYPE,
    pageNumber,
    encryptedSessionValue: '',
  };

  try {
    const res = await fetch(SHOW_MORE_JOBS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        Cookie: cookies,
        RFT: rft,
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Taleo ProcessSortAndShowMoreJobs API returned HTTP ${res.status}`);
    }

    const data = await res.json();
    const jobList = assertJsonListShapeMultiKey(data, { keys: ['Jobs.Job'], source: 'ubs' });
    const totalCount = data?.JobsCount || 0;

    return { jobs: jobList, totalCount };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Job Builder ──────────────────────────────────────────── */

/**
 * Build a ParsedJob from a Taleo search result entry.
 */
function buildJobFromTaleo(taleoJob, siteId = SITE_IDS[0]) {
  const questions = taleoJob?.Questions || [];

  const reqId = getField(questions, 'reqid');
  const title = normalizeSpace(stripHtml(getField(questions, 'jobtitle')));
  const descriptionHtml = getField(questions, 'jobdescription');
  const region = normalizeSpace(getField(questions, 'formtext23'));
  const cityStr = normalizeSpace(getField(questions, 'formtext2') || '');
  const department = normalizeSpace(getField(questions, 'department'));
  const categoryStr = normalizeSpace(getField(questions, 'formtext21'));
  const jobType = normalizeSpace(getField(questions, 'formtext22'));
  const lastUpdated = getField(questions, 'lastupdated');
  const langCode = getField(questions, 'jobreqlanguage');

  if (!title || title.length < 3) return null;
  if (!reqId) return null;

  const resolvedLocation = resolveSwissLocation(cityStr, region);
  if (!resolvedLocation) return null;
  const { city, canton } = resolvedLocation;
  const descriptionText = normalizeDescriptionSpace(stripHtml(descriptionHtml));
  const publicUrl = buildJobUrl(reqId, siteId);

  // Detect source language: use Taleo's language code, fallback to content detection
  const taleoLang = TALEO_LANG_MAP[Number(langCode)];
  const sourceLang = taleoLang || detectLang(descriptionText || title, 'de');

  const jobSlug = slugify(`${title} ubs ${city}`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const postedDate = parseTaleoDate(lastUpdated) || new Date().toISOString().slice(0, 10);

  return {
    // ── Required fields ──
    id: `ubs-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: UBS_COMPANY_NAME,
    companyKey: UBS_KEY,
    companyDomain: UBS_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText || `${title} — UBS`,
    descriptionByLocale: { [sourceLang]: descriptionText || `${title} — UBS` },
    location: city,
    canton,
    url: publicUrl,
    source: 'UBS Dedicated Parser (Taleo API)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: city,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: inferPostalCode(city),
    category: detectCategory(categoryStr, title),
    contract: 'full-time',
    employmentType: detectEmploymentType(jobType, title),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Finanza / Banca',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },

    // ── Internal metadata ──
    _ubsMeta: {
      reqId,
      department,
      region,
      cities: cityStr,
      categoryRaw: categoryStr,
      jobType,
    },
  };
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all UBS jobs across Switzerland (26 cantons, no city facet).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Cathedral CH-wide expansion (2026-05-10): the city facet was removed —
 * we paginate the full tenant result set in 25-row windows. The
 * canton-quorum-gate (BFS-strict + 2-of-3) downstream classifies each
 * job's canton for per-canton URL routing.
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllUbsJobs() {
  console.log(`🔍 Fetching UBS jobs from Taleo API (CH-wide, all 26 cantons)`);
  console.log(`   Site IDs: ${SITE_IDS.join(', ')}\n`);

  // Issue #3055 item 1: the main UBS CH tenant (5012) does not include the
  // apprenticeship (5054) or graduate (5131) job pools — each Taleo siteid is
  // its own independent tenant with its own session/pagination, so we fetch
  // and merge them in a loop rather than a single request.
  const allEntries = []; // { taleoJob, siteId }
  const seenReqIds = new Set();

  for (const siteId of SITE_IDS) {
    console.log(`  🌐 Site ${siteId}: ${buildSearchPageUrl(siteId)}`);

    // Step 1: Bootstrap session (cookies + CSRF token) for this site.
    console.log('  🔐 Bootstrapping Taleo session...');
    let cookies;
    let rft;
    try {
      // eslint-disable-next-line no-await-in-loop
      ({ cookies, rft } = await bootstrapSession(siteId));
    } catch (err) {
      console.warn(`  ⚠️ Site ${siteId} session bootstrap failed: ${err?.message || err}`);
      continue;
    }
    console.log('  ✅ Session established\n');

    // Step 2: Paginated walk of this site's tenant.
    //
    // MAX_PAGES is a hard cap, not the expected page count — the loop stops
    // as soon as a page comes back short/empty or we've collected >= the
    // API-reported total. 60 pages * 50/page = 3,000 jobs of headroom above
    // the observed ~550-600 global tenant size (main site 5012).
    console.log(`  📄 Searching for jobs on site ${siteId} (paginated)...`);
    const MAX_PAGES = 60;
    const siteEntries = [];
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageNumber = page + 1; // Taleo pagination is 1-indexed.
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = page === 0
          ? await searchJobs(cookies, rft, siteId)
          : await searchMoreJobs(cookies, rft, pageNumber, siteId);
      } catch (err) {
        console.warn(`  ⚠️ Site ${siteId} page ${pageNumber} failed: ${err?.message || err}`);
        break;
      }
      const { jobs: pageJobs, totalCount } = res;
      if (page === 0) total = totalCount;
      if (!pageJobs.length) break;
      // Defensive dedup by reqid — guards the merge/diff pipeline against any
      // future recurrence of the page-repeat bug (#3259) silently collapsing
      // distinct jobs downstream instead of surfacing as a shrink-guard trip.
      let newCount = 0;
      for (const taleoJob of pageJobs) {
        const reqId = getField(taleoJob?.Questions, 'reqid');
        const dedupKey = reqId ? `${siteId}:${reqId}` : '';
        if (dedupKey && seenReqIds.has(dedupKey)) continue;
        if (dedupKey) seenReqIds.add(dedupKey);
        siteEntries.push({ taleoJob, siteId });
        newCount += 1;
      }
      console.log(`    page ${pageNumber}: +${newCount} (running total ${siteEntries.length}/${total || '?'})`);
      if (newCount === 0) break; // No new jobs discovered — stop instead of looping to MAX_PAGES.
      if (siteEntries.length >= total && total > 0) break;
      // Polite delay between pages.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`  📋 Site ${siteId} returned ${siteEntries.length} jobs (reported total: ${total})\n`);
    allEntries.push(...siteEntries);
    // Polite delay between site tenants.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!allEntries.length) {
    console.warn('⚠️ No job listings returned from Taleo.');
    return [];
  }

  // Step 3: Build ParsedJob objects
  const jobs = [];
  for (const { taleoJob, siteId } of allEntries) {
    const job = buildJobFromTaleo(taleoJob, siteId);
    if (job) {
      jobs.push(job);
    }
  }

  console.log(`\n📋 Total UBS Swiss jobs: ${jobs.length}`);
  return jobs;
}

export const __internals = {
 extractRequestVerificationToken,
 buildJobFromTaleo,
 inferCanton,
 isSwissRegion,
 resolveSwissLocation,
 SITE_IDS,
};
