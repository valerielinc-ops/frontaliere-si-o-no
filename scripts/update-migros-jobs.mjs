#!/usr/bin/env node
/**
 * Dedicated Migros crawler runner.
 * Runs only Migros Ticino jobs and enforces full locale coverage
 * for SEO-critical fields.
 *
 * The Migros careers portal at jobs.migros.ch is a Nuxt.js SSR
 * application. The listing pages are server-side rendered and
 * contain all job detail URLs directly in the HTML.
 *
 * This script:
 *   1. Fetches the Migros listing page HTML for Ticino (REGION=871)
 *      and Grigioni (REGION=868) to discover job detail URLs.
 *   2. Sets those SSR detail URLs as adapter seed URLs.
 *   3. Runs the base crawler which fetches each detail page and
 *      parses the HTML content (no JSON-LD — Migros uses Nuxt
 *      with __NUXT_DATA__ hydration payloads).
 *
 * Listing URL pattern:
 *   https://jobs.migros.ch/it/le-nostre-imprese/gruppo-migros/posti-di-lavoro-vacanti?REGION={id}
 *
 * Detail page URL pattern:
 *   https://jobs.migros.ch/it/le-nostre-imprese/job/{company-slug}/{job-slug}/{uuid}
 *
 * Locale URL variants (same UUID, different prefix):
 *   IT: /it/le-nostre-imprese/job/...
 *   DE: /de/unsere-unternehmen/job/...
 *   FR: /fr/nos-entreprises/job/...
 *   EN: /en/our-companies/job/...
 *
 * Region IDs:
 *   871 = Svizzera meridionale (Southern Switzerland — includes Ticino)
 *   872 = Ticino
 *   868 = Grigioni
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, normalize } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const MIGROS_KEY = 'migros-ticino';

/**
 * Migros listing page base and region IDs.
 *
 * REGION=871 — "Svizzera meridionale" (Southern Switzerland), covers Ticino
 * REGION=868 — "Grigioni" (Graubünden)
 *
 * Both are fetched to maximise coverage for Italian-speaking regions.
 */
const LISTING_BASE = 'https://jobs.migros.ch/it/le-nostre-imprese/gruppo-migros/posti-di-lavoro-vacanti';
const REGION_IDS = {
  'Svizzera meridionale': '871',
  Grigioni: '868',
};

/**
 * Regex to extract job detail hrefs from the listing HTML.
 * Matches: href="/it/le-nostre-imprese/job/{company}/{slug}/{uuid}"
 */
const JOB_DETAIL_HREF_RE = /href="(\/it\/le-nostre-imprese\/job\/[^"]+)"/g;

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

// ──────────────────────────────────────────────────────────────
// Listing page fetching
// ──────────────────────────────────────────────────────────────

/**
 * Fetch Migros job detail URLs from the SSR listing pages
 * for the specified regions (Svizzera meridionale + Grigioni).
 *
 * The listing pages are Nuxt.js SSR and contain <a href="..."> links
 * to each job detail page directly in the HTML.
 *
 * Handles pagination by following "next page" links if present.
 *
 * Returns an array of absolute job detail URLs.
 */
async function fetchMigrosJobDetailUrls() {
  const allUrls = new Set();
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  for (const [regionName, regionId] of Object.entries(REGION_IDS)) {
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const listUrl = page === 0
        ? `${LISTING_BASE}?REGION=${regionId}`
        : `${LISTING_BASE}?REGION=${regionId}&page=${page}`;

      console.log(`🔍 Fetching Migros ${regionName} jobs (page ${page}): ${listUrl}`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(listUrl, {
          signal: controller.signal,
          headers: {
            Accept: 'text/html',
            'User-Agent': userAgent,
          },
        });
        clearTimeout(timer);

        if (!res.ok) {
          console.warn(`⚠️ Listing returned ${res.status} for ${regionName} page ${page} — skipping.`);
          break;
        }

        const html = await res.text();

        // Extract all job detail href paths
        const pageUrls = new Set();
        let match;
        while ((match = JOB_DETAIL_HREF_RE.exec(html)) !== null) {
          const relPath = match[1];
          const fullUrl = `https://jobs.migros.ch${relPath}`;
          if (!allUrls.has(fullUrl)) {
            pageUrls.add(fullUrl);
            allUrls.add(fullUrl);
          }
        }
        // Reset lastIndex for reuse
        JOB_DETAIL_HREF_RE.lastIndex = 0;

        console.log(`  📦 ${regionName} page ${page}: ${pageUrls.size} new job URL(s) found`);

        // Check for next page: Migros uses @start - @end dei risultati @count pattern
        // If no new URLs found on this page, stop pagination
        if (pageUrls.size === 0) {
          hasMore = false;
        } else {
          // Check if there's a "next page" link
          // The pagination in Migros Nuxt uses a "Pagina successiva" link
          const nextPageExists = html.includes(`REGION=${regionId}&amp;page=${page + 1}`) ||
            html.includes(`REGION=${regionId}&page=${page + 1}`);
          if (nextPageExists) {
            page++;
          } else {
            hasMore = false;
          }
        }
      } catch (err) {
        console.warn(`⚠️ Listing fetch failed for ${regionName} page ${page}: ${err.message}`);
        break;
      }
    }
  }

  console.log(`✅ Total unique Migros detail URLs discovered: ${allUrls.size}`);
  return [...allUrls];
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the Migros adapter JSON has the correct seed URLs
 * (detail page URLs discovered from the listing page).
 */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${MIGROS_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${MIGROS_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: MIGROS_KEY,
      companyName: 'Migros Ticino',
      companyHost: 'jobs.migros.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html'],
      seedUrls,
      notes: 'Nuxt.js SSR careers portal — detail URLs scraped from listing pages, each page has rich HTML content.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.companyHost = 'jobs.migros.ch';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    // Remove jsonld mode since Migros doesn't have JSON-LD
    adapter.crawlerModes = adapter.crawlerModes.filter((m) => m !== 'jsonld');
    if (!adapter.crawlerModes.includes('html')) adapter.crawlerModes.push('html');
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'Nuxt.js SSR careers portal — detail URLs scraped from listing pages, each page has rich HTML content.';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${MIGROS_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
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
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const migrosJobs = allJobs.filter(isMigrosJob);
  const ticinoJobs = migrosJobs.filter((job) => normalize(job?.canton) === 'ti');
  const grJobs = migrosJobs.filter((job) => normalize(job?.canton) === 'gr');
  const otherJobs = migrosJobs.length - ticinoJobs.length - grJobs.length;

  console.log(`\n📊 === Migros Ticino Job Stats ===`);
  console.log(`  🛒 Job totali trovati (Migros): ${migrosJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  console.log(`  ✅ Job in Grigioni (canton=GR): ${grJobs.length}`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job in altri cantoni: ${otherJobs}`);
    const examples = migrosJobs
      .filter((job) => !['ti', 'gr'].includes(normalize(job?.canton)))
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(migrosJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Migros');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Migros');

  return { total: migrosJobs.length, ticino: ticinoJobs.length, crawlDiff };

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
  console.log('🛒 Running dedicated Migros Ticino jobs crawler...');
  console.log('   Platform: Nuxt.js SSR (jobs.migros.ch)');
  console.log('   Regions: Svizzera meridionale (871) + Grigioni (868)');
  console.log('');

  // Step 1: Fetch job detail URLs from the SSR listing pages
  const detailUrls = await fetchMigrosJobDetailUrls();
  if (detailUrls.length === 0) {
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
      fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
      console.log(`  🏷️ Set sourceLang on ${patched} Migros job(s).`);
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

main().catch((err) => {
  console.error(`❌ Migros crawler failed: ${err?.message || err}`);
  process.exit(1);
});
