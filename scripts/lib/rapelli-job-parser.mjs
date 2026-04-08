/**
 * Rapelli (ORIOR Food AG) — careers.orior.ch job parser
 *
 * The Rapelli careers portal is hosted on ORIOR's SuccessFactors instance:
 *   https://careers.orior.ch/go/Rapelli-IT/5365701/
 *
 * Job detail URLs follow the pattern:
 *   https://careers.orior.ch/job/Stabio-{Title}-TI/{jobId}/
 *
 * HTML structure on the listing page:
 *   <a href="/job/{Location}-{Title}-TI/{jobId}/">Job Title</a>
 *   followed by company name, location, and department text
 *
 * This parser extracts jobs from the listing page HTML.
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('rapelli');

const CAREERS_URL = 'https://careers.orior.ch/go/Rapelli-IT/5365701/';
const CAREERS_BASE = 'https://careers.orior.ch';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/**
 * Parse the Rapelli listing page HTML to extract job links.
 * Returns array of { title, url, location, department }
 */
export function parseRapelliListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  // Match job links: /job/{path}/{jobId}/
  const linkRe = /<a\s+[^>]*href="(\/job\/[^"]+\/(\d+)\/?)"/gi;
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    const relUrl = match[1].replace(/&amp;/g, '&');
    const jobId = match[2];
    const fullUrl = `${CAREERS_BASE}${relUrl}`;

    // Extract the anchor text (title)
    const afterLink = html.slice(match.index, match.index + 500);
    const titleMatch = afterLink.match(/<a\s+[^>]*>[^<]*<[^>]*>([^<]+)<\/[^>]*>\s*<\/a>/i)
      || afterLink.match(/<a\s+[^>]*>([^<]+)<\/a>/i);
    if (!titleMatch) continue;

    const rawTitle = normalizeSpace(stripHtml(titleMatch[1]));
    if (!rawTitle || rawTitle.length < 3) continue;

    // Extract location from URL path (e.g., Stabio-Title-TI)
    const pathMatch = relUrl.match(/\/job\/([^/]+)/);
    let location = 'Stabio';
    if (pathMatch) {
      const parts = decodeURIComponent(pathMatch[1]).split('-');
      if (parts.length > 0) location = parts[0];
    }

    // Extract department from surrounding text
    const contextBlock = html.slice(match.index, match.index + 800);
    const deptMatch = contextBlock.match(/(?:Tecnologia|Ricerca e sviluppo|Produzione|Logistica|Qualità|Amministrazione|Risorse umane|Vendite|Marketing)/i);
    const department = deptMatch ? deptMatch[0] : '';

    jobs.push({
      id: `rapelli-${jobId}`,
      title: rawTitle,
      url: fullUrl,
      location,
      canton: HQ.canton,
      department,
      jobId,
    });
  }

  // Deduplicate by jobId
  const seen = new Set();
  return jobs.filter((j) => {
    if (seen.has(j.jobId)) return false;
    seen.add(j.jobId);
    return true;
  });
}

/**
 * Parse a Rapelli job detail page for description content.
 */
export function parseRapelliDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // SuccessFactors uses class="jobdescription" (no hyphen, no underscore).
  // The content has nested elements, so we can't use a simple lazy match —
  // instead, find the start and count div depth to find the matching close.
  let rawHtml = '';
  const marker = 'class="jobdescription"';
  const idx = html.indexOf(marker);
  if (idx >= 0) {
    // Find the '>' that closes the opening tag
    const contentStart = html.indexOf('>', idx) + 1;
    if (contentStart > 0) {
      let depth = 1;
      let pos = contentStart;
      while (pos < html.length && depth > 0) {
        const nextOpen = html.indexOf('<div', pos);
        const nextClose = html.indexOf('</div>', pos);
        if (nextClose < 0) break;
        if (nextOpen >= 0 && nextOpen < nextClose) {
          depth++;
          pos = nextOpen + 4;
        } else {
          depth--;
          if (depth === 0) {
            rawHtml = html.slice(contentStart, nextClose);
          }
          pos = nextClose + 6;
        }
      }
    }
  }

  // Fallback selectors for other SuccessFactors variants
  if (!rawHtml) {
    const fallback = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/<div[^>]*class="[^"]*jobDisplay[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/<div[^>]*class="[^"]*job_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (fallback) rawHtml = fallback[1];
  }

  const description = normalizeSpace(stripHtml(rawHtml));

  return {
    description: description || '',
    rawHtml,
  };
}

/**
 * Fetch all job URLs from the Rapelli listing page.
 */
export async function fetchRapelliJobUrls(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseRapelliListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Rapelli careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Rapelli detail page.
 */
export async function fetchRapelliDetailPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseRapelliDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
