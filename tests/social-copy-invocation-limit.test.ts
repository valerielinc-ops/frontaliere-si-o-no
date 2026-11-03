import { describe, expect, it } from 'vitest';

import {
  reserveSocialCopyCodexInvocation,
  SOCIAL_COPY_CODEX_INVOCATION_LIMIT,
  SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS,
} from '../scripts/lib/social-copy-invocation-limit.mjs';
import { run, socialCopyInvocationId } from '../scripts/social-copy/reserve-codex-invocation.mjs';

function fakeFirestore(initialState: Record<string, unknown> | null = null) {
  const reference = {};
  const state = { value: initialState };
  let transactionTail: Promise<unknown> = Promise.resolve();
  const db = {
    collection(name: string) {
      if (name !== 'socialAutomationLimits') throw new Error(`unexpected collection: ${name}`);
      return {
        doc(id: string) {
          if (id !== 'social-copy-pack') throw new Error(`unexpected document: ${id}`);
          return reference;
        },
      };
    },
    async runTransaction<T>(callback: (transaction: {
      get: (target: object) => Promise<{ exists: boolean; data: () => Record<string, unknown> | null }>;
      set: (target: object, value: Record<string, unknown>) => void;
    }) => Promise<T>) {
      const current = transactionTail.then(() => callback({
        async get(target) {
          expect(target).toBe(reference);
          return { exists: state.value !== null, data: () => state.value };
        },
        set(target, value) {
          expect(target).toBe(reference);
          state.value = structuredClone(value);
        },
      }));
      transactionTail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
  return { db, state };
}

describe('social-copy Codex invocation budget', () => {
  it('atomically allows at most two reservations in a rolling seven-day window', async () => {
    const { db } = fakeFirestore();
    const now = new Date('2026-11-03T12:00:00.000Z');

    const first = await reserveSocialCopyCodexInvocation({ db, invocationId: 'repo/1/1', now });
    const second = await reserveSocialCopyCodexInvocation({ db, invocationId: 'repo/2/1', now: new Date(now.getTime() + 1) });
    const third = await reserveSocialCopyCodexInvocation({ db, invocationId: 'repo/3/1', now: new Date(now.getTime() + 2) });

    expect(first).toMatchObject({ allowed: true, alreadyReserved: false, count: 1, limit: SOCIAL_COPY_CODEX_INVOCATION_LIMIT });
    expect(second).toMatchObject({ allowed: true, alreadyReserved: false, count: 2, limit: SOCIAL_COPY_CODEX_INVOCATION_LIMIT });
    expect(third).toMatchObject({
      allowed: false,
      alreadyReserved: false,
      count: 2,
      limit: SOCIAL_COPY_CODEX_INVOCATION_LIMIT,
      windowEndsAt: new Date(now.getTime() + SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS).toISOString(),
    });
  });

  it('keeps simultaneous reservations under the cap', async () => {
    const { db, state } = fakeFirestore();
    const now = new Date('2026-11-03T12:00:00.000Z');
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => reserveSocialCopyCodexInvocation({
      db,
      invocationId: `repo/concurrent-${index}/1`,
      now,
    })));

    expect(results.filter((result) => result.allowed)).toHaveLength(SOCIAL_COPY_CODEX_INVOCATION_LIMIT);
    expect(state.value?.reservations).toHaveLength(SOCIAL_COPY_CODEX_INVOCATION_LIMIT);
  });

  it('treats the same workflow attempt as an idempotent reservation', async () => {
    const { db, state } = fakeFirestore();
    const now = new Date('2026-11-03T12:00:00.000Z');

    await reserveSocialCopyCodexInvocation({ db, invocationId: 'repo/42/1', now });
    const duplicate = await reserveSocialCopyCodexInvocation({ db, invocationId: 'repo/42/1', now });

    expect(duplicate).toMatchObject({ allowed: true, alreadyReserved: true, count: 1 });
    expect(state.value?.reservations).toHaveLength(1);
  });

  it('expires reservations after seven days and reopens one slot', async () => {
    const { db } = fakeFirestore();
    const start = new Date('2026-11-03T12:00:00.000Z');

    await reserveSocialCopyCodexInvocation({ db, invocationId: 'repo/old/1', now: start });
    await reserveSocialCopyCodexInvocation({
      db,
      invocationId: 'repo/recent/1',
      now: new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000),
    });
    const next = await reserveSocialCopyCodexInvocation({
      db,
      invocationId: 'repo/new/1',
      now: new Date(start.getTime() + SOCIAL_COPY_CODEX_INVOCATION_WINDOW_MS + 1),
    });

    expect(next).toMatchObject({ allowed: true, alreadyReserved: false, count: 2 });
  });

  it('fails closed on malformed stored budget state', async () => {
    const malformedStates = [
      { schemaVersion: 1 },
      { schemaVersion: 1, reservations: [{ id: 'repo/1/1', reservedAt: 'invalid' }] },
    ];

    await expect(reserveSocialCopyCodexInvocation({
      db: fakeFirestore(malformedStates[0]).db,
      invocationId: 'repo/2/1',
      now: new Date('2026-11-03T12:00:00.000Z'),
    })).rejects.toThrow('social copy invocation limit state is malformed');
    await expect(reserveSocialCopyCodexInvocation({
      db: fakeFirestore(malformedStates[1]).db,
      invocationId: 'repo/2/1',
      now: new Date('2026-11-03T12:00:00.000Z'),
    })).rejects.toThrow('reservedAt must be a valid timestamp');
  });

  it('requires Firestore so missing persistent state cannot bypass the cap', async () => {
    await expect(reserveSocialCopyCodexInvocation({ invocationId: 'repo/1/1' }))
      .rejects.toThrow('Firestore is required');
  });

  it('binds the reservation id to repository, run, and attempt', () => {
    expect(socialCopyInvocationId({
      GITHUB_REPOSITORY: 'valerielinc-ops/frontaliere-si-o-no',
      GITHUB_RUN_ID: '123456',
      GITHUB_RUN_ATTEMPT: '2',
    })).toBe('valerielinc-ops/frontaliere-si-o-no/123456/2');
    expect(() => socialCopyInvocationId({ GITHUB_REPOSITORY: 'repo', GITHUB_RUN_ID: 'bad', GITHUB_RUN_ATTEMPT: '1' }))
      .toThrow('GitHub run identity is malformed');
  });

  it('rejects a non-main ref before reserving production Codex budget', async () => {
    const db = { collection() { throw new Error('non-main dispatch must not read the reservation'); } };
    await expect(run({
      env: { GITHUB_REF: 'refs/heads/feature/social-copy' },
      db,
      stdout: { write() {} },
    })).rejects.toThrow('restricted to refs/heads/main');
  });
});
