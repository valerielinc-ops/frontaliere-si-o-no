/**
 * TPL (Trasporti Pubblici Luganesi) — tplsa.ch job parser
 *
 * TPL is the public transport operator for the Lugano area in Ticino.
 * Their careers page at tplsa.ch/2/50/tpl-lavora-con-noi.html shows
 * open positions when available. The page is server-rendered HTML.
 *
 * This module exports:
 *   parseTplListingPage(html)  — extract job links from careers page
 *   parseTplDetailPage(html)   — extract job data from a detail page
 *   isTplJob(job)              — match TPL jobs in dataset
 */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
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
 * Extract job URLs from the TPL careers listing page.
 * The page may have links to detail pages or PDF documents.
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string }[]}
 */
export function parseTplListingPage(html = '') {
  if (!html) return [];

  const results = [];

  // Look for links to job detail pages or PDF announcements
  // TPL uses various patterns: /2/XX/slug.html or direct PDF links
  const linkPattern = /href="([^"]*(?:lavora|posizione|offerta|impiego|candidatura)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const rawUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (!rawUrl || !rawTitle || rawTitle.length < 3) continue;

    const url = rawUrl.startsWith('http')
      ? rawUrl
      : `https://www.tplsa.ch${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;

    results.push({ url, title: rawTitle });
  }

  // Also look for generic job links with common patterns
  const genericPattern = /href="(\/[^"]*\.html)"[^>]*>\s*([\s\S]*?)\s*<\/a>/gi;
  while ((match = genericPattern.exec(html)) !== null) {
    const rawUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (!rawUrl || !rawTitle || rawTitle.length < 5) continue;
    // Skip navigation/footer links
    if (/contatti|mappa|privacy|cookie|home|login/i.test(rawTitle)) continue;
    // Only include if it looks like a job
    if (/autista|conducente|meccanico|impiegat|tecnic|dirett|responsabil/i.test(rawTitle)) {
      const url = `https://www.tplsa.ch${rawUrl}`;
      if (!results.some((r) => r.url === url)) {
        results.push({ url, title: rawTitle });
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Extract job data from a TPL detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string } | null}
 */
export function parseTplDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // TPL jobs are always in Lugano area
  const location = 'Lugano';

  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (contentMatch) {
    body = stripHtml(contentMatch[1]);
  }

  if (!title && !body) return null;

  return { title, body, location };
}

/**
 * Check if a job belongs to TPL.
 * @param {object} job
 * @returns {boolean}
 */
export function isTplJob(job) {
  if (!job) return false;
  const company = String(job.company || '').toLowerCase();
  const key = String(job.companyKey || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();
  return (
    key === 'tpl-lugano' ||
    key.includes('tpl') ||
    company.includes('trasporti pubblici luganesi') ||
    company.includes('tpl') ||
    url.includes('tplsa.ch')
  );
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
