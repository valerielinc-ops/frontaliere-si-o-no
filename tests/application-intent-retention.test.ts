import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state: {
    docs: Map<string, Record<string, unknown>>;
    commits: number;
    queryCalls: string[];
    queryCutoffs: number[];
    deleted: string[];
  } = {
    docs: new Map(),
    commits: 0,
    queryCalls: [],
    queryCutoffs: [],
    deleted: [],
  };

  function millis(value: unknown): number | null {
    if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
      const result = (value as { toMillis: () => number }).toMillis();
      return Number.isFinite(result) ? result : null;
    }
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return null;
  }

  function timestamp(value: number) {
    return { toMillis: () => value, seconds: Math.floor(value / 1000), nanoseconds: 0 };
  }

  const db = {
    collection() {
      return {
        where(field: string, _operator: string, cutoff: { toMillis: () => number }) {
          let cursor: { millis: number | null; id: string } | null = null;
          let pageSize = Number.POSITIVE_INFINITY;
          const query = {
            orderBy() {
              return query;
            },
            startAfter(snapshot: { id: string; data: () => Record<string, unknown> }) {
              cursor = { millis: millis(snapshot.data()[field]), id: snapshot.id };
              return query;
            },
            limit(value: number) {
              pageSize = value;
              return query;
            },
            async get() {
              const cutoffMs = cutoff.toMillis();
              state.queryCutoffs.push(cutoffMs);
              const rows = [...state.docs.entries()]
                .filter(([, data]) => Object.prototype.hasOwnProperty.call(data, field))
                .filter(([, data]) => {
                  const value = millis(data[field]);
                  return value === null || value <= cutoffMs;
                })
                .sort(([leftId, left], [rightId, right]) => {
                  const leftMs = millis(left[field]) ?? Number.NEGATIVE_INFINITY;
                  const rightMs = millis(right[field]) ?? Number.NEGATIVE_INFINITY;
                  return leftMs - rightMs || leftId.localeCompare(rightId);
                });
              const startIndex = cursor
                ? rows.findIndex(([id, data]) => {
                  const rowMs = millis(data[field]) ?? Number.NEGATIVE_INFINITY;
                  return rowMs > (cursor?.millis ?? Number.NEGATIVE_INFINITY)
                    || (rowMs === (cursor?.millis ?? Number.NEGATIVE_INFINITY) && id > cursor!.id);
                })
                : 0;
              const page = rows.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + pageSize);
              state.queryCalls.push(field);
              return {
                docs: page.map(([id, data]) => ({
                  id,
                  ref: { path: `application_intents/${id}` },
                  data: () => data,
                })),
              };
            },
          };
          return query;
        },
      };
    },
    batch() {
      const deletes: Array<{ path: string }> = [];
      return {
        delete(ref: { path: string }) {
          deletes.push(ref);
        },
        async commit() {
          state.commits += 1;
          for (const ref of deletes) {
            const id = ref.path.split('/').at(-1) || '';
            state.docs.delete(id);
            state.deleted.push(id);
          }
        },
      };
    },
  };

  const firestore = Object.assign(() => db, {
    Timestamp: { fromMillis: timestamp },
  });
  return { state, firestore, timestamp };
});

vi.mock('firebase-admin', () => ({ default: { firestore: fake.firestore } }));

import {
  APPLICATION_INTENT_RETENTION_PAGE_SIZE,
  purgeExpiredApplicationIntents,
} from '../functions/src/applicationIntentRetention.js';

const DAY = 86400000;
const NOW = 1_800_000_000_000;
const OLD_CREATED_AT = NOW - 190 * DAY;
const functionsIndexSource = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');

function reset(entries: Array<[string, Record<string, unknown>]>) {
  fake.state.docs = new Map(entries);
  fake.state.commits = 0;
  fake.state.queryCalls = [];
  fake.state.queryCutoffs = [];
  fake.state.deleted = [];
}

describe('application-intent retention', () => {
  it('is wired to a daily Cloud Scheduler function', () => {
    expect(functionsIndexSource).toContain("export const purgeApplicationIntents = onSchedule(");
    expect(functionsIndexSource).toContain("schedule: 'every 24 hours'");
    expect(functionsIndexSource).toContain('purgeExpiredApplicationIntents()');
  });

  it('purges only demonstrably expired records and keeps the boundary fail-closed', async () => {
    reset([
      ['expired', { expiresAt: fake.timestamp(NOW - 1), createdAt: fake.timestamp(NOW - 100 * DAY) }],
      ['boundary', { expiresAt: fake.timestamp(NOW) }],
      ['future', { expiresAt: fake.timestamp(NOW + 1) }],
      ['legacy', { retentionUntil: fake.timestamp(NOW - 1) }],
      ['missing-expiry', { createdAt: fake.timestamp(OLD_CREATED_AT) }],
      ['invalid-expiry', { expiresAt: 'not-a-timestamp', createdAt: fake.timestamp(OLD_CREATED_AT) }],
    ]);

    const result = await purgeExpiredApplicationIntents(90, NOW, fake.firestore() as never);

    expect(result.purged).toBe(3);
    expect(result.skipped).toBe(1);
    expect(fake.state.docs.has('expired')).toBe(false);
    expect(fake.state.docs.has('boundary')).toBe(false);
    expect(fake.state.docs.has('legacy')).toBe(false);
    expect(fake.state.docs.has('future')).toBe(true);
    expect(fake.state.docs.has('missing-expiry')).toBe(true);
    expect(fake.state.docs.has('invalid-expiry')).toBe(true);
  });

  it('uses the current time as the cutoff for absolute expiry fields', async () => {
    const expiry = NOW;
    reset([['expires-at-T', { expiresAt: fake.timestamp(expiry) }]]);

    const result = await purgeExpiredApplicationIntents(90, expiry + 1, fake.firestore() as never);

    expect(fake.state.queryCutoffs).toEqual([expiry + 1, expiry + 1]);
    expect(result.purged).toBe(1);
    expect(fake.state.docs.has('expires-at-T')).toBe(false);
  });

  it('walks past one bounded page and is safe to retry', async () => {
    reset(Array.from({ length: APPLICATION_INTENT_RETENTION_PAGE_SIZE + 1 }, (_, index) => [
      `expired-${String(index).padStart(3, '0')}`,
      { expiresAt: fake.timestamp(NOW - 1) },
    ]));

    const first = await purgeExpiredApplicationIntents(90, NOW, fake.firestore() as never);
    const second = await purgeExpiredApplicationIntents(90, NOW, fake.firestore() as never);

    expect(first.purged).toBe(APPLICATION_INTENT_RETENTION_PAGE_SIZE + 1);
    expect(first.pages).toBe(2);
    expect(second.purged).toBe(0);
    expect(fake.state.docs.size).toBe(0);
    expect(fake.state.commits).toBe(2);
  });
});
