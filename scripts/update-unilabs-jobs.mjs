#!/usr/bin/env node
/**
 * Dedicated Unilabs crawler runner.
 *
 * Source:
 *   https://apply.workable.com/unilabs/
 *
 * Unilabs uses a Workable platform for job listings. This crawler uses the
 * Workable widget JSON API for listing and detail endpoints.
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
} from './lib/dedicated-crawler-common.mjs';
import {
  fetchUnilabsJobUrls,
  fetchUnilabsDetailPage,
  slugify,
  inferEmploymentType,
  buildPublicUrl,
} from './lib/unilabs-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'unilabs';
const COMPANY_NAME = 'Unilabs';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('workable.com/unilabs');
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
  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    byUrl.set(key, job);
  }
  const clean = [...byUrl.values()].sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  const merged = [...others, ...clean];
  writeJobsFiles(merged);
  return clean;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Unilabs');
  console.log(`\ud83d\udd2c Running dedicated ${COMPANY_NAME} crawler...`);

  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));

  const rawJobs = await fetchUnilabsJobUrls();
  if (rawJobs.length === 0) {
    console.log('\u26a0\ufe0f No jobs found on Unilabs Workable portal. Keeping existing jobs.');
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Unilabs job links. Fetching details...`);
  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchUnilabsDetailPage(raw.shortcode);
    if (!detail?.description || detail.description.length < 120) {
      console.log(`  \u26a0\ufe0f  ${raw.title}: description too short (${detail?.description?.length || 0} chars) \u2014 skipping`);
      continue;
    }
    const description = detail.description;
    const publicUrl = buildPublicUrl(raw.shortcode);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-unilabs-${raw.city || 'manno'}`);
    parsedJobs.push({
      id: `unilabs-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { it: jobSlug, en: jobSlug, de: jobSlug, fr: jobSlug },
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: 'unilabs.com',
      title: raw.title,
      titleByLocale: { it: raw.title, en: raw.title, de: raw.title, fr: raw.title },
      description,
      descriptionByLocale: { it: description },
      requirements: detail.requirements || [],
      requirementsByLocale: { it: detail.requirements || [], en: [], de: [], fr: [] },
      location: raw.city || 'Manno',
      canton: 'TI',
      addressLocality: raw.city || 'Manno',
      addressCountry: 'CH',
      category: 'healthcare',
      contract: 'full-time',
      employmentType: detail.employmentType || inferEmploymentType(raw.title, description),
      currency: 'CHF',
      featured: false,
      postedDate: detail.publishedDate || new Date().toISOString().slice(0, 10),
      url: publicUrl,
      source: 'Unilabs Dedicated Parser (Workable)',
      crawledAt: new Date().toISOString(),
    });
    console.log(`  \u2705 ${raw.title} \u2014 ${raw.city || 'Manno'}`);
  }

  if (parsedJobs.length === 0) {
    console.log('\u26a0\ufe0f No valid jobs parsed. Keeping existing jobs.');
    return;
  }

  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Unilabs');
  writeJobsSummary(published, 'Unilabs');

  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Unilabs');
  writeCrawlChangeSummaryToGH(diff, 'Unilabs');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });

  validateDedicatedLocaleCoverage({
    strictEnvVar: `JOBS_${COMPANY_KEY.toUpperCase()}_STRICT`,
    label: 'Unilabs',
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
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Unilabs', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`\u274c Unilabs crawler failed: ${err?.message || err}`); process.exit(1); });
