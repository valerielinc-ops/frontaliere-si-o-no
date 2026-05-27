#!/usr/bin/env node
/**
 * Dedicated Julius Baer crawler runner.
 *
 * Julius Baer is a Swiss private banking group headquartered in Zurich,
 * with a significant presence in Lugano, Canton Ticino.
 *
 * Uses Workday ATS:
 *   Listing: POST https://juliusbaer.wd3.myworkdayjobs.com/wday/cxs/juliusbaer/External/jobs
 *   Detail:  GET  https://juliusbaer.wd3.myworkdayjobs.com/wday/cxs/juliusbaer/External/job/{path}
 *
 * NOTE: Site name changed from "JuliusBaer" to "External" (2026-03-25).
 *
 * Filters for Lugano/Ticino positions only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang } from './lib/dedicated-crawler-common.mjs';
import { parseWorkdayListings, parseWorkdayJobDetail, slugify, normalizeSpace, stripHtml, WORKDAY_API_BASE, WORKDAY_PUBLIC_BASE, COMPANY_HOST, isSwissLocation, detectCategory, detectExperienceLevel, detectEmploymentType, buildPublicUrl, parseWorkdayCity } from './lib/julius-baer-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferSwissTargetCanton } from './lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'julius-baer';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Julius Baer';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(value = '') { return String(value || '').trim().toLowerCase(); }

function isJuliusBaerJob(job) {
  const key = normalize(job?.companyKey || '').replace(/[^a-z0-9]+/g, '-');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.startsWith('julius-ba') || company.includes('julius ba') || company.includes('julius bär') || url.includes('juliusbaer.wd3.myworkdayjobs.com');
}

function isTrustedDomain(rawUrl = '') {
  try { const host = new URL(rawUrl).hostname.toLowerCase(); return host === COMPANY_HOST || host.endsWith('.myworkdayjobs.com') || host.includes('juliusbaer'); }
  catch { return false; }
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'en,it-CH;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)', ...options.headers } });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.json();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
}

// Workday `Location_Country` facet ID for Switzerland on the Julius Baer tenant.
// This is the same Workday-wide CH identifier used by Fielmann/Lonza and other
// Workday-hosted Swiss employers; it is stable across tenants.
const SWISS_COUNTRY_FACET_ID = '187134fccb084a0ea9b4b95f23890dbe';

/**
 * Paginate the Workday API for all Switzerland-based postings.
 *
 * Previously this used a hardcoded `Location_Region_State_Province` facet ID
 * for Lugano plus narrow `searchText` probes ("Lugano", "Ticino", "Manno",
 * "Bellinzona"). When Julius Baer has no Ticino openings the region facet
 * returns nothing AND none of the text probes match — so the crawler reported
 * "0 via facet / 0 total" even when there were ~190 jobs globally and ~90 in
 * Switzerland. By fetching the whole CH country facet and relying on the
 * shared `isSwissLocation` check (cathedral TARGET_CANTONS) we capture jobs
 * in any target canton (ZH / GE / SG today, TI when they reopen) without
 * relying on tenant-specific region IDs that drift.
 */
async function listAllJobs() {
  const seenPaths = new Set();
  const allPostings = [];

  console.log(`  🔍 Strategy: Location_Country facet filter (Switzerland: ${SWISS_COUNTRY_FACET_ID})`);
  let offset = 0;
  const limit = 20;
  // Julius Baer's Workday tenant only returns `total` on the first page —
  // subsequent pages report total=0 even when they have rows. So we capture
  // the total once and only stop when (a) we've reached it, or (b) a page
  // comes back shorter than the page size (last page).
  let knownTotal = Infinity;
  while (true) {
    const body = JSON.stringify({ appliedFacets: { Location_Country: [SWISS_COUNTRY_FACET_ID] }, limit, offset, searchText: '' });
    const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, { method: 'POST', body });
    if (!data || !Array.isArray(data.jobPostings)) break;
    if (offset === 0 && Number.isFinite(data.total) && data.total > 0) knownTotal = data.total;
    for (const p of data.jobPostings) {
      if (!seenPaths.has(p.externalPath)) { seenPaths.add(p.externalPath); allPostings.push(p); }
    }
    if (data.jobPostings.length < limit) break;
    if (allPostings.length >= knownTotal) break;
    offset += limit;
  }
  console.log(`     Found: ${allPostings.length} via facet`);

  return allPostings;
}

async function fetchJobDetail(externalPath) {
  return fetchJson(`${WORKDAY_API_BASE}${externalPath}`);
}

async function fetchJuliusBaerJobs() {
  console.log(`🔍 Fetching Julius Baer jobs from Workday API`);
  console.log(`   API: ${WORKDAY_API_BASE}/jobs`);

  const allListings = await listAllJobs();
  console.log(`  📋 Total listings: ${allListings.length}`);

  // Filter for any target Swiss canton
  const swissListings = allListings.filter((p) => isSwissLocation(p.locationsText || ''));
  console.log(`  📋 Swiss target-canton listings: ${swissListings.length}`);

  if (swissListings.length === 0) return [];

  const jobs = [];
  for (const listing of swissListings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;
    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);
    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) continue;

    const locationRaw = info.location || listing.locationsText || '';
    const city = parseWorkdayCity(locationRaw) || 'Lugano';
    // Cathedral: derive canton from the actual city. Defaults to Ticino HQ
    // (and the matching Lugano postal/street) only when inference fails.
    const inferredCanton = inferSwissTargetCanton(`${city} ${locationRaw}`) || DEFAULT_CANTON;
    const isLuganoHq = inferredCanton === 'TI';
    const postalCode = isLuganoHq ? '6900' : '';
    const streetAddress = isLuganoHq ? 'Via Pretorio 22' : '';
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildPublicUrl(externalPath);
    const descEn = descriptionText || `${title} position at Julius Baer in ${city}, Switzerland.`;
    const descIt = `Posizione aperta presso Julius Baer a ${city}.\nRuolo: ${title}.\n\nJulius Baer è uno dei principali gruppi bancari privati svizzeri con sede a Zurigo e uffici a Lugano, Ticino.`;
    const slug = slugify(title, 'julius-baer');

    jobs.push({
      url: publicUrl, applyUrl: publicUrl, title, company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: city, canton: inferredCanton, country: 'CH',
      addressLocality: city, addressRegion: inferredCanton, addressCountry: 'CH',
      postalCode, streetAddress,
      description: descEn, descriptionByLocale: { en: descEn, it: descIt },
      titleByLocale: { en: title }, slug, slugByLocale: { en: slug, it: slugify(title, 'julius-baer') },
      category: detectCategory(title), datePosted: info.startDate || new Date().toISOString().split('T')[0],
      source: 'julius-baer-workday-crawler', employmentType: detectEmploymentType(info.timeType || ''),
      sourceLang: detectLang(descEn || title, 'en'),
      experienceLevel: detectExperienceLevel(title), sector: 'Banking / Wealth Management',
      _targetScope: { canton: inferredCanton, location: city },
    });
  }
  console.log(`\n📋 Total unique Julius Baer Swiss target-canton jobs: ${jobs.length}`);
  return jobs;
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }
function filterEmpty(obj = {}) { if (!obj || typeof obj !== 'object') return {}; const out = {}; for (const [k, v] of Object.entries(obj)) { if (v && String(v).trim()) out[k] = v; } return out; }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isJuliusBaerJob(j));
  const existingByUrl = new Map();
  for (const job of allJobs.filter(isJuliusBaerJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) discoveredByUrl.set(canonicalizeUrl(job.url), job);

  let added = 0, updated = 0, removed = 0;
  const merged = [];
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url);
    const ex = existingByUrl.get(key);
    if (ex) { merged.push({
      ...ex,
      ...d,
      titleByLocale: mergeLocaleTextMap(ex.titleByLocale, d.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, d.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(ex.slugByLocale, d.slugByLocale, 3),
      previousSlugs: [...new Set([...(ex.previousSlugs || []), ...(d.previousSlugs || [])])].slice(0, 20),
    }); updated++; }
    else { merged.push(d); added++; }
  }
  for (const [url] of existingByUrl) { if (!discoveredByUrl.has(url)) removed++; }

  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`\n📦 Merge: ➕${added} 🔄${updated} 🗑️${removed} 📊${final.length}`);
  return { added, updated, removed, total: final.length };
}

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const adapter = fs.existsSync(adapterPath) ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) : {};
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['api'], seedUrls: [WORKDAY_PUBLIC_BASE], notes: 'Workday API at juliusbaer.wd3.myworkdayjobs.com — Swiss positions across cathedral target cantons.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Julius Baer');
  console.log('═══════════════════════════════════════════════');
  console.log('  Julius Baer — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');

    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isJuliusBaerJob))

  const discoveredJobs = await fetchJuliusBaerJobs();
  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Swiss target-canton Julius Baer jobs discovered. Keeping existing.');
    const afterSnapshot = fs.existsSync(DATA_JOBS) ? snapshotJobSlugs((JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) || []).filter(isJuliusBaerJob)) : new Map();
    printCrawlChangeSummary(computeCrawlDiff(beforeSnapshot, afterSnapshot), 'Julius Baer');
    writeCrawlChangeSummaryToGH(computeCrawlDiff(beforeSnapshot, afterSnapshot), 'Julius Baer');
    return;
  }

  updateAdapterConfig();
  await mergeJobs(discoveredJobs);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '50', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50' } });

  // Post-process
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let fixed = 0;
    for (const j of (Array.isArray(jobs) ? jobs : [])) { if (!isJuliusBaerJob(j)) continue; if (j.company !== COMPANY_NAME) { j.company = COMPANY_NAME; fixed++; } j.companyKey = COMPANY_KEY; j.country = 'CH'; if (!j.canton) { j.canton = DEFAULT_CANTON; fixed++; } if (!j.location) { j.location = 'Lugano'; fixed++; } }
    if (fixed > 0) { fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n'); fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n'); }
  }

  const finalJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const companyJobs = (Array.isArray(finalJobs) ? finalJobs : []).filter(isJuliusBaerJob);
  console.log(`\n📊 Julius Baer Swiss target-canton jobs: ${companyJobs.length}`);
  const diff = computeCrawlDiff(beforeSnapshot, snapshotJobSlugs(companyJobs));
  printCrawlChangeSummary(diff, 'Julius Baer');
  writeCrawlChangeSummaryToGH(diff, 'Julius Baer');
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_JULIUS_BAER_STRICT', label: 'Julius Baer', dataJobsPath: DATA_JOBS, isTargetJob: isJuliusBaerJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_julius_baer_domain', failWhenNoJobs: false, noJobsMessage: 'No Julius Baer Swiss target-canton jobs found.' });
  console.log('\n✅ Julius Baer crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(COMPANY_KEY, companyJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Julius Baer', generatedAt: new Date().toISOString(), total: companyJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`❌ Julius Baer crawler failed: ${err?.message || err}`); process.exit(1); });
