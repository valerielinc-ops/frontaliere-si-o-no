import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { windowedDeadlineMs } from '../scripts/lib/translate-run-clock.mjs';
import { decideRepairLane } from '../scripts/translate-repair-lane-gate.mjs';

/**
 * translate-pending: every translation phase keeps minutes of its own.
 *
 * Corpus run 36779310211 (2026-10-01): Argos (2a) used its full 150min, the
 * cascade (2b) started at 159min against a 90min RUN-WIDE deadline and
 * translated 0 jobs while Azure answered "ok", 2c ran to the 210min envelope
 * and the Phase 2d/2e gate, at 212min, skipped the title lane. The budget is
 * now: 2a 75min (titles first), 2a.2 title residue to the free cascade 25min,
 * 2b a 30min window under a 150min ceiling, 2c up to 170min, 2d/2e after.
 */

const MIN = 60_000;
const TARGETS = [
  '.github/workflows/translate-pending-logic.yml',
  '.github/corpus-workflows/translate-pending.yml',
];
// Measured on run 36779310211, minutes on the run clock: assemble + stats
// before 2a (2.6), re-assemble + Argos commit + flags + baseline between 2a
// and 2b (6.7), commit after 2c (3.5). Rounded up.
const SETUP_BEFORE_2A = 3 * MIN;
const BETWEEN_2A_AND_2B = 7 * MIN;
const COMMIT_AFTER_2C = 5 * MIN;

type Step = { id?: string; name?: string; if?: string; env?: Record<string, string>; run?: string };

function load(rel: string) {
  const doc = YAML.parse(fs.readFileSync(path.resolve(rel), 'utf8')) as {
    jobs: { translate: { 'timeout-minutes': number; steps: Step[] } };
  };
  const steps = doc.jobs.translate.steps;
  const byName = (re: RegExp) => {
    const index = steps.findIndex((step) => re.test(step.name ?? ''));
    expect(index, String(re)).toBeGreaterThanOrEqual(0);
    return { index, step: steps[index] };
  };
  return { timeoutMs: doc.jobs.translate['timeout-minutes'] * MIN, steps, byName };
}

describe('windowedDeadlineMs()', () => {
  it('keeps the run-wide deadline when no window is set', () => {
    expect(windowedDeadlineMs({ deadlineMs: 90 * MIN, elapsedAtStartMs: 159 * MIN })).toBe(90 * MIN);
    expect(windowedDeadlineMs({ deadlineMs: 90 * MIN, windowMs: 0, elapsedAtStartMs: 10 * MIN })).toBe(90 * MIN);
  });

  it('gives the phase its window from its own start, never past the ceiling', () => {
    expect(windowedDeadlineMs({ deadlineMs: 150 * MIN, windowMs: 30 * MIN, elapsedAtStartMs: 110 * MIN })).toBe(140 * MIN);
    expect(windowedDeadlineMs({ deadlineMs: 150 * MIN, windowMs: 30 * MIN, elapsedAtStartMs: 135 * MIN })).toBe(150 * MIN);
  });

  it('treats a negative or missing elapsed time as a start at zero', () => {
    expect(windowedDeadlineMs({ deadlineMs: 150 * MIN, windowMs: 30 * MIN, elapsedAtStartMs: -5 })).toBe(30 * MIN);
    expect(windowedDeadlineMs({ deadlineMs: 150 * MIN, windowMs: 30 * MIN, elapsedAtStartMs: Number.NaN })).toBe(30 * MIN);
  });
});

describe.each(TARGETS)('translate-pending phase budget (%s)', (rel) => {
  const { timeoutMs, steps, byName } = load(rel);
  const bulk = byName(/^Phase 2a: Local MT bulk translate/);
  const titlesEarly = byName(/^Phase 2a\.2: Fix untranslated titles/);
  const reassemble = byName(/^Re-assemble dataset after Argos bulk$/);
  const argosCommit = byName(/^Commit Argos translations before cascade$/);
  const cascade = byName(/^Phase 2b:/);
  const mopup = byName(/^Phase 2c mop-up/);
  const titleFix = byName(/^Phase 2d: Fix untranslated titles/);
  const descriptionFix = byName(/^Phase 2e: Fix untranslated descriptions/);
  const gate = steps.find((step) => step.id === 'repair_lane_budget');

  const envelopeMs = Number(titleFix.step.env?.UNTRANSLATED_TITLE_FIX_DEADLINE_MS);
  const bulkMs = Number(bulk.step.env?.LOCAL_MT_TIME_BUDGET_MS);
  const titlesWindowMs = Number(titlesEarly.step.env?.UNTRANSLATED_TITLE_FIX_WINDOW_MS);
  const titlesCeilingMs = Number(titlesEarly.step.env?.UNTRANSLATED_TITLE_FIX_DEADLINE_MS);
  // The Argos-first branch of the two expressions.
  const argosFirst = (value: string | undefined) => Number(/\|\|\s*'(\d+)'/.exec(String(value))?.[1]);
  const cascadeCeilingMs = argosFirst(cascade.step.env?.JOBS_CASCADE_DEADLINE_MS);
  const cascadeWindowMs = argosFirst(cascade.step.env?.JOBS_CASCADE_WINDOW_MS);
  const mopupCeilingMs = Number(mopup.step.env?.LOCAL_MT_MOPUP_DEADLINE_MS);

  it('runs the phases in order: Argos, title residue, re-assemble + commit, cascade, mop-up, repair lanes', () => {
    expect(bulk.index).toBeLessThan(titlesEarly.index);
    expect(titlesEarly.index).toBeLessThan(reassemble.index);
    expect(reassemble.index).toBeLessThan(argosCommit.index);
    expect(argosCommit.index).toBeLessThan(cascade.index);
    expect(cascade.index).toBeLessThan(mopup.index);
    expect(mopup.index).toBeLessThan(titleFix.index);
  });

  it('keeps the 140min queue after the 210min envelope', () => {
    expect(envelopeMs).toBe(210 * MIN);
    expect(timeoutMs - envelopeMs).toBe(140 * MIN);
  });

  it('gives the cascade its full window when Argos and the title residue use all of theirs', () => {
    expect(bulkMs).toBe(75 * MIN);
    expect(titlesWindowMs).toBe(25 * MIN);
    expect(cascadeWindowMs).toBe(30 * MIN);
    const cascadeStartMs = SETUP_BEFORE_2A + bulkMs + titlesWindowMs + BETWEEN_2A_AND_2B;
    expect(titlesCeilingMs).toBeGreaterThanOrEqual(SETUP_BEFORE_2A + bulkMs + titlesWindowMs);
    expect(windowedDeadlineMs({ deadlineMs: cascadeCeilingMs, windowMs: cascadeWindowMs, elapsedAtStartMs: cascadeStartMs }) - cascadeStartMs)
      .toBe(cascadeWindowMs);
  });

  it('leaves the mop-up time after a cascade that ran to its ceiling', () => {
    expect(mopupCeilingMs - cascadeCeilingMs).toBeGreaterThanOrEqual(20 * MIN);
  });

  it('lets the Phase 2d/2e gate open after a mop-up that ran to its ceiling', () => {
    expect(gate?.env?.REPAIR_LANE_DEADLINE_MS).toBe(String(envelopeMs));
    const decision = decideRepairLane({
      startMs: 0,
      nowMs: mopupCeilingMs + COMMIT_AFTER_2C,
      deadlineMs: Number(gate?.env?.REPAIR_LANE_DEADLINE_MS),
      minRemainingMs: Number(gate?.env?.REPAIR_LANE_MIN_REMAINING_MS),
    });
    expect(decision.run).toBe(true);
    expect(decision.remainingMs).toBeGreaterThanOrEqual(30 * MIN);
  });

  it('sends the title residue to the free cascade without Codex, gated like the re-assemble that keeps its writes', () => {
    expect(titlesEarly.step.run).toBe('node scripts/fix-untranslated-titles.mjs');
    expect(titlesEarly.step.env).not.toHaveProperty('CODEX_AUTH_BROKER_SOCKET');
    expect(titlesEarly.step.env).not.toHaveProperty('AZURE_TRANSLATOR_KEY');
    for (const clause of String(reassemble.step.if).split(' && ')) {
      expect(titlesEarly.step.if).toContain(clause);
    }
    expect(titlesEarly.step.if).toContain('inputs.dry_run != true');
    expect(argosCommit.step.run).toContain('data/translation-title-fix-attempts.json');
  });

  it('keeps Azure for titles: the description lanes run without its keys, the title lanes with them', () => {
    for (const step of [cascade.step, descriptionFix.step]) {
      expect(step.env?.AZURE_TRANSLATOR_KEY, step.name).toBe('');
      expect(step.env?.AZURE_TRANSLATOR_KEY_2, step.name).toBe('');
    }
    for (const step of [titlesEarly.step, titleFix.step]) {
      expect(step.env, step.name).not.toHaveProperty('AZURE_TRANSLATOR_KEY');
    }
  });
});

describe('relocalize-pending-jobs honours JOBS_CASCADE_WINDOW_MS', () => {
  function budgetMinutes(env: Record<string, string>, elapsedMin: number[]) {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-window-'));
    try {
      fs.writeFileSync(path.join(runnerTemp, 'translate-pending-run-start.txt'), String(Date.now() - 110 * MIN));
      const program = `const m = await import(${JSON.stringify(path.resolve('scripts/relocalize-pending-jobs.mjs'))});
console.log(JSON.stringify(${JSON.stringify(elapsedMin)}.map((e) => Math.round(m.cascadeCompanyTimeBudgetMs(e * 60000) / 60000))));`;
      const proc = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
        env: { ...process.env, RUNNER_TEMP: runnerTemp, TRANSLATE_RUN_CLOCK_REQUIRED: '', ...env },
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(proc.status, proc.stderr).toBe(0);
      return JSON.parse(proc.stdout.trim().split('\n').pop() || '[]');
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  }

  it('starts the window when the cascade starts (110min), under the 150min ceiling', () => {
    // 15min per-company cap; 140 - 135 = 5min left; past 140 nothing.
    expect(budgetMinutes({ JOBS_CASCADE_DEADLINE_MS: '9000000', JOBS_CASCADE_WINDOW_MS: '1800000' }, [110, 135, 141]))
      .toEqual([15, 5, 0]);
  });

  it('without a window keeps the run-wide deadline (Argos disabled)', () => {
    expect(budgetMinutes({ JOBS_CASCADE_DEADLINE_MS: '9000000', JOBS_CASCADE_WINDOW_MS: '0' }, [110, 135, 141]))
      .toEqual([15, 15, 9]);
  });
}, 300_000);
