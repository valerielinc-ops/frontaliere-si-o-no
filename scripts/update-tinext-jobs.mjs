#!/usr/bin/env node
/**
 * Dedicated Tinext crawler.
 *
 * Tinext SA is a Lugano-based digital transformation company.
 * Jobs are published on their Kenjo careers site at https://tinext.kenjo.io/
 *
 * This crawler:
 *   1. Fetches the Kenjo public listing API for the tinext tenant.
 *   2. For each active position, fetches the public detail page HTML.
 *   3. Extracts the full vacancy body from the detail page.
 *   4. Merges results into data/jobs.json.
 *   5. Updates the adapter config with current seed URLs.
 *   6. Runs locale fill + validation.
 *   7. Publishes 0 jobs only when the API lists no positions for an active
 *      career site AND the public career page shows its explicit empty state;
 *      otherwise preserves the existing slice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError, fetchHtml as sharedFetchHtml, fetchJson } from './lib/crawler-template.mjs';
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
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';
import { dropStaleLocaleDescriptions } from './lib/source-locale-slots.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { assertJsonListShapeMultiKey } from './lib/assert-json-list-shape.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { provesKenjoCareerSiteEmpty, resolveKenjoPositionPath } from './lib/kenjo-career-site.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'tinext.json');

const COMPANY_KEY = 'tinext';
// Per-crawler-scoped scratch path — isolates this script's own merge writes
// from the shared, gitignored, CI-absent data/jobs.json that ~25 sibling
// dedicated crawlers also target as `background: true` steps in one CI job;
// writing directly to the shared path races and silently clobbers sibling
// output (confirmed bug class of #3769/#3770, crash-class #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const HQ = getCompanyDefaults('tinext');
const COMPANY_NAME = 'Tinext SA';
const COMPANY_HOST = 'tinext.kenjo.io';
const COMPANY_DOMAIN = 'tinext.com';
const CAREERS_URL = 'https://tinext.kenjo.io/#jobs';
const LISTING_API = 'https://tinext.kenjo.io/api/controller/career-site/public/tinext/positions';
const DETAIL_API_BASE = 'https://tinext.kenjo.io/api/controller/career-site/public/tinext/positions/';
const DETAIL_BASE = 'https://tinext.kenjo.io/';
const LOCALES = ['it', 'en', 'de', 'fr'];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */
function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function deriveSlug(title, customUrl) {
  const base = customUrl
    ? normalizeKey(`${title} tinext lugano ${customUrl}`)
    : normalizeKey(`${title} tinext lugano`);
  return base;
}

/* ── Matchers ──────────────────────────────────────────────── */
function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company.includes('tinext') ||
    url.includes('tinext.kenjo.io') ||
    url.includes('tinext.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host.endsWith('.tinext.com') || host === 'tinext.com';
  } catch { return false; }
}

/* ── Category inference ────────────────────────────────────── */
function inferCategory(title = '') {
  const t = normalize(title);
  if (t.includes('java') || t.includes('developer') || t.includes('sviluppatore') || t.includes('frontend') || t.includes('backend') || t.includes('fullstack') || t.includes('full stack') || t.includes('software')) return 'IT / Software Development';
  if (t.includes('data') || t.includes('analyst') || t.includes('analyst') || t.includes('bi ')) return 'Data & Analytics';
  if (t.includes('project manager') || t.includes('pm ') || t.includes('scrum') || t.includes('agile')) return 'Project Management';
  if (t.includes('sales') || t.includes('business development') || t.includes('account')) return 'Sales & Business Development';
  if (t.includes('assistant') || t.includes('executive') || t.includes('admin')) return 'Administration';
  if (t.includes('marketing') || t.includes('communication')) return 'Marketing & Communication';
  if (t.includes('hr') || t.includes('people') || t.includes('talent') || t.includes('recruiter')) return 'Human Resources';
  if (t.includes('freelance') || t.includes('consultant') || t.includes('consulente')) return 'Consulting';
  return 'IT & Digital Transformation';
}

/* ── Fetch helpers ─────────────────────────────────────────── */
async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return sharedFetchHtml(url, {
    timeoutMs,
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'User-Agent': UA,
      },
  });
}

/* ── Kenjo detail page parser ──────────────────────────────── */
/**
 * Extract the job description from a Kenjo detail page HTML.
 *
 * Kenjo renders the job body inside a section with the full vacancy
 * description.  We look for the main content area and extract the
 * prose text, stripping navigation, header, and footer chrome.
 */
function parseDetailHtml(html) {
  // Kenjo detail pages typically have job content inside the main body.
  // Strip known chrome sections first.
  let body = html;

  // Remove nav / header / footer areas
  body = body.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  body = body.replace(/<header[\s\S]*?<\/header>/gi, '');
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // Try to extract main content area (main, article, or .job-description)
  const mainMatch =
    body.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    body.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    body.match(/class="[^"]*(?:job[-_]?(?:description|content|detail|body))[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i);

  const contentHtml = mainMatch ? mainMatch[1] : body;

  const text = stripHtml(contentHtml);

  // If text is too short, fall back to stripping the full page
  if (text.length < 100) {
    return stripHtml(body);
  }

  return text;
}

/* ── Discover listings from API ────────────────────────────── */
async function discoverListings() {
  console.log('🔍 Fetching Tinext positions from Kenjo API...');
  const data = await fetchJson(LISTING_API, {
    headers: { Accept: 'application/json, */*', 'User-Agent': UA },
  });

  // The old `data?.activePositions || data?.positions || []` collapsed a TOTAL
  // drift (both keys absent) to `[]` — an array — so the `!Array.isArray` throw
  // below was unreachable on the silent-drift case (#1666 class). Resolve via the
  // shared multi-key guard, which warns on drift; a drift here is a hard failure
  // for this single-source crawler, so we still throw (preserving the original
  // loud-fail intent) but now it actually fires on a renamed/missing envelope.
  let envelopeDrifted = false;
  const positions = assertJsonListShapeMultiKey(data, {
    keys: ['activePositions', 'positions'],
    source: 'tinext',
    warn: (msg) => {
      envelopeDrifted = true;
      console.warn(msg);
    },
  });
  if (envelopeDrifted) {
    throw new Error(`Unexpected Kenjo API response shape: missing activePositions array`);
  }

  console.log(`📋 Found ${positions.length} active position(s):`);
  for (const p of positions) {
    console.log(`  📄 ${p.jobTitle || p.title || '?'} (${p.officeName || '?'}) — customUrl: ${resolveKenjoPositionPath(p) || '?'}`);
  }

  // The envelope travels with the positions: an empty list is only a proven
  // zero together with the site's own `active` flag (see confirmCareerSiteEmpty).
  return { positions, listing: data };
}

/* ── Build job objects ─────────────────────────────────────── */
async function buildJobs(positions) {
  const jobs = [];
  let skipped = 0;

  for (const position of positions) {
    const rawTitle = String(position.jobTitle || position.title || '').trim();
    // Filter out titles that are clearly platform-company roles
    // (e.g., "[UNPLEX]" prefix; still keep the underlying vacancy)
    const title = rawTitle.replace(/^\[UNPLEX\]\s*/i, '').trim() || rawTitle;
    const office = (position.officeName || 'Lugano').trim();
    const customUrl = resolveKenjoPositionPath(position);

    if (!customUrl) {
      console.warn(`  ⚠️  Position "${rawTitle}" has no customUrl — skipping`);
      skipped += 1;
      continue;
    }

    const detailUrl = `${DETAIL_BASE}${customUrl}`;

    let description = '';
    try {
      // Kenjo provides a public JSON detail API — use it instead of scraping the Angular SPA
      const detail = await fetchJson(`${DETAIL_API_BASE}${customUrl}`, {
        headers: { Accept: 'application/json, */*', 'User-Agent': UA },
      });
      const descHtml = detail?.jobDescription?.html || '';
      description = stripHtml(descHtml);
      if (!description && descHtml) description = stripHtml(descHtml);
      if (!description) description = title;
      console.log(`  ✓ Fetched detail for "${title}" (${description.length} chars)`);
    } catch (err) {
      console.warn(`  ⚠️  Could not fetch detail API for ${customUrl}: ${err.message} — using title only`);
      description = title;
    }

    const slug = deriveSlug(title, customUrl);
    const sourceLang = detectLang(description || title, 'en');

    jobs.push({
      title,
      slug,
      url: detailUrl,
      applyUrl: detailUrl,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: COMPANY_DOMAIN,
      location: office,
      addressLocality: office,
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      canton: HQ.canton,
      country: 'CH',
      category: inferCategory(title),
      sector: 'IT & Digital Transformation',
      source: 'tinext-dedicated-crawler',
      sourceLang,
      postedDate: new Date().toISOString().slice(0, 10),
      validThrough: '',
      employmentType: 'full-time',
      contractType: 'full-time',
      description,
      titleByLocale: { [sourceLang]: title },
      descriptionByLocale: { [sourceLang]: description },
      // Slug in the same source slot as the text (#5253).
      slugByLocale: { [sourceLang]: slug },
    });
  }

  if (skipped > 0) {
    console.warn(`  ⚠️  Skipped ${skipped}/${positions.length} positions`);
  }

  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */
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
    if (!prev) { added += 1; return job; }
    updated += 1;
    const merged = {
      ...prev,
      ...job,
      // Fresh text wins in the SOURCE slot only; translations are kept.
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3, job.sourceLang),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30, job.sourceLang),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
    dropStaleLocaleDescriptions(merged);
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    return merged;
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter config ────────────────────────────────────────── */
function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location || 'Lugano',
      canton: HQ.canton,
      company: COMPANY_NAME,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 12,
    crawlerModes: ['json_api', 'html'],
    seedUrls: [LISTING_API],
    notes: `Dedicated Tinext crawler uses the Kenjo public listing API at ${LISTING_API} (returns activePositions) and fetches each detail page from ${DETAIL_BASE}{customUrl}. Tinext SA is a digital transformation company based in Lugano (TI).`,
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Validation ────────────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_TINEXT_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_tinext_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Tinext jobs found after dedicated crawl — vacancies may be temporarily empty.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function publishAuthoritativeEmptySnapshot() {
  const previousJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(previousJobs);
  const diff = computeCrawlDiff(beforeSnapshot, new Map());
  const durationMs = getCrawlerElapsedMs();

  updateAdapterConfig([]);
  archiveRemovedJobsToSlice(diff.removedJobs, COMPANY_KEY);
  writeJobsCrawlerSlice(COMPANY_KEY, [], { skipShrinkGuard: true });
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: COMPANY_NAME,
    generatedAt: new Date().toISOString(),
    total: 0,
    discovered: 0,
    parsed: 0,
    written: 0,
    authoritativeEmptySnapshot: true,
    sourceProvenEmpty: true,
    newCount: 0,
    updatedCount: 0,
    removedCount: diff.removedJobs.length,
    unchangedCount: 0,
    durationMs,
    avgDurationMs: durationMs,
    durationHistory: [durationMs],
    newJobs: [],
    updatedJobs: [],
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: [],
  });
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  await assembleJobsDataset();
}

async function confirmCareerSiteEmpty(listing) {
  if (listing?.active !== true) {
    console.warn('⚠️ Kenjo listing API does not declare an active career site; an empty list is not a proven zero.');
    return false;
  }
  try {
    const html = await fetchHtml(CAREERS_URL);
    const empty = provesKenjoCareerSiteEmpty({ listing, careerPageHtml: html });
    if (!empty) {
      console.warn('⚠️ Kenjo career page does not show its explicit no-openings state; preserving existing Tinext jobs.');
    }
    return empty;
  } catch (error) {
    console.warn(`⚠️ Could not verify the Kenjo career page empty state: ${error.message}`);
    return false;
  }
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  const summaryCounts = { discovered: null, parsed: null, abortKind: null };
  registerCrawlerSummaryGuard(COMPANY_KEY, 'tinext', summaryCounts);
  console.log('═══════════════════════════════════════════════');
  console.log('  Tinext SA — Dedicated Crawler (Kenjo)');
  console.log('═══════════════════════════════════════════════');
  console.log(`  API: ${LISTING_API}\n`);

  // 1. Fetch listing API
  const { positions, listing } = await discoverListings();
  summaryCounts.discovered = positions.length;

  if (positions.length === 0) {
    if (await confirmCareerSiteEmpty(listing)) {
      console.log('ℹ️ Kenjo confirms no active positions; publishing an authoritative empty snapshot.');
      await publishAuthoritativeEmptySnapshot();
      return;
    }
    summaryCounts.abortKind = 'no-jobs-parsed';
    console.log('⚠️ Kenjo API returned no active positions without explicit public empty-state proof; preserving existing data.');
    return;
  }

  // 2. Fetch detail pages and build job objects
  const jobs = await buildJobs(positions);
  summaryCounts.parsed = jobs.length;

  if (jobs.length === 0) {
    // The API itself listed positions, so no page state can make this a
    // proven zero: the detail/build step lost them. Keep the existing slice.
    summaryCounts.abortKind = 'no-jobs-parsed';
    console.log(`⚠️ Kenjo listed ${positions.length} position(s) but no Tinext job could be built (all skipped); preserving existing data.`);
    return;
  }

  // 3. Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  // 4. Translate missing locales
  console.log('\n🌐 Running locale fill for Tinext jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // 5. Validate
  validateLocales();

  console.log('\n📊 === Tinext Job Stats ===');
  console.log(`  ⚡ Total Tinext jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'tinext',
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

main().catch((error) => exitCrawlerOnError(error, 'Tinext'));
