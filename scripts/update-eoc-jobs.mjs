#!/usr/bin/env node
/**
 * Dedicated EOC (Ente Ospedaliero Cantonale) crawler runner.
 * Runs only EOC hospital jobs (Umantis ATS at recruitingapp-2761.umantis.com)
 * and enforces full locale coverage for SEO-critical fields.
 *
 * The EOC careers portal uses the Umantis (Abacus) recruiting platform.
 * All job listings are served from recruitingapp-2761.umantis.com with
 * CompanyID filters for each hospital institute (Bellinzona, Lugano,
 * Locarno, Mendrisio, etc.).
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
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
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  stableSlugHash,
} from './lib/dedicated-crawler-common.mjs';
import { normalizeDescriptionBullets } from './lib/crawler-template.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const EOC_KEY = 'eoc-ente-ospedaliero-cantonale';
const HQ = getCompanyDefaults(EOC_KEY);

/**
 * Umantis listing URL for ALL EOC institutes.
 * CompanyID parameter covers every hospital/clinic:
 *   67|65|63|61|59|57|55|42|40|38|36|34|32|30|28|26|24|22|1
 * lang=ita returns Italian listing (source language).
 */
const UMANTIS_LISTING_URL =
  'https://recruitingapp-2761.umantis.com/Jobs/4?CompanyID=67|65|63|61|59|57|55|42|40|38|36|34|32|30|28|26|24|22|1&DesignID=10003&lang=ita&Reset=G&Search=Cerca';

/**
 * Umantis ATS uses a connector-table pagination system.
 * The listing table ID is 66856, so pagination params are tc66856=pN.
 * Each page shows 10 job entries.
 * A search_token is issued per session and must be passed to subsequent pages
 * to maintain the CompanyID filter context.
 */
const UMANTIS_BASE = 'https://recruitingapp-2761.umantis.com';
const UMANTIS_TABLE_ID = '66856';
const UMANTIS_ITEMS_PER_PAGE = 10;
const MAX_PAGES = 50; // safety cap to prevent infinite loops
const VACANCY_HREF_RE = /\/Vacancies\/(\d+)\/Description\/\d+/g;

// Maximum number of previousSlugs to retain per job.
// Each slug generates a redirect page at build time — unbounded growth causes
// thousands of extra pages (the root cause of this fix).
const MAX_PREVIOUS_SLUGS = 5;

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

/**
 * Extract the Umantis vacancy ID from a job URL.
 * E.g. "https://recruitingapp-2761.umantis.com/Vacancies/2655/Description/4" → "2655"
 */
function extractVacancyId(url) {
  const m = String(url || '').match(/\/Vacancies\/(\d+)\//);
  return m ? m[1] : null;
}

function detectLang(text = '') {
  return detectLanguage(text, 'it');
}

/**
 * Match a job object as belonging to the EOC crawl.
 */
function isEocJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === EOC_KEY ||
    key.includes('ente-ospedaliero-cantonale') ||
    key.includes('eoc-ente') ||
    host.includes('umantis.com') ||
    host.includes('eoc.ch') ||
    (company.includes('eoc') && company.includes('ospedaliero')) ||
    company.includes('ente ospedaliero cantonale')
  );
}

/**
 * Check whether a URL belongs to one of EOC's trusted domains.
 */
function isTrustedEocDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('eoc.ch') || host.includes('umantis.com');
  } catch {
    return false;
  }
}

function deriveLocalizedSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  return String(job?.slug || '').trim();
}

/**
 * Build a regenerated EOC slug with a stable per-job disambiguator suffix.
 *
 * EOC publishes multiple legitimate openings for the same role at the same
 * location (e.g. 3 nurses in Bellinzona). The previous formula
 * `{title}-eoc-{location}` collapsed those distinct postings to a single slug,
 * and the housekeeping dedup pass silently removed the duplicates — the run
 * at https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/24070266989
 * lost 13 jobs (155 → 142) this way.
 *
 * The disambiguator is `stableSlugHash(job)`, which derives a 6-char hash from
 * `fingerprintJob(job)`. EOC URLs include `/Vacancies/{id}/Description/4`, so
 * `extractJobIdentityFromUrl` returns `umantis.com|{vacancyId}` and each
 * vacancy gets a unique deterministic suffix that survives across crawl runs.
 *
 * The function is exported for tests (pure: no I/O, no module-level state).
 *
 * @param {object} job - Job object with at least { title, url } populated
 * @param {string} location - Resolved EOC city (e.g. "Bellinzona")
 * @returns {string} Regenerated slug, length-capped at 90 chars
 */
export function buildEocRegeneratedSlug(job, location) {
  const suffix = stableSlugHash(job) || '';
  const baseInput = `${job?.title || ''}-eoc-${location || ''}`;
  const baseSlug = baseInput
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!baseSlug) return '';
  if (!suffix) return baseSlug.slice(0, 200);
  // Reserve room for the `-{suffix}` tail (7 chars) so the final slug stays ≤ 90.
  const baseMaxLen = Math.max(0, 90 - (suffix.length + 1));
  const trimmedBase = baseSlug.slice(0, baseMaxLen).replace(/-+$/, '');
  return trimmedBase ? `${trimmedBase}-${suffix}` : suffix;
}

// ──────────────────────────────────────────────────────────────
// Umantis listing page fetching (with pagination)
// ──────────────────────────────────────────────────────────────

/**
 * Fetch a single URL with timeout and User-Agent header.
 * Returns the response body as text, or null on failure.
 */
async function fetchPage(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
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

/**
 * Extract unique vacancy detail paths from a page's HTML.
 * Returns a Set of vacancy IDs found (e.g. "2655").
 */
function extractVacancyIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(VACANCY_HREF_RE)) {
    ids.add(m[1]);
  }
  return ids;
}

/**
 * Extract the search_token for the connector table from the page HTML.
 * This token is needed to maintain the CompanyID filter across pages.
 */
function extractSearchToken(html) {
  const re = new RegExp(`_search_token${UMANTIS_TABLE_ID}=(\\d+)`);
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * Fetch ALL EOC job detail URLs by paginating through the Umantis listing.
 *
 * 1. Fetch page 1 with the full CompanyID filter URL to start a search session.
 * 2. Extract the _search_token from the response (needed for subsequent pages).
 * 3. Loop through pages 2..N using tc{TABLE_ID}=pN&_search_token=TOKEN.
 * 4. Stop when a page returns 0 new vacancy IDs (all seen before or empty page).
 * 5. Return full detail page URLs as seed URLs for the base crawler.
 */
async function fetchEocJobDetailUrls() {
  console.log('🔍 Fetching EOC jobs from Umantis listing (paginated)...');
  const allVacancyIds = new Set();

  // Page 1: use the full CompanyID listing URL to initialize the search session
  const page1Html = await fetchPage(UMANTIS_LISTING_URL);
  if (!page1Html) {
    console.error('❌ Failed to fetch Umantis listing page 1.');
    return [];
  }

  const page1Ids = extractVacancyIds(page1Html);
  for (const id of page1Ids) allVacancyIds.add(id);
  console.log(`  📄 Page 1: ${page1Ids.size} vacancies found`);

  const searchToken = extractSearchToken(page1Html);
  if (!searchToken) {
    console.warn('⚠️ Could not extract search token — returning page 1 results only.');
    return buildDetailUrls(allVacancyIds);
  }
  console.log(`  🔑 Search token: ${searchToken}`);

  // Pages 2..N: paginate using the connector table params
  // IMPORTANT: Include lang=ita and ContentOnly= to maintain the CompanyID filter
  // context from page 1. Without these params, the search_token expands to ALL
  // Umantis vacancies, not just the EOC-filtered subset.
  for (let pageNum = 2; pageNum <= MAX_PAGES; pageNum++) {
    const pageUrl = `${UMANTIS_BASE}/Jobs/4?lang=ita&tc${UMANTIS_TABLE_ID}=p${pageNum}&_search_token${UMANTIS_TABLE_ID}=${searchToken}&ContentOnly=`;
    const html = await fetchPage(pageUrl);
    if (!html) {
      console.log(`  📄 Page ${pageNum}: fetch failed — stopping pagination.`);
      break;
    }

    const pageIds = extractVacancyIds(html);
    if (pageIds.size === 0) {
      console.log(`  📄 Page ${pageNum}: 0 vacancies — end of listing.`);
      break;
    }

    // Check for wrap-around: if ALL IDs on this page were already seen, stop
    let newCount = 0;
    for (const id of pageIds) {
      if (!allVacancyIds.has(id)) {
        allVacancyIds.add(id);
        newCount++;
      }
    }

    console.log(`  📄 Page ${pageNum}: ${pageIds.size} vacancies (${newCount} new)`);

    if (newCount === 0) {
      console.log(`  🔄 All IDs on page ${pageNum} already seen — pagination wrapped around. Stopping.`);
      break;
    }

    // If page had fewer than expected items, likely the last page
    if (pageIds.size < UMANTIS_ITEMS_PER_PAGE) {
      console.log(`  📄 Page ${pageNum}: partial page (${pageIds.size} < ${UMANTIS_ITEMS_PER_PAGE}) — last page.`);
      break;
    }

    // Small delay to be polite to Umantis servers
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`✅ Total unique EOC vacancy IDs discovered: ${allVacancyIds.size}`);
  return buildDetailUrls(allVacancyIds);
}

/**
 * Convert vacancy IDs to full detail page URLs.
 */
function buildDetailUrls(vacancyIds) {
  return [...vacancyIds].map(
    (id) => `${UMANTIS_BASE}/Vacancies/${id}/Description/4`
  );
}

/**
 * Ensure the EOC adapter JSON has the correct seed URLs
 * (detail page URLs discovered from paginated listing).
 */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${EOC_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${EOC_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: EOC_KEY,
      companyName: 'EOC – Ente Ospedaliero Cantonale',
      companyHost: 'eoc.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      notes: 'Umantis ATS at recruitingapp-2761.umantis.com — EOC hospital job listings for all institutes.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.companyHost = adapter.companyHost || 'eoc.ch';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'Umantis ATS at recruitingapp-2761.umantis.com — EOC hospital job listings for all institutes.';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${EOC_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: EOC_KEY,
    localizeOnlyCompanyKeys: EOC_KEY,
    // NOTE: forceLocalizeKeys intentionally omitted — normal aiLocalizationEnabled=true
    // handles all jobs. Force-localize bypasses budget limits and model exhaustion checks,
    // causing 2+ hour runs retrying through rate-limited fallback models for 100+ jobs.
    // Without force, the crawler respects budget limits and stops gracefully.
    disableWorkdayForce: true,
    extraEnv: {
      // Override per-company limits: EOC via Umantis has 200+ active vacancies.
      JOBS_CRAWLER_MAX_JOB_LINKS: '400',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '400',
      // Use higher concurrency for dedicated single-company run.
      JOBS_AI_LOCALIZATION_CONCURRENCY: '2',
      // Generic summary is printed before EOC post-processing and can show
      // temporary noisy company/location fields.
      JOBS_SKIP_CRAWL_CHANGE_SUMMARY: '1',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing: fix company name & location for Umantis jobs
// ──────────────────────────────────────────────────────────────

/**
 * EOC hospital institute names found in Umantis job descriptions.
 * Map of keyword → human-readable institute + city.
 */
const EOC_INSTITUTES = [
  { re: /Ospedale Regionale di Bellinzona/i, city: 'Bellinzona', institute: 'Ospedale Regionale di Bellinzona e Valli' },
  { re: /Ospedale Regionale di Lugano/i, city: 'Lugano', institute: 'Ospedale Regionale di Lugano' },
  { re: /Ospedale Regionale di Locarno/i, city: 'Locarno', institute: 'Ospedale Regionale di Locarno' },
  { re: /Ospedale Regionale di Mendrisio/i, city: 'Mendrisio', institute: 'Ospedale Regionale di Mendrisio' },
  { re: /Ospedale San Giovanni/i, city: 'Bellinzona', institute: 'Ospedale San Giovanni' },
  { re: /Istituto Oncologico/i, city: 'Bellinzona', institute: 'Istituto Oncologico della Svizzera Italiana (IOSI)' },
  { re: /Neurocentro/i, city: 'Lugano', institute: 'Neurocentro della Svizzera Italiana' },
  { re: /Cardiocentro/i, city: 'Lugano', institute: 'Cardiocentro Ticino' },
  { re: /Clinica di Riabilitazione/i, city: 'Novaggio', institute: 'Clinica di Riabilitazione di Novaggio' },
  { re: /Laboratorio/i, city: 'Bellinzona', institute: 'EOC Laboratorio' },
  { re: /Servizio di anestesia/i, city: 'Bellinzona', institute: 'EOC Servizio di Anestesia' },
  { re: /Direzione generale/i, city: 'Bellinzona', institute: 'EOC Direzione Generale' },
];

const EOC_COMPANY_NAME = 'EOC – Ente Ospedaliero Cantonale';
const EOC_CITIES = ['Bellinzona', 'Lugano', 'Locarno', 'Mendrisio', 'Faido', 'Acquarossa', 'Novaggio', 'Stabio'];

/**
 * Extract the city/location from an EOC job description by looking
 * for known hospital institute names.
 */
function extractEocLocation(description = '', title = '') {
  const text = `${title} ${description}`;
  for (const inst of EOC_INSTITUTES) {
    if (inst.re.test(text)) return inst.city;
  }
  // Fallback: look for Ticino city names in the text
  const lowered = text.toLowerCase();
  for (const city of EOC_CITIES) {
    if (lowered.includes(city.toLowerCase())) return city;
  }
  return 'Bellinzona'; // EOC HQ fallback
}

function isLikelyCorruptedLocation(value = '') {
  const loc = String(value || '').trim();
  if (!loc) return true;
  if (loc.length > 60) return true;
  if (/^\d{4}\b/.test(loc)) return true;
  if (/(si rende noto|vedi|permette di combinare|offerta ospedaliera|sede di riferimen)/i.test(loc)) return true;
  return false;
}

/**
 * Clean up EOC job description: remove boilerplate intro paragraph
 * and CTA/footer noise.
 */
function cleanEocDescription(desc = '') {
  let cleaned = desc;
  // Remove EOC standard intro boilerplate
  cleaned = cleaned.replace(
    /L['']EOC,?\s*l['']ospedale multisito del Ticino[\s\S]*?(?=Per (?:completare|il nostro|la nostra|l[''])|Cerchiamo|Stiamo cercando|Il\/La candidato)/i,
    ''
  );
  // Remove CTA footer
  cleaned = cleaned.replace(/EOC\s*[-–]\s*il nostro ospedale\.?\s*Interessato\?[\s\S]*/i, '');
  cleaned = cleaned.replace(/Le candidature vanno inoltrate[\s\S]*/i, '');
  cleaned = cleaned.replace(/Se si riconosce nel profilo[\s\S]*/i, '');
  // Trim whitespace
  cleaned = cleaned.replace(/^\s+/, '').replace(/\s+$/, '').replace(/\n{3,}/g, '\n\n');
  // Restore line-start bullet markers so the parser-quality audit detects
  // structure (inline '•' separators → '\n• ', short paragraph runs → bullets).
  return normalizeDescriptionBullets(cleaned);
}

/**
 * Pure in-memory post-processing for EOC jobs.
 *
 * Mutates each EOC job in place to fix company name, location, canton,
 * description and slug. Returns the same array (caller-friendly: lets the
 * caller decide where to persist) plus a summary of how many fields were
 * touched. No filesystem I/O — exported for unit testing.
 *
 * Slug handling: only jobs whose existing slug contains boilerplate or is
 * absurdly long (> 120 chars) get regenerated. Other slugs are left alone
 * to preserve SEO continuity. The regeneration uses a stable per-vacancy
 * disambiguator (see buildEocRegeneratedSlug) so distinct openings with the
 * same title + location no longer collapse to the same slug.
 *
 * @param {object[]} jobs - Full jobs array (will be mutated in place)
 * @returns {{ jobs: object[], stats: { fixedJobs:number, fixedCompany:number, fixedLocation:number, fixedDescription:number, fixedSlug:number } }}
 */
export function postProcessEocJobsInMemory(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  let fixedJobs = 0;
  let fixedCompany = 0;
  let fixedLocation = 0;
  let fixedDescription = 0;
  let fixedSlug = 0;

  for (const job of list) {
    if (!isEocJob(job)) continue;
    let changed = false;

    // Fix company name (base crawler may extract boilerplate text)
    if (job.company !== EOC_COMPANY_NAME) {
      job.company = EOC_COMPANY_NAME;
      fixedCompany++;
      changed = true;
    }

    // Fix companyKey
    if (job.companyKey !== EOC_KEY) {
      job.companyKey = EOC_KEY;
      changed = true;
    }

    // Fix location (replace noisy extraction artifacts)
    const loc = extractEocLocation(job.description || '', job.title || '');
    const currentLocation = String(job.location || '').trim();
    if (loc && (job.location !== loc || isLikelyCorruptedLocation(currentLocation))) {
      job.location = loc;
      fixedLocation++;
      changed = true;
    }

    // Fix canton (all EOC hospitals are in Ticino)
    if (job.canton !== HQ.canton) {
      job.canton = HQ.canton;
      changed = true;
    }

    // Clean description
    const cleanedDesc = cleanEocDescription(job.description || '');
    if (cleanedDesc && cleanedDesc.length > 100 && cleanedDesc !== (job.description || '')) {
      job.description = cleanedDesc;
      // Keep source-locale descriptionByLocale in sync with cleaned description.
      // Without this, validation may fail because descriptionByLocale[sourceLang]
      // still has the uncleaned version while the AI localized from dirty content.
      if (job.descriptionByLocale && typeof job.descriptionByLocale === 'object') {
        const sourceLang = job.descriptionByLocale.it ? 'it' : 'en';
        job.descriptionByLocale[sourceLang] = cleanedDesc;
      }
      fixedDescription++;
      changed = true;
    }

    // Regenerate slug if it contains boilerplate or is absurdly long.
    // The replacement slug includes a stable per-vacancy disambiguator so
    // multiple openings with the same title + location stay unique. The
    // gating is preserved intact: well-formed existing slugs are NEVER
    // touched, so jobs already indexed by Google keep their canonical URL.
    if (job.slug && (job.slug.includes('permette-di-combinare') || job.slug.length > 120)) {
      const newSlug = buildEocRegeneratedSlug(job, loc);
      if (newSlug && newSlug !== job.slug) {
        // Preserve the previous slug for SEO bridge pages.
        if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
        if (!job.previousSlugs.includes(job.slug)) {
          job.previousSlugs.push(job.slug);
        }
        job.slug = newSlug;
        fixedSlug++;
        changed = true;
      }
    }

    // Cap previousSlugs to prevent unbounded growth.
    // Each entry generates a redirect page at build time — 40+ jobs with 10+
    // entries each caused thousands of extra build pages (the original bug).
    // First: remove entries that duplicate current slugs (redundant redirects).
    if (Array.isArray(job.previousSlugs)) {
      const currentSlugs = new Set();
      if (job.slug) currentSlugs.add(job.slug);
      if (job.slugByLocale && typeof job.slugByLocale === 'object') {
        for (const v of Object.values(job.slugByLocale)) {
          if (v) currentSlugs.add(v);
        }
      }
      const before = job.previousSlugs.length;
      job.previousSlugs = job.previousSlugs.filter(s => !currentSlugs.has(s));
      // Then: keep only the most recent MAX_PREVIOUS_SLUGS entries.
      if (job.previousSlugs.length > MAX_PREVIOUS_SLUGS) {
        job.previousSlugs = job.previousSlugs.slice(-MAX_PREVIOUS_SLUGS);
      }
      if (job.previousSlugs.length < before) {
        changed = true;
      }
    }

    if (changed) {
      fixedJobs++;
    }
  }

  return {
    jobs: list,
    stats: { fixedJobs, fixedCompany, fixedLocation, fixedDescription, fixedSlug },
  };
}

/**
 * Stabilize EOC slugs by comparing post-merge data with pre-crawl slice data.
 *
 * Root cause: EOC's location extraction is unreliable — the same vacancy may
 * appear with different locations (Bellinzona, Lugano, Novaggio) across crawl
 * runs, depending on which hospital name appears first in the description.
 * The base crawler's merge step uses location hints in isSlugStable(), so it
 * treats location-only slug changes as "genuinely different" jobs, generating
 * cascading previousSlugs entries (each becomes a redirect page at build time).
 *
 * Fix: For each EOC job matched by vacancy ID, if the title hasn't changed,
 * any slug change is location-driven and should be reverted to the pre-crawl
 * value. This function is exported for unit testing (pure: no I/O).
 *
 * @param {object[]} currentJobs - Post-merge/post-processed jobs array (mutated in place)
 * @param {object[]} preSliceJobs - Pre-crawl jobs from the existing slice file
 * @returns {{ stabilizedSlugs: number, stabilizedLocaleSlugs: number }}
 */
export function stabilizeEocSlugsInMemory(currentJobs, preSliceJobs) {
  const current = Array.isArray(currentJobs) ? currentJobs : [];
  const preSlice = Array.isArray(preSliceJobs) ? preSliceJobs : [];
  let stabilizedSlugs = 0;
  let stabilizedLocaleSlugs = 0;

  // Build vacancy ID → pre-crawl job map
  const preByVacancy = new Map();
  for (const j of preSlice) {
    const vid = extractVacancyId(j.url);
    if (vid) preByVacancy.set(vid, j);
  }
  if (preByVacancy.size === 0) return { stabilizedSlugs, stabilizedLocaleSlugs };

  for (const job of current) {
    if (!isEocJob(job)) continue;
    const vid = extractVacancyId(job.url);
    if (!vid) continue;
    const pre = preByVacancy.get(vid);
    if (!pre) continue; // new job — nothing to stabilize

    const preTitle = normalize(pre.title || '');
    const curTitle = normalize(job.title || '');
    if (!preTitle || !curTitle || preTitle !== curTitle) continue;

    // Title is identical → any slug change is location-driven. Revert.
    if (pre.slug && job.slug && pre.slug !== job.slug) {
      // Remove the pre-crawl slug from previousSlugs (it's current again)
      if (Array.isArray(job.previousSlugs)) {
        job.previousSlugs = job.previousSlugs.filter(s => s !== pre.slug);
      }
      job.slug = pre.slug;
      stabilizedSlugs++;
    }

    // Stabilize slugByLocale
    if (pre.slugByLocale && job.slugByLocale) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const oldSlug = pre.slugByLocale[locale];
        const newSlug = job.slugByLocale[locale];
        if (oldSlug && newSlug && oldSlug !== newSlug) {
          if (Array.isArray(job.previousSlugs)) {
            job.previousSlugs = job.previousSlugs.filter(s => s !== oldSlug);
          }
          job.slugByLocale[locale] = oldSlug;
          stabilizedLocaleSlugs++;
        }
      }
    }
  }

  return { stabilizedSlugs, stabilizedLocaleSlugs };
}

/**
 * I/O wrapper: stabilize EOC slugs after base crawler merge + post-processing.
 *
 * Reads the pre-crawl slice file (not yet overwritten) and the current
 * data/jobs.json, then calls stabilizeEocSlugsInMemory to revert
 * location-driven slug changes.
 */
function stabilizeEocSlugs() {
  const slicePath = path.resolve(ROOT, 'data', 'jobs', 'by-crawler', `${EOC_KEY}.json`);
  if (!fs.existsSync(slicePath) || !fs.existsSync(DATA_JOBS)) return;

  let preSliceJobs;
  try {
    const sliceData = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    preSliceJobs = Array.isArray(sliceData) ? sliceData : (sliceData.jobs || []);
  } catch { return; }
  if (preSliceJobs.length === 0) return;

  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];

  const { stabilizedSlugs, stabilizedLocaleSlugs } =
    stabilizeEocSlugsInMemory(jobs, preSliceJobs);

  if (stabilizedSlugs > 0 || stabilizedLocaleSlugs > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🛡️ EOC slug stabilization: ${stabilizedSlugs} main slugs reverted, ` +
      `${stabilizedLocaleSlugs} locale slugs reverted (location-driven churn prevented).`
    );
  }
}

/**
 * Post-process all EOC jobs in data/jobs.json to fix company name,
 * location, and description after base crawler extraction.
 *
 * Reads the legacy in-process file written by shared-jobs-crawler
 * (data/jobs.json — gitignored, populated in-memory by the base crawler
 * inside this same Node run), mutates it in place, then writes it back so
 * the downstream slice write step in main() picks up the corrected fields.
 *
 * The previous version of this function also ran a slug-based dedup loop
 * and wrote to public/data/jobs.json. That dedup was the cause of the
 * 155 → 142 regression: the broken slug formula collapsed distinct openings
 * to the same slug, then the dedup silently dropped them. With the per-job
 * disambiguator now baked into buildEocRegeneratedSlug, the dedup is no
 * longer needed and the public/data/jobs.json write was dead anyway in the
 * slice-based pipeline.
 */
function postProcessEocJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];

  const { stats } = postProcessEocJobsInMemory(jobs);

  if (stats.fixedJobs > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🔧 Post-processed ${stats.fixedJobs} EOC jobs ` +
      `(company=${stats.fixedCompany}, location=${stats.fixedLocation}, ` +
      `description=${stats.fixedDescription}, slug=${stats.fixedSlug}).`
    );
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logEocJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const eocJobs = allJobs.filter(isEocJob);
  const ticinoJobs = eocJobs.filter((job) => normalize(job?.canton) === 'ti');
  const nonTicino = eocJobs.length - ticinoJobs.length;

  console.log(`\n📊 === EOC – Ente Ospedaliero Cantonale Job Stats ===`);
  console.log(`  🏥 Job totali trovati (EOC): ${eocJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  if (nonTicino > 0) {
    console.log(`  ❌ Job scartati (location non Ticino): ${nonTicino}`);
    const examples = eocJobs
      .filter((job) => normalize(job?.canton) !== 'ti')
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(eocJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'EOC');
  writeCrawlChangeSummaryToGH(crawlDiff, 'EOC');

  return { total: eocJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateEocLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_EOC_STRICT',
    label: 'EOC',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isEocJob,
    detectSourceLang: (text) => detectLang(text),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedEocDomain,
    untrustedDomainReason: 'untrusted_domain_for_eoc_job',
    noJobsMessage: 'Nessun job EOC trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(EOC_KEY, 'EOC');
  console.log('🏥 Running dedicated EOC – Ente Ospedaliero Cantonale jobs crawler...');

  // 1. Fetch all job detail URLs from paginated Umantis listing
  const detailUrls = await fetchEocJobDetailUrls();

  if (detailUrls.length === 0) {
    console.log('⚠️ No EOC job URLs discovered from the listing. The Umantis portal may be down.');
    console.log('   Falling back to existing adapter seed URLs...');
    // Don't overwrite the adapter — keep whatever seeds exist
  } else {
    // 2. Update the adapter with discovered detail URLs
    ensureAdapterSeedUrls(detailUrls);
  }

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(EOC_KEY, DATA_JOBS).filter(isEocJob))

  await runBaseCrawler();

  // 3. Post-process EOC jobs: fix company name, location, description
  postProcessEocJobs();

  // 4. Stabilize slugs: revert location-driven slug changes by comparing with
  //    pre-crawl slice data. Must run AFTER post-processing but BEFORE writing
  //    the new slice. The slice file is still the pre-crawl version at this point.
  stabilizeEocSlugs();

  // Log stats
  const stats = logEocJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job EOC trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateEocLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isEocJob) : [];
  writeJobsCrawlerSlice(EOC_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: EOC_KEY,
    label: 'EOC',
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

// Only run main() when invoked as a script, not when imported by tests.
const isInvokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isInvokedDirectly) {
  main().catch((err) => {
    console.error(`❌ EOC crawler failed: ${err?.message || err}`);
    process.exit(1);
  });
}
