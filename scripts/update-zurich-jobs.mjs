#!/usr/bin/env node
/**
 * Dedicated Zurich Insurance crawler runner.
 * Runs only Zurich Insurance jobs (careers.zurich.com — SuccessFactors ATS)
 * and enforces full locale coverage for SEO-critical fields.
 *
 * The Zurich careers portal supports `locationsearch` query parameter.
 * We search across major Ticino and Graubünden cities to maximize job discovery.
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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, normalize } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const ZURICH_KEY = 'zurich-insurance-sede-ticino';

/**
 * Broad search terms for the Zurich careers portal (SuccessFactors ATS).
 * We use region-level queries rather than individual city searches:
 * - "Ticino" / "Tessin" cover ALL positions in the TI canton (IT / DE naming)
 * - "Lugano" catches jobs tagged specifically by city in the main hub
 * - "Graubünden" / "Grisons" / "Chur" cover GR canton positions
 * Keeping the list short is critical: each seed URL triggers a full BFS crawl
 * in crawlGenericListingJobs() (up to 8 listing + 12 detail pages per seed).
 */
const SEED_SEARCH_TERMS = ['Ticino', 'Tessin', 'Lugano', 'Graubünden', 'Grisons', 'Chur'];

const ZURICH_SEARCH_BASE = 'https://www.careers.zurich.com/search/';

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isZurichJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key.includes('zurich-insurance') ||
    key === ZURICH_KEY ||
    host.includes('careers.zurich.com') ||
    host.includes('zurich.com') ||
    (company.includes('zurich') && company.includes('insurance'))
  );
}

function isTrustedZurichDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('zurich.com') || host.endsWith('careers.zurich.com');
  } catch {
    return false;
  }
}

/**
 * Build the seed URLs for the adapter JSON.
 * Uses broad region-level search terms to keep HTTP request count manageable.
 */
function buildSeedUrls() {
  return SEED_SEARCH_TERMS.map(
    (term) =>
      `${ZURICH_SEARCH_BASE}?createNewAlert=false&q=&locationsearch=${encodeURIComponent(term)}&optionsFacetsDD_shifttype=&optionsFacetsDD_department=&optionsFacetsDD_customfield3=`
  );
}

/**
 * Ensure the Zurich adapter JSON has the correct seed URLs.
 * Replaces all seed URLs with the current broad search terms
 * to prevent stale per-city URLs from accumulating.
 */
function ensureAdapterSeedUrls() {
  const adapterPath = path.join(ADAPTERS_DIR, `${ZURICH_KEY}.json`);
  const seedUrls = buildSeedUrls();

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${ZURICH_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: ZURICH_KEY,
      companyName: 'Zurich Insurance (sede Ticino)',
      companyHost: 'careers.zurich.com',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      notes: 'SuccessFactors ATS at careers.zurich.com — region-level search across TI + GR.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    // Replace all seed URLs with the current broad search terms
    adapter.seedUrls = seedUrls;
    adapter.companyHost = adapter.companyHost || 'careers.zurich.com';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'SuccessFactors ATS at careers.zurich.com — region-level search across TI + GR.';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${ZURICH_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: ZURICH_KEY,
    localizeOnlyCompanyKeys: ZURICH_KEY,
    forceLocalizeKeys: ZURICH_KEY,
    disableWorkdayForce: true,
  });
}

function ensureSourceLang() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = 0;
  for (const job of jobs) {
    if (!isZurichJob(job)) continue;
    const lang = detectLang(job.description || job.title, 'en');
    if (job.sourceLang !== lang) { job.sourceLang = lang; changed++; }
  }
  if (changed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`📝 Set sourceLang on ${changed} Zurich job(s).`);
  }
}

function logZurichJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const zurichJobs = allJobs.filter(isZurichJob);
  const ticinoJobs = zurichJobs.filter((job) => normalize(job?.canton) === 'ti');
  const grJobs = zurichJobs.filter((job) => normalize(job?.canton) === 'gr');
  const otherJobs = zurichJobs.length - ticinoJobs.length - grJobs.length;

  console.log(`\n📊 === Zurich Insurance Job Stats ===`);
  console.log(`  🔍 Job totali trovati (Zurich Insurance): ${zurichJobs.length} (TI: ${ticinoJobs.length}, GR: ${grJobs.length})`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job in altri cantoni: ${otherJobs}`);
    const examples = zurichJobs
      .filter((job) => !['ti', 'gr'].includes(normalize(job?.canton)))
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(zurichJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Zurich');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Zurich');

  return { total: zurichJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateZurichLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ZURICH_STRICT',
    label: 'Zurich',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isZurichJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedZurichDomain,
    untrustedDomainReason: 'untrusted_domain_for_zurich_job',
    noJobsMessage: 'Nessun job Zurich Insurance trovato dopo il crawl — niente da validare.',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(ZURICH_KEY, 'Zurich');
  console.log('🏛️ Running dedicated Zurich Insurance jobs crawler (with forced localization)...');

  // Ensure the adapter has all TI + GR seed URLs
  ensureAdapterSeedUrls();

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(ZURICH_KEY, DATA_JOBS).filter(isZurichJob))

  await runBaseCrawler();
  ensureSourceLang();

  // Log stats
  const stats = logZurichJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Zurich trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateZurichLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isZurichJob) : [];
  writeJobsCrawlerSlice(ZURICH_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: ZURICH_KEY,
    label: 'Zurich',
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
  console.error(`❌ Zurich Insurance crawler failed: ${err?.message || err}`);
  process.exit(1);
});
