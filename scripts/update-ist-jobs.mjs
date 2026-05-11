#!/usr/bin/env node
/**
 * Dedicated International School of Ticino (IST) crawler runner.
 *
 * IST is part of the Inspired Education Group. Jobs are listed on the
 * group's TalentBrew/iCIMS careers portal at jobs.inspirededu.com.
 *
 * Discovery flow:
 *   1. Search for Lugano-based jobs at /search/?locationsearch=Lugano
 *   2. Extract job detail URLs from search results HTML
 *   3. Fetch each job detail page, parse schema.org microdata
 *   4. Build job objects and merge into data/jobs.json
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
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
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { getCantonDisplayName, getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const IST_KEY = 'international-school-of-ticino';
const DEFAULT_CANTON = getCompanyDefaults(IST_KEY)?.canton || 'TI';
const IST_COMPANY_NAME = 'International School of Ticino';
const IST_COMPANY_HOST = 'jobs.inspirededu.com';
const IST_SEARCH_URL = 'https://jobs.inspirededu.com/search/';
const IST_BASE_URL = 'https://jobs.inspirededu.com';
const LOCALES = ['it', 'en', 'de', 'fr'];

const UA = process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

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

function isIstJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === IST_KEY ||
    key.startsWith('international-school-of-ticino') ||
    (company.includes('international school') && company.includes('ticino')) ||
    (url.includes('inspirededu.com') && (url.includes('ticino') || url.includes('lugano')))
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === IST_COMPANY_HOST || host.endsWith('.inspirededu.com');
  } catch {
    return false;
  }
}

/* ── HTML fetching ─────────────────────────────────────────── */

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': UA,
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

/* ── Discovery ─────────────────────────────────────────────── */

/**
 * Search the Inspired Education careers portal for Lugano & Graubünden-based jobs
 * and filter for International School of Ticino / Swiss positions.
 */
async function discoverIstJobUrls() {
  console.log(`🔍 Searching IST jobs at: ${IST_SEARCH_URL}`);

  const urls = new Set();
  const hrefPattern = /href="(\/job\/[^"]+)"/g;

  // Search by Lugano location — IST is in Lugano
  const searchUrl = `${IST_SEARCH_URL}?q=&locationsearch=Lugano&sortColumn=referencedate&sortDirection=desc`;
  const html = await fetchHtml(searchUrl);
  if (html) {
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
      urls.add(`${IST_BASE_URL}${match[1]}`);
    }
  } else {
    console.warn('⚠️ Could not fetch Lugano search results page.');
  }

  // Also check if searching for "ticino" yields additional results
  const ticinoSearchUrl = `${IST_SEARCH_URL}?q=ticino&sortColumn=referencedate&sortDirection=desc`;
  const ticinoHtml = await fetchHtml(ticinoSearchUrl);
  if (ticinoHtml) {
    const hrefPattern2 = /href="(\/job\/[^"]+)"/g;
    let match2;
    while ((match2 = hrefPattern2.exec(ticinoHtml)) !== null) {
      const jobPath = match2[1];
      if (jobPath.toLowerCase().includes('lugano') || jobPath.toLowerCase().includes('ticino')) {
        urls.add(`${IST_BASE_URL}${jobPath}`);
      }
    }
  }

  // Search for Graubünden / Chur / Davos area jobs
  for (const grQuery of ['Chur', 'Davos', 'Graubünden', 'St. Moritz']) {
    const grSearchUrl = `${IST_SEARCH_URL}?q=&locationsearch=${encodeURIComponent(grQuery)}&sortColumn=referencedate&sortDirection=desc`;
    const grHtml = await fetchHtml(grSearchUrl);
    if (grHtml) {
      const hrefPattern3 = /href="(\/job\/[^"]+)"/g;
      let match3;
      while ((match3 = hrefPattern3.exec(grHtml)) !== null) {
        urls.add(`${IST_BASE_URL}${match3[1]}`);
      }
    }
  }

  console.log(`  📋 Discovered ${urls.size} TI/GR-area job URLs`);
  return [...urls];
}

/* ── Job detail parsing ────────────────────────────────────── */

function extractMicrodata(html) {
  const get = (prop) => {
    // Try <meta itemprop="prop" content="...">
    const metaRe = new RegExp(`itemprop="${prop}"\\s+content="([^"]*)"`, 'i');
    const metaMatch = html.match(metaRe);
    if (metaMatch) return metaMatch[1].trim();

    // Try <span itemprop="prop">...</span>
    const spanRe = new RegExp(`itemprop="${prop}"[^>]*>([^<]+)`, 'i');
    const spanMatch = html.match(spanRe);
    if (spanMatch) return spanMatch[1].trim();
    return '';
  };

  const getPropertyId = (propId) => {
    const re = new RegExp(`data-careersite-propertyid="${propId}"[^>]*>([\\s\\S]*?)(?=<\\/span>|<span)`, 'i');
    const m = html.match(re);
    return m ? normalizeSpace(stripHtml(m[1])) : '';
  };

  return {
    title: get('title') || getPropertyId('title'),
    location: get('streetAddress') || getPropertyId('location'),
    datePosted: get('datePosted'),
    hiringOrganization: get('hiringOrganization'),
    description: getPropertyId('description'),
  };
}

async function fetchJobDetail(url) {
  console.log(`  📄 Fetching: ${url.split('/').slice(-3, -1).join('/')}`);
  const html = await fetchHtml(url);
  if (!html) return null;

  const data = extractMicrodata(html);

  // Extract full description from the description span (it includes HTML content)
  const descRe = /data-careersite-propertyid="description"[^>]*>([\s\S]*?)<\/span>/i;
  const descMatch = html.match(descRe);
  if (descMatch) {
    data.description = stripHtml(descMatch[1]);
  }

  // Get canonical URL if available
  const canonicalRe = /rel="canonical"\s+href="([^"]+)"/i;
  const canonicalMatch = html.match(canonicalRe);
  if (canonicalMatch) {
    data.canonicalUrl = canonicalMatch[1];
  }

  // Extract job ID from URL
  const idMatch = url.match(/\/(\d+)\/?$/);
  data.jobId = idMatch ? idMatch[1] : '';

  data.sourceUrl = url;

  return data;
}

/* ── Location & canton mapping ─────────────────────────────── */

function inferCanton(location = '') {
  return inferAnyCanton(location) || 'TI';
}

function parseLocation(locText = '') {
  // Format: "Lugano, CH" or "Lugano"
  const parts = locText.split(',');
  return parts[0].trim() || 'Lugano';
}

/* ── Job building ──────────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/teacher|insegnante|docente|professor|tutor/i.test(t)) return 'education';
  if (/head\s*of|director|principal|coordinator/i.test(t)) return 'management';
  if (/counselor|counsellor|psych|welfare/i.test(t)) return 'student-services';
  if (/admin|secretary|reception|office/i.test(t)) return 'administration';
  if (/nurse|health|medical/i.test(t)) return 'healthcare';
  if (/it\b|tech|system/i.test(t)) return 'technology';
  if (/librarian|library/i.test(t)) return 'education';
  if (/maintenance|facility|caretaker|custodian/i.test(t)) return 'operations';
  if (/expression of interest/i.test(t)) return 'general';
  return 'education';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|assistant|aide|intern|stage|trainee|apprenti/i.test(t)) return 'ENTRY';
  if (/senior|head|director|principal|lead|chief|coordinator/i.test(t)) return 'SENIOR';
  return 'MID';
}

// City fallbacks per canton. IST's physical campuses are in Lugano (TI) and
// Chur (GR); other cantons use the canton name as the city fallback.
const IST_DEFAULT_CITY_BY_CANTON = {
  TI: 'Lugano',
  GR: 'Chur',
};

function istFallbackCity(canton, locale = 'it') {
  return IST_DEFAULT_CITY_BY_CANTON[canton] || getCantonDisplayName(canton, locale);
}

function buildDescription(title, descriptionText, location, canton = DEFAULT_CANTON) {
  const region = getCantonDisplayName(canton, 'en');
  const defaultCity = istFallbackCity(canton, 'en');
  const base = descriptionText || `${title} position at the International School of Ticino in ${location}, Switzerland.`;
  return `${base}\n\nThe International School of Ticino (IST) is part of the Inspired Education Group, one of the world's leading premium school groups. Located in ${defaultCity}, IST offers a stimulating international learning environment in ${region}.`.trim();
}

function buildDescriptionIt(title, location, canton = DEFAULT_CANTON) {
  const region = getCantonDisplayName(canton, 'it');
  const defaultCity = istFallbackCity(canton, 'it');
  return `Posizione aperta presso la International School of Ticino a ${location}.\nRuolo: ${title}.\n\nLa International School of Ticino (IST) fa parte di Inspired Education Group, uno dei principali gruppi scolastici premium al mondo. Situata a ${defaultCity}, IST offre un ambiente di apprendimento internazionale stimolante in ${region}.`.trim();
}

/* ── Fetch and build all IST jobs ──────────────────────────── */

async function fetchIstJobs() {
  console.log(`🏫 Fetching International School of Ticino jobs`);
  console.log(`   Portal: ${IST_COMPANY_HOST}\n`);

  const jobUrls = await discoverIstJobUrls();
  if (jobUrls.length === 0) {
    console.warn('⚠️ No IST job URLs discovered.');
    return [];
  }

  const jobs = [];
  for (const url of jobUrls) {
    const detail = await fetchJobDetail(url);
    if (!detail || !detail.title) {
      console.log(`  ⏭️  Skipped — no title extracted`);
      continue;
    }

    const title = normalizeSpace(detail.title);
    const city = parseLocation(detail.location);
    const canton = inferCanton(city);
    const publicUrl = detail.canonicalUrl || url;

    const descEn = buildDescription(title, detail.description, city, canton);
    const descIt = buildDescriptionIt(title, city, canton);

    const slug = slugify(title, 'ist');

    const job = {
      url: publicUrl,
      applyUrl: publicUrl,
      title,
      company: IST_COMPANY_NAME,
      companyKey: IST_KEY,
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
        it: slugify(title, 'ist'),
      },
      category: detectCategory(title),
      datePosted: detail.datePosted
        ? new Date(detail.datePosted).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      source: 'ist-inspirededu-crawler',
      sourceLang: detectLang(descEn || title, 'en'),
      employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(title),
      sector: 'Istruzione / Scuola internazionale',
      _targetScope: { canton, location: city },
    };

    if (detail.jobId) job.jobReqId = detail.jobId;

    jobs.push(job);
  }

  console.log(`\n📋 Total unique IST jobs discovered: ${jobs.length}`);
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

async function mergeIstJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(IST_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonIstJobs = allJobs.filter((j) => !isIstJob(j));
  const existingIstJobs = allJobs.filter(isIstJob);

  const existingByUrl = new Map();
  for (const job of existingIstJobs) {
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
        company: IST_COMPANY_NAME,
        companyKey: IST_KEY,
        location: discovered.location || existingJob.location,
        canton: discovered.canton || existingJob.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existingJob.applyUrl,
        category: discovered.category || existingJob.category,
        sector: discovered.sector || existingJob.sector,
        source: 'ist-inspirededu-crawler',
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

  const final = [...nonIstJobs, ...merged];

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

function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${IST_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = IST_KEY;
  adapter.companyName = IST_COMPANY_NAME;
  adapter.companyHost = IST_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html', 'jsonld'];
  adapter.seedUrls = seedUrls;
  adapter.notes = 'TalentBrew/iCIMS portal at jobs.inspirededu.com — search by Lugano + Graubünden locations for IST TI/GR positions.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${IST_KEY} updated with ${seedUrls.length} seed URLs.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: IST_KEY,
    localizeOnlyCompanyKeys: IST_KEY,
    forceLocalizeKeys: IST_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '30',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '30',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcessIstJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isIstJob(job)) continue;

    if (job.company !== IST_COMPANY_NAME) {
      job.company = IST_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== IST_KEY) {
      job.companyKey = IST_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton) {
      job.canton = DEFAULT_CANTON;
      fixed++;
    }
    if (!job.location) {
      job.location = 'Lugano';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} IST jobs (fixed company/location/canton).`);
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
  const istJobs = allJobs.filter(isIstJob);

  console.log(`\n📊 === International School of Ticino Job Stats ===`);
  const tiJobs = istJobs.filter(j => j.canton === 'TI').length;
  const grJobs = istJobs.filter(j => j.canton === 'GR').length;
  console.log(`  🏫 Total IST jobs: ${istJobs.length} (TI: ${tiJobs}, GR: ${grJobs})`);

  if (istJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of istJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(istJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'IST');
  writeCrawlChangeSummaryToGH(crawlDiff, 'IST');
  return { total: istJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_IST_STRICT',
    label: 'International School of Ticino',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isIstJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_inspirededu_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No IST jobs found — the school may not have active openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(IST_KEY, 'International School of Ticino');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  International School of Ticino — Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Portal: ${IST_COMPANY_HOST}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(IST_KEY, DATA_JOBS).filter(isIstJob))

  // Phase 1: Discover job URLs
  const discoveredJobs = await fetchIstJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No IST jobs discovered.');
    console.log('   The careers portal may have no TI/GR openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig(discoveredJobs.map(j => j.url));

  // Phase 3: Merge into data/jobs.json
  await mergeIstJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization
  console.log('\n🌐 Running base crawler for AI localization of IST jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessIstJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No IST jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ International School of Ticino crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isIstJob) : [];
  writeJobsCrawlerSlice(IST_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: IST_KEY,
    label: 'International School of Ticino',
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
  console.error(`❌ IST crawler failed: ${err?.message || err}`);
  process.exit(1);
});
