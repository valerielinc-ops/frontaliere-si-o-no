#!/usr/bin/env node
/**
 * Dedicated Migros crawler runner.
 * Runs Migros group jobs in Switzerland and enforces full locale coverage
 * for SEO-critical fields.
 *
 * The Migros careers portal at jobs.migros.ch is a Nuxt.js SPA.
 * The listing page is a Nuxt.js SPA, but it also exposes the complete
 * numbered pagination envelope in its server-rendered HTML. The default
 * worker path consumes that envelope over plain HTTP; browser discovery is
 * retained as an explicit escape hatch for a future source rollout.
 *
 * This script:
 *   1. Fetches the unfiltered listing URL over HTTP (no REGION param →
 *      nationwide) and follows each numbered `?page=N` link.
 *   2. Collects every job detail href (any locale prefix) and sets
 *      them as adapter seed URLs.
 *   3. Runs the base crawler which fetches each detail page and
 *      parses the HTML content (no JSON-LD — Migros uses Nuxt
 *      with __NUXT_DATA__ hydration payloads).
 *
 * Set JOBS_MIGROS_DISCOVERY_MODE=browser to use the legacy Playwright
 * discovery path explicitly. Automatic runs default to `http` and therefore
 * do not require CUA/Chromium.
 *
 * Listing URL pattern (unfiltered → nationwide):
 *   https://jobs.migros.ch/it/le-nostre-imprese/gruppo-migros/posti-di-lavoro-vacanti
 *
 * Detail page URL pattern:
 *   https://jobs.migros.ch/{it|de|fr|en}/{le-nostre-imprese|unsere-unternehmen|nos-entreprises|our-companies}/job/{company-slug}/{job-slug}/{uuid}
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { launchChromium } from './lib/ensure-chromium.mjs';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, normalize } from './lib/dedicated-crawler-common.mjs';
import { runQualityGuards } from './lib/crawler-quality-guards.mjs';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { dedicatedMigrosOwner } from './lib/crawler-company-ownership.mjs';
import { positiveIntFromEnv } from './lib/int-from-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const MIGROS_KEY = 'migros-ticino';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(MIGROS_KEY);

/**
 * Migros listing page URL — no REGION filter, so the whole of Switzerland is
 * crawled (all cantons + every Migros group company, incl. Migros Industrie
 * brands like Delica which the REGION taxonomy classified by HQ, not by the
 * job's physical location).
 */
const LISTING_URL =
  'https://jobs.migros.ch/it/le-nostre-imprese/gruppo-migros/posti-di-lavoro-vacanti';

/**
 * Regex matching a Migros job detail href in any of the four locale prefixes.
 * Pattern: /{locale}/{segment}/job/{company-slug}/{job-slug}/{uuid}
 */
const JOB_DETAIL_HREF_RE =
  /^\/(it|de|fr|en)\/(le-nostre-imprese|unsere-unternehmen|nos-entreprises|our-companies)\/job\/[^/]+\/[^/]+\/[a-f0-9-]{36}$/;

const MIGROS_LOCALE_PRIORITY = { it: 0, de: 1 };
const MIGROS_LISTING_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'it-CH,it;q=0.9,de-CH;q=0.8,de;q=0.7,en;q=0.6',
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Match a job object as belonging to the Migros crawl.
 */
function isMigrosJob(job) {
  if (dedicatedMigrosOwner(job)) return false;
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === MIGROS_KEY ||
    key.includes('migros-ticino') ||
    host.includes('jobs.migros.ch') ||
    (company.includes('migros') && (company.includes('ticino') || company.includes('cooperativa'))) ||
    (company.includes('scuola club') && company.includes('migros'))
  );
}

/**
 * Check whether a URL belongs to one of Migros' trusted domains.
 */
function isTrustedMigrosDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('migros.ch') ||
      host.endsWith('migrosticino.ch')
    );
  } catch {
    return false;
  }
}

function migrosLocalePriority(rawUrl) {
  try {
    const locale = new URL(rawUrl).pathname.split('/')[1]?.toLowerCase();
    return MIGROS_LOCALE_PRIORITY[locale] ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Prefer the historical Italian route when the same posting is emitted in
 * more than one locale. Keep the previous lexical tie-breaker for all other
 * locales so discovery remains deterministic without preferring German over
 * Italian by accident.
 */
export function compareMigrosDetailUrls(left, right) {
  const priorityDelta = migrosLocalePriority(left) - migrosLocalePriority(right);
  return priorityDelta || String(left).localeCompare(String(right));
}

function extractMigrosHrefValues(html = '') {
  const hrefs = [];
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = hrefRe.exec(String(html || ''))) !== null) {
    hrefs.push(String(match[1] ?? match[2] ?? '').replaceAll('&amp;', '&'));
  }
  return hrefs;
}

/**
 * Extract canonical job paths from a server-rendered Migros listing page.
 * Mixed-locale links for one posting are intentionally left for the shared
 * identity finalizer to deduplicate.
 */
export function extractMigrosListingDetailPaths(html = '') {
  const paths = new Set();
  for (const href of extractMigrosHrefValues(html)) {
    let url;
    try {
      url = new URL(href, LISTING_URL);
    } catch {
      continue;
    }
    if (url.hostname !== 'jobs.migros.ch' || url.protocol !== 'https:') continue;
    if (JOB_DETAIL_HREF_RE.test(url.pathname)) paths.add(url.pathname);
  }
  return [...paths];
}

/**
 * Read the numbered page links that make the HTTP listing snapshot complete.
 * A page with jobs but no pagination envelope is rejected by the caller
 * instead of silently publishing only the first SSR batch.
 */
export function extractMigrosListingPageNumbers(html = '', listingUrl = LISTING_URL) {
  const seed = new URL(listingUrl);
  const pages = new Set([Number(seed.searchParams.get('page')) || 1]);
  for (const href of extractMigrosHrefValues(html)) {
    let url;
    try {
      url = new URL(href, seed);
    } catch {
      continue;
    }
    if (url.origin !== seed.origin || url.pathname !== seed.pathname) continue;
    const page = Number(url.searchParams.get('page'));
    if (Number.isInteger(page) && page >= 1) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

export function migrosListingPageUrl(listingUrl, page) {
  const url = new URL(listingUrl);
  url.searchParams.set('page', String(page));
  return url.toString();
}

async function readMigrosListingSnapshot(fetched, requestedUrl) {
  if (typeof fetched === 'string') {
    return { body: fetched, status: 200, url: requestedUrl };
  }
  if (fetched && typeof fetched.body === 'string') {
    return {
      body: fetched.body,
      status: Number(fetched.status || 200),
      url: fetched.url || requestedUrl,
    };
  }
  if (fetched && typeof fetched.text === 'function') {
    return {
      body: await fetched.text(),
      status: Number(fetched.status || 200),
      url: fetched.url || requestedUrl,
    };
  }
  throw new Error(`Migros HTTP discovery returned no HTML for ${requestedUrl}`);
}

/**
 * Fetch the default HTTP listing path while retaining the URL after native
 * redirect handling. `fetchHtml()` intentionally returns only HTML to its
 * existing callers, so capture Response.url at its fetch boundary instead of
 * assuming the requested numbered URL was the page that was served.
 */
async function fetchMigrosListingPage(url, options = {}) {
  let finalUrl = '';
  const body = await fetchHtml(url, {
    ...options,
    fetchImpl: async (requestUrl, requestOptions) => {
      const response = await fetch(requestUrl, requestOptions);
      finalUrl = response.url || requestUrl;
      return response;
    },
  });
  return { body, status: 200, url: finalUrl || url };
}

export function migrosListingPageMatchesRequestedUrl(actualUrl, requestedUrl) {
  try {
    const actual = new URL(actualUrl);
    const requested = new URL(requestedUrl);
    const requestedPage = Number(requested.searchParams.get('page')) || 1;
    const actualPage = Number(actual.searchParams.get('page')) || 1;
    return (
      actual.origin === requested.origin &&
      actual.pathname === requested.pathname &&
      actualPage === requestedPage
    );
  } catch {
    return false;
  }
}

/**
 * Discover the complete Migros listing without a browser. The source's SSR
 * page publishes the authoritative numbered pagination links; every declared
 * page is fetched and must contain detail links before finalization.
 */
export async function fetchMigrosHttpJobDetailUrls({
  fetchPage = fetchMigrosListingPage,
  listingUrl = LISTING_URL,
  maxPages = positiveIntFromEnv('JOBS_MIGROS_MAX_PAGES', 1000),
} = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`Migros HTTP discovery requires a positive page cap, got ${maxPages}`);
  }

  const first = await readMigrosListingSnapshot(
    await fetchPage(listingUrl, { headers: MIGROS_LISTING_HEADERS }),
    listingUrl,
  );
  if (first.status < 200 || first.status >= 300 || !first.body) {
    throw new Error(`Migros HTTP discovery failed for ${first.url}: HTTP ${first.status}`);
  }
  if (!migrosListingPageMatchesRequestedUrl(first.url, listingUrl)) {
    throw new Error(`Migros HTTP discovery resolved first page to ${first.url}, expected ${listingUrl}`);
  }

  const pageNumbers = extractMigrosListingPageNumbers(first.body, listingUrl);
  const lastPage = Math.max(...pageNumbers);
  const firstPaths = extractMigrosListingDetailPaths(first.body);
  if (firstPaths.length === 0 && lastPage > 1) {
    throw new Error('Migros HTTP discovery incomplete: first page has no detail links despite pagination');
  }
  if (pageNumbers.length < 2 && firstPaths.length > 0) {
    throw new Error('Migros HTTP discovery is missing authoritative pagination links');
  }
  if (lastPage > maxPages) {
    throw new Error(`Migros HTTP discovery declares ${lastPage} pages, above the safe limit ${maxPages}`);
  }

  const rawPaths = new Set(firstPaths);
  for (let page = 2; page <= lastPage; page += 1) {
    const pageUrl = migrosListingPageUrl(listingUrl, page);
    const snapshot = await readMigrosListingSnapshot(
      await fetchPage(pageUrl, { headers: MIGROS_LISTING_HEADERS }),
      pageUrl,
    );
    if (snapshot.status < 200 || snapshot.status >= 300 || !snapshot.body) {
      throw new Error(`Migros HTTP discovery failed for page ${page}: HTTP ${snapshot.status}`);
    }
    if (!migrosListingPageMatchesRequestedUrl(snapshot.url, pageUrl)) {
      throw new Error(`Migros HTTP discovery resolved page ${page} to ${snapshot.url}, expected ${pageUrl}`);
    }
    const paths = extractMigrosListingDetailPaths(snapshot.body);
    if (paths.length === 0) {
      throw new Error(`Migros HTTP discovery incomplete: page ${page} has no detail links`);
    }
    for (const path of paths) rawPaths.add(path);
  }

  return finalizeMigrosDiscovery([...rawPaths], {
    termination: 'http-pagination',
    pagesFetched: lastPage,
    maxPages,
  });
}

// ──────────────────────────────────────────────────────────────
// Listing page fetching
// ──────────────────────────────────────────────────────────────

/**
 * Discover Migros job detail URLs via headless Chromium (Playwright).
 *
 * The listing is a Nuxt.js SPA: SSR only renders ~7 pinned jobs; the full
 * search result set is populated after client-side hydration, and pagination
 * is driven by a "Pagina successiva" button (no query-string paging).
 *
 * This function:
 *   1. Opens the unfiltered listing (no REGION param → nationwide) in Chromium.
 *   2. Accepts the OneTrust cookie banner (required — without it, the results
 *      panel renders only a handful of "suggested" jobs).
 *   3. Collects every anchor matching {locale}/{segment}/job/... .
 *   4. Clicks "Pagina successiva" until disabled, merging results each time.
 *
 * Returns absolute job detail URLs in whatever locale Migros served them
 * (mixed IT/DE is normal — individual job sourceLang is detected downstream).
 */
export async function fetchMigrosJobDetailUrls() {
  const headless = process.env.JOBS_MIGROS_HEADLESS !== '0';
  const navTimeoutMs = Number(process.env.JOBS_MIGROS_NAV_TIMEOUT_MS) || 30000;
  const paginationTimeoutMs = Number(process.env.JOBS_MIGROS_PAGINATION_TIMEOUT_MS) || 2000;
  // How many times to re-poll the DOM (waiting paginationTimeoutMs each time)
  // before concluding a freshly-clicked page genuinely added no new URLs. On a
  // slow CI render (>paginationTimeoutMs) the next page can still show the
  // previous page's anchors after a single wait → a bare `added===0` break
  // would terminate early and silently under-collect. Re-polling absorbs the
  // render lag; only a page that stays empty across every poll is terminal.
  const paginationStallPolls = Math.max(
    1,
    Number(process.env.JOBS_MIGROS_PAGINATION_STALL_POLLS) || 4,
  );
  // Uncapped: the loop below already terminates naturally when a page adds no
  // new URLs or the "next" button disappears, so this only guards against a
  // runaway pagination control. Was 25 → silently dropped ~380 of 1180 jobs.
  const maxPages = positiveIntFromEnv('JOBS_MIGROS_MAX_PAGES', 1000);

  const browser = await launchChromium({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'it-CH',
    viewport: { width: 1400, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'it-CH,it;q=0.9' },
  });
  const page = await context.newPage();

  const allUrls = new Set();
  let termination = '';
  let pageIdx = 1;

  try {
    console.log(`🔍 Opening Migros listing (${LISTING_URL})`);
    await page.goto(LISTING_URL, { waitUntil: 'networkidle', timeout: navTimeoutMs });

    // Accept cookies — without this the results panel stays at ~4 suggested items
    const consent = page
      .locator(
        'button:has-text("Accetta tutti i cookie"), #onetrust-accept-btn-handler, button:has-text("Accetta")',
      )
      .first();
    if (await consent.isVisible().catch(() => false)) {
      await consent.click().catch(() => {});
      await page.waitForTimeout(1500);
      console.log('  🍪 Cookie consent accepted');
    }

    // Wait for hydration — result panel populates a second or two after consent
    await page.waitForTimeout(3000);

    const collect = () =>
      page.evaluate((reSrc) => {
        const re = new RegExp(reSrc);
        const out = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const p = a.getAttribute('href');
          if (p && re.test(p)) out.add(p);
        }
        return [...out];
      }, JOB_DETAIL_HREF_RE.source);

    for (const u of await collect()) allUrls.add(u);
    console.log(`  📄 Page ${pageIdx}: ${allUrls.size} unique URLs so far`);

    while (pageIdx < maxPages) {
      const nextBtn = page
        .locator('button[aria-label*="successiva" i], button:has-text("Pagina successiva")')
        .first();

      const visible = await nextBtn.isVisible().catch(() => false);
      const disabled = await nextBtn.isDisabled().catch(() => true);
      if (!visible || disabled) {
        termination = visible ? 'next-disabled' : 'next-unavailable';
        break;
      }

      await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await nextBtn.click();
      } catch (err) {
        throw new Error(
          `Migros discovery incomplete at page ${pageIdx}: next control click failed (${err?.message || err}).`,
        );
      }
      pageIdx += 1;

      // Re-poll the DOM until the clicked page actually renders new anchors.
      // A single waitForTimeout races the SPA's async re-render: on a slow CI
      // render the page still shows the previous anchors, so collecting once
      // and breaking on added===0 under-collects. Only break once every poll
      // (paginationStallPolls × paginationTimeoutMs) comes back empty.
      const before = allUrls.size;
      let added = 0;
      for (let poll = 0; poll < paginationStallPolls; poll += 1) {
        await page.waitForTimeout(paginationTimeoutMs);
        for (const u of await collect()) allUrls.add(u);
        added = allUrls.size - before;
        if (added > 0) break;
      }
      if (added === 0) {
        // The fixed poll budget above can still be mid-render on a genuinely
        // slow (but real) last page. Give it one more chance keyed on actual
        // network activity instead of another fixed wait: a page still
        // fetching/rendering blocks here until it settles (bounded by
        // paginationTimeoutMs); a page that is truly done (the real stall
        // case) is already idle and this resolves immediately, changing
        // nothing. This is what tells "slow" apart from "stalled".
        await page.waitForLoadState('networkidle', { timeout: paginationTimeoutMs }).catch(() => {});
        for (const u of await collect()) allUrls.add(u);
        added = allUrls.size - before;
      }
      console.log(`  📄 Page ${pageIdx}: +${added} (${allUrls.size} total)`);
      if (added === 0) {
        const stillVisible = await nextBtn.isVisible().catch(() => false);
        const nowDisabled = await nextBtn.isDisabled().catch(() => true);
        if (stillVisible && !nowDisabled) {
          throw new Error(`Migros discovery incomplete: page ${pageIdx} stalled while the next-page control remained enabled.`);
        }
        termination = stillVisible ? 'next-disabled' : 'next-unavailable';
        break;
      }
    }
  } finally {
    await browser.close();
  }

  // Exclude Migros-Genossenschafts-Bund (HQ) postings — owned exclusively by
  // the dedicated `migros-hq` crawler (scripts/lib/migros-hq-job-parser.mjs)
  // since #3797. Without this filter the same job URL gets crawled here too
  // (this nationwide listing has no per-company filter — see LISTING_URL
  // above) and re-tagged under company="Migros Ticino", producing a literal
  // duplicate posting: assemble-jobs-dataset.mjs's dedup key is the raw URL
  // (scripts/lib/job-url-key.mjs:assembleUrlKey), which does not normalize
  // away the locale-prefix differences between the two crawlers' URLs, so
  // the two copies would not collapse into one.
  return finalizeMigrosDiscovery([...allUrls], { termination, pagesFetched: pageIdx, maxPages });
}

/**
 * @param {string[]} rawPaths
 * @param {{ termination?: string, pagesFetched?: number, maxPages?: number }} options
 */
export function finalizeMigrosDiscovery(rawPaths, options = {}) {
  const { termination = '', pagesFetched = 0, maxPages = 1000 } = options;
  if (!['next-disabled', 'next-unavailable', 'http-pagination'].includes(termination)
      || !Number.isInteger(pagesFetched) || pagesFetched < 1 || pagesFetched > maxPages) {
    throw new Error(`Migros discovery incomplete: reached JOBS_MIGROS_MAX_PAGES=${maxPages} without terminal pagination state.`);
  }
  const absoluteCandidates = rawPaths
    .map((p) => `https://jobs.migros.ch${p}`)
    .filter((u) => !dedicatedMigrosOwner(u));
  const byIdentity = new Map();
  let duplicateIdentity = 0;
  for (const url of absoluteCandidates) {
    const parsed = new URL(url);
    const match = parsed.pathname.match(JOB_DETAIL_HREF_RE);
    const identity = match ? parsed.pathname.split('/').pop()?.toLowerCase() : '';
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'jobs.migros.ch' || !identity) {
      throw new Error(`Migros discovery invariant failed: non-canonical detail URL ${url}.`);
    }
    if (byIdentity.has(identity)) {
      duplicateIdentity += 1;
      if (compareMigrosDetailUrls(url, byIdentity.get(identity)) < 0) {
        byIdentity.set(identity, url);
      }
    } else {
      byIdentity.set(identity, url);
    }
  }
  const absoluteUrls = [...byIdentity.values()].sort(compareMigrosDetailUrls);
  const excludedDedicated = rawPaths.length - absoluteCandidates.length;
  if (absoluteUrls.length + duplicateIdentity + excludedDedicated !== rawPaths.length) {
    throw new Error(`Migros discovery accounting failed: raw=${rawPaths.length}, canonical=${absoluteUrls.length}, duplicates=${duplicateIdentity}, dedicated=${excludedDedicated}.`);
  }
  const result = {
    urls: absoluteUrls,
    sourceZero: absoluteUrls.length === 0,
    termination,
    pagesFetched,
    rawUniqueUrls: rawPaths.length,
    duplicateIdentity,
    excludedDedicated,
  };
  console.log(`✅ Total unique Migros detail URLs discovered: ${absoluteUrls.length}`);
  return result;
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the Migros adapter JSON has the correct seed URLs
 * (detail page URLs discovered from the listing page).
 */
export function buildMigrosAdapterConfig(baseAdapter, seedUrls, updatedAt = new Date().toISOString()) {
  return {
    ...(baseAdapter || {}),
    companyHost: 'jobs.migros.ch',
    seedUrls,
    priority: Math.max(baseAdapter?.priority || 0, 10),
    crawlerModes: Array.from(new Set(['generic_ats', ...(baseAdapter?.crawlerModes || []), 'html']))
      .filter((mode) => mode !== 'jsonld'),
    notes: 'Nuxt.js SSR careers portal — detail URLs scraped from listing pages, each page has rich HTML content.',
    updatedAt,
  };
}

export function assertMigrosAdapterParity(adapter, seedUrls) {
  if (!isDeepStrictEqual(adapter?.seedUrls, seedUrls) || adapter?.crawlerModes?.includes('jsonld')) {
    throw new Error('Migros adapter parity failed: persisted seeds or crawler modes differ from the complete SPA listing.');
  }
  return true;
}

export function ensureAdapterSeedUrls(
  seedUrls,
  adapterPath = path.join(ADAPTERS_DIR, `${MIGROS_KEY}.json`),
  updatedAt = new Date().toISOString(),
) {
  const baseAdapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {
      companyKey: MIGROS_KEY,
      companyName: 'Migros Ticino',
      companyHost: 'jobs.migros.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html'],
    };
  const adapter = buildMigrosAdapterConfig(baseAdapter, seedUrls, updatedAt);
  writeJsonAtomic(adapterPath, adapter);
  const persisted = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  assertMigrosAdapterParity(persisted, seedUrls);
  console.log(`📝 Adapter ${MIGROS_KEY} updated with ${seedUrls.length} seed URLs (listing parity verified).`);
  return persisted;
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MIGROS_KEY,
    localizeOnlyCompanyKeys: MIGROS_KEY,
    forceLocalizationWhenAiEnabledOnly: true,
    disableWorkdayForce: true,
  });
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logMigrosJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const migrosJobs = allJobs.filter(isMigrosJob);
  const byCanton = new Map();
  for (const job of migrosJobs) {
    const canton = normalize(job?.canton).toUpperCase() || '??';
    byCanton.set(canton, (byCanton.get(canton) || 0) + 1);
  }

  console.log(`\n📊 === Migros Switzerland Job Stats ===`);
  console.log(`  🛒 Job totali trovati (Migros): ${migrosJobs.length}`);
  console.log(`  🗺️ Distribuzione per cantone: ${[...byCanton.entries()].sort().map(([canton, count]) => `${canton}=${count}`).join(', ') || 'nessun cantone rilevato'}`);
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(migrosJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Migros');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Migros');

  return { total: migrosJobs.length, crawlDiff };

}

function validateMigrosLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MIGROS_STRICT',
    label: 'Migros',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isMigrosJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedMigrosDomain,
    untrustedDomainReason: 'untrusted_domain_for_migros_job',
    noJobsMessage: 'Nessun job Migros trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(MIGROS_KEY, 'Migros');
  console.log('🛒 Running dedicated Migros Switzerland jobs crawler...');
  console.log('   Platform: Nuxt.js SSR listing (jobs.migros.ch) via HTTP');
  console.log('   Scope: nationwide (no REGION filter — all Swiss cantons)');
  console.log('');

  // Step 1: Fetch job detail URLs from the SSR listing pages. HTTP is the
  // browser-free default; Playwright remains an explicit escape hatch for a
  // future source rollout that removes numbered SSR links.
  const discoveryMode = process.env.JOBS_MIGROS_DISCOVERY_MODE || 'http';
  if (!['http', 'browser'].includes(discoveryMode)) {
    throw new Error(`Unsupported JOBS_MIGROS_DISCOVERY_MODE=${discoveryMode}; use http or browser`);
  }
  const discovery = discoveryMode === 'browser'
    ? await fetchMigrosJobDetailUrls()
    : await fetchMigrosHttpJobDetailUrls();
  const detailUrls = discovery.urls;
  if (discovery.sourceZero) {
    console.log('ℹ️ Nessun URL di dettaglio Migros trovato dalla listing. Uscita OK.');
    return;
  }

  // Step 2: Update the adapter with the discovered detail URLs as seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(MIGROS_KEY, DATA_JOBS).filter(isMigrosJob))

  // Step 3: Run the base crawler which fetches each SSR detail page
  // and parses the HTML content
  await runBaseCrawler();

  // Step 3b: Ensure sourceLang is set on all Migros jobs
  {
    const raw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
    const allJobs = Array.isArray(raw) ? raw : [];
    let patched = 0;
    for (const job of allJobs) {
      if (!isMigrosJob(job)) continue;
      if (!job.sourceLang) {
        job.sourceLang = detectLang(job.description || job.title, 'it');
        patched++;
      }
    }
    if (patched > 0) {
      writeJsonAtomic(DATA_JOBS, allJobs);
      console.log(`  🏷️ Set sourceLang on ${patched} Migros job(s).`);
    }
  }

  // Step 3c: Quality guards — reject jobs with thin descriptions only.
  // No company-name allowlist: every job here already passed isMigrosJob
  // (host jobs.migros.ch, L97), so Migros-group membership is proven by the
  // trusted domain. An allowlist adds no anti-hallucination value on a trusted
  // domain and only produces false negatives nationwide — it silently dropped
  // legitimate group brands that don't contain "Migros" (Delica, medbase,
  // m-way, Micasa, Voi, OBI, Do it + Garden, …). Gated behind
  // SKIP_QUALITY_GUARDS=1 for emergency bypass.
  if (process.env.SKIP_QUALITY_GUARDS !== '1') {
    const raw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
    const allJobs = Array.isArray(raw) ? raw : [];
    const migrosJobs = allJobs.filter(isMigrosJob);
    const report = runQualityGuards(migrosJobs, {
      minDescription: 200,
      logger: (msg) => console.warn(msg),
    });
    if (report.rejected > 0) {
      const keptIds = new Set(migrosJobs.map((j) => j.id || j.url));
      const filtered = allJobs.filter((j) => !isMigrosJob(j) || keptIds.has(j.id || j.url));
      writeJsonAtomic(DATA_JOBS, filtered);
      console.log(
        `  🧹 Migros quality guards: rejected ${report.rejected} job(s) — ${JSON.stringify(report.reasons)}`,
      );
    }
  }

  // Step 4: Log stats and validate
  const stats = logMigrosJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Migros trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateMigrosLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isMigrosJob) : [];
  writeJobsCrawlerSlice(MIGROS_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MIGROS_KEY,
    label: 'Migros',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Migros'));
}
