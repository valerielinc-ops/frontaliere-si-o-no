/**
 * MyMemory Translation API — Free translation fallback.
 *
 * https://mymemory.translated.net/doc/spec.php
 * - Anonymous: 1000 words/day (5000 chars/day effectively)
 * - With email: 10000 words/day
 * - Uses professional translation memories + MT blending
 * - Quality is often better than unofficial Google Translate for EU languages
 *
 * Rate limit: max 5 concurrent requests, 1s between calls.
 */

const MYMEMORY_API = 'https://api.mymemory.translated.net/get';

const LANG_MAP = {
  it: 'it-IT',
  en: 'en-GB',
  de: 'de-DE',
  fr: 'fr-FR',
};

let lastCallMs = 0;
let dailyChars = 0;
const DAILY_CHAR_LIMIT = 4500; // conservative limit (leave headroom)

/**
 * Translate text using MyMemory free API.
 *
 * @param {string} text - Text to translate (max ~500 chars per call recommended)
 * @param {string} sourceLang - Source language code (it/en/de/fr)
 * @param {string} targetLang - Target language code (it/en/de/fr)
 * @returns {Promise<string|null>} Translated text or null on failure
 */
export async function translateWithMyMemory(text, sourceLang, targetLang) {
  if (!text || text.length < 3) return null;
  if (sourceLang === targetLang) return text;

  const srcCode = LANG_MAP[sourceLang] || sourceLang;
  const tgtCode = LANG_MAP[targetLang] || targetLang;

  // Guard daily limit
  if (dailyChars + text.length > DAILY_CHAR_LIMIT) {
    return null;
  }

  // Rate limit: wait at least 1s between calls
  const now = Date.now();
  const elapsed = now - lastCallMs;
  if (elapsed < 1000) {
    await new Promise((r) => setTimeout(r, 1000 - elapsed));
  }
  lastCallMs = Date.now();

  try {
    const params = new URLSearchParams({
      q: text.slice(0, 500), // API handles up to ~500 chars well
      langpair: `${srcCode}|${tgtCode}`,
    });
    // Add email for higher quota if available
    const email = process.env.MYMEMORY_EMAIL;
    if (email) {
      params.set('de', email);
    }

    const url = `${MYMEMORY_API}?${params.toString()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();

    const translated = data?.responseData?.translatedText;
    if (!translated || typeof translated !== 'string') return null;

    // MyMemory returns "MYMEMORY WARNING" when quota exceeded
    if (translated.includes('MYMEMORY WARNING') || translated.includes('PLEASE CONTACT')) {
      return null;
    }

    // Quality check: match score (0-1, higher is better)
    const matchScore = data?.responseData?.match;
    if (typeof matchScore === 'number' && matchScore < 0.3) {
      return null; // Very low quality, skip
    }

    dailyChars += text.length;
    return translated.trim();
  } catch {
    return null;
  }
}

/**
 * Get current daily usage stats.
 */
export function getMyMemoryStats() {
  return { dailyChars, limit: DAILY_CHAR_LIMIT };
}

/**
 * Reset daily counter (call at start of new crawl day).
 */
export function resetMyMemoryDaily() {
  dailyChars = 0;
}
