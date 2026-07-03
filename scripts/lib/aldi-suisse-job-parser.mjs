/**
 * ALDI Suisse -- jobs.aldi.ch job parser
 *
 * ALDI Suisse uses SAP SuccessFactors as their ATS
 * (career5.successfactors.eu, company=HoferSELive). The careers portal at
 * jobs.aldi.ch is a TYPO3 site: it no longer server-renders `/job/{id}`
 * links — the job list is loaded client-side from the JSON REST endpoint
 * `${ALDI_SEARCH_API}` (each row carries city/zip/address/workload), and
 * each detail page (`/job/{id}`) is server-rendered HTML whose job-specific
 * body lives in `<div class="description">`.
 *
 * ALDI has stores across Ticino including locations in Lugano area,
 * Bellinzona, and other TI municipalities.
 *
 * Exports:
 *   parseAldiSearchResults(json)   -- extract job rows from the REST API
 *   parseAldiListingPage(html)     -- (legacy) extract job links from SSR HTML
 *   parseAldiDetailPage(html)      -- extract job data from detail page
 *   isAldiTicinoJob(job)           -- filter for Ticino positions
 *   isAldiJob(job)                 -- match ALDI jobs in dataset
 *   ALDI_SEARCH_API                -- TYPO3 REST job-search endpoint
 *   ALDI_SUCCESSFACTORS_BASE       -- SuccessFactors base URL
 */

import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';

/** SAP SuccessFactors base URL for ALDI Suisse */
export const ALDI_SUCCESSFACTORS_BASE = 'https://career5.successfactors.eu/career?company=aldisuis';

/** ALDI Suisse job detail URL prefix */
export const ALDI_JOB_BASE = 'https://www.jobs.aldi.ch';

/**
 * ALDI Suisse TYPO3 REST job-search endpoint.
 * Returns `{ jobs: [{ url:'job/{id}', title, city, zip, address, shift_type,
 * area_of_activity_title, career_level_title, sys_language_uid, ... }] }`.
 * Replaces the dead SSR `/job/{id}` link scraping (the homepage no longer
 * server-renders those anchors).
 */
export const ALDI_SEARCH_API = 'https://www.jobs.aldi.ch/rest/jobs/search';

/** Ticino locations where ALDI operates */
const TICINO_LOCATIONS = [
  'lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso',
  'giubiasco', 'biasca', 'agno', 'manno', 'rivera',
  'camorino', 'tenero', 'losone', 'gordola',
  'ticino', 'tessin',
];


/**
 * Extract the inner HTML of the first `<div>` whose class contains `classToken`,
 * matching the *balanced* closing `</div>` rather than the first one.
 *
 * A plain non-greedy regex (`<div ...>([\s\S]*?)</div>`) stops at the FIRST
 * `</div>`, so a nested `<div>` inside the block truncates the capture — on a
 * job detail page that means a thin (<50-word) body and a page that drops out
 * of the index. This walks the tag stream keeping a depth counter so the whole
 * block is returned regardless of nesting.
 *
 * @param {string} html
 * @param {string} classToken - bare class name to look for (e.g. "description")
 * @returns {string|null} inner HTML of the matched block, or null if not found
 */
function extractBalancedDiv(html = '', classToken = '') {
  if (!html || !classToken) return null;
  const openRe = new RegExp(
    `<div[^>]*class="[^"]*\\b${classToken}\\b[^"]*"[^>]*>`,
    'i',
  );
  const open = openRe.exec(html);
  if (!open) return null;

  const start = open.index + open[0].length;
  // Walk every <div ...>/<\/div> from the block start, tracking nesting depth.
  const tagRe = /<div\b[^>]*>|<\/div\s*>/gi;
  tagRe.lastIndex = start;
  let depth = 1;
  let tag;
  while ((tag = tagRe.exec(html)) !== null) {
    if (tag[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(start, tag.index);
    } else {
      depth += 1;
    }
  }
  // Unbalanced markup: fall back to everything after the opening tag so we
  // keep the full body rather than truncating to nothing.
  return html.slice(start);
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse the ALDI Suisse TYPO3 REST job-search response (the live discovery
 * path). The careers site no longer server-renders `/job/{id}` anchors; the
 * job list is fetched client-side from {@link ALDI_SEARCH_API} as JSON.
 *
 * Each row already carries the canonical structured fields (city, zip,
 * address, workload) so the detail page only needs to supply the prose body.
 *
 * @param {string|object} payload Raw JSON string or parsed `{ jobs: [...] }`.
 * @returns {{ url: string, jobId: string, title: string, city: string,
 *   zip: string, address: string, workload: string, areaTitle: string,
 *   careerLevel: string, latitude: string, longitude: string, langUid: number }[]}
 */
export function parseAldiSearchResults(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const rows = Array.isArray(data?.jobs) ? data.jobs : [];
  const seen = new Set();
  // `rmk_id` identifies the physical position. If TYPO3 ever ships one row
  // per `sys_language_uid` for the same role (distinct `job/{id}` URLs), a
  // URL-only dedupe would let every language variant through as a separate
  // job entry -- duplicate-content URLs for one physical posting. Dedupe on
  // `rmk_id` too whenever it's present (today it's already unique per row on
  // the live feed -- this is defensive hardening, not a fix for an observed
  // live duplicate; see #3119 item 3).
  const seenRmk = new Set();
  const results = [];
  for (const j of rows) {
    const rel = String(j?.url || '').trim();
    if (!rel) continue;
    const url = /^https?:\/\//i.test(rel)
      ? rel
      : `${ALDI_JOB_BASE}/${rel.replace(/^\/+/, '')}`;
    if (seen.has(url)) continue;
    const rmkId = String(j?.rmk_id || '').trim();
    if (rmkId && seenRmk.has(rmkId)) continue;
    seen.add(url);
    if (rmkId) seenRmk.add(rmkId);
    // `shift_type`/`shift` hold the human percentage ("50 - 70%"); the numeric
    // `workload` field is an internal relevance score, NOT a percentage.
    results.push({
      url,
      jobId: String(j?.job_id ?? j?.rmk_id ?? '').trim(),
      title: normalizeSpace(String(j?.title || '')),
      city: normalizeSpace(String(j?.city || '')),
      zip: String(j?.zip || '').trim(),
      address: normalizeSpace(String(j?.address || '')),
      workload: normalizeSpace(String(j?.shift_type || j?.shift || '')),
      areaTitle: normalizeSpace(String(j?.area_of_activity_title || '')),
      careerLevel: normalizeSpace(String(j?.career_level_title || '')),
      latitude: String(j?.latitude || '').trim(),
      longitude: String(j?.longitude || '').trim(),
      langUid: Number.isFinite(j?.sys_language_uid) ? j.sys_language_uid : 0,
    });
  }
  return results;
}

/**
 * (Legacy) Extract job links from an ALDI Suisse SSR listing page.
 *
 * Kept for the historical carousel/SuccessFactors anchor shape and unit
 * tests. The live careers site no longer ships these anchors — discovery now
 * goes through {@link parseAldiSearchResults}. This remains a harmless
 * fallback should ALDI ever re-introduce server-rendered job links.
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string, location: string, percentage: string }[]}
 */
export function parseAldiListingPage(html = '') {
  if (!html) return [];

  const results = [];

  // Primary: /job/{numericId} pattern on jobs.aldi.ch
  const jobIdPattern = /href="(\/job\/\d+)"/gi;
  let match;
  while ((match = jobIdPattern.exec(html)) !== null) {
    const url = `${ALDI_JOB_BASE}${match[1]}`;
    results.push({ url, title: '', location: '', percentage: '' });
  }

  // Also full URLs with /job/ pattern
  const fullJobPattern = /href="(https?:\/\/[^"]*jobs\.aldi\.ch\/job\/\d+)"/gi;
  while ((match = fullJobPattern.exec(html)) !== null) {
    results.push({ url: match[1], title: '', location: '', percentage: '' });
  }

  // SuccessFactors direct links
  const sfPattern = /href="(https?:\/\/career5\.successfactors[^"]+(?:aldisuis|HoferSELive)[^"]*)"/gi;
  while ((match = sfPattern.exec(html)) !== null) {
    results.push({ url: match[1], title: '', location: '', percentage: '' });
  }

  // Also look for links that look like job postings (have percentage or "Mostra")
  const jobCardPattern = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = jobCardPattern.exec(html)) !== null) {
    const href = match[1];
    const content = normalizeDescriptionSpace(stripHtml(match[2]));
    if (!content || content.length < 5) continue;
    if (/^(home|menu|login|kontakt|contatti)/i.test(content)) continue;

    if (/\d+\s*%|mostra|show|vedi|anzeigen/i.test(content)) {
      const url = href.startsWith('http') ? href : `${ALDI_JOB_BASE}${href}`;
      results.push({ url, title: content, location: '', percentage: '' });
    }
  }

  // Deduplicate
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Extract job data from an ALDI Suisse detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, percentage: string } | null}
 */
export function parseAldiDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Location
  let location = '';
  const locationMatch = html.match(/(?:Standort|Sede|Location)\s*:?\s*([^<\n,]+)/i)
    || html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i);
  if (locationMatch) {
    location = normalizeSpace(locationMatch[1]);
  }

  // Percentage
  let percentage = '';
  const pctMatch = html.match(/(\d+\s*(?:-\s*\d+)?\s*%)/);
  if (pctMatch) {
    percentage = normalizeSpace(pctMatch[1]);
  }

  // Body — the live TYPO3 detail page wraps the job-specific sections
  // (Aufgaben / Profil / Unser Angebot) in `<div class="description">`. Use a
  // depth-balanced extractor so a nested <div> inside the block does not
  // truncate the body to thin (<50-word) content. Older fixtures used
  // <main>/<article>/.content, kept here as fallbacks.
  let body = '';
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const contentHtml = extractBalancedDiv(html, 'description')
    || (mainMatch ? mainMatch[1] : '')
    || extractBalancedDiv(html, 'content')
    || '';
  if (contentHtml) {
    body = stripHtml(contentHtml);
  }

  // Requirements — bullet items within the job content block.
  const requirements = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liRe.exec(contentHtml || html)) !== null) {
    const text = normalizeSpace(stripHtml(liMatch[1]));
    if (text.length > 5 && text.length < 300) requirements.push(text);
  }

  if (!title && !body) return null;

  return { title, body, location, percentage, requirements };
}

/**
 * Check if an ALDI job is in Ticino.
 * @param {{ location?: string, canton?: string, city?: string }} job
 * @returns {boolean}
 */
export function isAldiTicinoJob(job) {
  if (!job) return false;
  const loc = String(job.location || job.city || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();

  if (canton === 'ti' || canton === 'ticino' || canton === 'tessin') return true;

  return TICINO_LOCATIONS.some((kw) => loc.includes(kw));
}

/**
 * Check if a job belongs to ALDI Suisse.
 * @param {object} job
 * @returns {boolean}
 */
export function isAldiJob(job) {
  if (!job) return false;
  const key = String(job.companyKey || '').toLowerCase();
  const company = String(job.company || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();

  return (
    key === 'aldi-suisse' ||
    key.includes('aldi') ||
    company.includes('aldi') ||
    url.includes('jobs.aldi.ch') ||
    url.includes('aldi.ch') ||
    (url.includes('successfactors') && url.includes('aldisuis'))
  );
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
