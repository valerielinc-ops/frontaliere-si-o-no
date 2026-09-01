#!/usr/bin/env node
/**
 * Dedicated Guess Europe Sagl crawler runner.
 *
 * Discovery uses the public Workable widget API embedded in:
 *   https://www.guess.eu/it-ch/career-page.html
 *
 * Flow:
 *   1. Fetch Workable widget JSONP for Guess Europe Sagl
 *   2. Keep only Ticino jobs (Bioggio/Stabio/Ticino)
 *   3. Fetch Workable v2 detail JSON for each job
 *   4. Build complete job objects and merge them into jobs.json
 *   5. Run scoped localization for the Guess company key
 *   6. Validate locale coverage in strict mode
 */
import fs from 'node:fs';
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
  GUESS_WORKABLE_ACCOUNT_ID,
  GUESS_WORKABLE_ACCOUNT_SLUG,
  parseGuessWidgetJsonp,
  isGuessTicinoWidgetJob,
  buildGuessDetailUrl,
  buildGuessApplyUrl,
  parseGuessJobDetailPayload,
  resolveGuessCanton,
  resolveGuessBackfillCanton,
} from './lib/guess-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'guess-europe.json');

const COMPANY_KEY = 'guess-europe';
// Per-crawler-scoped scratch path — this crawler does its own fetch+merge
// (no runDedicatedBaseCrawler call), but still runs as one of ~25 sibling
// background steps sharing a filesystem checkout in CI, so writing straight
// to the shared, gitignored, CI-absent data/jobs.json is the same
// cross-process-racy write pattern behind #3769/#3770. Scope it per-company.
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Guess Europe Sagl';
const COMPANY_HOST = 'apply.workable.com';
const COMPANY_DOMAIN = 'guess.eu';
const CAREERS_URL = 'https://www.guess.eu/it-ch/career-page.html';
const WORKABLE_WIDGET_URL = `https://apply.workable.com/api/v1/widget/accounts/${GUESS_WORKABLE_ACCOUNT_ID}?origin=embed&callback=whrcallback`;
const WORKABLE_DETAIL_API_BASE = `https://apply.workable.com/api/v2/accounts/${GUESS_WORKABLE_ACCOUNT_SLUG}/jobs`;
const LOCALES = ['it', 'en', 'de', 'fr'];

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

function slugify(value = '') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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
  if (/(customer service|e-commerce|campaign|merchandising|marketing|content)/i.test(haystack)) return 'sales';
  if (/(product developer|product development)/i.test(haystack)) return 'engineering';
  if (/(finance|accounting|controller|payroll|treasury)/i.test(haystack)) return 'finance';
  if (/(hr|human resources|talent|recruit)/i.test(haystack)) return 'admin';
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
    key.includes('guess-europe') ||
    company.includes('guess europe') ||
    host === 'apply.workable.com' ||
    host.endsWith('.workable.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'apply.workable.com' || host.endsWith('.workable.com') || host.endsWith('.guess.eu') || host === 'guess.eu';
  } catch {
    return false;
  }
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/javascript,text/javascript,*/*;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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

async function fetchGuessListings() {
  console.log('🔍 Fetching Guess jobs from Workable widget API...');
  console.log(`  📡 ${WORKABLE_WIDGET_URL}`);
  const jsonp = await fetchText(WORKABLE_WIDGET_URL, Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000);
  const payload = parseGuessWidgetJsonp(jsonp);
  const jobs = assertJsonListShape(payload, { key: 'jobs', source: 'guess' });
  const ticino = jobs.filter(isGuessTicinoWidgetJob);
  console.log(`  📦 Total widget jobs: ${jobs.length}`);
  console.log(`  🎯 Ticino jobs found: ${ticino.length}`);
  for (const job of ticino) {
    console.log(`     - ${job.title} (${job.city}, ${job.state})`);
  }
  return ticino;
}

async function fetchGuessDetail(shortcode) {
  return fetchJson(`${WORKABLE_DETAIL_API_BASE}/${encodeURIComponent(shortcode)}`, Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000);
}

function buildGuessJob(listing, detail) {
  const parsed = parseGuessJobDetailPayload(detail);
  const title = parsed.title || String(listing?.title || '').trim();
  const rawCity = parsed.city || String(listing?.city || '').trim();
  // Unresolved-canton skip guard (#3480 sibling — same construct already
  // fixed for clariant/swisslog/debiopharm/komax/lindt-spruengli): resolve
  // BEFORE the 'Bioggio' display fallback is applied, so a real-but-
  // unresolvable city is never masked into looking like "no location text
  // at all" and silently fabricated to the Bioggio HQ canton (TI).
  const canton = resolveGuessCanton(rawCity);
  if (canton === null) {
    console.warn(`     ⚠️  Skipping unresolvable location "${rawCity}" (${title})`);
    return null;
  }
  const city = rawCity || 'Bioggio';
  // Slug-only guard: `city` can be the literal "undefined"/"null" string (truthy)
  // → `-undefined` in an active slug (#952, class #900/#901). location/addressLocality
  // keep raw `city` (choke-point normalizer owns de-index).
  const slug = slugify(`${title} ${COMPANY_NAME} ${safeLocationToken(city, 'Bioggio')} Ticino Switzerland`);
  const detailUrl = buildGuessDetailUrl(listing.shortcode);
  const applyUrl = buildGuessApplyUrl(listing.shortcode);
  const publishedDate = toIsoDate(parsed.publishedDate || listing.published_on || listing.created_at);

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
    sector: 'Lusso & Moda',
    source: 'guess-europe-dedicated-crawler',
    sourceLang: parsed.sourceLanguage || 'en',
    postedDate: publishedDate,
    validThrough: '',
    description: parsed.description,
    titleByLocale: { en: title },
    descriptionByLocale: { en: parsed.description },
    slugByLocale: { en: slug },
    requirements: parsed.requirements,
    requirementsByLocale: parsed.requirements.length ? { en: parsed.requirements } : {},
    benefits: parsed.benefits,
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
        // cap explicit: this job's flat previousSlugs is the SAME field
        // dedicated-crawler-common.mjs's syncLegacyPreviousSlugs maintains
        // elsewhere in the pipeline (translate-pending, regenerate-slugs),
        // which now uses LEGACY_PREV_SLUGS_CAP too — the module default
        // (20) would re-collapse it on this crawler's next run (#3630).
        previousSlugs: mergePreviousSlugsCapped(existingJob.previousSlugs, discovered.previousSlugs, { jobId: existingJob.id || discovered.id, source: 'update-guess-jobs.mjs', cap: LEGACY_PREV_SLUGS_CAP }),
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
  adapter.notes = 'Dedicated Guess crawler uses Workable widget API + Workable v2 job detail API for Ticino jobs.';
  adapter.updatedAt = new Date().toISOString();
  writeJson(ADAPTER_PATH, adapter);
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
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
    // Unresolved-canton skip guard, backfill side (#3480 — mirrors
    // update-debiopharm-jobs.mjs's postProcessJobs()). Canton is still
    // recomputed unconditionally every run (unchanged prior behavior); a
    // real-but-unresolvable location text additionally earns a
    // `needsCantonReview` flag for editorial triage instead of silently
    // fabricating the Bioggio HQ canton (TI) for an already-published job
    // (AGENTS.md "never cut live pages without OK" + Non-Negotiable #3).
    const { canton: backfillCanton, needsCantonReview } = resolveGuessBackfillCanton(job.location || job.addressLocality || '');
    job.canton = backfillCanton;
    if (needsCantonReview && job.needsCantonReview !== true) {
      job.needsCantonReview = true;
      fixed += 1;
    }
    job.country = 'CH';
    // Deliberately does NOT default addressCountry to 'CH' here (#5403/#5384/#5405)
    // — an undeclared country and a declared-Swiss one are different pieces
    // of evidence; overwriting the former destroys that distinction at rest.
    // Consumers already fall back to 'CH' at read time.
    job.addressRegion = job.canton;
    if (!job.location) {
      job.location = 'Bioggio';
      fixed += 1;
    }
    if (!job.addressLocality) {
      job.addressLocality = job.location || 'Bioggio';
      fixed += 1;
    }
  }
  if (fixed > 0) {
    writeJson(DATA_JOBS, jobs);
    writeJson(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} Guess jobs (fixed company/location/canton).`);
  }
}

function logStats(beforeSnapshot = new Map()) {
  const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const targetJobs = Array.isArray(allJobs) ? allJobs.filter(isTargetJob) : [];

  console.log('\n📊 === Guess Europe Sagl Job Stats ===');
  console.log(`  👗 Total Guess jobs: ${targetJobs.length}`);
  if (targetJobs.length > 0) {
    console.log('  📋 Jobs:');
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Bioggio'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Guess');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Guess');

  writeJobsSummary(targetJobs, 'Guess');
  printPublishedJobUrls(targetJobs, 'Guess');
  return { total: targetJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GUESS_STRICT',
    label: 'Guess Europe Sagl',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_guess_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Guess jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Guess Europe Sagl');
  console.log('═══════════════════════════════════════════════');
  console.log('  Guess Europe Sagl — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  let beforeSnapshot = new Map();
  const pre = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  if (Array.isArray(pre)) beforeSnapshot = snapshotJobSlugs(pre.filter(isTargetJob));

  const listings = await fetchGuessListings();
  if (listings.length === 0) {
    throw new Error('Guess discovery returned 0 Ticino jobs.');
  }

  const discoveredJobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.title} (${listing.city})`);
    const detail = await fetchGuessDetail(listing.shortcode);
    const job = buildGuessJob(listing, detail);
    if (!job) continue;
    discoveredJobs.push(job);
  }

  if (discoveredJobs.length === 0) {
    throw new Error('Guess discovery produced 0 admissible jobs after enrichment.');
  }

  updateAdapterConfig(discoveredJobs);
  await mergeJobs(discoveredJobs);

  console.log('\n🌐 Running locale fill for Guess jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  postProcessJobs();
  const stats = logStats(beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    throw new Error('Guess crawler produced 0 jobs.');
  }
  validateLocales();

  console.log('\n✅ Guess Europe Sagl crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Guess Europe Sagl',
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

main().catch((err) => exitCrawlerOnError(err, 'Guess'));
