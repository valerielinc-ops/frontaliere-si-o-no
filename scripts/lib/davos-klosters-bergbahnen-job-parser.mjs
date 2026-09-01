/**
 * Davos Klosters Bergbahnen AG job parser — tourism/mountain railways.
 * Source: https://www.davosklostersmountains.ch/de/mountains/stellenangebote/jobs-berge
 *
 * The listing page uses rexx-systems: job cards are <div class="job-item">
 * with <h3 class="job-item__title">, metadata divs, and a detail link
 * matching /de/mountains/stellenangebote/{slug}_j_{id}.
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';
import { readAttr } from './html-attr.mjs';

const HQ = getCompanyDefaults('davos-klosters-bergbahnen');

const CAREERS_URL = 'https://www.davosklostersmountains.ch/de/mountains/stellenangebote/jobs-berge';
const CAREERS_BASE = 'https://www.davosklostersmountains.ch';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

export function normalizeDavosKlostersBergbahnenJobUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || '').trim(), CAREERS_BASE);
    const isJobPath = /^\/de\/mountains\/stellenangebote\/[^/]+_j_\d+\/?$/i.test(url.pathname);
    if (url.protocol !== 'https:' || url.origin !== CAREERS_BASE || url.username || url.password || !isJobPath) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

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

/**
 * Convert a job-body HTML fragment to plain text while PRESERVING list/line
 * structure. `stripHtml` above deliberately flattens everything onto one line
 * (correct for titles/metadata), but a description needs its bullet points to
 * survive as line-start `• ` markers: downstream structure detection (the
 * parser-quality audit's hasStructuredContent, JobPosting rendering) only
 * recognises lists when the bullets sit at the start of a line, not inline
 * inside a collapsed paragraph. Kept separate from stripHtml so the flattening
 * behaviour other callers rely on is unchanged.
 */
export function richTextToLines(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:li|p|h[1-6]|div|ul|ol|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .trim();
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
    const rawUrl = [...block.matchAll(/<a\b[^>]*>/gi)]
      .map((match) => readAttr(match[0], 'href'))
      .find((href) => /stellenangebote\/.*_j_\d+/i.test(href))
      ?.trim();
    if (!rawUrl) continue;
    const url = normalizeDavosKlostersBergbahnenJobUrl(rawUrl);
    if (!url) continue;
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

  // Extract title from the <h1> that OWNS a <span class="text-primary"> —
  // scanned <h1>-by-<h1> (never one unbounded match spanning multiple <h1>
  // tags) so a decorative/hidden <h1> elsewhere on the page (e.g. a
  // visually-hidden logo heading in the header) can't be mistaken for the
  // job title's own <h1> merely because some later span.text-primary follows
  // it in the document (#4205 follow-up).
  let titleMatch = null;
  let h1Idx = -1;
  for (const h1 of html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)) {
    const spanMatch = h1[1].match(/<span[^>]*class="[^"]*text-primary[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (spanMatch) {
      titleMatch = spanMatch;
      h1Idx = h1.index;
      break;
    }
  }
  if (titleMatch) result.title = stripHtml(titleMatch[1]).trim();

  // Bound description/metadata extraction to the per-job content subtree.
  //
  // #3836 (chrome-scraping): the live detail page renders a SITE-WIDE
  // operational alert banner (e.g. "Aufgrund von tech. Arbeiten an der
  // Pendelbahn … wird die 2. Sektion des Jakobshorns … geschlossen") inside its
  // OWN `.wysiwyg` block ABOVE the main job content. An unscoped "first
  // `.wysiwyg` on the page" match latched onto that banner, so all 9 davos jobs
  // carried the identical 171-char notice instead of their own body. The job
  // title `<h1>` always sits BELOW the banner, so anchor extraction there — only
  // the per-job region is searched, and the shared banner (plus header/nav
  // above it) is excluded. Falls back to the first <h1> on the page only when
  // no title-owning <h1> was found above.
  if (h1Idx < 0) h1Idx = html.search(/<h1[\s>]/i);
  const bodyScope = h1Idx >= 0 ? html.slice(h1Idx) : html;

  // Extract department from the <div class="h3 ..."> closest to (immediately
  // preceding) the job title <h1> — take the LAST match before h1Idx rather
  // than the first in the whole document, so a stray class="h3" element
  // inside the page-level banner/header (which sits earlier in the DOM) can't
  // leak into the department field (#4205 follow-up).
  const preTitleHtml = h1Idx >= 0 ? html.slice(0, h1Idx) : html;
  const deptMatches = [...preTitleHtml.matchAll(/<div[^>]*class="h3[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  const deptMatch = deptMatches.length ? deptMatches[deptMatches.length - 1] : null;
  if (deptMatch) result.department = stripHtml(deptMatch[1]).trim();

  // Extract metadata from meta-list items (within the per-job scope)
  const metaListMatch = bodyScope.match(/<div[^>]*class="meta-list"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (metaListMatch) {
    const items = metaListMatch[1].match(/<div[^>]*class="meta-list__item"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    const metaValues = items.map(d => stripHtml(d).trim()).filter(v => v && !v.includes('download'));
    if (metaValues.length >= 1) result.period = metaValues[0];
    if (metaValues.length >= 2) result.percentage = metaValues[1];
  }

  // Extract description from the FIRST wysiwyg block WITHIN the per-job scope —
  // i.e. the job body immediately following the title/meta-list, never the
  // page-level alert banner above the title.
  let description = '';
  const wysiwygMatch = bodyScope.match(/<div[^>]*class="[^"]*\bwysiwyg\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|$)/i);
  if (wysiwygMatch) {
    description = richTextToLines(wysiwygMatch[1]);
  }

  // Fallback: still bounded to the per-job scope — take the text after the
  // title but cut off at the first footer / nav / notification boundary so we
  // never re-absorb the shared page chrome the wysiwyg scoping just excluded.
  if (!description || description.length < 30) {
    const cut = bodyScope.search(/<footer[\s>]|<nav[\s>]|class="[^"]*(?:footer|site-alert|notification|megamenu)/i);
    const region = cut >= 0 ? bodyScope.slice(0, cut) : bodyScope;
    const text = richTextToLines(region);
    if (text.length >= 30) description = text;
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
  const safeUrl = normalizeDavosKlostersBergbahnenJobUrl(url);
  if (!safeUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(safeUrl, {
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
