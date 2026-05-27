#!/usr/bin/env node
/**
 * Dedicated Zegna Group crawler runner.
 * Crawls the Zegna Group careers portal (careers.zegnagroup.com) for
 * Switzerland-based positions and enforces full locale coverage.
 *
 * The Zegna careers portal is a server-rendered HTML page.
 * Listing URL with Switzerland filter:
 *   https://careers.zegnagroup.com/?FreeSearch=&Location=177940409
 *
 * Individual job detail pages:
 *   https://careers.zegnagroup.com/jobs/job-details?JobID=XXX&Team=YYY
 *
 * Discovery flow:
 *   1. Fetch the listing page with Switzerland location filter
 *   2. Parse job links (job-details?JobID=...&Team=...)
 *   3. Fetch each job detail page to extract title, location, description
 *   4. Build job objects with the detail URL as canonical identifier
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization of descriptions (4 locales)
 *   7. Post-process: fix company name, location, canton, clean descriptions
 *   8. Validate locale coverage across IT/EN/DE/FR
 *
 * Ermenegildo Zegna Group is an Italian luxury fashion house headquartered
 * in Trivero (Italy) with a major logistics and corporate hub in Stabio,
 * Canton Ticino, Switzerland.
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
import { isTargetSwissLocation, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { isTargetCanton, getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const ZEGNA_KEY = 'ermenegildo-zegna-logistica';
const ZEGNA_HQ = getCompanyDefaults(ZEGNA_KEY);
const DEFAULT_CANTON = ZEGNA_HQ?.canton || 'TI';
const DEFAULT_CITY = ZEGNA_HQ?.city || 'Stabio';
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Zegna careers portal URL with Switzerland location filter.
 * Location=177940409 is the Zegna ATS internal ID for "Switzerland".
 */
const LISTING_URL = 'https://careers.zegnagroup.com/?FreeSearch=&Location=177940409';
const DETAIL_BASE = 'https://careers.zegnagroup.com/jobs/job-details';

const ZEGNA_COMPANY_NAME = 'Ermenegildo Zegna Group';
const ZEGNA_COMPANY_HOST = 'careers.zegnagroup.com';

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
 * Match a job object as belonging to the Zegna crawl.
 */
function isZegnaJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === ZEGNA_KEY ||
    key.includes('ermenegildo-zegna') ||
    key.includes('zegna-logistica') ||
    host.includes('zegnagroup.com') ||
    host.includes('careers.zegnagroup.com')
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
// Parsing — extract job listings from the careers page
// ──────────────────────────────────────────────────────────────

/**
 * Parse job links from the listing page HTML.
 * Each job is a link of the form:
 *   <a href="https://careers.zegnagroup.com/jobs/job-details?JobID=XXX&Team=YYY">
 *     Title Location , Country
 *   </a>
 */
function parseJobLinks(html = '') {
  const jobs = [];
  // Match all job-detail links — can be relative (/jobs/job-details?...) or absolute
  const linkRe = /href=["']((?:https?:\/\/careers\.zegnagroup\.com)?\/jobs\/job-details\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    let url = match[1].replace(/&amp;/g, '&');
    // Normalize relative URLs to absolute
    if (url.startsWith('/')) {
      url = `https://careers.zegnagroup.com${url}`;
    }
    const linkText = match[2].replace(/<[^>]+>/g, '').trim();

    // Extract JobID from URL
    const jobIdMatch = url.match(/JobID=(\d+)/i);
    const jobId = jobIdMatch ? jobIdMatch[1] : '';

    // Parse title and location from link text
    // Format: "Title City , Country"
    const parts = linkText.split(/\s*,\s*/);
    const titleAndCity = parts[0] || '';
    const country = normalizeSpace(parts[parts.length - 1] || '');

    jobs.push({ url, jobId, rawText: linkText, titleAndCity, country });
  }

  // Deduplicate by JobID
  const seen = new Set();
  return jobs.filter(j => {
    if (!j.jobId || seen.has(j.jobId)) return false;
    seen.add(j.jobId);
    return true;
  });
}

/**
 * Parse a job detail page to extract structured data.
 * Tries JSON-LD first (most reliable), falls back to HTML parsing.
 */
function parseJobDetail(html = '', url = '') {
  const result = { title: '', location: '', city: '', region: '', brand: '', contractType: '', jobFunction: '', description: '' };

  // --- JSON-LD extraction (most reliable) ---
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'JobPosting') {
        result.title = ld.title || '';
        result.description = normalizeSpace(
          (ld.description || '')
            .replace(/\\r\\n|\\r|\\n/g, '\n')
            .replace(/\r\n|\r|\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        );
        const loc = ld.jobLocation?.address || {};
        result.city = loc.addressLocality || '';
        result.region = loc.addressRegion || '';
        result.location = [loc.addressCountry, loc.addressRegion, loc.addressLocality].filter(Boolean).join('/');
      }
    } catch { /* ignore JSON parse errors */ }
  }

  // --- HTML table extraction for metadata ---
  // Locations
  const locMatch = html.match(/aria-label=["']Locations["'][^>]*>([\s\S]*?)<\/div>/i);
  if (locMatch && !result.location) {
    result.location = normalizeSpace(locMatch[1].replace(/<[^>]+>/g, ''));
  }

  // Brand
  const brandMatch = html.match(/aria-label=["']Brand["'][^>]*>([\s\S]*?)<\/div>/i);
  if (brandMatch) {
    result.brand = normalizeSpace(brandMatch[1].replace(/<[^>]+>/g, ''));
  }

  // Contract type
  const contractMatch = html.match(/aria-label=["']Contract type["'][^>]*>([\s\S]*?)<\/div>/i);
  if (contractMatch) {
    result.contractType = normalizeSpace(contractMatch[1].replace(/<[^>]+>/g, ''));
  }

  // Job function
  const funcMatch = html.match(/aria-label=["']JOB FUNCTION["'][^>]*>([\s\S]*?)<\/div>/i);
  if (funcMatch) {
    result.jobFunction = normalizeSpace(funcMatch[1].replace(/<[^>]+>/g, ''));
  }

  // Title from <h1> as fallback
  if (!result.title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      result.title = normalizeSpace(h1Match[1].replace(/<[^>]+>/g, ''));
    }
  }

  // Extract city from location if not yet set
  if (!result.city && result.location) {
    const parts = result.location.split('/');
    if (parts.length >= 3) {
      result.city = parts[parts.length - 1].trim();
      result.region = parts[parts.length - 2].trim();
    }
  }

  return result;
}

/**
 * Detect city from the location string.
 * Returns the parsed location verbatim when present, else the Zegna HQ city.
 */
function detectCity(location = '') {
  const loc = String(location || '').trim();
  if (!loc) return DEFAULT_CITY;
  return loc;
}

function detectCanton(city = '') {
  return inferAnyCanton(city) || DEFAULT_CANTON;
}

function isZegnaSwissLocation(detail) {
  const signal = [detail?.city, detail?.location, detail?.region].filter(Boolean).join(' ');
  return isTargetSwissLocation(signal);
}

function detectEmploymentType(contractType = '') {
  const ct = contractType.toLowerCase();
  if (ct.includes('temporary') || ct.includes('fixed term') || ct.includes('seasonal')) return 'TEMPORARY';
  if (ct.includes('internship') || ct.includes('stage')) return 'INTERN';
  if (ct.includes('apprentice')) return 'APPRENTICESHIP';
  return 'FULL_TIME';
}

function detectSector(jobFunction = '') {
  const fn = jobFunction.toLowerCase();
  if (fn.includes('retail') || fn.includes('store')) return 'Retail';
  if (fn.includes('logistics')) return 'Logistica';
  if (fn.includes('finance') || fn.includes('credit')) return 'Finanza';
  if (fn.includes('it') || fn.includes('information technology')) return 'IT';
  if (fn.includes('marketing')) return 'Marketing';
  if (fn.includes('human resources')) return 'Risorse Umane';
  if (fn.includes('legal')) return 'Legale';
  return 'Lusso & Moda';
}

// ──────────────────────────────────────────────────────────────
// Main discovery flow
// ──────────────────────────────────────────────────────────────

async function fetchZegnaJobs() {
  console.log('🔍 Fetching Zegna Group job listings from careers portal...');
  console.log(`  📄 Listing URL: ${LISTING_URL}`);

  const listingHtml = await fetchPage(LISTING_URL, 20000);
  if (!listingHtml) {
    console.error('❌ Failed to fetch Zegna listing page.');
    return [];
  }

  const jobLinks = parseJobLinks(listingHtml);
  console.log(`  ✅ Found ${jobLinks.length} job links on listing page`);

  if (jobLinks.length === 0) {
    console.warn('⚠️ No job links found — page structure may have changed.');
    return [];
  }

  const jobs = [];
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  for (const link of jobLinks) {
    console.log(`  📄 Fetching detail: ${link.url}`);
    const detailHtml = await fetchPage(link.url, 15000);

    if (!detailHtml) {
      console.warn(`  ⚠️ Failed to fetch detail for JobID ${link.jobId}`);
      continue;
    }

    const detail = parseJobDetail(detailHtml, link.url);
    const title = detail.title || link.rawText || '';
    const city = detail.city || detectCity(detail.location);
    const canton = detectCanton(city);
    if (!isZegnaSwissLocation(detail) || !isTargetCanton(canton)) {
      console.log(`     ↳ Skipping (not target region): ${title} — ${detail.location || city || 'unknown location'}`);
      continue;
    }
    const slug = slugify(title, 'zegna');

    const descriptionIt = detail.description
      ? detail.description
      : `Posizione aperta presso ${ZEGNA_COMPANY_NAME}. Ruolo: ${title}. Sede: ${city}, Svizzera.`;

    const job = {
      url: link.url,
      applyUrl: link.url,
      title,
      company: ZEGNA_COMPANY_NAME,
      companyKey: ZEGNA_KEY,
      location: city,
      canton,
      country: 'CH',
      description: descriptionIt,
      descriptionByLocale: {
        en: detail.description || '',
      },
      titleByLocale: {
        en: title,
      },
      slug,
      slugByLocale: {
        en: slug,
      },
      department: detail.jobFunction || '',
      category: detail.jobFunction || 'corporate',
      datePosted: new Date().toISOString().split('T')[0],
      source: 'zegna-careers-crawler',
      employmentType: detectEmploymentType(detail.contractType),
      experienceLevel: '',
      sector: detectSector(detail.jobFunction),
      brand: detail.brand || 'Zegna',
      contractType: detail.contractType || '',
      _targetScope: { canton, location: city },
      sourceLang: detectLang(detail.description || title, 'en'),
    };

    jobs.push(job);

    // Be polite — small delay between requests
    await delay(500);
  }

  console.log(`\n📋 Total Zegna jobs discovered: ${jobs.length}`);
  return jobs;
}

// ──────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ──────────────────────────────────────────────────────────────

function canonicalizeUrl(url = '') {
  try {
    const u = new URL(url);
    // Normalize: sort params, lowercase
    u.searchParams.sort();
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return normalize(url);
  }
}

/**
 * Extract JobID from a Zegna careers URL for stable deduplication.
 */
function extractJobId(url = '') {
  const match = String(url).match(/JobID=(\d+)/i);
  return match ? match[1] : '';
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeZegnaJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(ZEGNA_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonZegnaJobs = allJobs.filter((j) => !isZegnaJob(j));
  const existingZegnaJobs = allJobs.filter(isZegnaJob);

  // Build lookup by JobID (more stable than full URL)
  const existingByJobId = new Map();
  for (const job of existingZegnaJobs) {
    const jid = extractJobId(job.url);
    if (jid) existingByJobId.set(jid, job);
  }

  const discoveredByJobId = new Map();
  for (const job of discoveredJobs) {
    const jid = extractJobId(job.url);
    if (jid) discoveredByJobId.set(jid, job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const jid = extractJobId(discovered.url);
    const existing = jid ? existingByJobId.get(jid) : null;

    if (existing) {
      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        company: ZEGNA_COMPANY_NAME,
        companyKey: ZEGNA_KEY,
        location: discovered.location || existing.location,
        canton: discovered.canton || existing.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        url: discovered.url || existing.url,
        department: discovered.department || existing.department,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'zegna-careers-crawler',
        sourceLang: discovered.sourceLang || existing.sourceLang,
        brand: discovered.brand || existing.brand,
        contractType: discovered.contractType || existing.contractType,
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

  // Count removed (existing Zegna jobs not in discovery)
  for (const [jid] of existingByJobId) {
    if (!discoveredByJobId.has(jid)) removed++;
  }

  const final = [...nonZegnaJobs, ...merged];

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
  const adapterPath = path.join(ADAPTERS_DIR, `${ZEGNA_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = ZEGNA_KEY;
  adapter.companyName = ZEGNA_COMPANY_NAME;
  adapter.companyHost = ZEGNA_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [LISTING_URL, ...seedUrls];
  adapter.notes = 'Zegna Group careers portal — job listings extracted from careers.zegnagroup.com with Switzerland location filter.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${ZEGNA_KEY} updated.`);
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation (for AI localization only)
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: ZEGNA_KEY,
    localizeOnlyCompanyKeys: ZEGNA_KEY,
    forceLocalizeKeys: ZEGNA_KEY,
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

function postProcessZegnaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;
  let removed = 0;
  const keptJobs = [];

  for (const job of jobs) {
    if (!isZegnaJob(job)) {
      keptJobs.push(job);
      continue;
    }

    if (!isTargetCanton(String(job.canton || '').toUpperCase())) {
      removed++;
      continue;
    }

    if (job.company !== ZEGNA_COMPANY_NAME) {
      job.company = ZEGNA_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== ZEGNA_KEY) {
      job.companyKey = ZEGNA_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.location) {
      job.location = DEFAULT_CITY;
      fixed++;
    }
    if (!job.canton) {
      job.canton = detectCanton(job.location);
      fixed++;
    }
    keptJobs.push(job);
  }

  if (fixed > 0 || removed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(keptJobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(keptJobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Zegna jobs (fixed company/location/canton, removed=${removed}).`);
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logZegnaJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const zegnaJobs = allJobs.filter(isZegnaJob);

  const locations = {};
  for (const job of zegnaJobs) {
    const loc = job.location || 'unknown';
    locations[loc] = (locations[loc] || 0) + 1;
  }

  const sectors = {};
  for (const job of zegnaJobs) {
    const sec = job.sector || 'unknown';
    sectors[sec] = (sectors[sec] || 0) + 1;
  }

  console.log(`\n📊 === Ermenegildo Zegna Group Job Stats ===`);
  console.log(`  👔 Job totali trovati (Zegna): ${zegnaJobs.length}`);

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

  const afterSnapshot = snapshotJobSlugs(zegnaJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Zegna');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Zegna');
  return { total: zegnaJobs.length, crawlDiff };
}

function validateZegnaLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ZEGNA_STRICT',
    label: 'Zegna',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isZegnaJob,
    detectSourceLang: (text) => detectLang(text, 'en'),
    minDescriptionChars: 80,
    noJobsMessage: 'No Zegna jobs found after crawl.',
    failWhenNoJobs: true,
    sampleLimit: 25,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(ZEGNA_KEY, 'Zegna');
  console.log('👔 Running dedicated Zegna Group jobs crawler...');
  console.log(`   Listing URL: ${LISTING_URL}\n`);

  // 1. Fetch and parse job listings
  const discoveredJobs = await fetchZegnaJobs();

  if (discoveredJobs.length === 0) {
    console.log('⚠️ No Zegna jobs discovered from the careers portal.');
    console.log('   The page structure may have changed or be temporarily unavailable.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    logZegnaJobStats();
    return;
  }

  // 2. Update the adapter config with discovered job URLs as seeds
  const seedUrls = discoveredJobs.map(j => j.url);
  updateAdapterConfig(seedUrls);

  // 3. Merge discovered jobs into data/jobs.json
  await mergeZegnaJobs(discoveredJobs);

  // Snapshot for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(ZEGNA_KEY, DATA_JOBS).filter(isZegnaJob))

  // 4. Run base crawler for AI localization (IT/DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Zegna jobs...');
  await runBaseCrawler();

  // 5. Post-process: ensure consistency
  postProcessZegnaJobs();

  // 6. Log stats
  const stats = logZegnaJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No Zegna jobs found. Exiting OK.');
    return;
  }

  // 7. Validate locale coverage
  validateZegnaLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isZegnaJob) : [];
  writeJobsCrawlerSlice(ZEGNA_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: ZEGNA_KEY,
    label: 'Zegna',
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
  console.error(`❌ Zegna crawler failed: ${err?.message || err}`);
  process.exit(1);
});
