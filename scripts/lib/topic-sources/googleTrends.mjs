// scripts/lib/topic-sources/googleTrends.mjs
//
// Pulls "rising" related-queries from Google Trends for a static seed list
// across 3 geos (IT, IT-25 = Lombardia, CH). Adds any topKeywords from the
// Phase-1 winnerFingerprint when available. Maps each rising query to a
// Candidate with `googleTrendsScore` derived from the API's value (0-100,
// "Breakout" → 200).
//
// Resilience:
//   - Each request wrapped in try/catch; module never throws.
//   - 1.5s gap between requests.
//   - On 429/network error: ONE Playwright fallback retry for that
//     (seed, geo) pair against the public trends.google.com page.
//   - Cap: max 20 candidates per geo.

import { fnv1a8, normalizeKeyword } from './gscOrphans.mjs';

const SEEDS_FALLBACK = [
  'frontaliere',
  'frontalieri',
  'permesso G',
  'tasse svizzera',
  'LPP',
  'telelavoro frontalieri',
  'ristorni frontalieri',
  'AVS frontalieri',
  'LAMal',
  'CMI frontalieri',
  'IRPEF frontalieri',
  'busta paga svizzera',
  'nuovo accordo fiscale',
  'secondo pilastro',
];

const GEOS = [
  { id: 'IT', sourceKey: 'googleTrendsIt' },
  { id: 'IT-25', sourceKey: 'googleTrendsItLombardia' },
  { id: 'CH', sourceKey: 'googleTrendsCh' },
];

const MAX_PER_GEO = 20;
const REQUEST_GAP_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;

// Per-seed retries with exponential backoff. Many `relatedQueries` errors are
// transient (HTML parse-as-JSON, ECONNRESET, intermittent 429). We retry the
// lib call before falling back to Playwright.
const RETRY_DELAYS_MS = [1000, 3000, 8000];

// Overall budget for one Playwright fallback attempt (selector wait + JS
// execution). Wraps the entire Playwright call so a single hung browser
// can't burn the per-source 5-minute timeout.
const FALLBACK_OVERALL_TIMEOUT_MS = 30000;

// With retries in place, a "real outage" is now ≥ 5 consecutive seeds
// failing all 3 attempts (was 3). 5 × 4 attempts = 20 tries before bailing.
const MAX_CONSECUTIVE_ERRORS = 5;

export function buildSeedList(winnerFingerprint) {
  const seen = new Set();
  const seeds = [];
  const push = (s) => {
    const norm = normalizeKeyword(s);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    seeds.push(s);
  };
  for (const s of SEEDS_FALLBACK) push(s);
  if (winnerFingerprint && Array.isArray(winnerFingerprint.topKeywords)) {
    for (const kw of winnerFingerprint.topKeywords) push(kw);
  }
  return seeds;
}

export function parseTrendsScore(rawValue) {
  if (rawValue == null) return null;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return Math.max(0, Math.min(rawValue, 200));
  }
  const s = String(rawValue).trim();
  if (/breakout/i.test(s)) return 200;
  // strip percent / "+" prefix
  const num = Number(s.replace(/[+,%\s]/g, ''));
  if (Number.isFinite(num)) return Math.max(0, Math.min(num, 200));
  return null;
}

// Parse the JSON the google-trends-api lib returns from `relatedQueries`.
// Shape: { default: { rankedList: [ { rankedKeyword: [...] }, { rankedKeyword: [...] } ] } }
// Lists 0=top, 1=rising. We only want rising.
export function extractRisingQueries(json) {
  if (!json || typeof json !== 'object') return [];
  const lists = json?.default?.rankedList;
  if (!Array.isArray(lists) || lists.length < 2) return [];
  const rising = lists[1]?.rankedKeyword;
  if (!Array.isArray(rising)) return [];
  // The google-trends-api shape: r.value is the numeric score, r.formattedValue
  // is a display string like "+250%" or "Breakout". Prefer the numeric value;
  // fall back to parsing the formatted string. Older shapes had formattedValue
  // as an array — keep that path too, but as last-ditch.
  return rising
    .map((r) => {
      const formatted = Array.isArray(r?.formattedValue)
        ? r.formattedValue[0]
        : r?.formattedValue;
      return {
        query: r?.query ?? r?.topic?.title ?? null,
        score:
          (typeof r?.value === 'number' && Number.isFinite(r.value)
            ? Math.max(0, Math.min(r.value, 200))
            : null) ?? parseTrendsScore(formatted ?? null),
      };
    })
    .filter((r) => r.query);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timeout after ${ms}ms`));
    }, ms);
    if (t && typeof t.unref === 'function') t.unref();
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function callGoogleTrendsApi(googleTrends, keyword, geo) {
  // googleTrends.relatedQueries returns a stringified JSON.
  const raw = await withTimeout(
    googleTrends.relatedQueries({
      keyword,
      geo,
      hl: 'it-IT',
    }),
    REQUEST_TIMEOUT_MS,
    'google-trends-api',
  );
  return JSON.parse(raw);
}

// Modern Trends UI has gone through several redesigns. Try multiple
// selectors in order; first match wins. The legacy `.fe-related-queries`
// wrapper still appears in the experimental endpoint but is unreliable —
// ARIA-region + custom-element selectors are more durable.
const RELATED_QUERIES_SELECTORS = [
  '.fe-related-queries',
  '.fe-related-queries-tab',
  '[role="region"][aria-label*="Related"]',
  'widget-related-queries',
];

async function _playwrightFallbackInner(keyword, geo) {
  let browser = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    const url = `https://trends.google.com/trends/explore?q=${encodeURIComponent(
      keyword,
    )}&geo=${encodeURIComponent(geo)}&hl=it-IT`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Race the candidate selectors — the first one that resolves wins.
    // If NONE match (UI redesigned again), return [] quietly instead of
    // throwing — the lib's original error reason should be reported.
    let foundSelector = null;
    for (const sel of RELATED_QUERIES_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 4000 });
        foundSelector = sel;
        break;
      } catch {
        /* try next */
      }
    }
    if (!foundSelector) return [];

    // Attempt to click the "rising" tab if present (graceful fail).
    const risingTab = await page
      .$('[data-rising], button:has-text("In aumento"), button:has-text("Rising")')
      .catch(() => null);
    if (risingTab) {
      try {
        await risingTab.click({ timeout: 2000 });
      } catch {
        /* ignore */
      }
    }

    const rows = await page.$$eval(
      `${foundSelector} .item, ${foundSelector} [class*="item"], ${foundSelector} li`,
      (nodes) =>
        nodes.map((n) => {
          const q =
            n.querySelector('.label-text, .title-text, span.label, a, span')?.textContent ?? '';
          const v =
            n.querySelector('.rising-value, .value-text, span.num, [class*="value"]')?.textContent ?? '';
          return { q: q.trim(), v: v.trim() };
        }),
    );
    return rows
      .map(({ q, v }) => ({
        query: q || null,
        score: parseTrendsScore(v),
      }))
      .filter((r) => r.query);
  } catch {
    return [];
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
  }
}

async function playwrightFallback(keyword, geo) {
  // Cap the entire Playwright path with an overall timeout. A single hung
  // browser must not burn the per-source 5-minute budget.
  return Promise.race([
    _playwrightFallbackInner(keyword, geo),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve([]), FALLBACK_OVERALL_TIMEOUT_MS);
      if (t && typeof t.unref === 'function') t.unref();
    }),
  ]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} [opts]
 * @param {object} [opts.winnerFingerprint] — optional Phase-1 fingerprint.
 * @param {object} [opts.googleTrendsImpl] — test override (must expose `.relatedQueries`).
 * @param {Function} [opts.playwrightFallback] — test override.
 * @param {Function} [opts.sleepFn] — test override (default real timer).
 * @returns {Promise<{ ok: boolean, perGeo: Record<string, {ok: boolean, candidates: any[], reason?: string}>, candidates: any[] }>}
 */
export async function fetchGoogleTrendsCandidates(opts = {}) {
  const seeds = buildSeedList(opts.winnerFingerprint ?? null);
  const sleepFn = opts.sleepFn ?? sleep;
  const fallback = opts.playwrightFallback ?? playwrightFallback;

  let googleTrends = opts.googleTrendsImpl;
  if (!googleTrends) {
    try {
      const mod = await import('google-trends-api');
      googleTrends = mod.default ?? mod;
    } catch (e) {
      const empty = {};
      for (const geo of GEOS) {
        empty[geo.sourceKey] = {
          ok: false,
          candidates: [],
          reason: `google-trends-api import failed: ${e.message ?? String(e)}`,
        };
      }
      return { ok: false, perGeo: empty, candidates: [] };
    }
  }

  const perGeo = {};
  const all = [];

  for (const geo of GEOS) {
    const collected = [];
    const seenForGeo = new Set();
    let geoOk = true;
    let lastReason = null;
    let consecutiveErrors = 0;
    let fallbackTried = false;

    for (const seed of seeds) {
      let rising = [];
      let hadError = false;
      let lastErrorMsg = null;

      // Retry the lib call up to RETRY_DELAYS_MS.length+1 times. Many
      // `relatedQueries` errors are transient (parse-HTML-as-JSON,
      // ECONNRESET, intermittent 429). Only after exhausting retries do
      // we fall back to Playwright.
      let attempt = 0;
      while (attempt <= RETRY_DELAYS_MS.length) {
        try {
          const json = await callGoogleTrendsApi(googleTrends, seed, geo.id);
          rising = extractRisingQueries(json);
          hadError = false;
          break;
        } catch (e) {
          lastErrorMsg = String(e?.message ?? e);
          hadError = true;
          if (attempt < RETRY_DELAYS_MS.length) {
            await sleepFn(RETRY_DELAYS_MS[attempt]);
          }
          attempt++;
        }
      }

      if (hadError) {
        // Capture the lib's original reason BEFORE attempting fallback so a
        // failed fallback doesn't overwrite the diagnostic.
        geoOk = false;
        lastReason = lastErrorMsg ? lastErrorMsg.slice(0, 200) : 'unknown error';

        // ONE Playwright fallback attempt per geo, on first error only —
        // avoids spending 14 × Playwright launches if Trends is down.
        if (!fallbackTried) {
          fallbackTried = true;
          try {
            rising = await fallback(seed, geo.id);
          } catch {
            rising = [];
          }
          // If the fallback recovered ≥1 query, reset `geoOk` so the source
          // isn't marked failed: data is real, even if the lib path failed.
          if (Array.isArray(rising) && rising.length > 0) {
            geoOk = true;
            hadError = false;
            lastReason = null;
          }
        }
      }
      if (hadError) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          // Bail this geo — clearly rate-limited / unreachable.
          break;
        }
      } else {
        consecutiveErrors = 0;
      }

      for (const r of rising) {
        if (!r.query) continue;
        const norm = normalizeKeyword(r.query);
        if (!norm || seenForGeo.has(norm)) continue;
        seenForGeo.add(norm);
        collected.push({
          id: fnv1a8(norm),
          keyword: r.query,
          normalizedKeyword: norm,
          angle: null,
          locale: 'it',
          sources: [geo.sourceKey],
          demandSignals: {
            googleTrendsScore: r.score,
            googleTrendsGeo: geo.id,
            googleTrendsSeed: seed,
          },
          rationale: `Google Trends rising (${geo.id}, seed "${seed}") — score ${
            r.score ?? '?'
          }`,
        });
        if (collected.length >= MAX_PER_GEO) break;
      }

      if (collected.length >= MAX_PER_GEO) break;
      await sleepFn(REQUEST_GAP_MS);
    }

    perGeo[geo.sourceKey] = collected.length
      ? { ok: true, candidates: collected }
      : { ok: geoOk, candidates: [], reason: lastReason ?? 'no rising queries' };
    for (const c of collected) all.push(c);
  }

  const ok = Object.values(perGeo).some((g) => g.ok && g.candidates.length > 0);
  return { ok, perGeo, candidates: all };
}

export default fetchGoogleTrendsCandidates;
