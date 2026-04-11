#!/usr/bin/env node
/**
 * Dedicated KSGR crawler runner.
 * Source discovery is API-first via Prospective.ch, then detail extraction
 * is delegated to the shared crawler using the SSR job detail pages.
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
import { detectLang } from './lib/dedicated-crawler-common.mjs';
import { parseKsgrJobsPage } from './lib/ksgr-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const KSGR_KEY = 'kantonsspital-graubuenden-ksgr';
const HQ = getCompanyDefaults(KSGR_KEY);
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000745';
const API_LANG = 'de';
const PAGE_SIZE = 100;
const COMPANY_NAME = 'Kantonsspital Graubünden';
const COMPANY_DOMAIN = 'ksgr.ch';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isKsgrJob(job = {}) {
  const companyKey = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return (
    companyKey === KSGR_KEY ||
    company.includes('kantonsspital graubünden') ||
    company.includes('kantonsspital graubuenden') ||
    url.includes('jobs.ksgr.ch/')
  );
}

function isTrustedKsgrDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jobs.ksgr.ch' ||
      host.endsWith('.ksgr.ch') ||
      host.endsWith('.prospective.ch') ||
      host === 'career5.successfactors.eu'
    );
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
        'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.json();
}

async function fetchAllKsgrJobs() {
  const discovered = [];
  let total = null;
  let offset = 0;

  while (total === null || offset < total) {
    const url = `${API_BASE}/jobs?lang=${API_LANG}&offset=${offset}&limit=${PAGE_SIZE}`;
    const payload = await fetchJson(url);
    const parsed = parseKsgrJobsPage(payload);
    if (!parsed.jobs.length) break;
    if (total === null) total = parsed.total;
    discovered.push(...parsed.jobs);
    offset += parsed.jobs.length;
    if (parsed.jobs.length < PAGE_SIZE) break;
    await sleep(250);
  }

  const deduped = [];
  const seen = new Set();
  for (const job of discovered) {
    const key = String(job.detailUrl || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  return deduped;
}

function slugify(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 140);
}

function buildJobFromApiData(apiJob, existingByUrl) {
  const existing = existingByUrl.get(String(apiJob.detailUrl || '').toLowerCase());
  const title = apiJob.title;
  const description = apiJob.description || '';
  const slug = slugify(`${title} ${COMPANY_NAME} ${apiJob.location || 'graubuenden'}`);

  return {
    id: apiJob.id,
    title,
    description,
    url: apiJob.detailUrl,
    company: COMPANY_NAME,
    companyKey: KSGR_KEY,
    companyDomain: COMPANY_DOMAIN,
    source: 'KSGR Dedicated Parser (Prospective API)',
    sourceLang: 'de',
    location: apiJob.location || 'Graubünden',
    addressLocality: apiJob.location || 'Graubünden',
    addressRegion: apiJob.region || HQ.canton,
    addressCountry: 'CH',
    canton: HQ.canton,
    postalCode: apiJob.postalCode || '7000',
    streetAddress: apiJob.streetAddress || '',
    postedDate: apiJob.postedDate || new Date().toISOString().slice(0, 10),
    employmentType: apiJob.employmentType || '',
    category: apiJob.industry || 'healthcare',
    crawledAt: new Date().toISOString(),
    slug: existing?.slug || slug,
    slugByLocale: existing?.slugByLocale || { de: slug },
    titleByLocale: existing?.titleByLocale || { de: title },
    descriptionByLocale: existing?.descriptionByLocale || { de: description },
    baseSalary: existing?.baseSalary || { currency: 'CHF', value: { minValue: 41080, unitText: 'YEAR' } },
    featured: false,
    previousSlugs: existing?.previousSlugs || [],
    previousSlugsByLocale: existing?.previousSlugsByLocale || {},
    needsRetranslation: !(existing?.titleByLocale?.it),
    _targetScope: 'grigioni',
  };
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(KSGR_KEY, 'KSGR');
  console.log('🏥 Running dedicated KSGR jobs crawler (Prospective API)...');

  // Load existing jobs from slice to preserve slugs and translations
  const beforeJobs = readExistingCrawlerJobs(KSGR_KEY, DATA_JOBS);
  const beforeTargetJobs = Array.isArray(beforeJobs) ? beforeJobs.filter(isKsgrJob) : [];
  const beforeSlugs = snapshotJobSlugs(beforeTargetJobs);

  // Build URL→job map for slug/translation preservation
  const existingByUrl = new Map(
    beforeTargetJobs.map((job) => [String(job.url || '').toLowerCase(), job])
  );

  // Discover all jobs from Prospective API (no detail page scraping needed)
  const discoveredJobs = await fetchAllKsgrJobs();
  if (discoveredJobs.length === 0) {
    throw new Error('KSGR discovery returned 0 jobs.');
  }
  console.log(`🔎 KSGR discovered ${discoveredJobs.length} jobs from Prospective API.`);

  // Build job objects directly from API data
  const jobs = discoveredJobs.map((apiJob) => buildJobFromApiData(apiJob, existingByUrl));
  console.log(`📋 Built ${jobs.length} KSGR job objects from API data.`);

  // Write slice directly (skip shared crawler — jobs.ksgr.ch returns 403 from CI)
  writeJobsCrawlerSlice(KSGR_KEY, jobs);

  // Summary and diff
  writeJobsSummary(jobs, 'KSGR');
  printPublishedJobUrls(jobs.slice(0, 20), 'KSGR');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const diff = computeCrawlDiff(beforeSlugs, afterSnapshot);
  printCrawlChangeSummary(diff, 'KSGR jobs');
  writeCrawlChangeSummaryToGH(diff, 'KSGR jobs');

  console.log(`✅ KSGR crawler complete. ${jobs.length} jobs built from API.`);

  const _durationMs = getCrawlerElapsedMs();
  writeSummaryCrawlerSlice({
    key: KSGR_KEY,
    label: 'KSGR',
    generatedAt: new Date().toISOString(),
    total: jobs.length,
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
  console.error('❌ KSGR dedicated crawler failed.');
  console.error(error);
  process.exitCode = 1;
});
