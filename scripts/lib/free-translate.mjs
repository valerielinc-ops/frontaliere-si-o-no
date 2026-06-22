/**
 * Free Translation Cascade — Reusable multi-service translation utility.
 *
 * Provides a robust 7-tier translation cascade using free & open-source APIs:
 *   1. DeepL Free API     (if DEEPL_API_KEY is set)
 *   2. MyMemory API       (up to ~500 chars per call)
 *   3. Lingva Translate   (free Google Translate proxy, multiple mirrors)
 *   4. SimplyTranslate    (another free translation proxy)
 *   5. LibreTranslate     (open-source MT, multiple public instances)
 *   6. Mozhi              (another open-source translation proxy)
 *   7. Google Translate    (unofficial free endpoint, multi-endpoint, chunked)
 *
 * Features:
 *   - Instance health tracking: remembers which instances are down to skip them
 *   - Parallel instance probing for proxy tiers: races multiple instances,
 *     uses the first successful response for lower latency
 *   - Automatic retry with exponential backoff
 *
 * This module is designed to be imported by any script that needs translation
 * without depending on the full shared-jobs-crawler.mjs infrastructure.
 */

import { translateWithMyMemory } from './mymemory-translate.mjs';
import { applyGlossaryCorrections } from './translation-glossary.mjs';

// ── Config ──────────────────────────────────────────────────────────────────
// DeepL: support multiple API keys with automatic rotation on quota exhaustion.
// Each Free API key gives 500K chars/month. With 2 keys = 1M chars/month.
const DEEPL_API_KEYS = [
  (process.env.DEEPL_API_KEY || '').trim(),
  (process.env.DEEPL_API_KEY_2 || '').trim(),
].filter(Boolean);
let _deeplKeyIndex = 0;
let _deeplExhaustedKeys = new Set();
// Per-run 429 circuit-breaker: after DEEPL_429_CB_THRESHOLD total 429s the flag is set
// and all subsequent _callDeepLWithKey calls throw rateLimited immediately, avoiding
// the O(N×3s) wall-clock blowup on a sustained rate-limit across many chunks/jobs.
let _deepl429TotalCount = 0;
const DEEPL_429_CB_THRESHOLD = 5;
let _deeplRateLimitedGlobal = false;
// Azure Translator (F0 Free tier: 2M chars/month, excellent quality)
const AZURE_TRANSLATOR_KEYS = [
  (process.env.AZURE_TRANSLATOR_KEY || '').trim(),
  (process.env.AZURE_TRANSLATOR_KEY_2 || '').trim(),
].filter(Boolean);
const AZURE_REGION = (process.env.AZURE_TRANSLATOR_REGION || 'westeurope').trim();
let _azureKeyIndex = 0;
let _azureExhaustedKeys = new Set();

// Google Cloud Translation (official API, free tier: 500K chars/month)
// Hard-capped at 16K chars/day in code to match GCP quota setting and avoid billing.
// Authenticates via OAuth2 using the same GSC credentials (no API key needed).
const GCP_PROJECT_ID = (process.env.VITE_FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID || 'frontaliere-ticino').trim();
const _gcOAuth = {
  clientId: (process.env.GSC_CLIENT_ID || '').trim(),
  clientSecret: (process.env.GSC_CLIENT_SECRET || '').trim(),
  refreshToken: (process.env.GSC_REFRESH_TOKEN || '').trim(),
  accessToken: '',
  expiresAt: 0,
};
const _gcOAuthAvailable = !!(
  _gcOAuth.clientId && _gcOAuth.clientSecret && _gcOAuth.refreshToken
);
let _googleCloudDailyChars = 0;
const GOOGLE_CLOUD_DAILY_LIMIT = 16000;

// Hugging Face OPUS-MT (Helsinki-NLP open-source translation models)
const HF_TOKEN = (process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '').trim();
const HF_OPUS_MT_MODELS = {
  'it-en': 'Helsinki-NLP/opus-mt-it-en', 'en-it': 'Helsinki-NLP/opus-mt-en-it',
  'it-de': 'Helsinki-NLP/opus-mt-it-de', 'de-it': 'Helsinki-NLP/opus-mt-de-it',
  'it-fr': 'Helsinki-NLP/opus-mt-it-fr', 'fr-it': 'Helsinki-NLP/opus-mt-fr-it',
  'de-en': 'Helsinki-NLP/opus-mt-de-en', 'en-de': 'Helsinki-NLP/opus-mt-en-de',
  'de-fr': 'Helsinki-NLP/opus-mt-de-fr', 'fr-de': 'Helsinki-NLP/opus-mt-fr-de',
  'fr-en': 'Helsinki-NLP/opus-mt-fr-en', 'en-fr': 'Helsinki-NLP/opus-mt-en-fr',
};

const GOOGLE_TRANSLATE_ENDPOINTS = [
  'https://translate.googleapis.com/translate_a/single',
  'https://clients5.google.com/translate_a/t',
];
const TIMEOUT_MS = 15000;

// Lingva Translate instances (free Google Translate proxy)
// Verified 2026-03-30 — only 2 alive; works locally but BLOCKED from GitHub Actions IPs
const LINGVA_INSTANCES = [
  'https://translate.plausibility.cloud',  // ✅ verified 2026-03-30
  'https://lingva.ml',                    // ✅ verified 2026-03-30
  // REMOVED: lingva.lunar.icu (DNS failure), projectsegfau.lt (404),
  //   garudalinux.org (403), translate.jae.fi (DNS failure)
];

// SimplyTranslate instances — the #1 workhorse in CI (183/329 hits = 55%)
// Verified 2026-03-30
const SIMPLYTRANSLATE_INSTANCES = [
  'https://simplytranslate.org',           // ✅ primary
];

// Mozhi instances (open-source translation proxy supporting multiple engines)
// Verified 2026-03-22
const MOZHI_INSTANCES = [
  'https://mozhi.adminforge.de',           // ✅ 1.5s
  'https://mozhi.pussthecat.org',          // ✅ 0.7s
  'https://mozhi.aryak.me',               // ✅ 3.4s (slow but reliable)
];

// LibreTranslate public instances (open-source, no API key)
// Verified 2026-03-30 from local + CI — all work from GitHub Actions IPs
// Note: Argos Translate model has known issues translating TO Italian
// (e.g., "Consulente Assicuravo" instead of "Assicurativo"). Fine for IT→EN/DE/FR.
// translate.adminforge.de removed 2026-07-24 — consistent 500 errors from CI (3+ failures per run)
// translate.cutie.dating removed 2026-06-16 — host fully dead from CI + local (HTTP 000 /
// connection refused, burns the FULL 20s AbortSignal.timeout on EVERY attempt, then gets
// resurrected every HEALTH_RECOVERY_MS=2min → hours of pure timeout waste per translate run
// (run 27606697505: ~3h burned, only 372 jobs drained). Same removal precedent as adminforge.
const LIBRETRANSLATE_PUBLIC = [
  'https://translate.fedilab.app',          // ✅ 200ms, 1 req/burst rate limit, verified 2026-03-30
];

// Self-hosted LibreTranslate — runs as a service container in CI (translate-pending.yml).
// Unlimited capacity, no API key, no rate limits. Set via LIBRETRANSLATE_SELF_HOSTED_URL env.
const LIBRETRANSLATE_SELF_HOSTED = (process.env.LIBRETRANSLATE_SELF_HOSTED_URL || '').trim();
// Warmup tracker for the self-hosted LT container: the Argos Translate model loads into RAM
// on the FIRST /translate call (~30s in CI even after the /languages readiness probe, which
// warms the HTTP layer but not the model). After that first success all calls complete in <1s.
// Strategy: first call always uses a 30s warmup window to avoid aborting model-load; after the
// first success, subsequent calls use LIBRETRANSLATE_TIMEOUT_MS (default 10s) for fast-fail on
// an overloaded/hung endpoint — critical for 2-core runners where CPU-bound LT degrades
// under concurrency > 2 (each stalled request would otherwise burn the full timeout before
// falling through to the next tier). In CI, translate-pending.yml overrides
// LIBRETRANSLATE_TIMEOUT_MS to '5000' for tighter fail-fast; that only applies to warm calls.
// A non-numeric or ≤0 override falls back to the 10s default (guards AbortSignal.timeout(NaN)).
// AbortError is caught by the try/catch in translateWithLibreTranslateSelfHosted → '' → next tier.
let _ltWarmupDone = false;
const _ltTimeoutRaw = parseInt(process.env.LIBRETRANSLATE_TIMEOUT_MS || '', 10);
const LIBRETRANSLATE_TIMEOUT_MS = Number.isFinite(_ltTimeoutRaw) && _ltTimeoutRaw > 0 ? _ltTimeoutRaw : 10000;

const DEEPL_LANG_MAP = { it: 'IT', en: 'EN', de: 'DE', fr: 'FR' };

// ── Instance Health Tracking ────────────────────────────────────────────────
// Track which instances have failed recently to skip them on subsequent calls.
// An instance is only marked unhealthy after HEALTH_FAILURE_THRESHOLD consecutive
// failures (not on the first failure). After HEALTH_RECOVERY_MS, it's retried.
const HEALTH_RECOVERY_MS = 2 * 60 * 1000; // 2 minutes (was 10 min — too aggressive)
const HEALTH_FAILURE_THRESHOLD = 3; // require 3+ failures before marking unhealthy
const instanceHealth = new Map(); // url → { failedAt: number, failures: number }

function isInstanceHealthy(url) {
  const entry = instanceHealth.get(url);
  if (!entry) return true;
  // Under threshold: still considered healthy (transient errors)
  if (entry.failures < HEALTH_FAILURE_THRESHOLD) return true;
  if (Date.now() - entry.failedAt > HEALTH_RECOVERY_MS) {
    instanceHealth.delete(url);
    return true;
  }
  return false;
}

function markInstanceFailed(url) {
  const entry = instanceHealth.get(url) || { failures: 0 };
  entry.failedAt = Date.now();
  entry.failures += 1;
  instanceHealth.set(url, entry);
}

function markInstanceHealthy(url) {
  instanceHealth.delete(url);
}

// ── Cascade Metrics ────────────────────────────────────────────────────────
const _cascadeStats = {
  calls: 0,
  successes: 0,
  failures: 0,
  tierHits: { deepl: 0, azure: 0, googleCloud: 0, mozhiDeepL: 0, myMemory: 0, libreTranslateSelfHosted: 0, lingva: 0, simplyTranslate: 0, mozhiDdg: 0, libreTranslate: 0, huggingFace: 0, mozhiGoogle: 0, google: 0, mozhiYandex: 0 },
  tierErrors: { deepl: 0, azure: 0, googleCloud: 0, mozhiDeepL: 0, myMemory: 0, libreTranslateSelfHosted: 0, lingva: 0, simplyTranslate: 0, mozhiDdg: 0, libreTranslate: 0, huggingFace: 0, mozhiGoogle: 0, google: 0, mozhiYandex: 0 },
  // Per-field-type split of calls/successes. The cumulative `successes` above is
  // summed across every field type, so a run that translates short titles fine
  // but has every (long) description rejected by all providers still reports
  // `successes > 0` — masking a systematic description outage from the
  // infra-down gate (#2590). Tracking title vs description independently lets
  // `isTranslationInfraDown` notice that one field type is fully down even when
  // another keeps the cumulative count above zero.
  byFieldType: {
    title: { calls: 0, successes: 0 },
    description: { calls: 0, successes: 0 },
  },
};

/** Resolve the per-field-type stats bucket, defaulting unknown kinds to title. */
function _fieldStats(fieldType) {
  return _cascadeStats.byFieldType[fieldType] || _cascadeStats.byFieldType.title;
}

/**
 * Get current health stats for all tracked instances.
 */
export function getInstanceHealthStats() {
  const stats = {};
  for (const [url, entry] of instanceHealth) {
    stats[url] = {
      failedAt: new Date(entry.failedAt).toISOString(),
      failures: entry.failures,
      recoversAt: new Date(entry.failedAt + HEALTH_RECOVERY_MS).toISOString(),
    };
  }
  return stats;
}

/**
 * Get cascade performance stats (calls, successes, per-tier hit rates).
 */
export function getCascadeStats() {
  return {
    ..._cascadeStats,
    byFieldType: {
      title: { ..._cascadeStats.byFieldType.title },
      description: { ..._cascadeStats.byFieldType.description },
    },
  };
}

/**
 * Log a summary of cascade performance to console.
 */
export function logCascadeSummary() {
  const s = _cascadeStats;
  if (s.calls === 0) return;
  const rate = s.calls > 0 ? ((s.successes / s.calls) * 100).toFixed(1) : '0';
  console.log(`\n📊 Free-translate cascade: ${s.successes}/${s.calls} succeeded (${rate}%)`);
  const hits = Object.entries(s.tierHits).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (hits.length) {
    console.log('   Tier hits: ' + hits.map(([k, v]) => `${k}=${v}`).join(', '));
  }
  const errs = Object.entries(s.tierErrors).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (errs.length) {
    console.log('   Tier errors: ' + errs.map(([k, v]) => `${k}=${v}`).join(', '));
  }
  const health = getInstanceHealthStats();
  const down = Object.entries(health).filter(([, h]) => h.failures >= HEALTH_FAILURE_THRESHOLD);
  const degraded = Object.entries(health).filter(([, h]) => h.failures > 0 && h.failures < HEALTH_FAILURE_THRESHOLD);
  if (degraded.length) {
    console.log(`   ⚡ ${degraded.length} instances degraded (below threshold ${HEALTH_FAILURE_THRESHOLD}):`);
    degraded.forEach(([url, h]) => console.log(`      ⚠️  ${url} (${h.failures}/${HEALTH_FAILURE_THRESHOLD} failures)`));
  }
  if (down.length) {
    console.log(`   ⚠️  ${down.length} instances currently marked unhealthy (>=${HEALTH_FAILURE_THRESHOLD} failures):`);
    down.forEach(([url, h]) => console.log(`      ❌ ${url} (${h.failures} failures)`));
  }
  // Key status
  if (DEEPL_API_KEYS.length > 0) {
    const active = DEEPL_API_KEYS.length - _deeplExhaustedKeys.size;
    console.log(`   🔑 DeepL: ${active}/${DEEPL_API_KEYS.length} keys active${_deeplExhaustedKeys.size > 0 ? ` (${_deeplExhaustedKeys.size} exhausted)` : ''}`);
  }
  if (AZURE_TRANSLATOR_KEYS.length > 0) {
    const active = AZURE_TRANSLATOR_KEYS.length - _azureExhaustedKeys.size;
    console.log(`   🔑 Azure: ${active}/${AZURE_TRANSLATOR_KEYS.length} keys active, region=${AZURE_REGION}${_azureExhaustedKeys.size > 0 ? ` (${_azureExhaustedKeys.size} exhausted)` : ''}`);
  }
  const gcAuth = _gcOAuthAvailable ? 'OAuth2' : 'none';
  console.log(`   🔑 Google Cloud Translation: auth=${gcAuth}, ${_googleCloudDailyChars}/${GOOGLE_CLOUD_DAILY_LIMIT} daily chars used`);
}

function normalizeSpace(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize whitespace WITHOUT collapsing newlines.
 *
 * Job descriptions arrive here with structure already encoded as line
 * breaks ("## Section\n- bullet\n- bullet\n\n") via htmlToStructuredText
 * or by the dedicated parsers. The earlier `normalizeSpace(text)` call
 * before each translation request flattened all of that into a single
 * line, DeepL returned a single line, and the audit's no-structure
 * ratchet escalated VF (and others) to CRITICAL because the translated
 * output had zero `<li>`/bullet markers.
 *
 * This variant collapses runs of horizontal whitespace, normalizes CRLF,
 * trims trailing spaces around line breaks, and caps blank-line runs.
 */
function normalizeBlock(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split text into chunks ≤ maxChars at sentence boundaries.
 * Splits at: paragraph breaks (\n\n), newlines (\n), sentence-ending punctuation (. ! ?),
 * markdown headers (##), and list items (- *).
 * Falls back to word boundaries if a single sentence exceeds maxChars.
 */
function _chunkAtSentences(text, maxChars = 480) {
  // Split into sentences at natural boundaries
  const segments = text.split(/(?<=\.\s)|(?<=\n)|(?<=\?\s)|(?<=!\s)|(?=##\s)|(?=[-*]\s)/).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (current.length + trimmed.length + 1 <= maxChars) {
      current = current ? `${current} ${trimmed}` : trimmed;
    } else {
      if (current) chunks.push(current.trim());
      // If single segment exceeds maxChars, split at word boundaries
      if (trimmed.length > maxChars) {
        const words = trimmed.split(/\s+/);
        current = '';
        for (const word of words) {
          if (current.length + word.length + 1 <= maxChars) {
            current = current ? `${current} ${word}` : word;
          } else {
            if (current) chunks.push(current.trim());
            current = word;
          }
        }
      } else {
        current = trimmed;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── DeepL Free (multi-key with automatic rotation) ──────────────────────────
// Each Free API key: 500K chars/month. With 2 keys: 1M chars/month.
// On 456 (quota exceeded) or 429 (rate limit): rotate to next key.
async function _callDeepLWithKey(apiKey, text, srcCode, tgtCode) {
  const MAX_CHUNK = 5000;
  // Preserve line breaks: DeepL's `preserve_formatting=1` keeps paragraph
  // structure (and `tag_handling=xml` would too if we wrapped content).
  // Using normalizeBlock (instead of the legacy normalizeSpace) keeps
  // bullet/section markers intact so the translated output is still
  // recognisable as structured prose to the audit.
  const clean = normalizeBlock(text);
  const chunks = clean.length <= MAX_CHUNK ? [clean] : chunkText(clean, MAX_CHUNK);
  const translated = [];

  // Circuit-breaker: if a previous call already triggered the global flag, fail fast
  // without burning an HTTP round-trip (and its 15s timeout).
  if (_deeplRateLimitedGlobal) {
    throw Object.assign(new Error('DeepL 429 rate-limited'), { rateLimited: true });
  }

  for (const chunk of chunks) {
    const body = new URLSearchParams();
    body.append('text', chunk);
    if (srcCode) body.append('source_lang', srcCode);
    body.append('target_lang', tgtCode);
    body.append('preserve_formatting', '1');
    body.append('split_sentences', 'nonewlines');

    // 429 is a *transient* rate-limit, not a permanent quota wall — retry the
    // same key a few times with a short backoff before giving up. 456 is the
    // real monthly-quota-exceeded signal and must NOT be retried.
    const MAX_429_RETRIES = 2;
    let res;
    for (let rl = 0; ; rl++) {
      res = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 456) {
        // Real monthly quota exhausted → mark key exhausted for the run.
        throw Object.assign(new Error('DeepL 456'), { quotaExhausted: true });
      }
      if (res.status === 429) {
        _deepl429TotalCount++;
        if (_deepl429TotalCount >= DEEPL_429_CB_THRESHOLD) {
          // Sustained rate-limit: set the global flag so every subsequent chunk and
          // job skips DeepL entirely instead of accumulating more backoff delay.
          _deeplRateLimitedGlobal = true;
          console.warn(`[deepl] circuit-breaker: ${_deepl429TotalCount} total 429s this run — bypassing all further DeepL calls`);
          throw Object.assign(new Error('DeepL 429 rate-limited'), { rateLimited: true });
        }
        if (rl < MAX_429_RETRIES) {
          console.warn(`[deepl] 429 rate-limited — backing off (retry ${rl + 1}/${MAX_429_RETRIES})`);
          await delay(1000 * (rl + 1)); // ~1s, then ~2s
          continue;
        }
        // Still rate-limited after retries → fall through to the next tier WITHOUT
        // marking the key exhausted (it may recover for later jobs).
        throw Object.assign(new Error('DeepL 429 rate-limited'), { rateLimited: true });
      }
      break;
    }
    if (!res.ok) return '';
    const data = await res.json();
    const t = data?.translations?.[0]?.text || '';
    if (!t) return '';
    translated.push(t);
    if (chunks.length > 1) await delay(200);
  }

  return normalizeBlock(translated.join('\n\n'));
}

async function translateWithDeepL(text, sourceLang, targetLang) {
  if (DEEPL_API_KEYS.length === 0) return '';
  const clean = normalizeBlock(text);
  if (!clean || sourceLang === targetLang) return '';

  const srcCode = DEEPL_LANG_MAP[sourceLang] || sourceLang?.toUpperCase() || '';
  const tgtCode = DEEPL_LANG_MAP[targetLang] || targetLang?.toUpperCase() || '';
  if (!tgtCode) return '';

  // Try each non-exhausted key, rotating on quota errors
  for (let attempt = 0; attempt < DEEPL_API_KEYS.length; attempt++) {
    const idx = (_deeplKeyIndex + attempt) % DEEPL_API_KEYS.length;
    const key = DEEPL_API_KEYS[idx];
    if (_deeplExhaustedKeys.has(key)) continue;

    try {
      const result = await _callDeepLWithKey(key, clean, srcCode, tgtCode);
      if (result && result.toLowerCase() !== clean.toLowerCase()) {
        _deeplKeyIndex = idx; // stick with working key
        return result;
      }
    } catch (err) {
      if (err?.quotaExhausted) {
        _deeplExhaustedKeys.add(key);
        _cascadeStats.tierErrors.deepl = (_cascadeStats.tierErrors.deepl || 0) + 1;
        console.log(`🔑 DeepL key #${idx + 1} quota exhausted — rotating to next key`);
        continue;
      }
      if (err?.rateLimited) {
        // Transient 429 after retries — do NOT exhaust the key (it may recover for
        // later jobs). Fall through to the next tier for THIS job only.
        _cascadeStats.tierErrors.deepl = (_cascadeStats.tierErrors.deepl || 0) + 1;
        console.log(`⏳ DeepL key #${idx + 1} rate-limited (transient) — falling through to next tier, key NOT exhausted`);
        return '';
      }
      return ''; // network error, don't retry with other keys
    }
  }
  return ''; // all keys exhausted
}

// ── Google Translate (unofficial free, multi-endpoint) ──────────────────────
async function translateChunkGoogle(text, sourceLang, targetLang) {
  const q = normalizeSpace(text);
  if (!q) return '';

  for (const base of GOOGLE_TRANSLATE_ENDPOINTS) {
    const isClients5 = base.includes('clients5');
    const params = new URLSearchParams({
      client: isClients5 ? 'dict-chrome-ex' : 'gtx',
      sl: sourceLang || 'auto',
      tl: targetLang,
      ...(isClients5 ? {} : { dt: 't' }),
      q,
    });

    try {
      const res = await fetch(`${base}?${params.toString()}`, {
        headers: {
          'Accept': 'application/json,text/plain,*/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const raw = await res.text().catch(() => '');
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        let translated = '';
        if (isClients5) {
          if (Array.isArray(parsed?.sentences)) {
            translated = parsed.sentences.map((s) => s?.trans || '').join('');
          } else if (Array.isArray(parsed)) {
            translated = parsed.map((s) => String(s || '')).join('');
          }
        } else {
          const segments = Array.isArray(parsed?.[0]) ? parsed[0] : [];
          translated = segments.map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('');
        }
        const result = normalizeSpace(translated);
        if (result && result.toLowerCase() !== q.toLowerCase()) return result;
      } catch { continue; }
    } catch { continue; }
  }
  return '';
}

// ── Parallel Race Helper ─────────────────────────────────────────────────────
// Probe multiple instances in parallel, return the first valid translation.
// Much faster than sequential probing when some instances are slow/down.
async function raceInstances(instances, fetchFn) {
  const healthy = instances.filter(isInstanceHealthy);
  if (healthy.length === 0) {
    // All marked unhealthy — try one anyway in case they recovered
    const oldest = instances[0];
    if (oldest) {
      instanceHealth.delete(oldest);
      return fetchFn(oldest);
    }
    return '';
  }

  // Race up to 3 instances in parallel for speed
  const batch = healthy.slice(0, 3);
  const controller = new AbortController();

  const promises = batch.map(async (base) => {
    try {
      const result = await fetchFn(base, controller.signal);
      if (result) {
        controller.abort(); // cancel others
        markInstanceHealthy(base);
        return result;
      }
      markInstanceFailed(base);
      return '';
    } catch {
      markInstanceFailed(base);
      return '';
    }
  });

  const results = await Promise.allSettled(promises);
  const firstSuccess = results.find(
    (r) => r.status === 'fulfilled' && r.value
  );
  if (firstSuccess) return firstSuccess.value;

  // Try remaining healthy instances sequentially
  for (const base of healthy.slice(3)) {
    try {
      const result = await fetchFn(base);
      if (result) {
        markInstanceHealthy(base);
        return result;
      }
      markInstanceFailed(base);
    } catch {
      markInstanceFailed(base);
    }
  }
  return '';
}

// ── Lingva Translate (free Google Translate proxy) ───────────────────────────
async function translateWithLingva(text, sourceLang, targetLang) {
  const q = normalizeSpace(text);
  if (!q || sourceLang === targetLang) return '';
  const encoded = encodeURIComponent(q);

  return raceInstances(LINGVA_INSTANCES, async (base, signal) => {
    const res = await fetch(
      `${base}/api/v1/${sourceLang || 'auto'}/${targetLang}/${encoded}`,
      {
        headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
        signal: signal || AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) return '';
    const data = await res.json();
    const translated = normalizeSpace(data?.translation || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) return translated;
    return '';
  });
}

// ── SimplyTranslate (another free Google Translate proxy) ────────────────────
async function translateWithSimplyTranslate(text, sourceLang, targetLang) {
  const q = normalizeSpace(text);
  if (!q || sourceLang === targetLang) return '';

  return raceInstances(SIMPLYTRANSLATE_INSTANCES, async (base, signal) => {
    const params = new URLSearchParams({
      engine: 'google',
      from: sourceLang || 'auto',
      to: targetLang,
      text: q,
    });
    const res = await fetch(`${base}/api/translate/?${params.toString()}`, {
      headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
      signal: signal || AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const translated = normalizeSpace(data?.translated_text || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) return translated;
    return '';
  });
}

// ── LibreTranslate self-hosted (CI service container) ──────────────────────
async function translateWithLibreTranslateSelfHosted(text, sourceLang, targetLang) {
  if (!LIBRETRANSLATE_SELF_HOSTED) return '';
  const q = normalizeSpace(text);
  if (!q || sourceLang === targetLang) return '';

  // First call uses a 30s warmup window regardless of LIBRETRANSLATE_TIMEOUT_MS.
  // Subsequent calls use the configured fast-fail timeout (see _ltWarmupDone above).
  const timeout = _ltWarmupDone ? LIBRETRANSLATE_TIMEOUT_MS : 30000;
  try {
    const res = await fetch(`${LIBRETRANSLATE_SELF_HOSTED}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, source: sourceLang || 'auto', target: targetLang, format: 'text' }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      console.warn(`⚠️  LibreTranslate self-hosted: HTTP ${res.status}`);
      return '';
    }
    const data = await res.json();
    const translated = normalizeSpace(data?.translatedText || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) {
      _ltWarmupDone = true;
      return translated;
    }
    return '';
  } catch (err) {
    console.warn(`⚠️  LibreTranslate self-hosted error: ${err?.message || err}`);
    return '';
  }
}

// ── LibreTranslate public instances ─────────────────────────────────────────
async function translateWithLibreTranslate(text, sourceLang, targetLang) {
  const q = normalizeSpace(text);
  if (!q || sourceLang === targetLang) return '';

  return raceInstances(LIBRETRANSLATE_PUBLIC, async (base, signal) => {
    const res = await fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, source: sourceLang || 'auto', target: targetLang, format: 'text' }),
      signal: signal || AbortSignal.timeout(20000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const translated = normalizeSpace(data?.translatedText || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) return translated;
    return '';
  });
}

// ── Mozhi (open-source proxy, supports: google, deepl, duckduckgo, yandex) ──
async function translateWithMozhiEngine(text, sourceLang, targetLang, engine = 'google') {
  const q = normalizeSpace(text);
  if (!q || sourceLang === targetLang) return '';

  return raceInstances(MOZHI_INSTANCES, async (base, signal) => {
    const params = new URLSearchParams({
      engine,
      from: sourceLang || 'auto',
      to: targetLang,
      text: q,
    });
    const res = await fetch(`${base}/api/translate?${params.toString()}`, {
      headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
      signal: signal || AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const data = await res.json();
    // Mozhi uses 'translated-text' (hyphenated) in its response
    const translated = normalizeSpace(data?.['translated-text'] || data?.translated_text || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) return translated;
    return '';
  });
}

// ── Azure Translator (F0 Free — 2M chars/month, near-DeepL quality) ────────
async function translateWithAzure(text, sourceLang, targetLang) {
  if (AZURE_TRANSLATOR_KEYS.length === 0) return '';
  const clean = normalizeSpace(text);
  if (!clean || sourceLang === targetLang) return '';

  // Azure supports up to 50K chars per request, but we chunk at 5K for safety
  const MAX_CHUNK = 5000;
  const chunks = clean.length <= MAX_CHUNK ? [clean] : chunkText(clean, MAX_CHUNK);

  for (let attempt = 0; attempt < AZURE_TRANSLATOR_KEYS.length; attempt++) {
    const idx = (_azureKeyIndex + attempt) % AZURE_TRANSLATOR_KEYS.length;
    const key = AZURE_TRANSLATOR_KEYS[idx];
    if (_azureExhaustedKeys.has(key)) continue;

    try {
      const translated = [];
      for (const chunk of chunks) {
        const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${sourceLang}&to=${targetLang}`;
        // Single call with the configured region. A 401/403 is an auth/credential
        // failure (bad or revoked key) — NOT something a different region header can
        // fix (live run 27544487773 proved BOTH westeurope AND global return 401 for
        // an invalid key), so we no longer waste a second `global` retry on auth
        // failures. The key is exhausted for the rest of the run instead (see below),
        // making this self-healing: a VALID key returns 200, is never exhausted, and
        // a renewed key in Remote Config re-enables Azure with zero code change.
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Ocp-Apim-Subscription-Region': AZURE_REGION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ Text: chunk }]),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) {
          // Auth failure: invalid/missing/revoked credentials. Exhaust this key for
          // the rest of the process run (mirrors the DeepL `_deeplExhaustedKeys`
          // pattern) so every remaining job skips it instead of burning a failed
          // HTTP call. Log the status + body snippet ONCE — on the first exhaustion
          // of a given key (the #2106 [azure] diagnostic is preserved for a future
          // bad key) — but never spam it for subsequent skipped jobs.
          if (!_azureExhaustedKeys.has(key)) {
            const snippet = (await res.text().catch(() => '')).slice(0, 200);
            console.warn(`[azure] HTTP ${res.status} (key #${idx + 1}, region="${AZURE_REGION}"): ${snippet}`);
            console.log(`🔑 Azure key #${idx + 1} auth failure (${res.status}) — exhausting for the rest of the run`);
          }
          _azureExhaustedKeys.add(key);
          _cascadeStats.tierErrors.azure = (_cascadeStats.tierErrors.azure || 0) + 1;
          throw Object.assign(new Error('Azure auth'), { quotaExhausted: true });
        }
        if (res.status === 429) {
          _azureExhaustedKeys.add(key);
          _cascadeStats.tierErrors.azure = (_cascadeStats.tierErrors.azure || 0) + 1;
          console.log(`🔑 Azure key #${idx + 1} quota exhausted — rotating`);
          throw Object.assign(new Error('Azure quota'), { quotaExhausted: true });
        }
        if (!res.ok) {
          // Other failure (e.g. 400 bad lang). Bump the tier error counter, then
          // preserve cascade flow by returning '' (do not throw, do not exhaust —
          // a 400 is request-specific, not a dead key).
          const snippet = (await res.text().catch(() => '')).slice(0, 200);
          _cascadeStats.tierErrors.azure = (_cascadeStats.tierErrors.azure || 0) + 1;
          console.warn(`[azure] HTTP ${res.status} (key #${idx + 1}, region="${AZURE_REGION}"): ${snippet}`);
          return '';
        }
        const data = await res.json();
        const t = data?.[0]?.translations?.[0]?.text || '';
        if (!t) return '';
        translated.push(t);
        if (chunks.length > 1) await delay(100);
      }
      const result = normalizeSpace(translated.join('\n\n'));
      if (result && result.toLowerCase() !== clean.toLowerCase()) {
        _azureKeyIndex = idx;
        return result;
      }
      return '';
    } catch (err) {
      if (err?.quotaExhausted) continue;
      // Log non-quota Azure errors so silent failures are visible in CI logs
      if (err?.message) console.warn(`⚠️  Azure Translator error: ${err.message}`);
      return '';
    }
  }
  return '';
}

// ── Google Cloud Translation (official API, 500K free/month) ───────────────

/** Exchange OAuth2 refresh token for a short-lived access token. */
async function _getGoogleCloudAccessToken() {
  if (_gcOAuth.accessToken && Date.now() < _gcOAuth.expiresAt - 60_000) {
    return _gcOAuth.accessToken;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: _gcOAuth.clientId,
      client_secret: _gcOAuth.clientSecret,
      refresh_token: _gcOAuth.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return '';
  const data = await res.json();
  _gcOAuth.accessToken = data.access_token || '';
  _gcOAuth.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return _gcOAuth.accessToken;
}

async function translateWithGoogleCloud(text, sourceLang, targetLang) {
  if (!_gcOAuthAvailable) return '';
  const clean = normalizeSpace(text);
  if (!clean || sourceLang === targetLang) return '';
  if (_googleCloudDailyChars + clean.length > GOOGLE_CLOUD_DAILY_LIMIT) return '';

  try {
    const token = await _getGoogleCloudAccessToken();
    if (!token) return '';

    const res = await fetch('https://translation.googleapis.com/language/translate/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': GCP_PROJECT_ID,
      },
      body: JSON.stringify({ q: clean, source: sourceLang, target: targetLang, format: 'text' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403 || res.status === 429) return ''; // quota exceeded
    if (!res.ok) return '';
    const data = await res.json();
    const translated = normalizeSpace(data?.data?.translations?.[0]?.translatedText || '');
    if (translated && translated.toLowerCase() !== clean.toLowerCase()) {
      _googleCloudDailyChars += clean.length;
      return translated;
    }
    return '';
  } catch {
    return '';
  }
}

// ── Hugging Face OPUS-MT (Helsinki-NLP open-source models) ─────────────────
async function translateWithHuggingFace(text, sourceLang, targetLang) {
  if (!HF_TOKEN) return '';
  const clean = normalizeSpace(text);
  if (!clean || sourceLang === targetLang) return '';

  const modelKey = `${sourceLang}-${targetLang}`;
  const model = HF_OPUS_MT_MODELS[modelKey];
  if (!model) return '';

  // OPUS-MT models work best with shorter texts (< 512 tokens ≈ ~2000 chars)
  const truncated = clean.slice(0, 2000);

  try {
    const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: truncated }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const translated = normalizeSpace(
      Array.isArray(data) ? data[0]?.translation_text || '' : data?.translation_text || ''
    );
    if (translated && translated.toLowerCase() !== clean.toLowerCase()) return translated;
    return '';
  } catch {
    return '';
  }
}

async function translateWithGoogle(text, sourceLang, targetLang) {
  const clean = normalizeSpace(text);
  if (!clean || sourceLang === targetLang) return '';

  const chunks = chunkText(clean, 1800);
  if (!chunks.length) return '';

  const translated = [];
  for (const chunk of chunks) {
    let result = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await translateChunkGoogle(chunk, sourceLang, targetLang);
      if (result) break;
      await delay(attempt * 300);
    }
    if (!result) return '';
    translated.push(result);
  }

  const merged = normalizeSpace(translated.join('\n\n'));
  if (!merged || merged.toLowerCase() === clean.toLowerCase()) return '';
  return merged;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function chunkText(text, maxChars = 1800) {
  const clean = normalizeSpace(text);
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  const paragraphs = clean.split(/\n{2,}/);
  let current = '';

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > maxChars) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // If any chunk is still too long, hard-split by sentences
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let cur = '';
      for (const s of sentences) {
        if (cur && (cur.length + s.length + 1) > maxChars) {
          result.push(cur.trim());
          cur = s;
        } else {
          cur = cur ? `${cur} ${s}` : s;
        }
      }
      if (cur.trim()) result.push(cur.trim());
    }
  }
  return result;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Translate text using a cascade of free & open-source translation services.
 * Returns translated text or empty string if all services fail.
 *
 * Cascade (10 tiers):
 *   1. DeepL Free         — best quality, requires API key
 *   2. Mozhi+DeepL        — DeepL via Mozhi proxy (no API key needed!)
 *   3. MyMemory            — good for EU languages, ≤500 chars
 *   4. Lingva              — free Google Translate proxy
 *   5. SimplyTranslate     — another free proxy
 *   6. Mozhi+DuckDuckGo    — Bing/DuckDuckGo via Mozhi proxy
 *   7. LibreTranslate      — open-source MT
 *   8. Mozhi+Google        — Google Translate via Mozhi proxy
 *   9. Google Translate     — unofficial direct endpoint, chunked
 *  10. Mozhi+Yandex        — Yandex Translate via Mozhi (slow fallback)
 *
 * @param {Object} options
 * @param {string} options.text - Text to translate
 * @param {string} options.sourceLang - Source language (it/en/de/fr)
 * @param {string} options.targetLang - Target language (it/en/de/fr)
 * @returns {Promise<string>} Translated text or ''
 */
/**
 * Post-process a translator output to make sure `**bold**` markdown markers
 * stay balanced. AI translators frequently re-flow paragraphs in a way that
 * leaves orphan `**` (count parity broken) or empty `**…**` runs containing
 * only whitespace/punctuation. Those artifacts then leak into the rendered
 * job page as literal `**…**` strings, which is the bug we patched at the
 * SSG+SPA parser layer in PR #426. This is the upstream root-cause guard:
 * any translation result with odd `**` count gets its `**` stripped before
 * we commit it to `descriptionByLocale`.
 *
 * Exported so the same balancer can be reused outside the cascade (tests,
 * upstream sanitizers, retroactive cleanup scripts).
 *
 * @param {string} s
 * @returns {string}
 */
export function balanceMarkdownMarkers(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  // 1. Drop empty / whitespace-only / punctuation-only bolds (e.g. `** **`,
  //    `**  **`, `** : **`, `** - **`).
  out = out.replace(/\*\*\s*[\s:;,.\-–—]*\s*\*\*/g, ' ');
  // 2. If `**` count is odd, the output is unrecoverable as bold structure —
  //    strip every `**` so the renderer sees plain text instead of a half-
  //    bold span.
  const count = (out.match(/\*\*/g) || []).length;
  if (count % 2 !== 0) {
    out = out.replace(/\*\*/g, '');
  }
  // 3. Strip standalone separator-only lines (`______`, `======`) that some
  //    translators emit as decoration.
  out = out
    .split('\n')
    .filter((line) => !/^[\s_\-=*•·~]{3,}$/.test(line))
    .join('\n');
  // 4. Strip trailing inline separator runs that often hug a line end.
  out = out
    .split('\n')
    .map((line) => line.replace(/\s+[_\-=~*]{3,}\s*$/g, '').trimEnd())
    .join('\n');
  // 5. Collapse 3+ consecutive newlines that step 3 may have created when
  //    a separator line sat between two paragraph breaks (\n\nSEP\n\n →
  //    \n\n\n after filter).
  out = out.replace(/\n{3,}/g, '\n\n');
  // 6. Collapse the consecutive double-spaces that step 1 may have left.
  out = out.replace(/[ \t]{2,}/g, ' ');
  return out.trim();
}

export async function freeTranslate({ text, sourceLang, targetLang, fieldType = 'title' }) {
  const clean = normalizeSpace(text);
  if (!clean) return '';
  if (sourceLang === targetLang) return clean;

  _cascadeStats.calls++;
  const fieldStats = _fieldStats(fieldType);
  fieldStats.calls++;

  // Single exit transform: balance markdown markers, then apply the
  // protected-term glossary so meaning-inverted MT output (e.g. German
  // "Nachtwache" → IT "orologio notturno") is corrected regardless of which
  // tier produced it. `fieldType` defaults to 'title' (preserving the original
  // behaviour for the short-text/title path); description callers pass
  // 'description' so broad single-word fallback rules are skipped and legitimate
  // body prose ("nel nostro orologio") is never rewritten.
  const finalize = (out) => applyGlossaryCorrections({
    sourceText: clean,
    translatedText: balanceMarkdownMarkers(out),
    targetLang,
    fieldType,
  });

  /** Try a tier: track success/error, return result or '' */
  async function tryTier(tierName, fn) {
    try {
      const result = await fn();
      if (result) {
        _cascadeStats.tierHits[tierName] = (_cascadeStats.tierHits[tierName] || 0) + 1;
        _cascadeStats.successes++;
        fieldStats.successes++;
        return result;
      }
    } catch (err) {
      _cascadeStats.tierErrors[tierName] = (_cascadeStats.tierErrors[tierName] || 0) + 1;
    }
    return '';
  }

  // ── CI-PROVEN TIERS (work from GitHub Actions) ─────────────────────────────
  // Order: best quality first for short text (titles), then volume handlers for long text (descriptions)

  // Tier 1: DeepL Free API (best quality, if API key set)
  const t1 = await tryTier('deepl', () => translateWithDeepL(clean, sourceLang, targetLang));
  if (t1) return finalize(t1);

  // Tier 2: Azure Translator (F0 Free — 2M chars/month, near-DeepL quality)
  const t1b = await tryTier('azure', () => translateWithAzure(clean, sourceLang, targetLang));
  if (t1b) return finalize(t1b);

  // Tier 3: Google Cloud Translation (official API, 500K free/month, hard-capped 16K/day)
  const t2c = await tryTier('googleCloud', () => translateWithGoogleCloud(clean, sourceLang, targetLang));
  if (t2c) return finalize(t2c);

  // Tier 3b: LibreTranslate self-hosted (CI service container — unlimited, no
  // rate limits, no shared throttle). Promoted ABOVE MyMemory ONLY for EN/DE/FR
  // targets: once the premium tiers (DeepL/Azure/Google Cloud) are exhausted, the
  // self-hosted instance carries the parallel load instead of MyMemory's
  // 1-call/sec throttle, so the localization queue's concurrency delivers
  // throughput. Gated to non-IT because LibreTranslate's IT quality is documented
  // as weaker (typos in compounds) and IT is the funnel's primary indexed locale —
  // for IT, MyMemory ("best EU quality") stays ahead and self-hosted LT remains a
  // post-MyMemory fallback (Tier 4a below), preserving pre-PR IT behaviour. No-op
  // when LIBRETRANSLATE_SELF_HOSTED_URL is unset (returns '').
  if (targetLang !== 'it') {
    const t3b = await tryTier('libreTranslateSelfHosted', () => translateWithLibreTranslateSelfHosted(clean, sourceLang, targetLang));
    if (t3b) return finalize(t3b);
  }

  // Tier 4: MyMemory (best EU language quality, 50K chars/day with email param)
  // Short text (≤5000 chars): single call. Long text: chunk at sentence boundaries.
  const t2 = await tryTier('myMemory', async () => {
    if (clean.length <= 5000) {
      const mm = await translateWithMyMemory(clean, sourceLang, targetLang);
      if (!mm) return '';
      // Check for quota warning in single-call path too (was only checked in chunked path)
      if (mm.includes('MYMEMORY WARNING') || mm.includes('PLEASE CONTACT')) return '';
      if (normalizeSpace(mm).toLowerCase() !== clean.toLowerCase()) return normalizeSpace(mm);
      return '';
    }
    // Chunk long text at sentence/paragraph boundaries
    const chunks = _chunkAtSentences(clean, 4800);
    if (chunks.length === 0) return '';
    const parts = [];
    for (const chunk of chunks) {
      const mm = await translateWithMyMemory(chunk, sourceLang, targetLang);
      if (!mm || mm.includes('MYMEMORY WARNING')) return ''; // quota hit mid-chunk, abort
      parts.push(mm);
    }
    const joined = normalizeSpace(parts.join(' '));
    if (joined && joined.toLowerCase() !== clean.toLowerCase()) return joined;
    return '';
  });
  if (t2) return finalize(t2);

  // Tier 4a: LibreTranslate self-hosted — IT-target ONLY. For IT this is the
  // first (and only) self-hosted attempt, kept below MyMemory by the EN/DE/FR
  // gate at Tier 3b, preserving pre-PR IT order. EN/DE/FR already tried it at
  // Tier 3b, so re-running it here would pay a second (up to 30s) timeout on a
  // hung endpoint for no benefit — skip. No-op when self-hosted URL is unset.
  if (targetLang === 'it') {
    const t3bFallback = await tryTier('libreTranslateSelfHosted', () => translateWithLibreTranslateSelfHosted(clean, sourceLang, targetLang));
    if (t3bFallback) return finalize(t3bFallback);
  }

  // Tier 4b: LibreTranslate public instances (raced in parallel — reliable from CI)
  const t4 = await tryTier('libreTranslate', () => translateWithLibreTranslate(clean, sourceLang, targetLang));
  if (t4) return finalize(t4);

  // Tier 5: Hugging Face OPUS-MT (Helsinki-NLP open-source, good for short text)
  const t5 = await tryTier('huggingFace', () => translateWithHuggingFace(clean, sourceLang, targetLang));
  if (t5) return finalize(t5);

  // Tier 6: Mozhi+DuckDuckGo (Bing via Mozhi proxy — works sometimes from CI)
  const t6b = await tryTier('mozhiDdg', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'duckduckgo'));
  if (t6b) return finalize(t6b);

  // ── LOCAL/DEV TIERS (blocked from GitHub Actions IPs, work locally) ───────

  // Tier 6: Lingva (Google Translate proxy — works locally, blocked in CI)
  const t6 = await tryTier('lingva', () => translateWithLingva(clean, sourceLang, targetLang));
  if (t6) return finalize(t6);

  // Tier 7: Mozhi+Google (Google via Mozhi — works locally, blocked in CI)
  const t7 = await tryTier('mozhiGoogle', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'google'));
  if (t7) return finalize(t7);

  // Tier 8: Google Translate (unofficial direct endpoint — often blocked)
  const t8 = await tryTier('google', () => translateWithGoogle(clean, sourceLang, targetLang));
  if (t8) return finalize(t8);

  // Tier 9: Mozhi+DeepL (DeepL engine returns empty via proxy — broken since 2026-03)
  const t9 = await tryTier('mozhiDeepL', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'deepl'));
  if (t9) return finalize(t9);

  // Tier 10: Mozhi+Yandex (slow last resort)
  const t10 = await tryTier('mozhiYandex', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'yandex'));
  if (t10) return finalize(t10);

  _cascadeStats.failures++;
  return '';
}

/**
 * Translate text, trying the cascade and retrying up to `maxRetries` times
 * with exponential backoff if all services fail on the first attempt.
 *
 * @param {Object} options
 * @param {string} options.text - Text to translate
 * @param {string} options.sourceLang - Source language
 * @param {string} options.targetLang - Target language
 * @param {('title'|'description')} [options.fieldType='title'] - Field kind; forwarded
 *   to the glossary so broad single-word fallbacks run on titles only.
 * @param {number} [options.maxRetries=2] - Max retry attempts after first failure
 * @returns {Promise<string>} Translated text or ''
 */
export async function freeTranslateWithRetry({ text, sourceLang, targetLang, fieldType = 'title', maxRetries = 2 }) {
  const result = await freeTranslate({ text, sourceLang, targetLang, fieldType });
  if (result) return result;

  for (let i = 1; i <= maxRetries; i++) {
    await delay(i * 1000);
    const retry = await freeTranslate({ text, sourceLang, targetLang, fieldType });
    if (retry) return retry;
  }

  return '';
}
