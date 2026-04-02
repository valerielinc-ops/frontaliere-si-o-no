#!/usr/bin/env node
/**
 * Dedicated Ferrovia Retica (RhB) crawler runner.
 *
 * Source:
 *   https://www.rhb.ch/it/lavoro-carriera/candidatura-posti-vacanti/job-uebersicht/
 *
 * Ferrovia Retica (RhB) is the largest employer in Graubünden,
 * operating the most extensive narrow-gauge railway in Switzerland (~1400 employees).
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
import { parseListingPage, parseDetailPage, buildJob, buildFallbackDescription, stripHtml } from './lib/ferrovia-retica-job-parser.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'ferrovia-retica';
const COMPANY_NAME = 'Ferrovia Retica (RhB)';
const COMPANY_HOST = 'www.rhb.ch';
const CAREERS_URL = 'https://www.rhb.ch/it/lavoro-carriera/candidatura-posti-vacanti/job-uebersicht/';
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
    key.includes('ferrovia-retica') ||
    key.includes('rhb') ||
    company.includes('ferrovia-retica') ||
    company.includes('rhb') ||
    host === COMPANY_HOST ||
    host === 'rhb.ch'
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host === 'rhb.ch';
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

  // Fetch detail pages to get rich descriptions
  const jobs = [];
  for (const listing of rawListings) {
    if (listing.url) {
      console.log(`    🔗 Fetching detail page: ${listing.url}`);
      try {
        const detailHtml = await fetchHtml(listing.url, timeoutMs);
        if (detailHtml) {
          const detail = parseDetailPage(detailHtml);
          if (detail && detail.description && detail.description.split(/\s+/).length >= 30) {
            listing.description = detail.description;
            if (detail.location) listing.location = detail.location;
            console.log(`    ✅ Detail description: ${detail.description.split(/\s+/).length} words`);
          } else {
            console.log(`    ⚠️ Detail page description too short (${(detail?.description || '').split(/\s+/).length} words), using fallback`);
          }
        }
      } catch (err) {
        console.log(`    ⚠️ Could not fetch detail page: ${err.message}`);
      }
      // Small delay to be respectful to the server
      await new Promise((r) => setTimeout(r, 500));
    }

    const job = buildJob(listing);
    if (job) {
      console.log(`  ✅ ${job.title} (${job.location}) — ${job.description.split(/\s+/).length} words`);
      jobs.push(job);
    }
  }

  console.log(`📋 Total unique ${COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function mergeJobs(discoveredJobs) {
  let allJobs = [];
  if (fs.existsSync(DATA_JOBS)) {
    allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    if (!Array.isArray(allJobs)) allJobs = [];
  }

  const existingByUrl = new Map();
  for (const j of allJobs) {
    if (isCompanyJob(j)) {
      existingByUrl.set(String(j.url || '').toLowerCase().replace(/\/+$/, ''), j);
    }
  }

  let added = 0, updated = 0;
  for (const job of discoveredJobs) {
    const key = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const existing = existingByUrl.get(key);
    if (existing) {
      Object.assign(existing, { title: job.title, company: job.company, companyKey: job.companyKey, location: job.location, canton: job.canton, country: job.country, category: job.category, description: job.description, postedDate: job.postedDate || existing.postedDate, source: job.source });
      if (!existing.slugByLocale || Object.keys(existing.slugByLocale).length === 0) existing.slugByLocale = mergeLocaleTextMap(existing.slugByLocale, job.slugByLocale, 3);
      if (!existing.titleByLocale || Object.keys(existing.titleByLocale).length === 0) existing.titleByLocale = mergeLocaleTextMap(existing.titleByLocale, job.titleByLocale, 2);
      updated++;
      existingByUrl.delete(key);
    } else { allJobs.push(job); added++; }
  }

  const discoveredUrls = new Set(discoveredJobs.map((j) => String(j.url || '').toLowerCase().replace(/\/+$/, '')));
  const removed = allJobs.filter((j) => isCompanyJob(j) && !discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, ''))).length;
  const finalJobs = allJobs.filter((j) => !isCompanyJob(j) || discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, '')));

  writeJson(DATA_JOBS, finalJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, finalJobs);
  console.log(`  ➕ Added: ${added}\n  🔄 Updated: ${updated}\n  ➖ Removed: ${removed}\n  📦 Total: ${finalJobs.length}`);
}

/* ── Adapter ───────────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  let adapter = {};
  try { adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')); } catch { /* first run */ }
  const seedMetaByUrl = {};
  for (const url of seedUrls) seedMetaByUrl[url] = { company: COMPANY_NAME, companyDomain: 'rhb.ch' };
  adapter = { ...adapter, companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls, seedMetaByUrl, notes: 'Rhaetian Railway, largest employer in Graubünden. Career page HTML crawler.', updatedAt: new Date().toISOString() };
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
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${COMPANY_NAME} — Dedicated Crawler`);
  console.log('═══════════════════════════════════════════════');

  let beforeMap = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    if (Array.isArray(jobs)) beforeMap = snapshotJobSlugs(jobs.filter(isCompanyJob));
  }

  const discoveredJobs = await fetchJobs();
  const diff = discoveredJobs.diff;
  if (discoveredJobs.length === 0) { console.log('ℹ️  No job listings found — skipping crawl.'); return; }

  const seedUrls = discoveredJobs.map((j) => j.url);
  mergeJobs(discoveredJobs);
  updateAdapterConfig(seedUrls);
  await runBaseCrawler();
  postProcess();

  // Stats
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    const companyJobs = Array.isArray(jobs) ? jobs.filter(isCompanyJob) : [];
    const after = snapshotJobSlugs(companyJobs);
    const diff = computeCrawlDiff(beforeMap, after);
    printCrawlChangeSummary(diff, COMPANY_NAME);
    writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
    console.log(`\n🏦 Total ${COMPANY_NAME} jobs: ${companyJobs.length}`);
    for (const j of companyJobs) console.log(`  • ${j.title} (${j.location})`);
  }

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_FERROVIA_RETICA_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_rhb_domain', failWhenNoJobs: false, noJobsMessage: `No ${COMPANY_NAME} jobs found — the company may not have active openings.` });

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
