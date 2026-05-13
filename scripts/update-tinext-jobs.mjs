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
 *   7. Exits OK with 0 jobs when no vacancies are active.
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
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'tinext.json');

const COMPANY_KEY = 'tinext';
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
async function fetchJson(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
        'User-Agent': UA,
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'User-Agent': UA,
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
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
  const data = await fetchJson(LISTING_API);

  const positions = data?.activePositions || data?.positions || [];
  if (!Array.isArray(positions)) {
    throw new Error(`Unexpected Kenjo API response shape: missing activePositions array`);
  }

  console.log(`📋 Found ${positions.length} active position(s):`);
  for (const p of positions) {
    console.log(`  📄 ${p.jobTitle || '?'} (${p.officeName || '?'}) — customUrl: ${p.customUrl || '?'}`);
  }

  return positions;
}

/* ── Build job objects ─────────────────────────────────────── */
async function buildJobs(positions) {
  const jobs = [];
  let skipped = 0;

  for (const position of positions) {
    const rawTitle = (position.jobTitle || '').trim();
    // Filter out titles that are clearly not Swiss/Ticino roles
    // (e.g., "[UNPLEX]" prefix signals a platform company role; still keep it)
    const title = rawTitle.replace(/^\[UNPLEX\]\s*/i, '').trim() || rawTitle;
    const office = (position.officeName || 'Lugano').trim();
    const customUrl = (position.customUrl || '').trim();

    if (!customUrl) {
      console.warn(`  ⚠️  Position "${rawTitle}" has no customUrl — skipping`);
      skipped += 1;
      continue;
    }

    const detailUrl = `${DETAIL_BASE}${customUrl}`;

    let description = '';
    try {
      // Kenjo provides a public JSON detail API — use it instead of scraping the Angular SPA
      const detail = await fetchJson(`${DETAIL_API_BASE}${customUrl}`);
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
      slugByLocale: { it: slug },
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

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'tinext');
  console.log('═══════════════════════════════════════════════');
  console.log('  Tinext SA — Dedicated Crawler (Kenjo)');
  console.log('═══════════════════════════════════════════════');
  console.log(`  API: ${LISTING_API}\n`);

  // 1. Fetch listing API
  const positions = await discoverListings();

  if (positions.length === 0) {
    console.log('ℹ️ No active positions found on the Tinext Kenjo API.');
    printCrawlChangeSummary({ newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 }, COMPANY_NAME);
    return;
  }

  // 2. Fetch detail pages and build job objects
  const jobs = await buildJobs(positions);

  if (jobs.length === 0) {
    console.log('ℹ️ No Tinext jobs built after detail fetch (all skipped).');
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

main().catch((error) => {
  console.error(`❌ Tinext crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
