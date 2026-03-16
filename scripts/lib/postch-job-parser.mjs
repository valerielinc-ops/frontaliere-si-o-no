/**
 * postch-job-parser.mjs
 *
 * Parses a Post.ch / job.post.ch detail page HTML and extracts
 * structured job data from embedded JSON-LD (JobPosting schema)
 * or falls back to meta tags / HTML scraping.
 *
 * Detail page format (job.post.ch):
 *   https://job.post.ch/v2/job-vacancies/{slug}/{uuid}
 *   Contains <script type="application/ld+json"> with JobPosting schema.
 */

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function normalizeDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

/**
 * Extract all JSON-LD blocks from HTML and return parsed objects.
 */
function extractJsonLd(html = '') {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch { /* skip malformed JSON-LD */ }
  }
  return blocks;
}

/**
 * Extract a meta tag content value from HTML.
 */
function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]+content\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = html.match(re);
  if (match) return decodeHtml(normalizeSpace(match[1]));
  // Try reversed attribute order
  const re2 = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+(?:name|property)\\s*=\\s*["']${name}["']`, 'i');
  const match2 = html.match(re2);
  return match2 ? decodeHtml(normalizeSpace(match2[1])) : '';
}

/**
 * Extract <title> from HTML.
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(normalizeSpace(match[1])) : '';
}

/**
 * Derive the location / city from the JobPosting schema.
 */
function deriveCity(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  // jobLocation can be a single Place or array of Places
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address) continue;
    if (typeof address === 'string') return normalizeSpace(address);
    const city = address.addressLocality || address.addressRegion || '';
    if (city) return normalizeSpace(city);
  }
  return '';
}

/**
 * Derive the region from the JobPosting schema.
 */
function deriveRegion(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address || typeof address === 'string') continue;
    const region = address.addressRegion || '';
    if (region) return normalizeSpace(region);
  }
  return '';
}

/**
 * Derive the street address from the JobPosting schema.
 */
function deriveStreetAddress(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address || typeof address === 'string') continue;
    if (address.streetAddress) return normalizeSpace(address.streetAddress);
  }
  return '';
}

/**
 * Extract description text. Prefer JSON-LD description, fall back to meta.
 */
function deriveDescription(jobPosting = {}, html = '') {
  const desc = jobPosting.description || '';
  if (desc) {
    // Strip HTML tags if present
    return normalizeSpace(desc.replace(/<[^>]+>/g, ' '));
  }
  return extractMeta(html, 'description') || extractMeta(html, 'og:description') || '';
}

/**
 * Parse workload / employment type from the JSON-LD.
 */
function deriveEmploymentType(jobPosting = {}) {
  const et = jobPosting.employmentType;
  if (!et) return '';
  if (Array.isArray(et)) return et[0] || '';
  return String(et);
}

/**
 * Parse a Post.ch job detail page and return structured data.
 *
 * @param {string} html - Raw HTML of the detail page
 * @param {string} url  - URL of the detail page (for fallback data)
 * @returns {object} Structured job detail
 */
export function parsePostJobDetail(html = '', url = '') {
  const jsonLdBlocks = extractJsonLd(html);

  // Find the JobPosting schema block
  const jobPosting = jsonLdBlocks.find(
    b => b['@type'] === 'JobPosting' || b['@type']?.includes?.('JobPosting')
  ) || {};

  const hiringOrg = jobPosting.hiringOrganization;
  const hiringOrgName = typeof hiringOrg === 'string'
    ? hiringOrg
    : (hiringOrg?.name || '');

  const title = normalizeSpace(jobPosting.title || '')
    || extractMeta(html, 'og:title')
    || extractTitle(html).replace(/\s*\|.*$/, '')
    || '';

  const city = deriveCity(jobPosting);
  const region = deriveRegion(jobPosting);
  const streetAddress = deriveStreetAddress(jobPosting);
  const description = deriveDescription(jobPosting, html);
  const employmentType = deriveEmploymentType(jobPosting);
  const datePosted = normalizeDate(jobPosting.datePosted || '');
  const validThrough = normalizeDate(jobPosting.validThrough || '');
  const industry = normalizeSpace(jobPosting.industry || jobPosting.occupationalCategory || '');

  // Workload (pensum) — Post.ch sometimes includes it in the title or description
  let workload = '';
  const workloadMatch = (title + ' ' + description).match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
  if (workloadMatch) {
    workload = `${workloadMatch[1]}-${workloadMatch[2]}%`;
  } else {
    const singleMatch = (title + ' ' + description).match(/(\d{1,3})\s*%/);
    if (singleMatch) workload = `${singleMatch[1]}%`;
  }

  return {
    title,
    description,
    hiringOrg: normalizeSpace(hiringOrgName),
    city,
    region,
    location: city || region || '',
    streetAddress,
    industry,
    datePosted,
    validThrough,
    employmentType,
    workload,
    url,
  };
}
