// tests/scripts/quality-alerts.test.ts
//
// Spec § 8 — main runner integration test. Builds a fake state on disk,
// runs the pure `run()` function, and asserts:
//   - exit code 1 on P0/P1, 0 otherwise
//   - meta-alert injects when 5+ P0/P1 fire
//   - summary string renders the active table
//   - history is appended

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../../scripts/quality-alerts.mjs';

const NOW = Date.parse('2026-05-08T00:00:00Z');
const HOUR = 3600 * 1000;

let tmpDir: string;
let paths: any;

const config = {
  monoculture_threshold: 0.4,
  quota_oscillation_threshold: 15,
  winrate_collapse_threshold: 0.2,
  engagement_dive_threshold: 0.4,
  cost_embedding_daily_max_usd: 5.0,
  cost_factcheck_retry_max: 300,
  snooze_after_consecutive_days: 3,
  snooze_duration_days: 7,
  meta_alert_count_threshold: 5,
  evidence_stale_max_hours: 36,
  cluster_stats_min_n: 10,
  all_low_score_consecutive: 5,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quality-alerts-'));
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  paths = {
    evidenceIndex: join(tmpDir, 'data', 'evidence-index.json'),
    embeddingsMeta: join(tmpDir, 'data', 'article-embeddings-meta.json'),
    quotaState: join(tmpDir, 'data', 'quota-state.json'),
    alertConfig: join(tmpDir, 'data', 'alert-config.json'),
    alertSnoozes: join(tmpDir, 'data', 'alert-snoozes.json'),
    alertsHistory: join(tmpDir, 'data', 'quality-alerts-history.jsonl'),
    blogArticlesDir: join(tmpDir, 'data', 'blog-articles'),
    blogMetaIt: join(tmpDir, 'blog-meta-it.ts'),
  };
  writeFileSync(paths.alertConfig, JSON.stringify(config), 'utf-8');
  writeFileSync(paths.alertSnoozes, JSON.stringify({ version: 1, snoozes: {} }), 'utf-8');
  writeFileSync(paths.alertsHistory, '', 'utf-8');
  writeFileSync(paths.blogMetaIt, '', 'utf-8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvidence(extra: object = {}) {
  writeFileSync(paths.evidenceIndex, JSON.stringify({
    version: 1,
    builtAt: new Date(NOW - 1 * HOUR).toISOString(),
    gsc: { queries: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`q${i}`, { imp: 10 }])) },
    ga4: { pages: {} },
    posthog: { pages: {} },
    clusterStats: { generic: { p10: 10, p50: 100, p90: 500, n: 50 } },
    ...extra,
  }), 'utf-8');
}

describe('run()', () => {
  it('exits 0 on a healthy snapshot', async () => {
    writeEvidence();
    writeFileSync(paths.quotaState, JSON.stringify({ version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] }), 'utf-8');
    const result = await run({
      paths,
      now: NOW,
      articles: [],
      readMtime: () => NOW - HOUR,
      countBlogArticles: () => 100,
      embeddingsCount: () => 100,
      summaryPath: join(tmpDir, 'summary.md'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.activeAlerts).toEqual([]);
  });

  it('exits 1 when a P0 fires', async () => {
    // missing evidence index → B.1 P0
    writeFileSync(paths.quotaState, JSON.stringify({ version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] }), 'utf-8');
    const result = await run({
      paths,
      now: NOW,
      articles: [],
      readMtime: () => null,
      countBlogArticles: () => 100,
      embeddingsCount: () => 100,
      summaryPath: join(tmpDir, 'summary.md'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.activeAlerts.find((a: any) => a.id === 'B.1.evidence-missing')).toBeDefined();
  });

  it('injects meta-alert when 5+ P0/P1 fire', async () => {
    writeEvidence({
      gsc: { error: 'boom' },
      ga4: { error: 'boom' },
      clusterStats: { fiscale: { p10: 1, p50: 5, p90: 10, n: 3 } },
    });
    writeFileSync(paths.quotaState, JSON.stringify({
      version: 1,
      runCounter: 0,
      currentQuota: 80,
      lastTune: null,
      history: [
        { timestamp: new Date(NOW - 24 * HOUR).toISOString(), provenWinRate: 0.05, discoveryWinRate: 0.05, newQuota: 60 },
        { timestamp: new Date(NOW - 8 * 24 * HOUR).toISOString(), provenWinRate: 0.05, discoveryWinRate: 0.05, newQuota: 95 },
      ],
    }), 'utf-8');
    const articles = [
      { slug: 's1', cluster: 'fiscale', publishedAt: new Date(NOW - HOUR).toISOString(), _pool: 'evergreen-fallback', _score_breakdown: { stage: 'cluster', finalScore: 1 } },
      { slug: 's2', cluster: 'fiscale', publishedAt: new Date(NOW - 2 * HOUR).toISOString(), _pool: 'evergreen-fallback', _score_breakdown: { stage: 'cluster', finalScore: 1 } },
      { slug: 's3', cluster: 'fiscale', publishedAt: new Date(NOW - 3 * HOUR).toISOString(), _pool: 'evergreen-fallback', _score_breakdown: { stage: 'cluster', finalScore: 1 } },
    ];
    const result = await run({
      paths,
      now: NOW,
      articles,
      readMtime: () => NOW - HOUR,
      countBlogArticles: () => 100,
      embeddingsCount: () => 100,
      summaryPath: join(tmpDir, 'summary.md'),
    });
    expect(result.activeAlerts.find((a: any) => a.id === 'meta.system-distress')).toBeDefined();
    expect(result.exitCode).toBe(1);
  });

  it('renders summary into provided summaryPath', async () => {
    writeEvidence();
    writeFileSync(paths.quotaState, JSON.stringify({ version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] }), 'utf-8');
    const summaryPath = join(tmpDir, 'summary.md');
    const result = await run({
      paths,
      now: NOW,
      articles: [],
      readMtime: () => NOW - HOUR,
      countBlogArticles: () => 100,
      embeddingsCount: () => 100,
      summaryPath,
    });
    const summaryContent = readFileSync(summaryPath, 'utf-8');
    expect(summaryContent).toContain('Quality alerts');
    expect(result.summary).toContain('Quality alerts');
  });

  it('appends to history file even on healthy run', async () => {
    writeEvidence();
    writeFileSync(paths.quotaState, JSON.stringify({ version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] }), 'utf-8');
    await run({
      paths,
      now: NOW,
      articles: [],
      readMtime: () => NOW - HOUR,
      countBlogArticles: () => 100,
      embeddingsCount: () => 100,
      summaryPath: join(tmpDir, 'summary.md'),
    });
    const history = readFileSync(paths.alertsHistory, 'utf-8');
    expect(history.length).toBeGreaterThan(0);
  });
});
