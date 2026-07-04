#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './lib/ensure-chromium.mjs';
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
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseAltenListingHtml,
  parseAltenDetailHtml,
  inferAltenCategory,
} from './lib/alten-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'alten-switzerland.json');

const COMPANY_KEY = 'alten-switzerland';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'ALTEN Switzerland';
const COMPANY_DOMAIN = 'alten.ch';
const COMPANY_HOST = 'www.alten.ch';
const CAREERS_URL = 'https://www.alten.ch/career/jobs/?pagenum=1&per_page=100';
const LOCALES = ['it', 'en', 'de', 'fr'];

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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toIsoDate(raw = '') {
  const value = String(raw || '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    const [dd, mm, yyyy] = value.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('alten switzerland') || url.includes('www.alten.ch/jobs/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.alten.ch' || host === 'alten.ch';
  } catch {
    return false;
  }
}

async function waitForListing(page) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 60000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const title = await page.title();
    const content = await page.textContent('body').catch(() => '');
    if (/Career - ALTEN Switzerland/i.test(title) && /Job offers/i.test(content || '')) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function waitForDetail(page) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 60000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const title = await page.title();
    const content = await page.textContent('body').catch(() => '');
    const isAltenPage = /ALTEN/i.test(title) || /ALTEN Switzerland/i.test(content || '');
    const hasJobContent = /APPLY/i.test(content || '')
      || /Job info/i.test(content || '')
      || /Responsibilities/i.test(content || '')
      || /wp-block-jobboard-offer/i.test(await page.content().catch(() => ''));
    if (isAltenPage && hasJobContent) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function withBrowser(fn) {
  const browser = await launchChromium({ headless: process.env.JOBS_ALTEN_HEADLESS === '1' });
  const context = await browser.newContext({
    userAgent:
      process.env.JOBS_CRAWLER_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function discoverListings() {
  console.log('🔍 Fetching ALTEN jobs with browser session...');
  try {
    return await withBrowser(async (page) => {
      await page.goto(CAREERS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const ok = await waitForListing(page);
      if (!ok) throw new Error('ALTEN listing did not become available in browser session');
      const html = await page.content();
      const listings = parseAltenListingHtml(html);
      console.log(`📋 Total Swiss ALTEN jobs discovered (CH-wide): ${listings.length}`);
      for (const listing of listings) console.log(`  📄 ${listing.title} (${listing.location})`);
      if (listings.length < 1) throw new Error(`Expected at least 1 ALTEN Swiss job, found ${listings.length}`);
      return listings;
    });
  } catch (err) {
    // Treat any connectivity / challenge / zero-listing error as a transient
    // unavailability. Return null so main() preserves the existing jobs.json
    // content rather than wiping ALTEN entries on a bad run.
    const isTransient = /did not become available|net::ERR_|timeout|403|Expected at least 1/i.test(err.message);
    if (isTransient) {
      console.warn(`⚠️  ALTEN site or listing unavailable: ${err.message}`);
      console.log('ℹ️  Keeping existing data — no updates this run.');
      return null;
    }
    throw err;
  }
}

async function buildJobs(listings) {
  try {
    return await withBrowser(async (page) => {
    // Warm the browser session on the listing page first so that Cloudflare
    // challenge cookies are established before navigating to detail pages.
    await page.goto(CAREERS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const sessionOk = await waitForListing(page);
    if (!sessionOk) throw new Error('ALTEN listing session could not be initialized for detail fetching');

    const jobs = [];
    let skipped = 0;
    for (const listing of listings) {
      // Navigate directly to the detail URL — avoids re-loading the listing page
      // for every job and eliminates fragile anchor-click logic.
      try {
        await page.goto(listing.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const detailOk = await waitForDetail(page);
        if (!detailOk) {
          console.warn(`  ⚠️  Detail page not ready for ${listing.href} — skipping`);
          skipped += 1;
          continue;
        }
        const parsed = parseAltenDetailHtml(await page.content(), listing.href);
        // Resolve the canton CH-wide from the cleanest single signal first
        // (the detail-page city string), falling back to the listing card
        // location only if the detail field is canton-less. Never default to
        // a hard-coded canton: if neither resolves to a Swiss canton the job
        // is foreign / un-geolocatable and is dropped.
        const canton = inferAnyCanton(parsed.location) || inferAnyCanton(listing.location);
        if (!canton) {
          console.warn(`  ⚠️  No Swiss canton resolved for ${listing.href} (location: "${parsed.location}") — skipping`);
          skipped += 1;
          continue;
        }
        jobs.push({
          title: parsed.title,
          slug: parsed.slug,
          url: listing.href,
          applyUrl: parsed.applyUrl,
          company: COMPANY_NAME,
          companyKey: COMPANY_KEY,
          companyDomain: COMPANY_DOMAIN,
          location: parsed.location,
          addressLocality: parsed.location,
          addressRegion: canton,
          addressCountry: 'CH',
          canton,
          country: 'CH',
          employmentType: 'full-time',
          contractType: 'full-time',
          category: inferAltenCategory(parsed.title, parsed.description),
          sector: 'IT Consulting & Engineering',
          source: 'alten-dedicated-crawler',
          sourceLang: detectLang(parsed.description || '', 'en'),
          postedDate: toIsoDate(parsed.postedDate || listing.postedDate),
          validThrough: '',
          description: parsed.description,
          titleByLocale: parsed.titleByLocale,
          descriptionByLocale: parsed.descriptionByLocale,
          slugByLocale: parsed.slugByLocale,
        });
      } catch (err) {
        console.warn(`  ⚠️  Failed to fetch detail for ${listing.href}: ${err.message} — skipping`);
        skipped += 1;
      }
    }

    if (jobs.length === 0) {
      throw new Error(`Failed to fetch any ALTEN job details (${skipped}/${listings.length} skipped)`);
    }
    if (skipped > 0) {
      console.warn(`  ⚠️  Skipped ${skipped}/${listings.length} detail pages due to errors`);
    }
    return jobs;
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const isTransient = /listing session could not be initialized|did not become available|net::ERR_|timeout|TimeoutError|403/i.test(msg);
    if (isTransient) {
      console.warn(`⚠️  ALTEN detail session unavailable: ${msg}`);
      console.log('ℹ️  Keeping existing data — no updates this run.');
      return null;
    }
    throw err;
  }
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
    const merged = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    return merged;
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'ALTEN Switzerland');
  writeCrawlChangeSummaryToGH(diff, 'ALTEN Switzerland');
  writeJobsSummary(mergedTarget, 'ALTEN Switzerland');
  printPublishedJobUrls(mergedTarget, 'ALTEN Switzerland');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton || DEFAULT_CANTON,
      company: COMPANY_NAME,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 16,
    crawlerModes: ['browser', 'html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated ALTEN Switzerland crawler uses a real browser session to bypass Cloudflare challenge and extracts CH-wide jobs (all 26 cantons) from the ALTEN Switzerland job board, keeping only rows whose location resolves to a Swiss canton.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ALTEN_STRICT',
    label: 'ALTEN Switzerland',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_alten_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No ALTEN jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'ALTEN Switzerland');
  console.log('═══════════════════════════════════════════════');
  console.log('  ALTEN Switzerland — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  const listings = await discoverListings();
  if (!listings) {
    console.log('⏩ Skipping ALTEN update — site unavailable.');
    printCrawlChangeSummary({ newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 }, 'ALTEN Switzerland');
    return;
  }
  const jobs = await buildJobs(listings);
  if (!jobs) {
    console.log('⏩ Skipping ALTEN update — detail session unavailable.');
    printCrawlChangeSummary({ newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 }, 'ALTEN Switzerland');
    return;
  }
  const result = mergeJobs(jobs);
  const diff = result.diff;
  updateAdapterConfig(jobs);
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  const refreshed = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob);
  writeJobsSummary(refreshed, 'ALTEN Switzerland');
  printPublishedJobUrls(refreshed, 'ALTEN Switzerland');
  validateLocales();
  console.log(`🏢 Total ALTEN jobs: ${result.total}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'ALTEN Switzerland',
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

main().catch((error) => exitCrawlerOnError(error, 'ALTEN'));
