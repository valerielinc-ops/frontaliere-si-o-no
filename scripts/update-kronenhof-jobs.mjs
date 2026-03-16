#!/usr/bin/env node
/**
 * Dedicated Grand Hotel Kronenhof / Kulm Group crawler runner.
 *
 * The Kulm Group operates luxury hotels in the Engadin (GR):
 *   - Grand Hotel Kronenhof (Pontresina)
 *   - Kulm Hotel (St. Moritz)
 * Careers portal: https://careers.kronenhof.com/en/vacancies
 *
 * The site exposes a paginated JSON API at:
 *   https://careers.kronenhof.com/en/vacancies/json?page=N
 * Each page returns up to 10 jobs with: id, title, location,
 * contract_duration, contract_starts_at, workload.
 *
 * This crawler:
 *   1. Paginates through the JSON API to collect all vacancies.
 *   2. Builds standardized job objects (all are in GR canton).
 *   3. Merges into data/jobs.json.
 *   4. Translates missing locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
} from './jobs-url-helper.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const COMPANY_KEY = 'grand-hotel-kronenhof';
const COMPANY_NAME = 'Grand Hotel Kronenhof';
const COMPANY_DOMAIN = 'kronenhof.com';

const API_BASE = 'https://careers.kronenhof.com/en/vacancies/json';
const CAREERS_URL = 'https://careers.kronenhof.com/en/vacancies';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)';
const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

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
    key === 'kulm-hotel' ||
    key.includes('kronenhof') ||
    key.includes('kulm-group') ||
    company.includes('kronenhof') ||
    company.includes('kulm hotel') ||
    company.includes('kulm group') ||
    url.includes('kronenhof.com') ||
    url.includes('kulm.com')
  );
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

/* ── Fetch API ─────────────────────────────────────────────── */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Paginate through the JSON API to collect all vacancies.
 */
async function fetchAllVacancies() {
  const allJobs = [];
  let page = 1;
  let lastPage = 1;

  do {
    const url = `${API_BASE}?page=${page}`;
    console.log(`  📥 Fetching page ${page}/${lastPage}: ${url}`);
    const response = await fetchJson(url);

    if (response.data && Array.isArray(response.data)) {
      allJobs.push(...response.data);
    }

    lastPage = response.meta?.last_page || 1;
    page++;
  } while (page <= lastPage);

  return allJobs;
}

/* ── Build Job Objects ─────────────────────────────────────── */

/** Map location string to city and company name. */
function mapLocation(rawLocation = '') {
  const loc = rawLocation.trim();
  if (loc.toLowerCase().includes('kronenhof')) {
    return { city: 'Pontresina', company: 'Grand Hotel Kronenhof' };
  }
  if (loc.toLowerCase().includes('kulm')) {
    return { city: 'St. Moritz', company: 'Kulm Hotel St. Moritz' };
  }
  return { city: 'Pontresina', company: COMPANY_NAME };
}

/** Map contract_duration to employment/contract type. */
function mapContractType(duration = '') {
  switch (duration) {
    case 'indefinite': return { employmentType: 'full-time', contractType: 'permanent' };
    case 'seasonal': return { employmentType: 'full-time', contractType: 'seasonal' };
    case '10-months': return { employmentType: 'full-time', contractType: 'fixed-term' };
    case '6-months': return { employmentType: 'full-time', contractType: 'fixed-term' };
    default: return { employmentType: 'full-time', contractType: duration || 'seasonal' };
  }
}

function buildJob(raw) {
  const title = String(raw.title || '').trim();
  const { city, company } = mapLocation(raw.location);
  const { employmentType, contractType } = mapContractType(raw.contract_duration);
  const slug = slugify(`${title}-${company}-${city}`);
  const detailUrl = `${CAREERS_URL}#job-${raw.id}`;
  const postedDate = raw.contract_starts_at
    ? raw.contract_starts_at.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const sourceLang = detectLang(title, 'de');
  const workload = raw.workload ? `${raw.workload}%` : '100%';

  // Build a description from available data
  const durationLabel = {
    'indefinite': 'Unbefristet / Permanent',
    'seasonal': 'Saisonstelle / Seasonal',
    '10-months': '10-Monats-Stelle / 10-month contract',
    '6-months': '6-Monats-Stelle / 6-month contract',
  }[raw.contract_duration] || raw.contract_duration || 'Seasonal';

  const description = [
    `${title} — ${company}, ${city} (Engadin, Graubünden).`,
    `Pensum: ${workload}. Vertrag: ${durationLabel}.`,
    raw.contract_starts_at ? `Stellenantritt: ${raw.contract_starts_at.slice(0, 10)}.` : '',
    `Bewerbungen an: people@kulmgroup.com oder über ${CAREERS_URL}`,
  ].filter(Boolean).join(' ');

  return {
    title,
    slug,
    url: detailUrl,
    applyUrl: CAREERS_URL,
    company,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: 'GR',
    addressCountry: 'CH',
    canton: 'GR',
    country: 'CH',
    category: 'Turismo & Ospitalità',
    sector: 'Hotellerie & Gastronomia',
    source: 'kronenhof-dedicated-crawler',
    sourceLang,
    postedDate,
    validThrough: '',
    employmentType,
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
  const existing = readJson(DATA_JOBS, []);
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
      titleByLocale: { ...(prev.titleByLocale || {}), ...(job.titleByLocale || {}) },
      descriptionByLocale: { ...(prev.descriptionByLocale || {}), ...(job.descriptionByLocale || {}) },
      slugByLocale: { ...(prev.slugByLocale || {}), ...(job.slugByLocale || {}) },
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

  return { total: mergedTarget.length, added, updated };
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats() {
  const allJobs = readJson(DATA_JOBS, []);
  const jobs = allJobs.filter(isTargetJob);
  const kronenhof = jobs.filter((j) => normalize(j.company).includes('kronenhof'));
  const kulm = jobs.filter((j) => normalize(j.company).includes('kulm'));

  console.log(`\n📊 === Kronenhof / Kulm Group Job Stats ===`);
  console.log(`  🏨 Total jobs: ${jobs.length}`);
  console.log(`  ✅ Grand Hotel Kronenhof: ${kronenhof.length}`);
  console.log(`  ✅ Kulm Hotel St. Moritz: ${kulm.length}`);
  console.log(`  📍 All in canton GR (Engadin)`);
  console.log('');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_KRONENHOF_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    noJobsMessage: 'No Kronenhof / Kulm Group jobs found after crawl.',
    maxToleratedMissingDescriptions: 10,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  console.log('🏨 Running dedicated Grand Hotel Kronenhof crawler...');
  console.log(`   API: ${API_BASE}`);
  console.log('');

  // Step 1: Fetch all vacancies via paginated API
  console.log('📥 Fetching vacancies from JSON API...');
  const allVacancies = await fetchAllVacancies();
  console.log(`📋 Found ${allVacancies.length} total vacancies`);

  if (allVacancies.length === 0) {
    console.log('ℹ️ No vacancies found. Exiting OK.');
    return;
  }

  // Step 2: Build standardized job objects
  const jobs = allVacancies.map(buildJob);
  console.log(`✅ Built ${jobs.length} job objects`);

  // Log location breakdown
  const locations = {};
  for (const j of jobs) {
    const loc = j.company;
    locations[loc] = (locations[loc] || 0) + 1;
  }
  for (const [loc, count] of Object.entries(locations)) {
    console.log(`   📍 ${loc}: ${count}`);
  }

  // Step 3: Merge into jobs.json
  const { total, added, updated } = mergeJobs(jobs);
  console.log(`\n📦 Merge complete: ${total} total, ${added} added, ${updated} updated`);

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Step 5: Stats + validation
  logStats();
  validateLocaleCoverage();
}

main().catch((err) => {
  console.error(`❌ Kronenhof crawler failed: ${err?.message || err}`);
  process.exit(1);
});
