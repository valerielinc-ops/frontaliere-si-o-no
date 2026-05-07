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

const { parseBlogMetaFile, inferClusterFromTitleAndSlug, normalizeClusterName } = discovery as unknown as {
  parseBlogMetaFile: (text: string) => Map<string, { title: string; excerpt: string }>;
  inferClusterFromTitleAndSlug: (title: string, slug: string, excerpt: string) => string;
  normalizeClusterName: (cluster: string | null | undefined) => string | null;
};

const { recencyWeight } = scoring as unknown as {
  recencyWeight: (publishedAt: string | null | undefined, nowMs?: number) => number;
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
    // Lowercase-normalized canonical cluster taxonomy (CLUSTER_TAXONOMY in
    // scripts/lib/cluster-classifier-prompt.mjs). Capitalized inputs like
    // 'Fiscale' get folded to 'fiscale' as a defense-in-depth so the on-disk
    // JSON is consistent.
    expect(fp.topClusters[0].cluster).toBe('fiscale');
    expect(fp.topClusters[0].weight).toBeGreaterThan(0.5);
    expect(fp.topAngles).toEqual(expect.arrayContaining(['come funziona']));
    expect(fp.topQuestionPatterns).toEqual(expect.arrayContaining(['come']));
    expect(fp.averageWordCount).toBe(1450);
    expect(fp.topKeywords.length).toBeGreaterThan(0);
    expect(fp.topKeywords).toEqual(expect.arrayContaining(['frontaliere']));
  });

  it('drops "unknown"-only clusters → topClusters=[]', () => {
    const winners = [
      { title: 'A', excerpt: 'x', cluster: 'unknown', wordCount: 1000 },
      { title: 'B', excerpt: 'x', cluster: null, wordCount: 1000 },
      { title: 'C', excerpt: 'x', cluster: 'Unknown', wordCount: 1000 },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    expect(fp.topClusters).toEqual([]);
  });

  it('drops "unknown" but keeps real clusters', () => {
    const winners = [
      { title: 'A', excerpt: 'frontaliere telelavoro', cluster: 'unknown', wordCount: 1000 },
      { title: 'B', excerpt: 'frontaliere irpef', cluster: 'fiscale', wordCount: 1000 },
      { title: 'C', excerpt: 'frontaliere stipendio', cluster: 'fiscale', wordCount: 1000 },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    expect(fp.topClusters.map((c: any) => c.cluster)).toEqual(['fiscale']);
  });

  it('topKeywords filtered through frontalieri-domain allowlist', () => {
    // Pure news-of-day winners — none of these tokens are in the domain regex.
    const winners = [
      { title: 'Sciopero pastori a Bellinzona oggi', excerpt: 'cronaca locale', cluster: 'novita', wordCount: 800 },
      { title: 'Grandine danni vigneti tessinesi', excerpt: 'fenomeni meteo', cluster: 'novita', wordCount: 800 },
      { title: 'Incidente sequestro autobus turistico', excerpt: 'cronaca regionale', cluster: 'novita', wordCount: 800 },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    expect(fp.topKeywords).toEqual([]);
  });

  it('mixed winners → topKeywords keeps only domain matches', () => {
    const winners = [
      { title: 'Telelavoro frontaliere salario tasse', excerpt: 'guida fiscale stipendio irpef', cluster: 'fiscale', wordCount: 1500 },
      { title: 'Permesso G frontaliere ticino lombardia', excerpt: 'pendolari valico cambio chf', cluster: 'pratico', wordCount: 1500 },
      { title: 'Sciopero pastori grandine tessin', excerpt: 'cronaca novita locale', cluster: 'novita', wordCount: 1500 },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    // Every kept keyword must match the domain regex (multilingual, broad).
    for (const kw of fp.topKeywords) {
      expect(kw).toMatch(/frontal|telelavoro|stipend|salar|tass|fiscal|irpef|permess|ticin|tessin|lombard|valic|pendol|cambio|chf/i);
    }
    // 'cronaca', 'pastori', 'sciopero', 'grandine' — must NOT survive.
    for (const kw of fp.topKeywords) {
      expect(kw).not.toMatch(/cronaca|pastori|sciopero|grandine|locale/i);
    }
  });

  it('averageWordCount=null when no winner has a wordCount', () => {
    const winners = [
      { title: 'Frontaliere telelavoro tasse', excerpt: 'fiscale', cluster: 'fiscale' /* no wordCount */ },
      { title: 'Frontaliere stipendio salario', excerpt: 'fiscale', cluster: 'fiscale' },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    expect(fp.averageWordCount).toBeNull();
  });

  it('averageWordCount=null when wordCount=0', () => {
    const winners = [
      { title: 'Frontaliere telelavoro tasse', excerpt: 'fiscale', cluster: 'fiscale', wordCount: 0 },
      { title: 'Frontaliere stipendio salario', excerpt: 'fiscale', cluster: 'fiscale', wordCount: 0 },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    expect(fp.averageWordCount).toBeNull();
  });

  it('returns empty shape when no winners (averageWordCount=null)', () => {
    const fp = buildWinnerFingerprint([], []);
    expect(fp).toEqual({
      topClusters: [],
      topAngles: [],
      topKeywords: [],
      averageWordCount: null,
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

// ── inferClusterFromTitleAndSlug heuristic ──────────────────
describe('fetch-article-performance / inferClusterFromTitleAndSlug', () => {
  it('classifies fiscal/tax titles as "fiscale"', () => {
    expect(inferClusterFromTitleAndSlug('Calcolo IRPEF frontaliere', 'irpef-frontaliere', '')).toBe('fiscale');
    expect(inferClusterFromTitleAndSlug('Quanto pago di tasse in Svizzera', 'tasse-svizzera', '')).toBe('fiscale');
    expect(inferClusterFromTitleAndSlug('Nuovo accordo fiscale 2026', 'accordo-2026', 'imposta')).toBe('fiscale');
  });

  it('classifies pension titles as "pensioni" (canonical CLUSTER_TAXONOMY)', () => {
    // Cluster name MUST match the canonical taxonomy in
    // scripts/lib/cluster-classifier-prompt.mjs (`pensioni`, plural). The
    // 2026-05-07 audit caught this inferred value as `pensione` (singular)
    // and fingerprint topClusters dropped the bucket on the floor.
    expect(inferClusterFromTitleAndSlug('Pensione AVS LPP frontaliere', 'avs-lpp', '')).toBe('pensioni');
    expect(inferClusterFromTitleAndSlug('Terzo pilastro 3a guida', 'terzo-pilastro', '')).toBe('pensioni');
    expect(inferClusterFromTitleAndSlug('Previdenza professionale BVG', 'bvg', '')).toBe('pensioni');
  });

  it('classifies practical/admin titles as "pratico"', () => {
    expect(inferClusterFromTitleAndSlug('Permesso G come fare', 'permesso-g', '')).toBe('pratico');
    expect(inferClusterFromTitleAndSlug('LAMal cassa malati guida', 'lamal-guida', '')).toBe('pratico');
    expect(inferClusterFromTitleAndSlug('Mutuo casa per frontalieri', 'mutuo-casa', '')).toBe('pratico');
  });

  it('classifies work/salary titles as "lavoro"', () => {
    expect(inferClusterFromTitleAndSlug('Stipendio netto Ticino', 'stipendio-netto', '')).toBe('lavoro');
    expect(inferClusterFromTitleAndSlug('Telelavoro frontaliere 25%', 'telelavoro-25', '')).toBe('lavoro');
    expect(inferClusterFromTitleAndSlug('Salaire frontalier Suisse', 'salaire-suisse', '')).toBe('lavoro');
  });

  it('classifies commute/border titles as "mobilita"', () => {
    expect(inferClusterFromTitleAndSlug('Valico di Chiasso traffico', 'chiasso-valico', '')).toBe('mobilita');
    expect(inferClusterFromTitleAndSlug('Pendolari frontiera Ticino', 'pendolari', '')).toBe('mobilita');
    expect(inferClusterFromTitleAndSlug('Carburante diesel Italia Svizzera', 'carbur', '')).toBe('mobilita');
  });

  it('classifies news titles as "novita"', () => {
    expect(inferClusterFromTitleAndSlug('Sciopero CGIL 2026', 'sciopero', '')).toBe('novita');
    expect(inferClusterFromTitleAndSlug('Cronaca incidente Ponte Tresa', 'cronaca', '')).toBe('novita');
    expect(inferClusterFromTitleAndSlug('Nuova legge in arrivo', 'nuova-legge', '')).toBe('novita');
  });

  it('falls back to "generic" for unrelated titles', () => {
    expect(inferClusterFromTitleAndSlug('Recipe gnocchi alla Bava', 'gnocchi', 'cucina')).toBe('generic');
    expect(inferClusterFromTitleAndSlug('Dog walk routes Lugano', 'dog-walk', '')).toBe('generic');
  });

  it('articleSection (when present) takes precedence over heuristic in aggregate()', () => {
    const articles = [
      {
        slug: 'a',
        locale: 'it',
        url: 'https://frontaliereticino.ch/articoli-frontaliere/a/',
        title: 'Stipendio netto guida frontalieri',
        excerpt: 'tasse irpef',
      },
    ];
    const seoMeta = new Map([
      // The seo-blog file says this is "Editoriale" — must override heuristic
      // ("lavoro" or "fiscale" would otherwise match).
      ['a', { cluster: 'Editoriale', publishedAt: '2025-01-01' }],
    ]);
    const out = aggregate({
      articles,
      seoMeta,
      sources: {
        gsc: { ok: true, rows: 1, perPath: new Map([['/articoli-frontaliere/a/', { clicks: 100, impressions: 1000, ctr: 0.1, position: 5 }]]) },
        ga4: { ok: false, reason: 'skipped' },
        posthog: { ok: false, reason: 'skipped' },
        adsense: { ok: false, reason: 'skipped' },
      },
      generatedAt: '2026-05-06T00:00:00Z',
    });
    expect(out.winners.length).toBe(1);
    // Capitalized articleSection 'Editoriale' is lowercase-normalized to
    // canonical taxonomy form. The seoMeta value still wins over heuristic.
    expect(out.winners[0].cluster).toBe('editoriale');
  });

  it('aggregate fills cluster via heuristic when seoMeta has no cluster', () => {
    const articles = [
      {
        slug: 'tax',
        locale: 'it',
        url: 'https://frontaliereticino.ch/articoli-frontaliere/tax/',
        title: 'Calcolo IRPEF e tasse 2026',
        excerpt: 'guida fiscale completa',
      },
      {
        slug: 'permit',
        locale: 'it',
        url: 'https://frontaliereticino.ch/articoli-frontaliere/permit/',
        title: 'Permesso G guida pratica',
        excerpt: 'come ottenere e rinnovare',
      },
    ];
    const seoMeta = new Map([
      ['tax',    { cluster: null, publishedAt: '2025-01-01' }],
      ['permit', { cluster: null, publishedAt: '2025-01-02' }],
    ]);
    const out = aggregate({
      articles,
      seoMeta,
      sources: {
        gsc: { ok: true, rows: 2, perPath: new Map([
          ['/articoli-frontaliere/tax/',    { clicks: 100, impressions: 1000, ctr: 0.10, position: 5 }],
          ['/articoli-frontaliere/permit/', { clicks: 50,  impressions: 500,  ctr: 0.10, position: 10 }],
        ]) },
        ga4: { ok: false, reason: 'skipped' },
        posthog: { ok: false, reason: 'skipped' },
        adsense: { ok: false, reason: 'skipped' },
      },
      generatedAt: '2026-05-06T00:00:00Z',
    });
    const byUrl = new Map<string, any>(out.winners.map((w: any) => [w.url, w]));
    expect(byUrl.get('https://frontaliereticino.ch/articoli-frontaliere/tax/')?.cluster).toBe('fiscale');
    expect(byUrl.get('https://frontaliereticino.ch/articoli-frontaliere/permit/')?.cluster).toBe('pratico');
  });
});

// ── Cluster name normalization ──────────────────────────────
describe('fetch-article-performance / normalizeClusterName', () => {
  it('lowercases capitalized articleSection values', () => {
    expect(normalizeClusterName('Pratico')).toBe('pratico');
    expect(normalizeClusterName('Fiscale')).toBe('fiscale');
    expect(normalizeClusterName('Editoriale')).toBe('editoriale');
  });

  it('maps Italian singular "Pensione" → canonical plural "pensioni"', () => {
    expect(normalizeClusterName('Pensione')).toBe('pensioni');
    expect(normalizeClusterName('pensione')).toBe('pensioni');
    expect(normalizeClusterName('PENSIONE')).toBe('pensioni');
  });

  it('returns null for empty/missing input', () => {
    expect(normalizeClusterName(null)).toBeNull();
    expect(normalizeClusterName(undefined)).toBeNull();
    expect(normalizeClusterName('')).toBeNull();
    expect(normalizeClusterName('   ')).toBeNull();
  });

  it('is idempotent — running twice yields the same result', () => {
    const v1 = normalizeClusterName('Pensione');
    const v2 = normalizeClusterName(v1);
    expect(v1).toBe('pensioni');
    expect(v2).toBe('pensioni');
  });
});

// ── Aggregate cluster case fix ──────────────────────────────
describe('fetch-article-performance / aggregate cluster case fix', () => {
  it('lowercases capitalized articleSection so winners/losers are consistent', () => {
    const articles = [
      { slug: 'a', locale: 'it', url: 'https://frontaliereticino.ch/articoli-frontaliere/a/', title: 'Permesso G frontalieri', excerpt: 'guida pratica' },
      { slug: 'b', locale: 'it', url: 'https://frontaliereticino.ch/articoli-frontaliere/b/', title: 'Frontaliere e LAMal', excerpt: 'casa malati' },
    ];
    // One uses capitalized "Pratico" (legacy seo-blog format), other lowercase.
    const seoMeta = new Map([
      ['a', { cluster: 'Pratico', publishedAt: '2025-01-01' }],
      ['b', { cluster: 'pratico', publishedAt: '2025-01-02' }],
    ]);
    const out = aggregate({
      articles,
      seoMeta,
      sources: {
        gsc: { ok: true, rows: 2, perPath: new Map([
          ['/articoli-frontaliere/a/', { clicks: 100, impressions: 1000, ctr: 0.10, position: 5 }],
          ['/articoli-frontaliere/b/', { clicks: 50,  impressions: 500,  ctr: 0.10, position: 8 }],
        ]) },
        ga4: { ok: false, reason: 'skipped' },
        posthog: { ok: false, reason: 'skipped' },
        adsense: { ok: false, reason: 'skipped' },
      },
      generatedAt: '2026-05-06T00:00:00Z',
    });
    // After normalization both winners share the canonical "pratico" cluster.
    const clusters = new Set<string>(out.winners.map((w: any) => w.cluster));
    expect(clusters.has('Pratico')).toBe(false);
    expect(clusters.has('pratico')).toBe(true);
    expect(clusters.size).toBe(1);
  });

  it('maps capitalized "Pensione" to canonical "pensioni" in winners', () => {
    const articles = [
      { slug: 'pen', locale: 'it', url: 'https://frontaliereticino.ch/articoli-frontaliere/pen/', title: 'AVS LPP secondo pilastro', excerpt: 'previdenza' },
    ];
    const seoMeta = new Map([
      ['pen', { cluster: 'Pensione', publishedAt: '2025-01-01' }],
    ]);
    const out = aggregate({
      articles,
      seoMeta,
      sources: {
        gsc: { ok: true, rows: 1, perPath: new Map([['/articoli-frontaliere/pen/', { clicks: 100, impressions: 1000, ctr: 0.10, position: 5 }]]) },
        ga4: { ok: false, reason: 'skipped' },
        posthog: { ok: false, reason: 'skipped' },
        adsense: { ok: false, reason: 'skipped' },
      },
      generatedAt: '2026-05-06T00:00:00Z',
    });
    expect(out.winners[0].cluster).toBe('pensioni');
  });
});

// ── Recency-weighted TF-IDF ─────────────────────────────────
describe('fetch-article-performance / recency-weighted TF-IDF', () => {
  it('recencyWeight returns 1.0 for fresh dates and < 0.5 for >2-week-old dates', () => {
    const now = Date.parse('2026-05-07T00:00:00Z');
    expect(recencyWeight('2026-05-07T00:00:00Z', now)).toBeCloseTo(1.0, 3);
    // 14 days old → 1/(1 + 1) = 0.5
    expect(recencyWeight('2026-04-23T00:00:00Z', now)).toBeCloseTo(0.5, 2);
    // 28 days old → 1/(1 + 2) ≈ 0.333
    expect(recencyWeight('2026-04-09T00:00:00Z', now)).toBeCloseTo(0.333, 2);
    // missing/invalid → 1.0 (don't zero-weight legitimate winners)
    expect(recencyWeight(null)).toBe(1.0);
    expect(recencyWeight('not a date')).toBe(1.0);
  });

  it('topKeywords are non-empty for a clearly-frontaliere winner set', () => {
    const winners = [
      { title: 'Telelavoro frontaliere salario tasse', excerpt: 'guida fiscale stipendio irpef', cluster: 'fiscale', wordCount: 1500, publishedAt: '2026-05-01' },
      { title: 'Permesso G frontaliere ticino lombardia', excerpt: 'pendolari valico cambio chf', cluster: 'pratico', wordCount: 1500, publishedAt: '2026-05-02' },
      { title: 'AVS LPP frontaliere secondo pilastro', excerpt: 'previdenza', cluster: 'pensioni', wordCount: 1500, publishedAt: '2026-05-03' },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    expect(fp.topKeywords.length).toBeGreaterThanOrEqual(3);
  });

  it('recency weighting de-emphasizes news-of-day terms in older winners', () => {
    // Old news-of-day winners (50 days old) — should get crushed by recency.
    // Fresh evergreen winners — full weight. Domain filter still applies as
    // final safety net, so the news terms (sciopero/grandine/pastori) get
    // dropped. The test mainly asserts the pipeline still produces a clean
    // fingerprint regardless of which winners are old vs new.
    const winners = [
      { title: 'Sciopero pastori grandine vigneti', excerpt: 'cronaca tessinese', cluster: 'novita', wordCount: 800, publishedAt: '2026-03-18' },
      { title: 'Telelavoro frontaliere stipendio chf', excerpt: 'tasse fiscale', cluster: 'fiscale', wordCount: 1500, publishedAt: '2026-05-05' },
      { title: 'Permesso G frontaliere ticino', excerpt: 'pendolari valico', cluster: 'pratico', wordCount: 1500, publishedAt: '2026-05-06' },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    for (const kw of fp.topKeywords) {
      expect(kw).not.toMatch(/sciopero|pastori|grandine|cronaca/i);
    }
  });

  it('regression: large fullCorpus does not collapse topKeywords (cap fCount at 50)', () => {
    // Production bug 2026-05-07: with a 9000-article full corpus,
    // evergreen frontaliere terms (`frontalieri`, `ticino`) had
    // fCount~6000-8000 and IDF score ≈ 0, dropping below the top-60
    // threshold. Domain filter then found < MIN_DOMAIN_KEYWORDS=3 →
    // topKeywords = []. Fix caps fCount at MAX_FCOUNT_IDF=50 in tfidfTopN.
    const now = '2026-05-07T00:00:00Z';
    const winners = [
      { title: 'Frontalieri ticino mutuo casa italia', cluster: 'pratico', wordCount: 1500, publishedAt: now },
      { title: 'Dogana chiasso doganali frontalieri', cluster: 'mobilita', wordCount: 1500, publishedAt: now },
      { title: 'Imposta alla fonte ticino frontalieri', cluster: 'fiscale', wordCount: 1500, publishedAt: now },
      { title: 'Tasse svizzera ticino frontalieri', cluster: 'fiscale', wordCount: 1500, publishedAt: now },
    ];
    // Simulate huge corpus where evergreen terms appear in every article.
    const allArticles: Array<{title: string, excerpt: string}> = [];
    for (let i = 0; i < 5000; i += 1) {
      allArticles.push({ title: `Frontalieri svizzera ticino articolo ${i}`, excerpt: '' });
    }
    allArticles.push(...winners.map((w) => ({ title: w.title, excerpt: '' })));
    const fp = buildWinnerFingerprint(winners as any, allArticles as any);
    expect(fp.topKeywords.length).toBeGreaterThanOrEqual(3);
    expect(fp.topKeywords).toEqual(expect.arrayContaining(['frontalieri', 'ticino']));
  });
});

// ── pensioni cluster propagation ────────────────────────────
describe('fetch-article-performance / pensioni cluster', () => {
  it('inferClusterFromTitleAndSlug returns "pensioni" for AVS/LPP/secondo pilastro', () => {
    expect(inferClusterFromTitleAndSlug('AVS frontalieri 2026', 'avs', '')).toBe('pensioni');
    expect(inferClusterFromTitleAndSlug('LPP secondo pilastro', 'lpp', '')).toBe('pensioni');
    expect(inferClusterFromTitleAndSlug('Pilastro 3a guida', 'pilastro', '')).toBe('pensioni');
    expect(inferClusterFromTitleAndSlug('Tredicesima AVS 2026', 'tredicesima-avs', '')).toBe('pensioni');
    expect(inferClusterFromTitleAndSlug('Previdenza professionale', 'previdenza', '')).toBe('pensioni');
  });

  it('topClusters histogram includes "pensioni" when winners are pension-domain', () => {
    const winners = [
      { title: 'AVS frontalieri 2026', excerpt: 'previdenza', cluster: 'pensioni', wordCount: 1500 },
      { title: 'LPP secondo pilastro', excerpt: 'previdenza', cluster: 'pensioni', wordCount: 1500 },
      { title: 'Telelavoro frontaliere', excerpt: 'fiscale', cluster: 'fiscale', wordCount: 1500 },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    const clusterNames = fp.topClusters.map((c: any) => c.cluster);
    expect(clusterNames).toContain('pensioni');
  });
});

// ── averageWordCount ────────────────────────────────────────
describe('fetch-article-performance / averageWordCount', () => {
  it('returns rounded positive integer when winners carry wordCount', () => {
    const winners = [
      { title: 'A', excerpt: 'x', cluster: 'fiscale', wordCount: 1200 },
      { title: 'B', excerpt: 'x', cluster: 'fiscale', wordCount: 1400 },
      { title: 'C', excerpt: 'x', cluster: 'fiscale', wordCount: 1600 },
    ];
    const fp = buildWinnerFingerprint(winners as any, winners as any);
    expect(fp.averageWordCount).toBe(1400);
    expect(Number.isInteger(fp.averageWordCount)).toBe(true);
    expect(fp.averageWordCount).toBeGreaterThan(0);
  });
});

// ── countWordsInBodySource ──────────────────────────────────
describe('fetch-article-performance / wordCount helper', () => {
  it('counts words in body-<slug>.ts shape', async () => {
    const wc = await import('../../scripts/lib/perf-sources/wordCount.mjs');
    const text = `
const bodyFoo: Record<string, string> = {
 'blog.article.foo.body1': 'Questa è una guida pratica frontaliere con dieci parole esatte.',
 'blog.article.foo.body2': 'Altre cinque parole qui infatti.',
};`;
    const count = (wc as any).countWordsInBodySource(text);
    // Total words across both bodies: 10 + 5 = 15
    expect(count).toBe(15);
  });

  it('returns 0 for empty / unparseable input', async () => {
    const wc = await import('../../scripts/lib/perf-sources/wordCount.mjs');
    expect((wc as any).countWordsInBodySource('')).toBe(0);
    expect((wc as any).countWordsInBodySource('no entries here')).toBe(0);
  });
});
