import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vocabMod from '../../scripts/lib/demand-vocabulary.mjs';
import * as classifierMod from '../../scripts/lib/cluster-classifier-prompt.mjs';

const { buildDemandVocabulary } = vocabMod as any;
const {
  classifyByRegex,
  buildClusterClassifierPrompt,
  CLUSTER_TAXONOMY,
  CLUSTER_PATTERNS,
} = classifierMod as any;

const cleanupPaths: string[] = [];
afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempPath(name: string): string {
  const dir = join(tmpdir(), `demand-vocab-test-${process.pid}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

// ───────────────────────── cluster-classifier-prompt ─────────────────────────

describe('classifyByRegex', () => {
  it('classifies fiscal terms as fiscale', () => {
    expect(classifyByRegex('tasse svizzera 2026')).toBe('fiscale');
    expect(classifyByRegex('quellensteuer frontalieri')).toBe('fiscale');
    expect(classifyByRegex('busta paga svizzera')).toBe('fiscale');
    expect(classifyByRegex('cambio valuta CHF EUR')).toBe('fiscale');
  });

  it('classifies health terms as salute', () => {
    expect(classifyByRegex('LAMal premio 2026')).toBe('salute');
    expect(classifyByRegex('cassa malati frontalieri')).toBe('salute');
    expect(classifyByRegex('CMI assicurazione')).toBe('salute');
  });

  it('classifies mobility terms as mobilita', () => {
    expect(classifyByRegex('valico Chiasso')).toBe('mobilita');
    expect(classifyByRegex('treno SBB Lugano')).toBe('mobilita');
    expect(classifyByRegex('pendolari ponte tresa')).toBe('mobilita');
  });

  it('classifies practical terms as pratico', () => {
    expect(classifyByRegex('permesso G rinnovo')).toBe('pratico');
    expect(classifyByRegex('telelavoro frontalieri')).toBe('pratico');
    expect(classifyByRegex('smart working accordo')).toBe('pratico');
    expect(classifyByRegex('NASPI disoccupazione')).toBe('pratico');
  });

  it('classifies job terms as lavoro', () => {
    expect(classifyByRegex('offerte lavoro Ticino')).toBe('lavoro');
    expect(classifyByRegex('cerco lavoro frontaliere')).toBe('lavoro');
    expect(classifyByRegex('apprendistato Lugano')).toBe('lavoro');
  });

  it('classifies novelty terms as novita', () => {
    expect(classifyByRegex('nuovo accordo 2026')).toBe('novita');
    expect(classifyByRegex('riforma legge frontalieri')).toBe('novita');
    expect(classifyByRegex('decreto aggiornamento')).toBe('novita');
  });

  it('falls back to generic when nothing matches', () => {
    expect(classifyByRegex('ricetta carbonara originale')).toBe('generic');
    expect(classifyByRegex('')).toBe('generic');
    expect(classifyByRegex(null as any)).toBe('generic');
  });

  it('priority order: fiscale wins over novita when both could match', () => {
    // "nuovo" matches novita; "tasse" matches fiscale. fiscale has higher
    // priority so it wins.
    expect(classifyByRegex('nuovo accordo tasse')).toBe('fiscale');
  });

  it('all results are members of CLUSTER_TAXONOMY', () => {
    const samples = [
      'tasse',
      'lamal',
      'treno',
      'permesso G',
      'lavoro',
      'nuovo',
      'completely unrelated text',
    ];
    for (const s of samples) {
      expect(CLUSTER_TAXONOMY).toContain(classifyByRegex(s));
    }
  });

  it('has one regex pattern per non-generic taxonomy entry', () => {
    const nonGeneric = CLUSTER_TAXONOMY.filter((c: string) => c !== 'generic');
    const patterns = CLUSTER_PATTERNS.map((p: any) => p.cluster);
    expect(patterns.sort()).toEqual([...nonGeneric].sort());
  });
});

describe('buildClusterClassifierPrompt', () => {
  it('lists all 7 taxonomy values explicitly in the response contract', () => {
    const p = buildClusterClassifierPrompt(['headline 1']);
    for (const c of CLUSTER_TAXONOMY) {
      expect(p).toContain(`"${c}"`);
    }
  });

  it('numbers the headlines starting at 1', () => {
    const p = buildClusterClassifierPrompt(['first', 'second', 'third']);
    expect(p).toContain('1. first');
    expect(p).toContain('2. second');
    expect(p).toContain('3. third');
  });

  it('embeds the expected array length N in the response contract', () => {
    const p = buildClusterClassifierPrompt(['a', 'b', 'c', 'd', 'e']);
    expect(p).toContain('esattamente 5 stringhe');
  });

  it('handles empty input safely', () => {
    const p = buildClusterClassifierPrompt([]);
    expect(p).toContain('esattamente 0 stringhe');
  });
});

// ───────────────────────── buildDemandVocabulary ─────────────────────────

describe('buildDemandVocabulary', () => {
  it('aggregates from 3 mock sources, sums weights, dedupes by normalizedKeyword', async () => {
    // Same keyword "permesso g rinnovo" appears in GSC + Suggest +
    // fingerprint → its weight is the sum of all three contributions and
    // its source label lists all three (canonical order).
    const fingerprintPath = tempPath('perf-1.json');
    cleanupPaths.push(fingerprintPath);
    writeFileSync(
      fingerprintPath,
      JSON.stringify({
        winnerFingerprint: {
          topKeywords: ['permesso g rinnovo'],
          topClusters: [{ cluster: 'pratico', weight: 0.5 }],
        },
      }),
    );

    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => ({
        ok: true,
        candidates: [
          {
            keyword: 'permesso g rinnovo',
            normalizedKeyword: 'permesso g rinnovo',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 250 },
          },
        ],
      }),
      suggestImpl: async () => ({
        ok: true,
        perSeed: {},
        candidates: [
          {
            keyword: 'permesso g rinnovo',
            normalizedKeyword: 'permesso g rinnovo',
            sources: ['googleSuggest'],
            demandSignals: { googleSuggestSeed: 'permesso G', googleSuggestRank: 0 },
          },
        ],
      }),
      fingerprintPath,
      now: () => '2026-05-07T22:00:00.000Z',
    });

    expect(r.stableKeywords.length).toBe(1);
    const kw = r.stableKeywords[0];
    // 0.5 (gsc 250/500) * 0.4 = 0.20
    // (1 - 0/10) * 0.3 = 0.30
    // fingerprint = 0.30
    // total = 0.80
    expect(kw.weight).toBeCloseTo(0.8, 5);
    expect(kw.source).toBe('gsc+suggest+fingerprint');
    expect(kw.cluster).toBe('pratico');
    expect(r.sources.gscOrphans.ok).toBe(true);
    expect(r.sources.googleSuggest.ok).toBe(true);
    expect(r.sources.winnerFingerprint.ok).toBe(true);
  });

  it('handles 1-source-ok / 2-failing gracefully', async () => {
    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => ({
        ok: true,
        candidates: [
          {
            keyword: 'lamal premio 2026',
            normalizedKeyword: 'lamal premio 2026',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 100 },
          },
        ],
      }),
      suggestImpl: async () => ({
        ok: false,
        candidates: [],
        reason: 'HTTP 429',
      }),
      fingerprintPath: '/nonexistent/perf.json',
      now: () => '2026-05-07T22:00:00.000Z',
    });
    expect(r.stableKeywords.length).toBe(1);
    expect(r.stableKeywords[0].source).toBe('gsc');
    expect(r.stableKeywords[0].cluster).toBe('salute');
    expect(r.sources.gscOrphans.ok).toBe(true);
    expect(r.sources.googleSuggest.ok).toBe(false);
    expect(r.sources.googleSuggest.reason).toMatch(/HTTP 429/);
    expect(r.sources.winnerFingerprint.ok).toBe(false);
  });

  it('all 3 sources empty → empty stableKeywords, but valid output structure', async () => {
    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => ({ ok: false, candidates: [], reason: 'no file' }),
      suggestImpl: async () => ({ ok: false, candidates: [], reason: 'HTTP 503' }),
      fingerprintPath: '/nonexistent/perf.json',
      now: () => '2026-05-07T22:00:00.000Z',
    });
    expect(r.stableKeywords).toEqual([]);
    expect(r.weights).toEqual({ gsc: 0.4, suggest: 0.3, fingerprint: 0.3 });
    expect(r.sources.gscOrphans.ok).toBe(false);
    expect(r.sources.googleSuggest.ok).toBe(false);
    expect(r.sources.winnerFingerprint.ok).toBe(false);
    expect(r.generatedAt).toBe('2026-05-07T22:00:00.000Z');
  });

  it('sorts stableKeywords by descending weight', async () => {
    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => ({
        ok: true,
        candidates: [
          {
            keyword: 'low signal kw',
            normalizedKeyword: 'low signal kw',
            sources: ['gscOrphans'],
            // 50/500 * 0.4 = 0.04 — above WEIGHT_FLOOR (0.01) but well
            // below the high-signal entry. Earlier value 10 yielded
            // 0.008 < floor so the kw was dropped, collapsing the test.
            demandSignals: { gscImpressions: 50 },
          },
          {
            keyword: 'high signal kw',
            normalizedKeyword: 'high signal kw',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 500 },
          },
        ],
      }),
      suggestImpl: async () => ({ ok: false, candidates: [] }),
      fingerprintPath: '/nonexistent/perf.json',
      now: () => '2026-05-07T22:00:00.000Z',
    });
    expect(r.stableKeywords.length).toBe(2);
    expect(r.stableKeywords[0].normalizedKeyword).toBe('high signal kw');
    expect(r.stableKeywords[0].weight).toBeGreaterThan(r.stableKeywords[1].weight);
  });

  it('drops keywords below the WEIGHT_FLOOR (0.01)', async () => {
    // gscImpressions=1 → 1/500 * 0.4 = 0.0008 → dropped.
    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => ({
        ok: true,
        candidates: [
          {
            keyword: 'tiny signal',
            normalizedKeyword: 'tiny signal',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 1 },
          },
        ],
      }),
      suggestImpl: async () => ({ ok: false, candidates: [] }),
      fingerprintPath: '/nonexistent/perf.json',
      now: () => '2026-05-07T22:00:00.000Z',
    });
    expect(r.stableKeywords).toEqual([]);
  });

  it('respects custom weights', async () => {
    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => ({
        ok: true,
        candidates: [
          {
            keyword: 'tasse svizzera',
            normalizedKeyword: 'tasse svizzera',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 500 },
          },
        ],
      }),
      suggestImpl: async () => ({ ok: false, candidates: [] }),
      fingerprintPath: '/nonexistent/perf.json',
      weights: { gsc: 1.0, suggest: 0, fingerprint: 0 },
      now: () => '2026-05-07T22:00:00.000Z',
    });
    expect(r.stableKeywords[0].weight).toBeCloseTo(1.0, 5);
    expect(r.weights.gsc).toBe(1.0);
  });

  it('does not throw if a source impl rejects', async () => {
    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => {
        throw new Error('synthetic gsc failure');
      },
      suggestImpl: async () => {
        throw new Error('synthetic suggest failure');
      },
      fingerprintPath: '/nonexistent/perf.json',
      now: () => '2026-05-07T22:00:00.000Z',
    });
    expect(r.stableKeywords).toEqual([]);
    expect(r.sources.gscOrphans.ok).toBe(false);
    expect(r.sources.googleSuggest.ok).toBe(false);
  });

  it('reads winnerFingerprint.topKeywords from articlePerformance file', async () => {
    const fingerprintPath = tempPath('perf-with-keywords.json');
    cleanupPaths.push(fingerprintPath);
    writeFileSync(
      fingerprintPath,
      JSON.stringify({
        winnerFingerprint: {
          topKeywords: ['frontalieri telelavoro', 'lamal 2026'],
          topClusters: [{ cluster: 'pratico', weight: 0.4 }],
        },
      }),
    );
    const r = await buildDemandVocabulary({
      gscOrphansImpl: async () => ({ ok: false, candidates: [] }),
      suggestImpl: async () => ({ ok: false, candidates: [] }),
      fingerprintPath,
      now: () => '2026-05-07T22:00:00.000Z',
    });
    expect(r.sources.winnerFingerprint.ok).toBe(true);
    expect(r.sources.winnerFingerprint.kw_count).toBe(2);
    // Fingerprint contributes weight 0.3 by default → above floor.
    const norms = r.stableKeywords.map((k: any) => k.normalizedKeyword).sort();
    expect(norms).toContain('frontalieri telelavoro');
    expect(norms).toContain('lamal 2026');
  });
});
