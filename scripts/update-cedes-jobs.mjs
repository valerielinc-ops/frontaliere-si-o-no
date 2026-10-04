#!/usr/bin/env node
/**
 * Dedicated CEDES AG single-site crawler runner.
 * Source: https://www.cedes.com/en/career/jobs/
 * CEDES currently publishes openings for its Landquart (GR) site only;
 * Landquart/7302 are intentional mono-site fallbacks, not a regional filter.
 */
import { sourcePostingDateFields } from './lib/source-posting-date.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSliceVerified, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs } from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceLangOfBody } from './lib/source-locale-slots.mjs';
import { fetchCedesJobUrls, fetchCedesDetailPage, slugify, inferEmploymentType } from './lib/cedes-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { collectThinSourceJobsForQuarantine, keepStoredSourceBodiesByKey, sourceBodyForJob } from './lib/stored-source-body.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'cedes';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'CEDES AG';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('cedes.com');
}

function jobMatchKey(job) {
  return extractStableJobId(job?.url)
    || String(job?.url || '').trim().replace(/\/+$/, '');
}

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const companyExisting = allJobs.filter((job) => isCompanyJob(job));
  const byUrl = new Map();
  for (const job of parsedJobs) { const key = String(job?.url || '').trim().replace(/\/+$/, ''); if (!key) continue; byUrl.set(key, job); }
  const deduped = [...byUrl.values()];
  const sourceBodyJobs = keepStoredSourceBodiesByKey(deduped, companyExisting, jobMatchKey);
  const merged = mergePreserveLocaleData(companyExisting, sourceBodyJobs);
  // Non-source slots the merge kept that are not in their own language go
  // back to the translation pipeline.
  for (const job of merged) dropStaleLocaleDescriptions(job);
  const thinSourceJobs = collectThinSourceJobsForQuarantine(deduped, merged, jobMatchKey);
  const clean = merged
    .filter((job) => meetsSourceBodyFloor(sourceBodyForJob(job)))
    .sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  writeJobsFiles([...others, ...clean]);
  return {
    jobs: clean,
    targetExisting: companyExisting,
    sourceBodyJobs,
    thinSourceJobs,
    noPublishableJobs: sourceBodyJobs.length === 0,
  };
}

async function rewriteStoredJobsWithoutThinSource(storedJobs) {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => jobs,
    storedJobs,
    companyKey: COMPANY_KEY,
    companyLabel: COMPANY_NAME,
    write: (jobs, options) => writeJobsCrawlerSliceVerified(COMPANY_KEY, jobs, {
      isTargetJob: isCompanyJob,
      ...options,
    }),
    assemble: () => assembleJobsDataset(),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'CEDES');
  console.log('📡 Running dedicated CEDES AG crawler...');
  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
  const rawJobs = await fetchCedesJobUrls();
  if (rawJobs.length === 0) {
    const outcome = rawJobs.fetchOutcome || 'unverified_empty';
    const detail = rawJobs.fetchDetail ? ` (${rawJobs.fetchDetail})` : '';
    console.log(`⚠️ No verified CEDES job links returned [${outcome}]${detail}. Keeping existing.`);
    await rewriteStoredJobsWithoutThinSource(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
    return;
  }
  console.log(`🧩 Found ${rawJobs.length} job links. Fetching details...`);

  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchCedesDetailPage(raw.url);
    const description = detail?.description || '';
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-cedes-${safeLocationToken(raw.location)}`);
    // The language the body is written in, not a fixed `en` key.
    const sourceLang = sourceLangOfBody(description, 'en');
    parsedJobs.push({
      id: `cedes-${urlHash}`, slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'cedes.com',
      title: raw.title, titleByLocale: { [sourceLang]: raw.title },
      description, descriptionByLocale: { [sourceLang]: description },
      requirements: [], requirementsByLocale: { [sourceLang]: [] },
      location: HQ.city, canton: HQ.canton,
      addressLocality: HQ.city, addressRegion: HQ.addressRegion,
      postalCode: HQ.postalCode, addressCountry: 'CH',
      category: 'technology', contract: 'full-time',
      employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF', featured: false, ...sourcePostingDateFields(''),
      url: raw.url, source: 'CEDES Dedicated Parser', sourceLang, crawledAt: new Date().toISOString(),
    });
    if (meetsSourceBodyFloor(description)) console.log(`  ✅ ${raw.title} — ${raw.location}`);
    else console.log(`  ⚠️  ${raw.title}: source body below 50 words — quarantining`);
  }

  if (parsedJobs.length === 0) {
    console.log('⚠️ No valid jobs parsed.');
    await rewriteStoredJobsWithoutThinSource(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
    return;
  }
  const stats = mergeCompanyJobs(parsedJobs);
  if (stats.noPublishableJobs) {
    console.warn(`⚠️ ${COMPANY_NAME}: all detail bodies are below the 50-word source-body floor; quarantining thin-source rows.`);
    await rewriteStoredJobsWithoutThinSource(stats.targetExisting);
    return;
  }
  const published = stats.jobs;
  printPublishedJobUrls(published, 'CEDES'); writeJobsSummary(published, 'CEDES');
  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'CEDES'); writeCrawlChangeSummaryToGH(diff, 'CEDES');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_CEDES_STRICT', label: 'CEDES', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No CEDES AG jobs found.', detectSourceLang: (text) => detectLang(text, 'de'), deriveSlug: deriveLocalizedSlug });

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw)
    ? _sliceRaw.filter(isCompanyJob).filter((job) => meetsSourceBodyFloor(sourceBodyForJob(job)))
    : [];
  const removedKeys = new Set((diff.removedJobs || []).map(jobMatchKey).filter(Boolean));
  const thinQuarantineJobs = stats.thinSourceJobs.filter((job) => removedKeys.has(jobMatchKey(job)));
  const housekeepingProof = thinQuarantineJobs.length > 0
    ? thinQuarantineJobs.map((job) => ({ job, reason: 'thin-source-quarantine', definitive: true }))
    : undefined;
  await writeJobsCrawlerSliceVerified(COMPANY_KEY, _sliceJobs, {
    isTargetJob: isCompanyJob,
    ...(housekeepingProof ? { housekeepingProof, verifyUnprovenHousekeeping: true } : {}),
  });
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'CEDES', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0,30), updatedJobs: diff.updatedJobs.slice(0,30), removedJobs: diff.removedJobs.slice(0,30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'CEDES'));
