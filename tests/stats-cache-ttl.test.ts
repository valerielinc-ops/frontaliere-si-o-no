import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => ({
  getDoc: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: firestore.getDoc,
}));

vi.mock('@/services/firebase', () => ({
  getApp: vi.fn(async () => ({})),
}));

type StorageState = {
  values: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

const storage: StorageState = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, value); },
  removeItem(key) { this.values.delete(key); },
  clear() { this.values.clear(); },
};

const VALID_DATA = {
  trend: [{ year: '2026-Q1', frontalieri: 100 }],
  ages: [{ name: '25-29', value: 20 }],
  genderTrend: [{ year: '2026-Q1', Uomini: 60, Donne: 40 }],
  genderSnapshot: [{ name: 'Uomini', value: 60, pct: '60.0', color: '#3b82f6' }],
  lastUpdated: '2026-10-26T00:00:00.000Z',
};

const LOCAL_CACHE_KEY = 'bfs_stats_cache_v2';
const NOW = 1_800_000_000_000;

function cachePayload(overrides: Record<string, unknown> = {}) {
  return { ...VALID_DATA, timestamp: NOW, ...overrides };
}

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', storage);
  firestore.getDoc.mockReset();
  firestore.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

import {
  STATS_CACHE_DURATION_MS,
  fetchStats,
  validateStatsCachePayload,
  validateStatsCacheTimestamp,
  validateStatsData,
} from '../services/statsService';

describe('statsService cache TTL', () => {
  it('uses a 1-hour cache window for BFS/UST stats', () => {
    expect(STATS_CACHE_DURATION_MS).toBe(60 * 60 * 1000);
  });
});

describe('statsService runtime cache validation', () => {
  it('filters malformed points while preserving valid points and fields', () => {
    const result = validateStatsData({
      ...VALID_DATA,
      trend: [
        ...VALID_DATA.trend,
        { year: '2026-Q2', frontalieri: Number.NaN },
        { year: 2026, frontalieri: 101 },
      ],
      ages: [...VALID_DATA.ages, { name: '30-34', value: Infinity }],
      genderTrend: [...VALID_DATA.genderTrend, { year: '2026-Q2', Uomini: '61', Donne: 41 }],
      genderSnapshot: [...VALID_DATA.genderSnapshot, { name: 'Donne', value: 40, pct: 40, color: '#ec4899' }],
    });

    expect(result).toEqual(VALID_DATA);
  });

  it('rejects missing collections, invalid metadata, and a trend emptied by filtering', () => {
    expect(validateStatsData({ ...VALID_DATA, ages: undefined })).toBeNull();
    expect(validateStatsData({ ...VALID_DATA, lastUpdated: 123 })).toBeNull();
    expect(validateStatsData({ ...VALID_DATA, lastUpdated: 'not-a-date' })).toBeNull();
    expect(validateStatsData({ ...VALID_DATA, trend: [{ year: '2026-Q1', frontalieri: Infinity }] })).toBeNull();
  });

  it('accepts finite numeric cache timestamps and Firestore Timestamp values only', () => {
    expect(validateStatsCacheTimestamp(NOW)).toBe(NOW);
    expect(validateStatsCacheTimestamp({ toMillis: () => NOW })).toBe(NOW);
    expect(validateStatsCacheTimestamp('1800000000000')).toBeNull();
    expect(validateStatsCacheTimestamp(Number.NaN)).toBeNull();
    expect(validateStatsCacheTimestamp(Infinity)).toBeNull();
    expect(validateStatsCacheTimestamp(-1)).toBeNull();
  });

  it('rejects a malformed envelope instead of letting invalid points reach consumers', () => {
    expect(validateStatsCachePayload(cachePayload({ timestamp: 'bad' }))).toBeNull();
    expect(validateStatsCachePayload(cachePayload({ genderTrend: undefined }))).toBeNull();
  });

  it('ignores malformed localStorage payloads', async () => {
    storage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cachePayload({ ages: undefined })));

    await expect(fetchStats()).resolves.toEqual({
      data: null,
      source: 'error',
      error: 'No data available',
    });
    expect(firestore.getDoc).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed Firestore payloads', async () => {
    firestore.getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => cachePayload({ timestamp: { toMillis: () => Number.NaN } }),
    });

    await expect(fetchStats()).resolves.toEqual({
      data: null,
      source: 'error',
      error: 'No data available',
    });
  });

  it('keeps valid local cache data on the existing one-hour fast path', async () => {
    storage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cachePayload({
      trend: [...VALID_DATA.trend, { year: '2026-Q2', frontalieri: '101' }],
    })));

    await expect(fetchStats()).resolves.toMatchObject({
      source: 'cache',
      data: VALID_DATA,
    });
    expect(firestore.getDoc).not.toHaveBeenCalled();
  });
});
