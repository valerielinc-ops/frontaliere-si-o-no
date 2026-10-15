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
 * now fetches structured detail data for every position with a public URL and
 * backfills `descriptionHtml` from that response when the feed left it empty,
 * via `fetchPersonioJobDetailData`
 * (built on the shared `extractJobPostingDescription` JSON-LD extractor —
 * same helper Decathlon/Straumann use for the identical "listing carries
 * only metadata" pattern, AGENTS.md rule #6). Tenants whose feed already
 * carries full descriptions still need the detail request for address data.
 *
 * RENDERED PAGE FIRST (lotto F, #5253): that same detail response is now the
 * primary description source. The job page's rendered blocks are the full
 * vacancy — company block included, in the language the published URL shows
 * — while the feed sections omit the company block and can be in another
 * language. Feed sections, then JSON-LD, remain the fallbacks when the page
 * renders no recognisable block (see `extractPersonioRenderedJob`).
 */

import { XMLParser } from 'fast-xml-parser';
import { sourcePostingDateFields } from '../source-posting-date.mjs';
import { httpFetchWithRetry } from '../transient-fetch.mjs';
import {
  extractJobPostingAddress,
  extractJobPostingDescription,
  extractJobPostingField,
} from '../jobposting-jsonld.mjs';
import { decodeEntities, extractBalancedTagBlock } from '../hospital-custom-html-helpers.mjs';

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
 *   postedAt: string|null, datePosted: string, postedDate: string,
 *   postingDateSource: "reported"|"unknown", applyUrl: string, descriptionHtml: string,
 *   employmentType: string, seniority: string, schedule: string,
 *   rawPosition: Object, locationDetail: Object|null,
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
    // XML createdAt is record creation, not evidence of public release.
    ...sourcePostingDateFields(),
    postedAt: null,
    applyUrl,
    descriptionHtml: concatJobDescriptions(rawPosition),
    employmentType: normalizeSpace(rawPosition?.employmentType || ''),
    seniority: normalizeSpace(rawPosition?.seniority || ''),
    schedule: normalizeSpace(rawPosition?.schedule || ''),
    rawPosition,
    locationDetail: null,
  };
}

/**
 * Read the vacancy exactly as the public job page `/job/{id}` renders it:
 * the title heading plus every content block, in page order.
 *
 * WHY THE RENDERED PAGE, NOT THE FEED (lotto F, #5253). The page is the URL
 * we publish, and it differs from both machine-readable surfaces:
 *   - it carries the tenant's company block (`detail-content-block-about-us`,
 *     «Über uns» / «About us»), which the XML feed and `search.json` do not
 *     return as a job section — felfel, kellerhals-carrard, lalive and
 *     sune-egge were all publishing without it;
 *   - it renders ONE language chosen by Personio, independent of
 *     `Accept-Language`, while `/xml` without `?language=` answers in the
 *     tenant's feed language. felfel 2342381 exists in DE and EN: the feed
 *     gave the German body, the published URL shows the English one — same
 *     vacancy, two languages, 0.11 word overlap with its own page;
 *   - `search.json?language=de` returns an EMPTY description for a position
 *     that only exists in English (kellerhals-carrard 2811560), so the parser
 *     fell back to a 244-character placeholder;
 *   - the JSON-LD `description` is absent on several `.jobs.personio.com`
 *     tenants (amina, lalive) and on others carries empty headings.
 * Blocks are matched on Personio's stable semantic classes
 * (`jb-description-item`, `detail-content-block-about-us`,
 * `detail-block-title`, `rich-text-content`), never on the hashed CSS-module
 * names (`page_jobDescriptionItem__eMzRv`) that change with every build.
 *
 * @param {string} html
 * @returns {{ title: string, descriptionHtml: string }}
 */
export function extractPersonioRenderedJob(html = '') {
  const source = String(html || '');
  const titleMatch = /<h1\b[^>]*\bclass=["'][^"']*\bjob-position-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(source);
  const title = titleMatch
    ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')))
    : '';
  const parts = [];
  const blockRe = /<div\b[^>]*\bclass=["'][^"']*\b(?:jb-description-item|detail-content-block-about-us)\b[^"']*["'][^>]*>/gi;
  let block;
  while ((block = blockRe.exec(source)) !== null) {
    const inner = extractBalancedTagBlock(source.slice(block.index + block[0].length), 'div', 200_000);
    const heading = /<h2\b[^>]*\bclass=["'][^"']*\bdetail-block-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i.exec(inner);
    const name = heading ? normalizeSpace(decodeEntities(heading[1].replace(/<[^>]+>/g, ' '))) : '';
    const body = /<div\b[^>]*\bclass=["'][^"']*\brich-text-content\b[^"']*["'][^>]*>/i.exec(inner);
    const value = body
      ? normalizeSpace(extractBalancedTagBlock(inner.slice(body.index + body[0].length), 'div', 200_000))
      : '';
    if (!value.replace(/<[^>]+>/g, '').trim()) continue;
    parts.push(name ? `## ${name}\n\n${value}` : value);
  }
  return { title, descriptionHtml: parts.join('\n\n').trim() };
}

/**
 * Choose the title/body pair a parser publishes for one position.
 *
 * The published URL is the job page, so its rendered body — company block
 * included, in the language the page actually shows — wins whenever the page
 * rendered one; the title follows it so title and body never disagree on
 * language. Otherwise the listing's own fields (XML sections or `search.json`
 * description) are kept, and the JSON-LD description only fills an empty one.
 *
 * @param {{ title?: string, renderedDescriptionHtml?: string, descriptionHtml?: string }} detail
 *   result of `fetchPersonioJobDetailData`
 * @param {{ title?: string, descriptionHtml?: string }} listing fields from the feed
 * @returns {{ title: string, descriptionHtml: string }}
 */
export function preferRenderedPersonioContent(detail, listing = {}) {
  const title = String(listing?.title || '');
  if (detail?.renderedDescriptionHtml) {
    return { title: detail.title || title, descriptionHtml: detail.renderedDescriptionHtml };
  }
  return { title, descriptionHtml: listing?.descriptionHtml || detail?.descriptionHtml || '' };
}

/**
 * Fetch one public job page and return everything the per-company parsers
 * read from it: the rendered vacancy (title + full body, see
 * `extractPersonioRenderedJob`), the JSON-LD description fallback and the
 * JSON-LD workplace address and explicit publication date.
 *
 * @param {string} url public `/job/{id}` URL (`.jobs.personio.de` or `.com`)
 * @param {{ timeoutMs?: number, userAgent?: string }} [options]
 * @returns {Promise<{ title: string, renderedDescriptionHtml: string, descriptionHtml: string, locationDetail: object|null, datePosted: string, postedDate: string, postingDateSource: "reported"|"unknown" }>}
 */
export async function fetchPersonioJobDetailData(url, options = {}) {
  const empty = { title: '', renderedDescriptionHtml: '', descriptionHtml: '', locationDetail: null, ...sourcePostingDateFields() };
  if (!url) return empty;
  const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = POLITE_UA } = options;
  try {
    const res = await httpFetchWithRetry(
      url,
      { headers: { 'User-Agent': userAgent, Accept: 'text/html' } },
      { timeout: timeoutMs, label: `personio detail ${url}` },
    );
    if (!res.ok) return empty;
    const html = await res.text();
    const rendered = extractPersonioRenderedJob(html);
    return {
      title: rendered.title,
      renderedDescriptionHtml: rendered.descriptionHtml,
      descriptionHtml: extractJobPostingDescription(html),
      locationDetail: extractJobPostingAddress(html),
      ...sourcePostingDateFields(extractJobPostingField(html, 'datePosted')),
    };
  } catch {
    return empty;
  }
}

/**
 * `search.json` flavour of the same preference, for the parsers that read
 * Personio's JSON listing (`{ id, name, description, office, … }`) instead of
 * the XML feed: fetch the record's public job page and return the record with
 * `name`/`description` taken from what that page renders. Call it only for a
 * record the parser keeps, so tenant-wide listings (sune-egge filters one
 * office out of a multi-site tenant) do not pay a request per foreign row.
 *
 * @param {Record<string, any>} record one `search.json` entry
 * @param {string} publicUrl the `/job/{id}` URL the parser publishes
 * @param {{ timeoutMs?: number, userAgent?: string }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function withRenderedPersonioPage(record, publicUrl, options = {}) {
  const detail = await fetchPersonioJobDetailData(publicUrl, options);
  const { title, descriptionHtml } = preferRenderedPersonioContent(detail, {
    title: record?.name,
    descriptionHtml: record?.description,
  });
  const postingDates = sourcePostingDateFields(detail.datePosted);
  return { ...record, name: title, description: descriptionHtml, ...postingDates, postedAt: postingDates.postedDate || null };
}

/**
 * Fetch and parse every open position from a Personio tenant's public XML
 * feed. Single request, no pagination.
 *
 * Every position with a public URL gets a second request to its detail page:
 * the rendered page body replaces the feed sections when present, the JSON-LD
 * description fills an empty feed otherwise, and the JSON-LD address is
 * always read (see module doc, #3497 and #5253).
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

  // Fetch detail data for every position so structured workplace data cannot
  // be skipped merely because the XML feed already carried a description.
  // Use the same response as the description backfill (see module doc,
  // #3497). Sequential — tenant volumes here are small (single digits to low
  // tens of open positions) and this mirrors the existing detail-page-
  // fallback pattern (no artificial delay).
  for (const job of jobs) {
    if (!job.applyUrl) continue;
    const detail = await fetchPersonioJobDetailData(job.applyUrl, { timeoutMs, userAgent });
    Object.assign(job, preferRenderedPersonioContent(detail, job));
    job.locationDetail = detail.locationDetail;
    const postingDates = sourcePostingDateFields(detail.datePosted);
    Object.assign(job, postingDates, { postedAt: postingDates.postedDate || null });
  }

  return jobs;
}
