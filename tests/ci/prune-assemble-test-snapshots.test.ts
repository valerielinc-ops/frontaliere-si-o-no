import { describe, expect, it, vi } from 'vitest';
import {
  pruneAssembleTestSnapshots,
  selectCachesToPrune,
  SNAPSHOT_CACHE_PREFIX,
} from '../../scripts/ci/prune-assemble-test-snapshots.mjs';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const entry = (id: number, key: string, created: number, accessed: number) => ({
  id, key, created_at: hoursAgo(created), last_accessed_at: hoursAgo(accessed),
});
const P = SNAPSHOT_CACHE_PREFIX;
const ids = (caches: Array<{ id: number }>) => caches.map((cache) => cache.id);

describe('selectCachesToPrune', () => {
  it('deletes only snapshot caches with created_at and last_accessed_at older than 3 hours', () => {
    const doomed = selectCachesToPrune({
      now: NOW,
      currentKey: `${P}current`,
      caches: [
        entry(1, `${P}current`, 10, 10),
        entry(2, `${P}old`, 4, 4),
        entry(3, `${P}old-but-read`, 10, 1),
        entry(4, `${P}young`, 1, 1),
        entry(5, `${P}edge`, 3, 3),
        entry(6, 'assemble-jobs-Linux-abc_stats', 10, 10),
        entry(7, 'assemble-jobs-test-snapshot-macOS-x', 10, 10),
      ],
    });
    expect(ids(doomed)).toEqual([2]);
  });

  it('keeps entries with a missing or malformed timestamp and ignores malformed entries', () => {
    const doomed = selectCachesToPrune({
      now: NOW,
      caches: [
        undefined,
        { id: 1, key: `${P}a`, created_at: hoursAgo(10) },
        { id: 2, key: `${P}b`, created_at: 'nope', last_accessed_at: hoursAgo(10) },
        { id: 3, key: 7, created_at: hoursAgo(10), last_accessed_at: hoursAgo(10) },
        entry(4, `${P}c`, 10, 10),
      ],
    });
    expect(ids(doomed)).toEqual([4]);
  });

  it('keeps a key a fresh manifest still names even when it is not among the newest two', () => {
    const doomed = selectCachesToPrune({
      now: NOW,
      currentKey: `${P}c`,
      caches: [entry(1, `${P}c`, 0, 0), entry(2, `${P}b`, 0.4, 0.4), entry(3, `${P}a`, 0.9, 0.9), entry(4, `${P}z`, 5, 5)],
    });
    expect(ids(doomed)).toEqual([4]);
  });
});

describe('pruneAssembleTestSnapshots', () => {
  it('lists the main ref by prefix and deletes only the selected caches', async () => {
    const deleted: number[] = [];
    const github = {
      paginate: vi.fn(async () => [entry(1, `${P}cur`, 9, 9), entry(2, `${P}old`, 9, 9)]),
      rest: {
        actions: {
          getActionsCacheList: () => undefined,
          deleteActionsCacheById: async ({ cache_id }: { cache_id: number }) => { deleted.push(cache_id); },
        },
      },
    };
    const core = { info: vi.fn() };
    const count = await pruneAssembleTestSnapshots({
      github, core, context: { repo: { owner: 'o', repo: 'r' } }, currentKey: `${P}cur`, now: NOW,
    });
    expect(count).toBe(1);
    expect(deleted).toEqual([2]);
    expect((github.paginate.mock.calls[0] as any[])[1]).toMatchObject({ ref: 'refs/heads/main', key: P });
  });
});
