#!/usr/bin/env node
/**
 * Adzuna free-tier API client — Swiss jobs metadata fallback.
 *
 * Used as a metadata-only fallback for employers whose career sites are
 * blocked by anti-bot WAFs (Cloudflare, Akamai BMP, etc.) and where running
 * a residential-proxy + Playwright stack would break the $0/mo budget.
 *
 * Adzuna is itself a job aggregator: each `redirect_url` is the canonical
 * Adzuna landing page for the listing, which then deep-links to the
 * employer's official posting. We expose Adzuna's URL as `applyUrl` —
 * no ToS violation since the user lands on Adzuna first.
 *
 * Free tier: 1000 calls/mo per app_id. To stay within the cap, every
 * `searchAdzuna` call is cached on disk under `data/adzuna-cache/` keyed
 * by `{employer}-{country}-{date-yyyy-mm-dd}-page-{n}.json`. Re-running
 * the parser the same UTC day reads from disk and never hits the API.
 *
 * Endpoint: https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
 * Docs:     https://developer.adzuna.com/docs/search
 *
 * Required env (production): ADZUNA_APP_ID, ADZUNA_APP_KEY
 * Tests inject `_fetchImpl` to avoid hitting the live API.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CACHE_DIR = path.join(ROOT, 'data', 'adzuna-cache');

const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs';
const FREE_TIER_MONTHLY_CAP = 1000;
const DEFAULT_RESULTS_PER_PAGE = 50; // max Adzuna allows
const DEFAULT_MAX_PAGES = 4; // 4 × 50 = up to 200 listings/employer/day

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function cacheKey({ employer, country, page, date }) {
  const safeEmployer = slugify(employer || 'unknown');
  return `${safeEmployer}-${country}-${date}-page-${page}.json`;
}

async function readCache(cacheDir, key) {
  try {
    const raw = await fs.readFile(path.join(cacheDir, key), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(cacheDir, key, payload) {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, key),
      JSON.stringify(payload, null, 2),
      'utf8',
    );
  } catch (err) {
    // Cache failures must never block the crawler — log and continue.
    console.warn(`⚠️ Adzuna cache write failed (${key}): ${err?.message || err}`);
  }
}

/**
 * Search Adzuna for jobs matching a company name.
 *
 * @param {object} params
 * @param {string} params.company         — Employer brand to search for (Adzuna's `what_phrase`)
 * @param {string} [params.country='ch']  — ISO country code (lowercase)
 * @param {number} [params.resultsPerPage=50]
 * @param {number} [params.page=1]
 * @param {string} [params.appId]         — defaults to process.env.ADZUNA_APP_ID
 * @param {string} [params.appKey]        — defaults to process.env.ADZUNA_APP_KEY
 * @param {string} [params.cacheDir]      — defaults to data/adzuna-cache/
 * @param {Function} [params._fetchImpl]  — test hook (signature mirrors fetch)
 * @param {string}   [params._cacheDate]  — test hook to freeze "today"
 * @returns {Promise<{ count: number, results: Array<object>, _fromCache: boolean }>}
 */
export async function searchAdzuna({
  company,
  country = 'ch',
  resultsPerPage = DEFAULT_RESULTS_PER_PAGE,
  page = 1,
  appId = process.env.ADZUNA_APP_ID,
  appKey = process.env.ADZUNA_APP_KEY,
  cacheDir = DEFAULT_CACHE_DIR,
  _fetchImpl = globalThis.fetch,
  _cacheDate = todayUtc(),
} = {}) {
  if (!company || typeof company !== 'string') {
    throw new Error('searchAdzuna: `company` is required');
  }

  const key = cacheKey({ employer: company, country, page, date: _cacheDate });
  const cached = await readCache(cacheDir, key);
  if (cached) {
    return { ...cached, _fromCache: true };
  }

  if (!appId || !appKey) {
    throw new Error(
      'searchAdzuna: ADZUNA_APP_ID and ADZUNA_APP_KEY must be set (or pass appId/appKey explicitly)',
    );
  }
  if (typeof _fetchImpl !== 'function') {
    throw new Error('searchAdzuna: no fetch implementation available');
  }

  const url = new URL(`${ADZUNA_BASE}/${encodeURIComponent(country)}/search/${encodeURIComponent(page)}`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('results_per_page', String(resultsPerPage));
  url.searchParams.set('what_phrase', company);
  url.searchParams.set('content-type', 'application/json');

  const res = await _fetchImpl(url.toString(), {
    headers: { 'User-Agent': 'FrontaliereTicino-AdzunaFallback/1.0' },
  });
  if (!res || !res.ok) {
    const status = res?.status ?? 'unknown';
    throw new Error(`Adzuna API request failed: HTTP ${status}`);
  }
  const json = await res.json();

  const payload = {
    count: typeof json?.count === 'number' ? json.count : (json?.results?.length ?? 0),
    results: Array.isArray(json?.results) ? json.results : [],
  };

  await writeCache(cacheDir, key, payload);
  return { ...payload, _fromCache: false };
}

/**
 * Fetch all pages for one employer, capped at `maxPages` to honour free-tier.
 * Stops early when a page returns fewer results than `resultsPerPage`.
 *
 * @param {object} [params]
 * @param {string} params.company
 * @param {string} [params.country='ch']
 * @param {number} [params.resultsPerPage]
 * @param {number} [params.maxPages]
 * @param {string} [params.appId]
 * @param {string} [params.appKey]
 * @param {string} [params.cacheDir]
 * @param {Function} [params._fetchImpl]
 * @param {string}   [params._cacheDate]
 * @returns {Promise<{ results: Array<object>, liveCalls: number }>}
 */
export async function searchAdzunaAllPages({
  company,
  country = 'ch',
  resultsPerPage = DEFAULT_RESULTS_PER_PAGE,
  maxPages = DEFAULT_MAX_PAGES,
  appId,
  appKey,
  cacheDir,
  _fetchImpl,
  _cacheDate,
} = {}) {
  const all = [];
  let liveCalls = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const { results, _fromCache } = await searchAdzuna({
      company,
      country,
      resultsPerPage,
      page,
      appId,
      appKey,
      cacheDir,
      _fetchImpl,
      _cacheDate,
    });
    if (!_fromCache) liveCalls += 1;
    all.push(...results);
    if (results.length < resultsPerPage) break;
  }
  return { results: all, liveCalls };
}

/**
 * Convert raw Adzuna search results to ParsedJob objects matching the
 * dedicated-crawler shape. Filters out listings whose `company.display_name`
 * does NOT match `employer.match` (free-text Adzuna search is fuzzy).
 *
 * @param {{ results: Array<object> }} rawResponse
 * @param {object} employer
 * @param {string} employer.key                — companyKey (e.g. 'richemont')
 * @param {string} employer.name               — display name (e.g. 'Richemont')
 * @param {string} employer.domain             — primary domain (e.g. 'richemont.com')
 * @param {(displayName: string) => boolean} employer.match — predicate to keep listings
 * @param {string} [employer.sector='Altro']
 * @param {string} [employer.defaultLocation]  — fallback when listing has no location
 * @param {string} [employer.defaultCanton]
 * @param {string} [employer.parserSourceLabel]
 * @returns {Array<object>} ParsedJob[]
 */
export function parseAdzunaJobs(rawResponse, employer) {
  if (!employer || typeof employer !== 'object') {
    throw new Error('parseAdzunaJobs: `employer` is required');
  }
  const {
    key,
    name,
    domain,
    match,
    sector = 'Altro',
    defaultLocation = '',
    defaultCanton = '',
    parserSourceLabel = `${name} Adzuna Fallback`,
  } = employer;
  if (!key || !name || !domain || typeof match !== 'function') {
    throw new Error('parseAdzunaJobs: employer.key/name/domain/match are required');
  }

  const raw = Array.isArray(rawResponse?.results) ? rawResponse.results : [];
  const out = [];
  const seen = new Set();

  for (const listing of raw) {
    const displayName = String(listing?.company?.display_name || '');
    if (!match(displayName)) continue;

    const title = normalizeSpace(listing?.title || '');
    if (!title || title.length < 3) continue;

    const descriptionHtml = listing?.description || '';
    const descriptionText = normalizeSpace(stripHtml(descriptionHtml));

    const locationDisplay = normalizeSpace(
      listing?.location?.display_name ||
        (Array.isArray(listing?.location?.area) ? listing.location.area.join(', ') : '') ||
        defaultLocation,
    );
    const canton = inferSwissTargetCanton(locationDisplay) || defaultCanton || 'CH';

    const redirectUrl = listing?.redirect_url || '';
    if (!redirectUrl) continue;
    let publicUrl;
    try {
      // Validate URL shape early; skip malformed entries.
      publicUrl = new URL(redirectUrl).toString();
    } catch {
      continue;
    }

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${key} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const id = `${key}-${urlHash}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const postedDate = listing?.created
      ? String(listing.created).slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    out.push({
      // ── Required fields ──
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: name,
      companyKey: key,
      companyDomain: domain,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${name}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${name}` },
      location: locationDisplay || defaultLocation || 'Switzerland',
      canton,
      url: publicUrl,
      source: parserSourceLabel,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: locationDisplay || defaultLocation || '',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Altro',
      contract: 'full-time',
      employmentType: 'OTHER',
      experienceLevel: 'mid',
      sector,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  return out;
}

export const ADZUNA_FREE_TIER_MONTHLY_CAP = FREE_TIER_MONTHLY_CAP;
export const ADZUNA_DEFAULT_MAX_PAGES = DEFAULT_MAX_PAGES;
export const ADZUNA_DEFAULT_RESULTS_PER_PAGE = DEFAULT_RESULTS_PER_PAGE;
