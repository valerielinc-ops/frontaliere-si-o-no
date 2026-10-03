// @vitest-environment node
/**
 * A run cancelled because a newer run superseded it is not a failure (issue 5253).
 *
 * Two halves:
 *  - the pure verdict of scripts/ci/run-superseded.mjs, which must only say
 *    `superseded` when a newer run exists AND the cancellation does not look
 *    like a timeout, and must fail closed on anything unreadable;
 *  - a contract on EVERY workflow: a failure reporter that fires on
 *    `cancelled()` in a job with `cancel-in-progress: true` must carry the
 *    supersession guard. A second workflow that adopts the same combination
 *    fails here instead of re-opening its failure issue on every hand-off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  CONCURRENCY_ANNOTATION_RE,
  TIMEOUT_MARGIN_MINUTES,
  decideSuperseded,
} from '../scripts/ci/run-superseded.mjs';
import { REPORT_ACTION_USES } from '../scripts/ci/failure-issue-inventory.mjs';
import { TIMEOUT_ANNOTATION_RE } from '../scripts/ci/lib/deploy-job-failure-signature.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
const DETECTOR = 'scripts/ci/run-superseded.mjs';

/* ── pure verdict ──────────────────────────────────────────────────── */

const MIN = 60_000;
const RUN_START = '2026-10-03T09:12:32Z';
const JOB_START = '2026-10-03T09:12:35Z';
const startMs = Date.parse(JOB_START);
const NEWER = { id: 37112995632, created_at: '2026-10-03T09:25:23Z' };
const SELF = { id: 37112269877, created_at: RUN_START };
const OLDER = { id: 37066771243, created_at: '2026-10-02T21:25:42Z' };
const CONCURRENCY_NOTE = { message: 'Canceling since a higher priority waiting request for audit-parser-quality exists' };
const TIMEOUT_NOTE = { message: 'The job running on runner X has exceeded the maximum execution time of 60 minutes.' };

function base(overrides: Record<string, unknown> = {}) {
  return {
    runId: SELF.id,
    runStartedAt: RUN_START,
    runs: [NEWER, SELF, OLDER],
    annotations: [CONCURRENCY_NOTE],
    jobStartedAt: JOB_START,
    timeoutMinutes: '60',
    nowMs: startMs + 13 * MIN,
    ...overrides,
  };
}

describe('run-superseded: verdict (issue 5253)', () => {
  it('newer run, no timeout annotation, far from the limit -> superseded (run 37112269877)', () => {
    const v = decideSuperseded(base());
    expect(v).toMatchObject({ superseded: true, reason: 'superseded', newerRunId: NEWER.id });
    expect(v.concurrencyAnnotation).toBe(true);
  });

  it('the concurrency annotation is a confirmation, not a requirement', () => {
    expect(decideSuperseded(base({ annotations: [] })).superseded).toBe(true);
    expect(decideSuperseded(base({ annotations: [] })).concurrencyAnnotation).toBe(false);
    expect(CONCURRENCY_ANNOTATION_RE.test(CONCURRENCY_NOTE.message)).toBe(true);
  });

  it('newer run but a timeout annotation -> report', () => {
    expect(decideSuperseded(base({ annotations: [CONCURRENCY_NOTE, TIMEOUT_NOTE] })))
      .toMatchObject({ superseded: false, reason: 'timeout-annotation' });
  });

  it('newer run but elapsed time at the edge of the limit -> report', () => {
    const edge = startMs + (60 - TIMEOUT_MARGIN_MINUTES) * MIN;
    expect(decideSuperseded(base({ nowMs: edge }))).toMatchObject({ superseded: false, reason: 'near-timeout-limit' });
    expect(decideSuperseded(base({ nowMs: startMs + 60 * MIN }))).toMatchObject({ superseded: false });
    expect(decideSuperseded(base({ nowMs: edge - 1 })).superseded).toBe(true);
  });

  it('no newer run (manual cancel, or only older runs) -> report', () => {
    expect(decideSuperseded(base({ runs: [SELF, OLDER] }))).toMatchObject({ superseded: false, reason: 'no-newer-run' });
    // A re-run attempt: only this attempt's start counts, not the run's creation.
    expect(decideSuperseded(base({ runStartedAt: '2026-10-03T09:30:00Z' })).superseded).toBe(false);
  });

  it('uses the same timeout signature as the job-timeout monitor (parity)', () => {
    // scan-job-timeouts.mjs keeps its own copy of the regex: if the two drift,
    // a timeout the monitor recognises could be read here as a supersession.
    const monitor = fs.readFileSync(path.join(ROOT, 'scripts/ci/scan-job-timeouts.mjs'), 'utf8');
    const literal = monitor.match(/^const TIMEOUT_ANNOTATION_RE = (\/.+\/[a-z]*);$/m);
    expect(literal, 'TIMEOUT_ANNOTATION_RE literal in scan-job-timeouts.mjs').not.toBeNull();
    expect(literal![1]).toBe(String(TIMEOUT_ANNOTATION_RE));
  });

  it('anything unreadable -> report (fail-closed)', () => {
    for (const overrides of [
      { runs: null },
      { annotations: null },
      { runStartedAt: undefined },
      { jobStartedAt: null },
      { timeoutMinutes: undefined },
      { timeoutMinutes: 'sixty' },
      { timeoutMinutes: '0' },
    ]) {
      expect(decideSuperseded(base(overrides)).superseded, JSON.stringify(overrides)).toBe(false);
    }
  });
});

/* ── workflow contract ─────────────────────────────────────────────── */

type Step = Record<string, any>;

function isFailureReporter(step: Step): boolean {
  if (step.uses === REPORT_ACTION_USES) return (step.with?.mode ?? 'report') !== 'resolve';
  const run = typeof step.run === 'string' ? step.run : '';
  return (run.includes('github-issue-creator.mjs') && !/--resolve\b/.test(run))
    || run.includes('report-workflow-failure.mjs');
}

/**
 * Offenders of the supersession-guard contract in one workflow source.
 * Empty when the workflow has no cancel-in-progress job with a cancelled()
 * reporter, or when every such reporter is guarded.
 */
function supersededGuardOffenders(source: string, file: string): string[] {
  const doc = YAML.parse(source) ?? {};
  const offenders: string[] = [];
  const cancelsWorkflowWide = doc.concurrency?.['cancel-in-progress'];
  for (const [jobId, job] of Object.entries<any>(doc.jobs ?? {})) {
    const cancels = job?.concurrency?.['cancel-in-progress'] ?? cancelsWorkflowWide;
    if (cancels === undefined || cancels === false || cancels === 'false') continue;
    const steps: Step[] = Array.isArray(job?.steps) ? job.steps : [];
    steps.forEach((step, index) => {
      const cond = String(step.if ?? '');
      if (!isFailureReporter(step) || !/\bcancelled\(\)/.test(cond)) return;
      const where = `${file} job ${jobId} step "${step.name ?? index}"`;
      const guard = cond.match(/steps\.([A-Za-z0-9_-]+)\.outputs\.superseded\s*!=\s*'true'/);
      if (!guard) {
        offenders.push(`${where}: cancelled() reporter without the supersession guard`);
        return;
      }
      const detectorIndex = steps.findIndex((s) => s.id === guard[1]);
      const detector = steps[detectorIndex];
      if (!detector || detectorIndex > index) {
        offenders.push(`${where}: guard step "${guard[1]}" missing or after the reporter`);
        return;
      }
      if (!String(detector.run ?? '').includes(DETECTOR)) {
        offenders.push(`${where}: guard step "${guard[1]}" does not run ${DETECTOR}`);
      }
      if (!/\bcancelled\(\)/.test(String(detector.if ?? ''))) {
        offenders.push(`${where}: guard step "${guard[1]}" lacks an explicit cancelled() (implicit success() never runs it)`);
      }
      if (!detector.env?.GH_TOKEN) offenders.push(`${where}: guard step "${guard[1]}" has no GH_TOKEN`);
      if (String(detector.env?.JOB_TIMEOUT_MINUTES ?? '') !== String(job['timeout-minutes'] ?? '')) {
        offenders.push(`${where}: JOB_TIMEOUT_MINUTES=${detector.env?.JOB_TIMEOUT_MINUTES} != timeout-minutes=${job['timeout-minutes']}`);
      }
    });
  }
  return offenders;
}

function workflowFiles(): string[] {
  return fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
}

describe('Reporter su cancelled() senza guardia di sostituzione in un workflow cancel-in-progress', () => {
  it('every cancelled() failure reporter in a cancel-in-progress job is guarded', () => {
    const offenders = workflowFiles().flatMap((f) =>
      supersededGuardOffenders(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'), f));
    expect(offenders).toEqual([]);
  });

  it('the contract is not vacuous: audit-parser-quality is in its population', () => {
    const src = fs.readFileSync(path.join(WORKFLOWS_DIR, 'audit-parser-quality.yml'), 'utf8');
    const unguarded = src.replace(
      "if: failure() || (cancelled() && steps.superseded.outputs.superseded != 'true')",
      'if: failure() || cancelled()',
    );
    expect(unguarded).not.toBe(src);
    expect(supersededGuardOffenders(unguarded, 'audit-parser-quality.yml')).not.toEqual([]);
  });

  it('flags a guard whose timeout drifts from the job timeout-minutes', () => {
    const src = fs.readFileSync(path.join(WORKFLOWS_DIR, 'audit-parser-quality.yml'), 'utf8');
    // Anchored to the job key: the header comment also mentions `timeout-minutes:`.
    const drifted = src.replace(/^ {4}timeout-minutes: (\d+)$/m, (_, n) => `    timeout-minutes: ${Number(n) + 30}`);
    expect(drifted).not.toBe(src);
    expect(supersededGuardOffenders(drifted, 'audit-parser-quality.yml').join('\n')).toMatch(/JOB_TIMEOUT_MINUTES/);
  });

  it('flags a detector without an explicit cancelled() status function', () => {
    const src = fs.readFileSync(path.join(WORKFLOWS_DIR, 'audit-parser-quality.yml'), 'utf8');
    const implicit = src.replace(/(id: superseded\n\s+)if: cancelled\(\)\n\s+/, '$1');
    expect(implicit).not.toBe(src);
    expect(supersededGuardOffenders(implicit, 'audit-parser-quality.yml').join('\n')).toMatch(/explicit cancelled\(\)/);
  });
});
