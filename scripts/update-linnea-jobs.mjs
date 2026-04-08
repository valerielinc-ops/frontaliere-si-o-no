#!/usr/bin/env node
/**
 * Dedicated Linnea SA crawler runner.
 *
 * Linnea SA is a pharmaceutical company (botanical ingredients, APIs)
 * headquartered in Riazzino, Ticino, Switzerland (near Locarno).
 *
 * The Linnea careers page at https://www.linnea.ch/careers/ is a WordPress site
 * using Foundation's accordion component. Jobs are listed under an
 * "OPEN POSITIONS" heading with each position as an accordion item.
 *
 * There are NO individual job detail page URLs. All job titles and full
 * descriptions are embedded inline in accordion items on a single page.
 *
 * Discovery flow:
 *   1. Fetch https://www.linnea.ch/careers/ (server-side rendered HTML)
 *   2. Locate the "OPEN POSITIONS" section
 *   3. Parse each accordion item: title from <h4>, description from <article>
 *   4. Build job objects with synthetic descriptions
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization of descriptions (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseAccordionJobs,
  normalizeSpace,
  slugify,
  detectCategory,
  detectExperienceLevel,
} from './lib/linnea-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const LINNEA_KEY = 'linnea';
const LINNEA_COMPANY_NAME = 'Linnea SA';
const LINNEA_COMPANY_HOST = 'www.linnea.ch';
const LINNEA_CAREERS_URL = 'https://www.linnea.ch/careers/';
const LOCALES = ['it', 'en', 'de', 'fr'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isLinneaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === LINNEA_KEY ||
    key === 'linnea-sa' ||
    key.startsWith('linnea') ||
    (company.includes('linnea') && company.includes('sa')) ||
    url.includes('linnea.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.linnea.ch' || host === 'linnea.ch';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// HTML fetching
// ─────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch and parse all Linnea jobs from the careers page.
 */
async function fetchLinneaJobs() {
  console.log(`🔍 Fetching Linnea SA jobs from ${LINNEA_CAREERS_URL}`);

  const html = await fetchPage(LINNEA_CAREERS_URL, 25000);
  if (!html) {
    console.error('❌ Failed to fetch Linnea careers page.');
    return [];
  }

  console.log(`  📄 Page fetched (${html.length} chars)`);

  // Parse accordion jobs
  const parsedJobs = parseAccordionJobs(html);
  console.log(`  📋 Accordion items found: ${parsedJobs.length}`);

  if (parsedJobs.length === 0) {
    console.log('  ℹ️ No active job listings found on Linnea careers page.');
    return [];
  }

  // Build job objects
  const jobs = [];
  for (const parsed of parsedJobs) {
    const slug = slugify(parsed.title, 'linnea');
    // Use query param for stable canonical URL (hash fragments get stripped by shared crawler)
    const canonicalUrl = `${LINNEA_CAREERS_URL}?position=${parsed.idx}`;

    const descEn = buildDescription(parsed, 'en');
    const descIt = buildDescription(parsed, 'it');

    const employmentType = /full\s*time/i.test(parsed.contractType) ? 'FULL_TIME'
      : /part\s*time/i.test(parsed.contractType) ? 'PART_TIME'
      : 'FULL_TIME';

    const job = {
      url: canonicalUrl,
      applyUrl: LINNEA_CAREERS_URL,
      title: parsed.title,
      company: LINNEA_COMPANY_NAME,
      companyKey: LINNEA_KEY,
      location: parsed.location || 'Riazzino',
      canton: 'TI',
      country: 'CH',
      description: descEn,
      descriptionByLocale: {
        en: descEn,
        it: descIt,
      },
      titleByLocale: {
        en: parsed.title,
      },
      slug,
      slugByLocale: {
        en: slug,
        it: slugify(parsed.title, 'linnea'),
      },
      category: detectCategory(parsed.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'linnea-careers-crawler',
      employmentType,
      experienceLevel: detectExperienceLevel(parsed.title),
      sector: 'Farmaceutica / Ingredienti botanici',
      sourceLang: detectLang(descEn || parsed.title, 'it'),
      _targetScope: { canton: 'TI', location: 'Riazzino' },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total unique Linnea jobs discovered: ${jobs.length}`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Description building
// ─────────────────────────────────────────────────────────────

function buildDescription(parsed, locale = 'en') {
  const rawDesc = parsed.descriptionText || '';

  if (locale === 'en') {
    return `${rawDesc}\n\nLinnea SA is a leading pharmaceutical company specializing in botanical ingredients and active pharmaceutical ingredients (APIs), headquartered in Riazzino, Ticino, Switzerland. Founded in 1982, the company operates a GMP-certified manufacturing site.`.trim();
  }

  if (locale === 'it') {
    return `Posizione aperta presso Linnea SA a Riazzino.\nRuolo: ${parsed.title}.\n\n${rawDesc}\n\nLinnea SA è un'azienda farmaceutica leader specializzata in ingredienti botanici e principi attivi farmaceutici (API), con sede a Riazzino, Ticino, Svizzera. Fondata nel 1982, l'azienda opera in un sito di produzione certificato GMP.`.trim();
  }

  return rawDesc;
}

// ─────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ─────────────────────────────────────────────────────────────

function canonicalizeUrl(url = '') {
  try {
    return new URL(url).href.replace(/\/$/, '').toLowerCase();
  } catch {
    return normalize(url);
  }
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeLinneaJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(LINNEA_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonLinneaJobs = allJobs.filter((j) => !isLinneaJob(j));
  const existingLinneaJobs = allJobs.filter(isLinneaJob);

  const existingByUrl = new Map();
  for (const job of existingLinneaJobs) {
    existingByUrl.set(canonicalizeUrl(job.url), job);
  }

  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) {
    discoveredByUrl.set(canonicalizeUrl(job.url), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const existing = existingByUrl.get(key);

    if (existing) {
      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        company: LINNEA_COMPANY_NAME,
        companyKey: LINNEA_KEY,
        location: discovered.location || existing.location,
        canton: 'TI',
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'linnea-careers-crawler',
        titleByLocale: mergeLocaleTextMap(existing.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existing.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existing.slugByLocale, discovered.slugByLocale, 3),
      };

      if (discovered.description && discovered.description.length > (existing.description || '').length) {
        updatedJob.description = discovered.description;
      }

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  for (const [url] of existingByUrl) {
    if (!discoveredByUrl.has(url)) {
      removed++;
    }
  }

  const final = [...nonLinneaJobs, ...merged];

  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

// ─────────────────────────────────────────────────────────────
// Adapter management
// ─────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${LINNEA_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = LINNEA_KEY;
  adapter.companyName = LINNEA_COMPANY_NAME;
  adapter.companyHost = LINNEA_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [LINNEA_CAREERS_URL];
  adapter.notes = 'WordPress + Foundation accordion at linnea.ch/careers/ — job listings extracted directly from inline accordion items, no individual detail pages.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${LINNEA_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: LINNEA_KEY,
    localizeOnlyCompanyKeys: LINNEA_KEY,
    forceLocalizeKeys: LINNEA_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessLinneaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isLinneaJob(job)) continue;

    if (job.company !== LINNEA_COMPANY_NAME) {
      job.company = LINNEA_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== LINNEA_KEY) {
      job.companyKey = LINNEA_KEY;
      fixed++;
    }
    job.canton = 'TI';
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Riazzino';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Linnea jobs (fixed company/location/canton).`);
  }
}

// ─────────────────────────────────────────────────────────────
// Stats & validation
// ─────────────────────────────────────────────────────────────

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const linneaJobs = allJobs.filter(isLinneaJob);

  console.log(`\n📊 === Linnea SA Job Stats ===`);
  console.log(`  🏢 Total Linnea jobs: ${linneaJobs.length}`);

  if (linneaJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of linneaJobs) {
      console.log(`     - ${job.title} (${job.location || 'Riazzino'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(linneaJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Linnea SA');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Linnea SA');
  return { total: linneaJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LINNEA_STRICT',
    label: 'Linnea SA',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isLinneaJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_linnea_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Linnea SA jobs found — the company may not have active openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(LINNEA_KEY, 'Linnea SA');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Linnea SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${LINNEA_CAREERS_URL}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(LINNEA_KEY, DATA_JOBS).filter(isLinneaJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchLinneaJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Linnea jobs discovered.');
    console.log('   The careers page may have changed structure or have no current openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeLinneaJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Linnea jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessLinneaJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Linnea jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Linnea SA crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isLinneaJob) : [];
  writeJobsCrawlerSlice(LINNEA_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: LINNEA_KEY,
    label: 'Linnea SA',
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
  console.error(`❌ Linnea SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
