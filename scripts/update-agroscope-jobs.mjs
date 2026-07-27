#!/usr/bin/env node
/**
 * Agroscope — Dedicated Crawler
 *
 * Crawls Swiss federal job portal via Prospective.ch API:
 *   https://ohws.prospective.ch/public/v1/medium/1000624/jobs?lang=it&offset=0&limit=100
 *
 * Fix for #4799 (2026-07-27): the API's medium_id drifted from 1000626 to
 * 1000624 (jobs.admin.ch platform migration — old id returns {total:0,
 * jobs:[]} for every query, not an error, so it silently looked like a
 * genuinely-empty board) AND the old numeric org-unit filter
 * (`f=verwaltungseinheit:1083812`) no longer isolates Agroscope — the office
 * is now only identifiable via a per-job free-text sub-facet, not a stable
 * numeric id (see scripts/lib/agroscope-job-parser.mjs docblock). See
 * docs/AGENTS-HISTORY.md for the sibling-pattern connection to #4759
 * (job.post.ch also has no working server-side brand filter).
 *
 * 1. Fetches the ENTIRE unfiltered federal jobs.admin.ch listing (no
 *    server-side org-unit filter — ~370 jobs / ~4 pages across every
 *    department), then keeps only Agroscope records client-side via
 *    `isAgroscopeApiRecord` (matches the `verwaltungseinheit_*` sub-facet
 *    text, not a numeric id — resilient to future department reorganisation).
 *    The listing is already national (CH-wide, all 26 cantons).
 * 2. Keeps every job whose location resolves to a Swiss canton (inferAnyCanton);
 *    drops foreign "Estero" postings. Agroscope is a national federal research org.
 * 3. All data is in the API response (no detail page fetching needed)
 * 4. Merges into data/jobs.json
 */

import fs from 'node:fs';
import os from 'node:os';
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
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseAgroscopeApiResponse,
  isAgroscopeSwissRelevant,
  inferAgroscopeCanton,
  inferAgroscopeCategory,
  buildAgroscopeLocalizedContent,
} from './lib/agroscope-job-parser.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path (never shared with sibling crawlers in the
// same crawler-group CI job -- no cross-process race possible by construction).
const SCRATCH_KEY = path.basename(fileURLToPath(import.meta.url), '.mjs');
const DATA_JOBS = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${SCRATCH_KEY}.json`);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'agroscope.json');

const COMPANY_KEY = 'agroscope';
const COMPANY_NAME = 'Agroscope';
const COMPANY_HOST = 'jobs.admin.ch';
const COMPANY_DOMAIN = 'admin.ch';
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000624/jobs';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;

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

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        Origin: 'https://jobs.admin.ch',
        Referer: 'https://jobs.admin.ch/',
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
    key === 'agroscope-defr' ||
    company === 'agroscope' ||
    url.includes('jobs.admin.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('admin.ch') || host.endsWith('sapsf.eu') || host.endsWith('prospective.ch');
  } catch {
    return false;
  }
}

async function fetchAllListings() {
  console.log('Fetching Agroscope job listings via Prospective API...');

  const allItems = [];
  let offset = 0;
  const limit = 100;
  let portalTotal = 0;

  // No server-side org-unit filter (see module + parser docblocks) — paginate
  // through the ENTIRE federal portal, then parseAgroscopeApiResponse filters
  // each page down to Agroscope records client-side.
  do {
    const url = `${API_BASE}?lang=it&offset=${offset}&limit=${limit}`;
    console.log(`  API: ${url}`);

    const data = await fetchJson(url);
    const { items } = parseAgroscopeApiResponse(data);
    portalTotal = data.total || 0;
    allItems.push(...items);
    offset += limit;
  } while (offset < portalTotal);

  console.log(`Scanned ${portalTotal} federal jobs.admin.ch listings, matched ${allItems.length} Agroscope jobs`);

  // Keep every job that resolves to a Swiss canton (CH-wide, all 26); drop
  // foreign "Estero" postings. The fetch is already national — no canton facet.
  const swissJobs = allItems.filter(isAgroscopeSwissRelevant);
  console.log(`Swiss (CH-wide) jobs: ${swissJobs.length}`);

  return swissJobs;
}

function buildAgroscopeJob(row) {
  const localized = buildAgroscopeLocalizedContent(row);
  const canton = inferAgroscopeCanton(row);
  // `row.directLink` (from the API's `links.directlink`) is populated on every
  // live record observed; this fallback is defensive only. Points at the
  // portal root rather than a filtered search — there is no reliable numeric
  // filter for Agroscope specifically (see module docblock), so a fallback
  // link that *claims* precision it can't deliver would be worse than none.
  const detailUrl = row.directLink || 'https://jobs.admin.ch/?lang=it';
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: row.applyUrl || detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || row.city || 'Svizzera',
    addressLocality: row.city || row.location || 'Svizzera',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferAgroscopeCategory(row),
    sector: 'Pubblica amministrazione',
    source: 'agroscope-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, row.language || 'it'),
    postedDate: row.startDate ? row.startDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
    validThrough: row.endDate ? row.endDate.slice(0, 10) : '',
    employmentType: row.pensumMax === '100' ? 'full-time' : 'part-time',
    contractType: row.pensumMax === '100' ? 'full-time' : 'part-time',
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
    const merged = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30, job.sourceLang),
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
  printCrawlChangeSummary(diff, 'Agroscope');
  writeCrawlChangeSummaryToGH(diff, 'Agroscope');
  writeJobsSummary(mergedTarget, 'Agroscope');
  printPublishedJobUrls(mergedTarget, 'Agroscope');
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
    seedUrls: [`${API_BASE}?lang=it`],
    notes: 'Dedicated Agroscope crawler — CH-wide (all 26 cantons). Uses Prospective.ch API (medium 1000624 — fixed 2026-07-27 for #4799, was stale 1000626 which silently returned {total:0,jobs:[]} for every query after a jobs.admin.ch platform migration). No server-side org-unit filter exists for Agroscope specifically (the old numeric verwaltungseinheit:1083812 filter no longer resolves anything); fetches the whole federal portal (~370 jobs) and filters client-side via isAgroscopeApiRecord matching the verwaltungseinheit_* sub-facet text "Agroscope" (see scripts/lib/agroscope-job-parser.mjs). Listing is already national since the whole portal is scanned. Swiss federal center of competence for agricultural research, part of DEFR. Research sites across CH: Posieux (FR), Reckenholz/Zürich (ZH), Changins/Nyon (VD), Conthey (VS), Cadenazzo (TI), Tänikon (TG), etc. Keeps every job that resolves to a Swiss canton (inferAnyCanton); drops foreign "Estero" postings. Full job data in API response, no detail page fetching needed.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AGROSCOPE_STRICT',
    label: 'Agroscope',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_admin_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Agroscope CH-wide jobs found after dedicated crawl.',
    detectSourceLang: (text, job) => job?.sourceLang || detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Agroscope');
  console.log('===============================================');
  console.log('  Agroscope — Dedicated Crawler');
  console.log('===============================================');
  console.log(`  API: ${API_BASE}`);
  console.log('  Filter: none (whole portal), client-side isAgroscopeApiRecord match\n');

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('No Swiss Agroscope jobs found — skipping.');
    return;
  }

  const jobs = listings.map(buildAgroscopeJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\nRunning locale fill for Agroscope jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n=== Agroscope Job Stats ===');
  console.log(`  Total Agroscope CH-wide jobs: ${total}`);
  console.log(`  Added: ${added}`);
  console.log(`  Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Agroscope',
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

main().catch((error) => exitCrawlerOnError(error, 'Agroscope'));
