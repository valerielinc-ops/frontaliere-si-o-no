#!/usr/bin/env node
import fs from 'node:fs';
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
import { translateMissingJobLocales, validateDedicatedLocaleCoverage, detectLang, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';
import { parseLwphrOpenJobs, inferLwphrLocation, inferLwphrCategory, buildLwphrLocalizedPayload, extractTitleFromPdfText, reconcilePdfTitle } from './lib/lwphr-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'lwphr.json');

const COMPANY_KEY = 'lwphr';
const HQ = getCompanyDefaults('lwphr');
const COMPANY_NAME = 'LWP Ledermann Wieting & Partners';
const COMPANY_HOST = 'www.lwphr.ch';
const COMPANY_DOMAIN = 'lwphr.ch';
const CAREERS_URL = 'https://www.lwphr.ch/opportunita-opportunities.html';
const LOCALES = ['it', 'en', 'de', 'fr'];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchPage(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('ledermann') || company.includes('lwphr') || url.includes('lwphr.ch/uploads/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'lwphr.ch' || host === 'www.lwphr.ch';
  } catch {
    return false;
  }
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function buildJob({ title, pdfUrl, pdfText }) {
  const pdfTitle = extractTitleFromPdfText(pdfText);
  const resolvedTitle = reconcilePdfTitle(title, pdfTitle);
  title = resolvedTitle;
  const location = inferLwphrLocation(title, pdfText);
  const localized = buildLwphrLocalizedPayload({ title, pdfText, location, pdfUrl });
  return {
    title: localized.titles.it,
    slug: localized.slugs.it,
    url: pdfUrl,
    applyUrl: CAREERS_URL,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: inferLwphrCategory(title, pdfText),
    sector: 'Consulenza',
    source: 'lwphr-dedicated-crawler',
    sourceLang: detectLang(`${title} ${pdfText}`, 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: buildPdfBackedDescription({
      introLines: [
        `${COMPANY_NAME} pubblica questa opportunita sul suo portale careers.`,
        `Titolo: ${title}.`,
        `Sede indicativa: ${location}.`,
      ],
      pdfText,
      footerLines: [
        `PDF ufficiale: ${pdfUrl}`,
        `Portale careers: ${CAREERS_URL}`,
      ],
    }),
    titleByLocale: {
      it: localized.titles.it,
      en: localized.titles.en,
      de: localized.titles.de,
      fr: localized.titles.fr,
    },
    descriptionByLocale: localized.descriptions,
    slugByLocale: localized.slugs,
  };
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const existingTarget = existing.filter(isTargetJob);
  const existingByKey = new Map(existingTarget.map((job) => [jobMatchKey(job), job]));

  // Preserve existing AI translations and slugs
  const mergedTarget = mergePreserveLocaleData(existingTarget, discoveredJobs);

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
      throw new Error(`LWPHR inserted ${invalid.length} invalid job URLs.`);
    }
    console.log(`✅ All ${newJobs.length} new job URLs validated successfully`);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'LWPHR');
  writeCrawlChangeSummaryToGH(diff, 'LWPHR');
  writeJobsSummary(mergedTarget, 'LWPHR');
  printPublishedJobUrls(mergedTarget, 'LWPHR');
  const removed = Math.max(0, existingTarget.length - mergedTarget.length);
  console.log(`📦 Merge results:\n  ➕ Added: ${newJobs.length}\n  🔄 Updated: ${mergedTarget.length - newJobs.length}\n  🗑️  Removed (stale): ${removed}\n  📊 Total jobs in file: ${allJobs.length}`);
  return { diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: HQ.canton,
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
    notes: 'Dedicated LWPHR crawler parses the open positions accordion and extracts descriptions directly from the linked PDF files.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LWPHR_STRICT',
    label: 'LWP Ledermann Wieting & Partners',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_lwphr_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No LWPHR jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'LWP Ledermann Wieting & Partners');
  console.log('═══════════════════════════════════════════════');
  console.log('  LWP Ledermann Wieting & Partners — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const html = await fetchPage(CAREERS_URL);
  const listings = parseLwphrOpenJobs(html);
  console.log(`📋 Open PDF jobs found on page: ${listings.length}`);
  if (listings.length === 0) {
    throw new Error('LWPHR discovery returned 0 open PDF jobs.');
  }

  const discoveredJobs = [];
  for (const listing of listings) {
    console.log(`  📄 Extracting PDF: ${listing.title}`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl);
    discoveredJobs.push(buildJob({
      title: listing.title,
      pdfUrl: listing.pdfUrl,
      pdfText: pdf.text || '',
    }));
  }

  updateAdapterConfig(discoveredJobs);
  const { diff } = await mergeJobs(discoveredJobs);

  console.log('\n🌐 Running locale fill for LWPHR jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log('\n✅ LWPHR crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'LWP Ledermann Wieting & Partners',
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

main().catch((err) => {
  console.error(`❌ LWPHR crawler failed: ${err?.message || err}`);
  process.exit(1);
});
