import { beforeEach, describe, expect, it, vi } from 'vitest';

const { adminMock, state } = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const state = {
    activeTransactions: 0,
    maxActiveTransactions: 0,
  };

  const firestore = vi.fn();
  firestore.Timestamp = { now: () => ({}) };
  firestore.collection = vi.fn(() => ({
    doc: (path: string) => ({ path: `meta/${path}` }),
  }));
  firestore.runTransaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
    state.activeTransactions += 1;
    state.maxActiveTransactions = Math.max(state.maxActiveTransactions, state.activeTransactions);
    try {
      if (state.activeTransactions > 1) {
        throw new Error('10 ABORTED: cross-transaction contention');
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
      const writes: Array<{ ref: { path: string }; value: Record<string, unknown> }> = [];
      const tx = {
        get: async (ref: { path: string }) => {
          const value = documents.get(ref.path);
          return { exists: Boolean(value), data: () => value };
        },
        set: (ref: { path: string }, value: Record<string, unknown>) => {
          writes.push({ ref, value });
        },
      };
      const result = await callback(tx);
      for (const { ref, value } of writes) {
        documents.set(ref.path, { ...(documents.get(ref.path) ?? {}), ...value });
      }
      return result;
    } finally {
      state.activeTransactions -= 1;
    }
  });

  const adminMock = {
    apps: [] as unknown[],
    credential: { applicationDefault: vi.fn(() => ({})) },
    firestore,
    initializeApp: vi.fn(),
  };

  return { adminMock, state };
});

vi.mock('firebase-admin', () => ({ default: adminMock }));

import { reserveTrafficProviderRequest } from '../functions/src/trafficProviderMesh.js';

describe('traffic provider reservation contention', () => {
  beforeEach(() => {
    state.activeTransactions = 0;
    state.maxActiveTransactions = 0;
  });

  it('serialises same-scope reservations issued by concurrent route segments', async () => {
    const reservations = await Promise.all([
      reserveTrafficProviderRequest('mapbox', 'route', 1, new Date('2026-09-16T10:00:00.000Z')),
      reserveTrafficProviderRequest('mapbox', 'route', 1, new Date('2026-09-16T10:00:00.000Z')),
    ]);

    expect(reservations.every((reservation) => reservation.allowed)).toBe(true);
    expect(state.maxActiveTransactions).toBe(1);
  });
});
