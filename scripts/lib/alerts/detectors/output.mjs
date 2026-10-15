// scripts/lib/alerts/detectors/output.mjs
//
// Category C — output-quality detectors. Reads quota-state.history (Phase 4
// auto-tune entries with provenWinRate/discoveryWinRate), the article
// sidecars, and GA4 / PostHog evidence to detect win-rate, engagement, and
// conversion regressions. Emits C.1-C.5.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 8

const DAY_MS = 24 * 3600 * 1000;

function withinLastDays(publishedAt, days, now) {
  if (!publishedAt) return false;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return false;
  return now - ts <= days * DAY_MS;
}

function inWindow(publishedAt, fromDays, toDays, now) {
  if (!publishedAt) return false;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return false;
  const ageDays = (now - ts) / DAY_MS;
  return ageDays >= fromDays && ageDays < toDays;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * @param {{
 *   articles: Array,
 *   evidence: object,
 *   quotaState: object,
 *   config: object,
 *   now?: number,
 * }} input
 */
export function detectOutput({ articles = [], evidence = {}, quotaState = {}, config = {}, now = Date.now() }) {
  const alerts = [];
  const history = Array.isArray(quotaState?.history) ? quotaState.history : [];
  const last7 = history
    .filter((h) => h && (h.timestamp || h.at))
    .slice(-7);

  // C.1 Win-rate collapse — any of last 7 history entries has provenWinRate < threshold.
  const collapsed = last7.find((h) => Number.isFinite(h.provenWinRate) && h.provenWinRate < config.winrate_collapse_threshold);
  if (collapsed) {
    alerts.push({
      id: 'C.1.winrate-collapse',
      severity: 'P0',
      message: `Proven-pool win-rate dropped to ${(collapsed.provenWinRate * 100).toFixed(1)}% (< ${(config.winrate_collapse_threshold * 100).toFixed(0)}%)`,
      mitigation: 'Inspect tune-discovery-quota logs; investigate scorer regression in last 14d',
      evidence: { provenWinRate: collapsed.provenWinRate, at: collapsed.timestamp || collapsed.at },
    });
  }

  // C.2 Both pools failing — any of last 7 entries has both rates < 0.15.
  const bothFailing = last7.find((h) => Number.isFinite(h.provenWinRate) && Number.isFinite(h.discoveryWinRate) && h.provenWinRate < 0.15 && h.discoveryWinRate < 0.15);
  if (bothFailing) {
    alerts.push({
      id: 'C.2.both-pools-failing',
      severity: 'P0',
      message: `Both pools' win-rate < 15% (proven=${(bothFailing.provenWinRate * 100).toFixed(1)}%, discovery=${(bothFailing.discoveryWinRate * 100).toFixed(1)}%)`,
      mitigation: 'Pause article generation; run /investigate on cluster-stats and scorer pipeline',
      evidence: { proven: bothFailing.provenWinRate, discovery: bothFailing.discoveryWinRate, at: bothFailing.timestamp || bothFailing.at },
    });
  }

  // C.3 Cluster collapse — per-cluster win-rate over last 7d articles drops >50% vs prior 30d.
  const ga4Pages = evidence?.ga4?.pages || {};
  const clusterStats = evidence?.clusterStats || {};
  const recent = articles.filter((a) => withinLastDays(a.publishedAt, 7, now));
  const prior = articles.filter((a) => inWindow(a.publishedAt, 7, 37, now));
  const clusterRate = (group) => {
    const byCluster = new Map();
    for (const a of group) {
      if (!a.slug) continue;
      const cluster = a.cluster || 'generic';
      const path = `/articoli-frontaliere/${a.slug}/`;
      const sessions = ga4Pages[path]?.sessions ?? ga4Pages[`/articoli-frontaliere/${a.slug}`]?.sessions;
      const p50 = clusterStats[cluster]?.p50;
      if (!Number.isFinite(sessions) || !Number.isFinite(p50) || p50 <= 0) continue;
      if (!byCluster.has(cluster)) byCluster.set(cluster, { wins: 0, total: 0 });
      const bucket = byCluster.get(cluster);
      bucket.total += 1;
      if (sessions > p50) bucket.wins += 1;
    }
    const out = {};
    for (const [k, v] of byCluster) out[k] = v.total > 0 ? v.wins / v.total : 0;
    return out;
  };
  const recentRates = clusterRate(recent);
  const priorRates = clusterRate(prior);
  for (const cluster of Object.keys(priorRates)) {
    if (!(cluster in recentRates)) continue;
    if (priorRates[cluster] <= 0) continue;
    const drop = (priorRates[cluster] - recentRates[cluster]) / priorRates[cluster];
    if (drop > 0.5) {
      alerts.push({
        id: `C.3.cluster-collapse:${cluster}`,
        severity: 'P1',
        message: `Cluster '${cluster}' win-rate dropped ${(drop * 100).toFixed(0)}% (recent=${(recentRates[cluster] * 100).toFixed(0)}% vs prior=${(priorRates[cluster] * 100).toFixed(0)}%)`,
        mitigation: 'Audit recent picks in this cluster; verify scorer + cluster-stats freshness',
        evidence: { cluster, recent: recentRates[cluster], prior: priorRates[cluster], drop },
      });
    }
  }

  // C.4 Engagement dive — median engageTime drops >X% vs articles 14-44d ago.
  const recent14 = articles.filter((a) => withinLastDays(a.publishedAt, 14, now));
  const prior30 = articles.filter((a) => inWindow(a.publishedAt, 14, 44, now));
  const engageOf = (group) => group
    .map((a) => ga4Pages[`/articoli-frontaliere/${a.slug}/`]?.engageTime ?? ga4Pages[`/articoli-frontaliere/${a.slug}`]?.engageTime)
    .filter((v) => Number.isFinite(v) && v > 0);
  const recentEngage = engageOf(recent14);
  const priorEngage = engageOf(prior30);
  if (recentEngage.length >= 3 && priorEngage.length >= 3) {
    const recentMed = median(recentEngage);
    const priorMed = median(priorEngage);
    if (priorMed > 0) {
      const drop = (priorMed - recentMed) / priorMed;
      if (drop > config.engagement_dive_threshold) {
        alerts.push({
          id: 'C.4.engagement-dive',
          severity: 'P1',
          message: `Median engageTime dropped ${(drop * 100).toFixed(0)}% (recent=${recentMed.toFixed(1)}s vs prior=${priorMed.toFixed(1)}s)`,
          mitigation: 'Inspect content quality on last 14d; possible thin-content regression',
          evidence: { recentMed, priorMed, drop, recentN: recentEngage.length, priorN: priorEngage.length },
        });
      }
    }
  }

  // C.5 Newsletter conversion dive — posthog signups/sessions across last 14d publishes drops >50%.
  const phPages = evidence?.posthog?.pages || {};
  const conversionOf = (group) => {
    let signups = 0;
    let sessions = 0;
    for (const a of group) {
      const p1 = `/articoli-frontaliere/${a.slug}/`;
      const p2 = `/articoli-frontaliere/${a.slug}`;
      const ph = phPages[p1] || phPages[p2];
      const ga = ga4Pages[p1] || ga4Pages[p2];
      if (ph && Number.isFinite(ph.newsletterSignups)) signups += ph.newsletterSignups;
      if (ga && Number.isFinite(ga.sessions)) sessions += ga.sessions;
    }
    return sessions > 0 ? signups / sessions : null;
  };
  const recentRate = conversionOf(recent14);
  const priorRate = conversionOf(prior30);
  if (Number.isFinite(recentRate) && Number.isFinite(priorRate) && priorRate > 0) {
    const drop = (priorRate - recentRate) / priorRate;
    if (drop > 0.5) {
      alerts.push({
        id: 'C.5.newsletter-conversion-dive',
        severity: 'P2',
        message: `Newsletter conversion dropped ${(drop * 100).toFixed(0)}% (recent=${(recentRate * 100).toFixed(2)}% vs prior=${(priorRate * 100).toFixed(2)}%)`,
        mitigation: 'Inspect newsletter CTA rendering on recent articles; verify PostHog event firing',
        evidence: { recentRate, priorRate, drop },
      });
    }
  }

  return alerts;
}
