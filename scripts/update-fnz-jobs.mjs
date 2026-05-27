#!/usr/bin/env node
/**
 * Dedicated FNZ crawler runner.
 *
 * FNZ is a global fintech platform provider. Their Swiss operations are
 * based in Chiasso (Ticino) and Geneva.
 *
 * The FNZ careers site uses Workday (myworkdayjobs.com) with a REST API:
 *   - Listing: POST /wday/cxs/fnz/fnz_careers/jobs
 *   - Detail:  GET  /wday/cxs/fnz/fnz_careers/job/{externalPath}
 *
 * Discovery flow:
 *   1. Query Workday API for Swiss-location jobs (Chiasso + Geneva)
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const FNZ_KEY = 'fnz';
const FNZ_COMPANY_NAME = 'FNZ (Switzerland) AG';
const FNZ_COMPANY_HOST = 'fnz.wd3.myworkdayjobs.com';
const FNZ_API_BASE = 'https://fnz.wd3.myworkdayjobs.com/wday/cxs/fnz/fnz_careers';
const FNZ_PUBLIC_BASE = 'https://fnz.wd3.myworkdayjobs.com/en/fnz_careers';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Swiss location IDs in Workday (from locationMainGroup facet)
const SWISS_LOCATION_IDS = [
  '35010ebf970510015744b49951f30000', // Chiasso - Switzerland
  '7ddfe84896541000f65839218e0f0000', // Geneva - Switzerland
];

/* ── Helpers ───────────────────────────────────────────────── */

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
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
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

function isFnzJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === FNZ_KEY ||
    key === 'fnz-switzerland-ag' ||
    key.startsWith('fnz') ||
    company.includes('fnz') ||
    url.includes('fnz.wd3.myworkdayjobs.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === FNZ_COMPANY_HOST || host.endsWith('.myworkdayjobs.com');
  } catch {
    return false;
  }
}

/* ── Workday API ───────────────────────────────────────────── */

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
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
 * List all Swiss FNZ jobs via Workday API.
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

    const data = await fetchJson(`${FNZ_API_BASE}/jobs`, {
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
  return fetchJson(`${FNZ_API_BASE}${externalPath}`);
}

/* ── Location & canton mapping ─────────────────────────────── */

function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  // Format: "Chiasso - Switzerland" or "2 Locations"
  if (/\d+\s+location/i.test(cleaned)) return '';
  const parts = cleaned.split(/\s*-\s*/);
  return parts.length > 0 ? parts[0].trim() : cleaned;
}

function inferCanton(location = '') {
  const loc = normalize(location);
  if (loc.includes('chiasso')) return 'TI';
  if (loc.includes('lugano')) return 'TI';
  if (loc.includes('mendrisio')) return 'TI';
  if (loc.includes('manno')) return 'TI';
  if (loc.includes('bellinzona')) return 'TI';
  if (loc.includes('locarno')) return 'TI';
  if (loc.includes('genev') || loc.includes('genf')) return 'GE';
  if (loc.includes('zurich') || loc.includes('zürich')) return 'ZH';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  return '';
}

/* ── Job building ──────────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/engineer|developer|software|architect|devops|cloud|data|cyber|network|infrastructure/i.test(t)) return 'technology';
  if (/qa|quality|test|validation/i.test(t)) return 'quality';
  if (/analyst|business\s*analyst/i.test(t)) return 'analysis';
  if (/sales|commercial|pre.?sales|account\s*exec/i.test(t)) return 'sales';
  if (/consult|solution/i.test(t)) return 'consulting';
  if (/project|programme|program|scrum|agile/i.test(t)) return 'project-management';
  if (/legal|counsel|lawyer|compliance|regulator/i.test(t)) return 'legal';
  if (/account|financ|controller|audit/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/support|helpdesk|service\s*desk/i.test(t)) return 'support';
  if (/manag|director|head|lead|chief|vp\b/i.test(t)) return 'management';
  if (/crm|salesforce|dynamics/i.test(t)) return 'crm';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagist|apprenti|graduate/i.test(t)) return 'ENTRY';
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
  const base = descriptionText || `${title} position at FNZ in ${location}, Switzerland.`;
  return `${base}\n\nFNZ is a global fintech platform provider that partners with financial institutions, wealth managers, and asset managers. The company has Swiss operations in Chiasso (Ticino) and Geneva.`.trim();
}

function buildDescriptionIt(title, location) {
  return `Posizione aperta presso FNZ a ${location}.\nRuolo: ${title}.\n\nFNZ è un provider globale di piattaforme fintech che collabora con istituzioni finanziarie, gestori patrimoniali e asset manager. L'azienda ha sedi svizzere a Chiasso (Ticino) e Ginevra.`.trim();
}

function buildPublicUrl(externalPath) {
  return `${FNZ_PUBLIC_BASE}${externalPath}`;
}

/* ── Fetch and build all FNZ Swiss jobs ────────────────────── */

async function fetchFnzJobs() {
  console.log(`🔍 Fetching FNZ jobs from Workday API`);
  console.log(`   API: ${FNZ_API_BASE}/jobs`);
  console.log(`   Swiss locations: Chiasso (TI), Geneva (GE)\n`);

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

    // Parse location — handle "2 Locations" multi-location jobs
    let locationRaw = info.location || listing.locationsText || '';
    let city = parseWorkdayLocation(locationRaw);

    // For multi-location jobs, try to find Swiss city from additional locations
    if (!city && detail?.jobPostingInfo?.additionalLocations) {
      for (const addLoc of detail.jobPostingInfo.additionalLocations) {
        const desc = addLoc?.descriptor || '';
        if (desc.toLowerCase().includes('switzerland') || desc.toLowerCase().includes('chiasso') || desc.toLowerCase().includes('geneva')) {
          city = parseWorkdayLocation(desc);
          break;
        }
      }
    }
    if (!city) city = 'Chiasso'; // fallback to primary Swiss office

    const canton = inferCanton(city);

    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildPublicUrl(externalPath);

    const descEn = buildDescription(title, descriptionText, city);
    const descIt = buildDescriptionIt(title, city);

    const slug = slugify(title, 'fnz');
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    const job = {
      url: publicUrl,
      applyUrl: publicUrl,
      title,
      company: FNZ_COMPANY_NAME,
      companyKey: FNZ_KEY,
      location: city,
      canton,
      country: 'CH',
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
        it: slugify(title, 'fnz'),
      },
      category: detectCategory(title),
      datePosted: info.startDate || new Date().toISOString().split('T')[0],
      source: 'fnz-workday-crawler',
      sourceLang: detectLang(descEn || title, 'en'),
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Fintech / Servizi finanziari',
      _targetScope: { canton, location: city },
    };

    if (jobReqId) job.jobReqId = jobReqId;

    jobs.push(job);
  }

  console.log(`\n📋 Total unique FNZ jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge into data/jobs.json ─────────────────────────────── */

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

async function mergeFnzJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(FNZ_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonFnzJobs = allJobs.filter((j) => !isFnzJob(j));
  const existingFnzJobs = allJobs.filter(isFnzJob);

  const existingByUrl = new Map();
  for (const job of existingFnzJobs) {
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
    const existingJob = existingByUrl.get(key);

    if (existingJob) {
      const updatedJob = {
        ...existingJob,
        title: discovered.title || existingJob.title,
        company: FNZ_COMPANY_NAME,
        companyKey: FNZ_KEY,
        location: discovered.location || existingJob.location,
        canton: discovered.canton || existingJob.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existingJob.applyUrl,
        category: discovered.category || existingJob.category,
        sector: discovered.sector || existingJob.sector,
        source: 'fnz-workday-crawler',
        titleByLocale: mergeLocaleTextMap(existingJob.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existingJob.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existingJob.slugByLocale, discovered.slugByLocale, 3),
      };

      if (discovered.description && discovered.description.length > (existingJob.description || '').length) {
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
    if (!discoveredByUrl.has(url)) removed++;
  }

  const final = [...nonFnzJobs, ...merged];

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

/* ── Adapter management ────────────────────────────────────── */

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${FNZ_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = FNZ_KEY;
  adapter.companyName = FNZ_COMPANY_NAME;
  adapter.companyHost = FNZ_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['api'];
  adapter.seedUrls = [`${FNZ_PUBLIC_BASE}?locations=${SWISS_LOCATION_IDS.join('&locations=')}`];
  adapter.notes = 'Workday REST API at fnz.wd3.myworkdayjobs.com — Swiss locations (Chiasso TI + Geneva GE).';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${FNZ_KEY} updated.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: FNZ_KEY,
    localizeOnlyCompanyKeys: FNZ_KEY,
    forceLocalizeKeys: FNZ_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcessFnzJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isFnzJob(job)) continue;

    if (job.company !== FNZ_COMPANY_NAME) {
      job.company = FNZ_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== FNZ_KEY) {
      job.companyKey = FNZ_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton && job.location) {
      job.canton = inferCanton(job.location);
      if (job.canton) fixed++;
    }
    if (!job.location) {
      job.location = 'Chiasso';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} FNZ jobs (fixed company/location/canton).`);
  }
}

/* ── Stats & validation ────────────────────────────────────── */

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const fnzJobs = allJobs.filter(isFnzJob);

  console.log(`\n📊 === FNZ Job Stats ===`);
  console.log(`  🏢 Total FNZ jobs: ${fnzJobs.length}`);

  if (fnzJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of fnzJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(fnzJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'FNZ');
  writeCrawlChangeSummaryToGH(crawlDiff, 'FNZ');
  return { total: fnzJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_FNZ_STRICT',
    label: 'FNZ',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isFnzJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_fnz_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No FNZ jobs found — the company may not have active Swiss openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(FNZ_KEY, 'FNZ');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  FNZ (Switzerland) AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Workday API: ${FNZ_API_BASE}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(FNZ_KEY, DATA_JOBS).filter(isFnzJob))

  // Phase 1: Fetch jobs from Workday API
  const discoveredJobs = await fetchFnzJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No FNZ jobs discovered.');
    console.log('   The Workday API may be unreachable or have no Swiss openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeFnzJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of FNZ jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessFnzJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No FNZ jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ FNZ crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isFnzJob) : [];
  writeJobsCrawlerSlice(FNZ_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: FNZ_KEY,
    label: 'FNZ',
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
  console.error(`❌ FNZ crawler failed: ${err?.message || err}`);
  process.exit(1);
});
