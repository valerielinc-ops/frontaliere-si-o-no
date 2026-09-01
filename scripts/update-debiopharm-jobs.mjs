#!/usr/bin/env node
/**
 * Dedicated Debiopharm crawler runner.
 *
 * Discovery: scrape the SSR career page at https://www.debiopharm.com/careers/
 * (HTML lists every job link → apply.workable.com/debiopharm/j/{shortcode}).
 *
 * Enrichment: fetch Workable v2 detail JSON for each shortcode
 *   GET https://apply.workable.com/api/v2/accounts/debiopharm/jobs/{shortcode}
 *
 * Flow:
 *   1. Fetch SSR careers page + extract job shortcodes
 *   2. For each shortcode, fetch v2 detail and keep Switzerland-located jobs
 *   3. Build complete ParsedJob records with needsRetranslation: true
 *   4. Merge into jobs.json keyed by Workable shortcode (stable id)
 *   5. Run scoped localization for the Debiopharm company key
 *   6. Validate locale coverage in strict mode
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePreviousSlugsCapped } from './lib/slug-history-journal.mjs';
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
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
  LEGACY_PREV_SLUGS_CAP,
} from './lib/dedicated-crawler-common.mjs';
import {
  DEBIOPHARM_WORKABLE_ACCOUNT_SLUG,
  DEBIOPHARM_CAREERS_URL,
  DEBIOPHARM_WORKABLE_DETAIL_API_BASE,
  parseDebiopharmCareersHtml,
  parseDebiopharmJobDetailPayload,
  buildDebiopharmDetailUrl,
  buildDebiopharmApplyUrl,
  isDebiopharmSwissJob,
} from './lib/debiopharm-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path (never shared with sibling crawlers in the
// same crawler-group CI job -- no cross-process race possible by construction).
const SCRATCH_KEY = path.basename(fileURLToPath(import.meta.url), '.mjs');
const DATA_JOBS = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${SCRATCH_KEY}.json`);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'debiopharm.json');

const COMPANY_KEY = 'debiopharm';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'VD';
const COMPANY_NAME = 'Debiopharm';
const COMPANY_HOST = 'apply.workable.com';
const COMPANY_DOMAIN = 'debiopharm.com';
const LOCALES = ['it', 'en', 'de', 'fr'];

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

function slugify(value = '') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 180);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function toIsoDate(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function inferCategory({ title = '', department = [] } = {}) {
  const haystack = normalize(`${title} ${(department || []).join(' ')}`);
  if (/(clinical|medical|pharmacovigilance|drug safety|regulatory)/i.test(haystack)) return 'healthcare';
  if (/(research|scientist|chemist|biolog|preclinical)/i.test(haystack)) return 'healthcare';
  if (/(finance|accounting|controller|payroll|treasury|audit)/i.test(haystack)) return 'finance';
  if (/(hr|human resources|talent|recruit|people)/i.test(haystack)) return 'admin';
  if (/(legal|counsel|compliance|patent)/i.test(haystack)) return 'admin';
  if (/(it |system|developer|engineer|csv|software|data scien)/i.test(haystack)) return 'engineering';
  if (/(communication|marketing|sales|business development)/i.test(haystack)) return 'sales';
  return 'other';
}

function isTargetJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === COMPANY_KEY ||
    key === 'debiopharm' ||
    company.startsWith('debiopharm') ||
    (host === 'apply.workable.com' && /\/debiopharm\//.test(url)) ||
    host.endsWith('.debiopharm.com') ||
    host === 'debiopharm.com'
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'apply.workable.com' ||
      host.endsWith('.workable.com') ||
      host === 'debiopharm.com' ||
      host.endsWith('.debiopharm.com')
    );
  } catch {
    return false;
  }
}

async function fetchText(url, timeoutMs = 20000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
}

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDebiopharmListings() {
  console.log('🔍 Fetching Debiopharm jobs from SSR careers page...');
  console.log(`  📡 ${DEBIOPHARM_CAREERS_URL}`);
  const html = await fetchText(DEBIOPHARM_CAREERS_URL, Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000);
  const listings = parseDebiopharmCareersHtml(html);
  console.log(`  📦 Total listing entries: ${listings.length}`);
  for (const job of listings) {
    console.log(`     - ${job.title} (${job.locationLabel || 'unknown'}) [${job.shortcode}]`);
  }
  return listings;
}

async function fetchDebiopharmDetail(shortcode) {
  return fetchJson(`${DEBIOPHARM_WORKABLE_DETAIL_API_BASE}/${encodeURIComponent(shortcode)}`, Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000);
}

export function buildDebiopharmJob(listing, detail) {
  const parsed = parseDebiopharmJobDetailPayload(detail);
  const title = parsed.title || String(listing?.title || '').trim();
  const city = parsed.city || 'Lausanne';
  // Slug-only guard: both `city` and `parsed.inferredCanton` can be the literal
  // "undefined"/"null" string (truthy) → `-undefined` in an active slug (#952, class
  // #900/#901). location/addressLocality keep raw `city` (choke-point normalizer
  // owns de-index); guard only the slug tokens here.
  const slug = slugify(`${title} ${COMPANY_NAME} ${safeLocationToken(city, 'Lausanne')} ${safeLocationToken(parsed.inferredCanton, 'Vaud')} Switzerland`);
  const detailUrl = buildDebiopharmDetailUrl(listing.shortcode);
  const applyUrl = buildDebiopharmApplyUrl(listing.shortcode);
  const publishedDate = toIsoDate(parsed.publishedDate);
  // Trust parsed.inferredCanton as-is: it was already derived from the RAW
  // (pre-HQ-default) city/region inside parseDebiopharmJobDetailPayload().
  // Re-deriving from `city` here is wrong — `city` is `parsed.city`, which is
  // ITSELF already HQ-defaulted to 'Lausanne' when the raw city was empty, so
  // inferAnyCanton(city) would trivially resolve to 'VD' and short-circuit
  // before ever consulting the real null-skip signal (e.g. empty city + a
  // genuinely unresolvable region would wrongly publish as Lausanne/VD).
  const canton = parsed.inferredCanton;
  if (canton === null) {
    console.warn(`     ⚠️  Skipping unresolvable location "${city}" (${title})`);
    return null;
  }

  return {
    title,
    slug,
    url: detailUrl,
    applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    employmentType: parsed.employmentType,
    contractType: parsed.employmentType,
    category: inferCategory({ title, department: parsed.department }),
    sector: 'Pharma & Biotech',
    source: 'debiopharm-dedicated-crawler',
    sourceLang: parsed.sourceLanguage || 'en',
    postedDate: publishedDate,
    validThrough: '',
    description: parsed.description,
    titleByLocale: { [parsed.sourceLanguage || 'en']: title },
    descriptionByLocale: { [parsed.sourceLanguage || 'en']: parsed.description },
    slugByLocale: { [parsed.sourceLanguage || 'en']: slug },
    requirements: parsed.requirements,
    requirementsByLocale: parsed.requirements.length ? { [parsed.sourceLanguage || 'en']: parsed.requirements } : {},
    benefits: parsed.benefits,
    needsRetranslation: true,
  };
}

function jobMatchKey(job = {}) {
  const url = String(job?.url || '');
  const m = url.match(/\/j\/([A-Z0-9]+)\//i) || url.match(/\/j\/([A-Z0-9]+)$/i);
  if (m) return `shortcode:${m[1].toUpperCase()}`;
  return `slug:${normalize(job?.slug || '')}`;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonTargetJobs = allJobs.filter((job) => !isTargetJob(job));
  const existingTargetJobs = allJobs.filter(isTargetJob);

  const existingByKey = new Map(existingTargetJobs.map((job) => [jobMatchKey(job), job]));
  const discoveredByKey = new Map(discoveredJobs.map((job) => [jobMatchKey(job), job]));

  // Intra-run dedup (same class as banca-cler, PR #4056): a source that
  // publishes the same posting under two keys must not write duplicates.
  // Iterate the deduped Map values (last occurrence wins) instead of the
  // raw discovered list.
  const dedupedDiscovered = [...discoveredByKey.values()];
  if (dedupedDiscovered.length !== discoveredJobs.length) {
    console.log(`  ↺ Intra-run dedup: ${discoveredJobs.length} discovered → ${dedupedDiscovered.length} unique (same posting under multiple keys)`);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of dedupedDiscovered) {
    const key = jobMatchKey(discovered);
    const existingJob = existingByKey.get(key);
    if (existingJob) {
      merged.push({
        ...existingJob,
        ...discovered,
        titleByLocale: mergeLocaleTextMap(existingJob.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existingJob.descriptionByLocale, discovered.descriptionByLocale, 30, discovered.sourceLang),
        slugByLocale: mergeLocaleTextMap(existingJob.slugByLocale, discovered.slugByLocale, 3),
        // cap explicit (issue #3630): flat previousSlugs is the same field
        // dedicated-crawler-common.mjs manages elsewhere with LEGACY_PREV_SLUGS_CAP;
        // the module default of 20 would re-collapse it on this crawler's next run.
        previousSlugs: mergePreviousSlugsCapped(existingJob.previousSlugs, discovered.previousSlugs, { jobId: existingJob.id || discovered.id, source: 'update-debiopharm-jobs.mjs', cap: LEGACY_PREV_SLUGS_CAP }),
      });
      updated += 1;
    } else {
      merged.push(discovered);
      added += 1;
    }
  }

  for (const [key] of existingByKey) {
    if (!discoveredByKey.has(key)) removed += 1;
  }

  const finalJobs = [...nonTargetJobs, ...merged];
  writeJson(DATA_JOBS, finalJobs);
  writeJson(PUBLIC_JOBS, finalJobs);

  console.log('\n📦 Merge results:');
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${finalJobs.length}`);

  return { added, updated, removed, total: finalJobs.length };
}

function updateAdapterConfig(discoveredJobs) {
  const adapter = readJson(ADAPTER_PATH, {});
  adapter.companyKey = COMPANY_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(Number(adapter.priority || 0), 10);
  adapter.crawlerModes = ['api', 'html', 'jsonld'];
  adapter.seedUrls = discoveredJobs.map((job) => job.url);
  adapter.seedMetaByUrl = Object.fromEntries(
    discoveredJobs.map((job) => [
      job.url,
      {
        location: job.location,
        canton: inferAnyCanton(job.location) || DEFAULT_CANTON,
        company: COMPANY_NAME,
        postedDate: job.postedDate || '',
      },
    ])
  );
  adapter.notes = 'Dedicated Debiopharm crawler uses SSR debiopharm.com/careers + Workable v2 job detail API for Swiss jobs.';
  adapter.updatedAt = new Date().toISOString();
  writeJson(ADAPTER_PATH, adapter);
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

/**
 * Pure canton-backfill decision for postProcessJobs() (#3480). Given the
 * real (already-scraped) location text of an ALREADY-published job whose
 * `canton` field is currently missing, returns the safe-default canton to
 * write (Non-Negotiable #3: structured data must always carry a canton —
 * the safe default itself is never removed) plus a `needsCantonReview`
 * flag when the location text is real but unresolvable, distinct from "no
 * location text at all" (which safely defaults to HQ with no flag).
 *
 * Unlike buildDebiopharmJob's admission-time skip guard, an already-published
 * job is never dropped/cut here (AGENTS.md "never cut live pages without
 * OK") — the flag exists purely for editorial triage; the canton/
 * addressRegion the job page actually shows is unchanged.
 */
export function resolveDebiopharmBackfillCanton(locationText = '') {
  const text = String(locationText || '').trim();
  const inferredCanton = inferAnyCanton(text);
  return {
    canton: inferredCanton || DEFAULT_CANTON,
    needsCantonReview: Boolean(text && !inferredCanton),
  };
}

function postProcessJobs() {
  const raw = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;
  for (const job of jobs) {
    if (!isTargetJob(job)) continue;
    if (job.company !== COMPANY_NAME) {
      job.company = COMPANY_NAME;
      fixed += 1;
    }
    if (job.companyKey !== COMPANY_KEY) {
      job.companyKey = COMPANY_KEY;
      fixed += 1;
    }
    if (job.companyDomain !== COMPANY_DOMAIN) {
      job.companyDomain = COMPANY_DOMAIN;
      fixed += 1;
    }
    if (!job.canton) {
      const { canton, needsCantonReview } = resolveDebiopharmBackfillCanton(job.location || job.addressLocality || '');
      job.canton = canton;
      if (needsCantonReview) job.needsCantonReview = true;
      fixed += 1;
    }
    job.country = 'CH';
    // Deliberately does NOT default addressCountry to 'CH' here (#5403/#5384/#5405)
    // — an undeclared country and a declared-Swiss one are different pieces
    // of evidence; overwriting the former destroys that distinction at rest.
    // Consumers already fall back to 'CH' at read time.
    if (!job.addressRegion) job.addressRegion = job.canton;
    if (!job.location) {
      job.location = 'Lausanne';
      fixed += 1;
    }
    if (!job.addressLocality) {
      job.addressLocality = job.location || 'Lausanne';
      fixed += 1;
    }
    if (job.needsRetranslation !== true) {
      job.needsRetranslation = true;
      fixed += 1;
    }
  }
  if (fixed > 0) {
    writeJson(DATA_JOBS, jobs);
    writeJson(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} Debiopharm fields (company/location/canton/needsRetranslation).`);
  }
}

function logStats(beforeSnapshot = new Map()) {
  const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const targetJobs = Array.isArray(allJobs) ? allJobs.filter(isTargetJob) : [];

  console.log('\n📊 === Debiopharm Job Stats ===');
  console.log(`  💊 Total Debiopharm jobs: ${targetJobs.length}`);
  if (targetJobs.length > 0) {
    console.log('  📋 Jobs:');
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Lausanne'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Debiopharm');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Debiopharm');

  writeJobsSummary(targetJobs, 'Debiopharm');
  printPublishedJobUrls(targetJobs, 'Debiopharm');
  return { total: targetJobs.length, crawlDiff };
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DEBIOPHARM_STRICT',
    label: 'Debiopharm',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_debiopharm_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Debiopharm jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Debiopharm');
  console.log('═══════════════════════════════════════════════');
  console.log('  Debiopharm — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${DEBIOPHARM_CAREERS_URL}\n`);

  let beforeSnapshot = new Map();
  const pre = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  if (Array.isArray(pre)) beforeSnapshot = snapshotJobSlugs(pre.filter(isTargetJob));

  const listings = await fetchDebiopharmListings();
  if (listings.length === 0) {
    throw new Error('Debiopharm discovery returned 0 listings.');
  }

  const discoveredJobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.title} [${listing.shortcode}]`);
    let detail;
    try {
      detail = await fetchDebiopharmDetail(listing.shortcode);
    } catch (err) {
      console.warn(`     ⚠️  Detail fetch failed for ${listing.shortcode}: ${err?.message || err}`);
      continue;
    }
    if (!isDebiopharmSwissJob(detail)) {
      console.log(`     ⏭️  Skipping (not Switzerland): ${detail?.location?.countryCode || '?'}`);
      continue;
    }
    const job = buildDebiopharmJob(listing, detail);
    if (!job) continue;
    discoveredJobs.push(job);
  }

  if (discoveredJobs.length === 0) {
    throw new Error('Debiopharm produced 0 Switzerland-located jobs after enrichment.');
  }

  updateAdapterConfig(discoveredJobs);
  await mergeJobs(discoveredJobs);

  console.log('\n🌐 Running locale fill for Debiopharm jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  postProcessJobs();
  const stats = logStats(beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    throw new Error('Debiopharm crawler produced 0 jobs.');
  }
  validateLocales();

  console.log('\n✅ Debiopharm crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Debiopharm',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

// Guard top-level execution so the module can be imported by tests (e.g.
// buildDebiopharmJob's skip-guard wiring test) without triggering a live
// crawl. Run only when invoked directly via `node scripts/update-debiopharm-jobs.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => exitCrawlerOnError(err, 'Debiopharm'));
}
