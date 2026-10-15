// scripts/lib/discovery/sources/googleTrendsSource.mjs
//
// Discovery source: Google Trends RSS / rising queries. This wraps the
// existing topic-source fetcher and keeps only frontaliere/Ticino-anchored
// trends so the ranker sees demand that is both fresh and articleable.

import { fetchGoogleTrendsCandidates } from '../../topic-sources/googleTrends.mjs';
import { hasDomainAnchor } from '../domainAnchor.mjs';

const SOURCE_TAG = 'trends';

function buildProvenSet(gscBlock) {
  const set = new Set();
  if (gscBlock && gscBlock.queries && typeof gscBlock.queries === 'object') {
    for (const key of Object.keys(gscBlock.queries)) {
      if (typeof key === 'string' && key.trim()) set.add(key.trim().toLowerCase());
    }
  }
  return set;
}

function trendScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Trends RSS approx_traffic is unbounded ("200+", "2000+"). Compress it
  // so it boosts fresh demand without drowning GSC orphan evidence.
  return Math.min(100, Math.log10(n + 1) * 25);
}

/**
 * @param {object} evidence
 * @param {{ trendsFn?: Function, fetchImpl?: Function }} [opts]
 * @returns {Promise<Array<{headline:string,url:null,source:'trends',meta:object}>>}
 */
export async function fetchTrendsDiscoveryCandidates(evidence, opts = {}) {
  const trendsFn = opts.trendsFn || fetchGoogleTrendsCandidates;
  const provenSet = buildProvenSet(evidence?.gsc);

  let result;
  try {
    result = await trendsFn({
      fetchImpl: opts.fetchImpl,
      winnerFingerprint: evidence?.winnerFingerprint || null,
    });
  } catch (err) {
    console.warn(`[discovery/trends] fetcher threw: ${err?.message || err}`);
    return [];
  }

  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const headline = String(c?.keyword || '').trim();
    if (!headline) continue;
    const lower = headline.toLowerCase();
    if (seen.has(lower) || provenSet.has(lower)) continue;
    if (!hasDomainAnchor(headline)) continue;
    seen.add(lower);
    out.push({
      headline,
      url: null,
      source: SOURCE_TAG,
      meta: {
        score: trendScore(c?.demandSignals?.googleTrendsScore),
        rawScore: Number(c?.demandSignals?.googleTrendsScore) || null,
        geo: c?.demandSignals?.googleTrendsGeo || null,
        seed: c?.demandSignals?.googleTrendsSeed || null,
        viaRss: Boolean(c?.demandSignals?.googleTrendsViaRss),
      },
    });
  }
  return out;
}

export default fetchTrendsDiscoveryCandidates;
