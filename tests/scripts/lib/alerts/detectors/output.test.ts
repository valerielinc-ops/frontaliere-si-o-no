// tests/scripts/lib/alerts/detectors/output.test.ts
//
// Spec § 8 — Category C detectors (C.1 win-rate collapse, C.2 both pools
// failing, C.3 cluster collapse, C.4 engagement dive, C.5 newsletter
// conversion dive).

import { describe, expect, it } from 'vitest';

import { detectOutput } from '../../../../../scripts/lib/alerts/detectors/output.mjs';

const NOW = Date.parse('2026-05-08T00:00:00Z');
const DAY = 24 * 3600 * 1000;

const config = {
  winrate_collapse_threshold: 0.2,
  engagement_dive_threshold: 0.4,
};

describe('C.1 win-rate collapse', () => {
  it('fires P0 when any of last 7 history entries has provenWinRate < threshold', () => {
    const quotaState = {
      history: [
        { timestamp: new Date(NOW - 2 * DAY).toISOString(), provenWinRate: 0.15, discoveryWinRate: 0.30 },
      ],
    };
    const out = detectOutput({ articles: [], evidence: {}, quotaState, config, now: NOW });
    const alert = out.find((a: any) => a.id === 'C.1.winrate-collapse');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P0');
  });

  it('does not fire when all rates healthy', () => {
    const quotaState = {
      history: [
        { timestamp: new Date(NOW - 2 * DAY).toISOString(), provenWinRate: 0.55, discoveryWinRate: 0.30 },
      ],
    };
    const out = detectOutput({ articles: [], evidence: {}, quotaState, config, now: NOW });
    expect(out.find((a: any) => a.id === 'C.1.winrate-collapse')).toBeUndefined();
  });
});

describe('C.2 both pools failing', () => {
  it('fires P0 when both pools < 15% in any of last 7 entries', () => {
    const quotaState = {
      history: [
        { timestamp: new Date(NOW - 2 * DAY).toISOString(), provenWinRate: 0.10, discoveryWinRate: 0.05 },
      ],
    };
    const out = detectOutput({ articles: [], evidence: {}, quotaState, config, now: NOW });
    const alert = out.find((a: any) => a.id === 'C.2.both-pools-failing');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P0');
  });
});

describe('C.3 cluster collapse', () => {
  it('fires when per-cluster win-rate drops >50% vs prior 30d', () => {
    const articles = [
      // recent (last 7d): 4 fiscale articles, all losing
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `recent-${i}`, cluster: 'fiscale', publishedAt: new Date(NOW - (i + 1) * DAY).toISOString() })),
      // prior (7-37d): 4 fiscale articles, all winning
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `prior-${i}`, cluster: 'fiscale', publishedAt: new Date(NOW - (10 + i) * DAY).toISOString() })),
    ];
    const ga4Pages: Record<string, any> = {};
    for (const a of articles.slice(0, 4)) ga4Pages[`/articoli-frontaliere/${a.slug}/`] = { sessions: 10 };
    for (const a of articles.slice(4)) ga4Pages[`/articoli-frontaliere/${a.slug}/`] = { sessions: 1000 };
    const evidence = {
      ga4: { pages: ga4Pages },
      clusterStats: { fiscale: { p10: 50, p50: 200, p90: 800, n: 30 } },
    };
    const out = detectOutput({ articles, evidence, quotaState: {}, config, now: NOW });
    expect(out.find((a: any) => a.id?.startsWith('C.3.cluster-collapse'))).toBeDefined();
  });
});

describe('C.4 engagement dive', () => {
  it('fires when median engageTime drops >40% vs prior window', () => {
    const articles = [
      ...Array.from({ length: 5 }, (_, i) => ({ slug: `recent-${i}`, cluster: 'generic', publishedAt: new Date(NOW - (i + 1) * DAY).toISOString() })),
      ...Array.from({ length: 5 }, (_, i) => ({ slug: `prior-${i}`, cluster: 'generic', publishedAt: new Date(NOW - (15 + i) * DAY).toISOString() })),
    ];
    const ga4Pages: Record<string, any> = {};
    for (const a of articles.slice(0, 5)) ga4Pages[`/articoli-frontaliere/${a.slug}/`] = { engageTime: 30 };
    for (const a of articles.slice(5)) ga4Pages[`/articoli-frontaliere/${a.slug}/`] = { engageTime: 120 };
    const out = detectOutput({
      articles,
      evidence: { ga4: { pages: ga4Pages }, clusterStats: {} },
      quotaState: {},
      config,
      now: NOW,
    });
    expect(out.find((a: any) => a.id === 'C.4.engagement-dive')).toBeDefined();
  });

  it('does not fire when engagement stable', () => {
    const articles = [
      ...Array.from({ length: 5 }, (_, i) => ({ slug: `recent-${i}`, cluster: 'generic', publishedAt: new Date(NOW - (i + 1) * DAY).toISOString() })),
      ...Array.from({ length: 5 }, (_, i) => ({ slug: `prior-${i}`, cluster: 'generic', publishedAt: new Date(NOW - (15 + i) * DAY).toISOString() })),
    ];
    const ga4Pages: Record<string, any> = {};
    for (const a of [...articles]) ga4Pages[`/articoli-frontaliere/${a.slug}/`] = { engageTime: 100 };
    const out = detectOutput({
      articles,
      evidence: { ga4: { pages: ga4Pages }, clusterStats: {} },
      quotaState: {},
      config,
      now: NOW,
    });
    expect(out.find((a: any) => a.id === 'C.4.engagement-dive')).toBeUndefined();
  });
});

describe('C.5 newsletter conversion dive', () => {
  it('fires P2 when conversion drops >50%', () => {
    const articles = [
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `recent-${i}`, cluster: 'generic', publishedAt: new Date(NOW - (i + 1) * DAY).toISOString() })),
      ...Array.from({ length: 4 }, (_, i) => ({ slug: `prior-${i}`, cluster: 'generic', publishedAt: new Date(NOW - (15 + i) * DAY).toISOString() })),
    ];
    const ga4Pages: Record<string, any> = {};
    const phPages: Record<string, any> = {};
    for (const a of articles.slice(0, 4)) {
      ga4Pages[`/articoli-frontaliere/${a.slug}/`] = { sessions: 1000 };
      phPages[`/articoli-frontaliere/${a.slug}/`] = { newsletterSignups: 1 };
    }
    for (const a of articles.slice(4)) {
      ga4Pages[`/articoli-frontaliere/${a.slug}/`] = { sessions: 1000 };
      phPages[`/articoli-frontaliere/${a.slug}/`] = { newsletterSignups: 10 };
    }
    const out = detectOutput({
      articles,
      evidence: { ga4: { pages: ga4Pages }, posthog: { pages: phPages }, clusterStats: {} },
      quotaState: {},
      config,
      now: NOW,
    });
    const alert = out.find((a: any) => a.id === 'C.5.newsletter-conversion-dive');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('P2');
  });
});
