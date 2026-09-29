import { JSDOM } from 'jsdom';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import {
  extractJobPostingAddress,
  extractJobPostingDescription,
  extractJobPostingField,
  extractMicrodataDescription,
} from './jobposting-jsonld.mjs';
/**
 * Knowledge Lab — Freshteam job parser
 *
 * Public source: https://klab.freshteam.com/jobs/
 *   - The former authenticated `/api/job_postings` feed is no longer a
 *     reliable crawl contract. The public careers portal remains reachable
 *     and exposes one detail link per published posting.
 *   - Detail pages carry the complete description and location in
 *     schema.org/JobPosting JSON-LD; the DOM is retained as a narrow fallback
 *     for the portal's visible title, location, and work type.
 */

import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';
import { dropFabricatedDescription } from './drop-fabricated-description.mjs';

export const KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL = 'https://klab.freshteam.com/jobs/';
const FRESHTEAM_ORIGIN = 'https://klab.freshteam.com';
const FRESHTEAM_JOB_PATH_RE = /^\/jobs\/([^/]+)(?:\/[^/]+)?\/?$/i;
const CLOSED_DETAIL_RE = /currently\s+not\s+accepting\s+applications|no\s+longer\s+accepting\s+applications|position\s+has\s+been\s+filled/i;
const MIN_DESCRIPTION_WORDS = 50;
const DEFAULT_POSTED_DATE = '2000-01-01';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
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

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

function toTextLines(html = '') {
  const source = String(html || '')
    .replace(/<(?:br|\/p|\/li|\/div|\/section|\/article|\/h[1-6])\b[^>]*>/gi, '\n');
  return stripHtml(source)
    .split(/\n+/)
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
}

function parseDate(value = '') {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function normalizeDate(value = '') {
  return parseDate(value) || DEFAULT_POSTED_DATE;
}

function isExpiredValidThrough(value = '') {
  const candidate = String(value || '').trim();
  const normalized = parseDate(candidate);
  if (!normalized) return false;

  // A date-only validThrough covers the whole calendar day. Date-times are
  // compared at their actual instant instead of being truncated to a date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    return normalized < new Date().toISOString().slice(0, 10);
  }
  return new Date(candidate).getTime() < Date.now();
}

function extractFreshteamJobId(rawUrl = '') {
  try {
    const url = new URL(rawUrl, KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL);
    if (url.origin !== FRESHTEAM_ORIGIN) return '';
    return url.pathname.match(FRESHTEAM_JOB_PATH_RE)?.[1] || '';
  } catch {
    return '';
  }
}

function buildFreshteamDetailUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl, KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL);
    if (url.origin !== FRESHTEAM_ORIGIN || !extractFreshteamJobId(url.href)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function isGenericHeaderLine(line = '') {
  return /^(?:careers?|open\s+positions?|open\s+roles?|open\s+role|product\s*&\s*infrastructure|services\s*&\s*delivery|apply\s+now|submit\s+your\s+application)$/i.test(line)
    || /^work\s+type\s*:/i.test(line);
}

function extractVisibleHeaderLines(document, title = '') {
  const h1 = document.querySelector('h1');
  const snippets = [h1?.parentElement?.innerHTML, document.body?.innerHTML].filter(Boolean);
  for (const snippet of snippets) {
    const lines = toTextLines(snippet);
    const titleIndex = lines.findIndex((line) => line === title);
    if (titleIndex === -1) continue;
    return lines.slice(titleIndex + 1, titleIndex + 8);
  }
  return [];
}

function extractLocationFromHeader(document, title = '') {
  const lines = extractVisibleHeaderLines(document, title);
  for (const line of lines) {
    if (/^work\s+type\s*:/i.test(line) || /^apply\s+now$/i.test(line)) break;
    if (!line || isGenericHeaderLine(line) || line === title) continue;
    if (line.length <= 120) return line;
  }
  return '';
}

function extractEmploymentType(document, html = '') {
  const structured = normalizeSpace(
    document.querySelector('[itemprop="employmentType"]')?.getAttribute('content')
      || document.querySelector('[itemprop="employmentType"]')?.textContent
      || extractJobPostingField(html, 'employmentType')
      || '',
  );
  const bodyText = normalizeSpace(document.body?.textContent || '');
  const title = normalizeSpace(document.querySelector('h1')?.textContent || '');
  const headerLine = extractVisibleHeaderLines(document, title)
    .find((line) => /^work\s+type\s*:/i.test(line));
  const visible = structured
    || headerLine?.replace(/^work\s+type\s*:\s*/i, '')
    || bodyText.match(/work\s+type\s*:\s*(full\s*time|part\s*time|fixed\s+term\s+contract|contract|internship|temporary|seasonal|volunteer|secondment)/i)?.[1]
    || '';
  return normalizeSpace(visible).toLowerCase().replace(/[\s_]+/g, '-') || 'full-time';
}

function extractPostedDate(document, html = '') {
  const candidates = [
    // JobPosting.datePosted is authoritative; generic page timestamps may be
    // application deadlines or publication times for unrelated page content.
    extractJobPostingField(html, 'datePosted'),
    document.querySelector('[itemprop="datePosted"]')?.getAttribute('content'),
    document.querySelector('[itemprop="datePosted"]')?.textContent,
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content'),
    document.querySelector('time[datetime]')?.getAttribute('datetime'),
  ];
  const raw = candidates.find((candidate) => parseDate(candidate));
  return normalizeDate(raw);
}

function extractDomDescription(document) {
  const selectors = [
    '[itemprop="description"]',
    '[class*="job-description"]',
    '[id*="job-description"]',
    'article',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, form, input, button, iframe, nav, header, footer').forEach((node) => node.remove());
    const html = clone.innerHTML || '';
    if (stripHtml(html).split(/\s+/).filter(Boolean).length >= 50) return html;
  }
  return '';
}

/**
 * Extract the detail links exposed by the public Freshteam careers portal.
 * Only the tenant's `/jobs/<id>/<slug>` pages are accepted; arbitrary links
 * on the portal must never become crawler records.
 */
export function parseKnowledgeLabPublicListingHtml(html = '', baseUrl = KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL) {
  const document = new JSDOM(String(html || '')).window.document;
  const seen = new Set();
  const items = [];

  for (const anchor of document.querySelectorAll('a[href]')) {
    const detailUrl = buildFreshteamDetailUrl(anchor.getAttribute('href') || '');
    if (!detailUrl || seen.has(detailUrl)) continue;
    seen.add(detailUrl);
    items.push({
      jobId: extractFreshteamJobId(detailUrl),
      title: normalizeSpace(anchor.querySelector('h1, h2, h3, h4, h5, [class*="title"]')?.textContent || anchor.textContent || ''),
      detailUrl,
      applyUrl: detailUrl,
    });
  }

  const canonical = [
    document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    document.querySelector('meta[property="og:url"]')?.getAttribute('content'),
  ].filter(Boolean).some((rawUrl) => {
    try {
      const url = new URL(rawUrl, baseUrl);
      return url.origin === FRESHTEAM_ORIGIN && url.pathname.replace(/\/+$/, '') === '/jobs';
    } catch {
      return false;
    }
  });
  const text = normalizeSpace(document.body?.textContent || '');
  const hasExplicitListingSignal = /\b(?:open\s+positions?|open\s+roles?|no\s+jobs\s+found)\b/i.test(text);
  const recognized = canonical || items.length > 0 || hasExplicitListingSignal;
  const hasOpenPositionSignals = items.length > 0 || hasExplicitListingSignal;

  return { items, recognized, hasOpenPositionSignals };
}

/**
 * Parse one public Freshteam detail page. A closed posting is returned as a
 * terminal record so the caller can discard it without treating stale list
 * links as a source failure. An open page without a rich description remains
 * incomplete and is deliberately rejected by the crawler runner.
 */
export function parseKnowledgeLabPublicDetailHtml(html = '', detailUrl = '', fallbackTitle = '') {
  const document = new JSDOM(String(html || '')).window.document;
  const bodyText = normalizeSpace(document.body?.textContent || '');
  const validThrough = extractJobPostingField(html, 'validThrough');
  if (CLOSED_DETAIL_RE.test(bodyText) || isExpiredValidThrough(validThrough)) {
    return { closed: true, detailUrl };
  }

  const title = normalizeSpace(document.querySelector('h1')?.textContent || fallbackTitle);
  const address = extractJobPostingAddress(html);
  const location = normalizeSpace(address?.locality || extractLocationFromHeader(document, title));
  const descriptionHtml = extractJobPostingDescription(html)
    || extractMicrodataDescription(html)
    || extractDomDescription(document);
  const description = stripHtml(descriptionHtml);
  const jobId = extractFreshteamJobId(detailUrl);
  const descriptionWordCount = description.split(/\s+/).filter(Boolean).length;

  return {
    closed: false,
    incomplete: !title || !location || descriptionWordCount < MIN_DESCRIPTION_WORDS,
    jobId,
    title,
    description,
    descriptionHtml,
    descriptionWordCount,
    location,
    state: normalizeSpace(address?.addressRegion || ''),
    countryCode: normalizeSpace(address?.addressCountry || ''),
    postalCode: normalizeSpace(address?.postalCode || ''),
    department: '',
    employmentType: extractEmploymentType(document, html),
    applyUrl: detailUrl,
    remote: /remote\s+only/i.test(bodyText),
    postedDate: extractPostedDate(document, html),
  };
}

/**
 * Parse the historical Freshteam API response.
 *
 * Kept as a pure compatibility parser for existing fixtures; live crawling
 * uses parseKnowledgeLabPublicListingHtml + parseKnowledgeLabPublicDetailHtml
 * because the authenticated endpoint is no longer the reliable source.
 * @param {Array} jobs - JSON array from the Freshteam API
 * @returns {{ items: Array, totalResults: number }}
 */
export function parseKnowledgeLabListingJson(jobs = []) {
  const items = jobs
    .filter((j) => j?.title && !j?.deleted)
    .map((j) => {
      const branch = j.branch || {};
      const department = j.department || {};
      return {
        jobId: String(j.id),
        title: normalizeSpace(j.title),
        description: j.description ? stripHtml(j.description) : '',
        descriptionHtml: j.description || '',
        location: normalizeSpace(branch.city || ''),
        state: normalizeSpace(branch.state || ''),
        countryCode: normalizeSpace(branch.country_code || ''),
        department: normalizeSpace(department.name || ''),
        employmentType: normalizeSpace(j.type || 'full_time').replace(/_/g, '-'),
        applyUrl: normalizeSpace(j.applicant_apply_link || ''),
        remote: !!j.remote,
        postedDate: j.created_at ? j.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
      };
    });

  return { items, totalResults: items.length };
}

/**
 * Build localized content for a Knowledge Lab job.
 */
export function buildKnowledgeLabLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Switzerland';
  const description = String(job.description || '').trim();

  // The posting's own text, in its own language slot (`job.sourceLang`, set
  // by the runner); the translation step fills the other locales. Without
  // a text there is no description: this used to publish a sentence about
  // Knowledge Lab of its own in four languages ("… is hiring for the <title>
  // role … Apply through the official … careers page."), which filled every
  // locale so the translation step never replaced it.
  const sourceLang = String(job.sourceLang || '').trim() || 'it';

  return {
    description,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: description ? { [sourceLang]: description } : {},
    slugByLocale: {
      it: slugify(`${title} knowledge-lab ${location}`),
      en: slugify(`${title} knowledge-lab ${location}`),
      de: slugify(`${title} knowledge-lab ${location}`),
      fr: slugify(`${title} knowledge-lab ${location}`),
    },
  };
}

/**
 * Whether a Freshteam record belongs to the Swiss, CH-wide scope. The branch
 * city must itself resolve through the all-26-canton matcher; a Swiss-looking
 * state field cannot relabel a foreign city as Swiss.
 */
export function isKnowledgeLabSwissRelevant(job = {}) {
  const city = normalizeSpace(job.location);
  return Boolean(
    city &&
    isTargetSwissLocation(city, { includeBorderProximity: false }) &&
    inferAnyCanton(city),
  );
}

/**
 * Infer canton code (2-letter) from a job's branch city via the BFS
 * municipality dataset, CH-wide across all 26 cantons.
 *
 * Resolves on the CLEANEST single signal — the city string ALONE. A
 * combined "city + state" string can make inferAnyCanton return the wrong
 * canton because TARGET_CANTONS are checked first (array order). An
 * unresolvable city is rejected instead of falling back to a state that could
 * describe a different locality.
 *
 * Returns '' for non-CH / unresolved locations (caller drops these).
 */
export function inferKnowledgeLabCanton(job = {}) {
  const city = normalizeSpace(job.location);
  if (!isKnowledgeLabSwissRelevant({ ...job, location: city })) return '';
  return inferAnyCanton(city);
}

// The text this crawler used to write itself: the four sentences the builder wrote without a posting text ("Knowledge Lab cerca un/una…", "…is hiring for the…", "…sucht derzeit…", "…recrute actuellement…").
// Only ever recognised, to be removed from stored records (issue 5253).
export const KNOWLEDGE_LAB_FABRICATED_RE = /Knowledge Lab cerca un\/una |Knowledge Lab is hiring for the |Knowledge Lab sucht derzeit für die Position |Knowledge Lab recrute actuellement pour le poste /;

/**
 * Remove that text from a stored job before the locale-preserving merge: the
 * slots and flat `description` that carry it and the translations made from
 * it (`dropFabricatedDescription`); the job is flagged for retranslation.
 *
 * @returns {boolean} true when the job changed.
 */
export function dropKnowledgeLabFabricatedText(job) {
  return dropFabricatedDescription(job, KNOWLEDGE_LAB_FABRICATED_RE);
}
