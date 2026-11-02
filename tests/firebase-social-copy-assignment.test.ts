import { describe, expect, it } from 'vitest';
import {
  assignBalancedSocialCopy,
  releaseBalancedSocialCopyAssignment,
} from '../scripts/lib/firebase-social-copy-assignment.mjs';

function memoryFirestore() {
  const documents = new Map<string, Record<string, unknown>>();
  let transactionTail = Promise.resolve();
  const getRef = (collection: string, id: string) => ({ path: collection + '/' + id });
  const db = {
    collection(name: string) {
      return { doc: (id: string) => getRef(name, id) };
    },
    runTransaction<T>(callback: (transaction: {
      get: (ref: { path: string }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      set: (ref: { path: string }, value: Record<string, unknown>, options?: { merge?: boolean }) => void;
    }) => Promise<T>) {
      const run = transactionTail.then(() => callback({
        get: async (ref) => {
          const value = documents.get(ref.path);
          return { exists: value !== undefined, data: () => value ? structuredClone(value) : undefined };
        },
        set: (ref, value, options) => {
          const previous = options?.merge ? documents.get(ref.path) || {} : {};
          documents.set(ref.path, { ...previous, ...structuredClone(value) });
        },
      }));
      transactionTail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return { db, documents };
}

describe('Firebase-balanced social-copy assignment', () => {
  it('balances arms, keeps retries on the original arm, and stores no content identity', async () => {
    const { db, documents } = memoryFirestore();
    const input = {
      db,
      experimentId: 'social-copy-balanced-v1',
      packId: '0123456789abcdef',
      channel: 'facebook',
      slot: 'article',
      assignmentKey: 'article:public-slug',
      templateIds: ['one', 'two', 'three'],
    };

    const first = await assignBalancedSocialCopy(input);
    const retry = await assignBalancedSocialCopy(input);
    const assignments = await Promise.all(Array.from({ length: 23 }, (_, index) => assignBalancedSocialCopy({
      ...input,
      assignmentKey: 'article:public-slug-' + index,
    })));

    expect(retry.templateId).toBe(first.templateId);
    expect(retry.reused).toBe(true);
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect(assignments).toHaveLength(23);
    const scope = [...documents.values()].find((value) => value.counts);
    expect(scope?.counts).toEqual({ one: 8, two: 8, three: 8 });
    expect(JSON.stringify([...documents.values()])).not.toContain('article:public-slug');
  });

  it('rejects an assignment outside the supported copy domain', async () => {
    const { db } = memoryFirestore();
    await expect(assignBalancedSocialCopy({
      db,
      experimentId: 'bad id',
      packId: '0123456789abcdef',
      channel: 'facebook',
      slot: 'article',
      assignmentKey: 'a',
      templateIds: ['one', 'two'],
    })).rejects.toThrow(/invalid experimentId/);
  });

  it('releases an unused format arm and allows a replacement assignment', async () => {
    const { db, documents } = memoryFirestore();
    const input = {
      db,
      experimentId: 'social-copy-balanced-v1',
      packId: '0123456789abcdef',
      channel: 'tiktok',
      slot: 'video',
      assignmentKey: 'article:2026-11-02',
      templateIds: ['one', 'two', 'three'],
    };

    const first = await assignBalancedSocialCopy(input);
    expect(await releaseBalancedSocialCopyAssignment({ ...input, attemptId: first.attemptId })).toBe(true);
    const releasedCounts = [...documents.values()].find((value) => value.experimentId === input.experimentId)?.counts;
    expect(Object.values(releasedCounts as Record<string, number>).reduce((sum, value) => sum + value, 0)).toBe(0);

    const replacement = await assignBalancedSocialCopy(input);
    expect(replacement.reused).toBe(false);
    expect(await releaseBalancedSocialCopyAssignment({ ...input, attemptId: replacement.attemptId })).toBe(true);
    expect(await releaseBalancedSocialCopyAssignment({ ...input, attemptId: replacement.attemptId })).toBe(true);
    const counts = [...documents.values()].find((value) => value.experimentId === input.experimentId)?.counts as Record<string, number>;
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it('keeps the reservation while another concurrent attempt may still publish', async () => {
    const { db, documents } = memoryFirestore();
    const input = {
      db,
      experimentId: 'social-copy-balanced-v1',
      packId: '0123456789abcdef',
      channel: 'reddit',
      slot: 'job',
      assignmentKey: 'job:stable-public-id',
      templateIds: ['one', 'two', 'three'],
    };

    const rejected = await assignBalancedSocialCopy(input);
    const concurrent = await assignBalancedSocialCopy(input);
    expect(rejected.templateId).toBe(concurrent.templateId);

    expect(await releaseBalancedSocialCopyAssignment({ ...input, attemptId: rejected.attemptId })).toBe(true);
    let counts = [...documents.values()].find((value) => value.experimentId === input.experimentId)?.counts as Record<string, number>;
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(1);

    // A successful or ambiguous concurrent attempt keeps its active marker,
    // so the failed attempt cannot free the shared reservation.
    counts = [...documents.values()].find((value) => value.experimentId === input.experimentId)?.counts as Record<string, number>;
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(1);

    // Only after both attempts are known not to have delivered may the count
    // be released.
    expect(await releaseBalancedSocialCopyAssignment({ ...input, attemptId: concurrent.attemptId })).toBe(true);
    counts = [...documents.values()].find((value) => value.experimentId === input.experimentId)?.counts as Record<string, number>;
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(0);
  });
});
