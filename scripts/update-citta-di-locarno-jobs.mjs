#!/usr/bin/env node
/**
 * Dedicated Città di Locarno crawler runner.
 *
 * Source: https://www.locarno.ch/it/albo-comunale/assunzioni-personale
 */
import { sourcePostingDateFields } from './lib/source-posting-date.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSliceVerified, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import {
  fetchLocarnoJobs,
  slugify,
  inferEmploymentType,
  CITTA_DI_LOCARNO_FABRICATED_DESCRIPTION_RE,
} from './lib/citta-di-locarno-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';
import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
} from './lib/pdf-job-content.mjs';
import { SOURCE_BODY_FAILURE_REASON } from './lib/source-body-failure.mjs';
import {
  buildSourceBodyFailureHousekeepingProof,
  dropFailedSourceJobsWithoutValidBody,
  keepStoredSourceBodiesByKey,
} from './lib/stored-source-body.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANY_KEY = 'citta-di-locarno';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Città di Locarno';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || key.includes('locarno') || url.includes('locarno.ch');
}

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
}

function mergeCompanyJobs(parsedJobs, discoveredJobs = []) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((j) => !isCompanyJob(j));
  const companyExisting = dropFailedSourceJobsWithoutValidBody(
    dropFabricatedDescriptions(
      allJobs.filter((j) => isCompanyJob(j)),
      CITTA_DI_LOCARNO_FABRICATED_DESCRIPTION_RE,
      COMPANY_NAME,
    ),
    discoveredJobs,
    (job) => String(job?.url || '').trim().replace(/\/+$/, ''),
  );
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
  const summaryCounts = { sourceBodyFailures: [] };
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Locarno', summaryCounts);
  console.log('\ud83c\udfe2 Running dedicated Citt\u00e0 di Locarno crawler...');

    const _before = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const rawJobs = await fetchLocarnoJobs();
  if (rawJobs.length === 0) {
    console.log('\u26a0\ufe0f No Locarno jobs found. Keeping existing.');
    // The stored jobs are kept, without the text the crawler once wrote
    // into them (the merge would have removed it).
    await rewritePreparedStoredJobs({
      prepare: (jobs) => dropFabricatedDescriptions(jobs, CITTA_DI_LOCARNO_FABRICATED_DESCRIPTION_RE, COMPANY_NAME),
      storedJobs: readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob),
      companyKey: COMPANY_KEY,
      companyLabel: COMPANY_NAME,
      write: (jobs, options) => writeJobsCrawlerSliceVerified(COMPANY_KEY, jobs, options),
      assemble: () => assembleJobsDataset(),
    });
    return;
  }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Locarno jobs.`);
  const parsedJobs = [];
  const sourceBodyFailures = [];
  for (const raw of rawJobs) {
    let pdfContent = null;
    if (raw.pdfUrl) {
      console.log(`  \ud83d\udcc4 Extracting PDF: ${raw.pdfUrl}`);
      pdfContent = await extractPdfJobContentFromUrl(raw.pdfUrl);
      if (pdfContent.error) {
        console.warn(`  \u26a0\ufe0f PDF extraction failed for "${raw.title}": ${pdfContent.error}`);
      } else if (pdfContent.text) {
        console.log(`  \u2705 PDF extracted (${pdfContent.text.length} chars, ${pdfContent.totalPages} pages)`);
      }
    }

    const pdfFailed = Boolean(pdfContent?.extractionFailed || pdfContent?.error);
    if (pdfFailed) {
      sourceBodyFailures.push({
        title: raw.title,
        url: raw.pdfUrl || raw.url,
        reason: SOURCE_BODY_FAILURE_REASON,
        message: pdfContent.error || pdfContent.warning || 'PDF extraction failed',
      });
    }
    const pdfText = pdfFailed || pdfContent?.thin ? '' : (pdfContent?.rawText || pdfContent?.text || '');

    // Only the text of the bando, in its own language: no lines of the crawler
    // (CITTA_DI_LOCARNO_FABRICATED_DESCRIPTION_RE). A bando without readable text
    // is a PDF extraction failure, not a thin source.
    const desc = buildPdfBackedDescription({ pdfText });
    const sourceLang = detectLang(desc || raw.title, 'it');

    parsedJobs.push({
      id: raw.id, slug: raw.slug, slugByLocale: { [sourceLang]: raw.slug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'locarno.ch',
      title: raw.title, titleByLocale: { [sourceLang]: raw.title },
      description: desc, descriptionByLocale: { [sourceLang]: desc }, requirements: [], requirementsByLocale: { [sourceLang]: [] },
      location: 'Locarno', canton: HQ.canton, addressLocality: 'Locarno', addressRegion: HQ.addressRegion, addressCountry: 'CH',
      postalCode: HQ.postalCode, streetAddress: 'Piazza Grande 18',
      category: 'public-admin', contract: 'full-time', employmentType: inferEmploymentType(raw.title, raw.description || ''), currency: 'CHF', featured: false,
      ...sourcePostingDateFields(raw.datePosted),
      url: raw.url, pdfUrl: raw.pdfUrl, applyUrl: raw.applyUrl,
      source: 'Locarno Dedicated Parser', sourceLang, crawledAt: new Date().toISOString(),
      ...(pdfFailed
        ? {
          sourceBodyFailureReason: SOURCE_BODY_FAILURE_REASON,
          sourceBodyFailureMessage: pdfContent.error || pdfContent.warning || 'PDF extraction failed',
        }
        : {}),
    });
  }
  summaryCounts.sourceBodyFailures = sourceBodyFailures;

  const storedJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob);
  const sourceBodyJobs = keepStoredSourceBodiesByKey(
    parsedJobs,
    storedJobs,
    (job) => String(job?.url || '').trim().replace(/\/+$/, ''),
  );
  if (sourceBodyJobs.length < parsedJobs.length) {
    console.warn(
      `  \u26a0\ufe0f Locarno: skipped ${parsedJobs.length - sourceBodyJobs.length} row(s) without a `
      + 'publishable source body; extraction failures are not thin-source quarantine.',
    );
  }
  const published = mergeCompanyJobs(sourceBodyJobs, parsedJobs);
  printPublishedJobUrls(published, 'Locarno');
  writeJobsSummary(published, 'Locarno');
  const after = snapshotJobSlugs(published);
  const diff = computeCrawlDiff(_before, after);
  printCrawlChangeSummary(diff, 'Locarno');
  writeCrawlChangeSummaryToGH(diff, 'Locarno');

  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_LOCARNO_STRICT', label: 'Locarno', dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, failOnMissingJobsFile: true, failWhenNoJobs: false, noJobsMessage: 'No Locarno jobs found — the municipality may not have active openings.', detectSourceLang: (t) => detectLang(t, 'it'), deriveSlug: deriveLocalizedSlug });

  const dur = getCrawlerElapsedMs();
  const sr = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const sj = Array.isArray(sr) ? sr.filter(isCompanyJob) : [];
  const sourceFailureHousekeepingProof = buildSourceBodyFailureHousekeepingProof(
    diff.removedJobs,
    parsedJobs.filter((job) => job?.sourceBodyFailureReason === SOURCE_BODY_FAILURE_REASON),
    (job) => String(job?.url || '').trim().replace(/\/+$/, ''),
  );
  await writeJobsCrawlerSliceVerified(COMPANY_KEY, sj, {
    isTargetJob: isCompanyJob,
    ...(sourceFailureHousekeepingProof ? { housekeepingProof: sourceFailureHousekeepingProof } : {}),
    ...(sourceFailureHousekeepingProof ? { verifyUnprovenHousekeeping: true } : {}),
  });
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Locarno', generatedAt: new Date().toISOString(), total: sj.length, sourceBodyFailureCount: sourceBodyFailures.length, sourceBodyFailures: sourceBodyFailures.slice(0, 100), newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: dur, avgDurationMs: dur, durationHistory: [dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Locarno'));
