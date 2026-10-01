#!/usr/bin/env node
/**
 * Artificialy — Dedicated Crawler
 *
 * Crawls https://www.artificialy.com/it/career
 * 1. Fetches career page HTML (site behind Cloudflare — may fail with 403)
 * 2. Parses job listings via JSON-LD, HTML cards, or link extraction
 * 3. Keeps jobs whose location matches a Swiss target canton
 * 4. Merges into data/jobs.json
 *
 * Artificialy: Swiss AI company, offices in Lugano (TI) and Zurich.
 * Specializes in finance, healthcare, manufacturing AI solutions.
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
  writeJobsCrawlerSliceVerified,
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
  parseArtificialyCareerPage,
  isArtificialySwissRelevant,
  inferArtificialyCanton,
  inferArtificialyCategory,
  buildArtificialyLocalizedContent,
} from './lib/artificialy-job-parser.mjs';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { dropFabricatedDescription } from './lib/drop-fabricated-description.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path (never shared with sibling crawlers in the
// same crawler-group CI job -- no cross-process race possible by construction).
const SCRATCH_KEY = path.basename(fileURLToPath(import.meta.url), '.mjs');
const DATA_JOBS = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${SCRATCH_KEY}.json`);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'artificialy.json');

const COMPANY_KEY = 'artificialy';
const COMPANY_NAME = 'Artificialy';
const COMPANY_HOST = 'artificialy.com';
const COMPANY_DOMAIN = 'artificialy.com';
const CAREER_URLS = [
  'https://www.artificialy.com/it/career',
  'https://www.artificialy.com/career',
];
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/**
 * A listing without at least the source-body floor is metadata, not an
 * indexable job page. Keep it out of the dedicated pipeline so the locale
 * validator can distinguish a listing-only source response from a parser
 * regression; a zero usable-listing result takes the existing soft-exit path.
 */
export function filterArtificialyListingsWithIndexableSourceBody(listings = []) {
  return (Array.isArray(listings) ? listings : []).filter((listing) =>
    meetsSourceBodyFloor(listing?.description || ''),
  );
}

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

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  return fetchHtml(url, {
    timeoutMs,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company === 'artificialy' ||
    url.includes('artificialy.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('artificialy.com') || host.endsWith('linkedin.com');
  } catch {
    return false;
  }
}

async function fetchCareerPage() {
  for (const url of CAREER_URLS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`  Fetching ${url} (attempt ${attempt + 1})...`);
        const html = await fetchText(url);
        const { items: parsedItems, blocked } = parseArtificialyCareerPage(html);

        if (blocked) {
          console.log(`  Cloudflare challenge detected on ${url}`);
          if (attempt < MAX_RETRIES) {
            console.log(`  Retrying in ${RETRY_DELAY_MS / 1000}s...`);
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          break;
        }

        const items = filterArtificialyListingsWithIndexableSourceBody(parsedItems);
        if (items.length > 0) {
          console.log(`  Found ${items.length} jobs from ${url}`);
          return items;
        }

        const thinCount = parsedItems.length - items.length;
        const reason = thinCount > 0
          ? `${thinCount} listing(s) had no indexable source body (under 50 words)`
          : 'no jobs extracted';
        console.log(`  ${reason} from ${url} (HTML length: ${html.length})`);
        break;
      } catch (err) {
        console.log(`  Fetch failed for ${url}: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
      }
    }
  }
  return [];
}

async function fetchAllListings() {
  console.log('Fetching Artificialy career page...');

  const items = await fetchCareerPage();
  console.log(`Total jobs found: ${items.length}`);

  // Keep only jobs with a location in one of the 26 target cantons.
  const swissJobs = items.filter(isArtificialySwissRelevant);
  console.log(`Swiss target locations: ${swissJobs.length}`);

  return swissJobs;
}

function buildArtificialyJob(row) {
  const sourceLang = detectLang(`${row.title} ${row.description}`, 'it');
  const localized = buildArtificialyLocalizedContent({ ...row, sourceLang });
  const canton = inferArtificialyCanton(row);
  const detailUrl = row.applyUrl || `${CAREER_URLS[0]}`;
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: row.applyUrl || detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || 'Switzerland',
    addressLocality: row.location || 'Switzerland',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferArtificialyCategory(row.title),
    sector: 'Intelligenza Artificiale',
    source: 'artificialy-dedicated-crawler',
    sourceLang,
    postedDate: row.datePosted || new Date().toISOString().slice(0, 10),
    validThrough: row.validThrough || '',
    employmentType: 'full-time',
    contractType: 'full-time',
    description: localized.description,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

// The sentence the builder used to write, in all four slots, for a posting without text:
// "Artificialy cerca <title> con sede a <place>. Azienda svizzera specializzata…".
// Only ever recognised, to be removed from stored records (issue 5253).
const ARTIFICIALY_FABRICATED_RE = /Artificialy cerca [^\n]* con sede a [^\n]*\. Azienda svizzera specializzata in intelligenza artificiale/;

/**
 * Remove, from a stored job, the text this runner used to write itself
 * (ARTIFICIALY_FABRICATED_RE): the slots that carry it, the flat
 * `description`, and the translations made from it, flagging the job for
 * retranslation (`dropFabricatedDescription`). The merge keeps stored locale
 * slots, so without this they would outlive the fix; the runner calls it on
 * its stored jobs right before the merge.
 *
 * @returns {boolean} true when the job changed.
 */
export function dropArtificialyFabricatedText(job) {
  return dropFabricatedDescription(job, ARTIFICIALY_FABRICATED_RE);
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const fossils = targetExisting.filter((job) => dropArtificialyFabricatedText(job)).length;
  if (fossils > 0) console.log(`  🧹 Removed the former invented description from ${fossils} stored Artificialy job(s); they will be retranslated`);
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
  printCrawlChangeSummary(diff, 'Artificialy');
  writeCrawlChangeSummaryToGH(diff, 'Artificialy');
  writeJobsSummary(mergedTarget, 'Artificialy');
  printPublishedJobUrls(mergedTarget, 'Artificialy');
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
    seedUrls: CAREER_URLS,
    notes: 'Dedicated Artificialy crawler keeps Swiss-located openings across the target cantons. Swiss AI company with offices in Lugano (TI) and Zurich. Specializes in AI solutions for finance, healthcare, manufacturing. Site behind Cloudflare managed challenge — may intermittently block automated requests.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ARTIFICIALY_STRICT',
    label: 'Artificialy',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_artificialy_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Artificialy Swiss-located jobs found after dedicated crawl (site may be Cloudflare-blocked).',
    detectSourceLang: (text, job) => job?.sourceLang || detectLang(text, 'it'),
  });
}

// The zero-job exits keep the stored slice: remove from it the text the
// crawler once wrote, as the merge does (stored-jobs-soft-exit.mjs).
function cleanStoredJobsOnSoftExit() {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => { for (const job of jobs) dropArtificialyFabricatedText(job); },
    storedJobs: readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob),
    companyKey: COMPANY_KEY,
    companyLabel: COMPANY_NAME,
    write: (jobs, options) => writeJobsCrawlerSliceVerified(COMPANY_KEY, jobs, options),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Artificialy');
  console.log('===============================================');
  console.log('  Artificialy — Dedicated Crawler');
  console.log('===============================================');
  console.log(`  URLs: ${CAREER_URLS.join(', ')}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('No Artificialy Swiss-located jobs found — skipping merge.');
    console.log('(Site may be blocked by Cloudflare managed challenge)');
    printCrawlChangeSummary({ newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 }, 'Artificialy');
    await cleanStoredJobsOnSoftExit();
    return;
  }

  const jobs = listings.map(buildArtificialyJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\nRunning locale fill for Artificialy jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n=== Artificialy Job Stats ===');
  console.log(`  Total Artificialy Swiss jobs: ${total}`);
  console.log(`  Added: ${added}`);
  console.log(`  Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Artificialy',
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

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => exitCrawlerOnError(error, 'Artificialy'));
}
