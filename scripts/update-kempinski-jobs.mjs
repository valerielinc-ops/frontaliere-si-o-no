#!/usr/bin/env node
/**
 * Dedicated Grand Hotel des Bains Kempinski St. Moritz crawler runner.
 *
 * The Grand Hotel des Bains Kempinski is a luxury 5-star hotel
 * in St. Moritz (canton GR). Part of the Kempinski Hotels group.
 * Careers portal: https://careers.kempinski.com/en
 *
 * Jobs are managed via Pinpoint ATS.  The JSON API is at:
 *   GET https://kempinski.pinpointhq.com/en/postings.json
 *
 * The API returns all Kempinski jobs worldwide (200+ postings) with
 * full details: id, title, description, employment_type, location
 * (city, name, province), job (department, division, hotel/property).
 *
 * We filter by location.name containing "Switzerland" to keep only
 * Swiss positions.  St. Moritz jobs → GR, Engelberg jobs → OW.
 *
 * This crawler:
 *   1. Fetches all postings from the Pinpoint JSON API.
 *   2. Filters for Swiss locations only.
 *   3. Builds standardised job objects.
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

const COMPANY_KEY = 'grand-hotel-des-bains-kempinski';
const COMPANY_NAME = 'Grand Hotel des Bains Kempinski St. Moritz';
const COMPANY_DOMAIN = 'kempinski.com';

const API_URL = 'https://kempinski.pinpointhq.com/en/postings.json';
const CAREERS_URL = 'https://careers.kempinski.com/en';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;

// City → canton mapping for Kempinski's Swiss properties
const CITY_CANTON = {
  'st. moritz': 'GR',
  'engelberg': 'OW',
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
    key === 'kempinski-palace-engelberg' ||
    key.includes('kempinski') ||
    company.includes('kempinski') ||
    url.includes('kempinski.pinpointhq.com')
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

function detectCanton(city = '') {
  const c = city.toLowerCase().trim();
  for (const [keyword, canton] of Object.entries(CITY_CANTON)) {
    if (c.includes(keyword)) return canton;
  }
  return 'GR'; // default — Grand Hotel des Bains is the primary property
}

function stripHtml(html = '') {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapEmploymentType(pinpointType = '') {
  const t = pinpointType.toLowerCase();
  if (t.includes('part')) return 'PART_TIME';
  if (t.includes('intern')) return 'INTERN';
  if (t.includes('apprentice')) return 'APPRENTICE';
  return 'FULL_TIME';
}

function mapContractType(pinpointType = '') {
  const t = pinpointType.toLowerCase();
  if (t.includes('seasonal')) return 'seasonal';
  if (t.includes('intern')) return 'internship';
  if (t.includes('apprentice')) return 'apprenticeship';
  if (t.includes('temporary') || t.includes('fixed')) return 'fixed-term';
  return 'permanent';
}

/* ── Fetch API ─────────────────────────────────────────────── */
async function fetchAllPostings() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Build job object ──────────────────────────────────────── */
function buildJob(posting) {
  const title = (posting.title || '').trim();
  const id = posting.id;
  const url = posting.url || '';

  const location = posting.location || {};
  const city = (location.city || '').trim();
  const locationName = (location.name || '').trim();
  const canton = detectCanton(city);

  const jobData = posting.job || {};
  const department = (jobData.department || {}).name || '';
  const hotelData = jobData.structure_custom_group_one || {};
  const hotelName = (hotelData.name || '').trim();

  // Use hotel name as company for the specific property
  const company = hotelName || COMPANY_NAME;

  const slug = slugify(`${title}-${id}`);

  // Build description from available fields
  const descParts = [];
  if (posting.description) descParts.push(stripHtml(posting.description));
  if (posting.key_responsibilities) {
    const header = posting.key_responsibilities_header || 'Key Responsibilities';
    descParts.push(`${header}: ${stripHtml(posting.key_responsibilities)}`);
  }
  if (posting.skills_knowledge_expertise) {
    const header = posting.skills_knowledge_expertise_header || 'Skills & Knowledge';
    descParts.push(`${header}: ${stripHtml(posting.skills_knowledge_expertise)}`);
  }
  if (posting.benefits) {
    const header = posting.benefits_header || 'Benefits';
    descParts.push(`${header}: ${stripHtml(posting.benefits)}`);
  }
  const description = descParts.join(' | ').slice(0, 3000);

  const sourceLang = detectLang(title + ' ' + description) || 'en';
  const empType = mapEmploymentType(posting.employment_type || '');
  const contractType = mapContractType(posting.employment_type_text || '');

  return {
    title,
    slug,
    url,
    applyUrl: url,
    company,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: 'Turismo & Ospitalità',
    sector: 'Hotellerie & Gastronomia',
    department,
    source: 'kempinski-dedicated-crawler',
    sourceLang,
    postedDate: posting.deadline_at || new Date().toISOString().slice(0, 10),
    validThrough: '',
    employmentType: empType,
    contractType,
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

  const byHotel = {};
  const byDept = {};
  const byType = {};
  const byCanton = {};
  for (const j of jobs) {
    const hotel = j.company || '?';
    const dept = j.department || 'N/A';
    const ct = j.contractType || 'N/A';
    const can = j.canton || '?';
    byHotel[hotel] = (byHotel[hotel] || 0) + 1;
    byDept[dept] = (byDept[dept] || 0) + 1;
    byType[ct] = (byType[ct] || 0) + 1;
    byCanton[can] = (byCanton[can] || 0) + 1;
  }

  console.log(`\n📊 === Kempinski Switzerland Job Stats ===`);
  console.log(`  🏨 Total Swiss jobs: ${jobs.length}`);
  console.log(`  📍 By property:`);
  for (const [h, count] of Object.entries(byHotel).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${h}: ${count}`);
  }
  console.log(`  🗺️  By canton:`);
  for (const [c, count] of Object.entries(byCanton).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${c}: ${count}`);
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
    strictEnvVar: 'JOBS_KEMPINSKI_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    noJobsMessage: 'No Kempinski Switzerland jobs found after crawl.',
    maxToleratedMissingDescriptions: 15,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'kempinski');
  console.log('🏨 Running dedicated Kempinski Switzerland crawler...');
  console.log(`   API: ${API_URL}`);
  console.log(`   Filter: Switzerland locations only`);
  console.log('');

  // Step 1: Fetch all postings from Pinpoint API
  console.log('📥 Fetching all Kempinski postings from Pinpoint API...');
  const allPostings = await fetchAllPostings();
  console.log(`📋 Total Kempinski postings worldwide: ${allPostings.length}`);

  // Step 2: Filter for Switzerland
  const swissPostings = allPostings.filter((p) => {
    const locName = ((p.location || {}).name || '').toLowerCase();
    return locName.includes('switzerland');
  });
  console.log(`🇨🇭 Swiss postings: ${swissPostings.length}`);

  if (swissPostings.length === 0) {
    console.log('ℹ️ No Swiss jobs found. Exiting OK.');
    return;
  }

  // Step 3: Build job objects
  const jobs = swissPostings.map(buildJob);
  console.log(`✅ Built ${jobs.length} job objects`);

  // Log location breakdown
  const locations = {};
  for (const j of jobs) {
    const loc = `${j.company} (${j.location}, ${j.canton})`;
    locations[loc] = (locations[loc] || 0) + 1;
  }
  for (const [loc, count] of Object.entries(locations).sort((a, b) => b[1] - a[1])) {
    console.log(`   📍 ${loc}: ${count}`);
  }

  // Step 4: Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  console.log(`\n📦 Merge complete: ${total} total, ${added} added, ${updated} updated`);

  // Step 5: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Step 6: Stats + validation
  logStats();
  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'kempinski',
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
  console.error(`❌ Kempinski crawler failed: ${err?.message || err}`);
  process.exit(1);
});
