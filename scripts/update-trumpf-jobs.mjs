#!/usr/bin/env node
/**
 * Dedicated TRUMPF Schweiz AG (Grüsch, GR) crawler.
 *
 * Source: Workday ATS — trumpf.wd3.myworkdayjobs.com
 *   Portals: TRUMPF_Graduates_and_Professionals, TRUMPF_Apprenticeships
 *
 * Strategy:
 *   1. POST to Workday JSON API to list all Swiss jobs across both portals.
 *   2. GET detail pages via Workday CXS API for full descriptions.
 *   3. Filter for Grüsch / GR-canton locations.
 *   4. Build standardized job objects + translate.
 *   5. Merge into data/jobs.json.
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
import { isTargetSwissLocation, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { isTargetCanton, getCompanyDefaults, getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'trumpf-schweiz.json');

const COMPANY_KEY = 'trumpf-schweiz';
const COMPANY_NAME = 'TRUMPF Schweiz AG';
const COMPANY_DOMAIN = 'trumpf.com';
const TRUMPF_HQ = getCompanyDefaults(COMPANY_KEY);
const DEFAULT_CANTON = TRUMPF_HQ?.canton || 'GR';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '15000', 10);
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoCrawler/1.0; +https://frontaliereticino.ch)';

const WORKDAY_BASE = 'https://trumpf.wd3.myworkdayjobs.com';
const WORKDAY_CXS = `${WORKDAY_BASE}/wday/cxs/trumpf`;

// Both job portals
const PORTALS = [
  'TRUMPF_Graduates_and_Professionals',
  'TRUMPF_Apprenticeships',
];

// TRUMPF spans Switzerland; canton scope is governed by TARGET_CANTONS in
// scripts/lib/crawler-location-config.mjs.

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function slugify(value = '') {
  return String(value || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#43;/g, '+')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTargetJob(job) {
  if (!job) return false;
  if (job.companyKey === COMPANY_KEY) return true;
  const cn = normalize(job.company || '');
  return cn.includes('trumpf schweiz') || cn.includes('trumpf-schweiz');
}

function jobMatchKey(job) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function isSwissLocation(locationText = '') {
  return isTargetSwissLocation(String(locationText || ''));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────
// Category inference
// ──────────────────────────────────────────────────────────────

function inferCategory(title = '') {
  const hay = title.toLowerCase();
  if (/(engineer|technik|konstrukt|entwickl|mechatron|automat)/i.test(hay)) return 'engineering';
  if (/(finanzbuch|account|controlling|buchhal)/i.test(hay)) return 'finance';
  if (/(production|produktions|anlagen|fertigung|montage|lager|logist)/i.test(hay)) return 'operations';
  if (/(it|software|data|cyber|system)/i.test(hay)) return 'it';
  if (/(sales|account manager|vertrieb|einkäuf|einkauf|procurement)/i.test(hay)) return 'sales';
  if (/(marketing|kommunikation|communication)/i.test(hay)) return 'marketing';
  if (/(hr|human|personal|talent|recrui)/i.test(hay)) return 'hr';
  if (/(project|projekt)/i.test(hay)) return 'project-management';
  if (/(lehrstelle|apprenti|ausbildung|lehrling)/i.test(hay)) return 'apprenticeship';
  if (/(field service|service tech|kundendienst)/i.test(hay)) return 'service';
  return 'manufacturing';
}

function mapEmploymentType(timeType = '', title = '') {
  const t = `${timeType} ${title}`.toLowerCase();
  if (t.includes('part')) return 'part_time';
  if (t.includes('praktik') || t.includes('intern') || t.includes('trainee')) return 'internship';
  if (t.includes('lehrstelle') || t.includes('apprenti') || t.includes('ausbildung')) return 'apprenticeship';
  return 'full_time';
}

// ──────────────────────────────────────────────────────────────
// Workday API
// ──────────────────────────────────────────────────────────────

async function fetchPortalJobs(portal) {
  const url = `${WORKDAY_CXS}/${portal}/jobs`;
  const PAGE_SIZE = 20;
  const allJobs = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const body = JSON.stringify({
      appliedFacets: {},
      limit: PAGE_SIZE,
      offset,
      searchText: 'Switzerland',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Workday API error for ${portal}: ${res.status}`);
    const data = await res.json();
    total = data.total || 0;
    const postings = data.jobPostings || [];
    allJobs.push(...postings.map((p) => ({ ...p, portal })));

    if (postings.length === 0) break;
    offset += postings.length;
  }
  return allJobs;
}

async function fetchJobDetail(portal, externalPath) {
  const url = `${WORKDAY_CXS}/${portal}${externalPath}`;
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed for ${externalPath}: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Build
// ──────────────────────────────────────────────────────────────

function buildJobFromListing(listing) {
  const title = listing.title || '';
  const city = (listing.locationsText || '').trim();
  const reqId = (listing.bulletFields || [])[0] || '';
  const slug = slugify(`${title}-trumpf-${reqId}`);
  const externalUrl = `${WORKDAY_BASE}/${listing.portal}${listing.externalPath}`;
  const canton = inferAnyCanton(city) || DEFAULT_CANTON;

  return {
    title,
    slug,
    url: externalUrl,
    applyUrl: externalUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: getCantonDisplayName(canton, 'de') || canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(title),
    sector: 'Tecnologia Industriale & Laser',
    source: 'trumpf-dedicated-crawler',
    sourceLang: 'de',
    postedDate: todayIso(),
    validThrough: '',
    employmentType: 'full_time',
    contractType: 'permanent',
    description: '',
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
    crawledAt: new Date().toISOString(),
    // Keep for enrichment
    _portal: listing.portal,
    _externalPath: listing.externalPath,
    _reqId: reqId,
  };
}

function enrichJobFromDetail(job, detail) {
  if (!detail) return job;
  const info = detail.jobPostingInfo || {};
  const org = detail.hiringOrganization || {};

  const rawDesc = info.jobDescription || '';
  const description = stripHtml(rawDesc).slice(0, 3000);
  const sourceLang = detectLang(job.title + ' ' + description) || 'de';
  const empType = mapEmploymentType(info.timeType || '', job.title);

  let postedDate = todayIso();
  if (info.startDate) {
    try {
      const d = new Date(info.startDate);
      if (!isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
    } catch { /* keep default */ }
  }

  // Clean company name from org (e.g., "223 TCH - TRUMPF Schweiz AG" → "TRUMPF Schweiz AG")
  let companyName = COMPANY_NAME;
  if (org.name) {
    const match = org.name.match(/TRUMPF\s+\S+/i);
    if (match) companyName = org.name.replace(/^\d+\s+\w+\s*-\s*/, '').trim() || COMPANY_NAME;
  }

  return {
    ...job,
    description,
    sourceLang,
    postedDate,
    employmentType: empType,
    contractType: empType === 'apprenticeship' ? 'apprendistato' : 'permanent',
    company: companyName,
    location: info.location || job.location,
    addressLocality: info.location || job.addressLocality,
  };
}

// ──────────────────────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────────────────────

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
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, allJobs);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  return { total: allJobs.length, added, updated, targetCount: mergedTarget.length, diff };
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'trumpf');
  console.log(`\n⚡ TRUMPF Schweiz AG — Dedicated Job Crawler`);
  console.log(`   Source: Workday ATS (trumpf.wd3.myworkdayjobs.com)`);
  console.log(`   Company key: ${COMPANY_KEY}\n`);

  // Validate adapter
  const adapter = readJson(ADAPTER_PATH, null);
  if (!adapter || !adapter.enabled) {
    console.warn('⚠️ Adapter not found or disabled — exiting.');
    process.exit(0);
  }

  // Phase 1 — Fetch from all portals
  console.log('═══════════════════════════════════════');
  console.log('Phase 1: Fetch jobs from Workday portals');
  console.log('═══════════════════════════════════════');
  const allListings = [];
  for (const portal of PORTALS) {
    console.log(`\n🔍 Fetching ${portal} ...`);
    const jobs = await fetchPortalJobs(portal);
    console.log(`   Found ${jobs.length} Swiss results`);
    allListings.push(...jobs);
  }
  console.log(`\n📋 Total listings across portals: ${allListings.length}`);

  // Phase 2 — Filter for target Swiss cantons
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 2: Filter target-canton jobs');
  console.log('═══════════════════════════════════════');
  const swissListings = allListings.filter((l) => isSwissLocation(l.locationsText || ''));

  // Deduplicate by externalPath (same job may appear in multiple search results)
  const seen = new Set();
  const uniqueListings = swissListings.filter((l) => {
    if (seen.has(l.externalPath)) return false;
    seen.add(l.externalPath);
    return true;
  });

  console.log(`📋 Target-canton jobs found: ${uniqueListings.length}`);
  for (const listing of uniqueListings) {
    console.log(`  📄 ${listing.title} | ${listing.locationsText} | ${listing.portal}`);
  }

  if (uniqueListings.length === 0) {
    console.log('ℹ️ No target-canton jobs found — nothing to update.');
    process.exit(0);
  }

  // Phase 3 — Build + enrich from detail pages
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 3: Build jobs + fetch details');
  console.log('═══════════════════════════════════════');
  const jobs = [];
  for (const listing of uniqueListings) {
    const baseJob = buildJobFromListing(listing);
    console.log(`  🔗 Fetching detail: ${listing.title} ...`);
    const detail = await fetchJobDetail(listing.portal, listing.externalPath);
    const enriched = enrichJobFromDetail(baseJob, detail);
    // Remove internal fields
    delete enriched._portal;
    delete enriched._externalPath;
    delete enriched._reqId;
    jobs.push(enriched);
  }
  console.log(`📊 Built ${jobs.length} job objects`);

  // Phase 4 — Merge
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 4: Merge');
  console.log('═══════════════════════════════════════');
  const stats = mergeJobs(jobs);
  const diff = stats.diff;
  console.log(`\n📈 Result: ${stats.targetCount} TRUMPF GR jobs (${stats.added} new, ${stats.updated} updated)`);
  console.log(`   Total jobs in file: ${stats.total}`);

  // Phase 5 — Translate + validate
  console.log('\n═══════════════════════════════════════');
  console.log('Phase 5: Translate');
  console.log('═══════════════════════════════════════');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_TRUMPF_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    failWhenNoJobs: true,
    noJobsMessage: 'No TRUMPF jobs found after dedicated crawl.',
  });

  // Phase 6 — Summary
  printPublishedJobUrls(jobs);
  writeJobsSummary(COMPANY_KEY, stats);

  console.log('\n✅ TRUMPF Schweiz AG crawler complete.\n');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'trumpf',
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
  console.error('❌ Fatal crawler error:', err);
  process.exit(1);
});
