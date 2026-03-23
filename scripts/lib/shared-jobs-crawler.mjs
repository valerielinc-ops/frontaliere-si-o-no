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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { callLLM, isAnyModelAvailable, getStats as getAiStats, initScoreStore, flushScores } from './ai-models.mjs';
import { validateJobUrls } from './validate-job-url.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH } from '../jobs-url-helper.mjs';
import { detectJobTitleLang, detectJobTitleLocaleDetails } from './job-locale-utils.mjs';
import { heuristicTranslateJobTitle, detectLang, normalizeKey, guessCategory, normalizeContract, qualityScore, evaluateJobQuality, isLikelyGenericCareerTitle, isLikelyJobDetailUrl } from './dedicated-crawler-common.mjs';
import {
  getJobLocalizationPipelineStats,
  localizeJobContentWithPipeline,
  translateTextWithLocalPipeline,
} from './job-localization-pipeline.mjs';
import { translateWithMyMemory, getMyMemoryStats } from './mymemory-translate.mjs';
import { parseSupsiJobDetail } from './supsi-job-parser.mjs';
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

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const COMPANIES_TSX = path.resolve(ROOT, 'components', 'vita', 'TicinoCompanies.tsx');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const META_PATH = path.resolve(ROOT, 'data', 'jobs-meta.json');
const CRAWLER_CONFIG_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-config.json');
const AUDIT_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-audit.json');
const EXTRA_COMPANIES_PATH = path.resolve(ROOT, 'data', 'ticino-companies-extra.json');

const ADAPTERS_REGISTRY_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'registry.json');
const ADAPTERS_BASE_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters');
const CRAWLER_FIRESTORE_DOC = 'admin_config/jobsCrawler';
const AI_CACHE_PATH = path.resolve(ROOT, 'data', 'jobs-ai-cache.json');

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
const MAX_JOB_LINKS_PER_COMPANY = clampNum(process.env.JOBS_CRAWLER_MAX_JOB_LINKS, 1, 500, 40);
const MAX_CONCURRENCY = clampNum(process.env.JOBS_CRAWLER_CONCURRENCY, 1, 12, 6);
const MAX_DESC_CHARS = 12000;
const MAX_CAREER_PAGES_PER_COMPANY = clampNum(process.env.JOBS_CRAWLER_MAX_CAREER_PAGES, 2, 20, 8);
const MAX_GENERIC_LISTING_PAGES = clampNum(process.env.JOBS_CRAWLER_MAX_GENERIC_LISTING_PAGES, 2, 20, 8);
const MAX_GENERIC_DETAIL_PAGES_PER_COMPANY = clampNum(process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES, 2, 500, 12);
const FETCH_RETRY_ATTEMPTS = clampNum(process.env.JOBS_CRAWLER_FETCH_RETRIES, 0, 4, 2);
const FETCH_RETRY_BASE_MS = clampNum(process.env.JOBS_CRAWLER_FETCH_RETRY_BASE_MS, 100, 5000, 350);
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const AI_LOCALIZATION_TIMEOUT_MS = clampNum(process.env.JOBS_AI_TIMEOUT_MS, 5000, 60000, 20000);
// AI availability is checked via centralized isAnyModelAvailable() from ai-models.mjs
// (covers all 4 providers: GitHub Models, Gemini, Groq, OpenRouter)
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const GOOGLE_CSE_API_KEY = normalizeSpace(process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_API_KEY || '');
const GOOGLE_CSE_CX = normalizeSpace(process.env.GOOGLE_CSE_CX || '');
const GOOGLE_MAPS_API_KEY = normalizeSpace(process.env.GOOGLE_MAPS_API_KEY || '');
// Moved to GOOGLE_TRANSLATE_ENDPOINTS array inside translateChunkGoogle
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
const FORCE_LOCALIZE_COMPANY_KEYS = new Set(
  String(process.env.JOBS_CRAWLER_FORCE_LOCALIZE_KEYS !== undefined
    ? process.env.JOBS_CRAWLER_FORCE_LOCALIZE_KEYS
    : 'vf-international-the-north-face-timberland,banca-cler')
    .split(',')
    .map((x) => normalizeCompanyKey(x))
    .filter(Boolean)
);
const FORCE_LOCALIZE_WORKDAY = String(process.env.JOBS_FORCE_LOCALIZE_WORKDAY || '1') !== '0';
const LOCALIZE_ONLY_COMPANY_KEYS = new Set(
  String(process.env.JOBS_CRAWLER_LOCALIZE_ONLY_COMPANY_KEYS || '')
    .split(',')
    .map((x) => normalizeCompanyKey(x))
    .filter(Boolean)
);
const LOCALES = ['it', 'en', 'de', 'fr'];

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
let deeplCalls = 0;
let deeplSuccess = 0;
let deeplFallbackToLlm = 0;
let companyAdaptersGlobal = new Map();

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

function loadPersistentAiCache() {
  if (!AI_CACHE_PERSIST_ENABLED || aiCacheLoaded) return aiCacheLoadedEntries;
  aiCacheLoaded = true;
  const raw = readJson(AI_CACHE_PATH, null);
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
  const entries = [...aiResponseCache.entries()]
    .slice(-AI_CACHE_DISK_MAX_ENTRIES)
    .map(([key, entry]) => ({
      key,
      touchedAt: Number(entry?.touchedAt || Date.now()),
      value: cloneCacheValue(entry?.value),
    }));
  writeJson(AI_CACHE_PATH, {
    version: AI_CACHE_FILE_VERSION,
    savedAt: new Date().toISOString(),
    entries,
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

function normalizeCompanyKey(input) { return normalizeKey(input).slice(0, 64); }

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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

function normalizeSpace(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function chunkTextForTranslation(text = '', maxChunkChars = 1800) {
  const clean = cleanDescription(text);
  if (!clean) return [];
  if (clean.length <= maxChunkChars) return [clean];
  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => normalizeSpace(p))
    .filter(Boolean);
  const out = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    if (paragraph.length <= maxChunkChars) {
      current = paragraph;
      continue;
    }
    for (let i = 0; i < paragraph.length; i += maxChunkChars) {
      out.push(paragraph.slice(i, i + maxChunkChars));
    }
    current = '';
  }
  if (current) out.push(current);
  return out;
}

// ─── DeepL Translation ────────────────────────────────────────────────
// Locale codes → DeepL target_lang codes (DeepL uses uppercase 2-letter)
const DEEPL_LANG_MAP = { it: 'IT', en: 'EN', de: 'DE', fr: 'FR' };

/**
 * Translate text using the DeepL free API.
 * Returns translated text, or '' on failure.
 * Handles chunking internally for texts > 5000 chars (DeepL free limit).
 */
async function translateWithDeepL(text, sourceLang, targetLang) {
  if (!DEEPL_API_KEY) return '';
  const clean = normalizeSpace(text || '');
  if (!clean) return '';
  if (sourceLang === targetLang) return clean;
  deeplCalls += 1;

  const srcCode = DEEPL_LANG_MAP[sourceLang] || sourceLang?.toUpperCase() || '';
  const tgtCode = DEEPL_LANG_MAP[targetLang] || targetLang?.toUpperCase() || '';
  if (!tgtCode) return '';

  // DeepL free API accepts up to ~128KB per request, but chunk at 5000 chars to be safe
  const MAX_CHUNK = 5000;
  const chunks = clean.length <= MAX_CHUNK
    ? [clean]
    : chunkTextForTranslation(clean, MAX_CHUNK);

  const translatedChunks = [];
  for (const chunk of chunks) {
    const body = new URLSearchParams();
    body.append('text', chunk);
    if (srcCode) body.append('source_lang', srcCode);
    body.append('target_lang', tgtCode);

    try {
      const res = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(AI_LOCALIZATION_TIMEOUT_MS),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.warn(`⚠️ DeepL API error ${res.status}: ${errBody.slice(0, 200)}`);
        return '';
      }
      const data = await res.json();
      const translated = data?.translations?.[0]?.text || '';
      if (!translated) return '';
      translatedChunks.push(translated);
    } catch (err) {
      console.warn(`⚠️ DeepL request failed: ${err?.message || err}`);
      return '';
    }
    // Small delay between chunk requests to respect rate limits
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const raw = translatedChunks.join('\n\n');
  // For short inputs (titles), skip heavy cleanDescription which strips CTA/boilerplate
  const merged = clean.length < 200 ? normalizeSpace(raw) : cleanDescription(raw);
  if (!merged || merged.toLowerCase() === clean.toLowerCase()) return '';
  deeplSuccess += 1;
  return merged;
}

// Google Translate free endpoints — try multiple to survive IP-based rate limits
const GOOGLE_TRANSLATE_ENDPOINTS = [
  'https://translate.googleapis.com/translate_a/single',
  'https://clients5.google.com/translate_a/t',
];

async function translateChunkGoogle({ text, sourceLang = 'auto', targetLang }) {
  const q = normalizeSpace(text);
  if (!q) return '';

  for (const base of GOOGLE_TRANSLATE_ENDPOINTS) {
    const isClients5 = base.includes('clients5');
    const query = new URLSearchParams({
      client: isClients5 ? 'dict-chrome-ex' : 'gtx',
      sl: sourceLang || 'auto',
      tl: targetLang,
      ...(isClients5 ? {} : { dt: 't' }),
      q,
    });
    const endpoint = `${base}?${query.toString()}`;
    try {
      const res = await fetch(endpoint, {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          // Standard browser UA — bot UAs get blocked from CI/datacenter IPs
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(AI_LOCALIZATION_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const raw = await res.text().catch(() => '');
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        // clients5 returns [{sentences:[{trans:"..."}]}] or [[["translated","original",...]]]
        let translated = '';
        if (isClients5) {
          if (Array.isArray(parsed?.sentences)) {
            translated = parsed.sentences.map((s) => s?.trans || '').join('');
          } else if (Array.isArray(parsed)) {
            translated = parsed.map((s) => String(s || '')).join('');
          }
        } else {
          const segments = Array.isArray(parsed?.[0]) ? parsed[0] : [];
          translated = segments
            .map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : ''))
            .join('');
        }
        const result = cleanDescription(translated);
        if (result && result.toLowerCase() !== q.toLowerCase()) return result;
      } catch {
        continue;
      }
    } catch {
      continue;
    }
  }
  return '';
}

// ── Instance Health Tracking (shared across proxy tiers) ──
const HEALTH_RECOVERY_MS = 10 * 60 * 1000; // 10 minutes
const proxyHealth = new Map(); // url → { failedAt, failures }

function isProxyHealthy(url) {
  const entry = proxyHealth.get(url);
  if (!entry) return true;
  if (Date.now() - entry.failedAt > HEALTH_RECOVERY_MS) { proxyHealth.delete(url); return true; }
  return false;
}
function markProxyFailed(url) {
  const e = proxyHealth.get(url) || { failures: 0 };
  e.failedAt = Date.now(); e.failures += 1; proxyHealth.set(url, e);
}
function markProxyOk(url) { proxyHealth.delete(url); }

// Race up to 3 healthy instances in parallel, return first valid result
async function raceProxyInstances(instances, fetchFn) {
  const healthy = instances.filter(isProxyHealthy);
  if (healthy.length === 0 && instances.length > 0) {
    proxyHealth.delete(instances[0]); // try oldest anyway
    return fetchFn(instances[0]);
  }
  const batch = healthy.slice(0, 3);
  const controller = new AbortController();
  const promises = batch.map(async (base) => {
    try {
      const r = await fetchFn(base, controller.signal);
      if (r) { controller.abort(); markProxyOk(base); return r; }
      markProxyFailed(base); return '';
    } catch { markProxyFailed(base); return ''; }
  });
  const results = await Promise.allSettled(promises);
  const first = results.find((r) => r.status === 'fulfilled' && r.value);
  if (first) return first.value;
  for (const base of healthy.slice(3)) {
    try {
      const r = await fetchFn(base);
      if (r) { markProxyOk(base); return r; }
      markProxyFailed(base);
    } catch { markProxyFailed(base); }
  }
  return '';
}

// ── Lingva Translate (free Google Translate proxy) ──
// Verified 2026-03-22
const LINGVA_INSTANCES = [
  'https://translate.plausibility.cloud',
];

async function translateChunkLingva({ text, sourceLang = 'auto', targetLang }) {
  const q = normalizeSpace(text);
  if (!q) return '';
  const encoded = encodeURIComponent(q);
  return raceProxyInstances(LINGVA_INSTANCES, async (base, signal) => {
    const url = `${base}/api/v1/${sourceLang || 'auto'}/${targetLang}/${encoded}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
      signal: signal || AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const translated = normalizeSpace(data?.translation || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) return translated;
    return '';
  });
}

async function translateChunkedWithLingva({ text, sourceLang, targetLang }) {
  const isShort = normalizeSpace(text || '').length < 200;
  const clean = isShort ? normalizeSpace(text || '') : cleanDescription(text || '');
  if (!clean) return '';
  const chunks = chunkTextForTranslation(clean, 1500);
  if (chunks.length === 0) return '';
  const translatedChunks = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const translated = await translateChunkLingva({ text: chunk, sourceLang, targetLang });
    if (!translated) return '';
    translatedChunks.push(translated);
    if (chunks.length > 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const raw = translatedChunks.join('\n\n');
  return isShort ? normalizeSpace(raw) : cleanDescription(raw);
}

// ── SimplyTranslate (another free Google Translate proxy) ──
// Verified 2026-03-22
const SIMPLYTRANSLATE_INSTANCES = [
  'https://simplytranslate.org',
];

async function translateWithSimplyTranslateChunked({ text, sourceLang, targetLang }) {
  const isShort = normalizeSpace(text || '').length < 200;
  const clean = isShort ? normalizeSpace(text || '') : cleanDescription(text || '');
  if (!clean || sourceLang === targetLang) return '';
  const chunks = chunkTextForTranslation(clean, 1500);
  if (chunks.length === 0) return '';
  const translatedChunks = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const translated = await raceProxyInstances(SIMPLYTRANSLATE_INSTANCES, async (base, signal) => {
      const params = new URLSearchParams({
        engine: 'google', from: sourceLang || 'auto', to: targetLang, text: chunk,
      });
      const res = await fetch(`${base}/api/translate/?${params.toString()}`, {
        headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
        signal: signal || AbortSignal.timeout(15000),
      });
      if (!res.ok) return '';
      const data = await res.json();
      const t = normalizeSpace(data?.translated_text || '');
      if (t && t.toLowerCase() !== normalizeSpace(chunk).toLowerCase()) return t;
      return '';
    });
    if (!translated) return '';
    translatedChunks.push(translated);
  }
  const raw = translatedChunks.join('\n\n');
  return isShort ? normalizeSpace(raw) : cleanDescription(raw);
}

// ── Mozhi (open-source translation proxy) ──
// Verified 2026-03-22
const MOZHI_INSTANCES = [
  'https://mozhi.adminforge.de',
  'https://mozhi.pussthecat.org',
  'https://mozhi.aryak.me',
];

async function translateWithMozhiChunked({ text, sourceLang, targetLang }) {
  const isShort = normalizeSpace(text || '').length < 200;
  const clean = isShort ? normalizeSpace(text || '') : cleanDescription(text || '');
  if (!clean || sourceLang === targetLang) return '';
  const chunks = chunkTextForTranslation(clean, 1500);
  if (chunks.length === 0) return '';
  const translatedChunks = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const translated = await raceProxyInstances(MOZHI_INSTANCES, async (base, signal) => {
      const params = new URLSearchParams({
        engine: 'google', from: sourceLang || 'auto', to: targetLang, text: chunk,
      });
      const res = await fetch(`${base}/api/translate?${params.toString()}`, {
        headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
        signal: signal || AbortSignal.timeout(15000),
      });
      if (!res.ok) return '';
      const data = await res.json();
      // Mozhi uses 'translated-text' (hyphenated) in its response
      const t = normalizeSpace(data?.['translated-text'] || data?.translated_text || '');
      if (t && t.toLowerCase() !== normalizeSpace(chunk).toLowerCase()) return t;
      return '';
    });
    if (!translated) return '';
    translatedChunks.push(translated);
  }
  const raw = translatedChunks.join('\n\n');
  return isShort ? normalizeSpace(raw) : cleanDescription(raw);
}

// ── Chunked MyMemory (for texts > 500 chars) ──
async function translateChunkedWithMyMemory({ text, sourceLang, targetLang }) {
  const isShort = normalizeSpace(text || '').length < 200;
  const clean = isShort ? normalizeSpace(text || '') : cleanDescription(text || '');
  if (!clean) return '';
  const chunks = chunkTextForTranslation(clean, 450);
  if (chunks.length === 0) return '';
  const translatedChunks = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const translated = await translateWithMyMemory(chunk, sourceLang, targetLang);
    if (!translated) return '';
    translatedChunks.push(translated);
  }
  const raw = translatedChunks.join('\n\n');
  return isShort ? normalizeSpace(raw) : cleanDescription(raw);
}

// ── LibreTranslate public instances (open-source, no API key) ──
// Verified 2026-03-22
const LIBRETRANSLATE_PUBLIC_INSTANCES = [
  'https://translate.cutie.dating',
];

async function translateWithLibreTranslatePublic({ text, sourceLang, targetLang }) {
  const q = normalizeSpace(text || '');
  if (!q || sourceLang === targetLang) return '';
  return raceProxyInstances(LIBRETRANSLATE_PUBLIC_INSTANCES, async (base, signal) => {
    const res = await fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q,
        source: sourceLang || 'auto',
        target: targetLang,
        format: 'text',
      }),
      signal: signal || AbortSignal.timeout(20000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const translated = normalizeSpace(data?.translatedText || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) return translated;
    return '';
  });
}

async function fallbackTranslateText({
  text,
  sourceLang = 'en',
  targetLang = 'it',
  minChars = 1,
}) {
  const isShort = normalizeSpace(text || '').length < 200;
  const clean = isShort ? normalizeSpace(text || '') : cleanDescription(text || '');
  if (!clean) return '';
  if (targetLang === sourceLang) return clean;
  // Try DeepL first (higher quality than Google Translate)
  const deepl = await translateWithDeepL(clean, sourceLang, targetLang);
  if (deepl && deepl.length >= minChars) return deepl;
  // Try MyMemory (chunked for long texts)
  const myMemory = await translateChunkedWithMyMemory({ text: clean, sourceLang, targetLang });
  if (myMemory && myMemory.length >= minChars &&
      normalizeSpace(myMemory).toLowerCase() !== normalizeSpace(clean).toLowerCase()) {
    return isShort ? normalizeSpace(myMemory) : cleanDescription(myMemory);
  }
  // Try Lingva Translate (free Google Translate proxy, 6 mirrors, parallel race)
  const lingva = await translateChunkedWithLingva({ text: clean, sourceLang, targetLang });
  if (lingva && lingva.length >= minChars &&
      normalizeSpace(lingva).toLowerCase() !== normalizeSpace(clean).toLowerCase()) {
    return isShort ? normalizeSpace(lingva) : cleanDescription(lingva);
  }
  // Try SimplyTranslate (another free proxy, 4 mirrors, parallel race)
  const simply = await translateWithSimplyTranslateChunked({ text: clean, sourceLang, targetLang });
  if (simply && simply.length >= minChars &&
      normalizeSpace(simply).toLowerCase() !== normalizeSpace(clean).toLowerCase()) {
    return isShort ? normalizeSpace(simply) : cleanDescription(simply);
  }
  // Try LibreTranslate public instances (open-source, 5 instances, parallel race)
  const libre = await translateWithLibreTranslatePublic({ text: clean, sourceLang, targetLang });
  if (libre && libre.length >= minChars &&
      normalizeSpace(libre).toLowerCase() !== normalizeSpace(clean).toLowerCase()) {
    return isShort ? normalizeSpace(libre) : cleanDescription(libre);
  }
  // Try Mozhi (open-source proxy, 3 instances, parallel race)
  const mozhi = await translateWithMozhiChunked({ text: clean, sourceLang, targetLang });
  if (mozhi && mozhi.length >= minChars &&
      normalizeSpace(mozhi).toLowerCase() !== normalizeSpace(clean).toLowerCase()) {
    return isShort ? normalizeSpace(mozhi) : cleanDescription(mozhi);
  }
  // Fallback to free Google Translate (direct endpoint)
  const chunks = chunkTextForTranslation(clean, 1800);
  if (chunks.length === 0) return '';
  const translatedChunks = [];
  for (const chunk of chunks) {
    let translated = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      translated = await translateChunkGoogle({ text: chunk, sourceLang, targetLang });
      if (translated) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
    if (!translated) return '';
    translatedChunks.push(translated);
  }
  const raw = translatedChunks.join('\n\n');
  const merged = isShort ? normalizeSpace(raw) : cleanDescription(raw);
  if (merged.length < minChars) return '';
  if (normalizeSpace(merged).toLowerCase() === normalizeSpace(clean).toLowerCase()) return '';
  return merged;
}

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
    return base ? new URL(raw, base).toString() : new URL(raw).toString();
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeHost(host) {
  return String(host || '').toLowerCase().trim().replace(/^www\d?\./, '');
}

function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const secondLevelSet = new Set(['co', 'com', 'org', 'gov', 'ac', 'edu', 'net']);
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && secondLevelSet.has(sld) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function canonicalizeJobUrl(rawUrl = '') {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return '';
  }
  const noisyParams = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'trk', 'tracking',
    'source', 'medium', 'campaign',
  ];
  for (const key of noisyParams) u.searchParams.delete(key);
  u.hash = '';
  const pathClean = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${pathClean}${u.search ? `?${u.searchParams.toString()}` : ''}`.toLowerCase();
}

function extractUuidLikeId(raw = '') {
  const text = String(raw || '');
  const uuidMatch = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
  return uuidMatch?.[0] ? uuidMatch[0].toLowerCase() : '';
}

function extractJobIdentityFromUrl(rawUrl = '') {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return '';
  }
  const host = normalizeHost(u.hostname);
  const full = `${host}${u.pathname}${u.search}`.toLowerCase();

  // Coop JobBooster can expose the same job with different path prefixes/slugs:
  // /offene-stellen/{slug}/{uuid} and /posti-vacanti/{slug}/{uuid}
  // Prefer the final UUID segment to avoid duplicate entries across locale routes.
  const coopPathMatch = full.match(/\/(?:offene-stellen|posti-vacanti)\/[^/?#]+\/([^/?#]+)/i);
  if (coopPathMatch?.[1]) {
    const coopIdCandidate = normalizeSpace(coopPathMatch[1]);
    const coopUuid = extractUuidLikeId(coopIdCandidate) || extractUuidLikeId(full);
    if (coopUuid) return `${registrableDomain(host)}|${coopUuid}`;
    if (coopIdCandidate) return `${registrableDomain(host)}|${coopIdCandidate.toLowerCase()}`;
  }

  const inPath = [
    /\/jobs\/view\/(\d+)/i, // LinkedIn
    /\/job\/(\d+)/i, // swatchgroup + many boards
    /\/details\/([^/?#]+)/i, // Workday detail pages
    /\/jobs\/(\d+)/i,
    /\/positions\/(\d+)/i,
    /\/vacanc(?:y|ies)\/(\d+)/i,
    /\/(?:offene-stellen|posti-vacanti)\/[^/?#]+\/([^/?#]+)/i,
    /\/career\/jobs\/([^/?#]+)/i,
    /\/job\/[^/?#]*\/([^/?#]+)/i, // workday-like
  ];
  for (const re of inPath) {
    const m = full.match(re);
    if (m?.[1]) return `${registrableDomain(host)}|${m[1]}`;
  }
  const queryKeys = ['jobid', 'job_id', 'gh_jid', 'jid', 'wdjobid', 'vacancyid'];
  for (const key of queryKeys) {
    const val = normalizeSpace(u.searchParams.get(key));
    if (val) return `${registrableDomain(host)}|${val.toLowerCase()}`;
  }
  // Hash-based job identifiers (e.g. #job.id=12345 or #slug-name)
  const hashRaw = normalizeSpace(u.hash.replace(/^#/, ''));
  if (hashRaw) {
    const keyedMatch = hashRaw.match(/(?:job[._-]?id|id)=(\w+)/i);
    if (keyedMatch?.[1]) return `${registrableDomain(host)}|${keyedMatch[1].toLowerCase()}`;
    if (hashRaw.length > 3 && /^[\w-]+$/.test(hashRaw)) {
      return `${registrableDomain(host)}|#${hashRaw.toLowerCase()}`;
    }
  }
  return '';
}

function recencyTs(job) {
  const raw = job?.crawledAt || job?.postedDate || '';
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

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
    h.includes('allibo.com')
  );
}

function dateOnly(input) {
  const d = new Date(input || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
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
  if (meta.canton === 'TI' || meta.canton === 'GR') return true;
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

function getJobTargetScope(job = {}) {
  const scope = job?._targetScope;
  return scope && typeof scope === 'object' ? scope : null;
}

function hasSeedMetaTargetScope(job = {}) {
  const scope = getJobTargetScope(job);
  if (!scope) return false;
  const canton = normalizeCantonCode(scope.canton || job?.canton || '');
  if (canton === 'TI' || canton === 'GR') return true;
  const location = normalizeSpace(scope.location || '');
  if (!location) return false;
  return isTargetSwissLocation(location);
}

function isJobPortalRelevant(job = {}) {
  const signal = `${job?.title || ''} ${job?.location || ''} ${job?.description || ''}`;
  if (isTargetSwissLocation(signal)) return true;
  return hasSeedMetaTargetScope(job);
}

function isExplicitlyOutsideTarget(text) {
  const lower = String(text || '').toLowerCase();
  const outsideMarkers = [
    // Europe
    'österreich', 'austria', 'graz', 'wien', 'vienna',
    'deutschland', 'germany', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt',
    'france', 'paris', 'lyon', 'marseille', 'toulouse', 'strasbourg',
    'spain', 'madrid', 'barcelona', 'sevilla', 'valencia',
    'uk', 'united kingdom', 'london', 'manchester', 'birmingham', 'edinburgh',
    'portugal', 'lisbon', 'lisboa', 'porto',
    'netherlands', 'amsterdam', 'rotterdam', 'den haag',
    'belgium', 'brussels', 'bruxelles', 'antwerp',
    'sweden', 'stockholm', 'göteborg',
    'norway', 'oslo',
    'denmark', 'copenhagen', 'københavn',
    'finland', 'helsinki',
    'poland', 'warsaw', 'kraków', 'wroclaw',
    'czech republic', 'prague', 'praha',
    'hungary', 'budapest',
    'romania', 'bucharest', 'bucuresti',
    'greece', 'athens',
    // Italy (outside border/Ticino area — major Italian cities that are NOT commutable)
    'italia', 'italy',
    'milano', 'milan', 'roma', 'rome', 'firenze', 'florence', 'napoli', 'naples',
    'torino', 'turin', 'bologna', 'genova', 'palermo', 'catania', 'bari',
    'venezia', 'venice', 'verona', 'padova', 'trieste', 'brescia', 'modena',
    'forte dei marmi', 'toscana', 'lazio', 'lombardia', 'piemonte', 'campania',
    'puglia', 'sicilia', 'sardegna', 'calabria', 'emilia-romagna', 'umbria',
    // Americas
    'usa', 'united states', 'new york', 'los angeles', 'san francisco', 'chicago',
    'canada', 'toronto', 'montreal', 'vancouver',
    'brazil', 'brasile', 'são paulo', 'rio de janeiro',
    'mexico', 'messico',
    // Asia & Middle East
    'malaysia', 'kuala lumpur',
    'singapore', 'singapour',
    'china', 'cina', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hong kong',
    'japan', 'giappone', 'tokyo',
    'south korea', 'seoul',
    'india', 'mumbai', 'bangalore', 'delhi', 'new delhi',
    'thailand', 'bangkok',
    'indonesia', 'jakarta',
    'vietnam', 'hanoi', 'ho chi minh',
    'philippines', 'manila',
    'taiwan', 'taipei',
    'united arab emirates', 'uae', 'dubai', 'abu dhabi',
    'saudi arabia', 'riyadh',
    'qatar', 'doha',
    // Africa & Oceania
    'australia', 'sydney', 'melbourne',
    'south africa', 'johannesburg', 'cape town',
  ];
  const hitOutside = outsideMarkers.some((k) => lower.includes(k));
  if (!hitOutside) return false;
  // Keep if there's also a strong Ticino/CH signal.
  return !/(ticino|lugano|bellinzona|mendrisio|chiasso|svizzera|switzerland|schweiz)/i.test(lower);
}

/**
 * Check if a job's LOCATION field explicitly indicates a non-Swiss location.
 * Unlike isExplicitlyOutsideTarget (which checks full text and can be fooled by
 * company descriptions mentioning Switzerland), this function checks only the
 * location field where country/city names are the actual work location.
 *
 * This is the strongest filter: if the job location says "Kuala Lumpur, Malaysia"
 * or "Milan, Italy", we reject it regardless of what the description says.
 */
function isLocationExplicitlyForeign(locationField) {
  const lower = String(locationField || '').toLowerCase();
  if (!lower || lower.length < 3) return false;
  // If location explicitly contains a Swiss indicator, keep it
  if (/(\bch\b|swiss|svizzera|switzerland|schweiz|suisse)/i.test(lower)) return false;
  // If location contains a Ticino city or canton indicator, keep it
  if (/\b(ticino|tessin|ti)\b/i.test(lower)) return false;
  // If location contains a known Ticino/GR city, keep it (e.g. "Chiasso, Italy" is actually in Switzerland)
  if (TICINO_CITIES.some((c) => lower.includes(c.toLowerCase()))) return false;
  // Foreign country names — reject if location explicitly names a non-Swiss country
  const foreignCountries = [
    'malaysia', 'italy', 'italia', 'france', 'germany', 'deutschland',
    'austria', 'österreich', 'spain', 'españa', 'portugal',
    'united kingdom', 'uk', 'usa', 'united states', 'canada',
    'china', 'japan', 'india', 'singapore', 'thailand', 'indonesia',
    'vietnam', 'philippines', 'taiwan', 'south korea', 'hong kong',
    'united arab emirates', 'uae', 'saudi arabia', 'qatar',
    'australia', 'brazil', 'mexico', 'south africa',
    'netherlands', 'belgium', 'sweden', 'norway', 'denmark', 'finland',
    'poland', 'czech republic', 'hungary', 'romania', 'greece',
    'russia', 'ukraine', 'turkey',
  ];
  // Foreign major cities (non-Swiss, non-border-Italian) — reject
  const foreignCities = [
    'kuala lumpur', 'milano', 'milan', 'roma', 'rome', 'firenze', 'florence',
    'napoli', 'naples', 'torino', 'turin', 'bologna', 'genova', 'palermo',
    'venezia', 'venice', 'forte dei marmi', 'toscana', 'lombardia',
    'paris', 'lyon', 'marseille', 'london', 'berlin', 'munich', 'münchen',
    'frankfurt', 'hamburg', 'vienna', 'wien', 'madrid', 'barcelona',
    'amsterdam', 'brussels', 'bruxelles', 'stockholm', 'oslo', 'copenhagen',
    'tokyo', 'beijing', 'shanghai', 'singapore', 'bangkok', 'mumbai',
    'dubai', 'new york', 'los angeles', 'toronto', 'sydney', 'melbourne',
    // Swiss cities outside the target area — these should not be auto-mapped to Ticino
    'zurich', 'zürich', 'bern', 'berne', 'basel', 'lausanne', 'geneva', 'genève',
    'fribourg', 'neuchatel', 'neuchâtel', 'winterthur', 'zug', 'aarau', 'lucerne', 'luzern',
  ];
  return foreignCountries.some((k) => lower.includes(k)) || foreignCities.some((k) => lower.includes(k));
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

// Ticino-relevant area: Canton TI, Canton GR (Mesolcina/Bregaglia), and
// northern Italian border provinces close enough for cross-border commuting.
const TICINO_RELEVANT_CANTONS = new Set(['ticino', 'ti', 'tessin']);
const TICINO_ADJACENT_CANTONS = new Set(['graubünden', 'gr', 'grigioni', 'grisons', 'grischun']);
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

  // ── Switzerland ──
  if (country === 'CH') {
    if (TICINO_RELEVANT_CANTONS.has(canton) || TICINO_RELEVANT_CANTONS.has(cantonShort?.toLowerCase())) {
      return { relevant: true, reason: 'ch_canton_ticino' };
    }
    if (TICINO_ADJACENT_CANTONS.has(canton) || TICINO_ADJACENT_CANTONS.has(cantonShort?.toLowerCase())) {
      // GR: only relevant if in the southern part (Mesolcina/Bregaglia/Poschiavo — lat < 46.6)
      if (lat && lat < 46.6) return { relevant: true, reason: 'ch_canton_gr_south' };
      return { relevant: false, reason: 'ch_canton_gr_north' };
    }
    // Other Swiss cantons — not Ticino-relevant
    return { relevant: false, reason: `ch_canton_${cantonShort || canton}_not_ticino` };
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
 *  1. Skip jobs whose location text-matches Ticino tokens (already verified)
 *  2. Geocode remaining ambiguous locations
 *  3. Reject jobs whose geocoded location is clearly outside the Ticino area
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
    console.log(`\n🗺️  Geocoding filter removed ${removed.length} job(s) outside Ticino area:`);
    for (const { job, geo, reason } of removed) {
      console.log(`   ❌ [${job.company}] "${job.title}" — ${job.location} → ${geo?.formattedAddress || '?'} (${reason})`);
    }
  } else if (_geocodeApiCalls > 0) {
    console.log(`\n🗺️  Geocoding filter: all locations verified (${_geocodeApiCalls} API calls made)`);
  }

  return { filtered: kept, removedCount: removed.length, removedJobs: removed };
}

function isExplicitlyOutsideSwissTicino(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  if (/\b(ticino|canton ticino|cantone ticino|ch-ti)\b/i.test(lower)) return false;
  if (/\b(?:ch-?)?\d{4}\s+[a-zà-öø-ÿ'().\-\s]{2,80}\s+(ag|ai|ar|be|bl|bs|fr|ge|gl|gr|ju|lu|ne|nw|ow|sg|sh|so|sz|tg|ur|vd|vs|zg|zh)\b/i.test(lower)) {
    return true;
  }
  const nonTiCantonsCities = [
    'bern', 'berne', 'zuerich', 'zürich', 'basel', 'lausanne', 'geneva', 'genève',
    'fribourg', 'neuchatel', 'luzern', 'lucerne', 'winterthur', 'aarau', 'zug',
    'st. gallen', 'sankt gallen', 'thun', 'biel', 'bienne',
    // Smaller Swiss cities frequently seen in apprenticeship listings
    'gossau', 'dietlikon', 'jegensdorf', 'lenzburg', 'oberbüren', 'oberbueren',
    'pratteln', 'muttenz', 'olten', 'langenthal', 'burgdorf', 'emmen', 'kriens',
    'köniz', 'ostermundigen', 'schaffhausen', 'frauenfeld', 'wil sg', 'rapperswil',
    'uster', 'dübendorf', 'kloten', 'wetzikon', 'volketswil', 'spreitenbach',
  ];
  return nonTiCantonsCities.some((k) => lower.includes(k));
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
  const jobSignals = [
    'responsibilities',
    'requirements',
    'requisiti',
    'stellenbeschreibung',
    'profil',
    'skills for success',
    'hiring organization',
    'job requisition id',
    'employment type',
    'apply now',
    'candidate profile',
  ];
  const commerceHits = commerceSignals.reduce((acc, s) => acc + (text.includes(s) ? 1 : 0), 0);
  const hasJobSignal = jobSignals.some((s) => text.includes(s));
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

function slugify(input = '', maxLen = 140) {
  return normalizeSpace(decodeNumericEntities(decodeHtmlEntities(input)))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}



function cleanDescription(desc) {
  let text = stripHtml(desc);
  // Remove noisy legal / cookie / nav fragments
  text = text
    .replace(/(privacy policy|cookie policy|all rights reserved|accept all cookies|manage preferences)/gi, ' ')
    .replace(/(apply now|candidati ora|learn more|scopri di più)\s*$/gi, ' ')
    // Strip residual markdown formatting (***bold***, ##headings, # titles)
    .replace(/\*{2,}([^*]+)\*{2,}/g, '$1')   // ***bold*** or **bold** → bold
    .replace(/^#{1,6}\s+/gm, '')               // ## Heading → Heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url) → text
    .replace(/[^\S\n]+/g, ' ')      // collapse horizontal whitespace, preserve \n
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

async function structureJobDescription(rawText) {
  if (!rawText || rawText.length < 100) return rawText;

  const cacheKey = buildAiCacheKey('structure-desc-v2', [rawText]);
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

  const prompt = `You are a job listing formatter. Restructure this flat job description into well-formatted Italian markdown.

Rules:
- Use ## for section headings (e.g. ## Mansioni, ## Requisiti, ## Cosa offriamo, ## Contatto)
- Use - for bullet points listing individual tasks, requirements, or benefits
- Each bullet point should be a single, complete item (one task or one requirement)
- Keep ALL original content verbatim — do NOT add, remove, or rephrase any text
- Only add markdown structure (headings, bullets, line breaks)
- If no clear section structure exists, use ## Descrizione as the heading
- Output ONLY the formatted markdown, no explanations, preamble, or code fences

Text:
${rawText}`;

  try {
    structureDescriptionCalls++;
    const result = await callLLM(
      [{ role: 'user', content: prompt }],
      { model: 'gemini-2.0-flash', maxTokens: 4000, temperature: 0.1 }
    );
    if (!result) {
      setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
      return rawText;
    }
    // Strip code fences if the model wrapped output
    const cleaned = result.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
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

async function aiEnrichThinDescription(job) {
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

  const prompt = `Sei un esperto di annunci di lavoro. Componi una descrizione professionale e completa in italiano per questa offerta di lavoro, utilizzando TUTTI i dati forniti.

Regole:
- Usa il formato markdown con sezioni ## (Descrizione, Mansioni, Requisiti, Cosa offriamo, Contatto)
- Usa - per i punti elenco
- Integra TUTTI i dati forniti senza inventare informazioni aggiuntive
- La descrizione iniziale deve essere un paragrafo introduttivo in 2-3 frasi
- Ogni mansione, requisito e benefit deve essere un punto elenco separato
- Non aggiungere informazioni non presenti nei dati forniti
- Non ripetere gli stessi contenuti in sezioni diverse
- Se il grado di occupazione è disponibile, includilo alla fine come **Grado di occupazione: XX%**
- Output SOLO il markdown formattato, nessuna spiegazione, preambolo o code fence

Dati:
${contextParts.join('\n\n')}`;

  try {
    enrichThinCalls++;
    const result = await callLLM(
      [{ role: 'user', content: prompt }],
      { model: 'gemini-2.0-flash', maxTokens: 4000, temperature: 0.2 }
    );
    if (!result) {
      setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
      return job.description;
    }
    const cleaned = result.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
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

  const best = candidates
    .map((x) => x.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';
  return sanitizeLocation(best);
}

function extractWorkdayApplyUrl(html, baseUrl) {
  const m = String(html).match(/<a[^>]*href=["']([^"']*lumessetalentlink[^"']+)["'][^>]*>/i);
  if (!m?.[1]) return '';
  return tryUrl(m[1], baseUrl) || '';
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
  const rx = /<link[^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = rx.exec(String(html))) !== null) {
    const hreflang = normalizeSpace(m[1]).toLowerCase();
    const href = tryUrl(m[2], currentUrl);
    if (!href || !hreflang || hreflang === 'x-default') continue;
    const lang = hreflang.slice(0, 2);
    if (!LOCALES.includes(lang)) continue;
    out[lang] = href;
  }
  return out;
}

function mergeRequirements(a = [], b = []) {
  const cleanReq = (value = '') =>
    normalizeSpace(String(value || '')
      .replace(/&[A-Za-z]+;/g, ' ')
      .replace(/^[)\]}\-–—:.,\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim());
  const seen = new Set();
  const out = [];
  for (const item of [...a, ...b]) {
    const cleaned = cleanReq(item);
    if (!cleaned) continue;
    // Skip truncated artifacts
    if (/\.{2,}\s*$/.test(cleaned)) continue;
    // Split joined list items separated by "; - " or "; •"
    const parts = cleaned.split(/;\s*[-•]\s+/).map((p) => p.replace(/^[-•]\s*/, '').trim()).filter((p) => p.length >= 8);
    const candidates = parts.length > 1 ? parts : [cleaned];
    for (const cand of candidates) {
      const key = cand.toLowerCase();
      if (seen.has(key)) continue;
      if (cand.length < 8 || cand.length > 120) continue;
      if (/\b(streamlined recruitment process|hiring manager|recruiter|business case|how you will make a difference|skills that will make you succeed|skills for success|eligibility requirements)\b/i.test(cand)) continue;
      seen.add(key);
      out.push(cand);
      if (out.length >= 8) break;
    }
    if (out.length >= 8) break;
  }
  return out;
}

function localeTextCoverage(map = {}, minChars = 1) {
  if (!map || typeof map !== 'object') return 0;
  let c = 0;
  for (const locale of LOCALES) {
    const val = normalizeSpace(String(map[locale] || ''));
    if (val.length >= minChars) c += 1;
  }
  return c;
}

function mergeLocaleTextMap(a = {}, b = {}, minChars = 1) {
  const out = {};
  for (const locale of LOCALES) {
    const av = normalizeSpace(String(a?.[locale] || ''));
    const bv = normalizeSpace(String(b?.[locale] || ''));
    if (av.length < minChars && bv.length < minChars) continue;
    out[locale] = bv.length >= av.length ? bv : av;
  }
  return out;
}

function mergeLocaleRequirementsMap(a = {}, b = {}) {
  const out = {};
  for (const locale of LOCALES) {
    const merged = mergeRequirements(
      Array.isArray(a?.[locale]) ? a[locale] : [],
      Array.isArray(b?.[locale]) ? b[locale] : [],
    );
    if (merged.length > 0) out[locale] = merged;
  }
  return out;
}

function tokenizeForSimilarity(text = '') {
  return new Set(
    normalizeSpace(String(text || '').toLowerCase())
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3)
  );
}

function textSimilarityRatio(a = '', b = '') {
  const aa = normalizeSpace(String(a || ''));
  const bb = normalizeSpace(String(b || ''));
  if (!aa && !bb) return 1;
  if (!aa || !bb) return 0;
  if (aa.toLowerCase() === bb.toLowerCase()) return 1;
  const at = tokenizeForSimilarity(aa);
  const bt = tokenizeForSimilarity(bb);
  if (at.size === 0 || bt.size === 0) return 0;
  let intersection = 0;
  for (const t of at) {
    if (bt.has(t)) intersection += 1;
  }
  const union = at.size + bt.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function hasCompleteLocalizedCoverage(job = {}) {
  const descCoverage = localeTextCoverage(job?.descriptionByLocale || {}, 120);
  const titleCoverage = localeTextCoverage(job?.titleByLocale || {}, 3);
  const reqCoverage = Object.keys(job?.requirementsByLocale || {}).length;
  return descCoverage >= LOCALES.length && titleCoverage >= LOCALES.length && reqCoverage >= LOCALES.length;
}

function shouldReusePreviousLocalization(prev = {}, next = {}, cfg = {}) {
  if (!cfg?.enabled) return false;
  if (!hasCompleteLocalizedCoverage(prev)) return false;

  const prevDesc = normalizeSpace(prev?.description || '');
  const nextDesc = normalizeSpace(next?.description || '');
  if (prevDesc.length < cfg.minSourceChars || nextDesc.length < cfg.minSourceChars) return false;

  const similarity = textSimilarityRatio(prevDesc, nextDesc);
  if (similarity < cfg.similarityThreshold) return false;

  const prevLen = Math.max(1, prevDesc.length);
  const nextLen = Math.max(1, nextDesc.length);
  const deltaRatio = Math.abs(nextLen - prevLen) / prevLen;
  if (deltaRatio > cfg.maxLengthDeltaRatio) return false;

  return true;
}

function isLowQualityLocalizedTitle(value = '') {
  const t = normalizeSpace(value || '');
  if (!t) return true;
  if (t.length < 3) return true;
  if (/^(h|he|her|here|here is|title|job title)\b/i.test(t)) return true;
  if (/^[\W_]+$/.test(t)) return true;
  return false;
}

function isLowQualityLocalizedSlug(value = '') {
  const s = normalizeSpace(value || '');
  if (!s) return true;
  if (s.length < 12) return true;
  if (/^(h|he|her|here)(-|$)/i.test(s)) return true;
  if (!/^[a-z0-9-]+$/i.test(s)) return true;
  return false;
}

function ensureLocaleFields(job) {
  const out = { ...job };
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
  const sourceLang = detectLang(`${bestTitle} ${bestDescription}`, 'en');
  const titleSourceLang = detectJobTitleLang(baseTitle || bestTitle, sourceLang);
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
      const detectedTitleLocale = detectJobTitleLocaleDetails(currentTitle, titleSourceLang);
      const copiedSourceTitle = sourceTitle && currentTitle.toLowerCase() === sourceTitle.toLowerCase();
      if (copiedSourceTitle || (detectedTitleLocale.confidence >= 0.6 && detectedTitleLocale.lang !== locale)) {
        if (
          detectedTitleLocale.lang !== locale &&
          detectedTitleLocale.lang !== titleSourceLang &&
          !normalizeSpace(titleByLocale[detectedTitleLocale.lang] || '')
        ) {
          titleByLocale[detectedTitleLocale.lang] = currentTitle;
        }
        delete titleByLocale[locale];
      }
    }

    const normalizedTitle = normalizeSpace(titleByLocale[locale] || '');
    if (locale !== titleSourceLang && !normalizedTitle && sourceTitle) {
      const translated = heuristicTranslateJobTitle(sourceTitle, locale);
      if (
        translated &&
        translated.toLowerCase() !== sourceTitle.toLowerCase() &&
        !isLowQualityLocalizedTitle(translated)
      ) {
        titleByLocale[locale] = translated;
      }
    }
    // Keep non-source locales empty if no proper translation is available.
    // UI/runtime SEO can fallback to out.description when needed.
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
  for (const locale of LOCALES) {
    const localizedTitleRaw = normalizeSpace(titleByLocale[locale] || out.title || '');
    const localizedTitle = isLowQualityLocalizedTitle(localizedTitleRaw)
      ? normalizeSpace(out.title || bestTitle || '')
      : localizedTitleRaw;
    const currentSlug = normalizeSpace(slugByLocale[locale] || '');
    const baseItSlug = normalizeSpace(slugByLocale.it || out.slug || '');
    const shouldRegenerateLocalizedSlug =
      locale !== 'it' &&
      currentSlug &&
      baseItSlug &&
      currentSlug === baseItSlug;
    const cleanCurrentSlug =
      isLowQualityLocalizedSlug(currentSlug) || shouldRegenerateLocalizedSlug ? '' : currentSlug;
    const localizedSlug =
      cleanCurrentSlug ||
      slugify(`${localizedTitle}-${out.company || ''}-${out.location || ''}`) ||
      slugify(localizedTitle) ||
      normalizeSpace(out.slug || '');
    if (localizedSlug) slugByLocale[locale] = localizedSlug;
  }
  out.slugByLocale = slugByLocale;
  if (!normalizeSpace(out.slug || '') && normalizeSpace(slugByLocale.it || '')) {
    out.slug = normalizeSpace(slugByLocale.it);
  }
  return out;
}

function shouldForceLocalizationForJob(job = {}) {
  const key = normalizeCompanyKey(job.companyKey || job.company || '');
  if (key && FORCE_LOCALIZE_COMPANY_KEYS.has(key)) return true;
  const host = normalizeHost(hostOf(job.url || ''));
  if (FORCE_LOCALIZE_COMPANY_KEYS.has(normalizeCompanyKey(host))) return true;
  if (FORCE_LOCALIZE_WORKDAY && (/(^|[.-])vfc\.com$/.test(host) || host.includes('myworkdayjobs.com'))) return true;
  return false;
}

function isLocalizationAllowedForJob(job = {}) {
  if (!(LOCALIZE_ONLY_COMPANY_KEYS instanceof Set) || LOCALIZE_ONLY_COMPANY_KEYS.size === 0) return true;
  const key = normalizeCompanyKey(job.companyKey || job.company || '');
  if (key && LOCALIZE_ONLY_COMPANY_KEYS.has(key)) return true;
  const host = normalizeHost(hostOf(job.url || ''));
  if (LOCALIZE_ONLY_COMPANY_KEYS.has(normalizeCompanyKey(host))) return true;
  return false;
}

async function aiTranslateJobDescription({ description, locale, sourceLang = 'en', minChars = 120 }) {
  const floor = Math.max(minChars, 40);
  const clean = cleanDescription(description || '');
  if (!clean || clean.length < floor) return '';
  if (locale === sourceLang) return clean;
  const localPipeline = await translateTextWithLocalPipeline({
    text: clean,
    sourceLang,
    targetLang: locale,
    kind: 'description',
    minChars: floor,
  });
  if (localPipeline && localPipeline.toLowerCase() !== clean.toLowerCase()) {
    return localPipeline;
  }
  const cacheKey = buildAiCacheKey('translate-desc-v2', [clean, locale, sourceLang]);
  const fromCache = getCachedAiResponse(cacheKey);
  if (typeof fromCache === 'string') {
    if (fromCache !== AI_CACHE_RAW_SENTINEL) return fromCache;
    // Sentinel means previous LLM attempt failed — still try free translation APIs
    const sentinelFallback = await fallbackTranslateText({
      text: clean,
      sourceLang,
      targetLang: locale,
      minChars: floor,
    });
    if (sentinelFallback && sentinelFallback.length >= floor && sentinelFallback.toLowerCase() !== clean.toLowerCase()) {
      setCachedAiResponse(cacheKey, sentinelFallback);
      return sentinelFallback;
    }
    return '';
  }
  // Try DeepL first (fast, high quality, saves LLM tokens)
  const deepl = await translateWithDeepL(clean, sourceLang, locale);
  if (deepl && deepl.length >= floor) {
    setCachedAiResponse(cacheKey, deepl);
    return deepl;
  }
  // Fallback to LLM
  const prompt = [
    `Translate this job description from ${sourceLang} to ${locale}.`,
    'Rules:',
    '- Keep company names, product names, acronyms unchanged.',
    '- Do not invent or add new facts.',
    '- Preserve the COMPLETE content — translate every paragraph, section, and detail without summarizing or shortening.',
    '- Keep clear paragraphs and preserve meaning.',
    '- Return only translated text, no markdown, no quotes.',
    '',
    clean,
  ].join('\n');
  if (isAnyModelAvailable()) {
    deeplFallbackToLlm += 1;
    try {
      const text = await callLLM([{ role: 'user', content: prompt }], {
        temperature: 0.1,
        maxTokens: 8192,
        jsonMode: false,
      });
      const translated = cleanDescription(stripCodeFenceJson(String(text || '')));
      if (translated.length >= floor && translated.toLowerCase() !== clean.toLowerCase()) {
        setCachedAiResponse(cacheKey, translated);
        return translated;
      }
    } catch {
      // fallback below
    }
  }
  const fallback = await fallbackTranslateText({
    text: clean,
    sourceLang,
    targetLang: locale,
    minChars: floor,
  });
  if (fallback && fallback.length >= floor && fallback.toLowerCase() !== clean.toLowerCase()) {
    setCachedAiResponse(cacheKey, fallback);
    return fallback;
  }
  setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
  return '';
}


function extractCompanyFromText(html = '', fallback = '') {
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
    if (v && !isLikelyGenericCareerTitle(v)) return v;
  }

  const siteName = normalizeSpace(extractMetaContent(html, 'property', 'og:site_name') || '');
  if (siteName && !isLikelyGenericCareerTitle(siteName)) return siteName;

  return normalizeSpace(fallback);
}

function extractLocationFromText(html = '', fallback = '') {
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
  if (labelLoc) return labelLoc;

  return normalizeSpace(fallback);
}

/**
 * Post-process a raw location string:
 * - Truncate at known noise boundaries ("La posizione consente",
 *   "Aspettiamo", "Wir freuen", "We look forward", etc.)
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
  // If the location is still > 80 chars, take only up to the first sentence-like boundary
  if (clean.length > 80) {
    const sentenceCut = clean.match(/^(.{3,80}?)(?:\.|,|;|\s{2,}|\s-\s)/)?.[1];
    if (sentenceCut) clean = sentenceCut.trim();
    else clean = clean.slice(0, 80).trim();
  }
  // Remove trailing punctuation artifacts
  clean = clean.replace(/[,;:\-·•|]+$/, '').trim();
  return clean;
}

async function fetchHtml(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) return '';
  return await res.text();
}

async function aiLocalizeJobContent({ title, company, location, description, requirements, sourceLang, maxLocales = 4, minChars = 120 }) {
  const floor = Math.max(minChars, 40);
  if (!description || description.length < Math.max(floor, 180)) return null;
  const targetLocales = LOCALES.slice(0, maxLocales).filter((l) => l !== sourceLang);
  const localPipeline = await localizeJobContentWithPipeline({
    title,
    company,
    location,
    description,
    requirements,
    sourceLang,
    targetLocales,
  });
  if (localPipeline) return localPipeline;
  const cacheKey = buildAiCacheKey('localize-job-v2', [
    normalizeSpace(title || ''),
    normalizeSpace(company || ''),
    normalizeSpace(location || ''),
    sourceLang || 'en',
    targetLocales.join(','),
    JSON.stringify((requirements || []).map((x) => normalizeSpace(String(x))).filter(Boolean).slice(0, 16)),
    cleanDescription(description || ''),
  ]);
  const fromCache = getCachedAiResponse(cacheKey);
  if (fromCache === AI_CACHE_RAW_SENTINEL) {
    // Sentinel means previous LLM attempt failed — still try free translation APIs
    const cleanedSource = cleanDescription(description || '');
    if (cleanedSource.length < floor) return null;
    const sentinelOut = {
      [sourceLang]: {
        title: title,
        description: cleanedSource,
        requirements: Array.isArray(requirements)
          ? requirements.map((x) => normalizeSpace(String(x))).filter(Boolean).slice(0, 8)
          : [],
      },
    };
    for (const locale of targetLocales) {
      // eslint-disable-next-line no-await-in-loop
      const desc = await fallbackTranslateText({
        text: cleanedSource,
        sourceLang: sourceLang || 'en',
        targetLang: locale,
        minChars: floor,
      });
      if (desc && desc.length >= floor) {
        // eslint-disable-next-line no-await-in-loop
        const localizedTitle = await fallbackTranslateText({
          text: title,
          sourceLang: sourceLang || 'en',
          targetLang: locale,
          minChars: 2,
        });
        sentinelOut[locale] = {
          title: localizedTitle || title,
          description: desc,
          requirements: [],
        };
      }
    }
    if (Object.keys(sentinelOut).length > 1) {
      setCachedAiResponse(cacheKey, sentinelOut);
      return sentinelOut;
    }
    return null;
  }
  if (fromCache && typeof fromCache === 'object' && !Array.isArray(fromCache)) {
    return fromCache;
  }
  if (!isAnyModelAvailable()) {
    // LLM models exhausted — try free translation APIs per locale
    const cleanedSource = cleanDescription(description || '');
    if (cleanedSource.length < floor) return null;
    const out = {
      [sourceLang]: {
        title: title,
        description: cleanedSource,
        requirements: Array.isArray(requirements)
          ? requirements.map((x) => normalizeSpace(String(x))).filter(Boolean).slice(0, 8)
          : [],
      },
    };
    for (const locale of targetLocales) {
      // eslint-disable-next-line no-await-in-loop
      const desc = await fallbackTranslateText({
        text: cleanedSource,
        sourceLang: sourceLang || 'en',
        targetLang: locale,
        minChars: floor,
      });
      if (desc && desc.length >= floor) {
        // eslint-disable-next-line no-await-in-loop
        const localizedTitle = await fallbackTranslateText({
          text: title,
          sourceLang: sourceLang || 'en',
          targetLang: locale,
          minChars: 2,
        });
        out[locale] = {
          title: localizedTitle || title,
          description: desc,
          requirements: [],
        };
      }
    }
    return Object.keys(out).length > 1 ? out : null;
  }
  const prompt = [
    'You are a multilingual job content editor for SEO.',
    `Translate this job posting into these locales: ${targetLocales.join(', ')}. Do NOT include the source locale (${sourceLang}) — it will be kept as-is.`,
    'CRITICAL: preserve the COMPLETE original content — every section, paragraph, bullet point, and detail MUST appear in each translation. Do NOT omit, condense, or truncate any part of the description.',
    'Keep company, role, location and requirements consistent with source.',
    `Return STRICT JSON only with keys: ${targetLocales.join(',')}.`,
    'Each locale object must contain:',
    '- title: localized job title in the TARGET locale language (do not keep source language title unless it is only brand/acronym), concise, no embellishments',
    '- description: FULL translation of the complete description preserving all paragraphs and sections (use \\n\\n between paragraphs)',
    '- requirements: array of max 8 concise bullet strings',
    '',
    `title: ${title}`,
    `company: ${company}`,
    `location: ${location}`,
    `sourceLanguage: ${sourceLang}`,
    `requirements: ${JSON.stringify((requirements || []).slice(0, 8))}`,
    `description: ${description}`,
  ].join('\n');

  try {
    const messages = [{ role: 'user', content: prompt }];
    const text = await callLLM(messages, {
      temperature: 0.2,
      maxTokens: 16384,
      jsonMode: true,
    });
    const parsed = JSON.parse(stripCodeFenceJson(text));
    const out = {};
    // For the source locale, keep the original description as-is (no translation needed)
    const cleanedSource = cleanDescription(description || '');
    if (cleanedSource.length >= floor) {
      out[sourceLang] = {
        title: title,
        description: cleanedSource,
        requirements: Array.isArray(requirements)
          ? requirements.map((x) => normalizeSpace(String(x))).filter(Boolean).slice(0, 8)
          : [],
      };
    }
    // Apply translated locales from LLM response
    for (const locale of targetLocales) {
      const item = parsed?.[locale];
      if (!item || typeof item !== 'object') continue;
      const localizedTitle = normalizeSpace(item.title || '');
      const desc = cleanDescription(item.description || '');
      const req = Array.isArray(item.requirements)
        ? item.requirements.map((x) => normalizeSpace(String(x))).filter(Boolean).slice(0, 8)
        : [];
      if (desc.length >= floor) out[locale] = {
        title: localizedTitle || title,
        description: desc,
        requirements: req,
      };
    }
    // Fill missing locales from LLM partial results via free translation fallback
    const missingLocales = targetLocales.filter((l) => !out[l]);
    if (missingLocales.length > 0 && cleanedSource.length >= floor) {
      for (const locale of missingLocales) {
        // eslint-disable-next-line no-await-in-loop
        const desc = await fallbackTranslateText({
          text: cleanedSource,
          sourceLang: sourceLang || 'en',
          targetLang: locale,
          minChars: floor,
        });
        if (desc && desc.length >= floor) {
          // eslint-disable-next-line no-await-in-loop
          const localizedTitle = await fallbackTranslateText({
            text: title,
            sourceLang: sourceLang || 'en',
            targetLang: locale,
            minChars: 2,
          });
          out[locale] = {
            title: localizedTitle || title,
            description: desc,
            requirements: [],
          };
        }
      }
    }
    if (Object.keys(out).length > 0) {
      setCachedAiResponse(cacheKey, out);
      return out;
    }
  } catch {
    // LLM failed — try free translation APIs per locale as fallback
    const cleanedFallback = cleanDescription(description || '');
    if (cleanedFallback.length >= floor) {
      const fallbackOut = {
        [sourceLang]: {
          title: title,
          description: cleanedFallback,
          requirements: Array.isArray(requirements)
            ? requirements.map((x) => normalizeSpace(String(x))).filter(Boolean).slice(0, 8)
            : [],
        },
      };
      for (const locale of targetLocales) {
        // eslint-disable-next-line no-await-in-loop
        const desc = await fallbackTranslateText({
          text: cleanedFallback,
          sourceLang: sourceLang || 'en',
          targetLang: locale,
          minChars: floor,
        });
        if (desc && desc.length >= floor) {
          // eslint-disable-next-line no-await-in-loop
          const localizedTitle = await fallbackTranslateText({
            text: title,
            sourceLang: sourceLang || 'en',
            targetLang: locale,
            minChars: 2,
          });
          fallbackOut[locale] = {
            title: localizedTitle || title,
            description: desc,
            requirements: [],
          };
        }
      }
      if (Object.keys(fallbackOut).length > 1) {
        setCachedAiResponse(cacheKey, fallbackOut);
        return fallbackOut;
      }
    }
  }
  setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
  return null;
}

async function aiTranslateJobTitle({ title, locale, sourceLang = 'en' }) {
  const cleanTitle = normalizeSpace(title || '');
  if (!cleanTitle || locale === sourceLang) return cleanTitle;
  const localPipeline = await translateTextWithLocalPipeline({
    text: cleanTitle,
    sourceLang,
    targetLang: locale,
    kind: 'title',
    context: { title: cleanTitle },
    minChars: 2,
  });
  if (localPipeline && localPipeline.toLowerCase() !== cleanTitle.toLowerCase()) {
    return localPipeline;
  }
  const cacheKey = buildAiCacheKey('translate-title-v2', [cleanTitle, locale, sourceLang]);
  const fromCache = getCachedAiResponse(cacheKey);
  if (typeof fromCache === 'string') {
    if (fromCache !== AI_CACHE_RAW_SENTINEL) return fromCache;
    // Sentinel means previous LLM attempt failed — still try free translation APIs
    const sentinelFallback = await fallbackTranslateText({
      text: cleanTitle,
      sourceLang,
      targetLang: locale,
      minChars: 2,
    });
    if (sentinelFallback && sentinelFallback.toLowerCase() !== cleanTitle.toLowerCase() &&
        !isLowQualityLocalizedTitle(sentinelFallback)) {
      setCachedAiResponse(cacheKey, sentinelFallback);
      return sentinelFallback;
    }
    return cleanTitle;
  }
  // Try DeepL first (fast, high quality, saves LLM tokens)
  const deepl = await translateWithDeepL(cleanTitle, sourceLang, locale);
  if (deepl && deepl.length >= 2 && !isLowQualityLocalizedTitle(deepl)) {
    setCachedAiResponse(cacheKey, deepl);
    return deepl;
  }
  // Fallback to LLM
  if (isAnyModelAvailable()) {
    deeplFallbackToLlm += 1;
    const prompt = [
      `Translate this job title from ${sourceLang} to ${locale}.`,
      'Rules:',
      '- Keep brand names/acronyms unchanged.',
      '- Translate role words naturally for the target locale.',
      '- Return only the translated title, no quotes, no extra text.',
      `Title: ${cleanTitle}`,
    ].join('\n');
    try {
      const text = await callLLM([{ role: 'user', content: prompt }], {
        temperature: 0.1,
        maxTokens: 80,
        jsonMode: false,
      });
      const translated = normalizeSpace(String(text || '').replace(/^["']|["']$/g, ''));
      if (
        translated &&
        translated.toLowerCase() !== cleanTitle.toLowerCase() &&
        !isLowQualityLocalizedTitle(translated)
      ) {
        setCachedAiResponse(cacheKey, translated);
        return translated;
      }
    } catch {
      // fallback below
    }
  }
  const fallback = await fallbackTranslateText({
    text: cleanTitle,
    sourceLang,
    targetLang: locale,
    minChars: 2,
  });
  if (fallback) {
    setCachedAiResponse(cacheKey, fallback);
    return fallback;
  }
  const heuristic = heuristicTranslateJobTitle(cleanTitle, locale);
  if (heuristic && !isLowQualityLocalizedTitle(heuristic)) {
    setCachedAiResponse(cacheKey, heuristic);
    return heuristic;
  }
  setCachedAiResponse(cacheKey, AI_CACHE_RAW_SENTINEL);
  return cleanTitle;
}


async function enrichJobLocales(job, crawlerConfig) {
  const out = { ...job };
  const titleByLocale = (out.titleByLocale && typeof out.titleByLocale === 'object')
    ? { ...out.titleByLocale }
    : {};
  const currentByLocale = (out.descriptionByLocale && typeof out.descriptionByLocale === 'object')
    ? { ...out.descriptionByLocale }
    : {};
  const sourceLang = detectLang(out.description || '', 'en');
  const forceLocalization = shouldForceLocalizationForJob(out);
  const titleSourceLang = detectJobTitleLang(out.title || '', sourceLang);
  const sourceTitle = normalizeSpace(titleByLocale[titleSourceLang] || out.title || '');
  if (sourceTitle) {
    titleByLocale[titleSourceLang] = sourceTitle;
  }
  const titleNeedsLocalization = LOCALES
    .filter((l) => l !== titleSourceLang)
    .some((locale) => {
      const localizedTitle = normalizeSpace(titleByLocale[locale] || '');
      if (!localizedTitle) return true;
      return sourceTitle && localizedTitle.toLowerCase() === sourceTitle.toLowerCase();
    });
  const localeDescFloor = crawlerConfig?.minDescriptionChars || 120;
  const coverage = LOCALES.filter((l) => normalizeSpace(currentByLocale[l] || '').length >= localeDescFloor).length;
  const hasBudget =
    aiLocalizationCalls < (crawlerConfig?.aiLocalizationMaxJobsPerRun || 0) || forceLocalization;
  const canUseAi = isAnyModelAvailable();
  const localizationEnabled = Boolean(crawlerConfig?.aiLocalizationEnabled) || forceLocalization;
  const shouldRunDescriptionLocalization =
    localizationEnabled &&
    hasBudget &&
    (coverage < LOCALES.length || forceLocalization) &&
    (out.description || '').length >= Math.max(localeDescFloor, 80) &&
    (canUseAi || forceLocalization);
  const shouldRunTitleLocalization =
    localizationEnabled &&
    sourceTitle.length >= 3 &&
    (titleNeedsLocalization || forceLocalization);
  if (!shouldRunDescriptionLocalization && !shouldRunTitleLocalization) return out;

  // ── Structure flat descriptions into markdown before AI localization ──
  // This ensures that the source text is well-formatted before being translated,
  // producing better quality translations and structured output for all locales.
  const rawDesc = out.description || '';
  const hasMarkdownStructure = /^## /m.test(rawDesc) && ((rawDesc.match(/\n/g) || []).length >= 3);
  if (shouldRunDescriptionLocalization && rawDesc.length >= 100 && !hasMarkdownStructure) {
    const hasHtml = /<[^>]+>/.test(rawDesc);
    if (hasHtml) {
      // Prefer deterministic HTML → text conversion for ATS APIs (Oracle, Workday, etc.)
      // to avoid LLM truncation/reformatting drift on already rich descriptions.
      const structuredFromHtml = htmlToStructuredText(rawDesc);
      if (structuredFromHtml && structuredFromHtml.length >= 120) {
        out.description = structuredFromHtml;
        currentByLocale[sourceLang] = structuredFromHtml;
      }
    } else {
      const structured = await structureJobDescription(rawDesc);
      if (structured !== rawDesc) {
        out.description = structured;
        // Also update the source locale so it gets the structured version
        currentByLocale[sourceLang] = structured;
      }
    }
  }

  // ── Centralized thin-description enrichment ──
  // If the description is still thin but we have extracted structured data
  // (responsibilities, requirements, benefits), use AI to compose a rich description.
  // This runs for ALL crawlers, not just Migros.
  const currentDesc = normalizeSpace(out.description || '');
  const hasExtractedData =
    (Array.isArray(out._migrosResponsibilities) && out._migrosResponsibilities.length > 0) ||
    (Array.isArray(out._migrosBenefits) && out._migrosBenefits.length > 0) ||
    (Array.isArray(out.requirements) && out.requirements.length > 0);
  if (shouldRunDescriptionLocalization && currentDesc.length < 500 && hasExtractedData && canUseAi) {
    const enrichedDesc = await aiEnrichThinDescription(out);
    if (enrichedDesc && enrichedDesc !== out.description && enrichedDesc.length > currentDesc.length) {
      out.description = enrichedDesc;
      currentByLocale[sourceLang] = enrichedDesc;
    }
  }

  const aiLocalized = shouldRunDescriptionLocalization && canUseAi
    ? await aiLocalizeJobContent({
      title: out.title,
      company: out.company,
      location: out.location,
      description: out.description,
      requirements: out.requirements || [],
      sourceLang,
      minChars: localeDescFloor,
    })
    : null;
  if (shouldRunDescriptionLocalization) {
    aiLocalizationCalls += 1;
  }

  const reqByLocale = (out.requirementsByLocale && typeof out.requirementsByLocale === 'object')
    ? { ...out.requirementsByLocale }
    : {};
  if (aiLocalized) {
    for (const locale of LOCALES) {
      const localized = aiLocalized[locale];
      if (!localized) continue;
      if (localized.title && localized.title.length >= 4 && !isLowQualityLocalizedTitle(localized.title)) {
        titleByLocale[locale] = localized.title;
      }
      if (localized.description && localized.description.length >= localeDescFloor) {
        currentByLocale[locale] = localized.description;
      }
      const mergedReq = mergeRequirements(reqByLocale[locale] || [], localized.requirements || []);
      if (mergedReq.length > 0) reqByLocale[locale] = mergedReq;
    }
  }
  if (shouldRunTitleLocalization) {
    for (const locale of LOCALES) {
      if (locale === titleSourceLang) continue;
      const localizedTitle = normalizeSpace(titleByLocale[locale] || '');
      if (
        localizedTitle &&
        localizedTitle.toLowerCase() !== sourceTitle.toLowerCase() &&
        !isLowQualityLocalizedTitle(localizedTitle)
      ) continue;
      const forced = await aiTranslateJobTitle({ title: sourceTitle, locale, sourceLang: titleSourceLang });
      if (forced && forced.toLowerCase() !== sourceTitle.toLowerCase() && !isLowQualityLocalizedTitle(forced)) {
        titleByLocale[locale] = forced;
        continue;
      }
      const fallback = heuristicTranslateJobTitle(sourceTitle, locale);
      if (fallback && fallback.toLowerCase() !== sourceTitle.toLowerCase() && !isLowQualityLocalizedTitle(fallback)) {
        titleByLocale[locale] = fallback;
      }
    }
  }

  // Strict fallback for forced companies (e.g. VF): ensure translated content exists per locale.
  if (forceLocalization) {
    for (const locale of LOCALES) {
      const currentDesc = cleanDescription(currentByLocale[locale] || '');
      const sourceDesc = cleanDescription(out.description || '');
      const needsDesc =
        locale !== sourceLang &&
        (!currentDesc || currentDesc.length < localeDescFloor || currentDesc.toLowerCase() === sourceDesc.toLowerCase());
      if (needsDesc) {
        // eslint-disable-next-line no-await-in-loop
        const translatedDesc = await aiTranslateJobDescription({
          description: out.description || '',
          locale,
          sourceLang,
          minChars: localeDescFloor,
        });
        if (translatedDesc) {
          currentByLocale[locale] = translatedDesc;
          const mergedReq = mergeRequirements(
            reqByLocale[locale] || [],
            extractRequirements(translatedDesc)
          );
          if (mergedReq.length > 0) reqByLocale[locale] = mergedReq;
        }
      }
      const currentTitle = normalizeSpace(titleByLocale[locale] || '');
      if (locale !== titleSourceLang && (!currentTitle || currentTitle.toLowerCase() === sourceTitle.toLowerCase())) {
        // eslint-disable-next-line no-await-in-loop
        const translatedTitle = await aiTranslateJobTitle({ title: sourceTitle, locale, sourceLang: titleSourceLang });
        if (
          translatedTitle &&
          translatedTitle.toLowerCase() !== sourceTitle.toLowerCase() &&
          !isLowQualityLocalizedTitle(translatedTitle)
        ) {
          titleByLocale[locale] = translatedTitle;
        }
      }
    }
  }

  // ── Inline truncation detection ──
  // Catch translations that are significantly shorter than source (likely truncated by LLM)
  // and re-attempt translation via the fallback cascade.
  const TRUNCATION_RATIO = 0.40;
  const sourceDescLen = cleanDescription(out.description || '').length;
  if (sourceDescLen >= 200) {
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      const localized = cleanDescription(currentByLocale[locale] || '');
      if (localized.length > 0 && localized.length < sourceDescLen * TRUNCATION_RATIO) {
        // Truncated — attempt re-translation via DeepL/LLM cascade
        // eslint-disable-next-line no-await-in-loop
        const retranslated = await aiTranslateJobDescription({
          description: out.description || '',
          locale,
          sourceLang,
          minChars: localeDescFloor,
        });
        if (retranslated && cleanDescription(retranslated).length > localized.length) {
          currentByLocale[locale] = retranslated;
        }
      }
    }
  }

  // ── Cross-locale copy detection ──
  // Detect when a non-source locale has the same text as the source (translation was skipped/copied)
  const sourceDescNorm = cleanDescription(out.description || '').toLowerCase();
  if (sourceDescNorm.length >= localeDescFloor) {
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      const localizedNorm = cleanDescription(currentByLocale[locale] || '').toLowerCase();
      if (localizedNorm && localizedNorm === sourceDescNorm) {
        // Same as source — try translating
        // eslint-disable-next-line no-await-in-loop
        const translated = await aiTranslateJobDescription({
          description: out.description || '',
          locale,
          sourceLang,
          minChars: localeDescFloor,
        });
        if (translated && cleanDescription(translated).toLowerCase() !== sourceDescNorm) {
          currentByLocale[locale] = translated;
        }
      }
    }
  }

  out.titleByLocale = titleByLocale;
  out.descriptionByLocale = currentByLocale;
  out.requirementsByLocale = reqByLocale;
  return out;
}

function hasUntranslatedLocaleDescriptions(job = {}) {
  const sourceDesc = cleanDescription(job?.description || '');
  if (!sourceDesc) return false;
  const sourceLang = detectLang(sourceDesc, 'en');
  for (const locale of LOCALES) {
    if (locale === sourceLang) continue;
    const localized = cleanDescription(job?.descriptionByLocale?.[locale] || '');
    if (!localized) return true;
    if (localized.toLowerCase() === sourceDesc.toLowerCase()) return true;
  }
  return false;
}

function hasUntranslatedLocaleTitles(job = {}) {
  const sourceTitle = normalizeSpace(job?.title || '');
  if (!sourceTitle) return false;
  const sourceLang = detectJobTitleLang(sourceTitle, detectLang(job?.description || '', 'en'));
  for (const locale of LOCALES) {
    if (locale === sourceLang) continue;
    const localized = normalizeSpace(job?.titleByLocale?.[locale] || '');
    if (!localized) return true;
    if (localized.toLowerCase() === sourceTitle.toLowerCase()) return true;
  }
  return false;
}

async function enrichJobLocalesWithRetry(job, crawlerConfig, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await enrichJobLocales(job, crawlerConfig);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || '').toLowerCase();
      const quotaExhausted =
        msg.includes('all ai models failed') ||
        msg.includes('daily request limit') ||
        msg.includes('daily quota') ||
        msg.includes('exceeded your current quota') ||
        msg.includes('plan and billing details');
      if (quotaExhausted) {
        break;
      }
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  const slug = job?.slug || job?.id || 'unknown';
  const message = lastError?.message || String(lastError || 'unknown error');
  console.warn(`⚠️  Localization failed for ${slug}: ${message}`);
  return job;
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

const CRAWLER_USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)';

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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
    });
    const fetchPromise = fetch(url, {
      method: upperMethod,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent || CRAWLER_USER_AGENT,
        ...headers,
      },
      body,
    });
    try {
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      if (attempt < maxAttempts && isRetryableFetchStatus(res.status)) {
        // Drain and drop transient response body before retrying.
        try { await res.arrayBuffer(); } catch {}
        await sleep(fetchRetryDelayMs(attempt));
        continue;
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
  const rx = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = rx.exec(String(html))) !== null) {
    const decoded = decodeSearchRedirectUrl(m[1]);
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
    const items = Array.isArray(data?.items) ? data.items : [];
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
    browser = await chromium.launch({ headless: true });
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
  if (aiPageValidationCalls >= (crawlerConfigGlobal?.aiPageValidationMaxPagesPerRun || 0)) {
    return { isJob: true, confidence: 0.5, reason: 'max_pages_reached' };
  }
  aiPageValidationCalls += 1;

  const text = stripHtml(html).slice(0, 5000);
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
    const raw = await callLLM(messages, {
      temperature: 0,
      maxTokens: 400,
      jsonMode: true,
    });
    const parsed = JSON.parse(stripCodeFenceJson(raw));
    return {
      isJob: Boolean(parsed?.isJobDetail),
      confidence: Number(parsed?.confidence || 0),
      reason: normalizeSpace(parsed?.reason || 'ai_classification'),
    };
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
  const regex = /<a[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const href = m[1];
    const url = tryUrl(href, baseUrl);
    if (url) links.add(url);
  }
  return [...links];
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function decodeNumericEntities(value = '') {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

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
  const iso = new Date(Date.UTC(y, mm - 1, d)).toISOString();
  return iso.slice(0, 10);
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
    const postings = Array.isArray(payload?.jobPostings) ? payload.jobPostings : [];
    total = Number(payload?.total || postings.length || 0);
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
      if (isExplicitlyOutsideTarget(geoSignal) || isExplicitlyOutsideSwissTicino(geoSignal)) continue;
      if (!location && !isTargetSwissLocation(`${title} ${descriptionSeed}`)) continue;
      if (!location) location = company.city || 'Ticino';
      if (!isTargetSwissLocation(`${title} ${location} ${descriptionSeed}`)) continue;
      const inferredCanton = inferSwissTargetCanton(`${title} ${location} ${descriptionSeed}`) || 'TI';
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
    if (postings.length < limit) break;
  } while (offset < total && offset < 200);

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
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const out = [];
  for (const j of jobs) {
    const title = normalizeSpace(j?.title || j?.name || '');
    if (!title || isLikelyGenericCareerTitle(title)) continue;
    const detailUrl = tryUrl(j?.absolute_url || j?.url || '', source.listingUrl);
    if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;
    const location = normalizeSpace(j?.location?.name || j?.location || company.city || 'Ticino');
    if (!isTargetSwissLocation(location)) continue;
    const description = cleanDescription(j?.content || j?.description || `${title}. ${location}`);
    const inferredCanton = inferSwissTargetCanton(`${title} ${location} ${description}`) || 'TI';
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
  const jobs = Array.isArray(payload) ? payload : [];
  const out = [];
  for (const j of jobs) {
    const title = normalizeSpace(j?.text || j?.title || '');
    if (!title || isLikelyGenericCareerTitle(title)) continue;
    const detailUrl = tryUrl(j?.hostedUrl || j?.applyUrl || '', source.listingUrl);
    if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;
    const location = normalizeSpace(j?.categories?.location || j?.workplaceType || company.city || 'Ticino');
    if (!isTargetSwissLocation(location)) continue;
    const description = cleanDescription(j?.descriptionPlain || j?.description || `${title}. ${location}`);
    const inferredCanton = inferSwissTargetCanton(`${title} ${location} ${description}`) || 'TI';
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
  const jobs = Array.isArray(payload?.content) ? payload.content : [];
  const out = [];
  for (const j of jobs) {
    const title = normalizeSpace(j?.name || '');
    if (!title || isLikelyGenericCareerTitle(title)) continue;
    const detailUrl = tryUrl(j?.ref ? `https://jobs.smartrecruiters.com/${source.company}/${j.ref}` : '', source.listingUrl);
    if (!detailUrl || !isLikelyJobDetailUrl(detailUrl)) continue;
    const location = normalizeSpace(j?.location?.city || j?.location?.region || company.city || 'Ticino');
    if (!isTargetSwissLocation(location)) continue;
    const description = cleanDescription(`${title}. ${location}. ${normalizeSpace(j?.releasedDate || '')}`);
    const inferredCanton = inferSwissTargetCanton(`${title} ${location} ${description}`) || 'TI';
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
  const regex = /<a[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const href = m[1];
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
        if (parsed.job) jobs.push(parsed.job);
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
          if (parsed.job) {
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
  const rows = Array.isArray(payload?.results) ? payload.results : [];
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
    merged.canton = inferSwissTargetCanton(`${merged.title} ${merged.location} ${merged.description}`) || merged.canton || 'TI';
    out.push(merged);
  }
  return out;
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

  if (!title || title.length < 6) return { job: null, reason: 'jsonld_missing_title' };
  if (isLikelyGenericCareerTitle(title)) return { job: null, reason: 'jsonld_generic_title' };
  if (!isLikelyJobDetailUrl(url)) return { job: null, reason: 'jsonld_not_detail_url' };

  // Include addressRegion in relevance check so that jobs in smaller Ticino towns
  // (e.g., Taverne) are still recognized when addressRegion says "Ticino".
  const mergedLocText = `${title} ${location} ${addressRegion} ${description}`;
  if (isLikelyCommercialPromoContent({ title, description, pageUrl: url })) {
    return { job: null, reason: 'jsonld_commercial_promo_page' };
  }
  if (isLocationExplicitlyForeign(location) && !seedMetaRelevant) return { job: null, reason: 'jsonld_location_explicitly_foreign' };
  if ((isExplicitlyOutsideTarget(mergedLocText) || isExplicitlyOutsideSwissTicino(mergedLocText)) && !seedMetaRelevant) {
    return { job: null, reason: 'jsonld_explicitly_outside_target' };
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
  const inferredJsonLdCanton = inferSwissTargetCanton(`${title} ${normalizedLocation || location} ${addressRegion} ${description}`);

  const job = {
    id: '',
    slug: '',
    company: company || fallbackCompany,
    title,
    location: normalizedLocation || seedLocation || 'Ticino',
    canton: seedCanton || inferredJsonLdCanton || 'TI',
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

  return { job, reason: null };
}

function extractTitleFromHtml(html) {
  return normalizeSpace(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
}

function extractH1FromHtml(html = '') {
  return normalizeSpace(stripHtml(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''));
}

function extractMetaContent(html, attr, value) {
  const re = new RegExp(`<meta[^>]*${attr}=["']${value}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
  return normalizeSpace(html.match(re)?.[1] || '');
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
  const sectionRe = /^(compiti|requisiti|condizioni|scadenza|aufgaben|anforderungen)\s*:/i;
  const candidates = h2s.filter((h) => (
    h.length > 20 &&
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
  const locationMatch =
    supsiParsed?.location ||
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
  if (isLocationExplicitlyForeign(locationMatch) && !seedMetaRelevant) return { job: null, reason: 'html_location_explicitly_foreign' };
  if ((isExplicitlyOutsideTarget(geoSignal) || isExplicitlyOutsideSwissTicino(geoSignal)) && !seedMetaRelevant) {
    return { job: null, reason: 'html_explicitly_outside_target' };
  }
  if (!isTargetSwissLocation(geoSignalExplicit) && !seedMetaRelevant) return { job: null, reason: 'html_not_target_relevant' };
  const inferredHtmlCanton = inferSwissTargetCanton(geoSignalExplicit);

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

function fingerprintJob(job) {
  const identity = extractJobIdentityFromUrl(job.url || '');
  if (identity) return `id|${identity}`;

  const canonicalUrl = canonicalizeJobUrl(job.url || '');
  if (canonicalUrl) return `url|${canonicalUrl}`;

  const domain = registrableDomain(hostOf(job.url || '')) || normalizeSpace(job.company).toLowerCase();
  const key = `${normalizeSpace(job.title).toLowerCase()}|${normalizeSpace(job.location).toLowerCase()}|${domain}`;
  return `tl|${key.replace(/\s+/g, ' ')}`;
}

function dedupHeuristicKey(job) {
  const identity = extractJobIdentityFromUrl(job?.url || '');
  if (identity) return `id|${identity}`;

  const domain = registrableDomain(hostOf(job?.url || '')) || normalizeSpace(job?.company).toLowerCase();
  const company = normalizeSpace(job?.company || '').toLowerCase().replace(/\s+/g, ' ');
  const title = normalizeSpace(job?.title || '').toLowerCase().replace(/\s+/g, ' ');
  const location = normalizeSpace(job?.location || '').toLowerCase().replace(/\s+/g, ' ');
  const canton = normalizeCantonCode(job?.canton || '');
  const contract = normalizeContract(job?.contract || '', job?.title || '', '').toLowerCase();
  const category = normalizeSpace(job?.category || '').toLowerCase();
  const salaryMin = Number.isFinite(Number(job?.salaryMin)) ? Math.round(Number(job.salaryMin)) : '';
  const salaryMax = Number.isFinite(Number(job?.salaryMax)) ? Math.round(Number(job.salaryMax)) : '';

  return `h|${domain}|${company}|${title}|${location}|${canton}|${contract}|${category}|${salaryMin}-${salaryMax}`;
}

function buildStableId(job) {
  const s = fingerprintJob(job);
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return `company-${Math.abs(hash).toString(36)}`;
}

function ensureJobSlug(job) {
  // Build slug from title first; only append company+location if short enough.
  // Italian government job titles are very long ("Concorso generale 2026:
  // aiuto cucina presso l'Ufficio della refezione e dei trasporti scolastici"),
  // so concatenating title+company+location caused truncation at the old 90-char limit.
  const titleSlug = slugify(job.title);
  const fullSlug = slugify(`${job.title}-${job.company}-${job.location}`);
  // Prefer full slug if it fits comfortably; otherwise title-only slug is more readable
  const base = (fullSlug && fullSlug.length <= 140) ? fullSlug : (titleSlug || job.id || 'job');
  return base;
}

function preferJob(a, b) {
  const aScore = qualityScore(a) + (a.featured ? 2 : 0) + ((a.source === 'Company Careers Crawler') ? 1 : 0);
  const bScore = qualityScore(b) + (b.featured ? 2 : 0) + ((b.source === 'Company Careers Crawler') ? 1 : 0);
  if (aScore !== bScore) return aScore > bScore ? a : b;
  const aRecency = recencyTs(a);
  const bRecency = recencyTs(b);
  if (aRecency !== bRecency) return aRecency > bRecency ? a : b;
  const aDesc = (a.description || '').length;
  const bDesc = (b.description || '').length;
  if (aDesc !== bDesc) return aDesc > bDesc ? a : b;
  return a;
}

function pruneStaleCrawlerJobs(existingJobs, incomingJobs, results, options = {}) {
  const activeDomains = new Set(
    (results || [])
      .filter((r) => (r?.processedCandidates || 0) > 0 || (r?.scrapedJobPages || 0) > 0 || (r?.discardedCount || 0) > 0)
      .map((r) => normalizeHost(r?.companyDomain || ''))
      .filter(Boolean)
  );
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
      if (hasScopedCompanyKeys) {
        const key = normalizeCompanyKey(String(job?.companyKey || job?.company || ''));
        if (!scopeCompanyKeys.has(key)) {
          prunedExisting.push(job);
          continue;
        }
      }
      const fp = fingerprintJob(job);
      if (fp && !incomingFp.has(fp)) {
        removed += 1;
        continue;
      }
    }
    prunedExisting.push(job);
  }
  return { prunedExisting, removed };
}

function getMergeExclusionReasons(job, qualityCfg) {
  const reasons = [];
  if (!(job?.title && job?.company && job?.location && job?.description)) {
    reasons.push('missing_required_fields');
    return reasons;
  }
  if (isLikelyGenericCareerTitle(job.title)) reasons.push('generic_title');
  if (!isLikelyJobDetailUrl(job.url || '') && !hasSeedMetaTargetScope(job)) reasons.push('non_detail_url');
  if (/linkedin\.com/i.test(String(job.url || ''))) reasons.push('linkedin_url');
  if (isLocationExplicitlyForeign(job.location) && !hasSeedMetaTargetScope(job)) reasons.push('location_explicitly_foreign');
  if (!isJobPortalRelevant(job)) reasons.push('not_ticino_relevant');
  {
    const signal = `${job.title} ${job.location} ${job.description}`;
    const hasLocalPrimaryScope = isTargetSwissLocation(job.location || '');
    // If the primary job location is already in TI/GR, do not reject due to
    // incidental mentions of other cities in the description (e.g. travel).
    if (!hasLocalPrimaryScope) {
      if (isExplicitlyOutsideTarget(signal) && !hasSeedMetaTargetScope(job)) reasons.push('explicitly_outside_target');
      if (isExplicitlyOutsideSwissTicino(signal) && !hasSeedMetaTargetScope(job)) reasons.push('outside_swiss_ticino');
    }
  }
  const quality = evaluateJobQuality(job, qualityCfg);
  if (!quality.accepted) {
    reasons.push(...quality.reasons);
  }
  return reasons;
}

function mergeAndDeduplicate(existingJobs, incomingJobs, qualityCfg, options = {}) {
  const nowIsoDate = dateOnly(Date.now());
  const nowIsoTs = new Date().toISOString();
  const map = new Map();
  const scopeCompanyKeys = new Set(
    (Array.isArray(options.scopeCompanyKeys) ? options.scopeCompanyKeys : [])
      .map((k) => normalizeCompanyKey(k))
      .filter(Boolean)
  );
  const hasScopedCompanyKeys = scopeCompanyKeys.size > 0;
  let duplicateExisting = 0;

  // Keep existing jobs as baseline
  for (const job of existingJobs) {
    if (
      job?.source === 'Company Careers Crawler' &&
      !normalizeSpace(job?.crawledAt || '')
    ) {
      // Drop legacy crawler entries without crawl timestamp; they will be re-ingested with richer extraction.
      continue;
    }
    const fp = fingerprintJob(job);
    if (!fp) continue;
    const normalized = {
      ...job,
      crawledAt: normalizeSpace(job.crawledAt || ''),
    };
    const prev = map.get(fp);
    if (!prev) {
      map.set(fp, normalized);
      continue;
    }
    duplicateExisting += 1;
    map.set(fp, preferJob(prev, normalized));
  }

  let inserted = 0;
  let refreshed = 0;
  let duplicateIncoming = 0;
  let reusedLocalizationFromPrevious = 0;
  const insertedByCompany = {};
  const refreshedByCompany = {};
  const duplicateByCompany = {};
  const seenIncoming = new Set();

  for (const raw of incomingJobs) {
    const fp = fingerprintJob(raw);
    if (!fp) continue;
    if (seenIncoming.has(fp)) {
      duplicateIncoming += 1;
      duplicateByCompany[raw.company] = (duplicateByCompany[raw.company] || 0) + 1;
      continue;
    }
    seenIncoming.add(fp);
    const next = {
      ...raw,
      id: raw.id || buildStableId(raw),
      crawledAt: nowIsoTs,
    };
    const prev = map.get(fp);
    if (!prev) {
      map.set(fp, next);
      inserted += 1;
      insertedByCompany[next.company] = (insertedByCompany[next.company] || 0) + 1;
      continue;
    }
    // Prefer richer/newer values
    const best = {
      ...prev,
      ...next,
      id: prev.id || next.id,
      postedDate: next.postedDate || prev.postedDate || nowIsoDate,
      // Preserve original crawledAt so fresh protection expires naturally.
      // Without this, re-crawled jobs get perpetually fresh timestamps,
      // preventing cleanup from ever removing dead URLs.
      crawledAt: prev.crawledAt || next.crawledAt || nowIsoTs,
      description: (next.description?.length || 0) >= (prev.description?.length || 0) ? next.description : prev.description,
      requirements: (next.requirements?.length || 0) >= (prev.requirements?.length || 0) ? next.requirements : prev.requirements,
      source: (next.source === 'Company Careers Crawler' || prev.source !== 'Company Careers Crawler')
        ? next.source
        : prev.source,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale || {}, next.titleByLocale || {}, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale || {}, next.descriptionByLocale || {}, 120),
      requirementsByLocale: mergeLocaleRequirementsMap(prev.requirementsByLocale || {}, next.requirementsByLocale || {}),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale || {}, next.slugByLocale || {}, 3),
    };
    if (shouldReusePreviousLocalization(prev, next, options.contentReuse || {})) {
      best.titleByLocale = { ...(prev.titleByLocale || {}) };
      best.descriptionByLocale = { ...(prev.descriptionByLocale || {}) };
      best.requirementsByLocale = { ...(prev.requirementsByLocale || {}) };
      best.slugByLocale = { ...(prev.slugByLocale || {}) };
      reusedLocalizationFromPrevious += 1;
    }
    if (localeTextCoverage(best.descriptionByLocale, 120) === 0 && (best.description || '').length >= 120) {
      const fallbackDesc = {};
      const descSourceLang = detectLang(best.description || '', 'en');
      fallbackDesc[descSourceLang] = best.description;
      best.descriptionByLocale = fallbackDesc;
    }
    if (localeTextCoverage(best.titleByLocale, 3) === 0 && best.title) {
      const fallbackTitle = {};
      const titleSourceLang = detectJobTitleLang(best.title, detectLang(best.description || '', 'en'));
      fallbackTitle[titleSourceLang] = best.title;
      best.titleByLocale = fallbackTitle;
    }
    const chosen = preferJob(prev, best);
    // Carry forward _targetScope from the merged candidate even when
    // preferJob picks the existing entry (identical quality/recency).
    if (best._targetScope && !chosen._targetScope) {
      chosen._targetScope = best._targetScope;
    }
    map.set(fp, chosen);
    refreshed += 1;
    refreshedByCompany[best.company] = (refreshedByCompany[best.company] || 0) + 1;
  }

  const allMerged = [...map.values()];
  const inScopeJobs = hasScopedCompanyKeys
    ? allMerged.filter((j) => {
      const key = normalizeCompanyKey(String(j?.companyKey || j?.company || ''));
      return scopeCompanyKeys.has(key);
    })
    : allMerged;
  const outOfScopeJobs = hasScopedCompanyKeys
    ? allMerged.filter((j) => {
      const key = normalizeCompanyKey(String(j?.companyKey || j?.company || ''));
      return !scopeCompanyKeys.has(key);
    })
    : [];

  const mergeExclusionByReason = {};
  const mergeExclusionSamples = [];
  let mergeExcludedJobs = 0;
  const acceptedInScopeJobs = [];
  for (const job of inScopeJobs) {
    const reasons = getMergeExclusionReasons(job, qualityCfg);
    if (reasons.length === 0) {
      acceptedInScopeJobs.push(job);
      continue;
    }
    mergeExcludedJobs += 1;
    for (const reason of new Set(reasons)) {
      mergeExclusionByReason[reason] = (mergeExclusionByReason[reason] || 0) + 1;
    }
    if (mergeExclusionSamples.length < 30) {
      mergeExclusionSamples.push({
        reason: reasons[0],
        title: normalizeSpace(job?.title || ''),
        company: normalizeSpace(job?.company || ''),
        location: normalizeSpace(job?.location || ''),
        url: normalizeSpace(job?.url || ''),
      });
    }
  }

  const merged = acceptedInScopeJobs
    .sort((a, b) => {
      const recencyDiff = recencyTs(b) - recencyTs(a);
      if (recencyDiff !== 0) return recencyDiff;
      return String(b.postedDate).localeCompare(String(a.postedDate));
    });

  // ── Heuristic dedup (identity first, then multi-field fallback) ──
  let heuristicDupes = 0;
  const seenHeuristic = new Map();
  for (const job of merged) {
    const dedupKey = dedupHeuristicKey(job);
    const prev = seenHeuristic.get(dedupKey);
    if (prev) {
      heuristicDupes += 1;
      seenHeuristic.set(dedupKey, preferJob(prev, job));
    } else {
      seenHeuristic.set(dedupKey, job);
    }
  }
  const deduped = [...seenHeuristic.values()].sort((a, b) => {
    const recencyDiff = recencyTs(b) - recencyTs(a);
    if (recencyDiff !== 0) return recencyDiff;
    return String(b.postedDate).localeCompare(String(a.postedDate));
  });

  const withPreservedOutOfScope = hasScopedCompanyKeys
    ? [...outOfScopeJobs, ...deduped]
    : deduped;
  const dedupedByFp = new Map();
  for (const job of withPreservedOutOfScope) {
    const fp = fingerprintJob(job);
    if (!fp) continue;
    const prev = dedupedByFp.get(fp);
    dedupedByFp.set(fp, prev ? preferJob(prev, job) : job);
  }
  const finalJobs = [...dedupedByFp.values()].sort((a, b) => {
    const recencyDiff = recencyTs(b) - recencyTs(a);
    if (recencyDiff !== 0) return recencyDiff;
    return String(b.postedDate).localeCompare(String(a.postedDate));
  });
  if (heuristicDupes > 0) {
    console.log(`\n🔄 Heuristic dedup: removed ${heuristicDupes} duplicate(s) using identity + multi-field signature`);
  }

  const usedSlugs = new Set();
  for (const job of deduped) {
    let slug = normalizeSpace(job.slug || ensureJobSlug(job));
    if (!slug) slug = `job-${job.id}`;
    let candidate = slug;
    let suffix = 2;
    while (usedSlugs.has(candidate)) {
      candidate = `${slug}-${suffix}`;
      suffix += 1;
    }
    job.slug = candidate;
    usedSlugs.add(candidate);
  }

  return {
    merged: finalJobs,
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
  };
}

async function processCompany(company, hintsRegex, crawlerConfig, knownJobUrls = new Set()) {
  const result = {
    company: company.name,
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
  try {
    const res = await fetchWithTimeout(company.website);
    if (!res.ok) {
      // Don't bail if adapter has seed URLs — they may be on a different host (e.g., jobs.migros.ch vs migros.ch)
      if (!adapterSeeds.length) return result;
      console.warn(`  ⚠️ Homepage ${company.website} returned ${res.status}, proceeding with ${adapterSeeds.length} adapter seed URLs`);
    } else {
      homepageHtml = await res.text();
    }
  } catch (e) {
    if (!adapterSeeds.length) return result;
    console.warn(`  ⚠️ Homepage ${company.website} unreachable (${e.message}), proceeding with ${adapterSeeds.length} adapter seed URLs`);
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
  const adapterDetailUrls = Array.isArray(adapter?.seedDetailUrls) ? adapter.seedDetailUrls : [];
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
            const parsed = toJobFromJsonLd(node, company.name, detailUrl, { seedMeta });
            if (!parsed.reason && parsed.job) {
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
  deeplCalls = 0;
  deeplSuccess = 0;
  deeplFallbackToLlm = 0;
  aiCacheHits = 0;
  aiCacheMisses = 0;
  const loadedAiCacheEntries = loadPersistentAiCache();
  const localCfg = loadCrawlerConfig();
  const firestoreCfg = await loadCrawlerConfigFromFirestore();
  const crawlerConfig = loadCrawlerConfig(mergeCrawlerConfig(localCfg, firestoreCfg));
  crawlerConfigGlobal = crawlerConfig;
  companyAdaptersGlobal = loadCompanyAdapters();
  writeJson(CRAWLER_CONFIG_PATH, crawlerConfig);
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
      console.warn(`⚠️  Missing company keys: ${missingRequested.join(', ')}`);
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
    console.log('🧭 Localization-only mode: skipping crawl/discovery, processing existing jobs only.');
  } else {
    // Pre-load known job URLs to skip re-crawling detail pages already in data/jobs.json
    const _preloadedJobs = readJson(DATA_JOBS, []);
    const knownJobUrls = new Set(
      (Array.isArray(_preloadedJobs) ? _preloadedJobs : [])
        .map((j) => canonicalizeJobUrl(j.url))
        .filter(Boolean)
    );
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

  const existingJobs = readJson(DATA_JOBS, []);
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
  if (skipStalePrune) {
    console.log('🛡️ Stale prune skipped (localization-only or JOBS_CRAWLER_SKIP_STALE_PRUNE=1).');
  }

  const mergeResult = mergeAndDeduplicate(prunedExisting, incomingJobs, {
    minQualityScore: crawlerConfig.minQualityScore,
    minDescriptionChars: crawlerConfig.minDescriptionChars,
  }, {
    scopeCompanyKeys: requestedCompanyKeys,
    contentReuse: crawlerConfig.contentReuse,
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
      const sourceDescLength = normalizeSpace(job?.description || '').length;
      return (
        needsLocalization ||
        shouldForceLocalization
      ) && (sourceDescLength >= 160 || hasTitleWork);
    });
    if (queue.length > 0) {
      // Prioritize recently-scraped jobs so they get localized first
      // if budget runs out before processing the entire queue.
      const incomingFps = new Set(incomingJobs.map(fingerprintJob).filter(Boolean));
      queue.sort((a, b) => {
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
      const enrichedMap = new Map();
      if (selectedQueue.length > 0) {
        const localizedEntries = await runWithConcurrency(
          selectedQueue.map((job, index) => ({ job, index })),
          async ({ job, index }) => {
            if (shouldForceLocalizationForJob(job)) {
              console.log(`🔁 Backfill forced localization ${index + 1}/${selectedQueue.length}: ${job.slug || job.id || 'unknown'}`);
            }
            const enriched = await enrichJobLocalesWithRetry(job, crawlerConfig);
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
  merged = merged.map((job) => ensureLocaleFields(job));

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
  } else {
    console.log(`🗺️  Geocoding filter: SKIPPED (${localizeExistingOnly ? 'localization-only mode' : 'JOBS_SKIP_GEOCODING=1'})`);
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
  const mergedEnriched = merged
    .map(sanitizeJobStrings)
    .map(stripCopyPasteLocales)
    .map(stripCrawlerInternalFields);
  writeJson(DATA_JOBS, mergedEnriched);
  writeJson(PUBLIC_JOBS, mergedEnriched);
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
      deeplCalls,
      deeplSuccess,
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

  console.log(`🧩 Merged jobs total: ${merged.length} (inserted=${inserted}, refreshed=${refreshed}, duplicateIncoming=${duplicateIncoming}, duplicateExisting=${duplicateExisting})`);
  if (mergeExcludedJobs > 0) {
    const ordered = Object.entries(mergeExclusionByReason || {})
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    console.log(`🚫 Excluded at merge: ${mergeExcludedJobs}${ordered ? ` (${ordered})` : ''}`);
  }
  console.log(`🧾 Audit written: ${path.relative(ROOT, AUDIT_PATH)}`);
  const shouldSkipHousekeeping =
    process.env.JOBS_SKIP_HOUSEKEEPING === '1' ||
    localizeExistingOnly ||
    hasScopedCompanyKeysForRun;
  if (shouldSkipHousekeeping) {
    const reasons = [];
    if (process.env.JOBS_SKIP_HOUSEKEEPING === '1') reasons.push('JOBS_SKIP_HOUSEKEEPING=1');
    if (localizeExistingOnly) reasons.push('localization-only');
    if (hasScopedCompanyKeysForRun) reasons.push('scoped-company-run');
    console.log(`⏭️  Skipping jobs housekeeping (${reasons.join(', ')})`);
  } else {
    console.log('🧹 Running jobs housekeeping...');
    await runHousekeeping();
  }

  // Log AI model stats & scoreboard
  const aiStats = getAiStats();
  console.log(`\n🤖 AI Model Stats: ${aiStats.calls} calls, ${aiStats.successes} successes, ${aiStats.retries} retries, ${aiStats.fallbacks} fallbacks, ${aiStats.exhausted} exhausted (store: ${aiStats.storeBackend})`);
  console.log(`🈯 DeepL Stats: calls=${deeplCalls}, success=${deeplSuccess}, fallback_to_llm=${deeplFallbackToLlm}`);
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

  // Flush persistent scores to Firestore before exit
  await flushScores();
  persistAiCacheToDisk();
  console.log(`💾 AI cache stats: hits=${aiCacheHits}, misses=${aiCacheMisses}, entries=${aiResponseCache.size}`);

  
  // Print crawl change summary (new/updated/removed)
  // Dedicated crawlers may post-process jobs after this base run.
  // In those cases, this summary can reflect temporary noisy fields.
  if (String(process.env.JOBS_SKIP_CRAWL_CHANGE_SUMMARY || '0') !== '1') {
    const afterSnapshot = snapshotJobSlugs(mergedEnriched);
    const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
    printCrawlChangeSummary(crawlDiff, 'Generic Crawler');
    writeCrawlChangeSummaryToGH(crawlDiff, 'Generic Crawler');
  } else {
    console.log('⏭️  Crawl change summary skipped (JOBS_SKIP_CRAWL_CHANGE_SUMMARY=1).');
  }

  console.log('✅ Jobs crawler completed');
}

// Export main for in-process invocation (used by dedicated-crawler-common.mjs)
export { main as runSharedCrawlerPipeline };

// Auto-run only when executed directly (not imported as module)
const isDirectExecution = typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectExecution) {
  main().catch((err) => {
    try {
      persistAiCacheToDisk({ force: true });
    } catch {
      // ignore cache persist failures on fatal exit
    }
    console.error('❌ Jobs crawler failed:', err?.message || err);
    process.exit(1);
  });
}
