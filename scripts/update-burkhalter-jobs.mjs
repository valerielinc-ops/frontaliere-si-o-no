#!/usr/bin/env node
/**
 * Dedicated Burkhalter Group crawler runner.
 *
 * Burkhalter Group is Switzerland's largest building technology group
 * (80+ companies, 150+ locations). HQ: Zürich.
 * Careers portal: https://www.burkhalter.ch/en/jobs-and-careers/vacancies
 *
 * The vacancies page embeds all jobs as an inline JSON array in a
 * <script type="application/json" id="jobs-json"> tag, making discovery
 * straightforward. Each job entry contains title, company, city, canton,
 * coordinates, and a relative detail URL.
 *
 * This crawler:
 *   1. Fetches the vacancies page and extracts the inline JSON job list.
 *   2. Filters for Grisons (Graubünden) and Ticino jobs.
 *   3. Scrapes each detail page for a description.
 *   4. Builds standardized job objects and merges into data/jobs.json.
 *   5. Translates missing locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
  detectLang,
  deriveLocalizedSlug,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { isTargetCanton, getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const COMPANY_KEY = 'burkhalter-group';
const COMPANY_NAME = 'Burkhalter Group';
const COMPANY_DOMAIN = 'burkhalter.ch';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'ZH';

const VACANCIES_URL = 'https://www.burkhalter.ch/en/jobs-and-careers/vacancies';
const BASE_URL = 'https://www.burkhalter.ch';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
const CONCURRENCY = Number(process.env.JOBS_CRAWLER_CONCURRENCY) || 4;

// Burkhalter spans all 26 Swiss cantons — accept any target canton. Canton scope
// is governed by TARGET_CANTONS in scripts/lib/crawler-location-config.mjs.

/* ── Helpers ───────────────────────────────────────────────── */
function readJson(filePath, fallback = []) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key.startsWith('burkhalter') ||
    company.includes('burkhalter') ||
    url.includes('burkhalter.ch')
  );
}

function mapCanton(rawCanton = '', cityHint = '') {
  const direct = inferAnyCanton(rawCanton);
  if (direct) return direct;
  const fromCity = cityHint ? inferAnyCanton(cityHint) : '';
  if (fromCity) return fromCity;
  const c = normalize(rawCanton).toUpperCase().slice(0, 2);
  return isTargetCanton(c) ? c : '';
}

function isRelevantCanton(rawCanton = '', cityHint = '') {
  return isTargetCanton(mapCanton(rawCanton, cityHint));
}

function jobMatchKey(job) {
  return String(job.url || '').trim().toLowerCase() || String(job.slug || '').trim().toLowerCase();
}

function slugify(text = '') {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/* ── Fetch & Parse ─────────────────────────────────────────── */
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Extract jobs JSON from the inline <script id="jobs-json"> tag.
 */
function extractJobsJson(html) {
  const match = html.match(/<script[^>]+id="jobs-json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Could not find <script id="jobs-json"> in vacancies page');
  return JSON.parse(match[1]);
}

/**
 * Scrape a job detail page for description text.
 */
async function scrapeDetailPage(relativeUrl) {
  const url = relativeUrl.startsWith('http') ? relativeUrl : `${BASE_URL}${relativeUrl}`;
  try {
    const html = await fetchPage(url);
    // Extract main content — detail pages have structured sections
    // Remove HTML tags but preserve paragraph breaks
    const contentMatch = html.match(/<div class="content">([\s\S]*?)<footer/i)
      || html.match(/<div data-addsearch="include">([\s\S]*?)<footer/i);
    if (!contentMatch) return '';

    let text = contentMatch[1]
      // Strip script/style content entirely — tag-only stripping below leaves JSON-LD
      // payload visible as raw text (the Burkhalter pages embed schema.org JobPosting
      // JSON-LD inside the content div, which was leaking into descriptionByLocale).
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, '') // strip remaining HTML tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Remove breadcrumb and header noise
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const contentStart = lines.findIndex(l =>
      l.includes('Ihr Profil') || l.includes('Your Profile') ||
      l.includes('Votre profil') || l.includes('Il tuo profilo') ||
      l.includes('Unser Angebot') || l.includes('suchen wir') ||
      l.includes('looking for') || l.includes('recherchons') ||
      lines.indexOf(l) > 3
    );
    const relevantLines = contentStart > 0 ? lines.slice(Math.max(0, contentStart - 2)) : lines.slice(3);
    return relevantLines.join('\n').trim().slice(0, 3000);
  } catch (err) {
    console.warn(`   ⚠️ Could not scrape detail: ${url} — ${err.message}`);
    return '';
  }
}

/* ── Build Job Objects ─────────────────────────────────────── */
function buildJob(raw, description = '') {
  const title = String(raw.job || '').trim();
  const company = String(raw.company || COMPANY_NAME).trim();
  const city = String(raw.city || '').trim();
  const canton = mapCanton(raw.canton, city) || DEFAULT_CANTON;
  const slug = slugify(`${title}-${company}-${city}`);
  const detailUrl = raw.url
    ? (raw.url.startsWith('http') ? raw.url : `${BASE_URL}${raw.url}`)
    : `${BASE_URL}/en/jobs-and-careers/vacancies`;
  const postedDate = raw.issueDate
    ? new Date(raw.issueDate * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const sourceLang = detectLang(`${title} ${description}`, 'de');

  // Determine employment type from title
  const pensum = title.match(/\((\d+)\s*-?\s*(\d+)?%\)/);
  let employmentType = 'full-time';
  if (pensum) {
    const maxPensum = Number(pensum[2] || pensum[1]);
    if (maxPensum < 80) employmentType = 'part-time';
  }

  // Category mapping from Burkhalter field
  const categoryMap = {
    'Electrotechnics': 'Ingegneria & Tecnica',
    'HLKS': 'Ingegneria & Tecnica',
    'Heating technology': 'Ingegneria & Tecnica',
    'Plumbing technology': 'Ingegneria & Tecnica',
    'Roofing': 'Edilizia & Costruzioni',
    'Metalwork': 'Edilizia & Costruzioni',
    'Plant engineering': 'Ingegneria & Tecnica',
    'Planning': 'Ingegneria & Tecnica',
    'Administration': 'Amministrazione & Risorse Umane',
    'IT': 'Informatica & Telecomunicazioni',
  };
  const category = categoryMap[raw.field] || 'Ingegneria & Tecnica';

  const job = {
    title,
    slug,
    url: detailUrl,
    applyUrl: detailUrl,
    company,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city || 'Graubünden',
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category,
    sector: 'Impiantistica & Tecnologia Edilizia',
    source: 'burkhalter-dedicated-crawler',
    sourceLang,
    postedDate,
    employmentType,
    contractType: employmentType,
    description: description || `${title} presso ${company}, ${city}`,
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
    crawledAt: new Date().toISOString(),
  };

  // Set coordinates if available
  if (raw.lat && raw.lng) {
    job.coordinates = [raw.lat, raw.lng];
  }

  return job;
}

/* ── Merge ─────────────────────────────────────────────────── */
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
    if (!prev) {
      added += 1;
      return job;
    }
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
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, allJobs);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats() {
  const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const jobs = allJobs.filter(isTargetJob);
  const grJobs = jobs.filter((j) => normalize(j.canton) === 'gr');
  const tiJobs = jobs.filter((j) => normalize(j.canton) === 'ti');
  const vsJobs = jobs.filter((j) => normalize(j.canton) === 'vs');

  console.log(`\n📊 === Burkhalter Group Job Stats ===`);
  console.log(`  🏗️  Total Burkhalter jobs: ${jobs.length}`);
  console.log(`  ✅ Grigioni (GR): ${grJobs.length}`);
  console.log(`  ✅ Ticino (TI): ${tiJobs.length}`);
  console.log(`  ✅ Vallese (VS): ${vsJobs.length}`);
  console.log('');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BURKHALTER_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    noJobsMessage: 'No Burkhalter Group jobs found after crawl.',
    maxToleratedMissingDescriptions: 10,
  });
}

/* ── Concurrency Helper ────────────────────────────────────── */
async function pMap(items, fn, concurrency = CONCURRENCY) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'burkhalter');
  console.log('🏗️  Running dedicated Burkhalter Group jobs crawler...');
  console.log(`   Portal: ${VACANCIES_URL}`);
  console.log('');

  // Step 1: Fetch the vacancies page
  console.log('📥 Fetching vacancies page...');
  const html = await fetchPage(VACANCIES_URL);

  // Step 2: Extract inline JSON
  const allJobs = extractJobsJson(html);
  console.log(`📋 Found ${allJobs.length} total Burkhalter Group jobs`);

  // Step 3: Filter for target cantons (all 26 by default — see crawler-location-config.mjs).
  const relevantJobs = allJobs.filter((j) => isRelevantCanton(j.canton, j.city));
  console.log(`🎯 Filtered to ${relevantJobs.length} jobs in target cantons`);

  if (relevantJobs.length === 0) {
    console.log('ℹ️ No relevant Burkhalter Group jobs found. Exiting OK.');
    return;
  }

  // Step 4: Scrape detail pages for descriptions
  console.log(`🔍 Scraping ${relevantJobs.length} detail pages (concurrency: ${CONCURRENCY})...`);
  const descriptions = await pMap(
    relevantJobs,
    async (raw, i) => {
      if (!raw.url) return '';
      console.log(`  [${i + 1}/${relevantJobs.length}] ${raw.job}`);
      return scrapeDetailPage(raw.url);
    },
    CONCURRENCY,
  );

  // Step 5: Build standardized job objects
  const jobs = relevantJobs.map((raw, i) => buildJob(raw, descriptions[i]));
  console.log(`✅ Built ${jobs.length} job objects`);

  // Step 6: Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  console.log(`\n📦 Merge complete: ${total} total, ${added} added, ${updated} updated`);

  // Step 7: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Step 8: Stats + validation
  logStats();
  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'burkhalter',
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

main().catch((err) => {
  console.error(`❌ Burkhalter Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
