/**
 * Hugo Boss — Phenom People careers platform parser
 *
 * Hugo Boss uses the Phenom People platform (like Sunrise).
 * The careers page embeds job data in a phApp.ddo JavaScript object.
 *
 * Listing URL:
 *   https://careers.hugoboss.com/global/en/search-results?keywords=&location=Coldrerio
 *
 * Detail URL pattern:
 *   https://careers.hugoboss.com/global/en/job/{jobSeqNo}/{title-slug}
 *
 * The phApp.ddo.eagerLoadRefineSearch.data.jobs array contains all
 * server-rendered job objects with: jobId, title, city, state,
 * cityStateCountry, category, postedDate, jobSeqNo, etc.
 */

import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

const HUGO_BOSS_HOST = 'careers.hugoboss.com';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function stripTags(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|section)>/gi, '\n')
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

/** Minimum description length to consider a detail page "full". */
export const MIN_DESC_LENGTH = 200;

/**
 * Extract the phApp.ddo JSON object from the Phenom People HTML.
 * Returns the parsed object or null if not found.
 */
export function extractPhenomDdo(html = '') {
  const source = String(html || '');
  // Phenom stores the DDO between phApp.ddo = {...}; phApp.experimentData
  const match = source.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\})\s*;\s*phApp\.experimentData/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Check whether a Phenom job object is located in Ticino or relevant Swiss areas.
 */
export function isHugoBossTargetLocation(job = {}) {
  const haystack = [
    job?.state,
    job?.city,
    job?.cityState,
    job?.cityStateCountry,
    job?.address,
    job?.location,
  ].filter(Boolean).join(' ');
  return isTargetSwissLocation(haystack);
}

/**
 * Parse all jobs from the Phenom People search results page HTML.
 * Returns an array of job objects extracted from phApp.ddo.
 */
export function parseSearchPage(html = '') {
  const ddo = extractPhenomDdo(html);
  const jobs = ddo?.eagerLoadRefineSearch?.data?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((job) => ({
    reqId: String(job.reqId || job.jobId || '').trim(),
    jobId: String(job.jobId || job.reqId || '').trim(),
    title: normalizeSpace(job.title || ''),
    city: normalizeSpace(job.city || ''),
    state: normalizeSpace(job.state || ''),
    cityState: normalizeSpace(job.cityState || ''),
    cityStateCountry: normalizeSpace(job.cityStateCountry || ''),
    address: normalizeSpace(job.address || ''),
    category: Array.isArray(job.multi_category)
      ? normalizeSpace(job.multi_category[0] || '')
      : normalizeSpace(job.category || ''),
    postedDate: String(job.postedDate || '').trim(),
    description: String(job.description || '').trim(),
    applyUrl: String(job.applyUrl || '').trim(),
    jobSeqNo: String(job.jobSeqNo || '').trim(),
  })).filter((job) => job.reqId && job.title);
}

/**
 * Build a canonical detail URL for a Hugo Boss job.
 */
export function buildDetailUrl(job = {}) {
  const seqNo = String(job.jobSeqNo || job.reqId || job.jobId || '').trim();
  const title = String(job.title || '').trim();
  if (!seqNo || !title) return '';
  return `https://${HUGO_BOSS_HOST}/global/en/job/${encodeURIComponent(seqNo)}/${slugify(title)}`;
}

/**
 * Parse a job detail page HTML. Extracts title and description body
 * from JSON-LD or the phApp.ddo.jobDetail data.
 */
export function parseDetailPage(html = '') {
  if (!html) return { title: '', body: '', sourceBodyLength: 0 };

  const ddo = extractPhenomDdo(html);
  const rawJob = ddo?.jobDetail?.data?.job || null;
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Try JSON-LD
  let jsonLd = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const items = Array.isArray(parsed) ? parsed : [parsed];
      jsonLd = items.find((item) => item?.['@type'] === 'JobPosting') || jsonLd;
    } catch { /* ignore */ }
  }

  const title = normalizeSpace(
    rawJob?.title || jsonLd?.title || document.querySelector('h1')?.textContent || ''
  );

  // Description: prefer DDO job description, then JSON-LD
  let body = '';
  const rawDesc = rawJob?.description || jsonLd?.description || '';
  if (rawDesc) {
    body = stripTags(rawDesc);
  }

  // Fallback: try main content area
  if (body.length < MIN_DESC_LENGTH) {
    const mainEl = document.querySelector('[class*="job-description"], [class*="jobDescription"], main, article');
    if (mainEl) {
      const candidate = stripTags(mainEl.innerHTML || '');
      if (candidate.length > body.length) body = candidate;
    }
  }

  return { title, body, sourceBodyLength: body.length };
}

/**
 * Detect job category from title.
 */
export function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/designer|design|creative|visual|3d|artist/i.test(t)) return 'design';
  if (/developer|software|engineer|it\b|tech|data|automation/i.test(t)) return 'technology';
  if (/intern|stage|stagist|practic/i.test(t)) return 'internship';
  if (/sales|retail|store|vendita|advisor/i.test(t)) return 'sales';
  if (/account|financ|controller|treasury/i.test(t)) return 'finance';
  if (/hr|human|recruit|people/i.test(t)) return 'hr';
  if (/marketing|communication|brand|copy/i.test(t)) return 'marketing';
  if (/logistic|supply|warehouse|planning|operations/i.test(t)) return 'logistics';
  if (/quality|qa|qc/i.test(t)) return 'quality';
  if (/produc|manufactur|operator/i.test(t)) return 'production';
  return 'general';
}

/**
 * Detect experience level from title.
 */
export function detectExperienceLevel(title = '') {
  if (/intern|jr\.?|junior|entry|stage|stagist|apprenti/i.test(title)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|vp/i.test(title)) return 'SENIOR';
  return 'MID';
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
