#!/usr/bin/env node
/**
 * Dedicated BPS (Banca Popolare di Sondrio) Suisse crawler runner.
 *
 * BPS Suisse is a banking institution headquartered in Lugano, TI.
 * Their careers page lists positions as simple HTML links.
 *
 * This script:
 *   1. Fetches the listing page at bps-suisse.ch/lavora-in-bps-suisse.php
 *   2. Extracts job detail URLs (carriera-*.php pattern) with titles
 *   3. Fetches each detail page for description content
 *   4. Merges discovered jobs into data/jobs.json
 *   5. Updates adapter seed URLs
 *   6. Runs base crawler for AI localization (localize-existing-only)
 *   7. Validates locale coverage
 */
import { sourcePostingDateFields, mergeSourcePostingDates } from './lib/source-posting-date.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
mergeLocaleTextMap,
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseBpsSuisseListingPage,
  parseBpsSuisseDetailPage, inferEmploymentType,
  buildBpsSuisseDescriptionFields,
  dropBpsSuisseFabricatedText,
} from './lib/bps-suisse-job-parser.mjs';
import { extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';
import { fetchHtml as fetchHtmlShared, exitCrawlerOnError } from './lib/crawler-template.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BPS_KEY = 'bps-suisse';
const HQ = getCompanyDefaults(BPS_KEY);
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(BPS_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const BPS_COMPANY_NAME = 'BPS (Banca Popolare di Sondrio) SUISSE';
const BPS_HOST = 'www.bps-suisse.ch';
const BPS_LISTING_URL = 'https://www.bps-suisse.ch/lavora-in-bps-suisse.php';
const LOCALES = ['it', 'en', 'de', 'fr'];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const SUMMARY_COUNTS = {
  discovered: null,
  parsed: null,
  lastFetchOutcome: null,
};

/* ── Matchers ──────────────────────────────────────────────── */
function isBpsJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === BPS_KEY ||
    key.includes('bps-suisse') ||
    key.includes('banca-popolare-di-sondrio') ||
    company.includes('bps') ||
    company.includes('banca popolare di sondrio') ||
    host === BPS_HOST ||
    host.endsWith('bps-suisse.ch')
  );
}

function slugify(value = '') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 180);
}

/* ── Fetch ─────────────────────────────────────────────────── */
async function fetchHtml(url, timeoutMs = 15000) {
  return fetchHtmlShared(url, { timeoutMs, headers: { Accept: 'text/html', 'User-Agent': UA } });
}

/* ── Discovery & Detail Fetching ──────────────────────────── */
export async function fetchJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  console.log(`🔍 Fetching BPS Suisse listing page: ${BPS_LISTING_URL}`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(BPS_LISTING_URL, timeoutMs);
  } catch (err) {
    console.error(`❌ Failed to fetch listing page: ${err?.message || err}`);
    throw err;
  }

  // Use robust regex to find all carriera-*.php links (matches the original working pattern)
  const urlPattern = /href="(carriera-[^"]+\.php)"/gi;
  const discoveredUrls = new Set();
  let match;
  while ((match = urlPattern.exec(listingHtml)) !== null) {
    discoveredUrls.add(`https://${BPS_HOST}/${match[1]}`);
  }
  // Also try the parser as fallback
  const parserListings = parseBpsSuisseListingPage(listingHtml);
  for (const pl of parserListings) {
    if (pl.url) discoveredUrls.add(pl.url);
  }
  const listings = [...discoveredUrls].map((url) => {
    // Try to extract a title from parser results
    const parserMatch = parserListings.find((p) => p.url === url);
    return { url, title: parserMatch?.title || '' };
  });
  SUMMARY_COUNTS.discovered = listings.length;
  SUMMARY_COUNTS.lastFetchOutcome = 'ok';
  console.log(`📋 Found ${listings.length} job link(s) on listing page.`);

  const jobs = [];
  for (const listing of listings) {
    let description = '';
    let location = 'Lugano';

    // Derive title from URL slug first (always available, always unique)
    const urlSlug = listing.url.match(/carriera-(.+)\.php/)?.[1] || '';
    const urlDerivedTitle = urlSlug
      .replace(/__\d+_?$/g, '')    // remove trailing __100_ percentage markers
      .replace(/\d+$/g, '')        // remove trailing numbers
      .replace(/_+/g, ' ')         // underscores to spaces
      .replace(/-+/g, ' ')         // hyphens to spaces
      .replace(/\s+/g, ' ')        // collapse whitespace
      .trim()
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    // Start with best available title: parser listing > URL-derived
    if (!listing.title && urlDerivedTitle) {
      listing.title = urlDerivedTitle;
    }

    // Try to fetch the detail page for a richer description
    let pdfUrl = '';
    try {
      const detailHtml = await fetchHtml(listing.url, timeoutMs);
      const detail = parseBpsSuisseDetailPage(detailHtml);
      if (detail) {
        if (detail.body) description = detail.body;
        if (detail.location) location = detail.location;
        if (detail.pdfUrl) pdfUrl = detail.pdfUrl;
        // Only use detail title if it's specific enough (> 15 chars, not generic)
        if (detail.title && detail.title.length > 15 && !/^posizione/i.test(detail.title)) {
          listing.title = detail.title;
        }
      }
    } catch (err) {
      console.warn(`  ⚠️ Could not fetch detail page ${listing.url}: ${err.message}`);
    }

    if (!listing.title) {
      // Neither the listing nor the carriera-*.php slug names the role: there
      // is no posting title to publish (the runner used to invent one).
      console.warn(`  ⚠️ Skipping BPS Suisse link without a title: ${listing.url}`);
      continue;
    }

    // Fetch and parse PDF content when available — BPS Suisse posts full job descriptions as PDFs
    let pdfText = '';
    if (pdfUrl) {
      console.log(`  📄 Extracting PDF: ${pdfUrl}`);
      const pdfContent = await extractPdfJobContentFromUrl(pdfUrl);
      if (pdfContent.error) {
        console.warn(`  ⚠️ PDF extraction failed for "${listing.title}": ${pdfContent.error}`);
      } else if (pdfContent.text) {
        pdfText = pdfContent.text;
        console.log(`  ✅ PDF extracted (${pdfContent.text.length} chars, ${pdfContent.totalPages} pages)`);
      }
    }

    // Description: the PDF call when present, else the detail-page body.
    const descriptionFields = buildBpsSuisseDescriptionFields({ pdfText, bodyText: description });
    description = descriptionFields.description;

    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    // Slug-only guard: `location` is reassigned from `detail.location`, which can
    // be the literal "undefined"/"null" string (truthy) → `-undefined` in an active
    // slug (#952, class #900/#901). addressLocality untouched (choke-point normalizer).
    const slug = slugify(`${listing.title}-bps-suisse-${safeLocationToken(location, 'Lugano')}`);

    jobs.push({
      id: `bps-suisse-${urlHash}`,
      title: listing.title,
      company: BPS_COMPANY_NAME,
      companyKey: BPS_KEY,
      companyDomain: 'bps-suisse.ch',
      url: listing.url,
      applyUrl: listing.url,
      location,
      canton: HQ.canton,
      country: 'CH',
      addressLocality: location,
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      postalCode: HQ.postalCode,
      streetAddress: 'Via Giacomo Bentina 5',
      employmentType: inferEmploymentType(listing.title, description),
      description,
      slug,
      slugByLocale: { it: slug },
      titleByLocale: { it: listing.title },
      descriptionByLocale: descriptionFields.descriptionByLocale,
      sourceLang: descriptionFields.sourceLang,
      requirementsByLocale: { it: [] },
      category: 'finance',
      contract: 'full-time',
      currency: 'CHF',
      ...sourcePostingDateFields(''),
      source: 'bps-suisse-careers-crawler',
      crawledAt: new Date().toISOString(),
      _targetScope: { canton: HQ.canton, location },
    });
    console.log(`  ✅ ${listing.title} — ${location}`);
  }

  SUMMARY_COUNTS.parsed = jobs.length;
  SUMMARY_COUNTS.lastFetchOutcome = jobs.length > 0
    ? 'ok'
    : (listings.length > 0 ? 'filtered_empty' : 'ok');
  console.log(`📋 Total BPS Suisse jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(BPS_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isBpsJob(job));
  const targetExisting = existing.filter(isBpsJob);
  const fossils = targetExisting.filter((job) => dropBpsSuisseFabricatedText(job)).length;
  if (fossils > 0) console.log(`  🧹 Dropped the former description wrapper from ${fossils} stored BPS Suisse job(s); they will be retranslated`);
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
      ...mergeSourcePostingDates(prev, job),
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30, job.sourceLang),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      salaryMin: prev.salaryMin || job.salaryMin,
      salaryMax: prev.salaryMax || job.salaryMax,
      currency: prev.currency || job.currency,
      sourceLang: prev.sourceLang || job.sourceLang,
      needsRetranslation: prev.needsRetranslation ?? job.needsRetranslation,
    };
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    return merged;
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'BPS Suisse');
  writeCrawlChangeSummaryToGH(diff, 'BPS Suisse');

  console.log(`  ➕ Added: ${added}\n  🔄 Updated: ${updated}\n  ➖ Removed: ${targetExisting.length - updated}\n  📦 Total: ${mergedTarget.length}`);
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter ───────────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${BPS_KEY}.json`);
  let adapter = {};
  try { adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')); } catch { /* first run */ }
  adapter = {
    ...adapter,
    companyKey: BPS_KEY, companyName: BPS_COMPANY_NAME, companyHost: BPS_HOST,
    enabled: true, priority: 10, crawlerModes: ['html'],
    seedUrls,
    notes: 'BPS Suisse careers portal (simple HTML). Detail pages at carriera-*.php. Lugano-based banking.',
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Main ──────────────────────────────────────────────────── */
// The zero-job exits keep the stored slice: remove from it the text the
// crawler once wrote, as the merge does (stored-jobs-soft-exit.mjs).
function cleanStoredJobsOnSoftExit() {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => { for (const job of jobs) dropBpsSuisseFabricatedText(job); },
    storedJobs: readExistingCrawlerJobs(BPS_KEY, DATA_JOBS).filter(isBpsJob),
    companyKey: BPS_KEY,
    companyLabel: BPS_COMPANY_NAME,
    write: (jobs, options) => writeJobsCrawlerSliceVerified(BPS_KEY, jobs, options),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(BPS_KEY, 'BPS Suisse', SUMMARY_COUNTS);
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${BPS_COMPANY_NAME} — Dedicated Crawler`);
  console.log('═══════════════════════════════════════════════');

  const discoveredJobs = await fetchJobs();
  if (discoveredJobs.length === 0) {
    console.log('ℹ️ No BPS Suisse job URLs discovered. Exiting OK.');
    await cleanStoredJobsOnSoftExit();
    const _durationMs = getCrawlerElapsedMs();
    const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
    const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isBpsJob) : [];
    writeSummaryCrawlerSlice({
      key: BPS_KEY,
      label: 'BPS Suisse',
      generatedAt: new Date().toISOString(),
      total: _sliceJobs.length,
      discovered: SUMMARY_COUNTS.discovered,
      parsed: SUMMARY_COUNTS.parsed,
      lastFetchOutcome: SUMMARY_COUNTS.lastFetchOutcome,
      written: _sliceJobs.length,
      newCount: 0,
      updatedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      durationMs: _durationMs,
      avgDurationMs: _durationMs,
      durationHistory: [_durationMs],
      newJobs: [],
      updatedJobs: [],
      removedJobs: [],
      unchangedJobs: [],
    });
    return;
  }

  const seedUrls = discoveredJobs.map((j) => j.url);
  const mergeResult = mergeJobs(discoveredJobs);
  const diff = mergeResult.diff;
  updateAdapterConfig(seedUrls);

  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: BPS_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });

  // Stats
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    const companyJobs = Array.isArray(jobs) ? jobs.filter(isBpsJob) : [];
    console.log(`\n🏦 Total BPS Suisse jobs: ${companyJobs.length}`);
    for (const j of companyJobs) console.log(`  • ${j.title} (${j.location})`);
  }

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BPS_SUISSE_STRICT',
    label: 'BPS Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isBpsJob,
    locales: LOCALES,
    failWhenNoJobs: false,
    noJobsMessage: 'No BPS Suisse jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });

  console.log(`✅ ${BPS_COMPANY_NAME} crawler complete.`);

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isBpsJob) : [];
  writeJobsCrawlerSlice(BPS_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: BPS_KEY,
    label: 'BPS Suisse',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    discovered: SUMMARY_COUNTS.discovered,
    parsed: SUMMARY_COUNTS.parsed,
    lastFetchOutcome: SUMMARY_COUNTS.lastFetchOutcome,
    newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount,
    durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'BPS Suisse'));
}
