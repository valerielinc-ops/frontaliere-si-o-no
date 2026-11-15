// W0-C: the re-arm classifies the last failure and backs off independently of
// the SHA. Replays the 2026-11-12 incident (20 consecutive `prep` failures with
// one signature, one per ~8 min, on 19 different SHAs).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  changeTouchesFailure,
  countRearmFailuresInWindow,
  decideBuildLocaleRecovery,
  decideFailureBackoff,
  failureBackoffMinutes,
  sequenceConcludedRuns,
  DEFAULT_NON_INFRA_BUDGET_MAX,
} from '../scripts/ci/rearm-deploy-build.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-12T04:56:00.000Z');
const sha = (n: number) => n.toString(16).padStart(40, '0');

/** Build the streak exactly as the I/O shell does, from a list of runs. */
function streakOf(runs: any[], nowMs: number) {
  const { sequence } = sequenceConcludedRuns({ runs, nowMs });
  const latest = sequence[0];
  if (!latest?.failed) return null;
  let streak = 0;
  for (const run of sequence.slice(0, 6)) {
    if (!run.failed) break;
    streak += 1;
  }
  return { latest, streak };
}

describe('failure backoff ladder', () => {
  it('doubles 20 -> 240 for deterministic and 10 -> 60 for unknown, then stays at the cap', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => failureBackoffMinutes('deterministic', n))).toEqual([20, 40, 80, 160, 240, 240]);
    expect([1, 2, 3, 4, 9].map((n) => failureBackoffMinutes('unknown', n))).toEqual([10, 20, 40, 60, 60]);
  });
});

describe('decideFailureBackoff', () => {
  const failure = (over: Record<string, unknown> = {}) => ({
    classification: 'deterministic',
    signature: 'prep::Migrate::ERR_STRING_TOO_LONG',
    streak: 1,
    lastEndedAtMs: T0,
    ...over,
  });

  it('never delays an infrastructure failure: the pre-existing immediate retry stays', () => {
    const d = decideFailureBackoff({ nowMs: T0 + MIN, failure: failure({ classification: 'infra' }), rearmFailuresInWindow: 99 });
    expect(d.action).toBe('proceed');
  });

  it('proceeds when there is no failure streak at all', () => {
    expect(decideFailureBackoff({ nowMs: T0, failure: null }).action).toBe('proceed');
  });

  it('holds a deterministic failure until the window from the END of the last run elapses', () => {
    const early = decideFailureBackoff({ nowMs: T0 + 19 * MIN, failure: failure() });
    expect(early).toMatchObject({ action: 'skip', reason: 'failure-backoff' });
    expect(early.detail).toContain('ERR_STRING_TOO_LONG');
    expect(early.detail).toContain('1x');
    expect(early.nextAtMs).toBe(T0 + 20 * MIN);
    expect(decideFailureBackoff({ nowMs: T0 + 20 * MIN, failure: failure() }).action).toBe('proceed');
  });

  it('uses the shorter unknown ladder', () => {
    const f = failure({ classification: 'unknown' });
    expect(decideFailureBackoff({ nowMs: T0 + 9 * MIN, failure: f }).action).toBe('skip');
    expect(decideFailureBackoff({ nowMs: T0 + 10 * MIN, failure: f }).action).toBe('proceed');
  });

  it('is released early by a commit that touches the failing code or the build tooling', () => {
    const d = decideFailureBackoff({ nowMs: T0 + MIN, failure: failure({ streak: 4 }), touchedSinceFailure: true });
    expect(d).toMatchObject({ action: 'proceed', reason: 'failure-backoff-released' });
  });

  it('keeps an absolute ceiling even when a touching commit would release the backoff', () => {
    const d = decideFailureBackoff({
      nowMs: T0 + 500 * MIN,
      failure: failure(),
      touchedSinceFailure: true,
      rearmFailuresInWindow: DEFAULT_NON_INFRA_BUDGET_MAX,
    });
    expect(d).toMatchObject({ action: 'skip', reason: 'rearm-budget-exhausted' });
  });
});

describe('changeTouchesFailure', () => {
  it('matches the file named by the signature and the build-affecting paths', () => {
    const paths = ['scripts/build-employer-profiles.mjs'];
    expect(changeTouchesFailure(['data/jobs.json', 'scripts/build-employer-profiles.mjs'], paths)).toBe('scripts/build-employer-profiles.mjs');
    for (const file of [
      '.github/workflows/deploy.yml', '.github/workflows/deploy-publish.yml', 'scripts/ci/rearm-deploy-build.mjs',
      'build-plugins/shared/x.ts', 'vite.config.ts', 'package.json', 'package-lock.json',
    ]) expect(changeTouchesFailure([file], [])).toBe(file);
  });
  it('ignores data, docs and unrelated workflows', () => {
    expect(changeTouchesFailure(['data/jobs/x.json', 'docs/a.md', '.github/workflows/tests.yml', 'services/x.ts'], [])).toBeNull();
  });
  it('is fail-safe on an unreadable change list', () => {
    expect(changeTouchesFailure(null as any, ['a'])).toBeNull();
  });
});

describe('sequenceConcludedRuns / countRearmFailuresInWindow', () => {
  it('skips cancelled (superseded) and schedule runs and ranks the caller first', () => {
    const runs = [
      { id: 1, headSha: sha(1), status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', createdAt: '2026-11-12T01:00:00Z', updatedAt: '2026-11-12T01:10:00Z' },
      { id: 2, headSha: sha(2), status: 'completed', conclusion: 'cancelled', event: 'workflow_dispatch', createdAt: '2026-11-12T02:00:00Z' },
      { id: 3, headSha: sha(3), status: 'completed', conclusion: 'failure', event: 'schedule', createdAt: '2026-11-12T03:00:00Z' },
      { id: 9, headSha: sha(9), status: 'in_progress', conclusion: null, event: 'workflow_dispatch', createdAt: '2026-11-12T00:00:00Z' },
    ];
    const { sequence } = sequenceConcludedRuns({ runs, selfRunId: 9, selfConclusion: 'failure', nowMs: Date.parse('2026-11-12T03:30:00Z') });
    expect(sequence.map((r: any) => r.id)).toEqual([9, 1]);
    expect(sequence.every((r: any) => r.failed)).toBe(true);
  });

  it('a green run ends the streak', () => {
    const runs = [
      { id: 1, status: 'completed', conclusion: 'failure', createdAt: '2026-11-12T01:00:00Z' },
      { id: 2, status: 'completed', conclusion: 'success', createdAt: '2026-11-12T02:00:00Z' },
      { id: 3, status: 'completed', conclusion: 'failure', createdAt: '2026-11-12T03:00:00Z' },
    ];
    const s = streakOf(runs, Date.parse('2026-11-12T04:00:00Z'));
    expect(s?.streak).toBe(1);
  });

  it('counts only failed bot-dispatched builds inside the window', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const mk = (id: number, over: Record<string, unknown>) => ({
      id, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', actor: 'github-actions[bot]',
      createdAt: '2026-11-12T10:00:00Z', ...over,
    });
    const runs = [
      mk(1, {}),
      mk(2, { createdAt: '2026-11-11T20:00:00Z' }),          // older than 12 h
      mk(3, { actor: 'some-owner' }),                         // a human dispatch
      mk(4, { conclusion: 'success' }),                       // green
      mk(5, { event: 'schedule' }),
      mk(6, { createdAt: '2026-11-12T11:00:00Z' }),
    ];
    expect(countRearmFailuresInWindow({ runs, nowMs: now })).toBe(2);
  });
});

describe('replay of 2026-11-12 04:56-08:13Z', () => {
  it('19 identical failures on 19 SHAs, HEAD moving every 8 min: at most 3 re-arm dispatches in 3 h 17 min', () => {
    const RUN_MIN = 8;
    const runs: any[] = [];
    let id = 1;
    const addRun = (startMs: number) => {
      runs.push({
        id: id += 1,
        headSha: sha(id),
        status: 'completed',
        conclusion: 'failure',
        event: 'workflow_dispatch',
        actor: 'github-actions[bot]',
        createdAt: new Date(startMs).toISOString(),
        updatedAt: new Date(startMs + RUN_MIN * MIN).toISOString(),
      });
    };
    addRun(T0 - RUN_MIN * MIN); // the failure that opens the incident
    let dispatches = 0;
    let busyUntil = T0;
    // the watchdog ticks every 10 minutes for 3 h 17 min; HEAD is new every tick
    for (let t = T0; t <= T0 + 197 * MIN; t += 10 * MIN) {
      if (t < busyUntil) continue;                      // a build is still running
      const streak = streakOf(runs, t);
      const decision = decideFailureBackoff({
        nowMs: t,
        failure: streak && {
          classification: 'deterministic',
          signature: 'prep::Migrate::ERR_STRING_TOO_LONG',
          streak: streak.streak,
          lastEndedAtMs: streak.latest.endedAtMs,
        },
        touchedSinceFailure: false,     // compare unreadable / nothing relevant changed
        rearmFailuresInWindow: countRearmFailuresInWindow({ runs, nowMs: t }),
      });
      if (decision.action === 'proceed') {
        dispatches += 1;
        addRun(t);
        busyUntil = t + RUN_MIN * MIN;
      }
    }
    expect(dispatches).toBeGreaterThan(0);
    expect(dispatches).toBeLessThanOrEqual(3);
  });

  it('twenty such runs are cut off by the 6/12 h budget even if the ladder allowed them', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const runs = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', actor: 'github-actions[bot]',
      createdAt: new Date(now - (i + 1) * 60 * MIN).toISOString(),
    }));
    const failures = countRearmFailuresInWindow({ runs, nowMs: now });
    expect(failures).toBeGreaterThanOrEqual(DEFAULT_NON_INFRA_BUDGET_MAX);
    const d = decideFailureBackoff({
      nowMs: now,
      failure: { classification: 'deterministic', signature: 's', streak: 1, lastEndedAtMs: now - 24 * 60 * MIN },
      rearmFailuresInWindow: failures,
    });
    expect(d.reason).toBe('rearm-budget-exhausted');
  });

  it('a different signature restarts the counter (the streak follows the failure key)', () => {
    const runs = [
      { id: 3, status: 'completed', conclusion: 'failure', createdAt: '2026-11-12T03:00:00Z', key: 'b' },
      { id: 2, status: 'completed', conclusion: 'failure', createdAt: '2026-11-12T02:00:00Z', key: 'a' },
      { id: 1, status: 'completed', conclusion: 'failure', createdAt: '2026-11-12T01:00:00Z', key: 'a' },
    ];
    const { sequence } = sequenceConcludedRuns({ runs, nowMs: Date.parse('2026-11-12T04:00:00Z') });
    let streak = 0;
    for (const run of sequence) { if ((run as any).key !== (sequence[0] as any).key) break; streak += 1; }
    expect(streak).toBe(1);
    expect(failureBackoffMinutes('deterministic', streak)).toBe(20);
  });
});

describe('memory-class locale recovery (replay of run 43582924519)', () => {
  const HEAD = 'a'.repeat(40);
  const run = { id: 42, name: 'Deploy to GitHub Pages', head_branch: 'main', head_sha: HEAD, run_attempt: 1, workflow_url: 'x' };
  const workflow = { path: '.github/workflows/deploy.yml' };
  const artifacts = [{ name: 'prepared-snapshot', expired: false, workflow_run: { id: 42 } }];
  const leg = (locale: string, id: number, conclusion: string) => ({
    id, run_id: 42, run_attempt: 1, head_sha: HEAD, name: `build-locale (${locale})`, status: 'completed', conclusion,
    completed_at: '2026-11-14T10:00:00Z', check_run_url: `https://api.github.com/repos/o/r/check-runs/${id}`,
    steps: [{ name: `Build (BUILD_LOCALE=${locale})`, status: 'completed', conclusion: conclusion === 'success' ? 'success' : 'failure' }],
  });
  const decide = (jobs: any[], annotationsByJob: any) => decideBuildLocaleRecovery({
    run, workflow, jobs, artifacts, annotationsByJob, expectedSha: HEAD, nowMs: Date.parse('2026-11-14T11:00:00Z'),
  });

  it('IT OOM (exit 134) with de/fr/en green -> rerun of the IT leg only', () => {
    const d = decide(
      [leg('de', 1, 'success'), leg('fr', 2, 'success'), leg('en', 3, 'success'), leg('it', 4, 'failure')],
      { 4: [{ annotation_level: 'failure', message: 'Process completed with exit code 134.' }] },
    );
    expect(d.action).toBe('rerun');
    expect(d.reason).toBe('memory');
    expect(d.job?.name).toBe('build-locale (it)');
  });

  it('the build memory guard abort is recoverable the same way', () => {
    const d = decide(
      [leg('de', 1, 'success'), leg('it', 4, 'failure')],
      { 4: [{ annotation_level: 'failure', message: '[build-mem-guard] preflight failed' }] },
    );
    expect(d).toMatchObject({ action: 'rerun', reason: 'memory' });
  });

  it('an ordinary failure (test assertion) is not mistaken for memory', () => {
    const d = decide(
      [leg('de', 1, 'success'), leg('it', 4, 'failure')],
      { 4: [{ annotation_level: 'failure', message: 'AssertionError: nope' }] },
    );
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('no-retryable-locale-leg');
  });

  it('does not rerun one leg when a sibling also failed', () => {
    const d = decide(
      [leg('de', 1, 'failure'), leg('it', 4, 'failure')],
      { 1: [{ annotation_level: 'failure', message: 'exit code 134' }], 4: [{ annotation_level: 'failure', message: 'exit code 134' }] },
    );
    expect(d.action).toBe('skip');
  });

  it('keeps the cap of one recovery attempt', () => {
    const d = decideBuildLocaleRecovery({
      run: { ...run, run_attempt: 2 }, workflow,
      jobs: [{ ...leg('it', 4, 'failure'), run_attempt: 2 }],
      artifacts, annotationsByJob: { 4: [{ annotation_level: 'failure', message: 'exit code 134' }] },
      expectedSha: HEAD, currentAttempt: 2, nowMs: Date.parse('2026-11-14T11:00:00Z'),
    });
    expect(d.reason).toBe('recovery-attempt-cap');
  });
});

describe('workflow wiring', () => {
  const deploy = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8');
  const watchdog = readFileSync(resolve('.github/workflows/deploy-stalled-watchdog.yml'), 'utf8');
  it('every light resolver checkout carries the classifier module', () => {
    expect(deploy).toContain('/scripts/ci/deploy-failure-classifier.mjs');
    expect(watchdog).toContain('/scripts/ci/deploy-failure-classifier.mjs');
  });
  it('only the final rearm job files the blocked-build issue', () => {
    const doc = YAML.parse(deploy) as any;
    const withIssues = Object.entries(doc.jobs)
      .filter(([, job]: any) => job.steps?.some((s: any) => s.env?.REARM_ISSUE_UPDATE === '1'))
      .map(([name]) => name);
    expect(withIssues).toEqual(['rearm']);
    expect(doc.jobs.rearm.permissions.issues).toBe('write');
    expect(doc.jobs['schedule-reconcile'].permissions.issues).toBeUndefined();
  });
});
