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
import { parseWorkdayListings, parseWorkdayJobDetail, slugify, normalizeSpace, stripHtml, WORKDAY_API_BASE, WORKDAY_PUBLIC_BASE, COMPANY_HOST, isTicinoLocation, detectCategory, detectExperienceLevel, detectEmploymentType, buildPublicUrl } from './lib/julius-baer-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

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

/**
 * Discover Lugano/Ticino facet ID dynamically from the API.
 * Falls back to known ID if the API doesn't return facets.
 */
async function discoverLuganoFacetId() {
  const KNOWN_LUGANO_FACET = 'abb0edcf3353016df6283de5bd3b4518';
  try {
    const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, { method: 'POST', body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: 'Lugano' }) });
    if (!data?.facets) return KNOWN_LUGANO_FACET;
    for (const facet of data.facets) {
      if (facet.facetParameter === 'Location_Region_State_Province') {
        for (const v of facet.values || []) {
          if (v.descriptor && v.descriptor.toLowerCase().includes('lugano')) return v.id;
        }
      }
    }
  } catch {}
  return KNOWN_LUGANO_FACET;
}

/**
 * List Ticino/Lugano jobs using multiple strategies:
 * 1. Location facet filter for Lugano region
 * 2. Text search for "Lugano", "Ticino", "Manno"
 * This multi-strategy approach handles Workday API inconsistencies.
 */
async function listAllJobs() {
  const seenPaths = new Set();
  const allPostings = [];

  // Strategy 1: Location facet filter (most reliable)
  const luganoFacetId = await discoverLuganoFacetId();
  console.log(`  🔍 Strategy 1: Location facet filter (Lugano: ${luganoFacetId})`);
  {
    let offset = 0;
    const limit = 20;
    while (true) {
      const body = JSON.stringify({ appliedFacets: { Location_Region_State_Province: [luganoFacetId] }, limit, offset });
      const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, { method: 'POST', body });
      if (!data || !Array.isArray(data.jobPostings)) break;
      for (const p of data.jobPostings) {
        if (!seenPaths.has(p.externalPath)) { seenPaths.add(p.externalPath); allPostings.push(p); }
      }
      if (data.jobPostings.length < limit || allPostings.length >= (data.total || 0)) break;
      offset += limit;
    }
    console.log(`     Found: ${allPostings.length} via facet`);
  }

  // Strategy 2: Text search for Ticino location keywords
  for (const searchText of ['Lugano', 'Ticino', 'Manno', 'Bellinzona']) {
    console.log(`  🔍 Strategy 2: Text search "${searchText}"`);
    let offset = 0;
    const limit = 20;
    let found = 0;
    while (true) {
      const body = JSON.stringify({ appliedFacets: {}, limit, offset, searchText });
      const data = await fetchJson(`${WORKDAY_API_BASE}/jobs`, { method: 'POST', body });
      if (!data || !Array.isArray(data.jobPostings)) break;
      for (const p of data.jobPostings) {
        if (!seenPaths.has(p.externalPath) && isTicinoLocation(p.locationsText || p.title || '')) {
          seenPaths.add(p.externalPath);
          allPostings.push(p);
          found++;
        }
      }
      if (data.jobPostings.length < limit) break;
      offset += limit;
    }
    if (found > 0) console.log(`     Found: ${found} new via "${searchText}"`);
  }

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

  // Filter for Ticino/Lugano
  const ticinoListings = allListings.filter((p) => isTicinoLocation(p.locationsText || ''));
  console.log(`  📋 Ticino/Lugano listings: ${ticinoListings.length}`);

  if (ticinoListings.length === 0) return [];

  const jobs = [];
  for (const listing of ticinoListings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;
    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);
    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) continue;

    const locationRaw = info.location || listing.locationsText || '';
    const city = locationRaw.split(/\s*-\s*/).slice(1).join('-').trim().replace(/,\s*switzerland$/i, '') || 'Lugano';
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildPublicUrl(externalPath);
    const descEn = descriptionText || `${title} position at Julius Baer in Lugano, Switzerland.`;
    const descIt = `Posizione aperta presso Julius Baer a ${city}.\nRuolo: ${title}.\n\nJulius Baer è uno dei principali gruppi bancari privati svizzeri con sede a Zurigo e uffici a Lugano, Ticino.`;
    const slug = slugify(title, 'julius-baer');

    jobs.push({
      url: publicUrl, applyUrl: publicUrl, title, company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: city || 'Lugano', canton: DEFAULT_CANTON, country: 'CH',
      addressLocality: city || 'Lugano', addressRegion: 'TI', addressCountry: 'CH',
      postalCode: '6900', streetAddress: 'Via Pretorio 22',
      description: descEn, descriptionByLocale: { en: descEn, it: descIt },
      titleByLocale: { en: title }, slug, slugByLocale: { en: slug, it: slugify(title, 'julius-baer') },
      category: detectCategory(title), datePosted: info.startDate || new Date().toISOString().split('T')[0],
      source: 'julius-baer-workday-crawler', employmentType: detectEmploymentType(info.timeType || ''),
      sourceLang: detectLang(descEn || title, 'en'),
      experienceLevel: detectExperienceLevel(title), sector: 'Banking / Wealth Management',
      _targetScope: { canton: DEFAULT_CANTON, location: city || 'Lugano' },
    });
  }
  console.log(`\n📋 Total unique Julius Baer Ticino jobs: ${jobs.length}`);
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
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['api'], seedUrls: [`${WORKDAY_PUBLIC_BASE}?q=lugano`], notes: 'Workday API at juliusbaer.wd3.myworkdayjobs.com — Lugano/Ticino positions.', updatedAt: new Date().toISOString() });
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
    console.log('\n⚠️ No Ticino Julius Baer jobs discovered. Keeping existing.');
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
  console.log(`\n📊 Julius Baer Ticino jobs: ${companyJobs.length}`);
  const diff = computeCrawlDiff(beforeSnapshot, snapshotJobSlugs(companyJobs));
  printCrawlChangeSummary(diff, 'Julius Baer');
  writeCrawlChangeSummaryToGH(diff, 'Julius Baer');
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_JULIUS_BAER_STRICT', label: 'Julius Baer', dataJobsPath: DATA_JOBS, isTargetJob: isJuliusBaerJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_julius_baer_domain', failWhenNoJobs: false, noJobsMessage: 'No Julius Baer Ticino jobs found.' });
  console.log('\n✅ Julius Baer crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(COMPANY_KEY, companyJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Julius Baer', generatedAt: new Date().toISOString(), total: companyJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`❌ Julius Baer crawler failed: ${err?.message || err}`); process.exit(1); });
