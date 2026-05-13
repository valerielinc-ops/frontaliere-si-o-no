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
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
} from './lib/dedicated-crawler-common.mjs';
import {
  parseBpsSuisseListingPage,
  parseBpsSuisseDetailPage, inferEmploymentType,
} from './lib/bps-suisse-job-parser.mjs';
import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
} from './lib/pdf-job-content.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const BPS_KEY = 'bps-suisse';
const HQ = getCompanyDefaults(BPS_KEY);
const BPS_COMPANY_NAME = 'BPS (Banca Popolare di Sondrio) SUISSE';
const BPS_HOST = 'www.bps-suisse.ch';
const BPS_LISTING_URL = 'https://www.bps-suisse.ch/lavora-in-bps-suisse.php';
const LOCALES = ['it', 'en', 'de', 'fr'];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

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
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/* ── Fetch ─────────────────────────────────────────────────── */
async function fetchHtml(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

/* ── Discovery & Detail Fetching ──────────────────────────── */
async function fetchJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  console.log(`🔍 Fetching BPS Suisse listing page: ${BPS_LISTING_URL}`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(BPS_LISTING_URL, timeoutMs);
  } catch (err) {
    console.error(`❌ Failed to fetch listing page: ${err?.message || err}`);
    return [];
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

    // Start with best available title: parser listing > URL-derived > fallback
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
      listing.title = 'Posizione aperta BPS Suisse';
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

    // Build description: prefer PDF content; fall back to HTML body
    const fallbackDesc = `${listing.title} — posizione aperta presso BPS (Banca Popolare di Sondrio) SUISSE, istituto bancario con sede a Lugano, Canton Ticino, Svizzera. BPS Suisse offre servizi bancari per clientela privata e commerciale con una forte presenza sul territorio ticinese. L'azienda offre un ambiente di lavoro professionale e stimolante nel settore finanziario.`;
    description = buildPdfBackedDescription({
      introLines: [`## ${listing.title}`, `BPS (Banca Popolare di Sondrio) SUISSE — posizione aperta a ${location} (TI).`],
      pdfText: pdfText || '',
      fallbackText: description || fallbackDesc,
      footerLines: [
        `**Settore:** Bancario / Finanziario`,
        `**Sede:** Via Giacomo Bentina 5, 6901 Lugano, TI, Svizzera`,
        pdfUrl ? `[Bando ufficiale (PDF)](${pdfUrl})` : '',
      ].filter(Boolean),
    });

    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const slug = slugify(`${listing.title}-bps-suisse-${location}`);

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
      descriptionByLocale: {},
      requirementsByLocale: { it: [] },
      category: 'finance',
      contract: 'full-time',
      currency: 'CHF',
      postedDate: new Date().toISOString().slice(0, 10),
      source: 'bps-suisse-careers-crawler',
      crawledAt: new Date().toISOString(),
      _targetScope: { canton: HQ.canton, location },
    });
    console.log(`  ✅ ${listing.title} — ${location}`);
  }

  console.log(`📋 Total BPS Suisse jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(BPS_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isBpsJob(job));
  const targetExisting = existing.filter(isBpsJob);
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
      postedDate: job.postedDate || prev.postedDate,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      salaryMin: prev.salaryMin || job.salaryMin,
      salaryMax: prev.salaryMax || job.salaryMax,
      currency: prev.currency || job.currency,
      sourceLang: prev.sourceLang || job.sourceLang,
      needsRetranslation: prev.needsRetranslation ?? job.needsRetranslation,
    };
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
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(BPS_KEY, 'BPS Suisse');
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${BPS_COMPANY_NAME} — Dedicated Crawler`);
  console.log('═══════════════════════════════════════════════');

  const discoveredJobs = await fetchJobs();
  if (discoveredJobs.length === 0) {
    console.log('ℹ️ No BPS Suisse job URLs discovered. Exiting OK.');
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
    newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount,
    durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ BPS Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
