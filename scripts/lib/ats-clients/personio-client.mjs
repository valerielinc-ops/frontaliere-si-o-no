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
 */

import { XMLParser } from 'fast-xml-parser';
import { httpFetchWithRetry } from '../transient-fetch.mjs';

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
 * Fetch and parse every open position from a Personio tenant's public XML
 * feed. Single request, no pagination.
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
  return positions.map((p) => normalizePersonioJob(p, { subdomain }));
}
