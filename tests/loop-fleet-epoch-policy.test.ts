import { describe, expect, it } from 'vitest';
import {
  LEDGER_EPOCH_LIMITS,
  ledgerEpochDecision,
} from '../scripts/ci/loop-fleet-epoch-policy.mjs';

describe('loop-fleet ledger epoch policy', () => {
  it('allows a new epoch without an open PR', () => {
    expect(ledgerEpochDecision()).toMatchObject({ allow: true, reason: 'no-open-epoch' });
  });

  it('allows a bounded append before either limit', () => {
    expect(ledgerEpochDecision({
      openPr: true,
      batchCount: LEDGER_EPOCH_LIMITS.maxBatches - 1,
      ageMinutes: LEDGER_EPOCH_LIMITS.maxAgeMinutes - 1,
    })).toMatchObject({ allow: true, reason: 'within-bounds' });
  });

  it('freezes the epoch at the batch cap', () => {
    expect(ledgerEpochDecision({
      openPr: true,
      batchCount: LEDGER_EPOCH_LIMITS.maxBatches,
      ageMinutes: 1,
    })).toMatchObject({ allow: false, reason: 'batch-cap-reached' });
  });

  it('freezes the epoch at the age cap', () => {
    expect(ledgerEpochDecision({
      openPr: true,
      batchCount: 1,
      ageMinutes: LEDGER_EPOCH_LIMITS.maxAgeMinutes,
    })).toMatchObject({ allow: false, reason: 'age-cap-reached' });
  });

  it('freezes when an open epoch has no trustworthy age', () => {
    expect(ledgerEpochDecision({ openPr: true, batchCount: 1 })).toMatchObject({
      allow: false,
      reason: 'epoch-age-unavailable',
    });
  });
});
