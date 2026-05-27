#!/usr/bin/env node
/**
 * Dedicated FART crawler runner.
 *
 * FART — Ferrovie Autolinee Regionali Ticinesi is the public transport
 * company serving the Locarno region in Canton Ticino, operating the
 * Centovalli Railway and regional bus lines.
 *
 * Job postings ("concorsi") are published on the WordPress-powered page:
 *   https://fartiamo.ch/lavora-con-noi-concorsi/
 *
 * Discovery flow:
 *   1. Fetch the careers page
 *   2. Parse <h5> job titles with associated PDF "CONCORSO" links
 *   3. Build job objects with structured descriptions
 *   4. Merge into data/jobs.json (add new, update existing, prune stale)
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  printPublishedJobUrls,
  writeJobsSummary,
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';
import {
  parseFartListingPage,
  buildFartDescription,
} from './lib/fart-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'fart';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'FART – Ferrovie Autolinee Regionali Ticinesi';
const COMPANY_HOST = 'fartiamo.ch';
const CAREERS_URL = 'https://fartiamo.ch/lavora-con-noi-concorsi/';
const LOCALES = ['it', 'en', 'de', 'fr'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
}

function decodeHtmlEntities(html = '') {
  return String(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#039;/gi, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D');
}

function stripHtml(html = '') {
  return decodeHtmlEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function isTargetJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === COMPANY_KEY ||
    key === 'fart-ferrovie-autolinee-regionali-ticinesi' ||
    key.startsWith('fart') ||
    (company.includes('fart') && (company.includes('ferrovie') || company.includes('autolinee'))) ||
    url.includes('fartiamo.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'fartiamo.ch' || host === 'www.fartiamo.ch';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// HTML fetching
// ─────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; FrontaliereBot/1.0; +https://frontaliereticino.ch)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return '';
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// parseFartListingPage and buildFartDescription are imported from ./lib/fart-job-parser.mjs

// ─────────────────────────────────────────────────────────────
// Category & experience detection
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/conducente|autista|macchinista|chauffeur/i.test(t)) return 'transport';
  if (/meccanico|tecnico|manutenz|officina|riparaz/i.test(t)) return 'technical';
  if (/contabil|finanz|amministra|conteg/i.test(t)) return 'admin';
  if (/capo\s+dipartimento|dirett|manager|coordinat|responsabile/i.test(t)) return 'management';
  if (/capo\s+movimento|capo\s+stazione/i.test(t)) return 'management';
  if (/pulizia|verifica|addetto|operaio/i.test(t)) return 'operations';
  if (/stage|stagiaire|stagist/i.test(t)) return 'internship';
  if (/apprendist|afc|cfp|formazione/i.test(t)) return 'apprenticeship';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/apprendist|afc|cfp|stage|stagist|stagiaire|junior|addetto/i.test(t)) return 'ENTRY';
  if (/senior|capo|dirett|manager|head|responsabile/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(title = '') {
  const pctMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (pctMatch) {
    const max = parseInt(pctMatch[2], 10);
    return max >= 100 ? 'FULL_TIME' : 'PART_TIME';
  }
  if (/100\s*%|full[\s-]?time/i.test(title)) return 'FULL_TIME';
  if (/part[\s-]?time|50%|60%|70%|80%/i.test(title)) return 'PART_TIME';
  if (/stage|stagiaire/i.test(title)) return 'INTERN';
  return 'FULL_TIME';
}

// ─────────────────────────────────────────────────────────────
// Main discovery
// ─────────────────────────────────────────────────────────────

async function fetchFartJobs() {
  console.log(`📡 Fetching careers page: ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL);
  if (!html) {
    console.warn('⚠️ Failed to fetch careers page.');
    return [];
  }

  const listings = parseFartListingPage(html);
  console.log(`📋 Found ${listings.length} concorso(i) on page.`);

  const seenPdfUrls = new Set();
  const jobs = [];

  for (const listing of listings) {
    // Deduplicate by PDF URL
    if (seenPdfUrls.has(listing.pdfUrl)) {
      console.log(`  ⏭️  Skipping duplicate: ${listing.title}`);
      continue;
    }
    seenPdfUrls.add(listing.pdfUrl);

    console.log(`  📄 Processing: ${listing.title}`);

    const pdfContent = listing.pdfUrl
      ? await extractPdfJobContentFromUrl(listing.pdfUrl)
      : { rawText: '', text: '', error: '' };

    if (listing.pdfUrl && pdfContent.error) {
      console.warn(`  ⚠️ PDF extraction failed for "${listing.title}": ${pdfContent.error}`);
    }

    // Pass rawText so buildFartDescription applies normalizePdfJobText exactly once.
    // Fall back to already-normalized text if rawText is unavailable.
    const { description, warnings } = buildFartDescription(
      listing.title,
      pdfContent.rawText || pdfContent.text || ''
    );
    for (const w of warnings) {
      console.warn(`  ⚠️ ${w}`);
    }
    const slug = slugify(listing.title, COMPANY_KEY);

    const job = {
      title: listing.title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location: 'Locarno',
      canton: HQ.canton,
      country: 'CH',
      url: listing.pdfUrl,
      applyUrl: CAREERS_URL,
      description,
      category: detectCategory(listing.title),
      sector: 'Trasporti pubblici / Ferrovia',
      employmentType: detectEmploymentType(listing.title),
      experienceLevel: detectExperienceLevel(listing.title),
      source: 'fart-crawler',
      sourceLang: detectLang(description || listing.title, 'it'),
      postedDate: new Date().toISOString().slice(0, 10),
      titleByLocale: { it: listing.title },
      descriptionByLocale: { it: description },
      slugByLocale: { it: slug },
      _targetScope: { canton: HQ.canton, location: 'Locarno' },
    };

    jobs.push(job);
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────

function jobMatchKey(job) {
  return `${slugify(job.title)}-${COMPANY_KEY}`;
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonTargetJobs = allJobs.filter((j) => !isTargetJob(j));
  const existingTargetJobs = allJobs.filter(isTargetJob);

  const existingByKey = new Map();
  for (const job of existingTargetJobs) {
    existingByKey.set(jobMatchKey(job), job);
  }

  const discoveredByKey = new Map();
  for (const job of discoveredJobs) {
    discoveredByKey.set(jobMatchKey(job), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = jobMatchKey(discovered);
    const ex = existingByKey.get(key);

    if (ex) {
      const updatedJob = {
        ...ex,
        title: discovered.title || ex.title,
        company: COMPANY_NAME,
        companyKey: COMPANY_KEY,
        location: discovered.location || ex.location,
        canton: HQ.canton,
        country: 'CH',
        url: discovered.url || ex.url,
        applyUrl: discovered.applyUrl || ex.applyUrl,
        category: discovered.category || ex.category,
        sector: discovered.sector || ex.sector,
        source: 'fart-crawler',
        titleByLocale: mergeLocaleTextMap(ex.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(ex.slugByLocale, discovered.slugByLocale, 3),
      };

      if (
        discovered.description &&
        discovered.description.length > (ex.description || '').length
      ) {
        updatedJob.description = discovered.description;
      }

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  for (const [key] of existingByKey) {
    if (!discoveredByKey.has(key)) removed++;
  }

  const final = [...nonTargetJobs, ...merged];

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
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = COMPANY_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html', 'pdf'];
  adapter.seedUrls = [CAREERS_URL];
  adapter.notes =
    'WordPress CMS — "Concorsi" listings with h5 titles and PDF download links.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '10',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '10',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isTargetJob(job)) continue;

    if (job.company !== COMPANY_NAME) {
      job.company = COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== COMPANY_KEY) {
      job.companyKey = COMPANY_KEY;
      fixed++;
    }
    job.canton = HQ.canton;
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Locarno';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🔧 Post-processed ${fixed} FART jobs (fixed company/location/canton).`
    );
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
  const targetJobs = allJobs.filter(isTargetJob);

  console.log(`\n📊 === FART Job Stats ===`);
  console.log(`  🚂 Total FART jobs: ${targetJobs.length}`);

  if (targetJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Locarno'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'FART');
  writeCrawlChangeSummaryToGH(crawlDiff, 'FART');
  return { total: targetJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_FART_STRICT',
    label: 'FART',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_fart_domain',
    failWhenNoJobs: false,
    noJobsMessage:
      'No FART jobs found — the company may not have active concorsi.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'FART');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  FART — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching FART jobs...');

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchFartJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No FART jobs discovered.');
    console.log(
      '   The careers page may have changed structure or have no current concorsi.'
    );
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization
  console.log(
    '\n🌐 Running base crawler for AI localization of FART jobs...'
  );
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log(
      'ℹ️ No FART jobs found after crawl. No error — exiting OK.'
    );
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ FART crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'FART',
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
  console.error(`❌ FART crawler failed: ${err?.message || err}`);
  process.exit(1);
});
