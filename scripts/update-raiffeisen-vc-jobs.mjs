#!/usr/bin/env node
/**
 * Dedicated Banca Raiffeisen Vedeggio Cassarate crawler runner.
 *
 * The bank's careers page is at:
 *   https://www.raiffeisen.ch/vedeggio-cassarate/it/chi-siamo/carriera/lavorare-banca-raiffeisen.html
 *
 * Job detail pages are hosted on Prospective.ch career center:
 *   https://jobs.raiffeisen.ch/posti-vacanti/{slug}/{uuid}
 *
 * Each job detail page contains JSON-LD JobPosting structured data with
 * hiringOrganization = "Banca Raiffeisen Vedeggio Cassarate".
 *
 * This crawler:
 *   1. Scrapes the local bank's careers page for jobs.raiffeisen.ch links.
 *   2. Writes discovered URLs as seed URLs in the adapter.
 *   3. Runs the shared base crawler (which parses JSON-LD from detail pages).
 *   4. Translates and validates locale coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseRaiffeisenDetailPage,
  htmlToText,
  MIN_DESC_LENGTH,
} from './lib/raiffeisen-vc-job-parser.mjs';
import { JSDOM } from 'jsdom';
import { markAuthoritativeEmptySnapshot } from './lib/authoritative-empty-snapshot.mjs';
import { holdSourceLang } from './lib/job-locale-utils.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const RAIFF_KEY = 'banca-raiffeisen-vedeggio-cassarate';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(RAIFF_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const HQ = getCompanyDefaults('raiffeisen-vc');
const RAIFF_COMPANY_NAME = 'Banca Raiffeisen Vedeggio Cassarate';
const RAIFF_HOST = 'www.raiffeisen.ch';
const RAIFF_JOBS_HOST = 'jobs.raiffeisen.ch';
const RAIFF_PROSPECTIVE_API = 'https://ohws.prospective.ch/public/v1/medium/1950/jobs';
const RAIFF_PROSPECTIVE_API_LANGS = ['it', 'de'];
const RAIFF_PROSPECTIVE_PAGE_SIZE = 100;
const RAIFF_PROSPECTIVE_QUERY = 'Vedeggio Cassarate';

const CAREERS_URLS = [
  'https://www.raiffeisen.ch/vedeggio-cassarate/it/chi-siamo/carriera/lavorare-banca-raiffeisen.html',
  'https://www.raiffeisen.ch/vedeggio-cassarate/de/ueber-uns/karriere-stellen.html',
];

const LISTING_COUNT_SELECTOR = '.listing-count';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isRaiffeisenVCJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === RAIFF_KEY ||
    key === 'raiffeisen-vedeggio-cassarate' ||
    (company.includes('raiffeisen') && company.includes('vedeggio')) ||
    (company.includes('raiffeisen') && company.includes('cassarate')) ||
    (host === RAIFF_JOBS_HOST && url.includes('vedeggio'))
  );
}

function hasExplicitEmptyListingState(html) {
  const document = new JSDOM(String(html || '')).window.document;
  const candidates = [...document.querySelectorAll(LISTING_COUNT_SELECTOR)];
  const countValues = candidates.map((element) => {
    const text = htmlToText(element.innerHTML || element.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text === '0' ? 0 : null;
  });

  // Only the site's structural listing-count node can authorize zero. Missing,
  // duplicated, or non-exact count markup fails closed and preserves prior jobs.
  return countValues.length === 1 && countValues[0] === 0;
}

const AUTHORITATIVE_EMPTY_EVIDENCE =
  'Both bilingual Raiffeisen Vedeggio Cassarate careers pages were reachable, carried the bank identity, '
  + 'and explicitly reported zero open positions.';

/**
 * Build the persisted result for a verified source zero.
 *
 * A plain empty array is intentionally not enough: the health monitor must be
 * able to distinguish a proven empty employer from the exit-guard placeholder
 * written when a crawler stops before publishing a result.
 */
export function buildRaiffeisenAuthoritativeEmptySnapshot(
  priorJobs = [],
  generatedAt = new Date().toISOString(),
  durationMs = getCrawlerElapsedMs(),
) {
  const priorTargetJobs = (Array.isArray(priorJobs) ? priorJobs : []).filter(isRaiffeisenVCJob);
  const crawlDiff = computeCrawlDiff(snapshotJobSlugs(priorTargetJobs), new Map());
  const jobs = markAuthoritativeEmptySnapshot([], AUTHORITATIVE_EMPTY_EVIDENCE);
  return {
    jobs,
    crawlDiff,
    summary: {
      key: RAIFF_KEY,
      label: 'Raiffeisen VC',
      generatedAt,
      total: 0,
      discovered: 0,
      parsed: 0,
      written: 0,
      authoritativeEmptySnapshot: true,
      authoritativeSnapshotVerified: true,
      newCount: 0,
      updatedCount: 0,
      removedCount: crawlDiff.removedJobs.length,
      unchangedCount: 0,
      durationMs,
      avgDurationMs: durationMs,
      durationHistory: [durationMs],
      newJobs: [],
      updatedJobs: [],
      removedJobs: crawlDiff.removedJobs.slice(0, 30),
      unchangedJobs: [],
    },
  };
}

/* ── Discovery ─────────────────────────────────────────────── */
function addRaiffeisenDetailUrl(byIdentity, href) {
  let parsed;
  try {
    parsed = new URL(String(href || ''));
  } catch {
    throw new Error(`Raiffeisen VC discovery invariant failed: invalid detail URL ${href}.`);
  }
  const detailMatch = parsed.pathname.match(
    /^\/(posti-vacanti|offene-stellen|postes-vacants|open-positions)\/[^/]+\/([0-9a-f-]{20,})\/?$/i,
  );
  if (parsed.protocol !== 'https:' || parsed.hostname !== RAIFF_JOBS_HOST
      || !detailMatch || parsed.search || parsed.hash) {
    throw new Error(`Raiffeisen VC discovery invariant failed: non-canonical detail URL ${href}.`);
  }
  const identity = detailMatch[2].toLowerCase();
  if (byIdentity.has(identity)) {
    if (String(href).localeCompare(byIdentity.get(identity)) < 0) {
      byIdentity.set(identity, String(href));
    }
    return { duplicate: true, identity };
  }
  byIdentity.set(identity, String(href));
  return { duplicate: false, identity };
}

function isVerifiedRaiffeisenVCListing(listing) {
  let haystack = '';
  try {
    haystack = JSON.stringify(listing || {}).toLowerCase();
  } catch {
    return false;
  }
  return haystack.includes('vedeggio') && haystack.includes('cassarate');
}

function prospectiveListingIdentity(listing) {
  for (const value of [listing?.id, listing?.hk_id, listing?.viewkey, listing?.links?.directlink]) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

async function fetchRaiffeisenProspectivePage(lang, offset, options = {}) {
  const params = new URLSearchParams({
    lang,
    q: RAIFF_PROSPECTIVE_QUERY,
    offset: String(offset),
    limit: String(RAIFF_PROSPECTIVE_PAGE_SIZE),
  });
  const url = `${RAIFF_PROSPECTIVE_API}?${params}`;
  let raw;
  try {
    raw = await fetchHtml(url, {
      fetchImpl: options.fetchImpl || globalThis.fetch,
      timeoutMs: options.timeoutMs,
      headers: { Accept: 'application/json', 'User-Agent': UA },
      retries: options.retries,
      retryBaseMs: options.retryBaseMs,
      label: `Raiffeisen VC Prospective API ${lang} offset=${offset}`,
    });
  } catch (err) {
    throw new Error(
      `Raiffeisen VC discovery failed: Prospective API ${lang} offset=${offset} fetch failed: ${err.message}`,
      { cause: err },
    );
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Raiffeisen VC discovery failed: Prospective API ${lang} offset=${offset} returned invalid JSON.`,
      { cause: err },
    );
  }
  const total = Number(data?.total);
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(data?.jobs)) {
    throw new Error(`Raiffeisen VC discovery failed: Prospective API ${lang} returned an invalid jobs payload.`);
  }
  return { total, jobs: data.jobs, url };
}

/**
 * The local bilingual pages now link only to the JavaScript portal. The portal
 * keeps the authoritative listings in the public Prospective medium API, so
 * use its exact employer search as a fail-closed discovery fallback.
 */
async function fetchProspectiveDetailUrls(options = {}) {
  const byIdentity = new Map();
  let matchedListings = 0;
  let apiResults = 0;

  for (const lang of RAIFF_PROSPECTIVE_API_LANGS) {
    let offset = 0;
    let declaredTotal = null;
    const seen = new Set();
    let firstPage = true;

    while (firstPage || offset < declaredTotal) {
      firstPage = false;
      const page = await fetchRaiffeisenProspectivePage(lang, offset, options);
      apiResults += page.jobs.length;
      if (declaredTotal !== null && page.total !== declaredTotal) {
        throw new Error(
          `Raiffeisen VC discovery failed: Prospective API ${lang} total changed `
          + `${declaredTotal} → ${page.total} during pagination.`,
        );
      }
      declaredTotal = page.total;

      if (page.jobs.length === 0) {
        if (seen.size !== declaredTotal) {
          throw new Error(
            `Raiffeisen VC discovery failed: Prospective API ${lang} pagination incomplete `
            + `(${seen.size}/${declaredTotal}).`,
          );
        }
        break;
      }
      if (page.jobs.length > RAIFF_PROSPECTIVE_PAGE_SIZE) {
        throw new Error(`Raiffeisen VC discovery failed: Prospective API ${lang} returned an oversized page.`);
      }

      for (const [index, listing] of page.jobs.entries()) {
        const identity = prospectiveListingIdentity(listing);
        if (!identity) {
          throw new Error(
            `Raiffeisen VC discovery failed: Prospective API ${lang} listing ${index} has no stable identity.`,
          );
        }
        seen.add(identity);
        if (!isVerifiedRaiffeisenVCListing(listing)) continue;
        matchedListings += 1;
        const href = listing?.links?.directlink;
        if (!href) {
          throw new Error(
            `Raiffeisen VC discovery failed: Prospective API ${lang} target listing ${identity} has no detail URL.`,
          );
        }
        addRaiffeisenDetailUrl(byIdentity, href);
      }

      offset += page.jobs.length;
      if (offset > declaredTotal) {
        throw new Error(
          `Raiffeisen VC discovery failed: Prospective API ${lang} pagination exceeded `
          + `the declared total (${offset}/${declaredTotal}).`,
        );
      }
      if (page.jobs.length < RAIFF_PROSPECTIVE_PAGE_SIZE && offset < declaredTotal) {
        throw new Error(
          `Raiffeisen VC discovery failed: Prospective API ${lang} pagination incomplete `
          + `(${seen.size}/${declaredTotal}).`,
        );
      }
    }

    if (seen.size !== declaredTotal) {
      throw new Error(
        `Raiffeisen VC discovery failed: Prospective API ${lang} pagination incomplete `
        + `(${seen.size}/${declaredTotal}).`,
      );
    }
    console.log(`   ✅ Prospective ${lang}: ${declaredTotal} matching listing(s), ${byIdentity.size} unique detail URL(s)`);
  }

  if (apiResults > 0 && matchedListings === 0) {
    throw new Error(
      'Raiffeisen VC discovery failed: Prospective employer search returned listings, '
      + 'but none carried a verified Vedeggio Cassarate identity marker.',
    );
  }
  return { byIdentity, sourceZero: apiResults === 0, matchedListings };
}

/**
 * Scrape the Raiffeisen Vedeggio Cassarate careers pages for
 * jobs.raiffeisen.ch links (Prospective career center). The current pages are
 * a client-rendered shell; when they expose no detail URLs, the public
 * Prospective medium API is used as the source-backed fallback.
 */
export async function fetchJobUrls(options = {}) {
  const timeoutMs = Number(options.timeoutMs) || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const byIdentity = new Map();
  let duplicateIdentity = 0;
  let pagesSucceeded = 0;
  let emptyStatePages = 0;

  for (const pageUrl of CAREERS_URLS) {
    console.log(`🔍 Fetching: ${pageUrl}`);
    try {
      const html = await fetchHtml(pageUrl, {
        fetchImpl,
        timeoutMs,
        headers: { Accept: 'text/html', 'User-Agent': UA },
        retries: options.retries,
        retryBaseMs: options.retryBaseMs,
        label: `Raiffeisen VC discovery ${pageUrl}`,
      });
      if (!/vedeggio-cassarate/i.test(html) || !/raiffeisen/i.test(html)) {
        throw new Error(`Raiffeisen VC discovery failed: careers page identity marker missing (${pageUrl}).`);
      }
      pagesSucceeded += 1;
      if (hasExplicitEmptyListingState(html)) emptyStatePages += 1;

      // Extract all jobs.raiffeisen.ch links (Prospective career center)
      const hrefPattern = /href="(https?:\/\/jobs\.raiffeisen\.ch\/[^"]+)"/g;
      let match;
      while ((match = hrefPattern.exec(html)) !== null) {
        const href = match[1];
        // Only include detail pages (posti-vacanti / offene-stellen / postes-vacants)
        // Skip the main portal link (/?lang=...)
        if (href.includes('/posti-vacanti/') ||
            href.includes('/offene-stellen/') ||
            href.includes('/postes-vacants/') ||
            href.includes('/open-positions/')) {
          const { duplicate } = addRaiffeisenDetailUrl(byIdentity, href);
          if (duplicate) duplicateIdentity += 1;
        }
      }
    } catch (err) {
      if (String(err?.message || '').startsWith('Raiffeisen VC discovery')) throw err;
      throw new Error(`Raiffeisen VC discovery failed for ${pageUrl}: ${err.message}`, { cause: err });
    }
  }

  if (pagesSucceeded !== CAREERS_URLS.length) {
    throw new Error(`Raiffeisen VC discovery incomplete: careers pages ${pagesSucceeded}/${CAREERS_URLS.length}.`);
  }
  let apiQueried = false;
  let apiSourceZero = false;
  if (byIdentity.size === 0 && emptyStatePages !== CAREERS_URLS.length) {
    console.log('🔍 Careers shell exposed no detail URLs; querying the Prospective employer feed…');
    let apiDiscovery;
    try {
      apiDiscovery = await fetchProspectiveDetailUrls(options);
    } catch (err) {
      throw new Error(
        'Raiffeisen VC discovery failed: both branded careers pages exposed no detail URLs '
        + 'and neither the explicit zero-open-positions marker nor the Prospective employer feed '
        + `proved zero open positions. ${err.message}`,
        { cause: err },
      );
    }
    apiQueried = true;
    apiSourceZero = apiDiscovery.sourceZero;
    for (const [identity, href] of apiDiscovery.byIdentity) {
      if (byIdentity.has(identity)) {
        duplicateIdentity += 1;
        if (href.localeCompare(byIdentity.get(identity)) < 0) byIdentity.set(identity, href);
      } else {
        byIdentity.set(identity, href);
      }
    }
  }

  const urls = [...byIdentity.values()].sort((a, b) => a.localeCompare(b));
  const sourceZero = urls.length === 0
    && (emptyStatePages === CAREERS_URLS.length || (apiQueried && apiSourceZero));
  if (urls.length === 0 && !sourceZero) {
    throw new Error(
      'Raiffeisen VC discovery failed: both branded careers pages exposed no detail URLs '
      + 'and neither the listing marker nor the Prospective employer feed proved zero open positions.',
    );
  }
  if (urls.length === 0) {
    console.log(`✅ Raiffeisen VC source explicitly reports 0 open positions`);
  }
  console.log(`✅ Discovered ${urls.length} Raiffeisen VC job detail URLs`);
  return {
    urls,
    sourceZero,
    pagesSucceeded,
    duplicateIdentity,
    emptyStatePages,
    apiQueried,
  };
}

/* ── Detail page fetching ──────────────────────────────────── */
/**
 * Fetch a single Raiffeisen detail page and return its parsed body.
 * Returns null on fetch failure or parse failure.
 *
 * @param {string} url
 * @returns {Promise<import('./lib/raiffeisen-vc-job-parser.mjs').ReturnType<typeof parseRaiffeisenDetailPage> | null>}
 */
async function fetchDetailBody(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  try {
    const html = await fetchHtml(url, {
      timeoutMs,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      label: `Raiffeisen VC detail ${url}`,
    });
    const parsed = parseRaiffeisenDetailPage(html);
    for (const w of parsed.warnings) {
      console.warn(`   ⚠️  ${url}: ${w}`);
    }
    return parsed;
  } catch (err) {
    console.warn(`   ⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch each detail page and update the matching job's description if the
 * freshly-parsed body is more complete than what's already stored.
 *
 * A "more complete" description is one that is longer than the stored version
 * by more than 10% — this avoids spurious rewrites while still catching the
 * case where the base crawler stored only a short summary.
 *
 * @param {string[]} urls - detail page URLs
 * @returns {Promise<Map<string, {descriptionText: string, title: string, workload: string}>>}
 *   Map from canonical URL to extracted body data.
 */
async function enrichJobsWithDetailBody(urls) {
  const results = new Map();
  console.log(`\n📖 Fetching ${urls.length} detail page(s) for full body extraction…`);

  for (const url of urls) {
    const parsed = await fetchDetailBody(url);
    if (!parsed || !parsed.valid) {
      console.warn(`   ⚠️  ${url}: detail body extraction failed or too short — skipped`);
      continue;
    }
    results.set(url, parsed);
    console.log(
      `   ✅ ${url.replace(/.*\//, '')} — ` +
      `"${parsed.title}" ${parsed.workload} · ${parsed.descriptionText.length} chars`
    );
  }

  return results;
}

/* ── Adapter ───────────────────────────────────────────────── */
function buildRaiffeisenSeedMeta(seedUrls) {
  // Build seedMetaByUrl so the base crawler knows the local bank's Swiss site
  // (avoids false-positive rejection from Italian-language descriptions
  // containing substrings that match foreign location markers).
  const seedMetaByUrl = {};
  for (const u of seedUrls) {
    seedMetaByUrl[u] = { canton: HQ.canton, location: 'Gravesano' };
  }
  return seedMetaByUrl;
}

export function buildRaiffeisenAdapterConfig(baseAdapter, seedUrls, updatedAt = new Date().toISOString()) {
  return {
    ...(baseAdapter || {}),
    seedUrls,
    seedMetaByUrl: buildRaiffeisenSeedMeta(seedUrls),
    updatedAt,
  };
}

export function assertRaiffeisenAdapterParity(adapter, seedUrls) {
  if (!isDeepStrictEqual(adapter?.seedUrls, seedUrls)
      || !isDeepStrictEqual(adapter?.seedMetaByUrl, buildRaiffeisenSeedMeta(seedUrls))) {
    throw new Error('Raiffeisen VC adapter parity failed: persisted seeds differ from the verified bilingual careers pages.');
  }
  return true;
}

export function ensureAdapterSeedUrls(
  seedUrls,
  adapterPath = path.join(ADAPTERS_DIR, `${RAIFF_KEY}.json`),
  updatedAt = new Date().toISOString(),
) {
  const baseAdapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {
      companyKey: RAIFF_KEY,
      companyName: RAIFF_COMPANY_NAME,
      companyHost: RAIFF_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      notes: 'Banca Raiffeisen Vedeggio Cassarate — local cooperative bank with postings at Gravesano (TI). Jobs on Prospective career center (jobs.raiffeisen.ch). Seed URLs auto-discovered from careers page.',
    };
  const adapter = buildRaiffeisenAdapterConfig(baseAdapter, seedUrls, updatedAt);
  writeJsonAtomic(adapterPath, adapter);
  const persisted = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  assertRaiffeisenAdapterParity(persisted, seedUrls);
  console.log(`📝 Adapter ${RAIFF_KEY} updated with ${seedUrls.length} seed URLs (bilingual listing parity verified).`);
  return persisted;
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: RAIFF_KEY,
    localizeOnlyCompanyKeys: RAIFF_KEY,
    forceLocalizeKeys: RAIFF_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
    },
  });
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const jobs = allJobs.filter(isRaiffeisenVCJob);
  const cantonCounts = jobs.reduce((counts, job) => {
    const canton = normalize(job?.canton).toUpperCase() || '??';
    counts[canton] = (counts[canton] || 0) + 1;
    return counts;
  }, {});

  console.log(`\n📊 === Raiffeisen Vedeggio Cassarate Job Stats ===`);
  console.log(`  🏦 Total jobs: ${jobs.length}`);
  console.log(`  📍 By canton: ${Object.entries(cantonCounts).sort(([a], [b]) => a.localeCompare(b)).map(([canton, count]) => `${canton}=${count}`).join(' | ') || 'none'}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Raiffeisen VC');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Raiffeisen VC');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RAIFFEISEN_VC_STRICT',
    label: 'Raiffeisen VC',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isRaiffeisenVCJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    noJobsMessage: 'No Raiffeisen Vedeggio Cassarate jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Description patching ──────────────────────────────────── */
function ensureSourceLang() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = 0;
  for (const job of jobs) {
    if (!isRaiffeisenVCJob(job)) continue;
    const heldLang = holdSourceLang(job, job.description || job.title, 'it');
    if (job.sourceLang !== heldLang) { job.sourceLang = heldLang; changed++; }
  }
  if (changed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    console.log(`📝 Set sourceLang on ${changed} Raiffeisen VC job(s).`);
  }
}

/**
 * For each detail URL in `detailBodies`, find the matching job in jobs.json
 * by URL and update its description if the freshly-parsed body is longer than
 * the currently stored description by more than 10%.
 *
 * Uses URL substring matching (UUID) to handle canonical URL variations.
 *
 * @param {Map<string, {descriptionText: string, title: string, workload: string}>} detailBodies
 */
function patchDescriptionsFromDetailBodies(detailBodies) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];

  let patched = 0;
  for (const [url, body] of detailBodies) {
    // Match by UUID in the URL (last path segment before query)
    const uuid = url.split('/').pop()?.split('?')[0] || '';
    const job = jobs.find(j => j.url && j.url.includes(uuid));
    if (!job) continue;

    const currentLen = (job.description || '').length;
    const newLen = body.descriptionText.length;

    // Only update if the new body is meaningfully longer (> 10% gain)
    if (newLen > currentLen * 1.1 || currentLen < MIN_DESC_LENGTH) {
      job.description = body.descriptionText;
      job.sourceLang = holdSourceLang(job, body.descriptionText || job.title, 'it');
      // Update English locale description too
      if (job.descriptionByLocale?.en) {
        job.descriptionByLocale.en = body.descriptionText;
      }
      console.log(
        `  🔄 Patched "${job.title}" (${job.url}): ` +
        `${currentLen} → ${newLen} chars`
      );
      patched++;
    }
  }

  if (patched > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(`\n✅ Patched ${patched} job description(s) with full vacancy body.`);
  } else {
    console.log('\nℹ️  All stored descriptions are already up-to-date (no patch needed).');
  }
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  const summaryCounts = { discovered: null, parsed: null, lastFetchOutcome: null, abortKind: null };
  registerCrawlerSummaryGuard(RAIFF_KEY, 'Raiffeisen VC', summaryCounts);
  console.log('🏦 Running dedicated Raiffeisen Vedeggio Cassarate jobs crawler...');
  console.log(`   Careers: ${CAREERS_URLS[0]}`);
  console.log(`   Jobs portal: ${RAIFF_JOBS_HOST}`);
  console.log('');

  // Step 1: Discover job detail URLs from careers page
  const discovery = await fetchJobUrls();
  const detailUrls = discovery.urls;
  if (discovery.sourceZero) {
    const priorTargetJobs = readExistingCrawlerJobs(RAIFF_KEY, DATA_JOBS).filter(isRaiffeisenVCJob);
    const emptyResult = buildRaiffeisenAuthoritativeEmptySnapshot(
      priorTargetJobs,
      new Date().toISOString(),
      getCrawlerElapsedMs(),
    );
    const archived = archiveRemovedJobsToSlice(priorTargetJobs, RAIFF_KEY);
    await writeJobsCrawlerSliceVerified(RAIFF_KEY, emptyResult.jobs, {
      skipShrinkGuard: true,
      preserveExistingSlugs: true,
    });
    printCrawlChangeSummary(emptyResult.crawlDiff, 'Raiffeisen VC');
    writeCrawlChangeSummaryToGH(emptyResult.crawlDiff, 'Raiffeisen VC');
    writeSummaryCrawlerSlice(emptyResult.summary);
    await assembleJobsDataset();
    console.log(`ℹ️ Persisted authoritative Raiffeisen VC zero; archived ${archived} expired route(s).`);
    return;
  }

  console.log(`📋 Found ${detailUrls.length} job URLs:`);
  for (const u of detailUrls) console.log(`   ${u}`);
  console.log('');
  summaryCounts.discovered = detailUrls.length;

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Step 2b: Fetch detail pages and extract full vacancy bodies
  const detailBodies = await enrichJobsWithDetailBody(detailUrls);

  // Snapshot before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(RAIFF_KEY, DATA_JOBS).filter(isRaiffeisenVCJob))

  // Step 3: Run the base crawler
  await runBaseCrawler();
  ensureSourceLang();

  // Step 3b: Patch stored descriptions with fully-extracted bodies where longer
  if (detailBodies.size > 0 && fs.existsSync(DATA_JOBS)) {
    patchDescriptionsFromDetailBodies(detailBodies);
  }

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isRaiffeisenVCJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    summaryCounts.parsed = 0;
    summaryCounts.abortKind = 'no-jobs-parsed';
    console.warn('⚠️ Raiffeisen discovery was non-empty, but the crawl produced no publishable jobs; preserving the published slice and recording the fail-closed reason.');
    return;
  }

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isRaiffeisenVCJob) : [];
  writeJobsCrawlerSlice(RAIFF_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: RAIFF_KEY,
    label: 'Raiffeisen VC',
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Raiffeisen VC'));
}
