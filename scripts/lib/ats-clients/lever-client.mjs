/**
 * Lever ATS — Shared client.
 *
 * Pipeline:
 *
 *   companySlug → buildLeverApiUrl → GET /v0/postings/{slug}?mode=json
 *                                                ↓
 *                       [posting, posting, …] → normalize each → NormalizedJob[]
 *                                                ↓
 *                              location filter (locationContains substring)
 *                                                ↓
 *                                  pagination loop (skip += 100, maxPages)
 *
 * Lever exposes a public, unauthenticated JSON API at
 * `https://api.lever.co/v0/postings/{companySlug}?mode=json`. A single GET
 * returns up to 100 postings; pagination is via `skip` + `limit` query params.
 *
 * This module centralises:
 *
 *   - URL building (`buildLeverApiUrl`)
 *   - Fetching with polite UA, timeout, single retry on 5xx, paginated walk
 *     (`fetchLeverJobs`)
 *   - Normalisation to a vendor-agnostic `NormalizedJob` shape
 *     (`normalizeLeverJob`)
 *   - Heuristic detection of Lever usage from a career-site URL
 *     (`extractLeverCompanySlug`)
 *   - A typed error class (`LeverApiError`) carrying the HTTP status
 *
 * It does NOT replace per-company parsers — those still own company-specific
 * concerns (canton inference, sector tagging, employment-type heuristics,
 * description sanitisation). This client is the thin transport + shape layer.
 *
 * Reference Lever API docs:
 *   https://github.com/lever/postings-api
 *
 * Existing in-tree references to Lever (NOT modified by this file):
 *   - scripts/lib/kudelski-nagra-job-parser.mjs (detects Lever links in HTML)
 */

/**
 * @typedef {Object} NormalizedJob
 * @property {string} jobReqId          Lever posting `id` (UUID).
 * @property {string} slug              Kebab-case slug derived from title.
 * @property {string} title             Job title (whitespace-normalised), from `text`.
 * @property {string} location          `categories.location` string.
 * @property {string} company           Company display name (passed via options).
 * @property {string|null} postedAt     ISO timestamp — prefers `createdAt` (ms),
 *                                      falls back to `updatedAt`, else null.
 * @property {string} applyUrl          Lever `hostedUrl`.
 * @property {string} [descriptionHtml] HTML body, if available (`descriptionHtml`).
 */

/* ── Constants ───────────────────────────────────────────────── */

const LEVER_API_BASE = 'https://api.lever.co/v0/postings';
const POLITE_UA = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const DEFAULT_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;

/* ── Error class ─────────────────────────────────────────────── */

/**
 * Error thrown by `fetchLeverJobs` after retries are exhausted or on
 * non-recoverable errors (4xx, network, timeout).
 */
export class LeverApiError extends Error {
  /**
   * @param {string} message
   * @param {number|null} statusCode
   */
  constructor(message, statusCode = null) {
    super(message);
    this.name = 'LeverApiError';
    /** @type {number|null} */
    this.statusCode = statusCode;
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Simple kebab-case slugify.
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
 * Convert a Lever ms-timestamp (or undefined) to ISO string.
 * @param {number|undefined|null} ms
 * @returns {string|null}
 */
function msToIso(ms) {
  if (ms === undefined || ms === null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
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
 * Build the Lever postings API URL for a given company slug.
 *
 * @param {string} companySlug      e.g. "scandit", "linkedin", "matterport"
 * @param {Object} [options]
 * @param {number} [options.skip]   Pagination offset (default 0).
 * @param {number} [options.limit]  Max items per call (default 100, Lever cap).
 * @returns {string}
 */
export function buildLeverApiUrl(companySlug, options = {}) {
  if (!companySlug || typeof companySlug !== 'string') {
    throw new TypeError('buildLeverApiUrl: companySlug must be a non-empty string');
  }
  const params = new URLSearchParams({ mode: 'json' });
  if (Number.isFinite(options.skip) && options.skip > 0) {
    params.set('skip', String(Math.floor(options.skip)));
  }
  if (Number.isFinite(options.limit) && options.limit > 0) {
    params.set('limit', String(Math.floor(options.limit)));
  }
  return `${LEVER_API_BASE}/${encodeURIComponent(companySlug)}?${params.toString()}`;
}

/**
 * Fetch a single page from Lever, with one retry on 5xx.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Array<Object>>}
 */
async function fetchLeverPage(url, timeoutMs) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await timedFetch(url, { timeoutMs });
      if (res.ok) {
        const json = await res.json();
        if (!Array.isArray(json)) {
          throw new LeverApiError(
            `Lever API returned non-array body for ${url}`,
            res.status,
          );
        }
        return json;
      }
      // 5xx → retry once. 4xx → fail fast.
      if (res.status >= 500 && res.status < 600 && attempt === 0) {
        lastErr = new LeverApiError(
          `Lever API ${res.status} ${res.statusText} (retrying)`,
          res.status,
        );
        continue;
      }
      throw new LeverApiError(
        `Lever API ${res.status} ${res.statusText} for ${url}`,
        res.status,
      );
    } catch (err) {
      if (err instanceof LeverApiError) {
        if (attempt === 0 && err.statusCode && err.statusCode >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      // Network / abort / parse error
      if (attempt === 0) {
        lastErr = new LeverApiError(
          `Lever API fetch failed: ${err?.message || err}`,
          null,
        );
        continue;
      }
      throw new LeverApiError(
        `Lever API fetch failed (after retry): ${err?.message || err}`,
        null,
      );
    }
  }
  throw lastErr || new LeverApiError(`Lever API fetch failed for ${url}`, null);
}

/**
 * Fetch and normalise all Lever postings for a company slug.
 *
 * Pagination: Lever returns at most 100 postings per call. We call repeatedly
 * with `skip += 100` until either the response has fewer than `PAGE_SIZE`
 * items or we hit `options.maxPages`.
 *
 * @param {string} companySlug
 * @param {Object} [options]
 * @param {string} [options.company]            Display name to attach to each job.
 * @param {string[]} [options.locationContains] Case-insensitive substring filter
 *                                              on `categories.location`. If
 *                                              provided, only postings whose
 *                                              location contains AT LEAST ONE of
 *                                              the substrings are kept.
 * @param {number} [options.maxPages]           Default 5.
 * @param {number} [options.timeoutMs]          Default 20_000.
 * @returns {Promise<NormalizedJob[]>}
 * @throws {LeverApiError} on persistent failure.
 */
export async function fetchLeverJobs(companySlug, options = {}) {
  const {
    company,
    locationContains = [],
    maxPages = DEFAULT_MAX_PAGES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const needles = (Array.isArray(locationContains) ? locationContains : [])
    .map((s) => String(s || '').toLowerCase().trim())
    .filter(Boolean);

  /** @type {NormalizedJob[]} */
  const out = [];
  let skip = 0;

  for (let page = 0; page < Math.max(1, maxPages); page++) {
    const url = buildLeverApiUrl(companySlug, { skip, limit: PAGE_SIZE });
    const batch = await fetchLeverPage(url, timeoutMs);

    for (const raw of batch) {
      if (!raw || typeof raw !== 'object') continue;
      const loc = String(raw?.categories?.location || '').toLowerCase();
      if (needles.length > 0 && !needles.some((n) => loc.includes(n))) continue;
      out.push(normalizeLeverJob(raw, { company }));
    }

    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  return out;
}

/**
 * Convert a single raw Lever posting into the vendor-agnostic shape.
 *
 * @param {Object} rawJob
 * @param {Object} [options]
 * @param {string} [options.company]   Display name.
 * @returns {NormalizedJob}
 */
export function normalizeLeverJob(rawJob, options = {}) {
  const { company = '' } = options;
  const id = String(rawJob?.id ?? '').trim();
  const title = normalizeSpace(rawJob?.text || '');
  const location = normalizeSpace(rawJob?.categories?.location || '');
  const applyUrl = String(rawJob?.hostedUrl || '').trim();
  const postedAt = msToIso(rawJob?.createdAt) || msToIso(rawJob?.updatedAt) || null;
  const slug = slugify(title) || (id ? `lever-${id.slice(0, 8)}` : '');
  const descriptionHtml =
    typeof rawJob?.descriptionHtml === 'string' && rawJob.descriptionHtml
      ? rawJob.descriptionHtml
      : undefined;

  /** @type {NormalizedJob} */
  const out = {
    jobReqId: id,
    slug,
    title,
    location,
    company,
    postedAt,
    applyUrl,
  };
  if (descriptionHtml) out.descriptionHtml = descriptionHtml;
  return out;
}

/**
 * Heuristic detection of Lever usage from a career-site URL or HTML snippet.
 *
 * Recognises:
 *   - https://jobs.lever.co/{slug}
 *   - https://jobs.lever.co/{slug}/...
 *   - https://lever.co/jobs/{slug}
 *   - https://api.lever.co/v0/postings/{slug}
 *
 * @param {string} careerSiteUrl   A URL OR an HTML/text blob to search.
 * @returns {string|null}          The detected company slug, or null.
 */
export function extractLeverCompanySlug(careerSiteUrl = '') {
  const haystack = String(careerSiteUrl || '');
  if (!haystack) return null;

  const patterns = [
    /jobs\.lever\.co\/([a-z0-9][a-z0-9-]*)/i,
    /lever\.co\/jobs\/([a-z0-9][a-z0-9-]*)/i,
    /api\.lever\.co\/v0\/postings\/([a-z0-9][a-z0-9-]*)/i,
  ];

  for (const re of patterns) {
    const m = haystack.match(re);
    if (m && m[1]) {
      return m[1].toLowerCase();
    }
  }
  return null;
}
