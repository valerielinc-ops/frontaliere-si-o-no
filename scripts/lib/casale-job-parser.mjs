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

/**
 * Convert HTML to Markdown, preserving headings, lists, bold, and paragraphs.
 * Used for job descriptions from Recruitee API which provide rich HTML.
 */
export function htmlToMarkdown(html = '') {
  if (!html || !String(html).trim()) return '';

  let md = String(html)
    // Remove script/style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Headings → ## Heading
    .replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      return text ? `\n\n## ${text}\n\n` : '';
    })
    // <h4>, <h5>, <h6> → ## (same level, keep it simple)
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      return text ? `\n\n## ${text}\n\n` : '';
    })
    // Bold/strong → **text**
    .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      return text ? `**${text}**` : '';
    })
    // List items → - item
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      return text ? `\n- ${text}` : '';
    })
    // Remove list wrappers
    .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n')
    // Paragraphs and divs → double newline
    .replace(/<\/(?:p|div)>/gi, '\n\n')
    .replace(/<(?:p|div)[^>]*>/gi, '')
    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Normalize whitespace
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?=\n)/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return md;
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
 * Patterns that match generic/placeholder offers from Recruitee.
 * These are not real job postings — they are "work with us" or
 * spontaneous application placeholders. Patterns match the phrase
 * anywhere in the title (to tolerate punctuation, suffixes like
 * "- Neolaureati", and leading qualifiers).
 */
const GENERIC_OFFER_PATTERNS = [
  /\bwork\s+with\s+us\b/i,
  /\bjoin\s+(?:our\s+)?team\b/i,
  /\bspontaneous\s+application\b/i,
  /\bopen\s+application\b/i,
  /\bcandidatura\s+spontanea\b/i,
  /\bcandidature\s+spontan[eé]es?\b/i,
  /\bpostuler\s+spontan[eé]ment\b/i,
  /\binitiativbewerbung\b/i,
  /\boffene\s+bewerbung\b/i,
  /\bneolaureat[io]\b/i,
];

/**
 * Slug fragments that indicate a placeholder/pipeline posting,
 * independent of how the title is displayed.
 */
const GENERIC_SLUG_PATTERNS = [
  /candidatura-spontanea/i,
  /spontaneous-application/i,
  /open-application/i,
  /work-with-us/i,
  /join-(?:our-)?team/i,
  /initiativbewerbung/i,
  /offene-bewerbung/i,
  /candidature-spontan/i,
  /neolaureat[io]/i,
  /talent-pool/i,
];

/**
 * Returns true if the offer title matches a generic/placeholder pattern
 * (e.g. "Work with us!", "Candidatura Spontanea - Neolaureati") or the
 * Recruitee slug marks it as a pipeline/open-application posting.
 */
export function isGenericOffer(offer = {}) {
  const title = String(offer.title || '').trim();
  if (title.length < 5) return true;
  if (GENERIC_OFFER_PATTERNS.some((re) => re.test(title))) return true;
  const slug = String(offer.slug || '').trim();
  if (slug && GENERIC_SLUG_PATTERNS.some((re) => re.test(slug))) return true;
  return false;
}

/**
 * Parse the Recruitee API JSON response and filter to Swiss jobs.
 * Excludes generic/placeholder offers (e.g. "Work with us").
 * @param {object} apiResponse - Raw JSON from /api/offers
 * @returns {Array<object>} Filtered offer objects
 */
export function parseApiResponse(apiResponse = {}) {
  const offers = apiResponse?.offers || [];
  return offers.filter((o) => isCasaleSwissOffer(o) && !isGenericOffer(o));
}

/**
 * Transform a Recruitee API offer into a standard job object.
 */
export function buildJobFromApi(offer = {}) {
  const title = normalizeSpace(offer.title || '');
  const descHtml = combineDescriptionSections(offer);
  const description = htmlToMarkdown(descHtml);

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
