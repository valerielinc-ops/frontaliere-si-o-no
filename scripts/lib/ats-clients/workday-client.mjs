#!/usr/bin/env node
/**
 * Workday ATS client — shared abstraction for the Workday Career Site (CXS) API.
 *
 *   tenant.wd3.myworkdayjobs.com → buildWorkdayApiBase → POST /wday/cxs/{tenant}/{site}/jobs
 *                                                              ↓
 *   {jobPostings: [...], total: N} ← paginate ← fetchWorkdayJobs (yield each)
 *                                              ↓
 *   extractWorkdayJobIdentity → normalized job
 *
 * Extracted from the Lonza parser (`scripts/lib/lonza-job-parser.mjs`) so any
 * marquee Workday-hosted employer (Roche, Novartis, ABB, Sika, …) can reuse
 * the same listing/pagination logic without copy-pasting.
 *
 * The existing `lonza-job-parser.mjs` is intentionally NOT migrated — that's a
 * follow-up task. New crawlers should import from this module.
 *
 * Source format references:
 *   - Listing endpoint: POST {apiBase}/jobs   body: { appliedFacets, limit, offset, searchText }
 *   - Detail endpoint:  GET  {apiBase}{externalPath}
 *   - Tenant URL:       https://{tenant}.{datacenter}.myworkdayjobs.com/{lang}/{site}
 */

/* ── Errors ────────────────────────────────────────────────────────────── */

/**
 * Thrown when the Workday API returns 4xx/5xx after the configured retry budget.
 */
export class WorkdayApiError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode HTTP status that triggered the failure
   * @param {string} [url] Endpoint that failed
   */
  constructor(message, statusCode, url) {
    super(message);
    this.name = 'WorkdayApiError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

/**
 * Thrown when Workday returns 401/403 — usually means anti-bot block or IP
 * fencing on the tenant. Caller should back off and retry from a different
 * runner / with a different User-Agent.
 */
export class WorkdayAuthError extends WorkdayApiError {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {string} [url]
   */
  constructor(message, statusCode, url) {
    super(message, statusCode, url);
    this.name = 'WorkdayAuthError';
  }
}

/* ── Constants ─────────────────────────────────────────────────────────── */

const DEFAULT_USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/)';
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MIN_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20000;

/* ── URL building ──────────────────────────────────────────────────────── */

/**
 * Build the Workday CXS API base URL for a tenant + career site.
 *
 * @param {string} tenantHost Hostname of the tenant. Examples:
 *   - `lonza.wd3.myworkdayjobs.com`
 *   - `roche.wd3.myworkdayjobs.com`
 *   - `novartis.wd5.myworkdayjobs.com`
 *   The leading `https://` is tolerated and stripped.
 * @param {string} sitePath Career site path. Examples:
 *   - `Lonza_Careers`
 *   - `roche` (Roche's external site name)
 *   - `External` (generic Workday default)
 * @returns {string} API base URL — append `/jobs` for listings or
 *   `{externalPath}` (returned by listings) for detail.
 *
 * @example
 *   buildWorkdayApiBase('lonza.wd3.myworkdayjobs.com', 'Lonza_Careers')
 *   // → 'https://lonza.wd3.myworkdayjobs.com/wday/cxs/lonza/Lonza_Careers'
 */
export function buildWorkdayApiBase(tenantHost, sitePath) {
  if (!tenantHost) throw new TypeError('buildWorkdayApiBase: tenantHost is required');
  if (!sitePath) throw new TypeError('buildWorkdayApiBase: sitePath is required');

  const host = String(tenantHost)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

  // Tenant slug is everything before the first `.wd` segment.
  // `lonza.wd3.myworkdayjobs.com` → `lonza`
  // Fallback: first DNS label.
  const wdMatch = host.match(/^([^.]+)\.wd\d+\./);
  const tenant = wdMatch ? wdMatch[1] : host.split('.')[0];

  const cleanSite = String(sitePath).trim().replace(/^\/+|\/+$/g, '');

  return `https://${host}/wday/cxs/${tenant}/${cleanSite}`;
}

/* ── Internal HTTP helper ──────────────────────────────────────────────── */

/**
 * @param {string} url
 * @param {object} options
 * @returns {Promise<any>}
 */
async function fetchJsonWithRetry(url, options = {}) {
  const {
    method = 'GET',
    body,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 1,
  } = options;

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'en,de-CH;q=0.9,it-CH;q=0.8,fr-CH;q=0.7',
          'User-Agent': userAgent,
        },
      });
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        throw new WorkdayAuthError(
          `Workday auth/anti-bot block (HTTP ${res.status}) for ${url}`,
          res.status,
          url,
        );
      }
      if (!res.ok) {
        throw new WorkdayApiError(
          `Workday API error HTTP ${res.status} for ${url}`,
          res.status,
          url,
        );
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      // Auth errors are not retryable — fail fast.
      if (err instanceof WorkdayAuthError) throw err;

      // Last attempt → throw whatever happened, wrapped.
      if (attempt >= retries) {
        if (err instanceof WorkdayApiError) throw err;
        throw new WorkdayApiError(
          `Workday fetch failed for ${url}: ${err?.message || err}`,
          0,
          url,
        );
      }

      // Retry once after a small backoff.
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  throw lastErr;
}

/* ── Listing iterator ──────────────────────────────────────────────────── */

/**
 * @typedef {object} WorkdayJobPosting
 * @property {string} [title]
 * @property {string} [externalPath]
 * @property {string} [locationsText]
 * @property {string} [postedOn]
 * @property {string[]} [bulletFields]
 */

/**
 * @typedef {object} WorkdayFetchOptions
 * @property {string[]} [locationFilters] Workday `locationCountry` facet values
 *   (Switzerland is `187134fccb084a0ea9b4b95f23890dbe` on most tenants but
 *   varies — caller must supply the correct ID for the target tenant).
 * @property {Record<string, string[]>} [appliedFacets] Raw facet override; if
 *   provided, takes precedence over `locationFilters`.
 * @property {string} [searchText] Optional keyword filter (default `''`).
 * @property {number} [pageSize] Postings per page (Workday accepts ≤20 reliably; default 20).
 * @property {number} [maxPages] Hard cap on pagination (default 10 → 200 jobs).
 * @property {string} [userAgent] Override User-Agent header.
 * @property {number} [minDelayMs] Polite delay between paginated calls (default 2000ms).
 * @property {number} [timeoutMs] Per-request timeout (default 20000ms).
 */

/**
 * Iterate over Workday job postings for a given tenant, paginating politely.
 *
 * Yields one `jobPosting` at a time. Stops when:
 *   - A page returns no `jobPostings`
 *   - We've collected `total` postings
 *   - We hit `maxPages`
 *
 * Throws `WorkdayAuthError` on 401/403 (anti-bot block — caller should back off)
 * or `WorkdayApiError` on other persistent 4xx/5xx after one retry.
 *
 * @param {string} apiBase Output of `buildWorkdayApiBase`.
 * @param {WorkdayFetchOptions} [options]
 * @returns {AsyncGenerator<WorkdayJobPosting>}
 *
 * @example
 *   const apiBase = buildWorkdayApiBase('lonza.wd3.myworkdayjobs.com', 'Lonza_Careers');
 *   for await (const posting of fetchWorkdayJobs(apiBase, {
 *     locationFilters: ['187134fccb084a0ea9b4b95f23890dbe'],
 *     maxPages: 10,
 *   })) {
 *     const id = extractWorkdayJobIdentity(posting, { apiBase, company: 'Lonza' });
 *     console.log(id.title, id.location);
 *   }
 */
export async function* fetchWorkdayJobs(apiBase, options = {}) {
  if (!apiBase) throw new TypeError('fetchWorkdayJobs: apiBase is required');

  const {
    locationFilters,
    appliedFacets,
    searchText = '',
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    userAgent = DEFAULT_USER_AGENT,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const facets = appliedFacets
    ? appliedFacets
    : Array.isArray(locationFilters) && locationFilters.length > 0
    ? { locationCountry: locationFilters }
    : {};

  const endpoint = `${apiBase.replace(/\/+$/, '')}/jobs`;

  let offset = 0;
  let yielded = 0;
  let total = Infinity;

  for (let page = 0; page < maxPages; page += 1) {
    const body = JSON.stringify({
      appliedFacets: facets,
      limit: pageSize,
      offset,
      searchText,
    });

    let data;
    try {
      data = await fetchJsonWithRetry(endpoint, {
        method: 'POST',
        body,
        userAgent,
        timeoutMs,
        retries: 1,
      });
    } catch (err) {
      // Surface auth errors verbatim; for other failures on the first page,
      // re-throw so the caller knows nothing was fetched. On later pages, stop
      // gracefully (we already returned partial results).
      if (err instanceof WorkdayAuthError) throw err;
      if (page === 0) throw err;
      return;
    }

    const postings = Array.isArray(data?.jobPostings) ? data.jobPostings : [];
    if (typeof data?.total === 'number' && Number.isFinite(data.total)) {
      total = data.total;
    }

    if (postings.length === 0) return;

    for (const posting of postings) {
      yield posting;
      yielded += 1;
    }

    if (yielded >= total) return;
    if (postings.length < pageSize) return;

    offset += pageSize;

    // Polite delay before the next paginated call.
    if (page < maxPages - 1 && minDelayMs > 0) {
      await new Promise((r) => setTimeout(r, minDelayMs));
    }
  }
}

/* ── Date parsing ──────────────────────────────────────────────────────── */

function dateOnlyIso(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse Workday's `postedOn` field into an ISO `YYYY-MM-DD` string.
 *
 * Handles the relative phrases Workday emits across locales:
 *   - "Posted Today" / "Oggi" / "Aujourd'hui" → today
 *   - "Posted Yesterday" / "Ieri" / "Hier" → today − 1
 *   - "Posted N Days Ago" / "N+ Days Ago" / "N giorni fa" / "N jours" → today − N
 *   - "Posted N Weeks Ago" / "N settimane fa" / "N semaines" → today − 7N
 *   - Absolute ISO/Date strings (passed through if parsable)
 *
 * Falls back to today's date when no pattern matches and input is empty.
 * Returns `null` for unparseable non-empty strings so the caller can decide
 * whether to use a fallback.
 *
 * @param {string} postedOnRaw
 * @returns {string|null} `YYYY-MM-DD` ISO date, or null if unparseable.
 */
export function parseWorkdayPostedDate(postedOnRaw) {
  const raw = normalizeSpace(postedOnRaw).toLowerCase();
  if (!raw) return dateOnlyIso(Date.now());

  if (raw.includes('today') || raw.includes('oggi') || raw.includes('aujourd') || raw.includes('heute')) {
    return dateOnlyIso(Date.now());
  }
  if (raw.includes('yesterday') || raw.includes('ieri') || raw.includes('hier') || raw.includes('gestern')) {
    return dateOnlyIso(Date.now() - 86400000);
  }

  const days = Number(
    raw.match(/(\d+)\+?\s*day/)?.[1] ||
      raw.match(/(\d+)\+?\s*giorn/)?.[1] ||
      raw.match(/(\d+)\+?\s*jour/)?.[1] ||
      raw.match(/(\d+)\+?\s*tag/)?.[1] ||
      0,
  );
  if (Number.isFinite(days) && days > 0) return dateOnlyIso(Date.now() - days * 86400000);

  const weeks = Number(
    raw.match(/(\d+)\+?\s*week/)?.[1] ||
      raw.match(/(\d+)\+?\s*settiman/)?.[1] ||
      raw.match(/(\d+)\+?\s*semain/)?.[1] ||
      raw.match(/(\d+)\+?\s*woch/)?.[1] ||
      0,
  );
  if (Number.isFinite(weeks) && weeks > 0) return dateOnlyIso(Date.now() - weeks * 7 * 86400000);

  // Absolute date attempt (ISO / RFC2822 etc.)
  const absolute = Date.parse(postedOnRaw);
  if (Number.isFinite(absolute)) return dateOnlyIso(absolute);

  return null;
}

/* ── Job identity normalization ────────────────────────────────────────── */

/**
 * @typedef {object} WorkdayJobIdentity
 * @property {string} jobReqId Workday `jobReqId` or first bullet field
 * @property {string} slug URL-safe lowercase slug derived from the title
 * @property {string} title Cleaned job title
 * @property {string} location First location segment (e.g. "Visp" from "Visp - VS, Switzerland")
 * @property {string} company Resolved company display name (from options.company)
 * @property {string|null} postedAt ISO `YYYY-MM-DD` or null
 * @property {string} applyUrl Public-facing URL (Workday `en/{site}{externalPath}` format)
 * @property {string} externalPath Raw Workday externalPath (use to fetch detail)
 */

function slugifyTitle(text = '', suffix = '') {
  let s = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return s.slice(0, 200);
}

function firstLocationSegment(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  if (/^[A-Z]{2}$/.test(cleaned)) return ''; // Bare country code is not useful as a city
  const parts = cleaned.split(/\s*-\s*/);
  return parts.length > 0 ? parts[0].trim() : cleaned;
}

/**
 * @typedef {object} WorkdayIdentityOptions
 * @property {string} [apiBase] If provided, used to derive a public apply URL
 *   in the form `{tenantOrigin}/en/{site}{externalPath}`.
 * @property {string} [publicBase] Override for the public URL base (e.g.
 *   `https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers`). Wins over `apiBase`.
 * @property {string} [company] Display name to attach to the identity.
 * @property {string} [slugSuffix] Extra suffix appended to the slug (e.g. `lonza-ch`).
 */

/**
 * Normalize a raw Workday `jobPosting` (from listing or detail) into a flat
 * identity object. Tolerant of the small shape differences between tenants —
 * any missing field becomes `''` or `null`.
 *
 * @param {WorkdayJobPosting} posting
 * @param {WorkdayIdentityOptions} [options]
 * @returns {WorkdayJobIdentity}
 */
export function extractWorkdayJobIdentity(posting, options = {}) {
  const safe = posting || {};
  const { apiBase, publicBase, company = '', slugSuffix = '' } = options;

  const title = normalizeSpace(safe.title || safe?.jobPostingInfo?.title || '');
  const externalPath = safe.externalPath || safe?.jobPostingInfo?.externalPath || '';
  const locationRaw =
    safe.locationsText ||
    safe?.jobPostingInfo?.location ||
    safe.location ||
    '';
  const location = firstLocationSegment(locationRaw);

  const jobReqId =
    safe?.jobPostingInfo?.jobReqId ||
    safe.jobReqId ||
    (Array.isArray(safe.bulletFields) ? safe.bulletFields[0] : '') ||
    '';

  const postedRaw = safe.postedOn || safe?.jobPostingInfo?.postedOn || '';
  const startDate = safe?.jobPostingInfo?.startDate || '';
  const postedAt = postedRaw ? parseWorkdayPostedDate(postedRaw) : startDate || null;

  // Build the public apply URL.
  // CXS API base: https://{host}/wday/cxs/{tenant}/{site}
  // Public form:  https://{host}/en/{site}{externalPath}
  let applyUrl = '';
  if (publicBase && externalPath) {
    applyUrl = `${publicBase.replace(/\/+$/, '')}${externalPath}`;
  } else if (apiBase && externalPath) {
    try {
      const u = new URL(apiBase);
      const cxsParts = u.pathname.split('/').filter(Boolean); // ['wday','cxs','{tenant}','{site}']
      const site = cxsParts[3] || '';
      if (site) applyUrl = `${u.origin}/en/${site}${externalPath}`;
    } catch {
      /* ignore — applyUrl stays empty */
    }
  }

  return {
    jobReqId,
    slug: slugifyTitle(title, slugSuffix),
    title,
    location,
    company,
    postedAt,
    applyUrl,
    externalPath,
  };
}
