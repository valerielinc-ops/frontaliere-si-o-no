#!/usr/bin/env node
/**
 * Dedicated Swiss Post (La Posta Svizzera) crawler runner.
 * Crawls the Post.ch careers portal for Ticino/Grigioni positions
 * (apprenticeships + professionals) and enforces full locale coverage.
 *
 * Listing URLs:
 *   Apprenticeships: https://www.post.ch/en/jobs/jobs?jobsCategory=apprenticeships
 *   Professionals: https://www.post.ch/en/jobs/jobs?jobsCategory=professionals&workload-maximum=1&workload-minimum=0
 *
 * Individual job detail pages are on a separate subdomain:
 *   https://job.post.ch/v2/job-vacancies/{slug}/{uuid}
 *
 * Discovery flow:
 *   1. Fetch both listing pages
 *   2. Parse job links (job.post.ch/v2/job-vacancies/{slug}/{uuid})
 *   3. Fetch each job detail page to extract data from JSON-LD (JobPosting schema)
 *   4. Filter to only keep target-region jobs (Ticino/Grigioni)
 *   5. Build job objects; merge into data/jobs.json
 *   6. Run the base crawler for AI localization (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { parsePostJobDetail } from './lib/postch-job-parser.mjs';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const POST_KEY = 'posta-svizzera-centro-regionale';
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Two listing URLs to crawl:
 *   1. Apprenticeships (all cantons — we filter after fetching detail)
 *   2. Professionals (all cantons — we filter after fetching detail)
 */
const LISTING_URLS = [
  'https://www.post.ch/en/jobs/jobs?jobsCategory=apprenticeships',
  'https://www.post.ch/en/jobs/jobs?jobsCategory=professionals&workload-maximum=1&workload-minimum=0',
];

const POST_COMPANY_NAME = 'La Posta Svizzera';
const POST_COMPANY_HOST = 'post.ch';
const DETAIL_HOST = 'job.post.ch';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

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

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
}

/**
 * Match a job object as belonging to the Post.ch crawl.
 */
function isPostJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === POST_KEY ||
    key.includes('posta-svizzera') ||
    key.includes('swiss-post') ||
    host === 'job.post.ch' ||
    host === 'www.post.ch'
  );
}

// ──────────────────────────────────────────────────────────────
// HTML fetching
// ──────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Parsing — extract job listings from the listing pages
// ──────────────────────────────────────────────────────────────

/**
 * Parse job links from a Post.ch listing page HTML.
 * Links are absolute URLs to job.post.ch:
 *   https://job.post.ch/v2/job-vacancies/{slug}/{uuid}
 */
function parseJobLinks(html = '') {
  const jobs = [];
  const linkRe = /href="(https:\/\/job\.post\.ch\/v2\/job-vacancies\/[^"]+)"/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = match[1].replace(/&amp;/g, '&');
    // Extract UUID from URL (last path segment)
    const uuid = url.split('/').pop() || '';
    jobs.push({ url, uuid });
  }

  // Deduplicate by UUID
  const seen = new Set();
  return jobs.filter(j => {
    if (!j.uuid || seen.has(j.uuid)) return false;
    seen.add(j.uuid);
    return true;
  });
}

/**
 * Check whether a job's region indicates it's in the TI/GR target area.
 */
function isTicinoJob(detail) {
  const region = normalize(detail.region);
  const city = normalize(detail.city);
  const location = normalize(detail.location);
  return (
    isTargetSwissLocation(region) ||
    isTargetSwissLocation(city) ||
    isTargetSwissLocation(location)
  );
}

/**
 * Detect the city from the location/region fields.
 */
function detectCity(detail) {
  const city = detail.city || '';
  // Remove " / Homeoffice" suffix
  const clean = city.replace(/\s*\/\s*homeoffice/i, '').trim();
  if (clean) return clean;
  if (detail.region && detail.region.toLowerCase().includes('tessin')) return 'Bellinzona';
  return 'Bellinzona';
}

function detectCanton(city = '') {
  return inferAnyCanton(city) || 'TI';
}

function detectEmploymentType(detail) {
  const et = detail.employmentType || '';
  if (et === 'PART_TIME') return 'PART_TIME';
  if (et === 'INTERN' || et === 'INTERNSHIP') return 'INTERN';
  return 'FULL_TIME';
}

function detectSector(detail) {
  const industry = normalize(detail.industry);
  const title = normalize(detail.title);
  if (industry.includes('bank') || industry.includes('finanz') || industry.includes('finance')) return 'Finanza';
  if (industry.includes('logist') || title.includes('logist')) return 'Logistica';
  if (industry.includes('inform') || title.includes('inform') || title.includes('it ') || title.includes('ict')) return 'IT';
  if (industry.includes('consult') || industry.includes('berat')) return 'Consulenza';
  if (title.includes('apprendist') || title.includes('lehre') || title.includes('apprenti')) return 'Formazione';
  if (industry.includes('telekom') || industry.includes('kommunik')) return 'Telecomunicazioni';
  return 'Servizi Postali';
}

// ──────────────────────────────────────────────────────────────
// Main discovery flow
// ──────────────────────────────────────────────────────────────

async function fetchPostJobs() {
  console.log('📮 Fetching Swiss Post (La Posta Svizzera) job listings...');

  const allLinks = [];

  for (const listingUrl of LISTING_URLS) {
    console.log(`  📄 Listing URL: ${listingUrl}`);
    const listingHtml = await fetchPage(listingUrl, 20000);
    if (!listingHtml) {
      console.warn(`  ⚠️ Failed to fetch listing page: ${listingUrl}`);
      continue;
    }
    const links = parseJobLinks(listingHtml);
    console.log(`     Found ${links.length} job links`);
    allLinks.push(...links);
  }

  // Deduplicate across all listing pages
  const seen = new Set();
  const uniqueLinks = allLinks.filter(j => {
    if (seen.has(j.uuid)) return false;
    seen.add(j.uuid);
    return true;
  });
  console.log(`  ✅ Total unique job links: ${uniqueLinks.length}`);

  if (uniqueLinks.length === 0) {
    console.warn('⚠️ No job links found — page structure may have changed.');
    return [];
  }

  const jobs = [];
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  for (const link of uniqueLinks) {
    console.log(`  📄 Fetching detail: ${link.url}`);
    const detailHtml = await fetchPage(link.url, 15000);

    if (!detailHtml) {
      console.warn(`  ⚠️ Failed to fetch detail for ${link.uuid}`);
      continue;
    }

    const detail = parsePostJobDetail(detailHtml, link.url);

    // Filter: only keep Ticino jobs
    if (!isTicinoJob(detail)) {
      console.log(`     ↳ Skipping (not Ticino): ${detail.title} — ${detail.region || detail.city || 'unknown region'}`);
      continue;
    }

    const title = detail.title || '';
    const city = detectCity(detail);
    const canton = detectCanton(city);
    const slug = slugify(title, 'post');

    const descriptionIt = detail.description
      ? detail.description
      : `Posizione aperta presso ${POST_COMPANY_NAME}. Ruolo: ${title}. Sede: ${city}, Svizzera.`;

    const job = {
      url: link.url,
      applyUrl: link.url,
      title,
      company: detail.hiringOrg || POST_COMPANY_NAME,
      companyKey: POST_KEY,
      location: city,
      canton,
      country: 'CH',
      description: descriptionIt,
      descriptionByLocale: { it: descriptionIt },
      titleByLocale: { it: title },
      slug,
      slugByLocale: { it: slug },
      sourceLang: detectLang(descriptionIt || title, 'en'),
      department: detail.industry || '',
      category: detail.industry || 'servizi-postali',
      datePosted: detail.datePosted || new Date().toISOString().split('T')[0],
      validThrough: detail.validThrough || '',
      source: 'postch-careers-crawler',
      employmentType: detectEmploymentType(detail),
      experienceLevel: '',
      sector: detectSector(detail),
      workload: detail.workload || '',
      _targetScope: { canton, location: city },
    };

    jobs.push(job);
    console.log(`     ✅ ${title} — ${city} (${canton})`);

    // Be polite — small delay between requests
    await delay(400);
  }

  console.log(`\n📋 Total Post.ch Ticino jobs discovered: ${jobs.length}`);
  return jobs;
}

// ──────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ──────────────────────────────────────────────────────────────

/**
 * Extract UUID from a Post.ch job URL for stable deduplication.
 */
function extractUuid(url = '') {
  const parts = String(url).split('/');
  const last = parts[parts.length - 1] || '';
  // UUID format: 8-4-4-4-12 hex
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)) {
    return last.toLowerCase();
  }
  return '';
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergePostJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(POST_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonPostJobs = allJobs.filter((j) => !isPostJob(j));
  const existingPostJobs = allJobs.filter(isPostJob);

  // Build lookup by UUID
  const existingByUuid = new Map();
  for (const job of existingPostJobs) {
    const uuid = extractUuid(job.url);
    if (uuid) existingByUuid.set(uuid, job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const uuid = extractUuid(discovered.url);
    const existing = uuid ? existingByUuid.get(uuid) : null;

    if (existing) {
      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        description: discovered.description || existing.description,
        company: discovered.company || existing.company,
        companyKey: POST_KEY,
        location: discovered.location || existing.location,
        canton: discovered.canton || existing.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        url: discovered.url || existing.url,
        department: discovered.department || existing.department,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'postch-careers-crawler',
        workload: discovered.workload || existing.workload,
        titleByLocale: mergeLocaleTextMap(existing.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existing.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existing.slugByLocale, discovered.slugByLocale, 3),
      };

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  // Count removed (existing Post jobs not in discovery)
  const discoveredUuids = new Set(discoveredJobs.map(j => extractUuid(j.url)).filter(Boolean));
  for (const [uuid] of existingByUuid) {
    if (!discoveredUuids.has(uuid)) removed++;
  }

  const final = [...nonPostJobs, ...merged];

  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

// ──────────────────────────────────────────────────────────────
// Adapter configuration
// ──────────────────────────────────────────────────────────────

function updateAdapterConfig(seedUrls = []) {
  const adapterPath = path.join(ADAPTERS_DIR, `${POST_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = POST_KEY;
  adapter.companyName = POST_COMPANY_NAME;
  adapter.companyHost = POST_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html', 'jsonld'];
  adapter.seedUrls = [...LISTING_URLS, ...seedUrls];
  adapter.notes = 'Swiss Post careers portal — Ticino job listings extracted from post.ch and job.post.ch.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${POST_KEY} updated.`);
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation (for AI localization only)
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: POST_KEY,
    localizeOnlyCompanyKeys: POST_KEY,
    forceLocalizeKeys: POST_KEY,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing
// ──────────────────────────────────────────────────────────────

function postProcessPostJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isPostJob(job)) continue;

    if (job.companyKey !== POST_KEY) {
      job.companyKey = POST_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Bellinzona';
      fixed++;
    }
    if (!job.descriptionByLocale || job.descriptionByLocale.it !== job.description) {
      job.descriptionByLocale = { ...(job.descriptionByLocale || {}), it: job.description };
      fixed++;
    }
    if (!job.titleByLocale || job.titleByLocale.it !== job.title) {
      job.titleByLocale = { ...(job.titleByLocale || {}), it: job.title };
      fixed++;
    }
    if (!job.slugByLocale || job.slugByLocale.it !== job.slug) {
      job.slugByLocale = { ...(job.slugByLocale || {}), it: job.slug };
      fixed++;
    }
    if (!job.canton) {
      job.canton = detectCanton(job.location);
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Post.ch jobs (fixed company/location/canton).`);
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logPostJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const postJobs = allJobs.filter(isPostJob);

  const locations = {};
  for (const job of postJobs) {
    const loc = job.location || 'unknown';
    locations[loc] = (locations[loc] || 0) + 1;
  }

  const sectors = {};
  for (const job of postJobs) {
    const sec = job.sector || 'unknown';
    sectors[sec] = (sectors[sec] || 0) + 1;
  }

  console.log(`\n📊 === La Posta Svizzera Job Stats ===`);
  console.log(`  📮 Job totali trovati (Post.ch): ${postJobs.length}`);

  if (Object.keys(locations).length > 0) {
    console.log(`  📍 Per sede:`);
    for (const [loc, count] of Object.entries(locations).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${loc}: ${count}`);
    }
  }

  if (Object.keys(sectors).length > 0) {
    console.log(`  🏢 Per settore:`);
    for (const [sec, count] of Object.entries(sectors).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${sec}: ${count}`);
    }
  }

  console.log('');

  const afterSnapshot = snapshotJobSlugs(postJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Post.ch');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Post.ch');
  return { total: postJobs.length, crawlDiff };
}

function validatePostLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_POSTCH_STRICT',
    label: 'Post.ch',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isPostJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    minDescriptionChars: 80,
    noJobsMessage: 'No Post.ch jobs found after crawl.',
    failWhenNoJobs: true,
    sampleLimit: 25,
    maxToleratedMissingDescriptions: 8,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(POST_KEY, 'Post.ch');
  console.log('📮 Running dedicated Swiss Post (La Posta) jobs crawler...');
  console.log(`   Listing URLs:`);
  for (const url of LISTING_URLS) console.log(`     ${url}`);
  console.log('');

  // 1. Fetch and parse job listings
  const discoveredJobs = await fetchPostJobs();

  if (discoveredJobs.length === 0) {
    console.log('⚠️ No Post.ch Ticino jobs discovered from the careers portal.');
    console.log('   The page structure may have changed or be temporarily unavailable.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    logPostJobStats();
    return;
  }

  // 2. Update the adapter config with discovered job URLs as seeds
  const seedUrls = discoveredJobs.map(j => j.url);
  updateAdapterConfig(seedUrls);

  // 3. Merge discovered jobs into data/jobs.json
  await mergePostJobs(discoveredJobs);

  // Snapshot for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(POST_KEY, DATA_JOBS).filter(isPostJob))

  // 4. Run base crawler for AI localization (IT/DE/FR/EN translations)
  console.log('\n🌐 Running base crawler for AI localization of Post.ch jobs...');
  await runBaseCrawler();

  // 5. Post-process: ensure consistency
  postProcessPostJobs();

  // 6. Log stats
  const stats = logPostJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No Post.ch jobs found. Exiting OK.');
    return;
  }

  // 7. Validate locale coverage
  validatePostLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isPostJob) : [];
  writeJobsCrawlerSlice(POST_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: POST_KEY,
    label: 'Post.ch',
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

main().catch((err) => {
  console.error(`❌ Post.ch crawler failed: ${err?.message || err}`);
  process.exit(1);
});
