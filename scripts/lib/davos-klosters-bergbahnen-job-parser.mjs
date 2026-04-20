/**
 * Davos Klosters Bergbahnen AG job parser — tourism/mountain railways.
 * Source: https://www.davosklostersmountains.ch/de/mountains/stellenangebote/jobs-berge
 *
 * The listing page uses rexx-systems: job cards are <div class="job-item">
 * with <h3 class="job-item__title">, metadata divs, and a detail link
 * matching /de/mountains/stellenangebote/{slug}_j_{id}.
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('davos-klosters-bergbahnen');

const CAREERS_URL = 'https://www.davosklostersmountains.ch/de/mountains/stellenangebote/jobs-berge';
const CAREERS_BASE = 'https://www.davosklostersmountains.ch';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// ── shared utilities ──────────────────────────────────────────────────

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ').trim();
}

export function slugify(value = '') {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 180);
}

export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  if (/saison|saisonnier|stagionale|seasonal/i.test(combined)) return 'TEMPORARY';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

// ── listing parsing ───────────────────────────────────────────────────

/**
 * Parse job listings from Davos Klosters Bergbahnen HTML.
 *
 * Real HTML structure:
 * <div class="job-item clickable js-go-to-link">
 *   <h3 class="... job-item__title">Title</h3>
 *   <div class="row ...">
 *     <div class="col-md-10 ...">
 *       <div class="col-md ...">Period</div>
 *       <div class="col-md ...">Percentage</div>
 *       <div class="col-md ...">Department</div>
 *     </div>
 *     <div class="col-md-2 ...">
 *       <a href="/de/mountains/stellenangebote/Slug_j_ID">Details</a>
 *     </div>
 *   </div>
 * </div>
 */
export function parseDavosKlostersBergbahnenListingHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const jobs = [];

  // Split on job-item blocks
  const blocks = html.split(/(?=<div[^>]*class="[^"]*job-item[^"]*")/i);

  for (const block of blocks) {
    // Must contain a job-item class
    if (!/class="[^"]*job-item/i.test(block)) continue;

    // Extract title from <h3 class="... job-item__title">
    const titleMatch = block.match(/<h3[^>]*class="[^"]*job-item__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    if (!titleMatch) continue;
    const title = stripHtml(titleMatch[1]).trim();
    if (!title || title.length < 3) continue;

    // Extract detail link: <a href="/de/mountains/stellenangebote/Slug_j_ID">
    const linkMatch = block.match(/<a[^>]+href=["']([^"']*?stellenangebote\/[^"']+_j_\d+[^"']*)["']/i);
    if (!linkMatch) continue;
    const rawUrl = linkMatch[1].trim();
    const url = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl}`;
    if (seen.has(url)) continue;
    seen.add(url);

    // Extract job ID from the URL pattern: _j_ID
    const idMatch = rawUrl.match(/_j_(\d+)/);
    const jobId = idMatch ? idMatch[1] : '';

    // Extract metadata from the three col-md divs (period, percentage, department)
    const metaDivs = block.match(/<div[^>]*class="col-md vertical-gutter__item"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    const metaValues = metaDivs.map(d => stripHtml(d).trim()).filter(Boolean);

    const period = metaValues[0] || '';
    const percentage = metaValues[1] || '';
    const department = metaValues[2] || '';

    jobs.push({
      id: slugify(title),
      jobId,
      title,
      url,
      location: 'Davos',
      canton: HQ.canton,
      department,
      percentage,
      period,
    });
  }

  return jobs;
}

// ── detail parsing ────────────────────────────────────────────────────

/**
 * Parse a Davos Klosters Bergbahnen detail page.
 *
 * Structure:
 * - <h1> containing <span class="text-primary">Title</span>
 * - <div class="h3"> with department
 * - <div class="meta-list"> with period and percentage
 * - <div class="wysiwyg"> with full description HTML
 */
export function parseDavosKlostersBergbahnenDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  const result = {};

  // Extract title from <h1> → <span class="text-primary">
  const titleMatch = html.match(/<h1[^>]*>[\s\S]*?<span[^>]*class="[^"]*text-primary[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  if (titleMatch) result.title = stripHtml(titleMatch[1]).trim();

  // Extract department from <div class="h3 ..."> before <h1>
  const deptMatch = html.match(/<div[^>]*class="h3[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (deptMatch) result.department = stripHtml(deptMatch[1]).trim();

  // Extract metadata from meta-list items
  const metaListMatch = html.match(/<div[^>]*class="meta-list"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (metaListMatch) {
    const items = metaListMatch[1].match(/<div[^>]*class="meta-list__item"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    const metaValues = items.map(d => stripHtml(d).trim()).filter(v => v && !v.includes('download'));
    if (metaValues.length >= 1) result.period = metaValues[0];
    if (metaValues.length >= 2) result.percentage = metaValues[1];
  }

  // Extract description from wysiwyg content block
  let description = '';
  const wysiwygMatch = html.match(/<div[^>]*class="wysiwyg[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|$)/i);
  if (wysiwygMatch) {
    description = stripHtml(wysiwygMatch[1]);
  }

  // Fallback: extract from <main>
  if (!description || description.length < 30) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) description = stripHtml(mainMatch[1]);
  }

  if (description && description.length >= 30) {
    result.description = description;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── fetch helpers ─────────────────────────────────────────────────────

export async function fetchDavosKlostersBergbahnenJobUrls(timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseDavosKlostersBergbahnenListingHtml(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchDavosKlostersBergbahnenDetailPage(url, timeoutMs = 15_000) {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseDavosKlostersBergbahnenDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
