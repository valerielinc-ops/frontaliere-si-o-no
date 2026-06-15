import { describe, expect, it } from 'vitest';

const { pickWinner, twoProportionTest, DEFAULT_WINNER_GATES } = await import('@/services/newsletter-ab-stats.mjs');
const { DEFAULT_EPSILON, listVariantIds } = await import('@/services/newsletter-subject-variants.mjs');
// assignSubjectVariant is server-only (node:crypto) — see newsletter-subject-assign.mjs.
const { assignSubjectVariant } = await import('@/services/newsletter-subject-assign.mjs');
const { previousCampaignIds } = await import('@/scripts/lib/newsletter-ab-data.mjs');

describe('pickWinner', () => {
  it('returns no winner when a sample is below the gate', () => {
    const r = pickWinner({ concreto: { sends: 50, opens: 30 }, curioso: { sends: 50, opens: 10 } });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe('insufficient sample');
  });

  it('returns no winner when the difference is not significant', () => {
    // 300 vs 300 sends, 90 vs 96 opens → close rates, not significant
    const r = pickWinner({ concreto: { sends: 300, opens: 90 }, curioso: { sends: 300, opens: 96 } });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe('not significant');
  });

  it('picks the higher-open-rate arm when significant and well-sampled', () => {
    // 1000 each: 320 vs 200 opens → 32% vs 20%, clearly significant
    const r = pickWinner({ concreto: { sends: 1000, opens: 320 }, curioso: { sends: 1000, opens: 200 } });
    expect(r.winner).toBe('concreto');
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('honors custom gates', () => {
    const tight = pickWinner({ a: { sends: 100, opens: 40 }, b: { sends: 100, opens: 20 } }, { minSendsPerArm: 500 });
    expect(tight.winner).toBeNull(); // 100 < 500
  });
});

describe('twoProportionTest', () => {
  it('is null when an arm has no sends', () => {
    expect(twoProportionTest({ sends: 0, opens: 0 }, { sends: 10, opens: 5 })).toBeNull();
  });
});

describe('assignSubjectVariant epsilon-greedy promotion', () => {
  const N = 6000;
  const ids = listVariantIds();
  const promoted = ids[0];

  it('stays a ~even split with no promotion (baseline)', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const v = assignSubjectVariant(`b${i}@x.com`, 'weekly_2026-06-15');
      counts[v] = (counts[v] || 0) + 1;
    }
    expect(counts[promoted] / N).toBeGreaterThan(0.4);
    expect(counts[promoted] / N).toBeLessThan(0.6);
  });

  it('biases toward the promoted variant (~1-epsilon+epsilon/k) but still explores', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const v = assignSubjectVariant(`p${i}@x.com`, 'weekly_2026-06-15', { promotedVariant: promoted, epsilon: DEFAULT_EPSILON });
      counts[v] = (counts[v] || 0) + 1;
    }
    const share = counts[promoted] / N;
    const expected = (1 - DEFAULT_EPSILON) + DEFAULT_EPSILON / ids.length; // k=2 → 0.9
    expect(share).toBeGreaterThan(expected - 0.05);
    expect(share).toBeLessThan(expected + 0.05);
    // the losing arm still gets meaningful traffic (test stays live)
    const loser = ids.find((x) => x !== promoted)!;
    expect(counts[loser] / N).toBeGreaterThan(0.04);
  });

  it('is deterministic with promotion (stable per subscriber within a campaign)', () => {
    const a = assignSubjectVariant('Same@x.com', 'weekly_2026-06-15', { promotedVariant: promoted });
    const b = assignSubjectVariant('same@x.com', 'weekly_2026-06-15', { promotedVariant: promoted });
    expect(a).toBe(b);
  });

  it('ignores an unknown promoted variant (falls back to even split)', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const v = assignSubjectVariant(`u${i}@x.com`, 'weekly_2026-06-15', { promotedVariant: 'nope' });
      counts[v] = (counts[v] || 0) + 1;
    }
    expect(counts[promoted] / N).toBeGreaterThan(0.4);
    expect(counts[promoted] / N).toBeLessThan(0.6);
  });

  it('epsilon=0 promotes the winner to (almost) everyone', () => {
    let promotedCount = 0;
    for (let i = 0; i < N; i++) {
      if (assignSubjectVariant(`z${i}@x.com`, 'weekly_2026-06-15', { promotedVariant: promoted, epsilon: 0 }) === promoted) promotedCount++;
    }
    expect(promotedCount).toBe(N);
  });

  it('backward compatible: a plain 2-arg call is the uniform baseline', () => {
    expect(typeof assignSubjectVariant('x@y.com', 'weekly_2026-06-15')).toBe('string');
  });
});

describe('previousCampaignIds', () => {
  it('returns the prior Mondays, most recent first', () => {
    expect(previousCampaignIds('weekly_2026-06-15', 2)).toEqual(['weekly_2026-06-08', 'weekly_2026-06-01']);
  });
  it('returns [] for a malformed campaign id', () => {
    expect(previousCampaignIds('not-a-campaign', 2)).toEqual([]);
  });
});
