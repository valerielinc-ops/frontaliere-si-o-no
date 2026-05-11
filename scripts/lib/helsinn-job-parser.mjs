/**
 * Helsinn Healthcare SA — AITI e-lavoro platform parser
 *
 * Helsinn exclusively uses the AITI e-lavoro portal for job postings:
 *   https://www.e-lavoro.ch/node/76
 *
 * The portal is a Drupal-based site. Job listings appear as linked items
 * under "I nostri annunci" (Our announcements) on the company's page.
 *
 * When no jobs are available, the page shows:
 *   "Purtroppo non ci sono offerte di lavoro, torna a trovarci!"
 *
 * Individual job pages follow the /node/{id} URL pattern.
 */

import { JSDOM } from 'jsdom';

const ELAVORO_HOST = 'www.e-lavoro.ch';
const ELAVORO_BASE_URL = `https://${ELAVORO_HOST}`;

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
 * Parse the listing page from e-lavoro.ch (Helsinn's company page).
 * Returns an array of { id, title, url, location } objects.
 *
 * e-lavoro.ch is a Drupal site. Job listings appear as links in the
 * content area. Each job links to a detail page at /node/{id}.
 *
 * When no jobs are present the page says:
 *   "Purtroppo non ci sono offerte di lavoro"
 */
export function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Check for "no jobs" message
  const bodyText = (document.body?.textContent || '').toLowerCase();
  if (bodyText.includes('non ci sono offerte di lavoro') ||
      bodyText.includes('nessuna offerta') ||
      bodyText.includes('no job offers')) {
    return [];
  }

  // Strategy 1: Find links to job detail pages (/node/{id} pattern)
  const links = document.querySelectorAll('a[href]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    // Match /node/{numeric_id} links (but skip known non-job nodes like /node/75 login, /node/76 listing)
    const nodeMatch = href.match(/\/node\/(\d+)/);
    if (!nodeMatch) continue;
    const id = nodeMatch[1];
    // Skip the listing page itself (node/76) and login (node/75)
    if (id === '76' || id === '75') continue;
    if (seen.has(id)) continue;

    const title = normalizeSpace(link.textContent || '');
    if (!title || title.length < 3) continue;
    // Skip navigation/footer links
    if (/^(home|login|cookie|privacy|termini|data protection|legal)/i.test(title)) continue;

    seen.add(id);

    const absoluteUrl = href.startsWith('http')
      ? href
      : `${ELAVORO_BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

    // Try to extract location from surrounding element
    const row = link.closest('tr, li, div, article, .job-item, .views-row');
    let location = '';
    if (row) {
      const text = normalizeSpace(row.textContent || '');
      if (/lugano|pambio|ticino|switzerland|svizzera/i.test(text)) {
        const locMatch = text.match(/(Lugano|Pambio[- ]Noranco|Biasca|Bellinzona|Ticino)/i);
        if (locMatch) location = locMatch[1];
      }
    }

    jobs.push({
      id,
      title,
      url: absoluteUrl,
      location: location || 'Lugano',
    });
  }

  // Strategy 2: Fallback — look for links with func=detail&id= (legacy jobopportunity.ch format)
  if (jobs.length === 0) {
    for (const link of links) {
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
        : `${ELAVORO_BASE_URL}/${href.replace(/^\//, '')}`;

      jobs.push({ id, title, url: absoluteUrl, location: 'Lugano' });
    }
  }

  return jobs;
}

/**
 * Parse a job detail page.
 * Supports both e-lavoro.ch (Drupal) and legacy jobopportunity.ch formats.
 * Returns { title, body, sourceBodyLength }.
 */
export function parseDetailPage(html = '') {
  if (!html) return { title: '', body: '', sourceBodyLength: 0 };

  const { document } = new JSDOM(html).window;

  // Title: first h1 or h2, or the page title
  const titleEl = document.querySelector('h1, h2.job-title, .job-title, .node-title');
  const title = normalizeSpace(titleEl?.textContent || document.querySelector('title')?.textContent || '');

  // Body: look for the main content area
  const BODY_SELECTORS = [
    '.job-description',
    '.job-detail',
    '.field--name-body',
    '.node__content',
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
