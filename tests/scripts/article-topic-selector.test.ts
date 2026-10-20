// tests/scripts/article-topic-selector.test.ts
//
// Phase B+C — News-pool re-ranker + experimental tier + cluster classifier.
//
// Spec: ~/.gstack/projects/valerielinc-ops-frontaliere-si-o-no/ceo-plans/
//        20260507-demand-driven-article-selection.md
// Test plan: valerielinc-main-eng-review-test-plan-20260507-090000.md

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as selectorMod from '../../scripts/lib/article-topic-selector.mjs';

const {
  loadDemandVocabulary,
  loadExperimentalCandidates,
  classifyHeadlineClusters,
  scoreHeadline,
  rankAndSelectHeadlines,
  loadTodayPicksByCluster,
  persistTodayPicksByCluster,
  loadExperimentalCounter,
  persistExperimentalCounter,
  shouldUseExperimentalTier,
  loadEvergreenRejectedTracker,
  EVERGREEN_REJECTED_SCHEMA_VERSION,
  EVERGREEN_POOL_NAME,
  EVERGREEN_STRIKE_TTL_MS,
  computeEvergreenPoolEpoch,
  migrateEvergreenRejectedTracker,
  isEvergreenBanned,
  isEvergreenStruck,
  evergreenRejectionKind,
  isEvergreenRejected,
  appendEvergreenRejected,
  strikeEvergreenKeyword,
  EVERGREEN_STRIKE_LIMIT,
  persistEvergreenRejectedTrackerAtomically,
  RANKER_MIN_SCORE,
  EXPERIMENTAL_RATIO_DEFAULT,
} = selectorMod as any;

let workDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `art-selector-bc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// ── Constants ─────────────────────────────────────────────────────
describe('selector — Phase B+C constants', () => {
  it('RANKER_MIN_SCORE is 0.25 per design (raised from 0.15 on 2026-05-07)', () => {
    expect(RANKER_MIN_SCORE).toBe(0.25);
  });
  it('EXPERIMENTAL_RATIO_DEFAULT is 0.10', () => {
    expect(EXPERIMENTAL_RATIO_DEFAULT).toBeCloseTo(0.1);
  });
});

// ── loadDemandVocabulary / loadExperimentalCandidates ─────────────
describe('loadDemandVocabulary', () => {
  it('returns null when file missing', () => {
    expect(loadDemandVocabulary({ path: join(workDir, 'missing.json') })).toBeNull();
  });
  it('returns parsed vocab when file is present', () => {
    const p = join(workDir, 'demand.json');
    const vocab = { stableKeywords: [{ kw: 'frontalieri ticino', weight: 0.9, source: 'gsc', cluster: 'novita' }] };
    writeFileSync(p, JSON.stringify(vocab));
    const got = loadDemandVocabulary({ path: p });
    expect(got).toEqual(vocab);
  });
});

describe('loadExperimentalCandidates', () => {
  it('returns null when file missing', () => {
    expect(loadExperimentalCandidates({ path: join(workDir, 'missing.json') })).toBeNull();
  });
  it('returns parsed candidates when file is present', () => {
    const p = join(workDir, 'exp.json');
    const data = { candidates: [{ id: 'a', keyword: 'foo', totalScore: 0.5 }] };
    writeFileSync(p, JSON.stringify(data));
    expect(loadExperimentalCandidates({ path: p })).toEqual(data);
  });
});

// ── classifyHeadlineClusters ──────────────────────────────────────
describe('classifyHeadlineClusters', () => {
  it('returns [] for empty input', async () => {
    expect(await classifyHeadlineClusters([])).toEqual([]);
  });

  it('forceRegex: true classifies via regex (no LLM call)', async () => {
    const callLLM = vi.fn();
    const out = await classifyHeadlineClusters(
      ['Tasse svizzera vs italia', 'LAMal 2026 premio', 'Permesso G rinnovo'],
      { forceRegex: true, callLLM },
    );
    expect(callLLM).not.toHaveBeenCalled();
    expect(out).toEqual(['fiscale', 'salute', 'pratico']);
  });

  it('uses LLM response when JSON array is well-formed and length matches', async () => {
    const callLLM = vi.fn(async () => '["fiscale","salute"]');
    const out = await classifyHeadlineClusters(['x', 'y'], { callLLM });
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(out).toEqual(['fiscale', 'salute']);
  });

  it('falls back to regex when LLM JSON is malformed', async () => {
    const callLLM = vi.fn(async () => 'not json at all{');
    const out = await classifyHeadlineClusters(
      ['Tasse svizzera 2026', 'Permesso G'],
      { callLLM },
    );
    expect(out).toEqual(['fiscale', 'pratico']);
  });

  it('falls back to regex when LLM returns wrong-length array', async () => {
    const callLLM = vi.fn(async () => '["fiscale"]');
    const out = await classifyHeadlineClusters(['Tasse', 'Permesso G'], { callLLM });
    expect(out).toEqual(['fiscale', 'pratico']);
  });

  it('mixes valid LLM output with regex fallback for hallucinated entries', async () => {
    // Second entry is hallucinated ("hallucinated_cluster_name"); should fall back to regex for that one.
    const callLLM = vi.fn(async () => '["fiscale","hallucinated_cluster_name"]');
    const out = await classifyHeadlineClusters(['Tasse 2026', 'Permesso G frontaliere'], { callLLM });
    expect(out[0]).toBe('fiscale');
    expect(out[1]).toBe('pratico');
  });

  it('strips ```json fences and reasoning blocks before parsing', async () => {
    const callLLM = vi.fn(async () => '<think>let me think</think>\n```json\n["fiscale","salute"]\n```');
    const out = await classifyHeadlineClusters(['a', 'b'], { callLLM });
    expect(out).toEqual(['fiscale', 'salute']);
  });

  it('falls back to regex when LLM throws', async () => {
    const callLLM = vi.fn(async () => { throw new Error('all providers exhausted'); });
    const out = await classifyHeadlineClusters(['Tasse'], { callLLM });
    expect(out).toEqual(['fiscale']);
  });
});

// ── scoreHeadline ─────────────────────────────────────────────────
describe('scoreHeadline', () => {
  const vocab = {
    stableKeywords: [
      { kw: 'frontalieri ticino calo', weight: 0.9, source: 'gsc', cluster: 'novita' },
      { kw: 'tasse svizzera', weight: 0.8, source: 'suggest', cluster: 'fiscale' },
    ],
  };

  it('zero overlap with vocab → demandScore = 0, score reflects only diversity + novelty', () => {
    const out = scoreHeadline('Bayern e Bayer Champions League', vocab, {
      todayPicksByCluster: {},
      headlineCluster: 'generic',
      existingTitles: [],
    });
    expect(out.demandScore).toBe(0);
    expect(out.clusterDiversityBonus).toBe(1.0);
    expect(out.noveltyScore).toBe(1.0);
    // 0.6*0 + 0.2*1 + 0.2*1 = 0.4
    expect(out.score).toBeCloseTo(0.4, 5);
  });

  it('full overlap with high-weight vocab → demand component drives score above 0.6', () => {
    const out = scoreHeadline('Frontalieri Ticino calo nel 2026', vocab, {
      todayPicksByCluster: {},
      headlineCluster: 'novita',
      existingTitles: [],
    });
    expect(out.demandScore).toBeGreaterThan(0.4);
    expect(out.score).toBeGreaterThan(0.6);
  });

  it('cluster diversity: first pick of cluster → bonus 1.0, second → 0.5', () => {
    const first = scoreHeadline('foo', vocab, {
      todayPicksByCluster: { fiscale: 0 },
      headlineCluster: 'fiscale',
      existingTitles: [],
    });
    const second = scoreHeadline('foo', vocab, {
      todayPicksByCluster: { fiscale: 1 },
      headlineCluster: 'fiscale',
      existingTitles: [],
    });
    expect(first.clusterDiversityBonus).toBe(1.0);
    expect(second.clusterDiversityBonus).toBe(0.5);
  });

  it('novelty: jaccard ≥ 0.7 with an existing title → noveltyScore = 0', () => {
    const out = scoreHeadline('Telelavoro frontalieri 25 percento', vocab, {
      headlineCluster: 'fiscale',
      existingTitles: ['Telelavoro frontalieri 25 percento'],
    });
    expect(out.noveltyScore).toBe(0);
  });

  it('empty vocab → demandScore = 0', () => {
    const out = scoreHeadline('Frontalieri Ticino', null, {
      headlineCluster: 'novita',
      existingTitles: [],
    });
    expect(out.demandScore).toBe(0);
    expect(out.score).toBeCloseTo(0.4, 5);
  });
});

// ── shouldUseExperimentalTier ─────────────────────────────────────
describe('shouldUseExperimentalTier', () => {
  it('ratio=0 → never experimental', () => {
    for (let i = 0; i < 30; i++) expect(shouldUseExperimentalTier(i, 0)).toBe(false);
  });
  it('ratio=1 → always experimental', () => {
    for (let i = 0; i < 5; i++) expect(shouldUseExperimentalTier(i, 1)).toBe(true);
  });
  it('ratio=0.10 → 1-in-10 cadence', () => {
    let yes = 0;
    for (let i = 0; i < 30; i++) if (shouldUseExperimentalTier(i, 0.1)) yes++;
    expect(yes).toBe(3); // exactly 30/10
  });
});

// ── rankAndSelectHeadlines ─────────────────────────────────────────
describe('rankAndSelectHeadlines', () => {
  const vocab = {
    stableKeywords: [
      { kw: 'frontalieri ticino', weight: 0.9, source: 'gsc', cluster: 'novita' },
      { kw: 'frontalieri calo', weight: 0.7, source: 'suggest', cluster: 'novita' },
      { kw: 'permesso g rinnovo', weight: 0.85, source: 'suggest', cluster: 'pratico' },
    ],
  };

  it('returns [] when both pools are empty', async () => {
    const out = await rankAndSelectHeadlines([], null, {
      classifierOpts: { forceRegex: true },
    });
    expect(out).toEqual([]);
  });

  it('stable pick: top-score headline returned with _selectedSource=stable', async () => {
    const headlines = [
      { headline: 'Bayern e Bayer Champions League', source: 'tio.ch', url: 'u1' },
      { headline: 'Frontalieri Ticino in calo nel 2026', source: 'rsi.ch', url: 'u2' },
      { headline: 'Cottarelli al Liceo Manzoni', source: 'varesenews.it', url: 'u3' },
    ];
    const picks = await rankAndSelectHeadlines(headlines, vocab, {
      classifierOpts: { forceRegex: true },
      maxPicks: 1,
    });
    expect(picks).toHaveLength(1);
    expect(picks[0].headline).toBe('Frontalieri Ticino in calo nel 2026');
    expect(picks[0]._selectedSource).toBe('stable');
    expect(picks[0]._score.score).toBeGreaterThan(RANKER_MIN_SCORE);
  });

  it('all headlines below minScore → returns []', async () => {
    const headlines = [{ headline: 'Cottarelli', source: 'x', url: 'u1' }];
    const picks = await rankAndSelectHeadlines(headlines, vocab, {
      classifierOpts: { forceRegex: true },
      minScore: 0.99, // impossibly high
    });
    expect(picks).toEqual([]);
  });

  it('experimental tier triggered: returns highest-totalScore experimental candidate', async () => {
    const headlines = [{ headline: 'foo', source: 'x', url: 'u1' }];
    const exp = {
      candidates: [
        { id: 'low', keyword: 'low scorer', totalScore: 0.1 },
        { id: 'high', keyword: 'high scorer experimental', totalScore: 0.9 },
      ],
    };
    const picks = await rankAndSelectHeadlines(headlines, vocab, {
      classifierOpts: { forceRegex: true },
      experimentalCandidates: exp,
      forceExperimental: true,
    });
    expect(picks).toHaveLength(1);
    expect(picks[0]._selectedSource).toBe('experimental');
    expect(picks[0].id).toBe('high');
  });

  it('experimental tier with empty experimental pool → falls through to stable scoring', async () => {
    const headlines = [
      { headline: 'Frontalieri Ticino calo 2026', source: 'rsi.ch', url: 'u1' },
    ];
    const picks = await rankAndSelectHeadlines(headlines, vocab, {
      classifierOpts: { forceRegex: true },
      experimentalCandidates: { candidates: [] },
      forceExperimental: true,
    });
    expect(picks).toHaveLength(1);
    expect(picks[0]._selectedSource).toBe('stable');
  });

  it('cluster diversity bonus respected across calls (same-day picks of same cluster ranked lower)', async () => {
    // Two roughly equivalent fiscale headlines + one novita headline. With
    // todayPicks fiscale=2, the novita headline should win because fiscale
    // diversity bonus has decayed to 0.25 while novita is still 1.0.
    const headlines = [
      { headline: 'Tasse svizzera frontalieri', source: 'a', url: 'u1' },
      { headline: 'Frontalieri Ticino calo 2026', source: 'b', url: 'u2' },
    ];
    const vocab2 = {
      stableKeywords: [
        { kw: 'tasse svizzera frontalieri', weight: 0.5, source: 'gsc', cluster: 'fiscale' },
        { kw: 'frontalieri ticino calo', weight: 0.5, source: 'gsc', cluster: 'novita' },
      ],
    };
    const picks = await rankAndSelectHeadlines(headlines, vocab2, {
      classifierOpts: { forceRegex: true },
      todayPicksByCluster: { fiscale: 2, novita: 0 },
    });
    expect(picks[0].url).toBe('u2'); // novita wins over hammered fiscale
  });

  // ── source-quality multiplier for undecoded Google News wrappers (#4101) ──
  // A Google News candidate not yet decoded has url=news.google.com/…, which is
  // never in perDomain → the multiplier used to degrade to a neutral 1.0 and a
  // known publisher lost its historical score. With `_publisherHost` (from the
  // RSS <source url> attr) the ranker recovers the real publisher's multiplier.
  const sourceQualityBoostingRsi = {
    medianWinnerRate: 0.5,
    perDomain: { 'rsi.ch': { winnerRate: 1.0, total: 10 } },
  };

  it('#4101: Google News wrapper with _publisherHost gets the publisher domain multiplier', async () => {
    const headlines = [
      {
        headline: 'Frontalieri Ticino in calo nel 2026',
        url: 'https://news.google.com/rss/articles/opaque',
        _publisherHost: 'rsi.ch',
      },
    ];
    const picks = await rankAndSelectHeadlines(headlines, vocab, {
      classifierOpts: { forceRegex: true },
      sourceQuality: sourceQualityBoostingRsi,
      maxPicks: 1,
    });
    expect(picks).toHaveLength(1);
    // rsi.ch winnerRate (1.0) is 2x the median (0.5) → boost multiplier > 1.
    expect(picks[0]._score.sourceQualityMultiplier).toBeGreaterThan(1);
  });

  it('#4101: same wrapper WITHOUT _publisherHost degrades to neutral (control)', async () => {
    const headlines = [
      {
        headline: 'Frontalieri Ticino in calo nel 2026',
        url: 'https://news.google.com/rss/articles/opaque',
      },
    ];
    const picks = await rankAndSelectHeadlines(headlines, vocab, {
      classifierOpts: { forceRegex: true },
      sourceQuality: sourceQualityBoostingRsi,
      maxPicks: 1,
    });
    expect(picks).toHaveLength(1);
    // news.google.com absent from perDomain → neutral 1.0 → field not attached.
    expect(picks[0]._score.sourceQualityMultiplier).toBeUndefined();
  });
});

// ── Today-picks-by-cluster persistence ────────────────────────────
describe('loadTodayPicksByCluster + persistTodayPicksByCluster', () => {
  it('returns all-zero counters when file missing', () => {
    const state = loadTodayPicksByCluster(Date.now(), { path: join(workDir, 'missing.json') });
    expect(typeof state.date).toBe('string');
    expect(state.picksByCluster.fiscale).toBe(0);
    expect(state.picksByCluster.novita).toBe(0);
  });

  it('round-trips state through persist + load', () => {
    const p = join(workDir, 'today.json');
    const now = new Date('2026-05-07T10:00:00Z').getTime();
    persistTodayPicksByCluster(
      { date: '2026-05-07', picksByCluster: { fiscale: 3, salute: 1, mobilita: 0, pratico: 0, lavoro: 0, novita: 0, generic: 0 } },
      now,
      { path: p },
    );
    const loaded = loadTodayPicksByCluster(now, { path: p });
    expect(loaded.picksByCluster.fiscale).toBe(3);
    expect(loaded.picksByCluster.salute).toBe(1);
  });

  it('resets counters when persisted date does not match today', () => {
    const p = join(workDir, 'today.json');
    persistTodayPicksByCluster(
      { date: '2025-01-01', picksByCluster: { fiscale: 99 } },
      new Date('2025-01-01').getTime(),
      { path: p },
    );
    const todayMs = new Date('2026-05-07T10:00:00Z').getTime();
    const loaded = loadTodayPicksByCluster(todayMs, { path: p });
    expect(loaded.picksByCluster.fiscale).toBe(0);
    expect(loaded.date).toBe('2026-05-07');
  });
});

// ── Experimental counter ──────────────────────────────────────────
describe('experimental counter', () => {
  it('returns {count:0} when missing', () => {
    expect(loadExperimentalCounter({ path: join(workDir, 'missing.json') })).toEqual({ count: 0 });
  });
  it('persists + reloads', () => {
    const p = join(workDir, 'counter.json');
    persistExperimentalCounter({ count: 7 }, { path: p });
    expect(loadExperimentalCounter({ path: p })).toEqual({ count: 7 });
  });
});

describe('evergreen-rejected tracker (#3138, schema v2)', () => {
  const context = {
    section: 'frontaliere',
    pool: EVERGREEN_POOL_NAME,
    poolEpoch: computeEvergreenPoolEpoch(['kw-ban', 'kw-flaky'], 'frontaliere'),
  };

  it('returns a v2 empty ledger when missing', () => {
    expect(loadEvergreenRejectedTracker({ path: join(workDir, 'missing.json') })).toEqual({
      schemaVersion: EVERGREEN_REJECTED_SCHEMA_VERSION,
      bans: [],
      strikes: [],
      legacy: [],
      topicGateUrls: {},
    });
  });

  it('migrates the legacy shape into explicit preflight quarantine', () => {
    const migrated = migrateEvergreenRejectedTracker({
      keywords: ['kw-banned'],
      strikes: { 'kw-flaky': EVERGREEN_STRIKE_LIMIT },
    }, { now: Date.now() });
    expect(migrated.ok).toBe(true);
    expect(migrated.report).toMatchObject({ bans: 0, strikes: 0, legacy: 2 });
    expect(migrated.tracker.legacy).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ban', keyword: 'kw-banned', validityRule: 'preflight-required' }),
      expect.objectContaining({ kind: 'strike', keyword: 'kw-flaky', count: EVERGREEN_STRIKE_LIMIT }),
    ]));
    expect(isEvergreenRejected(migrated.tracker, 'kw-banned')).toBe(true);
    expect(isEvergreenRejected(migrated.tracker, 'kw-banned', context)).toBe(false);
  });

  it('records ban provenance and expiring quality strikes per pool epoch', () => {
    const now = Date.now();
    let tracker = loadEvergreenRejectedTracker({ path: join(workDir, 'memory.json') });
    tracker = appendEvergreenRejected(tracker, 'kw-ban', { ...context, now });
    for (let i = 0; i < EVERGREEN_STRIKE_LIMIT; i += 1) {
      tracker = strikeEvergreenKeyword(tracker, 'kw-flaky', { ...context, now: now + i });
    }
    expect(tracker.bans[0]).toMatchObject({ keyword: 'kw-ban', ...context, validityRule: 'confirmed-duplicate' });
    expect(tracker.strikes[0]).toMatchObject({ keyword: 'kw-flaky', ...context, count: EVERGREEN_STRIKE_LIMIT });
    expect(evergreenRejectionKind(tracker, 'kw-ban', context)).toBe('ban');
    expect(evergreenRejectionKind(tracker, 'kw-flaky', context)).toBe('strike');
    expect(isEvergreenBanned(tracker, 'kw-ban', { ...context, poolEpoch: 'changed' })).toBe(false);
    expect(isEvergreenStruck(tracker, 'kw-flaky', { ...context, now: now + EVERGREEN_STRIKE_TTL_MS + 10 })).toBe(false);
  });

  it('persists the latest update under an atomic lock and recovers a stale owner', () => {
    const p = join(workDir, 'rejected.json');
    const lock = `${p}.lock`;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, token: 'dead-owner' }), 'utf8');

    const tracker = persistEvergreenRejectedTrackerAtomically(
      (current: any) => appendEvergreenRejected(current, 'kw-atomic', { ...context, now: Date.now() }),
      { path: p, _syncDirectoryForTest: () => {} },
    );
    expect(tracker.bans[0]).toMatchObject({ keyword: 'kw-atomic', ...context });
    expect(loadEvergreenRejectedTracker({ path: p }).bans).toHaveLength(1);
    expect(JSON.parse(readFileSync(p, 'utf8')).schemaVersion).toBe(EVERGREEN_REJECTED_SCHEMA_VERSION);
    expect(existsSync(lock)).toBe(false);
  });
});
