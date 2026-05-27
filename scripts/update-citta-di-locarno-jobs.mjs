#!/usr/bin/env node
/**
 * Dedicated Città di Locarno crawler runner.
 *
 * Source: https://www.locarno.ch/it/albo-comunale/assunzioni-personale
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, printPublishedJobUrls, writeJobsSummary, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, deriveLocalizedSlug, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { fetchLocarnoJobs, slugify, inferEmploymentType } from './lib/citta-di-locarno-job-parser.mjs';
import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
} from './lib/pdf-job-content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const COMPANY_KEY = 'citta-di-locarno';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Città di Locarno';

function isCompanyJob(job) {
  const key = String(job?.companyKey || job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key.includes(COMPANY_KEY) || key.includes('locarno') || url.includes('locarno.ch');
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
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Locarno');
  console.log('\ud83c\udfe2 Running dedicated Citt\u00e0 di Locarno crawler...');

    const _before = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const rawJobs = await fetchLocarnoJobs();
  if (rawJobs.length === 0) { console.log('\u26a0\ufe0f No Locarno jobs found. Keeping existing.'); return; }

  console.log(`\ud83e\udde9 Found ${rawJobs.length} Locarno jobs.`);
  const parsedJobs = [];
  for (const raw of rawJobs) {
    let pdfText = '';
    if (raw.pdfUrl) {
      console.log(`  \ud83d\udcc4 Extracting PDF: ${raw.pdfUrl}`);
      const pdfContent = await extractPdfJobContentFromUrl(raw.pdfUrl);
      if (pdfContent.error) {
        console.warn(`  \u26a0\ufe0f PDF extraction failed for "${raw.title}": ${pdfContent.error}`);
      } else if (pdfContent.text) {
        pdfText = pdfContent.text;
        console.log(`  \u2705 PDF extracted (${pdfContent.text.length} chars, ${pdfContent.totalPages} pages)`);
      }
    }

    const fallbackDesc = `Concorso pubblico presso la ${COMPANY_NAME} per la posizione di ${raw.title}. Consultare il bando di concorso allegato per requisiti e modalit\u00e0 di candidatura.`;
    const desc = buildPdfBackedDescription({
      introLines: [
        `## ${raw.title}`,
        `${COMPANY_NAME} \u2014 concorso pubblico a Locarno (TI), Svizzera.`,
      ],
      pdfText,
      fallbackText: fallbackDesc,
      footerLines: [
        `**Settore:** Pubblica Amministrazione`,
        `**Sede:** Piazza Grande 18, 6600 Locarno, TI, Svizzera`,
        raw.pdfUrl ? `[Bando ufficiale (PDF)](${raw.pdfUrl})` : '',
      ].filter(Boolean),
    });

    parsedJobs.push({
      id: raw.id, slug: raw.slug, slugByLocale: { it: raw.slug },
      company: COMPANY_NAME, companyKey: COMPANY_KEY, companyDomain: 'locarno.ch',
      title: raw.title, titleByLocale: { it: raw.title },
      description: desc, descriptionByLocale: { it: desc }, requirements: [], requirementsByLocale: { it: [] },
      location: 'Locarno', canton: HQ.canton, addressLocality: 'Locarno', addressRegion: HQ.addressRegion, addressCountry: 'CH',
      postalCode: HQ.postalCode, streetAddress: 'Piazza Grande 18',
      category: 'public-admin', contract: 'full-time', employmentType: inferEmploymentType(raw.title, raw.description || ''), currency: 'CHF', featured: false,
      postedDate: raw.datePosted,
      url: raw.url, pdfUrl: raw.pdfUrl, applyUrl: raw.applyUrl,
      source: 'Locarno Dedicated Parser', sourceLang: detectLang(desc || raw.title, 'it'), crawledAt: new Date().toISOString(),
    });
  }

  const published = mergeCompanyJobs(parsedJobs);
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
  writeJobsCrawlerSlice(COMPANY_KEY, sj);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Locarno', generatedAt: new Date().toISOString(), total: sj.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: dur, avgDurationMs: dur, durationHistory: [dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: sj.slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`\u274c Locarno crawler failed: ${err?.message || err}`); process.exit(1); });
