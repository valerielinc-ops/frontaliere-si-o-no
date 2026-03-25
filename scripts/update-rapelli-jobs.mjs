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
  assembleJobsDataset,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
} from './lib/dedicated-crawler-common.mjs';
import {
  fetchRapelliJobUrls,
  fetchRapelliDetailPage,
  slugify, inferEmploymentType,
} from './lib/rapelli-job-parser.mjs';

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
  const existing = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
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
  console.log(`\ud83c\udf56 Running dedicated ${COMPANY_NAME} crawler...`);

  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isCompanyJob) : []);
    } catch {}
  }

  const rawJobs = await fetchRapelliJobUrls();
  if (rawJobs.length === 0) {
    console.log('\u26a0\ufe0f No jobs found on Rapelli careers page. Keeping existing jobs.');
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Rapelli job links. Fetching details...`);
  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchRapelliDetailPage(raw.url);
    const description = detail?.description || `Posizione aperta presso ${COMPANY_NAME} a ${raw.location} (TI). Candidati tramite il portale ORIOR Careers.`;
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-rapelli-${raw.location}`);
    parsedJobs.push({
      id: `rapelli-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { it: jobSlug, en: jobSlug, de: jobSlug, fr: jobSlug },
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: 'rapelli.ch',
      title: raw.title,
      titleByLocale: { it: raw.title, en: raw.title, de: raw.title, fr: raw.title },
      description,
      descriptionByLocale: { it: description },
      requirements: [],
      requirementsByLocale: { it: [], en: [], de: [], fr: [] },
      location: raw.location || 'Stabio',
      canton: 'TI',
      addressLocality: raw.location || 'Stabio',
      addressCountry: 'CH',
      category: 'manufacturing',
      contract: 'full-time', employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url,
      source: 'Rapelli Dedicated Parser (ORIOR Careers)',
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
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Rapelli', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: 0, updatedCount: 0, removedCount: 0, unchangedCount: _sliceJobs.length, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`\u274c Rapelli crawler failed: ${err?.message || err}`); process.exit(1); });
