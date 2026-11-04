import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createMatchedBlockExperimentRegistration,
  evaluateMatchedBlockExperiment,
  validateMatchedBlockExperimentRegistration,
} from '../scripts/lib/social-experiment-protocol.mjs';

const GUARDRAILS = {
  platformPolicyClear: true,
  reservationLeaks: 0,
  duplicatePostIds: 0,
  metricCoverage: 1,
  syntheticAaCalibration: 'passed',
};

function registration() {
  const createdAt = '2026-11-01T00:00:00.000Z';
  const baselineObservations = Array.from({ length: 30 }, (_, index) => ({
    exact: true,
    postId: 'baseline-' + index,
    numerator: index % 2 === 0 ? 9 : 11,
    denominator: 100,
    publishedAt: new Date(Date.parse(createdAt) - (31 - index) * 86400000).toISOString(),
  }));
  return createMatchedBlockExperimentRegistration({
    experimentId: 'social-copy-angle-matched-v3',
    packId: '0123456789abcdef',
    treatmentFingerprint: 'c'.repeat(64),
    channel: 'instagram',
    slot: 'article',
    objective: 'share',
    arms: ['share-one', 'share-two', 'share-three'],
    metric: { numerator: 'shares', denominator: 'reach', windowHours: 72 },
    baselineObservations,
    createdAt,
  });
}

function blockRows(frozen: ReturnType<typeof registration>, { winner = true, incomplete = false } = {}) {
  const start = Date.parse(frozen.startsAt);
  const arms = frozen.arms;
  return Array.from({ length: frozen.plannedBlocks }, (_, index) => {
    const publishedAt = new Date(start + index * 86400000).toISOString();
    const blockId = createHash('sha256').update('block-' + index).digest('hex');
    const selectedArms = incomplete && index === frozen.plannedBlocks - 1 ? arms.slice(0, 2) : arms;
    return selectedArms.map((arm) => {
      const isWinner = arm === arms[0];
      const numerator = winner ? (isWinner ? 20 : 10) : (isWinner ? 11 : 10);
      return {
        channel: 'instagram',
        postId: `media-${index}-${arm}`,
        publishedAt,
        snapshotAt: new Date(Date.parse(publishedAt) + 72 * 3600000).toISOString(),
        snapshotAgeHours: 72,
        windowHours: 72,
        metrics: { shares: numerator, reach: 100 },
        availableMetrics: ['shares', 'reach'],
        matchMethod: 'ledger-media-id',
        copyAttributionStatus: 'exact',
        copyMode: 'codex',
        copyAssignmentMode: 'firebase-balanced',
        copyExperimentId: frozen.experimentId,
        copyPackId: 'fedcba9876543210',
        copySlot: frozen.slot,
        copyObjective: frozen.objective,
        copyTemplateId: `template-${arm}`,
        copyAngleId: arm,
        copyRegistrationHash: frozen.registrationHash,
        copyBlockId: blockId,
        copyBlockCycle: index,
      };
    });
  }).flat();
}

describe('matched-block social-copy experiment protocol', () => {
  it('freezes a hashed, fixed-sample registration from exact historical outcomes', () => {
    const frozen = registration();
    expect(frozen).toMatchObject({
      protocolVersion: 'social-copy-angle-matched-block-v3',
      baselinePopulationScope: 'same-slot-metric-across-objectives',
      channel: 'instagram',
      metric: { numerator: 'shares', denominator: 'reach', windowHours: 72 },
      baseline: { observations: 30 },
      familySize: 3,
      plannedBlocks: expect.any(Number),
      registrationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(validateMatchedBlockExperimentRegistration(frozen)).toBe(frozen);
    const changed = { ...frozen, absoluteMde: frozen.absoluteMde / 2 };
    expect(() => validateMatchedBlockExperimentRegistration(changed)).toThrow(/hash mismatch/u);
  });

  it('supports a slower Reel baseline without reducing the fixed statistical sample', () => {
    const createdAt = '2026-11-01T00:00:00.000Z';
    const baselineObservations = Array.from({ length: 30 }, (_, index) => ({
      exact: true,
      postId: `reel-baseline-${index}`,
      numerator: index % 2 === 0 ? 9 : 11,
      denominator: 100,
      publishedAt: new Date(Date.parse(createdAt) - (120 - index * 4) * 86400000).toISOString(),
    }));
    const frozen = createMatchedBlockExperimentRegistration({
      experimentId: 'social-copy-angle-matched-v3',
      packId: '0123456789abcdef',
      treatmentFingerprint: 'd'.repeat(64),
      channel: 'instagram',
      slot: 'reel',
      objective: 'follow',
      arms: ['reel-angle-one', 'reel-angle-two', 'reel-angle-three'],
      metric: { numerator: 'follows', denominator: 'reach', windowHours: 72 },
      baselineObservations,
      baselineMaxSpanDays: 120,
      createdAt,
    });

    expect(frozen).toMatchObject({
      baselineMaxSpanDays: 120,
      baselinePopulationScope: 'same-objective',
      baseline: { observations: 30 },
    });
    expect(frozen.plannedBlocks).toBeGreaterThanOrEqual(25);
    expect(frozen.estimatedDurationDays).toBeLessThanOrEqual(365);
    expect(validateMatchedBlockExperimentRegistration(frozen)).toBe(frozen);
  });

  it('promotes only a fixed-sample arm that clears matched and family-wise thresholds', () => {
    const frozen = registration();
    const result = evaluateMatchedBlockExperiment({
      registration: frozen,
      observations: blockRows(frozen),
      asOf: new Date(Date.parse(frozen.startsAt) + (frozen.plannedBlocks + 4) * 86400000),
      guardrails: GUARDRAILS,
    });
    expect(result).toMatchObject({
      status: 'winner',
      winnerAngleId: frozen.arms[0],
      completeBlocks: frozen.plannedBlocks,
      comparisons: expect.arrayContaining([
        expect.objectContaining({ adjustedPValue: expect.any(Number), lowerBound: expect.any(Number) }),
      ]),
    });
  });

  it('holds when the preregistered minimum effect is not reached', () => {
    const frozen = registration();
    const result = evaluateMatchedBlockExperiment({
      registration: frozen,
      observations: blockRows(frozen, { winner: false }),
      asOf: new Date(Date.parse(frozen.startsAt) + (frozen.plannedBlocks + 4) * 86400000),
      guardrails: GUARDRAILS,
    });
    expect(result.status).toBe('hold');
    expect(result.winnerAngleId).toBeNull();
  });

  it('expires an unfinished cohort at its preregistered maximum duration', () => {
    const frozen = registration();
    const expiredAt = new Date(Date.parse(frozen.startsAt) + (frozen.maximumDurationDays + 1) * 86400000);
    const result = evaluateMatchedBlockExperiment({
      registration: frozen,
      observations: [],
      asOf: expiredAt,
      guardrails: GUARDRAILS,
    });

    expect(result).toMatchObject({
      status: 'expired',
      reason: 'maximum experiment duration elapsed before the fixed sample completed',
      completeBlocks: 0,
      plannedBlocks: frozen.plannedBlocks,
    });
  });

  it('does not evaluate incomplete or non-exact post attribution as a winner', () => {
    const frozen = registration();
    const observations = blockRows(frozen, { incomplete: true });
    const collecting = evaluateMatchedBlockExperiment({
      registration: frozen,
      observations,
      asOf: new Date(Date.parse(frozen.startsAt) + (frozen.plannedBlocks + 4) * 86400000),
      guardrails: GUARDRAILS,
    });
    expect(collecting.status).toBe('collecting');

    const inferred = blockRows(frozen);
    inferred[0].copyAttributionStatus = 'inferred';
    const invalid = evaluateMatchedBlockExperiment({
      registration: frozen,
      observations: inferred,
      asOf: new Date(Date.parse(frozen.startsAt) + (frozen.plannedBlocks + 4) * 86400000),
      guardrails: GUARDRAILS,
    });
    expect(invalid.status).toBe('data-integrity-failed');

    const browserAttributed = blockRows(frozen);
    browserAttributed[0].matchMethod = 'browser-cover-fingerprint';
    const browserInvalid = evaluateMatchedBlockExperiment({
      registration: frozen,
      observations: browserAttributed,
      asOf: new Date(Date.parse(frozen.startsAt) + (frozen.plannedBlocks + 4) * 86400000),
      guardrails: GUARDRAILS,
    });
    expect(browserInvalid.status).toBe('data-integrity-failed');
  });

  it('fails closed when delivery, platform, or measurement guardrails are unhealthy', () => {
    const frozen = registration();
    const result = evaluateMatchedBlockExperiment({
      registration: frozen,
      observations: blockRows(frozen),
      asOf: new Date(Date.parse(frozen.startsAt) + (frozen.plannedBlocks + 4) * 86400000),
      guardrails: { ...GUARDRAILS, reservationLeaks: 1 },
    });
    expect(result).toMatchObject({ status: 'hold' });
  });
});
