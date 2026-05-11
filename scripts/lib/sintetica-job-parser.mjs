/**
 * Sintetica SA — NCore Platform (ncoreplat.com) parser
 *
 * Sintetica uses the NCore Platform for job listings:
 *   https://app.ncoreplat.com/jobboard/1255/sintetica
 *
 * Job detail pages follow the pattern:
 *   https://app.ncoreplat.com/jobposition/{id}/{slug}/sintetica
 *
 * The listing page is server-rendered HTML with job cards containing:
 *   - h3 headings with the job title
 *   - Description text (truncated)
 *   - "Candidati Ora" / "Apply Now" links to detail pages
 */

import { JSDOM } from 'jsdom';

const NCORE_HOST = 'app.ncoreplat.com';
const NCORE_BASE_URL = `https://${NCORE_HOST}`;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTags(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|section)>/gi, '\n')
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
 * Parse the NCore Platform listing page.
 * Returns an array of { id, title, url, snippet } objects.
 *
 * NCore uses a simple HTML structure:
 *   <h3>Job Title</h3>
 *   <p>Short description...</p>
 *   <a href="/jobposition/{id}/{slug}/sintetica" class="btn">Candidati Ora</a>
 */
export function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Find all links to job positions
  const links = document.querySelectorAll('a[href*="/jobposition/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/jobposition\/(\d+)\//);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const absoluteUrl = href.startsWith('http')
      ? href
      : `${NCORE_BASE_URL}${href}`;

    // Find the title from the nearest h3 or the preceding heading
    let title = '';
    let snippet = '';

    // Walk backwards from the link to find the h3
    let el = link.previousElementSibling;
    while (el) {
      if (el.tagName === 'H3') {
        title = normalizeSpace(el.textContent || '');
        break;
      }
      if (el.tagName === 'P' && !snippet) {
        snippet = normalizeSpace(el.textContent || '');
      }
      el = el.previousElementSibling;
    }

    // Fallback: look in parent container
    if (!title) {
      const container = link.closest('.singlePosition, .job-item, div, section');
      if (container) {
        const h3 = container.querySelector('h3');
        if (h3) title = normalizeSpace(h3.textContent || '');
        if (!snippet) {
          const p = container.querySelector('p');
          if (p) snippet = normalizeSpace(p.textContent || '');
        }
      }
    }

    // Skip if the title is a generic button text
    if (!title || /candidati|apply|postuler/i.test(title)) continue;

    jobs.push({ id, title, url: absoluteUrl, snippet });
  }

  return jobs;
}

/**
 * Parse a job detail page from NCore Platform.
 * Returns { title, body, location, sourceBodyLength, closed }.
 *
 * `closed: true` is set when the page renders the "Position closed" notice
 * ("Siamo spiacenti", "non più disponibile", etc.). Callers should treat the
 * returned body as unusable in that case.
 */
const NCORE_CLOSED_RE = /\b(Siamo spiacenti|risulta essere chiusa|non è più possibile inoltrare|position(?: is)? closed|no longer available|Position non disponibile)\b/i;

export function parseDetailPage(html = '') {
  if (!html) return { title: '', body: '', location: '', sourceBodyLength: 0, closed: false };

  const { document } = new JSDOM(html).window;

  const closed = NCORE_CLOSED_RE.test(document.body?.textContent || '');

  // Title
  const titleEl = document.querySelector('h1, h2, .job-title');
  const title = normalizeSpace(
    titleEl?.textContent || document.querySelector('title')?.textContent || ''
  );

  // Location: look for location-like text
  let location = '';
  const metaEls = document.querySelectorAll('.job-location, .location, [class*="location"]');
  for (const el of metaEls) {
    const text = normalizeSpace(el.textContent || '');
    if (text && text.length < 100) { location = text; break; }
  }

  // Body
  const BODY_SELECTORS = [
    '.job-description',
    '.position-description',
    '.detail-content',
    '#job-content',
    'main',
    'article',
    '.content',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const candidate = stripTags(el.innerHTML || '');
    if (candidate.length > body.length) body = candidate;
    if (candidate.length >= MIN_DESC_LENGTH) break;
  }

  // Fallback
  if (body.length < MIN_DESC_LENGTH) {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll('div, section, article')) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best && bestLen > body.length) {
      body = stripTags(best.innerHTML || '');
    }
  }

  return { title, body, location, sourceBodyLength: body.length, closed };
}

/**
 * Detect job category from title.
 */
export function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/scientist|research|r&d|laboratory|lab\b/i.test(t)) return 'science';
  if (/pharma|regulat|clinical|medical/i.test(t)) return 'pharma';
  if (/qa|quality|gmp|validation|control/i.test(t)) return 'quality';
  if (/produc|manufactur|operator|engineer/i.test(t)) return 'production';
  if (/maintenance|technic/i.test(t)) return 'maintenance';
  if (/developer|software|it\b|data/i.test(t)) return 'technology';
  if (/sales|commercial|marketing/i.test(t)) return 'sales';
  if (/logistic|supply|warehouse/i.test(t)) return 'logistics';
  if (/apprendist|intern|stage/i.test(t)) return 'internship';
  return 'general';
}

/**
 * Detect experience level from title.
 */
export function detectExperienceLevel(title = '') {
  if (/apprendist|intern|jr\.?|junior|entry|stage/i.test(title)) return 'ENTRY';
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
