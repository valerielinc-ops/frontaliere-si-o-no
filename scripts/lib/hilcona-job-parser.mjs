/**
 * Hilcona AG (Bell Food Group) job parser.
 * Source: https://career.bellfoodgroup.com/en
 */

const CAREERS_URL = 'https://career.bellfoodgroup.com/en';
const CAREERS_BASE = 'https://career.bellfoodgroup.com';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// ── shared utilities ──────────────────────────────────────────────────

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
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
 * Parse job listings from Bell Food Group career portal HTML.
 * Looks for job cards/links with href patterns like /en/job/12345
 */
export function parseHilconaListingHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const jobs = [];

  // Match job links — pattern: /en/job/{id} or /en/jobs/{slug}
  const pattern = /<a[^>]+href=["']([^"']*?\/(?:job|jobs|stelle|position)[s]?\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = pattern.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    const url = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = stripHtml(m[2]).trim();
    if (!title || title.length < 3) continue;

    const idMatch = rawUrl.match(/\/(?:job|jobs|stelle|position)[s]?\/(\d+)/);
    const jobId = idMatch ? idMatch[1] : '';

    // Try to extract location from nearby HTML context
    const ctx = html.slice(m.index, m.index + 800);
    const locMatch = ctx.match(/(?:location|ort|standort|arbeitsort)[^>]*>([^<]+)/i)
      || ctx.match(/(?:Landquart|Schaan|Hilcona)/i);
    const location = locMatch
      ? (typeof locMatch[1] === 'string' ? stripHtml(locMatch[1]).trim() : locMatch[0])
      : 'Landquart';

    jobs.push({ id: jobId, jobId, title, url, location, canton: 'GR', department: '' });
  }
  return jobs;
}

// ── detail parsing ────────────────────────────────────────────────────

export function parseHilconaDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let description = '';
  const contentMatch = html.match(/<div[^>]+class="[^"]*job[-_]?(?:description|content|details|body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]+class="[^"]*posting[-_]?(?:description|body|content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
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

export async function fetchHilconaJobUrls() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(CAREERS_URL, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseHilconaListingHtml(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchHilconaDetailPage(url) {
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
    return parseHilconaDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
