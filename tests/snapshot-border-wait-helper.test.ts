/**
 * Tests for the `snapshotBorderWaitFiles` helper extracted from
 * `scripts/snapshot-border-wait-history.mjs`. The helper is the shared core
 * used both by the daily CLI and by the live traffic collector
 * (`scripts/collect-traffic.mjs`) so that on-disk JSON stays as fresh as
 * the Firestore writes.
 *
 * We mock the Firestore client to return a deterministic set of crossings
 * and snapshots, run the helper against a temporary repoRoot, and assert
 * the on-disk shape is exactly what the static SEO build expects.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotBorderWaitFiles } from '../scripts/snapshot-border-wait-history.mjs';

interface CurrentDocData {
  waitTimeMinutes: number;
  approachMinutes: number | null;
  totalCrossingMinutes: number | null;
  status: 'green' | 'amber' | 'red' | null;
  source: string;
  lastUpdate: { toDate: () => Date };
}

interface HistorySnapshotData {
  hour: number;
  waitTimeMinutes: number;
}

/**
 * Minimal stand-in for the firestore client surface that
 * `snapshotBorderWaitFiles` uses. Only the methods/fields actually exercised
 * by the helper are implemented.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMockDb(opts: {
  current: Record<string, CurrentDocData>;
  history: Record<string, Record<string, HistorySnapshotData>>;
}): any {
  const collection = (name: string) => {
    if (name === 'trafficCurrent') {
      return {
        get: async () => ({
          forEach: (cb: (doc: { id: string; data: () => CurrentDocData }) => void) => {
            for (const [id, data] of Object.entries(opts.current)) {
              cb({ id, data: () => data });
            }
          },
        }),
      };
    }
    if (name === 'trafficHistory') {
      return {
        doc: (slug: string) => ({
          collection: (sub: string) => {
            if (sub !== 'snapshots') throw new Error(`unexpected subcollection ${sub}`);
            const snapshots = opts.history[slug] ?? {};
            return {
              where: () => ({
                where: () => ({
                  get: async () => ({
                    forEach: (cb: (doc: { id: string; data: () => HistorySnapshotData }) => void) => {
                      for (const [id, data] of Object.entries(snapshots)) {
                        cb({ id, data: () => data });
                      }
                    },
                  }),
                }),
              }),
            };
          },
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };

  return { collection };
}

describe('snapshotBorderWaitFiles', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'border-wait-helper-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes border-wait-current.json with the documented shape', async () => {
    const lastUpdate = new Date('2026-04-29T07:00:00.000Z');
    const db = buildMockDb({
      current: {
        'chiasso-brogeda': {
          waitTimeMinutes: 12,
          approachMinutes: 3,
          totalCrossingMinutes: 15,
          status: 'amber',
          source: 'tomtom',
          lastUpdate: { toDate: () => lastUpdate },
        },
      },
      history: {},
    });

    const result = await snapshotBorderWaitFiles(db, {
      repoRoot: tmpRoot,
      today: '2026-04-29',
      prune: false,
    });

    expect(result.slugs).toEqual(['chiasso-brogeda']);
    expect(result.currentPath).toBe(path.join(tmpRoot, 'data', 'border-wait-current.json'));

    const current = JSON.parse(fs.readFileSync(result.currentPath, 'utf-8'));
    expect(current.updatedAt).toBe(lastUpdate.toISOString());
    expect(current.perCrossing['chiasso-brogeda']).toMatchObject({
      waitTimeMinutes: 12,
      approachMinutes: 3,
      totalCrossingMinutes: 15,
      status: 'amber',
      source: 'tomtom',
      lastUpdate: lastUpdate.toISOString(),
    });
  });

  it('writes today\'s history file with 24 hour buckets per crossing', async () => {
    const db = buildMockDb({
      current: {
        'chiasso-brogeda': {
          waitTimeMinutes: 5,
          approachMinutes: null,
          totalCrossingMinutes: null,
          status: 'green',
          source: 'tomtom',
          lastUpdate: { toDate: () => new Date('2026-04-29T07:00:00.000Z') },
        },
      },
      history: {
        'chiasso-brogeda': {
          // Two samples in hour 7 → avg should be 30
          '1': { hour: 7, waitTimeMinutes: 20 },
          '2': { hour: 7, waitTimeMinutes: 40 },
          '3': { hour: 9, waitTimeMinutes: 10 },
        },
      },
    });

    const result = await snapshotBorderWaitFiles(db, {
      repoRoot: tmpRoot,
      today: '2026-04-29',
      prune: false,
    });

    expect(result.dayFile).toBe(
      path.join(tmpRoot, 'data', 'border-wait-history', '2026-04-29.json'),
    );

    const day = JSON.parse(fs.readFileSync(result.dayFile, 'utf-8'));
    expect(day.date).toBe('2026-04-29');
    const buckets = day.perCrossing['chiasso-brogeda'];
    expect(Array.isArray(buckets)).toBe(true);
    expect(buckets).toHaveLength(24);
    expect(buckets[7]).toEqual({ min: 20, avg: 30, max: 40, samples: 2 });
    expect(buckets[9]).toEqual({ min: 10, avg: 10, max: 10, samples: 1 });
    expect(buckets[0]).toBeNull();
    expect(buckets[23]).toBeNull();
  });

  it('prune option removes history files older than the retention window', async () => {
    const db = buildMockDb({ current: {}, history: {} });
    const historyDir = path.join(tmpRoot, 'data', 'border-wait-history');
    fs.mkdirSync(historyDir, { recursive: true });
    // 200 days ago → should be pruned at default 90d retention.
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const oldFile = path.join(historyDir, `${oldDate}.json`);
    fs.writeFileSync(oldFile, '{}', 'utf-8');

    await snapshotBorderWaitFiles(db, {
      repoRoot: tmpRoot,
      today: '2026-04-29',
      // prune defaults to true (90 days); explicit for clarity
      prune: true,
    });

    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('prune: false keeps stale history files in place', async () => {
    const db = buildMockDb({ current: {}, history: {} });
    const historyDir = path.join(tmpRoot, 'data', 'border-wait-history');
    fs.mkdirSync(historyDir, { recursive: true });
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const oldFile = path.join(historyDir, `${oldDate}.json`);
    fs.writeFileSync(oldFile, '{}', 'utf-8');

    await snapshotBorderWaitFiles(db, {
      repoRoot: tmpRoot,
      today: '2026-04-29',
      prune: false,
    });

    expect(fs.existsSync(oldFile)).toBe(true);
  });
});
