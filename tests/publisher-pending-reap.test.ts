/**
 * tests/publisher-pending-reap.test.ts
 *
 * Stale-checkout reaper: ads stuck in 'pending_payment' (abandoned Stripe
 * checkout) must NOT live forever — past the reap window they revert to 'draft'.
 *
 * Two layers:
 *   1. isStalePendingPayment — pure decision (timestamp anchoring + threshold).
 *   2. reapStalePendingPayments — query → filter → guarded revert, exercised
 *      against an in-memory firebase-admin stub (also covers the per-doc guard
 *      in revertPendingJobsToDraft: only docs still pending are reverted).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// In-memory publisher_jobs store, swapped per test.
let store: Record<string, Record<string, unknown>> = {};

// Mock firebase-admin: a chainable Firestore that the reaper + revert helper use:
//   collection('publisher_jobs').where('status','==','pending_payment').get()
//   collection('publisher_jobs').doc(id)  → ref { __id }
//   runTransaction(fn) → fn({ get, set })
vi.mock('firebase-admin', () => {
  const makeSnap = (id: string) => ({
    id,
    exists: store[id] != null,
    data: () => store[id],
  });
  const firestore = Object.assign(
    () => ({
      collection: () => ({
        where: () => ({
          get: async () => {
            const docs = Object.keys(store)
              .filter((id) => store[id].status === 'pending_payment')
              .map((id) => makeSnap(id));
            return { empty: docs.length === 0, docs };
          },
        }),
        doc: (id: string) => ({ __id: id }),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          get: async (ref: { __id: string }) => makeSnap(ref.__id),
          set: (ref: { __id: string }, data: Record<string, unknown>) => {
            const cur = store[ref.__id] || {};
            // Emulate FieldValue.delete() sentinel.
            const next: Record<string, unknown> = { ...cur, ...data };
            for (const k of Object.keys(next)) {
              if (next[k] === '__delete__') delete next[k];
            }
            store[ref.__id] = next;
          },
        }),
    }),
    {
      FieldValue: {
        serverTimestamp: () => '__server_ts__',
        delete: () => '__delete__',
      },
    },
  );
  return { default: { firestore } };
});

async function load() {
  return import('../functions/src/publisherPendingReapCore.js');
}

describe('isStalePendingPayment', () => {
  it('is true for a pending ad older than the threshold', async () => {
    const { isStalePendingPayment } = await load();
    const job = { status: 'pending_payment', pendingPaymentAt: NOW - 50 * HOUR };
    expect(isStalePendingPayment(job, NOW)).toBe(true);
  });

  it('is false for a pending ad still within the window', async () => {
    const { isStalePendingPayment } = await load();
    const job = { status: 'pending_payment', pendingPaymentAt: NOW - 1 * HOUR };
    expect(isStalePendingPayment(job, NOW)).toBe(false);
  });

  it('never reaps a non-pending ad', async () => {
    const { isStalePendingPayment } = await load();
    expect(isStalePendingPayment({ status: 'paid', pendingPaymentAt: NOW - 999 * HOUR }, NOW)).toBe(false);
    expect(isStalePendingPayment({ status: 'draft', pendingPaymentAt: NOW - 999 * HOUR }, NOW)).toBe(false);
    expect(isStalePendingPayment(null, NOW)).toBe(false);
  });

  it('falls back to updatedAt / createdAt when pendingPaymentAt is missing', async () => {
    const { isStalePendingPayment } = await load();
    expect(isStalePendingPayment({ status: 'pending_payment', updatedAt: NOW - 50 * HOUR }, NOW)).toBe(true);
    expect(isStalePendingPayment({ status: 'pending_payment', createdAt: NOW - 50 * HOUR }, NOW)).toBe(true);
  });

  it('leaves an ad with no usable timestamp untouched (unknown age = safe)', async () => {
    const { isStalePendingPayment } = await load();
    expect(isStalePendingPayment({ status: 'pending_payment' }, NOW)).toBe(false);
  });

  it('reads Firestore Timestamp ({ toMillis }) and { _seconds } shapes', async () => {
    const { isStalePendingPayment } = await load();
    const tsObj = { toMillis: () => NOW - 50 * HOUR };
    expect(isStalePendingPayment({ status: 'pending_payment', pendingPaymentAt: tsObj }, NOW)).toBe(true);
    const secObj = { _seconds: (NOW - 50 * HOUR) / 1000 };
    expect(isStalePendingPayment({ status: 'pending_payment', pendingPaymentAt: secObj }, NOW)).toBe(true);
  });
});

describe('reapStalePendingPayments', () => {
  beforeEach(() => {
    store = {};
  });

  it('reverts only stale pending ads, leaving fresh + non-pending untouched', async () => {
    const { reapStalePendingPayments } = await load();
    store = {
      fresh: { status: 'pending_payment', pendingPaymentAt: NOW - 1 * HOUR },
      stale1: { status: 'pending_payment', pendingPaymentAt: NOW - 50 * HOUR },
      stale2: { status: 'pending_payment', updatedAt: NOW - 60 * HOUR }, // fallback anchor
      live: { status: 'paid', pendingPaymentAt: NOW - 999 * HOUR },
    };

    const reverted = await reapStalePendingPayments(NOW);

    expect(reverted).toBe(2);
    expect(store.stale1.status).toBe('draft');
    expect(store.stale2.status).toBe('draft');
    expect(store.stale1.pendingPaymentAt).toBeUndefined(); // cleared on revert
    expect(store.fresh.status).toBe('pending_payment'); // within window
    expect(store.live.status).toBe('paid'); // never touched
  });

  it('returns 0 when there is nothing to reap', async () => {
    const { reapStalePendingPayments } = await load();
    store = { a: { status: 'paid' }, b: { status: 'published' } };
    expect(await reapStalePendingPayments(NOW)).toBe(0);
  });
});
