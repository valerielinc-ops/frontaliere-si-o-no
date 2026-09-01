#!/usr/bin/env node
/**
 * Dedicated Coop (Coop Società Cooperativa) crawler runner.
 * Coop is a national retail cooperative (~2600 stores, HQ Basel), so this
 * crawler collects Coop jobs CH-wide across all 26 cantons (Cathedral) and
 * enforces full locale coverage for SEO-critical fields.
 *
 * The Coop careers portal uses the Prospective.ch JobBooster platform. That
 * medium (1000103, "Coop Group career center") is SHARED with acquired Coop
 * Group subsidiaries — Fust, Jumbo, Interdiscount, Betty Bossi, CHRIST,
 * railCare, Marché, Two Spice, BâleHotels, Transgourmet/Prodega, etc. — all
 * served under the same jobs.coopjobs.ch domain, each with its own dedicated
 * crawler. The listing page is a client-side SPA that cannot be crawled
 * directly. Instead, this script:
 *   1. Fetches the Prospective.ch JSON API, scoped server-side to Coop's own
 *      internal division attribute-70 values (see COOP_DIVISION_FILTER_IDS —
 *      no canton facet, so all 26 cantons are covered in one pass), to
 *      discover every Coop (not-subsidiary) job detail URL, paginating
 *      through the full result set (API returns up to `limit` jobs per page).
 *   2. Sets those SSR detail URLs as explicit adapter detail seeds.
 *   3. Runs the base crawler which fetches each detail page and parses
 *      the JSON-LD JobPosting structured data embedded in it.
 *
 * API endpoints used:
 *   - Jobs:       https://ohws.prospective.ch/public/v1/medium/1000103/jobs?lang=it&offset=0&limit=500&f=70:<COOP_DIVISION_FILTER_IDS>
 *                 (no `f=30:{cantonId}` filter → all CH cantons)
 *   - Attributes: https://ohws.prospective.ch/public/v1/medium/1000103/attributes?lang=it
 *
 * Per-job canton is inferred from the canton label the API returns in
 * attribute 30 (e.g. "Zurigo", "Vallese", "Ticino") via the shared CH-wide
 * inferAnyCanton helper. The JSON-LD post-process step later refines it with
 * the authoritative addressRegion from the SSR detail page.
 *
 * Detail page URL pattern:
 *   https://jobs.coopjobs.ch/offene-stellen/{slug}/{uuid}
 *
 * The detail pages are fully SSR with schema.org/JobPosting JSON-LD,
 * so the base crawler's extractJsonLdBlocks() parses them correctly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, hasCorrectLocaleCoverage, normalizeSpace, mergeLocaleTextMap } from './lib/dedicated-crawler-common.mjs';
import { runQualityGuards } from './lib/crawler-quality-guards.mjs';
import {
  fetchCoopJsonLd,
  coopDescHtmlToMarkdown,
  validateCoopDescription,
  titleOverlap,
  applyCoopJsonLdToJob,
  buildCoopTranslationCacheEntry,
} from './lib/coop-job-parser.mjs';
import { detectLanguage } from './lib/detect-language.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const COOP_KEY = 'coop-ticino';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COOP_KEY);

/**
 * Lightweight translation cache that persists Coop locale data across runs,
 * independently of STRICT validation success.
 *
 * Problem: when all 5 previous runs failed at validateCoopLocaleCoverage(),
 * the slice file was never written → no Coop jobs in data/jobs.json → the
 * shared-jobs-crawler contentReuse mechanism has nothing to reuse → all 177
 * jobs are AI-translated from scratch every run, exhausting free model quotas.
 *
 * Fix: save translations before validation. Next run injects them into
 * data/jobs.json so the merge step can preserve them for unchanged jobs.
 */
// Stored in by-crawler/ so it's automatically committed by git-commit-data.sh --slice-only.
const COOP_TRANSLATIONS_CACHE = path.resolve(ROOT, 'data', 'jobs', 'by-crawler', 'coop-ticino-locale-cache.json');

/**
 * Prospective.ch Career Center API for Coop.
 * Medium ID 1000103 = Coop's career center (shared with acquired Coop Group
 * subsidiaries — see file header).
 *
 * CH-wide fetch: no `f=30:{cantonId}` canton facet, so the API answers with
 * every job across all 26 cantons in one pass (the canton facet enumerates
 * all 26 — verified live), implicitly covering all 3 website tabs (Offerte
 * di lavoro / Posti di apprendistato / Tirocini di prova) too. We DO scope
 * the query server-side to attribute 70 ("Azienda"), restricted to Coop's own
 * internal division values (COOP_DIVISION_FILTER_IDS) — this excludes
 * subsidiary brands that live on the same medium/domain (#5975: without this
 * filter, and with the client-side isCoopJob() matcher's permissive
 * `host.includes('coopjobs.ch')` branch, ~680 Fust/Jumbo/Interdiscount/etc.
 * jobs were leaking into the Coop slice — the same root cause documented for
 * fust.json in #5975). We paginate via offset/limit until the full result
 * set is drained.
 *
 * Per-job canton comes from attribute 30 (a localized canton label such as
 * "Zurigo", "Vallese", "Ticino"), resolved CH-wide by inferAnyCanton. The
 * JSON-LD post-process later refines it with the SSR detail page addressRegion.
 */
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000103';

// Attribute 70 ("Azienda") value ids for Coop's OWN internal store/division
// formats on medium 1000103 — confirmed against
// /public/v1/medium/1000103/attributes. Distinct from acquired subsidiary
// brands (Fust=1114045, Jumbo=1343965, Interdiscount=1114048, ...), which
// have their own dedicated crawlers and must stay out of this slice.
const COOP_DIVISION_FILTER_IDS = [
  '1114036', // Coop
  '1114069', // coop.ch
  '1114039', // Coop City
  '1114040', // Coop Pronto AG
  '1114041', // Coop Pronto
  '1114075', // Coop Ristorante
  '1114042', // Coop Trading
  '1400311', // Coop Immobilien
  '1114038', // Coop Tagungszentrum
  '1114070', // Coop Cassa Depositi
  '1236129', // Cassa di compensazione Coop
].join(',');

const API_LIMIT = 500; // max jobs per request
const API_MAX_PAGES = 20; // hard ceiling: 20 * 500 = 10000 jobs (safety stop)
const DISCOVERED_COOP_HOSTS = new Set();

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function hostOf(rawUrl = '') {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
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

function detectLang(text = '') {
  return detectLanguage(text, 'it');
}

// Coop's own internal division/store-format names (see
// COOP_DIVISION_FILTER_IDS above for the matching attribute-70 ids), as they
// appear in the scraped JSON-LD `company` text. Matched by EXACT set
// membership rather than a loose substring/word check: subsidiary jobs often
// describe themselves in prose as "division of Coop" (e.g.
// company="Jumbo, Division der Coop Genossenschaft"), so a substring test for
// "coop" would wrongly admit them.
const COOP_DIVISION_COMPANY_NAMES = new Set([
  'coop',
  'coop genossenschaft',
  'coop.ch',
  'coop city',
  'coop pronto',
  'coop pronto ag',
  'coop ristorante',
  'coop trading',
  'coop immobilien',
  'coop tagungszentrum',
  'coop cassa depositi',
  'cassa di compensazione coop',
]);

/**
 * Match a job object as belonging to the Coop crawl.
 *
 * A present `company` field is authoritative (it comes from the scraped
 * JSON-LD detail page, i.e. the real employer): a job whose company text
 * doesn't name one of Coop's own divisions is NOT Coop even if its
 * companyKey was stamped 'coop-ticino' upstream (#5975 — companyKey alone
 * used to be sufficient here, and every job seeded from this crawler shares
 * that companyKey regardless of the real employer; combined with
 * `host.includes('coopjobs.ch')` matching virtually anything on the shared
 * Coop Group portal, ~680 Fust/Jumbo/Interdiscount/etc. jobs ended up
 * counted as Coop — the same contamination mechanism documented for
 * fust.json in #5975). companyKey is only trusted as a fallback when company
 * is missing.
 */
export function isCoopJob(job) {
  const company = normalize(job?.company || '');
  if (company) return COOP_DIVISION_COMPANY_NAMES.has(company);
  const key = normalizeKey(job?.companyKey || '');
  return key === COOP_KEY || key.includes('coop-ticino') || key.includes('coop-gruppo');
}

/**
 * Check whether a URL belongs to one of Coop's trusted domains.
 */
function isTrustedCoopDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (DISCOVERED_COOP_HOSTS.has(host)) return true;
    return (
      host.endsWith('coopjobs.ch') ||
      host.endsWith('coop.ch') ||
      host.endsWith('fust.ch') ||       // Fust = Coop Group subsidiary
      host.includes('prospective.ch')
    );
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
 * Resolve a Prospective.ch attribute-30 canton label (e.g. "Zurigo",
 * "Vallese", "Ticino") to a 2-letter Swiss canton code, CH-wide.
 *
 * inferAnyCanton (BFS over names + aliases + municipalities for all 26
 * cantons) resolves most labels directly. A few localized labels the API
 * uses are not in that name set, so they are mapped explicitly here:
 *   - "Regione di Basilea" → BL (Basel-Landschaft)
 *   - "Nidwaldo"           → NW
 *   - "Obwaldo"            → OW
 * The Liechtenstein label ("Principato del Liechtenstein") is intentionally
 * left unresolved (not a Swiss canton).
 */
const COOP_CANTON_LABEL_OVERRIDES = {
  'regione di basilea': 'BL',
  nidwaldo: 'NW',
  obwaldo: 'OW',
};

function normalizeCantonCode(raw = '', fallback = '') {
  const label = String(raw || '').trim();
  if (!label) return fallback || '';
  const override = COOP_CANTON_LABEL_OVERRIDES[label.toLowerCase()];
  if (override) return override;
  return inferAnyCanton(label) || fallback || '';
}

function cantonLabel(canton = '') {
  return canton || '';
}

function dateOnly(raw = '') {
  const dt = new Date(raw || Date.now());
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}

function buildSeedMetaFromApiJob(job, fallbackCanton = '') {
  const attr30 = String(job?.attributes?.['30']?.[0] || '').trim();
  const canton = normalizeCantonCode(attr30, fallbackCanton);
  // Try to get city-level location from various API fields before falling back to canton
  const apiCity = String(job?.location || job?.place || job?.city || job?.address?.city || '').trim();
  const location = apiCity || attr30 || cantonLabel(canton || fallbackCanton);
  const company = String(job?.attributes?.['70']?.[0] || job?.company || '').trim();
  const contract = String(job?.attributes?.['40']?.[0] || '').trim();
  return {
    location,
    canton: canton || fallbackCanton,
    ...(company ? { company } : {}),
    ...(contract ? { contract } : {}),
    ...(job?.date || job?.datePosted || job?.publishedAt || job?.published_at || job?.createdAt
      ? { postedDate: dateOnly(job?.date || job?.datePosted || job?.publishedAt || job?.published_at || job?.createdAt) }
      : {}),
  };
}

// ──────────────────────────────────────────────────────────────
// Prospective.ch API fetching
// ──────────────────────────────────────────────────────────────

/**
 * Fetch Coop job detail URLs from the Prospective.ch JSON API CH-wide.
 *
 * Uses a single UNFILTERED query (no canton facet) paginated over the full
 * result set. This covers all 26 cantons and all 3 position categories
 * (regular offers, apprenticeships, trials) in one pass. Per-job canton is
 * inferred from the API canton label (attribute 30) by buildSeedMetaFromApiJob.
 *
 * Returns unique detail URLs + metadata indexed by URL.
 */
async function fetchCoopJobDetailUrls() {
  const allUrls = new Set();
  const seedMetaByUrl = {};
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

  /** Canton distribution for logging (2-letter code → count). */
  const cantonCounts = {};
  let apiTotal = null;
  let fetched = 0;
  let droppedNonCh = 0;

  for (let page = 0; page < API_MAX_PAGES; page += 1) {
    const offset = page * API_LIMIT;
    const params = new URLSearchParams({
      lang: 'it',
      offset: String(offset),
      limit: String(API_LIMIT),
    });
    // Company filter: Coop's own divisions only (server-side — see
    // COOP_DIVISION_FILTER_IDS above). Comma-joined ids are OR'd by the API.
    params.append('f', `70:${COOP_DIVISION_FILTER_IDS}`);
    const apiUrl = `${API_BASE}/jobs?${params}`;
    console.log(`🔍 Fetching Coop CH-wide page ${page + 1} (offset ${offset})…`);

    let jobs;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res;
      let data;
      try {
        res = await fetch(apiUrl, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
          },
        });
        if (res.ok) {
          data = await res.json();
        }
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        console.warn(`⚠️ API returned ${res.status} at offset ${offset} — stopping pagination.`);
        break;
      }

      jobs = assertJsonListShape(data, { key: 'jobs', source: 'coop', lang: `offset:${offset}` });
      if (apiTotal === null && typeof data?.total === 'number') apiTotal = data.total;
    } catch (err) {
      console.warn(`⚠️ API fetch failed at offset ${offset}: ${err.message}`);
      break;
    }

    if (jobs.length === 0) break;
    fetched += jobs.length;

    for (const job of jobs) {
      const directLink = String(job?.links?.directlink || '').trim();
      if (directLink && directLink.startsWith('http') && !allUrls.has(directLink)) {
        const meta = buildSeedMetaFromApiJob(job);
        // CH-only gate: drop foreign postings (e.g. "Principato del Liechtenstein")
        // whose label doesn't resolve to a Swiss canton — mirrors confederazione's
        // Boolean(job.canton) filter. Keeps JobPosting structured data complete
        // (addressRegion present) and the dataset on-target for a CH site.
        if (!meta.canton) { droppedNonCh += 1; continue; }
        const discoveredHost = hostOf(directLink);
        if (discoveredHost) DISCOVERED_COOP_HOSTS.add(discoveredHost);
        allUrls.add(directLink);
        seedMetaByUrl[directLink] = meta;
        cantonCounts[meta.canton] = (cantonCounts[meta.canton] || 0) + 1;
      }
    }

    console.log(`  📦 page ${page + 1}: ${jobs.length} jobs (cumulative ${fetched}${apiTotal !== null ? `/${apiTotal}` : ''})`);

    // Drained the full result set.
    if (apiTotal !== null && offset + jobs.length >= apiTotal) break;
    if (jobs.length < API_LIMIT) break;
  }

  // Surface the safety-ceiling so a silent stop ≠ a fully drained feed.
  if (apiTotal !== null && fetched < apiTotal) {
    console.warn(`  ⚠️ Pagination stopped at ${fetched}/${apiTotal} jobs (API_MAX_PAGES=${API_MAX_PAGES} ceiling) — raise the ceiling if Coop's national listing has grown.`);
  }

  // Summary log
  console.log(`\n📋 Coop API Discovery Summary (CH-wide):`);
  console.log(`  API total: ${apiTotal ?? '?'} · fetched: ${fetched} · dropped non-CH (e.g. Liechtenstein): ${droppedNonCh} · unique detail URLs: ${allUrls.size}`);
  const sortedCantons = Object.entries(cantonCounts).sort((a, b) => b[1] - a[1]);
  console.log(`  Cantons seen (${sortedCantons.length}): ${sortedCantons.map(([c, n]) => `${c}=${n}`).join(', ')}`);
  if (DISCOVERED_COOP_HOSTS.size > 0) {
    console.log(`  Trusted hosts from Coop API: ${[...DISCOVERED_COOP_HOSTS].sort().join(', ')}`);
  }
  console.log(`✅ Total unique Coop detail URLs discovered: ${allUrls.size}\n`);
  return { urls: [...allUrls], seedMetaByUrl };
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Build the Coop adapter from the authoritative Prospective detail allowlist.
 * Generic seeds are deliberately removed: the feed already proves that each
 * canonical UUID is a vacancy detail, including localized URL families that
 * the shared listing heuristic must continue to reject by default.
 */
export function buildCoopAdapterConfig(
  baseAdapter,
  seedDetailUrls,
  seedMetaByUrl = {},
  updatedAt = new Date().toISOString(),
) {
  const adapter = {
    ...(baseAdapter || {}),
    seedDetailUrls,
    seedMetaByUrl,
    updatedAt,
  };
  delete adapter.seedUrls;
  return adapter;
}

/**
 * Ensure the Coop adapter JSON has the correct detail seed URLs
 * (detail page URLs discovered from the API).
 */
function ensureAdapterSeedUrls(seedUrls, seedMetaByUrl = {}) {
  const adapterPath = path.join(ADAPTERS_DIR, `${COOP_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${COOP_KEY}.json not found — creating it.`);
    const adapter = buildCoopAdapterConfig({
      companyKey: COOP_KEY,
      companyName: 'Coop Ticino',
      companyHost: 'coopjobs.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      notes: 'Prospective.ch JobBooster platform — detail URLs from JSON API covering Offerte di lavoro + Posti di apprendistato + Tirocini di prova. Each page has JSON-LD JobPosting.',
    }, seedUrls, seedMetaByUrl);
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = buildCoopAdapterConfig(
      JSON.parse(fs.readFileSync(adapterPath, 'utf-8')),
      seedUrls,
      seedMetaByUrl,
    );
    adapter.companyHost = 'coopjobs.ch';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'Prospective.ch JobBooster platform — detail URLs from JSON API covering Offerte di lavoro + Posti di apprendistato + Tirocini di prova. Each page has JSON-LD JobPosting.';
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${COOP_KEY} updated with ${seedUrls.length} detail seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

/**
 * Before the crawler runs, inject Coop jobs from the translation cache into
 * data/jobs.json. This allows shared-jobs-crawler's contentReuse mechanism to
 * preserve existing translations for unchanged jobs, avoiding a full 177/177
 * AI backfill on every run after a failed previous run.
 */
function injectCachedCoopTranslations() {
  if (!fs.existsSync(COOP_TRANSLATIONS_CACHE)) return;
  if (!fs.existsSync(DATA_JOBS)) return;

  let cache;
  try { cache = JSON.parse(fs.readFileSync(COOP_TRANSLATIONS_CACHE, 'utf-8')); } catch { return; }
  if (!Array.isArray(cache) || cache.length === 0) return;

  let allJobs;
  try { allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')); } catch { return; }
  if (!Array.isArray(allJobs)) return;

  const existingCoopCount = allJobs.filter(isCoopJob).length;
  if (existingCoopCount >= cache.length * 0.5) {
    // Dataset already has most Coop jobs — contentReuse will handle it naturally.
    return;
  }

  const existingUrls = new Set(allJobs.map((j) => j.url).filter(Boolean));
  const toInject = cache.filter((c) => c.url && !existingUrls.has(c.url));
  if (toInject.length === 0) return;

  allJobs.push(...toInject);
  writeJsonAtomic(DATA_JOBS, allJobs);
  console.log(`♻️  Translation cache: injected ${toInject.length}/${cache.length} Coop jobs into jobs.json for localization reuse`);
}

/**
 * After the crawler runs (but BEFORE STRICT validation), persist Coop
 * translations to a lightweight cache file. Even if validation fails and the
 * slice is never written, the next run can restore these translations and
 * avoid a full 177/177 AI backfill.
 */
function saveCoopTranslationsCache() {
  if (!fs.existsSync(DATA_JOBS)) return;
  let allJobs;
  try { allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')); } catch { return; }
  const coopJobs = Array.isArray(allJobs) ? allJobs.filter(isCoopJob) : [];
  if (coopJobs.length === 0) return;

  // buildCoopTranslationCacheEntry preserves previousSlugs/previousSlugsByLocale
  // (issue #2962) so re-injected jobs keep their slug-redirect history and the
  // build plugin can still emit bridge pages for old, sitemap-referenced URLs.
  // cachedAt is stamped here (kept out of the pure helper) so the helper stays
  // deterministic + unit-testable.
  const cachedAt = new Date().toISOString();
  const cache = coopJobs.map((job) => ({ ...buildCoopTranslationCacheEntry(job), cachedAt }));

  try {
    // Directory is data/jobs/by-crawler/ which always exists after a crawler run.
    writeJsonAtomic(COOP_TRANSLATIONS_CACHE, cache);
    const LOCALES_CHECK = ['it', 'en', 'de', 'fr'];
    const fullyTranslated = cache.filter((c) =>
      LOCALES_CHECK.every((l) => (c.titleByLocale[l] || '').length >= 3 && (c.descriptionByLocale[l] || '').length >= 120)
    ).length;
    console.log(`💾 Translation cache saved: ${cache.length} Coop jobs (${fullyTranslated} fully translated, ${cache.length - fullyTranslated} partial)`);
  } catch (err) {
    console.warn(`⚠️  Failed to save Coop translation cache: ${err?.message || err}`);
  }
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COOP_KEY,
    localizeOnlyCompanyKeys: COOP_KEY,
    forceLocalizeKeys: COOP_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      // 8 concurrent detail fetches against jobs.coopjobs.ch were verified
      // live in #1882 (100% success for the full national set; the origin
      // starts returning 503 only above ~12-16 in-flight). At 4 the CH-wide
      // base crawl alone takes ~2h20 of the 6h CI budget.
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '8',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing: validate & repair Coop jobs against JSON-LD
// ──────────────────────────────────────────────────────────────

const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;

async function postProcessCoopJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;

  const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const coopJobs = allJobs.filter(isCoopJob);
  if (coopJobs.length === 0) return;

  console.log(`\n🔧 Post-processing ${coopJobs.length} Coop jobs (title + description validation)…`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  let repaired = 0;

  // Detail-page fetch resilience + throughput at national scale.
  //
  // ROOT CAUSE (issue #1789): jobs.coopjobs.ch is slow (~2.8s per detail page)
  // and the previous serial loop re-fetched all ~2200 CH-wide jobs one-by-one
  // → ~100 min for a single pass. Together with the base crawler's own serial
  // detail loop and the localization step, the 360-min CI budget was exhausted
  // before most pages were fetched, so the vast majority of descriptions stayed
  // EMPTY (not boilerplate-text) and the assemble boilerplate-guard hard-failed
  // at ~95%.
  //
  // FIX: fetch the authoritative JSON-LD with BOUNDED CONCURRENCY (verified
  // live: a pool of 8 sustains 100% success in ~18 min for the full national
  // set; the origin starts returning HTTP 503 only above ~12-16 in-flight
  // requests). A failed fetch (503/timeout) is retried with backoff, so the
  // real description is recovered instead of left blank. Jobs that still resolve
  // no real description are quarantined below (dropped, never published as
  // boilerplate). The concurrency is env-overridable but capped at 12 to stay
  // under the origin's rate-limit ceiling.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const concurrency = Math.min(
    12,
    Math.max(1, Number(process.env.JOBS_COOP_DETAIL_CONCURRENCY) || 8),
  );
  async function fetchCoopJsonLdResilient(url) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const ld = await fetchCoopJsonLd(url, timeoutMs);
      if (ld) return ld; // got JSON-LD (description handled downstream)
      await sleep(400 * (attempt + 1)); // backoff only when the fetch itself failed (e.g. 503 under load)
    }
    return null;
  }
  const quarantineUrls = new Set();

  // Pure per-job repair: applies authoritative JSON-LD (location/company/title/
  // description) to a single job object in place. Safe to run from concurrent
  // workers because each call mutates only its own `job` (Node is single-threaded;
  // there is no shared mutable state between jobs here).
  function repairJobFromJsonLd(job, jsonLd) {
    let changed = false;
    // Snapshot BEFORE any mutation below: gates the needsRetranslation flag
    // further down (issue #3442). Coop's detail page is re-fetched every
    // crawl cycle, so `descLang !== 'it'` is a near-permanent condition for
    // German/French postings — flagging needsRetranslation unconditionally
    // on every cycle bypasses the merge-time stability lock in
    // dedicated-crawler-common.mjs (runBaseCrawler already ran before this
    // post-processing step), forcing the AI pipeline to re-translate an
    // already fully-translated title every run and churn slugByLocale.
    // hasCorrectLocaleCoverage (not hasFullLocaleCoverage) is deliberate
    // (issue #4788 sibling): presence-only coverage would call a job
    // "already fully localized" even if a non-source title slot still holds
    // source-language text, permanently suppressing the retranslation flag.
    const wasFullyLocalized = hasCorrectLocaleCoverage(job, job.sourceLang);
    // Snapshot the prior assembled description too (review #3454): coverage
    // alone freezes the flag forever once a job reaches full 4-locale
    // coverage, even if the live Coop posting is later rewritten. The
    // assembly below is deterministic from title/company/locality/ldDesc, so
    // comparing old vs new full text detects genuine source content drift —
    // mirrors the sourceTitleStable gate in mergePreserveLocaleData.
    const priorDescriptionText = job.description || '';

    // ── Location & company update from JSON-LD ──
    const ldResult = applyCoopJsonLdToJob(job, jsonLd);
    if (ldResult.changed) {
      Object.assign(job, ldResult.job);
      changed = true;
    }

    // ── Title validation ──
    const ldTitle = (jsonLd.title || '').trim();
    if (ldTitle && job.title !== ldTitle) {
      const overlap = titleOverlap(job.title, ldTitle);
      if (overlap < 0.6) {
        const titleLang = detectLang(ldTitle);
        console.log(`  ⚠️ Title fix: "${job.title}" → "${ldTitle}" (overlap=${overlap.toFixed(2)}, lang=${titleLang})`);
        job.title = ldTitle;
        // Assign title to the correct locale based on detected language
        if (job.titleByLocale) {
          job.titleByLocale[titleLang] = ldTitle;
          // Don't copy German/French/English titles into IT locale
          if (titleLang !== 'it' && !job.titleByLocale.it) {
            // Leave IT empty — will be translated by localization pipeline
          }
        }
        changed = true;
      }
    }

    // ── Description validation ──
    const descLen = (job.description || '').length;
    const ldDesc = (jsonLd.description || '').trim();
    if (ldDesc) {
      const markdown = coopDescHtmlToMarkdown(ldDesc);
      const validation = validateCoopDescription(markdown, ldDesc.length);

      // Replace if: current is shorter than JSON-LD markdown, current is too
      // short, OR the raw source text drifted from what's already reflected
      // in the stored description (issue #3442 completeness gap: this
      // length-only gate previously skipped the whole rebuild — and
      // therefore the sourceContentChanged check below — whenever a live
      // posting was rewritten to similar-or-shorter length, freezing
      // needsRetranslation exactly like the bug this guard exists to fix).
      // The incoming markdown still appearing verbatim in the prior stored
      // text means no real drift; anything else means the source changed.
      const sourceDrifted =
        markdown.length > 200 && !normalizeSpace(priorDescriptionText).includes(normalizeSpace(markdown));
      if (markdown.length > descLen || descLen < 350 || sourceDrifted) {
        if (markdown.length > 200) {
          // Build structured description with metadata
          const lines = [`## ${job.title || ldTitle}`, ''];
          // Add company from OG or hiringOrganization
          const company = jsonLd.hiringOrganization?.name || 'Coop';
          const locality = jsonLd.jobLocation?.address?.addressLocality || job.location || '';
          const region = jsonLd.jobLocation?.address?.addressRegion || '';
          if (locality) {
            lines.push(`**${company}** — ${locality}${region ? `, ${region}` : ''}, Svizzera`, '');
          }
          lines.push(markdown);
          // Footer
          const employment = jsonLd.employmentType === 'PART_TIME' ? 'Part-time' : 'Full-time';
          lines.push('', '---');
          lines.push(`**Tipo:** ${employment}`);
          if (locality) lines.push(`**Sede:** ${locality}`);

          const fullDesc = lines.join('\n');
          job.description = fullDesc;
          // Detect source language and assign to the correct locale (FRO-309)
          const descLang = detectLang(fullDesc);
          // Issue #3453: this used to reset the WHOLE descriptionByLocale map
          // to `{ [descLang]: fullDesc }` whenever the rebuilt text differed
          // from the previously stored description by >100 chars — a bound
          // easily crossed by incidental reformatting (footer/company/
          // locality lines shift the assembled length) rather than a genuine
          // rewrite of the source posting, discarding already-translated
          // locales outright. Use the same source-locale-aware merge as the
          // rest of the dedicated crawlers instead: only the freshly fetched
          // locale's slot is authoritative here, every other locale keeps its
          // existing (real) translation. `sourceContentChanged` below still
          // flags genuine drift for retranslation, so no data needs to be
          // destroyed up front to achieve that.
          job.descriptionByLocale = mergeLocaleTextMap(
            job.descriptionByLocale || {},
            { [descLang]: fullDesc },
            30,
            descLang,
          );
          // Update sourceLang to match detected language (FRO-309)
          if (descLang !== 'it') {
            job.sourceLang = descLang;
          }
          // Post-process runs AFTER the localization step, so a freshly fetched
          // German/French description leaves descriptionByLocale.it empty. The
          // boilerplate guard reads descriptionByLocale.it and would count such a
          // job as `empty_description` even though its real source text is now
          // present — only translation is pending. Mark it for retranslation so
          // the guard correctly excludes it (translation backlog ≠ parser
          // failure) and the next localization pass fills IT. Jobs whose source
          // already IS Italian keep IT populated and pass the guard directly.
          // Guard (issue #3442): skip the flag when the job already had full
          // 4-locale coverage BEFORE this repair ran — descLang !== 'it' is
          // near-permanent for German/French Coop postings, so without this
          // guard an already-translated job gets re-flagged (and
          // re-translated, with MT non-determinism churning slugByLocale) on
          // every single re-crawl. But coverage alone must not freeze the
          // flag forever (review #3454): also re-flag when the assembled
          // description actually changed from the previous crawl, so a
          // rewritten live posting still reaches the translation pipeline.
          const sourceContentChanged = normalizeSpace(priorDescriptionText) !== normalizeSpace(fullDesc);
          if ((!wasFullyLocalized || sourceContentChanged) && (descLang !== 'it' || !String(job.descriptionByLocale?.it || '').trim())) {
            job.needsRetranslation = true;
          }
          changed = true;
        }
      }

      if (!validation.ok) {
        for (const w of validation.warnings) {
          console.warn(`  ⚠️ ${(job.title || '').substring(0, 40)} — ${w}`);
        }
      }
    }

    return changed;
  }

  // Fetch + repair one job. Quarantines jobs that resolve no real description.
  async function processOne(job) {
    const descLen = (job.description || '').length;
    const jsonLd = await fetchCoopJsonLdResilient(job.url);
    if (!jsonLd || String(jsonLd.description || '').trim().length < 80) {
      // No real source description available → quarantine (don't publish a
      // boilerplate-padded thin page).
      if (descLen < 250) quarantineUrls.add(job.url);
      if (!jsonLd) return;
    }
    if (repairJobFromJsonLd(job, jsonLd)) repaired += 1;
  }

  // Bounded-concurrency pool over the Coop jobs. A shared index cursor feeds
  // `concurrency` workers; each pulls the next job until the queue drains.
  let cursor = 0;
  const startMs = Date.now();
  async function worker() {
    while (cursor < coopJobs.length) {
      const job = coopJobs[cursor];
      cursor += 1;
      await processOne(job);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, coopJobs.length) }, worker));
  console.log(`  ⏱️  Detail JSON-LD fetch: ${coopJobs.length} jobs in ${((Date.now() - startMs) / 1000).toFixed(0)}s (concurrency=${concurrency})`);

  // Quarantine: drop Coop jobs for which no real source description could be
  // fetched (after retries) and whose own description is too thin — publishing a
  // boilerplate-padded thin page violates the <50-word / boilerplate-guard
  // contract. Better to ship fewer, well-described jobs than to fail the whole
  // crawler (fail-per-record, not fail-the-batch).
  let dropped = 0;
  if (quarantineUrls.size > 0) {
    const kept = allJobs.filter((j) => !(isCoopJob(j) && quarantineUrls.has(j.url)));
    dropped = allJobs.length - kept.length;
    allJobs.length = 0;
    allJobs.push(...kept);
  }

  if (repaired > 0 || dropped > 0) {
    writeJsonAtomic(DATA_JOBS, allJobs);
    writeJsonAtomic(PUBLIC_JOBS, allJobs);
    console.log(`  ✅ Repaired ${repaired}/${coopJobs.length} Coop jobs` + (dropped ? ` · quarantined ${dropped} without a real source description` : ''));
  } else {
    console.log(`  ✅ All ${coopJobs.length} Coop jobs passed validation`);
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logCoopJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const coopJobs = allJobs.filter(isCoopJob);
  const ticinoJobs = coopJobs.filter((job) => normalize(job?.canton) === 'ti');

  // CH-wide canton distribution (2-letter code → count).
  const byCanton = {};
  for (const job of coopJobs) {
    const code = String(job?.canton || '').toUpperCase() || '??';
    byCanton[code] = (byCanton[code] || 0) + 1;
  }
  const sortedCantons = Object.entries(byCanton).sort((a, b) => b[1] - a[1]);

  console.log(`\n📊 === Coop Job Stats (CH-wide) ===`);
  console.log(`  🛒 Job totali trovati (Coop): ${coopJobs.length}`);
  console.log(`  🇨🇭 Cantoni coperti (${sortedCantons.length}): ${sortedCantons.map(([c, n]) => `${c}=${n}`).join(', ')}`);
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(coopJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Coop');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Coop');

  return { total: coopJobs.length, ticino: ticinoJobs.length, coopJobs, crawlDiff };
}

function validateCoopLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_COOP_STRICT',
    label: 'Coop',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCoopJob,
    detectSourceLang: (text) => detectLang(text),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedCoopDomain,
    untrustedDomainReason: 'untrusted_domain_for_coop_job',
    noJobsMessage: 'Nessun job Coop trovato dopo il crawl — niente da validare.',
    maxToleratedMissingDescriptions: 12,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime(); // reset wall-clock baseline at actual crawler start
  registerCrawlerSummaryGuard(COOP_KEY, 'Coop');
  console.log('   Platform: Prospective.ch JobBooster (Career Center 1000103)');
  console.log('   Scope: CH-wide (all 26 cantons, unfiltered national query)');
  console.log('   Categories: Offerte di lavoro + Posti di apprendistato + Tirocini di prova');
  console.log('');

  // Step 1: Fetch job detail URLs from the Prospective.ch JSON API
  const discovery = await fetchCoopJobDetailUrls();
  const detailUrls = discovery.urls;
  if (detailUrls.length === 0) {
    console.log('ℹ️ Nessun URL di dettaglio Coop trovato dall\'API. Uscita OK.');
    return;
  }

  // Step 2: Update the adapter with the discovered URLs as explicit detail seeds
  ensureAdapterSeedUrls(detailUrls, discovery.seedMetaByUrl);

  // Step 2b: Inject cached translations into jobs.json BEFORE the crawler runs.
  // When previous runs failed at validation, no slice was written → no Coop jobs
  // in jobs.json → shared-jobs-crawler re-translates all 177 from scratch.
  // Injecting the cache lets the merge step reuse existing translations via contentReuse.
  injectCachedCoopTranslations();

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COOP_KEY, DATA_JOBS).filter(isCoopJob))

  // Step 3: Run the base crawler which fetches each SSR detail page
  // and parses the JSON-LD JobPosting structured data
  await runBaseCrawler();

  // Step 3b: Post-process — validate titles and descriptions against JSON-LD
  await postProcessCoopJobs();

  // Step 3c: Persist translations to cache BEFORE STRICT validation.
  // Even if validateCoopLocaleCoverage() exits with code 1 below, the cache
  // preserves partial translations. Next run injects them back, reducing the
  // AI backfill from 177/177 → ~5-15/177 (only new or changed jobs).
  saveCoopTranslationsCache();

  // Step 4: Log stats and validate
  const stats = logCoopJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Coop trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateCoopLocaleCoverage();

  // Step 4b: Quality guards — min description length only.
  // No company-name allowlist: every job here already passed isCoopJob (host
  // coopjobs.ch / jobs.coop.ch), so Coop-group membership is proven by the
  // trusted domain. An allowlist adds no anti-hallucination value there and
  // only produces false negatives — it would silently drop legitimate
  // Coop-group brands whose company name isn't "Coop" (Bell, Halba, Coop
  // Vitality, …). The title-overlap guard already runs in-line (≥0.6).
  if (process.env.SKIP_QUALITY_GUARDS !== '1') {
    const raw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
    const allJobs = Array.isArray(raw) ? raw : [];
    const coopSubset = allJobs.filter(isCoopJob);
    const report = runQualityGuards(coopSubset, {
      minDescription: 250,
      logger: (msg) => console.warn(msg),
    });
    if (report.rejected > 0) {
      const keptIds = new Set(coopSubset.map((j) => j.id || j.url));
      const filtered = allJobs.filter((j) => !isCoopJob(j) || keptIds.has(j.id || j.url));
      writeJsonAtomic(DATA_JOBS, filtered);
      console.log(
        `  🧹 Coop quality guards: rejected ${report.rejected} job(s) — ${JSON.stringify(report.reasons)}`,
      );
    }
  }

  // Step 5: Write per-crawler slice and assemble global dataset
  if (stats.coopJobs && stats.coopJobs.length > 0) {
    writeJobsCrawlerSlice(COOP_KEY, stats.coopJobs);

    const durationMs = getCrawlerElapsedMs();
    const diff = stats.crawlDiff || { newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: [], unchangedCount: 0 };
    const summaryEntry = {
      key: COOP_KEY,
      label: 'Coop',
      generatedAt: new Date().toISOString(),
      total: stats.coopJobs.length,
      newCount: crawlDiff.newJobs.length,
      updatedCount: crawlDiff.updatedJobs.length,
      removedCount: crawlDiff.removedJobs.length,
      unchangedCount: crawlDiff.unchangedCount,
      durationMs,
      avgDurationMs: durationMs,
      durationHistory: [durationMs],
      newJobs: crawlDiff.newJobs.slice(0, 30),
      updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
      removedJobs: crawlDiff.removedJobs.slice(0, 30),
      unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
    };
    writeSummaryCrawlerSlice(summaryEntry);
    await assembleJobsDataset();
  }
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
  main().catch((err) => exitCrawlerOnError(err, 'Coop'));
}
