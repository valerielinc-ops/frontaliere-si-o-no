// tests/scripts/lib/discovery/discoveryScore.test.ts
//
// Spec § 6.4 — source-specific scoring with confidence multipliers
// (orphan 1.0, suggest 0.6, news 0.7) and freshness boost on news.

import { describe, expect, it } from 'vitest';

import {
  discoveryScore,
  freshnessFactorForAgeHours,
} from '../../../../scripts/lib/discovery/discoveryScore.mjs';

const evidence = {
  windowDays: 90,
  clusterStats: {
    fiscale: { p50: 200, p10: 50, p90: 800, n: 30 },
    salute: { p50: 120, p10: 30, p90: 500, n: 20 },
    generic: { p50: 50, p10: 5, p90: 200, n: 100 },
  },
};

describe('freshnessFactorForAgeHours', () => {
  it('returns 1.3 at age 0', () => {
    expect(freshnessFactorForAgeHours(0)).toBeCloseTo(1.3, 5);
  });

  it('returns 1.0 at age >= 48h', () => {
    expect(freshnessFactorForAgeHours(48)).toBe(1);
    expect(freshnessFactorForAgeHours(96)).toBe(1);
  });

  it('decays linearly between 0 and 48h', () => {
    expect(freshnessFactorForAgeHours(24)).toBeCloseTo(1.15, 5);
  });

  it('handles missing/invalid age safely', () => {
    expect(freshnessFactorForAgeHours(NaN)).toBe(1);
    expect(freshnessFactorForAgeHours(undefined as unknown as number)).toBe(1);
  });
});

describe('discoveryScore — orphan', () => {
  it('uses (imp / windowDays) * (clusterP50 / 400) * confidence(1.0)', () => {
    const out = discoveryScore(
      {
        headline: 'Tassazione frontalieri ticino',
        source: 'orphan',
        meta: { imp: 9000, pos: 12, ctr: 0.005 },
      },
      evidence,
    );
    // 9000/90 = 100, 100 * (200/400) = 50, * 1.0 = 50
    expect(out.source).toBe('orphan');
    expect(out.confidence).toBe(1.0);
    expect(out.freshnessFactor).toBe(1);
    expect(out.rawScore).toBeCloseTo(50, 5);
    expect(out.finalScore).toBeCloseTo(50, 5);
  });

  it('falls back to default cluster p50 when cluster is unknown', () => {
    const out = discoveryScore(
      {
        headline: 'something completely off topic xyz',
        source: 'orphan',
        meta: { imp: 900, pos: 12, ctr: 0.005 },
      },
      { windowDays: 90, clusterStats: {} },
    );
    // generic cluster, fallback p50 = 100, so multiplier = 100/400 = 0.25
    expect(out.rawScore).toBeGreaterThan(0);
  });
});

describe('discoveryScore — suggest', () => {
  it('uses clusterP50 * 0.5 * confidence(0.6)', () => {
    const out = discoveryScore(
      {
        headline: 'Tasse svizzera frontalieri',
        source: 'suggest',
        meta: { seed: 'tasse svizzera', rank: 0 },
      },
      evidence,
    );
    expect(out.source).toBe('suggest');
    expect(out.confidence).toBeCloseTo(0.6, 5);
    expect(out.rawScore).toBeCloseTo(100, 5); // 200 * 0.5
    expect(out.finalScore).toBeCloseTo(60, 5); // 100 * 0.6
  });

  // Regression — 2026-05-11 `mobilita-palermo-frontalieri-ticino`.
  // Suggest candidates that lack any Ticino/frontalieri anchor token
  // MUST be rejected at the score gate as a backstop, even if an
  // upstream filter ever lets them through.
  it('throws on suggest candidate with no domain anchor (Palermo regression)', () => {
    expect(() =>
      discoveryScore(
        {
          headline: 'mobilita palermo',
          source: 'suggest',
          meta: { seed: 'mobilita', rank: 0 },
        },
        evidence,
      ),
    ).toThrow(/lacks a Ticino\/frontalieri anchor/);
  });

  it('throws on other off-topic Italian-city suggest candidates', () => {
    for (const headline of ['salute roma', 'pensioni napoli', 'fiscale milano centro']) {
      expect(() =>
        discoveryScore(
          { headline, source: 'suggest', meta: { seed: 'x', rank: 0 } },
          evidence,
        ),
      ).toThrow(/lacks a Ticino\/frontalieri anchor/);
    }
  });

  it('accepts anchored suggest candidates (e.g. with toponym or AVS/LPP)', () => {
    for (const headline of [
      'mobilita lugano frontalieri',
      'salute mendrisio',
      'lpp ginevra',
      'busta paga svizzera',
    ]) {
      expect(() =>
        discoveryScore(
          { headline, source: 'suggest', meta: { seed: 'x', rank: 0 } },
          evidence,
        ),
      ).not.toThrow();
    }
  });
});

describe('discoveryScore — news', () => {
  it('uses clusterP50 * confidence(0.7) * freshnessFactor', () => {
    const out = discoveryScore(
      {
        headline: 'Tassazione frontalieri novità',
        source: 'news',
        meta: { ageHours: 0 },
      },
      evidence,
    );
    expect(out.source).toBe('news');
    expect(out.confidence).toBeCloseTo(0.7, 5);
    expect(out.freshnessFactor).toBeCloseTo(1.3, 5);
    expect(out.finalScore).toBeCloseTo(200 * 0.7 * 1.3, 5);
  });

  it('drops freshness boost beyond 48h', () => {
    const out = discoveryScore(
      {
        headline: 'Tassazione frontalieri',
        source: 'news',
        meta: { ageHours: 100 },
      },
      evidence,
    );
    expect(out.freshnessFactor).toBe(1);
  });
});

describe('discoveryScore — error handling', () => {
  it('throws on unknown source', () => {
    expect(() => discoveryScore({ headline: 'x', source: 'bogus' as any }, evidence)).toThrow();
  });

  it('throws on missing candidate', () => {
    expect(() => discoveryScore(null as any, evidence)).toThrow();
  });
});
