// tests/scripts/lib/alerts/detectors/cost.test.ts
//
// Spec § 8 — Category D detectors (D.1 GSC quota, D.2 embedding cost,
// D.3 fact-check retry burst, D.4 OpenRouter free-model exhaustion).

import { describe, expect, it } from 'vitest';

import { detectCost } from '../../../../../scripts/lib/alerts/detectors/cost.mjs';

const NOW = Date.parse('2026-05-08T00:00:00Z');
const HOUR = 3600 * 1000;

const config = {
  cost_embedding_daily_max_usd: 5.0,
  cost_factcheck_retry_max: 300,
};

describe('D.1 GSC quota suspect', () => {
  it('fires P1 when GSC query count is suspiciously low', () => {
    const queries: Record<string, any> = {};
    for (let i = 0; i < 50; i += 1) queries[`q${i}`] = { imp: 10 };
    const out = detectCost({
      evidence: { gsc: { queries } },
      embeddingsMeta: null,
      alertHistory: [],
      recentLogs: [],
      config,
      now: NOW,
    });
    const alert = out.find((a: any) => a.id === 'D.1.gsc-quota-suspect');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P1');
  });

  it('does not fire when query count is healthy', () => {
    const queries: Record<string, any> = {};
    for (let i = 0; i < 600; i += 1) queries[`q${i}`] = { imp: 10 };
    const out = detectCost({
      evidence: { gsc: { queries } },
      embeddingsMeta: null,
      alertHistory: [],
      recentLogs: [],
      config,
      now: NOW,
    });
    expect(out.find((a: any) => a.id === 'D.1.gsc-quota-suspect')).toBeUndefined();
  });
});

describe('D.2 embedding cost spike', () => {
  it('fires P0 when refresh count + cost exceed cap', () => {
    const meta = {
      builtAt: new Date(NOW - 2 * HOUR).toISOString(),
      count: 2000,
      refreshedCount: 60000,
    };
    const out = detectCost({
      evidence: {},
      embeddingsMeta: meta,
      alertHistory: [],
      recentLogs: [],
      config,
      now: NOW,
    });
    const alert = out.find((a: any) => a.id === 'D.2.embedding-cost-spike');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P0');
  });

  it('does not fire on normal incremental refresh', () => {
    const meta = {
      builtAt: new Date(NOW - 2 * HOUR).toISOString(),
      count: 2000,
      refreshedCount: 5,
    };
    const out = detectCost({
      evidence: {},
      embeddingsMeta: meta,
      alertHistory: [],
      recentLogs: [],
      config,
      now: NOW,
    });
    expect(out.find((a: any) => a.id === 'D.2.embedding-cost-spike')).toBeUndefined();
  });
});

describe('D.3 fact-check retry burst', () => {
  it('fires when retry telemetry exceeds cap in last 24h', () => {
    const alertHistory = [
      { timestamp: new Date(NOW - 2 * HOUR).toISOString(), factcheckRetries: 200 },
      { timestamp: new Date(NOW - 5 * HOUR).toISOString(), factcheckRetries: 150 },
    ];
    const out = detectCost({
      evidence: {},
      embeddingsMeta: null,
      alertHistory,
      recentLogs: [],
      config,
      now: NOW,
    });
    expect(out.find((a: any) => a.id === 'D.3.factcheck-retry-burst')).toBeDefined();
  });

  it('does not fire without telemetry', () => {
    const out = detectCost({
      evidence: {},
      embeddingsMeta: null,
      alertHistory: [],
      recentLogs: [],
      config,
      now: NOW,
    });
    expect(out.find((a: any) => a.id === 'D.3.factcheck-retry-burst')).toBeUndefined();
  });
});

describe('D.4 OpenRouter free-model exhaustion', () => {
  it('fires P2 when log line matches', () => {
    const out = detectCost({
      evidence: {},
      embeddingsMeta: null,
      alertHistory: [],
      recentLogs: ['INFO: all free models exhausted, falling back', 'INFO: ok'],
      config,
      now: NOW,
    });
    const alert = out.find((a: any) => a.id === 'D.4.openrouter-free-exhausted');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P2');
  });

  it('does not fire on unrelated logs', () => {
    const out = detectCost({
      evidence: {},
      embeddingsMeta: null,
      alertHistory: [],
      recentLogs: ['everything fine here'],
      config,
      now: NOW,
    });
    expect(out.find((a: any) => a.id === 'D.4.openrouter-free-exhausted')).toBeUndefined();
  });
});
