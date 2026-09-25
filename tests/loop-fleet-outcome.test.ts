import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — the helper is a dependency-free ESM CI module.
import { buildValidatedLoopOutcome, validateLoopOutcomeProvenance } from '../scripts/lib/loop-fleet-outcome.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));
const NOW = new Date('2026-09-13T12:00:00.000Z');

function directEvidence({
  outcomeId = 'error-free-useful-session',
  sourceRefs = ['posthog-error-telemetry'],
  primaryMetric = 'error_free_useful_session_rate',
  status = 'observed',
  numerator = 95,
  denominator = 100,
  source = 'synthetic-independent-test-source',
} = {}) {
  return {
    candidate: {
      recordType: 'outcome',
      schemaVersion: 1,
      outcomeId,
      status,
      independent: true,
      sourceRefs,
      primaryMetric,
      numerator,
      denominator,
      observedAt: NOW.toISOString(),
    },
    sourceSnapshot: { source },
    decision: {
      recordId: 'candidate-test-1',
      decision: 'candidate',
      sourceSnapshot: { source },
      startedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
      decidedAt: NOW.toISOString(),
    },
  };
}

describe('loop-fleet-outcome', () => {
  it('keeps a validated independent measurement and registry metadata together', () => {
    const outcome = buildValidatedLoopOutcome({
      registry,
      loopId: 'L1',
      quality: 'observed',
      independent: true,
      numerator: 95,
      denominator: 100,
      observedAt: NOW.toISOString(),
      reason: 'fresh independent telemetry export',
      now: NOW,
      evidence: directEvidence(),
    });

    expect(outcome).toMatchObject({
      recordType: 'outcome',
      outcomeId: 'error-free-useful-session',
      status: 'observed',
      independent: true,
      numerator: 95,
      denominator: 100,
      requiredFieldsPresent: ['generatedAt', 'numerator', 'denominator'],
      missingFields: [],
      primaryMetric: 'error_free_useful_session_rate',
    });
  });

  it('downgrades a green-looking result when independence or fields are absent', () => {
    const outcome = buildValidatedLoopOutcome({
      registry,
      loopId: 'L2',
      quality: 'observed',
      independent: false,
      numerator: 12,
      denominator: 1000,
      observedAt: null,
      reason: 'source join is not independently attested',
      now: NOW,
    });

    expect(outcome).toMatchObject({
      status: 'partial',
      independent: false,
      numerator: null,
      denominator: null,
      requiredFieldsPresent: [],
      missingFields: ['generatedAt', 'numerator', 'denominator'],
    });
  });

  it('rejects an independent claim without direct evidence', () => {
    const outcome = buildValidatedLoopOutcome({
      registry,
      loopId: 'L1',
      quality: 'observed',
      independent: true,
      numerator: 95,
      denominator: 100,
      observedAt: NOW.toISOString(),
      reason: 'source join is not attached',
      now: NOW,
    });

    expect(outcome).toMatchObject({
      status: 'partial',
      independent: false,
      numerator: null,
      denominator: null,
    });
    expect(outcome.reason).toContain('independent outcome evidence is missing');
  });

  it('requires a direct source, candidate and TTL chain when provenance is supplied', () => {
    const policy = registry.loops.find((loop: any) => loop.loopId === 'L1');
    const evidence = directEvidence();
    const { candidate, decision, sourceSnapshot } = evidence;

    expect(validateLoopOutcomeProvenance({
      policy,
      candidate,
      sourceSnapshot,
      decision,
      now: NOW,
    })).toMatchObject({
      ok: true,
      candidateId: 'candidate-test-1',
      sourceRecordId: 'candidate-test-1',
      source: 'synthetic-independent-test-source',
    });

    const rejected = buildValidatedLoopOutcome({
      registry,
      loopId: 'L1',
      quality: 'observed',
      independent: true,
      numerator: 95,
      denominator: 100,
      observedAt: NOW.toISOString(),
      reason: 'source join is not attached',
      now: NOW,
      evidence: {
        candidate,
        sourceSnapshot,
        decision: { ...decision, expiresAt: new Date(NOW.getTime() - 1_000).toISOString() },
      },
    });

    expect(rejected).toMatchObject({
      status: 'partial',
      independent: false,
      numerator: null,
      denominator: null,
    });

    const mismatched = buildValidatedLoopOutcome({
      registry,
      loopId: 'L1',
      quality: 'observed',
      independent: true,
      numerator: 95,
      denominator: 100,
      observedAt: NOW.toISOString(),
      reason: 'candidate status is not measured',
      now: NOW,
      evidence: {
        candidate: { ...candidate, status: 'partial' },
        sourceSnapshot,
        decision,
      },
    });

    expect(mismatched).toMatchObject({
      status: 'partial',
      independent: false,
      numerator: null,
      denominator: null,
    });
  });

  it('rejects a measured outcome attached to a non-candidate decision', () => {
    const policy = registry.loops.find((loop: any) => loop.loopId === 'L1');
    const evidence = directEvidence();
    const decision = { ...evidence.decision, decision: 'observing' };
    const validation = validateLoopOutcomeProvenance({
      policy,
      candidate: evidence.candidate,
      sourceSnapshot: evidence.sourceSnapshot,
      decision,
      now: NOW,
    });

    expect(validation).toMatchObject({ ok: false });
    expect(validation.errors).toContain('independent outcome decision must be candidate');

    const outcome = buildValidatedLoopOutcome({
      registry,
      loopId: 'L1',
      quality: 'observed',
      independent: true,
      numerator: 95,
      denominator: 100,
      observedAt: NOW.toISOString(),
      reason: 'non-candidate decision must not measure',
      now: NOW,
      evidence: { ...evidence, decision },
    });

    expect(outcome).toMatchObject({ status: 'partial', independent: false, numerator: null, denominator: null });
  });

  it('rejects evidence whose status differs from the requested quality', () => {
    const outcome = buildValidatedLoopOutcome({
      registry,
      loopId: 'L1',
      quality: 'observed',
      independent: true,
      numerator: 95,
      denominator: 100,
      observedAt: NOW.toISOString(),
      reason: 'evidence status must match quality',
      now: NOW,
      evidence: directEvidence({ status: 'zero' }),
    });

    expect(outcome).toMatchObject({ status: 'partial', independent: false, numerator: null, denominator: null });
    expect(outcome.reason).toContain('independent outcome status is not linked to the requested quality');
  });

  it('preserves the registry exception for commercial money versus exposures', () => {
    const outcome = buildValidatedLoopOutcome({
      registry,
      loopId: 'L8',
      quality: 'observed',
      independent: true,
      numerator: 1200,
      denominator: 100,
      observedAt: NOW.toISOString(),
      reason: 'authorised approved-money export',
      now: NOW,
      evidence: directEvidence({
        outcomeId: 'approved-commercial-attribution',
        sourceRefs: ['adsense', 'gsc', 'posthog', 'publisher', 'authorised-affiliate-commercial-export', 'revenue-monitor'],
        primaryMetric: 'approved_net_chf_per_1000_relevant_exposures',
        numerator: 1200,
        denominator: 100,
      }),
    });

    expect(outcome).toMatchObject({
      status: 'observed',
      independent: true,
      numerator: 1200,
      denominator: 100,
      allowNumeratorExceedDenominator: true,
    });
  });
});
