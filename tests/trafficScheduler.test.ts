/**
 * Tests for FRO-6: Scheduled border-crossing traffic tracking
 *
 * Covers:
 *  1. slugifyCrossingName()   – matches the frontend helper in TrafficAlerts.tsx
 *  2. BORDER_CROSSINGS list   – no closed crossings, coordinates in valid range
 *  3. trafficService.getTrafficData() Firestore-first path
 *  4. Fallback to mock when Firestore is empty
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Import shared data module (no server-side deps) ──────────
// borderCrossingsData.js is a plain ES module with no firebase-admin imports,
// so it can be consumed safely in the Vitest/jsdom environment.
import {
  slugifyCrossingName,
  BORDER_CROSSINGS as SCHEDULER_CROSSINGS,
} from '../functions/src/borderCrossingsData.js';

// ─── Unit tests for slugifyCrossingName ───────────────────────

describe('slugifyCrossingName', () => {
  it('handles plain ASCII names', () => {
    expect(slugifyCrossingName('Ponte Tresa')).toBe('ponte-tresa');
  });

  it('strips parenthesised text', () => {
    expect(slugifyCrossingName('Chiasso Centro (Ponte Chiasso)')).toBe('chiasso-centro');
  });

  it('normalises accented characters', () => {
    expect(slugifyCrossingName("Lanzo d'Intelvi-Arogno")).toBe('lanzo-d-intelvi-arogno');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugifyCrossingName('-Test-')).toBe('test');
  });

  it('collapses consecutive hyphens', () => {
    expect(slugifyCrossingName('A  B')).toBe('a-b');
  });
});

// ─── BORDER_CROSSINGS list validation ─────────────────────────

import { borderCrossings } from '@/data/borderCrossings';

describe('BORDER_CROSSINGS (scheduler list)', () => {
  const EXPECTED_NAMES = borderCrossings
    .filter(c => c.trafficLevel !== 'closed')
    .map(c => c.name);

  it('contains only non-closed crossings', () => {
    const closedNames = borderCrossings
      .filter(c => c.trafficLevel === 'closed')
      .map(c => c.name);

    for (const crossing of SCHEDULER_CROSSINGS) {
      expect(closedNames).not.toContain(crossing.name);
    }
  });

  it('has the same count as non-closed borderCrossings', () => {
    expect(SCHEDULER_CROSSINGS).toHaveLength(EXPECTED_NAMES.length);
  });

  it('contains all expected crossing names', () => {
    const schedulerNames = SCHEDULER_CROSSINGS.map(c => c.name);
    for (const name of EXPECTED_NAMES) {
      expect(schedulerNames).toContain(name);
    }
  });

  it('has valid latitude/longitude for every crossing', () => {
    for (const c of SCHEDULER_CROSSINGS) {
      expect(c.lat).toBeGreaterThan(44);
      expect(c.lat).toBeLessThan(47);
      expect(c.lng).toBeGreaterThan(8);
      expect(c.lng).toBeLessThan(10);
    }
  });
});

// ─── trafficService: Firestore-first path ─────────────────────

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection:   vi.fn(() => ({})),
  getDocs: vi.fn(),
}));

import { trafficService } from '@/services/trafficService';
import * as firestoreModule from 'firebase/firestore';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  trafficService.clearCache();
});

describe('trafficService.getTrafficData – Firestore path', () => {
  it('returns Firestore data when collection is non-empty', async () => {
    const fakeTimestamp = { toDate: () => new Date(Date.now() - 10 * 60 * 1000) }; // 10 min ago
    const fakeDocs = [
      {
        id: 'chiasso-centro',
        data: () => ({
          crossingName: 'Chiasso Centro (Ponte Chiasso)',
          waitTimeMinutes: 12,
          status: 'yellow',
          direction: 'IT → CH',
          lastUpdate: fakeTimestamp,
          approachMinutes: 3,
          totalCrossingMinutes: 15,
          source: 'tomtom',
        }),
      },
    ];

    vi.mocked(firestoreModule.getDocs).mockResolvedValueOnce({
      empty: false,
      forEach: (cb: (doc: (typeof fakeDocs)[0]) => void) => fakeDocs.forEach(cb),
    } as unknown as Awaited<ReturnType<typeof firestoreModule.getDocs>>);

    const data = await trafficService.getTrafficData();
    expect(data).toHaveLength(1);
    expect(data[0].crossingName).toBe('Chiasso Centro (Ponte Chiasso)');
    expect(data[0].waitTimeMinutes).toBe(12);
    expect(data[0].status).toBe('yellow');
    expect(data[0].source).toBe('firestore');
    expect(data[0].approachMinutes).toBe(3);
    expect(data[0].totalCrossingMinutes).toBe(15);
    expect(data[0].lastUpdate).toBeInstanceOf(Date);
  });

  it('falls back to mock data when Firestore collection is empty', async () => {
    vi.mocked(firestoreModule.getDocs).mockResolvedValueOnce({
      empty: true,
      forEach: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof firestoreModule.getDocs>>);

    const data = await trafficService.getTrafficData();
    // Should return mock data for all non-closed crossings (>0 entries)
    expect(data.length).toBeGreaterThan(0);
    for (const d of data) {
      expect(d.source).toBe('mock');
    }
  });

  it('falls back gracefully when Firestore throws', async () => {
    vi.mocked(firestoreModule.getDocs).mockRejectedValueOnce(new Error('Firestore unavailable'));

    const data = await trafficService.getTrafficData();
    expect(data.length).toBeGreaterThan(0);
  });

  it('falls back to mock when Firestore data is stale (>2 hours old)', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const staleDocs = [
      {
        id: 'chiasso-centro',
        data: () => ({
          crossingName: 'Chiasso Centro (Ponte Chiasso)',
          waitTimeMinutes: 5,
          status: 'green',
          direction: 'Entrambi',
          lastUpdate: { toDate: () => threeHoursAgo },
          approachMinutes: 0,
          totalCrossingMinutes: 5,
          source: 'tomtom',
        }),
      },
    ];

    vi.mocked(firestoreModule.getDocs).mockResolvedValueOnce({
      empty: false,
      forEach: (cb: (doc: (typeof staleDocs)[0]) => void) => staleDocs.forEach(cb),
    } as unknown as Awaited<ReturnType<typeof firestoreModule.getDocs>>);

    const data = await trafficService.getTrafficData();
    // Should have fallen back to mock (stale Firestore data discarded)
    expect(data.length).toBeGreaterThan(0);
    for (const d of data) {
      expect(d.source).toBe('mock');
    }
  });
});
