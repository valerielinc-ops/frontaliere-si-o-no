#!/usr/bin/env node
/**
 * Dedicated DOT Life crawler runner.
 *
 * DOT Life SA is a hospitality & wellness group based in Paradiso (TI).
 * They own Villa Principe Leopoldo, Villa Sassa, Kurhaus Cademario, and
 * Park Hotel Principe.
 *
 * Their website (dotlifestyle.ch) has no dedicated careers page — the
 * contact page lists job@dotlife.swiss and the "Careers" nav links to
 * LinkedIn. This crawler:
 *   1. Scrapes the contact page and sitemap for any job-related links.
 *   2. If job detail URLs are found, writes them as seed URLs in the adapter.
 *   3. Runs the shared base crawler for any discovered URLs.
 *   4. Exits OK if no jobs are currently posted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
} from './jobs-url-helper.mjs';
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

const DOT_KEY = 'dot-life';
const DOT_COMPANY_NAME = 'DOT Life SA';
const DOT_HOST = 'www.dotlifestyle.ch';
const DOT_CONTACT_URL = 'https://www.dotlifestyle.ch/contact.htm';
const DOT_SITEMAP_URL = 'https://www.dotlifestyle.ch/sitemap.xml';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isDotLifeJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === DOT_KEY ||
    key === 'dot-life-sa' ||
    key.startsWith('dot-life') ||
    company.includes('dot life') ||
    company.includes('dotlife') ||
    host === DOT_HOST ||
    host.endsWith('.dotlifestyle.ch') ||
    host.endsWith('.dotlife.swiss')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
/**
 * Scrape the DOT Life contact page and sitemap for any job detail URLs.
 * The site currently has no dedicated careers page — jobs are posted via
 * LinkedIn or email. This function monitors for any new job links that
 * might appear on the site.
 */
async function fetchDotLifeJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const urls = new Set();
  const skipHosts = ['linkedin.com', 'www.linkedin.com', 'it.linkedin.com'];

  // Step 1: Scrape the contact page for job links
  console.log(`🔍 Fetching DOT Life contact page: ${DOT_CONTACT_URL}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(DOT_CONTACT_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
    });
    clearTimeout(timer);

    if (res.ok) {
      const html = await res.text();
      // Look for any links that might be job detail pages
      const hrefPattern = /href="([^"]+)"/g;
      let match;
      while ((match = hrefPattern.exec(html)) !== null) {
        const href = match[1];
        const lower = href.toLowerCase();
        // Skip non-job links
        if (!lower.includes('job') && !lower.includes('career') &&
            !lower.includes('lavoro') && !lower.includes('impiego') &&
            !lower.includes('stelle') && !lower.includes('posizion')) continue;
        // Skip LinkedIn (can't crawl)
        try {
          const parsed = new URL(href, `https://${DOT_HOST}`);
          if (skipHosts.some(h => parsed.hostname.includes(h))) continue;
          urls.add(parsed.href);
        } catch { /* ignore malformed URLs */ }
      }
    }
  } catch (err) {
    console.warn(`⚠️ Failed to fetch contact page: ${err.message}`);
  }

  // Step 2: Check sitemap for any job/career pages
  console.log(`🔍 Checking DOT Life sitemap: ${DOT_SITEMAP_URL}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(DOT_SITEMAP_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/xml,text/xml', 'User-Agent': UA },
    });
    clearTimeout(timer);

    if (res.ok) {
      const xml = await res.text();
      const locPattern = /<loc>([^<]+)<\/loc>/g;
      let match;
      while ((match = locPattern.exec(xml)) !== null) {
        const loc = match[1];
        const lower = loc.toLowerCase();
        if (lower.includes('job') || lower.includes('career') ||
            lower.includes('lavoro') || lower.includes('impiego') ||
            lower.includes('stelle') || lower.includes('posizion')) {
          urls.add(loc);
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ Failed to fetch sitemap: ${err.message}`);
  }

  console.log(`✅ Discovered ${urls.size} DOT Life job detail URLs`);
  return [...urls];
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${DOT_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${DOT_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: DOT_KEY,
      companyName: DOT_COMPANY_NAME,
      companyHost: DOT_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls,
      notes: 'DOT Life SA — Paradiso-based hospitality group. No dedicated careers page; jobs posted via LinkedIn/email. Seed URLs auto-discovered.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${DOT_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: DOT_KEY,
    localizeOnlyCompanyKeys: DOT_KEY,
    forceLocalizeKeys: DOT_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '30',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '30',
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
  const jobs = allJobs.filter(isDotLifeJob);
  const tiJobs = jobs.filter((j) => normalize(j?.canton) === 'ti');
  const grJobs = jobs.filter((j) => normalize(j?.canton) === 'gr');

  console.log(`\n📊 === DOT Life Job Stats ===`);
  console.log(`  🏨 Total DOT Life jobs: ${jobs.length}`);
  console.log(`  ✅ Ticino: ${tiJobs.length}`);
  console.log(`  ✅ Grigioni: ${grJobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'DOT Life');
  writeCrawlChangeSummaryToGH(crawlDiff, 'DOT Life');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DOT_LIFE_STRICT',
    label: 'DOT Life',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDotLifeJob,
    noJobsMessage: 'No DOT Life jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  console.log('🏨 Running dedicated DOT Life jobs crawler...');
  console.log(`   Portal: ${DOT_HOST} (static site + LinkedIn)`);
  console.log('');

  // Step 1: Discover job detail URLs
  const detailUrls = await fetchDotLifeJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No DOT Life job URLs discovered. Exiting OK.');
    printCrawlChangeSummary({ newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 }, 'DOT Life');
    return;
  }

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot before crawl for diff summary
  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isDotLifeJob) : []);
    } catch {}
  }

  // Step 3: Run the base crawler
  await runBaseCrawler();

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDotLifeJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No DOT Life jobs found after crawl. Exiting OK.');
    printCrawlChangeSummary({ newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 }, 'DOT Life');
    return;
  }

  validateLocaleCoverage();
}

main().catch((err) => {
  console.error(`❌ DOT Life crawler failed: ${err?.message || err}`);
  process.exit(1);
});
