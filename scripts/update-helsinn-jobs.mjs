#!/usr/bin/env node
/**
 * Dedicated Helsinn Healthcare SA (Lugano, TI) crawler runner.
 *
 * Helsinn exclusively uses the AITI e-lavoro portal for job postings:
 *   https://www.e-lavoro.ch/node/76
 *
 * Individual job detail pages: https://www.e-lavoro.ch/node/{id}
 *
 * Previously used jobopportunity.ch (defunct as of early 2026).
 */
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang } from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceSlotTitleAndSlug } from './lib/source-locale-slots.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseListingPage, slugify, detectCategory, detectExperienceLevel, inferEmploymentType, extractHelsinnJobBody } from './lib/helsinn-job-parser.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'helsinn';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const HQ = getCompanyDefaults('helsinn');
const COMPANY_NAME = 'Helsinn Healthcare SA';
const COMPANY_HOST = 'www.e-lavoro.ch';
const CAREERS_URL = 'https://www.e-lavoro.ch/node/76';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }

function isCompanyJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('helsinn') || company.includes('helsinn') || url.includes('helsinn') || url.includes('e-lavoro.ch');
}

function isTrustedDomain(rawUrl = '') {
  try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('helsinn') || h.includes('e-lavoro.ch'); } catch { return false; }
}

async function fetchPage(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'it,en;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
  finally { clearTimeout(timer); }
}

const DETAIL_DELAY_MS = 1000;

/**
 * Build one Helsinn job from its listing row and the vacancy text of its
 * e-lavoro detail page (issue 5253). The crawler used to be listing-only and
 * published an invented English sentence ("X position at Helsinn Healthcare
 * SA in Lugano … a track record of over forty years.") as the whole
 * description. Only the source text is published now; without at least 50
 * words of it the job is not published (returns null) — the merge keeps a
 * stored record.
 */
export function buildHelsinnJob(listing, body = '') {
  const description = String(body || '').trim();
  if (!meetsSourceBodyFloor(description)) return null;
  const slug = slugify(listing.title, 'helsinn');
  const sourceLang = detectLang(description, 'it');
  return {
    url: listing.url, applyUrl: listing.url, title: listing.title,
    company: COMPANY_NAME, companyKey: COMPANY_KEY,
    location: listing.location || 'Lugano', canton: HQ.canton, country: 'CH',
    addressLocality: 'Lugano-Pambio Noranco', addressRegion: HQ.addressRegion, addressCountry: 'CH',
    postalCode: HQ.postalCode, streetAddress: 'Via Pian Scairolo 9',
    description,
    ...sourceSlotTitleAndSlug(listing.title, slug, sourceLang),
    descriptionByLocale: { [sourceLang]: description },
    slug,
    category: detectCategory(listing.title),
    datePosted: new Date().toISOString().split('T')[0],
    source: 'helsinn-careers-crawler', employmentType: inferEmploymentType(listing.title, description),
    sourceLang,
    experienceLevel: detectExperienceLevel(listing.title),
    sector: 'Farmaceutica / Biopharma',
  };
}

async function fetchJobs() {
  console.log(`🔍 Fetching Helsinn jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Helsinn careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 Jobs found: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const [index, listing] of listings.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
    const job = buildHelsinnJob(listing, extractHelsinnJobBody(await fetchPage(listing.url)));
    if (!job) {
      console.log(`  ⏭️ ${listing.title}: no readable vacancy text on the detail page — not published this run`);
      continue;
    }
    jobs.push(job);
  }
  return jobs;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingCompanyJobs = (Array.isArray(existing) ? existing : []).filter(isCompanyJob);

  const existingKeys = new Set(existingCompanyJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingCompanyJobs, discoveredJobs).map((job) => {
    dropStaleLocaleDescriptions(job);
    return job;
  });

  const final = [...nonCompanyJobs, ...merged];
  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);
  console.log(`📦 Merge: ➕ ${added}, 🔄 ${updated}, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'AITI e-lavoro platform — Helsinn Healthcare SA jobs in Lugano/Pambio Noranco.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Helsinn Healthcare SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Helsinn jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_HELSINN_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_helsinn_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Helsinn crawler complete.');
}

// Guarded so tests can import the helpers without running a live crawl that
// writes the slice and the summary under data/.
if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Helsinn'));
}
