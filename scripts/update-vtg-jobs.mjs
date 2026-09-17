#!/usr/bin/env node
/**
 * Dedicated Swiss Armed Forces (VTG) crawler runner.
 *
 * The VTG publishes Swiss military/defence jobs on the federal government
 * portal jobs.admin.ch, powered by Prospective.ch (Career Center 1000624).
 *
 * This script:
 *   1. Queries the Prospective.ch API for VTG departments
 *      (verwaltungseinheit IDs) across the Swiss-wide feed.
 *   2. Writes discovered job detail URLs as seed URLs in the adapter config.
 *   3. Runs the shared base crawler which fetches each detail page.
 *   4. The shared infrastructure keeps Swiss locations and resolves their cantons.
 *   5. Translates missing locales and validates coverage.
 *
 * VTG has military facilities throughout Switzerland, including Rivera,
 * Ambrì, and Claro (TI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
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
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { normalizeDescriptionBullets, exitCrawlerOnError } from './lib/crawler-template.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  normalizeFederalDepartmentCompany,
  normalizeFederalJobLocation,
} from './lib/federal-job-normalization.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const VTG_KEY = 'vtg';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768, confirmed cause of #3769/#3770).
const DATA_JOBS = crawlerScratchPathFor(VTG_KEY);
const VTG_COMPANY_NAME = 'Swiss Armed Forces (VTG)';
const VTG_HOST = 'jobs.admin.ch';

/**
 * Prospective.ch API — medium 1000624 = Stellenportal Bund (jobs.admin.ch).
 *
 * VTG verwaltungseinheit IDs (military administration departments):
 *   1083433 — VBS/DDPS (Dept. Verteidigung)
 *   1132413 — Armasuisse
 *   1526654 — Nachrichtendienst NDB
 *   1132414 — Gruppe Verteidigung
 *   1083406 — Generalstab / Führungsstab der Armee
 *
 * The production discovery is Swiss-wide and sends only the department facet.
 * The legacy regional filter map remains available to direct helper callers
 * that still exercise the pre-migration fixture contract; the runner below
 * always passes `scope: 'ch-wide'`.
 */
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000624';
const VTG_VERWALTUNGSEINHEIT = '1083433,1132413,1526654,1132414,1083406';
const LEGACY_REGION_IDS = {
  TI: '1083341',
  Ostschweiz1: '1083334',
  Ostschweiz2: '1083319',
};
const API_LIMIT = 500;

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isVtgJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === VTG_KEY ||
    key.includes('vtg') ||
    company.includes('swiss armed') ||
    company.includes('vtg') ||
    company.includes('armee') ||
    company.includes('verteidigung') ||
    company.includes('armasuisse') ||
    (host === VTG_HOST && key === VTG_KEY)
  );
}

function normalizeCantonCode(raw = '', fallback = '') {
  const lower = String(raw || '').trim().toLowerCase();
  if (['ti', 'ticino', 'tessin'].includes(lower)) return 'TI';
  if (['gr', 'grigioni', 'graubunden', 'graubünden', 'grisons'].includes(lower)) return 'GR';
  return fallback || '';
}

function dateOnly(raw = '') {
  const dt = new Date(raw || Date.now());
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}

function buildSeedMetaFromApiJob(job) {
  const arbeitsort = String(job?.attributes?.['arbeitsort']?.[0] || '').trim();
  const region = String(job?.attributes?.['region']?.[0] || '').trim();
  const normalizedLocation = normalizeFederalJobLocation(arbeitsort, '');
  const canton = normalizeCantonCode(normalizedLocation.canton)
    || inferAnyCanton(arbeitsort)
    || inferAnyCanton(normalizedLocation.location)
    || inferAnyCanton(region);
  const dept = String(job?.attributes?.['verwaltungseinheit']?.[0] || '').trim();
  return {
    location: normalizedLocation.location || region || 'Schweiz',
    ...(canton ? { canton } : {}),
    company: normalizeFederalDepartmentCompany(dept, VTG_COMPANY_NAME) || VTG_COMPANY_NAME,
    ...(job?.start_date ? { postedDate: dateOnly(job.start_date) } : {}),
  };
}

/* ── API Discovery ─────────────────────────────────────────── */
function canonicalizeVtgDetailUrl(rawUrl = '') {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== VTG_HOST) return '';
    parsed.protocol = 'https:';
    parsed.hostname = VTG_HOST;
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    if (!/^\/offene-stellen\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.pathname)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export async function fetchVtgJobUrls(options = {}) {
  const allUrls = new Set();
  const stableIdToUrl = new Map();
  const seedMetaByUrl = {};
  const timeoutMs = Number(options.timeoutMs) || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const scope = options.scope || 'legacy-regional';
  const scopeFilters = scope === 'ch-wide'
    ? [['CH', '']]
    : Object.entries(LEGACY_REGION_IDS);
  const regionTotals = {};
  let fetched = 0;
  let duplicateIdentity = 0;
  let droppedMalformed = 0;

  for (const [scopeKey, regionId] of scopeFilters) {
    let offset = 0;
    let total = null;
    let scopeFetched = 0;
    let addedCount = 0;
    let page = 0;

    console.log(`🔍 Fetching VTG jobs for ${scope === 'ch-wide' ? 'all Swiss locations' : `scope ${scopeKey}`} from Prospective API…`);

    while (total === null || offset < total) {
      const params = new URLSearchParams({
        lang: 'de',
        offset: String(offset),
        limit: String(API_LIMIT),
      });
      params.append('f', `verwaltungseinheit:${VTG_VERWALTUNGSEINHEIT}`);
      if (regionId) params.append('f', `region:${regionId}`);

      const apiUrl = `${API_BASE}/jobs?${params}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(apiUrl, {
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': UA },
        });

        if (!res.ok) {
          throw new Error(`VTG discovery failed: API returned ${res.status} for scope ${scopeKey} at offset ${offset}.`);
        }

        const data = await res.json();
        const jobs = assertJsonListShape(data, {
          key: 'jobs',
          source: 'vtg',
          lang: `${scopeKey}:offset:${offset}`,
        });
        const pageTotal = Number(data?.total);
        if (!Number.isInteger(pageTotal) || pageTotal < 0) {
          throw new Error(`VTG discovery incomplete for ${scopeKey} at offset ${offset}: invalid total ${data?.total ?? '?'} (limit ${API_LIMIT}).`);
        }
        if (total === null) total = pageTotal;
        if (pageTotal !== total) {
          throw new Error(`VTG discovery incomplete for ${scopeKey}: total changed from ${total} to ${pageTotal} at offset ${offset}.`);
        }
        const expectedPageSize = Math.min(API_LIMIT, total - offset);
        if (jobs.length !== expectedPageSize) {
          throw new Error(`VTG discovery incomplete for ${scopeKey}: fetched ${scopeFetched + jobs.length}/${total} jobs at offset ${offset} (expected page size ${expectedPageSize}, limit ${API_LIMIT}).`);
        }

        scopeFetched += jobs.length;
        fetched += jobs.length;
        page++;
        console.log(`  📦 ${scopeKey} page ${page} (offset ${offset}): ${jobs.length} VTG jobs`);

        for (const job of jobs) {
          const directLink = canonicalizeVtgDetailUrl(job?.links?.directlink || '');
          if (!directLink) {
            droppedMalformed += 1;
            continue;
          }
          const stableId = extractStableJobId(directLink);
          const previousUrl = stableIdToUrl.get(stableId);
          if (previousUrl) {
            if (previousUrl !== directLink) {
              throw new Error(`VTG discovery identity conflict: ${stableId} maps to both ${previousUrl} and ${directLink}.`);
            }
            duplicateIdentity += 1;
            continue;
          }
          stableIdToUrl.set(stableId, directLink);
          allUrls.add(directLink);
          seedMetaByUrl[directLink] = buildSeedMetaFromApiJob(job);
          addedCount++;
        }

        offset += jobs.length;
      } catch (err) {
        if (String(err?.message || '').startsWith('VTG discovery')) throw err;
        throw new Error(`VTG discovery failed for ${scopeKey} at offset ${offset}: ${err.message}`, { cause: err });
      } finally {
        clearTimeout(timer);
      }
    }

    regionTotals[scopeKey] = total;
    console.log(`  🎖️ ${scopeKey}: ${addedCount} new unique URLs added (${scopeFetched}/${total} fetched)`);
  }

  const expectedScopes = scopeFilters.map(([scopeKey]) => scopeKey);
  const sourceZero = fetched === 0;
  if (Object.keys(regionTotals).length !== expectedScopes.length
      || expectedScopes.some((key) => !Object.hasOwn(regionTotals, key))
      || droppedMalformed !== 0
      || allUrls.size + duplicateIdentity !== fetched
      || Object.keys(seedMetaByUrl).length !== allUrls.size
      || (sourceZero && Object.values(regionTotals).some((total) => total !== 0))) {
    throw new Error(
      `VTG discovery invariant failed: scopes=${Object.keys(regionTotals).length}/${expectedScopes.length}, fetched=${fetched}, canonical=${allUrls.size}, duplicates=${duplicateIdentity}, malformed=${droppedMalformed}, metadata=${Object.keys(seedMetaByUrl).length}.`
    );
  }
  console.log(`\n✅ Total unique VTG detail URLs discovered: ${allUrls.size}\n`);
  return {
    urls: [...allUrls],
    seedMetaByUrl,
    regionTotals,
    scope,
    fetched,
    duplicateIdentity,
    droppedMalformed,
    sourceZero,
  };
}

/* ── Adapter ───────────────────────────────────────────────── */
export function buildVtgAdapterConfig(baseAdapter, seedUrls, seedMetaByUrl = {}, updatedAt = new Date().toISOString()) {
  return {
    ...(baseAdapter || {}),
    companyName: VTG_COMPANY_NAME,
    companyHost: VTG_HOST,
    seedUrls,
    seedMetaByUrl,
    priority: Math.max(baseAdapter?.priority || 0, 10),
    crawlerModes: Array.from(new Set(['generic_ats', ...(baseAdapter?.crawlerModes || []), 'html', 'jsonld'])),
    updatedAt,
  };
}

export function assertVtgAdapterParity(adapter, seedUrls, seedMetaByUrl = {}) {
  if (!isDeepStrictEqual(adapter?.seedUrls, seedUrls)
      || !isDeepStrictEqual(adapter?.seedMetaByUrl, seedMetaByUrl)) {
    throw new Error('VTG adapter parity failed: persisted seeds differ from the complete API feed.');
  }
  return true;
}

export function ensureAdapterSeedUrls(
  seedUrls,
  seedMetaByUrl = {},
  adapterPath = path.join(ADAPTERS_DIR, `${VTG_KEY}.json`),
  updatedAt = new Date().toISOString(),
) {
  const baseAdapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {
      companyKey: VTG_KEY,
      companyName: VTG_COMPANY_NAME,
      companyHost: VTG_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      notes: 'Swiss Armed Forces (VTG) — Prospective.ch JobBooster (Career Center 1000624, jobs.admin.ch). Filtered by VTG verwaltungseinheit IDs across the Swiss-wide feed.',
    };
  const adapter = buildVtgAdapterConfig(baseAdapter, seedUrls, seedMetaByUrl, updatedAt);
  writeJsonAtomic(adapterPath, adapter);
  const persisted = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  assertVtgAdapterParity(persisted, seedUrls, seedMetaByUrl);
  console.log(`📝 Adapter ${VTG_KEY} updated with ${seedUrls.length} seed URLs (Swiss-wide feed parity verified).`);
  return persisted;
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: VTG_KEY,
    localizeOnlyCompanyKeys: VTG_KEY,
    forceLocalizeKeys: VTG_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
    },
  });
}

function ensureSourceLang() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = 0;
  for (const job of jobs) {
    if (!isVtgJob(job)) continue;
    const lang = detectLang(job.description || job.title, 'de');
    if (job.sourceLang !== lang) { job.sourceLang = lang; changed++; }
  }
  if (changed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    console.log(`📝 Set sourceLang on ${changed} VTG job(s).`);
  }
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const jobs = allJobs.filter(isVtgJob);
  const byCanton = new Map();
  for (const job of jobs) {
    const canton = normalize(job?.canton).toUpperCase() || 'UNRESOLVED';
    byCanton.set(canton, (byCanton.get(canton) || 0) + 1);
  }
  const cantonSummary = [...byCanton.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([canton, count]) => `${canton}: ${count}`)
    .join(', ');

  console.log(`\n📊 === VTG Job Stats ===`);
  console.log(`  🎖️ Total VTG jobs: ${jobs.length}`);
  console.log(`  ✅ Cantons: ${cantonSummary || 'none'}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'VTG');
  writeCrawlChangeSummaryToGH(crawlDiff, 'VTG');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_VTG_STRICT',
    label: 'VTG',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isVtgJob,
    detectSourceLang: (text) => detectLang(text, 'de'),
    noJobsMessage: 'No VTG jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(VTG_KEY, 'VTG');
  console.log('🎖️ Running dedicated Swiss Armed Forces (VTG) jobs crawler...');
  console.log('   Platform: Prospective.ch JobBooster (Career Center 1000624, jobs.admin.ch)');
  console.log('   Scope: all Swiss locations (all 26 cantons)');
  console.log('');

  // Step 1: Discover VTG job URLs from the Prospective.ch API
  const discovery = await fetchVtgJobUrls({ scope: 'ch-wide' });
  const detailUrls = discovery.urls;
  if (discovery.sourceZero) {
    console.log('ℹ️ No VTG detail URLs found from API. Exiting OK.');
    return;
  }

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls, discovery.seedMetaByUrl);

  // Snapshot before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(VTG_KEY, DATA_JOBS).filter(isVtgJob))

  // Step 3: Run the base crawler (fetches detail pages)
  await runBaseCrawler();
  ensureSourceLang();

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isVtgJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No VTG jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isVtgJob) : [];
  writeJobsCrawlerSlice(VTG_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: VTG_KEY,
    label: 'VTG',
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
  main().catch((err) => exitCrawlerOnError(err, 'VTG'));
}
