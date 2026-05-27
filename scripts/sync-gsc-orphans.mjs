#!/usr/bin/env node
/**
 * sync-gsc-orphans.mjs
 *
 * Synchronizes orphan job slugs from Google Search Console, enriches them
 * from all available local + remote sources, and writes
 * `data/orphan-enriched-data.json` used by the build plugin.
 *
 * Usage:
 *   node scripts/load-rc-env.mjs && node scripts/sync-gsc-orphans.mjs
 *   node scripts/sync-gsc-orphans.mjs --dry-run
 *   node scripts/sync-gsc-orphans.mjs --days=480   # custom lookback window
 *
 * Environment variables (required):
 *   GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN
 *
 * Optional env flags:
 *   ENABLE_URL_INSPECTION=1   Enable URL Inspection API enrichment (max 500/run)
 *   ENABLE_WAYBACK=1          Enable Wayback Machine enrichment (max 200/run)
 *
 * CLI flags:
 *   --dry-run      Skip all file writes
 *   --days=N       Override GSC lookback window (default 480, max 540 — GSC retains ~16 months)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCityCantonIndex,
  buildOrphanLocalePaths,
} from './lib/orphan-canton-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SITE_URL = 'https://frontaliereticino.ch';
let resolvedSiteUrl = SITE_URL;
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Reserved hub slugs that MUST NOT be written into all-known-job-slugs.json.
 * These paths are owned by jobSectorPagesPlugin / cityJobsHubPlugin and the
 * SPA router treats them as sector/city hubs, not job details. If they leak
 * into the tracking file the soft-landing generator clobbers the hub HTML.
 *
 * Mirror of SECTOR_HUB_SLUG (build-plugins/jobSectorLanding.ts) +
 * CITY_HUB_SLUG (build-plugins/cityJobsHub.ts), kept in sync manually.
 */
const RESERVED_HUB_SLUGS = new Set([
  // Sector hubs (10 sectors × 4 locales = 40 slugs)
  'infermieri', 'nurses', 'pflegepersonal', 'infirmiers',
  'case-anziani', 'elderly-care', 'altenpflege', 'maisons-retraite',
  'educatori', 'educators', 'erzieher', 'educateurs',
  'ingegneri', 'engineers', 'ingenieure', 'ingenieurs',
  'autisti', 'drivers', 'fahrer', 'chauffeurs',
  'sviluppatori', 'developers', 'entwickler', 'developpeurs',
  'ristorazione', 'restaurants', 'gastronomie', 'restauration',
  'operatori-socio-sanitari', 'healthcare-assistants', 'pflegeassistenten', 'aides-soignants',
  'logistica', 'logistics', 'logistik', 'logistique',
  'apprendistato', 'apprenticeships', 'lehrstellen', 'apprentissages',
  // City hubs (5 cities — same slug across all locales)
  'lugano', 'mendrisio', 'bellinzona', 'locarno', 'chiasso',
]);

// Window configuration — GSC retains Search Analytics for ~16 months (~480 days).
// Default to 480; allow override via --days=N for shorter ad-hoc runs.
const DEFAULT_WINDOW_DAYS = 480;
function parseWindowDays() {
  const flag = process.argv.find((a) => a.startsWith('--days='));
  if (flag) {
    const n = parseInt(flag.slice('--days='.length), 10);
    if (Number.isFinite(n) && n > 0 && n <= 540) return n;
    console.warn(`⚠️  Invalid --days value; falling back to ${DEFAULT_WINDOW_DAYS}`);
  }
  return DEFAULT_WINDOW_DAYS;
}
const WINDOW_DAYS = parseWindowDays();

// ── Env ──────────────────────────────────────────────────
const GSC_CLIENT_ID = process.env.GSC_CLIENT_ID || '';
const GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || '';
const GSC_REFRESH_TOKEN = process.env.GSC_REFRESH_TOKEN || '';

const ENABLE_URL_INSPECTION = process.env.ENABLE_URL_INSPECTION === '1';
const ENABLE_WAYBACK = process.env.ENABLE_WAYBACK === '1';

// ── Locale path prefixes ─────────────────────────────────
const LOCALE_PREFIXES = {
  it: ['/cerca-lavoro-ticino/'],
  en: ['/en/find-jobs-ticino/', '/en/find-job-ticino/', '/en/job-search-ticino/'],
  de: ['/de/jobs-im-tessin/', '/de/jobsuche-tessin/', '/de/stellenangebote-tessin/'],
  fr: ['/fr/recherche-emploi-tessin/', '/fr/trouver-emploi-tessin/', '/fr/emplois-tessin/'],
};

const ALL_PREFIXES = Object.values(LOCALE_PREFIXES).flat();

// Non-job slug prefixes that should be filtered out of the orphan pool.
// These are company pages, search pages, etc. — not actual job detail pages.
const NON_JOB_SLUG_PREFIXES = [
  'ricerca-', 'search-', 'suche-', 'recherche-',
  'azienda-', 'company-', 'unternehmen-', 'entreprise-',
];

function isNonJobSlug(slug) {
  return NON_JOB_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

// ── Helpers ──────────────────────────────────────────────
function dataPath(...segments) {
  return path.join(ROOT, 'data', ...segments);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function extractSlugFromPath(urlPath) {
  for (const prefix of ALL_PREFIXES) {
    if (urlPath.startsWith(prefix)) {
      const slug = urlPath.slice(prefix.length).replace(/\/$/, '');
      if (slug && !slug.includes('/')) return slug;
    }
  }
  return null;
}

function detectLocaleFromPath(urlPath) {
  for (const [locale, prefixes] of Object.entries(LOCALE_PREFIXES)) {
    for (const prefix of prefixes) {
      if (urlPath.startsWith(prefix)) return locale;
    }
  }
  return 'it';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── OAuth2 ───────────────────────────────────────────────
async function getAccessToken() {
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REFRESH_TOKEN) {
    throw new Error('Missing GSC_CLIENT_ID, GSC_CLIENT_SECRET, or GSC_REFRESH_TOKEN');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GSC_CLIENT_ID,
      client_secret: GSC_CLIENT_SECRET,
      refresh_token: GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`OAuth token error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// ── Auto-detect GSC site property ────────────────────────
async function detectSiteProperty(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.warn(`⚠️  GSC site list failed (${res.status}) — using default ${SITE_URL}`);
      return;
    }
    const data = await res.json();
    const sites = (data.siteEntry || []).map(s => s.siteUrl);

    // Prefer exact URL-prefix match
    const urlPrefix = sites.find(s => s === SITE_URL || s === SITE_URL + '/');
    if (urlPrefix) {
      resolvedSiteUrl = urlPrefix.replace(/\/$/, '');
      console.log(`✅ GSC site found: ${resolvedSiteUrl} (URL-prefix)`);
      return;
    }

    // Try domain property
    const domain = sites.find(s => s.startsWith('sc-domain:') && SITE_URL.includes(s.replace('sc-domain:', '')));
    if (domain) {
      resolvedSiteUrl = domain;
      console.log(`✅ GSC site found: ${domain} (domain property)`);
      return;
    }

    console.warn(`⚠️  No matching GSC site found. Registered: ${sites.join(', ') || '(none)'}`);
  } catch (err) {
    console.warn(`⚠️  GSC site detection failed: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════
// STEP 1 — Import from GSC
// ══════════════════════════════════════════════════════════

async function fetchGscJobUrls(accessToken) {
  console.log('🔍 Step 1: Querying GSC Search Analytics API...');

  const endDate = new Date().toISOString().slice(0, 10);
  const startMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  console.log(`  📅 Window: ${startDate} → ${endDate} (${WINDOW_DAYS} days)`);

  /** @type {Map<string, { slug: string, locale: string, path: string, queries: {query: string, clicks: number, impressions: number}[], totalImpressions: number, totalClicks: number }>} */
  const slugMap = new Map();

  // Query per locale group to get best coverage
  const filterExpressions = [
    '/cerca-lavoro-ticino/',
    '/en/find-jobs-ticino/',    // current route (plural)
    '/en/find-job-ticino/',     // legacy route (singular)
    '/en/job-search-ticino/',
    '/de/jobs-im-tessin/',
    '/de/jobsuche-tessin/',
    '/de/stellenangebote-tessin/',  // old DE prefix
    '/fr/recherche-emploi-tessin/',
    '/fr/trouver-emploi-tessin/',
    '/fr/emplois-tessin/',          // old FR prefix
  ];

  for (const expression of filterExpressions) {
    let startRow = 0;
    let pageCount = 0;

    while (true) {
      const res = await fetch(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(resolvedSiteUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            startDate,
            endDate,
            dimensions: ['page', 'query'],
            dimensionFilterGroups: [
              {
                filters: [
                  {
                    dimension: 'page',
                    operator: 'contains',
                    expression,
                  },
                ],
              },
            ],
            rowLimit: 25000,
            startRow,
          }),
        },
      );

      if (!res.ok) {
        const errText = await res.text();
        console.error(`  ❌ GSC API error for "${expression}": ${res.status} ${errText}`);
        break;
      }

      const data = await res.json();
      const rows = data.rows || [];
      if (rows.length === 0) break;
      pageCount++;

      for (const row of rows) {
        const pageUrl = row.keys?.[0] || '';
        const query = row.keys?.[1] || '';
        const clicks = row.clicks || 0;
        const impressions = row.impressions || 0;

        let urlPath;
        try {
          urlPath = new URL(pageUrl).pathname;
        } catch {
          continue;
        }

        const slug = extractSlugFromPath(urlPath);
        if (!slug) continue;

        const locale = detectLocaleFromPath(urlPath);
        const key = `${locale}:${slug}`;

        if (!slugMap.has(key)) {
          slugMap.set(key, {
            slug,
            locale,
            path: urlPath,
            queries: [],
            totalImpressions: 0,
            totalClicks: 0,
          });
        }

        const entry = slugMap.get(key);
        entry.queries.push({ query, clicks, impressions });
        entry.totalImpressions += impressions;
        entry.totalClicks += clicks;
      }

      startRow += rows.length;
      if (rows.length < 25000) break;
    }

    if (pageCount > 0) {
      console.log(`  📄 "${expression}": ${pageCount} page(s) fetched`);
    }
  }

  console.log(`  📊 Total GSC entries: ${slugMap.size} (slug+locale pairs)`);
  return slugMap;
}

// ══════════════════════════════════════════════════════════
// STEP 2 — Identify orphans
// ══════════════════════════════════════════════════════════

function buildKnownSlugsSet() {
  console.log('\n🔍 Step 2: Building known slugs set...');
  const known = new Set();

  function addSlug(s) {
    if (s && typeof s === 'string') known.add(s);
  }

  function addJobSlugs(job) {
    addSlug(job.slug);
    if (job.slugByLocale) {
      for (const s of Object.values(job.slugByLocale)) addSlug(s);
    }
    if (Array.isArray(job.previousSlugs)) {
      for (const s of job.previousSlugs) addSlug(s);
    }
  }

  // 1. Active jobs
  const activeJobs = readJsonSafe(dataPath('jobs.json'));
  if (Array.isArray(activeJobs)) {
    for (const job of activeJobs) addJobSlugs(job);
    console.log(`  📦 Active jobs: ${activeJobs.length} (${known.size} slugs so far)`);
  }

  // 2. Expired jobs
  const expiredJobs = readJsonSafe(dataPath('expired-jobs.json'));
  if (Array.isArray(expiredJobs)) {
    for (const job of expiredJobs) addJobSlugs(job);
    console.log(`  📦 Expired jobs: ${expiredJobs.length} (${known.size} slugs so far)`);
  }

  // 3. All-known-job-slugs
  const allKnown = readJsonSafe(dataPath('all-known-job-slugs.json'));
  if (allKnown && typeof allKnown === 'object') {
    for (const slug of Object.keys(allKnown)) addSlug(slug);
    console.log(`  📦 all-known-job-slugs: ${Object.keys(allKnown).length} entries (${known.size} slugs so far)`);
  }

  // 4. Per-crawler slices
  const crawlerDir = dataPath('jobs', 'by-crawler');
  if (fs.existsSync(crawlerDir)) {
    let crawlerCount = 0;
    for (const file of fs.readdirSync(crawlerDir).filter((f) => f.endsWith('.json'))) {
      const data = readJsonSafe(path.join(crawlerDir, file));
      if (data?.jobs && Array.isArray(data.jobs)) {
        for (const job of data.jobs) addJobSlugs(job);
        crawlerCount++;
      }
    }
    console.log(`  📦 Crawler slices: ${crawlerCount} files (${known.size} slugs so far)`);
  }

  // 5. Per-crawler expired
  const expiredCrawlerDir = dataPath('jobs', 'expired', 'by-crawler');
  if (fs.existsSync(expiredCrawlerDir)) {
    let expiredCrawlerCount = 0;
    for (const file of fs.readdirSync(expiredCrawlerDir).filter((f) => f.endsWith('.json'))) {
      const data = readJsonSafe(path.join(expiredCrawlerDir, file));
      if (Array.isArray(data)) {
        for (const job of data) addJobSlugs(job);
        expiredCrawlerCount++;
      }
    }
    console.log(`  📦 Expired crawler slices: ${expiredCrawlerCount} files (${known.size} slugs so far)`);
  }

  console.log(`  ✅ Total known slugs: ${known.size}`);
  return known;
}

function identifyOrphans(gscMap, knownSlugs) {
  const orphans = [];
  let matchedCount = 0;
  let filteredNonJob = 0;

  for (const [, entry] of gscMap) {
    if (knownSlugs.has(entry.slug)) {
      matchedCount++;
    } else if (isNonJobSlug(entry.slug)) {
      filteredNonJob++;
    } else {
      orphans.push(entry);
    }
  }

  orphans.sort((a, b) => b.totalImpressions - a.totalImpressions);

  console.log(`  🔗 Matched (not orphan): ${matchedCount}`);
  if (filteredNonJob > 0) console.log(`  🏷️  Filtered non-job slugs: ${filteredNonJob}`);
  console.log(`  🚨 Orphans found: ${orphans.length}`);

  if (orphans.length > 0) {
    console.log('  Top 10 orphans by impressions:');
    for (const o of orphans.slice(0, 10)) {
      console.log(`    ❌ ${o.slug} (${o.locale}) — ${o.totalImpressions} imp, ${o.totalClicks} clicks`);
    }
  }

  return orphans;
}

// ══════════════════════════════════════════════════════════
// STEP 3 — Enrich from local sources
// ══════════════════════════════════════════════════════════

function buildSlugInfoExtractor() {
  // Build company slug lookup from crawler adapters
  const adapterDir = path.join(ROOT, 'data/jobs-crawler-adapters/adapters');
  const companySlugMap = [];
  const seenCompanySlugs = new Set();
  try {
    for (const f of fs.readdirSync(adapterDir).filter((n) => n.endsWith('.json'))) {
      const d = readJsonSafe(path.join(adapterDir, f));
      const name = d?.companyName || d?.company || '';
      if (!name) continue;
      const adapterSlug = f.replace('.json', '');
      companySlugMap.push({ slug: adapterSlug, name });
      seenCompanySlugs.add(adapterSlug);
      const nameSlug = name
        .toLowerCase()
        .replace(/[–—]/g, '-')
        .replace(/[()]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
      if (nameSlug && nameSlug !== adapterSlug && !seenCompanySlugs.has(nameSlug)) {
        companySlugMap.push({ slug: nameSlug, name });
        seenCompanySlugs.add(nameSlug);
      }
    }
  } catch { /* adapters dir missing */ }
  companySlugMap.sort((a, b) => b.slug.length - a.slug.length);

  // Build location lookup from swiss postal codes
  const plzData = readJsonSafe(path.join(ROOT, 'data/swiss-postal-codes.json')) || {};
  const locationNames = Object.keys(plzData).sort((a, b) => b.length - a.length);
  const locationSlugPairs = locationNames.map((name) => ({
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    postalCode: plzData[name],
  }));

  const slugStopFragments = new Set([
    'm-f', 'f-m', 'm-w', 'f-m-d', 'm-w-d', 'm-f-d', 'w-m-d', 'w-m',
    '100', '80', '60', '80-100', '60-100', '60-80',
    'afc', 'cfp', 'a', 'o', 'e', 'm', 'f', 'd', 'w',
  ]);

  const broadLocations = {
    'grigioni': 'Grigioni', 'graubunden': 'Graubünden', 'st-moritz': 'St. Moritz',
    'coira': 'Coira', 'chur': 'Chur', 'davos': 'Davos', 'berna': 'Berna',
    'zurigo': 'Zurigo', 'zurich': 'Zürich', 'basilea': 'Basilea', 'ginevra': 'Ginevra',
    'losanna': 'Losanna', 'lucerna': 'Lucerna', 'anniviers': 'Anniviers',
    'domat-ems': 'Domat/Ems',
  };

  console.log(`  📚 Slug info extractor: ${companySlugMap.length} company patterns, ${locationSlugPairs.length} locations`);

  return function extractInfoFromSlug(slug) {
    let remaining = slug;
    let company = '';
    let companyKey = '';
    let location = '';

    // 1. Match company (longest slug match first)
    for (const c of companySlugMap) {
      if (remaining.includes(c.slug)) {
        company = c.name;
        companyKey = c.slug;
        remaining = remaining.replace(c.slug, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
        break;
      }
    }

    // 2. Match location (end of slug preferred)
    for (const loc of locationSlugPairs) {
      if (remaining.endsWith(loc.slug) || remaining.endsWith('-' + loc.slug)) {
        location = loc.name.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        remaining = remaining.replace(new RegExp('-?' + loc.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
        break;
      }
      if (!location && remaining.includes('-' + loc.slug + '-')) {
        location = loc.name.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        remaining = remaining.replace('-' + loc.slug + '-', '-').replace(/^-+|-+$/g, '');
      }
    }

    // Broader Swiss locations
    if (!location) {
      for (const [locSlug, locName] of Object.entries(broadLocations)) {
        if (locName && (remaining.endsWith(locSlug) || remaining.endsWith('-' + locSlug))) {
          location = locName;
          remaining = remaining.replace(new RegExp('-?' + locSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
          break;
        }
      }
    }

    // 3. Build title from remaining
    remaining = remaining.replace(/^\d+-/, '');
    const parts = remaining.split('-').filter((p) => p && !slugStopFragments.has(p));
    const title = parts
      .join(' ')
      .replace(/amp\s/g, '& ')
      .replace(/\bdot\b/g, '.')
      .replace(/^./, (c) => c.toUpperCase())
      .trim();

    return { title: title || slug, company, companyKey, location };
  };
}

function enrichFromLocalSources(orphans) {
  console.log('\n🔍 Step 3: Enriching from local sources...');

  // Build slug info extractor for company/location/title extraction
  const extractInfoFromSlug = buildSlugInfoExtractor();

  // Load translation cache (all files)
  const translationCache = new Map();
  const cacheDir = dataPath('translation-cache');
  let cacheFileCount = 0;
  if (fs.existsSync(cacheDir)) {
    for (const file of fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))) {
      const companyKey = file.replace('.json', '');
      const data = readJsonSafe(path.join(cacheDir, file));
      if (data && typeof data === 'object') {
        for (const [slug, entry] of Object.entries(data)) {
          if (entry?.translations) {
            translationCache.set(slug, { ...entry, companyKey });
          }
        }
        cacheFileCount++;
      }
    }
  }
  console.log(`  📚 Translation cache: ${cacheFileCount} files, ${translationCache.size} slug entries`);

  // Load slug registry
  const slugRegistry = readJsonSafe(dataPath('slug-registry.json')) || {};
  // Build reverse lookup: slug → registry entry
  const registryBySlug = new Map();
  for (const [key, entry] of Object.entries(slugRegistry)) {
    if (entry.canonicalSlug) registryBySlug.set(entry.canonicalSlug, { ...entry, registryKey: key });
    if (entry.slugByLocale) {
      for (const s of Object.values(entry.slugByLocale)) {
        if (s && !registryBySlug.has(s)) registryBySlug.set(s, { ...entry, registryKey: key });
      }
    }
  }
  console.log(`  📚 Slug registry: ${Object.keys(slugRegistry).length} entries, ${registryBySlug.size} slug lookups`);

  // Load all-known-job-slugs for locale paths
  const allKnownSlugs = readJsonSafe(dataPath('all-known-job-slugs.json')) || {};
  console.log(`  📚 All-known-job-slugs: ${Object.keys(allKnownSlugs).length} entries`);

  // Enrich each orphan
  let enrichedFromCache = 0;
  let enrichedFromRegistry = 0;
  let enrichedFromKnown = 0;
  let enrichedFromSlugParsing = 0;

  const enriched = orphans.map((orphan) => {
    const result = {
      slug: orphan.slug,
      locale: orphan.locale,
      path: orphan.path,
      queries: Array.isArray(orphan.queries)
        ? orphan.queries.sort((a, b) => b.impressions - a.impressions).slice(0, 20)
        : [],
      totalImpressions: orphan.totalImpressions || 0,
      totalClicks: orphan.totalClicks || 0,
      topQuery: null,
      title: '',
      titleByLocale: { it: '', en: '', de: '', fr: '' },
      descriptionByLocale: { it: '', en: '', de: '', fr: '' },
      company: '',
      companyKey: '',
      location: '',
      sector: '',
      salaryMin: 0,
      salaryCurrency: 'CHF',
      slugByLocale: {},
      localePaths: {},
      sourceUrl: '',
      googleStatus: 'unknown',
      googleCanonical: '',
      lastCrawlTime: '',
      source: ['gsc'],
    };

    // Top query
    if (result.queries.length > 0) {
      result.topQuery = result.queries[0].query;
    }

    // Enrich from translation cache
    const cached = translationCache.get(orphan.slug);
    if (cached?.translations) {
      const { titles, descriptions } = cached.translations;
      if (titles) {
        result.titleByLocale = {
          it: titles.it || '',
          en: titles.en || '',
          de: titles.de || '',
          fr: titles.fr || '',
        };
        result.title = titles[orphan.locale] || titles.it || Object.values(titles).find(Boolean) || '';
      }
      if (descriptions) {
        result.descriptionByLocale = {
          it: descriptions.it || '',
          en: descriptions.en || '',
          de: descriptions.de || '',
          fr: descriptions.fr || '',
        };
      }
      if (cached.companyKey) {
        result.companyKey = cached.companyKey;
        // Convert company key to display name (kebab-case → Title Case)
        result.company = cached.companyKey
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      }
      result.source.push('translation-cache');
      enrichedFromCache++;
    }

    // Enrich from slug registry
    const regEntry = registryBySlug.get(orphan.slug);
    if (regEntry) {
      if (regEntry.slugByLocale) {
        result.slugByLocale = { ...regEntry.slugByLocale };
      }
      if (regEntry.registryKey?.startsWith('url|')) {
        result.sourceUrl = regEntry.registryKey.slice(4);
      }
      result.source.push('slug-registry');
      enrichedFromRegistry++;
    }

    // Enrich from all-known-job-slugs
    const knownEntry = allKnownSlugs[orphan.slug];
    if (knownEntry && typeof knownEntry === 'object') {
      result.localePaths = { ...knownEntry };
      if (!result.slugByLocale || Object.keys(result.slugByLocale).length === 0) {
        // Derive slug from paths
        for (const [loc, p] of Object.entries(knownEntry)) {
          const s = extractSlugFromPath(p);
          if (s) {
            if (!result.slugByLocale) result.slugByLocale = {};
            result.slugByLocale[loc] = s;
          }
        }
      }
      result.source.push('all-known-slugs');
      enrichedFromKnown++;
    }

    // Extract company/location/title from slug structure when not already enriched
    if (!result.companyKey && orphan.slug) {
      const info = extractInfoFromSlug(orphan.slug);
      if (info.companyKey) {
        result.companyKey = info.companyKey;
        if (!result.company) result.company = info.company;
        enrichedFromSlugParsing++;
      }
      if (info.location && !result.location) {
        result.location = info.location;
      }
      if (!result.title && info.title) {
        result.title = info.title;
      }
      if (info.companyKey || info.location) {
        result.source.push('slug-parsing');
      }
    }

    // Final fallback: simple de-slugify if title still empty
    if (!result.title && orphan.slug) {
      result.title = orphan.slug
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    return result;
  });

  console.log(`  ✅ Enriched from translation cache: ${enrichedFromCache}`);
  console.log(`  ✅ Enriched from slug registry: ${enrichedFromRegistry}`);
  console.log(`  ✅ Enriched from all-known-slugs: ${enrichedFromKnown}`);
  console.log(`  ✅ Enriched from slug parsing (company/location): ${enrichedFromSlugParsing}`);

  return enriched;
}

// ══════════════════════════════════════════════════════════
// STEP 4 — Remote enrichment (optional)
// ══════════════════════════════════════════════════════════

async function enrichUrlInspection(enrichedOrphans, accessToken) {
  if (!ENABLE_URL_INSPECTION) {
    console.log('\n⏭️  Step 4a: URL Inspection API — skipped (ENABLE_URL_INSPECTION not set)');
    return;
  }
  console.log('\n🔍 Step 4a: URL Inspection API enrichment...');

  // Load existing results
  const resultsPath = dataPath('url-inspection-results.json');
  const existingResults = readJsonSafe(resultsPath) || [];
  const resultsBySlug = new Map();
  for (const r of existingResults) {
    if (r.slug) resultsBySlug.set(r.slug, r);
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Filter orphans needing inspection: no recent data + sorted by impressions
  const needsInspection = enrichedOrphans
    .filter((o) => {
      const existing = resultsBySlug.get(o.slug);
      if (existing?.inspectedAt && new Date(existing.inspectedAt).getTime() > sevenDaysAgo) {
        return false; // Recent data exists
      }
      return true;
    })
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .slice(0, 500); // Cap at 500

  console.log(`  📊 Eligible for inspection: ${needsInspection.length}`);

  let inspected = 0;
  let errors = 0;

  for (const orphan of needsInspection) {
    const inspectionUrl = `${SITE_URL}${orphan.path}`;
    try {
      const res = await fetch(
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inspectionUrl,
            siteUrl: resolvedSiteUrl,
          }),
        },
      );

      if (res.status === 429) {
        console.warn('  ⚠️  Rate limited by URL Inspection API — stopping');
        break;
      }

      if (!res.ok) {
        errors++;
        if (errors > 10) {
          console.warn('  ⚠️  Too many errors — stopping URL Inspection');
          break;
        }
        continue;
      }

      const data = await res.json();
      const result = data.inspectionResult?.indexStatusResult || {};

      const inspectionData = {
        slug: orphan.slug,
        verdict: result.verdict || 'UNKNOWN',
        coverageState: result.coverageState || '',
        lastCrawlTime: result.lastCrawlTime || '',
        crawledAs: result.crawledAs || '',
        indexingState: result.indexingState || '',
        googleCanonical: result.googleCanonical || '',
        inspectedAt: new Date().toISOString(),
      };

      resultsBySlug.set(orphan.slug, inspectionData);

      // Map to orphan fields
      orphan.googleCanonical = inspectionData.googleCanonical;
      orphan.lastCrawlTime = inspectionData.lastCrawlTime;
      if (result.verdict === 'PASS') {
        orphan.googleStatus = 'indexed';
      } else if (result.coverageState?.includes('redirect')) {
        orphan.googleStatus = 'redirect';
      } else if (result.coverageState?.includes('alternate')) {
        orphan.googleStatus = 'alternate';
      }
      if (!orphan.source.includes('url-inspection')) {
        orphan.source.push('url-inspection');
      }

      inspected++;
      // Respect rate limits (~ 2 requests/sec)
      await sleep(500);
    } catch (err) {
      errors++;
      if (errors > 10) break;
    }
  }

  console.log(`  ✅ Inspected: ${inspected}, errors: ${errors}`);

  // Also apply existing results to orphans that weren't re-inspected
  for (const orphan of enrichedOrphans) {
    const existing = resultsBySlug.get(orphan.slug);
    if (existing && orphan.googleStatus === 'unknown') {
      orphan.googleCanonical = existing.googleCanonical || '';
      orphan.lastCrawlTime = existing.lastCrawlTime || '';
      if (existing.verdict === 'PASS') orphan.googleStatus = 'indexed';
      else if (existing.coverageState?.includes('redirect')) orphan.googleStatus = 'redirect';
      else if (existing.coverageState?.includes('alternate')) orphan.googleStatus = 'alternate';
    }
  }

  // Write merged inspection results
  if (!DRY_RUN) {
    const allResults = Array.from(resultsBySlug.values());
    writeJson(resultsPath, allResults);
    console.log(`  💾 Saved ${allResults.length} inspection results`);
  }
}

async function enrichWayback(enrichedOrphans) {
  if (!ENABLE_WAYBACK) {
    console.log('\n⏭️  Step 4b: Wayback Machine — skipped (ENABLE_WAYBACK not set)');
    return;
  }
  console.log('\n🔍 Step 4b: Wayback Machine enrichment...');

  // Only enrich orphans with no title from other sources
  const needsWayback = enrichedOrphans
    .filter(
      (o) =>
        !o.titleByLocale?.it &&
        !o.source.includes('translation-cache'),
    )
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .slice(0, 200);

  console.log(`  📊 Candidates for Wayback lookup: ${needsWayback.length}`);

  let found = 0;
  let errors = 0;

  for (const orphan of needsWayback) {
    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(`frontaliereticino.ch${orphan.path}`)}&output=json&limit=1&fl=timestamp,original`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(cdxUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        errors++;
        await sleep(1000);
        continue;
      }

      const data = await res.json();
      // CDX returns [["timestamp","original"], ["20240101...","url"]]
      if (!Array.isArray(data) || data.length < 2) {
        await sleep(1000);
        continue;
      }

      const [, timestamp] = data[1] || [];
      if (!timestamp) {
        await sleep(1000);
        continue;
      }

      // Fetch the archived page to extract title
      const archiveUrl = `https://web.archive.org/web/${timestamp}/https://frontaliereticino.ch${orphan.path}`;
      const pageRes = await fetch(archiveUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'FrontaliereTicino-OrphanSync/1.0' },
      });

      if (pageRes.ok) {
        const html = await pageRes.text();
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch?.[1]) {
          const title = titleMatch[1]
            .replace(/\s*\|.*$/, '') // Remove " | Frontaliere Ticino" suffix
            .trim();
          if (title && title.length > 5) {
            if (!orphan.title || orphan.title === orphan.slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())) {
              orphan.title = title;
            }
            // Assign to the detected locale
            if (!orphan.titleByLocale[orphan.locale]) {
              orphan.titleByLocale[orphan.locale] = title;
            }
            if (!orphan.source.includes('wayback')) {
              orphan.source.push('wayback');
            }
            found++;
          }
        }
      }
    } catch {
      errors++;
    }

    await sleep(1000); // 1 req/sec rate limit
  }

  console.log(`  ✅ Wayback titles found: ${found}, errors: ${errors}`);
}

// ══════════════════════════════════════════════════════════
// STEP 5 — Write outputs
// ══════════════════════════════════════════════════════════

function writeOutputs(enrichedOrphans, gscMap) {
  console.log('\n💾 Step 5: Writing outputs...');

  if (DRY_RUN) {
    console.log('  ⏭️  --dry-run: skipping file writes');
    console.log(`  Would write ${enrichedOrphans.length} orphans to orphan-enriched-data.json`);
    return;
  }

  // 1. orphan-enriched-data.json — full enriched array
  const enrichedPath = dataPath('orphan-enriched-data.json');
  writeJson(enrichedPath, enrichedOrphans);
  console.log(`  💾 ${enrichedPath}: ${enrichedOrphans.length} entries`);

  // 2. orphan-indexed-job-slugs.json — simple slug array (backward compat)
  const slugsPath = dataPath('orphan-indexed-job-slugs.json');
  const slugArray = [...new Set(enrichedOrphans.map((o) => o.slug))];
  writeJson(slugsPath, slugArray);
  console.log(`  💾 ${slugsPath}: ${slugArray.length} unique slugs`);

  // 3. gsc-orphan-queries.json — query data per slug
  const queriesPath = dataPath('gsc-orphan-queries.json');
  const queriesBySlug = {};
  for (const orphan of enrichedOrphans) {
    if (orphan.queries.length > 0) {
      queriesBySlug[orphan.slug] = orphan.queries;
    }
  }
  writeJson(queriesPath, queriesBySlug);
  console.log(`  💾 ${queriesPath}: ${Object.keys(queriesBySlug).length} slugs with query data`);

  // 4. Also save query data for non-orphan GSC entries (useful for analytics)
  // Already written via gsc-orphan-queries.json above
}

// ══════════════════════════════════════════════════════════
// STEP 6 — Process expired jobs
// ══════════════════════════════════════════════════════════

function processExpiredJobs() {
  console.log('\n🔍 Step 6: Enriching expired jobs from translation cache...');

  const expiredPath = dataPath('expired-jobs.json');
  const expiredJobs = readJsonSafe(expiredPath);
  if (!Array.isArray(expiredJobs) || expiredJobs.length === 0) {
    console.log('  ⏭️  No expired jobs to process');
    return;
  }

  // Load translation cache
  const cacheDir = dataPath('translation-cache');
  if (!fs.existsSync(cacheDir)) {
    console.log('  ⏭️  No translation cache directory');
    return;
  }

  const translationCache = new Map();
  for (const file of fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))) {
    const data = readJsonSafe(path.join(cacheDir, file));
    if (data && typeof data === 'object') {
      for (const [slug, entry] of Object.entries(data)) {
        if (entry?.translations) {
          translationCache.set(slug, entry.translations);
        }
      }
    }
  }

  let enrichedCount = 0;
  let updatedCount = 0;

  for (const job of expiredJobs) {
    if (!job.slug) continue;

    // Try to find in cache by slug or by any slugByLocale value
    const slugsToCheck = [job.slug];
    if (job.slugByLocale) {
      for (const s of Object.values(job.slugByLocale)) {
        if (s) slugsToCheck.push(s);
      }
    }

    let cached = null;
    for (const s of slugsToCheck) {
      cached = translationCache.get(s);
      if (cached) break;
    }

    if (!cached) continue;
    enrichedCount++;

    let changed = false;

    // Merge titleByLocale
    if (cached.titles) {
      if (!job.titleByLocale) job.titleByLocale = {};
      for (const [loc, title] of Object.entries(cached.titles)) {
        if (title && !job.titleByLocale[loc]) {
          job.titleByLocale[loc] = title;
          changed = true;
        }
      }
    }

    // Merge descriptionByLocale
    if (cached.descriptions) {
      if (!job.descriptionByLocale) job.descriptionByLocale = {};
      for (const [loc, desc] of Object.entries(cached.descriptions)) {
        if (desc && !job.descriptionByLocale[loc]) {
          job.descriptionByLocale[loc] = desc;
          changed = true;
        }
      }
    }

    if (changed) updatedCount++;
  }

  console.log(`  📊 Cache matches: ${enrichedCount}, jobs updated: ${updatedCount}`);

  if (updatedCount > 0 && !DRY_RUN) {
    writeJson(expiredPath, expiredJobs);
    console.log(`  💾 Updated ${expiredPath}`);
  } else if (DRY_RUN && updatedCount > 0) {
    console.log(`  ⏭️  --dry-run: would update ${updatedCount} expired jobs`);
  }
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════

async function main() {
  console.log('🚀 sync-gsc-orphans — GSC Orphan Job Slug Synchronizer\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE — no files will be written\n');
  }

  // Auth
  let accessToken;
  try {
    accessToken = await getAccessToken();
    console.log('✅ GSC OAuth token obtained');
  } catch (err) {
    console.error('❌ Cannot get GSC access token:', err.message);
    console.error('   Set GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN');
    process.exit(1);
  }

  // Detect correct GSC site property (URL-prefix vs domain)
  await detectSiteProperty(accessToken);
  console.log();

  // Step 1: Fetch GSC data
  const gscMap = await fetchGscJobUrls(accessToken);
  if (gscMap.size === 0) {
    console.log('\n⚠️  No job URLs found in GSC. Nothing to do.');
    process.exit(0);
  }

  // Step 2: Identify orphans
  const knownSlugs = buildKnownSlugsSet();
  const orphans = identifyOrphans(gscMap, knownSlugs);

  // Step 2b: Supplement orphans with GSC 404 compat paths
  // These are URLs from GSC Coverage reports (404/soft-404) that never appeared in
  // Search Analytics (no impressions/clicks). They get thin "Pagina archiviata" compat
  // pages at build time — feeding them into the orphan pipeline gives them proper
  // soft-landing pages with enriched content instead.
  const compatPathsFile = dataPath('seo-404-compat-paths.json');
  const compatData = readJsonSafe(compatPathsFile);
  if (compatData?.paths && Array.isArray(compatData.paths)) {
    const COMPAT_JOB_RE = /^\/(cerca-lavoro-ticino|en\/find-jobs?-ticino|de\/jobs-im-tessin|fr\/trouver-emploi-tessin)\/([^/]+)\/?$/;
    const SKIP_RE = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;
    const existingSlugs = new Set(orphans.map((o) => `${o.locale}:${o.slug}`));
    let compatAdded = 0;
    for (const p of compatData.paths) {
      const m = String(p || '').match(COMPAT_JOB_RE);
      if (!m) continue;
      const slug = m[2];
      if (!slug || SKIP_RE.test(slug)) continue;
      const locale = detectLocaleFromPath(p);
      const key = `${locale}:${slug}`;
      if (knownSlugs.has(slug) || existingSlugs.has(key)) continue;
      existingSlugs.add(key);
      orphans.push({
        slug,
        locale,
        path: p.replace(/\/$/, ''),
        queries: [],
        totalImpressions: 0,
        totalClicks: 0,
        source: 'gsc-404-compat',
      });
      compatAdded++;
    }
    if (compatAdded > 0) {
      console.log(`  📋 GSC-404 compat paths: ${compatAdded} supplementary orphans added`);
    }
  }

  // Step 2c: Merge with previously known orphans
  // Preserve ALL previously-enriched entries — even if the slug is now in knownSlugs.
  // The enrichment data (GSC queries, titles, company info) is used by the build
  // plugin to create richer soft-landing pages. Without it, pages degrade to generic
  // "Mercato del lavoro in Ticino" fallback content.
  const existingEnriched = readJsonSafe(dataPath('orphan-enriched-data.json'));
  if (Array.isArray(existingEnriched) && existingEnriched.length > 0) {
    const currentKeys = new Set(orphans.map((o) => `${o.locale}:${o.slug}`));
    let preserved = 0;
    let preservedKnown = 0;
    for (const prev of existingEnriched) {
      if (!prev.slug) continue;
      const key = `${prev.locale || 'it'}:${prev.slug}`;
      // Skip if already in the new orphan set from this run
      if (currentKeys.has(key)) continue;
      currentKeys.add(key);
      // Mark source so we can distinguish fresh GSC data from carried-over entries
      if (!prev.source) prev.source = 'previous-run';
      // Keep enrichment data even for slugs now in tracking — the build plugin
      // uses it for GSC queries, titles, and descriptions in soft-landing pages.
      if (knownSlugs.has(prev.slug)) {
        prev.source = 'enrichment-only';
        preservedKnown++;
      }
      orphans.push(prev);
      preserved++;
    }
    console.log(`  📋 Preserved ${preserved} previously-known orphans (${preservedKnown} now in tracking, kept for enrichment data)`);
    console.log(`  📊 Total orphans after merge: ${orphans.length}`);
  }

  // Step 2d: Feed back orphan paths to compat file for build-time coverage
  // Add both slug-based paths AND any already-tracked locale-specific paths
  let feedbackAdded = 0;
  if (!DRY_RUN) {
    const existingCompatPaths = new Set((compatData?.paths || []).filter(Boolean));
    const trackingFile = dataPath('all-known-job-slugs.json');
    const trackingData = readJsonSafe(trackingFile) || {};

    // Build reverse index: locale path → tracking entry
    const pathToTrackingEntry = new Map();
    for (const [key, entry] of Object.entries(trackingData)) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        if (entry[locale]) pathToTrackingEntry.set(entry[locale], entry);
      }
      // Also index by key
      pathToTrackingEntry.set(key, entry);
    }

    // City→canton index for canton-aware fallback path generation. Pre-fix
    // every fallback hardcoded Ticino, so any orphan whose canonical canton
    // is non-TI (e.g. RhB Chur → GR) ended up with a soft-landing only at
    // `/en/find-jobs-ticino/...`, while Google's actual indexed URL at
    // `/en/find-jobs-graubunden/...` had no page to land on and 404'd.
    const cityIndex = buildCityCantonIndex();

    for (const o of orphans) {
      // Skip enrichment-only entries (already in tracking, no new compat paths needed)
      if (o.source === 'enrichment-only') continue;
      // 1. Add basic slug × 4 locale paths — canton-aware where possible,
      //    falling back to legacy Ticino-only shape for unresolvable slugs.
      const inferred = buildOrphanLocalePaths(
        { slug: o.slug, path: o.path },
        { cityIndex, pathHints: trackingData[o.slug] },
      );
      const basicPaths = [inferred.it, inferred.en, inferred.de, inferred.fr];
      for (const p of basicPaths) {
        if (!existingCompatPaths.has(p)) {
          existingCompatPaths.add(p);
          feedbackAdded++;
        }
      }

      // 2. If this slug is a tracking key, add its (possibly translated) locale paths
      if (trackingData[o.slug]) {
        for (const locale of ['it', 'en', 'de', 'fr']) {
          const tracked = trackingData[o.slug][locale];
          if (tracked && !existingCompatPaths.has(tracked)) {
            existingCompatPaths.add(tracked);
            feedbackAdded++;
          }
        }
      }

      // 3. If the orphan's original GSC path is tracked under a different key, add all sibling paths
      if (o.path) {
        const trackingEntry = pathToTrackingEntry.get(o.path);
        if (trackingEntry) {
          for (const locale of ['it', 'en', 'de', 'fr']) {
            const p = trackingEntry[locale];
            if (p && !existingCompatPaths.has(p)) {
              existingCompatPaths.add(p);
              feedbackAdded++;
            }
          }
        }
      }
    }
    if (feedbackAdded > 0) {
      const updatedCompat = {
        ...compatData,
        paths: [...existingCompatPaths].filter(p => typeof p === 'string' && p.startsWith('/')).sort(),
        lastUpdated: new Date().toISOString().split('T')[0]
      };
      fs.writeFileSync(compatPathsFile, JSON.stringify(updatedCompat, null, 2) + '\n');
      console.log(`  ✅ Fed back ${feedbackAdded} orphan paths to seo-404-compat-paths.json`);
    } else {
      console.log(`  📝 No new orphan paths to feed back`);
    }
  }

  // Step 2e: Auto-register orphan slugs in tracking file (dedup-aware)
  let trackingAdded = 0;
  let trackingPatched = 0;
  if (!DRY_RUN) {
    const trackingFile = dataPath('all-known-job-slugs.json');
    const tracking = readJsonSafe(trackingFile) || {};
    const cityIndex = buildCityCantonIndex();

    // Build reverse index: slug-in-any-locale-path → tracking key
    const slugToKey = new Map();
    for (const [key, entry] of Object.entries(tracking)) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const p = entry[locale];
        if (p) {
          // Extract slug from path
          const parts = p.split('/');
          const lastPart = parts[parts.length - 1];
          if (lastPart) slugToKey.set(`${locale}:${lastPart}`, key);
        }
      }
    }

    let reservedHubsSkipped = 0;
    for (const o of orphans) {
      // Skip enrichment-only entries — they're already in tracking
      if (o.source === 'enrichment-only') continue;
      // Skip sector/city hub slugs — owned by jobSectorPagesPlugin /
      // cityJobsHubPlugin. Registering them here would let jobsSeoPagesPlugin
      // emit a job soft-landing that overwrites the legitimate hub HTML.
      if (RESERVED_HUB_SLUGS.has(o.slug)) {
        reservedHubsSkipped++;
        continue;
      }
      // Check if this slug already exists as a locale path in another entry
      let existingKey = null;
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const found = slugToKey.get(`${locale}:${o.slug}`);
        if (found && found !== o.slug) {
          existingKey = found;
          break;
        }
      }

      if (existingKey) {
        // Slug already tracked under a different key — ensure all 4 locales exist.
        // Re-derive the canton from the existing entry's own paths (the tracked
        // entry usually already encodes the canonical canton) so backfills land
        // under the right section instead of defaulting to Ticino.
        const entry = tracking[existingKey];
        const inferred = buildOrphanLocalePaths(
          { slug: existingKey, path: o.path },
          { cityIndex, pathHints: entry },
        );
        let patched = false;
        for (const loc of ['it', 'en', 'de', 'fr']) {
          if (!entry[loc]) { entry[loc] = inferred[loc]; patched = true; }
        }
        if (patched) trackingPatched++;
      } else if (!tracking[o.slug]) {
        // New slug — add to tracking with canton-aware paths.
        tracking[o.slug] = buildOrphanLocalePaths(
          { slug: o.slug, path: o.path },
          { cityIndex },
        );
        trackingAdded++;
      } else {
        // Already tracked under this key — ensure all 4 locales exist, using
        // existing locale paths as hints for canton inference.
        const entry = tracking[o.slug];
        const inferred = buildOrphanLocalePaths(
          { slug: o.slug, path: o.path },
          { cityIndex, pathHints: entry },
        );
        for (const loc of ['it', 'en', 'de', 'fr']) {
          if (!entry[loc]) entry[loc] = inferred[loc];
        }
      }
    }
    if (trackingAdded > 0 || trackingPatched > 0) {
      fs.writeFileSync(trackingFile, JSON.stringify(tracking, null, 2) + '\n');
      console.log(`  ✅ Tracking: ${trackingAdded} new slugs registered, ${trackingPatched} existing entries patched (total: ${Object.keys(tracking).length})`);
    }
    if (reservedHubsSkipped > 0) {
      console.log(`  🛡️  Skipped ${reservedHubsSkipped} reserved hub slug(s) (sector/city hubs — would clobber hub HTML)`);
    }
  }

  // Step 3: Enrich from local sources
  const enrichedOrphans = enrichFromLocalSources(orphans);

  // Step 4: Remote enrichment (optional)
  try {
    await enrichUrlInspection(enrichedOrphans, accessToken);
  } catch (err) {
    console.warn(`  ⚠️  URL Inspection enrichment failed: ${err.message}`);
  }

  try {
    await enrichWayback(enrichedOrphans);
  } catch (err) {
    console.warn(`  ⚠️  Wayback enrichment failed: ${err.message}`);
  }

  // Step 5: Write outputs
  writeOutputs(enrichedOrphans, gscMap);

  // Step 6: Process expired jobs
  try {
    processExpiredJobs();
  } catch (err) {
    console.warn(`  ⚠️  Expired jobs enrichment failed: ${err.message}`);
  }

  // Step 7: Bottom-up tracking coverage report
  // Check how many tracking paths are expected to need self-healing at build time.
  // This is informational — the build plugin handles the actual gap-filling.
  console.log('\n📊 Step 7: Tracking coverage analysis...');
  const finalTracking = readJsonSafe(dataPath('all-known-job-slugs.json')) || {};
  const totalTrackingPaths = Object.keys(finalTracking).length * 4;
  
  // Count paths that are likely covered by active jobs
  let likelyCovered = 0;
  const bySliceDir = dataPath('jobs', 'by-crawler');
  const activeSlugSet = new Set();
  if (fs.existsSync(bySliceDir)) {
    for (const f of fs.readdirSync(bySliceDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const slice = JSON.parse(fs.readFileSync(path.join(bySliceDir, f), 'utf-8'));
        const jobs = Array.isArray(slice) ? slice : (slice.jobs || []);
        for (const job of jobs) {
          for (const locale of ['it', 'en', 'de', 'fr']) {
            const s = job.slugByLocale?.[locale] || job.slug;
            if (s) activeSlugSet.add(`${locale}:${s}`);
          }
          if (job.slug) activeSlugSet.add(`it:${job.slug}`);
          // Also count previousSlugs as covered (bridge pages)
          for (const ps of (job.previousSlugs || [])) {
            for (const locale of ['it', 'en', 'de', 'fr']) {
              activeSlugSet.add(`${locale}:${ps}`);
            }
          }
        }
      } catch {}
    }
  }

  // Count tracking entries where the key itself is an active slug
  let trackingKeysCoveredByActive = 0;
  let trackingKeysExpired = 0;
  for (const key of Object.keys(finalTracking)) {
    const isActive = activeSlugSet.has(`it:${key}`) || activeSlugSet.has(`en:${key}`) || activeSlugSet.has(`de:${key}`) || activeSlugSet.has(`fr:${key}`);
    if (isActive) trackingKeysCoveredByActive++;
    else trackingKeysExpired++;
  }

  console.log(`  Tracking keys: ${Object.keys(finalTracking).length}`);
  console.log(`  Covered by active/bridge: ${trackingKeysCoveredByActive}`);
  console.log(`  Expired (soft-landing eligible): ${trackingKeysExpired}`);
  console.log(`  Active job slugs (all locales): ${activeSlugSet.size}`);
  console.log(`  ℹ️  Build-time self-healing will cover any remaining gaps`);

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 Summary');
  console.log('═'.repeat(60));
  console.log(`  GSC entries:        ${gscMap.size}`);
  console.log(`  Known slugs:        ${knownSlugs.size}`);
  console.log(`  Orphans:            ${enrichedOrphans.length}`);
  console.log(`  With title:         ${enrichedOrphans.filter((o) => o.title && o.title !== o.slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).length}`);
  console.log(`  With descriptions:  ${enrichedOrphans.filter((o) => Object.values(o.descriptionByLocale).some(Boolean)).length}`);
  console.log(`  With company:       ${enrichedOrphans.filter((o) => o.company).length}`);

  const topImpressions = enrichedOrphans.slice(0, 5);
  if (topImpressions.length > 0) {
    console.log('\n  Top orphans by impressions:');
    for (const o of topImpressions) {
      console.log(`    ${o.totalImpressions.toString().padStart(6)} imp  ${o.slug.slice(0, 60)}`);
    }
  }

  // Signal to workflow whether deploy is needed
  const compatChanged = feedbackAdded > 0 || trackingAdded > 0 || trackingPatched > 0;
  if (compatChanged) {
    console.log('\n🚀 DEPLOY_RECOMMENDED=true — orphan data changed, rebuild needed for new soft-landing pages');
  }

  console.log('\n✅ Done');
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
