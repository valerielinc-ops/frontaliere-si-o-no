#!/usr/bin/env node
/**
 * ReleWant — Dedicated Crawler
 *
 * Crawls https://relewant.zohorecruit.com/recruit/v2/public/Job_Openings?pagename=Careers
 * 1. Fetches all jobs via Zoho Recruit public JSON API (no HTML parsing needed)
 * 2. Filters Ticino-relevant jobs
 * 3. Merges into data/jobs.json
 * 4. Updates adapter config
 */

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
import {
  fetchRelewantJobs,
  parseRelewantJob,
  enrichRelewantJob,
  buildRelewantLocalizedContent,
  isRelewantTicinoRelevant,
} from './lib/relewant-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'relewant.json');

const COMPANY_KEY = 'relewant';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'ReleWant';
const COMPANY_HOST = 'relewant.zohorecruit.com';
const COMPANY_DOMAIN = 'zohorecruit.com';
const CAREERS_URL = 'https://relewant.zohorecruit.com/jobs/Careers';
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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company.includes('relewant') ||
    url.includes('relewant.zohorecruit.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'relewant.zohorecruit.com';
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const haystack = normalize(title);
  if (/devops|cloud|system|network|infrastructure/i.test(haystack)) return 'devops';
  if (/java|\.net|fullstack|full.?stack|backend|frontend|sviluppatore|developer/i.test(haystack)) return 'development';
  if (/security|sicurezza/i.test(haystack)) return 'security';
  if (/analyst|analista|bi\b|business/i.test(haystack)) return 'analysis';
  if (/project.*manager|program.*manager|consulen/i.test(haystack)) return 'consulting';
  return 'technology';
}

function buildRelewantJob(parsed) {
  const localized = buildRelewantLocalizedContent(parsed);
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: parsed.detailUrl,
    applyUrl: parsed.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: parsed.city || 'Chiasso',
    addressLocality: parsed.city || 'Chiasso',
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(parsed.title),
    sector: 'Consulenza IT',
    source: 'relewant-dedicated-crawler',
    sourceLang: detectLang(parsed.title, 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: parsed.jobType?.toLowerCase().includes('parziale') ? 'part-time' : 'full-time',
    contractType: parsed.jobType?.toLowerCase().includes('parziale') ? 'part-time' : 'full-time',
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

async function mergeJobs(discoveredJobs) {
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
    // Clear translations only when the source description changed significantly.
    // Otherwise preserve existing translated locales (en/de/fr) and only update
    // the source locale (it) from the fresh job data.
    const prevLen = (prev.description || '').length;
    const newLen = (job.description || '').length;
    const sourceChanged = Math.abs(newLen - prevLen) > 100;
    const mergedDescByLocale = sourceChanged
      ? { ...(job.descriptionByLocale || {}) }
      : { ...(prev.descriptionByLocale || {}), it: (job.descriptionByLocale || {}).it ?? (prev.descriptionByLocale || {}).it };
    const updatedJob = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergedDescByLocale,
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
    return updatedJob;
  });

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  const durationMs = getCrawlerElapsedMs();

  printCrawlChangeSummary(diff, 'ReleWant');
  writeCrawlChangeSummaryToGH(diff, 'ReleWant');
  writeJobsSummary(mergedTarget, 'ReleWant');
  printPublishedJobUrls(mergedTarget, 'ReleWant');

  // Write jobs.json with the merged (pre-translation) jobs so that
  // translateMissingJobLocales can update it in-place.
  writeJson(DATA_JOBS, [...nonTargetJobs, ...mergedTarget]);

  return { total: mergedTarget.length, added, updated, mergedTarget, diff, durationMs };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: DEFAULT_CANTON,
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
    crawlerModes: ['json'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated ReleWant crawler reads the Zoho Recruit public JSON API. No HTML scraping needed. Keeps Ticino IT consulting vacancies.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RELEWANT_STRICT',
    label: 'ReleWant',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_relewant_domain',
    failWhenNoJobs: false,
    maxToleratedMissingDescriptions: 10,
    noJobsMessage: 'No ReleWant jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime(); // reset wall-clock baseline at actual crawler start
  registerCrawlerSummaryGuard(COMPANY_KEY, 'ReleWant');
  console.log('  ReleWant — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching ReleWant jobs from Zoho Recruit API...');
  const rawJobs = await fetchRelewantJobs(TIMEOUT_MS);
  console.log(`📋 API returned ${rawJobs.length} job openings`);

  const parsed = rawJobs.map(parseRelewantJob).filter((j) => j.title);
  const ticinoJobs = parsed.filter((j) => isRelewantTicinoRelevant(j.city));
  console.log(`📍 Ticino-relevant: ${ticinoJobs.length} / ${parsed.length}`);

  if (ticinoJobs.length === 0) {
    console.log('⚠️ No Ticino-relevant jobs found — skipping.');
    return;
  }

  // Deduplicate by title + city
  const seenKeys = new Set();
  const deduplicated = [];
  for (const job of ticinoJobs) {
    const key = `${normalize(job.title)}|${normalize(job.city)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicated.push(job);
    }
  }
  if (deduplicated.length < ticinoJobs.length) {
    console.log(`🔄 Deduplicated: ${ticinoJobs.length} → ${deduplicated.length} unique`);
  }

  // Enrich each job with detail page data (description, metadata)
  console.log('\n📄 Fetching detail pages for full descriptions...');
  const enriched = [];
  for (const j of deduplicated) {
    console.log(`  📄 ${j.title} (${j.city})...`);
    const e = await enrichRelewantJob(j, TIMEOUT_MS);
    enriched.push(e);
    if (e.enriched) {
      const descLen = (e.description || '').length;
      console.log(`     ✅ enriched — desc ${descLen} chars`);
    } else {
      console.log(`     ⚠️ not enriched — using generic template`);
    }
    // Small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  const jobs = enriched.map(buildRelewantJob);
  const { total, added, updated, mergedTarget, diff, durationMs } = await mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for ReleWant jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  // Write the per-crawler slice AFTER translation so the slice contains fully
  // localized content. Then re-assemble the global dataset from slices.
  const translatedJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob);
  writeJobsCrawlerSlice(COMPANY_KEY, translatedJobs);
  const summaryEntry = {
    key: COMPANY_KEY,
    label: 'ReleWant',
    generatedAt: new Date().toISOString(),
    total: translatedJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs,
    avgDurationMs: durationMs,
    durationHistory: [durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  };
  writeSummaryCrawlerSlice(summaryEntry);
  await assembleJobsDataset();

  console.log('\n📊 === ReleWant Job Stats ===');
  console.log(`  🏢 Total ReleWant jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
}

main().catch((error) => {
  console.error(`❌ ReleWant crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
