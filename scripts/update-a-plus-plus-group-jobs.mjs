#!/usr/bin/env node
/**
 * Dedicated A++ Group crawler runner.
 *
 * A++ Group is an architecture, design & sustainability firm based in
 * Massagno (TI), founded by Paolo Colombo and Carlo Colombo.
 * Main site: a2plus.green (WordPress) — no dedicated careers page.
 * Jobs are currently filled via email (job@a2plus.green) and networking.
 *
 * This crawler:
 *   1. Scrapes the homepage, contact section, and sitemap for job links.
 *   2. Also checks architecture.a2plus.green for any career pages.
 *   3. If job detail URLs are found, writes them as seed URLs in the adapter.
 *   4. Runs the shared base crawler for any discovered URLs.
 *   5. Exits OK if no jobs are currently posted.
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

const APP_KEY = 'a-group';
const APP_COMPANY_NAME = 'A++ Group';
const APP_HOST = 'a2plus.green';

const PAGES_TO_CHECK = [
  'https://a2plus.green/',
  'https://a2plus.green/sitemap.xml',
  'https://a2plus.green/sitemap_index.xml',
  'https://architecture.a2plus.green/',
];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isAPlusPlusJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === APP_KEY ||
    key === 'a-group' ||
    key.startsWith('a-plus-plus') ||
    company.includes('a++ group') ||
    company.includes('a2plus') ||
    company.includes('aplusplus') ||
    host === APP_HOST ||
    host.endsWith('.a2plus.green')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
/**
 * Scrape A++ Group pages for any job-related URLs.
 * The site currently has no dedicated careers page — this function
 * monitors for any new job links that might appear.
 */
async function fetchJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const urls = new Set();
  const skipHosts = ['linkedin.com', 'www.linkedin.com', 'it.linkedin.com'];

  for (const pageUrl of PAGES_TO_CHECK) {
    const isXml = pageUrl.endsWith('.xml');
    console.log(`🔍 Checking: ${pageUrl}`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(pageUrl, {
        signal: controller.signal,
        headers: {
          Accept: isXml ? 'application/xml,text/xml' : 'text/html',
          'User-Agent': UA,
        },
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.log(`   ⚠️ HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();

      if (isXml) {
        // Parse sitemap <loc> entries
        const locPattern = /<loc>([^<]+)<\/loc>/g;
        let match;
        while ((match = locPattern.exec(text)) !== null) {
          const loc = match[1];
          const lower = loc.toLowerCase();
          if (lower.includes('job') || lower.includes('career') ||
              lower.includes('lavoro') || lower.includes('impiego') ||
              lower.includes('stelle') || lower.includes('posizion')) {
            urls.add(loc);
          }
        }
      } else {
        // Parse HTML href attributes
        const hrefPattern = /href="([^"]+)"/g;
        let match;
        while ((match = hrefPattern.exec(text)) !== null) {
          const href = match[1];
          const lower = href.toLowerCase();
          if (!lower.includes('job') && !lower.includes('career') &&
              !lower.includes('lavoro') && !lower.includes('impiego') &&
              !lower.includes('stelle') && !lower.includes('posizion')) continue;
          // Skip mailto and LinkedIn (not crawlable)
          if (lower.startsWith('mailto:')) continue;
          try {
            const parsed = new URL(href, pageUrl);
            if (skipHosts.some(h => parsed.hostname.includes(h))) continue;
            urls.add(parsed.href);
          } catch { /* ignore malformed URLs */ }
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Failed: ${err.message}`);
    }
  }

  console.log(`✅ Discovered ${urls.size} A++ Group job detail URLs`);
  return [...urls];
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${APP_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${APP_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: APP_KEY,
      companyName: APP_COMPANY_NAME,
      companyHost: APP_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls,
      notes: 'A++ Group — Massagno-based architecture & design firm. No dedicated careers page; jobs posted via email (job@a2plus.green). Seed URLs auto-discovered.',
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
    console.log(`📝 Adapter ${APP_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: APP_KEY,
    localizeOnlyCompanyKeys: APP_KEY,
    forceLocalizeKeys: APP_KEY,
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
  const jobs = allJobs.filter(isAPlusPlusJob);
  const tiJobs = jobs.filter((j) => normalize(j?.canton) === 'ti');
  const grJobs = jobs.filter((j) => normalize(j?.canton) === 'gr');

  console.log(`\n📊 === A++ Group Job Stats ===`);
  console.log(`  🏗️  Total A++ Group jobs: ${jobs.length}`);
  console.log(`  ✅ Ticino: ${tiJobs.length}`);
  console.log(`  ✅ Grigioni: ${grJobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'A++ Group');
  writeCrawlChangeSummaryToGH(crawlDiff, 'A++ Group');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_A_GROUP_STRICT',
    label: 'A++ Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isAPlusPlusJob,
    noJobsMessage: 'No A++ Group jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  console.log('🏗️  Running dedicated A++ Group jobs crawler...');
  console.log(`   Portal: ${APP_HOST} (WordPress site + email recruitment)`);
  console.log('');

  // Step 1: Discover job detail URLs
  const detailUrls = await fetchJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No A++ Group job URLs discovered. Exiting OK.');
    return;
  }

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot before crawl for diff summary
  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isAPlusPlusJob) : []);
    } catch {}
  }

  // Step 3: Run the base crawler
  await runBaseCrawler();

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isAPlusPlusJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No A++ Group jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();
}

main().catch((err) => {
  console.error(`❌ A++ Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
