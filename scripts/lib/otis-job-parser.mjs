/**
 * Otis SA — Workday API job parser
 *
 * Otis is a global elevator and escalator manufacturing company.
 * Their Swiss operations include positions across Switzerland.
 *
 * Workday API endpoints:
 *   Listing: POST https://otis.wd5.myworkdayjobs.com/wday/cxs/otis/REC_Ext_Gateway/jobs
 *            Body: {"appliedFacets":{},"limit":20,"offset":0,"searchText":"Switzerland"}
 *   Detail:  GET  https://otis.wd5.myworkdayjobs.com/wday/cxs/otis/REC_Ext_Gateway{externalPath}
 *
 * Public URL base:
 *   https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway{externalPath}
 *
 * The listing endpoint uses searchText to filter by country (facet IDs cause 400 errors).
 * Response locationsText format: "Walenbüchelstrasse 3, 9000 St-Gallen, Switzerland"
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('otis');

export const WORKDAY_API_BASE = 'https://otis.wd5.myworkdayjobs.com/wday/cxs/otis/REC_Ext_Gateway';
export const WORKDAY_PUBLIC_BASE = 'https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway';
export const COMPANY_HOST = 'otis.wd5.myworkdayjobs.com';

/**
 * Known Ticino location keywords for filtering.
 */
export const TICINO_LOCATION_KEYWORDS = [
  'lugano', 'ticino', 'manno', 'bellinzona', 'locarno',
  'mendrisio', 'chiasso', 'sorengo', 'agno', 'bioggio',
  'rivera', 'lamone', 'grancia', 'muzzano', 'paradiso',
  'switzerland', 'svizzera', 'suisse', 'schweiz',
  'st-gallen', 'st. gallen', 'zürich', 'zurich', 'bern', 'basel', 'geneva', 'genève',
  'lausanne', 'winterthur', 'luzern', 'lucerne',
];

const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

export function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/**
 * Check if a Workday location string refers to Switzerland/Ticino.
 */
export function isSwissLocation(locationText = '') {
  if (isTargetSwissLocation(locationText)) return true;
  const lower = String(locationText || '').toLowerCase();
  if (/\b(swiss|switzerland|schweiz|svizzera|suisse)\b/i.test(lower)) return true;
  return inferAnyCanton(lower) !== '';
}

/**
 * Parse city name from Workday location text.
 * Real format: "Walenbüchelstrasse 3, 9000 St-Gallen, Switzerland"
 * Also handles: "CHE - Lugano", "Ticino, Switzerland", plain "Switzerland"
 */
export function parseWorkdayCity(locText = '') {
  const cleaned = String(locText || '').trim();
  if (!cleaned) return '';

  // Format: "Street, PostalCode City, Country" — extract "City" from the middle segment
  const commaParts = cleaned.split(',').map((s) => s.trim());
  if (commaParts.length >= 3) {
    // Middle part is typically "9000 St-Gallen" — strip postal code
    const middle = commaParts[commaParts.length - 2];
    const cityFromMiddle = middle.replace(/^\d{4,5}\s+/, '').trim();
    if (cityFromMiddle && !/^switzerland|svizzera|suisse|schweiz$/i.test(cityFromMiddle)) {
      return cityFromMiddle;
    }
  }

  // Format: "City, Country"
  if (commaParts.length === 2) {
    const candidate = commaParts[0].replace(/^\d{4,5}\s+/, '').trim();
    if (candidate && !/^switzerland|svizzera|suisse|schweiz$/i.test(candidate)) {
      return candidate;
    }
  }

  // Format: "CHE - City"
  const dashParts = cleaned.split(/\s*-\s*/);
  if (dashParts.length > 1) {
    const city = dashParts.slice(1).join('-').trim();
    return city.replace(/,\s*(?:switzerland|svizzera|suisse|schweiz)$/i, '').trim() || cleaned;
  }

  return cleaned.replace(/,\s*(?:switzerland|svizzera|suisse|schweiz)$/i, '').trim() || cleaned;
}

/**
 * Build a public URL for an Otis Workday job posting.
 */
export function buildPublicUrl(externalPath = '') {
  return `${WORKDAY_PUBLIC_BASE}${externalPath}`;
}

/**
 * Infer employment type from Workday time type or title/description.
 * Workday uses "Full time", "Part time" in the timeType field.
 */
export function inferEmploymentType(title = '', description = '', timeType = '') {
  const tt = String(timeType || '').trim().toLowerCase();
  if (tt === 'part time') return 'PART_TIME';
  if (tt === 'full time') return 'FULL_TIME';

  const combined = `${title} ${timeType} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Parse job listings from the Workday API JSON response.
 * Filters to Swiss positions based on locationsText containing "Switzerland".
 *
 * Real response format:
 * { title, externalPath, locationsText, postedOn, remoteType, bulletFields: [location, jobReqId] }
 *
 * @param {object} apiResponse - Parsed JSON from the Workday listing endpoint
 * @returns {Array<{title: string, externalPath: string, location: string, city: string, bulletFields: string[], postedOn: string, jobId: string}>}
 */
export function parseOtisWorkdayListings(apiResponse) {
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

    // Filter for Swiss locations
    if (!isSwissLocation(locationsText)) continue;

    // Extract jobId from bulletFields (typically last element) or externalPath
    const bulletFields = posting.bulletFields || [];
    let jobId = '';
    for (const field of bulletFields) {
      if (/^\d{5,}$/.test(String(field).trim())) {
        jobId = String(field).trim();
        break;
      }
    }
    if (!jobId) {
      const pathMatch = externalPath.match(/_(\d{5,})$/);
      if (pathMatch) jobId = pathMatch[1];
    }

    results.push({
      title,
      externalPath,
      location: locationsText,
      city: parseWorkdayCity(locationsText),
      bulletFields,
      postedOn: posting.postedOn || '',
      jobId,
    });
  }

  return results;
}

/**
 * Parse a single Workday job detail response.
 *
 * @param {object} detail - Parsed JSON from Workday job detail endpoint
 * @param {string} externalPath - The external path of the job
 * @returns {object|null} Job detail or null if invalid
 */
export function parseOtisWorkdayDetail(detail, externalPath = '') {
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
    city: city || 'Ticino',
    canton: HQ.canton,
    employmentType: inferEmploymentType(title, descriptionText, timeType),
    datePosted: startDate,
    jobReqId,
    externalPath,
  };
}

/**
 * Fetch all Swiss job listings from the Otis Workday API.
 * Uses searchText:"Switzerland" instead of facet IDs (which cause HTTP 400).
 */
export async function fetchOtisJobUrls(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const allJobs = [];
    let offset = 0;
    const limit = 20;
    let hasMore = true;

    while (hasMore) {
      const res = await fetch(`${WORKDAY_API_BASE}/jobs`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': UA,
        },
        body: JSON.stringify({
          appliedFacets: {},
          limit,
          offset,
          searchText: 'Switzerland',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const listings = parseOtisWorkdayListings(data);
      allJobs.push(...listings);

      const total = data.total || 0;
      offset += limit;
      hasMore = offset < total && listings.length > 0;
    }

    clearTimeout(timer);
    return allJobs;
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Otis Workday listings: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Otis Workday job detail page.
 * Detail URL: GET {WORKDAY_API_BASE}{externalPath}
 * (externalPath already starts with /job/...)
 */
export async function fetchOtisDetailPage(externalPath, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKDAY_API_BASE}${externalPath}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseOtisWorkdayDetail(data, externalPath);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
