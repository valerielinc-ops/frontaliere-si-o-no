#!/usr/bin/env node
/**
 * Weisse Arena Gruppe job parser — Cegid TalentLink REST API.
 *
 * Source: https://www.weissearena.com/jobs/
 *
 * The career page embeds a Cegid TalentLink (formerly Lumesse) widget that
 * calls a REST API at emea3.recruitmentplatform.com. The API uses custom
 * auth headers (guest credentials baked into the widget JS) and returns
 * paginated JSON with job listings including full HTML descriptions via
 * customFields.
 *
 * API:
 *   POST /fo/rest/jobs?firstResult={offset}&maxResults={limit}
 *        &sortBy=DPOSTINGSTART&sortOrder=desc
 *   Headers: username, password, lumesse-language
 *   Body: { "searchCriteria": {} }
 *
 * Site tech ID: PD6FK026203F3VBQBLO8NV79D
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllWeisseArenaJobs()  — Fetch and parse all jobs
 *   - isWeisseArenaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to this company
 *   - slugify() / stripHtml()    — Re-exported from crawler-template.mjs
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const WEISSE_ARENA_KEY = 'weisse-arena';
export const WEISSE_ARENA_COMPANY_NAME = 'Weisse Arena Gruppe';
export const WEISSE_ARENA_COMPANY_DOMAIN = 'weissearena.com';

const SITE_TECH_ID = 'PD6FK026203F3VBQBLO8NV79D';
const API_BASE = 'https://emea3.recruitmentplatform.com/fo/rest/jobs';
const DETAIL_BASE = 'https://www.weissearena.com/jobs/details.html';
const PAGE_SIZE = 50;
const LISTING_SNAPSHOT_MAX_ATTEMPTS = 3;
const LISTING_SNAPSHOT_RETRY_DELAY_MS = 500;
const DETAIL_ABSENCE_MAX_CONCURRENCY = 4;
const PAGINATION_INCOMPLETE_ERROR_CODE = 'WEISSE_ARENA_PAGINATION_INCOMPLETE';
const INVALID_LISTING_ENVELOPE_ERROR_CODE = 'WEISSE_ARENA_INVALID_ENVELOPE';
const RETRYABLE_LISTING_SNAPSHOT_ERROR_CODES = new Set([
  PAGINATION_INCOMPLETE_ERROR_CODE,
  INVALID_LISTING_ENVELOPE_ERROR_CODE,
]);

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function firstNonEmptyValue(...values) {
  return values
    .filter((value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
    .map((value) => String(value).trim())
    .find(Boolean) || '';
}

function firstNonEmptyNormalized(...values) {
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => normalizeSpace(value))
    .find(Boolean) || '';
}

function createIncompleteSnapshotError(message) {
  const error = new Error(message);
  error.code = PAGINATION_INCOMPLETE_ERROR_CODE;
  return error;
}

function normalizeTalentLinkJobId(value) {
  const raw = typeof value === 'number' || typeof value === 'string'
    ? String(value).trim()
    : '';
  if (!/^\d+$/.test(raw)) return '';
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : '';
}

function existingTalentLinkJobId(job, index) {
  if (!isWeisseArenaJob(job)) {
    throw createIncompleteSnapshotError(
      `Weisse Arena existing job ${index + 1} is outside the source ownership boundary; refusing to verify a shrink.`,
    );
  }

  try {
    const url = new URL(job?.url || '');
    const host = url.hostname.toLowerCase();
    const jobIds = url.searchParams.getAll('jobId');
    const jobId = jobIds.length === 1 ? normalizeTalentLinkJobId(jobIds[0]) : '';
    if (
      url.protocol !== 'https:'
      || (host !== 'weissearena.com' && host !== 'www.weissearena.com')
      || url.pathname !== '/jobs/details.html'
      || !jobId
    ) {
      throw new Error('invalid Weisse Arena detail URL');
    }
    return jobId;
  } catch {
    throw createIncompleteSnapshotError(
      `Weisse Arena existing job ${index + 1} has no verifiable TalentLink jobId in its canonical URL; refusing to verify a shrink.`,
    );
  }
}

function listingTalentLinkJobId({ listing }, index) {
  const rawIds = [listing?.jobFields?.id, listing?.id]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
  const jobIds = rawIds.map(normalizeTalentLinkJobId);
  if (jobIds.length === 0 || jobIds.some((jobId) => !jobId) || new Set(jobIds).size !== 1) {
    throw createIncompleteSnapshotError(
      `Weisse Arena listing row ${index + 1} has no single numeric TalentLink jobId; refusing to verify a shrink.`,
    );
  }
  return jobIds[0];
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Weisse Arena Gruppe.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isWeisseArenaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === WEISSE_ARENA_KEY ||
    key.startsWith('weisse-arena') ||
    company.includes('weisse arena gruppe') ||
    company.includes('weisse arena') ||
    url.includes('weissearena.com') ||
    (url.includes('recruitmentplatform.com') && url.includes(SITE_TECH_ID.toLowerCase()))
  );
}

/**
 * Validate that a URL belongs to Weisse Arena Gruppe's domain.
 * Trusts both weissearena.com and recruitmentplatform.com (TalentLink ATS).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'weissearena.com' ||
      host.endsWith('.weissearena.com') ||
      host.endsWith('.recruitmentplatform.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect job category from title and department.
 * Tailored to Weisse Arena Gruppe's departments:
 *   - Gastronomie, Hotellerie, Skischule, Marketing, Technik, etc.
 */
export function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const combined = `${t} ${d}`;

  // Gastronomy / Restaurant
  if (/\b(koch|küche|k[oö]chin|pizzaiolo|spülküche|restaurant|gastro|bar|service.*mitarbeit|frühstück|kellner|buffet)/.test(combined)) return 'Ristorazione';
  // Hospitality / Hotel
  if (/\b(hotel|housekeep|rezeption|empfang|ferienwohn|concierge|room)/.test(combined)) return 'Hotellerie';
  // Ski / Sport / Outdoor
  if (/\b(ski|snowboard|bike|sport|piste|rettung|bergbahn|rental|schule)/.test(combined)) return 'Sport';
  // Marketing / Communication / Sales
  if (/\b(market|kommunik|content|growth|crm|lifecycle|sales|event|customer experience)/.test(combined)) return 'Marketing';
  // Tech / ICT / Engineering
  if (/\b(techni|unterhalt|sicherheit|ict|it\b|software|develop|ingenieur|engineer|bahnbetrieb|bahn.*technik)/.test(combined)) return 'Tecnica';
  // Finance / Administration
  if (/\b(admin|finan|buchhalt|hr\b|personal|verwaltung|controlling)/.test(combined)) return 'Amministrazione';
  // Ticket / Guest services
  if (/\b(ticket|gäste.*info|kasse|verkauf)/.test(combined)) return 'Commerciale';
  // Data / Digital
  if (/\b(data|digital|analy)/.test(combined)) return 'IT';

  return 'Turismo';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|supervisor|stellvertretend)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map TalentLink CONTRACTTYPLABEL to employmentType.
 * Known values: Festanstellung, Saisonanstellung, Kaderanstellung,
 *               Lehranstellung, Praktikumsanstellung
 */
export function mapContractType(label = '') {
  const l = normalize(label);
  if (l.includes('fest') || l.includes('kader')) return 'FULL_TIME';
  if (l.includes('saison')) return 'CONTRACTOR';
  if (l.includes('lehr') || l.includes('praktikum')) return 'INTERN';
  return 'OTHER';
}

/**
 * Parse pensum string like "80%-100%" into { min, max }.
 */
export function parsePensum(pensum = '') {
  const match = String(pensum || '').match(/(\d+)\s*%?\s*-\s*(\d+)\s*%?/);
  if (match) return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  const single = String(pensum || '').match(/(\d+)\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    return { min: v, max: v };
  }
  return { min: 100, max: 100 };
}

/* ── TalentLink API Client ────────────────────────────────── */

/**
 * Call the TalentLink REST API with proper auth headers.
 */
async function requestTalentLinkApi(url, body, readResponse) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        username: `${SITE_TECH_ID}:guest:FO`,
        password: 'guest',
        'lumesse-language': 'DE',
      },
      signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined,
    });
    return await readResponse(response);
  } finally {
    clearTimeout(timer);
  }
}

async function callTalentLinkApi(url, body = null) {
  return requestTalentLinkApi(url, body, async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status} from TalentLink API`);
    return response.json();
  });
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker() {
    while (!stopped && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function verifyTalentLinkJobAbsence(jobId) {
  const url = `${API_BASE}/${encodeURIComponent(jobId)}/details`;
  let response;
  let data;
  try {
    ({ response, data } = await requestTalentLinkApi(url, null, async (detailResponse) => ({
      response: detailResponse,
      data: await detailResponse.json(),
    })));
  } catch (error) {
    throw createIncompleteSnapshotError(
      `Weisse Arena could not verify whether TalentLink job ${jobId} still exists: ${error?.message || 'unknown detail error'}.`,
    );
  }

  if (
    response.status === 400
    && data !== null
    && typeof data === 'object'
    && !Array.isArray(data)
    && data.errorType === 'APPLICATION'
    && data.errorCode === 'Bad Request'
    && data.errorMsg === 'Stelle nicht gefunden'
  ) {
    return jobId;
  }

  if (response.status === 200 && response.ok) {
    const detailJobId = normalizeTalentLinkJobId(data?.jobFields?.id);
    if (detailJobId === jobId) {
      throw createIncompleteSnapshotError(
        `Weisse Arena listing omitted still-active TalentLink job ${jobId}; refusing to publish a partial snapshot.`,
      );
    }
    throw createIncompleteSnapshotError(
      `Weisse Arena detail response for job ${jobId} did not attest the same jobId; refusing to verify its absence.`,
    );
  }

  throw createIncompleteSnapshotError(
    `Weisse Arena detail response for job ${jobId} returned unrecognized status ${response.status}; refusing to verify its absence.`,
  );
}

async function verifyExistingJobsAgainstListingSnapshot(snapshot, existingJobs) {
  if (!Array.isArray(existingJobs) || existingJobs.length === 0) {
    return { baselineJobIds: [], currentJobIds: [], absenceVerifiedJobIds: [] };
  }

  const baselineJobIds = existingJobs.map(existingTalentLinkJobId);
  if (new Set(baselineJobIds).size !== baselineJobIds.length) {
    throw createIncompleteSnapshotError(
      'Weisse Arena existing slice contains duplicate TalentLink jobIds; refusing to verify a shrink.',
    );
  }

  const currentJobIds = snapshot.listings.map(listingTalentLinkJobId);
  if (new Set(currentJobIds).size !== currentJobIds.length) {
    throw createIncompleteSnapshotError(
      'Weisse Arena listing snapshot contains duplicate TalentLink jobIds; refusing to verify a shrink.',
    );
  }

  const currentJobIdSet = new Set(currentJobIds);
  const missingJobIds = baselineJobIds.filter((jobId) => !currentJobIdSet.has(jobId));
  const absenceVerifiedJobIds = await mapWithConcurrency(
    missingJobIds,
    DETAIL_ABSENCE_MAX_CONCURRENCY,
    verifyTalentLinkJobAbsence,
  );

  return { baselineJobIds, currentJobIds, absenceVerifiedJobIds };
}

/**
 * Fetch all job listings from the TalentLink API.
 * Uses the source-declared count as a minimum completeness boundary. TalentLink
 * can return either a stable total or a count of jobs remaining at the current
 * offset, and the count may be stale or short. Keep the largest count and
 * expand the boundary with every observed row; an empty page after that
 * boundary is required to prove the crawl is complete.
 */
async function fetchJobListingsOnce() {
  const allJobs = [];
  const seenListingIds = new Set();
  let minimumExpectedCount = null;
  let offset = 0;
  let pageCount = 0;
  let terminalOffset = null;
  let terminalJobsCount = null;
  let terminalJobsOmitted = false;

  while (true) {
    console.log(`  📄 Fetching jobs at offset ${offset}...`);
    const url = `${API_BASE}?firstResult=${offset}&maxResults=${PAGE_SIZE}&sortBy=DPOSTINGSTART&sortOrder=desc`;
    const data = await callTalentLinkApi(url, { searchCriteria: {} });
    pageCount += 1;

    const rawTotal = data?.globals?.jobsCount;
    const hasUsableRawTotal = (typeof rawTotal === 'number' && Number.isFinite(rawTotal))
      || (typeof rawTotal === 'string' && rawTotal.trim() !== '');
    const totalCount = hasUsableRawTotal
      ? Number(rawTotal)
      : Number.NaN;
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error(
        'Weisse Arena source response did not expose a valid globals.jobsCount; '
        + 'refusing an unverified partial crawl.',
      );
    }
    minimumExpectedCount = minimumExpectedCount === null
      ? totalCount
      : Math.max(minimumExpectedCount, totalCount);

    const hasJobsField = data !== null && typeof data === 'object'
      && Object.prototype.hasOwnProperty.call(data, 'jobs');
    let jobs;
    if (Array.isArray(data?.jobs)) {
      jobs = assertJsonListShape(data, {
        key: 'jobs',
        source: WEISSE_ARENA_KEY,
        rowShapeOk: (row) => row && typeof row === 'object' && !Array.isArray(row),
      });
    } else if (!hasJobsField && totalCount === 0 && allJobs.length === offset) {
      // TalentLink returns { globals: { jobsCount: 0 } } at the terminal offset
      // instead of an explicit jobs: [] array. Treat that shape as empty only
      // when the offset accounts for every row already collected and the
      // minimum completeness boundary has been reached.
      if (allJobs.length < minimumExpectedCount) {
        const error = new Error(
          `Weisse Arena pagination incomplete: fetched ${allJobs.length}/${minimumExpectedCount} `
            + 'minimum expected jobs before the terminal response omitted its jobs array.',
        );
        error.code = PAGINATION_INCOMPLETE_ERROR_CODE;
        throw error;
      }
      jobs = [];
    } else {
      const error = new Error('Weisse Arena source did not expose a jobs array with valid entries; refusing an unverified partial crawl.');
      error.code = INVALID_LISTING_ENVELOPE_ERROR_CODE;
      throw error;
    }

    if (jobs.length === 0) {
      if (allJobs.length < minimumExpectedCount) {
        const error = new Error(
          `Weisse Arena pagination incomplete: fetched ${allJobs.length}/${minimumExpectedCount} minimum expected jobs before an empty page.`,
        );
        error.code = PAGINATION_INCOMPLETE_ERROR_CODE;
        throw error;
      }
      terminalOffset = offset;
      terminalJobsCount = totalCount;
      terminalJobsOmitted = !hasJobsField;
      break;
    }

    for (const [index, listing] of jobs.entries()) {
      const fields = listing?.jobFields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new Error(
          `Weisse Arena listing row ${index + 1} at offset ${offset} has no jobFields object; refusing a partial crawl.`,
        );
      }

      const sourceJobNumber = firstNonEmptyValue(fields.jobNumber);
      const identity = firstNonEmptyValue(sourceJobNumber, fields.id, listing.id);
      if (!identity) {
        throw new Error(
          `Weisse Arena listing row ${index + 1} at offset ${offset} has no stable identity; refusing a partial crawl.`,
        );
      }
      if (seenListingIds.has(identity)) {
        throw new Error(
          `Weisse Arena pagination repeated listing ${identity} at offset ${offset}; refusing a partial crawl.`,
        );
      }
      seenListingIds.add(identity);

      const title = firstNonEmptyNormalized(fields.jobTitle, fields.sJobTitle);
      if (title.length < 3) {
        throw new Error(
          `Weisse Arena listing ${identity} at offset ${offset} has no usable job title; refusing a partial crawl.`,
        );
      }

      allJobs.push({ listing, identity, title, sourceJobNumber });
    }

    // The counter can lag behind the rows already returned. Observed rows are
    // authoritative evidence that the minimum boundary must expand.
    minimumExpectedCount = Math.max(minimumExpectedCount, allJobs.length);

    // firstResult is a record offset, not a page number. Advance by what the
    // source actually returned so a provider-side short page cannot skip the
    // records that follow it. Do not stop when the declared count is reached:
    // the source can under-report that count, and only an empty page after the
    // boundary proves that there are no more listings to read.
    offset += jobs.length;
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    listings: allJobs,
    sourceListingSnapshot: {
      source: WEISSE_ARENA_KEY,
      complete: true,
      pageCount,
      minimumExpectedCount,
      terminalOffset,
      terminalJobsCount,
      terminalJobsOmitted,
      listingCount: allJobs.length,
      listingIdentities: allJobs.map(({ identity }) => identity),
      listingJobNumbers: allJobs.map(({ sourceJobNumber }) => sourceJobNumber),
    },
  };
}

async function fetchJobListings({ existingJobs = [] } = {}) {
  const minimumExistingCount = Array.isArray(existingJobs) ? existingJobs.length : 0;
  let lastError;
  let lastListingCount = 0;

  for (let attempt = 1; attempt <= LISTING_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await fetchJobListingsOnce();
      lastListingCount = snapshot.listings.length;
      const absenceProof = await verifyExistingJobsAgainstListingSnapshot(snapshot, existingJobs);
      snapshot.sourceListingSnapshot = {
        ...snapshot.sourceListingSnapshot,
        ...absenceProof,
      };
      return snapshot;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_LISTING_SNAPSHOT_ERROR_CODES.has(error?.code)
        || attempt === LISTING_SNAPSHOT_MAX_ATTEMPTS) {
        if (error?.code === PAGINATION_INCOMPLETE_ERROR_CODE && attempt === LISTING_SNAPSHOT_MAX_ATTEMPTS) {
          throw createIncompleteSnapshotError(
            `Weisse Arena listing snapshot remained incomplete after ${LISTING_SNAPSHOT_MAX_ATTEMPTS} attempts: `
              + `fetched ${lastListingCount}/${minimumExistingCount} baseline jobs, or observed different identities; `
              + `${error.message} Refusing a partial crawl.`,
          );
        }
        throw error;
      }

      console.warn(
        `⚠️ Weisse Arena listing pagination was incomplete; `
          + `retrying attempt ${attempt + 1}/${LISTING_SNAPSHOT_MAX_ATTEMPTS}`,
      );
    }

    await new Promise((resolve) => {
      setTimeout(resolve, LISTING_SNAPSHOT_RETRY_DELAY_MS * attempt);
    });
  }

  throw lastError ?? new Error('Weisse Arena listing snapshot retry loop ended without a result');
}

function attachWeisseArenaListingMetadata(jobs, sourceListingSnapshot, processedIdentities, processedJobNumbers) {
  Object.defineProperties(jobs, {
    discoveredCount: {
      value: sourceListingSnapshot.listingCount,
      enumerable: false,
    },
    sourceListingSnapshot: {
      value: {
        ...sourceListingSnapshot,
        processedCount: jobs.length,
        processedIdentities,
        processedJobNumbers,
      },
      enumerable: false,
    },
  });
  return jobs;
}

/* ── Description Builder ──────────────────────────────────── */

/**
 * Build a plain-text description from TalentLink customFields.
 *
 * customFields is an array of { title, content } objects.
 * Titled sections (e.g. "Was du bewegst", "Was dich ausmacht") contain
 * the actual job responsibilities and requirements. Untitled sections
 * (title=" ") contain company intro and benefits boilerplate.
 */
function buildDescription(customFields = []) {
  const sections = [];

  for (const field of customFields) {
    const title = (field.title || '').trim();
    const content = normalizeSpace(stripHtml(field.content || ''));
    if (!content || content.length < 10) continue;

    if (title && title.length > 1) {
      sections.push(`${title}: ${content}`);
    } else {
      sections.push(content);
    }
  }

  return sections.join(' | ');
}

/**
 * Build the public detail URL for a job on weissearena.com.
 */
export function buildDetailUrl(jobId, jobTitle = '') {
  const params = new URLSearchParams({ jobId: String(jobId) });
  if (jobTitle) params.set('jobTitle', jobTitle);
  return `${DETAIL_BASE}?${params.toString()}`;
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Weisse Arena Gruppe jobs.
 * Returns the parsed source-locale jobs array. Complete listing metadata is
 * attached as non-enumerable array properties for the crawler template.
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllWeisseArenaJobs({ existingJobs = [] } = {}) {
  console.log(`🔍 Fetching Weisse Arena Gruppe jobs`);
  console.log(`   Source: ${DETAIL_BASE}\n`);

  const { listings, sourceListingSnapshot } = await fetchJobListings({ existingJobs });
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned from TalentLink API.');
    return attachWeisseArenaListingMetadata([], sourceListingSnapshot, [], []);
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const processedIdentities = [];
  const processedJobNumbers = [];

  for (const { listing, identity, title } of listings) {
    const fields = listing.jobFields || {};
    if (title.length < 3) {
      throw new Error('Weisse Arena listing reached the builder without a usable job title.');
    }

    const jobId = firstNonEmptyValue(fields.id, listing.id, identity);
    const department = normalizeSpace(fields.SLOVLIST10 || '');
    const pensumStr = fields.SLOVLIST17 || '100%';
    const contractLabel = fields.CONTRACTTYPLABEL || '';
    const jobNumber = firstNonEmptyValue(fields.jobNumber);
    const applicationUrl = fields.applicationUrl || '';

    // All Weisse Arena jobs are in Laax, GR
    const location = 'Laax';
    const canton = 'GR';
    const postalCode = '7031';

    // Build description from customFields
    const descriptionText = buildDescription(listing.customFields || []);

    // Public detail URL on weissearena.com
    const publicUrl = buildDetailUrl(jobId, title);

    // ID: use the validated listing identity for stability (e.g. "WAG02350").
    const idSource = identity;
    const urlHash = createHash('sha1').update(idSource).digest('hex').slice(0, 12);

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} weisse-arena ch`);

    // Parse pensum for contract type inference
    const pensum = parsePensum(pensumStr);
    const employmentType = mapContractType(contractLabel);
    const contract = pensum.max < 80 ? 'part-time' : 'full-time';

    // DPOSTINGSTART has no corroborated publication mapping for this endpoint.
    // Neither that generic start value nor the crawl clock establishes a date.
    const description = descriptionText || `${title} — Weisse Arena Gruppe, ${department}`;

    const job = {
      // ── Required fields ──
      id: `weisse-arena-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: WEISSE_ARENA_COMPANY_NAME,
      companyKey: WEISSE_ARENA_KEY,
      companyDomain: WEISSE_ARENA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Weisse Arena Gruppe Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Turismo / Sport',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(''),
      applyUrl: applicationUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (department) job.department = department;
    if (jobNumber) job.jobNumber = jobNumber;
    if (pensum.min !== pensum.max) {
      job.pensum = `${pensum.min} - ${pensum.max}%`;
    } else {
      job.pensum = `${pensum.min}%`;
    }
    if (contractLabel) job.contractLabel = contractLabel;

    jobs.push(job);
    processedIdentities.push(identity);
    processedJobNumbers.push(jobNumber);
    console.log(`  ✅ ${title.substring(0, 55)} — ${department} (${pensumStr})`);
  }

  if (
    jobs.length !== listings.length
    || sourceListingSnapshot.listingCount !== listings.length
    || processedIdentities.length !== sourceListingSnapshot.listingIdentities.length
    || processedJobNumbers.length !== sourceListingSnapshot.listingJobNumbers.length
    || processedIdentities.some((identity, index) => identity !== sourceListingSnapshot.listingIdentities[index])
    || processedJobNumbers.some((jobNumber, index) => jobNumber !== sourceListingSnapshot.listingJobNumbers[index])
  ) {
    throw new Error('Weisse Arena source listing snapshot did not process every unique API record; refusing to attest a complete crawl.');
  }

  console.log(`\n📋 Total Weisse Arena Gruppe jobs discovered: ${jobs.length}`);
  return attachWeisseArenaListingMetadata(
    jobs,
    sourceListingSnapshot,
    processedIdentities,
    processedJobNumbers,
  );
}
