/**
 * Air Zermatt AG — Job listing parser
 *
 * Career page: https://www.air-zermatt.ch/jobs
 *   (also accessible at /de/service/offene-stellen)
 *
 * The page uses a CMS listing module with MixItUp filtering.
 * Each job is in a `.listing_entry` div inside `div#mixItUp`.
 * Detail pages are at /de/service/offene-stellen/{slug}-{id}
 */

import { JSDOM } from 'jsdom';

const BASE_URL = 'https://www.air-zermatt.ch';

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

export const MIN_DESC_LENGTH = 100;

/**
 * Parse the Air Zermatt jobs listing page.
 * Returns an array of { id, title, url, snippet, location, tags } objects.
 */
export function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  const entries = document.querySelectorAll('.listing_entry');
  for (const entry of entries) {
    const entryId = entry.getAttribute('data-entry-id') || '';
    if (!entryId || seen.has(entryId)) continue;

    const titleEl = entry.querySelector('h2.listing-title a, h2 a, .listing-title a');
    const title = normalizeSpace(titleEl?.textContent || '');
    if (!title || title.length < 3) continue;

    const href = titleEl?.getAttribute('href') || '';
    const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

    const descEl = entry.querySelector('.listing-content-text');
    const snippet = normalizeSpace(descEl?.textContent || '');

    // Extract location from description (bold text typically indicates location)
    let location = 'Raron';
    const boldEls = descEl?.querySelectorAll('strong, b') || [];
    for (const b of boldEls) {
      const text = normalizeSpace(b.textContent || '');
      if (/raron|zermatt|visp|brig/i.test(text)) {
        location = text.replace(/[.,;]+$/, '').trim();
        break;
      }
    }

    // Extract tags from CSS classes
    const classes = entry.className || '';
    const tagMatches = classes.match(/tag_\d+/g) || [];

    seen.add(entryId);
    jobs.push({ id: entryId, title, url, snippet, location, tags: tagMatches });
  }

  return jobs;
}

/**
 * Parse a detail page for full job description.
 * Returns { title, body, sourceBodyLength }.
 */
export function parseDetailPage(html = '') {
  if (!html) return { title: '', body: '', sourceBodyLength: 0 };

  const { document } = new JSDOM(html).window;

  const titleEl = document.querySelector('h1, h2.listing-title, .listing-title');
  const title = normalizeSpace(titleEl?.textContent || document.querySelector('title')?.textContent || '');

  const BODY_SELECTORS = [
    '.listing-content-text',
    '.listing_entry .content',
    '.detail-content',
    '#content .content',
    'article',
    'main',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const candidate = stripTags(el.innerHTML || '');
    if (candidate.length > body.length) body = candidate;
    if (candidate.length >= MIN_DESC_LENGTH) break;
  }

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

  return { title, body, sourceBodyLength: body.length };
}

/**
 * Detect job category from title.
 */
export function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/pilot|flug|luft|heli/i.test(t)) return 'aviation';
  if (/mechanik|techniker|avionik|wartung/i.test(t)) return 'engineering';
  if (/rettung|rescue|paramedic|sanitä/i.test(t)) return 'rescue';
  if (/marketing|kommunikation|media/i.test(t)) return 'marketing';
  if (/admin|office|sekretär/i.test(t)) return 'admin';
  if (/lehr|ausbildung|apprent|stipend/i.test(t)) return 'apprenticeship';
  if (/training|instructor|coach/i.test(t)) return 'training';
  return 'general';
}

/**
 * Detect experience level from title.
 */
export function detectExperienceLevel(title = '') {
  if (/lehr|ausbildung|intern|junior|entry|stage|apprent|stipend/i.test(title)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chef/i.test(title)) return 'SENIOR';
  return 'MID';
}

/**
 * Infer employment type from title and description.
 */
export function inferEmploymentType(title = '', description = '') {
  const combined = `${title} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}
