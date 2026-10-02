#!/usr/bin/env node
/**
 * Dedicated Clinique Le Noirmont (Le Noirmont, JU) crawler runner.
 *
 * Centre national de référence en réadaptation cardiovasculaire, médecine
 * interne, oncologie et psychosomatique. Postings are PDF-only and live on
 * the WebMaker CMS at two URL shapes (see parser docs).
 *
 *   Career page: https://www.cliniquelenoirmont.ch/La-clinique/Offres-demploi
 */
import fs from 'node:fs';
import os from 'node:os';
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';
import {
  parseCliniqueLeNoirmontListing,
  resolveCliniqueLeNoirmontTitle,
  buildCliniqueLeNoirmontDescription,
  CLINIQUE_LE_NOIRMONT_KEY,
  CLINIQUE_LE_NOIRMONT_COMPANY_NAME,
  CLINIQUE_LE_NOIRMONT_COMPANY_DOMAIN,
  CLINIQUE_LE_NOIRMONT_CAREERS_URL,
  CLINIQUE_LE_NOIRMONT_FABRICATED_DESCRIPTION_RE,
} from './lib/clinique-le-noirmont-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';
import { storedJobForFailedSource } from './lib/stored-source-body.mjs';
import { SOURCE_BODY_FAILURE_REASON } from './lib/source-body-failure.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { fetchHtml, exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path (never shared with sibling crawlers in the
// same crawler-group CI job -- no cross-process race possible by construction).
const SCRATCH_KEY = path.basename(fileURLToPath(import.meta.url), '.mjs');
const DATA_JOBS = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${SCRATCH_KEY}.json`);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTER_PATH = path.resolve(
  ROOT,
  'data',
  'jobs-crawler-adapters',
  'adapters',
  `${CLINIQUE_LE_NOIRMONT_KEY}.json`
);

const COMPANY_KEY = CLINIQUE_LE_NOIRMONT_KEY;
const COMPANY_NAME = CLINIQUE_LE_NOIRMONT_COMPANY_NAME;
const COMPANY_HOST = `www.${CLINIQUE_LE_NOIRMONT_COMPANY_DOMAIN}`;
const COMPANY_DOMAIN = CLINIQUE_LE_NOIRMONT_COMPANY_DOMAIN;
const CAREERS_URL = CLINIQUE_LE_NOIRMONT_CAREERS_URL;
const LOCALES = ['it', 'en', 'de', 'fr'];

// Hardcoded HQ (Le Noirmont JU). crawler-location-config.mjs is read-only here.
const HQ = {
  city: 'Le Noirmont',
  canton: 'JU',
  postalCode: '2340',
  addressRegion: 'JU',
};

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
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugify(text = '') {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlugAtWordBoundary(slug, 200);
}

async function fetchPage(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key.startsWith('clinique-le-noirmont') ||
    (company.includes('noirmont') && company.includes('clinique')) ||
    url.includes('cliniquelenoirmont.ch') ||
    url.includes('clinique-le-noirmont.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === COMPANY_DOMAIN ||
      host === `www.${COMPANY_DOMAIN}` ||
      host === 'clinique-le-noirmont.ch' ||
      host === 'www.clinique-le-noirmont.ch'
    );
  } catch {
    return false;
  }
}

function jobMatchKey(job = {}) {
  return (
    extractStableJobId(job.url) ||
    `slug:${String(job.slug || job.titleByLocale?.fr || job.title || '').toLowerCase()}`
  );
}

function buildJob({ title, pdfUrl, pdfText, identifier }) {
  const slug = slugify(`${title}-${COMPANY_KEY}`);
  const description = buildCliniqueLeNoirmontDescription({ title, pdfText }).description;
  // The PDF text is keyed by its own language.
  const sourceLang = detectLang(`${title} ${pdfText}`, 'fr');
  return {
    title,
    slug,
    url: pdfUrl,
    applyUrl: CAREERS_URL,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: HQ.city,
    addressLocality: HQ.city,
    addressRegion: HQ.addressRegion,
    postalCode: HQ.postalCode,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: 'health',
    sector: 'Réadaptation cardiovasculaire et médecine interne',
    employmentType: 'full-time',
    contractType: 'full-time',
    source: `${COMPANY_KEY}-dedicated-crawler`,
    sourceLang,
    postedDate: new Date().toISOString().slice(0, 10),
    validThrough: '',
    needsRetranslation: true,
    description,
    titleByLocale: { [sourceLang]: title },
    descriptionByLocale: { [sourceLang]: description },
    slugByLocale: { [sourceLang]: slug },
    _meta: { sourceIdentifier: identifier },
  };
}

function urlKey(job = {}) {
  return String(job?.url || '').trim().replace(/\/+$/, '');
}

/** Stored postings of this crawler, without text the crawler once invented. */
function readStoredTargetJobs() {
  return dropFabricatedDescriptions(
    readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob),
    CLINIQUE_LE_NOIRMONT_FABRICATED_DESCRIPTION_RE,
    COMPANY_NAME,
  );
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const existingTarget = readStoredTargetJobs();
  const existingByKey = new Map(existingTarget.map((job) => [jobMatchKey(job), job]));

  const mergedTarget = mergePreserveLocaleData(existingTarget, discoveredJobs);
  for (const job of mergedTarget) {
    job.needsRetranslation = true;
  }

  const beforeSnapshot = snapshotJobSlugs(existingTarget);
  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const newJobs = mergedTarget.filter((job) => !existingByKey.has(jobMatchKey(job)));
  if (newJobs.length > 0) {
    console.log(`🔗 Validating URLs for ${newJobs.length} newly inserted jobs…`);
    const results = await validateJobUrls(newJobs, { concurrency: 4 });
    const invalid = results.filter((r) => !r.valid);
    if (invalid.length > 0) {
      console.warn(`⚠️  ${invalid.length} URL(s) failed validation:`);
      for (const inv of invalid) console.warn(`     - ${inv.url}: ${inv.reason}`);
      throw new Error(`Clinique Le Noirmont inserted ${invalid.length} invalid job URLs.`);
    }
    console.log(`✅ All ${newJobs.length} new job URLs validated successfully`);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Clinique Le Noirmont');
  writeCrawlChangeSummaryToGH(diff, 'Clinique Le Noirmont');
  writeJobsSummary(mergedTarget, 'Clinique Le Noirmont');
  printPublishedJobUrls(mergedTarget, 'Clinique Le Noirmont');
  const removed = Math.max(0, existingTarget.length - mergedTarget.length);
  console.log(
    `📦 Merge results:\n  ➕ Added: ${newJobs.length}\n  🔄 Updated: ${mergedTarget.length - newJobs.length}\n  🗑️  Removed (stale): ${removed}\n  📊 Total jobs in file: ${allJobs.length}`
  );
  return { diff };
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
    priority: 10,
    crawlerModes: ['html', 'pdf'],
    seedUrls: jobs.map((job) => job.url),
    notes:
      'Dedicated Clinique Le Noirmont crawler parses the Offres-demploi page and extracts descriptions from /File and /FileDownload PDF endpoints.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CLINIQUE_LE_NOIRMONT_STRICT',
    label: 'Clinique Le Noirmont',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_cliniquelenoirmont_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Clinique Le Noirmont jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'fr'),
  });
}

export async function main() {
  setCrawlerStartTime();
  const summaryCounts = { sourceBodyFailures: [] };
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Clinique Le Noirmont', summaryCounts);
  console.log('═══════════════════════════════════════════════');
  console.log('  Clinique Le Noirmont — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const html = await fetchPage(CAREERS_URL);
  const listings = parseCliniqueLeNoirmontListing(html);
  console.log(`📋 PDF offres found: ${listings.length}`);
  if (listings.length === 0) {
    throw new Error('Clinique Le Noirmont discovery returned 0 PDF jobs.');
  }

  // A posting whose PDF cannot be read this run (timeout, 5xx, no text layer)
  // is a degraded source, as in the other PDF crawlers: it republishes its
  // stored record, is left out only when no stored body exists, and is listed
  // in sourceBodyFailures either way. It used to abort the whole crawler. The
  // stored slice is read only when a read fails.
  const discoveredJobs = [];
  const sourceBodyFailures = [];
  let storedTargetJobs = null;
  let keptStoredCount = 0;
  let leftOutCount = 0;
  for (const listing of listings) {
    const title = resolveCliniqueLeNoirmontTitle(listing);
    console.log(`  📄 Extracting PDF for "${title}"`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl);
    if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    const pdfText = pdf.text || '';
    if (!pdfText) {
      // A failed read and a PDF without a text layer leave the same gap: both
      // are listed as a degraded source, as ECAM does.
      if (!pdf.error && !pdf.extractionFailed) {
        console.warn(`     ⚠️ ${pdf.warning || 'Empty PDF text'} — ${listing.identifier}`);
      }
      sourceBodyFailures.push({
        title,
        url: listing.pdfUrl,
        reason: SOURCE_BODY_FAILURE_REASON,
        message: pdf.error || pdf.warning || 'official PDF has no usable text layer',
      });
      storedTargetJobs ??= readStoredTargetJobs();
      const kept = storedJobForFailedSource(urlKey({ url: listing.pdfUrl }), storedTargetJobs, urlKey);
      if (kept) {
        keptStoredCount += 1;
        discoveredJobs.push(kept);
      } else {
        leftOutCount += 1;
      }
      continue;
    }
    discoveredJobs.push(
      buildJob({
        title,
        pdfUrl: listing.pdfUrl,
        pdfText,
        identifier: listing.identifier,
      })
    );
  }

  summaryCounts.sourceBodyFailures = sourceBodyFailures;
  if (keptStoredCount > 0) {
    console.warn(`  ⚠️ Clinique Le Noirmont: ${keptStoredCount} posting(s) with an unusable PDF keep their stored record.`);
  }
  if (leftOutCount > 0) {
    console.warn(`  ⚠️ Clinique Le Noirmont: ${leftOutCount} posting(s) left out of this run: unusable PDF and no stored source body.`);
  }
  if (discoveredJobs.length === 0) {
    throw new Error(
      `Clinique Le Noirmont has no publishable posting: ${listings.length} listed, `
      + `${leftOutCount} with an unusable PDF and no stored source body.`,
    );
  }

  updateAdapterConfig(discoveredJobs);
  const { diff } = await mergeJobs(discoveredJobs);

  console.log('\n🌐 Running locale fill for Clinique Le Noirmont jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log('\n✅ Clinique Le Noirmont crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Clinique Le Noirmont',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    sourceBodyFailureCount: sourceBodyFailures.length,
    sourceBodyFailures: sourceBodyFailures.slice(0, 100),
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

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Clinique Le Noirmont'));
}
