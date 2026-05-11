/**
 * Alpiq — career page parser
 *
 * Alpiq lists open positions at:
 *   https://www.alpiq.com/career/open-jobs
 *
 * Job detail pages:
 *   https://www.alpiq.com/career/open-jobs/your-application/{jobId}
 *
 * Application links go to SuccessFactors:
 *   https://career5.successfactors.eu/careers?company=Alpiq&career_job_req_id={jobId}
 *
 * HTML structure on listing page:
 *   <ul> containing <li> items with:
 *     - Category tag
 *     - <a href="/career/open-jobs/your-application/{jobId}">Job Title</a>
 *     - Brief description text
 *     - Location and employment type (e.g., "Lausanne - 100% Permanent")
 *
 * This parser extracts jobs from the listing page HTML, filtering for
 * Swiss/Ticino locations only.
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';
import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';

const CAREERS_URL = 'https://www.alpiq.com/career/open-jobs';
const CAREERS_BASE = 'https://www.alpiq.com';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';


export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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
 * Check if a location string is in Ticino specifically.
 */
export function isTicinoLocation(location = '') {
  return isTargetSwissLocation(location);
}

/**
 * Check if a location string is in Switzerland.
 */
export function isSwissLocation(location = '') {
  if (isTargetSwissLocation(location)) return true;
  const lower = String(location || '').toLowerCase();
  if (/\b(swiss|switzerland|schweiz|svizzera|suisse)\b/i.test(lower)) return true;
  return inferAnyCanton(lower) !== '';
}

/**
 * Parse a single job listing block from the Alpiq listing page.
 * Expects a block of HTML containing one job entry.
 */
export function parseAlpiqJobBlock(block) {
  if (!block) return null;

  // Extract link and title
  const linkMatch = block.match(/<a\s+[^>]*href="(\/career\/open-jobs\/your-application\/(\d+))"[^>]*>([\s\S]*?)<\/a>/i);
  if (!linkMatch) return null;

  const relUrl = linkMatch[1];
  const jobId = linkMatch[2];
  const title = normalizeSpace(stripHtml(linkMatch[3]));
  if (!title || title.length < 3) return null;

  const fullUrl = `${CAREERS_BASE}${relUrl}`;

  // Extract location line — typically "Location - percentage | type"
  const locationMatch = block.match(/([A-Z][a-zA-ZÀ-ÿ\s]+)\s*[-–]\s*\d{1,3}(?:-\d{1,3})?%\s*(?:\|?\s*(?:Permanent|Temporary|Fixed[\s-]term))?/i);
  const locationRaw = locationMatch ? normalizeSpace(locationMatch[1]) : '';

  // Extract description snippet
  const descText = normalizeDescriptionSpace(stripHtml(block));
  const description = descText.length > 50 ? descText.slice(0, 500) : descText;

  // Extract category
  const categoryMatch = block.match(/(?:Assets|Finance|Trading|HR|Legal|Origination|Projects|Sales|IT|Engineering|Operations|Administration|Digital)/i);
  const category = categoryMatch ? categoryMatch[0] : '';

  // Extract contract type
  const contractMatch = block.match(/(\d{1,3}(?:-\d{1,3})?)%\s*(?:\|?\s*)?(Permanent|Temporary|Fixed[\s-]term)?/i);
  const percentage = contractMatch ? contractMatch[1] : '100';
  const contractType = contractMatch && contractMatch[2] ? contractMatch[2] : 'Permanent';

  return {
    id: `alpiq-${jobId}`,
    title,
    url: fullUrl,
    applyUrl: `https://career5.successfactors.eu/careers?career_ns=job_application&company=Alpiq&career_job_req_id=${jobId}&lang=en_GB`,
    location: locationRaw,
    jobId,
    category,
    percentage,
    contractType,
    description,
  };
}

/**
 * Parse the Alpiq listing page HTML to extract all jobs.
 * Can optionally filter for Swiss-only or Ticino-only jobs.
 */
export function parseAlpiqListingHtml(html, { swissOnly = true } = {}) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];

  // Split by job link pattern
  const segments = html.split(/(?=<a\s+[^>]*href="\/career\/open-jobs\/your-application\/\d+)/gi);

  for (const segment of segments) {
    const job = parseAlpiqJobBlock(segment);
    if (!job) continue;

    if (swissOnly && !isSwissLocation(job.location)) continue;

    jobs.push(job);
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
 * Parse an Alpiq detail page for full description.
 */
export function parseAlpiqDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract title from h2
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const title = h2Match ? normalizeSpace(stripHtml(h2Match[1])) : '';

  // Extract description from main content sections
  const sections = [];
  const strongRe = /<strong[^>]*>([\s\S]*?)<\/strong>/gi;
  let m;
  while ((m = strongRe.exec(html)) !== null) {
    const heading = normalizeSpace(stripHtml(m[1]));
    if (heading.length > 3 && heading.length < 100) {
      sections.push(heading);
    }
  }

  // Extract bullet points
  const bullets = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((m = liRe.exec(html)) !== null) {
    const text = normalizeDescriptionSpace(stripHtml(m[1]));
    if (text.length > 5) bullets.push(text);
  }

  // Build full description
  const bodyText = stripHtml(html);
  const description = bodyText.slice(0, 3000);

  return {
    title,
    description,
    sections,
    bullets,
  };
}

/**
 * Fetch all pages of Alpiq job listings.
 */
export async function fetchAlpiqListingPages(maxPages = 6, timeoutMs = 15000) {
  const allJobs = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? CAREERS_URL : `${CAREERS_URL}?page=${page}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': UA },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) break;
      const html = await res.text();
      const jobs = parseAlpiqListingHtml(html, { swissOnly: true });
      if (jobs.length === 0) break;
      allJobs.push(...jobs);
    } catch (err) {
      clearTimeout(timer);
      console.warn(`\u26a0\ufe0f Failed to fetch Alpiq page ${page}: ${err.message}`);
      break;
    }
  }

  // Deduplicate across pages
  const seen = new Set();
  return allJobs.filter((j) => {
    if (seen.has(j.jobId)) return false;
    seen.add(j.jobId);
    return true;
  });
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
