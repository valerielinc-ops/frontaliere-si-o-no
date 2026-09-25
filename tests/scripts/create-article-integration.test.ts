// tests/scripts/create-article-integration.test.ts
//
// Phase 3 — Generator integration. Tests the helper module that
// scripts/create-article.mjs imports for topic-candidate selection,
// consumed-tracker management, and winner-fingerprint prompt enrichment.
//
// Spec: docs/superpowers/specs/2026-05-06-smarter-article-generator-design.md

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as selectorMod from '../../scripts/lib/article-topic-selector.mjs';

const {
  loadJsonSafe,
  jaccardSimilarity,
  extractItTitlesFromMeta,
  isCandidateDuplicate,
  loadConsumedTracker,
  appendConsumedId,
  persistConsumedTracker,
  pickTopCandidate,
  buildWinnerFingerprintMessage,
  CANDIDATE_MIN_SCORE,
  CANDIDATE_DUP_JACCARD,
  CONSUMED_MAX_IDS,
} = selectorMod as any;

let workDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `article-topic-selector-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// ── Constants sanity ─────────────────────────────────────────────
describe('selector — exported constants', () => {
  it('CANDIDATE_MIN_SCORE matches spec (0.6)', () => {
    expect(CANDIDATE_MIN_SCORE).toBe(0.6);
  });
  it('CANDIDATE_DUP_JACCARD matches spec defense-in-depth threshold (0.7)', () => {
    expect(CANDIDATE_DUP_JACCARD).toBe(0.7);
  });
  it('CONSUMED_MAX_IDS caps tracker to 500 (FIFO)', () => {
    expect(CONSUMED_MAX_IDS).toBe(500);
  });
});

// ── loadJsonSafe ─────────────────────────────────────────────────
describe('loadJsonSafe', () => {
  it('returns null when file does not exist', () => {
    expect(loadJsonSafe(join(workDir, 'missing.json'))).toBeNull();
  });
  it('returns parsed object on valid JSON', () => {
    const p = join(workDir, 'good.json');
    writeFileSync(p, JSON.stringify({ a: 1, b: [2, 3] }));
    expect(loadJsonSafe(p)).toEqual({ a: 1, b: [2, 3] });
  });
  it('returns null on malformed JSON (does not throw)', () => {
    const p = join(workDir, 'bad.json');
    writeFileSync(p, '{ this is : not json,');
    expect(loadJsonSafe(p)).toBeNull();
  });
});

// ── extractItTitlesFromMeta ──────────────────────────────────────
describe('extractItTitlesFromMeta', () => {
  it('parses titles in the blog-meta-it.ts shape', () => {
    const src = `
const meta = {
  'blog.article.foo-bar.title': 'Frontalieri e tasse 2026',
  'blog.article.foo-bar.excerpt': 'Una guida pratica',
  'blog.article.baz-qux.title': 'Telelavoro 25 percento',
};`;
    expect(extractItTitlesFromMeta(src)).toEqual([
      'Frontalieri e tasse 2026',
      'Telelavoro 25 percento',
    ]);
  });
  it('returns [] on empty/null input', () => {
    expect(extractItTitlesFromMeta('')).toEqual([]);
    expect(extractItTitlesFromMeta(null as any)).toEqual([]);
  });
});

// ── jaccardSimilarity + isCandidateDuplicate ─────────────────────
describe('jaccardSimilarity + isCandidateDuplicate', () => {
  it('jaccard identical = 1', () => {
    expect(jaccardSimilarity('frontalieri ticino tasse', 'frontalieri ticino tasse')).toBe(1);
  });
  it('jaccard disjoint = 0', () => {
    expect(jaccardSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });
  it('isCandidateDuplicate flags structurally similar keyword (Jaccard ≥ 0.7)', () => {
    const cand = { keyword: 'frontalieri telelavoro 25 percento accordo' };
    const titles = ['Telelavoro frontalieri 25 percento'];
    expect(isCandidateDuplicate(cand, titles)).toBe(true);
  });
  it('isCandidateDuplicate ignores unrelated existing titles', () => {
    const cand = { keyword: 'frontalieri telelavoro 25 percento' };
    const titles = ['Costo della vita a Lugano', 'AVS pensione italiana'];
    expect(isCandidateDuplicate(cand, titles)).toBe(false);
  });
  it('isCandidateDuplicate returns false on empty titles list (no signal)', () => {
    expect(isCandidateDuplicate({ keyword: 'foo' }, [])).toBe(false);
  });
});

// ── pickTopCandidate ──────────────────────────────────────────────
describe('pickTopCandidate', () => {
  const baseCand = (overrides: Record<string, unknown>) => ({
    id: 'fnv-1',
    keyword: 'frontalieri telelavoro 45 giorni 2026',
    angle: 'Nuova soglia 45 giorni',
    totalScore: 0.85,
    ...overrides,
  });

  it('returns null when topicCandidates is null (no file present)', () => {
    expect(pickTopCandidate(null)).toBeNull();
  });
  it('returns null when candidates list is empty', () => {
    expect(pickTopCandidate({ candidates: [] })).toBeNull();
  });
  it('returns the first eligible high-score candidate', () => {
    const data = { candidates: [baseCand({ id: 'a', totalScore: 0.85 })] };
    const got = pickTopCandidate(data);
    expect(got?.id).toBe('a');
  });
  it('skips candidates below CANDIDATE_MIN_SCORE (0.6)', () => {
    const data = {
      candidates: [
        baseCand({ id: 'low', totalScore: 0.5 }),
        baseCand({ id: 'high', totalScore: 0.7 }),
      ],
    };
    const got = pickTopCandidate(data);
    expect(got?.id).toBe('high');
  });
  it('skips candidates already in the consumed tracker', () => {
    const data = {
      candidates: [
        baseCand({ id: 'used', totalScore: 0.9 }),
        baseCand({ id: 'fresh', totalScore: 0.7, keyword: 'pensione lpp 2026' }),
      ],
    };
    const got = pickTopCandidate(data, { consumed: { ids: ['used'] } });
    expect(got?.id).toBe('fresh');
  });
  it('skips candidates structurally similar (Jaccard ≥ 0.7) to existing IT titles', () => {
    const data = {
      candidates: [
        baseCand({
          id: 'dup',
          keyword: 'telelavoro frontalieri 25 percento',
          totalScore: 0.9,
        }),
        baseCand({
          id: 'novel',
          keyword: 'mutuo casa svizzera frontaliere',
          totalScore: 0.7,
        }),
      ],
    };
    const titles = ['Telelavoro frontalieri 25 percento'];
    const got = pickTopCandidate(data, { existingTitles: titles });
    expect(got?.id).toBe('novel');
  });
  it('returns null when every candidate is consumed/low-score/duplicate', () => {
    const data = {
      candidates: [
        baseCand({ id: 'a', totalScore: 0.4 }),
        baseCand({ id: 'b', totalScore: 0.9 }),
      ],
    };
    expect(pickTopCandidate(data, { consumed: { ids: ['b'] } })).toBeNull();
  });
});

// ── consumed tracker (load/append/persist) ───────────────────────
describe('consumed tracker', () => {
  it('loadConsumedTracker returns empty when file missing', () => {
    const t = loadConsumedTracker(join(workDir, 'missing.json'));
    expect(t).toEqual({ consumedAt: null, ids: [] });
  });
  it('appendConsumedId appends new id and dedupes', () => {
    let t = { consumedAt: null, ids: [] as string[] };
    t = appendConsumedId(t, 'a');
    expect(t.ids).toEqual(['a']);
    t = appendConsumedId(t, 'b');
    expect(t.ids).toEqual(['a', 'b']);
    // Re-appending same id moves it to the tail (and dedupes).
    t = appendConsumedId(t, 'a');
    expect(t.ids).toEqual(['b', 'a']);
  });
  it('appendConsumedId rotates FIFO past max', () => {
    let t = { consumedAt: null, ids: [] as string[] };
    for (let i = 0; i < 5; i++) t = appendConsumedId(t, `id-${i}`, 3);
    expect(t.ids).toEqual(['id-2', 'id-3', 'id-4']);
  });
  it('persist + load round-trip', () => {
    const p = join(workDir, 'sub', 'consumed.json');
    const t = appendConsumedId({ consumedAt: null, ids: [] }, 'x1');
    expect(persistConsumedTracker(t, p)).toBe(true);
    const loaded = loadConsumedTracker(p);
    expect(loaded.ids).toEqual(['x1']);
    expect(typeof loaded.consumedAt).toBe('string');
  });
  it('end-to-end: same candidate id is not picked twice across two pickTopCandidate calls', () => {
    const data = {
      candidates: [
        { id: 'top', keyword: 'frontalieri smart working 2026', totalScore: 0.9 },
        { id: 'next', keyword: 'pensione lpp 2026', totalScore: 0.7 },
      ],
    };
    // First call — picks 'top'.
    const p = join(workDir, 'consumed.json');
    let consumed = loadConsumedTracker(p);
    const first = pickTopCandidate(data, { consumed });
    expect(first?.id).toBe('top');
    consumed = appendConsumedId(consumed, first!.id);
    persistConsumedTracker(consumed, p);

    // Reload and call again — must skip 'top'.
    consumed = loadConsumedTracker(p);
    const second = pickTopCandidate(data, { consumed });
    expect(second?.id).toBe('next');
  });
});

// ── buildWinnerFingerprintMessage ────────────────────────────────
describe('buildWinnerFingerprintMessage', () => {
  it('returns null when articlePerformance is null', () => {
    expect(buildWinnerFingerprintMessage(null)).toBeNull();
  });
  it('returns null when fingerprint is missing/empty', () => {
    expect(buildWinnerFingerprintMessage({})).toBeNull();
    expect(buildWinnerFingerprintMessage({ winnerFingerprint: {} })).toBeNull();
    expect(
      buildWinnerFingerprintMessage({
        winnerFingerprint: {
          topClusters: [],
          topAngles: [],
          topKeywords: [],
          topQuestionPatterns: [],
        },
      }),
    ).toBeNull();
  });
  it('renders the Italian system message with all sections when fingerprint is present', () => {
    const perf = {
      winnerFingerprint: {
        topClusters: [
          { cluster: 'fiscale', weight: 0.42 },
          { cluster: 'pratico', weight: 0.31 },
        ],
        topAngles: ['come funziona', 'calcolo passo-passo'],
        topKeywords: ['telelavoro', 'permesso G', 'tasse 2026'],
        averageWordCount: 1450,
        topQuestionPatterns: ['quando', 'quanto', 'come'],
      },
    };
    const msg = buildWinnerFingerprintMessage(perf);
    expect(msg).toBeTruthy();
    expect(msg).toContain('Per riferimento, gli articoli con più traffico organico storicamente:');
    expect(msg).toContain('coprono questi cluster: fiscale, pratico');
    expect(msg).toContain('usano angoli concreti tipo: come funziona; calcolo passo-passo');
    expect(msg).toContain('includono parole chiave: telelavoro, permesso G, tasse 2026');
    expect(msg).toContain('hanno una lunghezza media di ~1450 parole');
    expect(msg).toContain('rispondono spesso a domande tipo: quando, quanto, come');
    expect(msg).toContain('Mantieni questi pattern QUANDO sono pertinenti');
  });
  it('accepts string-only entries in topClusters', () => {
    const msg = buildWinnerFingerprintMessage({
      winnerFingerprint: { topClusters: ['fiscale', 'pratico'] },
    });
    expect(msg).toContain('coprono questi cluster: fiscale, pratico');
  });
  it('omits sections that are empty (partial fingerprint)', () => {
    const msg = buildWinnerFingerprintMessage({
      winnerFingerprint: { topKeywords: ['telelavoro'] },
    });
    expect(msg).toBeTruthy();
    expect(msg).toContain('includono parole chiave: telelavoro');
    expect(msg).not.toContain('coprono questi cluster:');
    expect(msg).not.toContain('hanno una lunghezza media');
  });
});

// ── Backward-compat invariants (data files missing) ──────────────
describe('backward compatibility', () => {
  it('selector functions are no-ops when data files are absent', () => {
    // Mirror what create-article.mjs does at module top.
    const perf = loadJsonSafe(join(workDir, 'article-performance.json'));
    const cand = loadJsonSafe(join(workDir, 'topic-candidates.json'));
    expect(perf).toBeNull();
    expect(cand).toBeNull();
    expect(buildWinnerFingerprintMessage(perf)).toBeNull();
    expect(pickTopCandidate(cand)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════
// Phase B+C — News-pool re-ranker REGRESSION TEST (CRITICAL)
//
// Per eng-review test plan 2026-05-07: assert that the new ranker
// chooses by SCORE not by ORDER. If this test ever passes-by-accident
// because the high-score headline happens to be first, change the
// fixture so it is NOT first.
// ═════════════════════════════════════════════════════════════════
describe('create-article topic selection (Phase B+C regression)', () => {
  const { rankAndSelectHeadlines } = selectorMod as any;

  it('CRITICAL: picks the highest-scoring headline, NOT the first in pool', async () => {
    // High-relevance headline is at index 1 (NOT first). If selection were
    // first-wins, the test would fail with the Bayern/Bayer pick.
    const headlinesPool = [
      { headline: 'Bayern e Bayer Champions League', source: 'tio.ch', url: 'u1' },
      { headline: 'Frontalieri in Ticino in calo nel 2026', source: 'rsi.ch', url: 'u2' },
      { headline: 'Cottarelli al Liceo Manzoni', source: 'varesenews.it', url: 'u3' },
    ];
    const vocab = {
      stableKeywords: [
        { kw: 'frontalieri ticino', weight: 0.9, source: 'gsc', cluster: 'novita' },
        { kw: 'frontalieri calo', weight: 0.7, source: 'suggest', cluster: 'novita' },
      ],
    };
    const result = await rankAndSelectHeadlines(headlinesPool, vocab, {
      classifierOpts: { forceRegex: true },
      maxPicks: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0].headline).toBe('Frontalieri in Ticino in calo nel 2026');
    expect(result[0].url).toBe('u2');
    expect(result[0]._selectedSource).toBe('stable');
  });

  it('returns [] when all headlines are off-topic (caller falls back to evergreen)', async () => {
    const headlinesPool = [
      { headline: 'Bayern e Bayer Champions League', source: 'tio.ch', url: 'u1' },
      { headline: 'Cottarelli al Liceo Manzoni', source: 'varesenews.it', url: 'u2' },
    ];
    const vocab = {
      stableKeywords: [
        { kw: 'frontalieri ticino', weight: 0.9, source: 'gsc', cluster: 'novita' },
      ],
    };
    const result = await rankAndSelectHeadlines(headlinesPool, vocab, {
      classifierOpts: { forceRegex: true },
      // Tightened threshold so the off-topic baseline (0.4) doesn't sneak through.
      minScore: 0.5,
    });
    expect(result).toEqual([]);
  });

  it('cluster diversity: same-day fiscale picks deprioritise next fiscale headline', async () => {
    const headlinesPool = [
      { headline: 'Tasse svizzera ristorni 2026', source: 'a', url: 'u1' },
      { headline: 'Frontalieri Ticino calo 2026', source: 'b', url: 'u2' },
    ];
    const vocab = {
      stableKeywords: [
        { kw: 'tasse svizzera ristorni', weight: 0.5, source: 'gsc', cluster: 'fiscale' },
        { kw: 'frontalieri ticino calo', weight: 0.5, source: 'gsc', cluster: 'novita' },
      ],
    };
    // After 2 fiscale picks today, fiscale bonus = 0.25 vs novita = 1.0.
    const result = await rankAndSelectHeadlines(headlinesPool, vocab, {
      classifierOpts: { forceRegex: true },
      todayPicksByCluster: { fiscale: 2, novita: 0 },
    });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('u2');
  });

  it('experimental tier: forced experimental returns candidate, not headline', async () => {
    const headlinesPool = [{ headline: 'Frontalieri Ticino', source: 'a', url: 'u1' }];
    const experimentalCandidates = {
      candidates: [{ id: 'exp-1', keyword: 'lavoro estivo lugano frontaliere', totalScore: 0.7 }],
    };
    const result = await rankAndSelectHeadlines(headlinesPool, { stableKeywords: [] }, {
      classifierOpts: { forceRegex: true },
      experimentalCandidates,
      forceExperimental: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0]._selectedSource).toBe('experimental');
    expect(result[0].id).toBe('exp-1');
  });
});
