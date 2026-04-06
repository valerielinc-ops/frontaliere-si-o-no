#!/usr/bin/env node
/**
 * Dedicated Hilcona AG (Bell Food Group) crawler runner.
 * Source: https://career.bellfoodgroup.com/en
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs } from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { fetchHilconaJobUrls, fetchHilconaDetailPage, slugify, inferEmploymentType } from './lib/hilcona-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'hilcona';
const COMPANY_NAME = 'Hilcona AG (Bell Food Group)';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('bellfoodgroup');
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
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Hilcona');
  console.log('🥗 Running dedicated Hilcona crawler...');
  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob));
  const rawJobs = await fetchHilconaJobUrls();
  if (rawJobs.length === 0) { console.log('⚠️ No jobs found. Keeping existing.'); return; }
  console.log(`🧩 Found ${rawJobs.length} job links. Fetching details...`);

  const parsedJobs = [];
  for (const raw of rawJobs) {
    const detail = await fetchHilconaDetailPage(raw.url);
    if (!detail?.description || detail.description.length < 120) { console.log(`  ⚠️  ${raw.title}: too short — skipping`); continue; }
    const description = detail.description;
    const loc = detail.location || 'Landquart';
    const company = detail.company || COMPANY_NAME;
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-hilcona-${loc}`);
    parsedJobs.push({
      id: `hilcona-${urlHash}`, slug: jobSlug,
      slugByLocale: { it: jobSlug, en: jobSlug, de: jobSlug, fr: jobSlug },
      company, companyKey: COMPANY_KEY, companyDomain: 'bellfoodgroup.com',
      title: raw.title, titleByLocale: { it: raw.title, en: raw.title, de: raw.title, fr: raw.title },
      description, descriptionByLocale: { it: description },
      requirements: [], requirementsByLocale: { it: [], en: [], de: [], fr: [] },
      location: loc, canton: 'GR',
      addressLocality: loc, addressCountry: 'CH',
      category: 'manufacturing', contract: detail.contractType || 'full-time',
      employmentType: inferEmploymentType(raw.title, description, detail.pensum),
      currency: 'CHF', featured: false, postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url, source: 'Hilcona Dedicated Parser', crawledAt: new Date().toISOString(),
    });
    console.log(`  ✅ ${raw.title} — ${loc}`);
  }

  if (parsedJobs.length === 0) { console.log('⚠️ No valid jobs parsed.'); return; }
  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Hilcona'); writeJobsSummary(published, 'Hilcona');
  const afterSnapshot = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Hilcona'); writeCrawlChangeSummaryToGH(diff, 'Hilcona');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_HILCONA_STRICT', label: 'Hilcona', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No Hilcona jobs found.', detectSourceLang: (text) => detectLang(text, 'de'), deriveSlug: deriveLocalizedSlug });

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Hilcona', generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0,30), updatedJobs: diff.updatedJobs.slice(0,30), removedJobs: diff.removedJobs.slice(0,30), unchangedJobs: _sliceJobs.slice(0,30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`❌ Hilcona crawler failed: ${err?.message || err}`); process.exit(1); });
