/**
 * BPS (Banca Popolare di Sondrio) Suisse — bps-suisse.ch job parser
 *
 * BPS Suisse is a banking institution based in Lugano, TI.
 * Their careers page at bps-suisse.ch/lavora-in-bps-suisse.php lists
 * open positions as simple anchor elements linking to detail pages
 * (carriera-{slug}.php). Detail pages often contain a link to a PDF
 * with the full job description.
 *
 * This module exports:
 *   parseBpsSuisseListingPage(html)  — extract job URLs from listing page
 *   parseBpsSuisseDetailPage(html)   — extract job data from a detail page
 *   isTicinoBpsJob(job)              — filter for Ticino-relevant positions
 */

/** Minimum body length for a "full" BPS job description. */
export const MIN_BPS_FULL_DESC = 200;

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
 * Extract all job detail URLs from the BPS Suisse listing page.
 * Links follow the pattern: href="carriera-{slug}.php"
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string }[]}
 */
export function parseBpsSuisseListingPage(html = '') {
  if (!html) return [];

  const results = [];
  // Match links to career detail pages
  const linkPattern = /href="(carriera-[^"]+\.php)"[^>]*>([^<]*)</gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const relativeUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (relativeUrl && rawTitle) {
      results.push({
        url: `https://www.bps-suisse.ch/${relativeUrl}`,
        title: rawTitle,
      });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Extract job data from a BPS Suisse detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, pdfUrl: string } | null}
 */
export function parseBpsSuisseDetailPage(html = '') {
  if (!html) return null;

  // Extract title from <h2> or <h1>
  const titleMatch = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Extract location — look for "Sede:" pattern
  const locationMatch = html.match(/Sede\s*:\s*([^<\n]+)/i);
  const location = locationMatch ? normalizeSpace(locationMatch[1]) : 'Lugano';

  // Extract body text from the main content area
  // Try to find the main article/content section
  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (contentMatch) {
    body = stripHtml(contentMatch[1]);
  }

  // Extract PDF URL if present
  const pdfMatch = html.match(/href="([^"]*\.pdf)"/i);
  const pdfUrl = pdfMatch
    ? (pdfMatch[1].startsWith('http')
        ? pdfMatch[1]
        : `https://www.bps-suisse.ch/${pdfMatch[1].replace(/^\/+/, '')}`)
    : '';

  if (!title && !body) return null;

  return {
    title,
    body,
    location,
    pdfUrl,
    meetsMinLength: body.length >= MIN_BPS_FULL_DESC,
  };
}

/**
 * Check if a job is in Ticino (BPS Suisse is headquartered in Lugano).
 * @param {{ location?: string, canton?: string }} job
 * @returns {boolean}
 */
export function isTicinoBpsJob(job) {
  if (!job) return false;
  const loc = String(job.location || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();

  // BPS Suisse jobs in Lugano are always relevant
  const ticinoKeywords = ['lugano', 'ticino', 'ti', 'bellinzona', 'locarno', 'mendrisio', 'chiasso'];
  return (
    canton === 'ti' ||
    ticinoKeywords.some((kw) => loc.includes(kw))
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
