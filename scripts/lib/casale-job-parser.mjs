/**
 * Casale SA — Recruitee API parser
 *
 * Casale SA uses Recruitee (like Boggi Milano).
 * API endpoint: https://casale.recruitee.com/api/offers
 * Careers page: https://recruit.casale.ch/
 *
 * Each offer includes: id, slug, title, description (HTML),
 * locations[] with city/state/country/country_code,
 * employment_type_code, department, published_at, etc.
 *
 * Detail URLs follow: https://recruit.casale.ch/o/{slug}
 */

import { JSDOM } from 'jsdom';

const CASALE_RECRUITEE_DOMAIN = 'casale.recruitee.com';
const CASALE_CAREERS_DOMAIN = 'recruit.casale.ch';
const DETAIL_URL_BASE = `https://${CASALE_CAREERS_DOMAIN}/o`;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slugify(value = '', suffix = '') {
  let s = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return s.slice(0, 180);
}

/** Minimum description length to consider a description "full". */
export const MIN_DESC_LENGTH = 200;

/**
 * Combine all description sections from a Recruitee API offer.
 */
export function combineDescriptionSections(offer = {}) {
  const parts = [];
  const fields = ['description', 'requirements', 'education', 'experience'];
  for (const field of fields) {
    const html = String(offer[field] || '').trim();
    if (html) parts.push(html);
  }
  return parts.join('\n');
}

/**
 * Check if a Recruitee offer is located in Switzerland (Ticino focus).
 */
export function isCasaleSwissOffer(offer = {}) {
  // Check top-level country_code
  if (offer.country_code === 'CH') return true;

  // Check each location entry
  const locations = offer.locations || [];
  for (const loc of locations) {
    if (loc.country_code === 'CH') return true;
    const combined = [loc.city, loc.state, loc.country].filter(Boolean).join(' ').toLowerCase();
    if (/switzerland|svizzera|schweiz|suisse|ticino|lugano|mendrisio|bellinzona/i.test(combined)) return true;
  }

  // Check combined location string
  const locStr = (offer.location || '').toLowerCase();
  if (/switzerland|svizzera|schweiz|suisse|ticino|lugano/i.test(locStr)) return true;

  return false;
}

/**
 * Parse the Recruitee API JSON response and filter to Swiss jobs.
 * @param {object} apiResponse - Raw JSON from /api/offers
 * @returns {Array<object>} Filtered offer objects
 */
export function parseApiResponse(apiResponse = {}) {
  const offers = apiResponse?.offers || [];
  return offers.filter(isCasaleSwissOffer);
}

/**
 * Transform a Recruitee API offer into a standard job object.
 */
export function buildJobFromApi(offer = {}) {
  const title = normalizeSpace(offer.title || '');
  const descHtml = combineDescriptionSections(offer);
  const description = stripHtml(descHtml);

  // Build location from first Swiss location
  const swissLoc = (offer.locations || []).find((l) => l.country_code === 'CH') || offer.locations?.[0] || {};
  const city = normalizeSpace(swissLoc.city || 'Lugano');
  const state = normalizeSpace(swissLoc.state || 'Ticino');
  const locationStr = city && state ? `${city}, ${state}` : city || 'Lugano';

  // Employment type mapping
  const empMap = {
    fulltime_permanent: 'FULL_TIME',
    fulltime_fixed_term: 'FULL_TIME',
    parttime: 'PART_TIME',
    internship: 'INTERNSHIP',
    freelance: 'FREELANCE',
  };
  const employmentType = empMap[offer.employment_type_code] || 'FULL_TIME';

  // Work model
  let workModel = 'on-site';
  if (offer.remote) workModel = 'remote';
  else if (offer.hybrid) workModel = 'hybrid';

  const datePosted = offer.published_at
    ? String(offer.published_at).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  return {
    title,
    city,
    state,
    location: locationStr,
    description,
    descriptionHtml: descHtml,
    slug: offer.slug || '',
    offerId: offer.id || '',
    detailUrl: `${DETAIL_URL_BASE}/${offer.slug}`,
    applyUrl: offer.careers_apply_url || `${DETAIL_URL_BASE}/${offer.slug}`,
    department: offer.department || '',
    employmentType,
    workModel,
    datePosted,
  };
}

/**
 * Parse the listing page HTML (fallback if API is unavailable).
 * The Recruitee hosted page lists jobs with links to /o/{slug}.
 */
export function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  const links = document.querySelectorAll('a[href*="/o/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const slugMatch = href.match(/\/o\/([^/?#]+)/);
    if (!slugMatch) continue;
    const slug = slugMatch[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const title = normalizeSpace(link.textContent || '');
    if (!title || title.length < 3) continue;

    const absoluteUrl = href.startsWith('http')
      ? href
      : `https://${CASALE_CAREERS_DOMAIN}${href}`;

    jobs.push({ title, url: absoluteUrl, slug });
  }

  return jobs;
}

/**
 * Detect job category from title.
 */
export function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/engineer|mechanical|electrical|civil|chemical|process/i.test(t)) return 'engineering';
  if (/project\s*(manag|coord)/i.test(t)) return 'project-management';
  if (/designer|visual|cad/i.test(t)) return 'design';
  if (/it\b|software|developer|data/i.test(t)) return 'technology';
  if (/sales|commercial|proposal/i.test(t)) return 'sales';
  if (/quality|qa|hse|safety/i.test(t)) return 'quality';
  if (/purchas|procurement|expedit|logistic|supply/i.test(t)) return 'logistics';
  if (/financ|account|controller/i.test(t)) return 'finance';
  if (/hr|human|recruit/i.test(t)) return 'hr';
  if (/intern|apprenti|stage|laborant/i.test(t)) return 'internship';
  if (/inspector|technolog/i.test(t)) return 'quality';
  return 'engineering';
}

/**
 * Detect experience level from title.
 */
export function detectExperienceLevel(title = '') {
  if (/intern|apprenti|jr\.?|junior|entry|stage/i.test(title)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal/i.test(title)) return 'SENIOR';
  return 'MID';
}
