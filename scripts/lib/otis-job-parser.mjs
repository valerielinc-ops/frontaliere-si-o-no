/**
 * Otis SA — Workday API job parser
 *
 * Otis is a global elevator and escalator manufacturing company.
 * Their Swiss operations include positions in Canton Ticino.
 *
 * Workday API endpoints:
 *   Listing: POST https://otis.wd5.myworkdayjobs.com/wday/cxs/otis/REC_Ext_Gateway/jobs
 *   Detail:  GET  https://otis.wd5.myworkdayjobs.com/wday/cxs/otis/REC_Ext_Gateway/job/{externalPath}
 *
 * Public URL base:
 *   https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway/job/{externalPath}
 *
 * The listing endpoint accepts a POST body with optional facets for country filtering.
 * Switzerland country facet ID: f2e609fe77da01661cd2407e01746e08
 */

export const WORKDAY_API_BASE = 'https://otis.wd5.myworkdayjobs.com/wday/cxs/otis/REC_Ext_Gateway';
export const WORKDAY_PUBLIC_BASE = 'https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway';
export const COMPANY_HOST = 'otis.wd5.myworkdayjobs.com';
export const SWISS_COUNTRY_FACET = 'f2e609fe77da01661cd2407e01746e08';

/**
 * Known Ticino location keywords for filtering.
 */
export const TICINO_LOCATION_KEYWORDS = [
  'lugano', 'ticino', 'manno', 'bellinzona', 'locarno',
  'mendrisio', 'chiasso', 'sorengo', 'agno', 'bioggio',
  'rivera', 'lamone', 'grancia', 'muzzano', 'paradiso',
  'switzerland', 'svizzera', 'suisse', 'schweiz',
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
  const loc = String(locationText || '').toLowerCase();
  return TICINO_LOCATION_KEYWORDS.some((kw) => loc.includes(kw));
}

/**
 * Parse city name from Workday location text.
 * Workday format: "CHE - Lugano" or "Ticino, Switzerland"
 */
export function parseWorkdayCity(locText = '') {
  const cleaned = String(locText || '').trim();
  const parts = cleaned.split(/\s*-\s*/);
  const city = parts.length > 1 ? parts.slice(1).join('-').trim() : cleaned;
  return city.replace(/,\s*(?:switzerland|svizzera|suisse|schweiz)$/i, '').trim() || cleaned;
}

/**
 * Build a public URL for an Otis Workday job posting.
 */
export function buildPublicUrl(externalPath = '') {
  return `${WORKDAY_PUBLIC_BASE}${externalPath}`;
}

/**
 * Infer employment type from Workday time type or title/description.
 */
export function inferEmploymentType(title = '', description = '', timeType = '') {
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
 * Filters to Swiss positions.
 *
 * @param {object} apiResponse - Parsed JSON from the Workday listing endpoint
 * @returns {Array<{title: string, externalPath: string, location: string, city: string, bulletFields: string[], postedOn: string}>}
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

    results.push({
      title,
      externalPath,
      location: locationsText,
      city: parseWorkdayCity(locationsText),
      bulletFields: posting.bulletFields || [],
      postedOn: posting.postedOn || '',
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
  const descriptionText = normalizeSpace(stripHtml(descriptionHtml));
  const publicUrl = buildPublicUrl(externalPath);
  const timeType = info.timeType || '';
  const jobReqId = info.jobReqId || '';
  const startDate = info.startDate || new Date().toISOString().split('T')[0];

  return {
    title,
    description: descriptionText,
    url: publicUrl,
    city: city || 'Ticino',
    canton: 'TI',
    employmentType: inferEmploymentType(title, descriptionText, timeType),
    datePosted: startDate,
    jobReqId,
    externalPath,
  };
}

/**
 * Fetch all Swiss job listings from the Otis Workday API.
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
          appliedFacets: { locationCountry: [SWISS_COUNTRY_FACET] },
          limit,
          offset,
          searchText: '',
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
 */
export async function fetchOtisDetailPage(externalPath, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKDAY_API_BASE}/job${externalPath}`, {
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
