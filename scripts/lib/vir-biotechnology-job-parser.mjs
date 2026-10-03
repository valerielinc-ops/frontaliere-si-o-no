/**
 * Vir Biotechnology (Humabs BioMed) — Greenhouse API job parser
 *
 * Vir Biotechnology acquired Humabs BioMed SA, which has Swiss R&D operations
 * including Bellinzona, Canton Ticino. Vir uses Greenhouse as their ATS.
 *
 * Greenhouse API endpoint:
 *   https://boards-api.greenhouse.io/v1/boards/virbiotechnologyinc/jobs?content=true
 *
 * The API returns all jobs globally. We filter for positions in Switzerland.
 */

import { isSwissLocationText, inferAnyCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { dropFabricatedLocaleText, sourceLocaleDescription } from './source-locale-description.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { isConnectionLevelFetchError, WAF_IP_BLOCK_STATUS } from './transient-fetch.mjs';
import { CRAWLER_FETCH_FAILURE_OUTCOMES } from './crawler-fetch-outcome.mjs';

const HQ = getCompanyDefaults('vir-biotechnology');

export const GREENHOUSE_BOARD = 'virbiotechnologyinc';
export const GREENHOUSE_API = `https://boards-api.greenhouse.io/v1/boards/${GREENHOUSE_BOARD}/jobs?content=true`;

export const SWISS_LOCATION_KEYWORDS = [
  'bellinzona', 'switzerland', 'swiss', 'ticino', 'lugano',
  'manno', 'zurich', 'zürich', 'basel', 'bern', 'geneva', 'genève',
];

/**
 * Normalize whitespace in a string.
 */
export function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode common entities.
 */
export function htmlToText(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Slugify a text string.
 */
export function slugify(value = '', suffix = '') {
  let s = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return truncateSlugAtWordBoundary(s, 200);
}

/**
 * Check if a Greenhouse job location matches Switzerland.
 */
export function isSwissLocation(locationName = '') {
  return isSwissLocationText(locationName);
}

/**
 * Infer canton from a Greenhouse location string.
 */
export function inferCanton(location = '') {
  return inferAnyCanton(location) || '';
}

/**
 * Parse city name from Greenhouse location string.
 * Example: "Bellinzona, Switzerland" → "Bellinzona"
 */
export function parseCity(location = '') {
  const parts = String(location || '').split(',').map((s) => s.trim());
  // Typically: "City, State/Country" or "City, State, Country"
  return parts[0] || '';
}

/**
 * Parse jobs from the Greenhouse API JSON response.
 * Filters to Swiss locations only.
 *
 * @param {object} apiResponse - Parsed JSON from Greenhouse API
 * @returns {Array<{title: string, description: string, url: string, location: string, city: string, canton: string, department: string, datePosted: string, greenhouseId: number}>}
 */
export function parseGreenhouseJobs(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.jobs)) return [];

  const results = [];
  const seen = new Set();

  for (const job of apiResponse.jobs) {
    if (!job.title || !job.id) continue;

    // Check if any office/location is in Switzerland
    const offices = Array.isArray(job.offices) ? job.offices : [];
    const locationObj = job.location || {};
    const locationName = locationObj.name || '';

    const allLocations = [
      locationName,
      ...offices.map((o) => o.name || ''),
    ];

    const swissLocation = allLocations.find((loc) => isSwissLocation(loc));
    if (!swissLocation) continue;

    // Deduplicate
    if (seen.has(job.id)) continue;
    seen.add(job.id);

    const title = normalizeSpace(job.title);
    const descriptionHtml = job.content || '';
    const description = normalizeSpace(htmlToText(descriptionHtml));
    const url = job.absolute_url || '';
    const city = parseCity(swissLocation);
    const canton = inferCanton(swissLocation);

    const departments = (job.departments || []).map((d) => d.name || '').filter(Boolean);
    const department = departments.join(', ') || '';

    const datePosted = job.first_published
      ? job.first_published.split('T')[0]
      : job.updated_at
        ? job.updated_at.split('T')[0]
        : new Date().toISOString().split('T')[0];

    results.push({
      title,
      description,
      url,
      location: swissLocation,
      city: city || 'Bellinzona',
      canton: canton || HQ.canton,
      department,
      datePosted,
      greenhouseId: job.id,
    });
  }

  return results;
}

function hasGreenhouseIdentity(job = {}) {
  return Boolean(job?.title && job?.id);
}

function hasGreenhouseLocationPayload(job = {}) {
  const locationName = normalizeSpace(job?.location?.name || '');
  const officeNames = Array.isArray(job?.offices)
    ? job.offices.map((office) => normalizeSpace(office?.name || '')).filter(Boolean)
    : [];
  return Boolean(locationName || officeNames.length > 0);
}

/**
 * Classify a successful Greenhouse response before the runner decides whether
 * it may keep the existing slice. A non-empty feed with valid location data
 * but no Swiss matches is a real, observed filtered-empty run; a feed whose
 * records lost their identity/location fields is parser drift and must stay
 * fail-closed.
 */
export function classifyGreenhouseResponse(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.jobs)) {
    return {
      jobs: [],
      discovered: 0,
      parsed: 0,
      lastFetchOutcome: 'selector_miss',
      abortKind: 'no-jobs-parsed',
    };
  }

  const sourceJobs = apiResponse.jobs;
  const malformedSource = sourceJobs.some(
    (job) => !hasGreenhouseIdentity(job) || !hasGreenhouseLocationPayload(job),
  );
  if (sourceJobs.length > 0 && malformedSource) {
    return {
      jobs: [],
      discovered: sourceJobs.length,
      parsed: 0,
      lastFetchOutcome: 'selector_miss',
      abortKind: 'no-jobs-parsed',
    };
  }

  const jobs = parseGreenhouseJobs(apiResponse);
  return {
    jobs,
    discovered: sourceJobs.length,
    parsed: jobs.length,
    lastFetchOutcome: jobs.length > 0
      ? 'ok'
      : sourceJobs.length > 0
        ? 'filtered_empty'
        : 'ok',
    abortKind: null,
  };
}

/** Classify a fetch/schema failure without turning it into a healthy zero. */
export function classifyGreenhouseFetchError(error) {
  const status = Number(error?.status);
  const lastFetchOutcome = WAF_IP_BLOCK_STATUS.has(status)
    ? 'anti_bot_block'
    : isConnectionLevelFetchError(error)
      ? 'connection_error'
      : 'feed_endpoint_unavailable';
  return {
    lastFetchOutcome,
    abortKind: CRAWLER_FETCH_FAILURE_OUTCOMES.has(lastFetchOutcome)
      && lastFetchOutcome !== 'feed_endpoint_unavailable'
      ? 'connection-level-fetch'
      : 'no-jobs-parsed',
  };
}

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 * @param {string} title
 * @param {string} description
 * @param {string} percentage
 * @returns {string} FULL_TIME or PART_TIME
 */
export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Description fields of a Greenhouse posting: the posting's own text keyed by
 * its language. The runner used to add an Italian company blurb of its own
 * to `descriptionByLocale.it` of every job ("Posizione aperta presso Vir
 * Biotechnology (Humabs BioMed) a …"), the same fabricated-locale defect
 * corrected in mikron, bracco, fnz, ist and capri-holdings. Under the shared
 * word floor (50 words) nothing is emitted: the merge keeps the stored source
 * body, or the job is not published this run.
 *
 * @param {{ title: string, city: string, description?: string }} parsed
 */
export function buildVirDescriptionFields(parsed = {}) {
  // Only the posting's own text over the shared word floor: nothing under it
  // (the merge keeps the stored source body, or omits the job this run).
  return sourceLocaleDescription(meetsSourceBodyFloor(parsed.description) ? parsed.description : '');
}

// Fossil of the removed Italian builder in stored jobs (see source-locale-description.mjs).
const VIR_IT_BLURB_RE = /^Posizione aperta presso Vir Biotechnology \(Humabs BioMed\)[\s\S]*azienda biotecnologica globale/;

/** Remove the fabricated Italian blurb of the former builder from a stored job. */
export function dropVirFabricatedText(job) {
  return dropFabricatedLocaleText(job, 'it', VIR_IT_BLURB_RE);
}
