/**
 * tests/newsletter-confirmation-ledger-atomicity.test.ts
 *
 * THE INVARIANT: the confirmation ledger is never half-written (#5843, items 2
 * and 3). A document may say "asked twice" or it may say "asked once", but it
 * may never hold a counter with no matching event, nor two events claiming to
 * be the same attempt.
 *
 * ── WHY THIS FILE DOES NOT GREP FOR THE WORD «transaction» ─────────────────
 *
 * Both defects are shaped so that the code reads correctly right up until the
 * process dies or a second caller arrives. A test that asserts the presence of
 * `runTransaction`, or the absence of a second `commitInChunks`, passes the day
 * somebody writes a transaction that reads the stale value inside it — which is
 * precisely the mistake being fixed. So nothing here reads the source.
 *
 * Instead there are two Firestore doubles:
 *
 *   - one whose `commit()` DIES on a chosen commit number, modelling the real
 *     guarantee (a batch that throws lands none of its writes). The runner is
 *     driven through it and every document it touched is then checked for the
 *     half-written shape. Under the two-pass code this file was written against
 *     it finds 400 of them;
 *   - one with a real optimistic `runTransaction`: reads are versioned, a
 *     conflicting commit re-runs the callback. Two sends are then let race the
 *     way two "resend" clicks do — both read the document before either writes.
 *
 * No email can leave: functions/src/emailCascade.js is mocked at module scope,
 * so both senders' only wire is a function that returns fixtures.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { cascade } = vi.hoisted(() => ({
  cascade: {
    fn: null as null | ((items: any[]) => Promise<{ sent: any[]; failed: any[] }>),
  },
}));

vi.mock('../functions/src/emailCascade.js', () => ({
  sendEmailCascade: (items: any[]) => cascade.fn!(items),
  PROVIDERS: [{ id: 'fake' }],
  isProviderConfigured: () => true,
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  bridgeEmailCascadeCredentialsToEnv: async () => {},
  getNewsletterTokenPolicyConfig: async () => ({}),
  getRemoteConfigValue: async () => null,
}));

import { sendConfirmationRequests } from '../scripts/newsletter-confirmation-followups.mjs';
import { commitInChunks, FIRESTORE_BATCH_SIZE } from '../scripts/lib/firestore-batch.mjs';
import { sendNewsletterConfirmationEmail } from '../functions/src/newsletterConfirmationEmail.js';

/** Deliver everything, with a message id per recipient. */
const deliverAll = async (items: any[]) => ({
  sent: items.map((it) => ({ ...it, messageId: `mid-${it.meta.id}` })),
  failed: [] as any[],
});

beforeEach(() => {
  cascade.fn = deliverAll;
});

// ── A Firestore double for the batched path ────────────────────────────────
//
// The only behaviour that matters: a `commit()` that throws must leave the
// store exactly as it was. That is Firestore's actual contract for a
// WriteBatch, and it is the contract the fix leans on.

type BatchStore = {
  db: any;
  fields: Map<string, Record<string, any>>;
  events: Map<string, any[]>;
  commits: () => number;
  refFor: (email: string) => any;
};

function batchDbThatDiesOnCommit(dieOn = Number.POSITIVE_INFINITY): BatchStore {
  const fields = new Map<string, Record<string, any>>();
  const events = new Map<string, any[]>();
  let commits = 0;

  const refFor = (email: string) => ({
    __doc: email,
    collection: (sub: string) => ({ doc: () => ({ __event: email, __sub: sub }) }),
  });

  const db = {
    batch() {
      const staged: Array<() => void> = [];
      const stage = (ref: any, data: any) => {
        if (ref.__event !== undefined) {
          staged.push(() => events.set(ref.__event, [...(events.get(ref.__event) ?? []), data]));
        } else {
          staged.push(() => fields.set(ref.__doc, { ...(fields.get(ref.__doc) ?? {}), ...data }));
        }
      };
      return {
        set: (ref: any, data: any) => stage(ref, data),
        update: (ref: any, data: any) => stage(ref, data),
        delete: () => {},
        commit: async () => {
          commits += 1;
          // Atomic: the process dies here and NOTHING this batch carried lands.
          if (commits === dieOn) throw new Error(`simulated process death on commit #${commits}`);
          for (const apply of staged) apply();
        },
      };
    },
  };

  return { db, fields, events, commits: () => commits, refFor };
}

/** Addresses left holding exactly one of the two halves. */
function halfWritten(store: BatchStore): string[] {
  const touched = new Set([...store.fields.keys(), ...store.events.keys()]);
  return [...touched].filter((email) => {
    const counted = (store.fields.get(email) ?? {}).confirmation_attempts !== undefined;
    const evidenced = (store.events.get(email) ?? []).length > 0;
    return counted !== evidenced;
  });
}

const NOW_ISO = new Date().toISOString();
/**
 * Relative to the real clock, never to a pinned date: the Cloud Function reads
 * `Date.now()` for its 1-hour cooldown, so a fixture stamped with a fixed
 * calendar date drifts into the future (or past the window) as the months pass
 * and the test starts asserting a different branch than the one it names.
 */
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

/** `plan.send` items, as planConfirmationFollowups would hand them over. */
function dueItems(store: BatchStore, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const email = `due-${String(i).padStart(4, '0')}@example.com`;
    return {
      id: email,
      data: {
        email,
        status: 'pending',
        isActive: false,
        created_at: hoursAgo(72),
        confirmation_attempts: 1,
        confirmation_first_sent_at: hoursAgo(72),
        confirmation_sent_at: hoursAgo(25),
      },
      ref: store.refFor(email),
      decision: { action: 'send', attempt: 2, attempts: 1, reason: 'reminder' },
    };
  });
}

describe('the ledger of a reminder run cannot be interrupted between its two halves', () => {
  // 500 recipients: enough that the run genuinely spans several commits, so
  // "die on commit N" lands in the middle of the work rather than before or
  // after all of it. Two writes per recipient at FIRESTORE_BATCH_SIZE ops per
  // batch means a boundary every 200 recipients.
  const N = 500;

  it('writes both halves for every recipient when nothing goes wrong', async () => {
    const store = batchDbThatDiesOnCommit();
    const due = dueItems(store, N);

    await sendConfirmationRequests(store.db, due, { nowIso: NOW_ISO, secret: 'test-secret' });

    expect(halfWritten(store)).toEqual([]);
    expect(store.fields.size).toBe(N);
    expect(store.events.size).toBe(N);
    // Derived from the shared constant, not restated: two operations per
    // recipient is what makes the pair atomic, and it is also what sets the
    // number of commits. A run that needed twice as many commits would be the
    // two-pass shape again.
    expect(store.commits()).toBe(Math.ceil((N * 2) / FIRESTORE_BATCH_SIZE));
  });

  it.each([2, 3])(
    'a process killed on commit #%i leaves no counter without its event, and no event without its counter',
    async (dieOn) => {
      const store = batchDbThatDiesOnCommit(dieOn);
      const due = dueItems(store, N);

      await expect(
        sendConfirmationRequests(store.db, due, { nowIso: NOW_ISO, secret: 'test-secret' }),
      ).rejects.toThrow(/simulated process death/);

      // The assertion this file exists for.
      expect(halfWritten(store)).toEqual([]);

      // …and it is not green because the run wrote nothing, or because it
      // wrote everything. Both would make the check above vacuous, which is
      // the failure mode of every guard in this repo that stopped guarding.
      expect(store.fields.size).toBeGreaterThan(0);
      expect(store.fields.size).toBeLessThan(N);
    },
  );

  it('every write of one recipient shares a batch, whatever the chunk boundary does', async () => {
    // The enabling invariant, asserted on the shared helper directly so it
    // cannot be re-broken for some other caller. `commitInChunks` may split
    // work across batches; what it may never do is split ONE item.
    const batchOfOp: number[][] = [];
    let open: number[] = [];
    let committed = 0;
    const db = {
      batch: () => ({
        set: (ref: any) => open.push(ref.__item),
        update: (ref: any) => open.push(ref.__item),
        delete: () => {},
        commit: async () => {
          committed += 1;
          batchOfOp.push(open);
          open = [];
        },
      }),
    };

    const items = Array.from({ length: 401 }, (_, i) => i);
    const written = await commitInChunks(db as any, items, (batch: any, i: number) => {
      batch.set({ __item: i }, { a: 1 });
      batch.set({ __item: i }, { b: 2 });
    });

    expect(written).toBe(items.length);
    expect(committed).toBeGreaterThan(1); // otherwise there is no boundary to test
    const seen = new Map<number, number>();
    for (const [batchIndex, ops] of batchOfOp.entries()) {
      for (const item of ops) {
        const already = seen.get(item);
        expect(already === undefined || already === batchIndex, `item ${item} split across batches`).toBe(true);
        seen.set(item, batchIndex);
      }
    }
    expect(seen.size).toBe(items.length);
  });
});

// ── A Firestore double with a real optimistic transaction ──────────────────

function txDb(initial: Record<string, any>) {
  const docs = new Map<string, Record<string, any>>([['sub', { ...initial }]]);
  const versions = new Map<string, number>([['sub', 0]]);
  const events: any[] = [];
  let aborts = 0;

  const eventsCollection = { doc: () => ({ __event: true }) };
  const subRef: any = {
    __key: 'sub',
    collection: () => eventsCollection,
    // The pre-send read, OUTSIDE any transaction — the one the race is about.
    get: async () => ({ exists: docs.has('sub'), data: () => docs.get('sub') }),
  };

  const db = {
    collection: () => ({ doc: () => subRef }),
    async runTransaction(fn: (tx: any) => Promise<any>) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const readAt = new Map<string, number>();
        const staged: Array<() => void> = [];
        const tx = {
          get: async (ref: any) => {
            readAt.set(ref.__key, versions.get(ref.__key) ?? 0);
            return { exists: docs.has(ref.__key), data: () => docs.get(ref.__key) };
          },
          update: (ref: any, data: any) =>
            staged.push(() => {
              docs.set(ref.__key, { ...(docs.get(ref.__key) ?? {}), ...data });
              versions.set(ref.__key, (versions.get(ref.__key) ?? 0) + 1);
            }),
          set: (ref: any, data: any) =>
            staged.push(() => {
              if (ref.__event) events.push(data);
              else docs.set(ref.__key, { ...(docs.get(ref.__key) ?? {}), ...data });
            }),
        };

        const result = await fn(tx);

        const stale = [...readAt].some(([key, v]) => (versions.get(key) ?? 0) !== v);
        if (stale) {
          aborts += 1;
          continue; // discard `staged` — exactly what Firestore does
        }
        for (const apply of staged) apply();
        return result;
      }
      throw new Error('transaction_aborted');
    },
  };

  return { db, docs, events, aborts: () => aborts, subRef };
}

describe('two resend clicks in the same instant cannot spend the same attempt number', () => {
  it('increments sequentially instead of writing the same number twice', async () => {
    // The shape from the issue: `attemptsBefore` is read BEFORE the send, and
    // the send is the slow part. Two callers therefore both hold the same
    // pre-send number by the time either of them writes. The barrier below is
    // not a contrivance — it is that overlap, made deterministic: neither send
    // returns until both have read the document.
    let release: () => void;
    const bothArrived = new Promise<void>((r) => { release = r; });
    let arrived = 0;
    cascade.fn = async (items: any[]) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      return { sent: items.map((it) => ({ ...it, messageId: `mid-${arrived}` })), failed: [] };
    };

    const store = txDb({
      email: 'race@example.com',
      status: 'pending',
      isActive: false,
      created_at: hoursAgo(72),
      confirmation_attempts: 1,
      confirmation_first_sent_at: hoursAgo(72),
      // Well past the 1-hour cooldown, so neither click is refused: the
      // cooldown is checked against this same stale read and cannot separate
      // two clicks that arrive together.
      confirmation_sent_at: hoursAgo(25),
    });

    const send = () =>
      sendNewsletterConfirmationEmail({
        email: 'race@example.com',
        locale: 'it',
        sourcePath: '/',
        secret: 'test-secret',
        db: store.db,
        purpose: undefined,
      });

    const results = await Promise.all([send(), send()]);
    expect(results.every((r) => r.success)).toBe(true);

    // Two messages left, so the ledger must say two more attempts than it did.
    expect(store.docs.get('sub')!.confirmation_attempts).toBe(3);

    // …and the evidence must agree, one row per message, no two claiming the
    // same attempt. This is the half the counter alone would not reveal.
    const attempts = store.events.map((e) => e.confirmation_attempt).sort();
    expect(attempts).toEqual([2, 3]);
  });

  it('records nothing rather than resurrecting a subscriber deleted mid-send', async () => {
    // A send whose document disappeared underneath it. Writing the ledger with
    // `set` would recreate the record somebody removed — the resurrection
    // shape this codebase has already paid for once. The send is lost instead,
    // which is the recoverable direction.
    const store = txDb({
      email: 'gone@example.com',
      status: 'pending',
      isActive: false,
      created_at: hoursAgo(72),
      confirmation_attempts: 1,
      confirmation_sent_at: hoursAgo(25),
    });
    cascade.fn = async (items: any[]) => {
      store.docs.delete('sub');
      return { sent: items.map((it) => ({ ...it, messageId: 'mid-x' })), failed: [] };
    };

    const result = await sendNewsletterConfirmationEmail({
      email: 'gone@example.com',
      locale: 'it',
      sourcePath: '/',
      secret: 'test-secret',
      db: store.db,
      purpose: undefined,
    });

    expect(result.success).toBe(true);
    expect(store.docs.has('sub')).toBe(false);
    expect(store.events).toEqual([]);
  });
});
