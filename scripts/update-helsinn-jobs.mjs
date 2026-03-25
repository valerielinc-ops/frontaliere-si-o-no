#!/usr/bin/env node
/**
 * Dedicated Helsinn Healthcare SA (Lugano, TI) crawler runner.
 *
 * Helsinn uses jobopportunity.ch for job listings.
 * Listing: https://helsinn.jobopportunity.ch/index.php?module=profile_mod&submod=jobs
 * Detail: https://helsinn.jobopportunity.ch/index.php?module=profile_mod&submod=jobs&func=detail&id={id}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice, assembleJobsDataset } from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage } from './lib/dedicated-crawler-common.mjs';
import { parseListingPage, parseDetailPage, slugify, detectCategory, detectExperienceLevel } from './lib/helsinn-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'helsinn';
const COMPANY_NAME = 'Helsinn Healthcare SA';
const COMPANY_HOST = 'helsinn.jobopportunity.ch';
const CAREERS_URL = 'https://helsinn.jobopportunity.ch/index.php?module=profile_mod&submod=jobs';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }

function isCompanyJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('helsinn') || company.includes('helsinn') || url.includes('helsinn');
}

function isTrustedDomain(rawUrl = '') {
  try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('helsinn'); } catch { return false; }
}

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,it-CH;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
}

async function fetchJobs() {
  console.log(`🔍 Fetching Helsinn jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Helsinn careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 Jobs found: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    const slug = slugify(listing.title, 'helsinn');
    jobs.push({
      url: listing.url, applyUrl: listing.url, title: listing.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: listing.location || 'Lugano', canton: 'TI', country: 'CH',
      description: `${listing.title} position at Helsinn Healthcare SA in Lugano, Ticino. Helsinn is a fully integrated biopharma company with a track record of over forty years.`,
      titleByLocale: { en: listing.title }, descriptionByLocale: {},
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(listing.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'helsinn-careers-crawler', employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(listing.title),
      sector: 'Farmaceutica / Biopharma',
    });
  }
  return jobs;
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }

async function mergeJobs(discoveredJobs) {
  const existing = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingByUrl = new Map();
  for (const job of (Array.isArray(existing) ? existing : []).filter(isCompanyJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const merged = [];
  let added = 0, updated = 0;
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url);
    const old = existingByUrl.get(key);
    if (old) { merged.push({ ...old, ...d, titleByLocale: { ...old.titleByLocale, ...d.titleByLocale }, descriptionByLocale: { ...old.descriptionByLocale, ...d.descriptionByLocale }, slugByLocale: { ...old.slugByLocale, ...d.slugByLocale } }); updated++; }
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
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'jobopportunity.ch platform — Helsinn Healthcare SA jobs in Lugano/Pambio Noranco.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  console.log('═══════════════════════════════════════════════');
  console.log('  Helsinn Healthcare SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
  let beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) { try { const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')); beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isCompanyJob) : []); } catch {} }
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Helsinn jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_HELSINN_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_helsinn_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : []).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = (fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : []).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: 0, updatedCount: 0, removedCount: 0, unchangedCount: _sliceJobs.length, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Helsinn crawler complete.');
}

main().catch((err) => { console.error(`❌ Helsinn crawler failed: ${err?.message || err}`); process.exit(1); });
