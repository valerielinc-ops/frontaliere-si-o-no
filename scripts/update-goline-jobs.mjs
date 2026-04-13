#!/usr/bin/env node
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
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
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { parseGolineOpportunitiesPage, buildGolineLocalizedContent } from './lib/goline-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'goline.json');

const COMPANY_KEY = 'goline';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'GOLINE SA';
const COMPANY_HOST = 'www.goline.ch';
const COMPANY_DOMAIN = 'goline.ch';
const CAREERS_URL = 'https://www.goline.ch/opportunities/';
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

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

async function fetchPage(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 30000) {
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'it-CH,it;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'User-Agent': USER_AGENTS[attempt],
          Referer: 'https://www.google.com/',
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2) {
        const delay = 3000 * (attempt + 1);
        console.log(`  ⚠️  fetch attempt ${attempt + 1} failed (${err.message}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.log(`  ⚠️  all fetch attempts failed (${err.message}), trying Playwright fallback...`);
        try {
          const { chromium } = await import('playwright');
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage({ userAgent: USER_AGENTS[0] });
            await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
            await page.waitForSelector('h2.wp-block-heading', { timeout: 10000 }).catch(() => {});
            return await page.content();
          } finally {
            await browser.close();
          }
        } catch (pwErr) {
          throw new Error(`All fetch methods failed. Last fetch: ${err.message}. Playwright: ${pwErr.message}`);
        }
      }
    }
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('goline') || url.includes('goline.ch/opportunities');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'goline.ch' || host === 'www.goline.ch';
  } catch {
    return false;
  }
}

function buildJob(role) {
  const localized = buildGolineLocalizedContent(role);
  const slug = localized.it.slug;
  return {
    title: localized.it.title,
    slug,
    url: CAREERS_URL,
    applyUrl: role.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: role.location || 'Stabio',
    addressLocality: role.location || 'Stabio',
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: 'tech',
    sector: 'Tecnologia & IT',
    source: 'goline-dedicated-crawler',
    sourceLang: 'en',
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: localized.it.description,
    titleByLocale: {
      it: localized.it.title,
      en: localized.en.title,
      de: localized.de.title,
      fr: localized.fr.title,
    },
    descriptionByLocale: {
      it: localized.it.description,
      en: localized.en.description,
      de: localized.de.description,
      fr: localized.fr.description,
    },
    slugByLocale: {
      it: localized.it.slug,
      en: localized.en.slug,
      de: localized.de.slug,
      fr: localized.fr.slug,
    },
  };
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);

  const mergedTarget = mergePreserveLocaleData(targetExisting, discoveredJobs);
  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'GOLINE SA');
  writeCrawlChangeSummaryToGH(diff, 'GOLINE SA');
  writeJobsSummary(mergedTarget, 'GOLINE SA');
  printPublishedJobUrls(mergedTarget, 'GOLINE SA');
  return { total: mergedTarget.length, diff };
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
  const payload = {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated GOLINE crawler parses the public opportunities page and extracts the current Ticino role directly from the WordPress content.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  };
  writeJson(ADAPTER_PATH, payload);
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GOLINE_STRICT',
    label: 'GOLINE SA',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_goline_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No GOLINE jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'GOLINE SA');
  console.log('═══════════════════════════════════════════════');
  console.log('  GOLINE SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  let html;
  try {
    html = await fetchPage(CAREERS_URL);
  } catch (fetchErr) {
    // Check if existing Goline jobs are already in the data
    const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
    const existing = allJobs.filter(isTargetJob);
    if (existing.length > 0) {
      console.log(`⚠️  Could not reach Goline website (${fetchErr.message}).`);
      console.log(`   Keeping ${existing.length} existing Goline job(s) — no changes made.`);
      return;
    }
    throw fetchErr;
  }

  const role = parseGolineOpportunitiesPage(html);
  const job = buildJob(role);
  const { total, diff } = mergeJobs([job]);
  updateAdapterConfig([job]);

  console.log('\n🌐 Running locale fill for GOLINE jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ GOLINE crawler complete (${total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'GOLINE SA',
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
  console.error(`❌ GOLINE crawler failed: ${err?.message || err}`);
  process.exit(1);
});
