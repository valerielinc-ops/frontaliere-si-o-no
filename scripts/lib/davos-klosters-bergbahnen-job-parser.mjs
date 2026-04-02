/**
 * Davos Klosters Bergbahnen AG job parser — tourism/mountain railways.
 * Source: https://www.davosklosters.ch/bergbahnen
 */

const CAREERS_URL = 'https://www.davosklosters.ch/de/bergbahnen/jobs';
const CAREERS_ALT = 'https://www.davos.ch/arbeiten-in-davos/stellenangebote/';
const CAREERS_BASE = 'https://www.davosklosters.ch';
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
 * Tries multiple patterns for job links on tourism career pages.
 */
export function parseDavosKlostersBergbahnenListingHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const jobs = [];

  // Pattern 1: links to job detail pages with /jobs/, /stelle/, /stellenangebote/
  const patterns = [
    /<a[^>]+href=["']([^"']*?\/(?:jobs?|stelle[n]?(?:angebote)?|career|karriere)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href=["']([^"']+)["'][^>]*class="[^"]*(?:job|stelle|vacancy)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    /<div[^>]+class="[^"]*(?:job|stelle|vacancy)[^"]*"[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      const rawUrl = m[1].trim();
      // Skip listing pages and anchors
      if (/(?:stellenangebote|jobs)\/?(?:#.*)?$/.test(rawUrl)) continue;
      const url = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl}`;
      if (seen.has(url)) continue;
      seen.add(url);

      const title = stripHtml(m[2]).trim();
      if (!title || title.length < 3) continue;

      const slugMatch = rawUrl.match(/\/([^/?#]+)\/?(?:\?|#|$)/);
      const jobId = slugMatch ? slugMatch[1] : '';

      // Try to extract location from context
      const ctx = html.slice(m.index, m.index + 800);
      const locMatch = ctx.match(/(?:location|ort|standort|arbeitsort)[^>]*>([^<]+)/i)
        || ctx.match(/(Davos|Klosters|Parsenn|Jakobshorn|Rinerhorn|Pischa|Madrisa)/i);
      const location = locMatch
        ? (typeof locMatch[1] === 'string' ? stripHtml(locMatch[1]).trim() : locMatch[0])
        : 'Davos';

      jobs.push({ id: jobId, jobId, title, url, location, canton: 'GR', department: '' });
    }
  }

  return jobs;
}

// ── detail parsing ────────────────────────────────────────────────────

export function parseDavosKlostersBergbahnenDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let description = '';
  const contentMatch = html.match(/<div[^>]+class="[^"]*(?:job|stelle|vacancy|content)[-_]?(?:description|content|details|body|text)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
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

export async function fetchDavosKlostersBergbahnenJobUrls() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    // Try primary careers URL
    const res = await fetch(CAREERS_URL, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (res.ok) {
      const html = await res.text();
      const jobs = parseDavosKlostersBergbahnenListingHtml(html);
      if (jobs.length > 0) return jobs;
    }
  } catch { /* fall through to alternative */ }

  try {
    // Fallback: community job board
    const res2 = await fetch(CAREERS_ALT, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res2.ok) return [];
    const html2 = await res2.text();
    return parseDavosKlostersBergbahnenListingHtml(html2);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchDavosKlostersBergbahnenDetailPage(url) {
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
    return parseDavosKlostersBergbahnenDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
