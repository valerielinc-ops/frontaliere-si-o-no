/**
 * Unit tests for the canton geo-filter wiring in `services/jobAlertService.ts`.
 *
 * Covers:
 *  - `normalizeCantonFilter` happy paths + edge cases (null/empty/dedupe/sort).
 *  - `createAlert` persists the normalised filter to Firestore for the
 *    three canonical scenarios required by the PR:
 *      • TI alone               → cantonFilter: ['TI']
 *      • TI + GE multi          → cantonFilter: ['GE', 'TI']  (sorted)
 *      • all-cantons default    → cantonFilter: null
 *  - Legacy subscribers (Firestore docs without a `cantonFilter` field) are
 *    surfaced as `null` by `getUserAlerts` so old data keeps working.
 *  - `updateAlert` flips the filter on/off via the same `null`-sentinel.
 *
 * Mocks the bare Firestore primitives the service imports and inspects the
 * argument that `addDoc` / `updateDoc` was called with.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const addDocMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({
  id: 'alert-id',
}));
const setDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const updateDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const getDocsMock = vi.fn<(...args: unknown[]) => Promise<{ size: number; docs: unknown[] }>>(
  async () => ({ size: 0, docs: [] }),
);

vi.mock('firebase/firestore', () => ({
  collectionGroup: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  addDoc: (...args: unknown[]) => addDocMock(...args),
  doc: vi.fn(() => ({})),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
  query: vi.fn(() => ({})),
  where: vi.fn(() => ({})),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  orderBy: vi.fn(() => ({})),
  serverTimestamp: vi.fn(() => new Date()),
  getFirestore: vi.fn(() => ({})),
}));

import {
  createAlert,
  getUserAlerts,
  normalizeCantonFilter,
  updateAlert,
} from '@/services/jobAlertService';

beforeEach(() => {
  addDocMock.mockClear();
  setDocMock.mockClear();
  updateDocMock.mockClear();
  getDocsMock.mockClear();
  getDocsMock.mockResolvedValue({ size: 0, docs: [] });
});

describe('normalizeCantonFilter', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(normalizeCantonFilter(null)).toBeNull();
    expect(normalizeCantonFilter(undefined)).toBeNull();
    expect(normalizeCantonFilter([])).toBeNull();
  });

  it('returns null when every entry is blank after trimming', () => {
    expect(normalizeCantonFilter(['', '   ', '\t'])).toBeNull();
  });

  it('uppercases and trims canton codes', () => {
    expect(normalizeCantonFilter(['ti', ' ge ', 'Vs'])).toEqual(['GE', 'TI', 'VS']);
  });

  it('dedupes case-insensitively', () => {
    expect(normalizeCantonFilter(['TI', 'ti', 'Ti', 'GE'])).toEqual(['GE', 'TI']);
  });

  it('sorts the output deterministically', () => {
    expect(normalizeCantonFilter(['ZH', 'GE', 'TI', 'BE'])).toEqual(['BE', 'GE', 'TI', 'ZH']);
  });

  it('drops non-string entries defensively', () => {
    // The service is typed to `string[]`, but Firestore reads are `unknown` —
    // the helper must survive a malformed payload.
    const malformed = ['TI', 42 as unknown as string, null as unknown as string, 'GE'];
    expect(normalizeCantonFilter(malformed)).toEqual(['GE', 'TI']);
  });
});

describe('createAlert — cantonFilter persistence', () => {
  const baseConfig = {
    keywords: ['developer'],
    locations: [],
    contractTypes: [],
    sectors: [],
    frequency: 'weekly' as const,
    locale: 'it' as const,
  };

  it('writes a single-canton filter (TI alone)', async () => {
    await createAlert('u1', 'a@b.com', { ...baseConfig, cantonFilter: ['TI'] });
    const payload = (addDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toEqual(['TI']);
  });

  it('writes a sorted multi-canton filter (TI + GE → [GE, TI])', async () => {
    await createAlert('u1', 'a@b.com', { ...baseConfig, cantonFilter: ['TI', 'GE'] });
    const payload = (addDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toEqual(['GE', 'TI']);
  });

  it('writes null when cantonFilter is omitted (all-cantons default)', async () => {
    await createAlert('u1', 'a@b.com', { ...baseConfig });
    const payload = (addDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toBeNull();
  });

  it('writes null when cantonFilter is an empty array', async () => {
    await createAlert('u1', 'a@b.com', { ...baseConfig, cantonFilter: [] });
    const payload = (addDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toBeNull();
  });

  it('writes null when cantonFilter is explicitly null', async () => {
    await createAlert('u1', 'a@b.com', { ...baseConfig, cantonFilter: null });
    const payload = (addDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toBeNull();
  });

  it('returns the normalised cantonFilter on the resolved alert', async () => {
    const alert = await createAlert('u1', 'a@b.com', {
      ...baseConfig,
      cantonFilter: ['ti', 'ge'],
    });
    expect(alert.cantonFilter).toEqual(['GE', 'TI']);
  });
});

describe('getUserAlerts — backward-compat for legacy subscribers', () => {
  function fakeSnapshot(docs: Array<Record<string, unknown>>) {
    return {
      docs: docs.map((data, i) => ({
        id: `alert-${i}`,
        data: () => data,
        ref: { parent: { parent: { id: data.email || 'parent@example.com' } } },
      })),
    };
  }

  it('surfaces missing cantonFilter as null (legacy doc)', async () => {
    getDocsMock.mockResolvedValueOnce(
      fakeSnapshot([
        {
          email: 'a@b.com',
          userId: 'u1',
          keywords: ['dev'],
          locations: [],
          contractTypes: [],
          sectors: [],
          frequency: 'weekly',
          locale: 'it',
          active: true,
          createdAt: { toDate: () => new Date('2025-01-01') },
          lastMatchedAt: null,
          matchCount: 0,
          // cantonFilter intentionally absent — written by old client.
        },
      ]) as unknown as { size: number; docs: unknown[] },
    );

    const alerts = await getUserAlerts('u1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].cantonFilter).toBeNull();
  });

  it('round-trips a stored multi-canton filter', async () => {
    getDocsMock.mockResolvedValueOnce(
      fakeSnapshot([
        {
          email: 'a@b.com',
          userId: 'u1',
          keywords: [],
          locations: [],
          contractTypes: [],
          sectors: [],
          cantonFilter: ['GE', 'TI'],
          frequency: 'daily',
          locale: 'it',
          active: true,
          createdAt: { toDate: () => new Date() },
          lastMatchedAt: null,
          matchCount: 0,
        },
      ]) as unknown as { size: number; docs: unknown[] },
    );

    const alerts = await getUserAlerts('u1');
    expect(alerts[0].cantonFilter).toEqual(['GE', 'TI']);
  });

  it('re-normalises a malformed stored filter (defensive read path)', async () => {
    getDocsMock.mockResolvedValueOnce(
      fakeSnapshot([
        {
          email: 'a@b.com',
          userId: 'u1',
          keywords: [],
          locations: [],
          contractTypes: [],
          sectors: [],
          // Mixed-case + duplicates as could happen if a legacy client wrote
          // un-normalised data before this PR landed.
          cantonFilter: ['ti', 'TI', 'ge'],
          frequency: 'daily',
          locale: 'it',
          active: true,
          createdAt: { toDate: () => new Date() },
          lastMatchedAt: null,
          matchCount: 0,
        },
      ]) as unknown as { size: number; docs: unknown[] },
    );

    const alerts = await getUserAlerts('u1');
    expect(alerts[0].cantonFilter).toEqual(['GE', 'TI']);
  });
});

describe('updateAlert — cantonFilter toggling', () => {
  it('sets a new canton filter when one is provided', async () => {
    await updateAlert('a@b.com', 'alert-1', { cantonFilter: ['ZH'] });
    const payload = (updateDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toEqual(['ZH']);
  });

  it('clears the canton filter to null when an empty array is passed', async () => {
    await updateAlert('a@b.com', 'alert-1', { cantonFilter: [] });
    const payload = (updateDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toBeNull();
  });

  it('clears the canton filter to null when null is passed explicitly', async () => {
    await updateAlert('a@b.com', 'alert-1', { cantonFilter: null });
    const payload = (updateDocMock.mock.calls[0] as unknown[])[1] as { cantonFilter: unknown };
    expect(payload.cantonFilter).toBeNull();
  });

  it('does not touch cantonFilter when the key is absent from the patch', async () => {
    await updateAlert('a@b.com', 'alert-1', { frequency: 'daily' });
    const payload = (updateDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('cantonFilter');
    expect(payload.frequency).toBe('daily');
  });
});
