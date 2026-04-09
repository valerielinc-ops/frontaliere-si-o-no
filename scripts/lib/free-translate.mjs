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

// ── Config ──────────────────────────────────────────────────────────────────
// DeepL: support multiple API keys with automatic rotation on quota exhaustion.
// Each Free API key gives 500K chars/month. With 2 keys = 1M chars/month.
const DEEPL_API_KEYS = [
  (process.env.DEEPL_API_KEY || '').trim(),
  (process.env.DEEPL_API_KEY_2 || '').trim(),
].filter(Boolean);
let _deeplKeyIndex = 0;
let _deeplExhaustedKeys = new Set();
// Azure Translator (F0 Free tier: 2M chars/month, excellent quality)
const AZURE_TRANSLATOR_KEYS = [
  (process.env.AZURE_TRANSLATOR_KEY || '').trim(),
  (process.env.AZURE_TRANSLATOR_KEY_2 || '').trim(),
].filter(Boolean);
const AZURE_REGION = 'westeurope';
let _azureKeyIndex = 0;
let _azureExhaustedKeys = new Set();

// Google Cloud Translation (official API, free tier: 500K chars/month)
// Hard-capped at 16K chars/day in code to match GCP quota setting and avoid billing
const GOOGLE_CLOUD_TRANSLATE_KEY = (process.env.GOOGLE_CLOUD_TRANSLATE_KEY || process.env.GEMINI_API_KEY || '').trim();
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
const LIBRETRANSLATE_PUBLIC = [
  'https://translate.fedilab.app',          // ✅ 200ms, 1 req/burst rate limit, verified 2026-03-30
  'https://translate.cutie.dating',         // ✅ 4.7s slower but reliable, verified 2026-03-30
];
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
  tierHits: { deepl: 0, azure: 0, googleCloud: 0, mozhiDeepL: 0, myMemory: 0, lingva: 0, simplyTranslate: 0, mozhiDdg: 0, libreTranslate: 0, huggingFace: 0, mozhiGoogle: 0, google: 0, mozhiYandex: 0 },
  tierErrors: { deepl: 0, azure: 0, googleCloud: 0, mozhiDeepL: 0, myMemory: 0, lingva: 0, simplyTranslate: 0, mozhiDdg: 0, libreTranslate: 0, huggingFace: 0, mozhiGoogle: 0, google: 0, mozhiYandex: 0 },
};

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
  return { ..._cascadeStats };
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
    console.log(`   🔑 Azure: ${active}/${AZURE_TRANSLATOR_KEYS.length} keys active${_azureExhaustedKeys.size > 0 ? ` (${_azureExhaustedKeys.size} exhausted)` : ''}`);
  }
}

function normalizeSpace(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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
  const clean = normalizeSpace(text);
  const chunks = clean.length <= MAX_CHUNK ? [clean] : chunkText(clean, MAX_CHUNK);
  const translated = [];

  for (const chunk of chunks) {
    const body = new URLSearchParams();
    body.append('text', chunk);
    if (srcCode) body.append('source_lang', srcCode);
    body.append('target_lang', tgtCode);

    const res = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 456 || res.status === 429) {
      throw Object.assign(new Error(`DeepL ${res.status}`), { quotaExhausted: true });
    }
    if (!res.ok) return '';
    const data = await res.json();
    const t = data?.translations?.[0]?.text || '';
    if (!t) return '';
    translated.push(t);
    if (chunks.length > 1) await delay(200);
  }

  return normalizeSpace(translated.join('\n\n'));
}

async function translateWithDeepL(text, sourceLang, targetLang) {
  if (DEEPL_API_KEYS.length === 0) return '';
  const clean = normalizeSpace(text);
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
        if (res.status === 403 || res.status === 429) {
          _azureExhaustedKeys.add(key);
          _cascadeStats.tierErrors.azure = (_cascadeStats.tierErrors.azure || 0) + 1;
          console.log(`🔑 Azure key #${idx + 1} quota exhausted — rotating`);
          throw Object.assign(new Error('Azure quota'), { quotaExhausted: true });
        }
        if (!res.ok) return '';
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
      return '';
    }
  }
  return '';
}

// ── Google Cloud Translation (official API, 500K free/month) ───────────────
async function translateWithGoogleCloud(text, sourceLang, targetLang) {
  if (!GOOGLE_CLOUD_TRANSLATE_KEY) return '';
  const clean = normalizeSpace(text);
  if (!clean || sourceLang === targetLang) return '';
  if (_googleCloudDailyChars + clean.length > GOOGLE_CLOUD_DAILY_LIMIT) return '';

  try {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_CLOUD_TRANSLATE_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
export async function freeTranslate({ text, sourceLang, targetLang }) {
  const clean = normalizeSpace(text);
  if (!clean) return '';
  if (sourceLang === targetLang) return clean;

  _cascadeStats.calls++;

  /** Try a tier: track success/error, return result or '' */
  async function tryTier(tierName, fn) {
    try {
      const result = await fn();
      if (result) {
        _cascadeStats.tierHits[tierName] = (_cascadeStats.tierHits[tierName] || 0) + 1;
        _cascadeStats.successes++;
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
  if (t1) return t1;

  // Tier 2: Azure Translator (F0 Free — 2M chars/month, near-DeepL quality)
  const t1b = await tryTier('azure', () => translateWithAzure(clean, sourceLang, targetLang));
  if (t1b) return t1b;

  // Tier 3: Google Cloud Translation (official API, 500K free/month, hard-capped 16K/day)
  const t2c = await tryTier('googleCloud', () => translateWithGoogleCloud(clean, sourceLang, targetLang));
  if (t2c) return t2c;

  // Tier 4: MyMemory (best EU language quality, 50K chars/day with email param)
  // Short text (≤5000 chars): single call. Long text: chunk at sentence boundaries.
  const t2 = await tryTier('myMemory', async () => {
    if (clean.length <= 5000) {
      const mm = await translateWithMyMemory(clean, sourceLang, targetLang);
      if (mm && normalizeSpace(mm).toLowerCase() !== clean.toLowerCase()) return normalizeSpace(mm);
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
  if (t2) return t2;

  // Tier 4: LibreTranslate (3 instances raced in parallel — reliable from CI)
  const t4 = await tryTier('libreTranslate', () => translateWithLibreTranslate(clean, sourceLang, targetLang));
  if (t4) return t4;

  // Tier 5: Hugging Face OPUS-MT (Helsinki-NLP open-source, good for short text)
  const t5 = await tryTier('huggingFace', () => translateWithHuggingFace(clean, sourceLang, targetLang));
  if (t5) return t5;

  // Tier 6: Mozhi+DuckDuckGo (Bing via Mozhi proxy — works sometimes from CI)
  const t6b = await tryTier('mozhiDdg', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'duckduckgo'));
  if (t6b) return t6b;

  // ── LOCAL/DEV TIERS (blocked from GitHub Actions IPs, work locally) ───────

  // Tier 6: Lingva (Google Translate proxy — works locally, blocked in CI)
  const t6 = await tryTier('lingva', () => translateWithLingva(clean, sourceLang, targetLang));
  if (t6) return t6;

  // Tier 7: Mozhi+Google (Google via Mozhi — works locally, blocked in CI)
  const t7 = await tryTier('mozhiGoogle', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'google'));
  if (t7) return t7;

  // Tier 8: Google Translate (unofficial direct endpoint — often blocked)
  const t8 = await tryTier('google', () => translateWithGoogle(clean, sourceLang, targetLang));
  if (t8) return t8;

  // Tier 9: Mozhi+DeepL (DeepL engine returns empty via proxy — broken since 2026-03)
  const t9 = await tryTier('mozhiDeepL', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'deepl'));
  if (t9) return t9;

  // Tier 10: Mozhi+Yandex (slow last resort)
  const t10 = await tryTier('mozhiYandex', () => translateWithMozhiEngine(clean, sourceLang, targetLang, 'yandex'));
  if (t10) return t10;

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
 * @param {number} [options.maxRetries=2] - Max retry attempts after first failure
 * @returns {Promise<string>} Translated text or ''
 */
export async function freeTranslateWithRetry({ text, sourceLang, targetLang, maxRetries = 2 }) {
  const result = await freeTranslate({ text, sourceLang, targetLang });
  if (result) return result;

  for (let i = 1; i <= maxRetries; i++) {
    await delay(i * 1000);
    const retry = await freeTranslate({ text, sourceLang, targetLang });
    if (retry) return retry;
  }

  return '';
}
