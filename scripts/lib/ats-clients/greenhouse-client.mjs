/**
 * Greenhouse ATS — Shared client.
 *
 * Pipeline:
 *
 *   boardToken → buildGreenhouseApiUrl → GET /v1/boards/{token}/jobs
 *                                                   ↓
 *                              {jobs: [...]} → normalize each → NormalizedJob[]
 *                                                   ↓
 *                              location filter (Switzerland / Zurich / etc.)
 *
 * Greenhouse exposes a public, unauthenticated JSON API. A single GET returns
 * ALL jobs for the board (no pagination). This module centralises:
 *
 *   - URL building (`buildGreenhouseApiUrl`)
 *   - Fetching with polite UA, timeout, single retry (`fetchGreenhouseJobs`)
 *   - Normalisation to a vendor-agnostic `NormalizedJob` shape
 *     (`normalizeGreenhouseJob`)
 *   - Heuristic detection of Greenhouse usage from a career-site URL
 *     (`extractGreenhouseBoardToken`)
 *   - A typed error class (`GreenhouseApiError`) carrying the HTTP status
 *
 * It does NOT replace per-company parsers — those still own company-specific
 * concerns (canton inference, sector tagging, employment-type heuristics,
 * description sanitisation). This client is the thin transport + shape layer.
 *
 * Reference Greenhouse API docs:
 *   https://developers.greenhouse.io/job-board.html
 *
 * Existing in-tree consumers (NOT modified by this file):
 *   - scripts/lib/kudelski-nagra-job-parser.mjs
 *   - scripts/lib/vaxcyte-job-parser.mjs
 *   - scripts/lib/vir-biotechnology-job-parser.mjs
 */

/**
 * @typedef {Object} NormalizedJob
 * @property {string} jobReqId         Greenhouse job.id, stringified.
 * @property {string} slug             Kebab-case slug derived from title.
 * @property {string} title            Job title (whitespace-normalised).
 * @property {string} location         First location string we could find
 *                                     (`job.location.name` or first office).
 * @property {string} company          Company display name (passed via options).
 * @property {string|null} postedAt    ISO timestamp — prefers `first_published`,
 *                                     falls back to `updated_at`, else null.
 * @property {string} applyUrl         Greenhouse `absolute_url`.
 * @property {string} [descriptionHtml] HTML body, if `?content=true` was used.
 */

/* ── Error class ─────────────────────────────────────────────── */

/**
 * Custom error for Greenhouse API failures. Carries the HTTP status code
 * (or `0` for network/abort errors) so callers can branch on it.
 */
export class GreenhouseApiError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode  HTTP status, or 0 for network errors.
   * @param {object} [meta]      Optional structured context (url, body…).
   */
  constructor(message, statusCode = 0, meta = {}) {
    super(message);
    this.name = 'GreenhouseApiError';
    this.statusCode = statusCode;
    this.meta = meta;
  }
}

/* ── Constants ───────────────────────────────────────────────── */

const POLITE_USER_AGENT =
  'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';

const DEFAULT_TIMEOUT_MS = 20000;

const PUBLIC_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';
// Some companies still expose only the legacy / "harvest-style" path.
const LEGACY_API_BASE = 'https://api.greenhouse.io/v1/boards';

/* ── URL builder ─────────────────────────────────────────────── */

/**
 * Build the Greenhouse Job Board API URL for a given board token.
 *
 * @param {string} boardToken               Board slug (e.g. 'vaxcyte').
 * @param {object} [options]
 * @param {boolean} [options.includeContent] When true, append `?content=true`
 *                                           so Greenhouse returns the full
 *                                           HTML description for each job.
 * @param {boolean} [options.useDeprecatedApi] When true, use the legacy
 *                                             `api.greenhouse.io` host
 *                                             instead of `boards-api.*`.
 * @returns {string} Fully-qualified API URL.
 * @throws {TypeError} If `boardToken` is missing/empty.
 */
export function buildGreenhouseApiUrl(boardToken, options = {}) {
  if (!boardToken || typeof boardToken !== 'string') {
    throw new TypeError('buildGreenhouseApiUrl: boardToken must be a non-empty string');
  }
  const { includeContent = false, useDeprecatedApi = false } = options;
  const base = useDeprecatedApi ? LEGACY_API_BASE : PUBLIC_API_BASE;
  const safeToken = encodeURIComponent(boardToken.trim());
  const query = includeContent ? '?content=true' : '';
  return `${base}/${safeToken}/jobs${query}`;
}

/* ── Fetcher ─────────────────────────────────────────────────── */

/**
 * Internal: single-shot GET with abort/timeout. Throws GreenhouseApiError
 * on non-2xx or network failure.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<object>} Parsed JSON body.
 */
async function getJsonOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': POLITE_USER_AGENT,
      },
    });
    if (!res.ok) {
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      throw new GreenhouseApiError(
        `Greenhouse API HTTP ${res.status} for ${url}`,
        res.status,
        { url, body: snippet },
      );
    }
    try {
      return await res.json();
    } catch (parseErr) {
      throw new GreenhouseApiError(
        `Greenhouse API returned non-JSON body for ${url}: ${parseErr.message}`,
        res.status,
        { url },
      );
    }
  } catch (err) {
    if (err instanceof GreenhouseApiError) throw err;
    throw new GreenhouseApiError(
      `Greenhouse API fetch failed for ${url}: ${err.message}`,
      0,
      { url, cause: err.name },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort extraction of a location string from a Greenhouse job.
 * Greenhouse responses include `location.name` plus an optional `offices[]`
 * array — different boards populate them differently.
 *
 * @param {object} rawJob
 * @returns {string} First non-empty location string, or ''.
 */
function pickFirstLocationString(rawJob) {
  const candidates = [];
  const top = rawJob?.location;
  if (top && typeof top === 'object' && typeof top.name === 'string') {
    candidates.push(top.name);
  } else if (typeof top === 'string') {
    candidates.push(top);
  }
  const offices = Array.isArray(rawJob?.offices) ? rawJob.offices : [];
  for (const office of offices) {
    if (!office) continue;
    if (typeof office.location === 'string') candidates.push(office.location);
    if (typeof office.name === 'string') candidates.push(office.name);
  }
  return candidates.find((c) => typeof c === 'string' && c.trim().length > 0) || '';
}

/**
 * Apply caller-provided substring filters (case-insensitive) against a
 * job's combined location string. If `needles` is empty/absent, the job
 * passes through.
 *
 * @param {object} rawJob
 * @param {string[]} needles
 * @returns {boolean}
 */
function passesLocationFilter(rawJob, needles) {
  if (!Array.isArray(needles) || needles.length === 0) return true;
  const top = rawJob?.location?.name || (typeof rawJob?.location === 'string' ? rawJob.location : '');
  const offices = Array.isArray(rawJob?.offices) ? rawJob.offices : [];
  const officeStrs = offices
    .map((o) => `${o?.location || ''} ${o?.name || ''}`)
    .join(' ');
  const haystack = `${top} ${officeStrs}`.toLowerCase();
  return needles.some((needle) => {
    if (!needle || typeof needle !== 'string') return false;
    return haystack.includes(needle.toLowerCase());
  });
}

/**
 * Fetch all jobs from a Greenhouse board, with one automatic retry on
 * failure. Greenhouse always returns the full job list in a single call —
 * no pagination is required.
 *
 * @param {string} boardToken
 * @param {object} [options]
 * @param {boolean} [options.includeContent]    Pass `?content=true`.
 * @param {boolean} [options.useDeprecatedApi]  Use legacy host.
 * @param {string[]} [options.locationContains] Case-insensitive substring
 *                                              filters on the job location.
 *                                              Matches if ANY needle is found.
 * @param {string} [options.companyName]        Company display name copied
 *                                              into NormalizedJob.company.
 * @param {number} [options.timeoutMs]          Per-request timeout, default 20s.
 * @returns {Promise<NormalizedJob[]>}
 * @throws {GreenhouseApiError}
 */
export async function fetchGreenhouseJobs(boardToken, options = {}) {
  const {
    includeContent = false,
    useDeprecatedApi = false,
    locationContains = [],
    companyName = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const url = buildGreenhouseApiUrl(boardToken, { includeContent, useDeprecatedApi });

  let payload;
  try {
    payload = await getJsonOnce(url, timeoutMs);
  } catch (firstErr) {
    // Single retry — only for transient classes (network / 5xx).
    const retriable =
      firstErr instanceof GreenhouseApiError &&
      (firstErr.statusCode === 0 || firstErr.statusCode >= 500);
    if (!retriable) throw firstErr;
    // Wait a beat before the retry; do not block the loop too long.
    await new Promise((r) => setTimeout(r, 750));
    payload = await getJsonOnce(url, timeoutMs);
  }

  const rawJobs = Array.isArray(payload?.jobs)
    ? payload.jobs
    : Array.isArray(payload)
      ? payload
      : [];

  const filtered = rawJobs.filter((j) => j && j.id && j.title && passesLocationFilter(j, locationContains));

  return filtered.map((rawJob) => normalizeGreenhouseJob(rawJob, { companyName, includeContent }));
}

/* ── Normaliser ──────────────────────────────────────────────── */

/**
 * Inline slug helper — kept dependency-free so this module can be imported
 * from anywhere under `scripts/lib/` without coupling to `crawler-template`.
 *
 * @param {string} value
 * @returns {string}
 */
function inlineSlugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function normalizeWhitespace(value = '') {
  return String(value || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Convert a raw Greenhouse job object into the vendor-agnostic
 * NormalizedJob shape used by downstream pipeline stages.
 *
 * Tolerant of missing fields: any field except `id` + `title` may be absent
 * and will fall back to a sensible default (empty string / null).
 *
 * @param {object} rawJob
 * @param {object} [options]
 * @param {string} [options.companyName]      Company display name.
 * @param {boolean} [options.includeContent]  When true, copy `content` to
 *                                            NormalizedJob.descriptionHtml.
 * @returns {NormalizedJob}
 */
export function normalizeGreenhouseJob(rawJob, options = {}) {
  const { companyName = '', includeContent = false } = options;
  if (!rawJob || typeof rawJob !== 'object') {
    throw new TypeError('normalizeGreenhouseJob: rawJob must be an object');
  }

  const jobReqId = rawJob.id != null ? String(rawJob.id) : '';
  const title = normalizeWhitespace(rawJob.title || '');
  const location = normalizeWhitespace(pickFirstLocationString(rawJob));
  const applyUrl = typeof rawJob.absolute_url === 'string' ? rawJob.absolute_url : '';

  const postedAt = (() => {
    if (typeof rawJob.first_published === 'string' && rawJob.first_published) return rawJob.first_published;
    if (typeof rawJob.updated_at === 'string' && rawJob.updated_at) return rawJob.updated_at;
    return null;
  })();

  /** @type {NormalizedJob} */
  const normalized = {
    jobReqId,
    slug: inlineSlugify(title),
    title,
    location,
    company: companyName,
    postedAt,
    applyUrl,
  };

  if (includeContent && typeof rawJob.content === 'string' && rawJob.content.length > 0) {
    normalized.descriptionHtml = rawJob.content;
  }

  return normalized;
}

/* ── Board-token detection ───────────────────────────────────── */

const BOARD_TOKEN_PATTERNS = [
  // Modern public job-board host.
  /(?:https?:\/\/)?(?:www\.)?boards\.greenhouse\.io\/([a-z0-9][a-z0-9-_]*)/i,
  // Newer "job-boards" host (Greenhouse rolled this out for some clients).
  /(?:https?:\/\/)?(?:www\.)?job-boards\.greenhouse\.io\/([a-z0-9][a-z0-9-_]*)/i,
  // Embed/iframe form.
  /(?:https?:\/\/)?(?:www\.)?boards\.greenhouse\.io\/embed\/job_board\?for=([a-z0-9][a-z0-9-_]*)/i,
  // Direct API URL leaks (rare but seen in source HTML).
  /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9][a-z0-9-_]*)/i,
];

/**
 * Heuristically extract a Greenhouse board token from a career-site URL,
 * an HTML snippet, or any string that may embed a Greenhouse link/iframe.
 *
 * Matching is case-insensitive and tolerant of `www.`, embed URLs, and
 * direct API references. Returns `null` when no Greenhouse signature is
 * found — callers should treat that as "this site is NOT on Greenhouse".
 *
 * @param {string} careerSiteUrl  URL or HTML blob.
 * @returns {string|null} Lower-cased board token, or null.
 */
export function extractGreenhouseBoardToken(careerSiteUrl) {
  if (!careerSiteUrl || typeof careerSiteUrl !== 'string') return null;
  for (const re of BOARD_TOKEN_PATTERNS) {
    const m = careerSiteUrl.match(re);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return null;
}
