/**
 * CEDES AG job parser — corporate career page.
 * Source: https://www.cedes.com/en/career/jobs/
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('cedes');

const CAREERS_URL = 'https://www.cedes.com/en/career/jobs/';
const CAREERS_BASE = 'https://www.cedes.com';
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
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

// ── listing parsing ───────────────────────────────────────────────────

/**
 * Parse job listings from CEDES career page HTML.
 * Looks for job cards/links on the /career/jobs/ page.
 */
export function parseCedesListingHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const jobs = [];

  // Match job links — pattern: /en/career/jobs/{slug} or /career/jobs/{slug}
  const pattern = /<a[^>]+href=["']([^"']*?\/career\/jobs\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = pattern.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    // Skip the listing page itself
    if (/\/career\/jobs\/?$/.test(rawUrl)) continue;
    const url = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = stripHtml(m[2]).trim();
    if (!title || title.length < 3) continue;

    const slugMatch = rawUrl.match(/\/career\/jobs\/([^/?#]+)/);
    const jobId = slugMatch ? slugMatch[1] : '';

    // Try to extract location from nearby context
    const ctx = html.slice(m.index, m.index + 800);
    const locMatch = ctx.match(/(?:location|ort|standort|arbeitsort)[^>]*>([^<]+)/i)
      || ctx.match(/(Landquart|Graubünden)/i);
    const location = locMatch
      ? (typeof locMatch[1] === 'string' ? stripHtml(locMatch[1]).trim() : locMatch[0])
      : 'Landquart';

    jobs.push({ id: jobId, jobId, title, url, location, canton: HQ.canton, department: '' });
  }

  // Fallback: generic job link pattern for card-based layouts
  if (jobs.length === 0) {
    const genericPattern = /<a[^>]+href=["']([^"']+)["'][^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let gm;
    while ((gm = genericPattern.exec(html)) !== null) {
      const rawUrl = gm[1].trim();
      const url = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl}`;
      if (seen.has(url)) continue;
      seen.add(url);
      const title = stripHtml(gm[2]).trim();
      if (!title || title.length < 3) continue;
      jobs.push({ id: '', jobId: '', title, url, location: 'Landquart', canton: HQ.canton, department: '' });
    }
  }

  return jobs;
}

// ── detail parsing ────────────────────────────────────────────────────

export function parseCedesDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let description = '';
  const contentMatch = html.match(/<div[^>]+class="[^"]*job[-_]?(?:description|content|details|body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]+class="[^"]*entry[-_]?content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  if (contentMatch) {
    description = stripHtml(contentMatch[1]);
  }

  if (!description || description.length < 30) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) description = stripHtml(bodyMatch[1]);
  }

  return description && description.length >= 30 ? { description } : null;
}

// ── fetch helpers ─────────────────────────────────────────────────────

export async function fetchCedesJobUrls() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(CAREERS_URL, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseCedesListingHtml(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCedesDetailPage(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseCedesDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
