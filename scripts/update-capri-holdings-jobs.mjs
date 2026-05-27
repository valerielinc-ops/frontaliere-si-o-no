#!/usr/bin/env node
/**
 * Dedicated Capri Holdings (Michael Kors / Versace) crawler runner.
 *
 * Capri Holdings uses Workday as their ATS. They have a major logistics
 * hub in Mendrisio (TI) employing hundreds of workers.
 *
 * Workday API endpoints (tenant changed from "capriholdings" to "capri", 2026-03-25):
 *   Michael Kors: POST https://capri.wd1.myworkdayjobs.com/wday/cxs/capri/Michael_Kors/jobs
 *   Versace:      POST https://capri.wd1.myworkdayjobs.com/wday/cxs/capri/Versace/jobs
 *   Detail:       GET  https://capri.wd1.myworkdayjobs.com/wday/cxs/capri/{site}/job/{path}
 *
 * This script:
 *   1. Queries both Michael Kors and Versace Workday APIs for Swiss positions
 *   2. Fetches full job details for each match
 *   3. Builds job objects with canonical Workday URLs
 *   4. Merges into data/jobs.json
 *   5. Runs base crawler for AI localization (4 locales)
 *   6. Post-processes and validates locale coverage
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
  detectLang,
  normalize,
  normalizeKey,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const CAPRI_KEY = 'capri-holdings';
const DEFAULT_CANTON = getCompanyDefaults(CAPRI_KEY)?.canton || 'TI';
const CAPRI_COMPANY_NAME = 'Capri Holdings (Michael Kors / Versace)';
const CAPRI_HOST = 'capri.wd1.myworkdayjobs.com';
const LOCALES = ['it', 'en', 'de', 'fr'];

/** Workday API sites to query — each brand has its own site within the "capri" tenant */
const WORKDAY_SITES = [
  { site: 'Michael_Kors', brand: 'Michael Kors' },
  { site: 'Versace', brand: 'Versace' },
];

const WORKDAY_API_BASE = 'https://capri.wd1.myworkdayjobs.com/wday/cxs/capri';
const WORKDAY_PUBLIC_BASE = 'https://capri.wd1.myworkdayjobs.com/en-US';

/** Swiss/Ticino location keywords for filtering */
const SWISS_LOCATION_KEYWORDS = [
  'mendrisio', 'lugano', 'chiasso', 'stabio', 'coldrerio',
  'balerna', 'novazzano', 'ticino', 'tessin', 'switzerland',
  'svizzera', 'schweiz', 'suisse', 'graubünden', 'graubunden',
  'landquart', 'zurich', 'zürich', 'geneva', 'genève', 'bern',
  'basel', 'lausanne', 'winterthur', 'st. gallen',
];

/* ── Helpers ──────────────────────────────────────────────── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function isSwissLocation(locationText = '') {
  const loc = String(locationText || '').toLowerCase();
  return SWISS_LOCATION_KEYWORDS.some((kw) => loc.includes(kw));
}

function inferCanton(location = '') {
  return inferAnyCanton(String(location || ''));
}

function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/engineer|developer|software|it\b|system|data|devops|cyber|network/i.test(t)) return 'technology';
  if (/logistic|supply|warehouse|procurement|buyer|shipping|inventory/i.test(t)) return 'logistics';
  if (/sales|retail|store|boutique|shop|associate|supervisor/i.test(t)) return 'retail';
  if (/design|creative|visual|merchand/i.test(t)) return 'design';
  if (/marketing|brand|communication|pr\b|social\s*media/i.test(t)) return 'marketing';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/account|financ|controller|audit|treasury|tax/i.test(t)) return 'finance';
  if (/legal|counsel|lawyer/i.test(t)) return 'legal';
  if (/manag|director|head|lead|chief|vp\b|general\s*manager/i.test(t)) return 'management';
  if (/customer|crm|client/i.test(t)) return 'customer-service';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/junior|jr\.?|entry|intern|stage|stagist|apprenti|trainee|graduate/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b|managing/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(timeType = '') {
  const t = String(timeType || '').toLowerCase();
  if (t.includes('full')) return 'FULL_TIME';
  if (t.includes('part')) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Matchers ──────────────────────────────────────────────── */
function isCapriJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === CAPRI_KEY ||
    key.includes('capri') ||
    key.includes('michael-kors') ||
    key.includes('versace') ||
    key.includes('jimmy-choo') ||
    company.includes('capri') ||
    company.includes('michael kors') ||
    company.includes('versace') ||
    company.includes('jimmy choo') ||
    host.includes('capri') && host.includes('myworkdayjobs') ||
    host.includes('capriholdings') ||
    host.includes('versace') && host.includes('myworkdayjobs') ||
    host.includes('michaelkors') && host.includes('myworkdayjobs')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === CAPRI_HOST || host.endsWith('.myworkdayjobs.com') || host.includes('capri');
  } catch {
    return false;
  }
}

/* ── Workday API ──────────────────────────────────────────── */

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
 * List all jobs from a Workday site, filtering for Swiss locations.
 * Uses text search + client-side location filtering since location facet IDs are not stable.
 */
async function listSwissJobs(site, brand) {
  const apiUrl = `${WORKDAY_API_BASE}/${site}/jobs`;
  const allPostings = [];

  // Strategy 1: Search for "Switzerland" to find Swiss jobs
  for (const searchText of ['Switzerland', 'Mendrisio', 'Lugano', 'Ticino', '']) {
    let offset = 0;
    const limit = 20;
    while (true) {
      const body = JSON.stringify({ appliedFacets: {}, limit, offset, searchText });
      const data = await fetchJson(apiUrl, { method: 'POST', body });
      if (!data || !Array.isArray(data.jobPostings)) break;

      for (const posting of data.jobPostings) {
        // Check if already found
        if (allPostings.some((p) => p.externalPath === posting.externalPath)) continue;

        // For text searches, all results are relevant; for empty search, filter by location
        if (searchText === '') {
          const fields = [
            posting.locationsText || '',
            posting.title || '',
            ...(posting.bulletFields || []),
          ].join(' ');
          if (!isSwissLocation(fields)) continue;
        }
        allPostings.push({ ...posting, brand });
      }

      if (data.jobPostings.length < limit || (searchText === '' && offset > 200)) break;
      offset += limit;
      // For non-empty search, the results are already filtered, paginate them all
      if (searchText !== '' && allPostings.length >= (data.total || 0)) break;
    }
    // If we found jobs via text search, skip the empty search
    if (searchText !== '' && allPostings.length > 0) continue;
  }

  return allPostings;
}

async function fetchJobDetail(site, externalPath) {
  return fetchJson(`${WORKDAY_API_BASE}/${site}${externalPath}`);
}

/**
 * Fetch all Swiss Capri Holdings jobs across both brand sites.
 */
async function fetchCapriHoldingsJobs() {
  console.log(`🔍 Fetching Capri Holdings jobs from Workday API`);
  console.log(`   Tenant: capri.wd1.myworkdayjobs.com`);
  console.log(`   Sites: ${WORKDAY_SITES.map((s) => s.site).join(', ')}\n`);

  const allSwissListings = [];

  for (const { site, brand } of WORKDAY_SITES) {
    console.log(`  🏷️  Querying ${brand} (${site})...`);
    const listings = await listSwissJobs(site, brand);
    console.log(`     Swiss listings found: ${listings.length}`);
    // Tag with site for detail fetching
    for (const l of listings) l._site = site;
    allSwissListings.push(...listings);
  }

  console.log(`\n  📋 Total Swiss listings across all brands: ${allSwissListings.length}`);
  if (allSwissListings.length === 0) return [];

  const jobs = [];
  for (const listing of allSwissListings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;

    console.log(`  📄 Fetching detail: ${listing.title} [${listing.brand}]`);
    const detail = await fetchJobDetail(listing._site, externalPath);
    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) continue;

    const locationRaw = info.location || listing.locationsText || (listing.bulletFields || [])[0] || '';
    const countryDesc = info.country?.descriptor || '';
    const city = locationRaw.split(/\s*-\s*/).slice(-1)[0]?.trim().replace(/,\s*switzerland$/i, '') || locationRaw;
    const canton = inferCanton(city || locationRaw);

    // Double-check this is actually a Swiss job
    if (countryDesc && !countryDesc.toLowerCase().includes('switzerland') && !countryDesc.toLowerCase().includes('schweiz') && !countryDesc.toLowerCase().includes('suisse') && !countryDesc.toLowerCase().includes('svizzera')) {
      const allText = [locationRaw, city, title, ...listing.bulletFields || []].join(' ');
      if (!isSwissLocation(allText)) {
        console.log(`     ⏭️  Skipped — not Swiss (country: ${countryDesc})`);
        continue;
      }
    }

    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${WORKDAY_PUBLIC_BASE}/${listing._site}${externalPath}`;
    const brand = listing.brand || 'Capri Holdings';
    const descEn = descriptionText || `${title} position at ${brand} in ${city || 'Switzerland'}.`;
    const descIt = `Posizione aperta presso ${brand} (Capri Holdings) a ${city || 'Svizzera'}.\nRuolo: ${title}.\n\nCapri Holdings è un gruppo globale della moda di lusso con i marchi Michael Kors, Versace e Jimmy Choo. L'azienda ha un importante hub logistico a Mendrisio, Canton Ticino.`;
    const slug = slugify(title, 'capri-holdings');

    jobs.push({
      url: publicUrl,
      applyUrl: publicUrl,
      title,
      company: CAPRI_COMPANY_NAME,
      companyKey: CAPRI_KEY,
      location: city || locationRaw || 'Switzerland',
      canton: canton || '',
      country: 'CH',
      addressLocality: city || 'Mendrisio',
      addressRegion: canton || DEFAULT_CANTON,
      addressCountry: 'CH',
      postalCode: city?.toLowerCase() === 'mendrisio' || !city ? '6850' : city?.toLowerCase() === 'stabio' ? '6855' : city?.toLowerCase() === 'coldrerio' ? '6877' : '6850',
      streetAddress: 'Via Penate',
      description: descEn,
      descriptionByLocale: { en: descEn, it: descIt },
      titleByLocale: { en: title },
      slug,
      slugByLocale: { en: slug, it: slugify(title, 'capri-holdings') },
      category: detectCategory(title),
      datePosted: info.startDate || new Date().toISOString().split('T')[0],
      source: 'capri-holdings-workday-crawler',
      employmentType: detectEmploymentType(info.timeType || ''),
      experienceLevel: detectExperienceLevel(title),
      sourceLang: detectLang(descEn || title, 'en'),
      sector: 'Fashion / Luxury Retail',
      _brand: brand,
      _targetScope: { canton: canton || '', location: city || locationRaw || '' },
    });
  }

  console.log(`\n📋 Total unique Capri Holdings Swiss jobs: ${jobs.length}`);
  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */

function canonicalizeUrl(url = '') {
  try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); }
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(CAPRI_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCapriJobs = allJobs.filter((j) => !isCapriJob(j));
  const existingByUrl = new Map();
  for (const job of allJobs.filter(isCapriJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) discoveredByUrl.set(canonicalizeUrl(job.url), job);

  let added = 0, updated = 0, removed = 0;
  const merged = [];

  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url);
    const ex = existingByUrl.get(key);
    if (ex) {
      merged.push({
        ...ex,
        title: d.title || ex.title,
        company: CAPRI_COMPANY_NAME,
        companyKey: CAPRI_KEY,
        location: d.location || ex.location,
        canton: d.canton || ex.canton,
        country: 'CH',
        source: 'capri-holdings-workday-crawler',
        titleByLocale: mergeLocaleTextMap(ex.titleByLocale, d.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, d.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(ex.slugByLocale, d.slugByLocale, 3),
      });
      updated++;
    } else {
      merged.push(d);
      added++;
    }
  }

  for (const [url] of existingByUrl) {
    if (!discoveredByUrl.has(url)) removed++;
  }

  const final = [...nonCapriJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`\n📦 Merge: ➕${added} 🔄${updated} 🗑️${removed} 📊${final.length}`);
  return { added, updated, removed, total: final.length };
}

/* ── Adapter ───────────────────────────────────────────────── */

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${CAPRI_KEY}.json`);
  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  Object.assign(adapter, {
    companyKey: CAPRI_KEY,
    companyName: CAPRI_COMPANY_NAME,
    companyHost: CAPRI_HOST,
    enabled: true,
    priority: Math.max(adapter.priority || 0, 10),
    crawlerModes: ['api'],
    seedUrls: WORKDAY_SITES.map((s) => `${WORKDAY_PUBLIC_BASE}/${s.site}`),
    notes: 'Workday API at capri.wd1.myworkdayjobs.com — Michael Kors + Versace. Swiss positions (Mendrisio TI logistics hub).',
    updatedAt: new Date().toISOString(),
  });

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
}

/* ── Post-processing ──────────────────────────────────────── */

function postProcessCapriJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;
  for (const j of jobs) {
    if (!isCapriJob(j)) continue;
    if (j.company !== CAPRI_COMPANY_NAME) { j.company = CAPRI_COMPANY_NAME; fixed++; }
    j.companyKey = CAPRI_KEY;
    j.country = 'CH';
    if (!j.canton && j.location) {
      j.canton = inferCanton(j.location);
      if (j.canton) fixed++;
    }
    if (!j.location) { j.location = 'Mendrisio'; fixed++; }
  }
  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Capri Holdings jobs.`);
  }
}

/* ── Stats & Validation ────────────────────────────────────── */

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const jobs = allJobs.filter(isCapriJob);

  console.log(`\n📊 === Capri Holdings Job Stats ===`);
  console.log(`  👜 Total Capri Holdings jobs: ${jobs.length}`);
  if (jobs.length > 0) {
    for (const job of jobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'}) [${job._brand || 'Capri'}]`);
    }
  }
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Capri Holdings');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Capri Holdings');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CAPRI_HOLDINGS_STRICT',
    label: 'Capri Holdings',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCapriJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_capri_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Capri Holdings Swiss jobs found — the company may not have active Swiss openings.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(CAPRI_KEY, 'Capri Holdings');
  console.log('═══════════════════════════════════════════════');
  console.log('  Capri Holdings — Dedicated Crawler');
  console.log('  Brands: Michael Kors, Versace, Jimmy Choo');
  console.log('  ATS: Workday (capri.wd1.myworkdayjobs.com)');
  console.log('═══════════════════════════════════════════════\n');

    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(CAPRI_KEY, DATA_JOBS).filter(isCapriJob))

  // Phase 1: Fetch jobs from Workday API
  const discoveredJobs = await fetchCapriHoldingsJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Swiss Capri Holdings jobs discovered.');
    console.log('   The Workday API may have no Swiss openings currently.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
    writeCrawlChangeSummaryToGH(computeCrawlDiff(_beforeSnapshot, new Map()), 'Capri Holdings');
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: CAPRI_KEY,
    localizeOnlyCompanyKeys: CAPRI_KEY,
    forceLocalizeKeys: CAPRI_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });

  // Phase 5: Post-process
  postProcessCapriJobs();

  // Phase 6: Stats & validation
  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total > 0) {
    validateLocaleCoverage();
  } else {
    console.log('ℹ️ No Capri Holdings Swiss jobs found after crawl. Exiting OK.');
  }

  console.log('\n✅ Capri Holdings crawler complete.');

  // Write per-crawler slice and reassemble
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCapriJob) : [];
  writeJobsCrawlerSlice(CAPRI_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: CAPRI_KEY,
    label: 'Capri Holdings',
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
  console.error(`❌ Capri Holdings crawler failed: ${err?.message || err}`);
  process.exit(1);
});
