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
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { JSDOM } from 'jsdom';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  parseBoardListings,
  isBoardTargetLocation,
  inferBoardCanton,
  parseBoardJobDetail,
  inferBoardCategory,
  buildBoardLocalizedContent,
} from './lib/board-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'board-international.json');

const COMPANY_KEY = 'board-international';
const COMPANY_NAME = 'Board International';
const COMPANY_HOST = 'www.board.com';
const COMPANY_DOMAIN = 'board.com';
const CAREERS_URL = 'https://boardinternationalsa.applytojob.com/apply';
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

function toIsoDate(value = '') {
  const parsed = new Date(String(value || '').trim());
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
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
  const applyUrl = String(job.applyUrl || '').toLowerCase();
  return key === COMPANY_KEY
    || company.includes('board international')
    || url.includes('boardinternationalsa.applytojob.com/apply/')
    || applyUrl.includes('boardinternationalsa.applytojob.com/apply/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.board.com' || host === 'board.com' || host.endsWith('.applytojob.com');
  } catch {
    return false;
  }
}

function extractNextPageUrl(html, currentUrl) {
  const document = new JSDOM(html).window.document;
  // Look for "Next »" pagination link
  for (const a of document.querySelectorAll('a')) {
    const text = (a.textContent || '').trim();
    if (/next|»|›|successiv/i.test(text)) {
      const href = a.getAttribute('href');
      if (href) return new URL(href, currentUrl).href;
    }
  }
  return null;
}

async function fetchBoardListings() {
  console.log('🔍 Fetching Board jobs from careers page...');
  const MAX_PAGES = 10;
  const allDiscovered = [];
  let pageUrl = CAREERS_URL;
  let page = 1;

  while (pageUrl && page <= MAX_PAGES) {
    console.log(`📄 Fetching page ${page}: ${pageUrl}`);
    const html = await fetchText(pageUrl);
    const discovered = parseBoardListings(html);
    console.log(`  → Found ${discovered.length} listings on page ${page}`);
    allDiscovered.push(...discovered);

    // Check for next page
    const nextUrl = extractNextPageUrl(html, pageUrl);
    if (nextUrl && nextUrl !== pageUrl) {
      pageUrl = nextUrl;
      page++;
    } else {
      break;
    }
  }

  const target = allDiscovered.filter((row) => isBoardTargetLocation(row.location));
  console.log(`📋 Total listing rows (all pages): ${allDiscovered.length}`);
  console.log(`📋 Ticino/Grigioni rows: ${target.length}`);
  for (const row of target) {
    console.log(`  📄 ${row.title} (${row.location})`);
  }
  if (target.length < 1) {
    throw new Error(`Expected at least 1 Board job in Ticino/Grigioni, found ${target.length}`);
  }
  return target;
}

async function buildBoardJob(listing) {
  const html = await fetchText(listing.href);
  const detail = parseBoardJobDetail(html);
  const location = detail.location || listing.location;
  const canton = inferBoardCanton(`${location} ${detail.region || ''}`);
  const localized = buildBoardLocalizedContent(detail, COMPANY_NAME);
  const sourceUrl = detail.canonicalUrl || listing.href;
  const title = detail.title || listing.title;

  return {
    title,
    slug:
      localized.slugByLocale.en ||
      normalizeKey(`${title} ${COMPANY_NAME} ${location}`),
    url: sourceUrl,
    applyUrl: sourceUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferBoardCategory(title, detail),
    sector: 'Tecnologia & IT',
    source: 'board-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'en'),
    postedDate: toIsoDate(detail.postedDate),
    employmentType: normalize(detail.employmentType).replace(/_/g, '-') || 'full-time',
    contractType: normalize(detail.employmentType).includes('part') ? 'part-time' : 'full-time',
    validThrough: toIsoDate(detail.validThrough),
    description: detail.description,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
  return { total: mergedTarget.length, added, updated, diff };
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
    priority: 18,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Board crawler parses the public jobs listing and applytojob detail pages, keeping only Ticino or Grigioni vacancies.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BOARD_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_board_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Board jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'board');
  console.log('═══════════════════════════════════════════════');
  console.log('  Board International — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchBoardListings();
  const jobs = [];
  for (const listing of listings) {
    try {
      jobs.push(await buildBoardJob(listing));
    } catch (err) {
      console.warn(`⚠️ Skipping "${listing.title}" — detail fetch failed: ${err?.message || err}`);
    }
  }
  if (jobs.length === 0) {
    throw new Error(`All ${listings.length} Board job detail fetches failed — no jobs to process.`);
  }
  console.log(`✅ Built ${jobs.length}/${listings.length} Board job objects from detail pages.`);

  const result = mergeJobs(jobs);
  const diff = result.diff || { newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: [], unchangedCount: 0 };
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Board jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Board crawler complete (${result.total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'board',
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
  console.error(`❌ Board crawler failed: ${err?.message || err}`);
  process.exit(1);
});
