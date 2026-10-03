import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_PATH,
  EXPECTED_LOOP_IDS,
  OPERATIONAL_FIELDS_REQUIRED_FROM,
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
          policyRequirements: ['allocation'],
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

// Rows recorded after OPERATIONAL_FIELDS_REQUIRED_FROM must carry the
// operational columns; NOW predates it, so the gate tests run at this instant.
const AFTER_CUTOFF_NOW = new Date('2026-10-02T12:00:00.000Z');
// Last real row without `operationalMetricsComplete` on ledger/loop-fleet.
const LAST_MEASURED_LEGACY_ROW_AT = '2026-09-14T22:04:45.291Z';
const OPERATIONAL_COLUMNS = Object.freeze({
  durationSeconds: 12,
  retryCount: 1,
  quotaUnits: 2,
  collisions: 0,
  gateBypass: false,
});
const OPERATIONAL_FIELDS = Object.freeze({ ...OPERATIONAL_COLUMNS, operationalMetricsComplete: true });

function canonicalHealthRowAt(recordedAt: string, runId: string, overrides: Record<string, unknown> = {}) {
  const base = canonicalHealthRow({ recordId: `health-${runId}`, ...overrides });
  return {
    ...base,
    recordedAt,
    execution: { ...base.execution, runId, recordedAt },
    outcome: { ...base.outcome, recordedAt },
  };
}

function validateAfterCutoff(...rows: Record<string, unknown>[]) {
  return validateFleetControl({
    registry: registry(),
    quota: quotaHistory(quotaRow({ tunedAt: '2026-10-02T11:00:00.000Z' })),
    health: healthHistory(...rows),
  }, { now: AFTER_CUTOFF_NOW });
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
    const verdict = validateAfterCutoff(canonicalHealthRowAt('2026-10-02T10:00:00.000Z', 'run-1'));
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

  it('accepts declared historical canonical sources only before their registry cutoff', () => {
    const loopRegistry: any = registry();
    loopRegistry.sourceCatalog['legacy-source'] = 'Retired test source';
    loopRegistry.sourceCatalog['second-test-source'] = 'Second current source';
    const policy = loopRegistry.loops.find((loop: any) => loop.loopId === 'L0');
    policy.sourceRefs = ['test-source', 'second-test-source'];
    policy.outcome.sourceRefs = [...policy.sourceRefs];
    policy.outcome.historicalSourceRefs = [['legacy-source']];
    policy.outcome.historicalSourceRefsBefore = '2026-09-24T20:22:12.000Z';

    const baseRow = canonicalHealthRow();
    const base = {
      ...baseRow,
      sourceRefs: [...policy.sourceRefs],
      outcome: { ...baseRow.outcome, sourceRefs: [...policy.outcome.sourceRefs] },
    };
    const rowAt = (recordedAt: string) => ({
      ...base,
      recordedAt,
      sourceRefs: ['legacy-source'],
      outcome: { ...base.outcome, sourceRefs: ['legacy-source'], recordedAt },
    });
    const validate = (row: ReturnType<typeof rowAt>) => validateFleetControl({
      registry: loopRegistry,
      quota: quotaHistory(quotaRow({ tunedAt: '2026-10-02T11:00:00.000Z' })),
      health: healthHistory(row),
    }, { now: new Date('2026-10-02T12:00:00.000Z') });

    const historical = validate(rowAt('2026-09-14T03:29:43.387Z'));
    expect(historical.issues.join(' ')).not.toContain('sourceRefs do not match the registry');
    expect(historical.issues.join(' ')).not.toContain('outcome violates registry');

    const reorderedCurrent = validate({
      ...rowAt('2026-10-01T00:00:00.000Z'),
      sourceRefs: [...policy.sourceRefs].reverse(),
      outcome: { ...base.outcome, recordedAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(reorderedCurrent.issues.join(' ')).toContain('sourceRefs do not match the registry');

    const postCutoff = validate(rowAt('2026-09-25T00:00:00.000Z'));
    expect(postCutoff.issues.join(' ')).toContain('sourceRefs do not match the registry');
    expect(postCutoff.issues.join(' ')).toContain('canonicalHealth[0]: outcome violates registry');
  });

  it('mantiene esplicita la copertura mista dopo l entrata in vigore dei campi operativi', () => {
    const incomplete = canonicalHealthRowAt('2026-10-02T09:00:00.000Z', 'run-incomplete');
    const complete = canonicalHealthRowAt('2026-10-02T10:00:00.000Z', 'run-complete', OPERATIONAL_FIELDS);
    const verdict = validateAfterCutoff(incomplete, complete);
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

  it('does not promote complete-looking rows without the telemetry marker after the cutoff', () => {
    const unmarked = canonicalHealthRowAt('2026-10-02T10:00:00.000Z', 'run-unmarked', OPERATIONAL_COLUMNS);
    const verdict = validateAfterCutoff(unmarked);
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

  describe('righe del ledger anteriori ai campi operativi', () => {
    const currentRows = () => [
      canonicalHealthRowAt('2026-10-02T09:00:00.000Z', 'run-current-1', OPERATIONAL_FIELDS),
      canonicalHealthRowAt('2026-10-02T10:00:00.000Z', 'run-current-2', OPERATIONAL_FIELDS),
      canonicalHealthRowAt('2026-10-02T11:00:00.000Z', 'run-current-3', OPERATIONAL_FIELDS),
    ];

    it('fissa il cutoff dopo l ultima riga legacy misurata sul ledger', () => {
      expect(Number.isFinite(Date.parse(OPERATIONAL_FIELDS_REQUIRED_FROM))).toBe(true);
      expect(Date.parse(OPERATIONAL_FIELDS_REQUIRED_FROM)).toBeGreaterThan(Date.parse(LAST_MEASURED_LEGACY_ROW_AT));
    });

    it('esenta dalla completezza le righe senza campi scritte prima del cutoff e le conta a parte', () => {
      const legacyRows = [
        canonicalHealthRowAt('2026-09-13T02:57:48.574Z', 'run-legacy-1'),
        canonicalHealthRowAt('2026-09-14T12:00:00.000Z', 'run-legacy-2'),
        canonicalHealthRowAt(LAST_MEASURED_LEGACY_ROW_AT, 'run-legacy-3'),
      ];
      const current = currentRows();
      const verdict = validateAfterCutoff(...legacyRows, ...current);
      expect(verdict.issues.join(' ')).not.toContain('omits operational fields');
      expect(verdict.snapshot.health).toMatchObject({
        validRowCount: legacyRows.length + current.length,
        eligibleRuns: legacyRows.length + current.length,
        operationalMetricsComplete: true,
        operationalMetricsCompleteRuns: current.length,
        operationalMetricsIncompleteRuns: 0,
        operationalMetricsLegacyRuns: legacyRows.length,
      });
    });

    it('non somma retries, quota e collisioni delle righe legacy', () => {
      const legacy = canonicalHealthRowAt('2026-09-14T12:00:00.000Z', 'run-legacy', {
        ...OPERATIONAL_COLUMNS,
        retryCount: 50,
        quotaUnits: 70,
        collisions: 9,
      });
      const current = currentRows();
      const verdict = validateAfterCutoff(legacy, ...current);
      expect(verdict.snapshot.health).toMatchObject({
        operationalMetricsLegacyRuns: 1,
        retries: current.length * OPERATIONAL_FIELDS.retryCount,
        quotaUnits: current.length * OPERATIONAL_FIELDS.quotaUnits,
        artifactCollisions: 0,
      });
    });

    it('confronto stretto: l ultima riga legacy reale e esente, una riga al cutoff no', () => {
      const lastLegacy = validateAfterCutoff(canonicalHealthRowAt(LAST_MEASURED_LEGACY_ROW_AT, 'run-legacy'), ...currentRows());
      expect(lastLegacy.issues.join(' ')).not.toContain('omits operational fields');
      expect(lastLegacy.snapshot.health).toMatchObject({ operationalMetricsLegacyRuns: 1, operationalMetricsIncompleteRuns: 0 });

      const atCutoff = validateAfterCutoff(canonicalHealthRowAt(OPERATIONAL_FIELDS_REQUIRED_FROM, 'run-at-cutoff'), ...currentRows());
      expect(atCutoff.issues.join(' ')).toContain('canonical health ledger omits operational fields');
      expect(atCutoff.snapshot.health).toMatchObject({
        operationalMetricsComplete: false,
        operationalMetricsLegacyRuns: 0,
        operationalMetricsIncompleteRuns: 1,
      });
    });

    it('una riga senza campi scritta dopo il cutoff resta un errore del ledger', () => {
      const verdict = validateAfterCutoff(canonicalHealthRowAt('2026-09-20T00:00:00.000Z', 'run-regressed'), ...currentRows());
      expect(verdict.quality).toBe('partial');
      expect(verdict.issues.join(' ')).toContain('canonical health ledger omits operational fields');
      expect(verdict.snapshot.health).toMatchObject({
        operationalMetricsComplete: false,
        operationalMetricsLegacyRuns: 0,
        operationalMetricsIncompleteRuns: 1,
        retries: null,
        quotaUnits: null,
      });
    });

    it('valuta normalmente una riga anteriore al cutoff che porta il marcatore', () => {
      const marked = canonicalHealthRowAt('2026-09-14T12:00:00.000Z', 'run-marked', {
        ...OPERATIONAL_FIELDS,
        durationSeconds: -1,
      });
      const verdict = validateAfterCutoff(marked, ...currentRows());
      expect(verdict.issues.join(' ')).toContain('canonicalHealth[0]: durationSeconds is not a non-negative number');
      expect(verdict.snapshot.health).toMatchObject({ operationalMetricsLegacyRuns: 0, invalidRowCount: 1 });
    });

    it('non tratta come legacy una riga con recordedAt non valido', () => {
      const undated = canonicalHealthRowAt('not-a-date', 'run-undated');
      const verdict = validateAfterCutoff(undated, ...currentRows());
      expect(verdict.issues.join(' ')).toContain('canonicalHealth[0]: recordedAt is missing or invalid');
      expect(verdict.issues.join(' ')).toContain('canonical health ledger omits operational fields');
      expect(verdict.snapshot.health).toMatchObject({ operationalMetricsLegacyRuns: 0 });
    });

    it('lascia le righe legacy soggette a tutte le altre validazioni', () => {
      const legacyBadSha = canonicalHealthRowAt('2026-09-14T12:00:00.000Z', 'run-legacy-bad-sha', {
        execution: { ...canonicalHealthRow().execution, sha: 'not-a-sha' },
      });
      const current = currentRows();
      const verdict = validateAfterCutoff(legacyBadSha, ...current);
      expect(verdict.issues.join(' ')).toContain('canonicalHealth[0]: execution.sha is missing or not a full commit SHA');
      expect(verdict.snapshot.health).toMatchObject({
        validRowCount: current.length,
        operationalMetricsLegacyRuns: 0,
      });
    });
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

  it('uses the independent reconciliation artifact and never self-promotes health alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l10-independent-input-'));
    const registryPath = writeJson(dir, 'registry.json', registry());
    const quotaPath = writeJsonl(dir, 'quota.jsonl', [quotaRow()]);
    const reportDir = path.join(dir, 'report');
    const outcome = buildOutcome({
      outcomeId: 'verified-l10',
      status: 'zero',
      independent: true,
      sourceRefs: ['test-source'],
      primaryMetric: 'verified_metric',
      numerator: 0,
      denominator: 2,
      requiredFieldsPresent: ['generatedAt', 'numerator', 'denominator'],
      missingFields: [],
      reason: 'independent GitHub run and health join',
      observedAt: NOW.toISOString(),
      recordedAt: NOW.toISOString(),
    });
    const independentPath = writeJson(dir, 'independent.json', {
      outcome,
      metrics: { eligibleRuns: 2, joinedRuns: 2, reconciliationErrors: 0 },
    });

    const result = await runL10({
      now: NOW,
      registryPath,
      quotaPath,
      healthPath: path.join(dir, 'missing-health.jsonl'),
      independentOutcomePath: independentPath,
      reportDir,
      issue: false,
      logger: { log() {} },
    });

    expect(result.outcome).toMatchObject({ status: 'zero', independent: true, numerator: 0, denominator: 2 });
    expect(result.observation.outcome).toMatchObject({ status: 'zero', independent: true });
  });
});
