/**
 * Tests for FRO-6: Scheduled border-crossing traffic tracking
 *
 * Covers:
 *  1. slugifyCrossingName()   – matches the frontend helper in TrafficAlerts.tsx
 *  2. BORDER_CROSSINGS list   – no closed crossings, coordinates in valid range
 *  3. trafficService.getTrafficData() public read-model path
 *  4. Fallback to mock when the public read model is empty
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
    .filter(c => c.trafficLevel !== 'closed' && c.waitSource !== 'none')
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

  it('keeps explicitly unmetered crossings out of paid polling', () => {
    const unmeteredNames = borderCrossings
      .filter(c => c.waitSource === 'none')
      .map(c => c.name);
    const schedulerNames = new Set(SCHEDULER_CROSSINGS.map(c => c.name));
    expect(unmeteredNames.length).toBeGreaterThan(0);
    for (const name of unmeteredNames) {
      expect(schedulerNames.has(name), `${name} must not enter TomTom/HERE polling`).toBe(false);
    }
  });

  it('carries the same canton as data/borderCrossings.ts for every crossing', () => {
    // publish-border-wait-window.mjs tags the ranking window with this field;
    // a drift here would file a crossing under the wrong canton's ranking.
    const cantonByName = new Map(borderCrossings.map(c => [c.name, c.canton]));
    const mismatches = SCHEDULER_CROSSINGS
      .filter(c => c.canton !== cantonByName.get(c.name))
      .map(c => `${c.name}: ${c.canton} != ${cantonByName.get(c.name)}`);
    expect(mismatches).toEqual([]);
  });

  it('has valid latitude/longitude for every crossing', () => {
    // Switzerland + immediately-adjacent border territory across all supported
    // neighbours (IT/FR/DE/AT/LI), not just the original Ticino-only scope:
    // south Chiasso ~45.8 to north Schaffhausen/Basel ~47.8,
    // west Geneva/Jura ~5.9 to east Samnaun/Val Müstair ~10.6, plus the
    // Grigioni/Vallese Italy-border passes (Gran San Bernardo ~7.17,
    // Umbrail ~10.43) that pushed the bounds slightly wider than either
    // sibling range alone (widened 2026-07, union of all 5 regime PRs).
    for (const c of SCHEDULER_CROSSINGS) {
      expect(c.lat).toBeGreaterThan(44);
      expect(c.lat).toBeLessThan(48);
      expect(c.lng).toBeGreaterThan(5.5);
      expect(c.lng).toBeLessThan(11);
    }
  });
});

// ─── trafficService: public read-model path ───────────────────

const mockFetch = vi.fn();

import { trafficService } from '@/services/trafficService';

function encodePublicValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate();
    return { timestampValue: date.toISOString() };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { integerValue: String(value) }
    : { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  return null;
}

function publicTrafficResponse(docs: Array<{ id: string; data: () => Record<string, unknown> }>) {
  return {
    ok: true,
    json: async () => ({
      documents: docs.map(doc => {
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(doc.data())) {
          const encoded = encodePublicValue(value);
          if (encoded) fields[key] = encoded;
        }
        return { name: doc.id, fields };
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  trafficService.clearCache();
});

describe('trafficService.getTrafficData – public endpoint path', () => {
  it('returns public read-model data when the endpoint is non-empty', async () => {
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

    mockFetch.mockResolvedValueOnce(publicTrafficResponse(fakeDocs));

    const data = await trafficService.getTrafficData();
    expect(data).toHaveLength(1);
    expect(data[0].crossingName).toBe('Chiasso Centro (Ponte Chiasso)');
    expect(data[0].waitTimeMinutes).toBe(12);
    expect(data[0].status).toBe('yellow');
    expect(data[0].source).toBe('firestore');
    expect(data[0].approachMinutes).toBe(3);
    expect(data[0].totalCrossingMinutes).toBe(15);
    expect(data[0].lastUpdate).toBeInstanceOf(Date);
    expect(data[0]).not.toHaveProperty('direction');
  });

  it('keeps a fresh total-only reading without inventing queue or status', async () => {
    const fakeDocs = [
      {
        id: 'total-only-crossing',
        data: () => ({
          crossingName: 'Total-only crossing',
          totalCrossingMinutes: 0,
          approachMinutes: 4,
          lastUpdate: { toDate: () => new Date(Date.now() - 10 * 60 * 1000) },
        }),
      },
    ];

    mockFetch.mockResolvedValueOnce(publicTrafficResponse(fakeDocs));

    const data = await trafficService.getTrafficData();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      crossingName: 'Total-only crossing',
      totalCrossingMinutes: 0,
      approachMinutes: 4,
      source: 'firestore',
    });
    expect(data[0]).not.toHaveProperty('waitTimeMinutes');
    expect(data[0]).not.toHaveProperty('status');
  });

  it('does not turn a public reading without a timestamp into a current reading', async () => {
    const incompleteDocs = [
      {
        id: 'chiasso-centro',
        data: () => ({
          crossingName: 'Chiasso Centro (Ponte Chiasso)',
          waitTimeMinutes: 12,
          status: 'yellow',
          source: 'tomtom',
        }),
      },
    ];

    mockFetch.mockResolvedValueOnce(publicTrafficResponse(incompleteDocs));

    const data = await trafficService.getTrafficData();
    expect(data.every((item) => item.source === 'mock')).toBe(true);
  });

  it('falls back to mock data when the public endpoint has no documents', async () => {
    mockFetch.mockResolvedValueOnce(publicTrafficResponse([]));

    const data = await trafficService.getTrafficData();
    // Should return mock data for all non-closed crossings (>0 entries)
    expect(data.length).toBeGreaterThan(0);
    for (const d of data) {
      expect(d.source).toBe('mock');
    }
  });

  it('falls back gracefully when the public endpoint throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Public endpoint unavailable'));

    const data = await trafficService.getTrafficData();
    expect(data.length).toBeGreaterThan(0);
  });

  it('falls back to mock when public data is stale (>2 hours old)', async () => {
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

    mockFetch.mockResolvedValueOnce(publicTrafficResponse(staleDocs));

    const data = await trafficService.getTrafficData();
    // Should have fallen back to mock (stale public data discarded)
    expect(data.length).toBeGreaterThan(0);
    for (const d of data) {
      expect(d.source).toBe('mock');
    }
  });
});
