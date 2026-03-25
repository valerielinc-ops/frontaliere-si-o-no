#!/usr/bin/env node
/**
 * Dedicated Denner crawler runner.
 *
 * Denner is a subsidiary of Migros Group. Their jobs are listed on the
 * Migros Group portal at jobs.migros.ch under the Denner SA company filter.
 *
 * The Migros portal is a Nuxt.js SSR application — listing pages are
 * server-rendered with real <a href="..."> links to detail pages.
 *
 * Listing URL:
 *   https://jobs.migros.ch/it/le-nostre-imprese/denner-sa/posti-di-lavoro-vacanti?REGION=871
 *
 * Detail page URL pattern:
 *   /it/le-nostre-imprese/job/denner-sa/{job-slug}/{uuid}
 *   /de/unsere-unternehmen/job/denner-ag/{job-slug}/{uuid}
 *   /fr/nos-entreprises/job/denner-sa/{job-slug}/{uuid}
 *
 * This script:
 *   1. Fetches the Migros listing pages for Denner (all regions + Ticino)
 *   2. Extracts job detail URLs from SSR HTML
 *   3. Updates adapter seed URLs
 *   4. Runs base crawler for detail parsing/localization
 *   5. Validates locale coverage
 */
import fs from 'node:fs';
import path from 'node:path';
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
  writeSummaryCrawlerSlice,
  assembleJobsDataset,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
} from './lib/dedicated-crawler-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const DENNER_KEY = 'denner';
const DENNER_COMPANY_NAME = 'Denner';
const DENNER_HOST = 'jobs.migros.ch';
const DENNER_LISTING_BASE = 'https://jobs.migros.ch/it/le-nostre-imprese/denner-sa/posti-di-lavoro-vacanti';

/**
 * Region IDs for the Migros portal:
 *   871 = Svizzera meridionale (Southern Switzerland — includes Ticino)
 *   868 = Grigioni
 */
const REGION_IDS = { 'Svizzera meridionale': '871', Grigioni: '868' };

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/**
 * Regex to match Denner job detail hrefs from Migros SSR HTML.
 *
 * Migros Nuxt renders detail links as:
 *   /it/le-nostre-imprese/job/denner-sa/{slug}/{uuid}
 *   /de/unsere-unternehmen/job/denner-ag/{slug}/{uuid}
 *   /fr/nos-entreprises/job/denner-sa/{slug}/{uuid}
 *   /en/our-companies/job/denner-sa/{slug}/{uuid}
 */
const JOB_DETAIL_HREF_RE = /href="(\/(?:it|de|fr|en)\/(?:le-nostre-imprese|unsere-unternehmen|nos-entreprises|our-companies)\/job\/[^"]+)"/gi;

/* ── Matchers ──────────────────────────────────────────────── */
function isDennerJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === DENNER_KEY ||
    key.includes('denner') ||
    company.includes('denner') ||
    (host === DENNER_HOST && url.includes('denner')) ||
    url.includes('denner.ch')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
async function fetchDennerJobUrls() {
  const allUrls = new Set();
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;

  // Fetch listing pages for Ticino regions + all-regions page
  const pagesToFetch = [
    ...Object.entries(REGION_IDS).map(([name, id]) => ({
      name,
      url: `${DENNER_LISTING_BASE}?REGION=${id}`,
    })),
    { name: 'All regions', url: DENNER_LISTING_BASE },
  ];

  for (const { name, url: listUrl } of pagesToFetch) {
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const fetchUrl =
        page === 0
          ? listUrl
          : `${listUrl}${listUrl.includes('?') ? '&' : '?'}page=${page}`;
      console.log(`\ud83d\udd0d Fetching Denner ${name} jobs (page ${page}): ${fetchUrl}`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(fetchUrl, {
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': UA,
          },
          redirect: 'follow',
        });
        clearTimeout(timer);

        if (!res.ok) {
          console.warn(`\u26a0\ufe0f Denner listing returned ${res.status} for ${name} page ${page}`);
          break;
        }

        const html = await res.text();
        const pageUrls = new Set();

        // Extract job detail URLs from SSR HTML
        let match;
        while ((match = JOB_DETAIL_HREF_RE.exec(html)) !== null) {
          const relPath = match[1];
          // Only include Denner company URLs (denner-sa or denner-ag or denner-partner)
          if (!/denner/i.test(relPath)) continue;
          const fullUrl = `https://${DENNER_HOST}${relPath}`;
          if (!allUrls.has(fullUrl)) {
            pageUrls.add(fullUrl);
            allUrls.add(fullUrl);
          }
        }
        JOB_DETAIL_HREF_RE.lastIndex = 0;

        console.log(`  \ud83d\udce6 ${name} page ${page}: ${pageUrls.size} new URL(s)`);

        if (pageUrls.size === 0) {
          hasMore = false;
        } else {
          // Check for pagination
          const nextExists =
            html.includes(`page=${page + 1}`) ||
            html.includes(`page%3D${page + 1}`);
          hasMore = nextExists;
          if (hasMore) page++;
        }
      } catch (err) {
        console.warn(`\u26a0\ufe0f Denner listing fetch failed for ${name} page ${page}: ${err.message}`);
        break;
      }
    }
  }

  console.log(`\u2705 Total unique Denner detail URLs discovered: ${allUrls.size}`);
  return [...allUrls];
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${DENNER_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`\u26a0\ufe0f Adapter ${DENNER_KEY}.json not found \u2014 creating it.`);
    const adapter = {
      companyKey: DENNER_KEY,
      companyName: DENNER_COMPANY_NAME,
      companyHost: DENNER_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html'],
      seedUrls: seedUrls.length > 0 ? seedUrls : [DENNER_LISTING_BASE],
      notes: 'Denner (Migros Group subsidiary) careers via jobs.migros.ch. Nuxt.js SSR with detail URLs scraped from listing pages.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls.length > 0 ? seedUrls : adapter.seedUrls || [DENNER_LISTING_BASE];
    adapter.crawlerModes = (adapter.crawlerModes || []).filter((m) => m !== 'jsonld');
    if (!adapter.crawlerModes.includes('generic_ats')) adapter.crawlerModes.unshift('generic_ats');
    if (!adapter.crawlerModes.includes('html')) adapter.crawlerModes.push('html');
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`\ud83d\udcdd Adapter ${DENNER_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: DENNER_KEY,
    localizeOnlyCompanyKeys: DENNER_KEY,
    forceLocalizeKeys: DENNER_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '3',
    },
  });
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('\u2139\ufe0f jobs.json not found \u2014 no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const jobs = allJobs.filter(isDennerJob);

  console.log(`\n\ud83d\udcca === Denner Job Stats ===`);
  console.log(`  \ud83c\udfea Total Denner jobs: ${jobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Denner');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Denner');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DENNER_STRICT',
    label: 'Denner',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDennerJob,
    noJobsMessage: 'No Denner jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  console.log('\ud83c\udfea Running dedicated Denner jobs crawler...');
  console.log(`   Portal: ${DENNER_HOST} (Migros Group portal)`);
  console.log('');

  const detailUrls = await fetchDennerJobUrls();
  ensureAdapterSeedUrls(detailUrls);

  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isDennerJob) : []);
    } catch {}
  }

  await runBaseCrawler();

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDennerJob,
  });

  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('\u2139\ufe0f No Denner jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS)
    ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'))
    : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isDennerJob) : [];
  writeJobsCrawlerSlice(DENNER_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: DENNER_KEY,
    label: 'Denner',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: 0,
    updatedCount: 0,
    removedCount: 0,
    unchangedCount: _sliceJobs.length,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: [],
    updatedJobs: [],
    removedJobs: [],
    unchangedJobs: _sliceJobs.slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`\u274c Denner crawler failed: ${err?.message || err}`);
  process.exit(1);
});
