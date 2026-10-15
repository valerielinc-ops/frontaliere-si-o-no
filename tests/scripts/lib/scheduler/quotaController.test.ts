// tests/scripts/lib/scheduler/quotaController.test.ts
//
// Spec § 6.6 + § 6.10 acceptance:
//   - 100 deterministic runs at quota=80 → exactly 80 'proven' + 20 'discovery'
//   - bounds + persistence + counter behavior

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideSlot,
  incrementCounter,
  loadQuotaState,
  saveQuotaState,
  QUOTA_DEFAULT,
  QUOTA_LOWER_BOUND,
  QUOTA_UPPER_BOUND,
} from '../../../../scripts/lib/scheduler/quotaController.mjs';

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-state-'));
  statePath = join(tmpDir, 'quota-state.json');
  delete process.env.DISCOVERY_QUOTA_OVERRIDE;
});

afterEach(() => {
  delete process.env.DISCOVERY_QUOTA_OVERRIDE;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadQuotaState', () => {
  it('returns defaults when the file is missing', () => {
    const state = loadQuotaState({ path: statePath });
    expect(state.runCounter).toBe(0);
    expect(state.currentQuota).toBe(QUOTA_DEFAULT);
    expect(state.version).toBe(1);
    expect(state.history).toEqual([]);
  });

  it('clamps an out-of-range quota into [60, 95]', () => {
    saveQuotaState({ version: 1, runCounter: 5, currentQuota: 200, lastTune: null, history: [] }, { path: statePath });
    const loaded = loadQuotaState({ path: statePath });
    expect(loaded.currentQuota).toBe(QUOTA_UPPER_BOUND);

    saveQuotaState({ version: 1, runCounter: 5, currentQuota: 1, lastTune: null, history: [] }, { path: statePath });
    const loaded2 = loadQuotaState({ path: statePath });
    expect(loaded2.currentQuota).toBe(QUOTA_LOWER_BOUND);
  });

  it('returns defaults on corrupt JSON', () => {
    // mkdir already created tmpDir; write garbage manually.
    saveQuotaState({} as any, { path: statePath });
    const state = loadQuotaState({ path: statePath });
    expect(state.runCounter).toBe(0);
    expect(state.currentQuota).toBe(QUOTA_DEFAULT);
  });
});

describe('decideSlot', () => {
  it('100 sequential runs at quota=80 produce 80 proven + 20 discovery', () => {
    let state = { version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] };
    let proven = 0;
    let discovery = 0;
    for (let i = 0; i < 100; i += 1) {
      const { slotKind } = decideSlot(state);
      if (slotKind === 'proven') proven += 1;
      else discovery += 1;
      state = incrementCounter(state);
    }
    expect(proven).toBe(80);
    expect(discovery).toBe(20);
  });

  it('200 sequential runs at quota=80 produce 160 proven + 40 discovery (cycles modulo 100)', () => {
    let state = { version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] };
    let proven = 0;
    let discovery = 0;
    for (let i = 0; i < 200; i += 1) {
      const { slotKind } = decideSlot(state);
      if (slotKind === 'proven') proven += 1;
      else discovery += 1;
      state = incrementCounter(state);
    }
    expect(proven).toBe(160);
    expect(discovery).toBe(40);
  });

  it('returns proven when counter < quota and discovery otherwise', () => {
    expect(decideSlot({ runCounter: 0, currentQuota: 80 } as any).slotKind).toBe('proven');
    expect(decideSlot({ runCounter: 79, currentQuota: 80 } as any).slotKind).toBe('proven');
    expect(decideSlot({ runCounter: 80, currentQuota: 80 } as any).slotKind).toBe('discovery');
    expect(decideSlot({ runCounter: 99, currentQuota: 80 } as any).slotKind).toBe('discovery');
    expect(decideSlot({ runCounter: 100, currentQuota: 80 } as any).slotKind).toBe('proven');
  });

  it('respects DISCOVERY_QUOTA_OVERRIDE=100 (force all proven)', () => {
    process.env.DISCOVERY_QUOTA_OVERRIDE = '100';
    let state = { version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] };
    let proven = 0;
    for (let i = 0; i < 100; i += 1) {
      const { slotKind } = decideSlot(state);
      if (slotKind === 'proven') proven += 1;
      state = incrementCounter(state);
    }
    expect(proven).toBe(100);
  });

  it('respects DISCOVERY_QUOTA_OVERRIDE=0 (force all discovery)', () => {
    process.env.DISCOVERY_QUOTA_OVERRIDE = '0';
    let state = { version: 1, runCounter: 0, currentQuota: 80, lastTune: null, history: [] };
    let discovery = 0;
    for (let i = 0; i < 100; i += 1) {
      const { slotKind } = decideSlot(state);
      if (slotKind === 'discovery') discovery += 1;
      state = incrementCounter(state);
    }
    expect(discovery).toBe(100);
  });
});

describe('incrementCounter', () => {
  it('returns a NEW state object (immutability)', () => {
    const state = { version: 1, runCounter: 5, currentQuota: 80, lastTune: null, history: [] };
    const next = incrementCounter(state);
    expect(next).not.toBe(state);
    expect(state.runCounter).toBe(5);
    expect(next.runCounter).toBe(6);
  });

  it('preserves the rest of the state', () => {
    const state = {
      version: 1,
      runCounter: 5,
      currentQuota: 70,
      lastTune: '2026-05-07T00:00:00Z',
      history: [{ at: 'x', quota: 70 }],
    };
    const next = incrementCounter(state);
    expect(next.currentQuota).toBe(70);
    expect(next.lastTune).toBe('2026-05-07T00:00:00Z');
    expect(next.history).toEqual(state.history);
  });
});

describe('saveQuotaState', () => {
  it('writes a JSON file readable by loadQuotaState', () => {
    const state = {
      version: 1,
      runCounter: 42,
      currentQuota: 75,
      lastTune: '2026-05-07T00:00:00Z',
      history: [],
    };
    expect(saveQuotaState(state, { path: statePath })).toBe(true);
    expect(existsSync(statePath)).toBe(true);
    const raw = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(raw.runCounter).toBe(42);
    expect(raw.currentQuota).toBe(75);

    const reloaded = loadQuotaState({ path: statePath });
    expect(reloaded.runCounter).toBe(42);
    expect(reloaded.currentQuota).toBe(75);
  });
});
