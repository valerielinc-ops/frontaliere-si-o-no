// tests/scripts/lib/scheduler/slugSimilarity.test.ts
//
// Spec § 6.5 — cross-pool dedup acceptance: 'frontaliere ticino' vs
// 'frontalieri in ticino' must clear the 0.7 threshold.

import { describe, expect, it } from 'vitest';

import {
  jaccardSimilarity,
  isNearDuplicate,
  tokenizeForSimilarity,
  SLUG_SIMILARITY_THRESHOLD,
} from '../../../../scripts/lib/scheduler/slugSimilarity.mjs';

describe('tokenizeForSimilarity', () => {
  it('drops tokens shorter than 3 chars', () => {
    expect(tokenizeForSimilarity('a be cat dog')).toEqual(['cat', 'dog']);
  });

  it('lowercases and strips diacritics', () => {
    expect(tokenizeForSimilarity('Tassazione Ticinó')).toEqual(['tassazione', 'ticino']);
  });

  it('returns empty for non-string input', () => {
    expect(tokenizeForSimilarity('')).toEqual([]);
    expect(tokenizeForSimilarity(undefined as unknown as string)).toEqual([]);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaccardSimilarity('frontalieri ticino', 'frontalieri ticino')).toBe(1);
  });

  it('returns 0 for empty inputs', () => {
    expect(jaccardSimilarity('', 'frontalieri')).toBe(0);
    expect(jaccardSimilarity('frontalieri', '')).toBe(0);
  });

  it('catches frontaliere/frontalieri inflection (acceptance § 6.5)', () => {
    const sim = jaccardSimilarity('frontaliere ticino', 'frontalieri in ticino');
    expect(sim).toBeGreaterThanOrEqual(SLUG_SIMILARITY_THRESHOLD);
  });

  it('treats unrelated headlines as non-duplicates', () => {
    const sim = jaccardSimilarity('Permesso G novità 2026', 'Mercato lavoro Lugano disoccupazione');
    expect(sim).toBeLessThan(SLUG_SIMILARITY_THRESHOLD);
  });

  it('is symmetric', () => {
    const a = 'tasse svizzera frontaliere';
    const b = 'tassazione frontalieri svizzera';
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });
});

describe('isNearDuplicate', () => {
  it('returns false against an empty corpus', () => {
    expect(isNearDuplicate('foo bar baz', [])).toBe(false);
  });

  it('returns true when at least one corpus entry clears the threshold', () => {
    const corpus = [
      'Mercato lavoro Lugano',
      'Frontalieri in Ticino',
    ];
    expect(isNearDuplicate('frontaliere ticino', corpus)).toBe(true);
  });

  it('returns false when no corpus entry clears the threshold', () => {
    const corpus = [
      'Mercato lavoro Lugano',
      'Borsa di studio Berna',
    ];
    expect(isNearDuplicate('Permesso B Bellinzona aggiornamenti', corpus)).toBe(false);
  });

  it('respects custom threshold override', () => {
    const corpus = ['mercato lavoro lugano'];
    // With a permissive threshold, a single-token overlap should match.
    expect(isNearDuplicate('lavoro disoccupazione', corpus, 0.2)).toBe(true);
    expect(isNearDuplicate('lavoro disoccupazione', corpus, 0.95)).toBe(false);
  });
});
