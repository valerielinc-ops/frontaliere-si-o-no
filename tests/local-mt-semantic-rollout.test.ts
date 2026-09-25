import { describe, expect, it } from 'vitest';
import {
  classifyMopupStructure,
  commitMopupCandidate,
  shadowWithheldOverwrite,
} from '../scripts/local-mt-mopup.mjs';
import {
  createSemanticRollout,
  createSemanticRolloutFromEnv,
  DEFAULT_LOCAL_MT_SEMANTIC_MAX_OVERWRITES,
  formatSemanticTelemetry,
  HARD_MAX_LOCAL_MT_SEMANTIC_OVERWRITES,
  parseSemanticLimit,
  semanticBucketOf,
  semanticBucketOfVerdict,
  semanticWriteKind,
} from '../scripts/lib/local-mt-semantic-rollout.mjs';
import { createSemanticRollbackGuard } from '../scripts/lib/local-mt-semantic-policy.mjs';

// #9677: bounded rollout, telemetry and kill-switch around the #9675 semantic
// gate and the #9676 overwrite policy (whose run rollback guard is reused, not
// duplicated). Every case goes through commitMopupCandidate(), the one place the
// mop-up assigns a translated field, so "not written" means the job object is
// byte-identical afterwards.

// German title in the Italian slot: the language arm wants to OVERWRITE it.
function overwriteJob(id = 1) {
  return {
    sourceLang: 'de',
    title: 'Gefängnisseelsorger',
    company: '',
    location: '',
    slug: `gefaengnisseelsorger-${id}`,
    titleByLocale: { de: 'Gefängnisseelsorger', it: 'Aushilfe Verkauf' },
  };
}

// Empty Italian slot: a plain FILL.
function fillJob(id = 1) {
  return {
    sourceLang: 'de',
    title: 'Gefängnisseelsorger',
    company: '',
    location: '',
    slug: `gefaengnisseelsorger-${id}`,
    titleByLocale: { de: 'Gefängnisseelsorger' },
  };
}

function candidateFor(job: ReturnType<typeof overwriteJob>, rawText = 'Cappellano carcerario') {
  return classifyMopupStructure({ job, locale: 'it', field: 'title', rawText });
}

function countingJudge(verdict: unknown | (() => unknown)) {
  const judge = async () => {
    judge.calls += 1;
    if (typeof verdict === 'function') return (verdict as () => unknown)();
    return verdict;
  };
  judge.calls = 0;
  return judge;
}

const ACCEPT = { accepted: true, score: 0.95, threshold: 0.8, reason: 'semantic-match' };
const REJECT = { accepted: false, score: 0.4, threshold: 0.8, reason: 'semantic-mismatch' };

describe('semantic rollout: default-off kill-switch', () => {
  it('reads LOCAL_MT_LANG_AWARE_OVERWRITE as the kill-switch and defaults to shadow with a finite cap', () => {
    const snapshot = createSemanticRolloutFromEnv({}).snapshot();
    expect(snapshot.killSwitch).toEqual({
      variable: 'LOCAL_MT_LANG_AWARE_OVERWRITE',
      overwritesEnabled: false,
      mode: 'shadow',
    });
    expect(snapshot.cap.maxOverwrites).toBe(DEFAULT_LOCAL_MT_SEMANTIC_MAX_OVERWRITES);
    expect(Number.isFinite(snapshot.cap.maxOverwrites)).toBe(true);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.rollback).toBeNull();
    expect(snapshot).not.toHaveProperty('errorStop');
    expect(createSemanticRolloutFromEnv({ LOCAL_MT_LANG_AWARE_OVERWRITE: '1' }).overwritesEnabled).toBe(true);
    expect(createSemanticRolloutFromEnv({ LOCAL_MT_LANG_AWARE_OVERWRITE: 'true' }).overwritesEnabled).toBe(false);
  });

  it('withholds an accepted overwrite when the switch is off, without calling the judge', async () => {
    const job = overwriteJob();
    const before = structuredClone(job);
    const rollout = createSemanticRollout();
    const judge = countingJudge(ACCEPT);

    const result = await commitMopupCandidate({
      job, locale: 'it', field: 'title', candidate: candidateFor(job), judge, rollout,
    });

    expect(result).toMatchObject({ written: false, decision: 'withheld:kill-switch' });
    expect(judge.calls).toBe(0);
    expect(job).toEqual(before);
    expect(rollout.snapshot().withheld).toMatchObject({ 'kill-switch': 1, total: 1 });
  });

  it('still fills an empty slot with the switch off', async () => {
    const job = fillJob();
    const rollout = createSemanticRollout();

    const result = await commitMopupCandidate({
      job, locale: 'it', field: 'title', candidate: candidateFor(job), judge: countingJudge(ACCEPT), rollout,
    });

    expect(result).toMatchObject({ written: true, decision: 'write' });
    expect(job.titleByLocale).toMatchObject({ it: 'Cappellano carcerario' });
    expect(rollout.snapshot().written).toMatchObject({ fill: 1, overwrite: 0, total: 1 });
  });
});

describe('semantic rollout: hard cap', () => {
  it('writes at most maxOverwrites overwrites and withholds the rest unjudged', async () => {
    const rollout = createSemanticRollout({ overwritesEnabled: true, maxOverwrites: 2 });
    const judge = countingJudge(ACCEPT);
    const outcomes: string[] = [];
    const jobs = [1, 2, 3, 4].map(overwriteJob);
    const befores = jobs.map((job) => structuredClone(job));

    for (const job of jobs) {
      const result = await commitMopupCandidate({
        job, locale: 'it', field: 'title', candidate: candidateFor(job), judge, rollout,
      });
      outcomes.push(result.decision);
    }

    expect(outcomes).toEqual(['write', 'write', 'withheld:cap', 'withheld:cap']);
    expect(judge.calls).toBe(2);
    expect(jobs[2]).toEqual(befores[2]);
    expect(jobs[3]).toEqual(befores[3]);
    const snapshot = rollout.snapshot();
    expect(snapshot.status).toBe('capped');
    expect(snapshot.cap).toMatchObject({ maxOverwrites: 2, reached: true });
    expect(snapshot.written).toMatchObject({ overwrite: 2, total: 2 });
    expect(snapshot.withheld).toMatchObject({ cap: 2, total: 2 });
  });

  it('holds at the write itself when two commits race past the pre-judge check', async () => {
    const rollout = createSemanticRollout({ overwritesEnabled: true, maxOverwrites: 1 });
    const jobs = [overwriteJob(1), overwriteJob(2)];
    const results = await Promise.all(jobs.map((job) => commitMopupCandidate({
      job, locale: 'it', field: 'title', candidate: candidateFor(job), judge: countingJudge(ACCEPT), rollout,
    })));

    expect(results.filter((result) => result.written)).toHaveLength(1);
    expect(results.map((result) => result.decision).sort()).toEqual(['withheld:cap', 'write']);
    expect(jobs.filter((job) => job.titleByLocale.it === 'Cappellano carcerario')).toHaveLength(1);
  });

  it('a cap of 0 is a valid stop: no overwrite is written', async () => {
    const job = overwriteJob();
    const rollout = createSemanticRollout({ overwritesEnabled: true, maxOverwrites: '0' });
    const result = await commitMopupCandidate({
      job, locale: 'it', field: 'title', candidate: candidateFor(job), judge: countingJudge(ACCEPT), rollout,
    });
    expect(result.decision).toBe('withheld:cap');
    expect(job.titleByLocale.it).toBe('Aushilfe Verkauf');
  });

  it('never parses an infinite, negative or garbage cap, and clamps to the hard max', () => {
    for (const value of ['', 'abc', '-1', '1.5', 'Infinity', undefined, null, Number.POSITIVE_INFINITY]) {
      expect(parseSemanticLimit(value, 7, 100), String(value)).toBe(7);
    }
    expect(parseSemanticLimit('50', 7, 100)).toBe(50);
    expect(parseSemanticLimit('1000000', 7, 100)).toBe(100);
    const rollout = createSemanticRollout({ maxOverwrites: '999999999' });
    expect(rollout.snapshot().cap.maxOverwrites).toBe(HARD_MAX_LOCAL_MT_SEMANTIC_OVERWRITES);
  });
});

describe('semantic rollout: unambiguous verdict counts', () => {
  it('counts accepted, rejected, unclear and error exactly once each', async () => {
    const rollout = createSemanticRollout();
    const verdicts = [
      ACCEPT,
      REJECT,
      { accepted: true, score: Number.NaN },
      () => { throw new Error('onnxruntime crashed'); },
    ];
    const decisions: string[] = [];
    for (const [index, verdict] of verdicts.entries()) {
      const job = fillJob(index);
      const result = await commitMopupCandidate({
        job, locale: 'it', field: 'title', candidate: candidateFor(job), judge: countingJudge(verdict), rollout,
      });
      decisions.push(result.decision);
    }

    expect(decisions).toEqual([
      'write',
      'skip:semantic-mismatch',
      'skip:semantic-unavailable',
      'skip:semantic-unavailable',
    ]);
    const snapshot = rollout.snapshot();
    expect(snapshot.verdicts).toEqual({ accepted: 1, rejected: 1, unclear: 1, error: 1, total: 4 });
    expect(snapshot.written).toEqual({ fill: 1, repair: 0, overwrite: 0, total: 1 });
    expect(snapshot.withheld.total).toBe(0);
  });

  it('maps each judged decision to one bucket, and structural skips to none', () => {
    expect(semanticBucketOf({ decision: 'write' })).toBe('accepted');
    expect(semanticBucketOf({ decision: 'skip:semantic-mismatch' })).toBe('rejected');
    expect(semanticBucketOf({ decision: 'skip:semantic-reject' })).toBe('rejected');
    expect(semanticBucketOf({ decision: 'skip:semantic-unclear' })).toBe('unclear');
    expect(semanticBucketOf({ decision: 'skip:semantic-rollback' })).toBeNull();
    expect(semanticBucketOf({ decision: 'skip:semantic-unavailable', semanticReason: 'embedding-error' })).toBe('error');
    expect(semanticBucketOf({ decision: 'skip:semantic-unavailable', semanticReason: 'judge-error' })).toBe('error');
    expect(semanticBucketOf({ decision: 'skip:semantic-unavailable', semanticReason: 'missing-text' })).toBe('unclear');
    expect(semanticBucketOf({ decision: 'skip:source-copy' })).toBeNull();
    expect(semanticBucketOfVerdict(ACCEPT)).toBe('accepted');
    expect(semanticBucketOfVerdict(REJECT)).toBe('rejected');
    expect(semanticBucketOfVerdict({ accepted: false, score: null, reason: 'embedding-error' })).toBe('error');
    expect(semanticBucketOfVerdict(undefined)).toBe('unclear');
  });

  it('classifies the slot a write would touch', () => {
    expect(semanticWriteKind(candidateFor(overwriteJob()))).toBe('overwrite');
    expect(semanticWriteKind(candidateFor(fillJob()))).toBe('fill');
    expect(semanticWriteKind({ decision: 'write', existing: 'Cap' })).toBe('repair');
  });
});

describe('semantic rollout: the #9676 rollback guard is reused, not duplicated', () => {
  const ECHO = { accepted: true, score: 0.99, threshold: 0.8, reason: 'semantic-match' };

  it('counts the policy verdicts of an overwrite: accepted, rejected (echo)', async () => {
    const rollout = createSemanticRollout({ overwritesEnabled: true, rollbackGuard: createSemanticRollbackGuard() });
    const decisions: string[] = [];
    for (const [index, verdict] of [ACCEPT, ECHO].entries()) {
      const job = overwriteJob(index);
      decisions.push((await commitMopupCandidate({
        job, locale: 'it', field: 'title', candidate: candidateFor(job), judge: countingJudge(verdict), rollout,
      })).decision);
    }
    expect(decisions).toEqual(['write', 'skip:semantic-reject']);
    expect(rollout.snapshot().verdicts).toMatchObject({ accepted: 1, rejected: 1, total: 2 });
    expect(rollout.snapshot().written).toMatchObject({ overwrite: 1, total: 1 });
  });

  it('after the guard trips on a judge error, later overwrites are withheld as rollback and reported', async () => {
    const guard = createSemanticRollbackGuard();
    const rollout = createSemanticRolloutFromEnv({ LOCAL_MT_LANG_AWARE_OVERWRITE: '1' }, { rollbackGuard: guard });
    expect(rollout.rollbackGuard).toBe(guard);
    const failing = countingJudge(() => { throw new Error('model download failed'); });
    const healthy = countingJudge(ACCEPT);

    const first = overwriteJob(1);
    const late = overwriteJob(2);
    const before = structuredClone(late);
    // No explicit rollbackGuard: commitMopupCandidate must default to the rollout's.
    const decisions = [
      (await commitMopupCandidate({ job: first, locale: 'it', field: 'title', candidate: candidateFor(first), judge: failing, rollout })).decision,
      (await commitMopupCandidate({ job: late, locale: 'it', field: 'title', candidate: candidateFor(late), judge: healthy, rollout })).decision,
    ];

    expect(decisions).toEqual(['skip:semantic-unavailable', 'skip:semantic-rollback']);
    expect(late).toEqual(before);
    expect(guard.status()).toMatchObject({ tripped: true, reason: 'semantic-unavailable', withheld: 1 });
    const snapshot = rollout.snapshot();
    expect(snapshot).toMatchObject({ status: 'rollback', rollbackRecommended: true });
    expect(snapshot.rollback).toMatchObject({ tripped: true, reason: 'semantic-unavailable', unavailable: 1, withheld: 1 });
    expect(snapshot.verdicts).toMatchObject({ error: 1, accepted: 0, total: 1 });
    expect(snapshot.withheld).toMatchObject({ rollback: 1, total: 1 });
    expect(snapshot.written.total).toBe(0);
  });

  it('a judge error on a fill fails closed for that slot only: no second stop over fills', async () => {
    const guard = createSemanticRollbackGuard();
    const rollout = createSemanticRollout({ rollbackGuard: guard });
    const failed = fillJob(1);
    const failedBefore = structuredClone(failed);
    const decisions = [
      (await commitMopupCandidate({
        job: failed, locale: 'it', field: 'title', candidate: candidateFor(failed),
        judge: countingJudge(() => { throw new Error('transient'); }), rollout,
      })).decision,
    ];
    const next = fillJob(2);
    decisions.push((await commitMopupCandidate({
      job: next, locale: 'it', field: 'title', candidate: candidateFor(next), judge: countingJudge(ACCEPT), rollout,
    })).decision);

    expect(decisions).toEqual(['skip:semantic-unavailable', 'write']);
    expect(failed).toEqual(failedBefore);
    expect(guard.status().tripped).toBe(false);
    expect(rollout.snapshot()).toMatchObject({ status: 'ok', rollbackRecommended: false });
    expect(rollout.snapshot().verdicts).toMatchObject({ error: 1, accepted: 1 });
  });
});

describe('semantic rollout: shadow sample and report', () => {
  it('bounds the shadow sample by the cap and keeps it apart from enforced verdicts', () => {
    const rollout = createSemanticRollout({ maxOverwrites: 2 });
    const sampled: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const go = rollout.shouldShadowJudge();
      sampled.push(go);
      if (go) rollout.recordShadowVerdict(i === 0 ? 'accepted' : 'rejected');
    }
    expect(sampled).toEqual([true, true, false, false]);
    const snapshot = rollout.snapshot();
    expect(snapshot.shadowVerdicts).toEqual({ accepted: 1, rejected: 1, unclear: 0, error: 0, total: 2 });
    expect(snapshot.verdicts.total).toBe(0);
    expect(snapshot.written.total).toBe(0);
    expect(createSemanticRollout({ overwritesEnabled: true }).shouldShadowJudge()).toBe(false);
  });

  it('counts every overwrite the switch holds back and judges only a capped shadow sample', async () => {
    const guard = createSemanticRollbackGuard();
    const rollout = createSemanticRollout({ maxOverwrites: 2, rollbackGuard: guard });
    const judge = countingJudge(() => (judge.calls === 1 ? ACCEPT : REJECT));
    const outcomes = [];
    for (const id of [1, 2, 3]) {
      const job = overwriteJob(id);
      outcomes.push(await shadowWithheldOverwrite({
        candidate: candidateFor(job), rollout, sourceLang: 'de', locale: 'it', field: 'title', judge,
      }));
    }

    expect(outcomes.map((outcome) => outcome?.decision)).toEqual([
      'withheld:kill-switch', 'withheld:kill-switch', 'withheld:kill-switch',
    ]);
    expect(outcomes.map((outcome) => outcome?.shadowBucket)).toEqual(['accepted', 'rejected', null]);
    expect(judge.calls).toBe(2);
    const snapshot = rollout.snapshot();
    expect(snapshot.withheld).toMatchObject({ 'kill-switch': 3, cap: 0, rollback: 0, total: 3 });
    expect(snapshot.shadowVerdicts).toMatchObject({ accepted: 1, rejected: 1, total: 2 });
    expect(snapshot.verdicts.total).toBe(0);
    expect(snapshot.written.total).toBe(0);
    // The shadow never feeds the run rollback of the enforced arm.
    expect(guard.status()).toMatchObject({ observed: 0, tripped: false });
  });

  it('a shadow judge error is counted as a shadow error and never throws', async () => {
    const rollout = createSemanticRollout();
    const outcome = await shadowWithheldOverwrite({
      candidate: candidateFor(overwriteJob()), rollout, sourceLang: 'de', locale: 'it', field: 'title',
      judge: countingJudge(() => { throw new Error('model download failed'); }),
    });
    expect(outcome).toEqual({ decision: 'withheld:kill-switch', shadowBucket: 'error' });
    expect(rollout.snapshot().shadowVerdicts).toMatchObject({ error: 1, total: 1 });
  });

  it('leaves fills and an enforcing rollout alone', async () => {
    const judge = countingJudge(ACCEPT);
    const off = createSemanticRollout();
    expect(await shadowWithheldOverwrite({
      candidate: candidateFor(fillJob()), rollout: off, sourceLang: 'de', locale: 'it', field: 'title', judge,
    })).toBeNull();
    const on = createSemanticRollout({ overwritesEnabled: true });
    expect(await shadowWithheldOverwrite({
      candidate: candidateFor(overwriteJob()), rollout: on, sourceLang: 'de', locale: 'it', field: 'title', judge,
    })).toBeNull();
    expect(judge.calls).toBe(0);
    expect(off.snapshot().withheld.total + on.snapshot().withheld.total).toBe(0);
  });

  it('emits one greppable JSON line and GitHub annotations for cap, rollback and judge errors', () => {
    const guard = createSemanticRollbackGuard();
    guard.observe({ verdict: 'unavailable', reason: 'judge-error' });
    const rollout = createSemanticRollout({ overwritesEnabled: true, maxOverwrites: 0, rollbackGuard: guard });
    rollout.beforeJudge({ kind: 'overwrite' });
    rollout.recordJudged({ decision: 'skip:semantic-unavailable', semanticReason: 'judge-error' });
    const lines = formatSemanticTelemetry(rollout.snapshot());
    const jsonLine = lines.find((line) => line.startsWith('LOCAL_MT_SEMANTIC_TELEMETRY '));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(String(jsonLine).slice('LOCAL_MT_SEMANTIC_TELEMETRY '.length));
    expect(parsed).toMatchObject({ schemaVersion: 2, status: 'rollback', rollbackRecommended: true });
    expect(lines.some((line) => line.startsWith('::warning title=Argos semantic cap reached::'))).toBe(true);
    expect(lines.some((line) => line.startsWith('::error title=Argos overwrite rollback tripped::')
      && line.includes('LOCAL_MT_LANG_AWARE_OVERWRITE=0'))).toBe(true);
    expect(lines.some((line) => line.startsWith('::warning title=Argos semantic judge errors::'))).toBe(true);
  });

  it('without a rollout the write boundary behaves exactly like the #9675 gate plus #9676 policy', async () => {
    const job = overwriteJob();
    const result = await commitMopupCandidate({
      job, locale: 'it', field: 'title', candidate: candidateFor(job), judge: countingJudge(ACCEPT),
    });
    expect(result).toMatchObject({ written: true, decision: 'write' });
  });
});
