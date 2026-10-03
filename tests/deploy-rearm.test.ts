// Guards for #5349 — the deploy re-arm.
//
// THE MEASUREMENT this file encodes. Over the 100 deploy.yml runs from
// 2026-08-06T12:37Z to 2026-08-08T05:58Z (~41 h): 82 cancelled, 10 success,
// 6 failure, 2 in flight. The 82 cancellations are newest-wins working as
// designed (deploy.yml's paths-ignore comment records 121/121 of them starting
// zero jobs), so they are NOT what this fixes. Exactly one moment in that
// window had a run reach a terminal state with nothing queued behind it — a
// `failure` at 2026-08-06T16:27:57Z, after which the pipeline sat idle for
// 412 minutes. That is the hole.
//
// So the tests come in two halves, and the second is the important one:
//   - the pipeline HAS stopped → dispatch exactly one build;
//   - the pipeline is still moving → do nothing at all, because a dispatch
//     into a full concurrency group evicts the pending run it would be waiting
//     for, and because 99 of those 100 runs are in this state.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  decideBuildLocaleRecovery,
  decideRearm,
  DEFAULT_MAX_BUILDS_PER_SHA,
  DEFAULT_MAX_LOCALE_RECOVERY_ATTEMPTS,
} from '../scripts/ci/rearm-deploy-build.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SELF = 999;

type Run = { id: number | string; headSha: string; status: string; conclusion?: string | null };
const done = (id: number, headSha: string, conclusion: string): Run => ({ id, headSha, status: 'completed', conclusion });
const live = (id: number, headSha: string, status: string): Run => ({ id, headSha, status, conclusion: null });
/** The caller: in_progress by definition, and about to end non-success. */
const selfRun = (headSha = HEAD): Run => ({ id: SELF, headSha, status: 'in_progress', conclusion: null });

const RECOVERY_RUN = {
  id: 42,
  name: 'Deploy to GitHub Pages',
  path: '.github/workflows/deploy.yml',
  head_branch: 'main',
  head_sha: HEAD,
  run_attempt: 1,
};
const PREPARED_SNAPSHOT = {
  name: 'prepared-snapshot',
  expired: false,
  workflow_run: { id: RECOVERY_RUN.id },
};
const RECOVERY_NOW = Date.parse('2026-10-03T01:00:00.000Z');
const RECOVERY_COMPLETED_AT = '2026-10-03T00:55:00.000Z';

function localeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    run_id: RECOVERY_RUN.id,
    run_attempt: 1,
    head_sha: HEAD,
    name: 'build-locale (de)',
    status: 'completed',
    conclusion: 'failure',
    completed_at: RECOVERY_COMPLETED_AT,
    check_run_url: 'https://api.github.com/repos/o/r/check-runs/100',
    steps: [
      { number: 15, name: 'Build (BUILD_LOCALE=de)', status: 'in_progress', conclusion: null },
      { number: 59, name: 'Report failure to GitHub Issues (build)', status: 'pending', conclusion: null },
    ],
    ...overrides,
  };
}

describe('targeted build-locale recovery — host loss/timeout only', () => {
  it('retries exactly the one leg whose Build step was host-killed', () => {
    const decision = decideBuildLocaleRecovery({
      run: RECOVERY_RUN,
      jobs: [localeJob()],
      artifacts: [PREPARED_SNAPSHOT],
      expectedSha: HEAD,
      nowMs: RECOVERY_NOW,
    });

    expect(DEFAULT_MAX_LOCALE_RECOVERY_ATTEMPTS).toBe(1);
    expect(decision.action).toBe('rerun');
    expect(decision.reason).toBe('host-loss');
    expect(decision.job?.name).toBe('build-locale (de)');
  });

  it('does not reinterpret a concluded application failure as host loss', () => {
    const decision = decideBuildLocaleRecovery({
      run: RECOVERY_RUN,
      jobs: [localeJob({
        steps: [
          { number: 15, name: 'Build (BUILD_LOCALE=de)', status: 'completed', conclusion: 'failure' },
          { number: 59, name: 'Report failure to GitHub Issues (build)', status: 'completed', conclusion: 'success' },
        ],
      })],
      artifacts: [PREPARED_SNAPSHOT],
      expectedSha: HEAD,
      nowMs: RECOVERY_NOW,
    });

    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('no-retryable-locale-leg');
  });

  it('accepts only the proven job-timeout annotation as the other transient signature', () => {
    const decision = decideBuildLocaleRecovery({
      run: RECOVERY_RUN,
      jobs: [localeJob({
        conclusion: 'cancelled',
        steps: [{ number: 15, name: 'Build (BUILD_LOCALE=de)', status: 'completed', conclusion: 'cancelled' }],
      })],
      artifacts: [PREPARED_SNAPSHOT],
      annotationsByJob: {
        100: [{ message: 'The job exceeded the maximum execution time of 360 minutes.' }],
      },
      expectedSha: HEAD,
      nowMs: RECOVERY_NOW,
    });

    expect(decision.action).toBe('rerun');
    expect(decision.reason).toBe('timeout');
  });

  it('stops after one job-level recovery attempt', () => {
    const decision = decideBuildLocaleRecovery({
      run: { ...RECOVERY_RUN, run_attempt: 2 },
      jobs: [localeJob({ run_attempt: 2 })],
      artifacts: [PREPARED_SNAPSHOT],
      expectedSha: HEAD,
      currentAttempt: 2,
      nowMs: RECOVERY_NOW,
    });

    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('recovery-attempt-cap');
  });

  it('fails closed when the snapshot or failed leg is not bound to the same SHA/run', () => {
    const wrongSnapshot = { ...PREPARED_SNAPSHOT, workflow_run: { id: 999 } };
    const wrongSha = localeJob({ head_sha: OLD });

    expect(decideBuildLocaleRecovery({
      run: RECOVERY_RUN,
      jobs: [localeJob()],
      artifacts: [wrongSnapshot],
      expectedSha: HEAD,
      nowMs: RECOVERY_NOW,
    }).reason).toBe('snapshot-provenance-mismatch');

    expect(decideBuildLocaleRecovery({
      run: RECOVERY_RUN,
      jobs: [wrongSha],
      artifacts: [PREPARED_SNAPSHOT],
      expectedSha: HEAD,
      nowMs: RECOVERY_NOW,
    }).reason).toBe('no-retryable-locale-leg');
  });

  it('refuses a partial choice when more than one locale leg has the signature', () => {
    const decision = decideBuildLocaleRecovery({
      run: RECOVERY_RUN,
      jobs: [
        localeJob(),
        localeJob({
          id: 101,
          name: 'build-locale (fr)',
          steps: [
            { number: 15, name: 'Build (BUILD_LOCALE=fr)', status: 'in_progress', conclusion: null },
            { number: 59, name: 'Report failure to GitHub Issues (build)', status: 'pending', conclusion: null },
          ],
        }),
      ],
      artifacts: [PREPARED_SNAPSHOT],
      expectedSha: HEAD,
      nowMs: RECOVERY_NOW,
    });

    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('ambiguous-retryable-locale-legs');
  });
});

describe('decideRearm — the pipeline has STOPPED with work outstanding (#5349)', () => {
  it('reproduces 2026-08-06T16:27:57Z: a failed run, nothing queued → dispatch one build', () => {
    // The 412-minute idle window, in miniature. Before this change nothing
    // restarted the pipeline here; a human push did, seven hours later.
    const v = decideRearm({
      headSha: HEAD,
      runs: [selfRun(), done(1, OLD, 'cancelled'), done(2, OLD, 'success')],
      selfRunId: SELF,
    });
    expect(v.action).toBe('dispatch');
    expect(v.reason).toBe('pipeline-stopped');
  });

  it('re-arms for the CURRENT head even when a pile of older commits was superseded', () => {
    // THE STORM CASE. Twelve cancelled runs across twelve superseded commits
    // must produce ONE dispatch, not twelve — and it must target HEAD, not any
    // of them. This holds by construction: the decision names a single sha.
    const runs: Run[] = [selfRun(), ...Array.from({ length: 12 }, (_, i) => done(i + 1, `sha-${i}`, 'cancelled'))];
    const v = decideRearm({ headSha: HEAD, runs, selfRunId: SELF });
    expect(v.action).toBe('dispatch');
    // One decision, one sha, one dispatch — there is no per-commit branch to
    // fan out over.
    expect(v.detail).toContain(HEAD);
  });
});

describe('decideRearm — the pipeline is still MOVING (99 of the 100 measured runs)', () => {
  it.each([['queued'], ['in_progress'], ['waiting'], ['requested'], ['pending']])(
    'another run is %s → skip, because dispatching would evict the pending run itself',
    (status) => {
      const v = decideRearm({ headSha: HEAD, runs: [selfRun(), live(1, HEAD, status)], selfRunId: SELF });
      expect(v.action).toBe('skip');
      expect(v.reason).toBe('pipeline-moving');
    },
  );

  it('the caller’s OWN run does not count as "still moving" (it is in_progress by definition)', () => {
    // Without excluding self, the check would always see one in-flight run and
    // the re-arm would never fire at all — a silent no-op that still looks wired.
    const v = decideRearm({ headSha: HEAD, runs: [selfRun()], selfRunId: SELF });
    expect(v.action).toBe('dispatch');
  });

  it('HEAD already has a green build → skip: the invariant already holds', () => {
    const v = decideRearm({
      headSha: HEAD,
      runs: [selfRun(), done(1, HEAD, 'success')],
      selfRunId: SELF,
    });
    expect(v.action).toBe('skip');
    expect(v.reason).toBe('head-already-built');
  });

  it('a green build on a DIFFERENT sha does not satisfy HEAD', () => {
    // The negative counterpart: "some build succeeded recently" is not the
    // invariant. It has to be a build of the commit that is live-facing now.
    const v = decideRearm({ headSha: HEAD, runs: [selfRun(), done(1, OLD, 'success')], selfRunId: SELF });
    expect(v.action).toBe('dispatch');
  });

  it('an unresolvable HEAD fails CLOSED — not knowing what to build means not building', () => {
    const v = decideRearm({ headSha: '', runs: [], selfRunId: SELF });
    expect(v.action).toBe('skip');
    expect(v.reason).toBe('no-head-sha');
  });
});

describe('decideRearm — recursion is bounded by a per-SHA cap, not by hope', () => {
  it('the cap counts the caller’s own run, so a re-armed chain is one retry long', () => {
    // Step 1: our run failed, no prior attempt for HEAD → retry (attempts = 1).
    const first = decideRearm({ headSha: HEAD, runs: [selfRun()], selfRunId: SELF });
    expect(first.action).toBe('dispatch');

    // Step 2: the re-armed build (id 1) also failed and is now itself the
    // caller. HEAD now has 2 attempts — our own plus the completed one — so the
    // chain STOPS. This is the property that makes recursion impossible rather
    // than unlikely: each re-arm strictly consumes cap.
    const second = decideRearm({
      headSha: HEAD,
      runs: [{ id: 1, headSha: HEAD, status: 'in_progress', conclusion: null }, done(SELF, HEAD, 'failure')],
      selfRunId: 1,
    });
    expect(second.action).toBe('skip');
    expect(second.reason).toBe('attempt-cap');
  });

  it('the cap is per-sha: a NEW commit gets its own budget', () => {
    // The regression this blocks is a global cooldown, which would stop
    // re-arming after any two failures anywhere and quietly reopen the hole.
    const exhausted: Run[] = [done(1, OLD, 'failure'), done(2, OLD, 'failure')];
    expect(decideRearm({ headSha: OLD, runs: [...exhausted, selfRun(OLD)], selfRunId: SELF }).action).toBe('skip');
    expect(decideRearm({ headSha: HEAD, runs: [...exhausted, selfRun()], selfRunId: SELF }).action).toBe('dispatch');
  });

  it('the cap is configurable but defaults to exactly one retry', () => {
    expect(DEFAULT_MAX_BUILDS_PER_SHA).toBe(2);
    const runs: Run[] = [selfRun(), done(1, HEAD, 'failure')];
    expect(decideRearm({ headSha: HEAD, runs, selfRunId: SELF }).action).toBe('skip');
    expect(decideRearm({ headSha: HEAD, runs, selfRunId: SELF, maxBuildsPerSha: 3 }).action).toBe('dispatch');
  });

  it('cancelled-while-pending runs consume cap too, and that is correct', () => {
    // A pending-cancel for a sha that is STILL head means the newer arrival was
    // for the same commit; treating it as an attempt keeps the bound provable.
    // (For a superseded commit the question never arises — it is not HEAD.)
    const v = decideRearm({
      headSha: HEAD,
      runs: [selfRun(), done(1, HEAD, 'cancelled')],
      selfRunId: SELF,
    });
    expect(v.action).toBe('skip');
    expect(v.reason).toBe('attempt-cap');
  });
});

describe('deploy.yml — the rearm job is wired so it can only ever ADD a build', () => {
  const DEPLOY_YML = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8');
  const doc = YAML.parse(DEPLOY_YML) as {
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    jobs: Record<string, { needs?: string[]; if?: string; permissions?: Record<string, string>; steps?: unknown[] }>;
  };

  it('runs after the build, on main only, and always() so a FAILED build still re-arms', () => {
    const job = doc.jobs.rearm;
    expect(job, 'rearm job missing from deploy.yml').toBeTruthy();
    expect(job.needs).toContain('build-locale');
    // The measured hole was a `failure`, so the job must not be gated on success.
    expect(job.if).toMatch(/always\(\)/);
    expect(job.if, 'must never re-arm off a non-main ref').toMatch(/github\.ref == 'refs\/heads\/main'/);
  });

  it('has exactly the permissions the dispatch needs and nothing more', () => {
    expect(doc.jobs.rearm.permissions).toEqual({ contents: 'read', actions: 'write' });
  });

  it('cannot fail the deploy: the re-arm step is continue-on-error', () => {
    // A red job here would stack a second failure on top of the one that
    // stopped the pipeline — and the publish-lag watchdog is still the backstop.
    const raw = DEPLOY_YML.slice(DEPLOY_YML.indexOf('\n  rearm:'));
    expect(raw).toMatch(/continue-on-error: true/);
    expect(raw).toMatch(/node scripts\/ci\/rearm-deploy-build\.mjs/);
    expect(raw, 'the per-sha cap must be pinned in the workflow, not left implicit').toMatch(
      /REARM_MAX_BUILDS_PER_SHA: '2'/,
    );
    expect(raw, 'the targeted locale recovery cap must stay at one job rerun').toMatch(
      /REARM_MAX_LOCALE_RECOVERY_ATTEMPTS: '1'/,
    );
  });

  it('the build concurrency group is UNCHANGED — re-arm adds an edge, it does not relax the lock', () => {
    // The tempting wrong fix is to flip cancel-in-progress or widen the group.
    // Either would let two builds race the same CDN / shard force-push targets,
    // which is the invariant build-locale's own comment relies on.
    expect(doc.concurrency?.group).toBe('pages-build-run');
    expect(doc.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('the push trigger is UNCHANGED — the re-arm is not a debounce in disguise', () => {
    // Route 1 (schedule instead of push) was rejected because it charges every
    // urgent merge the debounce interval, and would not have helped at all in
    // the measured incident: the queue was empty, not overfull.
    const on = (YAML.parse(DEPLOY_YML) as { on?: Record<string, unknown> }).on ?? {};
    expect(Object.keys(on), 'deploy.yml must still build on push to main').toContain('push');
    expect(Object.keys(on), 'a schedule trigger would be the debounce this deliberately avoids').not.toContain(
      'schedule',
    );
  });
});
