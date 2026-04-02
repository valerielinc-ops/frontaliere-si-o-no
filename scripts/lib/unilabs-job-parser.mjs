/**
 * Unilabs — Workable API job parser
 *
 * Unilabs is a European medical diagnostics company with operations
 * in Manno, Canton Ticino, Switzerland.
 *
 * Workable API endpoints:
 *   Listing: GET https://apply.workable.com/api/v1/widget/accounts/unilabs
 *   Detail:  GET https://apply.workable.com/api/v1/widget/accounts/unilabs/jobs/{shortcode}
 *
 * Public URL:
 *   https://apply.workable.com/unilabs/j/{shortcode}/
 *
 * The listing endpoint returns a JSON object with a `jobs` array.
 * Each job has: title, shortcode, city, state, country, department, url, shortlink.
 * Filter for Switzerland to find Ticino positions.
 */

const WORKABLE_ACCOUNT = 'unilabs';
const WORKABLE_API_BASE = `https://apply.workable.com/api/v1/widget/accounts/${WORKABLE_ACCOUNT}`;
const WORKABLE_PUBLIC_BASE = `https://apply.workable.com/${WORKABLE_ACCOUNT}`;
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/**
 * Known Ticino/Swiss location keywords for filtering.
 */
const SWISS_LOCATION_KEYWORDS = [
  'switzerland', 'svizzera', 'suisse', 'schweiz',
  'lugano', 'ticino', 'manno', 'bellinzona', 'locarno',
  'mendrisio', 'chiasso', 'sorengo', 'agno', 'bioggio',
  'rivera', 'lamone', 'grancia', 'muzzano', 'paradiso',
];

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
 * Infer employment type from title, description, and optional type field.
 */
export function inferEmploymentType(title = '', description = '', typeField = '') {
  const combined = `${title} ${typeField} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Check if a job's location is in Switzerland.
 */
export function isSwissJob(job = {}) {
  const country = String(job.country || '').toLowerCase();
  const city = String(job.city || '').toLowerCase();
  const state = String(job.state || '').toLowerCase();
  const combined = `${country} ${city} ${state}`;
  return SWISS_LOCATION_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Build a public Workable URL for a job posting.
 */
export function buildPublicUrl(shortcode = '') {
  const code = String(shortcode || '').trim();
  if (!code) return '';
  return `${WORKABLE_PUBLIC_BASE}/j/${code}/`;
}

/**
 * Extract bullet items from an HTML list.
 */
export function parseBullets(html = '') {
  const items = [];
  const source = String(html || '');
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match = null;
  while ((match = re.exec(source)) !== null) {
    const text = normalizeSpace(stripHtml(match[1]));
    if (text.length >= 5) items.push(text);
  }
  return [...new Set(items)];
}

/**
 * Parse the Workable widget listing response.
 * Filters for Swiss positions.
 *
 * @param {object} apiResponse - Parsed JSON from the Workable listing endpoint
 * @returns {Array<{title: string, shortcode: string, city: string, state: string, country: string, department: string, url: string}>}
 */
export function parseUnilabsListings(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.jobs)) return [];

  const results = [];
  const seen = new Set();

  for (const job of apiResponse.jobs) {
    const title = normalizeSpace(job.title || '');
    const shortcode = String(job.shortcode || '').trim();

    if (!title || !shortcode) continue;
    if (seen.has(shortcode)) continue;
    seen.add(shortcode);

    // Filter for Switzerland
    if (!isSwissJob(job)) continue;

    results.push({
      title,
      shortcode,
      city: String(job.city || '').trim(),
      state: String(job.state || '').trim(),
      country: String(job.country || '').trim(),
      department: String(job.department || '').trim(),
      url: buildPublicUrl(shortcode),
    });
  }

  return results;
}

/**
 * Parse a Workable job detail response.
 *
 * @param {object} detail - Parsed JSON from Workable job detail endpoint
 * @returns {object|null} Parsed job detail or null if invalid
 */
export function parseUnilabsJobDetail(detail) {
  if (!detail) return null;

  const title = normalizeSpace(detail.title || '');
  if (!title || title.length < 3) return null;

  const descriptionHtml = detail.description || '';
  const requirementsHtml = detail.requirements || '';
  const benefitsHtml = detail.benefits || '';

  const descriptionText = normalizeSpace(stripHtml(descriptionHtml));
  const requirements = parseBullets(requirementsHtml);
  const benefits = parseBullets(benefitsHtml);

  // Build rich description with sections
  const parts = [];
  if (descriptionText) parts.push(descriptionText);
  if (requirements.length > 0) {
    parts.push(`## Requirements\n${requirements.map((item) => `- ${item}`).join('\n')}`);
  }
  if (benefits.length > 0) {
    parts.push(`## Benefits\n${benefits.map((item) => `- ${item}`).join('\n')}`);
  }

  const city = String(detail?.location?.city || detail?.city || '').trim();
  const state = String(detail?.location?.region || detail?.state || '').trim();
  const publishedDate = String(detail.published || '').trim();

  return {
    title,
    description: parts.join('\n\n').trim(),
    city: city || 'Manno',
    state: state || 'Ticino',
    requirements,
    benefits,
    employmentType: inferEmploymentType(title, descriptionText, detail.type || ''),
    department: Array.isArray(detail.department) ? detail.department.filter(Boolean) : [],
    publishedDate: publishedDate ? publishedDate.split('T')[0] : '',
  };
}

/**
 * Fetch all Swiss job listings from the Unilabs Workable API.
 */
export async function fetchUnilabsJobUrls(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(WORKABLE_API_BASE, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseUnilabsListings(data);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Unilabs Workable listings: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Unilabs Workable job detail.
 */
export async function fetchUnilabsDetailPage(shortcode, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKABLE_API_BASE}/jobs/${shortcode}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseUnilabsJobDetail(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
