#!/usr/bin/env node
/**
 * Dedicated Città di Lugano crawler runner.
 *
 * Source:
 *   https://www.lugano.ch/temi-servizi/lavoro-e-impresa/concorsi-pubblici-posti-lavoro/
 *
 * Città di Lugano is the municipality of the largest city in Ticino,
 * the main urban center of Italian-speaking Switzerland (~3000 employees).
 *
 * This script:
 *   1. Fetches the career page HTML.
 *   2. Parses job listings using the dedicated parser.
 *   3. Fetches detail pages for additional content.
 *   4. Merges discovered jobs into data/jobs.json.
 *   5. Updates the adapter config.
 *   6. Runs the shared base crawler for AI localization.
 *   7. Post-processes and validates.
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
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  normalize,
  normalizeKey,
mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { parseListingPage, parseDetailPage, buildJob, stripHtml } from './lib/citta-di-lugano-job-parser.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
} from './lib/pdf-job-content.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'citta-di-lugano';
const COMPANY_NAME = 'Città di Lugano';
const COMPANY_HOST = 'www.lugano.ch';
const CAREERS_URL = 'https://www.lugano.ch/temi-servizi/lavoro-e-impresa/concorsi-pubblici-posti-lavoro/';
const LOCALES = ['it', 'en', 'de', 'fr'];
const UA = process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matcher ───────────────────────────────────────────────── */
function isCompanyJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  return (
    key === COMPANY_KEY ||
    key.includes('citta-di-lugano') ||
    key.includes('citta-lugano') ||
    company.includes('citta-di-lugano') ||
    company.includes('città di lugano') ||
    host === COMPANY_HOST ||
    host === 'lugano.ch' || host === 'egov.lugano.ch'
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host === 'lugano.ch' || host === 'egov.lugano.ch';
  } catch { return false; }
}

/* ── Fetch ─────────────────────────────────────────────────── */
async function fetchHtml(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function fetchJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  console.log(`🔍 Fetching ${COMPANY_NAME} career page...`);

  let html;
  try { html = await fetchHtml(CAREERS_URL, timeoutMs); } catch (err) {
    console.error(`❌ Failed to fetch career page: ${err?.message || err}`);
    throw err;
  }

  const rawListings = parseListingPage(html);
  console.log(`📋 Found ${rawListings.length} listing(s) on career page.`);

  const jobs = [];
  for (const listing of rawListings) {
    const job = buildJob(listing);
    if (!job) continue;

    // Enrich description with PDF content when available
    const pdfUrl = listing.pdfUrl || job.pdfUrl || '';
    if (pdfUrl) {
      console.log(`  📄 Extracting PDF: ${pdfUrl}`);
      const pdfContent = await extractPdfJobContentFromUrl(pdfUrl);
      if (pdfContent.error) {
        console.warn(`  ⚠️ PDF extraction failed for "${job.title}": ${pdfContent.error}`);
      } else if (pdfContent.text) {
        console.log(`  ✅ PDF extracted (${pdfContent.text.length} chars, ${pdfContent.totalPages} pages)`);
        job.description = buildPdfBackedDescription({
          introLines: [
            `## ${job.title}`,
            `${COMPANY_NAME} — concorso pubblico a Lugano (TI), Svizzera.`,
          ],
          pdfText: pdfContent.text,
          fallbackText: job.description || '',
          footerLines: [
            `**Settore:** Pubblica Amministrazione`,
            `**Sede:** Via Nizzola 5, 6900 Lugano, TI, Svizzera`,
            `[Bando ufficiale (PDF)](${pdfUrl})`,
          ],
        });
        job.descriptionByLocale = { it: job.description };
      }
    }

    console.log(`  ✅ ${job.title} (${job.location})`);
    jobs.push(job);
  }

  console.log(`📋 Total unique ${COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isCompanyJob(job));
  const targetExisting = existing.filter(isCompanyJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    return {
      ...prev,
      ...job,
      postedDate: job.postedDate || prev.postedDate,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      salaryMin: prev.salaryMin || job.salaryMin,
      salaryMax: prev.salaryMax || job.salaryMax,
      currency: prev.currency || job.currency,
      sourceLang: prev.sourceLang || job.sourceLang,
      needsRetranslation: prev.needsRetranslation ?? job.needsRetranslation,
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  console.log(`  ➕ Added: ${added}\n  🔄 Updated: ${updated}\n  ➖ Removed: ${targetExisting.length - updated}\n  📦 Total: ${mergedTarget.length}`);
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter ───────────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  let adapter = {};
  try { adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')); } catch { /* first run */ }
  const seedMetaByUrl = {};
  for (const url of seedUrls) seedMetaByUrl[url] = { company: COMPANY_NAME, companyDomain: 'lugano.ch' };
  adapter = { ...adapter, companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls, seedMetaByUrl, notes: 'Municipality of Lugano, public administration. Career page HTML crawler.', updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Base crawler ──────────────────────────────────────────── */
async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcess() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = false;
  const seenKeys = new Map();
  const processed = jobs.filter((job) => {
    if (!isCompanyJob(job)) return true;
    if (job.company !== COMPANY_NAME) { job.company = COMPANY_NAME; changed = true; }
    if (job.companyKey !== COMPANY_KEY) { job.companyKey = COMPANY_KEY; changed = true; }
    const dedupKey = String(job.url || '').toLowerCase().replace(/\/+$/, '') || normalizeKey(job.slug || job.title || '');
    if (seenKeys.has(dedupKey)) return false;
    seenKeys.set(dedupKey, true);
    return true;
  });
  if (changed || processed.length !== jobs.length) {
    writeJson(DATA_JOBS, processed);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, processed);
    console.log(`🔧 Post-processed: ${jobs.length} → ${processed.length} jobs`);
  }
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${COMPANY_NAME} — Dedicated Crawler`);
  console.log('═══════════════════════════════════════════════');

  const discoveredJobs = await fetchJobs();
  let diff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  if (discoveredJobs.length === 0) { console.log('ℹ️  No job listings found — skipping crawl.'); return; }

  const seedUrls = discoveredJobs.map((j) => j.url);
  const mergeResult = mergeJobs(discoveredJobs);
  diff = mergeResult.diff;
  updateAdapterConfig(seedUrls);
  await runBaseCrawler();
  postProcess();

  // Stats
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    const companyJobs = Array.isArray(jobs) ? jobs.filter(isCompanyJob) : [];
    console.log(`\n🏦 Total ${COMPANY_NAME} jobs: ${companyJobs.length}`);
    for (const j of companyJobs) console.log(`  • ${j.title} (${j.location})`);
  }

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_CITTA_DI_LUGANO_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_lugano_domain', failWhenNoJobs: false, noJobsMessage: `No ${COMPANY_NAME} jobs found — the company may not have active openings.` });

  console.log(`✅ ${COMPANY_NAME} crawler complete.`);

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) { main().catch((err) => { console.error(`❌ ${COMPANY_NAME} crawler failed:`, err); process.exit(1); }); }
