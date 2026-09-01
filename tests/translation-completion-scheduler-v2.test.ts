import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemoryV2,
  invalidateTranslationCandidateV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import {
  createEmptyTranslationSchedulerCursorV2,
  planTranslationScheduleV2,
  serializeTranslationScheduleV2,
  serializeTranslationSettlementV2,
  settleTranslationScheduleV2,
  validateTranslationSchedulerCursorV2,
  validateTranslationSettlementV2,
} from '../scripts/lib/translation-completion-scheduler-v2.mjs';
import { executeTranslationCandidateV2 } from '../scripts/lib/translation-candidate-executor-v2.mjs';
import {
  canonicalTranslationJsonV2,
  createTranslationUnitIdentityV2,
  digestTranslationDocumentV2,
} from '../scripts/lib/translation-unit-identity-v2.mjs';

const SCOPE_KEY = 'translation-shadow-v2';
const BASELINE_MAIN_SHA = 'a'.repeat(40);
const SCAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const ENGINE_VERSION = 'engine-1';
const GATE_VERSION = 'gate-1';
const evidenceDigest = (token: string) => createHash('sha256').update(token).digest('hex');
type SchedulerPlan = ReturnType<typeof planTranslationScheduleV2>['plan'];
type SchedulerSettlement = ReturnType<typeof settleTranslationScheduleV2>;
type SchedulerOutcomeStatus =
  | 'already_valid'
  | 'ambiguous_target'
  | 'applied'
  | 'conflict'
  | 'duplicate_attempt'
  | 'generation_failed'
  | 'malformed_target'
  | 'negative_cache'
  | 'rejected'
  | 'rejected_candidate'
  | 'retryable_reject'
  | 'reused'
  | 'stale_scan'
  | 'stale_source'
  | 'stale_target'
  | 'target_absent'
  | 'validated';

function identity(label: string, overrides: Record<string, unknown> = {}) {
  return createTranslationUnitIdentityV2({
    kind: 'job',
    fieldPath: `descriptionByLocale.${label}`,
    sourceLocale: 'de',
    targetLocale: 'it',
    sourceText: `Source ${label}`,
    context: { company: `Company ${label}`, location: 'Ticino' },
    ...overrides,
  });
}

function target(label: string) {
  return {
    crawlerKey: 'scheduler-test',
    slicePath: 'data/jobs/by-crawler/scheduler-test.json',
    jobKey: `job-${label}`,
    url: `https://jobs.example.test/${label}`,
  };
}

function job(
  label: string,
  identities = [identity(label)],
  queuedAtMs: number | null = 1_000,
  memory = createEmptyTranslationMemoryV2(),
) {
  return {
    target: target(label),
    queuedAtMs,
    units: identities.map((unitIdentity) => ({ identity: unitIdentity, memory })),
  };
}

function memoryWith(identityValue: ReturnType<typeof identity>, status: 'validated' | 'rejected', output = 'Output') {
  return recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
    identity: identityValue,
    engineVersion: ENGINE_VERSION,
    gateVersion: GATE_VERSION,
    outputText: output,
    status,
    evidence: [{ code: 'scheduler_test', digest: evidenceDigest(`${status}:${output}`) }],
  });
}

function plannerInput(overrides: Record<string, unknown> = {}) {
  return {
    scopeKey: SCOPE_KEY,
    baselineMainSha: BASELINE_MAIN_SHA,
    scanDigest: SCAN_DIGEST,
    engineVersion: ENGINE_VERSION,
    gateVersion: GATE_VERSION,
    cursor: createEmptyTranslationSchedulerCursorV2({ scopeKey: SCOPE_KEY }),
    activePlan: null,
    limits: {
      maxJobs: 10,
      maxUnits: 20,
      fairnessNumerator: 1,
      fairnessDenominator: 5,
    },
    jobs: [],
    ...overrides,
  };
}

function outcomesFor(plan: SchedulerPlan, status: SchedulerOutcomeStatus = 'generation_failed') {
  return plan.selectedJobs.map((selected) => ({
    schedulingKey: selected.schedulingKey,
    units: selected.units.map((unit) => ({ attemptKey: unit.attemptKey, status })),
  }));
}

function rehashSettlement(
  settlement: SchedulerSettlement,
  metrics: Partial<SchedulerSettlement['metrics']>,
) {
  const copy = structuredClone(settlement);
  copy.metrics = { ...copy.metrics, ...metrics };
  const { settlementHash: _ignored, ...payload } = copy;
  copy.settlementHash = digestTranslationDocumentV2(payload);
  return copy;
}

describe('translation completion scheduler v2', () => {
  it('orders completion candidates by generation distance, remaining units and age', () => {
    const easy = job('easy', [identity('easy')], 5_000);
    const olderTwo = job('older-two', [identity('older-a'), identity('older-b')], 1_000);
    const newerTwo = job('newer-two', [identity('newer-a'), identity('newer-b')], 2_000);
    const jobs = [newerTwo, olderTwo, easy];
    const planned = planTranslationScheduleV2(plannerInput({
      jobs,
      limits: { maxJobs: 3, maxUnits: 10, fairnessNumerator: 1, fairnessDenominator: 5 },
    }));
    const { plan } = planned;

    expect(plan.selectedJobs.map((selected) => [selected.generationDistance, selected.queuedAtMs]))
      .toEqual([[1, 5_000], [2, 1_000], [2, 2_000]]);
    expect(Object.isFrozen(planned)).toBe(true);
    expect(Object.isFrozen(planned.cursor)).toBe(true);
    expect(Object.isFrozen(plan.selectedJobs[0].units)).toBe(true);
    expect(plan.selectedJobs).not.toBe(jobs);
  });

  it('reuses an exact validated memory hit and excludes it from generation distance', () => {
    const unitIdentity = identity('reuse');
    const memory = memoryWith(unitIdentity, 'validated');
    const { plan } = planTranslationScheduleV2(plannerInput({
      jobs: [job('reuse', [unitIdentity], 1_000, memory)],
    }));

    expect(plan.selectedJobs[0]).toMatchObject({ generationDistance: 0, remainingUnits: 1 });
    expect(plan.selectedJobs[0].units[0]).toMatchObject({
      lookupStatus: 'exact_validated_hit',
      disposition: 'reuse',
      selectedCandidateId: expect.stringMatching(/^translation-candidate:v2:/),
    });
    expect(plan.metrics).toMatchObject({ exactValidatedHits: 1, exactMisses: 0 });
  });

  it('spends one cumulative fairness slot every five selections under a continuous easy head', () => {
    const hard = job('hard-old', [identity('hard-a'), identity('hard-b'), identity('hard-c'), identity('hard-d')], 1);
    let cursor = createEmptyTranslationSchedulerCursorV2({ scopeKey: SCOPE_KEY });
    let selectedHardAt = -1;
    for (let generation = 0; generation < 5; generation += 1) {
      const easyJobs = Array.from({ length: generation + 5 }, (_, index) => (
        job(`easy-${generation}-${index}`, [identity(`easy-${generation}-${index}`)], 10_000 + generation * 100 + index)
      ));
      const result = planTranslationScheduleV2(plannerInput({
        cursor,
        jobs: [hard, ...easyJobs],
        limits: { maxJobs: 1, maxUnits: 10, fairnessNumerator: 1, fairnessDenominator: 5 },
      }));
      if (result.plan.selectedJobs[0].remainingUnits === 4) {
        selectedHardAt = generation + 1;
        expect(result.plan.selectedJobs[0].lane).toBe('fairness');
      }
      cursor = settleTranslationScheduleV2({
        cursor: result.cursor,
        plan: result.plan,
        outcomes: outcomesFor(result.plan),
      }).cursor;
    }
    expect(selectedHardAt).toBe(5);
  });

  it('preserves due fairness when its oldest bundle does not fit the residual capacity', () => {
    const oldest = job('fairness-oldest', [identity('fairness-old-a'), identity('fairness-old-b')], 1);
    const firstEasyStream = Array.from({ length: 6 }, (_, index) => (
      job(`fairness-easy-a-${index}`, [identity(`fairness-easy-a-${index}`)], 10_000 + index)
    ));
    const first = planTranslationScheduleV2(plannerInput({
      jobs: [oldest, ...firstEasyStream],
      limits: { maxJobs: 5, maxUnits: 5, fairnessNumerator: 1, fairnessDenominator: 5 },
    }));
    expect(first.plan.selectedJobs).toHaveLength(4);
    expect(first.plan.selectedJobs.every((selected) => selected.lane === 'completion')).toBe(true);
    expect(first.plan.cursorAfter.fairnessCredit).toBe(4);

    const cursor = settleTranslationScheduleV2({
      cursor: first.cursor,
      plan: first.plan,
      outcomes: outcomesFor(first.plan),
    }).cursor;
    const secondEasyStream = Array.from({ length: 6 }, (_, index) => (
      job(`fairness-easy-b-${index}`, [identity(`fairness-easy-b-${index}`)], 20_000 + index)
    ));
    const second = planTranslationScheduleV2(plannerInput({
      cursor,
      jobs: [oldest, ...secondEasyStream],
      limits: { maxJobs: 5, maxUnits: 5, fairnessNumerator: 1, fairnessDenominator: 5 },
    }));
    expect(second.plan.selectedJobs[0]).toMatchObject({ lane: 'fairness', remainingUnits: 2 });
  });

  it('resumes Phase 2c after the prior completion pivot instead of repeating the prefix', () => {
    const jobs = Array.from({ length: 6 }, (_, index) => job(`cursor-${index}`, [identity(`cursor-${index}`)], 1_000));
    const first = planTranslationScheduleV2(plannerInput({
      jobs,
      limits: { maxJobs: 2, maxUnits: 2, fairnessNumerator: 1, fairnessDenominator: 5 },
    }));
    const cursor = settleTranslationScheduleV2({
      cursor: first.cursor,
      plan: first.plan,
      outcomes: outcomesFor(first.plan, 'stale_scan'),
    }).cursor;
    const second = planTranslationScheduleV2(plannerInput({
      cursor,
      jobs,
      limits: { maxJobs: 2, maxUnits: 2, fairnessNumerator: 1, fairnessDenominator: 5 },
    }));

    const firstKeys = new Set(first.plan.selectedJobs.map((selected) => selected.schedulingKey));
    expect(second.plan.selectedJobs.every((selected) => !firstKeys.has(selected.schedulingKey))).toBe(true);
  });

  it('replays an active plan byte-identically even when the next scan input is unusable', () => {
    const initial = planTranslationScheduleV2(plannerInput({ jobs: [job('active')] }));
    const replay = planTranslationScheduleV2({
      ...plannerInput(),
      cursor: initial.cursor,
      activePlan: initial.plan,
      baselineMainSha: null,
      scanDigest: null,
      engineVersion: null,
      gateVersion: null,
      limits: null,
      jobs: null,
    } as any);

    expect(serializeTranslationScheduleV2(replay.plan)).toBe(serializeTranslationScheduleV2(initial.plan));
    expect(replay.cursor).toEqual(initial.cursor);
  });

  it('produces the same canonical plan for every job and unit permutation', () => {
    const first = job('permutation-a', [identity('p-a-1'), identity('p-a-2')], 10);
    const second = job('permutation-b', [identity('p-b-1')], 20);
    const forward = planTranslationScheduleV2(plannerInput({ jobs: [first, second] }));
    const reverse = planTranslationScheduleV2(plannerInput({
      jobs: [second, { ...first, units: [...first.units].reverse() }],
    }));

    expect(serializeTranslationScheduleV2(forward.plan)).toBe(serializeTranslationScheduleV2(reverse.plan));

    const conflictIdentity = identity('permutation-memory');
    const conflictForward = recordTranslationCandidateV2(
      memoryWith(conflictIdentity, 'validated', 'First output'),
      {
        identity: conflictIdentity,
        engineVersion: ENGINE_VERSION,
        gateVersion: GATE_VERSION,
        outputText: 'Second output',
        status: 'validated',
        evidence: [{ code: 'scheduler_test', digest: evidenceDigest('permutation-memory') }],
      },
    );
    const conflictReverse = structuredClone(conflictForward);
    conflictReverse.records[0].candidates.reverse();
    const forwardMemory = planTranslationScheduleV2(plannerInput({
      jobs: [job('permutation-memory', [conflictIdentity], 1_000, conflictForward)],
    }));
    const reverseMemory = planTranslationScheduleV2(plannerInput({
      jobs: [job('permutation-memory', [conflictIdentity], 1_000, conflictReverse)],
    }));
    expect(serializeTranslationScheduleV2(forwardMemory.plan))
      .toBe(serializeTranslationScheduleV2(reverseMemory.plan));
  });

  it('fails closed when a feasible atomic bundle exceeds configured capacity', () => {
    const oversized = job('oversized', [identity('o-1'), identity('o-2'), identity('o-3'), identity('o-4')], 1);
    const fitting = job('fitting', [identity('fit')], 2);
    expect(() => planTranslationScheduleV2(plannerInput({
      jobs: [oversized, fitting],
      limits: { maxJobs: 2, maxUnits: 3, fairnessNumerator: 1, fairnessDenominator: 5 },
    }))).toThrow(/exceeds maxUnits/);

    const exact = planTranslationScheduleV2(plannerInput({
      jobs: [job('exact-capacity', [identity('c-1'), identity('c-2'), identity('c-3')])],
      limits: { maxJobs: 1, maxUnits: 3, fairnessNumerator: 1, fairnessDenominator: 5 },
    }));
    expect(exact.plan.selectedJobs[0]).toMatchObject({ remainingUnits: 3 });
    expect(exact.plan.metrics.selectedUnits).toBe(3);
  });

  it('negative-caches only the exact source/context/engine/gate attempt and honors invalidation', () => {
    const rejectedIdentity = identity('rejected');
    const rejected = memoryWith(rejectedIdentity, 'rejected');
    const exact = planTranslationScheduleV2(plannerInput({
      jobs: [job('rejected', [rejectedIdentity], 1_000, rejected)],
    }));
    expect(exact.plan.metrics).toMatchObject({ negativeCacheHits: 1, quarantinedJobs: 1, selectedJobs: 0 });

    const attempts: Array<{
      identity: ReturnType<typeof identity>;
      engineVersion?: string;
      gateVersion?: string;
    }> = [
      { engineVersion: 'engine-2', identity: rejectedIdentity },
      { gateVersion: 'gate-2', identity: rejectedIdentity },
      { identity: identity('rejected', { sourceText: 'Changed source' }) },
      { identity: identity('rejected', { context: { company: 'Changed company', location: 'Ticino' } }) },
    ];
    for (const changes of attempts) {
      const changedIdentity = changes.identity;
      const result = planTranslationScheduleV2(plannerInput({
        engineVersion: changes.engineVersion ?? ENGINE_VERSION,
        gateVersion: changes.gateVersion ?? GATE_VERSION,
        jobs: [job('rejected-changed', [changedIdentity], 1_000, rejected)],
      }));
      expect(result.plan.metrics).toMatchObject({ exactMisses: 1, selectedJobs: 1 });
    }

    const candidate = rejected.records[0].candidates[0];
    const invalidated = invalidateTranslationCandidateV2(rejected, {
      identityKey: rejectedIdentity.key,
      candidateId: candidate.candidateId,
      reasonCode: 'policy_changed',
    });
    const retry = planTranslationScheduleV2(plannerInput({
      jobs: [job('rejected-retry', [rejectedIdentity], 1_000, invalidated)],
    }));
    expect(retry.plan.metrics).toMatchObject({ exactMisses: 1, selectedJobs: 1, negativeCacheHits: 0 });
  });

  it('quarantines conflicting exact candidates and never selects one silently', () => {
    const unitIdentity = identity('conflict');
    const one = memoryWith(unitIdentity, 'validated', 'Output one');
    const conflict = recordTranslationCandidateV2(one, {
      identity: unitIdentity,
      engineVersion: ENGINE_VERSION,
      gateVersion: GATE_VERSION,
      outputText: 'Output two',
      status: 'validated',
      evidence: [{ code: 'scheduler_test', digest: evidenceDigest('conflict') }],
    });
    const { plan } = planTranslationScheduleV2(plannerInput({
      jobs: [job('conflict', [unitIdentity], 1_000, conflict)],
    }));

    expect(plan.metrics).toMatchObject({ exactConflicts: 1, quarantinedJobs: 1, selectedJobs: 0 });
  });

  it('separates target occurrence from memory identity across delete/re-add and URL/id rotation', () => {
    const unitIdentity = identity('readd');
    const memory = memoryWith(unitIdentity, 'validated');
    const first = planTranslationScheduleV2(plannerInput({
      jobs: [job('first-id', [unitIdentity], 1_000, memory)],
    }));
    const readded = planTranslationScheduleV2(plannerInput({
      jobs: [job('second-id', [unitIdentity], 1_000, memory)],
    }));

    expect(first.plan.selectedJobs[0].units[0].identityKey)
      .toBe(readded.plan.selectedJobs[0].units[0].identityKey);
    expect(first.plan.selectedJobs[0].targetOccurrenceKey)
      .not.toBe(readded.plan.selectedJobs[0].targetOccurrenceKey);
    expect(first.plan.selectedJobs[0].schedulingKey)
      .not.toBe(readded.plan.selectedJobs[0].schedulingKey);
    expect(readded.plan.selectedJobs[0].units[0].disposition).toBe('reuse');

    const withoutSlashJob = job('same-id', [unitIdentity], 1_000, memory);
    withoutSlashJob.target.url = 'https://jobs.example.test';
    const withSlashJob = job('same-id', [unitIdentity], 1_000, memory);
    withSlashJob.target.url = 'https://jobs.example.test/';
    const withoutSlash = planTranslationScheduleV2(plannerInput({ jobs: [withoutSlashJob] }));
    const withSlash = planTranslationScheduleV2(plannerInput({ jobs: [withSlashJob] }));
    expect(withoutSlash.plan.selectedJobs[0].units[0].identityKey)
      .toBe(withSlash.plan.selectedJobs[0].units[0].identityKey);
    expect(withoutSlash.plan.selectedJobs[0].targetOccurrenceKey)
      .not.toBe(withSlash.plan.selectedJobs[0].targetOccurrenceKey);
    expect(withoutSlash.plan.selectedJobs[0].schedulingKey)
      .not.toBe(withSlash.plan.selectedJobs[0].schedulingKey);
    expect(withoutSlash.plan.selectedJobs[0].units[0].disposition).toBe('reuse');
    expect(withSlash.plan.selectedJobs[0].units[0].disposition).toBe('reuse');
  });

  it('fails closed on prototype, schema, path, identity and hash corruption', () => {
    const validCursor = createEmptyTranslationSchedulerCursorV2({ scopeKey: SCOPE_KEY });
    expect(() => validateTranslationSchedulerCursorV2({ ...validCursor, fairnessCredit: 4 })).toThrow(/hash/);
    expect(() => createEmptyTranslationSchedulerCursorV2(Object.assign(Object.create({ polluted: true }), {
      scopeKey: SCOPE_KEY,
    }))).toThrow(/plain object/);
    expect(() => planTranslationScheduleV2(plannerInput({
      jobs: [{ ...job('extra'), extra: true }],
    }))).toThrow(/unsupported schema/);
    expect(() => planTranslationScheduleV2(plannerInput({
      jobs: [{ ...job('unsafe'), target: { ...target('unsafe'), slicePath: '../data.json' } }],
    }))).toThrow(/slicePath/);
    expect(() => planTranslationScheduleV2(plannerInput({
      jobs: [{ ...job('wrong-prefix'), target: { ...target('wrong-prefix'), slicePath: 'other/safe.json' } }],
    }))).toThrow(/slicePath/);
    const corruptedIdentity = { ...identity('corrupt'), sourceHash: '0'.repeat(64) };
    expect(() => planTranslationScheduleV2(plannerInput({
      jobs: [job('corrupt', [corruptedIdentity as any])],
    }))).toThrow(/key does not match/);
    const { plan } = planTranslationScheduleV2(plannerInput({ jobs: [job('hash')] }));
    expect(serializeTranslationScheduleV2(JSON.parse(serializeTranslationScheduleV2(plan))))
      .toBe(serializeTranslationScheduleV2(plan));
    expect(() => planTranslationScheduleV2(plannerInput({
      jobs: [job('non-json', [identity('non-json')], Number.NaN)],
    }))).toThrow(/queuedAtMs/);
    expect(() => planTranslationScheduleV2(plannerInput({
      limits: { maxJobs: 1, maxUnits: 251, fairnessNumerator: 1, fairnessDenominator: 5 },
    }))).toThrow(/limits/);
    expect(() => serializeTranslationScheduleV2({
      ...plan,
      metrics: { ...plan.metrics, selectedUnits: plan.metrics.selectedUnits + 1 },
    })).toThrow();
  });

  it('keeps predicted completion separate from semantic jobsCompleted settlement', () => {
    const planned = planTranslationScheduleV2(plannerInput({ jobs: [job('predicted')] }));
    expect(planned.plan.metrics.predictedCompletionJobs).toBe(1);
    expect(planned.plan.metrics).not.toHaveProperty('jobsCompleted');

    const failed = settleTranslationScheduleV2({
      cursor: planned.cursor,
      plan: planned.plan,
      outcomes: outcomesFor(planned.plan, 'generation_failed'),
    });
    expect(failed.metrics).toMatchObject({
      jobsCompleted: 0,
      queueJobsIn: 1,
      queueJobsOut: 1,
      queueUnitsIn: 1,
      queueUnitsOut: 1,
    });
    expect(serializeTranslationSettlementV2(failed, planned.plan)).toContain(failed.settlementHash);
    for (const tamperedMetrics of [
      { queueJobsOut: 0 },
      { queueUnitsOut: 0 },
    ]) {
      expect(() => serializeTranslationSettlementV2(
        rehashSettlement(failed, tamperedMetrics),
        planned.plan,
      ))
        .toThrow(/metrics/);
    }
    for (const coordinatedTamper of [
      { queueJobsIn: 2, queueJobsOut: 2 },
      { queueUnitsIn: 2, queueUnitsOut: 2 },
    ]) {
      expect(() => serializeTranslationSettlementV2(
        rehashSettlement(failed, coordinatedTamper),
        planned.plan,
      )).toThrow(/plan/);
    }

    const validated = settleTranslationScheduleV2({
      cursor: planned.cursor,
      plan: planned.plan,
      outcomes: outcomesFor(planned.plan, 'validated'),
    });
    expect(validated.metrics).toMatchObject({
      generated: 1,
      validated: 1,
      rejected: 0,
      patchesQueued: 1,
      patchesApplied: 0,
      jobsCompleted: 0,
    });

    const completed = settleTranslationScheduleV2({
      cursor: planned.cursor,
      plan: planned.plan,
      outcomes: outcomesFor(planned.plan, 'applied'),
    });
    expect(completed.metrics).toMatchObject({ jobsCompleted: 1, queueJobsOut: 0, queueUnitsOut: 0 });
  });

  it('settles a retryable executor rejection without completing or patching its queued unit', async () => {
    const sourceText = 'Die Aufgabe umfasst Planung, Zusammenarbeit und verlässliche Kommunikation im Team.';
    const unitIdentity = createTranslationUnitIdentityV2({
      kind: 'job', fieldPath: 'description', sourceLocale: 'de', targetLocale: 'it',
      sourceText,
      context: { company: null, location: null },
    });
    const planned = planTranslationScheduleV2(plannerInput({ jobs: [job('retryable', [unitIdentity])] }));
    const selected = planned.plan.selectedJobs[0].units[0];
    const execution = await executeTranslationCandidateV2({
      identity: unitIdentity, memory: createEmptyTranslationMemoryV2(), engineVersion: ENGINE_VERSION, gateVersion: GATE_VERSION,
      scanDigest: SCAN_DIGEST, currentScanDigest: SCAN_DIGEST, providerTimeoutMs: 1_000,
      quality: { sourceText, sourceLang: 'de', targetLang: 'it', field: 'description', protectedTokens: [] },
      provider: { schemaVersion: 2, costClass: 'zero', engineVersion: ENGINE_VERSION, executionClass: 'cooperative_async', translate: async () => sourceText },
    });
    expect(execution).toMatchObject({ status: 'retryable_reject', attemptKey: selected.attemptKey });
    const outcomes = [{ schedulingKey: planned.plan.selectedJobs[0].schedulingKey, units: [{ attemptKey: execution.attemptKey, status: execution.status }] }];
    const settlement = settleTranslationScheduleV2({ cursor: planned.cursor, plan: planned.plan, outcomes });
    expect(settlement.metrics).toMatchObject({ jobsCompleted: 0, patchesQueued: 0, patchesApplied: 0, queueJobsOut: 1, queueUnitsOut: 1 });
    expect(settlement.metrics.outcomeCounts.retryable_reject).toBe(1);
    expect(serializeTranslationSettlementV2(settlement, planned.plan)).toContain(settlement.settlementHash);
    await expect(Promise.resolve().then(() => settleTranslationScheduleV2({
      cursor: planned.cursor, plan: planned.plan,
      outcomes: [{ schedulingKey: planned.plan.selectedJobs[0].schedulingKey, units: [{ attemptKey: execution.attemptKey, status: 'unknown' }] }],
    } as any))).rejects.toThrow();
  });

  it('accepts every public executor terminal status as a non-patch scheduler outcome', () => {
    const executorStatuses: SchedulerOutcomeStatus[] = [
      'conflict', 'duplicate_attempt', 'generation_failed', 'negative_cache',
      'rejected_candidate', 'retryable_reject', 'reused', 'stale_scan', 'validated',
    ];
    for (const status of executorStatuses) {
      const planned = planTranslationScheduleV2(plannerInput({ jobs: [job(`executor-${status}`)] }));
      const settlement = settleTranslationScheduleV2({
        cursor: planned.cursor,
        plan: planned.plan,
        outcomes: outcomesFor(planned.plan, status),
      });
      expect(settlement.metrics.outcomeCounts[status]).toBe(1);
      if (status !== 'validated' && status !== 'reused') {
        expect(settlement.metrics).toMatchObject({ jobsCompleted: 0, patchesQueued: 0, patchesApplied: 0, queueJobsOut: 1, queueUnitsOut: 1 });
      }
    }
  });

  it('keeps duplicate attempts queued and preserves legacy settlement v2 bytes', () => {
    const planned = planTranslationScheduleV2(plannerInput({ jobs: [job('duplicate-attempt')] }));
    const current = settleTranslationScheduleV2({
      cursor: planned.cursor,
      plan: planned.plan,
      outcomes: outcomesFor(planned.plan, 'duplicate_attempt'),
    });
    expect(current.metrics).toMatchObject({ jobsCompleted: 0, patchesQueued: 0, patchesApplied: 0, queueJobsOut: 1, queueUnitsOut: 1 });
    expect(current.metrics.outcomeCounts.duplicate_attempt).toBe(1);

    const legacy = structuredClone(current);
    delete (legacy.metrics.outcomeCounts as Record<string, number>).duplicate_attempt;
    delete (legacy.metrics.outcomeCounts as Record<string, number>).retryable_reject;
    legacy.outcomes = outcomesFor(planned.plan, 'generation_failed');
    legacy.metrics.outcomeCounts.generation_failed = 1;
    legacy.settlementHash = digestTranslationDocumentV2({
      schemaVersion: legacy.schemaVersion,
      scopeKey: legacy.scopeKey,
      planHash: legacy.planHash,
      cursor: legacy.cursor,
      outcomes: legacy.outcomes,
      metrics: legacy.metrics,
    });
    const legacyBytes = `${canonicalTranslationJsonV2(legacy)}\n`;
    expect(validateTranslationSettlementV2(legacy, planned.plan)).toEqual(legacy);
    expect(serializeTranslationSettlementV2(legacy, planned.plan)).toBe(legacyBytes);
    expect(validateTranslationSchedulerCursorV2(legacy.cursor)).toEqual(legacy.cursor);

    for (const malformed of [
      { ...legacy, metrics: { ...legacy.metrics, outcomeCounts: { ...legacy.metrics.outcomeCounts, retryable_reject: 0 } } },
      { ...current, metrics: { ...current.metrics, outcomeCounts: (() => { const counts = { ...current.metrics.outcomeCounts }; delete (counts as Record<string, number>).duplicate_attempt; return counts; })() } },
      { ...legacy, metrics: { ...legacy.metrics, outcomeCounts: { ...legacy.metrics.outcomeCounts, unknown: 0 } } },
    ]) {
      expect(() => serializeTranslationSettlementV2(malformed as never, planned.plan)).toThrow();
    }
  });

  it('rejects incomplete, duplicate or mismatched settlement outcomes', () => {
    const planned = planTranslationScheduleV2(plannerInput({ jobs: [job('settle')] }));
    expect(() => settleTranslationScheduleV2({ cursor: planned.cursor, plan: planned.plan, outcomes: [] }))
      .toThrow(/cover selected jobs/);
    const outcomes = outcomesFor(planned.plan, 'applied');
    expect(() => settleTranslationScheduleV2({
      cursor: planned.cursor,
      plan: planned.plan,
      outcomes: [{ ...outcomes[0], units: [outcomes[0].units[0], outcomes[0].units[0]] }],
    })).toThrow();
    expect(() => settleTranslationScheduleV2({
      cursor: createEmptyTranslationSchedulerCursorV2({ scopeKey: SCOPE_KEY }),
      plan: planned.plan,
      outcomes,
    })).toThrow(/binding/);
  });
});
