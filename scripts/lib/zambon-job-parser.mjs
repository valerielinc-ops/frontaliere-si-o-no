/**
 * Zambon Svizzera SA — jobopportunity.ch platform parser
 *
 * Zambon uses the AITI e-lavoro / jobopportunity.ch portal.
 * The listing page is at:
 *   https://zambon.jobopportunity.ch/
 *
 * Each job links to a detail page at:
 *   https://zambon.jobopportunity.ch/index.php?module=profile_mod&submod=jobs&func=detail&id={id}
 *
 * The listing page is server-rendered HTML with a table or list of jobs.
 * Each row has: title, location, date, and a link to the detail page.
 */

import { JSDOM } from 'jsdom';

const ZAMBON_HOST = 'zambon.jobopportunity.ch';
const ZAMBON_BASE_URL = `https://${ZAMBON_HOST}`;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTags(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|section|tr|td)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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
  return s.slice(0, 90);
}

/** Minimum description length to accept. */
export const MIN_DESC_LENGTH = 100;

/**
 * Parse the listing page from zambon.jobopportunity.ch.
 * Returns an array of { id, title, url, location } objects.
 *
 * jobopportunity.ch uses a table-based or div-based listing with links
 * containing ?func=detail&id=XXX parameters.
 */
export function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Find all links that point to job detail pages
  const links = document.querySelectorAll('a[href*="func=detail"], a[href*="submod=jobs"]');

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    if (!href.includes('func=detail')) continue;

    // Extract the job ID
    const idMatch = href.match(/[?&]id=(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const title = normalizeSpace(link.textContent || '');
    if (!title || title.length < 3) continue;

    // Build absolute URL
    const absoluteUrl = href.startsWith('http')
      ? href
      : `${ZAMBON_BASE_URL}/${href.replace(/^\//, '')}`;

    // Try to extract location from surrounding row/container
    const row = link.closest('tr, .job-item, .listing-item, li, div');
    let location = '';
    if (row) {
      const cells = row.querySelectorAll('td, span, .location');
      for (const cell of cells) {
        const text = normalizeSpace(cell.textContent || '');
        if (text !== title && /cadempino|lugano|ticino|switzerland|svizzera/i.test(text)) {
          location = text;
          break;
        }
      }
    }

    jobs.push({
      id,
      title,
      url: absoluteUrl,
      location: location || 'Cadempino',
    });
  }

  // Strategy 2: Fallback — scan for any links with job-like URLs
  if (jobs.length === 0) {
    const allLinks = document.querySelectorAll('a[href]');
    for (const link of allLinks) {
      const href = link.getAttribute('href') || '';
      const text = normalizeSpace(link.textContent || '');
      if (text.length < 5) continue;
      if (href.includes('detail') && href.includes('id=')) {
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) continue;
        const id = idMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const absoluteUrl = href.startsWith('http')
          ? href
          : `${ZAMBON_BASE_URL}/${href.replace(/^\//, '')}`;
        jobs.push({ id, title: text, url: absoluteUrl, location: 'Cadempino' });
      }
    }
  }

  return jobs;
}

/**
 * Parse a job detail page from zambon.jobopportunity.ch.
 * Returns { title, body, sourceBodyLength }.
 */
export function parseDetailPage(html = '') {
  if (!html) return { title: '', body: '', sourceBodyLength: 0 };

  const { document } = new JSDOM(html).window;

  // Title
  const titleEl = document.querySelector('h1, h2.job-title, .job-title');
  const title = normalizeSpace(titleEl?.textContent || document.querySelector('title')?.textContent || '');

  // Body
  const BODY_SELECTORS = [
    '.job-description',
    '.job-detail',
    '.detail-content',
    '#content',
    'main',
    '.content',
    'article',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const candidate = stripTags(el.innerHTML || '');
    if (candidate.length > body.length) body = candidate;
    if (candidate.length >= MIN_DESC_LENGTH) break;
  }

  // Fallback: largest text block
  if (body.length < MIN_DESC_LENGTH) {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll('div, section, article, td')) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best && bestLen > body.length) {
      body = stripTags(best.innerHTML || '');
    }
  }

  return { title, body, sourceBodyLength: body.length };
}

/**
 * Detect job category from title.
 */
export function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/scientist|research|r&d|laboratory|lab\b/i.test(t)) return 'science';
  if (/pharma|regulat|clinical|medical/i.test(t)) return 'pharma';
  if (/qa|quality|gmp|validation/i.test(t)) return 'quality';
  if (/developer|software|engineer|it\b|data/i.test(t)) return 'technology';
  if (/sales|commercial|marketing|business\s*dev/i.test(t)) return 'sales';
  if (/account|financ|controller/i.test(t)) return 'finance';
  if (/hr|human|recruit/i.test(t)) return 'hr';
  if (/logistic|supply|warehouse/i.test(t)) return 'logistics';
  if (/produc|manufactur|operator/i.test(t)) return 'production';
  if (/intern|stage|apprendist/i.test(t)) return 'internship';
  return 'general';
}

/**
 * Detect experience level from title.
 */
export function detectExperienceLevel(title = '') {
  if (/intern|jr\.?|junior|entry|stage|apprendist/i.test(title)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal/i.test(title)) return 'SENIOR';
  return 'MID';
}
