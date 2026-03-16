/**
 * Free Translation Cascade — Reusable multi-service translation utility.
 *
 * Provides a robust translation cascade using free APIs:
 *   1. DeepL Free API  (if DEEPL_API_KEY is set)
 *   2. MyMemory API    (up to ~500 chars per call)
 *   3. Google Translate (unofficial free endpoint, chunked for long text)
 *
 * This module is designed to be imported by any script that needs translation
 * without depending on the full shared-jobs-crawler.mjs infrastructure.
 */

import { translateWithMyMemory } from './mymemory-translate.mjs';

// ── Config ──────────────────────────────────────────────────────────────────
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const TIMEOUT_MS = 15000;
const DEEPL_LANG_MAP = { it: 'IT', en: 'EN', de: 'DE', fr: 'FR' };

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

// ── Google Translate (unofficial free) ──────────────────────────────────────
async function translateChunkGoogle(text, sourceLang, targetLang) {
  const q = normalizeSpace(text);
  if (!q) return '';

  const params = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang || 'auto',
    tl: targetLang,
    dt: 't',
    q,
  });

  try {
    const res = await fetch(`${GOOGLE_TRANSLATE_ENDPOINT}?${params.toString()}`, {
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const raw = await res.text().catch(() => '');
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    const segments = Array.isArray(parsed?.[0]) ? parsed[0] : [];
    return normalizeSpace(
      segments.map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('')
    );
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
 * Translate text using a cascade of free translation services.
 * Returns translated text or empty string if all services fail.
 *
 * Cascade: DeepL Free → MyMemory → Google Translate
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

  // Tier 3: Google Translate (unofficial, works for any length via chunking)
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
