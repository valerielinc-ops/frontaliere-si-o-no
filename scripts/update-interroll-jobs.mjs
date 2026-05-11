#!/usr/bin/env node
/**
 * Dedicated Interroll Group (Sant'Antonino, TI) crawler runner.
 *
 * Interroll uses TYPO3 CMS with a custom jobs page at:
 *   https://www.interroll.com/company/careers/jobs/
 * Detail pages at: /company/careers/jobs/job-detail/{slug}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { parseListingPage, isSwissLocation, slugify, detectCategory, detectExperienceLevel, inferEmploymentType } from './lib/interroll-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'interroll';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Interroll Group';
const COMPANY_HOST = 'www.interroll.com';
const CAREERS_URL = 'https://www.interroll.com/company/careers/jobs/';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }
function isCompanyJob(job) {
  const key = normalize(job?.companyKey || ''); const company = normalize(job?.company || ''); const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('interroll') || company.includes('interroll') || url.includes('interroll.com');
}
function isTrustedDomain(rawUrl = '') { try { return new URL(rawUrl).hostname.toLowerCase().includes('interroll.com'); } catch { return false; } }

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,it-CH;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    clearTimeout(timer); if (!res.ok) { console.warn(`⚠️ HTTP ${res.status}`); return null; } return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
}

async function fetchJobs() {
  console.log(`🔍 Fetching Interroll jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Interroll careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 Total jobs: ${listings.length}`);
  const swissJobs = listings.filter((j) => isSwissLocation(j.location));
  console.log(`  🇨🇭 Swiss jobs: ${swissJobs.length}`);

  return swissJobs.map((raw) => {
    const slug = slugify(raw.title, 'interroll');
    return {
      url: raw.url, applyUrl: raw.url, title: raw.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: "Sant'Antonino", canton: DEFAULT_CANTON, country: 'CH',
      addressLocality: "Sant'Antonino", addressRegion: 'TI', addressCountry: 'CH',
      postalCode: '6592', streetAddress: 'Via Gorelle 3',
      description: `${raw.title} position at Interroll Group in Sant'Antonino, Ticino. Interroll is a global technology company providing material handling solutions.`,
      titleByLocale: { en: raw.title }, descriptionByLocale: {},
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(raw.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'interroll-careers-crawler', employmentType: inferEmploymentType(raw.title, raw.snippet || ''),
      sourceLang: detectLang(raw.title, 'en'),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Industria / Logistica',
    };
  });
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingByUrl = new Map();
  for (const job of (Array.isArray(existing) ? existing : []).filter(isCompanyJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const merged = []; let added = 0, updated = 0;
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url); const old = existingByUrl.get(key);
    if (old) { merged.push({ ...old, ...d, titleByLocale: mergeLocaleTextMap(old.titleByLocale, d.titleByLocale, 3), descriptionByLocale: mergeLocaleTextMap(old.descriptionByLocale, d.descriptionByLocale, 30), slugByLocale: mergeLocaleTextMap(old.slugByLocale, d.slugByLocale, 3) }); updated++; }
    else { merged.push(d); added++; }
  }
  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`📦 Merge: ➕ ${added}, 🔄 ${updated}, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: "TYPO3 CMS careers page — Interroll Group jobs in Sant'Antonino, TI.", updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Interroll Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Interroll Swiss jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_INTERROLL_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_interroll_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Interroll crawler complete.');
}

main().catch((err) => { console.error(`❌ Interroll crawler failed: ${err?.message || err}`); process.exit(1); });
