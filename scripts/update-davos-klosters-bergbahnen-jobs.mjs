#!/usr/bin/env node
/**
 * Dedicated Davos Klosters Bergbahnen AG crawler runner.
 * Source: https://www.davosklosters.ch/bergbahnen
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs } from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { fetchDavosKlostersBergbahnenJobUrls, fetchDavosKlostersBergbahnenDetailPage, slugify, inferEmploymentType } from './lib/davos-klosters-bergbahnen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'davos-klosters-bergbahnen';
const COMPANY_NAME = 'Davos Klosters Bergbahnen AG';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes('davos-klosters-bergbahnen') || url.includes('davosklosters.ch');
}

function writeJobsFiles(jobs) {
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((job) => !isCompanyJob(job));
  const companyExisting = allJobs.filter((job) => isCompanyJob(job));
  const byUrl = new Map();
  for (const job of parsedJobs) { const key = String(job?.url || '').trim().replace(/\/+$/, ''); if (!key) continue; byUrl.set(key, job); }
  const deduped = [...byUrl.values()];
  const merged = mergePreserveLocaleData(companyExisting, deduped);
  const clean = merged.sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  return writeJobsFiles([...others, ...clean]), clean;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Davos Klosters Bergbahnen');
  console.log('🏔️ Running dedicated Davos Klosters Bergbahnen crawler...');
  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
  const rawJobs = await fetchDavosKlostersBergbahnenJobUrls();
  if (rawJobs.length === 0) { console.log('⚠️ No jobs found. Keeping existing.'); return; }
  console.log(`🧩 Found ${rawJobs.length} job links. Fetching details...`);

  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchDavosKlostersBergbahnenDetailPage(raw.url);
    if (!detail?.description || detail.description.length < 120) { console.log(`  ⚠️  ${raw.title}: too short — skipping`); continue; }
    const description = detail.description;
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-davos-klosters-bergbahnen-${raw.location}`);
    parsedJobs.push({
      id: `davos-klosters-bergbahnen-${urlHash}`, slug: jobSlug,
      slugByLocale: { it: jobSlug, en: jobSlug, de: jobSlug, fr: jobSlug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'davosklosters.ch',
      title: raw.title, titleByLocale: { it: raw.title, en: raw.title, de: raw.title, fr: raw.title },
      description, descriptionByLocale: { it: description },
      requirements: [], requirementsByLocale: { it: [], en: [], de: [], fr: [] },
      location: raw.location || 'Davos', canton: 'GR',
      addressLocality: raw.location || 'Davos', addressCountry: 'CH',
      category: 'tourism', contract: 'full-time',
      employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF', featured: false, postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url, source: 'Davos Klosters Bergbahnen Dedicated Parser', crawledAt: new Date().toISOString(),
    });
    console.log(`  ✅ ${raw.title} — ${raw.location}`);
  }

  if (parsedJobs.length === 0) { console.log('⚠️ No valid jobs parsed.'); return; }
  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Davos Klosters Bergbahnen'); writeJobsSummary(published, 'Davos Klosters Bergbahnen');
  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Davos Klosters Bergbahnen'); writeCrawlChangeSummaryToGH(diff, 'Davos Klosters Bergbahnen');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_DAVOS_KLOSTERS_BERGBAHNEN_STRICT', label: 'Davos Klosters Bergbahnen', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No Davos Klosters Bergbahnen jobs found.', detectSourceLang: (text) => detectLang(text, 'de'), deriveSlug: deriveLocalizedSlug });

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Davos Klosters Bergbahnen', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0,30), updatedJobs: diff.updatedJobs.slice(0,30), removedJobs: diff.removedJobs.slice(0,30), unchangedJobs: _sliceJobs.slice(0,30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`❌ Davos Klosters Bergbahnen crawler failed: ${err?.message || err}`); process.exit(1); });
