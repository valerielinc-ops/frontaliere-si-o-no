/**
 * Zambon Svizzera SA — careers page parser
 *
 * Zambon's main careers portal is at:
 *   https://www.zambon.com/en/open-positions
 *
 * The page uses a Vue.js frontend backed by the NcorePlat ATS.
 * Job data is rendered client-side from a JavaScript data source.
 *
 * Since the page is JS-rendered, the HTML we receive via server-side fetch
 * contains the Vue template with {{ career.title }} placeholders.
 * We parse:
 *   1. Any server-rendered job listings (if pre-rendered)
 *   2. JSON-LD structured data (if present)
 *   3. Fallback: embedded JSON data in script tags
 *
 * When no positions are available, the page shows:
 *   "Currently there are not open positions."
 *
 * Previously used jobopportunity.ch (defunct as of early 2026).
 */

import { JSDOM } from 'jsdom';

const ZAMBON_BASE_URL = 'https://www.zambon.com';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTags(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
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
  return s.slice(0, 200);
}

/** Minimum description length to accept. */
export const MIN_DESC_LENGTH = 100;

/**
 * Parse the listing page from zambon.com/en/open-positions.
 * Returns an array of { id, title, url, location } objects.
 *
 * The page is primarily Vue.js rendered. For server-fetched HTML, we try:
 * 1. JSON-LD structured data
 * 2. Pre-rendered job cards/links
 * 3. Embedded JSON data in script tags
 * 4. Links to NcorePlat job detail pages
 * 5. Legacy jobopportunity.ch format (for backward compat in tests)
 */
export function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Check for "no jobs" message
  const bodyText = (document.body?.textContent || '').toLowerCase();
  if (bodyText.includes('currently there are not open positions') ||
      bodyText.includes('no open positions') ||
      bodyText.includes('nessuna posizione aperta')) {
    return [];
  }

  // Strategy 1: Parse JSON-LD structured data
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent || '');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting' && item.title) {
          const id = String(item.identifier || item.url || jobs.length + 1);
          if (seen.has(id)) continue;
          seen.add(id);
          jobs.push({
            id,
            title: normalizeSpace(item.title),
            url: item.url || '',
            location: normalizeSpace(item.jobLocation?.address?.addressLocality || 'Cadempino'),
          });
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  if (jobs.length > 0) return jobs;

  // Strategy 2: Find links to NcorePlat job pages
  const links = document.querySelectorAll('a[href*="ncoreplat.com"], a[href*="jobposition"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const title = normalizeSpace(link.textContent || '');
    if (!title || title.length < 5) continue;
    // Skip "spontaneous application" links
    if (/autocandidatura|spontaneous/i.test(href) || /autocandidatura|spontaneous/i.test(title)) continue;
    const id = href.match(/jobposition\/(\d+)/)?.[1] || String(jobs.length + 1);
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push({ id, title, url: href, location: 'Cadempino' });
  }
  if (jobs.length > 0) return jobs;

  // Strategy 3: Find pre-rendered job cards with titles
  const cardSelectors = [
    '.career-item', '.job-item', '.position-item', '.job-card',
    '[class*="career"]', '[class*="position"]', '[class*="vacancy"]',
  ];
  for (const sel of cardSelectors) {
    const cards = document.querySelectorAll(sel);
    for (const card of cards) {
      const titleEl = card.querySelector('h2, h3, h4, .title, [class*="title"]');
      if (!titleEl) continue;
      const title = normalizeSpace(titleEl.textContent || '');
      if (!title || title.length < 5) continue;
      const linkEl = card.querySelector('a[href]');
      const url = linkEl?.getAttribute('href') || '';
      const id = String(jobs.length + 1);
      if (seen.has(title)) continue;
      seen.add(title);
      jobs.push({ id, title, url: url.startsWith('http') ? url : `${ZAMBON_BASE_URL}${url}`, location: 'Cadempino' });
    }
  }
  if (jobs.length > 0) return jobs;

  // Strategy 4: Legacy jobopportunity.ch format (backward compatibility with tests)
  const legacyLinks = document.querySelectorAll('a[href*="func=detail"], a[href*="submod=jobs"]');
  for (const link of legacyLinks) {
    const href = link.getAttribute('href') || '';
    if (!href.includes('func=detail')) continue;
    const idMatch = href.match(/[?&]id=(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = normalizeSpace(link.textContent || '');
    if (!title || title.length < 3) continue;
    const absoluteUrl = href.startsWith('http')
      ? href
      : `${ZAMBON_BASE_URL}/${href.replace(/^\//, '')}`;
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
    jobs.push({ id, title, url: absoluteUrl, location: location || 'Cadempino' });
  }

  return jobs;
}

/**
 * Parse a job detail page.
 * Returns { title, body, sourceBodyLength }.
 */
export function parseDetailPage(html = '') {
  if (!html) return { title: '', body: '', sourceBodyLength: 0 };

  const { document } = new JSDOM(html).window;

  // Title
  const titleEl = document.querySelector('h1, h2.job-title, .job-title, .position-title');
  const title = normalizeSpace(titleEl?.textContent || document.querySelector('title')?.textContent || '');

  // Body
  const BODY_SELECTORS = [
    '.job-description',
    '.job-detail',
    '.position-description',
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
