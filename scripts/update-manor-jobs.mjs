#!/usr/bin/env node
/**
 * Dedicated Manor crawler runner.
 *
 * Source:
 *   https://positions.manor.ch/sitemap.xml
 *   (SAP SuccessFactors / jobs2web platform)
 *
 * This script:
 *   1. Fetches the sitemap.xml from positions.manor.ch.
 *   2. Extracts all job URLs and keeps every Swiss-target store (CH-wide).
 *   3. Fetches job detail pages for title/description/date.
 *   4. Merges discovered jobs into data/jobs.json.
 *   5. Updates the adapter config with discovered seed URLs.
 *   6. Post-processes rows for canonical consistency.
 *   7. Validates locale coverage.
 *
 * Manor AG is a national department-store chain (HQ Basel) with stores in
 * every canton, so the crawler collects CH-wide. Per-job canton is inferred
 * from the store city encoded in the URL via inferAnyCanton; the region gate
 * is isTargetSwissLocation (spans all 26 TARGET_CANTONS).
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
  normalize,
  normalizeKey,
mergeLocaleTextMap,
detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { isTargetSwissLocation, isKnownSwissCity, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { getCompanyDefaults, getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const MANOR_KEY = 'manor';
const DEFAULT_CANTON = getCompanyDefaults(MANOR_KEY)?.canton || 'TI';
const MANOR_COMPANY_NAME = 'Manor AG';
const MANOR_HOST = 'positions.manor.ch';
const MANOR_SITEMAP_URL = 'https://positions.manor.ch/sitemap.xml';
const MANOR_LOCALES = ['it', 'en', 'de', 'fr'];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matcher ───────────────────────────────────────────────── */
function isManorJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === MANOR_KEY ||
    key === 'manor-ag' ||
    key.includes('manor') ||
    company.includes('manor') ||
    host === MANOR_HOST ||
    host === 'careers.manor.ch'
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === MANOR_HOST ||
      host === 'careers.manor.ch' ||
      host === 'www.manor.ch'
    );
  } catch {
    return false;
  }
}

/* ── Category detection ────────────────────────────────────── */
function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/logisti|magazzin|lager|warehouse|entrepôt/i.test(t)) return 'logistics';
  if (/vendita|sales|vente|verkauf|conseill/i.test(t)) return 'sales';
  if (/kassier|cassa|caisse|kasse/i.test(t)) return 'sales';
  if (/cucin|cuisinier|koch|küch|pâtissier|boulanger/i.test(t)) return 'hospitality';
  if (/servizio|service|manora|plongeur/i.test(t)) return 'hospitality';
  if (/supermark|supermarch|epicerie|poissonnerie|caviste|charcuterie|fromage|fruit|légume/i.test(t)) return 'retail';
  if (/merchandis|visual|polydesigner/i.test(t)) return 'design';
  if (/drogist|droguiste|dermacenter|parf[uü]m|beauty/i.test(t)) return 'healthcare';
  if (/hr\b|human|personale|personal|recruiter/i.test(t)) return 'hr';
  if (/market|kommunikation|communication|project/i.test(t)) return 'marketing';
  if (/manager|responsable|floor.manager|team.lead|backoffice/i.test(t)) return 'management';
  if (/apprendista|apprenti|lehrling|lehrstelle|afc|efz|cfc/i.test(t)) return 'apprenticeship';
  if (/controller|finanz|finance|contabil|buchhaltung|comptab/i.test(t)) return 'finance';
  if (/it\b|software|developer|system|informatik/i.test(t)) return 'technology';
  return 'retail'; // default for Manor (department store)
}

/* ── Description builders ──────────────────────────────────── */
function buildDescriptionIt(title, city, canton) {
  const region = getCantonDisplayName(canton, 'it');
  return `${title} presso Manor, con sede a ${city}, Canton ${region}, Svizzera. Manor è una delle principali catene di grandi magazzini svizzere, con una vasta gamma di prodotti tra cui moda, bellezza, casa, alimentari e ristoranti Manora. Questa posizione offre l'opportunità di lavorare in un ambiente dinamico e orientato al cliente.`;
}

function buildDescriptionEn(title, city, canton) {
  const region = getCantonDisplayName(canton, 'en');
  return `${title} at Manor, located in ${city}, Canton of ${region}, Switzerland. Manor is one of Switzerland's leading department store chains, offering a wide range of products including fashion, beauty, home, food, and Manora restaurants. This position offers the opportunity to work in a dynamic, customer-oriented environment.`;
}

function buildDescriptionDe(title, city, canton) {
  const region = getCantonDisplayName(canton, 'de');
  return `${title} bei Manor, gelegen in ${city}, Kanton ${region}, Schweiz. Manor ist eine der führenden Warenhausgruppen der Schweiz mit einem vielfältigen Angebot in den Bereichen Mode, Beauty, Home, Food und Manora-Restaurants. Diese Stelle bietet die Möglichkeit, in einem dynamischen und kundenorientierten Umfeld zu arbeiten.`;
}

function buildDescriptionFr(title, city, canton) {
  const region = getCantonDisplayName(canton, 'fr');
  return `${title} chez Manor, situé à ${city}, Canton de ${region}, Suisse. Manor est l'un des principaux groupes de grands magasins suisses, offrant une large gamme de produits comprenant mode, beauté, maison, alimentation et restaurants Manora. Ce poste offre la possibilité de travailler dans un environnement dynamique et orienté vers le client.`;
}

/* ── HTTP helpers ──────────────────────────────────────────── */
async function fetchText(url, timeoutMs = 15000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Sitemap parser ────────────────────────────────────────── */
function parseSitemapUrls(xml) {
  const urls = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const url = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    urls.push(url);
  }
  return urls;
}

/**
 * Maximum number of leading dash-separated slug segments to treat as a city.
 * Covers multi-word Swiss municipalities like "Affoltern am Albis",
 * "Chavannes de Bogis", "Rickenbach b. Wil".
 */
const MANOR_CITY_MAX_SEGMENTS = 4;

/**
 * Extract the store city from a Manor job URL — CH-wide.
 * Format: /job/{City}-{Title}/{ID}/ where {City} may itself contain dashes.
 *
 * Greedily try the longest leading prefix (up to MANOR_CITY_MAX_SEGMENTS
 * segments) that resolves to a known Swiss city or a target Swiss canton via
 * the central helpers. A trailing numeric district segment (e.g. "Genève 1")
 * is tolerated. Returns the matched city string, or null when no Swiss city is
 * recognisable (the downstream isTargetSwissLocation gate then drops the row).
 */
// Returns { city, segments }: the resolved city and the NUMBER OF DASH-PARTS it
// consumed from the slug. Callers need `segments` (not the rendered city's word
// count) to strip the city prefix from the title — a district-stripped city
// ("Genève-1" → "Genève") consumes 2 dash-parts but renders as 1 word.
function extractCityFromUrl(url) {
  const match = url.match(/\/job\/([^/]+)\//);
  if (!match) return { city: null, segments: 0 };
  let slug;
  try { slug = decodeURIComponent(match[1]); } catch { slug = match[1]; }
  const parts = slug.split('-');
  const maxSeg = Math.min(MANOR_CITY_MAX_SEGMENTS, parts.length);
  for (let n = maxSeg; n >= 1; n--) {
    const candidate = parts.slice(0, n).join(' ').replace(/_/g, '.').trim();
    if (!candidate) continue;
    // Drop a trailing pure-number district suffix ("Genève 1" → "Genève").
    const candidateNoDistrict = candidate.replace(/\s+\d+$/, '').trim();
    for (const c of [candidate, candidateNoDistrict]) {
      if (!c) continue;
      if (isKnownSwissCity(c) || isTargetSwissLocation(c)) return { city: c, segments: n };
    }
  }
  return { city: null, segments: 0 };
}

/**
 * Extract job ID from URL.
 * Format: /job/{slug}/{ID}/
 */
function extractJobId(url) {
  const match = url.match(/\/job\/[^/]+\/(\d+)\/?$/);
  return match ? match[1] : null;
}

/* ── Job detail page parser ────────────────────────────────── */
function parseJobPage(html, url) {
  // Extract title from itemprop="title"
  const titleMatch = html.match(/itemprop="title"[^>]*>([^<]+)/);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Extract description from <span class="jobdescription">
  const descMatch = html.match(/<span class="jobdescription">([\s\S]*?)<\/span>/);
  const rawDesc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  // Extract posted date from itemprop="datePosted"
  const dateMatch = html.match(/itemprop="datePosted"\s+content="([^"]+)"/);
  let postedDate = '';
  if (dateMatch) {
    try {
      postedDate = new Date(dateMatch[1]).toISOString().slice(0, 10);
    } catch { /* ignore */ }
  }

  // Extract location from itemprop="streetAddress"
  const locMatch = html.match(/itemprop="streetAddress"\s+content="([^"]+)"/);
  const location = locMatch ? locMatch[1].trim() : '';

  return { title, description: rawDesc, postedDate, location };
}

/* ── Fetch & parse ─────────────────────────────────────────── */
async function fetchManorJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const delayMs = Number(process.env.MANOR_CRAWL_DELAY_MS) || 1500;

  console.log('🔍 Fetching Manor sitemap...');

  let sitemapXml;
  try {
    sitemapXml = await fetchText(MANOR_SITEMAP_URL, timeoutMs);
  } catch (err) {
    console.error(`❌ Failed to fetch Manor sitemap: ${err?.message || err}`);
    throw err;
  }

  const allUrls = parseSitemapUrls(sitemapXml);
  console.log(`📋 Sitemap returned ${allUrls.length} total job URLs.`);

  // Keep every store URL whose city resolves to a target Swiss canton (CH-wide).
  const targetUrls = [];
  for (const url of allUrls) {
    const { city } = extractCityFromUrl(url);
    if (city && isTargetSwissLocation(city)) {
      targetUrls.push({ url, city });
    }
  }
  console.log(`📋 Swiss-target job URLs: ${targetUrls.length}`);

  if (targetUrls.length === 0) {
    console.log('ℹ️  No Swiss-target job listings found in sitemap.');
    return [];
  }

  const jobs = [];

  // Fetch detail pages for each target job
  for (let i = 0; i < targetUrls.length; i++) {
    const { url, city } = targetUrls[i];
    const jobId = extractJobId(url) || '';

    console.log(`  📄 [${i + 1}/${targetUrls.length}] Fetching: ${url}`);

    let pageData;
    try {
      const html = await fetchText(url, timeoutMs);
      pageData = parseJobPage(html, url);
    } catch (err) {
      console.warn(`  ⚠️  Failed to fetch job detail: ${err?.message || err}`);
      // Still include with minimal data from URL
      pageData = {
        title: extractTitleFromUrl(url),
        description: '',
        postedDate: '',
        location: `${city}, CH`,
      };
    }

    const title = pageData.title || extractTitleFromUrl(url);
    if (!title) {
      console.log(`  ⚠️  Skipping job ${jobId}: no title`);
      continue;
    }

    const category = detectCategory(title);

    // Per-job canton inferred CH-wide from the store city; HQ default only as
    // a last resort when the central helper cannot resolve a code. City-first
    // (not a combined string): inferAnyCanton returns the first canton in
    // TARGET_CANTONS array order, so a combined "city + detail location" string
    // could let the detail location's canton override the URL-derived store
    // city. Resolve city alone first, fall back to detail location.
    const canton = inferAnyCanton(city) || inferAnyCanton(pageData.location || '') || DEFAULT_CANTON;

    // Use page description if substantial, otherwise template
    const pageDesc = (pageData.description || '').trim();
    const descIt = pageDesc.length >= 100
      ? pageDesc
      : buildDescriptionIt(title, city, canton);
    const descEn = buildDescriptionEn(title, city, canton);
    const descDe = buildDescriptionDe(title, city, canton);
    const descFr = buildDescriptionFr(title, city, canton);

    const baseSlug = normalizeKey(`manor ${title} ${city}`);

    const job = {
      title,
      company: MANOR_COMPANY_NAME,
      companyKey: MANOR_KEY,
      url,
      location: city,
      canton,
      country: 'CH',
      category,
      description: descIt,
      descriptionIt: descIt,
      descriptionByLocale: {
        it: descIt,
        en: descEn,
        de: descDe,
        fr: descFr,
      },
      postedDate: pageData.postedDate || '',
      source: 'company-website',
      slug: baseSlug,
      slugByLocale: {
        it: baseSlug,
      },
      titleByLocale: {
        it: title,
      },
      sourceLang: detectLang(descIt || title, 'de'),
    };

    console.log(`  ✅ ${title} — Manor @ ${city} (id: ${jobId})`);
    jobs.push(job);

    // Rate-limit between requests
    if (i < targetUrls.length - 1) {
      await sleep(delayMs);
    }
  }

  console.log(`📋 Total unique Manor Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}

/**
 * Extract a human-readable title from the URL slug.
 * e.g. /job/Lugano-Collaboratoretrice-logistica-60/1344050855/
 *   → "Collaboratoretrice logistica 60"
 */
function extractTitleFromUrl(url) {
  const match = url.match(/\/job\/([^/]+)\//);
  if (!match) return '';
  let slug;
  try { slug = decodeURIComponent(match[1]); } catch { slug = match[1]; }
  const parts = slug.split('-');
  // Strip the leading city prefix (CH-wide, possibly multi-word) when present.
  // Use the dash-part count the matcher consumed — NOT the rendered city's word
  // count — so a district-stripped city ("Genève-1") doesn't leave "1" in the title.
  const { segments: citySegments } = extractCityFromUrl(url);
  const titleParts = citySegments > 0 ? parts.slice(citySegments) : parts;
  return titleParts.join(' ').replace(/_/g, '.').trim();
}

/* ── Merge into jobs.json ──────────────────────────────────── */

function mergeManorJobs(discoveredJobs) {
  let allJobs = [];
  if (fs.existsSync(DATA_JOBS)) {
    allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    if (!Array.isArray(allJobs)) allJobs = [];
  }

  // Index existing Manor jobs by URL
  const existingByUrl = new Map();
  for (const j of allJobs) {
    if (isManorJob(j)) {
      const key = String(j.url || '').toLowerCase().replace(/\/+$/, '');
      existingByUrl.set(key, j);
    }
  }

  let added = 0;
  let updated = 0;

  for (const job of discoveredJobs) {
    const key = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const existing = existingByUrl.get(key);
    if (existing) {
      existing.title = job.title;
      existing.company = job.company;
      existing.companyKey = job.companyKey;
      existing.location = job.location;
      existing.canton = job.canton;
      existing.country = job.country;
      existing.category = job.category;
      existing.description = job.description;
      existing.descriptionIt = job.descriptionIt;
      existing.descriptionByLocale = mergeLocaleTextMap(existing.descriptionByLocale, job.descriptionByLocale, 30);
      existing.postedDate = job.postedDate || existing.postedDate;
      existing.source = job.source;
      existing.slugByLocale = mergeLocaleTextMap(existing.slugByLocale, job.slugByLocale, 3);
      existing.titleByLocale = mergeLocaleTextMap(existing.titleByLocale, job.titleByLocale, 2);
      updated++;
      existingByUrl.delete(key);
    } else {
      allJobs.push(job);
      added++;
    }
  }

  // Remove Manor jobs no longer in the feed
  const discoveredUrls = new Set(
    discoveredJobs.map((j) => String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  );
  const removed = allJobs.filter(
    (j) =>
      isManorJob(j) &&
      !discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  ).length;

  const finalJobs = allJobs.filter(
    (j) =>
      !isManorJob(j) ||
      discoveredUrls.has(String(j.url || '').toLowerCase().replace(/\/+$/, ''))
  );

  writeJson(DATA_JOBS, finalJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, finalJobs);

  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  ➖ Removed: ${removed}`);
  console.log(`  📦 Total jobs in file: ${finalJobs.length}`);
}

/* ── Adapter update ────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${MANOR_KEY}.json`);
  let adapter = {};
  try {
    adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  } catch { /* first run */ }

  const seedMetaByUrl = {};
  for (const url of seedUrls) {
    seedMetaByUrl[url] = {
      company: MANOR_COMPANY_NAME,
      companyDomain: 'manor.ch',
    };
  }

  adapter = {
    ...adapter,
    companyKey: MANOR_KEY,
    companyName: MANOR_COMPANY_NAME,
    companyHost: MANOR_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['sitemap'],
    seedUrls,
    seedMetaByUrl,
    notes:
      'Sitemap-based crawler — positions.manor.ch (SAP SuccessFactors / jobs2web). Manor AG national department-store chain (HQ Basel) — collects CH-wide across all target cantons.',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Run shared crawler for localization ───────────────────── */
async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MANOR_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcessManorJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;

  let changed = false;
  const seenKeys = new Map();

  const processed = jobs.filter((job) => {
    if (!isManorJob(job)) return true;

    // Canonicalize company key
    if (job.companyKey !== MANOR_KEY) {
      job.companyKey = MANOR_KEY;
      changed = true;
    }

    // Deduplicate by URL
    const url = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const dedupKey = url || normalizeKey(job.slug || job.title || '');
    if (seenKeys.has(dedupKey)) return false;
    seenKeys.set(dedupKey, true);

    return true;
  });

  if (changed || processed.length !== jobs.length) {
    writeJson(DATA_JOBS, processed);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, processed);
    console.log(`🔧 Post-processed: ${jobs.length} → ${processed.length} jobs`);
  }
}

/* ── Stats ─────────────────────────────────────────────────── */
function logStats(before) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const manorJobs = Array.isArray(jobs) ? jobs.filter(isManorJob) : [];
  const after = snapshotJobSlugs(manorJobs);
  const diff = computeCrawlDiff(before, after);
  printCrawlChangeSummary(diff, 'Manor');
  writeCrawlChangeSummaryToGH(diff, 'Manor');

  console.log(`\n🏬 Total Manor jobs: ${manorJobs.length}`);
  for (const j of manorJobs) {
    console.log(`  • ${j.title} — ${j.company} (${j.location}, ${j.canton || j.country || '?'})`);
  return diff;
  }
}

/* ── Locale validation ─────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MANOR_STRICT',
    label: 'Manor',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isManorJob,
    locales: MANOR_LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_manor_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Manor jobs found — the company may not have active Swiss openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(MANOR_KEY, 'Manor');
  console.log('═══════════════════════════════════════════════');
  console.log('  Manor AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  // Snapshot before
  const beforeMap = snapshotJobSlugs(readExistingCrawlerJobs(MANOR_KEY, DATA_JOBS).filter(isManorJob))

  // Phase 1: discover jobs from sitemap
  const discoveredJobs = await fetchManorJobs();

  if (discoveredJobs.length === 0) {
    console.log('ℹ️  No Swiss job listings found — skipping crawl.');
    return;
  }

  // Phase 2: merge into jobs.json
  const seedUrls = discoveredJobs.map((j) => j.url);
  mergeManorJobs(discoveredJobs);

  // Phase 3: update adapter
  updateAdapterConfig(seedUrls);

  // Phase 4: run shared crawler for AI localization
  await runBaseCrawler();

  // Phase 5: post-process
  postProcessManorJobs();

  // Phase 6: log stats
  const diff = logStats(beforeMap);

  // Phase 7: locale validation
  validateLocales();

  console.log('✅ Manor crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isManorJob) : [];
  writeJobsCrawlerSlice(MANOR_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MANOR_KEY,
    label: 'Manor',
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

main().catch((err) => exitCrawlerOnError(err, 'Manor'));
