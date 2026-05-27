// tests/scripts/lib/scheduler/winnerEvaluator.test.ts
//
// Spec § 7.3 acceptance:
//  - winners counted per pool ('proven' vs 'discovery')
//  - articles outside [14, 30] day window are skipped
//  - articles missing GA4 data are skipped (counted in 'skipped.noGa4')
//  - articles without `_pool` (e.g. evergreen-fallback) are skipped
//  - cold start (no sidecar dir) returns zeros without throwing

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  evaluateWinners,
  loadAllPublishedArticleMetas,
  slugToGa4Path,
} from '../../../../scripts/lib/scheduler/winnerEvaluator.mjs';

const NOW = new Date('2026-05-07T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let blogDir: string;

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function writeSidecar(name: string, sidecar: object) {
  writeFileSync(join(blogDir, `${name}.json`), JSON.stringify(sidecar, null, 2), 'utf-8');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'winner-eval-'));
  blogDir = join(tmpRoot, 'blog-articles');
  mkdirSync(blogDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('slugToGa4Path', () => {
  it('produces /articoli-frontaliere/<slug>/ with trailing slash', () => {
    expect(slugToGa4Path('frontalieri-2026')).toBe('/articoli-frontaliere/frontalieri-2026/');
  });

  it('strips leading and trailing slashes from the slug', () => {
    expect(slugToGa4Path('/frontalieri-2026/')).toBe('/articoli-frontaliere/frontalieri-2026/');
  });

  it('returns null for empty/invalid slugs', () => {
    expect(slugToGa4Path('')).toBeNull();
    expect(slugToGa4Path(null as unknown as string)).toBeNull();
    expect(slugToGa4Path(undefined as unknown as string)).toBeNull();
  });
});

describe('loadAllPublishedArticleMetas', () => {
  it('returns dirExists=false when the directory is missing', () => {
    const { articles, dirExists } = loadAllPublishedArticleMetas(join(tmpRoot, 'nope'));
    expect(dirExists).toBe(false);
    expect(articles).toEqual([]);
  });

  it('parses every json file and counts malformed ones', () => {
    writeSidecar('a', { slug: 'a', publishedAt: isoDaysAgo(20) });
    writeSidecar('b', { slug: 'b', publishedAt: isoDaysAgo(15) });
    writeFileSync(join(blogDir, 'broken.json'), '{not json', 'utf-8');
    writeFileSync(join(blogDir, 'note.txt'), 'ignored', 'utf-8');
    const { articles, malformed, dirExists } = loadAllPublishedArticleMetas(blogDir);
    expect(dirExists).toBe(true);
    expect(articles).toHaveLength(2);
    expect(malformed).toBe(1);
  });
});

describe('evaluateWinners', () => {
  it('cold-start: no sidecar dir → zeros, no throw', () => {
    const stats = evaluateWinners(
      { ga4: { pages: {} }, clusterStats: {} },
      { blogArticlesDir: join(tmpRoot, 'missing'), now: NOW },
    );
    expect(stats.proven).toEqual({ winners: 0, total: 0 });
    expect(stats.discovery).toEqual({ winners: 0, total: 0 });
    expect(stats.skipped.noSidecarDir).toBe(true);
  });

  it('cold-start: empty dir → zeros, dirExists=true', () => {
    const stats = evaluateWinners(
      { ga4: { pages: {} }, clusterStats: {} },
      { blogArticlesDir: blogDir, now: NOW },
    );
    expect(stats.proven.total).toBe(0);
    expect(stats.discovery.total).toBe(0);
    expect(stats.skipped.noSidecarDir).toBe(false);
  });

  it('counts proven and discovery winners separately', () => {
    // proven winner: sessions 200 > p50 100
    writeSidecar('p1', {
      slug: 'p1',
      publishedAt: isoDaysAgo(20),
      cluster: 'fisco',
      _pool: 'proven',
    });
    // proven loser
    writeSidecar('p2', {
      slug: 'p2',
      publishedAt: isoDaysAgo(20),
      cluster: 'fisco',
      _pool: 'proven',
    });
    // discovery winner
    writeSidecar('d1', {
      slug: 'd1',
      publishedAt: isoDaysAgo(18),
      cluster: 'fisco',
      _pool: 'discovery',
    });

    const evidence = {
      ga4: {
        pages: {
          '/articoli-frontaliere/p1/': { sessions: 200 },
          '/articoli-frontaliere/p2/': { sessions: 50 },
          '/articoli-frontaliere/d1/': { sessions: 250 },
        },
      },
      clusterStats: { fisco: { p50: 100 } },
    };

    const stats = evaluateWinners(evidence, { blogArticlesDir: blogDir, now: NOW });
    expect(stats.proven).toEqual({ winners: 1, total: 2 });
    expect(stats.discovery).toEqual({ winners: 1, total: 1 });
    expect(stats.perCluster.fisco).toEqual({ winners: 2, total: 3 });
  });

  it('skips articles outside the 14-30 day window', () => {
    writeSidecar('young', {
      slug: 'young',
      publishedAt: isoDaysAgo(7),
      cluster: 'fisco',
      _pool: 'proven',
    });
    writeSidecar('old', {
      slug: 'old',
      publishedAt: isoDaysAgo(60),
      cluster: 'fisco',
      _pool: 'proven',
    });
    const evidence = {
      ga4: {
        pages: {
          '/articoli-frontaliere/young/': { sessions: 999 },
          '/articoli-frontaliere/old/': { sessions: 999 },
        },
      },
      clusterStats: { fisco: { p50: 50 } },
    };
    const stats = evaluateWinners(evidence, { blogArticlesDir: blogDir, now: NOW });
    expect(stats.proven.total).toBe(0);
    expect(stats.skipped.outOfWindow).toBe(2);
  });

  it('skips articles missing from GA4 evidence (counted in skipped.noGa4)', () => {
    writeSidecar('orphan', {
      slug: 'orphan',
      publishedAt: isoDaysAgo(20),
      cluster: 'fisco',
      _pool: 'proven',
    });
    const stats = evaluateWinners(
      { ga4: { pages: {} }, clusterStats: { fisco: { p50: 50 } } },
      { blogArticlesDir: blogDir, now: NOW },
    );
    expect(stats.proven).toEqual({ winners: 0, total: 0 });
    expect(stats.skipped.noGa4).toBe(1);
  });

  it('skips articles with non-proven/non-discovery pool tag', () => {
    writeSidecar('e1', {
      slug: 'e1',
      publishedAt: isoDaysAgo(20),
      cluster: 'fisco',
      _pool: 'evergreen-fallback',
    });
    writeSidecar('miss', {
      slug: 'miss',
      publishedAt: isoDaysAgo(20),
      cluster: 'fisco',
      // no _pool field at all
    });
    const evidence = {
      ga4: {
        pages: {
          '/articoli-frontaliere/e1/': { sessions: 999 },
          '/articoli-frontaliere/miss/': { sessions: 999 },
        },
      },
      clusterStats: { fisco: { p50: 50 } },
    };
    const stats = evaluateWinners(evidence, { blogArticlesDir: blogDir, now: NOW });
    expect(stats.proven.total).toBe(0);
    expect(stats.discovery.total).toBe(0);
    expect(stats.skipped.noPool).toBe(2);
  });

  it('falls back to default p50=100 when cluster stats absent', () => {
    writeSidecar('p1', {
      slug: 'p1',
      publishedAt: isoDaysAgo(20),
      cluster: 'unknown-cluster',
      _pool: 'proven',
    });
    const evidence = {
      ga4: { pages: { '/articoli-frontaliere/p1/': { sessions: 150 } } },
      clusterStats: {},
    };
    const stats = evaluateWinners(evidence, { blogArticlesDir: blogDir, now: NOW });
    expect(stats.proven).toEqual({ winners: 1, total: 1 }); // 150 > default 100
  });

  it('treats null cluster as "generic"', () => {
    writeSidecar('g1', {
      slug: 'g1',
      publishedAt: isoDaysAgo(20),
      cluster: null,
      _pool: 'proven',
    });
    const evidence = {
      ga4: { pages: { '/articoli-frontaliere/g1/': { sessions: 999 } } },
      clusterStats: { generic: { p50: 50 } },
    };
    const stats = evaluateWinners(evidence, { blogArticlesDir: blogDir, now: NOW });
    expect(stats.proven.winners).toBe(1);
    expect(stats.perCluster.generic).toEqual({ winners: 1, total: 1 });
  });

  it('counts malformed sidecars without crashing', () => {
    writeFileSync(join(blogDir, 'bad.json'), 'not json at all', 'utf-8');
    writeSidecar('no-published', { slug: 'x', _pool: 'proven' });
    writeSidecar('no-slug', { publishedAt: isoDaysAgo(20), _pool: 'proven' });
    const stats = evaluateWinners(
      { ga4: { pages: {} }, clusterStats: {} },
      { blogArticlesDir: blogDir, now: NOW },
    );
    expect(stats.skipped.malformed).toBeGreaterThanOrEqual(2);
  });
});
