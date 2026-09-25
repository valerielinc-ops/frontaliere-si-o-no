import { describe, expect, it } from 'vitest';
import {
  evaluateTranslationCanaryIdentityV2,
  normalizeTranslationCanaryConfigV2,
  selectTranslationCanaryUnitsV2,
} from '../scripts/lib/translation-canary-v2.mjs';

const identities = Array.from({ length: 12 }, (_, index) => `translation-unit:v2:${String(index).padStart(64, '0')}`);

describe('translation canary v2', () => {
  it('defaults to a zero-exposure cohort and skips every planned identity', () => {
    const selection = selectTranslationCanaryUnitsV2({ identityKeys: identities.slice(0, 3) });

    expect(selection).toMatchObject({
      scopeKey: 'translation-shadow-v2',
      exposurePercent: 0,
      maxUnits: 25,
      eligibleUnits: 0,
      selectedUnits: 0,
      skippedUnits: 3,
    });
    expect(selection.selectedIdentityKeys).toEqual([]);
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it('keeps assignment stable across input ordering and repeated evaluations', () => {
    const forward = selectTranslationCanaryUnitsV2({
      scopeKey: 'translation-shadow-v2/stable',
      exposurePercent: 50,
      maxUnits: 12,
      identityKeys: identities,
    });
    const reverse = selectTranslationCanaryUnitsV2({
      scopeKey: 'translation-shadow-v2/stable',
      exposurePercent: 50,
      maxUnits: 12,
      identityKeys: [...identities].reverse(),
    });
    const repeated = evaluateTranslationCanaryIdentityV2({
      scopeKey: 'translation-shadow-v2/stable',
      exposurePercent: 50,
      identityKey: identities[0],
    });
    const repeatedAgain = evaluateTranslationCanaryIdentityV2({
      scopeKey: 'translation-shadow-v2/stable',
      exposurePercent: 50,
      identityKey: identities[0],
    });

    expect(forward.selectedIdentityKeys).toEqual(reverse.selectedIdentityKeys);
    expect(forward.decisions).toEqual(reverse.decisions);
    expect(repeated).toEqual(repeatedAgain);
  });

  it('enforces the cap after exposure selection', () => {
    const selection = selectTranslationCanaryUnitsV2({
      exposurePercent: 100,
      maxUnits: 2,
      identityKeys: identities.slice(0, 5),
    });

    expect(selection).toMatchObject({
      eligibleUnits: 5,
      selectedUnits: 2,
      skippedUnits: 3,
    });
    expect(selection.selectedIdentityKeys).toHaveLength(2);
  });

  it('fails closed for invalid or unbounded configuration', () => {
    expect(() => normalizeTranslationCanaryConfigV2({ exposurePercent: -1 })).toThrow();
    expect(() => normalizeTranslationCanaryConfigV2({ exposurePercent: 101 })).toThrow();
    expect(() => normalizeTranslationCanaryConfigV2({ maxUnits: 251 })).toThrow();
    expect(() => selectTranslationCanaryUnitsV2({ identityKeys: [''] })).toThrow();
  });
});
