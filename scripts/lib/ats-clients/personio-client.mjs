/**
 * Personio ATS — Shared client.
 *
 * Pipeline:
 *
 *   subdomain → buildPersonioXmlUrl → GET https://{subdomain}.jobs.personio.de/xml
 *      ↓
 *   parse XML (`<workzag-jobs><position>…</position></workzag-jobs>`)
 *      ↓
 *   normalize each `<position>` → NormalizedJob
 *
 * Personio publishes a free, unauthenticated XML job feed per tenant
 * subdomain — no pagination, no auth, single GET returns every open
 * position in one document. Each `<position>` carries a flat set of
 * scalar fields (office, department, employmentType, seniority,
 * schedule, createdAt, keywords) plus a `<jobDescriptions>` list of
 * `{name, value}` pairs (value is HTML wrapped in CDATA) — these are the
 * rich-text sections (intro / responsibilities / requirements / benefits)
 * concatenated into a single description body by `normalizePersonioJob`.
 *
 * Public posting URL: `https://{subdomain}.jobs.personio.de/job/{id}`
 * (verified 200, matches feed `<id>`).
 *
 * This module centralises:
 * - URL building (`buildPersonioXmlUrl`)
 * - Fetching + XML parsing (`fetchPersonioJobs`)
 * - Normalisation to vendor-agnostic `NormalizedJob` shape
 *   (`normalizePersonioJob`)
 * - A typed error class (`PersonioApiError`) carrying HTTP status
 *
 * Does NOT replace per-company parsers — those still own company-specific
 * concerns (canton inference, sector tagging, category detection).
 * Per-company parsers consume the array and also receive `rawPosition` on
 * each NormalizedJob to extract extra fields (department, occupation,
 * yearsOfExperience, …) without re-parsing.
 *
 * DETAIL-PAGE FALLBACK (added 2026-07-05, #3497): the XML feed's
 * `<jobDescriptions>` list is frequently EMPTY for individual positions even
 * though the tenant's own public detail page (`/job/{id}`, same Personio-
 * hosted career site, server-rendered) always carries the full rich-text
 * body in a schema.org/JobPosting JSON-LD `<script>` block. Verified live:
 * felfel (10/13 positions had an empty feed `<jobDescriptions>` but a fully
 * populated detail-page JSON-LD description), igroove (1/1) and yapeal (1/1)
 * — every one of those resolved to 3.5–4k chars of real content once fetched
 * from `/job/{id}`. Without this fallback `fetchPersonioJobs` silently
 * returns an empty `descriptionHtml`, so every downstream per-company parser
 * falls back to its `"{title} bei {company} in {location}."` placeholder —
 * which then becomes the PERMANENT stored description (caught by
 * `audit-parser-quality.mjs` as a "too-short" thin description). `fetchPersonioJobs`
 * now backfills `descriptionHtml` from the detail page for exactly the
 * positions the feed left empty, via `fetchPersonioJobDetailDescription`
 * (built on the shared `extractJobPostingDescription` JSON-LD extractor —
 * same helper Decathlon/Straumann use for the identical "listing carries
 * only metadata" pattern, AGENTS.md rule #6). Tenants whose feed already
 * carries full descriptions pay zero extra requests.
 */

import { XMLParser } from 'fast-xml-parser';
import { httpFetchWithRetry } from '../transient-fetch.mjs';
import { extractJobPostingDescription } from '../jobposting-jsonld.mjs';

/* ── Constants ───────────────────────────────────────────────── */

const PERSONIO_BASE = 'https://{subdomain}.jobs.personio.de';
const POLITE_UA = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const DEFAULT_TIMEOUT_MS = 20_000;

/* ── Error class ─────────────────────────────────────────────── */

/**
 * Error thrown by `fetchPersonioJobs` after retries are exhausted or on a
 * non-recoverable HTTP status.
 */
export class PersonioApiError extends Error {
  constructor(message, statusCode = null) {
    super(message);
    this.name = 'PersonioApiError';
    this.statusCode = statusCode;
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function toArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function toIsoDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Build the public Personio XML feed URL for a tenant subdomain.
 *
 * @param {string} subdomain e.g. "felfel", "yapeal-ag", "igroove"
 * @returns {string}
 */
export function buildPersonioXmlUrl(subdomain) {
  if (!subdomain || typeof subdomain !== 'string') {
    throw new TypeError('buildPersonioXmlUrl: subdomain must be non-empty string');
  }
  return `${PERSONIO_BASE.replace('{subdomain}', subdomain)}/xml`;
}

/**
 * Concatenate a position's `jobDescriptions` sections into one HTML body,
 * prefixing each section with its heading (`## SECTION NAME`).
 *
 * @param {Object} rawPosition raw `<position>` object from parsed XML.
 * @returns {string}
 */
function concatJobDescriptions(rawPosition) {
  const list = toArray(rawPosition?.jobDescriptions?.jobDescription);
  const parts = [];
  for (const section of list) {
    const name = normalizeSpace(section?.name || '');
    const value = normalizeSpace(section?.value || '');
    if (!value) continue;
    parts.push(name ? `## ${name}\n\n${value}` : value);
  }
  return parts.join('\n\n').trim();
}

/**
 * Convert a single raw Personio `<position>` into vendor-agnostic shape.
 *
 * @param {Object} rawPosition
 * @param {Object} [options]
 * @param {string} [options.subdomain] Used to compose the public job URL.
 * @returns {{
 *   jobReqId: string, title: string, location: string, department: string,
 *   postedAt: string|null, applyUrl: string, descriptionHtml: string,
 *   employmentType: string, seniority: string, schedule: string,
 *   rawPosition: Object,
 * }}
 */
export function normalizePersonioJob(rawPosition, options = {}) {
  const { subdomain = '' } = options;
  const id = String(rawPosition?.id ?? '').trim();
  const title = normalizeSpace(rawPosition?.name || '');
  const location = normalizeSpace(rawPosition?.office || '');
  const applyUrl = id && subdomain
    ? `https://${subdomain}.jobs.personio.de/job/${encodeURIComponent(id)}`
    : '';

  return {
    jobReqId: id,
    title,
    location,
    department: normalizeSpace(rawPosition?.department || ''),
    postedAt: toIsoDate(rawPosition?.createdAt),
    applyUrl,
    descriptionHtml: concatJobDescriptions(rawPosition),
    employmentType: normalizeSpace(rawPosition?.employmentType || ''),
    seniority: normalizeSpace(rawPosition?.seniority || ''),
    schedule: normalizeSpace(rawPosition?.schedule || ''),
    rawPosition,
  };
}

/**
 * Fetch a Personio job detail page (`/job/{id}`) and pull the full
 * description out of its embedded schema.org/JobPosting JSON-LD `<script>`
 * block — the same SSR pattern Decathlon/Straumann use, see
 * `extractJobPostingDescription` doc in `jobposting-jsonld.mjs`.
 *
 * Used ONLY as a backfill for positions whose XML-feed `<jobDescriptions>`
 * came back empty (see module doc, #3497). Returns '' on any miss/failure
 * so the caller falls back to its own placeholder — never throws, this must
 * not fail the whole crawl over one detail page.
 *
 * @param {string} url public job detail URL (`normalizePersonioJob().applyUrl`)
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] Default 20_000 ms.
 * @param {string} [options.userAgent] Default polite UA.
 * @returns {Promise<string>} raw HTML description (possibly with markup), or ''.
 */
async function fetchPersonioJobDetailDescription(url, options = {}) {
  if (!url) return '';
  const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = POLITE_UA } = options;
  try {
    const res = await httpFetchWithRetry(
      url,
      { headers: { 'User-Agent': userAgent, Accept: 'text/html' } },
      { timeout: timeoutMs, label: `personio detail ${url}` },
    );
    if (!res.ok) return '';
    const html = await res.text();
    return extractJobPostingDescription(html);
  } catch {
    return ''; // network/timeout — caller falls back to its own placeholder
  }
}

/**
 * Fetch and parse every open position from a Personio tenant's public XML
 * feed. Single request, no pagination.
 *
 * Positions whose `<jobDescriptions>` came back empty in the feed get a
 * second, per-position request to their public detail page to recover the
 * real description (see module doc, #3497) — tenants whose feed is already
 * fully populated pay zero extra requests.
 *
 * @param {string} subdomain e.g. "felfel", "yapeal-ag", "igroove"
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] Default 20_000 ms.
 * @param {string} [options.userAgent] Default polite UA.
 * @returns {Promise<Array<ReturnType<typeof normalizePersonioJob>>>}
 * @throws {PersonioApiError} on persistent failure or malformed feed.
 */
export async function fetchPersonioJobs(subdomain, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = POLITE_UA } = options;
  const url = buildPersonioXmlUrl(subdomain);

  let res;
  try {
    res = await httpFetchWithRetry(
      url,
      { headers: { 'User-Agent': userAgent, Accept: 'application/xml' } },
      { timeout: timeoutMs, label: `personio ${subdomain}` },
    );
  } catch (err) {
    throw new PersonioApiError(`Personio feed fetch failed for ${subdomain}: ${err?.message || err}`, err?.status ?? null);
  }

  if (!res.ok) {
    throw new PersonioApiError(`Personio feed returned HTTP ${res.status} for ${subdomain}`, res.status);
  }

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: false,
  });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new PersonioApiError(`Personio feed XML parse failed for ${subdomain}: ${err?.message || err}`, null);
  }

  const positions = toArray(parsed?.['workzag-jobs']?.position);
  const jobs = positions.map((p) => normalizePersonioJob(p, { subdomain }));

  // Backfill from the detail page for exactly the positions the XML feed
  // left empty (see module doc, #3497). Sequential — tenant volumes here are
  // small (single digits to low tens of open positions) and this mirrors the
  // existing Decathlon detail-page-fallback pattern (no artificial delay).
  for (const job of jobs) {
    if (job.descriptionHtml || !job.applyUrl) continue;
    job.descriptionHtml = await fetchPersonioJobDetailDescription(job.applyUrl, { timeoutMs, userAgent });
  }

  return jobs;
}
