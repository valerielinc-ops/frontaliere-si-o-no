/**
 * ALDI Suisse -- jobs.aldi.ch job parser
 *
 * ALDI Suisse uses SAP SuccessFactors as their ATS
 * (career5.successfactors.eu, company=HoferSELive). The careers page
 * at jobs.aldi.ch renders job cards via JavaScript but also includes
 * direct job detail URLs in the SSR HTML as /job/{id} paths.
 *
 * ALDI has stores across Ticino including locations in Lugano area,
 * Bellinzona, and other TI municipalities.
 *
 * Exports:
 *   parseAldiListingPage(html)     -- extract job links from listing page
 *   parseAldiDetailPage(html)      -- extract job data from detail page
 *   isAldiTicinoJob(job)           -- filter for Ticino positions
 *   isAldiJob(job)                 -- match ALDI jobs in dataset
 *   ALDI_SUCCESSFACTORS_BASE       -- SuccessFactors base URL
 */

import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';

/** SAP SuccessFactors base URL for ALDI Suisse */
export const ALDI_SUCCESSFACTORS_BASE = 'https://career5.successfactors.eu/career?company=aldisuis';

/** ALDI Suisse job detail URL prefix */
export const ALDI_JOB_BASE = 'https://www.jobs.aldi.ch';

/** Ticino locations where ALDI operates */
const TICINO_LOCATIONS = [
  'lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso',
  'giubiasco', 'biasca', 'agno', 'manno', 'rivera',
  'camorino', 'tenero', 'losone', 'gordola',
  'ticino', 'tessin',
];


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
 * Extract job links from the ALDI Suisse listing page.
 *
 * The homepage (jobs.aldi.ch) and the Italian version (/it) contain
 * carousel cards linking directly to job detail pages via /job/{numericId}.
 * It also has links to SuccessFactors for some positions.
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string, location: string, percentage: string }[]}
 */
export function parseAldiListingPage(html = '') {
  if (!html) return [];

  const results = [];

  // Primary: /job/{numericId} pattern on jobs.aldi.ch
  const jobIdPattern = /href="(\/job\/\d+)"/gi;
  let match;
  while ((match = jobIdPattern.exec(html)) !== null) {
    const url = `${ALDI_JOB_BASE}${match[1]}`;
    results.push({ url, title: '', location: '', percentage: '' });
  }

  // Also full URLs with /job/ pattern
  const fullJobPattern = /href="(https?:\/\/[^"]*jobs\.aldi\.ch\/job\/\d+)"/gi;
  while ((match = fullJobPattern.exec(html)) !== null) {
    results.push({ url: match[1], title: '', location: '', percentage: '' });
  }

  // SuccessFactors direct links
  const sfPattern = /href="(https?:\/\/career5\.successfactors[^"]+(?:aldisuis|HoferSELive)[^"]*)"/gi;
  while ((match = sfPattern.exec(html)) !== null) {
    results.push({ url: match[1], title: '', location: '', percentage: '' });
  }

  // Also look for links that look like job postings (have percentage or "Mostra")
  const jobCardPattern = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = jobCardPattern.exec(html)) !== null) {
    const href = match[1];
    const content = normalizeDescriptionSpace(stripHtml(match[2]));
    if (!content || content.length < 5) continue;
    if (/^(home|menu|login|kontakt|contatti)/i.test(content)) continue;

    if (/\d+\s*%|mostra|show|vedi|anzeigen/i.test(content)) {
      const url = href.startsWith('http') ? href : `${ALDI_JOB_BASE}${href}`;
      results.push({ url, title: content, location: '', percentage: '' });
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
 * Extract job data from an ALDI Suisse detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, percentage: string } | null}
 */
export function parseAldiDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Location
  let location = '';
  const locationMatch = html.match(/(?:Standort|Sede|Location)\s*:?\s*([^<\n,]+)/i)
    || html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i);
  if (locationMatch) {
    location = normalizeSpace(locationMatch[1]);
  }

  // Percentage
  let percentage = '';
  const pctMatch = html.match(/(\d+\s*(?:-\s*\d+)?\s*%)/);
  if (pctMatch) {
    percentage = normalizeSpace(pctMatch[1]);
  }

  // Body
  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (contentMatch) {
    body = stripHtml(contentMatch[1]);
  }

  if (!title && !body) return null;

  return { title, body, location, percentage };
}

/**
 * Check if an ALDI job is in Ticino.
 * @param {{ location?: string, canton?: string, city?: string }} job
 * @returns {boolean}
 */
export function isAldiTicinoJob(job) {
  if (!job) return false;
  const loc = String(job.location || job.city || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();

  if (canton === 'ti' || canton === 'ticino' || canton === 'tessin') return true;

  return TICINO_LOCATIONS.some((kw) => loc.includes(kw));
}

/**
 * Check if a job belongs to ALDI Suisse.
 * @param {object} job
 * @returns {boolean}
 */
export function isAldiJob(job) {
  if (!job) return false;
  const key = String(job.companyKey || '').toLowerCase();
  const company = String(job.company || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();

  return (
    key === 'aldi-suisse' ||
    key.includes('aldi') ||
    company.includes('aldi') ||
    url.includes('jobs.aldi.ch') ||
    url.includes('aldi.ch') ||
    (url.includes('successfactors') && url.includes('aldisuis'))
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
