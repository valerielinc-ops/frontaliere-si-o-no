// tests/scripts/tune-discovery-quota.test.ts
//
// Spec § 7.4 + § 7.6 acceptance:
//  - cold-start (no aged articles) → hold + reason includes 'cold-start'
//  - statistical sanity (sample < 30 in either pool) → hold
//  - bounds enforced: 100 cycles can never push quota outside [60, 95]
//  - decision direction: ratio ≥ 1.2 → 'more discovery' (quota − step),
//    ratio ≤ 0.7 → 'less discovery' (quota + step)
//  - history append + state mutation persist atomically

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideTune,
  appendStateHistory,
  buildHistoryRecord,
  loadEvidenceIndex,
  runTune,
  HISTORY_CAP,
  TUNE_STEP,
} from '../../scripts/tune-discovery-quota.mjs';
import {
  QUOTA_LOWER_BOUND,
  QUOTA_UPPER_BOUND,
  loadQuotaState,
} from '../../scripts/lib/scheduler/quotaController.mjs';

const NOW = new Date('2026-05-07T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let statePath: string;
let historyPath: string;
let evidencePath: string;
let blogDir: string;

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function seedState(state: object) {
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function seedEvidence(evidence: object) {
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf-8');
}

function writeSidecar(name: string, sidecar: object) {
  writeFileSync(join(blogDir, `${name}.json`), JSON.stringify(sidecar, null, 2), 'utf-8');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tune-quota-'));
  statePath = join(tmpRoot, 'quota-state.json');
  historyPath = join(tmpRoot, 'quota-history.jsonl');
  evidencePath = join(tmpRoot, 'evidence-index.json');
  blogDir = join(tmpRoot, 'blog-articles');
  mkdirSync(blogDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('decideTune', () => {
  it('cold-start (proven=0, discovery=0) → hold with cold-start reason', () => {
    const tune = decideTune(
      { currentQuota: 80 },
      { proven: { winners: 0, total: 0 }, discovery: { winners: 0, total: 0 } },
    );
    expect(tune.decision).toBe('hold');
    expect(tune.reason).toContain('cold-start');
    expect(tune.newQuota).toBe(80);
  });

  it('25 proven + 25 discovery (both < 30) → hold', () => {
    const tune = decideTune(
      { currentQuota: 80 },
      {
        proven: { winners: 10, total: 25 },
        discovery: { winners: 5, total: 25 },
      },
    );
    expect(tune.decision).toBe('hold');
    expect(tune.reason).toContain('insufficient sample');
    expect(tune.newQuota).toBe(80);
  });

  it('30 proven + 30 discovery → applies tune logic', () => {
    // discovery beating proven by 2x → ratio=2, decrease quota
    const tune = decideTune(
      { currentQuota: 80 },
      {
        proven: { winners: 6, total: 30 },
        discovery: { winners: 12, total: 30 },
      },
    );
    expect(tune.decision).toBe('more discovery');
    expect(tune.newQuota).toBe(75);
  });

  it('discovery >> proven (ratio ≥ 1.2) → quota − step', () => {
    const tune = decideTune(
      { currentQuota: 80 },
      {
        proven: { winners: 5, total: 50 },
        discovery: { winners: 30, total: 50 },
      },
    );
    expect(tune.decision).toBe('more discovery');
    expect(tune.newQuota).toBe(80 - TUNE_STEP);
  });

  it('discovery << proven (ratio ≤ 0.7) → quota + step', () => {
    const tune = decideTune(
      { currentQuota: 80 },
      {
        proven: { winners: 30, total: 50 },
        discovery: { winners: 5, total: 50 },
      },
    );
    expect(tune.decision).toBe('less discovery');
    expect(tune.newQuota).toBe(80 + TUNE_STEP);
  });

  it('ratio between 0.7 and 1.2 → hold', () => {
    const tune = decideTune(
      { currentQuota: 80 },
      {
        proven: { winners: 15, total: 50 },
        discovery: { winners: 15, total: 50 },
      },
    );
    expect(tune.decision).toBe('hold');
    expect(tune.newQuota).toBe(80);
  });

  it('100 cycles starting at quota=60 with discoveryRate >> provenRate never goes below 60', () => {
    let state: { currentQuota: number } = { currentQuota: QUOTA_LOWER_BOUND };
    for (let i = 0; i < 100; i += 1) {
      const tune = decideTune(state, {
        proven: { winners: 1, total: 100 },
        discovery: { winners: 90, total: 100 },
      });
      expect(tune.newQuota).toBeGreaterThanOrEqual(QUOTA_LOWER_BOUND);
      expect(tune.newQuota).toBeLessThanOrEqual(QUOTA_UPPER_BOUND);
      state = { currentQuota: tune.newQuota };
    }
    expect(state.currentQuota).toBe(QUOTA_LOWER_BOUND);
  });

  it('100 cycles starting at quota=95 with provenRate >> discoveryRate never exceeds 95', () => {
    let state: { currentQuota: number } = { currentQuota: QUOTA_UPPER_BOUND };
    for (let i = 0; i < 100; i += 1) {
      const tune = decideTune(state, {
        proven: { winners: 90, total: 100 },
        discovery: { winners: 1, total: 100 },
      });
      expect(tune.newQuota).toBeGreaterThanOrEqual(QUOTA_LOWER_BOUND);
      expect(tune.newQuota).toBeLessThanOrEqual(QUOTA_UPPER_BOUND);
      state = { currentQuota: tune.newQuota };
    }
    expect(state.currentQuota).toBe(QUOTA_UPPER_BOUND);
  });

  it('handles provenRate=0 without dividing by zero (ratio uses 0.01 floor)', () => {
    const tune = decideTune(
      { currentQuota: 80 },
      {
        proven: { winners: 0, total: 50 },
        discovery: { winners: 25, total: 50 },
      },
    );
    expect(tune.decision).toBe('more discovery');
    expect(Number.isFinite(tune.ratio)).toBe(true);
  });

  it('clamps already-out-of-bounds incoming quota into [60, 95]', () => {
    const tune = decideTune(
      { currentQuota: 200 },
      { proven: { winners: 0, total: 0 }, discovery: { winners: 0, total: 0 } },
    );
    expect(tune.newQuota).toBe(QUOTA_UPPER_BOUND);
  });
});

describe('appendStateHistory', () => {
  it('caps history at HISTORY_CAP entries (drops oldest)', () => {
    const huge = Array.from({ length: HISTORY_CAP }, (_, i) => ({ tunedAt: `t${i}` }));
    const next = appendStateHistory({ history: huge }, { tunedAt: 'newest' });
    expect(next).toHaveLength(HISTORY_CAP);
    expect(next[next.length - 1]).toEqual({ tunedAt: 'newest' });
    expect(next[0]).toEqual({ tunedAt: 't1' });
  });

  it('appends below the cap without trimming', () => {
    const next = appendStateHistory({ history: [{ tunedAt: 'a' }] }, { tunedAt: 'b' });
    expect(next).toHaveLength(2);
  });

  it('initialises history when state.history is missing', () => {
    const next = appendStateHistory({}, { tunedAt: 'first' });
    expect(next).toEqual([{ tunedAt: 'first' }]);
  });
});

describe('buildHistoryRecord', () => {
  it('rounds rates to 4 decimals and includes samples', () => {
    const tune = {
      decision: 'hold' as const,
      reason: 'ok',
      newQuota: 80,
      provenRate: 1 / 3,
      discoveryRate: 0.5,
      ratio: 1.5,
    };
    const winnerStats = {
      proven: { winners: 1, total: 3 },
      discovery: { winners: 1, total: 2 },
    };
    const record = buildHistoryRecord({
      tunedAt: '2026-05-07T00:00:00Z',
      tune,
      prevQuota: 80,
      winnerStats,
    });
    expect(record.provenWinRate).toBe(0.3333);
    expect(record.discoveryWinRate).toBe(0.5);
    expect(record.samples.proven).toEqual({ winners: 1, total: 3 });
    expect(record.prevQuota).toBe(80);
    expect(record.tunedAt).toBe('2026-05-07T00:00:00Z');
  });

  it('preserves null ratio in cold-start records', () => {
    const record = buildHistoryRecord({
      tunedAt: 't',
      tune: {
        decision: 'hold',
        reason: 'cold-start',
        newQuota: 80,
        provenRate: 0,
        discoveryRate: 0,
        ratio: null,
      },
      prevQuota: 80,
      winnerStats: { proven: { winners: 0, total: 0 }, discovery: { winners: 0, total: 0 } },
    });
    expect(record.ratio).toBeNull();
  });
});

describe('loadEvidenceIndex', () => {
  it('returns empty skeleton when file missing', () => {
    const evidence = loadEvidenceIndex(join(tmpRoot, 'absent.json'));
    expect(evidence.ga4.pages).toEqual({});
    expect(evidence.clusterStats).toEqual({});
  });

  it('returns empty skeleton on malformed JSON', () => {
    writeFileSync(evidencePath, '{not json', 'utf-8');
    const evidence = loadEvidenceIndex(evidencePath);
    expect(evidence.ga4.pages).toEqual({});
  });

  it('fills missing ga4/clusterStats subfields when present partial', () => {
    writeFileSync(evidencePath, JSON.stringify({ version: 1 }), 'utf-8');
    const evidence = loadEvidenceIndex(evidencePath);
    expect(evidence.ga4).toBeTruthy();
    expect(evidence.ga4.pages).toEqual({});
    expect(evidence.clusterStats).toEqual({});
  });
});

describe('runTune (integration)', () => {
  it('cold-start: no state, no evidence, no sidecars → hold + record appended', () => {
    const { tune, state } = runTune({
      statePath,
      evidencePath,
      historyPath,
      blogArticlesDir: blogDir,
      now: NOW,
      tunedAt: '2026-05-07T12:00:00Z',
    });
    expect(tune.decision).toBe('hold');
    expect(tune.reason).toContain('cold-start');
    expect(state.currentQuota).toBeGreaterThanOrEqual(QUOTA_LOWER_BOUND);
    expect(state.currentQuota).toBeLessThanOrEqual(QUOTA_UPPER_BOUND);

    expect(existsSync(historyPath)).toBe(true);
    const lines = readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.decision).toBe('hold');
    expect(record.reason).toContain('cold-start');
  });

  it('persists the new quota to disk via atomic write', () => {
    seedState({ version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] });
    seedEvidence({
      version: 1,
      ga4: {
        pages: Object.fromEntries(
          Array.from({ length: 60 }, (_, i) => [
            `/articoli-frontaliere/p${i}/`,
            { sessions: i < 30 ? 999 : 10 },
          ]),
        ),
      },
      clusterStats: { fisco: { p50: 100 } },
    });
    // Seed 30 proven (mostly losers) and 30 discovery (mostly winners) → ratio high → quota down.
    for (let i = 0; i < 30; i += 1) {
      writeSidecar(`p${i}`, {
        slug: `p${i}`,
        publishedAt: isoDaysAgo(20),
        cluster: 'fisco',
        _pool: 'proven',
      });
    }
    for (let i = 0; i < 30; i += 1) {
      writeSidecar(`d${i}`, {
        slug: `p${30 + i}`,
        publishedAt: isoDaysAgo(20),
        cluster: 'fisco',
        _pool: 'discovery',
      });
    }
    const { tune, state } = runTune({
      statePath,
      evidencePath,
      historyPath,
      blogArticlesDir: blogDir,
      now: NOW,
      tunedAt: '2026-05-07T12:00:00Z',
    });
    // Pages 0..29 (sessions 999) → slugs p0..p29 (proven, all winners).
    // Pages 30..59 (sessions 10)  → slugs p30..p59 (discovery, all losers).
    // proven wins 30/30, discovery wins 0/30 → ratio≈0 → quota up.
    expect(tune.decision).toBe('less discovery');
    expect(state.currentQuota).toBe(85);

    const reloaded = loadQuotaState({ path: statePath });
    expect(reloaded.currentQuota).toBe(state.currentQuota);
    expect(reloaded.lastTune).toBe('2026-05-07T12:00:00Z');
    expect(reloaded.history).toHaveLength(1);
  });

  it('appends successive runs to history JSONL', () => {
    seedState({ version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] });
    runTune({ statePath, evidencePath, historyPath, blogArticlesDir: blogDir, now: NOW });
    runTune({ statePath, evidencePath, historyPath, blogArticlesDir: blogDir, now: NOW });
    runTune({ statePath, evidencePath, historyPath, blogArticlesDir: blogDir, now: NOW });
    const lines = readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('dryRun=true does not mutate state file', () => {
    seedState({ version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] });
    runTune({
      statePath,
      evidencePath,
      historyPath,
      blogArticlesDir: blogDir,
      now: NOW,
      dryRun: true,
    });
    expect(existsSync(historyPath)).toBe(false);
    const reloaded = loadQuotaState({ path: statePath });
    expect(reloaded.lastTune).toBeNull();
  });
});
