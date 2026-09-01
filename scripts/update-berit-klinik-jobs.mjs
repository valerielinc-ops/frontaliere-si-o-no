#!/usr/bin/env node
/**
 * Dedicated Berit Klinik (Gruppe) crawler runner.
 *
 * The Berit Klinik group operates seven hospital/clinic sites in
 * north-eastern Switzerland (Speicher AR HQ + Niederteufen, Wattwil,
 * Goldach, Arbon, Heerbrugg, St. Gallen Sportslab). All open positions
 * are published as Stelleninserat PDFs on the CMS at
 * https://cms-berit-klinik.deployco.de.
 *
 * Flow:
 *   1. Fetch the Next.js SSR HTML for /de/karriere-offene-stellen
 *   2. Extract every distinct PDF URL on the CMS host
 *   3. Download each PDF, extract text (unpdf), derive title + site
 *   4. Merge into data/jobs.json preserving prior locale data
 *   5. Validate URLs (HEAD), fill non-source locales, run locale gate
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  printPublishedJobUrls,
  writeJobsSummary,
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';
import {
  parseBeritKlinikListing,
  resolveBeritKlinikSite,
  extractBeritKlinikTitleFromPdf,
  pickBestBeritTitle,
  buildBeritKlinikDescription,
  BERIT_KLINIK_KEY,
  BERIT_KLINIK_COMPANY_NAME,
  BERIT_KLINIK_COMPANY_DOMAIN,
  BERIT_KLINIK_CAREERS_URL,
  BERIT_KLINIK_CMS_HOST,
} from './lib/berit-klinik-job-parser.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { fetchHtml, exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path (never shared with sibling crawlers in the
// same crawler-group CI job -- no cross-process race possible by construction).
const SCRATCH_KEY = path.basename(fileURLToPath(import.meta.url), '.mjs');
const DATA_JOBS = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${SCRATCH_KEY}.json`);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTER_PATH = path.resolve(
  ROOT,
  'data',
  'jobs-crawler-adapters',
  'adapters',
  `${BERIT_KLINIK_KEY}.json`
);

const COMPANY_KEY = BERIT_KLINIK_KEY;
const COMPANY_NAME = BERIT_KLINIK_COMPANY_NAME;
const COMPANY_HOST = `www.${BERIT_KLINIK_COMPANY_DOMAIN}`;
const COMPANY_DOMAIN = BERIT_KLINIK_COMPANY_DOMAIN;
const CAREERS_URL = BERIT_KLINIK_CAREERS_URL;
const LOCALES = ['it', 'en', 'de', 'fr'];

// Hardcoded HQ (Speicher AR) — Berit Klinik is not yet present in
// crawler-location-config.mjs and that file is read-only for this batch.
const HQ = { city: 'Speicher', canton: 'AR', postalCode: '9042', addressRegion: 'AR' };

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugify(text = '') {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlugAtWordBoundary(slug, 200);
}

async function fetchPage(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key.startsWith('berit-klinik') ||
    company.includes('berit klinik') ||
    url.includes(BERIT_KLINIK_CMS_HOST) ||
    url.includes('beritklinik.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === COMPANY_DOMAIN ||
      host === `www.${COMPANY_DOMAIN}` ||
      host === BERIT_KLINIK_CMS_HOST ||
      host.endsWith('.beritklinik.ch')
    );
  } catch {
    return false;
  }
}

function jobMatchKey(job = {}) {
  return (
    extractStableJobId(job.url) ||
    `slug:${String(job.slug || job.titleByLocale?.de || job.title || '').toLowerCase()}`
  );
}

function buildJob({ title, city, canton, postalCode, pdfUrl, pdfText, filename }) {
  const slug = slugify(`${title}-${COMPANY_KEY}`);
  return {
    title,
    slug,
    url: pdfUrl,
    applyUrl: CAREERS_URL,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    postalCode,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: 'health',
    sector: 'Gesundheitswesen / Klinik',
    employmentType: 'full-time',
    contractType: 'full-time',
    source: `${COMPANY_KEY}-dedicated-crawler`,
    sourceLang: detectLang(`${title} ${pdfText}`, 'de'),
    postedDate: new Date().toISOString().slice(0, 10),
    validThrough: '',
    needsRetranslation: true,
    description: buildBeritKlinikDescription({ title, city, pdfText, pdfUrl }).description,
    titleByLocale: { de: title },
    descriptionByLocale: {
      de: buildBeritKlinikDescription({ title, city, pdfText, pdfUrl }).description,
    },
    slugByLocale: { de: slug },
    _meta: { sourceFilename: filename },
  };
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const existingTarget = existing.filter(isTargetJob);
  const existingByKey = new Map(existingTarget.map((job) => [jobMatchKey(job), job]));

  const mergedTarget = mergePreserveLocaleData(existingTarget, discoveredJobs);

  // Ensure needsRetranslation stays true for jobs newly discovered or whose
  // PDF text changed. mergePreserveLocaleData preserves descriptionByLocale,
  // so we explicitly set the flag on every discovered match.
  for (const job of mergedTarget) {
    job.needsRetranslation = true;
  }

  const beforeSnapshot = snapshotJobSlugs(existingTarget);
  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const newJobs = mergedTarget.filter((job) => !existingByKey.has(jobMatchKey(job)));
  if (newJobs.length > 0) {
    console.log(`🔗 Validating URLs for ${newJobs.length} newly inserted jobs…`);
    const results = await validateJobUrls(newJobs, { concurrency: 4 });
    const invalid = results.filter((result) => !result.valid);
    if (invalid.length > 0) {
      console.warn(`⚠️  ${invalid.length} URL(s) failed validation:`);
      for (const inv of invalid) console.warn(`     - ${inv.url}: ${inv.reason}`);
      throw new Error(`Berit Klinik inserted ${invalid.length} invalid job URLs.`);
    }
    console.log(`✅ All ${newJobs.length} new job URLs validated successfully`);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Berit Klinik');
  writeCrawlChangeSummaryToGH(diff, 'Berit Klinik');
  writeJobsSummary(mergedTarget, 'Berit Klinik');
  printPublishedJobUrls(mergedTarget, 'Berit Klinik');
  const removed = Math.max(0, existingTarget.length - mergedTarget.length);
  console.log(
    `📦 Merge results:\n  ➕ Added: ${newJobs.length}\n  🔄 Updated: ${mergedTarget.length - newJobs.length}\n  🗑️  Removed (stale): ${removed}\n  📊 Total jobs in file: ${allJobs.length}`
  );
  return { diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton,
      company: COMPANY_NAME,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html', 'pdf'],
    seedUrls: jobs.map((job) => job.url),
    notes:
      'Dedicated Berit Klinik crawler parses the Next.js careers page and extracts descriptions from CMS-hosted Stelleninserat PDFs.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BERIT_KLINIK_STRICT',
    label: 'Berit Klinik',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_berit_klinik_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Berit Klinik jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'de'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Berit Klinik');
  console.log('═══════════════════════════════════════════════');
  console.log('  Berit Klinik — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const html = await fetchPage(CAREERS_URL);
  const listings = parseBeritKlinikListing(html);
  console.log(`📋 PDF stelleninserate found: ${listings.length}`);
  if (listings.length === 0) {
    throw new Error('Berit Klinik discovery returned 0 PDF jobs.');
  }

  const discoveredJobs = [];
  for (const listing of listings) {
    console.log(`  📄 Extracting PDF: ${listing.filename}`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl);
    if (pdf.error) {
      console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    }
    const pdfText = pdf.text || '';
    if (!pdfText) {
      console.warn(`     ⚠️ Empty PDF text — skipping ${listing.filename}`);
      continue;
    }
    const site = resolveBeritKlinikSite(pdfText, listing.filename);
    const pdfTitle = extractBeritKlinikTitleFromPdf(pdfText);
    const title = pickBestBeritTitle(listing.titleFromFilename, pdfTitle);
    discoveredJobs.push(
      buildJob({
        title,
        city: site.city,
        canton: site.canton,
        postalCode: site.postalCode,
        pdfUrl: listing.pdfUrl,
        pdfText,
        filename: listing.filename,
      })
    );
  }

  if (discoveredJobs.length === 0) {
    throw new Error('Berit Klinik discovered 0 jobs with extractable PDF text.');
  }

  updateAdapterConfig(discoveredJobs);
  const { diff } = await mergeJobs(discoveredJobs);

  console.log('\n🌐 Running locale fill for Berit Klinik jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log('\n✅ Berit Klinik crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Berit Klinik',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Berit Klinik'));
