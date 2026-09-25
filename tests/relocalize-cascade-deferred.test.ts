import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeCascadeWindow, markCascadeFailure } from '../scripts/relocalize-pending-jobs.mjs';
import { summarizeRunPhases } from '../scripts/lib/translation-observability.mjs';
import {
  RUN_PHASES_PATH,
  readRunPhases,
  recordRunPhase,
} from '../scripts/lib/translate-run-clock.mjs';

describe('deferred cascade follow-ups', () => {
  it('falls back to the wall clock only when the compensated clock is incoherent', () => {
    expect(computeCascadeWindow({ nowMs: 100, runStartMs: 200, deadlineMs: 90 }))
      .toEqual({ startedAtMs: 0, windowMs: 90, stopReason: 'clock incoherent' });
    expect(computeCascadeWindow({ nowMs: 100, runStartMs: 200, deadlineMs: 90, fallbackNowMs: 260 }))
      .toEqual({ startedAtMs: 60, windowMs: 30, stopReason: 'clock fallback' });
    expect(computeCascadeWindow({ nowMs: 100, runStartMs: 200, deadlineMs: 90, fallbackNowMs: 290 }))
      .toEqual({ startedAtMs: 90, windowMs: 0, stopReason: 'cascade deadline' });
  });

  describe('phase sidecar identity', () => {
    beforeEach(() => fs.rmSync(RUN_PHASES_PATH, { force: true }));
    afterEach(() => fs.rmSync(RUN_PHASES_PATH, { force: true }));

    it('replaces a prior phase snapshot instead of appending a duplicate name', () => {
      recordRunPhase({ name: 'local-mt-bulk', endedAtMs: 10 });
      recordRunPhase({ name: 'cascade', stopReason: 'in progress' });
      recordRunPhase({ name: 'local-mt-mopup', endedAtMs: 30 });
      recordRunPhase({ name: 'cascade', stopReason: 'queue exhausted' });

      expect(readRunPhases()).toEqual([
        { name: 'local-mt-bulk', endedAtMs: 10 },
        { name: 'cascade', stopReason: 'queue exhausted' },
        { name: 'local-mt-mopup', endedAtMs: 30 },
      ]);
    });
  });

  it('preserves a deadline reason while marking a later failure separately', () => {
    const deadline = { stopReason: 'cascade deadline' };
    const active = { stopReason: 'in progress' };
    markCascadeFailure(deadline);
    markCascadeFailure(active);

    expect(deadline).toEqual({ stopReason: 'cascade deadline', failed: true });
    expect(active).toEqual({ stopReason: 'failed', failed: true });

    const summary = summarizeRunPhases([{
      name: 'cascade',
      windowMs: 0,
      stopReason: deadline.stopReason,
      failed: deadline.failed,
      clockFallback: true,
    }]);
    expect(summary?.cascade).toMatchObject({
      stopReason: 'cascade deadline',
      failed: true,
      clockFallback: true,
    });
  });
});
