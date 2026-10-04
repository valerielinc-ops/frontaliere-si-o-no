#!/usr/bin/env node
/**
 * Dedicated Vir Biotechnology (Humabs BioMed) crawler runner.
 *
 * Vir Biotechnology acquired Humabs BioMed SA, with Swiss R&D operations
 * including Bellinzona, Canton Ticino. Uses Greenhouse ATS.
 *
 * Greenhouse API: https://boards-api.greenhouse.io/v1/boards/virbiotechnologyinc/jobs?content=true
 *
 * Discovery flow:
 *   1. Query Greenhouse API for all jobs
 *   2. Filter for Swiss positions and infer each posting's canton
 *   3. Build job objects
 *   4. Merge into data/jobs.json
 *   5. Run base crawler for AI localization
 *   6. Post-process and validate
 */
import { sourcePostingDateFields } from './lib/source-posting-date.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceSlotTitleAndSlug } from './lib/source-locale-slots.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  classifyGreenhouseFetchError,
  classifyGreenhouseResponse,
  slugify,
  GREENHOUSE_API,
  inferEmploymentType,
  buildVirDescriptionFields,
  dropVirFabricatedText,
} from './lib/vir-biotechnology-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { keepStoredSourceBodies } from './lib/stored-source-body.mjs';

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
  if (/\b(junior|jr\.?|entry|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenti)/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b/i.test(t)) return 'SENIOR';
  return 'MID';
}

async function fetchGreenhouseJobs(counts) {
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
    if (!res.ok) {
      const error = new Error(`Greenhouse API returned HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    const classified = classifyGreenhouseResponse(data);
    Object.assign(counts, {
      discovered: classified.discovered,
      parsed: classified.parsed,
      lastFetchOutcome: classified.lastFetchOutcome,
      abortKind: classified.abortKind,
      authoritativeEmptySnapshot: classified.authoritativeEmptySnapshot,
      authoritativeSnapshotVerified: classified.authoritativeSnapshotVerified,
    });
    console.log(`  📋 Swiss jobs found: ${classified.parsed} (of ${classified.discovered} source jobs)`);
    return classified.jobs;
  } catch (err) {
    // fetch-failure-empty-ok: bespoke runner outside runStandardCrawlerPipeline: a throw is an unclassified exit 1, not the template connection-level soft exit
    const classified = classifyGreenhouseFetchError(err);
    Object.assign(counts, {
      discovered: 0,
      parsed: 0,
      lastFetchOutcome: classified.lastFetchOutcome,
      abortKind: classified.abortKind,
      authoritativeEmptySnapshot: false,
      authoritativeSnapshotVerified: false,
    });
    console.warn(`⚠️ Greenhouse API fetch failed: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function buildJobFromGreenhouse(parsed) {
  const slug = slugify(parsed.title, 'vir-biotechnology');
  // Only the posting's own text, keyed by its language (no fabricated `it`).
  const { description: descEn, descriptionByLocale, sourceLang } = buildVirDescriptionFields(parsed);

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
    descriptionByLocale,
    // Title and slug in the body's source slot, not a fixed `en`/`it`.
    ...sourceSlotTitleAndSlug(parsed.title, slug, sourceLang),
    slug,
    category: detectCategory(parsed.title),
    ...sourcePostingDateFields(parsed.datePosted),
    crawledAt: new Date().toISOString(),
    source: 'vir-greenhouse-crawler',
    employmentType: inferEmploymentType(parsed.title, parsed.description),
    experienceLevel: detectExperienceLevel(parsed.title),
    sector: 'Biotecnologia / Farmaceutica',
    _targetScope: { canton: parsed.canton || HQ.canton, location: parsed.city || 'Bellinzona' },
    sourceLang,
  };
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isVirJob(j));
  const existingCompanyJobs = allJobs.filter(isVirJob);
  const fossils = existingCompanyJobs.filter((job) => dropVirFabricatedText(job)).length;
  if (fossils > 0) console.log(`  🧹 Dropped the fabricated Italian blurb from ${fossils} stored job(s); they will be retranslated`);
  // Under the shared word floor the builder emits no body: keep the stored
  // source body (fossils already dropped above), or omit the job this run.
  const withBody = keepStoredSourceBodies(discoveredJobs, existingCompanyJobs, (url) => extractStableJobId(url) || url);
  if (withBody.length < discoveredJobs.length) {
    console.log(`  ⏭️ ${discoveredJobs.length - withBody.length} job(s) without a source body over the word floor: not published this run`);
  }
  discoveredJobs = withBody;

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
  // Non-source slots the merge kept that are not in their own language go
  // back to the translation pipeline.
  for (const job of merged) dropStaleLocaleDescriptions(job);

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
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['api'], seedUrls: [GREENHOUSE_API], notes: 'Greenhouse API — filter Swiss locations and retain the resolved canton per posting.', updatedAt: new Date().toISOString() });
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
  const summaryCounts = {
    discovered: null,
    parsed: null,
    lastFetchOutcome: null,
    abortKind: null,
    authoritativeEmptySnapshot: false,
    authoritativeSnapshotVerified: false,
  };
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Vir Biotechnology', summaryCounts);
  console.log('═══════════════════════════════════════════════');
  console.log('  Vir Biotechnology (Humabs BioMed) — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');

    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isVirJob))

  const swissJobs = await fetchGreenhouseJobs(summaryCounts);
  const discoveredJobs = swissJobs.map(buildJobFromGreenhouse);

  if (discoveredJobs.length === 0) {
    if (summaryCounts.abortKind === null && summaryCounts.lastFetchOutcome) {
      const durationMs = getCrawlerElapsedMs();
      console.log('\n⚠️ No Swiss Vir Biotechnology jobs found. Keeping existing.');
      writeSummaryCrawlerSlice({
        key: COMPANY_KEY,
        label: 'Vir Biotechnology',
        generatedAt: new Date().toISOString(),
        total: 0,
        discovered: summaryCounts.discovered ?? 0,
        parsed: summaryCounts.parsed ?? 0,
        written: 0,
        lastFetchOutcome: summaryCounts.lastFetchOutcome,
        abortKind: null,
        authoritativeEmptySnapshot: summaryCounts.authoritativeEmptySnapshot,
        authoritativeSnapshotVerified: summaryCounts.authoritativeSnapshotVerified,
        newCount: 0,
        updatedCount: 0,
        removedCount: 0,
        unchangedCount: 0,
        durationMs,
        avgDurationMs: durationMs,
        durationHistory: [durationMs],
        newJobs: [],
        updatedJobs: [],
        removedJobs: [],
        unchangedJobs: [],
      });
      return;
    }
    summaryCounts.abortKind ||= 'no-jobs-parsed';
    console.log('\n⚠️ Vir Biotechnology produced no publishable Swiss jobs; keeping existing slice for diagnosis.');
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
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Vir Biotechnology', generatedAt: new Date().toISOString(), total: companyJobs.length, newCount: crawlDiff.newJobs.length, updatedCount: crawlDiff.updatedJobs.length, removedCount: crawlDiff.removedJobs.length, unchangedCount: crawlDiff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Vir Biotechnology'));
