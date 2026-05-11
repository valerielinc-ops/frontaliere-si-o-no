/**
 * Interroll Group — TYPO3 CMS careers page parser
 *
 * Interroll's job listing page is at:
 *   https://www.interroll.com/company/careers/jobs/
 *
 * Job detail pages follow the pattern:
 *   https://www.interroll.com/company/careers/jobs/job-detail/{job-title-slug}
 *
 * The listing page is server-rendered HTML with job cards containing:
 *   - Job title in an h3 element
 *   - Location text (e.g., "Sant'Antonino, Switzerland")
 *   - A "Details" link to the job detail page
 *
 * The page also has filter controls for department/location.
 */

import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

const INTERROLL_HOST = 'www.interroll.com';
const INTERROLL_BASE_URL = `https://${INTERROLL_HOST}`;

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
 * Check if a location string indicates a Swiss/Ticino position.
 */
export function isSwissLocation(location = '') {
  return isTargetSwissLocation(location);
}

/**
 * Parse the job listing page from interroll.com.
 * Returns an array of { title, url, location } objects.
 */
export function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Find job cards with detail links
  const detailLinks = document.querySelectorAll('a[href*="job-detail/"]');
  for (const link of detailLinks) {
    const href = link.getAttribute('href') || '';
    if (seen.has(href)) continue;
    seen.add(href);

    const absoluteUrl = href.startsWith('http')
      ? href
      : `${INTERROLL_BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

    // Find the title — check parent container for h3 or the nearest heading
    const container = link.closest('.job-listing-item, .job-card, .job, li, article, div');
    let title = '';
    if (container) {
      const heading = container.querySelector('h3, h2, h4, .job-title');
      title = normalizeSpace(heading?.textContent || '');
    }
    if (!title) {
      title = normalizeSpace(link.textContent || '');
    }
    // If the link text is just "Details", try to get the title from the parent
    if (/^details?$/i.test(title) && container) {
      const headings = container.querySelectorAll('h3, h2, h4');
      for (const h of headings) {
        const t = normalizeSpace(h.textContent || '');
        if (t && !/^details?$/i.test(t)) { title = t; break; }
      }
    }

    if (!title || title.length < 3 || /^details?$/i.test(title)) continue;

    // Extract location from surrounding text
    let location = '';
    if (container) {
      const pElements = container.querySelectorAll('p, span, .location, .meta');
      for (const p of pElements) {
        const text = normalizeSpace(p.textContent || '');
        if (text !== title && text.length > 3 && text.length < 200) {
          // Look for location-like text (contains a country or city name)
          if (/switzerland|germany|austria|brazil|sant.?antonino|china|usa/i.test(text)) {
            location = text.replace(/\s*\|.*$/, '').trim();
            break;
          }
        }
      }
    }

    jobs.push({ title, url: absoluteUrl, location: location || '' });
  }

  return jobs;
}

/**
 * Parse a job detail page from interroll.com.
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
    '.job-detail-content',
    '.job-description',
    '.ce-bodytext',
    '.frame-default',
    '#content main',
    'main',
    'article',
    '.content-main',
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
    for (const el of document.querySelectorAll('div, section')) {
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
  if (/engineer|r&d|develop|techni/i.test(t)) return 'engineering';
  if (/sales|account|commercial|area\s*manager/i.test(t)) return 'sales';
  if (/produc|manufactur|operator|assembl/i.test(t)) return 'production';
  if (/quality|qa|qc/i.test(t)) return 'quality';
  if (/logistic|supply|warehouse|purchas/i.test(t)) return 'logistics';
  if (/it\b|software|data|admin/i.test(t)) return 'technology';
  if (/hr|human|recruit/i.test(t)) return 'hr';
  if (/financ|account|controller/i.test(t)) return 'finance';
  if (/intern|apprenti|stage|ausbildung/i.test(t)) return 'internship';
  if (/project\s*manag/i.test(t)) return 'project-management';
  if (/customer|service/i.test(t)) return 'customer-service';
  return 'general';
}

/**
 * Detect experience level from title.
 */
export function detectExperienceLevel(title = '') {
  if (/intern|apprenti|jr\.?|junior|entry|stage|ausbildung/i.test(title)) return 'ENTRY';
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
