#!/usr/bin/env node
/**
 * Dedicated Bracco Suisse S.A. crawler runner.
 *
 * Bracco Group is an Italian multinational in healthcare/diagnostic imaging.
 * Bracco Suisse S.A. has offices in Cadempino (Ticino) and Plan-les-Ouates (Geneva).
 *
 * The Bracco careers site uses Workday (myworkdayjobs.com) with a REST API:
 *   - Listing: POST /wday/cxs/bracco/BraccoCareers/jobs
 *   - Detail:  GET  /wday/cxs/bracco/BraccoCareers/job/{externalPath}
 *
 * Discovery flow:
 *   1. Query Workday API for Swiss-location jobs (Cadempino + Plan-les-Ouates)
 *   2. Fetch full job detail for each listing
 *   3. Build job objects with canonical Workday URLs
 *   4. Merge into data/jobs.json (add new, update existing, prune stale)
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang, mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const BRACCO_KEY = 'bracco';
const BRACCO_COMPANY_NAME = 'Bracco Suisse S.A.';
const BRACCO_COMPANY_HOST = 'bracco.wd103.myworkdayjobs.com';
const BRACCO_API_BASE = 'https://bracco.wd103.myworkdayjobs.com/wday/cxs/bracco/BraccoCareers';
const BRACCO_PUBLIC_BASE = 'https://bracco.wd103.myworkdayjobs.com/it-IT/BraccoCareers';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Swiss location IDs in Workday
const SWISS_LOCATION_IDS = [
  '9f72af9e9f0e1008c408607b37a00000', // CHE - Plan-les-Ouates
  '9f72af9e9f0e1008c40856e1a7d40000', // CHE - Cadempino
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
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

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isBraccoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === BRACCO_KEY ||
    key === 'bracco-suisse-s-a' ||
    key.startsWith('bracco') ||
    company.includes('bracco') ||
    url.includes('bracco.wd103.myworkdayjobs.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === BRACCO_COMPANY_HOST || host.endsWith('.myworkdayjobs.com');
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Workday API
// ─────────────────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        ...options.headers,
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * List all Swiss Bracco jobs via Workday API.
 * Uses pagination (limit/offset) in case there are more than 20.
 */
async function listSwissJobs() {
  const allPostings = [];
  let offset = 0;
  const limit = 20;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: { locations: SWISS_LOCATION_IDS },
      limit,
      offset,
      searchText: '',
    });

    const data = await fetchJson(`${BRACCO_API_BASE}/jobs`, {
      method: 'POST',
      body,
    });

    if (!data || !Array.isArray(data.jobPostings)) {
      if (offset === 0) console.warn('⚠️ Failed to fetch Workday listings.');
      break;
    }

    allPostings.push(...data.jobPostings);

    if (allPostings.length >= (data.total || 0) || data.jobPostings.length < limit) {
      break;
    }
    offset += limit;
  }

  return allPostings;
}

/**
 * Fetch full detail for a single job via Workday API.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${BRACCO_API_BASE}${externalPath}`);
}

// ─────────────────────────────────────────────────────────────
// Location & canton mapping
// ─────────────────────────────────────────────────────────────

function parseWorkdayLocation(locText = '') {
  // Format: "CHE - Cadempino" or "CHE - Plan-les-Ouates"
  const cleaned = String(locText || '').trim();
  const parts = cleaned.split(/\s*-\s*/);
  // last part is the city
  const city = parts.length > 1 ? parts.slice(1).join('-').trim() : cleaned;
  return city || cleaned;
}

function inferCanton(location = '') {
  const loc = normalize(location);
  if (loc.includes('cadempino')) return 'TI';
  if (loc.includes('plan-les-ouates') || loc.includes('plan les ouates')) return 'GE';
  if (loc.includes('lugano')) return 'TI';
  if (loc.includes('manno')) return 'TI';
  if (loc.includes('bellinzona')) return 'TI';
  if (loc.includes('locarno')) return 'TI';
  if (loc.includes('mendrisio')) return 'TI';
  if (loc.includes('chiasso')) return 'TI';
  if (loc.includes('genev') || loc.includes('genf')) return 'GE';
  if (loc.includes('zurich') || loc.includes('zürich')) return 'ZH';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  return '';
}

// ─────────────────────────────────────────────────────────────
// Job building
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/engineer|developer|software|it\b|system|data|devops|cyber|network/i.test(t)) return 'technology';
  if (/qa|quality|validation|compliance|regulator/i.test(t)) return 'quality';
  if (/scientist|research|r&d|laboratory|lab\b|clinical/i.test(t)) return 'science';
  if (/produc|manufactur|operator|technic/i.test(t)) return 'production';
  if (/sales|commercial|marketing|brand|communication/i.test(t)) return 'sales';
  if (/legal|counsel|lawyer/i.test(t)) return 'legal';
  if (/account|financ|controller|audit/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/logistic|supply|warehouse|procurement|buyer/i.test(t)) return 'logistics';
  if (/field\s*service|service\s*tech|maintenance|install/i.test(t)) return 'service';
  if (/manag|director|head|lead|chief|vp\b/i.test(t)) return 'management';
  if (/improv|lean|continuous|optimi/i.test(t)) return 'operations';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagist|apprenti/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (t.includes('full')) return 'FULL_TIME';
  if (t.includes('part')) return 'PART_TIME';
  return 'FULL_TIME';
}

function buildDescription(title, descriptionText, location) {
  const base = descriptionText || `${title} position at Bracco Suisse S.A. in ${location}, Switzerland.`;
  return `${base}\n\nBracco Suisse S.A. is part of the Bracco Group, an international leader in diagnostic imaging and healthcare. The company operates in Switzerland with offices in Cadempino (Ticino) and Plan-les-Ouates (Geneva).`.trim();
}

function buildDescriptionIt(title, location) {
  return `Posizione aperta presso Bracco Suisse S.A. a ${location}.\nRuolo: ${title}.\n\nBracco Suisse S.A. fa parte del Gruppo Bracco, leader internazionale nell'imaging diagnostico e nella sanità. L'azienda opera in Svizzera con sedi a Cadempino (Ticino) e Plan-les-Ouates (Ginevra).`.trim();
}

/**
 * Build a canonical public URL for a Workday job.
 * Format: https://bracco.wd103.myworkdayjobs.com/it-IT/BraccoCareers/job/{path}
 */
function buildPublicUrl(externalPath) {
  // externalPath is like "/job/CHE---Cadempino/FIELD-SERVICE-TECHNICIAN_"
  return `${BRACCO_PUBLIC_BASE}${externalPath}`;
}

// ─────────────────────────────────────────────────────────────
// Fetch and build all Bracco Swiss jobs
// ─────────────────────────────────────────────────────────────

async function fetchBraccoJobs() {
  console.log(`🔍 Fetching Bracco Suisse S.A. jobs from Workday API`);
  console.log(`   API: ${BRACCO_API_BASE}/jobs`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned from Workday API.');
    return [];
  }

  console.log(`  📋 Swiss job listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);

    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) {
      console.log(`  ⏭️  Skipped — empty title`);
      continue;
    }

    const locationRaw = info.location || listing.locationsText || '';
    const city = parseWorkdayLocation(locationRaw);
    const canton = inferCanton(city);
    const country = info.country?.descriptor === 'Switzerland' ? 'CH' : 'CH';

    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildPublicUrl(externalPath);

    const descEn = buildDescription(title, descriptionText, city);
    const descIt = buildDescriptionIt(title, city);

    const slug = slugify(title, 'bracco-suisse');
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    const job = {
      url: publicUrl,
      applyUrl: publicUrl,
      title,
      company: BRACCO_COMPANY_NAME,
      companyKey: BRACCO_KEY,
      location: city,
      canton,
      country,
      description: descEn,
      descriptionByLocale: {
        en: descEn,
        it: descIt,
      },
      titleByLocale: {
        en: title,
      },
      slug,
      slugByLocale: {
        en: slug,
        it: slugify(title, 'bracco-suisse'),
      },
      category: detectCategory(title),
      datePosted: info.startDate || new Date().toISOString().split('T')[0],
      source: 'bracco-workday-crawler',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sourceLang: detectLang(descEn || title, 'en'),
      sector: 'Healthcare / Imaging diagnostico',
      _targetScope: { canton, location: city },
    };

    if (jobReqId) {
      job.jobReqId = jobReqId;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total unique Bracco jobs discovered: ${jobs.length}`);
  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ─────────────────────────────────────────────────────────────

function canonicalizeUrl(url = '') {
  try {
    return new URL(url).href.replace(/\/$/, '').toLowerCase();
  } catch {
    return normalize(url);
  }
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeBraccoJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(BRACCO_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonBraccoJobs = allJobs.filter((j) => !isBraccoJob(j));
  const existingBraccoJobs = allJobs.filter(isBraccoJob);

  const existingByUrl = new Map();
  for (const job of existingBraccoJobs) {
    existingByUrl.set(canonicalizeUrl(job.url), job);
  }

  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) {
    discoveredByUrl.set(canonicalizeUrl(job.url), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const existing = existingByUrl.get(key);

    if (existing) {
      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        company: BRACCO_COMPANY_NAME,
        companyKey: BRACCO_KEY,
        location: discovered.location || existing.location,
        canton: discovered.canton || existing.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'bracco-workday-crawler',
        titleByLocale: mergeLocaleTextMap(existing.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existing.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existing.slugByLocale, discovered.slugByLocale, 3),
      };

      if (discovered.description && discovered.description.length > (existing.description || '').length) {
        updatedJob.description = discovered.description;
      }

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  for (const [url] of existingByUrl) {
    if (!discoveredByUrl.has(url)) {
      removed++;
    }
  }

  const final = [...nonBraccoJobs, ...merged];

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

// ─────────────────────────────────────────────────────────────
// Adapter management
// ─────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${BRACCO_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = BRACCO_KEY;
  adapter.companyName = BRACCO_COMPANY_NAME;
  adapter.companyHost = BRACCO_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['api'];
  adapter.seedUrls = [`${BRACCO_PUBLIC_BASE}?locations=${SWISS_LOCATION_IDS.join('&locations=')}`];
  adapter.notes = 'Workday REST API at bracco.wd103.myworkdayjobs.com — Swiss locations (Cadempino TI + Plan-les-Ouates GE).';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${BRACCO_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: BRACCO_KEY,
    localizeOnlyCompanyKeys: BRACCO_KEY,
    forceLocalizeKeys: BRACCO_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessBraccoJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isBraccoJob(job)) continue;

    if (job.company !== BRACCO_COMPANY_NAME) {
      job.company = BRACCO_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== BRACCO_KEY) {
      job.companyKey = BRACCO_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton && job.location) {
      job.canton = inferCanton(job.location);
      if (job.canton) fixed++;
    }
    if (!job.location) {
      job.location = 'Cadempino';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Bracco jobs (fixed company/location/canton).`);
  }
}

// ─────────────────────────────────────────────────────────────
// Stats & validation
// ─────────────────────────────────────────────────────────────

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const braccoJobs = allJobs.filter(isBraccoJob);

  console.log(`\n📊 === Bracco Suisse S.A. Job Stats ===`);
  console.log(`  🏢 Total Bracco jobs: ${braccoJobs.length}`);

  if (braccoJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of braccoJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(braccoJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Bracco Suisse');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Bracco Suisse');
  return { total: braccoJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BRACCO_STRICT',
    label: 'Bracco Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isBraccoJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_bracco_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Bracco Suisse jobs found — the company may not have active Swiss openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(BRACCO_KEY, 'Bracco Suisse');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Bracco Suisse S.A. — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Workday API: ${BRACCO_API_BASE}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(BRACCO_KEY, DATA_JOBS).filter(isBraccoJob))

  // Phase 1: Fetch jobs from Workday API
  const discoveredJobs = await fetchBraccoJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Bracco jobs discovered.');
    console.log('   The Workday API may be unreachable or have no Swiss openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeBraccoJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Bracco jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessBraccoJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Bracco jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Bracco Suisse S.A. crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isBraccoJob) : [];
  writeJobsCrawlerSlice(BRACCO_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: BRACCO_KEY,
    label: 'Bracco Suisse',
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
  console.error(`❌ Bracco Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
