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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang } from './lib/dedicated-crawler-common.mjs';
import { parseKsgrJobsPage } from './lib/ksgr-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'kantonsspital-graubuenden-ksgr.json');
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

function ensureAdapter(discoveredJobs) {
  const adapter = readJson(ADAPTER_PATH, {
    companyKey: KSGR_KEY,
    companyName: COMPANY_NAME,
    companyHost: 'jobs.ksgr.ch',
    enabled: true,
    priority: 10,
    crawlerModes: ['jsonld', 'html', 'generic_ats'],
    seedUrls: [],
    seedMetaByUrl: {},
    notes: 'Dedicated KSGR crawler seeds Prospective.ch API detail URLs from jobs.ksgr.ch.',
    updatedAt: new Date().toISOString(),
  });

  adapter.companyKey = KSGR_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = 'jobs.ksgr.ch';
  adapter.enabled = true;
  adapter.priority = Math.max(Number(adapter.priority || 0), 10);
  adapter.crawlerModes = ['jsonld', 'html', 'generic_ats'];
  adapter.seedUrls = discoveredJobs.map((job) => job.detailUrl);
  adapter.seedMetaByUrl = Object.fromEntries(
    discoveredJobs.map((job) => [
      job.detailUrl,
      {
        location: job.location || 'Graubünden',
        canton: HQ.canton,
        company: COMPANY_NAME,
        postedDate: job.postedDate || '',
      },
    ])
  );
  adapter.notes = 'Dedicated KSGR crawler seeds Prospective.ch API detail URLs from jobs.ksgr.ch.';
  adapter.updatedAt = new Date().toISOString();

  writeJson(ADAPTER_PATH, adapter);
}

function postProcessKsgrJobs(discoveredJobs) {
  const jobs = readExistingCrawlerJobs(KSGR_KEY, DATA_JOBS);
  if (!Array.isArray(jobs)) return { updated: 0, total: 0 };

  const metaByUrl = new Map(
    discoveredJobs.map((job) => [String(job.detailUrl || '').toLowerCase(), job])
  );

  let updated = 0;
  for (const job of jobs) {
    if (!isKsgrJob(job)) continue;
    const meta = metaByUrl.get(String(job.url || '').toLowerCase());
    job.company = COMPANY_NAME;
    job.companyKey = KSGR_KEY;
    job.companyDomain = COMPANY_DOMAIN;
    job.source = 'KSGR Dedicated Parser (Prospective API)';
    job.addressCountry = job.addressCountry || 'CH';
    job.canton = HQ.canton;
    if (!job.sourceLang) {
      job.sourceLang = detectLang((job.description || job.title || ''), 'de');
    }
    if (meta?.location) {
      job.location = meta.location;
      job.addressLocality = meta.location;
    } else if (!job.location) {
      job.location = 'Graubünden';
      job.addressLocality = 'Graubünden';
    }
    if (meta?.postedDate && !String(job.postedDate || '').trim()) {
      job.postedDate = meta.postedDate;
    }
    updated += 1;
  }

  writeJson(DATA_JOBS, jobs);
  writeJson(PUBLIC_JOBS, jobs);
  return { updated, total: jobs.length };
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(KSGR_KEY, 'KSGR');
  console.log('🏥 Running dedicated KSGR jobs crawler (Prospective API)...');
  const beforeJobs = readExistingCrawlerJobs(KSGR_KEY, DATA_JOBS);
  const beforeTargetJobs = Array.isArray(beforeJobs) ? beforeJobs.filter((job) => isKsgrJob(job)) : [];
  const beforeSlugs = snapshotJobSlugs(beforeTargetJobs);
  const discoveredJobs = await fetchAllKsgrJobs();
  if (discoveredJobs.length === 0) {
    throw new Error('KSGR discovery returned 0 jobs.');
  }

  console.log(`🔎 KSGR discovered ${discoveredJobs.length} remote job pages.`);
  ensureAdapter(discoveredJobs);

  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: [KSGR_KEY],
    localizeOnlyCompanyKeys: [KSGR_KEY],
    forceLocalizeKeys: [KSGR_KEY],
  });

  const repairStats = postProcessKsgrJobs(discoveredJobs);
  console.log(`🧹 KSGR post-process updated ${repairStats.updated} jobs.`);

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DEDICATED_KSGR_STRICT',
    label: 'KSGR',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isKsgrJob,
    detectSourceLang: (text) => (/[äöüß]/i.test(String(text || '')) ? 'de' : 'de'),
    isTrustedDomain: isTrustedKsgrDomain,
    untranslatedCheck: true,
    minDescriptionChars: 120,
    failWhenNoJobs: true,
    noJobsMessage: 'No KSGR jobs found after dedicated crawl.',
  });

  const allJobs = readExistingCrawlerJobs(KSGR_KEY, DATA_JOBS);
  const targetJobs = Array.isArray(allJobs) ? allJobs.filter((job) => isKsgrJob(job)) : [];
  writeJobsSummary(targetJobs, 'KSGR');
  printPublishedJobUrls(targetJobs.slice(0, 20), 'KSGR');

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const diff = computeCrawlDiff(beforeSlugs, afterSnapshot);
  printCrawlChangeSummary(diff, 'KSGR jobs');
  writeCrawlChangeSummaryToGH(diff, 'KSGR jobs');

  console.log(`✅ KSGR crawler complete. Remote job pages crawled: ${discoveredJobs.length}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isKsgrJob) : [];
  writeJobsCrawlerSlice(KSGR_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: KSGR_KEY,
    label: 'KSGR',
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
  console.error('❌ KSGR dedicated crawler failed.');
  console.error(error);
  process.exitCode = 1;
});
