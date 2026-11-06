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
const MYMEMORY_TIMEOUT_MS = 8000;

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

function cancelResponseBody(response, reason = 'MyMemory request timed out') {
  try {
    const cancellation = response?.body?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {
    // Minimal fetch doubles may expose a throwing cancel().
  }
}

function cancelReaderBestEffort(reader, reason) {
  try {
    const cancellation = reader?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {
    // A test double may expose a throwing cancel().
  }
}

async function readJsonWithDeadline(response, timeoutPromise, setActiveReader) {
  const reader = response?.body?.getReader?.();
  // Existing callers use minimal fetch doubles without a ReadableStream. Keep
  // those compatible; native fetch responses always take the owned-reader path.
  if (!reader) {
    return await Promise.race([
      Promise.resolve().then(() => response.json()),
      timeoutPromise,
    ]);
  }

  setActiveReader(reader);
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([
        Promise.resolve().then(() => reader.read()),
        timeoutPromise,
      ]);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Invalid MyMemory response chunk');
      // A stream source may reuse the same Uint8Array backing store on its
      // next read; retain a byte copy before asking it for another chunk.
      chunks.push(Uint8Array.from(value));
      totalBytes += value.byteLength;
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    setActiveReader(undefined);
    try { reader.releaseLock?.(); } catch { /* cancellation may still be settling */ }
  }
}

async function fetchJsonWithDeadline(url, init, timeoutMs = MYMEMORY_TIMEOUT_MS) {
  const controller = new AbortController();
  let response;
  let activeReader;
  let timedOut = false;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  // The deadline may reject before fetch() returns a Response. Keep that
  // rejection observed until Promise.race attaches its own handler below.
  timeoutPromise.catch(() => {});

  const timeout = setTimeout(() => {
    timedOut = true;
    const reason = new DOMException('The MyMemory request timed out', 'TimeoutError');
    controller.abort(reason);
    rejectTimeout(reason);
    if (activeReader) cancelReaderBestEffort(activeReader, reason);
    else cancelResponseBody(response, reason);
  }, timeoutMs);

  try {
    const fetchPromise = Promise.resolve().then(() => fetch(url, {
      ...init,
      signal: controller.signal,
    }));
    // Abort is only a cancellation hint. If a non-compliant fetch resolves
    // after the explicit deadline, release its late response as well.
    fetchPromise.then((lateResponse) => {
      if (timedOut) cancelResponseBody(lateResponse);
    }, () => {});

    response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response?.ok) {
      cancelResponseBody(response);
      return null;
    }

    return await readJsonWithDeadline(response, timeoutPromise, (reader) => {
      activeReader = reader;
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

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

    const data = await fetchJsonWithDeadline(url, {
      headers: { 'User-Agent': 'FrontaliereTicino/1.0' },
    });
    if (!data) return null;

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
