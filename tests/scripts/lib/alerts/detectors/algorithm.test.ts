// tests/scripts/lib/alerts/detectors/algorithm.test.ts
//
// Spec § 8 — Category A detectors (A.1 cluster monoculture, A.2 pool
// starvation, A.3 all-low-score, A.4 quota oscillation, A.5 confidence
// stage collapse).

import { describe, expect, it } from 'vitest';

import { detectAlgorithm } from '../../../../../scripts/lib/alerts/detectors/algorithm.mjs';

const NOW = Date.parse('2026-05-08T00:00:00Z');
const DAY = 24 * 3600 * 1000;

const config = {
  monoculture_threshold: 0.4,
  quota_oscillation_threshold: 15,
  all_low_score_consecutive: 5,
};

const baseEvidence = {
  clusterStats: {
    generic: { p10: 10, p50: 100, p90: 500, n: 50 },
    fiscale: { p10: 20, p50: 200, p90: 800, n: 30 },
  },
};

function makeArticle(overrides: Record<string, unknown>) {
  return {
    slug: 'art',
    publishedAt: new Date(NOW - DAY).toISOString(),
    cluster: 'generic',
    _pool: 'proven',
    _score_breakdown: { stage: 'gsc', finalScore: 200 },
    ...overrides,
  };
}

describe('A.1 cluster monoculture', () => {
  it('fires when one cluster exceeds 40% in last 7d', () => {
    const articles = Array.from({ length: 10 }, (_, i) => makeArticle({
      slug: `s${i}`,
      cluster: i < 6 ? 'fiscale' : 'salute',
      publishedAt: new Date(NOW - i * DAY).toISOString(),
    }));
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    const ids = out.map((a: any) => a.id);
    expect(ids).toContain('A.1.cluster-monoculture');
  });

  it('does not fire when distribution is balanced', () => {
    const clusters = ['fiscale', 'salute', 'lavoro', 'casa', 'generic'];
    const articles = clusters.flatMap((c, i) => [
      makeArticle({ slug: `${c}-1`, cluster: c, publishedAt: new Date(NOW - i * DAY).toISOString() }),
      makeArticle({ slug: `${c}-2`, cluster: c, publishedAt: new Date(NOW - (i + 1) * DAY).toISOString() }),
    ]);
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.1.cluster-monoculture')).toBeUndefined();
  });

  it('skips when sample < 5', () => {
    const articles = [makeArticle({ cluster: 'fiscale' })];
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.1.cluster-monoculture')).toBeUndefined();
  });
});

describe('A.2 pool starvation', () => {
  it('fires when last 3 are all evergreen-fallback', () => {
    const articles = [
      makeArticle({ slug: 's1', _pool: 'evergreen-fallback', publishedAt: new Date(NOW - 1 * DAY).toISOString() }),
      makeArticle({ slug: 's2', _pool: 'evergreen-fallback', publishedAt: new Date(NOW - 2 * DAY).toISOString() }),
      makeArticle({ slug: 's3', _pool: 'evergreen-fallback', publishedAt: new Date(NOW - 3 * DAY).toISOString() }),
    ];
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.2.pool-starvation')).toBeDefined();
  });

  it('does not fire if any of last 3 is non-evergreen', () => {
    const articles = [
      makeArticle({ slug: 's1', _pool: 'evergreen-fallback', publishedAt: new Date(NOW - 1 * DAY).toISOString() }),
      makeArticle({ slug: 's2', _pool: 'proven', publishedAt: new Date(NOW - 2 * DAY).toISOString() }),
      makeArticle({ slug: 's3', _pool: 'evergreen-fallback', publishedAt: new Date(NOW - 3 * DAY).toISOString() }),
    ];
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.2.pool-starvation')).toBeUndefined();
  });
});

describe('A.3 all-low-score', () => {
  it('fires when last 5 picks all scored below cluster p10', () => {
    const articles = Array.from({ length: 5 }, (_, i) => makeArticle({
      slug: `s${i}`,
      publishedAt: new Date(NOW - (i + 1) * DAY).toISOString(),
      _score_breakdown: { stage: 'cluster', finalScore: 5 },
    }));
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.3.all-low-score')).toBeDefined();
  });

  it('does not fire when at least one pick beats p10', () => {
    const articles = Array.from({ length: 5 }, (_, i) => makeArticle({
      slug: `s${i}`,
      publishedAt: new Date(NOW - (i + 1) * DAY).toISOString(),
      _score_breakdown: { stage: 'cluster', finalScore: i === 2 ? 150 : 5 },
    }));
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.3.all-low-score')).toBeUndefined();
  });
});

describe('A.4 quota oscillation', () => {
  it('fires when quota delta over 7d exceeds threshold', () => {
    const quotaState = {
      history: [
        { timestamp: new Date(NOW - 8 * DAY).toISOString(), newQuota: 60 },
        { timestamp: new Date(NOW - 1 * DAY).toISOString(), newQuota: 90 },
      ],
    };
    const out = detectAlgorithm({ articles: [], evidence: baseEvidence, quotaState, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.4.quota-oscillation')).toBeDefined();
  });

  it('does not fire when delta is small', () => {
    const quotaState = {
      history: [
        { timestamp: new Date(NOW - 8 * DAY).toISOString(), newQuota: 80 },
        { timestamp: new Date(NOW - 1 * DAY).toISOString(), newQuota: 85 },
      ],
    };
    const out = detectAlgorithm({ articles: [], evidence: baseEvidence, quotaState, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.4.quota-oscillation')).toBeUndefined();
  });
});

describe('A.5 confidence-stage collapse', () => {
  it('fires when >80% recent picks are stage=cluster', () => {
    const articles = Array.from({ length: 10 }, (_, i) => makeArticle({
      slug: `s${i}`,
      publishedAt: new Date(NOW - i * DAY).toISOString(),
      _score_breakdown: { stage: i === 0 ? 'gsc' : 'cluster', finalScore: 50 },
    }));
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.5.confidence-stage-collapse')).toBeDefined();
  });

  it('does not fire when stages are mixed', () => {
    const articles = Array.from({ length: 10 }, (_, i) => makeArticle({
      slug: `s${i}`,
      publishedAt: new Date(NOW - i * DAY).toISOString(),
      _score_breakdown: { stage: ['gsc', 'embedding', 'cluster'][i % 3], finalScore: 50 },
    }));
    const out = detectAlgorithm({ articles, evidence: baseEvidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id === 'A.5.confidence-stage-collapse')).toBeUndefined();
  });
});
