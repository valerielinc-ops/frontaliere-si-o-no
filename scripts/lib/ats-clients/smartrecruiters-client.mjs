/**
 * SmartRecruiters ATS — Shared client.
 *
 * Pipeline:
 *
 *   tenant → buildSmartRecruitersApiUrl → GET /v1/companies/{tenant}/postings
 *                                                 ↓
 *                  paginated walk (limit=100, offset+=100, until offset>=totalFound)
 *                                                 ↓
 *                  optional: location filters (locationContains substring,
 *                            locationCountryCodes ISO match, custom predicate)
 *                                                 ↓
 *                  optional: detail fetch (concurrency pool, size 5, polite delay)
 *                                                 ↓
 *                  normalize each → NormalizedJob (yielded one-at-a-time)
 *
 * SmartRecruiters publishes a free, unauthenticated REST API exposing every
 * active posting for a tenant. The list endpoint returns a paginated index
 * with summary objects (id, name, location, releasedDate, applyUrl). Each
 * posting carries a structured `jobAd.sections` payload with rich-text body
 * fragments (qualifications, jobDescription, additionalInformation) ONLY when
 * fetched individually via `/v1/postings/{id}` — list endpoint omits jobAd.
 *
 * This module centralises:
 *
 *   - URL building (`buildSmartRecruitersApiUrl`)
 *   - Async-iterable fetching with polite UA, timeout, single retry on 5xx,
 *     paginated walk, optional detail-fetch concurrency pool
 *     (`fetchSmartRecruitersJobs`)
 *   - Normalisation to a vendor-agnostic `NormalizedJob` shape
 *     (`normalizeSmartRecruitersJob`)
 *   - Heuristic detection of SmartRecruiters tenant from a career-site URL
 *     (`extractSmartRecruitersTenant`)
 *   - A typed error class (`SmartRecruitersApiError`) carrying the HTTP status
 *
 * It does NOT replace per-company parsers — those still own company-specific
 * concerns (canton inference, sector tagging, employment-type heuristics,
 * description sanitisation). Per-company parsers consume the iterable and
 * also receive `rawPosting` on each NormalizedJob to extract extra fields
 * (city, region, postalCode, typeOfEmployment, …) without re-parsing.
 *
 * Reference SmartRecruiters API docs:
 *   https://dev.smartrecruiters.com/customer-api/posting-api/
 *
 * Existing in-tree references to SmartRecruiters (consumers of this client):
 *   - scripts/lib/schindler-job-parser.mjs
 *   - scripts/lib/migros-hq-job-parser.mjs
 *   - scripts/lib/avaloq-job-parser.mjs (also SR API; not yet migrated)
 */

/**
 * @typedef {Object} SmartRecruitersLocation
 * @property {string} [fullLocation]
 * @property {string} [city]
 * @property {string} [region]
 * @property {string} [postalCode]
 * @property {{ code?: string, name?: string }|string} [country]
 */

/**
 * @typedef {Object} SmartRecruitersPosting
 * @property {string} id
 * @property {string} name
 * @property {string} [applyUrl]
 * @property {string} [releasedDate]
 * @property {string} [createdOn]
 * @property {SmartRecruitersLocation} [location]
 * @property {{ id?: string, label?: string }} [typeOfEmployment]
 * @property {{ sections?: Record<string, { text?: string }> }} [jobAd]
 */

/**
 * @typedef {Object} NormalizedJob
 * @property {string} jobReqId           SmartRecruiters posting `id`.
 * @property {string} slug               Kebab-case slug derived from title.
 * @property {string} title              Job title (whitespace-normalised), from `name`.
 * @property {string} location           `location.fullLocation` || `location.city`.
 * @property {string} company            Company display name (passed via options).
 * @property {string|null} postedAt      ISO date — prefers `releasedDate`,
 *                                       falls back to `createdOn`, else null.
 * @property {string} applyUrl           `applyUrl` (preferred) or composed
 *                                       `https://jobs.smartrecruiters.com/{tenant}/{id}`.
 * @property {string} [descriptionHtml]  Concatenated jobAd sections, if present.
 * @property {SmartRecruitersPosting} rawPosting  The original posting object
 *                                                (untouched), for consumers
 *                                                that need extra fields.
 */

/* ── Constants ───────────────────────────────────────────────── */

const SR_API_BASE = 'https://api.smartrecruiters.com/v1/companies';
const SR_PUBLIC_JOBS_BASE = 'https://jobs.smartrecruiters.com';
const POLITE_UA = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MIN_DELAY_MS = 2000;
const DEFAULT_DETAIL_CONCURRENCY = 5;
const DEFAULT_DETAIL_DELAY_MS = 250;

/* ── Error class ─────────────────────────────────────────────── */

/**
 * Error thrown by `fetchSmartRecruitersJobs` after retries are exhausted or
 * on non-recoverable errors (4xx, network, timeout).
 */
export class SmartRecruitersApiError extends Error {
  /**
   * @param {string} message
   * @param {number|null} statusCode
   */
  constructor(message, statusCode = null) {
    super(message);
    this.name = 'SmartRecruitersApiError';
    /** @type {number|null} */
    this.statusCode = statusCode;
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Simple kebab-case slugify (mirrors lever-client / greenhouse-client style).
 * @param {string} input
 * @returns {string}
 */
function slugify(input = '') {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Best-effort ISO date conversion. Accepts ISO strings and date-only strings.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function toIsoDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Promise wrapper around `fetch` that aborts after `timeoutMs`.
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string,string> }} [opts]
 * @returns {Promise<Response>}
 */
async function timedFetch(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': POLITE_UA,
        Accept: 'application/json',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ── Public API ──────────────────────────────────────────────── */

/**
 * Build the SmartRecruiters postings list URL for a given tenant.
 *
 * Tenant is case-sensitive in the SR API path (e.g., 'Schindler', not
 * 'schindler'). The API ignores trailing slashes but case mismatch returns
 * an empty content array.
 *
 * @param {string} tenant            e.g. "Schindler", "Migros", "Avaloq"
 * @param {Object} [options]
 * @param {number} [options.limit]   Page size (default 100, SR cap).
 * @param {number} [options.offset]  Pagination offset (default 0).
 * @returns {string}
 */
export function buildSmartRecruitersApiUrl(tenant, options = {}) {
  if (!tenant || typeof tenant !== 'string') {
    throw new TypeError('buildSmartRecruitersApiUrl: tenant must be a non-empty string');
  }
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(options.offset) && options.offset > 0
    ? Math.floor(options.offset)
    : 0;
  // Tenant is case-sensitive — DO NOT lowercase. encodeURIComponent only
  // escapes structural chars (space, slash) and leaves alpha intact.
  return `${SR_API_BASE}/${encodeURIComponent(tenant)}/postings?limit=${limit}&offset=${offset}`;
}

/**
 * Fetch a single page from SmartRecruiters list endpoint, with one retry on 5xx.
 *
 * @param {string} url
 * @param {{ timeoutMs: number, userAgent: string }} ctx
 * @returns {Promise<{ content: SmartRecruitersPosting[], totalFound: number }>}
 */
async function fetchListPage(url, { timeoutMs, userAgent }) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await timedFetch(url, {
        timeoutMs,
        headers: { 'User-Agent': userAgent },
      });
      if (res.ok) {
        const json = await res.json();
        const content = Array.isArray(json?.content) ? json.content : [];
        const totalFound = Number.isFinite(json?.totalFound) ? Number(json.totalFound) : content.length;
        return { content, totalFound };
      }
      if (res.status >= 500 && res.status < 600 && attempt === 0) {
        lastErr = new SmartRecruitersApiError(
          `SmartRecruiters API ${res.status} ${res.statusText} (retrying)`,
          res.status,
        );
        continue;
      }
      throw new SmartRecruitersApiError(
        `SmartRecruiters API ${res.status} ${res.statusText} for ${url}`,
        res.status,
      );
    } catch (err) {
      if (err instanceof SmartRecruitersApiError) {
        if (attempt === 0 && err.statusCode && err.statusCode >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      if (attempt === 0) {
        lastErr = new SmartRecruitersApiError(
          `SmartRecruiters API fetch failed: ${err?.message || err}`,
          null,
        );
        continue;
      }
      throw new SmartRecruitersApiError(
        `SmartRecruiters API fetch failed (after retry): ${err?.message || err}`,
        null,
      );
    }
  }
  throw lastErr || new SmartRecruitersApiError(`SmartRecruiters API fetch failed for ${url}`, null);
}

/**
 * Fetch a single posting detail (full jobAd payload). Best-effort: on error
 * returns the original listing posting unchanged so the caller's pipeline
 * keeps working with summary fields.
 *
 * @param {string} tenant
 * @param {SmartRecruitersPosting} listingPosting
 * @param {{ timeoutMs: number, userAgent: string }} ctx
 * @returns {Promise<SmartRecruitersPosting>}
 */
async function fetchPostingDetail(tenant, listingPosting, { timeoutMs, userAgent }) {
  const id = String(listingPosting?.id || '').trim();
  if (!id) return listingPosting;
  // SmartRecruiters detail endpoint REQUIRES the company prefix —
  // `/v1/postings/{id}` returns 404. The full payload (jobAd.sections) lives
  // at `/v1/companies/{tenant}/postings/{id}`. Using the tenant-less path was
  // a regression that left every detail fetch returning the listing summary,
  // which trips the thin-source guard for crawlers like Avaloq + HUG.
  const url = `${SR_API_BASE}/${encodeURIComponent(tenant)}/postings/${encodeURIComponent(id)}`;
  try {
    const res = await timedFetch(url, {
      timeoutMs,
      headers: { 'User-Agent': userAgent },
    });
    if (!res.ok) return listingPosting;
    const full = await res.json();
    return (full && typeof full === 'object') ? full : listingPosting;
  } catch {
    return listingPosting;
  }
}

/**
 * Run an async worker pool over `items`. Each worker consumes from the shared
 * queue and yields the result via the supplied `onResult` callback (preserves
 * arrival order — NOT input order). Polite delay between successive fetches
 * within the same worker.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {number} delayMs
 * @param {(item: T) => Promise<R>} task
 * @param {(result: R) => void} onResult
 */
async function runDetailPool(items, concurrency, delayMs, task, onResult) {
  const queue = items.slice();
  const workerCount = Math.min(Math.max(1, concurrency), queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      const result = await task(item);
      onResult(result);
      if (delayMs > 0 && queue.length > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Match a posting against a `locationCountryCodes` ISO list. Returns true if
 * the posting has no country code (caller decides how to handle), or if the
 * code matches one of the provided ISO codes (case-insensitive).
 *
 * @param {SmartRecruitersPosting} posting
 * @param {string[]} countryCodes
 * @returns {boolean}
 */
function matchesCountryCodes(posting, countryCodes) {
  if (!countryCodes || countryCodes.length === 0) return true;
  const country = posting?.location?.country;
  const code = String(
    (typeof country === 'object' && country?.code) || (typeof country === 'string' && country) || '',
  ).toLowerCase().trim();
  if (!code) return true; // no signal → don't reject; let other filters decide
  const targets = countryCodes.map((c) => String(c || '').toLowerCase().trim()).filter(Boolean);
  return targets.includes(code);
}

/**
 * Match a posting against a `locationContains` substring list (case-insensitive,
 * matched against fullLocation + city joined).
 *
 * @param {SmartRecruitersPosting} posting
 * @param {string[]} needles
 * @returns {boolean}
 */
function matchesLocationContains(posting, needles) {
  if (!needles || needles.length === 0) return true;
  const loc = posting?.location || {};
  const haystack = `${loc.fullLocation || ''} ${loc.city || ''}`.toLowerCase();
  return needles.some((n) => haystack.includes(String(n || '').toLowerCase()));
}

/**
 * Fetch and yield SmartRecruiters postings for a tenant.
 *
 * Pagination: SR returns at most 100 postings per call. We call repeatedly
 * with `offset += 100` until either `offset >= totalFound`, the response is
 * empty, or we hit `options.maxPages`. Polite delay between pages.
 *
 * @param {string} tenant
 * @param {Object} [options]
 * @param {string} [options.company]              Display name attached to each
 *                                                NormalizedJob.
 * @param {string[]} [options.locationContains]   Case-insensitive substring
 *                                                filter on `location.fullLocation`
 *                                                + `location.city`. If provided,
 *                                                only postings whose location
 *                                                contains AT LEAST ONE of the
 *                                                substrings are kept.
 * @param {string[]} [options.locationCountryCodes] ISO country codes
 *                                                  (e.g., ['ch']). Posting kept
 *                                                  if `location.country.code`
 *                                                  matches OR is missing.
 * @param {(posting: SmartRecruitersPosting) => boolean} [options.filter]
 *                                                Custom predicate evaluated
 *                                                AFTER built-in filters. Return
 *                                                `false` to drop the posting.
 * @param {boolean} [options.fetchDetail]         If true, fetch full posting
 *                                                via `/v1/postings/{id}` for
 *                                                kept postings. Default false.
 * @param {number} [options.detailConcurrency]    Default 5.
 * @param {number} [options.detailDelayMs]        Default 250 ms (per-worker).
 * @param {number} [options.maxPages]             Default 50.
 * @param {number} [options.minDelayMs]           Inter-page delay. Default 2000 ms.
 * @param {number} [options.timeoutMs]            Per-request. Default 20_000 ms.
 * @param {string} [options.userAgent]            Default polite UA.
 * @returns {AsyncIterable<NormalizedJob>}
 * @throws {SmartRecruitersApiError} on persistent failure.
 */
export async function* fetchSmartRecruitersJobs(tenant, options = {}) {
  const {
    company = '',
    locationContains = [],
    locationCountryCodes = [],
    filter = null,
    fetchDetail = false,
    detailConcurrency = DEFAULT_DETAIL_CONCURRENCY,
    detailDelayMs = DEFAULT_DETAIL_DELAY_MS,
    maxPages = DEFAULT_MAX_PAGES,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = POLITE_UA,
  } = options;

  if (!tenant || typeof tenant !== 'string') {
    throw new TypeError('fetchSmartRecruitersJobs: tenant must be a non-empty string');
  }

  const ctx = { timeoutMs, userAgent };
  const needles = (Array.isArray(locationContains) ? locationContains : [])
    .map((s) => String(s || '').toLowerCase().trim())
    .filter(Boolean);
  const codes = (Array.isArray(locationCountryCodes) ? locationCountryCodes : [])
    .map((s) => String(s || '').toLowerCase().trim())
    .filter(Boolean);

  let offset = 0;
  let totalFound = Infinity;

  for (let page = 0; page < Math.max(1, maxPages); page++) {
    if (offset >= totalFound) break;

    const url = buildSmartRecruitersApiUrl(tenant, { limit: DEFAULT_PAGE_SIZE, offset });
    const { content, totalFound: serverTotal } = await fetchListPage(url, ctx);
    if (Number.isFinite(serverTotal)) totalFound = serverTotal;
    if (content.length === 0) break;

    // Apply filters BEFORE optional detail-fetch (avoids wasted detail calls).
    const kept = [];
    for (const posting of content) {
      if (!matchesLocationContains(posting, needles)) continue;
      if (!matchesCountryCodes(posting, codes)) continue;
      if (typeof filter === 'function' && !filter(posting)) continue;
      kept.push(posting);
    }

    let resolved;
    if (fetchDetail && kept.length > 0) {
      resolved = [];
      await runDetailPool(
        kept,
        detailConcurrency,
        detailDelayMs,
        (p) => fetchPostingDetail(tenant, p, ctx),
        (r) => resolved.push(r),
      );
    } else {
      resolved = kept;
    }

    for (const posting of resolved) {
      yield normalizeSmartRecruitersJob(posting, { company, tenant });
    }

    if (content.length < DEFAULT_PAGE_SIZE) break;
    offset += DEFAULT_PAGE_SIZE;
    if (offset < totalFound && minDelayMs > 0) {
      await new Promise((r) => setTimeout(r, minDelayMs));
    }
  }
}

/**
 * Concatenate available jobAd sections into a single HTML blob.
 * Order: jobDescription → qualifications → additionalInformation.
 *
 * @param {SmartRecruitersPosting} posting
 * @returns {string}
 */
function concatJobAdSections(posting) {
  const sections = posting?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  const parts = [];
  for (const key of ['jobDescription', 'qualifications', 'additionalInformation']) {
    const text = typeof sections[key]?.text === 'string' ? sections[key].text : '';
    if (text && text.trim().length > 0) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

/**
 * Convert a single raw SmartRecruiters posting into the vendor-agnostic shape.
 *
 * @param {SmartRecruitersPosting} rawJob
 * @param {Object} [options]
 * @param {string} [options.company]   Display name.
 * @param {string} [options.tenant]    Used to compose fallback applyUrl.
 * @returns {NormalizedJob}
 */
export function normalizeSmartRecruitersJob(rawJob, options = {}) {
  const { company = '', tenant = '' } = options;
  const id = String(rawJob?.id ?? '').trim();
  const title = normalizeSpace(rawJob?.name || '');
  const loc = rawJob?.location || {};
  const location = normalizeSpace(loc.fullLocation || loc.city || '');
  const postedAt = toIsoDate(rawJob?.releasedDate) || toIsoDate(rawJob?.createdOn) || null;
  const fallbackApply = id && tenant
    ? `${SR_PUBLIC_JOBS_BASE}/${encodeURIComponent(tenant)}/${encodeURIComponent(id)}`
    : '';
  const applyUrl = String(rawJob?.applyUrl || fallbackApply || '').trim();
  const slug = slugify(title) || (id ? `sr-${id.slice(0, 8)}` : '');
  const descriptionHtml = concatJobAdSections(rawJob);

  /** @type {NormalizedJob} */
  const out = {
    jobReqId: id,
    slug,
    title,
    location,
    company,
    postedAt,
    applyUrl,
    rawPosting: rawJob,
  };
  if (descriptionHtml) out.descriptionHtml = descriptionHtml;
  return out;
}

/**
 * Heuristic detection of SmartRecruiters tenant from a career-site URL or
 * HTML snippet.
 *
 * Recognises:
 *   - https://jobs.smartrecruiters.com/{Tenant}
 *   - https://jobs.smartrecruiters.com/{Tenant}/{id}
 *   - https://careers.smartrecruiters.com/{Tenant}
 *   - https://api.smartrecruiters.com/v1/companies/{Tenant}
 *
 * Tenant is returned with case preserved (SR API is case-sensitive).
 *
 * @param {string} careerSiteUrl
 * @returns {string|null}
 */
export function extractSmartRecruitersTenant(careerSiteUrl = '') {
  const haystack = String(careerSiteUrl || '');
  if (!haystack) return null;

  const patterns = [
    /jobs\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
    /careers\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
    /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
  ];

  for (const re of patterns) {
    const m = haystack.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}
