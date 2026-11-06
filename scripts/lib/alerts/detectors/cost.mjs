// scripts/lib/alerts/detectors/cost.mjs
//
// Category D — cost detectors. Heuristic checks that surface API quota
// exhaustion and cost spikes early. D.3/D.4 are deferred-friendly: if the
// underlying telemetry is missing they no-op silently.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 8

const DAY_MS = 24 * 3600 * 1000;

/**
 * @param {{
 *   evidence: object,
 *   embeddingsMeta: object|null,
 *   alertHistory: Array,
 *   recentLogs: string[],
 *   config: object,
 *   now?: number,
 * }} input
 */
export function detectCost({
  evidence = {},
  embeddingsMeta = null,
  alertHistory = [],
  recentLogs = [],
  config = {},
  now = Date.now(),
}) {
  const alerts = [];

  // D.1 GSC API quota — heuristic: query count suspiciously low vs historical.
  const queries = evidence?.gsc?.queries;
  if (queries && typeof queries === 'object') {
    const queryCount = Object.keys(queries).length;
    if (queryCount > 0 && queryCount < 100) {
      alerts.push({
        id: 'D.1.gsc-quota-suspect',
        severity: 'P1',
        message: `GSC returned only ${queryCount} queries (historical ≥500). Quota exhaustion suspected.`,
        mitigation: 'Check Google Cloud quota for Search Console API; rerun evidence build',
        evidence: { queryCount },
      });
    }
  }

  // D.2 OpenAI embedding cost spike — single-day refresh of 5x normal article count.
  if (embeddingsMeta && embeddingsMeta.builtAt && Number.isFinite(embeddingsMeta.count)) {
    const ts = Date.parse(embeddingsMeta.builtAt);
    if (!Number.isNaN(ts) && now - ts < DAY_MS) {
      const refreshedCount = Number(embeddingsMeta.refreshedCount ?? embeddingsMeta.lastRunCount ?? 0);
      const normalDailyRefresh = 5;
      if (refreshedCount > normalDailyRefresh * 5) {
        const estCost = refreshedCount * 0.0001;
        if (estCost > config.cost_embedding_daily_max_usd) {
          alerts.push({
            id: 'D.2.embedding-cost-spike',
            severity: 'P0',
            message: `Embedding refresh of ${refreshedCount} articles in 24h (~$${estCost.toFixed(2)}) exceeds daily cap $${config.cost_embedding_daily_max_usd}`,
            mitigation: 'Inspect build-article-embeddings logs; consider stalling full-rebuild trigger',
            evidence: { refreshedCount, estCost, cap: config.cost_embedding_daily_max_usd },
          });
        }
      }
    }
  }

  // D.3 LLM fact-check retry burst — read history if telemetry is present.
  let totalRetries = 0;
  for (const entry of alertHistory) {
    if (!entry || !entry.timestamp) continue;
    if (now - Date.parse(entry.timestamp) > DAY_MS) continue;
    if (Number.isFinite(entry.factcheckRetries)) totalRetries += entry.factcheckRetries;
  }
  if (totalRetries > config.cost_factcheck_retry_max) {
    alerts.push({
      id: 'D.3.factcheck-retry-burst',
      severity: 'P1',
      message: `Fact-check retries in last 24h (${totalRetries}) exceed cap ${config.cost_factcheck_retry_max}`,
      mitigation: 'Inspect fact-check pipeline; widen consensus tolerance only after RCA',
      evidence: { totalRetries, cap: config.cost_factcheck_retry_max },
    });
  }

  // D.4 OpenRouter free-model exhaustion.
  const exhaustedHit = recentLogs.some((line) => typeof line === 'string' && /all free models exhausted/i.test(line));
  if (exhaustedHit) {
    alerts.push({
      id: 'D.4.openrouter-free-exhausted',
      severity: 'P2',
      message: 'OpenRouter free-model pool exhausted in recent create-article runs',
      mitigation: 'Verify OPENROUTER_API_KEY rotation; consider falling back to direct provider',
      evidence: {},
    });
  }

  return alerts;
}
