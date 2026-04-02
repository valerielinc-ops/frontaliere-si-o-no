/**
 * Läderach (Schweiz) AG job parser — Softgarden career platform.
 * Source: https://laderach.career.softgarden.de/
 */

const CAREERS_URL = 'https://laderach.career.softgarden.de/';
const CAREERS_API = 'https://laderach.career.softgarden.de/api/frontend/v1/jobad?limit=100&geoDistance=0';
const CAREERS_BASE = 'https://laderach.career.softgarden.de';
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

// ── JSON API parsing ──────────────────────────────────────────────────

/**
 * Parse Softgarden JSON API response.
 * Expected shape: { results: [{ id, title, geoCity, channelUrl, ... }] }
 */
export function parseLaderachApiResponse(json) {
  if (!json || typeof json !== 'object') return [];
  const results = Array.isArray(json.results) ? json.results : Array.isArray(json) ? json : [];
  const seen = new Set();
  const jobs = [];

  for (const item of results) {
    if (!item || !item.title) continue;
    const url = item.channelUrl || item.applyUrl || item.externalPostingUrl || '';
    const id = String(item.id || item.jobId || '');
    const key = url || id;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    jobs.push({
      id: id,
      jobId: id,
      title: String(item.title || '').trim(),
      url: url.startsWith('http') ? url : `${CAREERS_BASE}${url}`,
      location: String(item.geoCity || item.geo_city || item.location || 'Ennenda').trim(),
      canton: 'GR',
      department: String(item.jobCategory || item.department || '').trim(),
    });
  }
  return jobs;
}

/**
 * Fallback: parse listing HTML from the Softgarden careers page.
 */
export function parseLaderachListingHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const jobs = [];
  const pattern = /<a[^>]+href=["']([^"']*?\/job\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = pattern.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    const url = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = stripHtml(m[2]).trim();
    if (!title) continue;

    const idMatch = rawUrl.match(/\/job\/(\d+)/);
    const jobId = idMatch ? idMatch[1] : '';

    const locationMatch = html.slice(m.index, m.index + 500).match(/(?:location|ort|standort)[^>]*>([^<]+)/i);
    const location = locationMatch ? stripHtml(locationMatch[1]).trim() : 'Ennenda';

    jobs.push({ id: jobId, jobId, title, url, location, canton: 'GR', department: '' });
  }
  return jobs;
}

// ── detail parsing ────────────────────────────────────────────────────

export function parseLaderachDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let description = '';
  const contentMatch = html.match(/<div[^>]+class="[^"]*job[-_]?(?:description|content|details|ad)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]+class="[^"]*softgarden[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
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

export async function fetchLaderachJobUrls() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    // Try JSON API first
    const apiRes = await fetch(CAREERS_API, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (apiRes.ok) {
      const json = await apiRes.json();
      const jobs = parseLaderachApiResponse(json);
      if (jobs.length > 0) return jobs;
    }
  } catch { /* fall through to HTML */ }

  try {
    // Fallback: HTML listing
    const htmlRes = await fetch(CAREERS_URL, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!htmlRes.ok) return [];
    const html = await htmlRes.text();
    return parseLaderachListingHtml(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLaderachDetailPage(url) {
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
    return parseLaderachDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
