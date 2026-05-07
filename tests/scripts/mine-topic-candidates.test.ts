import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as gscMod from '../../scripts/lib/topic-sources/gscOrphans.mjs';
import * as trendsMod from '../../scripts/lib/topic-sources/googleTrends.mjs';
import * as redditMod from '../../scripts/lib/topic-sources/reddit.mjs';
import * as fbMod from '../../scripts/lib/topic-sources/facebookPages.mjs';
import * as noveltyMod from '../../scripts/lib/topic-sources/noveltyCheck.mjs';
import * as orchestrator from '../../scripts/mine-topic-candidates.mjs';

const {
  fetchGscOrphanCandidates,
  jaccard,
  fnv1a8,
  normalizeKeyword,
  extractItTitles,
} = gscMod as any;

const {
  buildSeedList,
  parseTrendsScore,
  extractRisingQueries,
  fetchGoogleTrendsCandidates,
} = trendsMod as any;

const {
  isQuestionTitle,
  passesFilters,
  fetchRedditCandidates,
  extractPosts,
} = redditMod as any;

const {
  postPassesFilter,
  fetchFacebookCandidates,
} = fbMod as any;

const { noveltyScore } = noveltyMod as any;

const {
  mineTopicCandidates,
  normalizeSignals,
  computeDemandScore,
  mergeCandidates,
  scoreCandidates,
} = orchestrator as any;

// ───────────────────────── helpers ─────────────────────────
function tempPath(name: string): string {
  const dir = join(tmpdir(), `topic-candidates-test-${process.pid}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

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

// ───────────────────────── gscOrphans ─────────────────────────

describe('gscOrphans', () => {
  it('fnv1a8 returns 8-hex deterministic hashes', () => {
    expect(fnv1a8('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a8('hello')).toBe(fnv1a8('hello'));
    expect(fnv1a8('hello')).not.toBe(fnv1a8('world'));
  });

  it('jaccard returns identity 1.0 on identical strings', () => {
    expect(jaccard('telelavoro frontalieri', 'telelavoro frontalieri')).toBe(1);
  });

  it('jaccard < 1 on partial overlap', () => {
    const s = jaccard('telelavoro frontalieri 2026', 'telelavoro frontalieri');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('extractItTitles parses blog-meta lines', () => {
    const sample = [
      "'blog.article.foo.title': 'Hello World',",
      "'blog.article.bar.title': 'Another title',",
      "'blog.article.bar.excerpt': 'not a title',",
    ].join('\n');
    expect(extractItTitles(sample)).toEqual(['Hello World', 'Another title']);
  });

  it('filters by impressions >= 5 and de-dups by keyword', async () => {
    const orphanData = {
      bucketA: [
        { query: 'telelavoro 45 giorni', impressions: 100, clicks: 2 },
        { query: 'too-low signal', impressions: 3, clicks: 0 }, // below MIN_IMPRESSIONS=5
        { query: 'telelavoro 45 giorni', impressions: 80, clicks: 1 }, // dup
      ],
    };
    const r = await fetchGscOrphanCandidates({
      orphanData,
      existingTitles: [],
    });
    expect(r.ok).toBe(true);
    // 'telelavoro 45 giorni' (deduped to 1) — 'too-low signal' below floor.
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].keyword).toMatch(/telelavoro/i);
    expect(r.candidates[0].sources).toEqual(['gscOrphans']);
  });

  it('drops queries with high Jaccard against existing titles', async () => {
    const orphanData = {
      x: [
        // Same tokens as the existing title → Jaccard = 1.0, dropped.
        { query: 'telelavoro frontalieri guida', impressions: 200 },
        { query: 'novita totalmente diversa', impressions: 200 },
      ],
    };
    const r = await fetchGscOrphanCandidates({
      orphanData,
      existingTitles: ['Telelavoro frontalieri guida'],
    });
    expect(r.ok).toBe(true);
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].keyword).toBe('novita totalmente diversa');
  });

  it('returns ok:false when file missing', async () => {
    const r = await fetchGscOrphanCandidates({
      orphanQueriesPath: '/nonexistent/path.json',
      blogMetaPath: '/nonexistent/meta.ts',
    });
    expect(r.ok).toBe(false);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toBeTruthy();
  });
});

// ───────────────────────── googleTrends ─────────────────────────

describe('googleTrends', () => {
  it('parseTrendsScore handles Breakout, percent strings, plain numbers', () => {
    expect(parseTrendsScore('Breakout')).toBe(200);
    expect(parseTrendsScore('+90%')).toBe(90);
    expect(parseTrendsScore(45)).toBe(45);
    expect(parseTrendsScore(null)).toBe(null);
  });

  it('extractRisingQueries returns only the rising list (index 1)', () => {
    const json = {
      default: {
        rankedList: [
          { rankedKeyword: [{ query: 'top-not-rising', formattedValue: ['100'] }] },
          {
            rankedKeyword: [
              { query: 'rising-a', formattedValue: ['+90%'] },
              { query: 'rising-b', formattedValue: ['Breakout'] },
            ],
          },
        ],
      },
    };
    const r = extractRisingQueries(json);
    expect(r).toEqual([
      { query: 'rising-a', score: 90 },
      { query: 'rising-b', score: 200 },
    ]);
  });

  it('buildSeedList unions winnerFingerprint topKeywords', () => {
    const seeds = buildSeedList({ topKeywords: ['nuova-keyword', 'frontaliere'] });
    expect(seeds).toContain('frontaliere'); // de-duped
    expect(seeds).toContain('nuova-keyword');
  });

  it('orchestrates per-geo with mock googleTrends impl', async () => {
    const fake = {
      relatedQueries: vi.fn(async () =>
        JSON.stringify({
          default: {
            rankedList: [
              { rankedKeyword: [] },
              {
                rankedKeyword: [
                  { query: 'fake rising', formattedValue: ['+50%'] },
                ],
              },
            ],
          },
        }),
      ),
    };
    const r = await fetchGoogleTrendsCandidates({
      googleTrendsImpl: fake,
      sleepFn: async () => undefined,
    });
    expect(r.ok).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
    // Three geos.
    expect(Object.keys(r.perGeo)).toEqual([
      'googleTrendsIt',
      'googleTrendsItLombardia',
      'googleTrendsCh',
    ]);
  });

  it('falls back to playwright impl on api error and never throws', async () => {
    const fake = {
      relatedQueries: vi.fn(async () => {
        throw new Error('429 rate limited');
      }),
    };
    const fallback = vi.fn(async () => [
      { query: 'fallback rising', score: 80 },
    ]);
    const r = await fetchGoogleTrendsCandidates({
      googleTrendsImpl: fake,
      playwrightFallback: fallback,
      sleepFn: async () => undefined,
    });
    // Even if individual API calls failed, fallback returned data so per-geo
    // candidates appear.
    const total = r.candidates.length;
    expect(total).toBeGreaterThan(0);
    expect(fallback).toHaveBeenCalled();
  });

  it('retries the lib call before falling back (transient errors recover)', async () => {
    let calls = 0;
    const fake = {
      relatedQueries: vi.fn(async () => {
        calls += 1;
        if (calls <= 2) {
          throw new Error('transient parse error');
        }
        return JSON.stringify({
          default: {
            rankedList: [
              { rankedKeyword: [] },
              {
                rankedKeyword: [
                  { query: 'recovered query', formattedValue: ['+70%'] },
                ],
              },
            ],
          },
        });
      }),
    };
    const fallback = vi.fn(async () => []);
    const r = await fetchGoogleTrendsCandidates({
      googleTrendsImpl: fake,
      playwrightFallback: fallback,
      sleepFn: async () => undefined,
    });
    // First seed retried twice (3 attempts: 2 fails + 1 success), so the
    // 3rd attempt succeeds. The fallback should NOT have run for the
    // recovered seed — that's the whole point of the retry.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(r.candidates.some((c: any) => c.keyword === 'recovered query')).toBe(true);
    // Fallback may still have run for OTHER seeds (the loop visits ~14
    // seeds × 3 geos), but the recovered-query path didn't need it.
    // What we care about: at least one candidate exists.
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('fallback success resets geoOk=true even though lib call failed', async () => {
    const fake = {
      relatedQueries: vi.fn(async () => {
        throw new Error('persistent parse error');
      }),
    };
    const fallback = vi.fn(async () => [
      { query: 'fallback rising x', score: 90 },
    ]);
    const r = await fetchGoogleTrendsCandidates({
      googleTrendsImpl: fake,
      playwrightFallback: fallback,
      sleepFn: async () => undefined,
      // Stub the RSS path to empty so the lib+fallback path is the one
      // exercised by this test.
      fetchTrendsRssImpl: async () => '',
    });
    // For each geo, the fallback fires once and returns ≥1 query, so
    // geoOk MUST be true (data is real, even if the lib path failed).
    for (const key of ['googleTrendsIt', 'googleTrendsItLombardia', 'googleTrendsCh']) {
      expect(r.perGeo[key].ok).toBe(true);
      expect(r.perGeo[key].candidates.length).toBeGreaterThan(0);
      expect(r.perGeo[key].reason).toBeUndefined();
    }
  });

  it('fallback returning [] after lib error keeps geoOk=false with sanitized reason', async () => {
    const fake = {
      relatedQueries: vi.fn(async () => {
        throw new Error('SyntaxError: Unexpected token < in JSON at position 0');
      }),
    };
    const fallback = vi.fn(async () => []);
    const r = await fetchGoogleTrendsCandidates({
      googleTrendsImpl: fake,
      playwrightFallback: fallback,
      sleepFn: async () => undefined,
      // Empty RSS so the lib path's reason is what surfaces.
      fetchTrendsRssImpl: async () => '',
    });
    for (const key of ['googleTrendsIt', 'googleTrendsItLombardia', 'googleTrendsCh']) {
      expect(r.perGeo[key].ok).toBe(false);
      expect(r.perGeo[key].candidates).toEqual([]);
      // The HTML-as-JSON parse error is now surfaced as a human reason,
      // not the raw lib error.
      expect(r.perGeo[key].reason).toMatch(/rate-limited from CI IP/);
    }
  });

  it('RSS path produces candidates without needing the lib', async () => {
    const fake = {
      relatedQueries: vi.fn(async () => '{"default":{"rankedList":[{},{}]}}'),
    };
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>frontalieri rising query</title><ht:approx_traffic>2000+</ht:approx_traffic></item>
      <item><title>varese affitti 2026</title><ht:approx_traffic>500+</ht:approx_traffic></item>
    </channel></rss>`;
    const fallback = vi.fn(async () => []);
    const r = await fetchGoogleTrendsCandidates({
      googleTrendsImpl: fake,
      playwrightFallback: fallback,
      sleepFn: async () => undefined,
      fetchTrendsRssImpl: async (geo: string) => xml,
    });
    expect(r.perGeo.googleTrendsIt.ok).toBe(true);
    expect(r.perGeo.googleTrendsIt.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r.perGeo.googleTrendsCh.ok).toBe(true);
    // 'varese' triggers the Lombardia hint; cross-tag should populate IT-25.
    expect(
      r.perGeo.googleTrendsItLombardia.candidates.some((c: any) =>
        /varese/i.test(c.keyword),
      ),
    ).toBe(true);
  });
});

// ───────────────────────── reddit ─────────────────────────

describe('reddit', () => {
  it('isQuestionTitle accepts question marks and Italian/English starts', () => {
    expect(isQuestionTitle('Come funziona il telelavoro?')).toBe(true);
    expect(isQuestionTitle('Quanto si guadagna in Ticino')).toBe(true);
    expect(isQuestionTitle('How does it work')).toBe(true);
    expect(isQuestionTitle('Random news headline.')).toBe(false);
  });

  it('passesFilters enforces score>=5, comments>=3, is_self, question', () => {
    expect(
      passesFilters({
        is_self: true,
        score: 10,
        num_comments: 5,
        title: 'Come fare?',
      }),
    ).toBe(true);
    expect(
      passesFilters({
        is_self: false,
        score: 10,
        num_comments: 5,
        title: 'Come fare?',
      }),
    ).toBe(false);
    expect(
      passesFilters({
        is_self: true,
        score: 1,
        num_comments: 5,
        title: 'Come fare?',
      }),
    ).toBe(false);
  });

  it('extractPosts pulls .data fields out of listing JSON', () => {
    const json = {
      data: {
        children: [
          { data: { title: 'a', is_self: true, score: 5, num_comments: 3 } },
          { kind: 't1', data: { title: 'b' } },
        ],
      },
    };
    const ps = extractPosts(json);
    expect(ps.length).toBe(2);
  });

  it('orchestrates fetch with mocked fetch returning qualifying posts', async () => {
    const mockFetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          children: [
            {
              data: {
                title: `Come funziona il permesso G? (${url.slice(-10)})`,
                is_self: true,
                score: 12,
                num_comments: 8,
                permalink: '/r/x/comments/y/z/',
              },
            },
          ],
        },
      }),
      text: async () => '',
    }));
    const r = await fetchRedditCandidates({
      fetchImpl: mockFetch as any,
      sleepFn: async () => undefined,
    });
    expect(r.ok).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('falls back to playwright on fetch error', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('429');
    });
    const fallback = vi.fn(async () => [
      {
        title: 'Come fare il permesso G?',
        is_self: true,
        score: 20,
        num_comments: 10,
      },
    ]);
    const r = await fetchRedditCandidates({
      fetchImpl: mockFetch as any,
      sleepFn: async () => undefined,
      playwrightFallback: fallback,
    });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(fallback).toHaveBeenCalled();
  });

  it('retries the JSON endpoint before falling back (403 transient recovers)', async () => {
    let perEndpoint = new Map<string, number>();
    const mockFetch = vi.fn(async (url: string) => {
      const n = (perEndpoint.get(url) ?? 0) + 1;
      perEndpoint.set(url, n);
      if (n <= 2) {
        const e: any = new Error('reddit 403');
        e.status = 403;
        throw e;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            children: [
              {
                data: {
                  title: 'Come funziona il permesso G?',
                  is_self: true,
                  score: 12,
                  num_comments: 8,
                  permalink: '/r/x/comments/y/z/',
                },
              },
            ],
          },
        }),
        text: async () => '',
      };
    });
    const fallback = vi.fn(async () => []);
    const r = await fetchRedditCandidates({
      fetchImpl: mockFetch as any,
      sleepFn: async () => undefined,
      playwrightFallback: fallback,
    });
    // The retry path should have produced candidates without resorting to
    // Playwright (since attempt 3 succeeds).
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('fallback receives endpoint object and tries old.reddit selectors', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('persistent 403');
    });
    // The new fallback signature receives the endpoint object so it can
    // try both old.reddit + modern www.reddit URLs in one browser session.
    const fallback = vi.fn(async (ep: any) => {
      // Verify the orchestrator passes the endpoint object (not just the URL).
      expect(ep).toEqual(expect.objectContaining({ fallbackHtml: expect.any(String) }));
      expect(ep.fallbackHtmlModern).toEqual(expect.any(String));
      // Simulate old.reddit `.thing` extraction yielding qualifying posts.
      return [
        {
          title: 'Come funziona il telelavoro?',
          is_self: true,
          score: 25,
          num_comments: 12,
        },
      ];
    });
    const r = await fetchRedditCandidates({
      fetchImpl: mockFetch as any,
      sleepFn: async () => undefined,
      playwrightFallback: fallback,
    });
    expect(fallback).toHaveBeenCalled();
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('second-tier www.reddit fallback runs after old.reddit empty (composed in one fallback)', async () => {
    // We exercise the orchestrator contract: the fallback function decides
    // whether to climb the old → modern ladder. We assert here that when
    // old.reddit returns [] but the fallback still emits posts (modeling
    // the two-tier walk), candidates land. This stays decoupled from the
    // Playwright internals (no real network).
    const mockFetch = vi.fn(async () => {
      throw new Error('429 rate limited');
    });
    let fallbackCalls = 0;
    const fallback = vi.fn(async (ep: any) => {
      fallbackCalls++;
      // First fake "old.reddit empty, modern returns one post" outcome —
      // the implementation runs both inside one Playwright session.
      return [
        {
          title: 'Quanto si paga di tasse in Svizzera?',
          is_self: true,
          score: 40,
          num_comments: 15,
        },
      ];
    });
    const r = await fetchRedditCandidates({
      fetchImpl: mockFetch as any,
      sleepFn: async () => undefined,
      playwrightFallback: fallback,
    });
    expect(fallbackCalls).toBeGreaterThan(0);
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});

// ───────────────────────── facebookPages ─────────────────────────

describe('facebookPages', () => {
  it('returns ok:false when token missing', async () => {
    const r = await fetchFacebookCandidates({ token: undefined, pages: ['x'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/FB_PAGE_ACCESS_TOKEN/);
  });

  it('returns ok:false when no pages', async () => {
    const r = await fetchFacebookCandidates({ token: 'tok', pages: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no public page IDs/);
  });

  it('postPassesFilter accepts any post above the soft engagement floor', () => {
    // No keyword filter — we want to surface "what's loud" on the page,
    // frontaliere-relevant or not. Bias is applied at sort-time.
    expect(
      postPassesFilter({
        message: 'frontalieri news',
        reactions: { summary: { total_count: 15 } },
        comments: { summary: { total_count: 10 } },
      }),
    ).toBe(true);
    // Unrelated text WITH engagement passes — keyword bias not a filter.
    expect(
      postPassesFilter({
        message: 'unrelated but loud post',
        reactions: { summary: { total_count: 100 } },
        comments: { summary: { total_count: 100 } },
      }),
    ).toBe(true);
    // Below the soft engagement floor (1): drop only completely-zero posts.
    expect(
      postPassesFilter({
        message: 'frontalieri',
        reactions: { summary: { total_count: 0 } },
        comments: { summary: { total_count: 0 } },
      }),
    ).toBe(false);
    // Empty message: drop.
    expect(
      postPassesFilter({
        message: '',
        reactions: { summary: { total_count: 100 } },
        comments: { summary: { total_count: 100 } },
      }),
    ).toBe(false);
  });

  it('orchestrates with mocked fetch', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            message: 'Nuove regole per i frontalieri 2026 in arrivo',
            reactions: { summary: { total_count: 30 } },
            comments: { summary: { total_count: 5 } },
            created_time: '2026-05-01T00:00:00Z',
          },
        ],
      }),
      text: async () => '',
    }));
    const r = await fetchFacebookCandidates({
      token: 'fake',
      pages: ['tio.ch'],
      fetchImpl: mockFetch as any,
    });
    expect(r.ok).toBe(true);
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].keyword).toMatch(/frontalieri/i);
  });
});

// ───────────────────────── novelty ─────────────────────────

describe('noveltyScore', () => {
  it('returns 1 for no existing titles', () => {
    expect(noveltyScore('whatever', [])).toBe(1);
  });

  it('returns close to 0 for known dup', () => {
    const score = noveltyScore('Telelavoro frontalieri 25%', [
      'Telelavoro frontalieri 25 percento guida',
    ]);
    expect(score).toBeLessThan(0.5);
  });

  it('returns close to 1 for unrelated keyword', () => {
    const score = noveltyScore('totalmente diversa argomento', [
      'Telelavoro frontalieri 25 percento',
    ]);
    expect(score).toBeGreaterThan(0.7);
  });
});

// ───────────────────────── aggregation / scoring ─────────────────────────

describe('orchestrator: aggregation + scoring', () => {
  it('normalizeSignals + computeDemandScore weight per spec', () => {
    const norm = normalizeSignals({
      gscImpressions: 250, // 250/500 = 0.5 → key gsc
      googleTrendsScore: 80, // 80/100 = 0.8 → key trends
    });
    expect(norm.gsc).toBeCloseTo(0.5, 5);
    expect(norm.trends).toBeCloseTo(0.8, 5);
    const score = computeDemandScore(norm);
    // Weighted by 0.4/0.7 + 0.3/0.7 → (0.5*0.4 + 0.8*0.3)/0.7 ≈ 0.628
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThan(0.7);
  });

  it('mergeCandidates unions sources and keeps best demand signals', () => {
    const a = {
      keyword: 'telelavoro 25%',
      normalizedKeyword: 'telelavoro 25%',
      sources: ['gscOrphans'],
      demandSignals: { gscImpressions: 100, gscPosition: 18 },
      rationale: 'gsc',
    };
    const b = {
      keyword: 'telelavoro 25%',
      normalizedKeyword: 'telelavoro 25%',
      sources: ['googleTrendsIt'],
      demandSignals: { googleTrendsScore: 80, gscImpressions: 200, gscPosition: 9 },
      rationale: 'trends',
    };
    const merged = mergeCandidates([a, b]);
    expect(merged.length).toBe(1);
    expect(merged[0].sources).toEqual(['gscOrphans', 'googleTrendsIt']);
    expect(merged[0].demandSignals.gscImpressions).toBe(200); // max
    expect(merged[0].demandSignals.gscPosition).toBe(9); // min
    expect(merged[0].demandSignals.googleTrendsScore).toBe(80);
    expect(merged[0].rationale).toContain('gsc');
    expect(merged[0].rationale).toContain('trends');
  });

  it('multi-source candidate gets boosted total over single-source one', () => {
    const both = scoreCandidates(
      mergeCandidates([
        {
          keyword: 'multi-source kw',
          normalizedKeyword: 'multi-source kw',
          sources: ['gscOrphans'],
          demandSignals: { gscImpressions: 250 },
        },
        {
          keyword: 'multi-source kw',
          normalizedKeyword: 'multi-source kw',
          sources: ['googleTrendsIt'],
          demandSignals: { googleTrendsScore: 90 },
        },
      ]),
      [],
    );
    const single = scoreCandidates(
      mergeCandidates([
        {
          keyword: 'single source kw',
          normalizedKeyword: 'single source kw',
          sources: ['gscOrphans'],
          demandSignals: { gscImpressions: 250 },
        },
      ]),
      [],
    );
    expect(both[0].totalScore).toBeGreaterThan(single[0].totalScore);
  });
});

// ───────────────────────── full orchestrator ─────────────────────────

describe('mineTopicCandidates orchestrator', () => {
  it('writes a valid JSON with all sources missing → empty candidates', async () => {
    const out = tempPath('all-missing.json');
    cleanupPaths.push(out);
    const result = await mineTopicCandidates({
      outputPath: out,
      blogMetaPath: '/nonexistent/blog-meta.ts',
      articlePerformancePath: '/nonexistent/perf.json',
      gscOrphansImpl: async () => ({
        ok: false,
        candidates: [],
        reason: 'no file',
      }),
      googleTrendsImpl: async () => ({
        ok: false,
        perGeo: {
          googleTrendsIt: { ok: false, candidates: [], reason: 'x' },
          googleTrendsItLombardia: { ok: false, candidates: [], reason: 'x' },
          googleTrendsCh: { ok: false, candidates: [], reason: 'x' },
        },
        candidates: [],
      }),
      redditImpl: async () => ({
        ok: false,
        perSubreddit: {
          redditTicino: { ok: false, candidates: [], reason: 'x' },
          redditItaly: { ok: false, candidates: [], reason: 'x' },
          redditLugano: { ok: false, candidates: [], reason: 'x' },
          redditSwitzerland: { ok: false, candidates: [], reason: 'x' },
        },
        candidates: [],
      }),
      facebookImpl: async () => ({
        ok: false,
        candidates: [],
        reason: 'no FB token',
      }),
      now: () => '2026-05-06T22:00:00.000Z',
    });
    expect(result.candidates).toEqual([]);
    expect(result.sources.gscOrphans.ok).toBe(false);
    expect(result.sources.googleTrendsIt.ok).toBe(false);
    expect(result.sources.facebookPages.ok).toBe(false);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, 'utf-8'));
    expect(parsed.candidates).toEqual([]);
  });

  it('produces deterministic output across two runs with same mocks', async () => {
    const out1 = tempPath('determ-1.json');
    const out2 = tempPath('determ-2.json');
    cleanupPaths.push(out1, out2);

    const mocks = () => ({
      gscOrphansImpl: async () => ({
        ok: true,
        candidates: [
          {
            id: 'aaaaaaaa',
            keyword: 'kw a',
            normalizedKeyword: 'kw a',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 200 },
          },
          {
            id: 'bbbbbbbb',
            keyword: 'kw b',
            normalizedKeyword: 'kw b',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 100 },
          },
        ],
      }),
      googleTrendsImpl: async () => ({
        ok: true,
        perGeo: {
          googleTrendsIt: {
            ok: true,
            candidates: [
              {
                id: 'cccccccc',
                keyword: 'kw a',
                normalizedKeyword: 'kw a',
                sources: ['googleTrendsIt'],
                demandSignals: { googleTrendsScore: 80 },
              },
            ],
          },
          googleTrendsItLombardia: { ok: false, candidates: [] },
          googleTrendsCh: { ok: false, candidates: [] },
        },
        candidates: [
          {
            id: 'cccccccc',
            keyword: 'kw a',
            normalizedKeyword: 'kw a',
            sources: ['googleTrendsIt'],
            demandSignals: { googleTrendsScore: 80 },
          },
        ],
      }),
      redditImpl: async () => ({ ok: false, candidates: [] }),
      facebookImpl: async () => ({ ok: false, candidates: [] }),
      now: () => '2026-05-06T22:00:00.000Z',
    });

    await mineTopicCandidates({ outputPath: out1, ...mocks() });
    await mineTopicCandidates({ outputPath: out2, ...mocks() });

    expect(readFileSync(out1, 'utf-8')).toBe(readFileSync(out2, 'utf-8'));
    const parsed = JSON.parse(readFileSync(out1, 'utf-8'));
    // 'kw a' is in gscOrphans + googleTrendsIt → boosted, comes first.
    expect(parsed.candidates[0].normalizedKeyword).toBe('kw a');
    expect(parsed.candidates[0].sources).toEqual(
      expect.arrayContaining(['gscOrphans', 'googleTrendsIt']),
    );
  });

  it('drops candidates with novelty < 0.3', async () => {
    const out = tempPath('novelty-drop.json');
    cleanupPaths.push(out);
    // Set up a temp blog-meta file with a single title.
    const metaPath = tempPath('blog-meta.ts');
    cleanupPaths.push(metaPath);
    writeFileSync(
      metaPath,
      "'blog.article.foo.title': 'Telelavoro frontalieri 25 percento guida',\n",
    );
    const result = await mineTopicCandidates({
      outputPath: out,
      blogMetaPath: metaPath,
      articlePerformancePath: '/nope.json',
      gscOrphansImpl: async () => ({
        ok: true,
        candidates: [
          {
            id: 'dup',
            keyword: 'Telelavoro frontalieri 25 percento guida',
            normalizedKeyword: 'telelavoro frontalieri 25 percento guida',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 999 },
          },
          {
            id: 'novel',
            keyword: 'argomento del tutto nuovo da coprire',
            normalizedKeyword: 'argomento del tutto nuovo da coprire',
            sources: ['gscOrphans'],
            demandSignals: { gscImpressions: 50 },
          },
        ],
      }),
      googleTrendsImpl: async () => ({ ok: false, perGeo: {}, candidates: [] }),
      redditImpl: async () => ({ ok: false, candidates: [] }),
      facebookImpl: async () => ({ ok: false, candidates: [] }),
      now: () => '2026-05-06T22:00:00.000Z',
    });
    expect(
      result.candidates.find((c: any) => c.id === 'dup'),
    ).toBeUndefined();
    expect(
      result.candidates.find(
        (c: any) => c.normalizedKeyword === 'argomento del tutto nuovo da coprire',
      ),
    ).toBeTruthy();
  });
});
