#!/usr/bin/env node
/**
 * Dedicated McDonald's Switzerland crawler runner.
 *
 * McDonald's Switzerland uses a Drupal-based careers site at jobs.mcdonalds.ch.
 * All job data is embedded as JSON in drupalSettings.mcdo_jobs_mapEntries.
 * Detail pages at /de/details-offre/{id} have JSON-LD JobPosting schema.
 *
 * Discovery flow:
 *   1. Fetch /de/jobs → parse embedded mcdo_jobs_mapEntries JSON
 *   2. Filter for TI/GR city IDs (Lugano, Bellinzona, Locarno, etc.)
 *   3. Fetch each detail page → extract JSON-LD JobPosting data
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const MCDO_KEY = 'mcdonald-s-switzerland';
const MCDO_COMPANY_NAME = "McDonald's Switzerland";
const MCDO_COMPANY_HOST = 'jobs.mcdonalds.ch';
const MCDO_LISTING_URL = 'https://jobs.mcdonalds.ch/de/jobs';
const MCDO_BASE_URL = 'https://jobs.mcdonalds.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];

/** City IDs for Ticino and Graubünden locations from the Drupal select */
const TARGET_CITY_IDS = new Set([
  // Ticino
  10596, // Bellinzona
  9696,  // Locarno
  9701,  // Lugano
  9690,  // Magliaso
  9689,  // Mendrisio
  10588, // Morbio
  9613,  // Sant'Antonino
  // Graubünden
  9640,  // Chur
]);

const CITY_CANTON_MAP = {
  'Bellinzona': 'TI', 'Locarno': 'TI', 'Lugano': 'TI',
  'Magliaso': 'TI', 'Mendrisio': 'TI', 'Morbio': 'TI',
  "Sant'Antonino": 'TI', 'Chur': 'GR',
};

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

function isMcdoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === MCDO_KEY ||
    key.startsWith('mcdonald') ||
    company.includes("mcdonald") ||
    url.includes('jobs.mcdonalds.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === MCDO_COMPANY_HOST || host.endsWith('.mcdonalds.ch');
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
        'Accept-Language': 'de,it-CH;q=0.9',
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

/* ── Discovery (embedded JSON in listing page) ─────────────── */

async function discoverMcdoJobs() {
  console.log(`🔍 Fetching McDonald's job listing: ${MCDO_LISTING_URL}`);

  const html = await fetchHtml(MCDO_LISTING_URL);
  if (!html) {
    console.warn('⚠️ Could not fetch listing page.');
    return [];
  }

  // Extract mcdo_jobs_mapEntries JSON from drupalSettings
  const mapMatch = html.match(/mcdo_jobs_mapEntries":(\[[\s\S]*?\])(?:,"mcdo_jobs_restaurants|,\s*"mcdo_jobs)/);
  if (!mapMatch) {
    console.warn('⚠️ Could not find mcdo_jobs_mapEntries in page.');
    return [];
  }

  let allJobs;
  try {
    allJobs = JSON.parse(mapMatch[1]);
  } catch (err) {
    console.warn(`⚠️ Failed to parse mapEntries JSON: ${err.message}`);
    return [];
  }

  console.log(`  📋 Total jobs on portal: ${allJobs.length}`);

  // Filter for TI/GR cities
  const targetJobs = allJobs.filter(j => TARGET_CITY_IDS.has(j.city_id));
  console.log(`  🎯 TI/GR target jobs: ${targetJobs.length}`);

  for (const j of targetJobs) {
    console.log(`     - ${j.title} (${j.city_name}) → ${j.url}`);
  }

  return targetJobs;
}

/* ── Job detail fetching (JSON-LD) ─────────────────────────── */

async function fetchJobDetail(jobEntry) {
  const detailUrl = `${MCDO_BASE_URL}${jobEntry.url}`;
  console.log(`  📄 Fetching detail: ${jobEntry.title} (${jobEntry.city_name})`);

  const html = await fetchHtml(detailUrl);
  if (!html) return null;

  // Extract JSON-LD
  const ldMatch = html.match(/<script\s+type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!ldMatch) return null;

  try {
    const ld = JSON.parse(ldMatch[1]);
    return { ...ld, sourceUrl: detailUrl };
  } catch {
    return null;
  }
}

/* ── Location & canton mapping ─────────────────────────────── */

function inferCanton(cityName = '') {
  for (const [city, canton] of Object.entries(CITY_CANTON_MAP)) {
    if (normalize(cityName).includes(normalize(city))) return canton;
  }
  return 'TI'; // default
}

/* ── Job building ──────────────────────────────────────────── */

function detectCategory(typeName = '', title = '') {
  const t = normalize(typeName + ' ' + title);
  if (/manage|direktor|director|direttore|gerant/i.test(t)) return 'management';
  if (/lehre|apprenti|apprendist/i.test(t)) return 'apprenticeship';
  if (/praktikum|stage|intern/i.test(t)) return 'internship';
  if (/küche|service|cucina|servizio|empfang|accueil|mccafé/i.test(t)) return 'gastronomy';
  if (/admin/i.test(t)) return 'administration';
  if (/hauptsitz|siège|sede/i.test(t)) return 'corporate';
  return 'gastronomy';
}

function detectExperienceLevel(title = '', typeName = '') {
  const t = normalize(title + ' ' + typeName);
  if (/lehre|apprenti|apprendist|praktikum|stage|intern/i.test(t)) return 'ENTRY';
  if (/manager|direktor|director|direttore|gérant/i.test(t)) return 'SENIOR';
  return 'ENTRY';
}

function detectEmploymentType(employmentType = '') {
  const t = normalize(employmentType);
  if (/vollzeit|full.?time|tempo pieno|plein temps/i.test(t)) return 'FULL_TIME';
  if (/teilzeit|part.?time|tempo parziale|partiel/i.test(t)) return 'PART_TIME';
  if (/stunden|hourly|ore/i.test(t)) return 'PART_TIME';
  return 'PART_TIME'; // most McDonald's crew positions are part-time/hourly
}

async function buildJobObjects(mapEntries) {
  const jobs = [];

  for (const entry of mapEntries) {
    const detailUrl = `${MCDO_BASE_URL}${entry.url}`;
    const ld = await fetchJobDetail(entry);

    const title = normalizeSpace(ld?.title || entry.title);
    const city = entry.city_name || 'Lugano';
    const canton = inferCanton(city);
    const description = ld?.description || entry.desc || '';

    const slug = slugify(title, 'mcdonalds');

    const job = {
      url: detailUrl,
      applyUrl: detailUrl,
      title,
      company: MCDO_COMPANY_NAME,
      companyKey: MCDO_KEY,
      location: city,
      canton,
      country: 'CH',
      description,
      descriptionByLocale: {},
      titleByLocale: { de: title },
      sourceLang: detectLang(description || title, 'de'),
      slug,
      slugByLocale: { de: slug },
      category: detectCategory(entry.type_name, title),
      datePosted: ld?.datePosted
        ? new Date(ld.datePosted).toISOString().split('T')[0]
        : entry.date || new Date().toISOString().split('T')[0],
      validThrough: ld?.validThrough
        ? new Date(ld.validThrough).toISOString().split('T')[0]
        : undefined,
      source: 'mcdonalds-ch-crawler',
      employmentType: detectEmploymentType(ld?.employmentType || ''),
      experienceLevel: detectExperienceLevel(title, entry.type_name),
      sector: 'Ristorazione / Fast Food',
      jobReqId: entry.id,
      _targetScope: { canton, location: city },
    };

    // If description looks Italian, set it as IT locale
    if (/cerchi|lavoro|colleghi|offriamo|profilo/i.test(description)) {
      job.descriptionByLocale.it = description;
    } else if (/suchst|kollegin|bieten|profil/i.test(description)) {
      job.descriptionByLocale.de = description;
    }

    jobs.push(job);
  }

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

async function mergeMcdoJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(MCDO_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonMcdoJobs = allJobs.filter(j => !isMcdoJob(j));
  const existingMcdoJobs = allJobs.filter(isMcdoJob);

  const existingByUrl = new Map();
  for (const job of existingMcdoJobs) {
    existingByUrl.set(canonicalizeUrl(job.url), job);
  }

  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) {
    discoveredByUrl.set(canonicalizeUrl(job.url), job);
  }

  let added = 0, updated = 0, removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const existingJob = existingByUrl.get(key);

    if (existingJob) {
      const updatedJob = {
        ...existingJob,
        title: discovered.title || existingJob.title,
        company: MCDO_COMPANY_NAME,
        companyKey: MCDO_KEY,
        location: discovered.location || existingJob.location,
        canton: discovered.canton || existingJob.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existingJob.applyUrl,
        category: discovered.category || existingJob.category,
        sector: discovered.sector || existingJob.sector,
        source: 'mcdonalds-ch-crawler',
        titleByLocale: mergeLocaleTextMap(existingJob.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existingJob.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existingJob.slugByLocale, discovered.slugByLocale, 3),
      };

      if (discovered.description && discovered.description.length > (existingJob.description || '').length) {
        updatedJob.description = discovered.description;
      }
      if (discovered.validThrough) updatedJob.validThrough = discovered.validThrough;

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

  const final = [...nonMcdoJobs, ...merged];

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
  const adapterPath = path.join(ADAPTERS_DIR, `${MCDO_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = MCDO_KEY;
  adapter.companyName = MCDO_COMPANY_NAME;
  adapter.companyHost = MCDO_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['embedded-json', 'jsonld'];
  adapter.seedUrls = seedUrls;
  adapter.notes = "Drupal CMS at jobs.mcdonalds.ch — job data embedded in drupalSettings.mcdo_jobs_mapEntries, detail pages have JSON-LD.";
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${MCDO_KEY} updated with ${seedUrls.length} seed URLs.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MCDO_KEY,
    localizeOnlyCompanyKeys: MCDO_KEY,
    forceLocalizeKeys: MCDO_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '30',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '30',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcessMcdoJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isMcdoJob(job)) continue;

    if (job.company !== MCDO_COMPANY_NAME) {
      job.company = MCDO_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== MCDO_KEY) {
      job.companyKey = MCDO_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton) {
      job.canton = inferCanton(job.location);
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} McDonald's jobs (fixed company/location/canton).`);
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
  const mcdoJobs = allJobs.filter(isMcdoJob);

  console.log(`\n📊 === McDonald's Switzerland Job Stats ===`);
  console.log(`  🍔 Total McDonald's jobs: ${mcdoJobs.length}`);

  if (mcdoJobs.length > 0) {
    const byCanton = {};
    for (const j of mcdoJobs) {
      byCanton[j.canton || '??'] = (byCanton[j.canton || '??'] || 0) + 1;
    }
    console.log(`  📋 Jobs by canton:`);
    for (const [canton, count] of Object.entries(byCanton)) {
      console.log(`     ${canton}: ${count}`);
    }
    console.log(`  📋 Jobs:`);
    for (const job of mcdoJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(mcdoJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, "McDonald's");
  writeCrawlChangeSummaryToGH(crawlDiff, "McDonald's");
  return { total: mcdoJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MCDONALDS_STRICT',
    label: "McDonald's Switzerland",
    dataJobsPath: DATA_JOBS,
    isTargetJob: isMcdoJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_mcdonalds_domain',
    failWhenNoJobs: false,
    noJobsMessage: "No McDonald's TI/GR jobs found — the portal may not have active openings in target regions.",
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(MCDO_KEY, 'mcdonalds');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log("  McDonald's Switzerland — Crawler");
  console.log('═══════════════════════════════════════════════');
  console.log(`  Portal: ${MCDO_COMPANY_HOST}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(MCDO_KEY, DATA_JOBS).filter(isMcdoJob))

  // Phase 1: Discover job entries from embedded data
  const mapEntries = await discoverMcdoJobs();

  if (mapEntries.length === 0) {
    console.log("\n⚠️ No McDonald's TI/GR jobs discovered.");
    console.log('   The portal may have no openings in target regions.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Build job objects with detail page data
  console.log('\n📄 Fetching job detail pages for JSON-LD data...');
  const discoveredJobs = await buildJobObjects(mapEntries);

  // Phase 3: Update adapter config
  updateAdapterConfig(discoveredJobs.map(j => j.url));

  // Phase 4: Merge into data/jobs.json
  await mergeMcdoJobs(discoveredJobs);

  // Phase 5: Run base crawler for AI localization
  console.log("\n🌐 Running base crawler for AI localization of McDonald's jobs...");
  await runBaseCrawler();

  // Phase 6: Post-process
  postProcessMcdoJobs();

  // Phase 7: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log("ℹ️ No McDonald's jobs found after crawl. No error — exiting OK.");
    return;
  }

  // Phase 8: Validate locale coverage
  validateLocales();

  console.log("\n✅ McDonald's Switzerland crawler complete.");

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isMcdoJob) : [];
  writeJobsCrawlerSlice(MCDO_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MCDO_KEY,
    label: 'mcdonalds',
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
  console.error(`❌ McDonald's crawler failed: ${err?.message || err}`);
  process.exit(1);
});
