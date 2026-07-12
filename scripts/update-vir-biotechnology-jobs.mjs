#!/usr/bin/env node
/**
 * Dedicated Vir Biotechnology (Humabs BioMed) crawler runner.
 *
 * Vir Biotechnology acquired Humabs BioMed SA, with R&D operations
 * in Bellinzona, Canton Ticino. Uses Greenhouse ATS.
 *
 * Greenhouse API: https://boards-api.greenhouse.io/v1/boards/virbiotechnologyinc/jobs?content=true
 *
 * Discovery flow:
 *   1. Query Greenhouse API for all jobs
 *   2. Filter for Switzerland/Bellinzona positions
 *   3. Build job objects
 *   4. Merge into data/jobs.json
 *   5. Run base crawler for AI localization
 *   6. Post-process and validate
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseGreenhouseJobs, slugify, normalizeSpace, GREENHOUSE_API, inferEmploymentType } from './lib/vir-biotechnology-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'vir-biotechnology';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768, confirmed cause of #3769/#3770).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const HQ = getCompanyDefaults('vir-biotechnology');
const COMPANY_NAME = 'Vir Biotechnology (Humabs BioMed)';
const COMPANY_HOST = 'job-boards.greenhouse.io';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(value = '') { return String(value || '').trim().toLowerCase(); }

function isVirJob(job) {
  const key = normalize(job?.companyKey || '').replace(/[^a-z0-9]+/g, '-');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.startsWith('vir-bio') || company.includes('vir bio') || company.includes('humabs') || url.includes('greenhouse.io/virbiotechnology');
}

function isTrustedDomain(rawUrl = '') {
  try { const host = new URL(rawUrl).hostname.toLowerCase(); return host.includes('greenhouse.io') || host.includes('vir.bio'); }
  catch { return false; }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/engineer|developer|software|it\b|data|devops/i.test(t)) return 'technology';
  if (/scientist|research|r&d|lab|clinical|biotech/i.test(t)) return 'science';
  if (/qa|quality|validation|compliance|regulator/i.test(t)) return 'quality';
  if (/produc|manufactur|operator|technic/i.test(t)) return 'production';
  if (/sales|commercial|marketing|business\s*dev/i.test(t)) return 'sales';
  if (/legal|counsel|patent/i.test(t)) return 'legal';
  if (/account|financ|controller|audit/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/manag|director|head|lead|chief|vp\b/i.test(t)) return 'management';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|apprenti/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b/i.test(t)) return 'SENIOR';
  return 'MID';
}

async function fetchGreenhouseJobs() {
  console.log(`🔍 Fetching Vir Biotechnology jobs from Greenhouse API`);
  console.log(`   API: ${GREENHOUSE_API}`);
  const timeoutMs = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '20000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GREENHOUSE_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for Greenhouse API`); return []; }
    const data = await res.json();
    const swissJobs = parseGreenhouseJobs(data);
    console.log(`  📋 Swiss jobs found: ${swissJobs.length} (of ${data?.jobs?.length || 0} total)`);
    return swissJobs;
  } catch (err) {
    console.warn(`⚠️ Greenhouse API fetch failed: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function buildJobFromGreenhouse(parsed) {
  const slug = slugify(parsed.title, 'vir-biotechnology');
  const descEn = parsed.description || `${parsed.title} position at Vir Biotechnology (Humabs BioMed) in ${parsed.city}, Switzerland.`;
  const descIt = `Posizione aperta presso Vir Biotechnology (Humabs BioMed) a ${parsed.city}.\nRuolo: ${parsed.title}.\n\nVir Biotechnology è un'azienda biotecnologica globale. Humabs BioMed SA opera a Bellinzona, Ticino.`;

  return {
    url: parsed.url,
    applyUrl: parsed.url,
    title: parsed.title,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    location: parsed.city || 'Bellinzona',
    canton: parsed.canton || HQ.canton,
    country: 'CH',
    addressLocality: parsed.city || 'Bellinzona',
    addressRegion: parsed.canton || HQ.addressRegion,
    addressCountry: 'CH',
    postalCode: HQ.postalCode,
    streetAddress: 'Via Mirasole 1',
    description: descEn,
    descriptionByLocale: { en: descEn, it: descIt },
    titleByLocale: { en: parsed.title },
    slug,
    slugByLocale: { en: slug, it: slugify(parsed.title, 'vir-biotechnology') },
    category: detectCategory(parsed.title),
    datePosted: parsed.datePosted || new Date().toISOString().split('T')[0],
    source: 'vir-greenhouse-crawler',
    employmentType: inferEmploymentType(parsed.title, parsed.description),
    experienceLevel: detectExperienceLevel(parsed.title),
    sector: 'Biotecnologia / Farmaceutica',
    _targetScope: { canton: parsed.canton || HQ.canton, location: parsed.city || 'Bellinzona' },
    sourceLang: detectLang(descEn || parsed.title, 'en'),
  };
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isVirJob(j));
  const existingCompanyJobs = allJobs.filter(isVirJob);

  const existingKeys = new Set(existingCompanyJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a Greenhouse title/slug rewrite no longer orphans
  // the job's previousSlugs/previousSlugsByLocale/firstSeenAt history the
  // way the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingCompanyJobs, discoveredJobs).map((job) => ({
    ...job,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    source: 'vir-greenhouse-crawler',
  }));

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
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['api'], seedUrls: [GREENHOUSE_API], notes: 'Greenhouse API — filter Swiss locations (Bellinzona TI).', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, localizeExistingOnly: true, extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '100000', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000' } });
}

function postProcess() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  let fixed = 0;
  for (const job of (Array.isArray(jobs) ? jobs : [])) {
    if (!isVirJob(job)) continue;
    if (job.company !== COMPANY_NAME) { job.company = COMPANY_NAME; fixed++; }
    if (job.companyKey !== COMPANY_KEY) { job.companyKey = COMPANY_KEY; fixed++; }
    job.country = 'CH';
    if (!job.canton) { job.canton = HQ.canton; fixed++; }
    if (!job.location) { job.location = 'Bellinzona'; fixed++; }
  }
  if (fixed > 0) { writeJsonAtomic(DATA_JOBS, jobs); writeJsonAtomic(PUBLIC_JOBS, jobs); console.log(`🔧 Post-processed ${fixed} Vir jobs.`); }
  return;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Vir Biotechnology');
  console.log('═══════════════════════════════════════════════');
  console.log('  Vir Biotechnology (Humabs BioMed) — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');

    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isVirJob))

  const swissJobs = await fetchGreenhouseJobs();
  const discoveredJobs = swissJobs.map(buildJobFromGreenhouse);

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Swiss Vir Biotechnology jobs found. Keeping existing.');
    const afterSnapshot = fs.existsSync(DATA_JOBS) ? snapshotJobSlugs((JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) || []).filter(isVirJob)) : new Map();
    const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
    printCrawlChangeSummary(crawlDiff, 'Vir Biotechnology');
    writeCrawlChangeSummaryToGH(crawlDiff, 'Vir Biotechnology');
    return;
  }

  updateAdapterConfig();
  await mergeJobs(discoveredJobs);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runBaseCrawler();
  postProcess();

  if (!fs.existsSync(DATA_JOBS)) return;
  const finalJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const companyJobs = (Array.isArray(finalJobs) ? finalJobs : []).filter(isVirJob);
  console.log(`\n📊 Vir Biotechnology jobs: ${companyJobs.length}`);
  const afterSnapshot = snapshotJobSlugs(companyJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Vir Biotechnology');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Vir Biotechnology');

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_VIR_BIOTECHNOLOGY_STRICT', label: 'Vir Biotechnology', dataJobsPath: DATA_JOBS, isTargetJob: isVirJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_vir_domain', failWhenNoJobs: false, noJobsMessage: 'No Vir Biotechnology Swiss jobs found.' });
  console.log('\n✅ Vir Biotechnology crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(COMPANY_KEY, companyJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Vir Biotechnology', generatedAt: new Date().toISOString(), total: companyJobs.length, newCount: crawlDiff.newJobs.length, updatedCount: crawlDiff.updatedJobs.length, removedCount: crawlDiff.removedJobs.length, unchangedCount: crawlDiff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedJobs: companyJobs.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Vir Biotechnology'));
