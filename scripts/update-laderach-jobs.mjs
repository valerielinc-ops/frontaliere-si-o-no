#!/usr/bin/env node
/**
 * Dedicated Läderach (Schweiz) AG crawler runner.
 * Source: https://laderach.career.softgarden.de/
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSliceVerified, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs } from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceLangOfBody } from './lib/source-locale-slots.mjs';
import { fetchLaderachJobUrls, fetchLaderachDetailPage, slugify, inferEmploymentType } from './lib/laderach-job-parser.mjs';
import {
  inferAnyCanton,
  isTargetSwissLocation,
  swissCityFromLocationField,
} from './lib/target-swiss-locations.mjs';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { keepStoredSourceBodiesByKey, sourceBodyForJob } from './lib/stored-source-body.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'laderach';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Läderach (Schweiz) AG';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('laderach');
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
  const thinSourceJobs = merged.filter((job) => !meetsSourceBodyFloor(sourceBodyForJob(job)));
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
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Läderach');
  console.log('🍫 Running dedicated Läderach crawler...');
  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
  const rawJobs = await fetchLaderachJobUrls();
  if (rawJobs.length === 0) {
    console.log('⚠️ No jobs found. Keeping existing publishable jobs and quarantining thin-source rows.');
    await rewriteStoredJobsWithoutThinSource(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
    return;
  }
  console.log(`🧩 Found ${rawJobs.length} job links. Fetching details...`);

  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchLaderachDetailPage(raw.url);
    if (!detail?.description || !meetsSourceBodyFloor(detail.description)) { console.log(`  ⚠️  ${raw.title}: source body below 50 words — quarantining`); continue; }
    const description = detail.description;
    // Validate that this is a Swiss location.
    // Use the shared all-canton Swiss-location gate; the canton is derived
    // from the same source for each posting.
    const rawLocation = String(raw.location || '');
    const inferredCanton = inferAnyCanton(rawLocation);
    // A foreign locality can share a name with a Swiss canton (for example
    // Freiburg im Breisgau vs. canton FR). Require a recognized Swiss
    // municipality or an explicit country marker after the shared gate.
    const hasSwissCity = Boolean(swissCityFromLocationField(rawLocation));
    const hasSwissCountry = /\b(?:ch|switzerland|schweiz|suisse|svizzera)\b/i.test(rawLocation);
    const isSwiss = isTargetSwissLocation(rawLocation, { includeBorderProximity: false })
      && (hasSwissCity || hasSwissCountry);
    if (!isSwiss) {
      console.log(`  ⚠️  Non-Swiss location (${raw.location}) — skipping: ${raw.title}`);
      continue;
    }
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-laderach-${safeLocationToken(raw.location, 'Switzerland')}`);
    // The language the body is written in, not a fixed `de` key.
    const sourceLang = sourceLangOfBody(description, 'de');
    parsedJobs.push({
      id: `laderach-${urlHash}`, slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'laderach.com',
      title: raw.title, titleByLocale: { [sourceLang]: raw.title },
      description, descriptionByLocale: { [sourceLang]: description },
      sourceLang,
      requirements: [], requirementsByLocale: { [sourceLang]: [] },
      location: rawLocation, canton: inferredCanton,
      addressLocality: rawLocation, addressCountry: 'CH',
      category: 'manufacturing', contract: 'full-time',
      employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF', featured: false, postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url, source: 'Läderach Dedicated Parser', crawledAt: new Date().toISOString(),
    });
    console.log(`  ✅ ${raw.title} — ${raw.location}`);
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
  printPublishedJobUrls(published, 'Läderach'); writeJobsSummary(published, 'Läderach');
  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Läderach'); writeCrawlChangeSummaryToGH(diff, 'Läderach');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_LADERACH_STRICT', label: 'Läderach', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No Läderach jobs found.', detectSourceLang: (text) => detectLang(text, 'de'), deriveSlug: deriveLocalizedSlug });

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw)
    ? _sliceRaw.filter(isCompanyJob).filter((job) => meetsSourceBodyFloor(sourceBodyForJob(job)))
    : [];
  const removedKeys = new Set((diff.removedJobs || []).map(jobMatchKey).filter(Boolean));
  const thinQuarantineJobs = stats.thinSourceJobs.filter((job) => removedKeys.has(jobMatchKey(job)));
  const housekeepingProof = thinQuarantineJobs.length > 0
    && thinQuarantineJobs.length === (diff.removedJobs || []).length
    ? thinQuarantineJobs.map((job) => ({ job, reason: 'thin-source-quarantine', definitive: true }))
    : undefined;
  await writeJobsCrawlerSliceVerified(COMPANY_KEY, _sliceJobs, {
    isTargetJob: isCompanyJob,
    ...(housekeepingProof ? { housekeepingProof } : {}),
  });
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Läderach', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0,30), updatedJobs: diff.updatedJobs.slice(0,30), removedJobs: diff.removedJobs.slice(0,30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Läderach'));
