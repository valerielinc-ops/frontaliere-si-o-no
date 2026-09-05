import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeRunPhases } from '../scripts/lib/translation-observability.mjs';
import { RUN_PHASES_PATH, readRunPhases, recordRunPhase } from '../scripts/lib/translate-run-clock.mjs';

/**
 * The cascade's deadline is measured from the run start published by the FIRST
 * translation step, so what the cascade receives is the remainder the earlier
 * phases left. These tests pin the two things that make a starved run readable:
 * the window is reported, and a missing window never reads as a healthy zero.
 */
describe('summarizeRunPhases', () => {
  const cascade = (over: Record<string, unknown> = {}) => ({
    name: 'cascade',
    startedAtMs: 52 * 60_000,
    endedAtMs: 90 * 60_000,
    deadlineMs: 90 * 60_000,
    windowMs: 38 * 60_000,
    jobsCleared: 30,
    companiesQueued: 200,
    stopReason: 'cascade deadline',
    ...over,
  });

  it('reports no phases as null, so "not instrumented" never reads as "idle"', () => {
    expect(summarizeRunPhases([])).toBeNull();
    expect(summarizeRunPhases(null)).toBeNull();
    expect(summarizeRunPhases(undefined)).toBeNull();
    expect(summarizeRunPhases([{ nameless: true }])).toBeNull();
  });

  it('carries the granted window and the time the earlier phases consumed', () => {
    const summary = summarizeRunPhases([
      { name: 'local-mt', startedAtMs: 0, endedAtMs: 49 * 60_000 },
      cascade(),
    ]);
    expect(summary?.phases).toHaveLength(2);
    expect(summary?.phases[0]).toMatchObject({ name: 'local-mt', elapsedMs: 49 * 60_000 });
    expect(summary?.cascade).toMatchObject({
      windowMs: 38 * 60_000,
      starved: false,
      consumedBeforeMs: 52 * 60_000,
      jobsCleared: 30,
      stopReason: 'cascade deadline',
    });
    // 30 jobs in 38 minutes of GRANTED window — not 30 in the nominal 90.
    expect(summary?.cascade?.jobsPerWindowMinute).toBeCloseTo(0.789, 3);
  });

  it('marks a run whose window the earlier phases had already spent', () => {
    // Phase 2a is allowed 150 minutes and the cascade's deadline is 90, measured
    // from the same instant: the bulk pass alone can spend the whole deadline.
    const summary = summarizeRunPhases([
      { name: 'local-mt', startedAtMs: 0, endedAtMs: 145.6 * 60_000 },
      cascade({ startedAtMs: 152 * 60_000, windowMs: -62 * 60_000, jobsCleared: 0 }),
    ]);
    expect(summary?.cascade?.starved).toBe(true);
    // Null, never 0: dividing zero jobs by a window that does not exist would
    // report a real yield of zero for a phase that never ran.
    expect(summary?.cascade?.jobsPerWindowMinute).toBeNull();
  });

  it('keeps an unreadable field null rather than coercing it to a number', () => {
    const summary = summarizeRunPhases([cascade({ windowMs: 'soon', jobsCleared: null })]);
    expect(summary?.cascade?.windowMs).toBeNull();
    expect(summary?.cascade?.starved).toBeNull();
    expect(summary?.cascade?.jobsPerWindowMinute).toBeNull();
  });

  it('reports phases even when no cascade ran', () => {
    const summary = summarizeRunPhases([{ name: 'local-mt', startedAtMs: 0, endedAtMs: 60_000 }]);
    expect(summary?.cascade).toBeNull();
    expect(summary?.phases).toHaveLength(1);
  });
});

describe('the phase sidecar', () => {
  // The module resolves its directory at import time, so the tests use the very
  // path it chose (RUNNER_TEMP on a runner, the system temp dir locally) and just
  // clear the sidecar around each case.
  beforeEach(() => fs.rmSync(RUN_PHASES_PATH, { force: true }));
  afterEach(() => fs.rmSync(RUN_PHASES_PATH, { force: true }));

  it('appends entries in the order the phases ran', () => {
    recordRunPhase({ name: 'local-mt', startedAtMs: 0, endedAtMs: 10 });
    recordRunPhase({ name: 'cascade', startedAtMs: 10, endedAtMs: 20 });
    expect(readRunPhases().map((phase: { name: string }) => phase.name)).toEqual(['local-mt', 'cascade']);
  });

  it('ignores an entry with no name and never throws on a corrupt sidecar', () => {
    recordRunPhase({ startedAtMs: 0 } as { name?: string });
    expect(readRunPhases()).toEqual([]);
    fs.writeFileSync(RUN_PHASES_PATH, 'not json at all', 'utf-8');
    expect(readRunPhases()).toEqual([]);
    expect(() => recordRunPhase({ name: 'cascade' })).not.toThrow();
  });

  it('caps the sidecar, because the report it feeds is hard-capped at 1 MiB', () => {
    for (let index = 0; index < 40; index += 1) recordRunPhase({ name: `phase-${index}` });
    expect(readRunPhases()).toHaveLength(32);
  });
});
