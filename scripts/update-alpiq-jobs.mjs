#!/usr/bin/env node
/**
 * Dedicated Alpiq crawler runner.
 *
 * Source: https://www.alpiq.com/career/open-jobs
 * Alpiq is a major Swiss energy company with hydroelectric plants in Ticino.
 * This crawler fetches all pages of listings and filters for Swiss jobs only.
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
import { fetchAlpiqListingPages, slugify, inferEmploymentType } from './lib/alpiq-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'alpiq';
const COMPANY_NAME = 'Alpiq';

/** Alpiq location → postal code map (Swiss locations, Ticino focus) */
const ALPIQ_PLZ = {
  airolo: '6780', biasca: '6710', locarno: '6600', bellinzona: '6500',
  lugano: '6900', mendrisio: '6850', chiasso: '6830', rodi: '6772',
  ritom: '6772', piotta: '6772', lausanne: '1003', zurich: '8001',
  olten: '4600', bern: '3001', baden: '5400',
};

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || url.includes('alpiq.com');
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
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Alpiq');
  console.log('\u26a1 Running dedicated Alpiq crawler...');

    const _before = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const rawJobs = await fetchAlpiqListingPages(6);
  if (rawJobs.length === 0) { console.log('\u26a0\ufe0f No Swiss Alpiq jobs found. Keeping existing.'); return; }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Swiss Alpiq jobs.`);
  const parsedJobs = rawJobs.map((raw) => {
    const urlHash = createHash('sha1').update(raw.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${raw.title}-alpiq-${raw.location || 'switzerland'}`);
    const desc = raw.description || `Posizione aperta presso Alpiq (${raw.location || 'Svizzera'}). Alpiq \u00e8 uno dei principali produttori di energia in Svizzera con centrali idroelettriche in Ticino. Candidati tramite il portale SuccessFactors.`;
    return {
      id: `alpiq-${urlHash}`, slug: jobSlug, slugByLocale: { it: jobSlug, en: jobSlug, de: jobSlug, fr: jobSlug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'alpiq.com',
      title: raw.title, titleByLocale: { it: raw.title, en: raw.title, de: raw.title, fr: raw.title },
      description: desc, descriptionByLocale: { it: desc }, requirements: [], requirementsByLocale: { it: [], en: [], de: [], fr: [] },
      location: raw.location || 'Switzerland',
      canton: raw.location && /airolo|biasca|locarno|bellinzona|lugano|mendrisio|chiasso|rodi|ritom|piotta/i.test(raw.location) ? 'TI' : '',
      postalCode: ALPIQ_PLZ[raw.location?.toLowerCase()] || '',
      streetAddress: '',
      addressLocality: raw.location || 'Switzerland',
      addressRegion: raw.location && /airolo|biasca|locarno|bellinzona|lugano|mendrisio|chiasso|rodi|ritom|piotta/i.test(raw.location) ? 'TI' : '',
      addressCountry: 'CH',
      employmentType: inferEmploymentType(raw.title, raw.description || '', raw.percentage || ''),
      category: 'energy', contract: raw.contractType === 'Temporary' ? 'temporary' : 'full-time',
      currency: 'CHF', featured: false, postedDate: new Date().toISOString().slice(0, 10),
      url: raw.url, applyUrl: raw.applyUrl, source: 'Alpiq Dedicated Parser', crawledAt: new Date().toISOString(),
    };
  });

  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Alpiq');
  writeJobsSummary(published, 'Alpiq');
  const after = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_before, after);
  printCrawlChangeSummary(diff, 'Alpiq');
  writeCrawlChangeSummaryToGH(diff, 'Alpiq');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_ALPIQ_STRICT', label: 'Alpiq', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: true, noJobsMessage: 'No Alpiq jobs found.', detectSourceLang: (t) => detectLang(t, 'en'), deriveSlug: deriveLocalizedSlug });

  const dur = getCrawlerElapsedMs();
  const sr = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const sj = Array.isArray(sr) ? sr.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, sj);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Alpiq', generatedAt: new Date().toISOString(), total: sj.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: dur, avgDurationMs: dur, durationHistory: [dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: sj.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`\u274c Alpiq crawler failed: ${err?.message || err}`); process.exit(1); });
