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
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const GOOGLE_TRANSLATE_ENDPOINTS = [
  'https://translate.googleapis.com/translate_a/single',
  'https://clients5.google.com/translate_a/t',
];
const TIMEOUT_MS = 15000;

// Lingva Translate instances (free Google Translate proxy)
// Verified 2026-03-22 — only instances that returned valid translations
const LINGVA_INSTANCES = [
  'https://translate.plausibility.cloud',  // ✅ 3.3s
];

// SimplyTranslate instances (another free proxy)
// Verified 2026-03-22
const SIMPLYTRANSLATE_INSTANCES = [
  'https://simplytranslate.org',           // ✅ 1.3s
];

// Mozhi instances (open-source translation proxy supporting multiple engines)
// Verified 2026-03-22
const MOZHI_INSTANCES = [
  'https://mozhi.adminforge.de',           // ✅ 1.5s
  'https://mozhi.pussthecat.org',          // ✅ 0.7s
  'https://mozhi.aryak.me',               // ✅ 3.4s (slow but reliable)
];

// LibreTranslate public instances (open-source, no API key)
// Verified 2026-03-22
const LIBRETRANSLATE_PUBLIC = [
  'https://translate.cutie.dating',        // ✅ 4.7s
];
const DEEPL_LANG_MAP = { it: 'IT', en: 'EN', de: 'DE', fr: 'FR' };

// ── Instance Health Tracking ────────────────────────────────────────────────
// Track which instances have failed recently to skip them on subsequent calls.
// After HEALTH_RECOVERY_MS, an instance is retried.
const HEALTH_RECOVERY_MS = 10 * 60 * 1000; // 10 minutes
const instanceHealth = new Map(); // url → { failedAt: number, failures: number }

function isInstanceHealthy(url) {
  const entry = instanceHealth.get(url);
  if (!entry) return true;
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

function normalizeSpace(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── DeepL Free ──────────────────────────────────────────────────────────────
async function translateWithDeepL(text, sourceLang, targetLang) {
  if (!DEEPL_API_KEY) return '';
  const clean = normalizeSpace(text);
  if (!clean || sourceLang === targetLang) return '';

  const srcCode = DEEPL_LANG_MAP[sourceLang] || sourceLang?.toUpperCase() || '';
  const tgtCode = DEEPL_LANG_MAP[targetLang] || targetLang?.toUpperCase() || '';
  if (!tgtCode) return '';

  const MAX_CHUNK = 5000;
  const chunks = clean.length <= MAX_CHUNK ? [clean] : chunkText(clean, MAX_CHUNK);
  const translated = [];

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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return '';
      const data = await res.json();
      const t = data?.translations?.[0]?.text || '';
      if (!t) return '';
      translated.push(t);
    } catch {
      return '';
    }
    if (chunks.length > 1) await delay(200);
  }

  const result = normalizeSpace(translated.join('\n\n'));
  if (!result || result.toLowerCase() === clean.toLowerCase()) return '';
  return result;
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

// ── Mozhi (open-source translation proxy) ───────────────────────────────────
async function translateWithMozhi(text, sourceLang, targetLang) {
  const q = normalizeSpace(text);
  if (!q || sourceLang === targetLang) return '';

  return raceInstances(MOZHI_INSTANCES, async (base, signal) => {
    const params = new URLSearchParams({
      engine: 'google',
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
    const translated = normalizeSpace(data?.translated_text || '');
    if (translated && translated.toLowerCase() !== q.toLowerCase()) return translated;
    return '';
  });
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
 * Cascade (7 tiers):
 *   1. DeepL Free        — best quality, requires API key
 *   2. MyMemory           — good for EU languages, ≤500 chars
 *   3. Lingva             — free Google Translate proxy (6 mirrors, parallel race)
 *   4. SimplyTranslate    — another free proxy (4 mirrors, parallel race)
 *   5. LibreTranslate     — open-source MT (5 public instances, parallel race)
 *   6. Mozhi              — open-source proxy (3 instances, parallel race)
 *   7. Google Translate    — unofficial direct endpoint, multi-endpoint, chunked
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

  // Tier 1: DeepL Free (best quality)
  try {
    const deepl = await translateWithDeepL(clean, sourceLang, targetLang);
    if (deepl) return deepl;
  } catch { /* continue */ }

  // Tier 2: MyMemory (good quality for EU languages, limited to 500 chars)
  if (clean.length <= 500) {
    try {
      const mm = await translateWithMyMemory(clean, sourceLang, targetLang);
      if (mm && normalizeSpace(mm).toLowerCase() !== clean.toLowerCase()) {
        return normalizeSpace(mm);
      }
    } catch { /* continue */ }
  }

  // Tier 3: Lingva (free Google Translate proxy, 6 mirrors, parallel race)
  try {
    const lingva = await translateWithLingva(clean, sourceLang, targetLang);
    if (lingva) return lingva;
  } catch { /* continue */ }

  // Tier 4: SimplyTranslate (another free proxy, 4 mirrors, parallel race)
  try {
    const simply = await translateWithSimplyTranslate(clean, sourceLang, targetLang);
    if (simply) return simply;
  } catch { /* continue */ }

  // Tier 5: LibreTranslate (open-source, 5 public instances, parallel race)
  try {
    const libre = await translateWithLibreTranslate(clean, sourceLang, targetLang);
    if (libre) return libre;
  } catch { /* continue */ }

  // Tier 6: Mozhi (open-source proxy, 3 instances, parallel race)
  try {
    const mozhi = await translateWithMozhi(clean, sourceLang, targetLang);
    if (mozhi) return mozhi;
  } catch { /* continue */ }

  // Tier 7: Google Translate (unofficial, multi-endpoint, chunked)
  try {
    const google = await translateWithGoogle(clean, sourceLang, targetLang);
    if (google) return google;
  } catch { /* continue */ }

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
