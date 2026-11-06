/**
 * Tests for services/borderWaitCurrentService.ts (issue #4892).
 *
 * fetchBorderWaitCurrent() must never throw — a network failure or malformed
 * payload must resolve to `null` so callers (BorderMunicipalitiesMap.tsx) can
 * fall back to the static field without breaking rendering. effectiveWaitMinutes()
 * must prefer totalCrossingMinutes over waitTimeMinutes, matching the same
 * priority already used by trafficService.ts's getFallbackTrafficData().
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBorderWaitCurrent,
  effectiveWaitMinutes,
  type BorderWaitCurrentSnapshot,
} from '../services/borderWaitCurrentService';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBorderWaitCurrent', () => {
  it('returns the parsed snapshot on a successful fetch', async () => {
    const snapshot: BorderWaitCurrentSnapshot = {
      updatedAt: '2026-07-28T18:54:01.740Z',
      perCrossing: {
        'chiasso-brogeda': { waitTimeMinutes: 5, totalCrossingMinutes: 8, status: 'green', source: 'here', lastUpdate: '2026-07-28T18:00:00.000Z' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => snapshot,
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await fetchBorderWaitCurrent();
    expect(result).toEqual(snapshot);
  });

  it('returns null (never throws) when the network request rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(fetchBorderWaitCurrent()).resolves.toBeNull();
  });

  it('returns null when the response is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(fetchBorderWaitCurrent()).resolves.toBeNull();
  });

  it('returns null when the payload is missing perCrossing/updatedAt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ foo: 'bar' }) });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(fetchBorderWaitCurrent()).resolves.toBeNull();
  });

  it('returns null when res.json() itself throws (malformed JSON body)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('Unexpected token'); },
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(fetchBorderWaitCurrent()).resolves.toBeNull();
  });
});

describe('effectiveWaitMinutes', () => {
  it('prefers totalCrossingMinutes over waitTimeMinutes', () => {
    expect(effectiveWaitMinutes({ waitTimeMinutes: 3, totalCrossingMinutes: 12 })).toBe(12);
  });

  it('falls back to waitTimeMinutes when totalCrossingMinutes is absent', () => {
    expect(effectiveWaitMinutes({ waitTimeMinutes: 3 })).toBe(3);
  });

  it('returns null for an undefined entry (crossing missing from the snapshot)', () => {
    expect(effectiveWaitMinutes(undefined)).toBeNull();
  });

  it('returns null when the entry has neither field', () => {
    expect(effectiveWaitMinutes({ status: 'green' })).toBeNull();
  });
});
