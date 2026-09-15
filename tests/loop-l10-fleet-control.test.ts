import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_PATH,
  EXPECTED_LOOP_IDS,
  runL10,
  validateFleetControl,
} from '../scripts/ci/loop-l10-fleet-control.mjs';
import {
  buildOutcome,
  AUTONOMY_LEVELS,
  LOOP_STATES,
  QUALITY_STATES,
} from '../scripts/lib/loop-fleet-contract.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function registry(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    contractVersion: '2026-09-12',
    states: LOOP_STATES,
    qualityStates: QUALITY_STATES,
    autonomyLevels: Object.fromEntries(AUTONOMY_LEVELS.map((level) => [level, level])),
    actionAutonomy: {
      observe: 'A0',
      'follow-up': 'A1',
      route: 'A4',
      lock: 'A4',
      retry: 'A4',
    },
    sourceCatalog: { 'test-source': 'Independent test source' },
    loops: EXPECTED_LOOP_IDS.map((loopId) => ({
      loopId,
      goal: `Goal ${loopId}`,
      owner: 'Operations',
      oracle: 'independent ledger',
      sourceRefs: ['test-source'],
      cadence: 'daily',
      primaryMetric: 'verified_metric',
      outcome: {
        outcomeId: `verified-${loopId.toLowerCase()}`,
        sourceRefs: ['test-source'],
        requiredFields: ['generatedAt', 'numerator', 'denominator'],
      },
      minimumSample: 1,
      maxAutonomy: 'A4',
      actionClasses: loopId === 'L10'
        ? ['observe', 'follow-up', 'route', 'lock', 'retry']
        : ['observe', 'follow-up'],
      actionPolicy: loopId === 'L10'
        ? {
          healthy: 'observe',
          needsReview: 'route+lock+retry+follow-up',
          missingHealth: 'route',
          repair: 'follow-up',
          retry: 'lock+retry',
        }
        : { healthy: 'observe', needsReview: 'follow-up' },
      ...(loopId === 'L7'
        ? {
          allocationPolicy: {
            persistent: true,
            assignmentMethod: 'stable-sha256',
            assignmentKey: 'experiment-session-id',
            boundedCanary: {
              enabled: false,
              maxExposure: 0,
              requiresReviewedApproval: true,
            },
            contaminationPolicy: {
              controlled: true,
              key: 'experiment-session-id',
              rejectReassignment: true,
              rejectCrossCandidateExposure: true,
            },
            trafficMutationAllowed: false,
            priceMutationAllowed: false,
            noAutomaticPriceChange: true,
          },
        }
        : {}),
      guardrails: ['never bypass a gate'],
      lifecycle: {
        candidateTtlHours: 24,
        ownerSlaHours: 24,
        postMergeVerificationHours: 24,
        rollbackOwner: 'Operations',
      },
    })),
    ...overrides,
  };
}

function quotaRow(overrides: Record<string, unknown> = {}) {
  return {
    tunedAt: '2026-09-12T09:00:00.000Z',
    prevQuota: 90,
    newQuota: 90,
    decision: 'hold',
    reason: 'ratio=0.82',
    provenWinRate: 0.8,
    discoveryWinRate: 0.6,
    ratio: 0.75,
    samples: {
      proven: { winners: 8, total: 10 },
      discovery: { winners: 6, total: 10 },
    },
    ...overrides,
  };
}

function healthRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    loopId: 'L0',
    generatedAt: '2026-09-12T10:00:00.000Z',
    status: 'success',
    verifiedDecision: true,
    gateBypass: false,
    durationSeconds: 12,
    retryCount: 0,
    quotaUnits: 1,
    collisions: 0,
    artifactsWritten: ['l0-result.json'],
    ...overrides,
  };
}

function canonicalHealthRow(overrides: Record<string, unknown> = {}) {
  const loopRegistry = registry();
  const policy = loopRegistry.loops.find((loop: { loopId: string }) => loop.loopId === 'L0')!;
  const outcome = buildOutcome({
    outcomeId: policy.outcome.outcomeId,
    status: 'partial',
    independent: false,
    sourceRefs: policy.outcome.sourceRefs,
    primaryMetric: policy.primaryMetric,
    requiredFieldsPresent: [],
    missingFields: ['generatedAt', 'numerator', 'denominator'],
    reason: 'independent outcome is not available in the canonical health record',
    recordedAt: NOW.toISOString(),
  });
  return {
    recordType: 'health',
    schemaVersion: 1,
    recordId: 'health-1',
    loopId: 'L0',
    execution: {
      loopId: 'L0',
      runId: 'run-1',
      runAttempt: '1',
      sha: 'a'.repeat(40),
      recordedAt: NOW.toISOString(),
    },
    recordedAt: NOW.toISOString(),
    quality: 'partial',
    ok: false,
    evidenceComplete: true,
    policyCompliant: true,
    lifecycleCompliant: true,
    lifecycle: policy.lifecycle,
    sourceRefs: policy.sourceRefs,
    policyErrors: [],
    outcome,
    outcomePolicyCompliant: true,
    outcomeErrors: [],
    decision: 'candidate',
    actionClass: 'observe',
    requiredAutonomy: 'A0',
    maxAutonomy: 'A4',
    issueCount: 1,
    warningCount: 0,
    candidateCount: 0,
    issued: false,
    actionsWritten: false,
    evidence: {
      observation: 'l0-observation.json',
      decision: 'l0-decision.json',
      result: 'l0-result.json',
      outcome: 'loop-fleet-outcome.json',
    },
    ...overrides,
  };
}

function quotaHistory(...rows: Record<string, unknown>[]) {
  return { records: rows.length ? rows : [quotaRow()], parseIssues: [], missing: false };
}

function healthHistory(...rows: Record<string, unknown>[]) {
  return { records: rows.length ? rows : [healthRow()], parseIssues: [], missing: false };
}

function writeJson(dir: string, name: string, value: unknown) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

function writeJsonl(dir: string, name: string, rows: unknown[]) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

describe('L10 Engineering Learning / Fleet Control', () => {
  it('legge il percorso del ledger health canonico', () => {
    expect(DEFAULT_HEALTH_PATH).toBe(path.join('data', 'loop-fleet', 'ledger', 'loop-health-history.jsonl'));
  });

  it('accepts a complete registry, coherent quota record and verified execution', () => {
    const verdict = validateFleetControl({
      registry: registry(),
      quota: quotaHistory(),
      health: healthHistory(),
    }, { now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot).toMatchObject({
      registry: { loopCount: 12 },
      quota: { validRowCount: 1, currentQuota: 90 },
      health: { eligibleRuns: 1, verifiedDecisions: 1 },
    });
  });

  it('valida il formato health canonico senza promuoverlo a outcome completo', () => {
    const verdict = validateFleetControl({
      registry: registry(),
      quota: quotaHistory(),
      health: healthHistory(canonicalHealthRow()),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.health).toMatchObject({
      canonical: true,
      rowCount: 1,
      validRowCount: 1,
      eligibleRuns: 1,
      verifiedDecisions: 0,
      retries: null,
      quotaUnits: null,
      artifactCollisions: null,
    });
    expect(verdict.issues.join(' ')).toContain('canonical health ledger omits operational fields');
  });

  it('mantiene esplicita la copertura mista durante la transizione del ledger', () => {
    const complete = canonicalHealthRow({
      recordId: 'health-complete',
      execution: {
        ...canonicalHealthRow().execution,
        runId: 'run-complete',
      },
      durationSeconds: 12,
      retryCount: 1,
      quotaUnits: 2,
      collisions: 0,
      gateBypass: false,
      operationalMetricsComplete: true,
    });
    const verdict = validateFleetControl({
      registry: registry(),
      quota: quotaHistory(),
      health: healthHistory(canonicalHealthRow(), complete),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.health).toMatchObject({
      operationalMetricsComplete: false,
      operationalMetricsCompleteRuns: 1,
      operationalMetricsIncompleteRuns: 1,
      retries: null,
      quotaUnits: null,
      artifactCollisions: null,
    });
    expect(verdict.issues.join(' ')).toContain('canonical health ledger omits operational fields');
  });

  it('does not promote complete-looking legacy rows without the telemetry marker', () => {
    const legacyComplete: any = canonicalHealthRow({
      durationSeconds: 12,
      retryCount: 1,
      quotaUnits: 2,
      collisions: 0,
      gateBypass: false,
    });
    delete legacyComplete.operationalMetricsComplete;
    const verdict = validateFleetControl({
      registry: registry(),
      quota: quotaHistory(),
      health: healthHistory(legacyComplete),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.health).toMatchObject({
      operationalMetricsComplete: false,
      operationalMetricsCompleteRuns: 0,
      operationalMetricsIncompleteRuns: 1,
      retries: null,
      quotaUnits: null,
      artifactCollisions: null,
    });
    expect(verdict.issues.join(' ')).toContain('operationalMetricsComplete');
  });

  it('keeps a missing health ledger unmeasurable instead of counting zero successes', () => {
    const verdict = validateFleetControl({
      registry: registry(),
      quota: quotaHistory(),
      health: null,
    }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'unmeasurable' });
    expect(verdict.snapshot.health.verifiedDecisions).toBeNull();
    expect(verdict.candidates.some((candidate) => candidate.actionClass === 'route' && candidate.autonomy === 'A4')).toBe(true);
  });

  it('detects an incomplete fleet registry and does not route an unknown loop as valid', () => {
    const incomplete = registry({ loops: registry().loops.slice(0, -1) });
    const verdict = validateFleetControl({
      registry: incomplete,
      quota: quotaHistory(),
      health: healthHistory(),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.issues.join(' ')).toContain('registry is missing L11');
  });

  it('detects quota direction inconsistencies and artifact/gate collisions', () => {
    const verdict = validateFleetControl({
      registry: registry(),
      quota: quotaHistory(quotaRow({ decision: 'more discovery', newQuota: 95 })),
      health: healthHistory(healthRow({ gateBypass: true, collisions: 1, retryCount: 2 })),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.issues.join(' ')).toContain('more discovery does not reduce proven quota');
    expect(verdict.issues.join(' ')).toContain('gateBypass must remain false');
    expect(verdict.candidates.some((candidate) => candidate.actionClass === 'lock+retry' && candidate.autonomy === 'A4')).toBe(true);
  });

  it('keeps a skipped run out of the verified throughput denominator', () => {
    const verdict = validateFleetControl({
      registry: registry(),
      quota: quotaHistory(),
      health: healthHistory(healthRow({ status: 'skipped', verifiedDecision: false, artifactsWritten: [] })),
    }, { now: NOW });
    expect(verdict).toMatchObject({ quality: 'zero', ok: false });
    expect(verdict.snapshot.health).toMatchObject({ eligibleRuns: 0, verifiedDecisions: 0, skippedRuns: 1 });
  });

  it('writes gate-preserving actions and the result after issue creation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l10-test-'));
    const registryPath = writeJson(dir, 'registry.json', registry());
    const quotaPath = writeJsonl(dir, 'quota.jsonl', [quotaRow()]);
    const reportDir = path.join(dir, 'report');
    const issues: unknown[] = [];
    const result = await runL10({
      now: NOW,
      registryPath,
      quotaPath,
      healthPath: path.join(dir, 'missing-health.jsonl'),
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload) => { issues.push(payload); },
      logger: { log() {} },
    });
    expect(result).toMatchObject({ issued: true, actionsWritten: true });
    expect(issues).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l10-safe-actions.json'), 'utf8')))
      .toMatchObject({ oneWriterPerArtifact: true, boundedQueues: true, gateBypass: false });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l10-result.json'), 'utf8')))
      .toMatchObject({ ok: false, issued: true, actionsWritten: true });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l10-outcome.json'), 'utf8')))
      .toMatchObject({
        loopId: 'L10',
        safeToAct: false,
        oneWriterPerArtifact: true,
        boundedRetries: true,
        ledgerWriteMode: 'serialized-atomic',
        gateBypass: false,
        supervisorL11Separate: true,
      });
  });

  it('does not persist a result when issue creation fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l10-test-'));
    const registryPath = writeJson(dir, 'registry.json', registry());
    const quotaPath = writeJsonl(dir, 'quota.jsonl', [quotaRow()]);
    const reportDir = path.join(dir, 'report');
    await expect(runL10({
      now: NOW,
      registryPath,
      quotaPath,
      healthPath: path.join(dir, 'missing-health.jsonl'),
      reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue service unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l10-result.json'))).toBe(false);
  });
});
