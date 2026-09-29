#!/usr/bin/env node
/**
 * Dedicated KSGR crawler runner.
 * Source discovery is API-first via Prospective.ch, then detail extraction
 * is delegated to the shared crawler using the SSR job detail pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';

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
import { extractStableJobId } from './lib/job-match-key.mjs';
import { exitCrawlerOnError, fetchHtml, fetchJson } from './lib/crawler-template.mjs';
import { mapPool } from './lib/prospector/polite-fetch.mjs';
import {
  composeKsgrDescription,
  parseKsgrDetailExtras,
  parseKsgrJobsPage,
} from './lib/ksgr-job-parser.mjs';
import { preferEnrichedDescription } from './lib/enriched-description-fallback.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const KSGR_KEY = 'kantonsspital-graubuenden-ksgr';
const HQ = getCompanyDefaults(KSGR_KEY);
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000745';
const API_LANG = 'de';
const PAGE_SIZE = 100;
const DETAIL_CONCURRENCY = 3;
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

/**
 * Benefit cards and contact block exist only on the jobs.ksgr.ch detail page,
 * not in the Prospective API. A page that cannot be read leaves that job on
 * its API text (see `preferEnrichedDescription` for how a previously
 * enriched text survives a transient failure) — the crawl never fails on it.
 */
async function fetchKsgrDetailExtras(apiJobs) {
  const extrasByUrl = new Map();
  let failed = 0;
  await mapPool(apiJobs, DETAIL_CONCURRENCY, async (job) => {
    try {
      const extras = parseKsgrDetailExtras(await fetchHtml(job.detailUrl));
      if (extras.benefits.length || extras.contact) extrasByUrl.set(job.detailUrl, extras);
    } catch {
      failed += 1;
    }
    await sleep(150);
  });
  console.log(`🧾 KSGR detail pages enriched: ${extrasByUrl.size}/${apiJobs.length}${failed ? ` (${failed} unreadable, API text kept)` : ''}.`);
  return extrasByUrl;
}

function slugify(value = '') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 140);
}

function buildJobFromApiData(apiJob, existingByUrl, extras = null) {
  // Match on the stable id extracted from the detail URL (the UUID trailing
  // segment, e.g. .../offene-stellen/<title-slug>/<uuid>) rather than the
  // raw lowercased URL, so a Prospective title/slug rewrite doesn't orphan
  // the previousSlugs/previousSlugsByLocale/translations preserved below
  // (issue #3699). Same approach as the other Prospective/SmartRecruiters
  // API-based dedicated crawlers (mikron, swiss-medical-network).
  const existing = existingByUrl.get(extractStableJobId(apiJob.detailUrl));
  const title = apiJob.title;
  const previousSourceDescription = existing?.descriptionByLocale?.de || '';
  // Benefit cards and contact are the hospital's, not the vacancy's: without
  // the feed's role text they are never published as a body. Such a job keeps
  // the text the source gave on an earlier run, or is not published (main).
  const hasRoleText = Boolean(String(apiJob.description || '').trim());
  let description = previousSourceDescription;
  if (hasRoleText) {
    description = extras
      ? composeKsgrDescription(apiJob.description, extras)
      : preferEnrichedDescription(previousSourceDescription, apiJob.description);
  }
  // The German source slot follows the crawl: it used to be frozen at the
  // first crawl (`existing.descriptionByLocale || …`), so a parser fix never
  // reached published jobs. Translations of an older source are kept until the
  // translation pipeline redoes them — flagged below when the source moved.
  const sourceChanged = Boolean(previousSourceDescription)
    && normalize(previousSourceDescription).replace(/\s+/g, ' ') !== normalize(description).replace(/\s+/g, ' ');
  // Guard the slug location token so a literal "undefined"/"null" from the API
  // (both truthy → slip past `|| 'graubuenden'`) can never leak `-undefined`
  // into an active slug (sitemap-canonical gate). Slug-only; addressLocality is
  // backfilled by the choke-point normalizer. Issue #952 (class #900/#901).
  const slug = slugify(`${title} ${COMPANY_NAME} ${safeLocationToken(apiJob.location, 'graubuenden')}`);

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
    descriptionByLocale: { ...(existing?.descriptionByLocale || {}), de: description },
    baseSalary: existing?.baseSalary || { currency: 'CHF', value: { minValue: 41080, unitText: 'YEAR' } },
    featured: false,
    previousSlugs: existing?.previousSlugs || [],
    previousSlugsByLocale: existing?.previousSlugsByLocale || {},
    needsRetranslation: !(existing?.titleByLocale?.it) || sourceChanged,
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

  // Build stable-id→job map for slug/translation preservation (issue #3699:
  // keying by raw lowercased URL missed a match whenever Prospective
  // rewrote the title-derived slug portion of detailUrl, silently
  // orphaning previousSlugs/previousSlugsByLocale/translations).
  const existingByUrl = new Map();
  for (const job of beforeTargetJobs) {
    const key = extractStableJobId(job?.url);
    if (key) existingByUrl.set(key, job);
  }

  // Discover all jobs from Prospective API; detail pages only add the
  // benefit cards and contact block the API does not carry.
  const discoveredJobs = await fetchAllKsgrJobs();
  if (discoveredJobs.length === 0) {
    throw new Error('KSGR discovery returned 0 jobs.');
  }
  console.log(`🔎 KSGR discovered ${discoveredJobs.length} jobs from Prospective API.`);

  const extrasByUrl = await fetchKsgrDetailExtras(discoveredJobs);

  // Build job objects from API data + detail-page-only sections
  const builtJobs = discoveredJobs.map((apiJob) => buildJobFromApiData(
    apiJob,
    existingByUrl,
    extrasByUrl.get(apiJob.detailUrl) || null,
  ));
  const jobs = builtJobs.filter((job) => String(job.description || '').trim());
  if (jobs.length < builtJobs.length) {
    console.log(`⏭️ KSGR: ${builtJobs.length - jobs.length} job(s) without role text in the feed and none stored — not published.`);
  }
  console.log(`📋 Built ${jobs.length} KSGR job objects from API data.`);

  // Write slice directly (the shared crawler is not needed: the API carries
  // every per-vacancy field and fetchKsgrDetailExtras adds the rest).
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

main().catch((error) => exitCrawlerOnError(error, 'KSGR'));
