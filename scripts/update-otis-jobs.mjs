#!/usr/bin/env node
/**
 * Dedicated Otis SA crawler runner.
 *
 * Source:
 *   https://otis.wd504.myworkdayjobs.com/REC_Ext_Gateway
 *
 * Otis uses a Workday portal for job listings. This crawler uses the
 * Workday JSON API (POST for listings, GET for details).
 */
import { sourcePostingDateFields } from './lib/source-posting-date.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceLangOfBody } from './lib/source-locale-slots.mjs';
import {
  fetchOtisJobUrls,
  fetchOtisDetailPage,
  slugify,
  inferEmploymentType,
  buildPublicUrl,
} from './lib/otis-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { dropIdenticalPostings } from './lib/identical-posting-dedupe.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { collectThinSourceJobsForQuarantine, keepStoredSourceBodiesByKey, sourceBodyForJob } from './lib/stored-source-body.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'otis';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Otis SA';

function sameLocality(a, b) {
  const key = (value) => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
  return Boolean(key(a)) && key(a) === key(b);
}

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('otis.wd504.myworkdayjobs.com') || url.includes('otis.wd5.myworkdayjobs.com');
}

function jobMatchKey(job) {
  return extractStableJobId(job?.url)
    || String(job?.url || '').trim().replace(/\/+$/, '');
}

// Otis migrated their Workday pod from wd5 to wd504 (observed 2026-08-11,
// issue #5597) — wd5 now 500s permanently, a genuine tenant move, not
// transient bot-blocking. mergePreserveLocaleData's match key is host-prefixed
// (job-url-key.mjs Rule W, by design, to stop distinct Workday tenants from
// colliding on a bare requisition id), so the same requisition under the old
// wd5 host and the new wd504 host never matches — the wd5 copy just sits in
// the 2-run grace period meant for transient fetch failures, showing up as a
// same-title/same-body duplicate of its wd504 replacement (issue #5657). We
// know wd5 is dead for good (fetchOtisJobUrls only ever queries wd504), so
// there is nothing transient left to protect: drop wd5 rows immediately
// instead of waiting out the grace period. computeCrawlDiff still sees them
// vanish from `published` and files them as removedJobs, same archive path
// a real 2-miss expiry would take.
function isLegacyTenantJob(job) {
  return String(job?.url || '').toLowerCase().includes('otis.wd5.myworkdayjobs.com');
}

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
  }
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const companyExisting = allJobs.filter((job) => isCompanyJob(job) && !isLegacyTenantJob(job));
  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    byUrl.set(key, job);
  }
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
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Otis');
  console.log(`\ud83d\udfd7 Running dedicated ${COMPANY_NAME} crawler...`);

  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));

  const rawJobs = await fetchOtisJobUrls();
  if (rawJobs.length === 0) {
    console.log('\u26a0\ufe0f No jobs found on Otis Workday portal. Keeping existing jobs.');
    await rewriteStoredJobsWithoutThinSource(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Otis job links. Fetching details...`);
  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchOtisDetailPage(raw.externalPath);
    const description = detail?.description || '';
    const publicUrl = buildPublicUrl(raw.externalPath);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    // Prefer detail city (from full location text) over listing city. Otis runs
    // a national service network, so leave the field blank when unresolved and
    // let the PLZ/locality hardening derive it.
    const city = detail?.city || raw.city || '';
    // City-first: resolve the (detail-preferred) city alone before the raw
    // listing location, so the more authoritative city wins over the array-order
    // sensitivity of a combined string.
    const canton = inferAnyCanton(city) || inferAnyCanton(raw.location) || detail?.canton || '';
    // The branch address printed in the ad ("Location: Nenzlingerweg 2, 4153
    // Reinach") is the workplace, when it names the same town as the req.
    // Street and postal code are set only when the ad prints both: a missing
    // part is never guessed, so the posting's workplace stays unresolved and
    // it is never grouped with another (identical-posting-dedupe).
    const site = detail?.siteAddress;
    const siteAddress = site && site.streetAddress && site.postalCode
      && sameLocality(site.locality, city)
      ? { postalCode: site.postalCode, streetAddress: site.streetAddress }
      : {};
    const jobSlug = slugify(`${raw.title}-otis-${safeLocationToken(city, 'Switzerland')}`);
    // The language the body is written in, not a fixed `en` key.
    const sourceLang = sourceLangOfBody(description, 'en');
    parsedJobs.push({
      id: `otis-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: 'otis.com',
      title: raw.title,
      titleByLocale: { [sourceLang]: raw.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      sourceLang,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      location: city,
      canton,
      addressLocality: city,
      ...siteAddress,
      addressCountry: 'CH',
      category: 'manufacturing',
      contract: 'full-time',
      employmentType: detail?.employmentType || inferEmploymentType(raw.title, description),
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(detail?.datePosted),
      url: publicUrl,
      source: 'Otis Dedicated Parser (Workday)',
      crawledAt: new Date().toISOString(),
    });
    if (meetsSourceBodyFloor(description)) console.log(`  \u2705 ${raw.title} \u2014 ${raw.city}`);
    else console.log(`  \u26a0\ufe0f  ${raw.title}: source body below 50 words — quarantining`);
  }

  if (parsedJobs.length === 0) {
    console.log('\u26a0\ufe0f No valid jobs parsed. Keeping existing jobs.');
    await rewriteStoredJobsWithoutThinSource(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
    return;
  }

  // Two Workday reqs carrying the very same ad (title, branch address, text)
  // are one vacancy to a reader, and publishing both made two identical
  // pages. A req whose ad prints no full branch address is never grouped.
  const { jobs: uniqueJobs, dropped } = dropIdenticalPostings(parsedJobs);
  if (dropped.length > 0) {
    console.log(`  \ud83e\uddf9 Dropped ${dropped.length} double publication(s) (same title, site and text under another req).`);
  }

  const stats = mergeCompanyJobs(uniqueJobs);
  if (stats.noPublishableJobs) {
    console.warn(`⚠️ ${COMPANY_NAME}: all detail bodies are below the 50-word source-body floor; quarantining thin-source rows.`);
    await rewriteStoredJobsWithoutThinSource(stats.targetExisting);
    return;
  }
  const published = stats.jobs;
  printPublishedJobUrls(published, 'Otis');
  writeJobsSummary(published, 'Otis');

  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Otis');
  writeCrawlChangeSummaryToGH(diff, 'Otis');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });

  validateDedicatedLocaleCoverage({
    strictEnvVar: `JOBS_${COMPANY_KEY.toUpperCase()}_STRICT`,
    label: 'Otis',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCompanyJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: `No ${COMPANY_NAME} jobs found after crawl.`,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
  });

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
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Otis', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Otis'));
