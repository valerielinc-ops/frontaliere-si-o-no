/**
 * Julius Baer — Workday API job parser
 *
 * Julius Baer is a Swiss private banking group headquartered in Zurich,
 * with a significant presence in Lugano, Canton Ticino.
 *
 * Workday API endpoints:
 *   Listing: POST https://juliusbaer.wd3.myworkdayjobs.com/wday/cxs/juliusbaer/External/jobs
 *   Detail:  GET  https://juliusbaer.wd3.myworkdayjobs.com/wday/cxs/juliusbaer/External/job/{externalPath}
 *
 * Public URL base:
 *   https://juliusbaer.wd3.myworkdayjobs.com/en-US/External/job/{externalPath}
 *
 * NOTE: The Workday site name changed from "JuliusBaer" to "External" (discovered 2026-03-25).
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('julius-baer');

export const WORKDAY_API_BASE = 'https://juliusbaer.wd3.myworkdayjobs.com/wday/cxs/juliusbaer/External';
export const WORKDAY_PUBLIC_BASE = 'https://juliusbaer.wd3.myworkdayjobs.com/en-US/External';
export const COMPANY_HOST = 'juliusbaer.wd3.myworkdayjobs.com';

/**
 * Known Lugano/Ticino location keywords for filtering.
 */
export const TICINO_LOCATION_KEYWORDS = [
  'lugano', 'ticino', 'manno', 'bellinzona', 'locarno',
  'mendrisio', 'chiasso', 'sorengo', 'agno',
];

/**
 * Normalize whitespace.
 */
export function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode entities.
 */
export function stripHtml(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
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
  return s.slice(0, 90);
}

/**
 * Check if a Workday location string refers to any target Swiss canton.
 */
export function isSwissLocation(locationText = '') {
  return isTargetSwissLocation(locationText);
}

/** @deprecated Misleading legacy name; alias of isSwissLocation. Keep until callers are migrated. */
export const isTicinoLocation = isSwissLocation;

/**
 * Parse city name from Workday location text.
 * Workday format: "CHE - Lugano" or "Lugano, Switzerland"
 */
export function parseWorkdayCity(locText = '') {
  const cleaned = String(locText || '').trim();
  const parts = cleaned.split(/\s*-\s*/);
  const city = parts.length > 1 ? parts.slice(1).join('-').trim() : cleaned;
  return city.replace(/,\s*switzerland$/i, '').trim() || cleaned;
}

/**
 * Build a public URL for a Workday job posting.
 */
export function buildPublicUrl(externalPath = '') {
  return `${WORKDAY_PUBLIC_BASE}${externalPath}`;
}

/**
 * Detect job category from title.
 */
export function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/engineer|developer|software|it\b|system|data|devops|cyber|network|architect/i.test(t)) return 'technology';
  if (/analyst|quantitative|risk|compliance|regulat/i.test(t)) return 'risk';
  if (/relationship\s*manager|client\s*advisor|wealth|private\s*bank/i.test(t)) return 'wealth-management';
  if (/sales|commercial|marketing|brand|communication/i.test(t)) return 'sales';
  if (/legal|counsel|lawyer/i.test(t)) return 'legal';
  if (/account|financ|controller|audit|treasury|tax/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/operations|middle\s*office|back\s*office|settlement/i.test(t)) return 'operations';
  if (/manag|director|head|lead|chief|vp\b/i.test(t)) return 'management';
  if (/assistant|admin|secretary|reception/i.test(t)) return 'admin';
  return 'general';
}

/**
 * Detect experience level from title.
 */
export function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/junior|jr\.?|entry|intern|stage|apprenti|trainee|graduate/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b|managing/i.test(t)) return 'SENIOR';
  return 'MID';
}

/**
 * Detect employment type from Workday time type.
 */
export function detectEmploymentType(timeType = '') {
  const t = String(timeType || '').toLowerCase();
  if (t.includes('full')) return 'FULL_TIME';
  if (t.includes('part')) return 'PART_TIME';
  return 'FULL_TIME';
}

/**
 * Parse job listings from the Workday API JSON response.
 * Filters to Ticino/Lugano positions only.
 *
 * @param {object} apiResponse - Parsed JSON from the Workday listing endpoint
 * @returns {Array<{title: string, externalPath: string, location: string, city: string, bulletFields: string[]}>}
 */
export function parseWorkdayListings(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.jobPostings)) return [];

  const results = [];
  const seen = new Set();

  for (const posting of apiResponse.jobPostings) {
    const title = normalizeSpace(posting.title || '');
    const externalPath = posting.externalPath || '';
    const locationsText = posting.locationsText || '';

    if (!title || !externalPath) continue;
    if (seen.has(externalPath)) continue;
    seen.add(externalPath);

    // Filter for Ticino/Lugano
    if (!isSwissLocation(locationsText)) continue;

    results.push({
      title,
      externalPath,
      location: locationsText,
      city: parseWorkdayCity(locationsText),
      bulletFields: posting.bulletFields || [],
    });
  }

  return results;
}

/**
 * Parse a single Workday job detail response into a job object.
 *
 * @param {object} detail - Parsed JSON from Workday job detail endpoint
 * @param {string} externalPath - The external path of the job
 * @returns {object|null} Job object or null if invalid
 */
export function parseWorkdayJobDetail(detail, externalPath = '') {
  if (!detail) return null;

  const info = detail.jobPostingInfo || {};
  const title = normalizeSpace(info.title || '');
  if (!title || title.length < 3) return null;

  const locationRaw = info.location || '';
  const city = parseWorkdayCity(locationRaw);
  const descriptionHtml = info.jobDescription || '';
  const descriptionText = stripHtml(descriptionHtml);
  const publicUrl = buildPublicUrl(externalPath);
  const timeType = info.timeType || '';
  const jobReqId = info.jobReqId || '';
  const startDate = info.startDate || new Date().toISOString().split('T')[0];

  return {
    title,
    description: descriptionText,
    url: publicUrl,
    city: city || 'Lugano',
    canton: HQ.canton,
    employmentType: detectEmploymentType(timeType),
    category: detectCategory(title),
    experienceLevel: detectExperienceLevel(title),
    datePosted: startDate,
    jobReqId,
    externalPath,
  };
}
