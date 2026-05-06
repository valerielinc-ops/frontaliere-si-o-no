#!/usr/bin/env node
// scripts/mine-topic-candidates.mjs
//
// Phase-2 orchestrator: pulls candidates from GSC orphans + Google Trends +
// Reddit + Facebook public pages, deduplicates and scores them, then writes
// `data/topic-candidates.json`. See spec
// docs/superpowers/specs/2026-05-06-smarter-article-generator-design.md.
//
// Graceful degradation: every source returns `{ ok, candidates, reason? }`
// and the script always exits 0 with a valid JSON file, even if every
// source fails (in which case `candidates` is an empty array).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { fetchGscOrphanCandidates, extractItTitles, normalizeKeyword, fnv1a8 } from './lib/topic-sources/gscOrphans.mjs';
import { fetchGoogleTrendsCandidates } from './lib/topic-sources/googleTrends.mjs';
import { fetchRedditCandidates } from './lib/topic-sources/reddit.mjs';
import { fetchFacebookCandidates } from './lib/topic-sources/facebookPages.mjs';
import { noveltyScore } from './lib/topic-sources/noveltyCheck.mjs';

const OUTPUT_PATH = 'data/topic-candidates.json';
const BLOG_META_PATH = 'services/locales/blog-meta-it.ts';
const ARTICLE_PERFORMANCE_PATH = 'data/article-performance.json';

const NOVELTY_FLOOR = 0.3;
const TOP_N = 100;

const SIGNAL_WEIGHTS = {
  gsc: 0.4,
  trends: 0.3,
  reddit: 0.2,
  facebook: 0.1,
};

function loadJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.warn(`[mine-topic] could not load ${path}: ${e.message}`);
    return null;
  }
}

function loadTextSafe(path) {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function writeJsonAtomic(path, obj) {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

// Per-source signal normalization → 0-1.
export function normalizeSignals(demandSignals) {
  const out = {};
  if (demandSignals.gscImpressions != null) {
    out.gsc = Math.min(Number(demandSignals.gscImpressions) / 500, 1);
  }
  if (demandSignals.googleTrendsScore != null) {
    out.trends = Math.min(Number(demandSignals.googleTrendsScore) / 100, 1);
  }
  if (
    demandSignals.redditScore != null ||
    demandSignals.redditComments != null ||
    demandSignals.redditCombined != null
  ) {
    const combined =
      demandSignals.redditCombined != null
        ? Number(demandSignals.redditCombined)
        : Number(demandSignals.redditScore ?? 0) +
          Number(demandSignals.redditComments ?? 0) * 2;
    out.reddit = Math.min(combined / 100, 1);
  }
  if (
    demandSignals.facebookEngagement != null ||
    demandSignals.facebookReactions != null
  ) {
    const eng =
      demandSignals.facebookEngagement != null
        ? Number(demandSignals.facebookEngagement)
        : Number(demandSignals.facebookReactions ?? 0) +
          Number(demandSignals.facebookComments ?? 0);
    out.facebook = Math.min(eng / 100, 1);
  }
  return out;
}

export function computeDemandScore(normSignals) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [k, w] of Object.entries(SIGNAL_WEIGHTS)) {
    if (normSignals[k] != null && Number.isFinite(normSignals[k])) {
      weightedSum += normSignals[k] * w;
      weightTotal += w;
    }
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

// Merge multiple Candidates that share a normalized keyword. Sources +
// demandSignals are unioned; the lowest position / highest impressions etc
// win on conflict.
export function mergeCandidates(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const norm = c.normalizedKeyword || normalizeKeyword(c.keyword);
    if (!norm) continue;
    const existing = byKey.get(norm);
    if (!existing) {
      byKey.set(norm, {
        ...c,
        normalizedKeyword: norm,
        sources: [...(c.sources ?? [])],
        demandSignals: { ...(c.demandSignals ?? {}) },
        rationaleBits: c.rationale ? [c.rationale] : [],
      });
      continue;
    }
    for (const s of c.sources ?? []) {
      if (!existing.sources.includes(s)) existing.sources.push(s);
    }
    // Prefer max for impressions/score-like signals; min for position; first
    // non-null for everything else.
    const ds = c.demandSignals ?? {};
    const cur = existing.demandSignals;
    for (const key of Object.keys(ds)) {
      const incoming = ds[key];
      if (incoming == null) continue;
      if (cur[key] == null) {
        cur[key] = incoming;
        continue;
      }
      if (
        key === 'gscImpressions' ||
        key === 'gscClicks' ||
        key === 'googleTrendsScore' ||
        key === 'redditScore' ||
        key === 'redditComments' ||
        key === 'redditCombined' ||
        key === 'facebookReactions' ||
        key === 'facebookComments' ||
        key === 'facebookEngagement'
      ) {
        if (Number(incoming) > Number(cur[key])) cur[key] = incoming;
      } else if (key === 'gscPosition') {
        if (Number(incoming) < Number(cur[key])) cur[key] = incoming;
      }
      // else: keep existing
    }
    if (c.rationale) existing.rationaleBits.push(c.rationale);
    if (!existing.angle && c.angle) existing.angle = c.angle;
    // Keep the longer keyword (tends to be more descriptive).
    if (
      typeof c.keyword === 'string' &&
      c.keyword.length > (existing.keyword?.length ?? 0)
    ) {
      existing.keyword = c.keyword;
    }
  }
  // Stable id derived from normalized keyword.
  const out = [];
  for (const v of byKey.values()) {
    out.push({
      id: fnv1a8(v.normalizedKeyword),
      keyword: v.keyword,
      normalizedKeyword: v.normalizedKeyword,
      angle: v.angle ?? null,
      locale: v.locale ?? 'it',
      sources: v.sources,
      demandSignals: v.demandSignals,
      rationale: v.rationaleBits.join(' | '),
    });
  }
  return out;
}

export function scoreCandidates(merged, existingTitles) {
  return merged.map((c) => {
    const norm = normalizeSignals(c.demandSignals);
    const demandScore = round3(computeDemandScore(norm));
    const novelty = round3(noveltyScore(c.keyword, existingTitles));
    const totalScore = round3(0.6 * demandScore + 0.4 * novelty);
    return {
      ...c,
      demandScore,
      noveltyScore: novelty,
      totalScore,
    };
  });
}

function round3(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function compareCandidates(a, b) {
  if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
  return String(a.normalizedKeyword).localeCompare(String(b.normalizedKeyword));
}

function sourceSummary(name, result) {
  if (!result) return { ok: false, candidates: 0, reason: 'no result' };
  return {
    ok: !!result.ok,
    candidates: Array.isArray(result.candidates) ? result.candidates.length : 0,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export async function mineTopicCandidates({
  outputPath = OUTPUT_PATH,
  blogMetaPath = BLOG_META_PATH,
  articlePerformancePath = ARTICLE_PERFORMANCE_PATH,
  // Test seams — replace with mock impls when needed.
  gscOrphansImpl = fetchGscOrphanCandidates,
  googleTrendsImpl = fetchGoogleTrendsCandidates,
  redditImpl = fetchRedditCandidates,
  facebookImpl = fetchFacebookCandidates,
  noveltyFloor = NOVELTY_FLOOR,
  topN = TOP_N,
  now = () => new Date().toISOString(),
} = {}) {
  const blogMetaText = loadTextSafe(blogMetaPath);
  const existingTitles = extractItTitles(blogMetaText);

  const articlePerformance = loadJsonSafe(articlePerformancePath);
  const winnerFingerprint = articlePerformance?.winnerFingerprint ?? null;

  // Run sources sequentially — Reddit/Trends self-rate-limit, parallel buys
  // little and risks 429s.
  const gscRes = await safeRun(() =>
    gscOrphansImpl({ existingTitles }),
  );
  const trendsRes = await safeRun(() =>
    googleTrendsImpl({ winnerFingerprint }),
  );
  const redditRes = await safeRun(() => redditImpl());
  const facebookRes = await safeRun(() => facebookImpl());

  // Build per-source summary for top-level "sources" object.
  const sources = {
    gscOrphans: sourceSummary('gscOrphans', gscRes),
  };
  if (trendsRes?.perGeo) {
    for (const [k, v] of Object.entries(trendsRes.perGeo)) {
      sources[k] = sourceSummary(k, v);
    }
  } else {
    // Trends fully failed (e.g. import error) — represent the three geo keys.
    sources.googleTrendsIt = { ok: false, candidates: 0, reason: 'unavailable' };
    sources.googleTrendsItLombardia = {
      ok: false,
      candidates: 0,
      reason: 'unavailable',
    };
    sources.googleTrendsCh = { ok: false, candidates: 0, reason: 'unavailable' };
  }
  if (redditRes?.perSubreddit) {
    for (const [k, v] of Object.entries(redditRes.perSubreddit)) {
      sources[k] = sourceSummary(k, v);
    }
  } else {
    sources.redditTicino = { ok: false, candidates: 0, reason: 'unavailable' };
    sources.redditItaly = { ok: false, candidates: 0, reason: 'unavailable' };
    sources.redditLugano = { ok: false, candidates: 0, reason: 'unavailable' };
    sources.redditSwitzerland = {
      ok: false,
      candidates: 0,
      reason: 'unavailable',
    };
  }
  sources.facebookPages = sourceSummary('facebookPages', facebookRes);

  // Collect raw candidates (each source already returns array).
  const raw = [];
  if (gscRes?.candidates) raw.push(...gscRes.candidates);
  if (trendsRes?.candidates) raw.push(...trendsRes.candidates);
  if (redditRes?.candidates) raw.push(...redditRes.candidates);
  if (facebookRes?.candidates) raw.push(...facebookRes.candidates);

  // Merge by normalized keyword.
  const merged = mergeCandidates(raw);

  // Score (demand + novelty) and drop low-novelty.
  const scored = scoreCandidates(merged, existingTitles).filter(
    (c) => c.noveltyScore >= noveltyFloor,
  );

  // Deterministic sort + cap.
  scored.sort(compareCandidates);
  const candidates = scored.slice(0, topN);

  const output = {
    generatedAt: now(),
    sources,
    candidates,
  };

  writeJsonAtomic(outputPath, output);
  return output;
}

// Per-source timeout — even with internal try/catch a source can hang on a
// blocking network call (e.g. google-trends-api → trends.google.com). We
// race against a timer so the orchestrator always finishes.
const PER_SOURCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per source

async function safeRun(fn, timeoutMs = PER_SOURCE_TIMEOUT_MS) {
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          candidates: [],
          reason: `timeout after ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    const r = await Promise.race([
      Promise.resolve()
        .then(fn)
        .then((v) => v ?? { ok: false, candidates: [], reason: 'empty result' })
        .catch((e) => ({
          ok: false,
          candidates: [],
          reason: `unhandled: ${e?.message ?? String(e)}`,
        })),
      timeoutPromise,
    ]);
    return r;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    return process.argv[1] && url.pathname === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  mineTopicCandidates()
    .then((out) => {
      const counts = Object.entries(out.sources)
        .map(([k, v]) => `${k}:${v.candidates}${v.ok ? '' : '!'}`)
        .join(' ');
      console.log(
        `[mine-topic] wrote ${out.candidates.length} candidates → ${OUTPUT_PATH}`,
      );
      console.log(`[mine-topic] per-source: ${counts}`);
      process.exit(0);
    })
    .catch((e) => {
      // We should never get here — orchestrator wraps everything — but if we
      // do, still exit 0 with an empty file rather than failing CI.
      console.error(`[mine-topic] unexpected error: ${e.message ?? e}`);
      try {
        writeJsonAtomic(OUTPUT_PATH, {
          generatedAt: new Date().toISOString(),
          sources: {},
          candidates: [],
        });
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
}
