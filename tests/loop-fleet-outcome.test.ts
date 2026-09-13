import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — the helper is a dependency-free ESM CI module.
import { buildValidatedLoopOutcome } from '../scripts/lib/loop-fleet-outcome.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));
const NOW = new Date('2026-09-13T12:00:00.000Z');

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
