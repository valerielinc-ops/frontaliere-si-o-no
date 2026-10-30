#!/usr/bin/env node
/**
 * Stiftung Diaconis (Bern) — palliative care + Wohnen im Alter + Arbeitsintegration.
 *
 * The public site diaconis.ch exposes its current openings through the public
 * Abacus JobPortal API behind:
 *   https://karriere.diaconis.ch/job-overview
 *
 * The old Abacus City HTML host is retained only as a bounded compatibility
 * fallback. It is no longer the primary source: its landing page has started
 * returning gateway/client errors (including 422 through the rescue proxy),
 * while the canonical API returns complete publication records and their
 * descriptions in one response.
 *
 * Listing structure:
 *   <a href="/de/job_{INSTANCE}_{ID}/{title-slug}">
 *     {ENCODED_TITLE}
 *   </a>
 *
 * "Spontanbewerbung", "Spontananfrage", "Berufswahlpraktikum (Schnuppern)" and
 * "Freiwillig Engagierte/r" entries are dropped — they are not real openings.
 *
 * Detail page is a static HTML form. Visible content lives in a series of
 * `<div class="col-xs-12 {section}">` blocks (introduction / jobtitle / tasks
 * / benefits / requirements / contact / closure). We grab every such block
 * inside <main>, strip HTML, and concatenate.
 *
 * Address: Schönburgstrasse 25, 3000 Bern 25 (BE).
 */
import {
  sourcePostingDateFields,
  sourcePostingDateCandidatesFields,
  mergeSourcePostingDates,
} from './source-posting-date.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, normalizeDescriptionBullets } from './crawler-template.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  USER_AGENT,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const STIFTUNG_DIACONIS_KEY = 'stiftung-diaconis';
export const STIFTUNG_DIACONIS_COMPANY_NAME = 'Stiftung Diaconis';
export const STIFTUNG_DIACONIS_COMPANY_DOMAIN = 'diaconis.ch';

export const LISTING_URL = 'https://karriere.diaconis.ch/job-overview';
export const LISTING_API_URL = 'https://api.jobportal.abaservices.ch/api/publication/publications/job-portal/2e0f40b6-1598-4270-808b-c63e75a05a6c/static-button?link=https%3A%2F%2Fkarriere.diaconis.ch%2Fjob-overview';
const LEGACY_LISTING_URL = 'https://diaconis.abacuscity.ch/';
const PUBLIC_CAREER_URL = 'https://diaconis.ch/karriere/offene-stellen/';

const HQ_CITY = 'Bern';
const HQ_POSTAL_CODE = '3000';
const HQ_CANTON = 'BE';

const DETAIL_DELAY_MS = 350;

/* ── Matchers ──────────────────────────────────────────────── */

export function isStiftungDiaconisJob(job) {
  if (job?.companyKey === STIFTUNG_DIACONIS_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('diaconis') || company.includes('stiftung diaconis')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('diaconis.ch') || url.includes('diaconis.abacuscity.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'diaconis.ch' || host.endsWith('.diaconis.ch')) return true;
    if (host === 'diaconis.abacuscity.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Listing parser ────────────────────────────────────────── */

const SPONTANEOUS_RE = /(spontan|berufswahlpraktikum|freiwillig\s+engagier|schnupper|praktikums-?anfrage)/i;

/**
 * Parse the Abacus City landing page and return one row per real opening.
 * Dedupes by job ID (numeric segment after `job_{instance}_`).
 *
 * @param {string} html
 * @returns {Array<{ url: string, jobId: string, title: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  // The portal currently emits relative links; older snapshots used absolute
  // links. Resolve both forms against the listing URL before validating the
  // destination so a same-shaped link from another host cannot be ingested.
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])([^"'<>]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rawHref = decodeEntities(m[2].trim());
    let parsedUrl;
    try {
      parsedUrl = new URL(rawHref, LEGACY_LISTING_URL);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname.toLowerCase() !== 'diaconis.abacuscity.ch') {
      continue;
    }
    const jobPath = parsedUrl.pathname.match(/^\/[a-z]{2,3}\/job_\d+_(\d+)(?:\/|$)/i);
    if (!jobPath) continue;
    const url = parsedUrl.toString();
    const jobId = jobPath[1];
    const titleRaw = normalizeSpace(decodeEntities(m[3].replace(/<[^>]+>/g, ' ')));
    if (!titleRaw || titleRaw.length < 4) continue;
    if (SPONTANEOUS_RE.test(titleRaw)) continue;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    out.push({ url, jobId, title: titleRaw });
  }
  return out;
}

/**
 * Parse the records returned by the canonical Abacus JobPortal endpoint.
 *
 * The API is already a publication list, so following one detail request per
 * row is both slower and less reliable than using the record itself. Keep the
 * original record on each internal row so the builder can consume the source
 * description, address and publication date without exposing it in a job.
 *
 * @param {unknown} payload
 * @returns {Array<{ url: string, jobId: string, title: string, sourceRecord: object }>}
 */
export function parseApiListing(payload = []) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  const seen = new Set();
  for (const record of payload) {
    if (!record || typeof record !== 'object') continue;
    const rawUrl = decodeEntities(String(record.PublicationUrlAbacusJobPortal || '').trim());
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== 'https:' || !isTrustedDomain(parsedUrl.toString())) continue;

    const jobId = normalizeSpace(String(
      record.PublicationId || record.JobId || record.PositionNumber || '',
    ));
    if (!jobId || seen.has(jobId)) continue;

    const title = normalizeSpace(decodeEntities(htmlToText(String(
      record.JobTitle || record.PositionTitle || record.Designation01 || '',
    ))));
    if (!title || title.length < 4 || SPONTANEOUS_RE.test(title)) continue;

    seen.add(jobId);
    out.push({
      url: parsedUrl.toString(),
      jobId,
      title,
      sourceRecord: record,
    });
  }
  return out;
}

function normalizeApiDescription(value = '') {
  // The API JSON contains HTML encoded once (`&lt;p&gt;...`). Decode before
  // handing it to htmlToText, otherwise the decoded tags would remain in the
  // published body after the helper's tag-stripping pass.
  const decoded = decodeEntities(String(value || ''));
  if (!decoded.trim()) return '';
  const cleaned = htmlToText(decoded)
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalizeDescriptionBullets(cleaned);
}

const API_DESCRIPTION_FIELDS = [
  'Organization',
  'Introduction',
  'Tasks',
  'Requirements',
  'Benefits',
  'Contact',
  'Closure',
];

/** Build the source body and date evidence from one API publication. */
export function parseApiDescription(record = {}) {
  if (!record || typeof record !== 'object') {
    return { body: '', ...sourcePostingDateFields('') };
  }
  const parts = API_DESCRIPTION_FIELDS
    .map((field) => normalizeApiDescription(record[field]))
    .filter(Boolean);
  return {
    body: normalizeDescriptionBullets(parts.join('\n\n')),
    ...sourcePostingDateCandidatesFields([
      record.PublicationStartDateSortkey,
      record.PublicationStartDate,
      record.PositionValidFromSortkey,
      record.PositionValidFrom,
    ]),
  };
}

/* ── Detail parser ─────────────────────────────────────────── */

const DETAIL_SECTIONS = ['introduction', 'jobtitle', 'tasks', 'benefits', 'requirements', 'contact', 'closure'];

/**
 * Concatenate every `<div class="col-xs-12 {section}">…</div>` block in the
 * order they appear. Strip HTML and produce a single trimmed body text.
 */
export function parseDetailDescription(html = '') {
  const parts = [];
  for (const section of DETAIL_SECTIONS) {
    const re = new RegExp(
      `<div\\s+class="[^"]*\\bcol-xs-12\\s+${section}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`,
      'gi',
    );
    let m;
    while ((m = re.exec(html)) !== null) {
      const inner = m[1].trim();
      if (inner) parts.push(inner);
    }
  }
  if (parts.length === 0) {
    const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (main) parts.push(main[1]);
  }
  if (parts.length === 0) return '';
  const cleaned = htmlToText(parts.join('\n\n'))
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalizeDescriptionBullets(cleaned);
}

/* ── Fetch + build ─────────────────────────────────────────── */

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    return { body: parseDetailDescription(html), ...sourcePostingDateFields(extractJobPostingLd(html)?.datePosted) };
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return { body: '', ...sourcePostingDateFields('') };
  }
}

async function fetchApiPayload() {
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(LISTING_API_URL, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${LISTING_API_URL}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }, { label: `${STIFTUNG_DIACONIS_COMPANY_NAME} JobPortal API` });
}

export async function fetchAllStiftungDiaconisJobs({
  fetchApi = fetchApiPayload,
  fetchLegacyHtml = fetchHtml,
} = {}) {
  console.log(`🏥 Fetching ${STIFTUNG_DIACONIS_COMPANY_NAME} jobs`);
  console.log(`   API:     ${LISTING_API_URL}`);
  console.log(`   Public:  ${PUBLIC_CAREER_URL}\n`);

  let rows;
  let sourceLabel = 'Abacus JobPortal API';
  try {
    const payload = await fetchApi();
    if (!Array.isArray(payload)) {
      throw new Error('Abacus JobPortal API returned a non-array payload');
    }
    rows = parseApiListing(payload);
    if (rows.length === 0) {
      if (payload.length === 0) {
        console.log('  ✓ API explicitly reports zero publications');
        return markAuthoritativeEmptySnapshot(
          [],
          'Abacus JobPortal API returned a successful empty publication array',
        );
      }
      throw new Error(`Abacus JobPortal API returned ${payload.length} records but no trusted real opening was parsed`);
    }
  } catch (apiError) {
    console.warn(`⚠️ JobPortal API fetch/parse failed: ${apiError?.message || apiError}`);
    console.warn(`   Trying legacy HTML fallback: ${LEGACY_LISTING_URL}`);
    try {
      const listingHtml = await fetchLegacyHtml(LEGACY_LISTING_URL);
      rows = parseListing(listingHtml);
    } catch (legacyError) {
      legacyError.cause = apiError;
      throw legacyError;
    }
    if (rows.length === 0) {
      throw new Error(
        `Stiftung Diaconis produced no trusted opening after API failure and legacy fallback `
        + '(fail-closed; source state is not proven empty)',
      );
    }
    sourceLabel = 'Abacus City HTML fallback';
  }
  console.log(`  ✓ ${rows.length} real openings (spontaneous/Schnupper/freiwillig rows dropped)`);

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r.sourceRecord && i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detail = r.sourceRecord ? parseApiDescription(r.sourceRecord) : await fetchDetail(r.url);
    const description = detail.body;
    const fallback = `${r.title} bei der ${STIFTUNG_DIACONIS_COMPANY_NAME}, ${HQ_CITY} (${HQ_CANTON}). Stiftung Diaconis betreibt Palliative Care, Wohnen im Alter sowie Arbeitsintegration in Bern.`;
    const safeDescription =
      description && description.split(/\s+/).length >= 30
        ? description
        : [fallback, description].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(safeDescription || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${STIFTUNG_DIACONIS_KEY} ${HQ_CITY}`);
    const sourceRecord = r.sourceRecord || {};
    const location = normalizeSpace(sourceRecord.PlaceOfWorkCity) || HQ_CITY;
    const canton = normalizeSpace(sourceRecord.PlaceOfWorkState) || HQ_CANTON;
    const postalCode = normalizeSpace(sourceRecord.PlaceOfWorkZip) || HQ_POSTAL_CODE;
    const applyUrl = isTrustedDomain(sourceRecord.ApplicationUrl)
      ? new URL(sourceRecord.ApplicationUrl).toString()
      : r.url;

    jobs.push({
      id: `${STIFTUNG_DIACONIS_KEY}-${r.jobId}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STIFTUNG_DIACONIS_COMPANY_NAME,
      companyKey: STIFTUNG_DIACONIS_KEY,
      companyDomain: STIFTUNG_DIACONIS_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      needsRetranslation: true,
      location,
      canton,
      url: r.url,
      source: `${STIFTUNG_DIACONIS_COMPANY_NAME} Dedicated Parser (${sourceLabel})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(`${r.title} ${safeDescription.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(r.title)
        ? 'part-time'
        : 'full-time',
      employmentType: detectHealthcareEmploymentType(`${r.title} ${safeDescription.slice(0, 500)}`),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, detail),
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${STIFTUNG_DIACONIS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { PUBLIC_CAREER_URL, HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
