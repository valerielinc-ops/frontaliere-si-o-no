import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { reconcileHotPaths } from '../scripts/build-cf-hot-404s.mjs';

/**
 * Retention invariants for the cf-hot-404 accumulator (build-cf-hot-404s.mjs):
 *   - fresh swept paths are added with today's lastSeen,
 *   - re-seen paths refresh lastSeen and keep the MAX hits ever,
 *   - paths not seen for > staleDays age out (converged → bridge not load-bearing),
 *   - pre-age-out entries (no lastSeen) are graced to today (no mass-eviction),
 *   - when over the cap, the LEAST-recently-seen are evicted first (a stale
 *     once-hot path never displaces a fresh actively-hit orphan).
 */
const acceptAll = () => true;
const TODAY = '2026-06-22';
const daysAgo = (n: number): string =>
  new Date(Date.parse(TODAY) - n * 86400000).toISOString().slice(0, 10);

describe('reconcileHotPaths', () => {
  it('adds fresh swept paths with today lastSeen and keeps max hits', () => {
    const out = reconcileHotPaths({
      existing: [{ path: '/cerca-lavoro-berna/role-a', hits: 5, lastSeen: daysAgo(1) }],
      sweptRows: [
        { path: '/cerca-lavoro-berna/role-a', count: 9 }, // re-seen, higher hits
        { path: '/cerca-lavoro-zurigo/role-b', count: 3 }, // fresh
      ],
      cap: 100,
      minHits: 2,
      staleDays: 120,
      todayStr: TODAY,
      isHotCandidate: acceptAll,
    });
    expect(out.fresh).toBe(1);
    const a = out.paths.find((p: { path: string }) => p.path === '/cerca-lavoro-berna/role-a');
    expect(a.hits).toBe(9); // max ever
    expect(a.lastSeen).toBe(TODAY); // refreshed
    const b = out.paths.find((p: { path: string }) => p.path === '/cerca-lavoro-zurigo/role-b');
    expect(b.lastSeen).toBe(TODAY);
  });

  it('drops one-hit noise below minHits', () => {
    const out = reconcileHotPaths({
      existing: [],
      sweptRows: [{ path: '/cerca-lavoro-berna/probe', count: 1 }],
      cap: 100,
      minHits: 2,
      staleDays: 120,
      todayStr: TODAY,
      isHotCandidate: acceptAll,
    });
    expect(out.paths).toHaveLength(0);
  });

  it('ages out a path not seen for longer than staleDays', () => {
    const out = reconcileHotPaths({
      existing: [
        { path: '/cerca-lavoro-berna/converged', hits: 50, lastSeen: daysAgo(200) },
        { path: '/cerca-lavoro-berna/active', hits: 4, lastSeen: daysAgo(10) },
      ],
      sweptRows: [],
      cap: 100,
      minHits: 2,
      staleDays: 120,
      todayStr: TODAY,
      isHotCandidate: acceptAll,
    });
    expect(out.agedOut).toBe(1);
    expect(out.paths.map((p: { path: string }) => p.path)).toEqual(['/cerca-lavoro-berna/active']);
  });

  it('graces pre-age-out entries (missing lastSeen) to today — no mass-eviction', () => {
    const out = reconcileHotPaths({
      existing: [{ path: '/cerca-lavoro-berna/legacy', hits: 7 }], // no lastSeen
      sweptRows: [],
      cap: 100,
      minHits: 2,
      staleDays: 120,
      todayStr: TODAY,
      isHotCandidate: acceptAll,
    });
    expect(out.agedOut).toBe(0);
    expect(out.paths[0].lastSeen).toBe(TODAY);
  });

  it('evicts the LEAST-recently-seen first when over the cap (recency beats hits)', () => {
    const out = reconcileHotPaths({
      existing: [
        { path: '/cerca-lavoro-berna/stale-hot', hits: 999, lastSeen: daysAgo(40) },
        { path: '/cerca-lavoro-berna/fresh-cold', hits: 3, lastSeen: daysAgo(1) },
      ],
      sweptRows: [],
      cap: 1, // force the cap to bite
      minHits: 2,
      staleDays: 120,
      todayStr: TODAY,
      isHotCandidate: acceptAll,
    });
    expect(out.paths).toHaveLength(1);
    // The fresh (recently-seen) path survives even though it has far fewer hits.
    expect(out.paths[0].path).toBe('/cerca-lavoro-berna/fresh-cold');
  });

  it('emits in hits-descending order for bridge recovery priority', () => {
    const out = reconcileHotPaths({
      existing: [],
      sweptRows: [
        { path: '/cerca-lavoro-berna/low', count: 3 },
        { path: '/cerca-lavoro-berna/high', count: 90 },
        { path: '/cerca-lavoro-berna/mid', count: 20 },
      ],
      cap: 100,
      minHits: 2,
      staleDays: 120,
      todayStr: TODAY,
      isHotCandidate: acceptAll,
    });
    expect(out.paths.map((p: { path: string }) => p.path)).toEqual([
      '/cerca-lavoro-berna/high',
      '/cerca-lavoro-berna/mid',
      '/cerca-lavoro-berna/low',
    ]);
  });

  it('respects isHotCandidate filtering of both existing and swept paths', () => {
    const out = reconcileHotPaths({
      existing: [{ path: '/assets/old.js', hits: 9, lastSeen: TODAY }],
      sweptRows: [{ path: '/wp-admin/probe', count: 5 }],
      cap: 100,
      minHits: 2,
      staleDays: 120,
      todayStr: TODAY,
      isHotCandidate: (p: string) => p.startsWith('/cerca-lavoro-'),
    });
    expect(out.paths).toHaveLength(0);
  });
});
