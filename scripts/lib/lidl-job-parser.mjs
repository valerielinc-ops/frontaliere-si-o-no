/**
 * Lidl Svizzera — team.lidl.ch search-API contract + detail page parser
 *
 * The Lidl career site (team.lidl.ch) runs on the LiCa SPA platform (shared
 * across the Schwarz group). This module is the single source of truth for the
 * pieces that drift when Lidl migrates the careers site, so a rename cannot
 * silently empty the crawler:
 *
 *   - Search-API contract: LIDL_SEARCH_API_BASE, LIDL_SEARCH_JOBS_KEY,
 *     buildLidlSearchQuery(), getLidlSearchPageCount(),
 *     extractLidlSearchLanguagePartitions(), extractLidlApiHitFields().
 *     The LiCa API is GET /it/api/v1/search?general={"page":N,"resultsPerPage":20,...}
 *     -> { jobs[], meta { totalCount, resultsPerPage, page } }. (The legacy
 *     /it/search_api/jobsearch endpoint with result.hits[] was retired and 404s.)
 *
 *   - Detail-page parser: parseLidlDetailPage(html) extracts the full
 *     multi-section body from a rendered job detail page, with two hard guards:
 *       1. body length ≥ MIN_LIDL_FULL_DESC (400 chars)
 *       2. body must contain list content (at least one "- " bullet line)
 *     When the guards are not met the extracted body is still returned (shorter /
 *     unstructured), letting callers decide whether to use it.
 */

import { JSDOM } from 'jsdom';

/** Base URL of the LiCa job-search API (replaces the retired search_api/jobsearch). */
export const LIDL_SEARCH_API_BASE = 'https://team.lidl.ch/it/api/v1/search';

/** Top-level key holding the job list in the LiCa search envelope. */
export const LIDL_SEARCH_JOBS_KEY = 'jobs';

/** Default page size requested from the LiCa search API. */
export const LIDL_DEFAULT_RESULTS_PER_PAGE = 20;

/**
 * Build the query string for one LiCa search page. The API paginates ONLY via a
 * JSON-encoded `general` object — a bare `page=N` query param is silently
 * ignored (meta.page stays 1 and the same first page is returned).
 */
export function buildLidlSearchQuery(
  page,
  resultsPerPage = LIDL_DEFAULT_RESULTS_PER_PAGE,
  language = '',
) {
  const general = JSON.stringify({
    page,
    resultsPerPage,
    sortField: '',
    sortOrder: 'desc',
  });
  const params = new URLSearchParams({ general });
  if (language) params.set('facets', JSON.stringify({ language: [language] }));
  return params.toString();
}

/**
 * Number of pages to drain given the LiCa search envelope `meta`. The API no
 * longer reports a `pageCount`; derive it from totalCount / resultsPerPage.
 */
export function getLidlSearchPageCount(meta, resultsPerPage = LIDL_DEFAULT_RESULTS_PER_PAGE) {
  const totalCount = Number(meta?.totalCount) || 0;
  const perPage = Number(meta?.resultsPerPage) || resultsPerPage || 1;
  return totalCount > 0 ? Math.ceil(totalCount / perPage) : 1;
}

/**
 * Read the source-declared language partition from the national envelope.
 * The unfiltered LiCa paginator can omit hits from otherwise well-formed
 * intermediate pages; the language facets are independently count-bound and
 * their declared counts must form an exact partition of the national total.
 */
export function extractLidlSearchLanguagePartitions(meta) {
  const totalCount = Number(meta?.totalCount);
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new Error(`Lidl language partition invalid: national total=${meta?.totalCount ?? '?'}.`);
  }
  if (totalCount === 0) return [];

  const languageFilters = Array.isArray(meta?.filters)
    ? meta.filters.filter((filter) => filter?.identifier === 'language')
    : [];
  if (languageFilters.length !== 1 || !Array.isArray(languageFilters[0]?.values)) {
    throw new Error('Lidl language partition invalid: expected exactly one language filter.');
  }

  const seen = new Set();
  const partitions = [];
  for (const value of languageFilters[0].values) {
    const language = String(value?.identifier || '').trim();
    const count = Number(value?.count);
    if (!/^[a-z]{2}$/.test(language)
        || seen.has(language)
        || !Number.isInteger(count)
        || count < 0) {
      throw new Error(
        `Lidl language partition invalid: language=${language || '?'}, count=${value?.count ?? '?'}.`,
      );
    }
    seen.add(language);
    if (count > 0) partitions.push({ language, count });
  }

  const partitionTotal = partitions.reduce((total, partition) => total + partition.count, 0);
  if (partitionTotal !== totalCount) {
    throw new Error(
      `Lidl language partition incomplete: facets=${partitionTotal}, national=${totalCount}.`,
    );
  }
  return partitions.sort((left, right) => left.language.localeCompare(right.language));
}

/**
 * Normalize one LiCa search-API job hit to the field set the crawler consumes,
 * tolerating the legacy search_api/jobsearch names as fallbacks. Keeping the
 * field mapping here (one tested place) means a future API rename surfaces as a
 * failing test instead of a silent zero-job crawl.
 */
export function extractLidlApiHitFields(hit = {}) {
  const loc = (hit && hit.location) || {};
  return {
    detailUrl: String(hit?.jobDetailUrl || hit?.url || '').trim(),
    title: String(hit?.title || '').trim(),
    // LiCa bundles the whole body into descResponsibilities; descOffer is legacy.
    descriptionHtml: String(hit?.descResponsibilities || hit?.descOffer || ''),
    language: String(hit?.language || hit?.jobLanguage || '').trim().toLowerCase(),
    requisitionId: String(hit?.requisitionId || hit?.reference || '').trim(),
    applyUrl: String(
      hit?.recruitingUrlEasyApply || hit?.recruitingUrl || hit?.easyApply?.easyApplyUrl || '',
    ).trim(),
    contractType: String(hit?.contractTypeId || hit?.contractType || '').trim(),
    city: String(loc?.city || '').trim(),
    locationName: String(loc?.name || loc?.title || '').trim(),
    address: String(loc?.address || '').trim(),
    zipCode: String(loc?.zipCode || loc?.postcode || '').trim(),
    country: String(loc?.country || '').trim(),
    highlight: Boolean(hit?.highlight),
  };
}

/** Minimum body length for a "full" Lidl job description. */
export const MIN_LIDL_FULL_DESC = 400;

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
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
 * Convert an element's inner HTML to plain text, preserving <li> bullets as
 * "- " markers so callers can detect structured list content.
 */
function innerTextWithBullets(el) {
  if (!el) return '';
  // Replace <li>…</li> with "- …\n" before stripping all other tags
  const html = el.innerHTML
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n');
  return stripHtml(html);
}

/**
 * True if the extracted text contains at least one bullet line.
 * Allows optional leading whitespace before the "- " marker — JSDOM innerHTML
 * preserves source indentation so lines arrive as "      - item".
 */
export function hasListContent(text = '') {
  return /(?:^|\n)\s*-\s+\S/m.test(String(text || ''));
}

/**
 * Priority-ordered CSS selectors for the job description container.
 * team.lidl.ch uses a Nuxt/Vue frontend; selectors cover known class patterns
 * as well as common fallbacks.
 */
const BODY_SELECTORS = [
  // Lidl-specific patterns (observed on team.lidl.ch)
  '.job-detail__description',
  '.jobad-description',
  '.jobad-body',
  '[data-testid="job-description"]',
  '[data-cy="job-description"]',
  // Rich-text content wrappers
  '.rte-text',
  '.rte-content',
  // Generic fallbacks
  '.vacancy-description',
  '.job-content',
  'article .content',
  'main .description',
  'main article',
];

/**
 * Find the element with the highest <li> count — useful as a last resort
 * when no specific selector matches.
 */
function findRichestListElement(document) {
  let best = null;
  let bestCount = 0;
  for (const el of document.querySelectorAll('div, section, article')) {
    const count = el.querySelectorAll('li').length;
    if (count > bestCount) {
      bestCount = count;
      best = el;
    }
  }
  return bestCount >= 3 ? best : null;
}

/**
 * Extract the full job description body from a team.lidl.ch detail page HTML.
 *
 * Returns:
 *   { title, body, hasLists, meetsMinLength }
 *
 * - `title`         — text from the first <h1> element
 * - `body`          — plain text with "- " bullet markers from <li> elements
 * - `hasLists`      — true if body contains list content (guard 2)
 * - `meetsMinLength` — true if body.length >= MIN_LIDL_FULL_DESC (guard 1)
 */
export function parseLidlDetailPage(html = '') {
  if (!html) return { title: '', body: '', hasLists: false, meetsMinLength: false };

  const { document } = new JSDOM(html).window;

  // ── Title ────────────────────────────────────────────────────
  const titleEl = document.querySelector('h1');
  const title = normalizeSpace(titleEl?.textContent || '');

  // ── Body via priority selectors ───────────────────────────────
  let body = '';

  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = innerTextWithBullets(el);
    if (text.length >= MIN_LIDL_FULL_DESC) {
      body = text;
      break;
    }
    // Keep the longest candidate as fallback even if below threshold
    if (text.length > body.length) body = text;
  }

  // ── Fallback: richest-list element ────────────────────────────
  if (!body || body.length < MIN_LIDL_FULL_DESC) {
    const rich = findRichestListElement(document);
    if (rich) {
      const text = innerTextWithBullets(rich);
      if (text.length > body.length) body = text;
    }
  }

  const lists = hasListContent(body);
  const meetsMinLength = body.length >= MIN_LIDL_FULL_DESC;

  return { title, body, hasLists: lists, meetsMinLength };
}
