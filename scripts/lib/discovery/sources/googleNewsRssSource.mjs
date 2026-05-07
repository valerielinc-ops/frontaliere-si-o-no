// scripts/lib/discovery/sources/googleNewsRssSource.mjs
//
// Discovery source: Google News RSS. Wraps the existing fetcher in
// scripts/lib/topic-sources/googleNewsRss.mjs (which already applies
// NOISE_TITLE_RE / NOISE_SOURCE_RE filters and a relevance regex).
//
// For each item we attach `meta.ageHours` (hours since pubDate) so the
// downstream `discoveryScore` can apply its freshness boost.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.3.3

import { fetchNewsRssCandidates } from '../../topic-sources/googleNewsRss.mjs';

const SOURCE_TAG = 'news';
const FALLBACK_AGE_HOURS = 48;

/**
 * @typedef {{
 *   headline: string,
 *   url: string|null,
 *   source: 'news',
 *   meta: { ageHours: number, sourceUrl: string|null, sourceName: string|null, pubDate: string|null, seed: string|null },
 * }} NewsCandidate
 */

/**
 * Compute hours between `pubDate` and `now`. Returns FALLBACK_AGE_HOURS
 * when the date is missing or unparseable.
 *
 * @param {string|null} pubDate
 * @param {number} [nowMs]
 * @returns {number}
 */
export function ageHoursFromPubDate(pubDate, nowMs = Date.now()) {
  if (!pubDate || typeof pubDate !== 'string') return FALLBACK_AGE_HOURS;
  const parsed = Date.parse(pubDate);
  if (!Number.isFinite(parsed)) return FALLBACK_AGE_HOURS;
  const diffMs = nowMs - parsed;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return diffMs / (60 * 60 * 1000);
}

/**
 * Fetch Google News RSS discovery candidates. Returns [] on fetcher
 * failure — never throws.
 *
 * @param {object} evidence
 * @param {{ fetchImpl?: Function, newsFn?: Function, seeds?: string[], nowMs?: number }} [opts]
 * @returns {Promise<NewsCandidate[]>}
 */
export async function fetchNewsRssDiscoveryCandidates(evidence, opts = {}) {
  const newsFn = opts.newsFn || fetchNewsRssCandidates;
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();

  let result;
  try {
    result = await newsFn({
      seeds: Array.isArray(opts.seeds) && opts.seeds.length > 0 ? opts.seeds : undefined,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    console.warn(`[discovery/news] fetcher threw: ${err?.message || err}`);
    return [];
  }
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const headline = String(c?.keyword || '').trim();
    if (!headline) continue;
    const lower = headline.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const pubDate = c?.demandSignals?.googleNewsRssPubDate || null;
    out.push({
      headline,
      url: c?.demandSignals?.googleNewsRssLink || null,
      source: SOURCE_TAG,
      meta: {
        ageHours: ageHoursFromPubDate(pubDate, nowMs),
        sourceUrl: c?.demandSignals?.googleNewsRssLink || null,
        sourceName: c?.demandSignals?.googleNewsRssSource || null,
        pubDate,
        seed: c?.demandSignals?.googleNewsRssSeed || null,
      },
    });
  }
  return out;
}

export default fetchNewsRssDiscoveryCandidates;
