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

// Monotonic "next free slot" timestamp for rate-limit spacing. Reserved
// synchronously (no await between read and write) so concurrent callers each
// get a distinct 1s-spaced slot — see the rate-limit block below.
let nextSlotMs = 0;
let dailyChars = 0;
// With email param: 50K chars/day. Without: 5K chars/day.
// Default email for the project — gives 10x quota boost for free.
const MYMEMORY_EMAIL = (process.env.MYMEMORY_EMAIL || 'info@frontaliereticino.ch').trim();
const DAILY_CHAR_LIMIT = MYMEMORY_EMAIL ? 45000 : 4500;

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

  // Rate limit: max 5 concurrent, 1s between calls. Reserve a 1s-spaced slot
  // SYNCHRONOUSLY (read + write nextSlotMs with no await in between) so N
  // concurrent callers each get their own slot instead of all reading the same
  // lastCallMs, waiting the same delta, and firing in a burst. The old
  // read-then-await-then-write collapsed the spacing under the localization
  // queue's concurrency → burst 429s → cascade fell through to slower tiers.
  const now = Date.now();
  const slot = Math.max(now, nextSlotMs);
  nextSlotMs = slot + 1000;
  const wait = slot - now;
  // Under Vitest fetch is always mocked, so there's no real API to rate-limit
  // against — skip the spacing wait to avoid burning real seconds per call.
  if (wait > 0 && !process.env.VITEST) {
    await new Promise((r) => setTimeout(r, wait));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const params = new URLSearchParams({
      q: text.slice(0, 5000), // API supports up to 5000 chars per call
      langpair: `${srcCode}|${tgtCode}`,
    });
    // Email param unlocks 50K chars/day (vs 5K anonymous)
    if (MYMEMORY_EMAIL) {
      params.set('de', MYMEMORY_EMAIL);
    }

    const url = `${MYMEMORY_API}?${params.toString()}`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
    });

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
  } finally {
    clearTimeout(timeout);
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
