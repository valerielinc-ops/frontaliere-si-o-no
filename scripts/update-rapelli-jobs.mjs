#!/usr/bin/env node
/**
 * Dedicated Rapelli (ORIOR Food AG) crawler runner.
 *
 * Source:
 *   https://careers.orior.ch/go/Rapelli-IT/5365701/
 *
 * Rapelli's careers are hosted on ORIOR's SuccessFactors instance.
 * Job detail pages follow: /job/{Location}-{Title}-TI/{jobId}/
 */
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
  writeJobsCrawlerSlice,
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
import {
  fetchRapelliJobUrls,
  fetchRapelliDetailPage,
  slugify, inferEmploymentType,
} from './lib/rapelli-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'rapelli';
const COMPANY_NAME = 'Rapelli - ORIOR Food AG';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('careers.orior.ch');
}

function writeJobsFiles(jobs) {
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  }
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const companyExisting = allJobs.filter((job) => isCompanyJob(job));
  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];
  const merged = mergePreserveLocaleData(companyExisting, deduped);
  const clean = merged.sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  writeJobsFiles([...others, ...clean]);
  return clean;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Rapelli');
  console.log(`\ud83c\udf56 Running dedicated ${COMPANY_NAME} crawler...`);

    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const rawJobs = await fetchRapelliJobUrls();
  if (rawJobs.length === 0) {
    console.log('\u26a0\ufe0f No jobs found on Rapelli careers page. Keeping existing jobs.');
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Rapelli job links. Fetching details...`);
  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchRapelliDetailPage(raw.url);
    if (!detail?.description || detail.description.length < 120) {
      console.log(`  ⚠️  ${raw.title}: description too short (${detail?.description?.length || 0} chars) — skipping`);
      continue;
    }
    const description = detail.description;
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-rapelli-${raw.location}`);
    // Only set source locale (IT) — other locales will be filled by:
    // 1. mergePreserveLocaleData (preserves existing translations from previous runs)
    // 2. translate-pending pipeline (AI translation for missing locales)
    // Setting all locales to the raw title causes mergeLocaleTextMap to
    // incorrectly overwrite real translations via the length-comparison fallback.
    parsedJobs.push({
      id: `rapelli-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { it: jobSlug },
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: 'rapelli.ch',
      title: raw.title,
      titleByLocale: { it: raw.title },
      description,
      descriptionByLocale: { it: description },
      requirements: [],
      requirementsByLocale: { it: [] },
      location: raw.location || 'Stabio',
      canton: getCompanyDefaults('rapelli').canton,
      addressLocality: raw.location || 'Stabio',
      addressCountry: 'CH',
      category: 'manufacturing',
      contract: 'full-time', employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url,
      source: 'Rapelli Dedicated Parser (ORIOR Careers)',
      sourceLang: detectLang(description || raw.title, 'it'),
      crawledAt: new Date().toISOString(),
    });
    console.log(`  \u2705 ${raw.title} \u2014 ${raw.location}`);
  }

  if (parsedJobs.length === 0) {
    console.log('\u26a0\ufe0f No valid jobs parsed. Keeping existing jobs.');
    return;
  }

  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Rapelli');
  writeJobsSummary(published, 'Rapelli');

  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Rapelli');
  writeCrawlChangeSummaryToGH(diff, 'Rapelli');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });

  validateDedicatedLocaleCoverage({
    strictEnvVar: `JOBS_${COMPANY_KEY.toUpperCase()}_STRICT`,
    label: 'Rapelli',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCompanyJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: `No ${COMPANY_NAME} jobs found after crawl.`,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
  });

  const _durationMs = getCrawlerElapsedMs();
  // Read from DATA_JOBS (just written by mergeCompanyJobs), not from the per-crawler
  // slice which still has stale data at this point.
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Rapelli', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`\u274c Rapelli crawler failed: ${err?.message || err}`); process.exit(1); });
