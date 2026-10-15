/**
 * Guards the precondition check that stops a dist-walking audit from turning a
 * partial `dist/` into a structural verdict about the site (issue #4857).
 *
 * The regression this pins: audit replay run 30346794790 extracted only the
 * trunk `github-pages` artifact — no locale/section shard rehydrate — so every
 * `/cerca-lavoro-svizzera/` cluster page was absent from dist/ and
 * `audit:max-bfs-depth` reported ~68k URLs as an entire content tier below
 * crawl depth. The same report showed `reached: 0` on shards 001-005, which the
 * committed baseline records as 100% reachable at depth ≤4 — the tell that the
 * input, not the site, was broken.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateDistCompleteness,
  sampleEvenly,
  DEFAULT_COMPLETENESS_TOL,
} from '../scripts/ci/assert-dist-complete.mjs';

const row = (sampled: number, missing: number, examples: string[] = []) => ({ sampled, missing, examples });

describe('evaluateDistCompleteness', () => {
  it('passes on a rehydrated dist where sampled URLs resolve to files', () => {
    const result = evaluateDistCompleteness({
      perSitemap: {
        'sitemap-search-clusters-001.xml': row(40, 0),
        'sitemap-search-clusters-006.xml': row(40, 0),
        'sitemap-jobs.xml': row(40, 0),
      },
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.missingTotal).toBe(0);
  });

  it('tolerates a stray missing page without declaring the dist incomplete', () => {
    const result = evaluateDistCompleteness({
      perSitemap: {
        'sitemap-search-clusters-001.xml': row(40, 1, ['https://frontaliereticino.ch/x/']),
        'sitemap-jobs.xml': row(40, 0),
      },
    });
    // One stale URL is a `validate:sitemap-pages` concern, not a partial dist.
    expect(result.ok).toBe(true);
    expect(result.overallMissingPct).toBeLessThan(DEFAULT_COMPLETENESS_TOL.overallMissingFailPct);
  });

  it('fails when a sharded subtree is absent (the #4857 trunk-only signature)', () => {
    const perSitemap: Record<string, ReturnType<typeof row>> = {};
    // Shards 001-006 sampled entirely missing, 007 mostly missing — exactly what
    // a trunk-only dist yields once every cluster canonicalizes under the
    // stripped /cerca-lavoro-svizzera/ section subtree.
    for (const n of ['001', '002', '003', '004', '005', '006']) {
      perSitemap[`sitemap-search-clusters-${n}.xml`] = row(40, 40, [
        `https://frontaliereticino.ch/cerca-lavoro-svizzera/ricerca-example-${n}/`,
      ]);
    }
    perSitemap['sitemap-search-clusters-007.xml'] = row(40, 39);
    perSitemap['sitemap-blog.xml'] = row(40, 0);

    const result = evaluateDistCompleteness({ perSitemap });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.name)).toContain('sitemap-search-clusters-006.xml');
    // The shard the baseline says is 100% reachable must be flagged too — that
    // contradiction is the whole point: it proves the input, not the site.
    expect(result.failures.map((f) => f.name)).toContain('sitemap-search-clusters-001.xml');
    expect(result.failures[0].missingPct).toBe(100);
    expect(result.failures[0].examples.length).toBeGreaterThan(0);
  });

  it('fails on a partial restore spread thin across many sitemaps', () => {
    const perSitemap: Record<string, ReturnType<typeof row>> = {};
    // No single sitemap crosses the 50% per-shard bar, but a whole locale
    // subtree is gone — the overall rate has to catch it.
    for (let i = 1; i <= 10; i++) {
      perSitemap[`sitemap-${i}.xml`] = row(40, 12);
    }
    const result = evaluateDistCompleteness({ perSitemap });
    expect(result.failures).toEqual([]);
    expect(result.overallMissingPct).toBe(30);
    expect(result.ok).toBe(false);
  });

  it('does not fail a tiny sitemap on a single miss', () => {
    const result = evaluateDistCompleteness({
      perSitemap: {
        'sitemap-tiny.xml': row(2, 1, ['https://frontaliereticino.ch/tiny/']),
        'sitemap-jobs.xml': row(400, 0),
      },
    });
    // 1/2 missing is 50% but below the minimum sample size, so it only feeds
    // the overall rate (1/402 ≈ 0.25%) instead of failing on its own.
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports an empty dist as incomplete rather than complete', () => {
    const result = evaluateDistCompleteness({
      perSitemap: { 'sitemap-search-clusters-001.xml': row(40, 40) },
    });
    expect(result.ok).toBe(false);
    expect(result.overallMissingPct).toBe(100);
  });
});

describe('sampleEvenly', () => {
  it('returns every item when the pool is smaller than the sample size', () => {
    expect(sampleEvenly([1, 2, 3], 40)).toEqual([1, 2, 3]);
  });

  it('spreads the sample across the whole list instead of taking a prefix', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const sample = sampleEvenly(items, 10);
    expect(sample).toHaveLength(10);
    expect(sample[0]).toBe(0);
    expect(sample.at(-1)).toBeGreaterThan(800);
  });

  it('is deterministic so a failure is reproducible from the log alone', () => {
    const items = Array.from({ length: 500 }, (_, i) => `url-${i}`);
    expect(sampleEvenly(items, 25)).toEqual(sampleEvenly(items, 25));
  });
});
