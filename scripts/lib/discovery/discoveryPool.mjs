// scripts/lib/discovery/discoveryPool.mjs
//
// Orchestrates the discovery sources (orphan + suggest + news + trends),
// applies cross-pool deduplication against the proven pool's headlines,
// and returns the merged candidate list with discovery scores attached.
//
// Per-source kill switches honored (spec § 13.2 rollback levers):
//   DISABLE_DISCOVERY_ORPHAN=1
//   DISABLE_DISCOVERY_SUGGEST=1
//   DISABLE_DISCOVERY_NEWS=1
//   DISABLE_DISCOVERY_TRENDS=1
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.3-6.5

import { fetchOrphanCandidates } from './sources/orphanQuerySource.mjs';
import { fetchSuggestDiscoveryCandidates } from './sources/googleSuggestSource.mjs';
import {
  fetchNewsRssDiscoveryCandidates,
  NEWS_RSS_MAX_SEED_DURATION_MS,
} from './sources/googleNewsRssSource.mjs';
import { fetchTrendsDiscoveryCandidates } from './sources/googleTrendsSource.mjs';
import { discoveryScore } from './discoveryScore.mjs';
import { isNearDuplicate, SLUG_SIMILARITY_THRESHOLD } from '../scheduler/slugSimilarity.mjs';

const ENV_TRUE = (val) => val === '1' || val === 'true';
const MAX_TREND_EVIDENCE_SEEDS = 3;
const MAX_TREND_EVIDENCE_ARTICLES_PER_SEED = 2;
const MAX_TREND_EVIDENCE_AGE_HOURS = 14 * 24;
const MIN_TREND_EVIDENCE_WINDOW_MS = MAX_TREND_EVIDENCE_SEEDS * NEWS_RSS_MAX_SEED_DURATION_MS;

function normalizeDeadlineMs(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeReserveMs(value) {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function effectiveNewsDeadlineMs(opts) {
  const deadlineMs = normalizeDeadlineMs(opts.deadlineMs);
  if (deadlineMs === null) return null;
  return Math.max(0, deadlineMs - normalizeReserveMs(opts.deadlineReserveMs));
}

function hasDeadlineWindow(deadlineMs, minimumMs = 0) {
  return deadlineMs === null || deadlineMs - Date.now() >= minimumMs;
}

function isOrphanDisabled() {
  return ENV_TRUE(process.env.DISABLE_DISCOVERY_ORPHAN);
}
function isSuggestDisabled() {
  return ENV_TRUE(process.env.DISABLE_DISCOVERY_SUGGEST);
}
function isNewsDisabled() {
  return ENV_TRUE(process.env.DISABLE_DISCOVERY_NEWS);
}
function isTrendsDisabled() {
  return ENV_TRUE(process.env.DISABLE_DISCOVERY_TRENDS);
}

function evidenceAgeHours(pubDate, nowMs) {
  if (typeof pubDate !== 'string' || !pubDate.trim()) return null;
  const publishedAtMs = Date.parse(pubDate);
  if (!Number.isFinite(publishedAtMs)) return null;
  const ageHours = (nowMs - publishedAtMs) / (60 * 60 * 1000);
  if (ageHours > MAX_TREND_EVIDENCE_AGE_HOURS) return null;
  if (ageHours < 0) return null;
  return Math.max(0, ageHours);
}

function isSecureHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function buildTrendEvidenceCandidates(trendSignals, newsEvidence, nowMs) {
  if (!Array.isArray(trendSignals) || !Array.isArray(newsEvidence)) return [];

  const newsBySeed = new Map();
  for (const item of newsEvidence) {
    const seed = String(item?.meta?.seed || '').trim();
    if (!seed || !isSecureHttpUrl(item?.url)) continue;
    const ageHours = evidenceAgeHours(item?.meta?.pubDate, nowMs);
    if (ageHours === null) continue;
    if (!newsBySeed.has(seed)) newsBySeed.set(seed, []);
    newsBySeed.get(seed).push({ item, ageHours });
  }
  for (const matches of newsBySeed.values()) {
    matches.sort((a, b) => a.ageHours - b.ageHours);
  }

  const out = [];
  const seenUrls = new Set();
  const seenHeadlines = new Set();
  for (const signal of trendSignals) {
    const signalHeadline = String(signal?.headline || '').trim();
    if (!signalHeadline) continue;
    const matches = newsBySeed.get(signalHeadline) || [];
    let keptForSignal = 0;
    for (const { item, ageHours } of matches) {
      const evidenceHeadline = String(item?.headline || '').trim();
      if (!evidenceHeadline) continue;
      const headlineKey = evidenceHeadline.toLowerCase().replace(/\s+/g, ' ');
      if (seenUrls.has(item.url) || seenHeadlines.has(headlineKey)) continue;
      seenUrls.add(item.url);
      seenHeadlines.add(headlineKey);
      keptForSignal += 1;
      out.push({
        headline: evidenceHeadline,
        url: item.url,
        source: 'trends',
        meta: {
          ...signal.meta,
          signalHeadline,
          signalProvider: 'google-trends',
          signalCollectedAt: new Date(nowMs).toISOString(),
          evidenceProvider: 'google-news-rss',
          evidenceUrl: item.url,
          evidenceHeadline,
          evidencePublisher: item.meta?.publisherHost || item.meta?.sourceName || null,
          evidencePublishedAt: item.meta?.pubDate || null,
          evidenceAgeHours: ageHours,
        },
      });
      if (keptForSignal >= MAX_TREND_EVIDENCE_ARTICLES_PER_SEED) break;
    }
  }
  return out;
}

/**
 * @typedef {{
 *   headline: string,
 *   url: string|null,
 *   source: 'orphan'|'suggest'|'news'|'trends',
 *   meta: object,
 * }} DiscoveryCandidate
 *
 * @typedef {DiscoveryCandidate & {
 *   _scoreBreakdown: object,
 *   _discoveryScore: number,
 * }} ScoredDiscoveryCandidate
 */

/**
 * Fetch discovery candidates from all enabled sources. Per-source
 * failures are logged but never fatal — the pool returns whatever the
 * other sources produced.
 *
 * @param {object} evidence
 * @param {{
 *   fetchImpl?: Function,
 *   orphanFn?: Function,
 *   suggestFn?: Function,
 *   newsFn?: Function,
 *   trendsFn?: Function,
 *   nowMs?: number,
 *   deadlineMs?: number,
 *   deadlineReserveMs?: number,
 * }} [opts]
 * @returns {Promise<{ candidates: DiscoveryCandidate[], perSource: Record<string, number> }>}
 */
export async function fetchAll(evidence, opts = {}) {
  const orphanFn = opts.orphanFn || fetchOrphanCandidates;
  const suggestFn = opts.suggestFn || fetchSuggestDiscoveryCandidates;
  const newsFn = opts.newsFn || fetchNewsRssDiscoveryCandidates;
  const trendsFn = opts.trendsFn || fetchTrendsDiscoveryCandidates;
  const newsDeadlineMs = effectiveNewsDeadlineMs(opts);
  const perSource = { orphan: 0, suggest: 0, news: 0, trends: 0, trendSignals: 0 };
  const merged = [];

  // Orphan — synchronous (reads from evidence in-memory).
  if (!isOrphanDisabled()) {
    try {
      const orphans = orphanFn(evidence) || [];
      perSource.orphan = orphans.length;
      for (const c of orphans) merged.push(c);
    } catch (err) {
      console.warn(`[discovery] orphan source failed: ${err?.message || err}`);
    }
  }

  // Remote sources — fetch in parallel; each source already swallows errors.
  // A caller with a run-wide deadline gets the effective deadline on the RSS
  // source. Other callers retain the historical unbounded behavior.
  const remoteJobs = [];
  if (hasDeadlineWindow(newsDeadlineMs) && !isSuggestDisabled()) {
    remoteJobs.push(
      suggestFn(evidence, { fetchImpl: opts.fetchImpl })
        .then((arr) => ({ kind: 'suggest', arr: Array.isArray(arr) ? arr : [] }))
        .catch((err) => {
          console.warn(`[discovery] suggest source failed: ${err?.message || err}`);
          return { kind: 'suggest', arr: [] };
        }),
    );
  }
  if (hasDeadlineWindow(newsDeadlineMs) && !isNewsDisabled()) {
    const newsOptions = { fetchImpl: opts.fetchImpl };
    if (newsDeadlineMs !== null) newsOptions.deadlineMs = newsDeadlineMs;
    remoteJobs.push(
      newsFn(evidence, newsOptions)
        .then((arr) => ({ kind: 'news', arr: Array.isArray(arr) ? arr : [] }))
        .catch((err) => {
          console.warn(`[discovery] news source failed: ${err?.message || err}`);
          return { kind: 'news', arr: [] };
        }),
    );
  }
  if (hasDeadlineWindow(newsDeadlineMs) && !isTrendsDisabled()) {
    remoteJobs.push(
      trendsFn(evidence, { fetchImpl: opts.fetchImpl })
        .then((arr) => ({ kind: 'trends', arr: Array.isArray(arr) ? arr : [] }))
        .catch((err) => {
          console.warn(`[discovery] trends source failed: ${err?.message || err}`);
          return { kind: 'trends', arr: [] };
        }),
    );
  }

  const remoteResults = await Promise.all(remoteJobs);
  const byKind = new Map();
  for (const r of remoteResults) {
    byKind.set(r.kind, r.arr);
  }

  const suggestions = byKind.get('suggest') || [];
  const news = byKind.get('news') || [];
  const trendSignals = byKind.get('trends') || [];
  perSource.suggest = suggestions.length;
  perSource.trendSignals = trendSignals.length;

  // Trends supplies demand signals, not article evidence. Search Google News
  // for the top three distinct trend queries and admit up to two matching
  // articles per query (at most six candidates) when recent Google News
  // results provide HTTPS URLs. This keeps bare queries from becoming
  // synthetic discovery:// URLs in create-article.
  let trendBackedCandidates = [];
  if (
    !isNewsDisabled()
    && !isTrendsDisabled()
    && trendSignals.length > 0
    && hasDeadlineWindow(newsDeadlineMs, MIN_TREND_EVIDENCE_WINDOW_MS)
  ) {
    const seenSignalHeadlines = new Set();
    const topTrendSignals = trendSignals
      .slice()
      .sort((a, b) => (Number(b?.meta?.score) || 0) - (Number(a?.meta?.score) || 0))
      .filter((candidate) => {
        const key = String(candidate?.headline || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!key || seenSignalHeadlines.has(key)) return false;
        seenSignalHeadlines.add(key);
        return true;
      })
      .slice(0, MAX_TREND_EVIDENCE_SEEDS);
    try {
      const seeds = topTrendSignals.map((candidate) => candidate.headline);
      const result = await newsFn(evidence, {
        fetchImpl: opts.fetchImpl,
        seeds,
        nowMs: opts.nowMs,
        ...(newsDeadlineMs !== null ? { deadlineMs: newsDeadlineMs } : {}),
      });
      const newsEvidence = Array.isArray(result) ? result : [];
      trendBackedCandidates = buildTrendEvidenceCandidates(
        topTrendSignals,
        newsEvidence,
        Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now(),
      );
    } catch (err) {
      console.warn(`[discovery/trends] evidence search failed: ${err?.message || err}`);
    }
  } else if (
    !isNewsDisabled()
    && !isTrendsDisabled()
    && trendSignals.length > 0
    && newsDeadlineMs !== null
  ) {
    console.error('[discovery/trends] evidence search skipped: insufficient deadline window');
  }

  // When the same Google News item appears in both the regular news pool and
  // the trend-seeded search, retain the trend-backed row so the article keeps
  // its originating signal in the report and sidecar.
  const trendUrls = new Set(trendBackedCandidates.map((candidate) => candidate.url));
  const uniqueNews = news.filter((candidate) => !trendUrls.has(candidate?.url));
  perSource.news = uniqueNews.length;
  perSource.trends = trendBackedCandidates.length;

  for (const candidate of suggestions) merged.push(candidate);
  for (const candidate of uniqueNews) merged.push(candidate);
  for (const candidate of trendBackedCandidates) merged.push(candidate);

  return { candidates: merged, perSource };
}

/**
 * Drop candidates whose headline is similar (Jaccard >= threshold) to
 * any string in `provenHeadlines`. Logs the count of dropped entries.
 *
 * @param {DiscoveryCandidate[]} candidates
 * @param {string[]} provenHeadlines
 * @param {number} [threshold]
 * @returns {DiscoveryCandidate[]}
 */
export function dedupAgainstProven(candidates, provenHeadlines, threshold = SLUG_SIMILARITY_THRESHOLD) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (!Array.isArray(provenHeadlines) || provenHeadlines.length === 0) return candidates.slice();
  const kept = [];
  let dropped = 0;
  for (const c of candidates) {
    if (isNearDuplicate(c.headline, provenHeadlines, threshold)) {
      dropped += 1;
      continue;
    }
    kept.push(c);
  }
  if (dropped > 0) {
    console.error(`DISCOVERY_CROSS_POOL_DEDUP dropped=${dropped} kept=${kept.length} threshold=${threshold}`);
  }
  return kept;
}

/**
 * Attach a discovery-score breakdown to every candidate. Sorted by
 * `_discoveryScore` desc.
 *
 * @param {DiscoveryCandidate[]} candidates
 * @param {object} evidence
 * @returns {ScoredDiscoveryCandidate[]}
 */
export function scoreCandidates(candidates, evidence) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const scored = [];
  for (const c of candidates) {
    let breakdown;
    try {
      breakdown = discoveryScore(c, evidence);
    } catch (err) {
      console.warn(`[discovery] scoring failed for "${String(c.headline).slice(0, 60)}": ${err?.message || err}`);
      continue;
    }
    scored.push({
      ...c,
      _scoreBreakdown: breakdown,
      _discoveryScore: Number(breakdown.finalScore) || 0,
    });
  }
  scored.sort((a, b) => b._discoveryScore - a._discoveryScore);
  return scored;
}

/**
 * One-shot convenience: fetch + dedup + score. Returns the sorted list.
 *
 * @param {object} evidence
 * @param {{ provenHeadlines?: string[], fetchImpl?: Function, orphanFn?: Function, suggestFn?: Function, newsFn?: Function, trendsFn?: Function, dedupThreshold?: number, nowMs?: number, deadlineMs?: number, deadlineReserveMs?: number }} [opts]
 * @returns {Promise<{ candidates: ScoredDiscoveryCandidate[], perSource: Record<string, number>, postDedupCount: number }>}
 */
export async function buildDiscoveryPool(evidence, opts = {}) {
  const { candidates, perSource } = await fetchAll(evidence, opts);
  const proven = Array.isArray(opts.provenHeadlines) ? opts.provenHeadlines : [];
  const deduped = dedupAgainstProven(candidates, proven, opts.dedupThreshold);
  const scored = scoreCandidates(deduped, evidence);
  return { candidates: scored, perSource, postDedupCount: deduped.length };
}

export default buildDiscoveryPool;
