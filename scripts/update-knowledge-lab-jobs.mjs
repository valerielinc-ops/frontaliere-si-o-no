#!/usr/bin/env node
/**
 * Knowledge Lab — Dedicated Crawler
 *
 * Crawls via Freshteam API (https://klab.freshteam.com/api/job_postings)
 * 1. Fetches all published jobs in one API call (with auth token)
 * 2. Filters to Swiss + Ticino-relevant jobs
 * 3. Merges into data/jobs.json
 * 4. Updates adapter config
 *
 * No detail page fetching needed — Freshteam API includes full descriptions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStableJobId } from './lib/job-match-key.mjs';
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
  parseKnowledgeLabListingJson,
  buildKnowledgeLabLocalizedContent,
  isKnowledgeLabTicinoRelevant,
  inferKnowledgeLabCanton,
} from './lib/knowledge-lab-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'knowledge-lab.json');

const COMPANY_KEY = 'knowledge-lab';
const COMPANY_NAME = 'Knowledge Lab';
const COMPANY_HOST = 'knowledge-lab.ch';
const COMPANY_DOMAIN = 'knowledge-lab.ch';
const CAREERS_URL = 'https://knowledge-lab.ch/en/who-we-are/careers';
const FRESHTEAM_API = 'https://klab.freshteam.com/api/job_postings?status=published';
const FRESHTEAM_TOKEN = 'dCgoskmdTBBZPx2XPT-hyQ';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

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

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${FRESHTEAM_TOKEN}`,
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'knowledge-lab-ag' ||
    company === 'knowledge lab' ||
    company === 'knowledge lab ag' ||
    url.includes('knowledge-lab.ch') ||
    url.includes('klab.freshteam.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('knowledge-lab.ch') || host.endsWith('freshteam.com');
  } catch {
    return false;
  }
}

function inferCategory(title = '', department = '') {
  const haystack = normalize(`${title} ${department}`);
  if (/software|engineer|developer|platform|devops/i.test(haystack)) return 'it';
  if (/ai\b|machine.*learn|data.*scien/i.test(haystack)) return 'it';
  if (/consult|solution/i.test(haystack)) return 'consulting';
  if (/avaloq|banking.*tech/i.test(haystack)) return 'it';
  if (/cyber|security/i.test(haystack)) return 'it';
  if (/sales|account/i.test(haystack)) return 'sales';
  if (/hr|recruit|talent/i.test(haystack)) return 'hr';
  if (/marketing|communicat/i.test(haystack)) return 'marketing';
  if (/admin|office/i.test(haystack)) return 'admin';
  return 'it';
}

function inferSector() {
  return 'IT & Consulenza Bancaria';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Knowledge Lab jobs via Freshteam API...');
  console.log(`  📡 ${FRESHTEAM_API}`);

  const json = await fetchJson(FRESHTEAM_API);
  const { items, totalResults } = parseKnowledgeLabListingJson(json);

  console.log(`📋 Total published listings: ${totalResults}`);
  return items;
}

function buildKnowledgeLabJob(row) {
  const localized = buildKnowledgeLabLocalizedContent(row);
  const canton = inferKnowledgeLabCanton(row);
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.applyUrl || `${CAREERS_URL}`,
    applyUrl: row.applyUrl || '',
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || 'Switzerland',
    addressLocality: row.location || 'Switzerland',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title, row.department),
    sector: inferSector(),
    source: 'knowledge-lab-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'en'),
    postedDate: row.postedDate,
    employmentType: row.employmentType || 'full-time',
    contractType: row.employmentType || 'full-time',
    validThrough: '',
    description: localized.descriptionByLocale.it,
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
  printCrawlChangeSummary(diff, 'Knowledge Lab');
  writeCrawlChangeSummaryToGH(diff, 'Knowledge Lab');
  writeJobsSummary(mergedTarget, 'Knowledge Lab');
  printPublishedJobUrls(mergedTarget, 'Knowledge Lab');
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
    crawlerModes: ['api'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Knowledge Lab crawler uses Freshteam API (klab.freshteam.com/api/job_postings). Single API call returns all published jobs with descriptions. Offices in Zurich (HQ), Mendrisio (TI), Madrid, Belgrade.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_KNOWLEDGE_LAB_STRICT',
    label: 'Knowledge Lab',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_knowledge_lab_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Knowledge Lab jobs found after dedicated crawl.',
    detectSourceLang: () => 'en',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Knowledge Lab');
  console.log('═══════════════════════════════════════════════');
  console.log('  Knowledge Lab — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page:   ${CAREERS_URL}`);
  console.log(`  Freshteam API:  ${FRESHTEAM_API}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No listings found on Freshteam API — skipping.');
    return;
  }

  // Filter to Swiss jobs
  const swissJobs = listings.filter((j) => j.countryCode === 'CH');
  console.log(`🇨🇭 Swiss jobs: ${swissJobs.length} / ${listings.length}`);

  // Filter to Ticino-relevant
  const ticinoJobs = swissJobs.filter(isKnowledgeLabTicinoRelevant);
  console.log(`📍 Ticino-relevant jobs: ${ticinoJobs.length} / ${swissJobs.length}`);

  if (ticinoJobs.length === 0) {
    console.log('⚠️ No Ticino-relevant jobs found — skipping merge.');
    return;
  }

  // Deduplicate by apply URL
  const seenUrls = new Map();
  const deduplicated = [];
  for (const listing of ticinoJobs) {
    const key = normalize(listing.applyUrl || listing.jobId);
    if (!seenUrls.has(key)) {
      seenUrls.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < ticinoJobs.length) {
    console.log(`🔄 Deduplicated: ${ticinoJobs.length} → ${deduplicated.length} unique jobs`);
  }

  const jobs = deduplicated.map(buildKnowledgeLabJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Knowledge Lab jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Knowledge Lab Job Stats ===');
  console.log(`  🏢 Total Knowledge Lab jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Knowledge Lab',
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
  console.error(`❌ Knowledge Lab crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
