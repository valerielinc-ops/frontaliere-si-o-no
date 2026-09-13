import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runL7,
  validateExperimentAllocator,
  validateCandidateRegistry,
} from '../scripts/ci/loop-l7-experiment-allocator.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const GUARDRAILS = ['persistent assignment', 'minimum sample', 'explicit expiry', 'no automatic price change'];

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1',
    keyword: 'calcolo stipendio ticino',
    locale: 'it',
    sources: ['gsc'],
    rationale: 'registered demand signal',
    demandScore: 0.4,
    noveltyScore: 0.7,
    totalScore: 0.55,
    ...overrides,
  };
}

function registry(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    sources: { gsc: { ok: true, candidates: 1 } },
    candidates: [candidate()],
    ...overrides,
  };
}

function outcomes(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    independent: true,
    evidence: {
      source: 'experiment-assignment-exposure-ledger',
      sourceRefs: ['experiment-assignment-exposure-outcome'],
    },
    preRegistration: {
      outcomeId: 'registered-experiment-outcome',
      primaryMetric: 'registered_outcome_per_eligible_cohort',
      minimumSample: 200,
      guardrails: GUARDRAILS,
      expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    assignmentLedger: {
      persistent: true,
      method: 'stable-sha256',
      key: 'experiment-session-id',
    },
    contaminationPolicy: {
      controlled: true,
      key: 'experiment-session-id',
    },
    eligibleCohort: 300,
    assignments: 300,
    exposures: 280,
    primaryOutcomes: 42,
    guardrailBreaches: 0,
    persistentAssignments: 300,
    contaminatedAssignments: 0,
    durationDays: 7,
    ...overrides,
  };
}

function tempFiles(candidateValue: unknown = registry(), outcomeValue: unknown = outcomes()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l7-test-'));
  const candidatesPath = path.join(dir, 'candidates.json');
  const outcomePath = path.join(dir, 'outcomes.json');
  const reportDir = path.join(dir, 'report');
  fs.writeFileSync(candidatesPath, `${JSON.stringify(candidateValue)}\n`);
  if (outcomeValue !== null) fs.writeFileSync(outcomePath, `${JSON.stringify(outcomeValue)}\n`);
  return { dir, candidatesPath, outcomePath, reportDir };
}

describe('L7 Experiment Allocator', () => {
  it('accepts a sourced candidate registry and complete outcome ledger', () => {
    const verdict = validateExperimentAllocator({ registry: registry(), outcomes: outcomes() }, { now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot.outcomes).toMatchObject({ eligibleCohort: 300, persistentAssignments: 300 });
  });

  it('rejects missing candidate provenance and malformed scores', () => {
    const verdict = validateCandidateRegistry(registry({ candidates: [candidate({ sources: [], totalScore: 4 })] }), { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.issues.join(' ')).toContain('sources must be');
    expect(verdict.issues.join(' ')).toContain('totalScore');
  });

  it('keeps canary allocation unmeasurable when the outcome ledger is absent', () => {
    const verdict = validateExperimentAllocator({ registry: registry(), outcomes: null }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'partial' });
    expect(verdict.snapshot.outcomes.eligibleCohort).toBeNull();
    expect(verdict.warnings.join(' ')).toContain('no independent');
  });

  it('requires an explicit independent ledger with reviewable experiment metadata', () => {
    const verdict = validateExperimentAllocator({
      registry: registry(),
      outcomes: outcomes({ independent: false }),
    }, { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('independent must be explicitly true');
  });

  it('does not turn an empty eligible cohort into a measurable zero outcome', async () => {
    const files = tempFiles(registry(), outcomes({
      eligibleCohort: 0,
      assignments: 0,
      exposures: 0,
      primaryOutcomes: 0,
      persistentAssignments: 0,
    }));
    const result = await runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('zero');
    expect(result.outcome).toMatchObject({ status: 'partial', independent: false });
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('does not treat an eligible cohort without assignments or exposures as observed', async () => {
    const files = tempFiles(registry(), outcomes({
      eligibleCohort: 300,
      assignments: 0,
      exposures: 0,
      primaryOutcomes: 0,
      persistentAssignments: 0,
    }));
    const result = await runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('zero');
    expect(result.verdict.ok).toBe(false);
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('rejects future outcome timestamps and starts the decision window at now', async () => {
    const files = tempFiles(registry(), outcomes({ generatedAt: '2026-09-13T12:00:00.000Z' }));
    const result = await runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('stale');
    expect(result.observation.observationWindow.start).toBe(NOW.toISOString());
  });

  it('detects exposure, contamination and guardrail cardinality errors', () => {
    const verdict = validateExperimentAllocator({
      registry: registry(),
      outcomes: outcomes({ exposures: 301, contaminatedAssignments: 301, guardrailBreaches: 301 }),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.reason).toContain('exposures exceeds outcomes.assignments');
  });

  it('stops and escalates a canary with any guardrail breach or contamination', async () => {
    const verdict = validateExperimentAllocator({
      registry: registry(),
      outcomes: outcomes({ guardrailBreaches: 1, contaminatedAssignments: 1 }),
    }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'partial' });
    expect(verdict.issues.join(' ')).toContain('guardrailBreaches is non-zero');
    expect(verdict.issues.join(' ')).toContain('contaminatedAssignments is non-zero');
    const files = tempFiles(registry(), outcomes({ guardrailBreaches: 1, contaminatedAssignments: 1 }));
    const result = await runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      apply: true,
      logger: { log() {} },
    });
    expect(JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l7-actions.json'), 'utf8')).actions[0]).toMatchObject({ autonomy: 'A3' });
  });

  it('writes only candidate recommendations and preserves the no-price-change guardrail', async () => {
    const files = tempFiles(registry(), null);
    const result = await runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      apply: true,
      logger: { log() {} },
    });
    expect(result.actionsWritten).toBe(true);
    const actions = JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l7-actions.json'), 'utf8'));
    expect(actions).toMatchObject({
      appliesToTraffic: false,
      noAutomaticPriceChange: true,
    });
    expect(actions.actions.find((action: { actionClass: string }) => action.actionClass === 'candidate'))
      .toMatchObject({ autonomy: 'A1' });
  });

  it('exports a persistent, bounded, review-only allocation plan with the outcome ledger', async () => {
    const files = tempFiles(registry(), null);
    const result = await runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      logger: { log() {} },
    });
    expect(result.outcome).toMatchObject({
      loopId: 'L7',
      status: 'partial',
      independent: false,
      metrics: {
        eligibleCohort: null,
        assignments: null,
        exposures: null,
      },
      safeToAct: false,
      appliesToTraffic: false,
      trafficMutationAllowed: false,
      priceMutationAllowed: false,
      noAutomaticPriceChange: true,
      allocationPlan: {
        persistent: true,
        assignmentMethod: 'stable-sha256',
        assignmentKey: 'experiment-session-id',
        boundedCanary: { enabled: false, maxExposure: 0, requiresReviewedApproval: true },
        preRegistration: {
          outcomeId: 'registered-experiment-outcome',
          primaryMetric: 'registered_outcome_per_eligible_cohort',
          minimumSample: 200,
          guardrails: GUARDRAILS,
        },
        contaminationPolicy: {
          controlled: true,
          rejectReassignment: true,
          rejectCrossCandidateExposure: true,
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l7-outcome.json'), 'utf8')))
      .toMatchObject({ loopId: 'L7', safeToAct: false, allocationPlan: { persistent: true } });
  });

  it('keeps the allocation seed deterministic for the same registry snapshot', async () => {
    const first = tempFiles(registry(), null);
    const second = tempFiles(registry(), null);
    const [firstResult, secondResult] = await Promise.all([
      runL7({ now: NOW, candidatesPath: first.candidatesPath, outcomePath: first.outcomePath, logger: { log() {} } }),
      runL7({ now: NOW, candidatesPath: second.candidatesPath, outcomePath: second.outcomePath, logger: { log() {} } }),
    ]);
    expect(firstResult.allocationPlan).toEqual(secondResult.allocationPlan);
  });

  it('persists a separate result after a deduplicated issue succeeds', async () => {
    const files = tempFiles(registry(), null);
    const result = await runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      issue: true,
      createIssueImpl: async () => ({ persisted: true }),
      logger: { log() {} },
    });
    expect(result.issued).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l7-result.json'), 'utf8'))).toMatchObject({ loopId: 'L7', issued: true });
  });

  it('does not claim issue persistence when the issue writer declines it', async () => {
    const files = tempFiles(registry(), null);
    await expect(runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      issue: true,
      createIssueImpl: async () => ({ persisted: false }),
      logger: { log() {} },
    })).rejects.toThrow('L7 issue persistence failed');
    expect(fs.existsSync(path.join(files.reportDir, 'l7-result.json'))).toBe(false);
  });

  it('does not write a success result if issue persistence fails', async () => {
    const files = tempFiles(registry(), null);
    await expect(runL7({
      now: NOW,
      candidatesPath: files.candidatesPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue API unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue API unavailable');
    expect(fs.existsSync(path.join(files.reportDir, 'l7-result.json'))).toBe(false);
  });
});
