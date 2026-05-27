#!/usr/bin/env node
/**
 * Dedicated Hamilton Bonaduz AG crawler runner.
 *
 * Hamilton is a leading high-tech company in the life science sector,
 * headquartered in Bonaduz and Domat/Ems (canton GR).
 * Careers portal: https://jobs.hamilton.ch/en/open-positions/
 *
 * Jobs are managed via Workday ATS.  The external API is at:
 *   POST https://hamilton.wd3.myworkdayjobs.com/wday/cxs/hamilton/hamilton_jobs/jobs
 * Body: { appliedFacets, limit, offset, searchText }
 *
 * The API returns up to 20 jobs per page with: title, externalPath,
 * locationsText, bulletFields (jobId + department).
 * Detail endpoint (GET):
 *   https://hamilton.wd3.myworkdayjobs.com/wday/cxs/hamilton/hamilton_jobs{externalPath}
 *
 * We filter by locationCountry = Switzerland to keep only Swiss positions.
 *
 * This crawler:
 *   1. Paginates through the Workday API (country filter = Switzerland).
 *   2. Fetches detail pages for each job to get description & dates.
 *   3. Builds standardised job objects (all Swiss jobs are in GR canton).
 *   4. Merges into data/jobs.json.
 *   5. Translates missing locales.
 */
import fs from 'node:fs';
import path from 'node:path';
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const COMPANY_KEY = 'hamilton-bonaduz-ag';
const COMPANY_NAME = 'Hamilton Bonaduz AG';
const COMPANY_DOMAIN = 'hamilton.ch';

const API_URL = 'https://hamilton.wd3.myworkdayjobs.com/wday/cxs/hamilton/hamilton_jobs/jobs';
const DETAIL_BASE = 'https://hamilton.wd3.myworkdayjobs.com/wday/cxs/hamilton/hamilton_jobs';
const CAREERS_URL = 'https://jobs.hamilton.ch/en/open-positions/';
const JOB_URL_BASE = 'https://hamilton.wd3.myworkdayjobs.com/en-US/hamilton_jobs';

// Workday locationCountry facet ID for Switzerland
const SWITZERLAND_FACET_ID = '187134fccb084a0ea9b4b95f23890dbe';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
const PAGE_SIZE = 20; // Workday API max

// Location → canton mapping for Hamilton's Swiss sites
const LOCATION_CANTON = {
  bonaduz: 'GR',
  'domat/ems': 'GR',
  'home office switzerland': 'GR', // HQ region
};

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
    key.startsWith('hamilton') ||
    company.includes('hamilton') ||
    url.includes('hamilton.wd3.myworkdayjobs.com') ||
    url.includes('jobs.hamilton.ch')
  );
}

function jobMatchKey(job) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectCanton(locationText = '') {
  const loc = locationText.toLowerCase().trim();
  for (const [keyword, canton] of Object.entries(LOCATION_CANTON)) {
    if (loc.includes(keyword)) return canton;
  }
  return 'GR'; // default for Hamilton (all Swiss offices in GR)
}

function parseWorkload(title = '') {
  const m = title.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (m) return `${m[1]}-${m[2]}%`;
  const m2 = title.match(/(\d+)\s*%/);
  if (m2) return `${m2[1]}%`;
  return '';
}

/* ── Workday API fetch ─────────────────────────────────────── */
async function fetchJobsPage(offset = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        appliedFacets: {
          locationCountry: [SWITZERLAND_FACET_ID],
        },
        limit: PAGE_SIZE,
        offset,
        searchText: '',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchJobDetail(externalPath) {
  const url = `${DETAIL_BASE}${externalPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/* ── Fetch all Swiss jobs ─────────────────────────────────── */
async function fetchAllSwissJobs() {
  const allJobs = [];
  let offset = 0;
  let total = null;

  while (true) {
    console.log(`   📄 Fetching offset=${offset}...`);
    const data = await fetchJobsPage(offset);
    const postings = data.jobPostings || [];

    if (total === null) {
      total = data.total || 0;
      console.log(`   📊 Total Swiss jobs reported: ${total}`);
    }

    if (postings.length === 0) break;

    for (const posting of postings) {
      allJobs.push(posting);
    }

    offset += postings.length;
    if (offset >= (total || allJobs.length)) break;
    await sleep(500);
  }

  return allJobs;
}

/* ── Build job object ──────────────────────────────────────── */
function buildJob(listing, detail) {
  const title = (listing.title || '').trim();
  const locationText = (listing.locationsText || '').trim();
  const bulletFields = listing.bulletFields || [];
  const jobId = bulletFields[0] || '';
  const department = bulletFields[1] || '';
  const externalPath = listing.externalPath || '';

  const detailUrl = `${JOB_URL_BASE}${externalPath}`;
  const slug = slugify(`${title}-${jobId}`);
  const canton = detectCanton(locationText);

  // Extract city from location text (handle "2 Locations", etc.)
  let city = locationText;
  if (/^\d+\s+Locations?$/i.test(locationText)) {
    // Multi-location: try detail page for primary location
    city = detail?.jobPostingInfo?.location || 'Bonaduz';
  }

  // Detail page data
  const info = detail?.jobPostingInfo || {};
  const postedDate = info.startDate || new Date().toISOString().slice(0, 10);
  const endDate = info.endDate || '';
  const timeType = info.timeType || 'Full time';
  const rawDescription = info.jobDescription || '';

  // Clean HTML from description.
  // Convert structural tags (<li>, <p>, <br>, <h*>) to newline markers BEFORE
  // stripping the rest, so the audit's "^\s*[-•*]\s/m" detector can see the
  // bullet structure. Replacing \s+ → ' ' here flattened the markers and
  // tripped the no-structured-content ratchet. Preserve \n explicitly.
  const description = rawDescription
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n[^\S\n]+/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 3000);

  const sourceLang = detectLang(title + ' ' + description) || 'de';
  const workload = parseWorkload(title);

  // Employment type
  let employmentType = 'FULL_TIME';
  if (workload) {
    const match = workload.match(/(\d+)/);
    if (match && Number(match[1]) < 80) employmentType = 'PART_TIME';
  }

  // Contract type from bulletFields / workerSubType
  let contractType = 'permanent';
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('intern') || lowerTitle.includes('praktikum')) {
    contractType = 'internship';
  } else if (lowerTitle.includes('apprentice') || lowerTitle.includes('lehre') || lowerTitle.includes('schnupperlehre')) {
    contractType = 'apprenticeship';
  }

  // Category mapping based on department
  const sectorMap = {
    robotics: 'Robotica & Automazione',
    'process analytics': 'Chimica & Analisi',
    storage: 'Logistica & Magazzino',
    'shared services': 'Servizi Aziendali',
    ict: 'Informatica & Tecnologia',
    'robotics direct sales': 'Vendite & Commerciale',
  };
  const deptLower = department.toLowerCase();
  const sector = sectorMap[deptLower] || 'Life Science & Tecnologia Medica';

  return {
    title,
    slug,
    url: detailUrl,
    applyUrl: detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: sector,
    sector,
    department: department || '',
    source: 'hamilton-dedicated-crawler',
    sourceLang,
    postedDate,
    validThrough: endDate,
    employmentType,
    contractType,
    workload,
    description,
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
    crawledAt: new Date().toISOString(),
  };
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

  const byLocation = {};
  const byDept = {};
  const byType = {};
  for (const j of jobs) {
    const loc = j.location || 'Unknown';
    const dept = j.department || 'N/A';
    const ct = j.contractType || 'N/A';
    byLocation[loc] = (byLocation[loc] || 0) + 1;
    byDept[dept] = (byDept[dept] || 0) + 1;
    byType[ct] = (byType[ct] || 0) + 1;
  }

  console.log(`\n📊 === Hamilton Bonaduz AG Job Stats ===`);
  console.log(`  🏭 Total Swiss jobs: ${jobs.length}`);
  console.log(`  📍 By location:`);
  for (const [loc, count] of Object.entries(byLocation).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${loc}: ${count}`);
  }
  console.log(`  🏢 By department:`);
  for (const [dept, count] of Object.entries(byDept).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`      ${dept}: ${count}`);
  }
  console.log(`  📋 By contract type:`);
  for (const [ct, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${ct}: ${count}`);
  }
  console.log('');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_HAMILTON_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    noJobsMessage: 'No Hamilton Bonaduz AG jobs found after crawl.',
    maxToleratedMissingDescriptions: 15,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'hamilton');
  console.log('🏭 Running dedicated Hamilton Bonaduz AG crawler...');
  console.log(`   API: ${API_URL}`);
  console.log(`   Filter: Switzerland only`);
  console.log('');

  // Step 1: Fetch all Swiss jobs from Workday API
  console.log('📥 Fetching Swiss job listings from Workday API...');
  const listings = await fetchAllSwissJobs();
  console.log(`📋 Found ${listings.length} Swiss job listings`);

  if (listings.length === 0) {
    console.log('ℹ️ No Swiss jobs found. Exiting OK.');
    return;
  }

  // Step 2: Fetch detail pages for each job
  console.log('\n📥 Fetching job details...');
  const jobs = [];
  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const title = listing.title || '';
    process.stdout.write(`   [${i + 1}/${listings.length}] ${title.slice(0, 50)}...`);

    const detail = await fetchJobDetail(listing.externalPath);
    if (detail) {
      process.stdout.write(' ✓\n');
    } else {
      process.stdout.write(' ⚠️ (no detail)\n');
    }

    jobs.push(buildJob(listing, detail));
    if (i < listings.length - 1) await sleep(300);
  }

  console.log(`\n✅ Built ${jobs.length} job objects`);

  // Log location breakdown
  const locations = {};
  for (const j of jobs) {
    const loc = j.location;
    locations[loc] = (locations[loc] || 0) + 1;
  }
  for (const [loc, count] of Object.entries(locations).sort((a, b) => b[1] - a[1])) {
    console.log(`   📍 ${loc}: ${count}`);
  }

  // Step 3: Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  console.log(`\n📦 Merge complete: ${total} total, ${added} added, ${updated} updated`);

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Step 5: Stats + validation
  logStats();
  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'hamilton',
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
  console.error(`❌ Hamilton crawler failed: ${err?.message || err}`);
  process.exit(1);
});
