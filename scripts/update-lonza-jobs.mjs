#!/usr/bin/env node
/**
 * Dedicated Lonza crawler runner.
 *
 * Lonza is a global pharma/biotech company headquartered in Basel,
 * with major operations in Visp (Canton Valais, VS).
 *
 * The Lonza careers site uses Workday (myworkdayjobs.com) with a REST API:
 *   - Listing: POST /wday/cxs/lonza/Lonza_Careers/jobs
 *   - Detail:  GET  /wday/cxs/lonza/Lonza_Careers/job/{externalPath}
 *
 * Discovery flow:
 *   1. Query Workday API for Swiss-location jobs (locationCountry facet)
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
import { inferSwissTargetCanton } from './lib/target-swiss-locations.mjs';
import { isTargetCanton, TARGET_CANTONS, COMPANY_HQ } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const LONZA_KEY = 'lonza';
const LONZA_COMPANY_NAME = 'Lonza';
const LONZA_HOST = 'lonza.wd3.myworkdayjobs.com';
const LONZA_COMPANY_DOMAIN = 'lonza.com';
const LONZA_API_BASE = 'https://lonza.wd3.myworkdayjobs.com/wday/cxs/lonza/Lonza_Careers';
const LONZA_PUBLIC_BASE = 'https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Switzerland country ID in Workday (from locationCountry facet)
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

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
  return s.slice(0, 90);
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

function isLonzaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === LONZA_KEY ||
    key.startsWith('lonza') ||
    company.includes('lonza') ||
    url.includes('lonza.wd3.myworkdayjobs.com') ||
    url.includes('lonza.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === LONZA_HOST || host.endsWith('.lonza.com') || host.endsWith('.myworkdayjobs.com');
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
        'Accept-Language': 'en,de-CH;q=0.9',
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
 * List all Swiss Lonza jobs via Workday API.
 * Uses locationCountry facet to filter Switzerland, with pagination.
 */
async function listSwissJobs() {
  const allPostings = [];
  let offset = 0;
  const limit = 20;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: { locationCountry: SWISS_LOCATION_IDS },
      limit,
      offset,
      searchText: '',
    });

    const data = await fetchJson(`${LONZA_API_BASE}/jobs`, {
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

    // Small delay between pages to be respectful
    if (data.jobPostings.length === limit) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return allPostings;
}

/**
 * Fetch full detail for a single job via Workday API.
 */
async function fetchJobDetail(externalPath) {
  return fetchJson(`${LONZA_API_BASE}${externalPath}`);
}

/* ── Location & canton mapping ─────────────────────────────── */

function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  // Format: "Visp - Switzerland" or "2 Locations"
  if (/\d+\s+location/i.test(cleaned)) return '';
  const parts = cleaned.split(/\s*-\s*/);
  return parts.length > 0 ? parts[0].trim() : cleaned;
}

/**
 * Infer canton from location text.
 * Uses inferSwissTargetCanton() for generic canton detection,
 * with fallback to Visp (VS) as Lonza's primary Swiss HQ.
 */
function inferCanton(location = '') {
  const canton = inferSwissTargetCanton(location);
  if (canton) return canton;

  // Additional Lonza-specific location mappings
  const loc = normalize(location);
  if (loc.includes('visp') || loc.includes('viège')) return 'VS';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('stein')) return 'AG';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('zürich') || loc.includes('zurich')) return 'ZH';
  if (loc.includes('genev') || loc.includes('genf')) return 'GE';

  return '';
}

/* ── Job building ──────────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  // Pharma/biotech-specific categories
  if (/pharma|drug|formul|gmp|clinical|regulatory\s*affair/i.test(t)) return 'pharma';
  if (/biotech|biolog|cell\s*therap|gene\s*therap|capsid/i.test(t)) return 'biotech';
  if (/chem|laborat|lab\b|analyt|spectro|chromato/i.test(t)) return 'chemistry';
  if (/manufactur|production|batch|process\s*engineer|process\s*techni/i.test(t)) return 'manufacturing';
  if (/quality|qa|qc|valid|qualif/i.test(t)) return 'quality';
  if (/engineer|developer|software|architect|devops|cloud|data|cyber|network|infrastructure|automat/i.test(t)) return 'technology';
  if (/scientist|research|r&d|innovation/i.test(t)) return 'research';
  if (/supply\s*chain|logist|warehous|procurement|purchas/i.test(t)) return 'logistics';
  if (/safety|ehs|environment|health\s*&?\s*safety/i.test(t)) return 'ehs';
  if (/sales|commercial|pre.?sales|account\s*exec|business\s*develop/i.test(t)) return 'sales';
  if (/project|programme|program|scrum|agile/i.test(t)) return 'project-management';
  if (/legal|counsel|lawyer|compliance|regulator/i.test(t)) return 'legal';
  if (/account|financ|controller|audit/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/support|helpdesk|service\s*desk/i.test(t)) return 'support';
  if (/manag|director|head|lead|chief|vp\b/i.test(t)) return 'management';
  if (/mainten|technic|mechani|electri/i.test(t)) return 'maintenance';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagist|apprenti|graduate|trainee/i.test(t)) return 'ENTRY';
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
  const base = descriptionText || `${title} position at Lonza in ${location}, Switzerland.`;
  return `${base}\n\nLonza is a global leader in pharma and biotech manufacturing. The company operates major production facilities in Visp (Valais), Basel, and Stein (Aargau), Switzerland.`.trim();
}

function buildDescriptionDe(title, location) {
  return `Offene Stelle bei Lonza in ${location}.\nPosition: ${title}.\n\nLonza ist ein weltweit führendes Unternehmen in der Pharma- und Biotech-Produktion. Das Unternehmen betreibt grosse Produktionsanlagen in Visp (Wallis), Basel und Stein (Aargau), Schweiz.`.trim();
}

function buildPublicUrl(externalPath) {
  return `${LONZA_PUBLIC_BASE}${externalPath}`;
}

/* ── Fetch and build all Lonza Swiss jobs ────────────────────── */

async function fetchLonzaJobs() {
  console.log(`🔍 Fetching Lonza jobs from Workday API`);
  console.log(`   API: ${LONZA_API_BASE}/jobs`);
  console.log(`   Filter: Switzerland (all Swiss locations)\n`);

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
        if (desc.toLowerCase().includes('switzerland') || desc.toLowerCase().includes('visp') || desc.toLowerCase().includes('basel') || desc.toLowerCase().includes('stein')) {
          city = parseWorkdayLocation(desc);
          break;
        }
      }
    }
    if (!city) city = 'Visp'; // fallback to primary Swiss office

    const canton = inferCanton(city);

    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildPublicUrl(externalPath);

    const descEn = buildDescription(title, descriptionText, city);
    const descDe = buildDescriptionDe(title, city);

    const slug = slugify(title, 'lonza');
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    // Detect source language — Lonza posts primarily in EN and DE
    const sourceLang = detectLang(descriptionText || title, 'en');

    const job = {
      url: publicUrl,
      applyUrl: publicUrl,
      title,
      company: LONZA_COMPANY_NAME,
      companyKey: LONZA_KEY,
      location: city,
      canton,
      country: 'CH',
      description: descEn,
      descriptionByLocale: {
        en: descEn,
        de: descDe,
      },
      titleByLocale: {
        en: title,
      },
      slug,
      slugByLocale: {
        en: slug,
      },
      category: detectCategory(title),
      datePosted: info.startDate || new Date().toISOString().split('T')[0],
      source: 'lonza-workday-crawler',
      sourceLang,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Farmaceutica / Biotecnologia',
      _targetScope: { canton, location: city },
    };

    if (jobReqId) job.jobReqId = jobReqId;

    jobs.push(job);

    // Small delay between detail fetches
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total unique Lonza jobs discovered: ${jobs.length}`);
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

async function mergeLonzaJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(LONZA_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonLonzaJobs = allJobs.filter((j) => !isLonzaJob(j));
  const existingLonzaJobs = allJobs.filter(isLonzaJob);

  const existingByUrl = new Map();
  for (const job of existingLonzaJobs) {
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
        company: LONZA_COMPANY_NAME,
        companyKey: LONZA_KEY,
        location: discovered.location || existingJob.location,
        canton: discovered.canton || existingJob.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existingJob.applyUrl,
        category: discovered.category || existingJob.category,
        sector: discovered.sector || existingJob.sector,
        source: 'lonza-workday-crawler',
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

  const final = [...nonLonzaJobs, ...merged];

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
  const adapterPath = path.join(ADAPTERS_DIR, `${LONZA_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = LONZA_KEY;
  adapter.companyName = LONZA_COMPANY_NAME;
  adapter.companyHost = LONZA_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['api'];
  adapter.seedUrls = [`${LONZA_PUBLIC_BASE}?locationCountry=${SWISS_LOCATION_IDS.join('&locationCountry=')}`];
  adapter.notes = 'Workday REST API at lonza.wd3.myworkdayjobs.com — Swiss locations (Visp VS, Basel BS, Stein AG).';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${LONZA_KEY} updated.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: LONZA_KEY,
    localizeOnlyCompanyKeys: LONZA_KEY,
    forceLocalizeKeys: LONZA_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '250',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '250',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcessLonzaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isLonzaJob(job)) continue;

    if (job.company !== LONZA_COMPANY_NAME) {
      job.company = LONZA_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== LONZA_KEY) {
      job.companyKey = LONZA_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton && job.location) {
      job.canton = inferCanton(job.location);
      if (job.canton) fixed++;
    }
    if (!job.location) {
      job.location = 'Visp';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Lonza jobs (fixed company/location/canton).`);
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
  const lonzaJobs = allJobs.filter(isLonzaJob);

  console.log(`\n📊 === Lonza Job Stats ===`);
  console.log(`  🏢 Total Lonza jobs: ${lonzaJobs.length}`);

  if (lonzaJobs.length > 0) {
    // Group by canton for stats
    const byCanton = {};
    for (const job of lonzaJobs) {
      const c = job.canton || '??';
      byCanton[c] = (byCanton[c] || 0) + 1;
    }
    console.log(`  📍 By canton:`);
    for (const [canton, count] of Object.entries(byCanton).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${canton}: ${count} jobs`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(lonzaJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Lonza');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Lonza');
  return { total: lonzaJobs.length, crawlDiff };
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LONZA_STRICT',
    label: 'Lonza',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isLonzaJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_lonza_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Lonza jobs found — the company may not have active Swiss openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(LONZA_KEY, 'Lonza');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Lonza — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Workday API: ${LONZA_API_BASE}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(LONZA_KEY, DATA_JOBS).filter(isLonzaJob));

  // Phase 1: Fetch jobs from Workday API
  const discoveredJobs = await fetchLonzaJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Lonza jobs discovered.');
    console.log('   The Workday API may be unreachable or have no Swiss openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeLonzaJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (IT/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Lonza jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessLonzaJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Lonza jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Lonza crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isLonzaJob) : [];
  writeJobsCrawlerSlice(LONZA_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: LONZA_KEY,
    label: 'Lonza',
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
  console.error(`❌ Lonza crawler failed: ${err?.message || err}`);
  process.exit(1);
});
