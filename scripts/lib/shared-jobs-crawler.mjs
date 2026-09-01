#!/usr/bin/env node
/**
 * Ticino Company Careers Crawler
 *
 * Goal:
 * - Crawl career pages for censused Ticino companies (from components/vita/TicinoCompanies.tsx)
 * - Extract high-quality JobPosting data
 * - Deduplicate and clean jobs
 * - Sync data/jobs.json and public/data/jobs.json
 * - Run housekeeping in the same workflow (moved out of article generation)
 *
 * Design principles:
 * - Fail-open: never drop existing jobs because of transient network issues
 * - Quality first: keep only relevant CH/Ticino postings with usable metadata
 * - SEO-safe fields: clean title/company/location/date/description/url/contract/source
 */

import fs from 'node:fs';
import { listSliceFileNames } from './crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllAttr, readAttr, readMetaContent } from './html-attr.mjs';
import { createHash } from 'node:crypto';
import { callLLM, isAnyModelAvailable, getPreferredModel, getStats as getAiStats, initScoreStore, flushScores, flushScoresBeforeExit, printRunSummary } from './ai-models.mjs';
import { validateJobUrls } from './validate-job-url.mjs';
import { stripScriptsAndStyles } from './crawler-template.mjs';
import { hasAnyJobSignal } from './job-like.mjs';
import { assertJsonListShape, assertJsonListShapeMultiKey } from './assert-json-list-shape.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH } from '../jobs-url-helper.mjs';
import { detectJobTitleLang, detectJobTitleLocaleDetails, pinnedTitleSourceLang, titleLooksUntranslated } from './job-locale-utils.mjs';
import {
  heuristicTranslateJobTitle, detectLang, normalizeKey, guessCategory, normalizeContract, qualityScore, evaluateJobQuality, isLikelyGenericCareerTitle, isLikelyJobDetailUrl,
  // FRO-231: slug utilities extracted from this file
  normalizeSpace as _normalizeSpace,
  slugify as _slugify,
  decodeHtmlEntities as _decodeHtmlEntities,
  decodeNumericEntities as _decodeNumericEntities,
  hostOf as _hostOf,
  normalizeHost as _normalizeHost,
  registrableDomain as _registrableDomain,
  canonicalizeJobUrl as _canonicalizeJobUrl,
  extractJobIdentityFromUrl as _extractJobIdentityFromUrl,
  isLowQualityLocalizedTitle as _isLowQualityLocalizedTitle,
  isLowQualityLocalizedSlug as _isLowQualityLocalizedSlug,
  fingerprintJob as _fingerprintJob,
  dedupHeuristicKey as _dedupHeuristicKey,
  ensureJobSlug as _ensureJobSlug,
  stableSlugHash as _stableSlugHash,
  isSlugStable as _isSlugStable,
  buildStableId as _buildStableId,
  loadSlugRegistry as _loadSlugRegistry,
  saveSlugRegistry as _saveSlugRegistry,
  getRegisteredSlug as _getRegisteredSlug,
  registryPinnedLocaleSlug as _registryPinnedLocaleSlug,
  sourceSlugPinContext as _sourceSlugPinContext,
  registerJobSlug as _registerJobSlug,
  // FRO-232: merge/dedup utilities extracted from this file
  LOCALES as _LOCALES,
  normalizeCompanyKey as _normalizeCompanyKey,
  dateOnly as _dateOnly,
  hasSeedMetaTargetScope as _hasSeedMetaTargetScope,
  isJobPortalRelevant as _isJobPortalRelevant,
  isExplicitlyOutsideTarget as _isExplicitlyOutsideTarget,
  isLocationExplicitlyForeign as _isLocationExplicitlyForeign,
  isForeignAtsUrlLocation as _isForeignAtsUrlLocation,
  isExplicitlyOutsideTargetCantons as _isExplicitlyOutsideTargetCantons,
  recencyTs as _recencyTs,
  mergeRequirements as _mergeRequirements,
  mergeLocaleTextMap as _mergeLocaleTextMap,
  mergeLocaleRequirementsMap as _mergeLocaleRequirementsMap,
  textSimilarityRatio as _textSimilarityRatio,
  hasCompleteLocalizedCoverage as _hasCompleteLocalizedCoverage,
  shouldReusePreviousLocalization as _shouldReusePreviousLocalization,
  preferJob as _preferJob,
  getMergeExclusionReasons as _getMergeExclusionReasons,
  mergeAndDeduplicate as _mergeAndDeduplicate,
  localeTextCoverage,
  // FRO-234: localization pipeline extracted from this file
  shouldForceLocalizationForJob as _shouldForceLocalizationForJobDCC,
  isLocalizationAllowedForJob as _isLocalizationAllowedForJobDCC,
  hasUntranslatedLocaleDescriptions as _hasUntranslatedLocaleDescriptionsDCC,
  hasUntranslatedLocaleTitles as _hasUntranslatedLocaleTitlesDCC,
  aiTranslateJobDescriptionDCC as _aiTranslateJobDescriptionDCC,
  aiTranslateJobTitleDCC as _aiTranslateJobTitleDCC,
  aiLocalizeJobContentDCC as _aiLocalizeJobContentDCC,
  enrichJobLocalesDCC as _enrichJobLocalesDCC,
  enrichJobLocalesWithRetryDCC as _enrichJobLocalesWithRetryDCC,
  cleanDescriptionDCC as _cleanDescriptionDCC,
  stripHtmlBasic as _stripHtmlBasic,
  stripCodeFenceJson as _stripCodeFenceJsonDCC,
  extractRequirementsFromText as _extractRequirementsFromText,
  htmlToStructuredTextDCC as _htmlToStructuredTextDCC,
  sanitizeAiOutput as _sanitizeAiOutput,
  addPreviousSlugForLocale,
  captureLostSlugs,
} from './dedicated-crawler-common.mjs';
import { writeJsonAtomic as writeJson } from './atomic-write-json.mjs';
// The cache's size bound lives in ONE module because two writers must agree on
// it: this file at persist time, and scripts/ci/merge-ai-cache.mjs when git
// reconciles two crawlers' commits. See that module for why the bound is in
// bytes and not entries (issue #4248 follow-up).
import {
  trimAiCacheEntriesToByteBudget,
  resolveAiCacheDiskMaxBytes,
  AI_CACHE_DISK_MAX_BYTES_DEFAULT,
} from './ai-cache-budget.mjs';
import { recordSlugMutation } from './slug-history-journal.mjs';
import {
  getJobLocalizationPipelineStats,
  localizeJobContentWithPipeline,
  translateTextWithLocalPipeline,
} from './job-localization-pipeline.mjs';
import { translateWithMyMemory, getMyMemoryStats } from './mymemory-translate.mjs';
import { freeTranslateWithRetry, logCascadeSummary } from './free-translate.mjs';
import { parseSupsiJobDetail } from './supsi-job-parser.mjs';
import { hasConcatenatedWords } from './translation-quality.mjs';
import { jinaProxiedRequest, hostMatchesProxyList, fetchViaJinaWithRetry, detectJinaErrorBody } from './jina-proxy.mjs';
import {
  extractMigrosStructuredData,
  extractMigrosSectionItems,
  extractMigrosBenefitItems,
} from './migros-job-parser.mjs';
import {
  BORDER_PROXIMITY_KEYWORDS,
  TICINO_CITIES,
  inferSwissTargetCanton,
  isTargetSwissLocation,
  isTicinoRelevant,
  isGrigioniRelevant,
  normalizeCantonCode,
} from './target-swiss-locations.mjs';
import {
  isFederalJobsPortalUrl,
  normalizeFederalDepartmentCompany,
  normalizeFederalJobLocation,
} from './federal-job-normalization.mjs';
// Shared CH country-field recognition (alpha-2/alpha-3/numeric/object shapes).
// Reused rather than re-implemented so the matcher can't drift from the
// dedicated parsers that already gate on it.
import { coerceCountryField, isChCountry } from './ch-country-guard.mjs';

// FRO-359: Re-alias DCC imports immediately after import block to avoid TDZ errors.
// These were scattered throughout the file, causing "Cannot access before initialization"
// when used at top level (e.g., normalizeSpace at line 133) before the alias declaration.
const normalizeSpace = _normalizeSpace;
const slugify = _slugify;
const decodeHtmlEntities = _decodeHtmlEntities;
const decodeNumericEntities = _decodeNumericEntities;
const hostOf = _hostOf;
const normalizeHost = _normalizeHost;
const registrableDomain = _registrableDomain;
const canonicalizeJobUrl = _canonicalizeJobUrl;
const extractJobIdentityFromUrl = _extractJobIdentityFromUrl;
const isLowQualityLocalizedTitle = _isLowQualityLocalizedTitle;
const isLowQualityLocalizedSlug = _isLowQualityLocalizedSlug;
const fingerprintJob = _fingerprintJob;
const dedupHeuristicKey = _dedupHeuristicKey;
const ensureJobSlug = _ensureJobSlug;
const stableSlugHash = _stableSlugHash;
const isSlugStable = _isSlugStable;
const buildStableId = _buildStableId;
const loadSlugRegistry = _loadSlugRegistry;
const saveSlugRegistry = _saveSlugRegistry;
const getRegisteredSlug = _getRegisteredSlug;
const registryPinnedLocaleSlug = _registryPinnedLocaleSlug;
const sourceSlugPinContext = _sourceSlugPinContext;
const registerJobSlug = _registerJobSlug;
// FRO-232: merge/dedup utilities re-aliases
const LOCALES = _LOCALES;
const normalizeCompanyKey = _normalizeCompanyKey;
const dateOnly = _dateOnly;
const hasSeedMetaTargetScope = _hasSeedMetaTargetScope;
const isJobPortalRelevant = _isJobPortalRelevant;
const isExplicitlyOutsideTarget = _isExplicitlyOutsideTarget;
const isLocationExplicitlyForeign = _isLocationExplicitlyForeign;
const isExplicitlyOutsideTargetCantons = _isExplicitlyOutsideTargetCantons;
const recencyTs = _recencyTs;
const mergeRequirements = _mergeRequirements;
const mergeLocaleTextMap = _mergeLocaleTextMap;
const mergeLocaleRequirementsMap = _mergeLocaleRequirementsMap;
const textSimilarityRatio = _textSimilarityRatio;
const hasCompleteLocalizedCoverage = _hasCompleteLocalizedCoverage;
const shouldReusePreviousLocalization = _shouldReusePreviousLocalization;
const preferJob = _preferJob;
const getMergeExclusionReasons = _getMergeExclusionReasons;
const mergeAndDeduplicate = _mergeAndDeduplicate;

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const COMPANIES_TSX = path.resolve(ROOT, 'components', 'vita', 'TicinoCompanies.tsx');
// A dedicated caller (runDedicatedBaseCrawler / crawler-template.mjs) may
// override these with a per-crawler-scoped scratch path via
// JOBS_CRAWLER_DATA_JOBS_PATH, so this module never touches the shared
// data/jobs.json when running as one of ~25 concurrent sibling crawlers in a
// crawler-group CI job.
const DATA_JOBS = process.env.JOBS_CRAWLER_DATA_JOBS_PATH
  ? path.resolve(process.env.JOBS_CRAWLER_DATA_JOBS_PATH)
  : path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = process.env.JOBS_CRAWLER_DATA_JOBS_PATH
  ? `${DATA_JOBS}.public.json`
  : path.resolve(ROOT, 'public', 'data', 'jobs.json');
const META_PATH = path.resolve(ROOT, 'data', 'jobs-meta.json');
const CRAWLER_CONFIG_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-config.json');
const AUDIT_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-audit.json');
const EXTRA_COMPANIES_PATH = path.resolve(ROOT, 'data', 'ticino-companies-extra.json');

const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
const SLUG_REGISTRY_PATH = path.resolve(ROOT, 'data', 'slug-registry.json');
const ADAPTERS_REGISTRY_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'registry.json');
const ADAPTERS_BASE_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters');
const CRAWLER_FIRESTORE_DOC = 'admin_config/jobsCrawler';
const AI_CACHE_PATH_DEFAULT = path.resolve(ROOT, 'data', 'jobs-ai-cache.json');

// Resolved at call time so tests can point load/persist at a controlled fixture
// via AI_CACHE_PATH_OVERRIDE. Unset in all prod/CI paths → identical behavior.
function resolveAiCachePath() {
  const override = process.env.AI_CACHE_PATH_OVERRIDE;
  return override ? path.resolve(override) : AI_CACHE_PATH_DEFAULT;
}

function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key]) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadLocalEnvFile(path.resolve(ROOT, '.env'));
loadLocalEnvFile(path.resolve(ROOT, '.env.local'));

const REQUEST_TIMEOUT_MS = clampNum(process.env.JOBS_CRAWLER_TIMEOUT_MS, 4000, 15000, 9000);
const MAX_COMPANIES = clampNum(process.env.JOBS_CRAWLER_LIMIT_COMPANIES, 10, 120, 60);
// Job-count caps are uncapped by default: crawlers must collect every job they
// discover (a low per-company link cap silently truncated e.g. Migros 800→40).
// Defaults are effectively unlimited; env vars can still narrow them, and the
// high ceiling means an explicit env value is never clamped down. Pagination
// terminates naturally on the first empty/no-new page, so unbounded ≠ infinite.
const UNCAPPED = 1_000_000;
const MAX_JOB_LINKS_PER_COMPANY = clampNum(process.env.JOBS_CRAWLER_MAX_JOB_LINKS, 1, UNCAPPED, UNCAPPED);
const MAX_CONCURRENCY = clampNum(process.env.JOBS_CRAWLER_CONCURRENCY, 1, 12, 6);
const MAX_DESC_CHARS = 12000;
const MAX_CAREER_PAGES_PER_COMPANY = clampNum(process.env.JOBS_CRAWLER_MAX_CAREER_PAGES, 2, UNCAPPED, 200);
const MAX_GENERIC_LISTING_PAGES = clampNum(process.env.JOBS_CRAWLER_MAX_GENERIC_LISTING_PAGES, 2, UNCAPPED, 200);
const MAX_GENERIC_DETAIL_PAGES_PER_COMPANY = clampNum(process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES, 2, UNCAPPED, UNCAPPED);
const FETCH_RETRY_ATTEMPTS = clampNum(process.env.JOBS_CRAWLER_FETCH_RETRIES, 0, 4, 2);
const FETCH_RETRY_BASE_MS = clampNum(process.env.JOBS_CRAWLER_FETCH_RETRY_BASE_MS, 100, 5000, 350);
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// AI availability is checked via centralized isAnyModelAvailable() from ai-models.mjs
// (covers all 4 providers: GitHub Models, Gemini, Groq, OpenRouter)
const GOOGLE_CSE_API_KEY = normalizeSpace(process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_API_KEY || '');
const GOOGLE_CSE_CX = normalizeSpace(process.env.GOOGLE_CSE_CX || '');
const GOOGLE_MAPS_API_KEY = normalizeSpace(process.env.GOOGLE_MAPS_API_KEY || '');
const WEB_DISCOVERY_RESULTS_PER_QUERY = clampNum(process.env.JOBS_WEB_DISCOVERY_RESULTS_PER_QUERY, 3, 10, 8);
const WEB_DISCOVERY_MAX_QUERIES_PER_COMPANY = clampNum(process.env.JOBS_WEB_DISCOVERY_MAX_QUERIES_PER_COMPANY, 1, 16, 6);
const SITEMAP_MAX_URLS_PER_FILE = clampNum(process.env.JOBS_SITEMAP_MAX_URLS_PER_FILE, 50, 4000, 1200);
const SITEMAP_MAX_FETCHES_PER_COMPANY = clampNum(process.env.JOBS_SITEMAP_MAX_FETCHES_PER_COMPANY, 1, 30, 8);
const BROWSER_FALLBACK_ENABLED = String(process.env.JOBS_BROWSER_FALLBACK_ENABLED || '1') !== '0';
const BROWSER_FALLBACK_WAIT_MS = clampNum(process.env.JOBS_BROWSER_FALLBACK_WAIT_MS, 0, 10000, 1200);
const BROWSER_FALLBACK_TIMEOUT_MS = clampNum(process.env.JOBS_BROWSER_FALLBACK_TIMEOUT_MS, 5000, 120000, 25000);
const BROWSER_FALLBACK_MAX_LINKS = clampNum(process.env.JOBS_BROWSER_FALLBACK_MAX_LINKS, 10, 500, 120);
const CAREER_DISCOVERY_HINT_RE = /(career|careers|jobs|job|vacanc|offerta|lavor|karriere|stellen|emploi|candid|join-us|work-with-us)/i;
const CAREER_DISCOVERY_ATS_HOST_RE = /(myworkdayjobs\.com|greenhouse\.io|lever\.co|smartrecruiters\.com)/i;
// Re-read env vars on each call to handle translate-pending's per-company overrides.
// ESM caches modules, so module-level const Sets only capture the FIRST call's env vars.
function getForceLocalizeCompanyKeys() {
  return new Set(
    String(process.env.JOBS_CRAWLER_FORCE_LOCALIZE_KEYS !== undefined
      ? process.env.JOBS_CRAWLER_FORCE_LOCALIZE_KEYS
      : 'vf-international-the-north-face-timberland,banca-cler')
      .split(',')
      .map((x) => normalizeCompanyKey(x))
      .filter(Boolean)
  );
}
const FORCE_LOCALIZE_COMPANY_KEYS = getForceLocalizeCompanyKeys();
function getForceLocalizeWorkday() {
  return String(process.env.JOBS_FORCE_LOCALIZE_WORKDAY || '1') !== '0';
}
const FORCE_LOCALIZE_WORKDAY = getForceLocalizeWorkday();
const LOCALIZE_ONLY_COMPANY_KEYS = new Set(
  String(process.env.JOBS_CRAWLER_LOCALIZE_ONLY_COMPANY_KEYS || '')
    .split(',')
    .map((x) => normalizeCompanyKey(x))
    .filter(Boolean)
);
/** Skip gpt-4o for the rest of the run once daily request limit (UserByModelByDay) is hit */
// Daily limit tracking now handled by centralized ai-models.mjs

const TICINO_KEYWORDS = [
  'ticino',
  'canton ticino',
  'cantone ticino',
  'ti',
  '(ti)',
  'lugano',
  'bellinzona',
  'locarno',
  'mendrisio',
  'chiasso',
  'manno',
  'stabio',
  'agno',
  'biasca',
  'canton ticino',
  'svizzera italiana',
];


const CAREER_HINTS = [
  '/careers',
  '/career',
  '/jobs',
  '/job',
  '/vacancies',
  '/vacancy',
  '/open-positions',
  '/work-with-us',
  '/join-us',
  '/karriere',
  '/stellen',
  '/emplois',
  '/carrieres',
  '/carriere',
  '/lavora-con-noi',
  '/lavora-con-noi',
  '/lavora',
];


const COMPANY_DISCOVERY_DOMAIN_BLACKLIST = new Set([
  'linkedin.com',
  'jobs.ch',
  'jobup.ch',
  'indeed.com',
  'jobcourier.ch',
  'monster.com',
  'glassdoor.com',
  'xing.com',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
]);

let aiLocalizationCalls = 0;
let aiPageValidationCalls = 0;
let deeplFallbackToLlm = 0;
let companyAdaptersGlobal = new Map();

// ── Noise reduction: suppress repeated output in LOCALIZE_EXISTING_ONLY mode ──
let _bannerPrintedOnce = false;
let _lastPrintedAiCallCount = -1;

const AI_CACHE_MAX_ENTRIES = clampNum(process.env.JOBS_AI_CACHE_MAX_ENTRIES, 200, 30000, 8000);
const AI_CACHE_DISK_MAX_ENTRIES = clampNum(process.env.JOBS_AI_CACHE_DISK_MAX_ENTRIES, 200, 100000, 30000);
const AI_CACHE_RAW_SENTINEL = '__RAW__';
const AI_CACHE_FILE_VERSION = 1;
const AI_CACHE_PERSIST_ENABLED = String(process.env.JOBS_AI_CACHE_PERSIST || '1') !== '0';
const aiResponseCache = new Map();
let aiCacheLoaded = false;
let aiCacheDirty = false;
let aiCacheLoadedEntries = 0;
let aiCacheHits = 0;
let aiCacheMisses = 0;
let fastXmlParserModulePromise = null;
let playwrightChromiumPromise = null;

function buildAiCacheKey(prefix = '', parts = []) {
  const h = createHash('sha256');
  h.update(String(prefix || ''));
  for (const p of parts) {
    h.update('\n');
    h.update(String(p || ''));
  }
  return h.digest('hex');
}

function cloneCacheValue(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function trimAiCache(maxEntries = AI_CACHE_MAX_ENTRIES) {
  while (aiResponseCache.size > maxEntries) {
    const oldestKey = aiResponseCache.keys().next().value;
    if (!oldestKey) break;
    aiResponseCache.delete(oldestKey);
    aiCacheDirty = true;
  }
}

function getCachedAiResponse(cacheKey) {
  if (!cacheKey || !aiResponseCache.has(cacheKey)) {
    aiCacheMisses += 1;
    return null;
  }
  aiCacheHits += 1;
  const entry = aiResponseCache.get(cacheKey);
  const value = entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')
    ? entry.value
    : entry;
  // simple LRU behavior
  aiResponseCache.delete(cacheKey);
  aiResponseCache.set(cacheKey, { value, touchedAt: Date.now() });
  return cloneCacheValue(value);
}

function setCachedAiResponse(cacheKey, value) {
  if (!cacheKey) return;
  if (aiResponseCache.has(cacheKey)) aiResponseCache.delete(cacheKey);
  aiResponseCache.set(cacheKey, { value: cloneCacheValue(value), touchedAt: Date.now() });
  aiCacheDirty = true;
  trimAiCache(AI_CACHE_MAX_ENTRIES);
}

function deleteCachedAiResponse(cacheKey) {
  if (!cacheKey || !aiResponseCache.has(cacheKey)) return false;
  aiResponseCache.delete(cacheKey);
  aiCacheDirty = true;
  return true;
}

function loadPersistentAiCache() {
  if (!AI_CACHE_PERSIST_ENABLED || aiCacheLoaded) return aiCacheLoadedEntries;
  aiCacheLoaded = true;
  const raw = readJson(resolveAiCachePath(), null);
  if (!raw || typeof raw !== 'object') return aiCacheLoadedEntries;

  let entries = [];
  if (Array.isArray(raw.entries)) {
    entries = raw.entries;
  } else if (raw.entries && typeof raw.entries === 'object') {
    entries = Object.entries(raw.entries).map(([key, value]) => ({ key, value, touchedAt: Date.now() }));
  }

  const normalizedEntries = entries
    .map((entry) => ({
      key: normalizeSpace(entry?.key || ''),
      value: cloneCacheValue(entry?.value),
      touchedAt: Number(entry?.touchedAt || 0),
    }))
    .filter((entry) => entry.key.length > 0)
    .sort((a, b) => a.touchedAt - b.touchedAt)
    .slice(-Math.min(AI_CACHE_MAX_ENTRIES, AI_CACHE_DISK_MAX_ENTRIES));

  for (const entry of normalizedEntries) {
    aiResponseCache.set(entry.key, {
      value: entry.value,
      touchedAt: entry.touchedAt || Date.now(),
    });
  }
  aiCacheLoadedEntries = aiResponseCache.size;
  aiCacheDirty = false;
  return aiCacheLoadedEntries;
}

function persistAiCacheToDisk({ force = false } = {}) {
  if (!AI_CACHE_PERSIST_ENABLED || !aiCacheLoaded) return;
  if (!force && !aiCacheDirty) return;
  trimAiCache(Math.min(AI_CACHE_MAX_ENTRIES, AI_CACHE_DISK_MAX_ENTRIES));

  const merged = new Map(
    [...aiResponseCache.entries()].map(([key, entry]) => [
      key,
      { touchedAt: Number(entry?.touchedAt || Date.now()), value: cloneCacheValue(entry?.value) },
    ]),
  );

  // Crawler-group jobs run ~25 sibling processes concurrently against one
  // shared checkout, each loading this cache once at startup then writing a
  // full snapshot back at exit. Without merging, whichever process persists
  // last clobbers every key a sibling added or refreshed after this
  // process's own load — a last-write-wins race (self-healing: a dropped
  // entry just costs one extra LLM call next run, not permanent data loss —
  // but wasteful at ~25x scale, every run). Re-read the current on-disk
  // snapshot right before writing and fold in any key with a newer
  // touchedAt than what this process already holds, so concurrent siblings'
  // additions merge by actual recency instead of clobbering each other.
  const onDisk = readJson(resolveAiCachePath(), null);
  const onDiskEntries = onDisk && typeof onDisk === 'object' && Array.isArray(onDisk.entries)
    ? onDisk.entries
    : [];
  for (const entry of onDiskEntries) {
    const key = normalizeSpace(entry?.key || '');
    if (!key) continue;
    const diskTouchedAt = Number(entry?.touchedAt || 0);
    const existing = merged.get(key);
    if (!existing || diskTouchedAt > existing.touchedAt) {
      merged.set(key, { touchedAt: diskTouchedAt, value: cloneCacheValue(entry?.value) });
    }
  }

  const entries = [...merged.entries()]
    .sort(([, a], [, b]) => a.touchedAt - b.touchedAt)
    .slice(-AI_CACHE_DISK_MAX_ENTRIES)
    .map(([key, entry]) => ({ key, touchedAt: entry.touchedAt, value: entry.value }));

  const budgetBytes = resolveAiCacheDiskMaxBytes();
  const { entries: budgeted, droppedEntries, droppedBytes } = trimAiCacheEntriesToByteBudget(
    entries,
    budgetBytes,
  );
  if (droppedEntries > 0) {
    console.log(
      `  🧹 AI cache byte budget: dropped ${droppedEntries} least-recently-used entries ` +
        `(${(droppedBytes / 1048576).toFixed(1)} MB) to stay under ` +
        `${(budgetBytes / 1048576).toFixed(0)} MB`,
    );
  }

  writeJson(resolveAiCachePath(), {
    version: AI_CACHE_FILE_VERSION,
    savedAt: new Date().toISOString(),
    entries: budgeted,
  });
  aiCacheDirty = false;
}

async function getFastXmlParserModule() {
  if (fastXmlParserModulePromise) return fastXmlParserModulePromise;
  fastXmlParserModulePromise = import('fast-xml-parser')
    .then((mod) => mod || null)
    .catch(() => null);
  return fastXmlParserModulePromise;
}

import { launchChromium } from './ensure-chromium.mjs';

async function getPlaywrightChromium() {
  if (playwrightChromiumPromise) return playwrightChromiumPromise;
  playwrightChromiumPromise = import('playwright')
    .then((mod) => mod?.chromium || null)
    .catch(() => null);
  return playwrightChromiumPromise;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Read existing jobs from per-crawler slices when data/jobs.json is absent.
 * In CI, data/jobs.json is gitignored and doesn't exist, but per-crawler slices
 * (data/jobs/by-crawler/*.json) are committed and contain translated data.
 * Falling back to slices preserves translations across crawler runs.
 */
function readExistingJobsFromSlices(scopedKeys) {
  if (!fs.existsSync(BY_CRAWLER_DIR)) return [];
  const files = listSliceFileNames(BY_CRAWLER_DIR);
  const jobs = [];
  for (const file of files) {
    const key = file.replace(/\.json$/, '');
    // When running a scoped crawler, only load that crawler's slice
    if (scopedKeys && scopedKeys.length > 0 && !scopedKeys.includes(key)) continue;
    const data = readJson(path.join(BY_CRAWLER_DIR, file), null);
    if (data && Array.isArray(data.jobs)) {
      jobs.push(...data.jobs);
    }
  }
  return jobs;
}

function loadCompanyAdapters() {
  const out = new Map();
  const registry = readJson(ADAPTERS_REGISTRY_PATH, null);
  const entries = registry && typeof registry === 'object' && registry.adapters && typeof registry.adapters === 'object'
    ? Object.entries(registry.adapters)
    : [];
  for (const [rawKey, relPath] of entries) {
    const key = normalizeCompanyKey(rawKey);
    if (!key || typeof relPath !== 'string') continue;
    const abs = path.resolve(ADAPTERS_BASE_DIR, relPath);
    const parsed = readJson(abs, null);
    if (!parsed || typeof parsed !== 'object') continue;
    const enabled = parsed.enabled !== false;
    const crawlerModes = Array.isArray(parsed.crawlerModes)
      ? parsed.crawlerModes.map((m) => normalizeSpace(String(m || '')).toLowerCase()).filter(Boolean)
      : [];
    const seedUrls = Array.isArray(parsed.seedUrls)
      ? parsed.seedUrls.map((u) => normalizeSpace(String(u || ''))).filter(Boolean)
      : [];
    const seedDetailUrls = Array.isArray(parsed.seedDetailUrls)
      ? parsed.seedDetailUrls.map((u) => normalizeSpace(String(u || ''))).filter(Boolean)
      : [];
    const authoritativeLifecycleDomains = Array.isArray(parsed.authoritativeLifecycleDomains)
      ? parsed.authoritativeLifecycleDomains.map((domain) => normalizeHost(String(domain || ''))).filter(Boolean)
      : [];
    const authoritativeLifecycleDomainSet = new Set(authoritativeLifecycleDomains);
    const authoritativeDetailSnapshot = parsed.authoritativeDetailSnapshot === true
      && seedDetailUrls.length > 0
      && authoritativeLifecycleDomains.length > 0
      && seedDetailUrls.every((url) => authoritativeLifecycleDomainSet.has(normalizeHost(hostOf(url))));
    const seedMetaByUrl = {};
    if (parsed.seedMetaByUrl && typeof parsed.seedMetaByUrl === 'object') {
      for (const [rawUrl, rawMeta] of Object.entries(parsed.seedMetaByUrl)) {
        const absoluteUrl = tryUrl(rawUrl);
        if (!absoluteUrl) continue;
        const normalizedMeta = normalizeAdapterSeedMeta(rawMeta);
        if (!normalizedMeta) continue;
        const canonical = canonicalizeJobUrl(absoluteUrl) || absoluteUrl.toLowerCase();
        seedMetaByUrl[canonical] = normalizedMeta;
        seedMetaByUrl[absoluteUrl.toLowerCase()] = normalizedMeta;
      }
    }
    const priority = Number.isFinite(Number(parsed.priority)) ? Number(parsed.priority) : 0;
    const userAgent = typeof parsed.userAgent === 'string' ? parsed.userAgent.trim() : '';
    out.set(key, {
      enabled,
      crawlerModes,
      seedUrls,
      seedDetailUrls: seedDetailUrls.length > 0 ? seedDetailUrls : undefined,
      seedMetaByUrl: Object.keys(seedMetaByUrl).length > 0 ? seedMetaByUrl : undefined,
      authoritativeDetailSnapshot,
      authoritativeLifecycleDomains: authoritativeDetailSnapshot ? authoritativeLifecycleDomains : undefined,
      priority,
      userAgent: userAgent || undefined,
    });
  }
  return out;
}

function getCompanyAdapter(company) {
  if (!company || !(companyAdaptersGlobal instanceof Map) || companyAdaptersGlobal.size === 0) return null;
  const byKey = normalizeCompanyKey(company.key || '');
  if (byKey && companyAdaptersGlobal.has(byKey)) return companyAdaptersGlobal.get(byKey);
  const byName = normalizeCompanyKey(company.name || '');
  if (byName && companyAdaptersGlobal.has(byName)) return companyAdaptersGlobal.get(byName);
  return null;
}

// FRO-231: normalizeSpace → moved to top of file (FRO-359)

// AI model calls now handled by centralized scripts/lib/ai-models.mjs
// (isModelBusyOrRateLimited, callGitHubModels, callGeminiText, callLlmWithFallback removed)

function stripCodeFenceJson(text = '') {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// callGitHubModels, callGeminiText, callLlmWithFallback → centralized in scripts/lib/ai-models.mjs
// All call sites now use the imported callLLM which handles model fallback chain automatically.


function stripHtml(s) {
  return normalizeSpace(
    String(s || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

function tryUrl(raw, base = null) {
  if (!raw) return null;
  try {
    // Issue #3626 sibling fix: href attributes scraped straight out of raw HTML
    // (e.g. `<a href="...&amp;startrow=25">`) carry HTML-escaped `&amp;` instead
    // of a literal `&`. tryUrl() is the single convergence point every link
    // extractor in this file (absoluteLinks, absoluteSameHostLinks,
    // routeDiscoveredUrl, ...) funnels through, so decoding here fixes the
    // whole class in one place instead of patching each extractor. Left
    // undecoded, a multi-param pagination href like careers.zurich.com's
    // `?q=&amp;locationsearch=Switzerland&amp;startrow=25` gets sent to the
    // server with literal "amp;locationsearch"/"amp;startrow" keys — verified
    // live: the malformed variant returns an unrelated 822-result unscoped
    // page while the decoded variant returns the correct scoped page 2 of 56.
    const cleaned = decodeHtmlEntities(String(raw));
    return base ? new URL(cleaned, base).toString() : new URL(cleaned).toString();
  } catch {
    return null;
  }
}

// FRO-231: URL utilities → moved to top of file (FRO-359)

function sameHost(a, b) {
  const ha = normalizeHost(hostOf(a));
  const hb = normalizeHost(hostOf(b));
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  return registrableDomain(ha) === registrableDomain(hb);
}

function isKnownAtsHost(host = '') {
  const h = normalizeHost(host);
  if (!h) return false;
  return (
    h.includes('myworkdayjobs.com') ||
    h.includes('greenhouse.io') ||
    h.includes('lever.co') ||
    h.includes('smartrecruiters.com') ||
    h.includes('teamtailor.com') ||
    h.includes('jobs.personio.') ||
    h.includes('personio.de') ||
    h.includes('personio.com') ||
    h.includes('umantis.com') ||
    h.includes('arca24.careers') ||
    h.includes('coopjobs.ch') ||
    h.includes('jobs.migros.ch') ||
    h.includes('concorsi.ti.ch') ||
    h.includes('jobs.sbb.ch') ||
    h.includes('oraclecloud.com') ||
    h.includes('usi.ch') ||
    h.includes('allibo.com') ||
    // Issue #3626: careers.zurich.com is a SuccessFactors jobs2web-style search
    // portal on a DIFFERENT registrable domain (zurich.com) than the company's
    // marketing site (zurich.ch), so sameHost(link, company.website) never
    // matches it. Without this entry, routeDiscoveredUrl() drops the adapter's
    // search-listing seed URLs entirely (no branch claims them), so the BFS
    // pagination crawl in crawlGenericListingJobs() — which the adapter's own
    // seed-URL comment already assumes runs — never executes, and the crawler
    // silently falls back to scraping unrelated zurich.ch marketing pages.
    h.includes('careers.zurich.com')
  );
}

// guessCategory and normalizeContract imported from dedicated-crawler-common.mjs

function extractRequirements(description) {
  const text = normalizeSpace(description);
  if (!text) return [];
  const lines = text
    .split(/[\n\r•·]+|(?<=[.!?;:])\s+/)
    .map((x) => normalizeSpace(String(x || '').replace(/^[)\]}\-–—:.,\s]+/, '')))
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.length < 14 || line.length > 120) continue;
    if (!/[a-zà-öø-ÿ]{3,}/i.test(line)) continue;
    if (/\b(streamlined recruitment process|interview|privacy|cookie|wishlist|newsletter|all rights reserved|hiring manager|recruiter|business case)\b/i.test(line)) continue;
    if (/\b(how you will make a difference|skills that will make you succeed|skills for success|eligibility requirements)\b/i.test(line)) continue;
    if (/^[)\]}\-–—:.,\s]+$/.test(line)) continue;
    if (!/(esperienza|experience|skills?|requirements?|requisiti|laurea|degree|language|lingua|english|italian|tedesco|francese|deutsch|français|python|java|excel|sap|sql|communication|teamwork|problem solving|analytical)/i.test(line)) continue;
    out.push(line);
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeAdapterSeedMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object') return null;
  const location = sanitizeLocation(normalizeSpace(rawMeta.location || rawMeta.regionLabel || rawMeta.addressLocality || ''));
  const canton = normalizeCantonCode(rawMeta.canton || rawMeta.cantonCode || rawMeta.region || rawMeta.regionCode || '');
  const company = normalizeSpace(rawMeta.company || rawMeta.companyName || rawMeta.brand || '');
  const contract = normalizeSpace(rawMeta.contract || rawMeta.employmentType || '');
  const postedDate = normalizeSpace(rawMeta.postedDate || rawMeta.datePosted || '');
  if (!location && !canton && !company && !contract && !postedDate) return null;
  return { location, canton, company, contract, postedDate };
}

function isAdapterSeedMetaTargetRelevant(seedMeta) {
  const meta = normalizeAdapterSeedMeta(seedMeta);
  if (!meta) return false;
  // Any recognized Swiss canton qualifies (nationwide crawl). normalizeCantonCode
  // only yields a non-empty code for one of the 26 Swiss cantons.
  if (meta.canton) return true;
  if (meta.location && isTargetSwissLocation(meta.location)) return true;
  return false;
}

function seedMetaPreferredLocation(seedMeta, fallback = '') {
  const meta = normalizeAdapterSeedMeta(seedMeta);
  if (!meta) return sanitizeLocation(fallback || '');
  if (meta.location) return sanitizeLocation(meta.location);
  if (meta.canton === 'GR') return 'Grigioni';
  if (meta.canton === 'TI') return 'Ticino';
  return sanitizeLocation(fallback || '');
}

function getAdapterSeedMetaForUrl(adapter, rawUrl) {
  if (!adapter || !adapter.seedMetaByUrl || typeof adapter.seedMetaByUrl !== 'object') return null;
  const absoluteUrl = tryUrl(rawUrl);
  if (!absoluteUrl) return null;
  const candidates = [
    canonicalizeJobUrl(absoluteUrl),
    absoluteUrl.toLowerCase(),
    absoluteUrl.replace(/\/+$/, '').toLowerCase(),
  ].filter(Boolean);
  for (const key of candidates) {
    const meta = adapter.seedMetaByUrl[key];
    if (meta) return meta;
  }
  return null;
}

// ─── Google Maps Geocoding — Centralized Ticino Location Verification ────────
// Verifies job locations via Google Maps Geocoding API (Nominatim fallback).
// Called AFTER text-based filters on the final merged job list, so ALL crawler
// types benefit from it. Only geocodes ambiguous locations that text filters
// couldn't resolve. Cached to avoid redundant API calls.

const _geocodeCache = new Map();
let _geocodeApiCalls = 0;
const GEOCODE_MAX_API_CALLS = clampNum(process.env.JOBS_GEOCODE_MAX_CALLS, 5, 200, 80);
const GEOCODE_RATE_LIMIT_MS = 250; // 4 req/sec — well within Google's 50/sec

// Relevant area: all of Switzerland (nationwide crawl), plus northern Italian
// border provinces close enough for cross-border commuting.
const BORDER_PROVINCES_IT = new Set([
  'varese', 'como', 'lecco', 'sondrio',
  'verbano-cusio-ossola', 'verbania', 'novara',
]);

/**
 * Geocode a location string using Google Maps Geocoding API.
 * Falls back to Nominatim (OpenStreetMap) if no API key available.
 * Returns { lat, lng, country, canton, province, formattedAddress } or null.
 */
async function geocodeLocation(locationStr) {
  const key = normalizeSpace(locationStr).toLowerCase();
  if (!key || key.length < 2) return null;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);

  let result = null;

  // ── Google Maps Geocoding (primary) ────────────
  if (GOOGLE_MAPS_API_KEY && _geocodeApiCalls < GEOCODE_MAX_API_CALLS) {
    try {
      // Bias towards Switzerland (region=ch) to resolve ambiguous place names
      // like "S.Antonino" (exists in both TI/Switzerland and Treviso/Italy).
      // This only biases, it doesn't restrict — Italian cities still resolve correctly.
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(locationStr)}&language=en&region=ch&key=${GOOGLE_MAPS_API_KEY}`;
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
      _geocodeApiCalls += 1;
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'OK' && data.results?.length > 0) {
          const r = data.results[0];
          const comps = r.address_components || [];
          const getComp = (type) => comps.find((c) => c.types?.includes(type));
          const country = getComp('country');
          const admin1 = getComp('administrative_area_level_1');
          const admin2 = getComp('administrative_area_level_2');
          result = {
            lat: r.geometry?.location?.lat,
            lng: r.geometry?.location?.lng,
            country: (country?.short_name || '').toUpperCase(),
            countryLong: (country?.long_name || '').toLowerCase(),
            canton: (admin1?.long_name || '').toLowerCase(),
            cantonShort: (admin1?.short_name || '').toUpperCase(),
            province: (admin2?.long_name || '').toLowerCase(),
            formattedAddress: r.formatted_address || '',
            source: 'google',
          };
        }
      }
      await new Promise((r) => setTimeout(r, GEOCODE_RATE_LIMIT_MS));
    } catch {
      // Fall through to Nominatim
    }
  }

  // ── Nominatim fallback ─────────────────────────
  if (!result) {
    try {
      // Bias towards Switzerland + Italy border area with viewbox & bounded=0
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationStr)}&limit=1&addressdetails=1&accept-language=en&countrycodes=ch,it`;
      const res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'FrontaliereTicinoCrawler/1.0',
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.length > 0) {
          const r = data[0];
          const addr = r.address || {};
          result = {
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            country: (addr.country_code || '').toUpperCase(),
            countryLong: (addr.country || '').toLowerCase(),
            canton: (addr.state || '').toLowerCase(),
            cantonShort: '',
            province: (addr.county || addr.state_district || '').toLowerCase(),
            formattedAddress: r.display_name || '',
            source: 'nominatim',
          };
        }
      }
      // Nominatim rate limit: max 1 req/sec
      await new Promise((r) => setTimeout(r, 1100));
    } catch {
      // Geocoding failed — will return null (fail open)
    }
  }

  _geocodeCache.set(key, result);
  return result;
}

/**
 * Check if a geocoded location is within the Ticino-relevant area.
 * Returns { relevant: boolean, reason: string }
 */
function isGeocodedLocationTicinoRelevant(geo) {
  if (!geo) return { relevant: true, reason: 'geocoding_failed_fail_open' };

  const { country, canton, cantonShort, province, lat, lng } = geo;

  // ── Switzerland → all 26 cantons relevant (nationwide crawl) ──
  if (country === 'CH') {
    return { relevant: true, reason: `ch_canton_${cantonShort || canton || 'unknown'}` };
  }

  // ── Italy ──
  if (country === 'IT') {
    const provLower = province.toLowerCase();
    if (BORDER_PROVINCES_IT.has(provLower)) {
      return { relevant: true, reason: `it_border_province_${provLower}` };
    }
    // Latitude-based fallback: if in northern Italy (lat > 45.5) and close to
    // Ticino longitude (8.4–9.4), it could be a border area we missed
    if (lat && lng && lat > 45.5 && lng > 8.4 && lng < 9.4) {
      return { relevant: true, reason: 'it_geo_proximity_border' };
    }
    return { relevant: false, reason: `it_province_${provLower || 'unknown'}_not_border` };
  }

  // ── Any other country → not relevant ──
  return { relevant: false, reason: `country_${country || 'unknown'}_not_relevant` };
}

/**
 * Async batch filter: verify job locations via geocoding.
 * Applied on the final merged job list so ALL crawler types benefit.
 *
 * Strategy:
 *  1. Skip jobs whose location text-matches a Swiss location (already verified)
 *  2. Geocode remaining ambiguous locations
 *  3. Reject jobs whose geocoded location is clearly outside Switzerland
 *     (foreign, except northern-Italian border provinces)
 *  4. If geocoding fails → keep the job (fail open)
 *
 * @param {Array} jobs - Merged, deduplicated jobs list
 * @returns {Promise<{filtered: Array, removedCount: number, removedJobs: Array}>}
 */
async function filterJobsByGeolocation(jobs) {
  const removed = [];
  const kept = [];

  for (const job of jobs) {
    const loc = normalizeSpace(job.location || '');
    // Skip geocoding if the location alone is already Ticino-relevant
    // (uses the comprehensive TICINO_CITIES list + border keywords)
    // or if adapter seed metadata already marked this job as in-target.
    if (isTargetSwissLocation(loc) || isJobPortalRelevant(job)) {
      kept.push(job);
      continue;
    }
    // Skip geocoding for generic/placeholder locations
    if (!loc || loc === 'Ticino' || loc === 'Switzerland' || loc === 'Svizzera' || loc === 'Schweiz') {
      kept.push(job);
      continue;
    }

    // Geocode the location
    // eslint-disable-next-line no-await-in-loop
    const geo = await geocodeLocation(loc);
    const check = isGeocodedLocationTicinoRelevant(geo);

    if (!check.relevant) {
      // For jobs with canton=TI (i.e. they passed text-based Ticino relevance),
      // retry geocoding with "Ticino, Switzerland" appended to disambiguate
      // place names that exist in both Switzerland and Italy (e.g. S.Antonino).
      if (job.canton === 'TI' || job.canton === 'GR') {
        const disambiguated = `${loc}, ${job.canton === 'TI' ? 'Ticino' : 'Grigioni'}, Switzerland`;
        // eslint-disable-next-line no-await-in-loop
        const geoRetry = await geocodeLocation(disambiguated);
        const retryCheck = isGeocodedLocationTicinoRelevant(geoRetry);
        if (retryCheck.relevant) {
          kept.push(job);
          continue;
        }
      }
      removed.push({ job, geo, reason: check.reason });
    } else {
      kept.push(job);
    }
  }

  if (removed.length > 0) {
    console.log(`\n🗺️  Geocoding filter removed ${removed.length} job(s) outside Switzerland:`);
    for (const { job, geo, reason } of removed) {
      console.log(`   ❌ [${job.company}] "${job.title}" — ${job.location} → ${geo?.formattedAddress || '?'} (${reason})`);
    }
  } else if (_geocodeApiCalls > 0) {
    console.log(`\n🗺️  Geocoding filter: all locations verified (${_geocodeApiCalls} API calls made)`);
  }

  return { filtered: kept, removedCount: removed.length, removedJobs: removed };
}

function isLikelyCommercialPromoContent({ title = '', description = '', pageUrl = '' }) {
  const text = `${title} ${description} ${pageUrl}`.toLowerCase();
  if (!text) return false;
  const commerceSignals = [
    '5% off',
    'pix',
    'parcelado',
    'wishlist',
    'carrello',
    'carrito',
    'spedizione',
    'shipping',
    'troca e devolucao',
    'troca e devolução',
    'carrinho',
    'seja um revendedor',
    'nossas lojas',
    'cnpj',
    'newsletter',
    'sneakers',
    'botas',
    'acessorios',
    'acessórios',
    'denim',
  ];
  // Vocabolario di lavoro condiviso con il gate del prospector
  // (`scripts/lib/job-like.mjs`), piu' i marcatori d'ATS che restano specifici
  // di questo strato. Erano due elenchi separati per la stessa domanda «questo
  // testo e' un annuncio?», destinati a divergere: quello del prospector e'
  // multilingue e per gruppi, questo undici stringhe nate da un incidente.
  //
  // Solo il VETO attinge al modulo condiviso, non la soglia commerciale: un
  // vocabolario di lavoro piu' ampio puo' soltanto salvare piu' annunci veri
  // dallo scarto, mai scartarne di piu'. Allargare anche `commerceSignals`
  // renderebbe il rilevatore piu' aggressivo su 600 crawler di produzione, che
  // e' l'unica direzione in cui un falso positivo costa un annuncio reale.
  // Restano qui i token che il modulo condiviso NON copre alla lettera:
  // `profil` e' una sottostringa nuda (prende anche "profilo"/"profile"), e
  // toglierla restringerebbe il veto invece di allargarlo. I cinque token che
  // il modulo copre parola per parola — responsibilities, requirements,
  // requisiti, employment type, apply now — sono stati tolti da qui.
  const atsSignals = [
    'stellenbeschreibung',
    'profil',
    'skills for success',
    'hiring organization',
    'job requisition id',
    'candidate profile',
  ];
  const commerceHits = commerceSignals.reduce((acc, s) => acc + (text.includes(s) ? 1 : 0), 0);
  const hasJobSignal = atsSignals.some((s) => text.includes(s)) || hasAnyJobSignal(text);
  return commerceHits >= 4 && !hasJobSignal;
}

function isLikelyListingSummaryContent(title = '', description = '') {
  const t = normalizeSpace(title).toLowerCase();
  const d = normalizeSpace(description).toLowerCase();
  if (!d) return false;
  if (/(kein passender job|job-newsletter|spontanbewerbung|deinen arbeitsort kannst du innerhalb der schweiz)/i.test(d)) return true;
  if (/\b\d{1,3}\s+jobs?\b/i.test(d) && /(vollzeit|teilzeit|hybrides arbeiten)/i.test(d)) return true;
  if (/(administration\s*\/\s*kfm|organisation\s*\/\s*projekte|verkauf\s*\/\s*kundenberatung)/i.test(d) && t.includes('berufliche zukunft')) {
    return true;
  }
  return false;
}

// FRO-231: slugify → moved to top of file (FRO-359)



function cleanDescription(desc) {
  // Strip HTML while preserving \n newlines. The general stripHtml helper calls
  // normalizeSpace which collapses every \s+ to a single space, so any newline
  // markers introduced by upstream htmlToStructuredText() (e.g. "\n- " for <li>,
  // "\n" for <p>/<br>) get flattened — descriptions arrive as one giant
  // paragraph and trip the audit's no-structured-content ratchet. Keep the
  // newlines so the rest of cleanDescription (already designed around \n) can
  // do its job.
  let text = String(desc || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Remove noisy legal / cookie / nav fragments
  text = text
    .replace(/(privacy policy|cookie policy|all rights reserved|accept all cookies|manage preferences)/gi, ' ')
    .replace(/(apply now|candidati ora|learn more|scopri di più)\s*$/gi, ' ')
    // Strip residual markdown formatting (***bold***, ##headings, # titles)
    .replace(/\*{2,}([^*]+)\*{2,}/g, '$1')   // ***bold*** or **bold** → bold
    .replace(/^#{1,6}\s+/gm, '')               // ## Heading → Heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url) → text
    .replace(/[^\S\n]+/g, ' ')      // collapse horizontal whitespace, preserve \n
    .replace(/\n[^\S\n]+/g, '\n')   // strip leading horizontal whitespace on each line
    .replace(/[^\S\n]+\n/g, '\n')   // strip trailing horizontal whitespace on each line
    .replace(/\n{3,}/g, '\n\n')      // max 2 consecutive newlines
    .replace(/^\n+|\n+$/g, '')       // trim leading/trailing newlines
    .trim();

  // Strip CTA / navigation / footer boilerplate that leaks from career portals
  // (SuccessFactors, Workday, etc.) — covers IT, EN, DE, FR.
  text = stripDescriptionBoilerplate(text);

  if (text.length > MAX_DESC_CHARS) text = text.slice(0, MAX_DESC_CHARS).trim();
  return text;
}

/** Known noise phrases that mark the end of useful job description content. */
const DESCRIPTION_NOISE_PATTERNS = [
  // IT
  /\bCandidati ora\b.*$/is,
  /\bInvia la tua candidatura\b.*$/is,
  /\bAvvia la candidatura con LinkedIn.*$/is,
  /\bInformazioni per le agenzie di reclutamento\b.*$/is,
  /\bRespingiamo ogni responsabilità sia per candidature non richieste.*$/is,
  /\bTrova offerte simili\s*:.*$/is,
  // EN
  /\bApply now\s*[»>].*$/is,
  /\bStart application with LinkedIn.*$/is,
  /\bInformation for recruitment agencies\b.*$/is,
  /\bWe reject all responsibility for unsolicited applications.*$/is,
  /\bFind similar offers\s*:.*$/is,
  // DE
  /\bJetzt bewerben\s*[»>].*$/is,
  /\bBewerbung mit LinkedIn starten.*$/is,
  /\bInformationen für Personalvermittlungsagenturen\b.*$/is,
  /\bWir lehnen jede Verantwortung für unaufgeforderte Bewerbungen.*$/is,
  /\bÄhnliche Angebote finden\s*:.*$/is,
  // FR
  /\bPostuler maintenant\s*[»>].*$/is,
  /\bDémarrer la candidature avec LinkedIn.*$/is,
  /\bInformations pour les agences de recrutement\b.*$/is,
  /\bNous déclinons toute responsabilité pour les candidatures non sollicitées.*$/is,
  /\bTrouver des offres similaires\s*:.*$/is,
  // Generic tail fragments (nav links / legal)
  /\s*-\s*Privacy\s*-\s*Terms of Use\s*-\s*Cookies\s*$/i,
  /\s*-\s*Confidentialité\s*-\s*Conditions d'utilisation\s*-\s*Cookies\s*$/i,
  /\s*-\s*Datenschutz\s*-\s*Nutzungsbedingungen\s*-\s*Cookies\s*$/i,
  /\s*-\s*Privacy\s*-\s*Termini di utilizzo\s*-\s*Cookies\s*$/i,
  // Rexx Systems ATS (concorsi.ti.ch) — footer nav and noise
  /\bIndietro\b\s*\n?\s*\bcandidatura online\s*[»>]?\s*$/is,
  /\bcandidatura online\s*[»>]?\s*$/is,
  /\bIndietro\b\s*$/i,
  /\bStampa\s*$/i,
  /\bJavascript non riconosciuto\b.*$/is,
  /\bFoglio Ufficiale\s*(?:n[.°]?\s*\d+)?.*$/im,
];

function stripDescriptionBoilerplate(text) {
  let cleaned = text;
  for (const re of DESCRIPTION_NOISE_PATTERNS) {
    cleaned = cleaned.replace(re, '').trim();
  }
  // Remove orphaned trailing separators
  cleaned = cleaned.replace(/[\s·•|\-]+$/, '').trim();
  return cleaned;
}

// ─── AI-based description structuring ────────────────────────────────────
// Many crawled job descriptions arrive as a single flat paragraph without
// headings, bullets, or line breaks.  This function uses an LLM to restructure
// the text into well-formatted markdown while keeping content verbatim.
//
// Guards:
//  • Only runs if the text is flat (no existing ## headings + \n\n)
//  • Only runs if text ≥ 100 chars (short descriptions don't need it)
//  • Returns original text on any failure (network, quota, malformed output)
//  • Validates output length to avoid truncated results

/** @type {number} */
let structureDescriptionCalls = 0;
const STRUCTURE_DESC_MAX_PER_RUN = 30;

// Language name for each supported locale, used to tell the LLM which
// language to format IN (not translate to) — the source description must
// stay in its own sourceLang, only markdown structure is added.
const _LOCALE_LANGUAGE_NAME = { it: 'Italian', de: 'German', fr: 'French', en: 'English' };
// Section-heading examples per locale, so structuring a de/fr/en source
// description doesn't graft Italian headings onto non-Italian body text.
const _LOCALE_SECTION_HEADINGS = {
  it: { tasks: 'Mansioni', requirements: 'Requisiti', offer: 'Cosa offriamo', contact: 'Contatto', fallback: 'Descrizione', rate: 'Grado di occupazione' },
  de: { tasks: 'Aufgaben', requirements: 'Anforderungen', offer: 'Wir bieten', contact: 'Kontakt', fallback: 'Beschreibung', rate: 'Beschäftigungsgrad' },
  fr: { tasks: 'Missions', requirements: 'Profil recherché', offer: 'Ce que nous offrons', contact: 'Contact', fallback: 'Description', rate: "Taux d'occupation" },
  en: { tasks: 'Responsibilities', requirements: 'Requirements', offer: 'What we offer', contact: 'Contact', fallback: 'Description', rate: 'Employment rate' },
};

/** Resolve the language name + localized section headings an AI prompt should target for a job's sourceLang, defaulting to Italian for unknown/missing locales. */
export function resolveLocalePromptContext(sourceLang) {
  return {
    langName: _LOCALE_LANGUAGE_NAME[sourceLang] || _LOCALE_LANGUAGE_NAME.it,
    headings: _LOCALE_SECTION_HEADINGS[sourceLang] || _LOCALE_SECTION_HEADINGS.it,
  };
}

async function structureJobDescription(rawText, sourceLang = 'it') {
  if (!rawText || rawText.length < 100) return rawText;
  const { langName } = resolveLocalePromptContext(sourceLang);

  const cacheKey = buildAiCacheKey('structure-desc-v2', [rawText, sourceLang]);
  const fromCache = getCachedAiResponse(cacheKey);
  if (typeof fromCache === 'string') {
    return fromCache === AI_CACHE_RAW_SENTINEL ? rawText : fromCache;
  }

  // Already has markdown structure → skip
  const hasHeadings = /^## /m.test(rawText);
  const hasBullets = /^- /m.test(rawText);
  const hasMultipleLines = (rawText.match(/\n/g) || []).length >= 3;
  const bulletCount = (rawText.match(/^\s*[-*•]\s+/gm) || []).length;
  const paragraphCount = rawText.split(/\n{2,}/).map((x) => normalizeSpace(x)).filter(Boolean).length;
  const looksStructuredEnough =
    (hasHeadings && (hasBullets || hasMultipleLines)) ||
    (hasBullets && bulletCount >= 5 && paragraphCount >= 2);
  if (looksStructuredEnough) {
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return rawText;
  }

  // Rate limit per run
  if (structureDescriptionCalls >= STRUCTURE_DESC_MAX_PER_RUN) {
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return rawText;
  }

  const { headings } = resolveLocalePromptContext(sourceLang);
  const prompt = `You are a job listing formatter. Restructure this flat job description into well-formatted ${langName} markdown. The text is already in ${langName} — do NOT translate it, only add structure.

Rules:
- Use ## for section headings (e.g. ## ${headings.tasks}, ## ${headings.requirements}, ## ${headings.offer}, ## ${headings.contact})
- Use - for bullet points listing individual tasks, requirements, or benefits
- Each bullet point should be a single, complete item (one task or one requirement)
- Keep ALL original content verbatim, in its original language — do NOT add, remove, translate, or rephrase any text
- Only add markdown structure (headings, bullets, line breaks)
- If no clear section structure exists, use ## ${headings.fallback} as the heading
- Output ONLY the formatted markdown, no explanations, preamble, or code fences

Text:
${rawText}`;

  try {
    structureDescriptionCalls++;
    const result = await callLLM(
      [{ role: 'user', content: prompt }],
      { model: 'gemini-flash-latest', maxTokens: 4000, temperature: 0.1 }
    );
    if (!result) {
      setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
      return rawText;
    }
    // Strip code fences if the model wrapped output; sanitize control chars
    const cleaned = _sanitizeAiOutput(result).replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    // Validate: output should be at least 70% of input length (guard against truncation)
    if (cleaned.length >= rawText.length * 0.7) {
      setCachedAiResponse(cacheKey, cleaned);
      return cleaned;
    }
  } catch { /* ignore — return original */ }
  setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
  return rawText;
}

// ── Centralized AI content enrichment for thin job descriptions ──
// Many crawled jobs have thin descriptions (only an overview or a few lines)
// but separately extracted structured fields (responsibilities, requirements,
// benefits) from the HTML. This function uses AI to compose a comprehensive,
// well-structured description in Italian from all available data.
//
// This runs centrally in the base crawler so ALL company crawlers benefit.
// Guards:
//  • Only runs if the existing description is thin (<500 chars)
//  • Only runs if additional structured data is available
//  • Returns original description on any failure
//  • Rate-limited to ENRICH_THIN_MAX_PER_RUN per crawler run

/** @type {number} */
let enrichThinCalls = 0;
const ENRICH_THIN_MAX_PER_RUN = 50;

async function aiEnrichThinDescription(job, sourceLangHint) {
  const sourceLang = sourceLangHint || job.sourceLang || 'it';
  const { langName, headings } = resolveLocalePromptContext(sourceLang);
  const desc = normalizeSpace(job.description || '');
  const responsibilities = job._migrosResponsibilities || [];
  const benefits = job._migrosBenefits || [];
  const requirements = Array.isArray(job.requirements) ? job.requirements : [];
  const workPercentage = job._migrosWorkPercentage || '';
  const hasStructuredData = responsibilities.length > 0 || benefits.length > 0 || requirements.length > 0;
  const descHasSections = /^##\s+/m.test(desc);
  const descBulletCount = (desc.match(/^\s*[-*•]\s+/gm) || []).length;

  const cacheKey = buildAiCacheKey('enrich-thin-v2', [
    job.title || '',
    job.company || '',
    job.location || '',
    job.contract || '',
    desc,
    responsibilities.join('\n'),
    requirements.join('\n'),
    benefits.join('\n'),
    workPercentage,
    sourceLang,
  ]);
  const fromCache = getCachedAiResponse(cacheKey);
  if (typeof fromCache === 'string') {
    return fromCache === AI_CACHE_RAW_SENTINEL ? job.description : fromCache;
  }

  // Already rich enough → skip
  if (desc.length >= 500) {
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return job.description;
  }

  // Already structured enough for UX/SEO quality → skip expensive enrichment
  if (desc.length >= 260 && descHasSections && descBulletCount >= 4) {
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return job.description;
  }

  // Need at least some structured data OR a description with raw content to work with
  if (!hasStructuredData && desc.length < 100) {
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return job.description;
  }

  // Rate limit per run
  if (enrichThinCalls >= ENRICH_THIN_MAX_PER_RUN) {
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return job.description;
  }

  // No AI available → skip
  if (!isAnyModelAvailable()) {
    setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
    return job.description;
  }

  // Build context block from all available structured fields
  const contextParts = [];
  contextParts.push(`Titolo: ${job.title || ''}`);
  contextParts.push(`Azienda: ${job.company || ''}`);
  contextParts.push(`Località: ${job.location || ''}`);
  if (desc) contextParts.push(`Descrizione attuale:\n${desc}`);
  if (responsibilities.length > 0) {
    contextParts.push(`Mansioni estratte:\n${responsibilities.map(r => `- ${r}`).join('\n')}`);
  }
  if (requirements.length > 0) {
    contextParts.push(`Requisiti estratti:\n${requirements.map(r => `- ${r}`).join('\n')}`);
  }
  if (benefits.length > 0) {
    contextParts.push(`Benefit aziendali:\n${benefits.map(b => `- ${b}`).join('\n')}`);
  }
  if (workPercentage) contextParts.push(`Grado di occupazione: ${workPercentage}`);
  if (job.contract) contextParts.push(`Tipo contratto: ${job.contract}`);

  const prompt = `You are a job listing expert. Compose a professional, complete job description in ${langName} using ALL the data provided below. The provided data may be in a different language than ${langName} — translate/compose it INTO ${langName}, do not leave it in the source language.

Rules:
- Use markdown format with ## sections (${headings.fallback}, ${headings.tasks}, ${headings.requirements}, ${headings.offer}, ${headings.contact})
- Use - for bullet points
- Integrate ALL the provided data without inventing additional information
- The opening description must be a 2-3 sentence introductory paragraph
- Each task, requirement, and benefit must be its own bullet point
- Do not add information not present in the provided data
- Do not repeat the same content across different sections
- If the employment rate is available, include it at the end as **${headings.rate}: XX%**
- Output ONLY the formatted markdown, no explanation, preamble, or code fence

Data:
${contextParts.join('\n\n')}`;

  try {
    enrichThinCalls++;
    const result = await callLLM(
      [{ role: 'user', content: prompt }],
      { model: 'gemini-flash-latest', maxTokens: 4000, temperature: 0.2 }
    );
    if (!result) {
      setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
      return job.description;
    }
    const cleaned = _sanitizeAiOutput(result).replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    // Must be at least as long as original and reasonably sized
    if (cleaned.length >= desc.length && cleaned.length >= 200) {
      setCachedAiResponse(cacheKey, cleaned);
      return cleaned;
    }
  } catch { /* ignore — return original */ }
  setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
  return job.description;
}

function htmlToStructuredText(html) {
  if (!html) return '';
  let text = String(html)
    // Common ATS pattern: <p><strong>Section title</strong></p>
    .replace(/<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi, '\n## $1\n')
    // Convert structural HTML to newlines/markdown markers
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    // Strip remaining HTML tags AFTER preserving structure
    .replace(/<[^>]+>/g, ' ');
  return cleanDescription(text);
}

/**
 * Rexx Systems ATS (concorsi.ti.ch) — dedicated structured text extraction.
 *
 * The Rexx HTML has a very specific structure:
 *   - Header table: company name, Foglio Ufficiale, dates, reference number
 *   - Department h2 (emp_nr_subtitle)
 *   - Job title h2 (emp_nr_subtitle)
 *   - Salary line (Classe e stipendio annuo...)
 *   - Sections: Compiti, Requisiti, Condizioni particolari, Osservazioni particolari,
 *     Condizioni di presentazione, Condizioni d'impiego, Scadenza
 *
 * The generic htmlToStructuredText() produces low-quality output because:
 *   - It dumps the entire header table (company, dates, FU number) into the description
 *   - All emp_nr_subtitle h2 tags become ## headings — including department/title which
 *     aren't description sections
 *   - Content between sections often has no wrapping <p> tags; it's raw text in <span>s
 *   - Salary info gets mixed into the description text
 *
 * This function:
 *   1. Strips the header table (everything before first emp_nr_subtitle)
 *   2. Skips department/title/salary headings (first 2-3 emp_nr_subtitle)
 *   3. Formats real sections (Compiti, Requisiti, etc.) as ## headings
 *   4. Properly converts <ul>/<li> to bullet lists
 *   5. Handles <strong> labels (e.g., "Condizioni particolari:") as sub-headings
 *   6. Strips noise: reference numbers, Foglio Ufficiale, dates, scadenza
 */
function formatRexxDescription(html) {
  if (!html) return '';
  let content = String(html);

  // Decode common HTML entities before processing.
  // The Rexx HTML uses &nbsp; heavily for spacing (between class number and salary,
  // between sections, etc.). Without decoding, regex patterns fail.
  content = content
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\u200B/g, '');   // zero-width joiners

  // Strip everything after the emp_nr_innerframe close (footer, page chrome).
  // Multiple regex patterns to handle varied whitespace and nesting in Rexx HTML.
  content = content.replace(/<div\s+id=["']footer_links["'][\s\S]*/i, '');
  content = content.replace(/<\/div>\s*<\/div>\s*<\/div>\s*<div\s+id="footer_links"[\s\S]*/i, '');
  // Also strip the closing </div> chain at the end of emp_nr_innerframe
  content = content.replace(/(<\/div>\s*){2,}$/i, '');

  // Do NOT strip all <table> blocks:
  // Rexx embeds the *actual job sections* (Compiti/Requisiti/...) inside tables.
  // The old broad table removal caused near-empty output and forced fallback parsing.
  // Header boilerplate is removed later by section slicing + noise cleanup.

  // Strip salary block — it's extracted separately by extractRexxSalary().
  // Pattern: "Classe e stipendio annuo (compresa 13a mensilità):" followed by class+amounts
  content = content.replace(/Classe e stipendio annuo\s*\([^)]*\)\s*:?[\s\S]*?\.--/gi, '');

  // ── Locate content sections by finding h2 tags one at a time ──
  // The h2 tags contain nested <span> tags, so we must strip inner tags
  // before checking the text content. A spanning regex like
  //   <h2[^>]*>[\s\S]*?Compiti[\s\S]*?</h2>
  // would incorrectly match from an earlier h2 (e.g. "Dipartimento") all the
  // way through later h2 tags because [\s\S] matches across tag boundaries.
  const CONTENT_SECTION_NAMES = [
    'Compiti', 'Requisiti', 'Condizioni particolari', 'Osservazioni particolari',
    'Mansioni', 'Profilo richiesto', 'Offriamo', 'Descrizione',
    'Condizioni di presentazione della candidatura',
    "Condizioni d'impiego", 'Condizioni d\u2019impiego',
    'Scadenza', 'Contatto',
    'Aufgaben', 'Anforderungen',
  ];

  // Find all h2 positions and their text content
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let h2Match;
  const h2Tags = [];
  while ((h2Match = h2Re.exec(content)) !== null) {
    const rawText = h2Match[1].replace(/<[^>]+>/g, '').trim().replace(/:$/, '');
    h2Tags.push({ fullMatch: h2Match[0], index: h2Match.index, endIndex: h2Match.index + h2Match[0].length, text: rawText });
  }

  // Also find <strong> labels that act as section headings
  const strongRe = /<strong>\s*((?:Condizioni|Requisiti|Profilo|Offriamo|Mansioni|Responsabilit)[^<]*?)\s*:?\s*<\/strong>/gi;
  let strongMatch;
  while ((strongMatch = strongRe.exec(content)) !== null) {
    const rawText = strongMatch[1].trim().replace(/:$/, '');
    h2Tags.push({ fullMatch: strongMatch[0], index: strongMatch.index, endIndex: strongMatch.index + strongMatch[0].length, text: rawText, isStrong: true });
  }
  h2Tags.sort((a, b) => a.index - b.index);

  // Find the first content section (Compiti, Requisiti, etc.)
  const isContentSection = (text) => CONTENT_SECTION_NAMES.some(n =>
    text.toLowerCase().startsWith(n.toLowerCase())
  );
  const firstContentIdx = h2Tags.findIndex(h => isContentSection(h.text));
  if (firstContentIdx >= 0) {
    content = content.slice(h2Tags[firstContentIdx].index);
  }

  // Convert h2 headings to ## markdown.
  // These contain <span> wrappers, so we strip inner tags to get clean text.
  content = content.replace(
    /<h2[^>]*>([\s\S]*?)<\/h2>/gi,
    (_, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim().replace(/:$/, '');
      return text ? `\n## ${text}\n` : '\n';
    }
  );

  // Convert <strong> labels to sub-headings (e.g., "Condizioni particolari:")
  content = content.replace(
    /<strong>\s*((?:Condizioni|Requisiti|Profilo|Offriamo|Mansioni|Responsabilit)[^<]*?)\s*:?\s*<\/strong>/gi,
    '\n## $1\n'
  );

  // Strip all remaining <strong>/<b> tags — keep their text content but remove the tags.
  // This prevents bold-formatted noise (company names, dates, reference numbers) from
  // leaking into the description as raw text after the final HTML tag strip.
  content = content.replace(/<\/?(strong|b)\b[^>]*>/gi, ' ');

  // Convert lists
  content = content
    .replace(/<ul[^>]*>/gi, '\n')
    .replace(/<\/ul>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n');

  // Strip all remaining HTML tags
  content = content.replace(/<[^>]+>/g, ' ');

  // Strip Rexx-specific noise that may survive after HTML stripping:
  // - Duplicate header text: "Descrizione posizione Descrizione"
  // - Reference numbers: "N. 12345" or "Rif. 12345"
  // - "Foglio Ufficiale" references with dates
  // - Footer navigation: "Indietro", "candidatura online »", "Stampa"
  // - "Repubblica e Cantone Ticino" / "Sezione delle risorse umane" headers
  content = content
    .replace(/Descrizione\s+posizione\s+Descrizione\b/gi, '')
    .replace(/\bN\.\s*\d{3,}\b/g, '')
    .replace(/\bRif\.\s*\d{3,}\b/g, '')
    .replace(/\bFoglio Ufficiale\b[^\n]*/gi, '')
    .replace(/\bRepubblica e Cantone Ticino\b/gi, '')
    .replace(/\bSezione delle risorse umane\b/gi, '')
    .replace(/\bIndietro\b/gi, '')
    .replace(/\bcandidatura online\s*[»>]?\s*/gi, '')
    .replace(/\bStampa\b/gi, '');

  return cleanDescription(content);
}

/**
 * Extract salary from Rexx Systems ATS pages (concorsi.ti.ch).
 *
 * Salary format in the HTML:
 *   Classe e stipendio annuo (compresa 13a mensilità):
 *   {class}    {min}.-- / {max}.--
 *
 * Examples:
 *   "9    83'603.-- / 133'310.--"
 *   "1    41'834.-- / 64'005.--"
 *   "Infermiere/a con specialità 5    63'297.-- / 99'123.--"
 *
 * Numbers use ' as thousands separator (Swiss format).
 * Some jobs have "contratto speciale" instead of numbers → returns null.
 *
 * @param {string} html Raw HTML of the Rexx page
 * @returns {{ salaryClass: string, min: number, max: number, currency: string } | null}
 */
function extractRexxSalary(html) {
  if (!html) return null;
  // Decode &nbsp; to regular space before stripping HTML, otherwise the
  // salary numbers like "1&nbsp;&nbsp;41'834.--" become "1 41'834" with
  // literal &nbsp; text that breaks regex matching.
  const decoded = String(html).replace(/&nbsp;/gi, ' ');
  const text = stripHtml(decoded);

  // Primary pattern: "Classe e stipendio annuo (compresa 13a mensilità):" followed
  // by class number and salary range. The parenthetical "(compresa 13a mensilità)"
  // contains "13a" which a naive [\s\S]*?([\d]+) would capture as the class.
  // Fix: explicitly match through the closing paren and colon first.
  // Note: ti.ch uses Unicode RIGHT SINGLE QUOTATION MARK (\u2019) as thousands
  // separator, not ASCII apostrophe. Match both.
  //
  // Some jobs have a title prefix before the class number, e.g.:
  //   "Infermiere/a con specialità 5    63'297.-- / 99'123.--"
  // Allow any non-digit text (title prefix) between the colon and the class number.
  // Also handle <br/> that becomes whitespace/newlines after stripHtml.
  const salaryMatch = text.match(
    /Classe e stipendio annuo\s*\([^)]*\)\s*:?\s*(?:[^\d]*?)(\d{1,2})\s+(\d[\d'\u2019]*)\.--\s*\/\s*(\d[\d'\u2019]*)\.--/i
  );
  if (salaryMatch) {
    const cls = salaryMatch[1];
    const min = Number(salaryMatch[2].replace(/['\u2019]/g, ''));
    const max = Number(salaryMatch[3].replace(/['\u2019]/g, ''));
    if (Number.isFinite(min) && Number.isFinite(max) && min > 10000 && max > min) {
      return { salaryClass: cls, min, max, currency: 'CHF' };
    }
  }

  // Some jobs list multiple salary classes. Try matching any of them.
  // Pattern: "{class}    {min}.-- / {max}.--" appearing anywhere after "Classe e stipendio"
  const salaryBlockMatch = text.match(/Classe e stipendio annuo\s*\([^)]*\)\s*:?([\s\S]{0,500})/i);
  if (salaryBlockMatch) {
    const block = salaryBlockMatch[1];
    const classRe = /(\d{1,2})\s+(\d[\d'\u2019]*)\.--\s*\/\s*(\d[\d'\u2019]*)\.--/g;
    let cm;
    let bestResult = null;
    while ((cm = classRe.exec(block)) !== null) {
      const cls = cm[1];
      const min = Number(cm[2].replace(/['\u2019]/g, ''));
      const max = Number(cm[3].replace(/['\u2019]/g, ''));
      if (Number.isFinite(min) && Number.isFinite(max) && min > 10000 && max > min) {
        // Take the highest salary range (best-case for the candidate)
        if (!bestResult || max > bestResult.max) {
          bestResult = { salaryClass: cls, min, max, currency: 'CHF' };
        }
      }
    }
    if (bestResult) return bestResult;
  }

  // Fallback: just look for Swiss salary range pattern anywhere
  // e.g., "83'603.-- / 133'310.--" (with either ASCII or Unicode apostrophe)
  const rangeMatch = text.match(/(\d[\d'\u2019]{4,})\.--\s*\/\s*(\d[\d'\u2019]{4,})\.--/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1].replace(/['\u2019]/g, ''));
    const max = Number(rangeMatch[2].replace(/['\u2019]/g, ''));
    if (Number.isFinite(min) && Number.isFinite(max) && min > 10000 && max > min) {
      return { salaryClass: '', min, max, currency: 'CHF' };
    }
  }

  return null;
}

function extractPageLang(html = '') {
  const m = String(html).match(/<html[^>]*\slang=["']([a-z]{2})(?:-[A-Z]{2})?["']/i);
  return normalizeSpace(m?.[1] || '').toLowerCase() || 'en';
}

function bestJobPostingNodeFromHtml(html) {
  const blocks = extractJsonLdBlocks(html);
  let best = null;
  for (const block of blocks) {
    const nodes = extractJobPostingNodes(block);
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      if (!best) {
        best = n;
        continue;
      }
      const currLen = cleanDescription(n.description || '').length;
      const bestLen = cleanDescription(best.description || '').length;
      if (currLen > bestLen) best = n;
    }
  }
  return best;
}

function extractWorkdayLocation(html) {
  const candidates = [];
  const block = String(html).match(/<div[^>]*id=["']jl["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const text = cleanDescription(block);
  if (text) {
    const byLabel = normalizeSpace(text.split(/Arbeitsort|Lieu de travail|Workplace|Sede di lavoro|Work location|Arbeitsstelle/i).pop() || text);
    if (byLabel) candidates.push(byLabel);
  }

  const plain = stripHtml(html);
  const locLabel = plain.match(/(?:Arbeitsort|Lieu de travail|Workplace|Sede di lavoro|Work location)\s*:?\s*([^\n]{3,180})/i)?.[1];
  if (locLabel) candidates.push(normalizeSpace(locLabel));

  const postalLine = plain.match(/\b(\d{4,5}\s+[A-ZÀ-ÖØ-Ýa-zà-öø-ÿ'(). -]{2,80})\b/g) || [];
  for (const p of postalLine.slice(0, 4)) candidates.push(normalizeSpace(p));

  // #4587: the "jl" div split and the loose label regex above are the same
  // crude full-text label scan pattern guarded elsewhere in this file (see
  // looksLikeShortLabelValue above extractCompanyFromText) — without this
  // check a label keyword found mid-prose (e.g. "Workplace: where your ideas
  // valued...") gets captured whole as a "location". Sanitize + guard every
  // candidate before picking the longest one.
  const best = candidates
    .map((x) => sanitizeLocation(x.replace(/\s{2,}/g, ' ').trim()))
    .filter((x) => x && looksLikeShortLabelValue(x))
    .sort((a, b) => b.length - a.length)[0] || '';
  return best;
}

function extractWorkdayApplyUrl(html, baseUrl) {
  // #6480: the substring filter belongs in JS, not inside the attribute regex —
  // `[^"']*lumessetalentlink[^"']+` cut the URL at any apostrophe in it.
  const hit = readAllAttr(html, 'href').find((h) => h.includes('lumessetalentlink'));
  if (!hit) return '';
  return tryUrl(hit, baseUrl) || '';
}

// extractMigrosStructuredData, extractMigrosSectionItems, extractMigrosBenefitItems
// are imported from ./migros-job-parser.mjs at the top of this file.

function extractRichJobDescription(html) {
  const supsiParsed = parseSupsiJobDetail(html);
  if (supsiParsed.description.length >= 180) return supsiParsed.description;

  // Migros Nuxt SSR pages (jobs.migros.ch) — content split across
  // <section id="overview|tasks|skills|benefits|recruitment">.
  // Each section has <h3> headings, <h4> sub-headings, and <p> text.
  // The SVG bullet-skill icons are stripped; text content is preserved.
  const migrosIds = ['overview', 'tasks', 'skills', 'benefits', 'recruitment'];
  const migrosRe = new RegExp(
    '<section\\s+id=["\'](' + migrosIds.join('|') + ')["\'][^>]*>([\\s\\S]*?)</section>',
    'gi'
  );
  const migrosChunks = [];
  let mm;
  while ((mm = migrosRe.exec(String(html))) !== null) {
    const sectionId = mm[1].toLowerCase();
    let sectionHtml = mm[2];
    // Strip SVG noise (skill-level dots and decorative icons)
    sectionHtml = sectionHtml.replace(/<svg[\s\S]*?<\/svg>/gi, '');
    // Strip share buttons and apply buttons containers
    sectionHtml = sectionHtml.replace(/<div[^>]*class="[^"]*ad-share-list[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    // Strip image carousels
    sectionHtml = sectionHtml.replace(/<div[^>]*class="[^"]*flicking[^"]*"[^>]*>[\s\S]*?(?:<\/div>\s*){1,5}/gi, '');
    // Skip overview share/apply UI (keep only typo-body1 intro text)
    if (sectionId === 'overview') {
      const introMatch = sectionHtml.match(/<div[^>]*class="[^"]*typo-body1[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (introMatch) {
        sectionHtml = introMatch[1];
      }
    }
    const sectionText = htmlToStructuredText(sectionHtml);
    if (sectionText.length >= 20) migrosChunks.push(sectionText);
  }
  const migrosJoined = cleanDescription(migrosChunks.join('\n\n'));
  if (migrosJoined.length >= 300) return migrosJoined;

  // Rexx Systems ATS (concorsi.ti.ch) — job content in <div class="emp_nr_innerframe">
  // Contains structured sections (Compiti, Requisiti, Condizioni, Scadenza) with
  // H2 headings and UL/LI lists. Stop capture before the footer_links div to avoid
  // leaking navigation noise ("Indietro", "candidatura online »").
  const rexxMatch = String(html).match(/<div class=["']emp_nr_innerframe["']>([\s\S]*?)(?:<div\s+id=["']footer_links["']|<\/body|$)/i);
  if (rexxMatch) {
    const rexxText = formatRexxDescription(rexxMatch[1]);
    if (rexxText.length >= 100) return rexxText;
  }

  // SuccessFactors / SAP career portals (e.g., careers.zurich.com, career.ibsagroup.com)
  // The full description lives inside <span class="jobdescription"> with deeply
  // nested HTML (79+ inner </span> tags), so we cannot use lazy </span> matching.
  // Instead, capture from the jobdescription class to a known structural boundary.
  // The boundary keywords (apply, job-actions, etc.) may appear as substrings
  // (e.g., "applylink pull-right"), so we don't require them at a class boundary.
  const sfMatch = String(html).match(
    /class=["']jobdescription["'][^>]*>([\s\S]*?)(?:<div[^>]*class=["'][^"']*(?:job-actions|apply|back-button|applyContainer)[^"']*["']|<footer\b)/i
  );
  if (sfMatch) {
    const sfText = htmlToStructuredText(sfMatch[1]);
    if (sfText.length >= 180) return sfText;
  }

  const mainChunk =
    String(html).match(/<div class="row wysiwyg">([\s\S]*?)<div class="col-lg-4/i)?.[1] ||
    String(html).match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    '';
  const richText = htmlToStructuredText(mainChunk);
  if (richText.length >= 180) return richText;

  const richBlocks = [];
  const richBlockRe = /<div[^>]*class=["'][^"']*m-richtext__content[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let rb;
  while ((rb = richBlockRe.exec(String(html))) !== null) {
    const t = htmlToStructuredText(rb[1]);
    if (t.length >= 60) richBlocks.push(t);
  }
  const joinedRich = cleanDescription(richBlocks.join('\n\n'));
  if (joinedRich.length >= 180) return joinedRich;

  // Fallback to high-signal field blocks common in career pages.
  const blocks = [];
  const re = /<div[^>]*class=["'][^"']*field[^"']*f-n-(?:body|field-job-[^"']+)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const t = htmlToStructuredText(m[1]);
    if (t.length >= 30) blocks.push(t);
  }
  return cleanDescription(blocks.join('\n\n'));
}

function extractAlternateLocaleUrls(html, currentUrl) {
  const out = {};
  // #6480: read the tag, then its attributes — the old single regex glued
  // `hreflang=` and `href=` together and its `[^"']` classes cut either value
  // at an apostrophe (hreflang never carries one, an href can).
  const rx = /<link\b[^>]*>/gi;
  let m;
  while ((m = rx.exec(String(html))) !== null) {
    const tag = m[0];
    if (!/(?<![\w-])rel\s*=\s*(["'])alternate\1/i.test(tag)) continue;
    const hreflang = normalizeSpace(readAttr(tag, 'hreflang')).toLowerCase();
    const href = tryUrl(readAttr(tag, 'href'), currentUrl);
    if (!href || !hreflang || hreflang === 'x-default') continue;
    const lang = hreflang.slice(0, 2);
    if (!LOCALES.includes(lang)) continue;
    out[lang] = href;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded rollout for the per-slot title-language verdict (D5 / S3).
//
// `titleLooksUntranslated` flags 30.14% of non-source title slots (24,054 of
// 79,796 measured 2026-08-10; 49.8% of jobs carry at least one). Flagging all of
// them the first time this code runs would enqueue a backlog above what drains
// per run: the quota-bound cascade in relocalize-pending-jobs.mjs repairs ~100
// jobs/run, and the free unlimited local-MT mop-up (local-mt-mopup.mjs
// `missingSlots`, extended 2026-08-24 to call `titleLooksUntranslated` too —
// issue #6354) is capped by its own per-run job budget (LOCAL_MT_MAX_JOBS,
// default 2000) and wall-clock budget, not by detection reach.
//
// So the sweep over *already-stored* titles is capped per process. Slots this
// call actually wrote are NOT capped: they are new content, they are few, and
// checking them is what the quality gate below has always done.
//
// 0 disables the sweep entirely (changed slots keep being checked).
const DEFAULT_TITLE_REQUEUE_BUDGET = 50;
let _titleRequeueBudgetSpent = 0;

function _titleRequeueBudgetLimit() {
  const raw = process.env.JOBS_TITLE_LANG_REQUEUE_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_TITLE_REQUEUE_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TITLE_REQUEUE_BUDGET;
}

/** @returns {boolean} true when this process may raise one more backlog flag. */
function _claimTitleRequeueBudget() {
  if (_titleRequeueBudgetSpent >= _titleRequeueBudgetLimit()) return false;
  _titleRequeueBudgetSpent += 1;
  return true;
}

/** Test seam: the counter is process-wide by design (that IS the cap). */
export function _resetTitleRequeueBudget() { _titleRequeueBudgetSpent = 0; }
/** Test/telemetry seam. */
export function _titleRequeueBudgetState() {
  return { spent: _titleRequeueBudgetSpent, limit: _titleRequeueBudgetLimit() };
}

// FRO-231: slug quality checks → moved to top of file (FRO-359)

function _slugByLocaleDiffer(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (String(a?.[k] || '') !== String(b?.[k] || '')) return true;
  }
  return false;
}

export function ensureLocaleFields(job) {
  const out = { ...job };
  // Snapshot pre-mutation titles so the quality gate below can skip locales
  // this call left untouched — re-running the wrong-language heuristic on
  // titles that were already present and unchanged is what mass-re-flags
  // complete jobs with needsRetranslation on every crawl run (see EOC/migros
  // incident: 76%/51% of already-translated jobs re-flagged every run).
  const _preTitleByLocale = (job.titleByLocale && typeof job.titleByLocale === 'object') ? { ...job.titleByLocale } : {};
  const titleByLocale = (out.titleByLocale && typeof out.titleByLocale === 'object') ? { ...out.titleByLocale } : {};
  const descriptionByLocale = (out.descriptionByLocale && typeof out.descriptionByLocale === 'object') ? { ...out.descriptionByLocale } : {};
  const requirementsByLocale = (out.requirementsByLocale && typeof out.requirementsByLocale === 'object') ? { ...out.requirementsByLocale } : {};
  const slugByLocale = (out.slugByLocale && typeof out.slugByLocale === 'object') ? { ...out.slugByLocale } : {};
  const baseTitle = normalizeSpace(out.title || '');
  const baseDescription = normalizeSpace(out.description || '');

  const bestTitle =
    normalizeSpace(titleByLocale.it || '') ||
    normalizeSpace(titleByLocale.en || '') ||
    normalizeSpace(titleByLocale.de || '') ||
    normalizeSpace(titleByLocale.fr || '') ||
    baseTitle;

  const bestDescription =
    normalizeSpace(descriptionByLocale.it || '') ||
    normalizeSpace(descriptionByLocale.en || '') ||
    normalizeSpace(descriptionByLocale.de || '') ||
    normalizeSpace(descriptionByLocale.fr || '') ||
    baseDescription;
  // Publisher-authored records pin their declared source language — heuristic
  // detection must never reclassify (and then "repair") the slot the employer
  // wrote (see pinnedTitleSourceLang in job-locale-utils.mjs).
  const pinnedLang = pinnedTitleSourceLang(out);
  const sourceLang = pinnedLang || detectLang(`${bestTitle} ${bestDescription}`, 'en');
  const titleSourceLang = pinnedLang || detectJobTitleLang(baseTitle || bestTitle, sourceLang);
  const sourceTitle = baseTitle || normalizeSpace(titleByLocale[titleSourceLang] || bestTitle);

  // Detect the language of the raw base description separately — it may differ
  // from sourceLang when titleByLocale has wrong-language entries.
  const baseDescLang = baseDescription.length >= 60
    ? detectLang(baseDescription, sourceLang)
    : sourceLang;

  if (sourceTitle) {
    titleByLocale[titleSourceLang] = sourceTitle;
  }

  for (const locale of LOCALES) {
    const currentTitle = normalizeSpace(titleByLocale[locale] || '');
    if (locale === titleSourceLang) {
      if (!currentTitle || currentTitle !== sourceTitle) {
        if (sourceTitle) titleByLocale[locale] = sourceTitle;
      }
    } else if (currentTitle) {
      // STABILITY: Do not overwrite existing titles that are already in a non-source locale.
      // The old logic detected "wrong language" and replaced with heuristic translations,
      // but this caused "Hebamme" (correct DE) → "Ostetrica/o" (wrong IT in DE slot),
      // and "Organizational Specialist" (correct EN) → "Specialista Organizzativo" (IT in EN).
      // That stability rule stands: a wrong-language title is REPORTED here (the
      // quality gate below queues it), never heuristically rewritten in place.
      //
      // S3 (2026-08-10): the source-copy branch used to be skipped whenever any
      // OTHER non-source locale differed from the source ("it must be an
      // international title"). That cross-locale rule is exactly the reported bug
      // — for a DE-source job whose EN and FR slots translated and whose IT slot
      // did not, it suppressed the IT check on the evidence of EN and FR. The
      // verdict is now taken per slot, from the shared primitive, so no
      // cross-locale escape hatch is needed by construction: a slot that holds
      // its own source copy is untranslated whatever the neighbouring slots hold.
      const verdict = titleLooksUntranslated({
        title: currentTitle,
        sourceTitle,
        sourceLang: titleSourceLang,
        targetLocale: locale,
        company: out.company || '',
        location: out.addressLocality || out.location || '',
      });
      // Only the exact-copy case is rewritten here. heuristicTranslateJobTitle
      // translates the SOURCE title, so it has nothing to offer a slot that
      // already holds a partial translation — that repair belongs to the
      // translate pipeline (dedicated-crawler-common enrichJobLocalesDCC), which
      // now accepts flagged slots instead of skipping them.
      if (verdict.reason === 'source-copy') {
        const heuristicReplacement = heuristicTranslateJobTitle(sourceTitle, locale);
        if (heuristicReplacement &&
            heuristicReplacement.toLowerCase() !== sourceTitle.toLowerCase() &&
            !isLowQualityLocalizedTitle(heuristicReplacement)) {
          titleByLocale[locale] = heuristicReplacement;
        }
      }
    } else if (!currentTitle && locale !== titleSourceLang && sourceTitle) {
      // Locale slot was already empty — try heuristic fill
      const translated = heuristicTranslateJobTitle(sourceTitle, locale);
      if (
        translated &&
        translated.toLowerCase() !== sourceTitle.toLowerCase() &&
        !isLowQualityLocalizedTitle(translated)
      ) {
        titleByLocale[locale] = translated;
      }
    }
    // Fill empty description slots for source/detected language only.
    // Non-source locales are left empty if no proper translation is available —
    // UI/runtime SEO can fallback to out.description when needed.
    // However, NEVER delete existing description data for any locale.
    if (
      !normalizeSpace(descriptionByLocale[locale] || '') &&
      bestDescription &&
      (locale === sourceLang || locale === baseDescLang)
    ) {
      // Use the raw base description when the locale matches its detected language,
      // otherwise fall back to bestDescription (which may already be translated).
      descriptionByLocale[locale] = (locale === baseDescLang && baseDescription)
        ? baseDescription
        : bestDescription;
    }
    const req = Array.isArray(requirementsByLocale[locale]) ? requirementsByLocale[locale] : [];
    if (req.length === 0 && Array.isArray(out.requirements) && out.requirements.length > 0) {
      requirementsByLocale[locale] = mergeRequirements([], out.requirements);
    }
  }

  out.titleByLocale = titleByLocale;
  out.descriptionByLocale = descriptionByLocale;
  out.requirementsByLocale = requirementsByLocale;
  // Language word sets used by both slug regeneration and quality gate below.
  const _LANG_WORDS = {
    it: new Set('assemblaggio,imballo,imballaggio,collaudo,edile,cantiere,geometra,impiegato,impiegata,responsabile,tecnico,tecnica,ingegnere,manutenzione,magazzino,produzione,qualita,logistica,vendita,pulizia,operaio,operaia,conduttore,conduttrice,contabile,elettricista,meccanico,meccanica,direttore,direttrice,gestione,amministrazione,segretario,segretaria,cuoco,cuoca,cameriere,cameriera,operatore,operatrice,educatore,educatrice,infermiere,infermiera,fisioterapista,caporeparto,servizio,ricercatore,ricercatrice,architetto,laboratorio,metrologia,saldatore,fresatore,tornitore,verniciatore,falegname,muratore,idraulico,giardiniere,autista,magazziniere,addetto,addetta,apprendista,collaboratore,collaboratrice,specialista,descrizione,mansioni,requisiti,candidato,principali'.split(',')),
    de: new Set('mitarbeiter,mitarbeitende,aufgaben,bewerbung,bewerben,arbeitsort,anfallenden,unternehmen,lernender,lehrjahr,detailhandel,kassieren,filiale,filialen,qualifikationsverfahren,ferien,ausbildung,angebot,beschreibung,stellenangebot,verantwortungsvolles,einsatzbereitschaft,teamgeist,karriere,arbeitsbeginn,pensum,vollzeit,teilzeit,berufserfahrung,anforderungen,voraussetzungen,leistung,entlohnung,schulung,weiterbildung,pflegefachfrau,pflegefachmann,systemgastronomie,diatkoch'.split(',')),
    fr: new Set('responsable,candidature,postuler,emploi,salaire,formation,recrutement,disponibilite,competences,qualifications,experience,horaires,contrat,entreprise,taches,principales,description,auxiliaire'.split(',')),
  };
  const _getWords = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter(w => w.length > 5);
  const _hasWrongLang = (text, locale) => {
    const words = _getWords(text);
    for (const [lang, wordSet] of Object.entries(_LANG_WORDS)) {
      if (lang === locale) continue;
      if (words.filter(w => wordSet.has(w)).length >= 2) return true;
    }
    return false;
  };

  for (const locale of LOCALES) {
    const localizedTitleRaw = normalizeSpace(titleByLocale[locale] || out.title || '');
    const localizedTitle = isLowQualityLocalizedTitle(localizedTitleRaw)
      ? normalizeSpace(out.title || bestTitle || '')
      : localizedTitleRaw;
    const currentSlug = normalizeSpace(slugByLocale[locale] || '');
    const baseItSlug = normalizeSpace(slugByLocale.it || out.slug || '');
    // Use heuristic (deterministic) translation for slug derivation, not AI title.
    // heuristicTranslateJobTitle may return the input unchanged when no pattern matches —
    // in that case, prefer the AI-translated title from titleByLocale[locale] for the slug.
    const sourceTitle = normalizeSpace(out.title || '');
    const heuristicTitle = heuristicTranslateJobTitle(sourceTitle, locale);
    const rawLocaleTitle = normalizeSpace(titleByLocale[locale] || '');
    const localeHasTranslatedTitle = rawLocaleTitle && rawLocaleTitle.toLowerCase() !== sourceTitle.toLowerCase();
    // For slug derivation, prefer the AI-translated title over heuristic.
    // Heuristic may only partially translate (e.g. "Ingegnere" → "Engineer" but
    // leaves "edile" untranslated), producing worse slugs than AI titles.
    // Only use heuristic when there's no AI-translated title available.
    const slugSourceTitle = localeHasTranslatedTitle ? rawLocaleTitle : localizedTitle;
    const hashSuffix = stableSlugHash(out);
    const derivedSlug =
      slugify(`${slugSourceTitle}-${out.company || ''}-${out.location || ''}`) ||
      slugify(slugSourceTitle) ||
      normalizeSpace(out.slug || '');
    // Check if the current slug has wrong-language words
    const _slugHasWrongLang = (() => {
      const words = currentSlug.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter(w => w.length > 5);
      for (const [lang, wordSet] of Object.entries(_LANG_WORDS)) {
        if (lang === locale) continue;
        if (words.filter(w => wordSet.has(w)).length >= 2) return true;
      }
      return false;
    })();
    const shouldRegenerateLocalizedSlug =
      locale !== 'it' &&
      currentSlug &&
      baseItSlug &&
      (
        // Case 1: slug is a direct copy of the current IT slug
        currentSlug === baseItSlug ||
        // Case 2: slug contains wrong-language words (e.g. IT words in EN slug)
        // Only regenerate if the slug actually has quality issues, not just because
        // a new translation produced a slightly different result
        _slugHasWrongLang
      );
    // When shouldRegenerateLocalizedSlug fires but the derived slug is essentially the same as
    // the current one (e.g. an English job title that produces identical IT and EN slugs), skip
    // regeneration to avoid unnecessary URL churn and the appended hash suffix.
    // Pass per-job location hints so isSlugStable can never collapse two
    // distinct city openings (e.g. Lidl in Cadenazzo vs Locarno) into the
    // same slug even when the title-token Jaccard score exceeds 0.80.
    const _slugLocationHint = String(out.addressLocality || out.location || '');
    const willDiscardSlug =
      isLowQualityLocalizedSlug(currentSlug) ||
      (shouldRegenerateLocalizedSlug && !isSlugStable(currentSlug, derivedSlug, {
        existingLocation: _slugLocationHint,
        newLocation: _slugLocationHint,
      }));
    // Save old locale slug before discarding so the build plugin can generate bridge/redirect
    // pages for previously-indexed locale URLs (prevents SEO 404s on locale-specific paths).
    // FRO-prev-slug-attribution (2026-05-20): write to previousSlugsByLocale so the
    // bridge plugin emits under the correct locale prefix; flat-array-only write was
    // leaving entries unattributed and cleanPreviousSlugsPerLocale was stripping
    // cross-locale matches (e.g. EN slug equal to new DE active slug → IT history lost).
    if (willDiscardSlug && currentSlug) {
      addPreviousSlugForLocale(out, locale, currentSlug, 20, 'ensureLocaleFields/willDiscardSlug');
      recordSlugMutation({
        jobId: out.id,
        locale,
        slug: currentSlug,
        action: 'capture',
        source: 'shared-jobs-crawler.ensureLocaleFields/willDiscardSlug',
        reason: _slugHasWrongLang ? 'wrong-lang' : (isLowQualityLocalizedSlug(currentSlug) ? 'low-quality' : 'regen'),
      });
    }
    const cleanCurrentSlug = willDiscardSlug ? '' : currentSlug;
    // Append stable fingerprint hash to new slugs for URL-identified jobs
    const localizedSlug =
      cleanCurrentSlug ||
      (derivedSlug && hashSuffix ? `${derivedSlug}-${hashSuffix}` : derivedSlug);
    if (localizedSlug) slugByLocale[locale] = localizedSlug;
  }
  out.slugByLocale = slugByLocale;
  const currentMainSlug = normalizeSpace(out.slug || '');
  if ((!currentMainSlug || isLowQualityLocalizedSlug(currentMainSlug)) && normalizeSpace(slugByLocale.it || '')) {
    out.slug = normalizeSpace(slugByLocale.it);
  }

  // Post-processing quality gate: flag if any locale has wrong-language content.
  // When wrong-language content is detected, CLEAR the affected locale so that the
  // next AI translation attempt starts with a blank slate instead of being confused
  // by the corrupted previous translation (e.g. IT words in a DE title).
  {
    const srcLang = out.sourceLang || 'it';
    const srcTitle = normalizeSpace(out.titleByLocale?.[srcLang] || '');
    const gateCompany = out.company || '';
    const gateLocation = out.addressLocality || out.location || '';
    for (const locale of LOCALES) {
      // Every branch below only ever writes `true`, so once the job is queued
      // there is nothing left to decide — and, crucially, no rollout budget is
      // spent on a job the repair queue already holds. This is what keeps the
      // re-flagging idempotent: a second pass over an already-flagged job is a
      // no-op, byte for byte.
      if (out.needsRetranslation) break;
      if (locale === srcLang) continue; // Never clear or flag the source language
      const title = normalizeSpace(out.titleByLocale?.[locale] || '');
      if (!title) continue;
      // Glued-together words (e.g. "Direttoredifiliale") are a static defect
      // that never self-corrects: once a broken title lands, the exact-copy
      // and unchanged-slot checks below both continue to see it as "already
      // translated" on every subsequent run, so this check runs unconditionally
      // (not gated on the unchanged-slot skip further down) to keep flagging it.
      if (hasConcatenatedWords(title, locale)) {
        out.needsRetranslation = true;
        continue;
      }
      // Locale slot unchanged by this call (existing, already-vetted content).
      const slotChanged = title !== normalizeSpace(_preTitleByLocale[locale] || '');
      // S3 (2026-08-10): the exact-copy branch used to be suppressed whenever
      // any OTHER non-source locale differed from the source. That cross-locale
      // rule is the reported bug — a DE-source job whose EN and FR slots
      // translated had its untranslated IT slot excused on the evidence of EN
      // and FR. The verdict is now taken per slot by the shared primitive, which
      // makes the escape hatch unnecessary by construction: whether THIS slot is
      // still in the source language does not depend on the neighbouring slots.
      //
      // Rollout: a slot this call wrote is always judged (new content, low
      // volume — the pre-existing behaviour for changed slots). A slot the call
      // left byte-identical is the frozen backlog (D5), and judging all of it at
      // once would enqueue ~24k slots against a ~100 jobs/run drain, so it is
      // swept under _claimTitleRequeueBudget(). Jobs the pipeline already gave up
      // on (`localeMismatchSuppressed`, set after MAX_RETRANSLATION_ATTEMPTS in
      // relocalize-pending-jobs.mjs) are never re-queued: re-raising the flag
      // there would defeat the give-up and burn one attempt per run forever,
      // which is the same flapping shape as the EOC/migros mass re-flag incident.
      const mayJudgeStoredSlot = !out.localeMismatchSuppressed;
      if (slotChanged || mayJudgeStoredSlot) {
        const verdict = titleLooksUntranslated({
          title,
          sourceTitle: srcTitle,
          sourceLang: srcLang,
          targetLocale: locale,
          company: gateCompany,
          location: gateLocation,
        });
        if (verdict.untranslated && (slotChanged || _claimTitleRequeueBudget())) {
          out.needsRetranslation = true;
          continue;
        }
      }
      if (!slotChanged) continue;
      // Wrong-language words in title — only flag if genuinely contaminated,
      // don't clear locale content (clearing destroys good descriptions for a title issue).
      // Still gated on the unchanged-slot skip: `_hasWrongLang` is the cognate
      // word-list heuristic behind the EOC/migros mass re-flag incident (76%/51%
      // of already-translated jobs re-flagged every run), and it has never been
      // measured. The primitive above is (96.6% precision / 95.0% recall), which
      // is why it — and only it — is allowed to look at stored titles.
      if (_hasWrongLang(title, locale)) {
        out.needsRetranslation = true;
        continue;
      }
    }
  }

  return out;
}

// FRO-234: Localization pipeline — thin wrappers delegating to DCC
// The actual implementations are in dedicated-crawler-common.mjs.
// SJC builds a context object with its internal state and passes it to DCC.

/** Build the localization context object for DCC functions. */
function _buildLocalizationCtx() {
  return {
    LOCALES,
    FORCE_LOCALIZE_COMPANY_KEYS: getForceLocalizeCompanyKeys(),
    FORCE_LOCALIZE_WORKDAY: getForceLocalizeWorkday(),
    LOCALIZE_ONLY_COMPANY_KEYS,
    AI_CACHE_RAW_SENTINEL,
    cleanDescription,
    stripCodeFenceJson,
    normalizeSpace,
    normalizeHost,
    hostOf,
    normalizeCompanyKey,
    isLowQualityLocalizedTitle,
    mergeRequirements,
    callLLM,
    isAnyModelAvailable,
    extractRequirements,
    structureJobDescription,
    htmlToStructuredText,
    aiEnrichThinDescription,
    buildAiCacheKey,
    getCachedAiResponse,
    setCachedAiResponse,
    deleteCachedAiResponse,
    getAiLocalizationCalls: () => aiLocalizationCalls,
    incrAiLocalizationCalls: () => { aiLocalizationCalls += 1; },
    getDeeplFallbackToLlm: () => deeplFallbackToLlm,
    incrDeeplFallbackToLlm: () => { deeplFallbackToLlm += 1; },
  };
}

function shouldForceLocalizationForJob(job = {}) {
  return _shouldForceLocalizationForJobDCC(job, _buildLocalizationCtx());
}

function isLocalizationAllowedForJob(job = {}) {
  return _isLocalizationAllowedForJobDCC(job, _buildLocalizationCtx());
}

async function aiTranslateJobDescription({ description, locale, sourceLang = 'en', minChars = 120 }) {
  return _aiTranslateJobDescriptionDCC({ description, locale, sourceLang, minChars }, _buildLocalizationCtx());
}

async function aiLocalizeJobContent({ title, company, location, description, requirements, sourceLang, maxLocales = 4, minChars = 120 }) {
  return _aiLocalizeJobContentDCC({ title, company, location, description, requirements, sourceLang, maxLocales, minChars }, _buildLocalizationCtx());
}

async function aiTranslateJobTitle({ title, locale, sourceLang = 'en' }) {
  return _aiTranslateJobTitleDCC({ title, locale, sourceLang }, _buildLocalizationCtx());
}

async function enrichJobLocales(job, crawlerConfig) {
  return _enrichJobLocalesDCC(job, crawlerConfig, _buildLocalizationCtx());
}

function hasUntranslatedLocaleDescriptions(job = {}) {
  return _hasUntranslatedLocaleDescriptionsDCC(job, _buildLocalizationCtx());
}

function hasUntranslatedLocaleTitles(job = {}) {
  return _hasUntranslatedLocaleTitlesDCC(job, _buildLocalizationCtx());
}

async function enrichJobLocalesWithRetry(job, crawlerConfig, maxAttempts = 3) {
  return _enrichJobLocalesWithRetryDCC(job, crawlerConfig, _buildLocalizationCtx(), maxAttempts);
}

// Guards the crude "label: <up to N chars>" regex fallbacks in
// extractCompanyFromText / extractLocationFromText (#4587). Those regexes
// match a label keyword (e.g. "hiring organization", "Sede di lavoro")
// ANYWHERE in the page's stripped plain text, with no guarantee the label
// actually introduces a short field value — on templated ATS pages the same
// keyword can appear inside ordinary marketing/description prose (e.g. a
// "Company Description" paragraph, or an "Arbeitsort" mention buried in a
// sentence), and the regex then grabs a chunk of that prose as if it were
// the company name or location. Real company names / city names are short
// and don't read like sentences, so reject long, multi-clause captures
// instead of trusting them blindly.
export function looksLikeShortLabelValue(text = '') {
  const v = String(text || '').trim();
  if (!v) return false;
  if (v.length > 60) return false;
  if (v.split(/\s+/).filter(Boolean).length > 8) return false;
  // Prose has internal sentence punctuation; short labels/names don't.
  if (/[.,;][^.,;]/.test(v)) return false;
  // A mid-sentence fragment (the regex matched a label keyword that turned
  // out to be embedded inside prose, not introducing a field) almost always
  // starts on a lowercase word, a bare digit-led clause, or punctuation —
  // real company/location names start with a capital letter, or a number
  // immediately followed by a capitalized word (e.g. a street/postal number:
  // "8001 Zürich").
  const first = v.match(/^([\p{L}\p{N}][\p{L}]*)/u)?.[1] || '';
  if (!first) return false;
  const isCapitalized = /^\p{Lu}/u.test(first);
  const isDigitLedProperNoun = /^\d/.test(first) && /^\d+\s+\p{Lu}/u.test(v);
  if (!isCapitalized && !isDigitLedProperNoun) return false;
  return true;
}

export function extractCompanyFromText(html = '', fallback = '') {
  const jd = bestJobPostingNodeFromHtml(html);
  const fromLd = normalizeSpace(jd?.hiringOrganization?.name || jd?.hiringOrganization || '');
  if (fromLd && !isLikelyGenericCareerTitle(fromLd)) return fromLd;

  const hiringOrgName = normalizeSpace(
    decodeNumericEntities(
      decodeHtmlEntities(
        String(html).match(/"hiringOrganization"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]{2,180})"/i)?.[1] || ''
      )
    )
  );
  if (hiringOrgName && !isLikelyGenericCareerTitle(hiringOrgName)) return hiringOrgName;

  const companyAddressBlock = String(html).match(/f-n-field-job-ca[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const firstCompanyLine = normalizeSpace(
    decodeNumericEntities(stripHtml(companyAddressBlock.split(/<br\s*\/?>/i)[0] || ''))
  );
  if (firstCompanyLine && !isLikelyGenericCareerTitle(firstCompanyLine)) return firstCompanyLine;

  const plain = stripHtml(html);
  const labelMatches = [
    /(?:Firmenbeschreibung|Company Description|Descrizione azienda|Description de l'entreprise)\s*:?\s*([^\n]{2,140})/i,
    /(?:hiring organization|organizzazione|organisation)\s*:?\s*([^\n]{2,140})/i,
  ];
  for (const re of labelMatches) {
    const m = plain.match(re)?.[1];
    const v = normalizeSpace(m);
    if (v && !isLikelyGenericCareerTitle(v) && looksLikeShortLabelValue(v)) return v;
  }

  const siteName = normalizeSpace(extractMetaContent(html, 'property', 'og:site_name') || '');
  if (siteName && !isLikelyGenericCareerTitle(siteName)) return siteName;

  return normalizeSpace(fallback);
}

export function extractLocationFromText(html = '', fallback = '') {
  const jd = bestJobPostingNodeFromHtml(html);
  const ldLoc = normalizeSpace(
    jd?.jobLocation?.address?.addressLocality ||
    jd?.jobLocation?.address?.addressRegion ||
    jd?.jobLocation?.address?.streetAddress ||
    ''
  );
  if (ldLoc) return ldLoc;

  const fromWorkday = extractWorkdayLocation(html);
  if (fromWorkday && fromWorkday.length <= 120) return fromWorkday;

  const clerDetailLoc = normalizeSpace(
    stripHtml(
      String(html).match(
        /JobDetail__item-slot[^>]*>\s*(?:Sede di lavoro|Workplace|Lieu de travail|Arbeitsort)\s*<\/span>\s*<span[^>]*JobDetail__item-slot[^>]*>([\s\S]*?)<\/span>/i
      )?.[1] || ''
    )
  );
  if (clerDetailLoc) return clerDetailLoc;

  const companyAddressBlock = String(html).match(/f-n-field-job-ca[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  if (companyAddressBlock) {
    const rawLines = companyAddressBlock
      .split(/<br\s*\/?>/i)
      .map((line) => normalizeSpace(decodeNumericEntities(stripHtml(line))))
      .filter(Boolean);
    if (rawLines.length > 1) {
      const addressLine = rawLines.slice(1).join(' · ');
      if (addressLine) return addressLine;
    }
  }

  const plain = stripHtml(html);
  const labelMatch = plain.match(
    /(?:Arbeitsort|Lieu de travail|Workplace|Sede di lavoro|Work location)\s*:?\s*([^\n]{3,180})/i
  )?.[1];
  const labelLoc = sanitizeLocation(normalizeSpace(labelMatch || ''));
  // #4587: sanitizeLocation trims known noise-phrase boundaries but doesn't
  // reject text that never matched one — a label keyword found mid-prose
  // (see looksLikeShortLabelValue above extractCompanyFromText) can still
  // survive as a sentence fragment. Apply the same short-value sanity check
  // before trusting it as the job's location.
  if (labelLoc && looksLikeShortLabelValue(labelLoc)) return labelLoc;

  return normalizeSpace(fallback);
}

/**
 * Post-process a raw location string:
 * - Truncate at known noise boundaries
 * - Cap at a reasonable length
 * - Return only the meaningful city/address fragment
 */
const LOCATION_NOISE_BOUNDARIES = [
  // IT
  /\bLa posizione consente\b.*/i,
  /\bAspettiamo\b.*/i,
  /\bNon abbiamo bisogno\b.*/i,
  /\bTempo pieno o parziale\b.*/i,
  /\bInformazioni supplementari\b.*/i,
  // EN
  /\bThe position allows\b.*/i,
  /\bWe look forward\b.*/i,
  /\bFull-time or part-time\b.*/i,
  /\bAdditional [Ii]nformation\b.*/i,
  // DE
  /\bDie Position ermöglicht\b.*/i,
  /\bWir freuen uns\b.*/i,
  /\bVollzeit oder Teilzeit\b.*/i,
  /\bZusätzliche Informationen\b.*/i,
  // FR
  /\bLe poste permet\b.*/i,
  /\bNous attendons\b.*/i,
  /\bTemps plein ou partiel\b.*/i,
  /\bInformations supplémentaires\b.*/i,
  // ATS metadata fields (Cler / generic career portals)
  /\bTasso di occupazione\b.*/i,
  /\bEntrata in servizio\b.*/i,
  /\bBeschäftigungsgrad\b.*/i,
  /\bStellenantritt\b.*/i,
  /\bTaux d'occupation\b.*/i,
  /\bEntrée en fonction\b.*/i,
  /\bEmployment rate\b.*/i,
  /\bStart date\b.*/i,
  /\bPensum\b.*/i,
  // Generic noise
  /\bRemote work\b.*/i,
  /\bTelelavoro\b.*/i,
];

function sanitizeLocation(loc) {
  if (!loc) return '';
  let clean = loc;
  for (const re of LOCATION_NOISE_BOUNDARIES) {
    clean = clean.replace(re, '').trim();
  }
  if (clean.length > 80) {
    const sentenceCut = clean.match(/^(.{3,80}?)(?:\.|,|;|\s{2,}|\s-\s)/)?.[1];
    if (sentenceCut) clean = sentenceCut.trim();
    else clean = clean.slice(0, 80).trim();
  }
  clean = clean.replace(/[,;:\-·•|]+$/, '').trim();
  return clean;
}

async function fetchHtml(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) return '';
  return await res.text();
}

function parseCompanySourcesFromTsx(tsxSource) {
  const objects = tsxSource.match(/\{[^{}]*name:\s*'[^']+'[^{}]*\}/g) || [];
  const parsed = [];
  for (const raw of objects) {
    const name = raw.match(/name:\s*'([^']+)'/)?.[1];
    const website = raw.match(/website:\s*'([^']+)'/)?.[1];
    const city = raw.match(/city:\s*'([^']+)'/)?.[1] || 'Ticino';
    const employees = Number(raw.match(/employees:\s*(\d+)/)?.[1] || 0);
    if (!name || !website) continue;
    const url = tryUrl(website);
    if (!url) continue;
    parsed.push({ name, website: url, city, employees });
  }
  // Keep highest employee entry for duplicate domains
  return dedupeAndSortCompanies(parsed);
}

function dedupeAndSortCompanies(inputCompanies) {
  const byHost = new Map();
  for (const c of inputCompanies) {
    const host = hostOf(c.website);
    const prev = byHost.get(host);
    if (!prev || c.employees > prev.employees) byHost.set(host, c);
  }
  return [...byHost.values()]
    .sort((a, b) => b.employees - a.employees);
}

function loadExtraCompanies() {
  const raw = readJson(EXTRA_COMPANIES_PATH, []);
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const name = normalizeSpace(row.name);
    const website = tryUrl(row.website || '');
    if (!name || !website) continue;
    out.push({
      name,
      website,
      city: normalizeSpace(row.city || 'Ticino') || 'Ticino',
      employees: clampNum(row.employees, 5, 100000, 80),
      ...(row.key ? { key: normalizeSpace(row.key) } : {}),
    });
  }
  return dedupeAndSortCompanies(out);
}

function normalizeSeedMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = normalizeSpace(key).toLowerCase();
    if (!normalizedKey) continue;
    if (Array.isArray(value)) {
      const cleaned = value.map((x) => normalizeSpace(x)).filter(Boolean);
      if (cleaned.length > 0) out[normalizedKey] = cleaned;
      continue;
    }
    const single = normalizeSpace(value);
    if (single) out[normalizedKey] = [single];
  }
  return out;
}

const CRAWLER_USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchStatus(status) {
  return RETRYABLE_HTTP_STATUS.has(Number(status));
}

function isRetryableFetchError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('socket') ||
    msg.includes('fetch failed') ||
    msg.includes('temporarily') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout')
  );
}

function fetchRetryDelayMs(attempt) {
  const expo = FETCH_RETRY_BASE_MS * Math.max(1, 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 120);
  return Math.min(5000, expo + jitter);
}

async function fetchWithTimeout(url, { method = 'GET', headers = {}, body, userAgent } = {}) {
  const upperMethod = normalizeSpace(method || 'GET').toUpperCase();
  const canRetry = (upperMethod === 'GET' || upperMethod === 'HEAD') && !body;
  const maxAttempts = canRetry ? 1 + FETCH_RETRY_ATTEMPTS : 1;
  let lastErr = null;

  // Opt-in egress proxy for IP-blocked sources (JOBS_CRAWLER_FETCH_PROXY lists
  // the host(s) to route via Jina Reader). Default unset → no effect on any
  // other crawler. The proxied request returns the target's raw HTML, so the
  // caller and all downstream parsers are unchanged; the original `url` is still
  // what callers use for the job's canonical URL.
  let targetUrl = url;
  let proxyHeaders = {};
  let postJinaFallback = false;
  if (hostMatchesProxyList(url, process.env.JOBS_CRAWLER_FETCH_PROXY)) {
    // Route through Jina Reader, and for idempotent GET/HEAD retry on a fresh
    // Jina egress IP when the proxy lands on a WAF-flagged IP (the challenge
    // comes back HTTP 200, so the generic status-based retry below never fires).
    // Same root cause as discovery (#1363): ~1-in-5 Jina IPs are blocked by the
    // sgcaptcha IP-reputation WAF, so a single proxied fetch drops that detail
    // page → the job is parsed empty. Short-circuit so every proxied detail page
    // gets the same retry-until-clean-IP treatment as the sitemap discovery.
    // GET-only: Jina Reader always issues a GET, so a HEAD must NOT be routed here
    // (canRetry also allows HEAD) — it would silently become a GET with a full
    // body. Let HEAD fall through to the generic proxied fetch below, which keeps
    // the original method.
    if (canRetry && upperMethod === 'GET') {
      const jinaRes = await fetchViaJinaWithRetry(url, { timeoutMs: REQUEST_TIMEOUT_MS });
      if (jinaRes.ok) return jinaRes;
      // Every Jina egress IP tried was still blocked/erroring (#3797 recurrence,
      // 2026-07-07: all 4 cambiavalute.ch detail pages silently dropped this way
      // in one CI run — zero log trace, even though a plain direct fetch worked
      // fine for discovery in that SAME run and reproduced locally afterwards).
      // A degraded/rate-limited proxy pool must not be a harder failure mode than
      // no proxy at all, so fall through to the direct-fetch retry loop below
      // (targetUrl/proxyHeaders are left at their unproxied defaults — do NOT
      // route this fallback through jinaProxiedRequest, or it just re-hits the
      // same exhausted proxy path). Logged so a future recurrence is diagnosable
      // from CI output alone (previously this path was completely silent — the
      // caller's `if (!res.ok) continue` masked it entirely).
      const jinaFailReason = jinaRes.headers.get('x-jina-retry-reason') || `HTTP ${jinaRes.status}`;
      console.warn(`⚠️ Jina proxy exhausted for ${url} (${jinaFailReason}) — falling back to direct fetch.`);
      postJinaFallback = true;
    } else {
      const proxied = jinaProxiedRequest(url);
      targetUrl = proxied.url;
      proxyHeaders = proxied.headers;
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
    });
    const fetchPromise = fetch(targetUrl, {
      method: upperMethod,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent || CRAWLER_USER_AGENT,
        ...headers,
        ...proxyHeaders,
      },
      body,
    });
    try {
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      if (attempt < maxAttempts && isRetryableFetchStatus(res.status)) {
        // Cancel and drop the transient response body before retrying — cancel()
        // (vs arrayBuffer()) signals undici to reclaim the socket without reading
        // the body, so a slow/large transient body can't stall the retry loop.
        try { await res.body?.cancel(); } catch {}
        await sleep(fetchRetryDelayMs(attempt));
        continue;
      }
      if (postJinaFallback && res.ok) {
        // Direct-fetch fallback after Jina exhaustion (see above): a CI
        // datacenter IP can hit the same sgcaptcha WAF challenge Jina's blocked
        // IPs get, but on a plain HTTP 200 — no `!res.ok` signal at all. Validate
        // the body with the same detector Jina's own retry path already relies
        // on before trusting this as real content; otherwise a challenge page
        // silently gets parsed as a job page instead of the old (safe) skip.
        const probe = res.clone();
        const text = await probe.text().catch(() => '');
        const errorReason = detectJinaErrorBody(text);
        if (errorReason) {
          console.warn(`⚠️ Direct-fetch fallback for ${url} also hit a WAF challenge (${errorReason}) — treating as failed fetch.`);
          try { await res.body?.cancel(); } catch {}
          return new Response('', {
            status: 502,
            headers: { 'content-type': 'text/html', 'x-fallback-fail-reason': errorReason },
          });
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableFetchError(err)) {
        throw err;
      }
      await sleep(fetchRetryDelayMs(attempt));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastErr || new Error(`fetch failed for ${url}`);
}

function decodeSearchRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    // DuckDuckGo redirect link
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return tryUrl(decodeURIComponent(uddg));
    return parsed.toString();
  } catch {
    return '';
  }
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseDuckDuckGoHtmlLinks(html) {
  const out = [];
  // #6480: same shape — locate the anchor, then read `href` quote-balanced.
  const rx = /<a\b[^>]*>/gi;
  let m;
  while ((m = rx.exec(String(html))) !== null) {
    const tag = m[0];
    if (!/(?<![\w-])class\s*=\s*(["'])[^<]*?result__a[^<]*?\1/i.test(tag)) continue;
    const href = readAttr(tag, 'href');
    if (!href) continue;
    const decoded = decodeSearchRedirectUrl(href);
    const u = tryUrl(decoded);
    if (u) out.push(u);
  }
  return out;
}

async function searchGoogleCse(query, limit = 8) {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) return [];
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_CSE_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CSE_CX)}&q=${encodeURIComponent(query)}&num=${Math.min(10, Math.max(1, limit))}`;
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    const items = assertJsonListShape(data, { key: 'items', source: 'shared-jobs-crawler:google-cse' });
    return items
      .map((x) => tryUrl(x?.link || ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function searchDuckDuckGo(query, limit = 8) {
  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseDuckDuckGoHtmlLinks(html).slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

function parseRssLinks(xml = '') {
  const out = [];
  const rx = /<item>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<\/item>/gi;
  let m;
  while ((m = rx.exec(String(xml))) !== null) {
    const u = tryUrl(m[1]);
    if (u) out.push(u);
  }
  return out;
}

async function searchBingRss(query, limit = 8) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
    const res = await fetchWithTimeout(url, {
      headers: { Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssLinks(xml).slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

async function searchWeb(query, limit = 8) {
  const google = await searchGoogleCse(query, limit);
  if (google.length > 0) return { provider: 'google-cse', urls: google.slice(0, limit) };
  const bing = await searchBingRss(query, limit);
  if (bing.length > 0) return { provider: 'bing-rss', urls: bing.slice(0, limit) };
  const ddg = await searchDuckDuckGo(query, limit);
  return { provider: 'duckduckgo', urls: ddg.slice(0, limit) };
}

function isSearchResultUsefulForJobs(url, companyDomain) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  const host = normalizeHost(hostOf(u));
  if (!host) return false;
  if (
    COMPANY_DISCOVERY_DOMAIN_BLACKLIST.has(registrableDomain(host)) ||
    COMPANY_DISCOVERY_DOMAIN_BLACKLIST.has(host)
  ) return false;
  if (companyDomain && !(host === companyDomain || registrableDomain(host) === registrableDomain(companyDomain) || isKnownAtsHost(host))) {
    return false;
  }
  if (/\.(pdf|docx?|xlsx?|pptx?)($|\?)/i.test(u)) return false;
  return /(job|jobs|career|careers|vacanc|position|offene-stellen|stellen|emploi|lavoro|candid|workday|greenhouse|lever)/i.test(u);
}

function buildWebDiscoveryQueries(company) {
  const domain = normalizeHost(hostOf(company.website));
  const cityChunks = chunkArray(TICINO_CITIES, 8);
  const queries = [];

  for (const chunk of cityChunks) {
    const cityExpr = chunk.map((c) => `"${c}"`).join(' OR ');
    queries.push(
      `site:${domain} (${cityExpr}) (jobs OR careers OR lavoro OR stellen OR "offene stellen" OR emploi)`
    );
  }
  queries.push(
    `"${company.name}" (Ticino OR "Canton Ticino" OR Lugano OR Bellinzona) (jobs OR careers OR lavoro OR stellen OR emploi)`
  );

  return queries.slice(0, WEB_DISCOVERY_MAX_QUERIES_PER_COMPANY);
}

async function discoverCareerUrlsFromWebSearch(company, crawlerConfig) {
  if (!crawlerConfig?.webDiscoveryEnabled) {
    return { urls: [], providers: [], queries: 0, hits: 0 };
  }

  const domain = normalizeHost(hostOf(company.website));
  const providers = new Set();
  const out = new Set();
  let queries = 0;
  let hits = 0;

  for (const query of buildWebDiscoveryQueries(company)) {
    queries += 1;
    // eslint-disable-next-line no-await-in-loop
    const { provider, urls } = await searchWeb(query, WEB_DISCOVERY_RESULTS_PER_QUERY);
    providers.add(provider);
    for (const url of urls) {
      if (!isSearchResultUsefulForJobs(url, domain)) continue;
      out.add(url);
      hits += 1;
    }
  }

  return { urls: [...out], providers: [...providers], queries, hits };
}

async function discoverCareerUrlsWithBrowserFallback(companyWebsite) {
  if (!BROWSER_FALLBACK_ENABLED) {
    return { urls: [], reason: 'disabled' };
  }
  const chromium = await getPlaywrightChromium();
  if (!chromium) {
    return { urls: [], reason: 'playwright_unavailable' };
  }

  let browser = null;
  const out = new Set();
  try {
    browser = await launchChromium({ headless: true });
    const page = await browser.newPage({ userAgent: CRAWLER_USER_AGENT });
    await page.goto(companyWebsite, { waitUntil: 'domcontentloaded', timeout: BROWSER_FALLBACK_TIMEOUT_MS });
    if (BROWSER_FALLBACK_WAIT_MS > 0) {
      await page.waitForTimeout(BROWSER_FALLBACK_WAIT_MS);
    }
    const hrefs = await page.$$eval('a[href]', (nodes) =>
      nodes.map((node) => String(node.getAttribute('href') || '')).filter(Boolean)
    );
    for (const href of hrefs) {
      const absolute = tryUrl(href, companyWebsite);
      if (!absolute) continue;
      if (CAREER_DISCOVERY_HINT_RE.test(absolute) || isKnownAtsHost(hostOf(absolute)) || isLikelyJobDetailUrl(absolute)) {
        out.add(absolute);
      }
    }
    return { urls: [...out].slice(0, BROWSER_FALLBACK_MAX_LINKS), reason: 'ok' };
  } catch (err) {
    return {
      urls: [],
      reason: normalizeSpace(String(err?.message || 'browser_fallback_failed')).slice(0, 160) || 'browser_fallback_failed',
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

function quickJobPageSignals(html = '', pageUrl = '') {
  const plain = stripHtml(html).toLowerCase();
  const title = extractH1FromHtml(html) || extractTitleFromHtml(html);
  const hasJsonLdJob = extractJobPostingNodes(extractJsonLdBlocks(html)).length > 0;
  const positive = [
    /apply now|apply here|candidati|bewerben|postuler|job posting|stellenbeschreibung|beschreibung|requirements|requisiti|anforderungen/i.test(plain),
    /(job|jobs|career|careers|vacanc|position|offene stellen|emploi|lavoro)/i.test(`${pageUrl} ${title}`),
    plain.length > 700,
  ].filter(Boolean).length;
  const negative = [
    /cookie|privacy policy|all rights reserved|investors|media relations|press release/i.test(plain),
    /\/news\/|\/blog\/|\/article\//i.test(pageUrl),
  ].filter(Boolean).length;
  return { hasJsonLdJob, positive, negative, title };
}

async function aiValidateJobDetailPage({ html, pageUrl, companyName }) {
  if (!crawlerConfigGlobal?.aiPageValidationEnabled) return { isJob: true, confidence: 0.5, reason: 'disabled' };
  if (!isAnyModelAvailable()) return { isJob: true, confidence: 0.5, reason: 'no_llm_keys' };

  const text = stripHtml(html).slice(0, 5000);
  // Content-hash cache (persisted in data/jobs-ai-cache.json across runs): a page
  // whose visible text is unchanged returns the prior verdict without spending an
  // LLM call OR a per-run budget slot. This was the only AI call site in this file
  // without a cache; a re-crawled ambiguous page used to re-classify every run.
  //
  // The key also includes the model that would currently serve the request
  // (#3080): without it, a verdict produced by a fallback model during a
  // primary-model outage freezes under a model-agnostic key and gets silently
  // reused even after the primary model recovers — permanently baking in a
  // fallback-model classification (e.g. a false "not a job page") instead of
  // re-checking with the primary model once it's available again.
  const preferredModel = getPreferredModel();
  const cacheKey = buildAiCacheKey('validate-page-v1', [pageUrl, text, preferredModel || 'no-model-available']);
  const cachedVerdict = getCachedAiResponse(cacheKey);
  if (cachedVerdict) return cachedVerdict;

  if (aiPageValidationCalls >= (crawlerConfigGlobal?.aiPageValidationMaxPagesPerRun || 0)) {
    return { isJob: true, confidence: 0.5, reason: 'max_pages_reached' };
  }
  aiPageValidationCalls += 1;

  const prompt = [
    'Determine whether this page is a REAL SINGLE JOB DETAIL page (not generic careers listing/news/about).',
    'Return JSON only: {"isJobDetail": boolean, "confidence": number, "reason": string}.',
    'Rules:',
    '- TRUE only if there is a concrete role title + responsibilities/requirements + application context.',
    '- FALSE for generic company career pages, category listings, press/news, about pages.',
    `Company hint: ${companyName}`,
    `URL: ${pageUrl}`,
    `TEXT: ${text}`,
  ].join('\n');

  try {
    const messages = [{ role: 'user', content: prompt }];
    const modelUsedRef = { model: null };
    const raw = await callLLM(messages, {
      temperature: 0,
      maxTokens: 400,
      jsonMode: true,
      modelUsedRef,
    });
    const parsed = JSON.parse(stripCodeFenceJson(raw));
    const verdict = {
      isJob: Boolean(parsed?.isJobDetail),
      confidence: Number(parsed?.confidence || 0),
      reason: normalizeSpace(parsed?.reason || 'ai_classification'),
    };
    // Only successful classifications are cached — a failed-open default must be
    // retried next run, not frozen. Store under the model that ACTUALLY served
    // this call — it can differ from the pre-call `preferredModel` peek if that
    // model failed mid-cascade and callLLM fell back further down the chain —
    // so the persisted key always matches the model whose verdict it holds.
    const servedModel = modelUsedRef.model || preferredModel || 'no-model-available';
    const finalCacheKey = servedModel === preferredModel
      ? cacheKey
      : buildAiCacheKey('validate-page-v1', [pageUrl, text, servedModel]);
    setCachedAiResponse(finalCacheKey, verdict);
    return verdict;
  } catch {
    return { isJob: true, confidence: 0.5, reason: 'ai_failed_open' };
  }
}

let crawlerConfigGlobal = null;

function extractJsonLdBlocks(html) {
  const blocks = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      blocks.push(parsed);
    } catch {
      // Retry on partially escaped JSON-LD often found in CMS pages.
      try {
        const decoded = decodeNumericEntities(decodeHtmlEntities(raw));
        const parsedDecoded = JSON.parse(decoded);
        blocks.push(parsedDecoded);
      } catch {
        // Ignore malformed blocks
      }
    }
  }
  return blocks;
}

function extractJobPostingNodes(node) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n !== 'object') return;
    if (n['@type'] === 'JobPosting') out.push(n);
    if (Array.isArray(n['@graph'])) n['@graph'].forEach(walk);
    for (const value of Object.values(n)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(node);
  return out;
}

function extractWorkdayListingUrls(html, baseUrl) {
  const out = new Set();
  const rx = /https?:\/\/[a-z0-9.-]*myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?[a-z0-9_-]+(?:\?[^\s"'<]*)?/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const normalized = tryUrl(m[0], baseUrl);
    if (!normalized) continue;
    out.add(normalized);
  }
  return [...out];
}

function parseWorkdaySource(listingUrl) {
  let u;
  try {
    u = new URL(listingUrl);
  } catch {
    return null;
  }
  if (!u.hostname.includes('myworkdayjobs.com')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let site = parts[0] || '';
  if (/^[a-z]{2}-[a-z]{2}$/i.test(site) && parts[1]) {
    site = parts[1];
  }
  if (!site) return null;
  const hostHead = u.hostname.split('.')[0];
  const tenant = hostHead || site;
  const endpoint = `${u.origin}/wday/cxs/${tenant}/${site}/jobs`;
  const appliedFacets = {};
  for (const [k, v] of u.searchParams.entries()) {
    const key = normalizeSpace(k);
    const value = normalizeSpace(v);
    if (!key || !value) continue;
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    const values = value.split(',').map((x) => normalizeSpace(x)).filter(Boolean);
    if (values.length > 0) appliedFacets[key] = values;
  }
  return { listingUrl, tenant, site, endpoint, origin: u.origin, appliedFacets };
}

function extractGreenhouseListingUrls(html, baseUrl) {
  const out = new Set();
  const rx = /https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/[a-z0-9_-]+(?:\/[a-z0-9_/?=&-]*)?/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const normalized = tryUrl(m[0], baseUrl);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function parseGreenhouseSource(listingUrl) {
  let u;
  try {
    u = new URL(listingUrl);
  } catch {
    return null;
  }
  if (!u.hostname.includes('greenhouse.io')) return null;
  const board = u.pathname.split('/').filter(Boolean)[0];
  if (!board) return null;
  return {
    listingUrl,
    board,
    endpoint: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`,
  };
}

function extractLeverListingUrls(html, baseUrl) {
  const out = new Set();
  const rx = /https?:\/\/jobs\.lever\.co\/[a-z0-9_-]+(?:\/[a-z0-9_/?=&-]*)?/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const normalized = tryUrl(m[0], baseUrl);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function parseLeverSource(listingUrl) {
  let u;
  try {
    u = new URL(listingUrl);
  } catch {
    return null;
  }
  if (!u.hostname.includes('jobs.lever.co')) return null;
  const company = u.pathname.split('/').filter(Boolean)[0];
  if (!company) return null;
  return {
    listingUrl,
    company,
    endpoint: `https://api.lever.co/v0/postings/${company}?mode=json`,
  };
}

function extractSmartRecruitersListingUrls(html, baseUrl) {
  const out = new Set();
  const rx = /https?:\/\/careers\.smartrecruiters\.com\/[a-z0-9_-]+(?:\/[a-z0-9_/?=&-]*)?/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const normalized = tryUrl(m[0], baseUrl);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function absoluteLinks(html, baseUrl) {
  const links = new Set();
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const href = readAttr(m[1], 'href').trim();
    if (!href || href.startsWith('#')) continue;
    const url = tryUrl(href, baseUrl);
    if (url) links.add(url);
  }
  return [...links];
}

// FRO-231: HTML entity decoders → moved to top of file (FRO-359)

/**
 * Strip locale fields that are just copies of the source text (not translated).
 * Better to have an empty locale (frontend falls back to base description)
 * than to pretend untranslated content is localized.
 */
function stripCopyPasteLocales(job) {
  if (!job || typeof job !== 'object') return job;
  const out = { ...job };
  const baseDesc = normalizeSpace(out.description || '');
  if (!baseDesc || baseDesc.length < 30) return out;

  const sourceLang = detectLang(baseDesc, 'en');

  // Strip identical descriptions
  if (out.descriptionByLocale && typeof out.descriptionByLocale === 'object') {
    const dbl = { ...out.descriptionByLocale };
    const sourceText = normalizeSpace(dbl[sourceLang] || baseDesc).toLowerCase();
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      const localized = normalizeSpace(dbl[locale] || '');
      if (localized && localized.toLowerCase() === sourceText) {
        dbl[locale] = '';
      }
    }
    out.descriptionByLocale = dbl;
  }

  // Strip identical requirements
  if (out.requirementsByLocale && typeof out.requirementsByLocale === 'object') {
    const rbl = { ...out.requirementsByLocale };
    const sourceReqs = JSON.stringify(rbl[sourceLang] || []);
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      if (JSON.stringify(rbl[locale] || []) === sourceReqs && sourceReqs !== '[]') {
        rbl[locale] = [];
      }
    }
    out.requirementsByLocale = rbl;
  }

  // Strip identical titles (only for longer titles — short titles are often language-neutral)
  if (out.titleByLocale && typeof out.titleByLocale === 'object') {
    const tbl = { ...out.titleByLocale };
    const baseTitle = normalizeSpace(out.title || '');
    const sourceTitleNorm = normalizeSpace(tbl[sourceLang] || baseTitle).toLowerCase();
    if (sourceTitleNorm.length > 25) {
      for (const locale of LOCALES) {
        if (locale === sourceLang) continue;
        const localized = normalizeSpace(tbl[locale] || '');
        if (localized && localized.toLowerCase() === sourceTitleNorm) {
          tbl[locale] = '';
        }
      }
      out.titleByLocale = tbl;
    }
  }

  return out;
}

/**
 * Recursively decode HTML entities in all string fields of a job object.
 * Applied as final pass before writing JSON to prevent &amp; / &#34; / etc.
 * leaking from ATS HTML into user-visible text.
 */
function sanitizeJobStrings(job) {
  if (!job || typeof job !== 'object') return job;
  const decode = (s) => decodeNumericEntities(decodeHtmlEntities(s));
  const out = Array.isArray(job) ? [...job] : { ...job };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v === 'string') {
      out[key] = decode(v);
    } else if (Array.isArray(v)) {
      out[key] = v.map((item) =>
        typeof item === 'string' ? decode(item) : sanitizeJobStrings(item)
      );
    } else if (v && typeof v === 'object') {
      out[key] = sanitizeJobStrings(v);
    }
  }
  return out;
}

function stripCrawlerInternalFields(job) {
  if (!job || typeof job !== 'object') return job;
  const out = { ...job };
  // _targetScope is intentionally preserved: adapter-declared seed meta
  // (canton, location) is needed across runs so that merge exclusion
  // correctly recognises non-standard detail URLs (e.g. SUPSI /bando26_*).
  return out;
}

function extractJobTeaserApiUrls(html, baseUrl) {
  const out = new Set();
  const re = /data-job-teaser-listing-options=(['"])([\s\S]*?)\1/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const raw = decodeHtmlEntities(m[2] || '');
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      const apiUrl = normalizeSpace(obj?.apiUrl || '');
      const full = tryUrl(apiUrl, baseUrl);
      if (full && /\/api\/jobssearch\/search/i.test(full)) out.add(full);
    } catch {
      // ignore malformed inline options
    }
  }
  return [...out];
}

function parseDdMmYyyy(raw = '') {
  const m = String(raw).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return dateOnly(Date.now());
  const d = Number(m[1]);
  const mm = Number(m[2]);
  const y = Number(m[3]);
  const iso = new Date(Date.UTC(y, mm - 1, d));
  // Round-trip: reject calendar-impossible dates (31.04, 31.02) silently
  // overflowed by Date.UTC instead of trusting a misparsed postedDate.
  if (iso.getUTCDate() !== d || iso.getUTCMonth() !== mm - 1) return dateOnly(Date.now());
  return iso.toISOString().slice(0, 10);
}

function inferTicinoCityFromText(text = '', fallback = 'Ticino') {
  const t = String(text || '').toLowerCase();
  const cities = ['lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso', 'manno', 'stabio', 'biasca', 'castione'];
  for (const c of cities) {
    if (t.includes(c)) return c.charAt(0).toUpperCase() + c.slice(1);
  }
  return fallback;
}

function extractGenericAtsListingUrls(html, baseUrl) {
  const out = new Set();
  const links = absoluteLinks(html, baseUrl);
  for (const link of links) {
    const host = hostOf(link);
    if (!isKnownAtsHost(host)) continue;
    if (/(job|jobs|career|careers|vacanc|position|offerta|lavor|stellen|emploi|candid)/i.test(link)) {
      out.add(link);
      continue;
    }
    if (/teamtailor\.com$/i.test(host) || /jobs\.personio\./i.test(host)) {
      out.add(link);
    }
  }
  return [...out];
}

function extractSitemapUrls(xml) {
  const out = [];
  const rx = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const u = tryUrl(m[1]);
    if (u) out.push(u);
  }
  return out;
}

async function extractSitemapUrlsRobust(xml = '') {
  const fallback = extractSitemapUrls(xml);
  const parserModule = await getFastXmlParserModule();
  if (!parserModule?.XMLParser) return fallback;
  try {
    const parser = new parserModule.XMLParser({
      ignoreAttributes: true,
      trimValues: true,
      parseTagValue: false,
      processEntities: true,
    });
    const parsed = parser.parse(xml);
    const out = [];
    const collectLocs = (nodes) => {
      if (!nodes) return;
      const arr = Array.isArray(nodes) ? nodes : [nodes];
      for (const node of arr) {
        const loc = tryUrl(normalizeSpace(node?.loc || ''));
        if (loc) out.push(loc);
      }
    };
    collectLocs(parsed?.urlset?.url);
    collectLocs(parsed?.sitemapindex?.sitemap);
    if (out.length > 0) return out;
  } catch {
    // fallback below
  }
  return fallback;
}

async function discoverSitemapUrlsFromRobots(companyWebsite) {
  const out = new Set();
  const robotsUrl = tryUrl('/robots.txt', companyWebsite);
  if (!robotsUrl) return out;
  try {
    const res = await fetchWithTimeout(robotsUrl, { headers: { Accept: 'text/plain,*/*' } });
    if (!res.ok) return out;
    const body = await res.text();
    for (const line of body.split(/\r?\n/)) {
      const trimmed = normalizeSpace(line);
      if (!/^sitemap\s*:/i.test(trimmed)) continue;
      const rawUrl = trimmed.replace(/^sitemap\s*:/i, '').trim();
      const sitemapUrl = tryUrl(rawUrl, companyWebsite);
      if (sitemapUrl) out.add(sitemapUrl);
    }
  } catch {
    // ignore robots.txt failures
  }
  return out;
}

async function discoverCareerUrlsFromSitemap(companyWebsite) {
  const out = new Set();
  const root = tryUrl('/', companyWebsite);
  if (!root) return out;
  const queue = [];
  const seenSitemaps = new Set();
  const enqueueSitemap = (value) => {
    const sitemapUrl = tryUrl(value, root);
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) return;
    seenSitemaps.add(sitemapUrl);
    queue.push(sitemapUrl);
  };

  enqueueSitemap('sitemap.xml');
  enqueueSitemap('sitemap_index.xml');
  const robotsSitemaps = await discoverSitemapUrlsFromRobots(root);
  for (const url of robotsSitemaps) enqueueSitemap(url);

  let fetchedSitemaps = 0;
  while (queue.length > 0 && fetchedSitemaps < SITEMAP_MAX_FETCHES_PER_COMPANY) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl) continue;
    fetchedSitemaps += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchWithTimeout(sitemapUrl, { headers: { Accept: 'application/xml,text/xml,*/*' } });
      if (!res.ok) continue;
      // eslint-disable-next-line no-await-in-loop
      const xml = await res.text();
      // eslint-disable-next-line no-await-in-loop
      const locs = (await extractSitemapUrlsRobust(xml)).slice(0, SITEMAP_MAX_URLS_PER_FILE);
      for (const loc of locs) {
        if (/\.xml(\?|$)/i.test(loc)) {
          enqueueSitemap(loc);
          continue;
        }
        const host = hostOf(loc);
        if (!(sameHost(loc, companyWebsite) || isKnownAtsHost(host))) continue;
        if (CAREER_DISCOVERY_HINT_RE.test(loc)) out.add(loc);
      }
    } catch {
      // ignore sitemap discovery failure
    }
  }
  return out;
}

function parseSmartRecruitersSource(listingUrl) {
  let u;
  try {
    u = new URL(listingUrl);
  } catch {
    return null;
  }
  if (!u.hostname.includes('smartrecruiters.com')) return null;
  const company = u.pathname.split('/').filter(Boolean)[0];
  if (!company) return null;
  return {
    listingUrl,
    company,
    endpoint: `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100`,
  };
}

function workdayPostedDateToIso(postedOnRaw) {
  const raw = normalizeSpace(postedOnRaw).toLowerCase();
  if (!raw) return dateOnly(Date.now());
  if (raw.includes('today') || raw.includes('oggi') || raw.includes('aujourd')) return dateOnly(Date.now());
  if (raw.includes('yesterday') || raw.includes('ieri') || raw.includes('hier')) return dateOnly(Date.now() - 86400000);
  const days = Number(raw.match(/(\d+)\s+day/)?.[1] || raw.match(/(\d+)\s+giorn/)?.[1] || raw.match(/(\d+)\s+jour/)?.[1]);
  if (Number.isFinite(days) && days >= 0) return dateOnly(Date.now() - days * 86400000);
  const weeks = Number(raw.match(/(\d+)\s+week/)?.[1] || raw.match(/(\d+)\s+settiman/)?.[1] || raw.match(/(\d+)\s+semain/)?.[1]);
  if (Number.isFinite(weeks) && weeks >= 0) return dateOnly(Date.now() - weeks * 7 * 86400000);
  return dateOnly(Date.now());
}

async function extractDetailPayload(html, detailUrl) {
  const supsiParsed = hostOf(detailUrl).endsWith('supsi.ch') ? parseSupsiJobDetail(html) : null;
  const richMain = extractRichJobDescription(html);
  const og = cleanDescription(extractMetaContent(html, 'property', 'og:description') || '');
  let jsonLdDesc = '';
  const jsonLdBlocks = extractJsonLdBlocks(html);
  for (const block of jsonLdBlocks) {
    const nodes = extractJobPostingNodes(block);
    for (const n of nodes) {
      const d = cleanDescription(n?.description || '');
      if (d.length > jsonLdDesc.length) jsonLdDesc = d;
    }
  }
  const scriptMatch = String(html).match(/"jobDescription"\s*:\s*"([\s\S]*?)"\s*,\s*"/i);
  const scriptDesc = cleanDescription((scriptMatch?.[1] || '').replace(/\\"/g, '"').replace(/\\n/g, ' '));

  const candidates = [richMain, jsonLdDesc, scriptDesc, og, cleanDescription(stripHtml(html).slice(0, 3000))];
  const description = candidates.sort((a, b) => b.length - a.length)[0] || '';
  const pageLang = extractPageLang(html);
  const requirements = extractRequirements(description);
  const altUrls = extractAlternateLocaleUrls(html, detailUrl);
  const descriptionByLocale = {};
  const requirementsByLocale = {};

  // Populate source locale from current page.
  if (description.length >= 120 && LOCALES.includes(pageLang)) {
    descriptionByLocale[pageLang] = description;
    requirementsByLocale[pageLang] = requirements;
  }

  // Crawl alternates for locale coherence when available.
  for (const locale of LOCALES) {
    if (descriptionByLocale[locale]) continue;
    const alt = altUrls[locale];
    if (!alt) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const altHtml = await fetchHtml(alt);
      if (!altHtml) continue;
      const altDesc = extractRichJobDescription(altHtml) || cleanDescription(stripHtml(altHtml).slice(0, 2400));
      if (altDesc.length < 120) continue;
      descriptionByLocale[locale] = altDesc;
      requirementsByLocale[locale] = extractRequirements(altDesc);
    } catch {
      // ignore alternate locale failures
    }
  }

  return {
    description,
    requirements: supsiParsed?.requirements?.length ? supsiParsed.requirements : requirements,
    descriptionByLocale,
    requirementsByLocale,
    sourceLang: detectLang(description, pageLang),
    locationFromPage: supsiParsed?.location || extractLocationFromText(html, ''),
    companyFromPage: extractCompanyFromText(html, ''),
    applyUrl: extractWorkdayApplyUrl(html, detailUrl),
  };
}

async function crawlWorkdayJobs(company, source, crawlerConfig, knownJobUrls = new Set()) {
  const collected = [];
  let skippedKnown = 0;
  const detailApiBase = String(source.endpoint || '').replace(/\/jobs\/?$/i, '');
  let offset = 0;
  let total = 0;
  const limit = 20;
  do {
    let res;
    try {
      res = await fetchWithTimeout(source.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
        },
        body: JSON.stringify({
          appliedFacets: source.appliedFacets || {},
          limit,
          offset,
          searchText: '',
        }),
      });
    } catch {
      break;
    }
    if (!res.ok) break;
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      break;
    }
    const postings = assertJsonListShape(payload, { key: 'jobPostings', source: `workday:${company?.name || source?.endpoint || ''}` });
    // Trust the API `total` only as a positive upper bound. An unfiltered Workday
    // query (appliedFacets:{}) can echo total:0 with a full page; the old
    // `|| postings.length` fallback made total === page length, so the
    // `offset < total` guard below stopped after page 1, silently dropping
    // every posting on pages 2+. The short-page break is the genuine terminator.
    total = Number(payload?.total) || 0;
    for (const p of postings) {
      const title = normalizeSpace(p?.title || '');
      if (!title || title.length < 6 || isLikelyGenericCareerTitle(title)) continue;
      const externalPath = normalizeSpace(p?.externalPath || '');
      const normalizedExternalPath = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
      const detailUrl = externalPath ? tryUrl(externalPath, source.origin) : null;
      const detailApiUrl = detailApiBase && externalPath ? `${detailApiBase}${normalizedExternalPath}` : '';
      if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;
      if (knownJobUrls.size > 0 && knownJobUrls.has(canonicalizeJobUrl(detailUrl))) { skippedKnown++; continue; }
      const apiLocations = Array.isArray(p?.locations)
        ? p.locations.map((x) => normalizeSpace(x?.displayName || x?.name || x?.city || x?.country || '')).filter(Boolean)
        : [];
      let location = normalizeSpace(p?.locationsText || apiLocations.join(' · '));
      const postedDate = workdayPostedDateToIso(p?.postedOn || '');
      const bullet = Array.isArray(p?.bulletFields) ? p.bulletFields.map((x) => normalizeSpace(String(x))).filter(Boolean) : [];
      let descriptionSeed = normalizeSpace([title, location, bullet.join(' • ')].join('. '));
      let requirementsSeed = extractRequirements(descriptionSeed);
      let descriptionByLocale = {};
      let requirementsByLocale = {};
      let titleByLocale = {};
      let companyName = company.name;
      let applyUrl = detailUrl;
      let contractRaw = '';

      // 1) Preferred: Workday CXS detail API.
      try {
        if (detailApiUrl) {
          // eslint-disable-next-line no-await-in-loop
          const detailApiRes = await fetchWithTimeout(detailApiUrl, {
            headers: { Accept: 'application/json, text/plain, */*' },
          });
          if (detailApiRes.ok && /json/i.test(detailApiRes.headers.get('content-type') || '')) {
            // eslint-disable-next-line no-await-in-loop
            const apiPayload = await detailApiRes.json();
            const info = apiPayload?.jobPostingInfo || {};
            const apiDesc = htmlToStructuredText(info.jobDescription || '');
            if (apiDesc.length >= 120) {
              descriptionSeed = apiDesc;
            }
            const apiLoc = normalizeSpace(
              String(info.location || info.jobRequisitionLocation || '')
                .replace(/\s*>\s*/g, ' · ')
            );
            if (apiLoc) location = apiLoc;
            if (normalizeSpace(info.externalUrl || '')) {
              applyUrl = normalizeSpace(info.externalUrl);
            }
            contractRaw = normalizeSpace(info.timeType || '');
            requirementsSeed = mergeRequirements(requirementsSeed, extractRequirements(apiDesc));
          }
        }
      } catch {
        // keep HTML/detail fallback
      }

      // 2) HTML fallback + locale alternates
      try {
        // eslint-disable-next-line no-await-in-loop
        const detailRes = await fetchWithTimeout(detailUrl);
        if (detailRes.ok) {
          // eslint-disable-next-line no-await-in-loop
          const detailHtml = await detailRes.text();
          // eslint-disable-next-line no-await-in-loop
          const detailPayload = await extractDetailPayload(detailHtml, detailUrl);
          if (detailPayload.description?.length >= 120) {
            descriptionSeed = detailPayload.description;
          }
          if (detailPayload.locationFromPage) {
            const pageLoc = detailPayload.locationFromPage;
            const combinedLocSignal = `${title} ${pageLoc} ${detailPayload.description || ''}`;
            if (!isTargetSwissLocation(combinedLocSignal)) {
              // Detail page disproves Ticino relevance -> discard.
              continue;
            }
            location = pageLoc;
          }
          if (detailPayload.companyFromPage) {
            companyName = detailPayload.companyFromPage;
          }
          if (detailPayload.applyUrl) {
            applyUrl = detailPayload.applyUrl;
          }
          requirementsSeed = mergeRequirements(requirementsSeed, detailPayload.requirements || []);
          descriptionByLocale = detailPayload.descriptionByLocale || {};
          requirementsByLocale = detailPayload.requirementsByLocale || {};

          // AI enrichment only if still thin or locale coverage is missing.
          const localeCoverage = Object.keys(descriptionByLocale).length;
          if (
            crawlerConfig?.aiLocalizationEnabled &&
            aiLocalizationCalls < (crawlerConfig?.aiLocalizationMaxJobsPerRun || 0) &&
            localeCoverage === 0 &&
            descriptionSeed.length >= 260 &&
            isAnyModelAvailable()
          ) {
            aiLocalizationCalls += 1;
            // eslint-disable-next-line no-await-in-loop
            const aiLocalized = await aiLocalizeJobContent({
              title,
              company: company.name,
              location,
              description: descriptionSeed,
              requirements: requirementsSeed,
              sourceLang: detailPayload.sourceLang || detectLang(descriptionSeed, 'en'),
            });
            if (aiLocalized) {
              for (const localeKey of Object.keys(aiLocalized)) {
                titleByLocale[localeKey] = aiLocalized[localeKey].title || title;
                descriptionByLocale[localeKey] = aiLocalized[localeKey].description;
                requirementsByLocale[localeKey] = mergeRequirements(
                  requirementsByLocale[localeKey] || [],
                  aiLocalized[localeKey].requirements || []
                );
              }
            }
          }
        }
      } catch {
        // Keep fallback descriptionSeed
      }
      const geoSignal = `${title} ${location} ${descriptionSeed}`;
      if (isLocationExplicitlyForeign(location)) continue;
      if (isExplicitlyOutsideTarget(geoSignal) || isExplicitlyOutsideTargetCantons(geoSignal)) continue;
      if (!location && !isTargetSwissLocation(`${title} ${descriptionSeed}`)) continue;
      if (!location) location = company.city || 'Ticino';
      if (!isTargetSwissLocation(`${title} ${location} ${descriptionSeed}`)) continue;
      const inferredCanton = inferSwissTargetCanton(location) || inferSwissTargetCanton(`${title} ${descriptionSeed}`) || '';
      if (!inferredCanton) { console.warn(`  ⚠️ Skipping job with unknown canton: "${title}" (location: ${location})`); continue; }
      collected.push({
        id: '',
        slug: '',
        company: companyName || company.name,
        title,
        location,
        canton: inferredCanton,
        category: guessCategory(title, descriptionSeed),
        contract: normalizeContract(contractRaw, title, descriptionSeed),
        currency: 'CHF',
        description: descriptionSeed,
        titleByLocale,
        descriptionByLocale,
        requirements: requirementsSeed,
        requirementsByLocale,
        featured: false,
        postedDate,
        url: applyUrl || detailUrl,
        source: 'Company Careers Crawler',
      });
    }
    offset += limit;
    if (postings.length < limit) break;            // genuine end of results
    if (total > 0 && offset >= total) break;        // positive upper bound only
  } while (offset < 200);                            // page-cap (existing safety bound)

  collected.skippedKnown = skippedKnown;
  return collected;
}

async function crawlGreenhouseJobs(company, source) {
  let res;
  try {
    res = await fetchWithTimeout(source.endpoint, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return [];
  }
  const jobs = assertJsonListShape(payload, { key: 'jobs', source: `greenhouse:${company?.name || source?.endpoint || ''}` });
  const out = [];
  for (const j of jobs) {
    const title = normalizeSpace(j?.title || j?.name || '');
    if (!title || isLikelyGenericCareerTitle(title)) continue;
    const detailUrl = tryUrl(j?.absolute_url || j?.url || '', source.listingUrl);
    if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;
    const location = normalizeSpace(j?.location?.name || j?.location || company.city || 'Ticino');
    if (!isTargetSwissLocation(location)) continue;
    const description = cleanDescription(j?.content || j?.description || `${title}. ${location}`);
    const inferredCanton = inferSwissTargetCanton(location) || inferSwissTargetCanton(`${title} ${description}`) || '';
    if (!inferredCanton) { console.warn(`  ⚠️ Skipping job with unknown canton: "${title}" (location: ${location})`); continue; }
    out.push({
      id: '',
      slug: '',
      company: company.name,
      title,
      location,
      canton: inferredCanton,
      category: guessCategory(title, description),
      contract: normalizeContract(j?.metadata?.employment_type || '', title, description),
      currency: 'CHF',
      description,
      requirements: extractRequirements(description),
      featured: false,
      postedDate: dateOnly(j?.updated_at || j?.updatedAt || Date.now()),
      url: detailUrl,
      source: 'Company Careers Crawler',
    });
  }
  return out;
}

async function crawlLeverJobs(company, source) {
  let res;
  try {
    res = await fetchWithTimeout(source.endpoint, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return [];
  }
  // Lever's postings API returns a bare top-level array; a non-array here is an
  // error/challenge body, not an empty board → warn loudly rather than silently
  // yielding 0 jobs.
  const jobs = assertJsonListShapeMultiKey(payload, {
    keys: [],
    allowBareArray: true,
    source: `lever:${company?.name || source?.endpoint || 'unknown'}`,
  });
  const out = [];
  for (const j of jobs) {
    const title = normalizeSpace(j?.text || j?.title || '');
    if (!title || isLikelyGenericCareerTitle(title)) continue;
    const detailUrl = tryUrl(j?.hostedUrl || j?.applyUrl || '', source.listingUrl);
    if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;
    const location = normalizeSpace(j?.categories?.location || j?.workplaceType || company.city || 'Ticino');
    if (!isTargetSwissLocation(location)) continue;
    const description = cleanDescription(j?.descriptionPlain || j?.description || `${title}. ${location}`);
    const inferredCanton = inferSwissTargetCanton(location) || inferSwissTargetCanton(`${title} ${description}`) || '';
    if (!inferredCanton) { console.warn(`  ⚠️ Skipping job with unknown canton: "${title}" (location: ${location})`); continue; }
    out.push({
      id: '',
      slug: '',
      company: company.name,
      title,
      location,
      canton: inferredCanton,
      category: guessCategory(title, description),
      contract: normalizeContract(j?.categories?.commitment || '', title, description),
      currency: 'CHF',
      description,
      requirements: extractRequirements(description),
      featured: false,
      postedDate: dateOnly(j?.createdAt || j?.updatedAt || Date.now()),
      url: detailUrl,
      source: 'Company Careers Crawler',
    });
  }
  return out;
}

async function crawlSmartRecruitersJobs(company, source) {
  let res;
  try {
    res = await fetchWithTimeout(source.endpoint, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return [];
  }
  const jobs = assertJsonListShape(payload, { key: 'content', source: `smartrecruiters:${company?.name || source?.endpoint || ''}` });
  const out = [];
  for (const j of jobs) {
    const title = normalizeSpace(j?.name || '');
    if (!title || isLikelyGenericCareerTitle(title)) continue;
    const detailUrl = tryUrl(j?.ref ? `https://jobs.smartrecruiters.com/${source.company}/${j.ref}` : '', source.listingUrl);
    if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;
    const location = normalizeSpace(j?.location?.city || j?.location?.region || company.city || 'Ticino');
    if (!isTargetSwissLocation(location)) continue;
    const description = cleanDescription(`${title}. ${location}. ${normalizeSpace(j?.releasedDate || '')}`);
    const inferredCanton = inferSwissTargetCanton(location) || inferSwissTargetCanton(`${title} ${description}`) || '';
    if (!inferredCanton) { console.warn(`  ⚠️ Skipping job with unknown canton: "${title}" (location: ${location})`); continue; }
    out.push({
      id: '',
      slug: '',
      company: company.name,
      title,
      location,
      canton: inferredCanton,
      category: guessCategory(title, description),
      contract: normalizeContract(j?.typeOfEmployment || '', title, description),
      currency: 'CHF',
      description,
      requirements: extractRequirements(description),
      featured: false,
      postedDate: dateOnly(j?.releasedDate || Date.now()),
      url: detailUrl,
      source: 'Company Careers Crawler',
    });
  }
  return out;
}

function absoluteSameHostLinks(html, baseUrl, hintsRegex) {
  const links = new Set();
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const href = readAttr(m[1], 'href').trim();
    if (!href || href.startsWith('#')) continue;
    const text = stripHtml(m[2]).toLowerCase();
    const url = tryUrl(href, baseUrl);
    if (!url || !sameHost(url, baseUrl)) continue;
    if (hintsRegex.test(url.toLowerCase()) || hintsRegex.test(text)) {
      links.add(url);
    }
  }
  return [...links];
}

async function crawlGenericListingJobs(company, listingUrl, crawlerConfig, knownJobUrls = new Set(), { userAgent } = {}) {
  const queue = [{ url: listingUrl, depth: 0 }];
  const visited = new Set();
  const jobs = [];
  const jobLinks = new Set();
  const listingHost = hostOf(listingUrl);
  const allowAtsHost = isKnownAtsHost(listingHost);

  while (queue.length > 0 && visited.size < MAX_GENERIC_LISTING_PAGES) {
    const current = queue.shift();
    if (!current) break;
    const pageUrl = current.url;
    if (!pageUrl || visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    let html = '';
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchWithTimeout(pageUrl, { userAgent });
      if (!res.ok) continue;
      // eslint-disable-next-line no-await-in-loop
      html = await res.text();
    } catch (fetchErr) {
      continue;
    }

    const blocks = extractJsonLdBlocks(html);
    for (const block of blocks) {
      const nodes = extractJobPostingNodes(block);
      for (const n of nodes) {
        const parsed = toJobFromJsonLd(n, company.name, pageUrl);
        if (parsed?.job) jobs.push(parsed.job);
      }
    }

    const links = absoluteLinks(html, pageUrl);
    for (const link of links) {
      const lHost = hostOf(link);
      const sameListingHost = lHost && lHost === listingHost;
      const sameCompanyHost = sameHost(link, company.website);
      const knownAts = isKnownAtsHost(lHost);
      if (!(sameListingHost || sameCompanyHost || (allowAtsHost && knownAts))) continue;

      if (isLikelyJobDetailUrl(link)) {
        jobLinks.add(link);
        continue;
      }
      if (current.depth >= 1) continue;
      if (/(job|jobs|career|careers|vacanc|position|offerta|lavor|stellen|emploi|candid)/i.test(link)) {
        queue.push({ url: link, depth: current.depth + 1 });
      }
    }
  }

  const allDetailLinks = [...jobLinks];
  const unknownDetailLinks = knownJobUrls.size > 0
    ? allDetailLinks.filter((u) => !knownJobUrls.has(canonicalizeJobUrl(u)))
    : allDetailLinks;
  const detailLinks = unknownDetailLinks.slice(0, MAX_GENERIC_DETAIL_PAGES_PER_COMPANY);
  jobs.skippedKnown = allDetailLinks.length - unknownDetailLinks.length;
  jobs.truncatedByLimit = Math.max(0, unknownDetailLinks.length - detailLinks.length);
  for (const detailUrl of detailLinks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchWithTimeout(detailUrl, { userAgent });
      // eslint-disable-next-line no-await-in-loop
      const html = await res.text();
      const blocks = extractJsonLdBlocks(html);
      let parsedFromJsonLd = false;
      for (const block of blocks) {
        const nodes = extractJobPostingNodes(block);
        for (const n of nodes) {
          const parsed = toJobFromJsonLd(n, company.name, detailUrl);
          if (parsed?.job) {
            jobs.push(parsed.job);
            parsedFromJsonLd = true;
          }
        }
      }
      if (!parsedFromJsonLd) {
        const signals = quickJobPageSignals(html, detailUrl);
        if (!signals.hasJsonLdJob && (signals.positive <= 1 || signals.negative > 0)) {
          // eslint-disable-next-line no-await-in-loop
          const gate = await aiValidateJobDetailPage({ html, pageUrl: detailUrl, companyName: company.name });
          if (!gate.isJob) continue;
        }
        const parsed = toJobFromHtmlFallback(html, detailUrl, company.name, company.city || 'Ticino');
        if (parsed.job) jobs.push(parsed.job);
      }
    } catch (detErr) {
    }
  }

  return jobs;
}

async function crawlTeaserApiJobs(company, apiUrl) {
  let res;
  try {
    res = await fetchWithTimeout(apiUrl, { headers: { Accept: 'application/json, text/plain, */*' } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return [];
  }
  const rows = assertJsonListShape(payload, { key: 'results', source: `teaser-api:${company?.name || apiUrl || ''}` });
  const out = [];
  for (const row of rows) {
    const title = normalizeSpace(row?.title || '');
    if (!title || isLikelyGenericCareerTitle(title)) continue;
    const detailUrl = tryUrl(row?.link?.url || '', apiUrl);
    if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;

    let parsed = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const detailRes = await fetchWithTimeout(detailUrl);
      if (detailRes.ok) {
        // eslint-disable-next-line no-await-in-loop
        const detailHtml = await detailRes.text();
        const signals = quickJobPageSignals(detailHtml, detailUrl);
        if (!signals.hasJsonLdJob && (signals.positive <= 1 || signals.negative > 0)) {
          // eslint-disable-next-line no-await-in-loop
          const gate = await aiValidateJobDetailPage({ html: detailHtml, pageUrl: detailUrl, companyName: company.name });
          if (!gate.isJob) continue;
        }
        parsed = toJobFromHtmlFallback(detailHtml, detailUrl, company.name, company.city || 'Ticino');
      }
    } catch {
      parsed = null;
    }

    const locationFromTitle = inferTicinoCityFromText(`${title} ${row?.fieldofactivity || ''}`, company.city || 'Ticino');
    const baseJob = parsed?.job || {
      id: '',
      slug: '',
      company: company.name,
      title,
      location: locationFromTitle,
      canton: 'TI',
      category: guessCategory(title, `${row?.fieldofactivity || ''}`),
      contract: normalizeContract(row?.workload || row?.expiration || '', title, ''),
      currency: 'CHF',
      description: cleanDescription(`${title}. ${row?.fieldofactivity || ''}. ${row?.workloadTitle || ''}: ${row?.workload || ''}`),
      requirements: [],
      featured: false,
      postedDate: parseDdMmYyyy(row?.date || ''),
      url: detailUrl,
      source: 'Company Careers Crawler',
    };

    const merged = {
      ...baseJob,
      title: baseJob.title || title,
      location: baseJob.location || locationFromTitle,
      contract: normalizeContract(row?.workload || row?.expiration || '', baseJob.title || title, baseJob.description || ''),
      postedDate: parseDdMmYyyy(row?.date || baseJob.postedDate || ''),
      url: detailUrl,
      source: 'Company Careers Crawler',
    };
    if (!isTargetSwissLocation(`${merged.title} ${merged.location} ${merged.description}`)) continue;
    merged.canton = inferSwissTargetCanton(merged.location) || inferSwissTargetCanton(`${merged.title} ${merged.description}`) || merged.canton || '';
    if (!merged.canton) {
      console.warn(`  ⚠️ Skipping job with unknown canton: "${merged.title}" (location: ${merged.location || 'unknown'})`);
      continue;
    }
    out.push(merged);
  }
  return out;
}

/**
 * Every `addressCountry` the JSON-LD node declares, coerced to comparable
 * tokens. `jobLocation` may be a single object or an array (multi-site
 * postings), and `addressCountry` may be a string ("CH", "Switzerland"), a
 * numeric ISO-3166 code, or a `{ '@type': 'Country', name }` object.
 * Returns [] when the posting declares no country at all.
 */
function jsonLdDeclaredCountryTokens(node) {
  const locations = Array.isArray(node?.jobLocation) ? node.jobLocation : [node?.jobLocation];
  const tokens = [];
  for (const loc of locations) {
    const token = coerceCountryField(loc?.address?.addressCountry);
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * True when the posting ITSELF declares a country that is unambiguously not
 * Switzerland.
 *
 * This is the strongest location evidence a JobPosting carries: the publisher
 * stating where the job is. It is deliberately ranked by SPECIFICITY, not by
 * position in a fallback chain:
 *
 *   - No `addressCountry` at all → returns false. Absence is not evidence, so
 *     the seed's canton keeps winning exactly as before.
 *   - Any declared country reads as Switzerland → false, even if a sibling
 *     jobLocation is foreign (a multi-site posting that includes CH is still
 *     legitimately crawlable for its Swiss location).
 *   - A declared token that is itself a Swiss CANTON code or name → false.
 *     `FR`, `GR`, `LU`, `BE`, `NE`, `SO`, `SG`, `TG`, `AR`, `GL`, `SZ` and `BS`
 *     are all simultaneously ISO country codes and Swiss canton codes, and
 *     feeds really do put a canton in `addressCountry`. A colliding bare token
 *     is ambiguous, and ambiguity is not the explicit evidence this rule acts
 *     on — dropping it would delete legitimate Fribourg/Graubünden/Luzern jobs.
 *     The spelled-out name ("Luxembourg", "France") carries no such collision
 *     and is still treated as foreign.
 */
function isJsonLdCountryExplicitlyForeign(node) {
  const tokens = jsonLdDeclaredCountryTokens(node);
  if (!tokens.length) return false;
  if (tokens.some((token) => isChCountry(token))) return false;
  return tokens.every((token) => !normalizeCantonCode(token));
}

function toJobFromJsonLd(node, fallbackCompany, sourcePageUrl, options = {}) {
  const seedMeta = normalizeAdapterSeedMeta(options?.seedMeta || null);
  const seedMetaRelevant = isAdapterSeedMetaTargetRelevant(seedMeta);
  const seedLocation = seedMetaPreferredLocation(seedMeta, 'Ticino');
  const seedCanton = normalizeCantonCode(seedMeta?.canton || '');
  const title = normalizeSpace(node.title);
  const description = cleanDescription(node.description || '');
  const hiringOrg = normalizeSpace(node.hiringOrganization?.name || fallbackCompany);
  const rawLoc =
    node.jobLocation?.address?.addressLocality ||
    node.jobLocation?.address?.addressRegion ||
    node.jobLocation?.address?.streetAddress ||
    '';
  const addressRegion = normalizeSpace(node.jobLocation?.address?.addressRegion || '');
  const locality = normalizeSpace(node.jobLocation?.address?.addressLocality || '');
  // Append region to locality when both present and different (e.g. "Taverne, Ticino")
  // so that post-merge target matching can recognise smaller towns via their canton.
  let location;
  if (locality && addressRegion && !locality.toLowerCase().includes(addressRegion.toLowerCase())) {
    location = sanitizeLocation(`${locality}, ${addressRegion}`);
  } else {
    location = sanitizeLocation(normalizeSpace(rawLoc || 'Ticino'));
  }
  if (!location && seedLocation) location = seedLocation;
  const url = tryUrl(node.url, sourcePageUrl) || sourcePageUrl;
  const declaredSeedDetail = options?.isSeedDetail === true
    && canonicalizeJobUrl(url)
    && canonicalizeJobUrl(url) === canonicalizeJobUrl(sourcePageUrl);

  if (!title || title.length < 6) return { job: null, reason: 'jsonld_missing_title' };
  if (isLikelyGenericCareerTitle(title)) return { job: null, reason: 'jsonld_generic_title' };
  if (!declaredSeedDetail && !isLikelyJobDetailUrl(url)) {
    return { job: null, reason: 'jsonld_not_detail_url' };
  }

  // Include addressRegion in relevance check so that jobs in smaller Ticino towns
  // (e.g., Taverne) are still recognized when addressRegion says "Ticino".
  const mergedLocText = `${title} ${location} ${addressRegion} ${description}`;
  if (isLikelyCommercialPromoContent({ title, description, pageUrl: url })) {
    return { job: null, reason: 'jsonld_commercial_promo_page' };
  }
  // #4587: seedMetaRelevant only means the SEED URL was reached via a
  // Switzerland-targeting search term/canton scope — it says nothing about
  // any individual JSON-LD JobPosting the seed happens to return. It used
  // to blanket-suppress both explicit-foreign checks below, so a
  // country-name-seeded crawler (zurich-insurance-sede-ticino) ingested
  // explicitly foreign postings and then forged them a fake Swiss
  // location/canton via seedLocation/seedCanton further down. Both foreign
  // checks already no-op when the same text also mentions Switzerland, so
  // an EXPLICIT foreign signal is strong enough to reject regardless of
  // seed trust. Keep the seedMetaRelevant rescue only for the ambiguous
  // "no explicit signal either way" case below.
  if (isLocationExplicitlyForeign(location) || _isForeignAtsUrlLocation(url)) {
    return { job: null, reason: 'jsonld_location_explicitly_foreign' };
  }
  if (isExplicitlyOutsideTarget(mergedLocText) || isExplicitlyOutsideTargetCantons(mergedLocText)) {
    return { job: null, reason: 'jsonld_explicitly_outside_target' };
  }
  // The two checks above read the location STRING. They miss the posting's own
  // structured `addressCountry`, which this function never looked at — so a US
  // or Canadian JobPosting whose locality happens not to name a blacklisted
  // city reached the assignment below and was stamped with `seedCanton`,
  // landing in the corpus as a Ticino job. That corrupts the denominator of
  // every per-canton count (surfaced while investigating #5321).
  //
  // The declared country is more specific evidence than the adapter seed, so
  // it wins over it — but only when it is explicit AND unambiguous; see
  // isJsonLdCountryExplicitlyForeign. Placed with the other explicit-foreign
  // checks, i.e. ahead of the seedMetaRelevant rescue, for the reason #4587
  // gives above: an explicit foreign signal outranks seed trust.
  if (isJsonLdCountryExplicitlyForeign(node)) {
    return { job: null, reason: 'jsonld_address_country_foreign' };
  }
  if (!isTargetSwissLocation(mergedLocText) && !seedMetaRelevant) return { job: null, reason: 'jsonld_not_target_relevant' };

  const salary = node.baseSalary?.value || {};
  const salaryMin = Number(salary.minValue);
  const salaryMax = Number(salary.maxValue);
  const currency = normalizeSpace(node.baseSalary?.currency || 'CHF').toUpperCase() === 'EUR' ? 'EUR' : 'CHF';
  const company = normalizeSpace(seedMeta?.company || hiringOrg || fallbackCompany);
  const normalizedLocation = seedMetaRelevant && !isTargetSwissLocation(mergedLocText)
    ? seedLocation
    : location;
  const inferredJsonLdCanton =
    inferSwissTargetCanton(`${normalizedLocation || location} ${addressRegion}`) ||
    inferSwissTargetCanton(`${title} ${description}`) ||
    '';

  const job = {
    id: '',
    slug: '',
    company: company || fallbackCompany,
    title,
    location: normalizedLocation || seedLocation || 'Ticino',
    canton: seedCanton || inferredJsonLdCanton || '',
    category: guessCategory(title, description),
    contract: normalizeContract(seedMeta?.contract || node.employmentType, title, description),
    salaryMin: Number.isFinite(salaryMin) ? salaryMin : undefined,
    salaryMax: Number.isFinite(salaryMax) ? salaryMax : undefined,
    currency,
    description,
    requirements: extractRequirements(description),
    featured: false,
    postedDate: dateOnly(seedMeta?.postedDate || node.datePosted || Date.now()),
    url,
    source: 'Company Careers Crawler',
    ...(seedMetaRelevant ? {
      _targetScope: {
        type: 'adapter_seed_meta',
        location: seedLocation || location || '',
        canton: seedCanton || '',
      },
    } : {}),
  };

  if (!job.canton) {
    console.warn(`  ⚠️ Skipping JSON-LD job with unknown canton: "${job.title}" (location: ${job.location || 'unknown'})`);
    return null;
  }

  return { job, reason: null };
}

/**
 * Read schema.org PostalAddress metadata from HTML-only job pages. Some ATS
 * tenants expose microdata but no JSON-LD, so the generic fallback otherwise
 * judges geography from title/body tokens (where e.g. "IT" means Information
 * Technology, not Italy).
 */
function extractHtmlMicrodataAddress(html = '') {
  const content = (prop) => {
    const tag = String(html).match(new RegExp(
      `<[^>]*\\bitemprop=["']${prop}["'][^>]*>`,
      'i',
    ))?.[0] || '';
    return normalizeSpace(decodeHtmlEntities(
      tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] || '',
    ));
  };
  return {
    locality: content('addressLocality'),
    region: content('addressRegion'),
    postalCode: content('postalCode'),
    country: content('addressCountry'),
  };
}

function extractTitleFromHtml(html) {
  return normalizeSpace(stripScriptsAndStyles(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
}

function extractH1FromHtml(html = '') {
  return normalizeSpace(stripHtml(stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''));
}

/**
 * #6480: this was a second, unbalanced copy of `readMetaContent` — its
 * `["']([^"']+)["']` stopped at the first quote of either kind, so an
 * `og:title` carrying an apostrophe (`Operatore dell'infanzia`) was truncated
 * there. It now delegates to the shared quote-balanced reader instead of
 * keeping a private regex that has to be fixed twice.
 *
 * `attr` is kept in the signature for the call sites, but `readMetaContent`
 * matches `property=` and `name=` alike, which is what every caller wanted.
 */
function extractMetaContent(html, attr, value) {
  return normalizeSpace(readMetaContent(html, value));
}

/**
 * Extract job title from Rexx Systems ATS pages (concorsi.ti.ch).
 * Page structure: h2.emp_nr_subtitle[0]=department, [1]=concorso number, [2]=job title.
 * The H1 is a generic heading ("Concorsi per la nomina..."), not the actual job title.
 */
function extractRexxJobTitle(html) {
  if (!/<div class=["']emp_nr_innerframe["']>/i.test(html)) return '';
  const re = /<h2[^>]*class=["'][^"']*emp_nr_subtitle[^"']*["'][^>]*>([\s\S]*?)<\/h2>/gi;
  const h2s = [];
  let m;
  while ((m = re.exec(String(html))) !== null) {
    h2s.push(normalizeSpace(stripHtml(m[1])));
  }
  // Concorsi.ti.ch layout is not fixed across announcements:
  // often h2[2] is just "33/26" and h2[3] is the real title.
  // Select the best semantic candidate instead of hard index.
  // Every content section heading on this portal ends with a colon
  // (Requisiti:, Compiti:, Condizioni:, Scadenza:, Osservazioni particolari:,
  // Documenti e condizioni di presentazione della candidatura:, Stipendio …:).
  // Real job titles never end with a colon, so a trailing-colon check rejects the
  // whole heading class — not just the few enumerated keywords (which previously
  // let a long heading like "Documenti …:" win when the title lacked a preferred
  // keyword). Kept in sync with SECTION_HEADING_RE in scripts/lib/tich-job-parser.mjs.
  const sectionRe = /^(compiti|requisiti|condizioni|scadenza|osservazioni|documenti|stipendio|mansioni|profilo|aufgaben|anforderungen)\b/i;
  const candidates = h2s.filter((h) => (
    // Min length aligned with parseTichDetailPage (>10), not >20, so short
    // count-leading titles (e.g. "1 Stagista IT", 13 chars) are not silently
    // dropped here while passing the tich-parser. The trailing-colon /
    // sectionRe / concorso-number guards below reject short section headings.
    h.length > 10 &&
    !/:\s*$/.test(h) &&
    !sectionRe.test(h) &&
    !/^\d+\/\d+$/.test(h.trim()) &&
    !/^dipartimento\b/i.test(h) &&
    !/^concorsi per la nomina\b/i.test(h)
  ));
  const preferred = candidates.filter((h) =>
    /(presso|a tempo|%|lord|incaricat|nomina|psicolog|assistente|ingegner|operatore|infermier|docente)/i.test(h)
  );
  return (preferred.sort((a, b) => b.length - a.length)[0] || candidates.sort((a, b) => b.length - a.length)[0] || '');
}

function toJobFromHtmlFallback(html, pageUrl, companyName, companyCity, options = {}) {
  const supsiParsed = hostOf(pageUrl).endsWith('supsi.ch') ? parseSupsiJobDetail(html) : null;
  const seedMeta = normalizeAdapterSeedMeta(options?.seedMeta || null);
  const seedMetaRelevant = isAdapterSeedMetaTargetRelevant(seedMeta);
  const isSeedDetail = Boolean(options?.isSeedDetail);
  const seedLocation = seedMetaPreferredLocation(seedMeta, companyCity || 'Ticino');
  // Try ATS-specific title extractors first, then generic H1 / og:title / <title>.
  // If the H1 is a generic career page heading, try alternative title sources
  // instead of immediately rejecting the entire job.
  let title = normalizeSpace(supsiParsed?.title || extractRexxJobTitle(html));
  if (!title) {
    const h1 = extractH1FromHtml(html);
    title = (!h1 || isLikelyGenericCareerTitle(h1))
      ? normalizeSpace(
          extractMetaContent(html, 'property', 'og:title') ||
          extractTitleFromHtml(html)
        )
      : h1;
  }
  // Clean Rexx Systems title tag format: "Offerta di lavoro {TITLE} presso {COMPANY} Jobportal"
  title = normalizeSpace(
    title
      .replace(/^offerta di lavoro\s+/i, '')
      .replace(/\s+jobportal$/i, '')
  );
  if (!title || title.length < 6) return { job: null, reason: 'html_missing_title' };
  if (isLikelyGenericCareerTitle(title)) return { job: null, reason: 'html_generic_title' };
  // Adapter-declared seed detail URLs bypass URL pattern and keyword checks — the adapter
  // explicitly designates these as job detail pages.
  if (!isSeedDetail && !isLikelyJobDetailUrl(pageUrl)) return { job: null, reason: 'html_not_detail_url' };
  if (!isSeedDetail && !/(job|career|position|vacanc|offerta|lavor|stelle|emploi|karriere|apply|candid)/i.test(html)) {
    return { job: null, reason: 'html_not_job_like' };
  }

  // Try Migros-specific structured extraction first (returns separate fields)
  const migrosData = extractMigrosStructuredData(html);

  const richDescription = supsiParsed?.description || migrosData?.description || extractRichJobDescription(html);
  const description = cleanDescription(
    richDescription ||
    extractMetaContent(html, 'property', 'og:description') ||
    extractMetaContent(html, 'name', 'description') ||
    stripHtml(html).slice(0, 3000)
  );
  if (isLikelyCommercialPromoContent({ title, description, pageUrl })) {
    return { job: null, reason: 'html_commercial_promo_page' };
  }
  if (isLikelyListingSummaryContent(title, description)) {
    return { job: null, reason: 'html_listing_summary_page' };
  }
  const microdataAddress = extractHtmlMicrodataAddress(html);
  const microdataLocation = [microdataAddress.locality, microdataAddress.region]
    .filter(Boolean)
    .join(', ');
  const locationMatch =
    supsiParsed?.location ||
    microdataLocation ||
    extractLocationFromText(html, '') ||
    sanitizeLocation(normalizeSpace(extractMetaContent(html, 'property', 'jobLocation'))) ||
    (isTargetSwissLocation(description) ? companyCity : '') ||
    (seedMetaRelevant ? seedLocation : '');
  const location = sanitizeLocation(locationMatch || seedLocation || companyCity || 'Ticino');
  const isFederalPortal = isFederalJobsPortalUrl(pageUrl);
  const normalizedFederalLocation = isFederalPortal
    ? normalizeFederalJobLocation(location, normalizeCantonCode(seedMeta?.canton || ''))
    : null;
  const companyCandidate =
    extractCompanyFromText(html, companyName) ||
    normalizeSpace(seedMeta?.company || companyName) ||
    companyName;
  const companyDetected = isFederalPortal
    ? normalizeFederalDepartmentCompany(companyCandidate, seedMeta?.company || companyName)
    : companyCandidate;

  // Relevance must come from explicit page signals, not only company-city fallback.
  const geoSignalExplicit = `${title} ${locationMatch || ''} ${description} ${pageUrl}`;
  const geoSignal = `${title} ${location} ${description}`;
  // #4587: seedMetaRelevant only means the SEED URL was reached via a
  // Switzerland-targeting search term (e.g. locationsearch=Switzerland on a
  // global ATS) — it says nothing about any individual result the search
  // happens to return. It used to blanket-suppress every foreign check
  // below, so a country-name-seeded crawler (zurich-insurance-sede-ticino)
  // ingested explicitly foreign postings (Köln, Wien, Vorarlberg, Barcelona)
  // and forged them a fake Swiss location downstream. isLocationExplicitlyForeign
  // / isExplicitlyOutsideTarget already no-op when the same text also
  // mentions Switzerland, so an EXPLICIT foreign signal here is strong
  // enough to reject regardless of seed trust. Keep the seedMetaRelevant
  // rescue only for the ambiguous "no explicit signal either way" case below.
  const microdataCountryForeign = Boolean(microdataAddress.country)
    && !isChCountry(microdataAddress.country)
    && !normalizeCantonCode(microdataAddress.country);
  if (microdataCountryForeign || isLocationExplicitlyForeign(locationMatch) || _isForeignAtsUrlLocation(pageUrl)) {
    return { job: null, reason: 'html_location_explicitly_foreign' };
  }
  const explicitSwissMicrodata = isChCountry(microdataAddress.country)
    && isTargetSwissLocation(`${microdataAddress.locality} ${microdataAddress.region}`);
  if (
    !explicitSwissMicrodata
    && (isExplicitlyOutsideTarget(geoSignal) || isExplicitlyOutsideTargetCantons(geoSignal))
  ) {
    return { job: null, reason: 'html_explicitly_outside_target' };
  }
  if (!isTargetSwissLocation(geoSignalExplicit) && !seedMetaRelevant) return { job: null, reason: 'html_not_target_relevant' };
  const inferredHtmlCanton =
    inferSwissTargetCanton(locationMatch || '') ||
    inferSwissTargetCanton(`${title} ${description} ${pageUrl}`) ||
    '';

  // Use Migros structured data for requirements/contract when available
  const contractFromMigros = migrosData?.employmentType || '';
  const requirementsFromMigros = migrosData?.requirements || [];

  // Rexx Systems ATS (concorsi.ti.ch) — extract actual salary from page
  const isRexxPage = /emp_nr_(?:inner|outer)frame/i.test(html);
  const rexxSalary = isRexxPage ? extractRexxSalary(html) : null;

  const job = {
    id: '',
    slug: '',
    company: companyDetected,
    title: title.replace(/\s*[-|]\s*careers?.*$/i, '').trim(),
    location: seedMetaRelevant && !isTargetSwissLocation(geoSignalExplicit)
      ? seedLocation
      : normalizedFederalLocation?.location || location,
    canton:
      normalizeCantonCode(seedMeta?.canton || '') ||
      normalizeCantonCode(normalizedFederalLocation?.canton || '') ||
      inferredHtmlCanton ||
      'TI',
    category: guessCategory(title, description),
    contract: contractFromMigros || normalizeContract(seedMeta?.contract || '', title, description),
    currency: rexxSalary?.currency || 'CHF',
    description,
    requirements: (supsiParsed?.requirements?.length || 0) > 0
      ? supsiParsed.requirements
      : requirementsFromMigros.length > 0
      ? requirementsFromMigros
      : extractRequirements(description),
    featured: false,
    postedDate: dateOnly(seedMeta?.postedDate || Date.now()),
    url: pageUrl,
    source: 'Company Careers Crawler',
    ...(seedMetaRelevant ? {
      _targetScope: {
        type: 'adapter_seed_meta',
        location: seedLocation || location || '',
        canton: normalizeCantonCode(seedMeta?.canton || ''),
      },
    } : {}),
    // Rexx Systems salary (concorsi.ti.ch) — actual salary from the page
    ...(rexxSalary ? {
      salaryMin: rexxSalary.min,
      salaryMax: rexxSalary.max,
    } : {}),
    // Extended Migros fields (used by AI enrichment and build plugin)
    ...(migrosData ? {
      _migrosResponsibilities: migrosData.responsibilities,
      _migrosBenefits: migrosData.benefits,
      _migrosWorkPercentage: migrosData.workPercentage,
    } : {}),
  };
  return { job, reason: null };
}

// FRO-231: fingerprint, slug registry, dedup → moved to top of file (FRO-359)

const GRACE_PERIOD_MAX_MISSES = 2;

function pruneStaleCrawlerJobs(existingJobs, incomingJobs, results, options = {}) {
  const activeResults = (results || [])
    .filter((r) => (r?.processedCandidates || 0) > 0 || (r?.scrapedJobPages || 0) > 0 || (r?.discardedCount || 0) > 0);
  const activeDomains = new Set();
  const authoritativeFingerprintsByScope = new Map();
  for (const result of activeResults) {
    const companyDomain = normalizeHost(result?.companyDomain || '');
    if (companyDomain) activeDomains.add(companyDomain);

    const companyKey = normalizeCompanyKey(result?.companyKey || '');
    const lifecycleDomains = Array.isArray(result?.authoritativeLifecycleDomains)
      ? result.authoritativeLifecycleDomains.map((domain) => normalizeHost(domain)).filter(Boolean)
      : [];
    const sourceFingerprints = Array.isArray(result?.authoritativeDetailFingerprints)
      ? result.authoritativeDetailFingerprints.filter(Boolean)
      : [];
    if (!companyKey || lifecycleDomains.length === 0 || sourceFingerprints.length === 0) continue;
    for (const domain of lifecycleDomains) {
      activeDomains.add(domain);
      authoritativeFingerprintsByScope.set(`${companyKey}|${domain}`, new Set(sourceFingerprints));
    }
  }
  if (activeDomains.size === 0) return { prunedExisting: existingJobs, removed: 0 };
  const scopeCompanyKeys = new Set(
    (Array.isArray(options.scopeCompanyKeys) ? options.scopeCompanyKeys : [])
      .map((k) => normalizeCompanyKey(k))
      .filter(Boolean)
  );
  const hasScopedCompanyKeys = scopeCompanyKeys.size > 0;

  const incomingFp = new Set((incomingJobs || []).map((j) => fingerprintJob(j)).filter(Boolean));
  const prunedExisting = [];
  let removed = 0;
  for (const job of existingJobs || []) {
    const domain = normalizeHost(hostOf(job?.url || ''));
    if (job?.source === 'Company Careers Crawler' && domain && activeDomains.has(domain)) {
      const key = normalizeCompanyKey(String(job?.companyKey || job?.company || ''));
      if (hasScopedCompanyKeys) {
        if (!scopeCompanyKeys.has(key)) {
          prunedExisting.push(job);
          continue;
        }
      }
      const fp = fingerprintJob(job);
      const authoritativeFingerprints = authoritativeFingerprintsByScope.get(`${key}|${domain}`);
      const isPresent = authoritativeFingerprints
        ? authoritativeFingerprints.has(fp)
        : incomingFp.has(fp);
      if (fp && !isPresent) {
        // Grace period before dropping a job absent from the authoritative
        // source snapshot (when explicitly declared) or this run's incoming
        // set. Mirrors mergePreserveLocaleData's silent-job-loss guard in
        // dedicated-crawler-common.mjs: a domain counting as "active" only
        // means SOME page scraped, not that every page did, so one run's
        // partial-page miss shouldn't be a permanent removal.
        const missStreak = (Number(job?.crawlerMissStreak) || 0) + 1;
        if (missStreak <= GRACE_PERIOD_MAX_MISSES) {
          prunedExisting.push({ ...job, crawlerMissStreak: missStreak });
          continue;
        }
        removed += 1;
        continue;
      }
      if (fp && job?.crawlerMissStreak) {
        // Job reappeared in the authoritative source or this run — clear a
        // streak left by a prior miss so
        // the grace period counts CONSECUTIVE misses, not cumulative ones.
        // Without this, mergeAndDeduplicate's `{ ...prev, ...next }` spread
        // downstream would carry the stale count forward forever, since the
        // freshly-scraped `next` job never has this field to overwrite it.
        const { crawlerMissStreak, ...rest } = job;
        prunedExisting.push(rest);
        continue;
      }
    }
    prunedExisting.push(job);
  }
  return { prunedExisting, removed };
}

// Job URLs known from a prior run, used by main() to skip re-fetching detail
// pages we already have data for (see knownJobUrls usage below). A job with
// an active crawlerMissStreak was NOT seen in a recent run and must be
// re-verified rather than trusted as still-known — otherwise its fingerprint
// never reappears in incomingJobs, the miss streak climbs every run
// regardless of whether the job is still live, and pruneStaleCrawlerJobs
// eventually evicts a job that may still genuinely be online (issue 4826).
function buildKnownJobUrlsSet(preloadedJobs) {
  return new Set(
    (Array.isArray(preloadedJobs) ? preloadedJobs : [])
      .filter((j) => !(Number(j?.crawlerMissStreak) > 0))
      .map((j) => canonicalizeJobUrl(j.url))
      .filter(Boolean)
  );
}

async function processCompany(company, hintsRegex, crawlerConfig, knownJobUrls = new Set()) {
  const result = {
    company: company.name,
    companyKey: company.key,
    companyDomain: normalizeHost(hostOf(company.website)),
    discoveredCareerPages: 0,
    scrapedJobPages: 0,
    extractedJobs: [],
    discardedCount: 0,
    discardedByReason: {},
    filteredOutCount: 0,
    filteredOutByReason: {},
    duplicateInCompany: 0,
    processedCandidates: 0,
    webDiscoveryQueries: 0,
    webDiscoveryHits: 0,
    webDiscoveryProviders: [],
    skippedKnownUrls: 0,
    browserFallbackAttempted: 0,
    browserFallbackHits: 0,
    browserFallbackReason: '',
  };
  const seenCompanyFingerprints = new Set();
  const adapter = getCompanyAdapter(company);
  if (adapter && adapter.enabled === false) {
    return result;
  }
  if (adapter?.authoritativeDetailSnapshot === true) {
    result.authoritativeLifecycleDomains = adapter.authoritativeLifecycleDomains;
    result.authoritativeDetailFingerprints = (adapter.seedDetailUrls || [])
      .map((url) => fingerprintJob({ url }))
      .filter(Boolean);
  }
  const defaultModes = ['workday', 'greenhouse', 'lever', 'smartrecruiters', 'generic_ats', 'teaser_api', 'jsonld', 'html'];
  const companyModeConfig =
    crawlerConfig?.companyCrawlerMode?.[normalizeCompanyKey(String(company.name || ''))] ??
    crawlerConfig?.companyCrawlerMode?.[normalizeCompanyKey(String(company.key || ''))] ??
    crawlerConfig?.companyCrawlerMode?.[String(company.name || '').toLowerCase()] ??
    crawlerConfig?.companyCrawlerMode?.[String(company.key || '').toLowerCase()] ??
    null;
  const adapterModes =
    Array.isArray(adapter?.crawlerModes) && adapter.crawlerModes.length > 0
      ? adapter.crawlerModes.map((m) => normalizeSpace(String(m || '')).toLowerCase()).filter(Boolean)
      : [];
  const enabledModes = new Set(
    (
      Array.isArray(companyModeConfig) && companyModeConfig.length > 0
        // Explicit per-company config wins (strict override).
        ? companyModeConfig
        // Adapter modes are additive hints; never disable default parsers implicitly.
        : [...new Set([...defaultModes, ...adapterModes])]
    )
      .map((m) => normalizeSpace(String(m || '')).toLowerCase())
      .filter(Boolean)
  );

  const registerDiscard = (reason) => {
    result.discardedCount += 1;
    result.discardedByReason[reason] = (result.discardedByReason[reason] || 0) + 1;
  };
  const registerFilteredOut = (reason, count = 1) => {
    const safeCount = Number.isFinite(Number(count)) ? Math.max(1, Math.floor(Number(count))) : 1;
    result.filteredOutCount += safeCount;
    result.filteredOutByReason[reason] = (result.filteredOutByReason[reason] || 0) + safeCount;
  };
  const registerDiscardReasons = (reasons) => {
    result.discardedCount += 1;
    for (const reason of reasons) {
      result.discardedByReason[reason] = (result.discardedByReason[reason] || 0) + 1;
    }
  };

  const companyKeyNormalized = normalizeCompanyKey(String(company?.key || company?.name || ''));
  const companyHostNormalized = normalizeHost(hostOf(String(company?.website || '')));
  const isVfCompany =
    companyKeyNormalized.includes('vf-international-the-north-face-timberland') ||
    companyKeyNormalized.includes('vf-international') ||
    companyHostNormalized.includes('vfc.com');

  const maybeAcceptCandidate = (job, originTag) => {
    if (!job) {
      registerDiscard(`${originTag}_parse_failed`);
      return;
    }
    result.processedCandidates += 1;
    const quality = evaluateJobQuality(job, {
      minQualityScore: crawlerConfig.minQualityScore,
      minDescriptionChars: crawlerConfig.minDescriptionChars,
    });
    if (!quality.accepted) {
      if (String(process.env.VERBOSE || '0') === '1') {
        const titleLen = (job.title || '').length;
        const descLen = (job.description || '').length;
        console.log(`   ⚠️  Discarded [${company.key}] "${job.title}" (title=${titleLen}ch, desc=${descLen}ch, score=${quality.score}/${crawlerConfig.minQualityScore}) reasons: ${quality.reasons.join(', ')}`);
      }
      registerDiscardReasons(quality.reasons);
      return;
    }
    const fp = fingerprintJob(job);
    if (fp && seenCompanyFingerprints.has(fp)) {
      result.duplicateInCompany += 1;
      registerDiscard('duplicate_in_company');
      return;
    }
    if (fp) seenCompanyFingerprints.add(fp);
    result.extractedJobs.push({
      ...job,
      companyKey: company.key,
      companyDomain: result.companyDomain,
    });
  };

  // Dedicated fast path for VF: rely on known Workday feed and skip generic discovery/sitemap scans.
  // This keeps the crawler stable and focused on real VF job detail pages.
  if (isVfCompany && enabledModes.has('workday')) {
    const vfWorkdayListingUrls = new Set();
    const seedUrls = getSeedUrlsForCompany(company, crawlerConfig);
    for (const seed of seedUrls) {
      if (parseWorkdaySource(seed)) vfWorkdayListingUrls.add(seed);
    }
    // Hard fallback source for VF Careers (Swiss jobs).
    vfWorkdayListingUrls.add('https://vfc.wd5.myworkdayjobs.com/vfc_careers?Location_Country=187134fccb084a0ea9b4b95f23890dbe');
    if (parseWorkdaySource(company.website)) vfWorkdayListingUrls.add(company.website);

    result.discoveredCareerPages = vfWorkdayListingUrls.size;
    for (const listingUrl of vfWorkdayListingUrls) {
      const source = parseWorkdaySource(listingUrl);
      if (!source) continue;
      let wdJobs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        wdJobs = await crawlWorkdayJobs(company, source, crawlerConfig, knownJobUrls);
      } catch {
        wdJobs = [];
      }
      for (const j of wdJobs) maybeAcceptCandidate(j, 'workday_vf');
      result.skippedKnownUrls += wdJobs.skippedKnown || 0;
    }
    return result;
  }

  let homepageHtml = '';
  const adapterSeeds = getSeedUrlsForCompany(company, crawlerConfig);
  const adapterDetailUrls = Array.isArray(adapter?.seedDetailUrls) ? adapter.seedDetailUrls : [];
  const hasAdapterSeeds = adapterSeeds.length > 0 || adapterDetailUrls.length > 0;
  try {
    const res = await fetchWithTimeout(company.website);
    if (!res.ok) {
      // Don't bail if adapter has seed URLs — they may be on a different host (e.g., jobs.migros.ch vs migros.ch)
      if (!hasAdapterSeeds) return result;
      console.warn(`  ⚠️ Homepage ${company.website} returned ${res.status}, proceeding with ${adapterSeeds.length + adapterDetailUrls.length} adapter seed URLs`);
    } else {
      homepageHtml = await res.text();
    }
  } catch (e) {
    if (!hasAdapterSeeds) return result;
    console.warn(`  ⚠️ Homepage ${company.website} unreachable (${e.message}), proceeding with ${adapterSeeds.length + adapterDetailUrls.length} adapter seed URLs`);
  }

  const candidateCareerUrls = new Set();
  const jobLinkSources = new Map();
  const addJobLink = (url, sourceTag) => {
    if (!url) return;
    if (!jobLinkSources.has(url)) jobLinkSources.set(url, sourceTag);
  };
  // Seed detail URLs: adapter-provided URLs that are individual job detail pages
  // (not listing pages). These go directly to jobLinks for HTML fallback extraction,
  // bypassing the generic ATS listing crawl which only extracts JSON-LD from "listing" pages.
  const seedDetailUrls = new Set();
  const workdayListingUrls = new Set(extractWorkdayListingUrls(homepageHtml, company.website));
  const greenhouseListingUrls = new Set(extractGreenhouseListingUrls(homepageHtml, company.website));
  const leverListingUrls = new Set(extractLeverListingUrls(homepageHtml, company.website));
  const smartRecruitersListingUrls = new Set(extractSmartRecruitersListingUrls(homepageHtml, company.website));
  const genericAtsListingUrls = new Set(extractGenericAtsListingUrls(homepageHtml, company.website));
  const teaserApiUrls = new Set(extractJobTeaserApiUrls(homepageHtml, company.website));
  const seedUrls = adapterSeeds;
  const webDiscovery = await discoverCareerUrlsFromWebSearch(company, crawlerConfig);
  const routeDiscoveredUrl = (rawUrl, sourceTag = 'discovery') => {
    const link = tryUrl(rawUrl, company.website);
    if (!link) return;
    if (parseWorkdaySource(link)) {
      workdayListingUrls.add(link);
      return;
    }
    if (parseGreenhouseSource(link)) {
      greenhouseListingUrls.add(link);
      return;
    }
    if (parseLeverSource(link)) {
      leverListingUrls.add(link);
      return;
    }
    if (parseSmartRecruitersSource(link)) {
      smartRecruitersListingUrls.add(link);
      return;
    }
    if (/\/api\/jobssearch\/search/i.test(link)) {
      teaserApiUrls.add(link);
      return;
    }
    if (isLikelyJobDetailUrl(link)) {
      seedDetailUrls.add(link);
      addJobLink(link, sourceTag);
      return;
    }
    const host = hostOf(link);
    if (isKnownAtsHost(host)) {
      genericAtsListingUrls.add(link);
      return;
    }
    if (sameHost(link, company.website) || CAREER_DISCOVERY_ATS_HOST_RE.test(link)) {
      candidateCareerUrls.add(link);
    }
  };
  
  result.webDiscoveryQueries = webDiscovery.queries || 0;
  result.webDiscoveryHits = webDiscovery.hits || 0;
  result.webDiscoveryProviders = Array.isArray(webDiscovery.providers) ? webDiscovery.providers : [];
  for (const p of CAREER_HINTS) {
    const url = tryUrl(p, company.website);
    if (url) routeDiscoveredUrl(url, 'career_hint');
  }
  for (const link of absoluteSameHostLinks(homepageHtml, company.website, hintsRegex)) {
    routeDiscoveredUrl(link, 'homepage');
  }
  for (const seed of seedUrls) {
    routeDiscoveredUrl(seed, 'adapter_seed');
  }
  // Adapter-declared detail URLs bypass isLikelyJobDetailUrl() classification
  for (const raw of adapterDetailUrls) {
    const link = tryUrl(raw, company.website);
    if (link) {
      seedDetailUrls.add(link);
      addJobLink(link, 'adapter_seed_detail');
    }
  }
  const sitemapCareerUrls = await discoverCareerUrlsFromSitemap(company.website);
  for (const link of sitemapCareerUrls) routeDiscoveredUrl(link, 'sitemap');
  for (const link of webDiscovery.urls) {
    routeDiscoveredUrl(link, 'web_search');
  }

  const discoverySignals =
    candidateCareerUrls.size +
    workdayListingUrls.size +
    greenhouseListingUrls.size +
    leverListingUrls.size +
    smartRecruitersListingUrls.size +
    genericAtsListingUrls.size +
    teaserApiUrls.size +
    seedDetailUrls.size;
  if (discoverySignals < 3 && BROWSER_FALLBACK_ENABLED) {
    result.browserFallbackAttempted = 1;
    const browserDiscovery = await discoverCareerUrlsWithBrowserFallback(company.website);
    result.browserFallbackReason = browserDiscovery.reason || '';
    for (const link of (browserDiscovery.urls || [])) {
      routeDiscoveredUrl(link, 'browser_fallback');
    }
    result.browserFallbackHits = Array.isArray(browserDiscovery.urls) ? browserDiscovery.urls.length : 0;
  }

  const careerUrls = [...candidateCareerUrls].slice(0, MAX_CAREER_PAGES_PER_COMPANY);
  result.discoveredCareerPages = careerUrls.length;


  const jobLinks = new Set();
  const jobPostingNodes = [];

  // Add adapter-provided job detail URLs directly to jobLinks.
  // These are individual vacancy pages (e.g., Umantis /Vacancies/ID/Description)
  // that should be fetched for HTML fallback extraction, not treated as listing pages.
  if (seedDetailUrls.size > 0) {
    for (const url of seedDetailUrls) {
      jobLinks.add(url);
      addJobLink(url, 'adapter_seed');
    }
    console.log(`  ℹ️ ${seedDetailUrls.size} discovery URLs routed as direct job detail pages`);
  }

  for (const pageUrl of careerUrls) {
    try {
      const res = await fetchWithTimeout(pageUrl, { userAgent: adapter?.userAgent });
      if (!res.ok) continue;
      const html = await res.text();
      for (const wd of extractWorkdayListingUrls(html, pageUrl)) workdayListingUrls.add(wd);
      for (const gh of extractGreenhouseListingUrls(html, pageUrl)) greenhouseListingUrls.add(gh);
      for (const lev of extractLeverListingUrls(html, pageUrl)) leverListingUrls.add(lev);
      for (const sr of extractSmartRecruitersListingUrls(html, pageUrl)) smartRecruitersListingUrls.add(sr);
      for (const ga of extractGenericAtsListingUrls(html, pageUrl)) genericAtsListingUrls.add(ga);
      for (const ta of extractJobTeaserApiUrls(html, pageUrl)) teaserApiUrls.add(ta);

      const blocks = extractJsonLdBlocks(html);
      for (const block of blocks) {
        const nodes = extractJobPostingNodes(block);
        for (const n of nodes) jobPostingNodes.push({ node: n, pageUrl });
      }

      const linkHints = /(job|jobs|career|careers|vacanc|position|offerta|lavor|stellen|emploi|candid)/i;
      for (const l of absoluteSameHostLinks(html, pageUrl, linkHints)) {
        if (isLikelyJobDetailUrl(l)) {
          jobLinks.add(l);
          addJobLink(l, 'career_page');
        }
      }
    } catch {
    }
  }

  // 0) Workday listing APIs (e.g., VF Careers) -> final job positions
  if (enabledModes.has('workday')) {
    for (const listingUrl of workdayListingUrls) {
      const source = parseWorkdaySource(listingUrl);
      if (!source) continue;
      let wdJobs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        wdJobs = await crawlWorkdayJobs(company, source, crawlerConfig, knownJobUrls);
      } catch {
        wdJobs = [];
      }
      for (const j of wdJobs) {
        maybeAcceptCandidate(j, 'workday');
      }
      result.skippedKnownUrls += wdJobs.skippedKnown || 0;
    }
  }

  // 0b) Greenhouse APIs
  if (enabledModes.has('greenhouse')) {
    for (const listingUrl of greenhouseListingUrls) {
      const source = parseGreenhouseSource(listingUrl);
      if (!source) continue;
      let ghJobs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        ghJobs = await crawlGreenhouseJobs(company, source);
      } catch {
        ghJobs = [];
      }
      for (const j of ghJobs) maybeAcceptCandidate(j, 'greenhouse');
    }
  }

  // 0c) Lever APIs
  if (enabledModes.has('lever')) {
    for (const listingUrl of leverListingUrls) {
      const source = parseLeverSource(listingUrl);
      if (!source) continue;
      let levJobs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        levJobs = await crawlLeverJobs(company, source);
      } catch {
        levJobs = [];
      }
      for (const j of levJobs) maybeAcceptCandidate(j, 'lever');
    }
  }

  // 0d) SmartRecruiters APIs
  if (enabledModes.has('smartrecruiters')) {
    for (const listingUrl of smartRecruitersListingUrls) {
      const source = parseSmartRecruitersSource(listingUrl);
      if (!source) continue;
      let srJobs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        srJobs = await crawlSmartRecruitersJobs(company, source);
      } catch {
        srJobs = [];
      }
      for (const j of srJobs) maybeAcceptCandidate(j, 'smartrecruiters');
    }
  }

  // 0e) Generic ATS / proprietary listings (multi-site fallback)
  if (enabledModes.has('generic_ats')) {
    for (const listingUrl of genericAtsListingUrls) {
      // Skip sources already handled by dedicated adapters
      if (listingUrl.includes('myworkdayjobs.com')) continue;
      if (listingUrl.includes('greenhouse.io')) continue;
      if (listingUrl.includes('lever.co')) continue;
      if (listingUrl.includes('smartrecruiters.com')) continue;
      let genericJobs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        genericJobs = await crawlGenericListingJobs(company, listingUrl, crawlerConfig, knownJobUrls, { userAgent: adapter?.userAgent });
      } catch {
        genericJobs = [];
      }
      for (const j of genericJobs) maybeAcceptCandidate(j, 'generic_ats');
      result.skippedKnownUrls += genericJobs.skippedKnown || 0;
      if ((genericJobs.truncatedByLimit || 0) > 0) {
        registerFilteredOut('generic_ats_detail_links_truncated_by_limit', genericJobs.truncatedByLimit);
      }
    }
  }

  // 0f) CMS teaser API (e.g. cler.ch jobssearch endpoint)
  if (enabledModes.has('teaser_api')) {
    for (const apiUrl of teaserApiUrls) {
      let apiJobs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        apiJobs = await crawlTeaserApiJobs(company, apiUrl);
      } catch {
        apiJobs = [];
      }
      for (const j of apiJobs) maybeAcceptCandidate(j, 'teaser_api');
    }
  }

  // 1) Structured data extraction (best quality)
  if (enabledModes.has('jsonld')) {
    for (const { node, pageUrl } of jobPostingNodes) {
      const parsed = toJobFromJsonLd(node, company.name, pageUrl);
      if (!parsed) continue;
      if (parsed.reason) {
        registerFilteredOut(parsed.reason);
        continue;
      }
      maybeAcceptCandidate(parsed.job, 'jsonld');
    }
  }

  // 2) Fallback on job detail pages when JSON-LD is absent
  if (enabledModes.has('html') && jobLinks.size > 0) {
    const allLinks = [...jobLinks];
    // seedDetailUrls bypass skip-optimization: they must always be re-fetched
    // so that _targetScope metadata is present for the merge exclusion bypass.
    const unknownLinks = knownJobUrls.size > 0
      ? allLinks.filter((u) => seedDetailUrls.has(u) || !knownJobUrls.has(canonicalizeJobUrl(u)))
      : allLinks;
    const links = unknownLinks.slice(0, MAX_JOB_LINKS_PER_COMPANY);
    result.skippedKnownUrls += allLinks.length - unknownLinks.length;
    if (unknownLinks.length > links.length) {
      registerFilteredOut('html_detail_links_truncated_by_limit', unknownLinks.length - links.length);
    }
    for (const detailUrl of links) {
      try {
        const seedMeta = getAdapterSeedMetaForUrl(adapter, detailUrl);
        const res = await fetchWithTimeout(detailUrl, { userAgent: adapter?.userAgent });
        if (!res.ok) continue;
        const html = await res.text();
        const sourceTag = jobLinkSources.get(detailUrl) || 'detail_link';
        const signals = quickJobPageSignals(html, detailUrl);
        // When a detail page embeds JSON-LD JobPosting (e.g. Prospective career center SPAs),
        // extract it directly instead of relying on toJobFromHtmlFallback which may fail on
        // SPA shells with generic <title>/<h1> tags.
        if (signals.hasJsonLdJob) {
          const detailNodes = extractJobPostingNodes(extractJsonLdBlocks(html));
          let jsonLdAccepted = false;
          for (const node of detailNodes) {
            const parsed = toJobFromJsonLd(node, company.name, detailUrl, {
              seedMeta,
              isSeedDetail: seedDetailUrls.has(detailUrl),
            });
            if (parsed && !parsed.reason && parsed.job) {
              // Migros pages embed JSON-LD with only the brief overview description.
              // The full sections (tasks, skills, benefits) live in the SSR HTML.
              // Enrich the job description with the structured HTML content when
              // the page is from jobs.migros.ch and richer data is available.
              if (/jobs\.migros\.ch/i.test(detailUrl)) {
                const migrosData = extractMigrosStructuredData(html);
                if (migrosData) {
                  if ((migrosData.description?.length || 0) > (parsed.job.description?.length || 0)) {
                    parsed.job.description = migrosData.description;
                  }
                  if (migrosData.requirements.length > (parsed.job.requirements?.length || 0)) {
                    parsed.job.requirements = migrosData.requirements;
                  }
                  parsed.job._migrosResponsibilities = migrosData.responsibilities;
                  parsed.job._migrosBenefits = migrosData.benefits;
                  parsed.job._migrosWorkPercentage = migrosData.workPercentage;
                }
              }
              maybeAcceptCandidate(parsed.job, 'jsonld');
              result.scrapedJobPages += 1;
              jsonLdAccepted = true;
            }
          }
          if (jsonLdAccepted) continue;
          // JSON-LD present but all nodes rejected (e.g. location filter) — skip HTML fallback.
          // Falling through to toJobFromHtmlFallback would produce the same rejection
          // (same page text, same isTicinoRelevant check) and inflate filteredOutCount.
          registerFilteredOut('jsonld_rejected_all_nodes');
          continue;
        }
        const mustAiCheck = !seedDetailUrls.has(detailUrl) && (sourceTag === 'web_search' || (!signals.hasJsonLdJob && (signals.positive <= 1 || signals.negative > 0)));
        if (mustAiCheck) {
          // eslint-disable-next-line no-await-in-loop
          const gate = await aiValidateJobDetailPage({ html, pageUrl: detailUrl, companyName: company.name });
          if (!gate.isJob) {
            registerFilteredOut('ai_not_job_detail');
            continue;
          }
        }
        const isSeedDetail = seedDetailUrls.has(detailUrl);
        const parsed = toJobFromHtmlFallback(html, detailUrl, company.name, company.city || 'Ticino', { seedMeta, isSeedDetail });
        if (parsed.reason) {
          registerFilteredOut(parsed.reason);
          continue;
        }
        maybeAcceptCandidate(parsed.job, 'html');
        result.scrapedJobPages += 1;
      } catch {
        // ignore
      }
    }
  }

  return result;
}

function loadCrawlerConfig(inputCfg = null) {
  const envWhitelist = String(process.env.JOBS_CRAWLER_DOMAIN_WHITELIST || '')
    .split(',')
    .map((x) => normalizeHost(x))
    .filter(Boolean);
  const envBlacklist = String(process.env.JOBS_CRAWLER_DOMAIN_BLACKLIST || '')
    .split(',')
    .map((x) => normalizeHost(x))
    .filter(Boolean);
  const defaults = {
    domainWhitelist: envWhitelist,
    domainBlacklist: envBlacklist,
    companyPriority: {
      byDomain: {},
      byName: {},
    },
    sourceSeeds: {
      byDomain: {
        'vfc.com': [
          'https://vfc.wd5.myworkdayjobs.com/vfc_careers?Location_Country=187134fccb084a0ea9b4b95f23890dbe',
        ],
        'swatchgroup.com': [
          'https://www.swatchgroup.com/en/job-finder?jf_country=40',
        ],
        'ubs.com': [
          'https://www.ubs.com/global/en/careers/search-jobs.html',
          'https://www.ubs.com/global/en/careers.html',
        ],
        'schindler.com': [
          'https://job.schindler.com',
          'https://www.schindler.com/com/internet/en/careers.html',
        ],
        'avaloq.com': [
          'https://www.avaloq.com/careers',
        ],
        'nozominetworks.com': [
          'https://www.nozominetworks.com/company/careers/',
        ],
        'medacta.com': [
          'https://www.medacta.com/EN/careers',
        ],
        'cler.ch': [
          'https://www.cler.ch/it/banca-cler/jobs-und-karriere/cercare-candidatura/offene-stellen',
        ],
      },
      byName: {},
    },
    companyCrawlerMode: {},
    minQualityScore: clampNum(process.env.JOBS_MIN_QUALITY_SCORE, 4, 10, 6),
    minDescriptionChars: clampNum(process.env.JOBS_MIN_DESCRIPTION_CHARS, 80, 1200, 220),
    aiLocalizationEnabled: String(process.env.JOBS_AI_LOCALIZATION_ENABLED || '1') !== '0',
    aiLocalizationMaxJobsPerRun: clampNum(process.env.JOBS_AI_MAX_JOBS_PER_RUN, 0, 500, 300),
    aiPageValidationEnabled: String(process.env.JOBS_AI_PAGE_VALIDATION_ENABLED || '1') !== '0',
    aiPageValidationMaxPagesPerRun: clampNum(process.env.JOBS_AI_PAGE_VALIDATION_MAX_PAGES_PER_RUN, 0, 1000, 80),
    webDiscoveryEnabled: String(process.env.JOBS_WEB_DISCOVERY_ENABLED || '1') !== '0',
    contentReuse: {
      enabled: String(process.env.JOBS_CONTENT_REUSE_ENABLED || '1') !== '0',
      similarityThreshold: clampFloat(process.env.JOBS_CONTENT_REUSE_SIMILARITY_THRESHOLD, 0.7, 1, 0.93),
      minSourceChars: clampNum(process.env.JOBS_CONTENT_REUSE_MIN_SOURCE_CHARS, 120, 8000, 220),
      maxLengthDeltaRatio: clampFloat(process.env.JOBS_CONTENT_REUSE_MAX_LENGTH_DELTA_RATIO, 0.02, 1, 0.2),
    },
  };
  const fileCfg = inputCfg && typeof inputCfg === 'object' ? inputCfg : readJson(CRAWLER_CONFIG_PATH, {});
  const cfg = {
    ...defaults,
    ...(fileCfg && typeof fileCfg === 'object' ? fileCfg : {}),
  };
  const byDomain = cfg.companyPriority?.byDomain || {};
  const byName = cfg.companyPriority?.byName || {};
  const seedByDomain = normalizeSeedMap(cfg.sourceSeeds?.byDomain || {});
  const seedByName = normalizeSeedMap(cfg.sourceSeeds?.byName || {});
  cfg.companyPriority = {
    byDomain,
    byName,
  };
  cfg.sourceSeeds = {
    byDomain: seedByDomain,
    byName: seedByName,
  };
  cfg.companyCrawlerMode = (cfg.companyCrawlerMode && typeof cfg.companyCrawlerMode === 'object')
    ? cfg.companyCrawlerMode
    : {};
  cfg.contentReuse = {
    ...defaults.contentReuse,
    ...((cfg.contentReuse && typeof cfg.contentReuse === 'object') ? cfg.contentReuse : {}),
  };
  cfg.domainWhitelist = Array.isArray(cfg.domainWhitelist) ? cfg.domainWhitelist.map(normalizeHost).filter(Boolean) : [];
  cfg.domainBlacklist = Array.isArray(cfg.domainBlacklist) ? cfg.domainBlacklist.map(normalizeHost).filter(Boolean) : [];
  if (envWhitelist.length > 0) cfg.domainWhitelist = envWhitelist;
  if (envBlacklist.length > 0) cfg.domainBlacklist = envBlacklist;
  cfg.minQualityScore = clampNum(cfg.minQualityScore, 4, 10, defaults.minQualityScore);
  cfg.minDescriptionChars = clampNum(cfg.minDescriptionChars, 80, 1200, defaults.minDescriptionChars);
  if (process.env.JOBS_MIN_DESCRIPTION_CHARS !== undefined) {
    cfg.minDescriptionChars = clampNum(process.env.JOBS_MIN_DESCRIPTION_CHARS, 80, 1200, defaults.minDescriptionChars);
  }
  if (process.env.JOBS_MIN_QUALITY_SCORE !== undefined) {
    cfg.minQualityScore = clampNum(process.env.JOBS_MIN_QUALITY_SCORE, 4, 10, defaults.minQualityScore);
  }
  if (process.env.JOBS_AI_LOCALIZATION_ENABLED !== undefined) {
    cfg.aiLocalizationEnabled = String(process.env.JOBS_AI_LOCALIZATION_ENABLED || '1') !== '0';
  }
  if (process.env.JOBS_AI_MAX_JOBS_PER_RUN !== undefined) {
    cfg.aiLocalizationMaxJobsPerRun = clampNum(process.env.JOBS_AI_MAX_JOBS_PER_RUN, 0, 500, defaults.aiLocalizationMaxJobsPerRun);
  }
  if (process.env.JOBS_AI_PAGE_VALIDATION_ENABLED !== undefined) {
    cfg.aiPageValidationEnabled = String(process.env.JOBS_AI_PAGE_VALIDATION_ENABLED || '1') !== '0';
  }
  if (process.env.JOBS_AI_PAGE_VALIDATION_MAX_PAGES_PER_RUN !== undefined) {
    cfg.aiPageValidationMaxPagesPerRun = clampNum(
      process.env.JOBS_AI_PAGE_VALIDATION_MAX_PAGES_PER_RUN,
      0,
      1000,
      defaults.aiPageValidationMaxPagesPerRun
    );
  }
  if (process.env.JOBS_WEB_DISCOVERY_ENABLED !== undefined) {
    cfg.webDiscoveryEnabled = String(process.env.JOBS_WEB_DISCOVERY_ENABLED || '1') !== '0';
  }
  if (process.env.JOBS_CONTENT_REUSE_ENABLED !== undefined) {
    cfg.contentReuse.enabled = String(process.env.JOBS_CONTENT_REUSE_ENABLED || '1') !== '0';
  }
  if (process.env.JOBS_CONTENT_REUSE_SIMILARITY_THRESHOLD !== undefined) {
    cfg.contentReuse.similarityThreshold = clampFloat(
      process.env.JOBS_CONTENT_REUSE_SIMILARITY_THRESHOLD,
      0.7,
      1,
      defaults.contentReuse.similarityThreshold
    );
  }
  if (process.env.JOBS_CONTENT_REUSE_MIN_SOURCE_CHARS !== undefined) {
    cfg.contentReuse.minSourceChars = clampNum(
      process.env.JOBS_CONTENT_REUSE_MIN_SOURCE_CHARS,
      120,
      8000,
      defaults.contentReuse.minSourceChars
    );
  }
  if (process.env.JOBS_CONTENT_REUSE_MAX_LENGTH_DELTA_RATIO !== undefined) {
    cfg.contentReuse.maxLengthDeltaRatio = clampFloat(
      process.env.JOBS_CONTENT_REUSE_MAX_LENGTH_DELTA_RATIO,
      0.02,
      1,
      defaults.contentReuse.maxLengthDeltaRatio
    );
  }
  cfg.aiLocalizationEnabled = Boolean(cfg.aiLocalizationEnabled) && isAnyModelAvailable();
  cfg.aiPageValidationEnabled = Boolean(cfg.aiPageValidationEnabled) && isAnyModelAvailable();
  cfg.aiPageValidationMaxPagesPerRun = clampNum(cfg.aiPageValidationMaxPagesPerRun, 0, 1000, defaults.aiPageValidationMaxPagesPerRun);
  cfg.aiLocalizationMaxJobsPerRun = clampNum(cfg.aiLocalizationMaxJobsPerRun, 0, 500, defaults.aiLocalizationMaxJobsPerRun);
  cfg.webDiscoveryEnabled = Boolean(cfg.webDiscoveryEnabled);
  cfg.contentReuse.enabled = Boolean(cfg.contentReuse.enabled);
  cfg.contentReuse.similarityThreshold = clampFloat(
    cfg.contentReuse.similarityThreshold,
    0.7,
    1,
    defaults.contentReuse.similarityThreshold
  );
  cfg.contentReuse.minSourceChars = clampNum(
    cfg.contentReuse.minSourceChars,
    120,
    8000,
    defaults.contentReuse.minSourceChars
  );
  cfg.contentReuse.maxLengthDeltaRatio = clampFloat(
    cfg.contentReuse.maxLengthDeltaRatio,
    0.02,
    1,
    defaults.contentReuse.maxLengthDeltaRatio
  );
  return cfg;
}

async function loadCrawlerConfigFromFirestore() {
  const enabled = process.env.JOBS_CRAWLER_USE_FIRESTORE_CONFIG === '1';
  if (!enabled) return null;
  try {
    const adminMod = await import('firebase-admin');
    const admin = adminMod.default || adminMod;
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
    const fsAdmin = admin.firestore();
    const snap = await fsAdmin.doc(CRAWLER_FIRESTORE_DOC).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data || typeof data !== 'object') return null;
    console.log(`☁️  Loaded crawler config override from Firestore (${CRAWLER_FIRESTORE_DOC})`);
    return data;
  } catch (err) {
    console.warn(`⚠️  Firestore crawler config unavailable (${err?.message || err}) — using local file config`);
    return null;
  }
}

function mergeCrawlerConfig(baseCfg, overrideCfg) {
  if (!overrideCfg || typeof overrideCfg !== 'object') return baseCfg;
  const merged = {
    ...baseCfg,
    ...overrideCfg,
    companyPriority: {
      ...(baseCfg.companyPriority || {}),
      ...((overrideCfg.companyPriority && typeof overrideCfg.companyPriority === 'object') ? overrideCfg.companyPriority : {}),
      byDomain: {
        ...(baseCfg.companyPriority?.byDomain || {}),
        ...((overrideCfg.companyPriority?.byDomain && typeof overrideCfg.companyPriority.byDomain === 'object') ? overrideCfg.companyPriority.byDomain : {}),
      },
      byName: {
        ...(baseCfg.companyPriority?.byName || {}),
        ...((overrideCfg.companyPriority?.byName && typeof overrideCfg.companyPriority.byName === 'object') ? overrideCfg.companyPriority.byName : {}),
      },
    },
    sourceSeeds: {
      ...(baseCfg.sourceSeeds || {}),
      ...((overrideCfg.sourceSeeds && typeof overrideCfg.sourceSeeds === 'object') ? overrideCfg.sourceSeeds : {}),
      byDomain: {
        ...(baseCfg.sourceSeeds?.byDomain || {}),
        ...((overrideCfg.sourceSeeds?.byDomain && typeof overrideCfg.sourceSeeds.byDomain === 'object') ? overrideCfg.sourceSeeds.byDomain : {}),
      },
      byName: {
        ...(baseCfg.sourceSeeds?.byName || {}),
        ...((overrideCfg.sourceSeeds?.byName && typeof overrideCfg.sourceSeeds.byName === 'object') ? overrideCfg.sourceSeeds.byName : {}),
      },
    },
    discoveryNameBlacklist: Array.isArray(overrideCfg.discoveryNameBlacklist)
      ? overrideCfg.discoveryNameBlacklist
      : baseCfg.discoveryNameBlacklist,
    discoveryWhitelistDomains: Array.isArray(overrideCfg.discoveryWhitelistDomains)
      ? overrideCfg.discoveryWhitelistDomains
      : baseCfg.discoveryWhitelistDomains,
    discoveryWhitelistNames: Array.isArray(overrideCfg.discoveryWhitelistNames)
      ? overrideCfg.discoveryWhitelistNames
      : baseCfg.discoveryWhitelistNames,
  };
  return merged;
}

function getSeedUrlsForCompany(company, cfg) {
  const host = normalizeHost(hostOf(company.website));
  const base = host ? (cfg.sourceSeeds?.byDomain?.[host] || []) : [];
  const byName = cfg.sourceSeeds?.byName?.[String(company.name || '').toLowerCase()] || [];
  const adapter = getCompanyAdapter(company);
  const adapterSeeds = Array.isArray(adapter?.seedUrls) ? adapter.seedUrls : [];
  const raw = [...base, ...byName, ...adapterSeeds];
  const urls = [];
  for (const item of raw) {
    const u = tryUrl(item, company.website);
    if (u) urls.push(u);
  }
  return [...new Set(urls)];
}

function companyPriorityScore(company, cfg) {
  const host = normalizeHost(hostOf(company.website));
  const byDomain = Number(cfg.companyPriority?.byDomain?.[host] || 0);
  const byName = Number(cfg.companyPriority?.byName?.[String(company.name || '').toLowerCase()] || 0);
  const adapter = getCompanyAdapter(company);
  const adapterBoost = Number(adapter?.priority || 0);
  return byDomain + byName + adapterBoost;
}

function applyCompanySelection(companies, cfg) {
  const whitelist = new Set(cfg.domainWhitelist || []);

  const selected = [];
  const dropped = [];
  for (const c of companies) {
    const host = normalizeHost(hostOf(c.website));
    if (!host) {
      dropped.push({ company: c.name, domain: host, reason: 'invalid_host' });
      continue;
    }
    if (whitelist.size > 0 && !whitelist.has(host)) {
      dropped.push({ company: c.name, domain: host, reason: 'not_in_whitelist' });
      continue;
    }
    selected.push({ ...c, __priority: companyPriorityScore(c, cfg), __domain: host });
  }

  selected.sort((a, b) => {
    if (b.__priority !== a.__priority) return b.__priority - a.__priority;
    return b.employees - a.employees;
  });
  return { selected, dropped };
}

function writeAuditLog(audit) {
  writeJson(AUDIT_PATH, audit);
}

async function runWithConcurrency(items, worker, concurrency) {
  const out = new Array(items.length);
  let i = 0;
  async function runner() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      // eslint-disable-next-line no-await-in-loop
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return out;
}

function updateMeta({ totalJobs, companiesCrawled, extracted, inserted, refreshed, startedAt }) {
  const prev = readJson(META_PATH, {});
  const next = {
    ...prev,
    lastUpdated: new Date().toISOString(),
    totalJobs,
    crawler: {
      ...prev.crawler,
      lastRun: new Date().toISOString(),
      startedAt,
      companiesCrawled,
      extracted,
      inserted,
      refreshed,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxCompanies: MAX_COMPANIES,
      maxConcurrency: MAX_CONCURRENCY,
    },
    sources: {
      ...(prev.sources || {}),
      companyCareerCrawler: extracted,
    },
  };
  writeJson(META_PATH, next);
}

async function runHousekeeping() {
  const script = path.resolve(ROOT, 'scripts', 'cleanup-jobs.mjs');
  if (!fs.existsSync(script)) return;
  await execFileAsync('node', [script], { cwd: ROOT, maxBuffer: 1024 * 1024 * 4 });
}

async function main() {
  const startedAt = new Date().toISOString();
  aiLocalizationCalls = 0;
  aiPageValidationCalls = 0;
  deeplFallbackToLlm = 0;
  aiCacheHits = 0;
  aiCacheMisses = 0;
  const loadedAiCacheEntries = loadPersistentAiCache();
  const localCfg = loadCrawlerConfig();
  const firestoreCfg = await loadCrawlerConfigFromFirestore();
  const crawlerConfig = loadCrawlerConfig(mergeCrawlerConfig(localCfg, firestoreCfg));
  crawlerConfigGlobal = crawlerConfig;
  companyAdaptersGlobal = loadCompanyAdapters();
  // Only persist config when running as a real crawler, not as LOCALIZE_EXISTING_ONLY.
  // The translate-pending pipeline sets ephemeral env overrides (JOBS_AI_MAX_JOBS_PER_RUN)
  // that would corrupt the on-disk config if written back (e.g., maxJobsPerRun=1 for a
  // single-company batch overwrites the real value of 9).
  const isLocalizeOnly = String(process.env.JOBS_CRAWLER_LOCALIZE_EXISTING_ONLY || '') === '1';
  if (!isLocalizeOnly) {
    writeJson(CRAWLER_CONFIG_PATH, crawlerConfig);
  }
  // Suppress the full config banner on repeat calls in LOCALIZE_EXISTING_ONLY mode
  if (!isLocalizeOnly || !_bannerPrintedOnce) {
    console.log('💼 Ticino company careers crawler');
    console.log(`ℹ️  timeout=${REQUEST_TIMEOUT_MS}ms companies<=${MAX_COMPANIES} concurrency=${MAX_CONCURRENCY}`);
    console.log(`ℹ️  qualityGate score>=${crawlerConfig.minQualityScore} desc>=${crawlerConfig.minDescriptionChars} chars`);
    console.log(`ℹ️  aiLocalization=${crawlerConfig.aiLocalizationEnabled ? 'on' : 'off'} maxJobs=${crawlerConfig.aiLocalizationMaxJobsPerRun}`);
    console.log(
      `ℹ️  contentReuse=${crawlerConfig.contentReuse?.enabled ? 'on' : 'off'} similarity>=${crawlerConfig.contentReuse?.similarityThreshold}`
      + ` minChars>=${crawlerConfig.contentReuse?.minSourceChars} maxDelta<=${crawlerConfig.contentReuse?.maxLengthDeltaRatio}`
    );
    console.log(`ℹ️  aiPageValidation=${crawlerConfig.aiPageValidationEnabled ? 'on' : 'off'} maxPages=${crawlerConfig.aiPageValidationMaxPagesPerRun}`);
    console.log(`ℹ️  webDiscovery=${crawlerConfig.webDiscoveryEnabled ? 'on' : 'off'} maxQueries/company=${WEB_DISCOVERY_MAX_QUERIES_PER_COMPANY}`);
    console.log(`ℹ️  browserFallback=${BROWSER_FALLBACK_ENABLED ? 'on' : 'off'} timeout=${BROWSER_FALLBACK_TIMEOUT_MS}ms`);
    console.log(`ℹ️  aiCacheDisk=${AI_CACHE_PERSIST_ENABLED ? 'on' : 'off'} loadedEntries=${loadedAiCacheEntries}`);
    console.log(`ℹ️  companyAdapters=${companyAdaptersGlobal.size}`);
    if (isLocalizeOnly) _bannerPrintedOnce = true;
  }

  if (!fs.existsSync(COMPANIES_TSX)) {
    throw new Error(`Missing companies source: ${COMPANIES_TSX}`);
  }

  const tsx = fs.readFileSync(COMPANIES_TSX, 'utf-8');
  const companiesFromMap = parseCompanySourcesFromTsx(tsx);
  const extraCompanies = loadExtraCompanies();
  const companies = dedupeAndSortCompanies([...companiesFromMap, ...extraCompanies]).map((c) => ({
    ...c,
    key: c.key || normalizeKey(c.name || '').slice(0, 64),
  }));
  if (companies.length === 0) {
    throw new Error('No company websites found in TicinoCompanies.tsx');
  }
  const { selected: configuredCompanies, dropped: droppedCompanies } = applyCompanySelection(companies, crawlerConfig);
  const requestedCompanyKeys = String(process.env.JOBS_CRAWLER_COMPANY_KEYS || process.env.JOBS_CRAWLER_COMPANY_KEY || '')
    .split(',')
    .map((x) => normalizeKey(x || '').slice(0, 64))
    .filter(Boolean);
  const excludedCompanyKeys = String(process.env.JOBS_CRAWLER_EXCLUDE_COMPANY_KEYS || process.env.JOBS_CRAWLER_EXCLUDE_COMPANY_KEY || '')
    .split(',')
    .map((x) => normalizeKey(x || '').slice(0, 64))
    .filter(Boolean);
  const requestedSet = new Set(requestedCompanyKeys);
  const excludedSet = new Set(excludedCompanyKeys);
  const selectedByKey = requestedSet.size > 0
    ? configuredCompanies.filter((c) => requestedSet.has(c.key))
    : configuredCompanies;
  const selectedWithoutExcluded = excludedSet.size > 0
    ? selectedByKey.filter((c) => !excludedSet.has(c.key))
    : selectedByKey;
  const companiesToCrawl = selectedWithoutExcluded.slice(0, MAX_COMPANIES);
  console.log(`📚 Parsed ${companiesFromMap.length} censused companies + ${extraCompanies.length} extra companies`);
  console.log(`🎯 Company selection: ${companiesToCrawl.length} selected, ${droppedCompanies.length} dropped by whitelist`);
  if (requestedSet.size > 0) {
    const missingRequested = [...requestedSet].filter((k) => !companiesToCrawl.some((c) => c.key === k));
    console.log(`🧷 Company key filter active: requested=${requestedSet.size} resolved=${companiesToCrawl.length}`);
    if (missingRequested.length > 0) {
      if (isLocalizeOnly) {
        // In LOCALIZE_EXISTING_ONLY mode, company keys from per-crawler slices
        // may not exist in TicinoCompanies.tsx or extra companies. This is fine:
        // translation uses the job's companyKey directly, not the company census.
        console.log(`ℹ️  Company keys not in census (OK in localize-only mode): ${missingRequested.join(', ')}`);
      } else {
        console.warn(`⚠️  Missing company keys: ${missingRequested.join(', ')}`);
      }
    }
  }
  if (excludedSet.size > 0) {
    console.log(`🚫 Company key exclusion active: excluded=${[...excludedSet].join(', ')}`);
  }
  const scopedCompanyKeysForRun = new Set(
    requestedCompanyKeys
      .map((k) => normalizeCompanyKey(k))
      .filter(Boolean)
  );
  const hasScopedCompanyKeysForRun = scopedCompanyKeysForRun.size > 0;
  const isInScopedCompaniesForRun = (job) => {
    if (!hasScopedCompanyKeysForRun) return true;
    const key = normalizeCompanyKey(String(job?.companyKey || job?.company || ''));
    return scopedCompanyKeysForRun.has(key);
  };
  const geoScopeFingerprint = (job) =>
    fingerprintJob(job) ||
    `${normalizeSpace(job?.title || '').toLowerCase()}|${normalizeSpace(job?.company || '').toLowerCase()}|${normalizeSpace(job?.location || '').toLowerCase()}|${normalizeSpace(job?.url || '').toLowerCase()}`;

  const localizeExistingOnly = String(process.env.JOBS_CRAWLER_LOCALIZE_EXISTING_ONLY || '0') === '1';
  let results = [];
  let incomingJobs = [];
  let companiesCrawled = 0;
  let discoveredCareerPages = 0;
  let scrapedJobPages = 0;
  let discardedTotal = 0;
  let filteredOutTotal = 0;
  let duplicateInCompanyTotal = 0;
  let webDiscoveryQueriesTotal = 0;
  let webDiscoveryHitsTotal = 0;
  let skippedKnownUrlsTotal = 0;
  let browserFallbackAttemptsTotal = 0;
  let browserFallbackHitsTotal = 0;

  if (localizeExistingOnly) {
    // Only log on first invocation — message is identical every time
  } else {
    // Pre-load known job URLs to skip re-crawling detail pages already in data/jobs.json
    // Fall back to per-crawler slices when data/jobs.json is absent (CI environment)
    let _preloadedJobs = readJson(DATA_JOBS, null);
    if (_preloadedJobs === null) {
      _preloadedJobs = readExistingJobsFromSlices(requestedCompanyKeys);
      if (_preloadedJobs.length > 0) {
        console.log(`📂 data/jobs.json absent — loaded ${_preloadedJobs.length} jobs from per-crawler slices for URL skip-optimization`);
      }
    }
    const knownJobUrls = buildKnownJobUrlsSet(_preloadedJobs);
    if (knownJobUrls.size > 0) {
      console.log(`⏩ Known job URLs loaded for skip-optimization: ${knownJobUrls.size}`);
    }

    const hintsRegex = /(career|careers|jobs|job|vacanc|offerta|lavor|karriere|stellen|emploi|candid|join-us|work-with-us)/i;
    results = await runWithConcurrency(
      companiesToCrawl,
      (company) => processCompany(company, hintsRegex, crawlerConfig, knownJobUrls),
      MAX_CONCURRENCY
    );
    incomingJobs = results.flatMap((r) => r.extractedJobs);
    if (incomingJobs.length > 0 && crawlerConfig.aiLocalizationEnabled) {
      console.log(`🌐 AI localization deferred: processing ${incomingJobs.length} extracted jobs after merge/dedup`);
    }
    companiesCrawled = results.length;
    discoveredCareerPages = results.reduce((sum, r) => sum + r.discoveredCareerPages, 0);
    scrapedJobPages = results.reduce((sum, r) => sum + r.scrapedJobPages, 0);
    discardedTotal = results.reduce((sum, r) => sum + r.discardedCount, 0);
    filteredOutTotal = results.reduce((sum, r) => sum + r.filteredOutCount, 0);
    duplicateInCompanyTotal = results.reduce((sum, r) => sum + r.duplicateInCompany, 0);
    webDiscoveryQueriesTotal = results.reduce((sum, r) => sum + (r.webDiscoveryQueries || 0), 0);
    webDiscoveryHitsTotal = results.reduce((sum, r) => sum + (r.webDiscoveryHits || 0), 0);
    skippedKnownUrlsTotal = results.reduce((sum, r) => sum + (r.skippedKnownUrls || 0), 0);
    browserFallbackAttemptsTotal = results.reduce((sum, r) => sum + (r.browserFallbackAttempted || 0), 0);
    browserFallbackHitsTotal = results.reduce((sum, r) => sum + (r.browserFallbackHits || 0), 0);

    console.log(`🔎 Discovered career pages: ${discoveredCareerPages}`);
    console.log(`🔎 Scraped job detail pages: ${scrapedJobPages}`);
    if (skippedKnownUrlsTotal > 0) console.log(`⏩ Skipped detail pages (already known): ${skippedKnownUrlsTotal}`);
    console.log(`✅ Extracted jobs from company sites: ${incomingJobs.length}`);
    console.log(`🧪 Discarded candidates (quality/thin/relevance): ${discardedTotal}`);
    // ── Detailed discard breakdown by reason ──
    if (discardedTotal > 0) {
      const aggregatedReasons = {};
      for (const r of results) {
        for (const [reason, count] of Object.entries(r.discardedByReason || {})) {
          aggregatedReasons[reason] = (aggregatedReasons[reason] || 0) + count;
        }
      }
      const sortedReasons = Object.entries(aggregatedReasons).sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of sortedReasons) {
        console.log(`   ├─ ${reason}: ${count}`);
      }
      // Per-company detail for companies with discards
      const companiesWithDiscards = results
        .filter((r) => r.discardedCount > 0)
        .sort((a, b) => b.discardedCount - a.discardedCount);
      if (companiesWithDiscards.length > 0) {
        console.log(`   └─ Per-company breakdown:`);
        for (const r of companiesWithDiscards) {
          const reasons = Object.entries(r.discardedByReason || {}).map(([k, v]) => `${k}=${v}`).join(', ');
          console.log(`      ${r.company}: ${r.discardedCount} (${reasons})`);
        }
      }
    }
    console.log(`🪄 Filtered non-candidate pages (not real job details): ${filteredOutTotal}`);
    if (filteredOutTotal > 0) {
      const aggregatedFilteredReasons = {};
      for (const r of results) {
        for (const [reason, count] of Object.entries(r.filteredOutByReason || {})) {
          aggregatedFilteredReasons[reason] = (aggregatedFilteredReasons[reason] || 0) + count;
        }
      }
      const sortedFilteredReasons = Object.entries(aggregatedFilteredReasons).sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of sortedFilteredReasons) {
        console.log(`   ├─ ${reason}: ${count}`);
      }
      const companiesWithFiltered = results
        .filter((r) => r.filteredOutCount > 0)
        .sort((a, b) => b.filteredOutCount - a.filteredOutCount);
      if (companiesWithFiltered.length > 0) {
        console.log(`   └─ Per-company filtered breakdown:`);
        for (const r of companiesWithFiltered) {
          const reasons = Object.entries(r.filteredOutByReason || {}).map(([k, v]) => `${k}=${v}`).join(', ');
          console.log(`      ${r.company}: ${r.filteredOutCount} (${reasons})`);
        }
      }
    }
    console.log(`🧩 Duplicates inside company crawl: ${duplicateInCompanyTotal}`);
    console.log(`🌐 Web discovery: queries=${webDiscoveryQueriesTotal}, hits=${webDiscoveryHitsTotal}`);
    console.log(`🧭 Browser fallback discovery: attempts=${browserFallbackAttemptsTotal}, hits=${browserFallbackHitsTotal}`);
  }

  const extracted = incomingJobs.length;

  // Read existing jobs from data/jobs.json — or fall back to per-crawler slices.
  // In CI, data/jobs.json is gitignored and absent. Without this fallback,
  // existingJobs=[] causes mergeAndDeduplicate to lose all translated titles/slugs.
  let existingJobs = readJson(DATA_JOBS, null);
  if (existingJobs === null) {
    existingJobs = readExistingJobsFromSlices(requestedCompanyKeys);
    if (existingJobs.length > 0) {
      console.log(`📂 data/jobs.json absent — loaded ${existingJobs.length} existing jobs from per-crawler slices`);
    } else {
      existingJobs = [];
    }
  }
  if (!Array.isArray(existingJobs)) {
    throw new Error(`${DATA_JOBS} must contain an array`);
  }
  const beforeSnapshot = snapshotJobSlugs(existingJobs);

  const skipStalePrune =
    localizeExistingOnly || String(process.env.JOBS_CRAWLER_SKIP_STALE_PRUNE || '0') === '1';
  const { prunedExisting, removed: prunedStaleCrawlerJobs } = skipStalePrune
    ? { prunedExisting: existingJobs, removed: 0 }
    : pruneStaleCrawlerJobs(existingJobs, incomingJobs, results, { scopeCompanyKeys: requestedCompanyKeys });
  if (!skipStalePrune && prunedStaleCrawlerJobs > 0) {
    console.log(`🧽 Pruned stale crawler jobs from active domains: ${prunedStaleCrawlerJobs}`);
  }
  if (skipStalePrune && !localizeExistingOnly) {
    console.log('🛡️ Stale prune skipped (JOBS_CRAWLER_SKIP_STALE_PRUNE=1).');
  }

  const mergeResult = mergeAndDeduplicate(prunedExisting, incomingJobs, {
    minQualityScore: crawlerConfig.minQualityScore,
    minDescriptionChars: crawlerConfig.minDescriptionChars,
  }, {
    scopeCompanyKeys: requestedCompanyKeys,
    contentReuse: crawlerConfig.contentReuse,
    localizeExistingOnly: localizeExistingOnly,
  });
  let merged = mergeResult.merged;
  const {
    inserted,
    refreshed,
    duplicateIncoming,
    duplicateExisting,
    insertedByCompany,
    refreshedByCompany,
    duplicateByCompany,
    reusedLocalizationFromPrevious,
    mergeExcludedJobs,
    mergeExclusionByReason,
    mergeExclusionSamples,
  } = mergeResult;

  // Backfill localization for existing records still missing locale coverage.
  const hasForcedLocalizationMerged = merged.some((job) => shouldForceLocalizationForJob(job));
  if ((crawlerConfig.aiLocalizationEnabled || hasForcedLocalizationMerged) && merged.length > 0) {
    const canUseAi = isAnyModelAvailable();
    const forceRelocalizeAll = String(process.env.JOBS_FORCE_RELOCALIZE_ALL || '0') === '1';
    const localizationConcurrency = clampNum(
      process.env.JOBS_AI_LOCALIZATION_CONCURRENCY,
      1,
      6,
      (localizeExistingOnly || hasForcedLocalizationMerged) ? 2 : 1
    );
    const queue = merged.filter((job) => {
      if (!isLocalizationAllowedForJob(job)) return false;
      // In localize-existing-only mode with scoped company keys, only translate
      // jobs from the scoped companies. Without this restriction, the translation
      // budget is spent on random jobs from all companies — translations land in
      // gitignored jobs.json and never reach the target company's per-crawler file.
      if (localizeExistingOnly && hasScopedCompanyKeysForRun && !isInScopedCompaniesForRun(job)) return false;
      const forceLocalization = shouldForceLocalizationForJob(job);
      // Respect JOBS_AI_LOCALIZATION_ENABLED=0 for non-forced companies only.
      if (!crawlerConfig.aiLocalizationEnabled && !forceLocalization) return false;
      if (!canUseAi && !forceLocalization) return false;
      const missingDesc = localeTextCoverage(job?.descriptionByLocale || {}, 120) < LOCALES.length;
      const missingTitle = localeTextCoverage(job?.titleByLocale || {}, 3) < LOCALES.length;
      const reqByLocale = (job?.requirementsByLocale && typeof job.requirementsByLocale === 'object')
        ? job.requirementsByLocale
        : {};
      const reqCoverage = LOCALES.filter((locale) => {
        const req = reqByLocale[locale];
        return Array.isArray(req) && req.length > 0;
      }).length;
      const sourceReqCount = Array.isArray(job?.requirements) ? job.requirements.length : 0;
      const hasAnyLocaleReq = Object.values(reqByLocale).some((req) => Array.isArray(req) && req.length > 0);
      const shouldEnforceReqCoverage = sourceReqCount > 0 || hasAnyLocaleReq;
      const missingReq = shouldEnforceReqCoverage && reqCoverage < LOCALES.length;
      const untranslatedDesc = hasUntranslatedLocaleDescriptions(job);
      const untranslatedTitle = hasUntranslatedLocaleTitles(job);
      const hasTitleWork = missingTitle || untranslatedTitle;
      const hasDescriptionWork = missingDesc || missingReq || untranslatedDesc;
      const needsLocalization = (
        hasDescriptionWork ||
        hasTitleWork
      );
      const shouldForceLocalization = forceLocalization && (forceRelocalizeAll || needsLocalization);
      // FRO-327 bypass: jobs explicitly flagged for retranslation must enter the
      // queue even if coverage checks pass — the flag indicates quality issues
      // (contamination, source copies) that coverage-based checks miss.
      const flaggedForRetranslation = !!job.needsRetranslation;
      const sourceDescLength = normalizeSpace(job?.description || '').length;
      return (
        needsLocalization ||
        shouldForceLocalization ||
        flaggedForRetranslation
      ) && (sourceDescLength >= 160 || hasTitleWork || flaggedForRetranslation);
    });
    if (queue.length > 0) {
      // Prioritize: 1) needsRetranslation jobs (translation pipeline targets),
      // 2) recently-scraped jobs, 3) everything else.
      // This ensures the limited budget goes to actually-incomplete jobs first.
      const incomingFps = new Set(incomingJobs.map(fingerprintJob).filter(Boolean));
      queue.sort((a, b) => {
        const aNeedsRetrans = a.needsRetranslation ? 0 : 1;
        const bNeedsRetrans = b.needsRetranslation ? 0 : 1;
        if (aNeedsRetrans !== bNeedsRetrans) return aNeedsRetrans - bNeedsRetrans;
        const aNew = incomingFps.has(fingerprintJob(a)) ? 0 : 1;
        const bNew = incomingFps.has(fingerprintJob(b)) ? 0 : 1;
        return aNew - bNew;
      });
      const maxJobs = crawlerConfig?.aiLocalizationMaxJobsPerRun || 0;
      const remainingBudget = Math.max(0, maxJobs - aiLocalizationCalls);
      const selectedQueue = queue.slice(0, remainingBudget || 0);
      if (selectedQueue.length > 0) {
        console.log(`🌐 Backfill localization queue: ${selectedQueue.length}/${queue.length} jobs (concurrency=${localizationConcurrency})`);
      }
      // Opt-in wall-clock budget for the AI-localization loop. Default UNSET /
      // 0 / non-finite ⇒ NO budget (unlimited) so the 300+ normal dedicated
      // crawlers (which never set it and finish in minutes) are UNAFFECTED.
      // When set (translate-pending sets ~280min, well under its 350min job
      // timeout), once elapsed wall-clock since loop start exceeds it we STOP
      // starting NEW jobs: the per-item callback early-returns the job UNCHANGED
      // (still flagged needsRetranslation/incomplete so the next run retries it)
      // instead of calling the AI. In-flight items finish normally. This keeps
      // the step from being killed at the hard job timeout, which would skip the
      // commit step and LOSE work. Jobs localized BEFORE the budget hit keep
      // their results (returned by the pipeline + captured by the per-company
      // incremental fs.writeFileSync in relocalize-pending-jobs.mjs).
      const rawLocalizationTimeBudgetMs = Number(process.env.JOBS_AI_LOCALIZATION_TIME_BUDGET_MS);
      const localizationTimeBudgetMs =
        Number.isFinite(rawLocalizationTimeBudgetMs) && rawLocalizationTimeBudgetMs > 0
          ? rawLocalizationTimeBudgetMs
          : 0;
      const localizationLoopStart = Date.now();
      let localizationDeferredCount = 0;
      let localizationBudgetLogged = false;
      const enrichedMap = new Map();
      if (selectedQueue.length > 0) {
        // Load registry once for post-AI pinning enforcement: mergeAndDeduplicate
        // pinned slugs from the immutable registry, but enrichJobLocalesWithRetry
        // can re-derive slugByLocale from a freshly AI-translated title. Without
        // re-pinning here the AI's slug wins and the SEO bridge / canonical
        // mismatch returns (old URL serves a page whose H1+canonical point at
        // the new slug). Demote any AI-derived drift to previousSlugsByLocale so
        // legacy URLs keep resolving via the slug-map.
        const postAiRegistry = loadSlugRegistry();
        const localizedEntries = await runWithConcurrency(
          selectedQueue.map((job, index) => ({ job, index })),
          async ({ job, index }) => {
            // Wall-clock budget guard: once the budget is exceeded, stop
            // starting NEW jobs — return the job UNCHANGED (no AI call) so it
            // stays flagged needsRetranslation/incomplete and the next run
            // retries it. In-flight items already past this check finish.
            if (localizationTimeBudgetMs > 0
                && (Date.now() - localizationLoopStart) > localizationTimeBudgetMs) {
              localizationDeferredCount++;
              if (!localizationBudgetLogged) {
                localizationBudgetLogged = true;
                const budgetMin = Math.round(localizationTimeBudgetMs / 60_000);
                console.log(`⏰ [localize] time budget ${budgetMin}min reached — ${selectedQueue.length - index} jobs deferred to next run`);
              }
              return { fp: fingerprintJob(job), enriched: job };
            }
            if (shouldForceLocalizationForJob(job)) {
              console.log(`🔁 Backfill forced localization ${index + 1}/${selectedQueue.length}: ${job.slug || job.id || 'unknown'}`);
            }
            // FRO-prev-slug-attribution: snapshot pre-AI slugs so post-AI slug
            // changes get captured into previousSlugsByLocale. Without this,
            // AI-driven title rewrites (e.g. needsRetranslation → Turner from
            // Lathe Operator) lost the old slug because hardenLocalesAcrossFile
            // is the only path that calls captureLostSlugs.
            const _preAiSlug = job.slug;
            const _preAiSlugByLocale = job.slugByLocale ? { ...job.slugByLocale } : {};
            const enriched = await enrichJobLocalesWithRetry(job, crawlerConfig);
            if (enriched && (enriched.slug !== _preAiSlug || _slugByLocaleDiffer(enriched.slugByLocale, _preAiSlugByLocale))) {
              captureLostSlugs(enriched, _preAiSlugByLocale, _preAiSlug);
            }
            // Re-pin registry over any AI-derived slug drift (Fix 1B). Mirrors
            // the source-copy guard in mergeAndDeduplicate: skip per-locale
            // entries whose registry value is just a copy of the source-locale
            // slug (no real translation was registered) so AI's new
            // translation isn't reverted to the source slug.
            if (enriched) {
              const pin = getRegisteredSlug(enriched, postAiRegistry);
              if (pin && pin.canonicalSlug) {
                const aiSlugByLocale = enriched.slugByLocale ? { ...enriched.slugByLocale } : {};
                const aiSlug = enriched.slug || '';
                const srcLang = enriched.sourceLang || null;
                if (!enriched.slugByLocale || typeof enriched.slugByLocale !== 'object') {
                  enriched.slugByLocale = {};
                }
                if (pin.slugByLocale && typeof pin.slugByLocale === 'object') {
                  // Per-locale source-copy rule lives in registryPinnedLocaleSlug
                  // (single definition shared with mergeAndDeduplicate,
                  // hardenJobLocaleFields, and regenerate-slugs-by-locale).
                  const pinCtx = sourceSlugPinContext(enriched, srcLang);
                  for (const loc of Object.keys(pin.slugByLocale)) {
                    const pinned = registryPinnedLocaleSlug(pin, loc, srcLang, pinCtx);
                    if (pinned) enriched.slugByLocale[loc] = pinned;
                  }
                }
                // Master slug serves the IT path (regenerate-slugs-by-locale.mjs
                // keeps job.slug in sync with slugByLocale.it), so pin it through
                // the SAME registryPinnedLocaleSlug source-copy guard used for
                // every other locale above instead of comparing raw
                // pin.canonicalSlug against pin.slugByLocale[srcLang] — those two
                // registry fields can legitimately differ (e.g. disambiguator
                // hash present on one but not the other) even when both were
                // frozen pre-translation, which silently defeated the old
                // equality check and re-pinned an untranslated master slug over
                // a real IT translation on every subsequent run (issues #3785 /
                // #3794).
                const pinnedMasterSlug = registryPinnedLocaleSlug(pin, 'it', srcLang, sourceSlugPinContext(enriched, srcLang));
                if (pinnedMasterSlug) enriched.slug = pinnedMasterSlug;
                captureLostSlugs(enriched, aiSlugByLocale, aiSlug);
              }
            }
            return { fp: fingerprintJob(job), enriched };
          },
          localizationConcurrency
        );
        for (const entry of localizedEntries) {
          if (!entry?.fp) continue;
          enrichedMap.set(entry.fp, entry.enriched);
        }
      }
      if (enrichedMap.size > 0) {
        merged = merged.map((job) => enrichedMap.get(fingerprintJob(job)) || job);
      }
    }
  }
  // ensureLocaleFields normalizes locale slots for newly crawled jobs.
  // In LOCALIZE_EXISTING_ONLY mode (translate-pending), skip it entirely —
  // existing jobs already have correct locale fields. Running ensureLocaleFields
  // on them DESTROYS correct translations by overwriting with heuristic translations
  // (e.g. "Hebamme" → "Ostetrica/o", "Organizational Specialist" → "Specialista Organizzativo")
  // and re-flags 140+ complete jobs with needsRetranslation every run.
  if (!localizeExistingOnly) {
    merged = merged.map((job) => ensureLocaleFields(job));
  }

  // ── Geocoding verification: verify locations via Google Maps ───────────
  // Centralized check that ALL crawler types benefit from.
  // Only geocodes ambiguous locations not already verified by text-based filters.
  // Skip when JOBS_SKIP_GEOCODING=1.
  if (!localizeExistingOnly && process.env.JOBS_SKIP_GEOCODING !== '1') {
    if (hasScopedCompanyKeysForRun) {
      const scopedJobs = merged.filter((job) => isInScopedCompaniesForRun(job));
      const beforeGeoCount = scopedJobs.length;
      const geoResult = await filterJobsByGeolocation(scopedJobs);
      const keepScopedFingerprints = new Set(
        geoResult.filtered
          .map((job) => geoScopeFingerprint(job))
          .filter(Boolean)
      );
      merged = merged.filter((job) => {
        if (!isInScopedCompaniesForRun(job)) return true;
        return keepScopedFingerprints.has(geoScopeFingerprint(job));
      });
      if (geoResult.removedCount > 0) {
        console.log(`🗺️  Geocoding filter (scoped): removed ${geoResult.removedCount} jobs in selected company keys (${beforeGeoCount} → ${geoResult.filtered.length})`);
      }
    } else {
      const beforeGeoCount = merged.length;
      const geoResult = await filterJobsByGeolocation(merged);
      merged = geoResult.filtered;
      if (geoResult.removedCount > 0) {
        console.log(`🗺️  Geocoding filter: removed ${geoResult.removedCount} jobs (${beforeGeoCount} → ${merged.length})`);
      }
    }
  } else if (!localizeExistingOnly) {
    console.log(`🗺️  Geocoding filter: SKIPPED (JOBS_SKIP_GEOCODING=1)`);
  }

  // ── URL validation: verify source URLs are still live ──────────────────
  // Only validate newly inserted jobs (existing ones are checked by housekeeping).
  // Skip validation when JOBS_SKIP_URL_VALIDATION=1.
  if (!localizeExistingOnly && process.env.JOBS_SKIP_URL_VALIDATION !== '1' && inserted > 0) {
    const insertedFpSet = new Set(
      incomingJobs
        .filter((j) => {
          const fp = fingerprintJob(j);
          // A job is "new" if its fingerprint was not in the pre-merge existing set
          return fp && !existingJobs.some((e) => fingerprintJob(e) === fp);
        })
        .map((j) => fingerprintJob(j))
        .filter(Boolean)
    );
    const jobsToValidate = merged.filter((j) => insertedFpSet.has(fingerprintJob(j)));
    if (jobsToValidate.length > 0) {
      console.log(`🔗 Validating URLs for ${jobsToValidate.length} newly inserted jobs…`);
      const validationResults = await validateJobUrls(
        jobsToValidate.map((j) => ({ id: j.id || fingerprintJob(j), url: j.url })),
        { concurrency: MAX_CONCURRENCY, timeoutMs: REQUEST_TIMEOUT_MS }
      );
      const invalidIds = new Set();
      for (const vr of validationResults) {
        if (!vr.valid) {
          console.log(`   ❌ ${vr.id}: ${vr.reason} (${vr.status || '?'})`);
          invalidIds.add(vr.id);
        }
      }
      if (invalidIds.size > 0) {
        const beforeCount = merged.length;
        merged = merged.filter((j) => {
          const jId = j.id || fingerprintJob(j);
          return !invalidIds.has(jId);
        });
        console.log(`🚫 Removed ${beforeCount - merged.length} jobs with dead URLs at publish time`);
      } else {
        console.log(`✅ All ${jobsToValidate.length} new job URLs validated successfully`);
      }
    }
  }

  // IMPORTANT: keep crawler output raw (sanitize/strip only).
  // Salary/address enrichment must run only in scripts/re-enrich-jobs.mjs (single source of truth).
  // Skip stripCopyPasteLocales in LOCALIZE_EXISTING_ONLY mode — blanking copy-paste locales
  // without being able to AI-retranslate them destroys data. The translate-pending pipeline
  // is the translation pass; stripping should only happen during real crawl runs.
  let strippedCount = 0;
  const mergedEnriched = merged
    .map(sanitizeJobStrings)
    .map((job) => {
      if (localizeExistingOnly) return job;
      const before = JSON.stringify(job.titleByLocale || {}) + JSON.stringify(job.descriptionByLocale || {});
      const out = stripCopyPasteLocales(job);
      const after = JSON.stringify(out.titleByLocale || {}) + JSON.stringify(out.descriptionByLocale || {});
      if (before !== after) strippedCount++;
      return out;
    })
    .map(stripCrawlerInternalFields);
  if (strippedCount > 0) {
    console.log(`⚠️  stripCopyPasteLocales modified ${strippedCount}/${merged.length} jobs (titles/descriptions blanked)`);
  }
  writeJson(DATA_JOBS, mergedEnriched, { compact: true });
  writeJson(PUBLIC_JOBS, mergedEnriched, { compact: true });
  updateMeta({ totalJobs: merged.length, companiesCrawled, extracted, inserted, refreshed, startedAt });

  const audit = {
    generatedAt: new Date().toISOString(),
    startedAt,
    config: {
      minQualityScore: crawlerConfig.minQualityScore,
      minDescriptionChars: crawlerConfig.minDescriptionChars,
      aiLocalizationEnabled: crawlerConfig.aiLocalizationEnabled,
      aiLocalizationMaxJobsPerRun: crawlerConfig.aiLocalizationMaxJobsPerRun,
      contentReuse: crawlerConfig.contentReuse,
      aiPageValidationEnabled: crawlerConfig.aiPageValidationEnabled,
      aiPageValidationMaxPagesPerRun: crawlerConfig.aiPageValidationMaxPagesPerRun,
      webDiscoveryEnabled: crawlerConfig.webDiscoveryEnabled,
      browserFallbackEnabled: BROWSER_FALLBACK_ENABLED,
      domainWhitelistCount: crawlerConfig.domainWhitelist.length,
      domainBlacklistCount: crawlerConfig.domainBlacklist.length,
      source: firestoreCfg ? 'firestore+file' : 'file',
    },
    totals: {
      companiesParsed: companies.length,
      companiesSelected: companiesToCrawl.length,
      companiesDroppedBySelection: droppedCompanies.length,
      companiesCrawled,
      discoveredCareerPages,
      scrapedJobPages,
      incomingCandidatesAccepted: extracted,
      discardedCandidates: discardedTotal,
      filteredOutNonCandidates: filteredOutTotal,
      duplicateInCompany: duplicateInCompanyTotal,
      webDiscoveryQueries: webDiscoveryQueriesTotal,
      webDiscoveryHits: webDiscoveryHitsTotal,
      browserFallbackAttempts: browserFallbackAttemptsTotal,
      browserFallbackHits: browserFallbackHitsTotal,
      duplicateIncoming,
      duplicateExisting,
      mergeExcludedJobs,
      mergeExclusionByReason,
      reusedLocalizationFromPrevious,
      inserted,
      refreshed,
      mergedTotal: merged.length,
      aiLocalizationCalls,
      aiPageValidationCalls,
      deeplFallbackToLlm,
      aiCacheHits,
      aiCacheMisses,
      aiCacheEntries: aiResponseCache.size,
      discoveredCompaniesCandidates: 0,
      discoveredCompaniesAdded: 0,
      discoveredCompaniesPending: 0,
    },
    byCompany: results
      .map((r) => ({
        company: r.company,
        domain: r.companyDomain,
        discoveredCareerPages: r.discoveredCareerPages,
        scrapedJobPages: r.scrapedJobPages,
        processedCandidates: r.processedCandidates,
        extractedAccepted: r.extractedJobs.length,
        discardedCount: r.discardedCount,
        discardedByReason: r.discardedByReason,
        filteredOutCount: r.filteredOutCount,
        filteredOutByReason: r.filteredOutByReason,
        duplicateInCompany: r.duplicateInCompany,
        webDiscoveryQueries: r.webDiscoveryQueries,
        webDiscoveryHits: r.webDiscoveryHits,
        webDiscoveryProviders: r.webDiscoveryProviders,
        browserFallbackAttempted: r.browserFallbackAttempted,
        browserFallbackHits: r.browserFallbackHits,
        browserFallbackReason: r.browserFallbackReason,
        inserted: insertedByCompany[r.company] || 0,
        refreshed: refreshedByCompany[r.company] || 0,
        duplicateIncoming: duplicateByCompany[r.company] || 0,
      }))
      .sort((a, b) => (b.inserted + b.refreshed) - (a.inserted + a.refreshed)),
    droppedCompanies,
    mergeExclusionSamples,
  };
  writeAuditLog(audit);

  if (!localizeExistingOnly) {
    console.log(`🧩 Merged jobs total: ${merged.length} (inserted=${inserted}, refreshed=${refreshed}, duplicateIncoming=${duplicateIncoming}, duplicateExisting=${duplicateExisting})`);
    if (mergeExcludedJobs > 0) {
      const ordered = Object.entries(mergeExclusionByReason || {})
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ');
      console.log(`🚫 Excluded at merge: ${mergeExcludedJobs}${ordered ? ` (${ordered})` : ''}`);
    }
    console.log(`🧾 Audit written: ${path.relative(ROOT, AUDIT_PATH)}`);
  }
  const shouldSkipHousekeeping =
    process.env.JOBS_SKIP_HOUSEKEEPING === '1' ||
    localizeExistingOnly ||
    hasScopedCompanyKeysForRun;
  if (shouldSkipHousekeeping) {
    // Only log the skip reason when NOT in localize-only mode (where it's always skipped)
    if (!localizeExistingOnly) {
      const reasons = [];
      if (process.env.JOBS_SKIP_HOUSEKEEPING === '1') reasons.push('JOBS_SKIP_HOUSEKEEPING=1');
      if (hasScopedCompanyKeysForRun) reasons.push('scoped-company-run');
      console.log(`⏭️  Skipping jobs housekeeping (${reasons.join(', ')})`);
    }
  } else {
    console.log('🧹 Running jobs housekeeping...');
    await runHousekeeping();
  }

  // Log AI model stats & scoreboard — suppress when stats haven't changed since last print
  const aiStats = getAiStats();
  const currentAiCallCount = aiStats.calls;
  const statsChanged = currentAiCallCount !== _lastPrintedAiCallCount;

  if (statsChanged || !localizeExistingOnly) {
    console.log(`\n🤖 AI Model Stats: ${aiStats.calls} calls, ${aiStats.successes} successes, ${aiStats.retries} retries, ${aiStats.fallbacks} fallbacks, ${aiStats.exhausted} exhausted (store: ${aiStats.storeBackend})`);
    console.log(`🈯 Free translate fallback_to_llm=${deeplFallbackToLlm}`);
    logCascadeSummary();
    const mmStats = getMyMemoryStats();
    console.log(`🌐 MyMemory Stats: chars_used=${mmStats.dailyChars}/${mmStats.limit}`);
    const localLocalizationStats = getJobLocalizationPipelineStats();
    console.log(
      `🏠 Local localization: memory_hits=${localLocalizationStats.memoryHits}, memory_misses=${localLocalizationStats.memoryMisses}, ` +
      `entries=${localLocalizationStats.memoryEntries}, providers=` +
      `nllb:${localLocalizationStats.providersConfigured.nllb ? 'on' : 'off'}/` +
      `libre:${localLocalizationStats.providersConfigured.libretranslate ? 'on' : 'off'}/` +
      `ollama:${localLocalizationStats.providersConfigured.ollama ? 'on' : 'off'}`
    );
    if (aiStats.scoreBoard.length > 0) {
      console.log('📊 Model Scoreboard (top 10):');
      aiStats.scoreBoard.slice(0, 10).forEach(({ model, score, successes, failures }, i) =>
        console.log(`   ${i + 1}. ${model}: ${score >= 0 ? '+' : ''}${score} (✓${successes || 0} ✗${failures || 0})`)
      );
    }
    if (aiStats.exhaustedModels.length > 0) {
      console.log(`🚫 Exhausted: ${aiStats.exhaustedModels.join(', ')}`);
    }
    // FRO-325: full run summary (cache hits, provider cooldowns, 429
    // streaks, error count) — superset of the calls/successes/retries
    // lines above, not tracked anywhere else in this pipeline (#3091).
    printRunSummary();
    _lastPrintedAiCallCount = currentAiCallCount;
  }

  // Flush persistent scores to Firestore before exit
  await flushScores();
  persistAiCacheToDisk();
  if (statsChanged || !localizeExistingOnly) {
    console.log(`💾 AI cache stats: hits=${aiCacheHits}, misses=${aiCacheMisses}, entries=${aiResponseCache.size}`);
  }

  
  // Print crawl change summary (new/updated/removed)
  // Dedicated crawlers may post-process jobs after this base run.
  // In those cases, this summary can reflect temporary noisy fields.
  if (String(process.env.JOBS_SKIP_CRAWL_CHANGE_SUMMARY || '0') !== '1') {
    const afterSnapshot = snapshotJobSlugs(mergedEnriched);
    const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
    printCrawlChangeSummary(crawlDiff, 'Generic Crawler');
    writeCrawlChangeSummaryToGH(crawlDiff, 'Generic Crawler');
  } else if (!localizeExistingOnly) {
    console.log('⏭️  Crawl change summary skipped (JOBS_SKIP_CRAWL_CHANGE_SUMMARY=1).');
  }

  console.log('✅ Jobs crawler completed');
}

// Export main for in-process invocation (used by dedicated-crawler-common.mjs)
export { main as runSharedCrawlerPipeline };

// Test-only internals (see scripts/lib/*-job-parser.mjs __internals/__testables
// convention). Exposes aiValidateJobDetailPage — module-private in production —
// plus the small hooks needed to drive it in isolation: crawlerConfigGlobal is
// normally only set by main(), and aiResponseCache is a module-singleton
// in-memory Map that must be reset between test cases (#3080).
export const __testables = {
  aiValidateJobDetailPage,
  fetchWithTimeout,
  buildKnownJobUrlsSet,
  pruneStaleCrawlerJobs,
  absoluteLinks,
  absoluteSameHostLinks,
  // Canton mis-tagging guard: the JSON-LD → job mapper and the
  // addressCountry-vs-seedCanton precedence predicate it relies on.
  toJobFromJsonLd,
  toJobFromHtmlFallback,
  processCompany,
  extractHtmlMicrodataAddress,
  isJsonLdCountryExplicitlyForeign,
  setCrawlerConfigForTests(cfg) { crawlerConfigGlobal = cfg; },
  setCompanyAdaptersForTests(adapters) { companyAdaptersGlobal = adapters; },
  clearAiResponseCacheForTests() { aiResponseCache.clear(); },
  persistAiCacheToDisk,
  loadPersistentAiCache,
  trimAiCacheEntriesToByteBudget,
  resolveAiCacheDiskMaxBytes,
  AI_CACHE_DISK_MAX_BYTES_DEFAULT,
  seedAiCacheForTests(entries) {
    aiCacheLoaded = true;
    aiCacheDirty = true;
    for (const { key, touchedAt, value } of entries) {
      aiResponseCache.set(key, { touchedAt, value });
    }
  },
  resetAiCacheStateForTests() {
    aiResponseCache.clear();
    aiCacheLoaded = false;
    aiCacheDirty = false;
    aiCacheLoadedEntries = 0;
  },
};

// Auto-run only when executed directly (not imported as module)
const isDirectExecution = typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectExecution) {
  main().catch(async (err) => {
    try {
      persistAiCacheToDisk({ force: true });
    } catch {
      // ignore cache persist failures on fatal exit
    }
    // The ledger has to be flushed HERE and not left to `beforeExit`:
    // `process.exit()` below skips that hook entirely, and every model
    // outcome recorded during this run — including the failures that led
    // to the crash, which are the most informative ones the ledger can
    // hold — would leave with the process. This is the same defect the
    // PR removes from create-article.mjs, and this file is the engine
    // imported by dedicated-crawler-common.mjs and by the ~hundreds of
    // scripts/update-*-jobs.mjs, so it carries far more of the traffic.
    // Bounded and non-throwing by construction (see flushScoresBeforeExit),
    // so a hung Firestore client cannot hold the runner open.
    await flushScoresBeforeExit();
    console.error('❌ Jobs crawler failed:', err?.message || err);
    process.exit(1);
  });
}
