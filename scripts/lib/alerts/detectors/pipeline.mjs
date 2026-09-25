// scripts/lib/alerts/detectors/pipeline.mjs
//
// Category B — data-pipeline detectors. Validates evidence freshness,
// fetcher health, cluster-stats sample sizes, and embedding store
// coverage. Emits B.1-B.6.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 8

import { existsSync, statSync } from 'node:fs';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

function withinLastDays(publishedAt, days, now) {
  if (!publishedAt) return false;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return false;
  return now - ts <= days * DAY_MS;
}

/**
 * @param {object} [input]
 * @param {object} [input.evidence]
 * @param {Array}  [input.articles]
 * @param {string} [input.evidenceIndexPath]
 * @param {object} [input.config]
 * @param {number} [input.now]
 * @param {(path: string) => (number|null)} [input.readMtime]
 * @param {() => (number|null)} [input.countBlogArticles]
 * @param {() => (number|null)} [input.embeddingsCount]
 * @returns {Array<{id:string, severity:string, message:string, mitigation:string, evidence:object}>}
 */
export function detectPipeline(input = {}) {
  const {
    evidence = {},
    articles = [],
    evidenceIndexPath = 'data/evidence-index.json',
    config = {},
    now = Date.now(),
    readMtime,
    countBlogArticles,
    embeddingsCount,
  } = input;
  const alerts = [];

  // B.1 Evidence-index stale.
  const mtime = typeof readMtime === 'function'
    ? readMtime(evidenceIndexPath)
    : (existsSync(evidenceIndexPath) ? statSync(evidenceIndexPath).mtimeMs : null);
  const maxStaleMs = (config.evidence_stale_max_hours || 36) * HOUR_MS;
  if (mtime == null) {
    alerts.push({
      id: 'B.1.evidence-missing',
      severity: 'P0',
      message: `evidence-index.json not found at ${evidenceIndexPath} — full data outage`,
      mitigation: 'Re-run "Build evidence + tune quota" workflow; investigate fetcher failures',
      evidence: { path: evidenceIndexPath },
    });
  } else if (now - mtime > maxStaleMs) {
    const ageHours = ((now - mtime) / HOUR_MS).toFixed(1);
    alerts.push({
      id: 'B.1.evidence-stale',
      severity: 'P0',
      message: `evidence-index.json is ${ageHours}h old (threshold ${config.evidence_stale_max_hours}h)`,
      mitigation: 'Inspect "Build evidence + tune quota" cron run; rerun on demand',
      evidence: { ageHours, path: evidenceIndexPath },
    });
  }

  // B.2 GSC fetch failure.
  const gscError = evidence?.gsc?.error;
  if (gscError) {
    alerts.push({
      id: 'B.2.gsc-fetch-failure',
      severity: 'P1',
      message: `GSC fetcher reported error: ${gscError}`,
      mitigation: 'Check FIREBASE_SERVICE_ACCOUNT_JSON GSC permissions; rerun evidence build',
      evidence: { error: gscError },
    });
  }

  // B.3 GA4 fetch failure.
  const ga4Error = evidence?.ga4?.error;
  if (ga4Error) {
    alerts.push({
      id: 'B.3.ga4-fetch-failure',
      severity: 'P1',
      message: `GA4 fetcher reported error: ${ga4Error}`,
      mitigation: 'Verify GA4_PROPERTY_ID + service-account Viewer role on the GA4 property',
      evidence: { error: ga4Error },
    });
  }

  // B.4 PostHog fetch failure — P2 (winner-def is traffic-only, this is metadata).
  const phError = evidence?.posthog?.error;
  if (phError) {
    alerts.push({
      id: 'B.4.posthog-fetch-failure',
      severity: 'P2',
      message: `PostHog fetcher reported error: ${phError}`,
      mitigation: 'Verify POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID; non-blocking for selection',
      evidence: { error: phError },
    });
  }

  // B.5 ClusterStats degenerate — clusters used in last 7d publications with n < threshold.
  const minN = config.cluster_stats_min_n || 10;
  const recent = articles.filter((a) => withinLastDays(a.publishedAt, 7, now));
  const clusterStats = evidence?.clusterStats || {};
  const degenerate = new Set();
  for (const a of recent) {
    const cluster = a.cluster || 'generic';
    const stats = clusterStats[cluster];
    if (!stats) {
      degenerate.add(`${cluster}:missing`);
      continue;
    }
    if (Number.isFinite(stats.n) && stats.n < minN) degenerate.add(`${cluster}:n=${stats.n}`);
  }
  if (degenerate.size > 0) {
    alerts.push({
      id: 'B.5.cluster-stats-degenerate',
      severity: 'P1',
      message: `Clusters used in last 7d publications have insufficient sample (n<${minN}): ${Array.from(degenerate).join(', ')}`,
      mitigation: 'Backfill GA4 evidence; reduce CLUSTER_MIN_N if cluster taxonomy was just split',
      evidence: { degenerate: Array.from(degenerate), minN },
    });
  }

  // B.6 Embedding store outdated.
  const liveCount = typeof countBlogArticles === 'function' ? countBlogArticles() : null;
  const storedCount = typeof embeddingsCount === 'function' ? embeddingsCount() : null;
  if (Number.isFinite(liveCount) && Number.isFinite(storedCount) && liveCount - storedCount > 50) {
    alerts.push({
      id: 'B.6.embedding-store-outdated',
      severity: 'P1',
      message: `Embedding store covers ${storedCount} articles but blog-meta-it has ${liveCount} (gap ${liveCount - storedCount} > 50)`,
      mitigation: 'Run "build-article-embeddings.mjs --incremental" or trigger evidence-build workflow',
      evidence: { liveCount, storedCount, gap: liveCount - storedCount },
    });
  }

  return alerts;
}
