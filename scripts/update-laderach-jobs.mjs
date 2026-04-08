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
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs } from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { fetchLaderachJobUrls, fetchLaderachDetailPage, slugify, inferEmploymentType } from './lib/laderach-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'laderach';
const COMPANY_NAME = 'Läderach (Schweiz) AG';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('laderach');
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
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Läderach');
  console.log('🍫 Running dedicated Läderach crawler...');
  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
  const rawJobs = await fetchLaderachJobUrls();
  if (rawJobs.length === 0) { console.log('⚠️ No jobs found. Keeping existing.'); return; }
  console.log(`🧩 Found ${rawJobs.length} job links. Fetching details...`);

  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchLaderachDetailPage(raw.url);
    if (!detail?.description || detail.description.length < 120) { console.log(`  ⚠️  ${raw.title}: too short — skipping`); continue; }
    const description = detail.description;
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-laderach-${raw.location}`);
    parsedJobs.push({
      id: `laderach-${urlHash}`, slug: jobSlug,
      slugByLocale: { de: jobSlug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'laderach.com',
      title: raw.title, titleByLocale: { de: raw.title },
      description, descriptionByLocale: { de: description },
      sourceLang: detectLang(description || raw.title, 'de'),
      requirements: [], requirementsByLocale: { de: [] },
      location: raw.location || 'Ennenda', canton: 'GR',
      addressLocality: raw.location || 'Ennenda', addressCountry: 'CH',
      category: 'manufacturing', contract: 'full-time',
      employmentType: inferEmploymentType(raw.title, description),
      currency: 'CHF', featured: false, postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url, source: 'Läderach Dedicated Parser', crawledAt: new Date().toISOString(),
    });
    console.log(`  ✅ ${raw.title} — ${raw.location}`);
  }

  if (parsedJobs.length === 0) { console.log('⚠️ No valid jobs parsed.'); return; }
  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Läderach'); writeJobsSummary(published, 'Läderach');
  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Läderach'); writeCrawlChangeSummaryToGH(diff, 'Läderach');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_LADERACH_STRICT', label: 'Läderach', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No Läderach jobs found.', detectSourceLang: (text) => detectLang(text, 'de'), deriveSlug: deriveLocalizedSlug });

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Läderach', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0,30), updatedJobs: diff.updatedJobs.slice(0,30), removedJobs: diff.removedJobs.slice(0,30), unchangedJobs: _sliceJobs.slice(0,30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`❌ Läderach crawler failed: ${err?.message || err}`); process.exit(1); });
