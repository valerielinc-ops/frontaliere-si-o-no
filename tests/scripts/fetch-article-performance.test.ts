import { describe, expect, it } from 'vitest';

// Pure-function tests for the article-performance pipeline. We exercise the
// scoring math, fingerprint extraction, newsletter filter contract, and the
// graceful-empty-shape contract. We deliberately avoid the network helpers
// (gsc/ga4/posthog/adsense) which are integration code.

import * as scoring from '../../scripts/lib/perf-sources/scoring.mjs';
import * as discovery from '../../scripts/lib/perf-sources/articleDiscovery.mjs';
import * as fetcher from '../../scripts/fetch-article-performance.mjs';

const { meanStd, zNormalize, composeScores, buildWinnerFingerprint, sortScored } =
  scoring as unknown as {
    meanStd: (xs: number[]) => { mean: number; sd: number };
    zNormalize: (rows: any[], key: string) => Map<any, number | null>;
    composeScores: (rows: any[]) => any[];
    buildWinnerFingerprint: (winners: any[], all: any[]) => any;
    sortScored: (rows: any[]) => any[];
  };

const { parseBlogMetaFile } = discovery as unknown as {
  parseBlogMetaFile: (text: string) => Map<string, { title: string; excerpt: string }>;
};

const { aggregate } = fetcher as unknown as {
  aggregate: (input: any) => any;
};

// ── Scoring math ────────────────────────────────────────────
describe('fetch-article-performance / scoring', () => {
  it('z-normalizes finite values, returns null for missing', () => {
    const rows = [
      { clicks: 10 },
      { clicks: 20 },
      { clicks: 30 },
      { clicks: null },
    ];
    const z = zNormalize(rows as any, 'clicks');
    expect(z.get(rows[0])).toBeCloseTo(-1.2247, 3);
    expect(z.get(rows[1])).toBeCloseTo(0, 3);
    expect(z.get(rows[2])).toBeCloseTo(1.2247, 3);
    expect(z.get(rows[3])).toBeNull();
  });

  it('composeScores skips rows with no metric, ranks by composite', () => {
    const rows = [
      { url: 'a', clicks: 100, impressions: 1000, adsenseRevenueOrProxy: 10, scrollP50: 0.8, ctr: 0.10 },
      { url: 'b', clicks: 10,  impressions: 200,  adsenseRevenueOrProxy: 1,  scrollP50: 0.4, ctr: 0.05 },
      { url: 'c', clicks: 50,  impressions: 500,  adsenseRevenueOrProxy: 5,  scrollP50: 0.6, ctr: 0.10 },
      { url: 'd', clicks: null, impressions: null, adsenseRevenueOrProxy: null, scrollP50: null, ctr: null },
    ];
    const scored = composeScores(rows as any);
    expect(scored.length).toBe(3);
    const sorted = sortScored(scored);
    expect(sorted[0].url).toBe('a');
    expect(sorted[sorted.length - 1].url).toBe('b');
  });

  it('sortScored is deterministic on score ties (alphabetical url)', () => {
    const rows = [
      { url: 'https://x/c', score: 1.0 },
      { url: 'https://x/a', score: 1.0 },
      { url: 'https://x/b', score: 1.0 },
    ];
    const sorted = sortScored(rows as any);
    expect(sorted.map((r) => r.url)).toEqual(['https://x/a', 'https://x/b', 'https://x/c']);
  });
});

// ── Fingerprint extraction ──────────────────────────────────
describe('fetch-article-performance / winnerFingerprint', () => {
  it('extracts clusters, angles, keywords, question patterns, avg wordCount', () => {
    const winners = [
      { title: 'Come funziona il telelavoro frontaliere 2026', excerpt: 'Guida pratica al calcolo del telelavoro', cluster: 'Fiscale', wordCount: 1400 },
      { title: 'Quando conviene il pilastro 3a', excerpt: 'Confronto tra pilastri previdenziali', cluster: 'Pensione', wordCount: 1500 },
      { title: 'Calcolo stipendio netto frontaliere passo passo', excerpt: 'Esempio completo con esempi 2026', cluster: 'Fiscale', wordCount: 1600 },
      { title: 'Quanto si paga di IRPEF da frontaliere', excerpt: 'Quanto costa il rientro fiscale in Italia', cluster: 'Fiscale', wordCount: 1300 },
    ];
    const all = [
      ...winners,
      { title: 'Articolo perdente generico', excerpt: 'cose noiose', cluster: 'Altro', wordCount: 800 },
    ];
    const fp = buildWinnerFingerprint(winners as any, all as any);
    expect(fp.topClusters[0].cluster).toBe('Fiscale');
    expect(fp.topClusters[0].weight).toBeGreaterThan(0.5);
    expect(fp.topAngles).toEqual(expect.arrayContaining(['come funziona']));
    expect(fp.topQuestionPatterns).toEqual(expect.arrayContaining(['come']));
    expect(fp.averageWordCount).toBe(1450);
    expect(fp.topKeywords.length).toBeGreaterThan(0);
    expect(fp.topKeywords).toEqual(expect.arrayContaining(['frontaliere']));
  });

  it('returns empty shape when no winners', () => {
    const fp = buildWinnerFingerprint([], []);
    expect(fp).toEqual({
      topClusters: [],
      topAngles: [],
      topKeywords: [],
      averageWordCount: 0,
      topQuestionPatterns: [],
    });
  });
});

// ── Newsletter filter contract ──────────────────────────────
describe('fetch-article-performance / newsletter filter', () => {
  it('aggregate marks newsletter filter as applied with documented method', () => {
    const out = aggregate({
      articles: [],
      seoMeta: new Map(),
      sources: {
        gsc: { ok: false, reason: 'no token' },
        ga4: { ok: false, reason: 'no prop' },
        posthog: { ok: false, reason: 'no key' },
        adsense: { ok: false, reason: 'no token' },
      },
      generatedAt: '2026-05-06T00:00:00Z',
    });
    expect(out.filters.newsletter.applied).toBe(true);
    expect(out.filters.newsletter.method).toMatch(/utm_medium=newsletter/);
    expect(out.filters.newsletter.method).toMatch(/GA4 \+ PostHog/);
  });
});

// ── Graceful empty-shape contract ───────────────────────────
describe('fetch-article-performance / graceful empty', () => {
  it('produces a valid JSON shape when all sources are missing', () => {
    const out = aggregate({
      articles: [],
      seoMeta: new Map(),
      sources: {
        gsc: { ok: false, reason: 'no token' },
        ga4: { ok: false, reason: 'no prop' },
        posthog: { ok: false, reason: 'no key' },
        adsense: { ok: false, reason: 'no token' },
      },
      generatedAt: '2026-05-06T00:00:00Z',
    });
    expect(out.generatedAt).toBe('2026-05-06T00:00:00Z');
    expect(out.articleCount).toBe(0);
    expect(out.articlesScored).toBe(0);
    expect(out.winners).toEqual([]);
    expect(out.losers).toEqual([]);
    expect(out.winnerFingerprint).toBeDefined();
    expect(out.sources.gsc.ok).toBe(false);
    expect(out.sources.ga4.ok).toBe(false);
    expect(out.sources.posthog.ok).toBe(false);
    expect(out.sources.adsense.ok).toBe(false);
    // Score formula stays consistent with the spec literal so the agent's
    // documentation gate and consumers can rely on it.
    expect(out.scoreFormula).toMatch(/^0\.4\*z\(clicks\)/);
  });
});

// ── Determinism contract ────────────────────────────────────
describe('fetch-article-performance / determinism', () => {
  it('aggregate produces byte-identical JSON on repeat with the same inputs', () => {
    const articles = [
      { slug: 'a', locale: 'it', url: 'https://frontaliereticino.ch/articoli-frontaliere/a/', title: 'Come funziona X', excerpt: 'Guida pratica' },
      { slug: 'b', locale: 'it', url: 'https://frontaliereticino.ch/articoli-frontaliere/b/', title: 'Quanto costa Y', excerpt: 'Confronto X vs Y' },
      { slug: 'c', locale: 'it', url: 'https://frontaliereticino.ch/articoli-frontaliere/c/', title: 'Calcolo Z passo passo', excerpt: 'Esempio concreto' },
    ];
    const seoMeta = new Map([
      ['a', { cluster: 'Fiscale', publishedAt: '2025-01-01' }],
      ['b', { cluster: 'Pratico', publishedAt: '2025-01-02' }],
      ['c', { cluster: 'Fiscale', publishedAt: '2025-01-03' }],
    ]);
    const gscPerPath = new Map([
      ['/articoli-frontaliere/a/', { clicks: 200, impressions: 4000, ctr: 0.05, position: 8 }],
      ['/articoli-frontaliere/b/', { clicks: 50,  impressions: 2000, ctr: 0.025, position: 18 }],
      ['/articoli-frontaliere/c/', { clicks: 100, impressions: 1500, ctr: 0.067, position: 12 }],
    ]);
    const sources = {
      gsc: { ok: true, rows: 3, perPath: gscPerPath },
      ga4: { ok: false, reason: 'skipped' },
      posthog: { ok: false, reason: 'skipped' },
      adsense: { ok: false, reason: 'skipped' },
    };
    const a = JSON.stringify(aggregate({ articles, seoMeta, sources, generatedAt: '2026-05-06T00:00:00Z' }), null, 2);
    const b = JSON.stringify(aggregate({ articles, seoMeta, sources, generatedAt: '2026-05-06T00:00:00Z' }), null, 2);
    expect(a).toBe(b);
    // Sanity: winners should be sorted by score desc.
    const parsed = JSON.parse(a);
    if (parsed.winners.length >= 2) {
      expect(parsed.winners[0].score).toBeGreaterThanOrEqual(parsed.winners[1].score);
    }
  });
});

// ── parseBlogMetaFile ───────────────────────────────────────
describe('fetch-article-performance / parseBlogMetaFile', () => {
  it('extracts slug + title + excerpt from blog-meta-it.ts shape', () => {
    const text = `
const blogMetaIt: Record<string, string> = {
 'blog.article.foo-bar.title': 'Titolo Foo',
 'blog.article.foo-bar.excerpt': 'Riassunto del foo',
 'blog.article.baz.title': 'Titolo Baz \\'apostrofo\\'',
 'blog.article.baz.excerpt': 'Esempio',
};`;
    const parsed = parseBlogMetaFile(text);
    expect(parsed.size).toBe(2);
    expect(parsed.get('foo-bar')).toEqual({ title: 'Titolo Foo', excerpt: 'Riassunto del foo' });
    expect(parsed.get('baz')?.title).toContain("'apostrofo'");
  });
});
