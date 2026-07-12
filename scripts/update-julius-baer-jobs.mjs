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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang } from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { parseWorkdayListings, parseWorkdayJobDetail, slugify, normalizeSpace, stripHtml, WORKDAY_API_BASE, WORKDAY_PUBLIC_BASE, COMPANY_HOST, isSwissLocation, detectCategory, detectExperienceLevel, detectEmploymentType, buildPublicUrl, parseWorkdayCity } from './lib/julius-baer-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferSwissTargetCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'julius-baer';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'en,it-CH;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)', ...options.headers } });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.json();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
  finally { clearTimeout(timer); }
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
    // Reuse the real scraped Workday description (which carries genuine
    // bullet markup converted by stripHtml()) as the interim 'it' value too.
    // Previously this always wrote a synthetic per-city boilerplate paragraph
    // regardless of whether real content was scraped — that paragraph has no
    // list markup and, because effectiveDescription() checks the 'it' locale
    // before 'en', it masked the real bulleted content for both the
    // parser-quality audit and real Italian-locale site visitors. Only fall
    // back to synthetic boilerplate when no real description was scraped.
    const descIt = descriptionText
      ? descEn
      : `Posizione aperta presso Julius Baer a ${city}.\nRuolo: ${title}.\n\nJulius Baer è uno dei principali gruppi bancari privati svizzeri con sede a Zurigo e uffici a Lugano, Ticino.`;
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

function filterEmpty(obj = {}) { if (!obj || typeof obj !== 'object') return {}; const out = {}; for (const [k, v] of Object.entries(obj)) { if (v && String(v).trim()) out[k] = v; } return out; }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isJuliusBaerJob(j));
  const existingCompanyJobs = allJobs.filter(isJuliusBaerJob);

  const existingKeys = new Set(existingCompanyJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingCompanyJobs, discoveredJobs);

  const final = [...nonCompanyJobs, ...merged];
  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);
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
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '100000', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000' } });

  // Post-process
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let fixed = 0;
    for (const j of (Array.isArray(jobs) ? jobs : [])) { if (!isJuliusBaerJob(j)) continue; if (j.company !== COMPANY_NAME) { j.company = COMPANY_NAME; fixed++; } j.companyKey = COMPANY_KEY; j.country = 'CH'; if (!j.canton) { j.canton = DEFAULT_CANTON; fixed++; } if (!j.location) { j.location = 'Lugano'; fixed++; } }
    if (fixed > 0) { writeJsonAtomic(DATA_JOBS, jobs); writeJsonAtomic(PUBLIC_JOBS, jobs); }
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

main().catch((err) => exitCrawlerOnError(err, 'Julius Baer'));
