#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
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
import {
  parseDelvitechCareerPage,
  parseDelvitechJobDetail,
  isDelvitechTicinoJob,
  inferDelvitechCategory,
  inferDelvitechCanton,
  buildDelvitechLocalizedContent,
} from './lib/delvitech-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'delvitech-sa.json');

const COMPANY_KEY = 'delvitech-sa';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Delvitech SA';
const COMPANY_HOST = 'legacy.delvi.tech';
const COMPANY_DOMAIN = 'delvi.tech';
const CAREERS_URL = 'https://legacy.delvi.tech/career/';
const LOCALES = ['it', 'en', 'de', 'fr'];
const execFile = promisify(execFileCb);
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAccessLimited(html = '') {
  const value = String(html || '').toLowerCase();
  return value.includes('your access to this site has been limited') || value.includes('http response code 503');
}

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': BROWSER_UA,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (isAccessLimited(html)) {
      throw new Error('Access limited by site owner');
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithBrowser(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent: BROWSER_UA,
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1000);
    const html = await page.content();
    if (isAccessLimited(html)) {
      throw new Error('Browser fallback still blocked by site owner');
    }
    return html;
  } finally {
    await browser.close();
  }
}

async function fetchWithCurl(url) {
  const runCurl = async (extraArgs = []) => {
    const { stdout } = await execFile('curl', [
      '-L',
      '--max-time',
      '30',
      '-A',
      BROWSER_UA,
      ...extraArgs,
      url,
    ], {
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  };

  try {
    const stdout = await runCurl();
    if (isAccessLimited(stdout)) {
      throw new Error('curl fallback blocked by site owner');
    }
    return stdout;
  } catch (error) {
    const host = new URL(url).hostname;
    const dnsQuery = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
      headers: { Accept: 'application/json' },
    });
    const dnsPayload = await dnsQuery.json().catch(() => ({}));
    const ip = dnsPayload?.Answer?.find?.((entry) => entry?.type === 1 && entry?.data)?.data;
    if (!ip) throw error;
    const stdout = await runCurl(['--resolve', `${host}:443:${ip}`]);
    if (isAccessLimited(stdout)) {
      throw new Error('curl+DoH fallback blocked by site owner');
    }
    return stdout;
  }
}

async function fetchRobust(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchText(url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1200 * attempt);
    }
  }
  console.log(`⚠️  fetch failed for ${url}, trying curl fallback...`);
  try {
    return await fetchWithCurl(url);
  } catch (error) {
    lastError = error;
  }
  console.log(`⚠️  fetch failed for ${url}, trying Playwright fallback...`);
  try {
    return await fetchWithBrowser(url);
  } catch (error) {
    throw lastError || error;
  }
}

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, CAREERS_URL).toString();
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('delvitech') || url.includes('legacy.delvi.tech/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'legacy.delvi.tech' || host.endsWith('.delvi.tech') || host === 'delvi.tech';
  } catch {
    return false;
  }
}

async function fetchListings() {
  console.log('🔍 Fetching Delvitech career page...');
  const html = await fetchRobust(CAREERS_URL);
  const listings = parseDelvitechCareerPage(html);
  console.log(`📋 Total Delvitech job pages found: ${listings.length}`);
  if (listings.length < 12) {
    throw new Error(`Expected at least 12 Delvitech career pages, found ${listings.length}`);
  }
  return listings;
}

function buildApplyUrl(email, title, fallbackUrl) {
  if (!email) return fallbackUrl;
  const subject = encodeURIComponent(`Application - ${title}`);
  return `mailto:${email}?subject=${subject}`;
}

async function buildDelvitechJob(listing) {
  const detailUrl = absoluteUrl(listing.href);
  const html = await fetchRobust(detailUrl);
  const detail = parseDelvitechJobDetail(html, detailUrl);
  if (!detail.title) {
    throw new Error(`Missing title while parsing ${detailUrl}`);
  }
  if (!isDelvitechTicinoJob(detail)) {
    return null;
  }
  const localized = buildDelvitechLocalizedContent(detail);
  const canton = inferDelvitechCanton(detail);
  const defaultCity = canton === 'GR' ? 'Graubünden' : 'Mendrisio';
  const location = detail.location || defaultCity;
  return {
    title: detail.title,
    slug: localized.slugByLocale.en,
    url: detailUrl,
    applyUrl: buildApplyUrl(detail.email, detail.title, detailUrl),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferDelvitechCategory(detail.title, detail.description),
    sector: 'Tecnologia & IT',
    source: 'delvitech-dedicated-crawler',
    sourceLang: detectLang(detail.description || detail.title, 'en'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: detail.description,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
    contactEmail: detail.email || 'career@delvi.tech',
  };
}

function jobMatchKey(job = {}) {
  return String(job.url || '').trim().toLowerCase() || String(job.slug || '').trim().toLowerCase();
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
  printCrawlChangeSummary(diff, 'Delvitech SA');
  writeCrawlChangeSummaryToGH(diff, 'Delvitech SA');
  writeJobsSummary(mergedTarget, 'Delvitech SA');
  printPublishedJobUrls(mergedTarget, 'Delvitech SA');
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
    priority: 20,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Delvitech crawler parses the legacy WordPress career page and detail pages, excluding Germany roles and publishing TI + GR vacancies.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DELVITECH_STRICT',
    label: 'Delvitech SA',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_delvitech_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Delvitech jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Delvitech SA');
  console.log('═══════════════════════════════════════════════');
  console.log('  Delvitech SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  // Bail out gracefully if the adapter is disabled (e.g. careers page is unreachable).
  const adapterConfig = readJson(ADAPTER_PATH, { enabled: true });
  if (adapterConfig.enabled === false) {
    console.log('ℹ️  Delvitech SA crawler is disabled in adapter config — skipping.');
    return;
  }

  const listings = await fetchListings();
  const jobs = [];
  let skipped = 0;
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.title}`);
    try {
      const job = await buildDelvitechJob(listing);
      if (job) jobs.push(job);
    } catch (err) {
      skipped += 1;
      console.warn(`  ⚠️  Skipping "${listing.title}": ${err.message}`);
    }
    await sleep(350);
  }
  if (skipped) console.log(`  ⚠️  Skipped ${skipped}/${listings.length} listings due to errors`);

  const minJobs = Math.max(1, 8 - skipped);
  if (jobs.length < minJobs) {
    throw new Error(`Expected at least ${minJobs} TI/GR Delvitech jobs after excluding foreign roles, found ${jobs.length}`);
  }

  const { total, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Delvitech jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  validateLocales();

  console.log('\n📊 === Delvitech Job Stats ===');
  const tiCount = jobs.filter((j) => j.canton === 'TI').length;
  const grCount = jobs.filter((j) => j.canton === 'GR').length;
  console.log(`  🏢 Total Delvitech jobs (TI+GR): ${total} (TI: ${tiCount}, GR: ${grCount})`);
  for (const job of jobs) {
    console.log(`  • ${job.title} (${job.location}, ${job.canton})`);
  }

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Delvitech SA',
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

main().catch((error) => {
  console.error('❌ Delvitech crawler failed:', error);
  process.exitCode = 1;
});
