/**
 * Läderach (Schweiz) AG job parser — Softgarden career platform (Next.js).
 * Source: https://laderach.career.softgarden.de/jobs/
 *
 * The listing page embeds all jobs in a __NEXT_DATA__ script tag.
 * Detail pages also use __NEXT_DATA__ for metadata + JSON-LD for the description.
 */

import { inferAnyCanton } from './target-swiss-locations.mjs';

const CAREERS_URL = 'https://laderach.career.softgarden.de/jobs/';
const CAREERS_BASE = 'https://laderach.career.softgarden.de';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// ── shared utilities ──────────────────────────────────────────────────

export function stripHtml(html = '') {
  const out = String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  // Preserve newlines introduced by <li>, <br>, <p>, <h*> markers — the audit
  // detects structured content via "^\\s*[-•*]\\s/m". Collapsing \s+ → ' ' would
  // flatten every bullet into one line and trip the no-structured-content gate.
  return out
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n[^\S\n]+/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
 * Extract __NEXT_DATA__ JSON from a Softgarden HTML page.
 * Returns the parsed object or null.
 */
export function extractNextData(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Parse listing HTML from the Softgarden careers page.
 * Extracts jobs from __NEXT_DATA__ → props.pageProps.jobs[].
 * Each job: { jobPostingId, title, link, location, additionalLocations }
 */
export function parseLaderachListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const nextData = extractNextData(html);
  if (nextData) {
    const rawJobs = nextData?.props?.pageProps?.jobs;
    if (Array.isArray(rawJobs) && rawJobs.length > 0) {
      return parseLaderachNextDataJobs(rawJobs);
    }
  }

  // Fallback: parse <li><a> links from the server-rendered HTML
  return parseLaderachHtmlFallback(html);
}

/**
 * Parse the jobs array from __NEXT_DATA__ pageProps.
 */
export function parseLaderachNextDataJobs(jobs) {
  if (!Array.isArray(jobs)) return [];
  const seen = new Set();
  const result = [];

  for (const item of jobs) {
    if (!item || !item.title) continue;
    const jobId = String(item.jobPostingId || '');
    const url = String(item.link || '').trim();
    const key = url || jobId;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    result.push({
      id: slugify(item.title),
      jobId,
      title: String(item.title).trim(),
      url: url.startsWith('http') ? url : `${CAREERS_BASE}${url}`,
      location: String(item.location || 'Ennenda').trim(),
      canton: inferAnyCanton(String(item.location || 'Ennenda')) || 'GL',
      department: '',
    });
  }
  return result;
}

/**
 * Fallback: parse <a href="/jobs/ID/Slug/"> links from server-rendered HTML.
 */
function parseLaderachHtmlFallback(html) {
  const seen = new Set();
  const jobs = [];
  const pattern = /<a[^>]+href=["']([^"']*?\/jobs\/\d+\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = pattern.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    const url = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = stripHtml(m[2]).trim();
    if (!title) continue;

    const idMatch = rawUrl.match(/\/jobs\/(\d+)\//);
    const jobId = idMatch ? idMatch[1] : '';

    // Location is in <small>Locations: <!-- -->City</small> after the <a>
    const ctx = html.slice(m.index, m.index + 500).replace(/<!--[\s\S]*?-->/g, '');
    const locMatch = ctx.match(/<small[^>]*>[^<]*Locations?:\s*([^<]+)/i);
    const location = locMatch ? stripHtml(locMatch[1]).trim() : 'Ennenda';

    jobs.push({
      id: slugify(title),
      jobId,
      title,
      url,
      location,
      canton: inferAnyCanton(location) || 'GL',
      department: '',
    });
  }
  return jobs;
}

// ── detail parsing ────────────────────────────────────────────────────

/**
 * Parse a Läderach detail page. Extracts:
 * - Metadata from __NEXT_DATA__ → data.context.job
 * - Description from JSON-LD JobPosting schema or HTML body fallback
 */
export function parseLaderachDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  const result = {};

  // Extract metadata from __NEXT_DATA__
  const nextData = extractNextData(html);
  if (nextData) {
    const job = nextData?.props?.pageProps?.data?.context?.job;
    if (job) {
      if (job.title) result.title = String(job.title).trim();
      if (job.city) result.location = String(job.city).trim();
      if (job.employmentType) result.employmentTypeRaw = String(job.employmentType).trim();
      if (job.workTime) result.workTime = String(job.workTime).trim();
    }
  }

  // Extract description from JSON-LD JobPosting
  let description = '';
  const ldMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (ld['@type'] === 'JobPosting' && ld.description) {
        description = stripHtml(ld.description);
      }
    } catch { /* ignore parse errors */ }
  }

  // Fallback: extract from HTML body
  if (!description || description.length < 30) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) description = stripHtml(mainMatch[1]);
  }
  if (!description || description.length < 30) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) description = stripHtml(bodyMatch[1]);
  }

  if (description && description.length >= 30) {
    result.description = description;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── fetch helpers ─────────────────────────────────────────────────────

export async function fetchLaderachJobUrls(timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseLaderachListingHtml(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLaderachDetailPage(url, timeoutMs = 15_000) {
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
    return parseLaderachDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
