import { describe, expect, it } from 'vitest';
import {
  assignBalancedSocialCopy,
  markBalancedSocialCopyAssignmentPublished,
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

  it('randomizes ties within the least-used arm set and remains idempotent on retry', async () => {
    const { db } = memoryFirestore();
    const requestedIndexes = [0, 1, 0];
    const randomIntImpl = (max: number) => {
      const index = requestedIndexes.shift();
      if (index === undefined || index >= max) throw new Error('unexpected random draw');
      return index;
    };
    const input = {
      db,
      experimentId: 'social-copy-randomized-v1',
      packId: '0123456789abcdef',
      channel: 'facebook',
      slot: 'article',
      templateIds: ['one', 'two', 'three'],
      randomIntImpl,
    };

    const assignments = await Promise.all(['one-post', 'two-post', 'three-post'].map((assignmentKey) => (
      assignBalancedSocialCopy({ ...input, assignmentKey })
    )));
    const retry = await assignBalancedSocialCopy({ ...input, assignmentKey: 'one-post' });

    expect(assignments.map((assignment) => assignment.templateId)).toEqual(['one', 'two', 'three']);
    expect(retry.templateId).toBe('one');
    expect(retry.reused).toBe(true);
    expect(requestedIndexes).toEqual([]);
  });

  it('balances arms independently inside source-class and weekday blocks', async () => {
    const { db } = memoryFirestore();
    const input = {
      db,
      experimentId: 'social-copy-blocked-v1',
      packId: '0123456789abcdef',
      channel: 'instagram',
      slot: 'article',
      objective: 'share',
      blockContext: { contentClass: 'article', weekday: 2 },
      templateIds: ['one', 'two', 'three'],
      randomIntImpl: () => 0,
    };

    const firstCycle = await Promise.all(['article-a', 'article-b', 'article-c'].map((assignmentKey) => (
      assignBalancedSocialCopy({ ...input, assignmentKey })
    )));
    const secondCycle = await assignBalancedSocialCopy({ ...input, assignmentKey: 'article-d' });
    const otherBlock = await assignBalancedSocialCopy({
      ...input,
      assignmentKey: 'article-other-weekday',
      blockContext: { contentClass: 'article', weekday: 3 },
    });

    expect(new Set(firstCycle.map((assignment) => assignment.templateId)).size).toBe(3);
    expect(firstCycle.map((assignment) => assignment.blockCycle)).toEqual([0, 0, 0]);
    expect(secondCycle.blockCycle).toBe(1);
    expect(firstCycle.every((assignment) => assignment.blockId === firstCycle[0].blockId)).toBe(true);
    expect(otherBlock.blockCycle).toBe(0);
    expect(otherBlock.blockId).not.toBe(firstCycle[0].blockId);
  });

  it('keeps registered angle arms and matching blocks stable across pack and weekday changes', async () => {
    const { db, documents } = memoryFirestore();
    const base = {
      db,
      experimentId: 'social-copy-angle-matched-v3',
      channel: 'instagram',
      slot: 'reel',
      objective: 'share',
      registrationHash: 'c'.repeat(64),
      armIds: ['angle-one', 'angle-two', 'angle-three'],
      randomIntImpl: () => 0,
    };
    const firstCycle = await Promise.all([
      assignBalancedSocialCopy({
        ...base, packId: '0123456789abcdef', assignmentKey: 'reel:one',
        blockContext: { contentClass: 'reel', weekday: 1 },
      }),
      assignBalancedSocialCopy({
        ...base, packId: 'fedcba9876543210', assignmentKey: 'reel:two',
        blockContext: { contentClass: 'reel', weekday: 4 },
      }),
      assignBalancedSocialCopy({
        ...base, packId: '1123456789abcdef', assignmentKey: 'reel:three',
        blockContext: { contentClass: 'reel', weekday: 5 },
      }),
    ]);

    expect(firstCycle.map((assignment) => assignment.armId).sort()).toEqual([...base.armIds].sort());
    expect(new Set(firstCycle.map((assignment) => assignment.blockId)).size).toBe(1);
    expect(firstCycle.map((assignment) => assignment.blockCycle)).toEqual([0, 0, 0]);
    const retry = await assignBalancedSocialCopy({
      ...base,
      packId: 'fedcba9876543210',
      assignmentKey: 'reel:one',
      blockContext: { contentClass: 'reel', weekday: 2 },
    });
    expect(retry).toMatchObject({ armId: 'angle-one', templateId: 'angle-one', reused: true });
    expect(retry.blockId).toBe(firstCycle[0].blockId);

    const published = await markBalancedSocialCopyAssignmentPublished({
      ...base,
      packId: 'fedcba9876543210',
      assignmentKey: 'reel:one',
      attemptId: retry.attemptId,
      postId: '9876543210',
      publishedAt: '2026-11-03T12:00:00.000Z',
    });
    expect(published).toBe(true);
    const records = [...documents.entries()]
      .filter(([key]) => key.startsWith('social_copy_assignment_records/'))
      .map(([, value]) => value);
    expect(records.find((record) => record.postIdHash)?.armId).toBe('angle-one');
    expect(records.find((record) => record.postIdHash)).not.toHaveProperty('templateId');
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

  it('marks accepted exact-ID posts once and refuses to bind an assignment to a second post', async () => {
    const { db, documents } = memoryFirestore();
    const input = {
      db,
      experimentId: 'social-copy-balanced-v1',
      packId: '0123456789abcdef',
      channel: 'instagram',
      slot: 'article',
      objective: 'share',
      registrationHash: 'a'.repeat(64),
      blockContext: { contentClass: 'article', weekday: 2 },
      assignmentKey: 'article:2026-11-03',
      templateIds: ['one', 'two'],
    };
    const assignment = await assignBalancedSocialCopy(input);
    const markInput = {
      ...input,
      attemptId: assignment.attemptId,
      postId: '1234567890',
      publishedAt: '2026-11-03T12:00:00.000Z',
    };

    await expect(markBalancedSocialCopyAssignmentPublished(markInput)).resolves.toBe(true);
    await expect(markBalancedSocialCopyAssignmentPublished(markInput)).resolves.toBe(true);
    await expect(markBalancedSocialCopyAssignmentPublished({ ...markInput, postId: '1234567891' }))
      .rejects.toThrow(/another post/);
    const assignmentRecord = [...documents.entries()]
      .find(([key]) => key.startsWith('social_copy_assignment_records/'))?.[1];
    expect(assignmentRecord).toMatchObject({ status: 'published', registrationHash: 'a'.repeat(64) });
    expect(assignmentRecord).toHaveProperty('postIdHash', expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(JSON.stringify(assignmentRecord)).not.toContain('1234567890');
  });

  it('releases a reservation from its original block even when the retry context changed', async () => {
    const { db, documents } = memoryFirestore();
    const original = {
      db,
      experimentId: 'social-copy-blocked-v1',
      packId: '0123456789abcdef',
      channel: 'instagram',
      slot: 'article',
      objective: 'share',
      assignmentKey: 'article:stable-post',
      blockContext: { contentClass: 'article', weekday: 2 },
      templateIds: ['one', 'two', 'three'],
      randomIntImpl: () => 0,
    };
    const assignment = await assignBalancedSocialCopy(original);
    const retry = await assignBalancedSocialCopy({
      ...original,
      blockContext: { contentClass: 'article', weekday: 3 },
    });

    expect(retry.blockId).toBe(assignment.blockId);
    expect(retry.blockCycle).toBe(assignment.blockCycle);
    expect(await releaseBalancedSocialCopyAssignment({ ...original, attemptId: assignment.attemptId })).toBe(true);
    expect(await releaseBalancedSocialCopyAssignment({ ...original, attemptId: retry.attemptId })).toBe(true);
    const scope = [...documents.values()].find((value) => value.experimentId === original.experimentId);
    const blockCounts = scope?.blockCounts as Record<string, Record<string, number>>;
    expect(blockCounts[assignment.blockId as string]?.[assignment.templateId]).toBe(0);
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
