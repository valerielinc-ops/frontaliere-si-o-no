#!/usr/bin/env node
/**
 * Dedicated PKB Private Bank crawler runner.
 *
 * Source: https://www.pkb.ch/en/about-us/work-with-us/
 * Careers portal: https://careers.pkb.ch/jobs.php
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { fetchPkbJobs, slugify, inferEmploymentType } from './lib/pkb-private-bank-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'pkb-private-bank';
const COMPANY_NAME = 'PKB Private Bank';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes('pkb') || url.includes('pkb.ch') || url.includes('careers.pkb.ch');
}

function writeJobsFiles(jobs) {
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((j) => !isCompanyJob(j));
  const companyExisting = allJobs.filter((j) => isCompanyJob(j));
  const byUrl = new Map();
  for (const job of parsedJobs) { const k = String(job?.url || '').trim().replace(/\/+$/, ''); if (k) byUrl.set(k, job); }
  const deduped = [...byUrl.values()];
  const merged = mergePreserveLocaleData(companyExisting, deduped);
  const clean = merged.sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  writeJobsFiles([...others, ...clean]);
  return clean;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'PKB');
  console.log('\ud83c\udfe6 Running dedicated PKB Private Bank crawler...');

    const _before = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const rawJobs = (await fetchPkbJobs()).filter((j) => {
    const t = String(j?.title || '').trim().toLowerCase();
    // Drop the "Disclaimer" footer block the listing parser captures as a job.
    return t && t !== 'disclaimer';
  });
  if (rawJobs.length === 0) { console.log('\u26a0\ufe0f No PKB jobs found. Keeping existing.'); return; }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} PKB Private Bank jobs.`);
  const parsedJobs = rawJobs.map((raw) => {
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-pkb-private-bank-lugano`);
    const desc = `Posizione aperta presso PKB Private Bank SA a Lugano (TI). PKB \u00e8 una banca privata svizzera indipendente fondata nel 1958, specializzata in gestione patrimoniale e private banking. Candidati tramite il portale ufficiale.`;
    return {
      id: `pkb-private-bank-${urlHash}`, slug: jobSlug, slugByLocale: { it: jobSlug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'pkb.ch',
      title: raw.title, titleByLocale: { it: raw.title }, sourceLang: detectLang(desc || raw.title, 'en'),
      description: desc, descriptionByLocale: { it: desc }, requirements: [], requirementsByLocale: { it: [] },
      location: 'Lugano', canton: getCompanyDefaults('pkb-private-bank').canton, addressLocality: 'Lugano', addressRegion: getCompanyDefaults('pkb-private-bank').canton, addressCountry: 'CH',
      postalCode: '6900', streetAddress: 'Via S. Balestra 1',
      category: 'finance', contract: 'full-time', employmentType: inferEmploymentType(raw.title, raw.description || ''), currency: 'CHF', featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url, source: 'PKB Dedicated Parser', crawledAt: new Date().toISOString(),
    };
  });

  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'PKB');
  writeJobsSummary(published, 'PKB');
  const after = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_before, after);
  printCrawlChangeSummary(diff, 'PKB');
  writeCrawlChangeSummaryToGH(diff, 'PKB');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_PKB_STRICT', label: 'PKB', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No PKB jobs found.', detectSourceLang: (t) => detectLang(t, 'en'), deriveSlug: deriveLocalizedSlug });

  const dur = getCrawlerElapsedMs();
  const sr = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const sj = Array.isArray(sr) ? sr.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, sj);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'PKB', generatedAt: new Date().toISOString(), total: sj.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: dur, avgDurationMs: dur, durationHistory: [dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: sj.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`\u274c PKB crawler failed: ${err?.message || err}`); process.exit(1); });
