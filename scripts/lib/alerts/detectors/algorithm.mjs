// scripts/lib/alerts/detectors/algorithm.mjs
//
// Category A — algorithm health detectors. Reads the most-recent published
// articles' sidecar metadata (`_pool`, `_pool_source`, `cluster`,
// `_score_breakdown`) and the quota-state history. Emits A.1-A.5.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 8

const DAY_MS = 24 * 3600 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

function withinLastDays(publishedAt, days, now) {
  if (!publishedAt) return false;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return false;
  return now - ts <= days * DAY_MS;
}

/**
 * @param {{ articles: Array, evidence: object, quotaState: object, config: object, now?: number }} input
 * @returns {Array<{id, severity, message, mitigation, evidence}>}
 */
export function detectAlgorithm({ articles = [], evidence = {}, quotaState = {}, config = {}, now = Date.now() }) {
  const alerts = [];
  const recent = articles.filter((a) => withinLastDays(a.publishedAt, 7, now));

  // A.1 Cluster monoculture — >X% of last 7d articles in one cluster.
  if (recent.length >= 5) {
    const counts = new Map();
    for (const a of recent) {
      const key = a.cluster || 'generic';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let topCluster = null;
    let topCount = 0;
    for (const [k, n] of counts) {
      if (n > topCount) { topCluster = k; topCount = n; }
    }
    const ratio = topCount / recent.length;
    if (ratio > config.monoculture_threshold) {
      alerts.push({
        id: 'A.1.cluster-monoculture',
        severity: 'P1',
        message: `Cluster '${topCluster}' represents ${(ratio * 100).toFixed(0)}% of last 7d articles (${topCount}/${recent.length}); threshold ${(config.monoculture_threshold * 100).toFixed(0)}%`,
        mitigation: 'Verify discovery pool emits diverse candidates; check cluster diversity malus in scorer',
        evidence: { topCluster, topCount, total: recent.length, ratio },
      });
    }
  }

  // A.2 Pool starvation — last 3 picks all evergreen-fallback.
  const last3 = articles.slice().sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0)).slice(0, 3);
  if (last3.length === 3 && last3.every((a) => a._pool === 'evergreen-fallback')) {
    alerts.push({
      id: 'A.2.pool-starvation',
      severity: 'P1',
      message: 'Last 3 published articles all fell back to evergreen — both proven and discovery pools are empty',
      mitigation: 'Check news-crawler workflows + GSC orphan-query availability; investigate fetch failures',
      evidence: { lastThreePools: last3.map((a) => a._pool) },
    });
  }

  // A.3 All-low-score — top-1 finalScore < clusterStats.global_p10 for ≥N consecutive runs.
  const consecutive = config.all_low_score_consecutive || 5;
  const lastN = articles.slice().sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0)).slice(0, consecutive);
  const globalP10 = evidence?.clusterStats?.generic?.p10 ?? evidence?.clusterStats?.global?.p10;
  if (lastN.length === consecutive && Number.isFinite(globalP10) && globalP10 > 0) {
    const allLow = lastN.every((a) => {
      const score = a?._score_breakdown?.finalScore;
      return Number.isFinite(score) && score < globalP10;
    });
    if (allLow) {
      alerts.push({
        id: 'A.3.all-low-score',
        severity: 'P1',
        message: `Last ${consecutive} picks all scored below cluster-stats global p10 (${globalP10})`,
        mitigation: 'Inspect candidate sources — scorer may be choosing weak picks because pools are starved',
        evidence: { globalP10, scores: lastN.map((a) => a?._score_breakdown?.finalScore) },
      });
    }
  }

  // A.4 Quota oscillation — |quota[t] - quota[t-7]| > X.
  const history = Array.isArray(quotaState?.history) ? quotaState.history : [];
  if (history.length >= 2) {
    const sorted = history
      .filter((h) => h && (h.timestamp || h.at))
      .map((h) => ({ ts: Date.parse(h.timestamp || h.at), quota: Number(h.newQuota ?? h.quota) }))
      .filter((h) => !Number.isNaN(h.ts) && Number.isFinite(h.quota))
      .sort((a, b) => b.ts - a.ts);
    if (sorted.length >= 2) {
      const newest = sorted[0];
      const oldEnough = sorted.find((h) => newest.ts - h.ts >= SEVEN_DAYS_MS) || sorted[sorted.length - 1];
      const delta = Math.abs(newest.quota - oldEnough.quota);
      if (delta > config.quota_oscillation_threshold) {
        alerts.push({
          id: 'A.4.quota-oscillation',
          severity: 'P1',
          message: `Quota oscillated by ${delta} points over the last 7d (now ${newest.quota}, was ${oldEnough.quota})`,
          mitigation: 'Inspect tune logs; consider widening sample-size threshold or smoothing the tune step',
          evidence: { newest: newest.quota, prior: oldEnough.quota, delta },
        });
      }
    }
  }

  // A.5 Confidence-stage collapse — >80% recent picks scored via 'cluster' fallback.
  if (recent.length >= 5) {
    const clusterStage = recent.filter((a) => a?._score_breakdown?.stage === 'cluster').length;
    const ratio = clusterStage / recent.length;
    if (ratio > 0.8) {
      alerts.push({
        id: 'A.5.confidence-stage-collapse',
        severity: 'P1',
        message: `${(ratio * 100).toFixed(0)}% of last 7d picks scored via cluster fallback (stage=cluster); GSC + embedding stages dry`,
        mitigation: 'Check GSC fetch success + embedding-store freshness; cluster fallback is the weakest signal',
        evidence: { clusterStage, total: recent.length, ratio },
      });
    }
  }

  return alerts;
}
