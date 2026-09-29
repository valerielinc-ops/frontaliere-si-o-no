#!/usr/bin/env node
/**
 * Knowledge Lab — Dedicated Crawler
 *
 * Crawls the public Freshteam careers portal (https://klab.freshteam.com/jobs/)
 * 1. Discovers published detail links from the public listing page, then reads
 *    each detail page for the complete JobPosting description and location —
 *    the feed is national (no canton/region facet), Knowledge Lab is a CH-wide
 *    employer
 * 2. Keeps jobs whose detail-page location resolves to any of the 26 Swiss
 *    cantons; drops non-CH / unresolved (foreign) jobs
 * 3. Merges into data/jobs.json
 * 4. Updates adapter config
 *
 * Closed detail links are skipped. An open detail page without a title,
 * location, or rich description is a source-contract failure so the existing
 * snapshot is preserved instead of publishing a thin or mislocated job.
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
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import {
  KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL,
  parseKnowledgeLabPublicDetailHtml,
  parseKnowledgeLabPublicListingHtml,
  buildKnowledgeLabLocalizedContent,
  isKnowledgeLabSwissRelevant,
  inferKnowledgeLabCanton,
  dropKnowledgeLabFabricatedText,
} from './lib/knowledge-lab-job-parser.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path (never shared with sibling crawlers in the
// same crawler-group CI job -- no cross-process race possible by construction).
const SCRATCH_KEY = path.basename(fileURLToPath(import.meta.url), '.mjs');
const DATA_JOBS = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${SCRATCH_KEY}.json`);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'knowledge-lab.json');

const COMPANY_KEY = 'knowledge-lab';
const COMPANY_NAME = 'Knowledge Lab';
const COMPANY_HOST = 'knowledge-lab.ch';
const COMPANY_DOMAIN = 'knowledge-lab.ch';
const CAREERS_URL = 'https://knowledge-lab.ch/en/who-we-are/careers';
const LOCALES = ['it', 'en', 'de', 'fr'];
const FRESHTEAM_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
};

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

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
  console.log('🔍 Fetching Knowledge Lab jobs from the public Freshteam portal...');
  console.log(`  📡 ${KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL}`);

  const listingHtml = await fetchHtml(KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL, {
    timeoutMs: TIMEOUT_MS,
    label: 'Knowledge Lab Freshteam public careers portal',
    headers: FRESHTEAM_HEADERS,
  });
  const listing = parseKnowledgeLabPublicListingHtml(listingHtml);
  if (!listing.recognized) {
    throw new Error('Freshteam public careers page was not recognized; refusing to treat an HTML contract change as an empty feed');
  }
  if (listing.items.length === 0) {
    if (listing.hasOpenPositionSignals && !/no\s+jobs\s+found/i.test(listingHtml)) {
      throw new Error('Freshteam public careers page advertises open positions but exposes no detail links');
    }
    console.log('📋 No published detail links on the public Freshteam portal.');
    return [];
  }

  console.log(`📋 Public detail links discovered: ${listing.items.length}`);
  const items = [];
  for (const candidate of listing.items) {
    let detailHtml;
    try {
      detailHtml = await fetchHtml(candidate.detailUrl, {
        timeoutMs: TIMEOUT_MS,
        label: `Knowledge Lab Freshteam detail ${candidate.jobId}`,
        headers: FRESHTEAM_HEADERS,
      });
    } catch (error) {
      // A stale list link can disappear between the listing and detail fetch.
      // Treat only an explicit gone/not-found response as closed; all other
      // failures remain fatal so a transient or source-wide outage is visible.
      if (error?.status === 404 || error?.status === 410) {
        console.warn(`⚠️ Skipping stale Freshteam detail ${candidate.detailUrl} (HTTP ${error.status}).`);
        continue;
      }
      throw error;
    }

    const row = parseKnowledgeLabPublicDetailHtml(
      detailHtml,
      candidate.detailUrl,
      candidate.title,
    );
    if (row?.closed) {
      console.log(`ℹ️ Skipping closed Freshteam detail ${candidate.detailUrl}`);
      continue;
    }
    if (!row || row.incomplete) {
      throw new Error(`Freshteam detail ${candidate.detailUrl} did not expose a complete title, location, and rich description`);
    }
    items.push(row);
  }

  console.log(`📋 Open detail pages parsed: ${items.length}`);
  return items;
}

function buildKnowledgeLabJob(row) {
  const sourceLang = detectLang(`${row.title} ${row.description}`, 'en');
  const localized = buildKnowledgeLabLocalizedContent({ ...row, sourceLang });
  const canton = inferKnowledgeLabCanton(row);
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.applyUrl || `${CAREERS_URL}`,
    applyUrl: row.applyUrl || '',
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location,
    addressLocality: row.location,
    postalCode: row.postalCode || '',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title, row.department),
    sector: inferSector(),
    source: 'knowledge-lab-dedicated-crawler',
    sourceLang,
    postedDate: row.postedDate,
    employmentType: row.employmentType || 'full-time',
    contractType: row.employmentType || 'full-time',
    validThrough: '',
    description: localized.description,
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
  const fabricatedFossils = targetExisting.filter((job) => dropKnowledgeLabFabricatedText(job)).length;
  if (fabricatedFossils > 0) console.log(`  🧹 Removed the former crawler-written description from ${fabricatedFossils} stored Knowledge Lab job(s); they will be retranslated`);
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
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL, KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL],
    notes: 'Dedicated Knowledge Lab crawler discovers the public Freshteam careers portal and fetches each detail page for the complete JobPosting description and location. Closed/stale detail links are skipped; an open page without complete structured content fails closed. Each vacancy is retained only when its detail-page location passes isTargetSwissLocation across all 26 cantons; the canton is inferred from that same city and foreign branches (including Madrid and Belgrade) are rejected. Zurich and Mendrisio are current Swiss sites, not the geographic scope.',
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
    detectSourceLang: (text, job) => job?.sourceLang || detectLang(text, 'en'),
  });
}

// The zero-job exits keep the stored slice: remove from it the text the
// crawler once wrote, as the merge does (stored-jobs-soft-exit.mjs).
function cleanStoredJobsOnSoftExit() {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => { for (const job of jobs) dropKnowledgeLabFabricatedText(job); },
    storedJobs: readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob),
    companyKey: COMPANY_KEY,
    companyLabel: COMPANY_NAME,
    write: (jobs) => writeJobsCrawlerSlice(COMPANY_KEY, jobs),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Knowledge Lab');
  console.log('═══════════════════════════════════════════════');
  console.log('  Knowledge Lab — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page:   ${CAREERS_URL}`);
  console.log(`  Freshteam jobs: ${KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No listings found on the public Freshteam portal — skipping.');
    await cleanStoredJobsOnSoftExit();
    return;
  }

  // Filter to Swiss jobs (CH-wide): the branch city itself must resolve to one
  // of the 26 Swiss cantons. Drops non-CH / unresolved (foreign) jobs and
  // never lets a state field or fixed city default relabel the vacancy.
  const swissJobs = listings.filter(isKnowledgeLabSwissRelevant);
  console.log(`🇨🇭 Swiss-canton jobs: ${swissJobs.length} / ${listings.length}`);

  if (swissJobs.length === 0) {
    console.log('⚠️ No Swiss-canton jobs found — skipping merge.');
    await cleanStoredJobsOnSoftExit();
    return;
  }

  // Deduplicate by apply URL
  const seenUrls = new Map();
  const deduplicated = [];
  for (const listing of swissJobs) {
    const key = normalize(listing.applyUrl || listing.jobId);
    if (!seenUrls.has(key)) {
      seenUrls.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < swissJobs.length) {
    console.log(`🔄 Deduplicated: ${swissJobs.length} → ${deduplicated.length} unique jobs`);
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

main().catch((error) => exitCrawlerOnError(error, 'Knowledge Lab'));
