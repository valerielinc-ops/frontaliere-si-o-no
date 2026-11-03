import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectSocialPublishLedgerReservations,
  listStaleSocialPublishReservations,
  markSocialPublishReservationPublished,
  reconcileSocialPublishReservationPublished,
  refreshSocialPublishReservation,
  releaseSocialPublishReservation,
  reserveSocialPublishBatch,
  socialPublishContentFingerprint,
  socialPublishReservationKey,
} from '../scripts/lib/social-publish-reservations.mjs';

const roots: string[] = [];

function makeRepoRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'social-publish-reservations-'));
  roots.push(root);
  mkdirSync(path.join(root, 'data'));
  for (const file of [
    'fb-posted-jobs.json',
    'fb-posted-articles.json',
    'fb-posted-events.json',
    'instagram-posted.json',
    'linkedin-member-posted.json',
    'telegram-posted-jobs.json',
    'telegram-posted-announcements.json',
  ]) {
    writeFileSync(path.join(root, 'data', file), `${JSON.stringify({ schemaVersion: 1, posted: [] })}\n`);
  }
  return root;
}

function writeLedger(root: string, file: string, posted: object[]) {
  writeFileSync(path.join(root, 'data', file), `${JSON.stringify({ schemaVersion: 1, posted })}\n`);
}

function memoryFirestore() {
  const documents = new Map<string, Record<string, unknown>>();
  let transactionTail = Promise.resolve();
  const db = {
    collection(name: string) {
      return {
        doc: (id: string) => {
          const ref = { path: `${name}/${id}` };
          return {
            ...ref,
            get: async () => {
              const value = documents.get(ref.path);
              return { exists: value !== undefined, data: () => value ? structuredClone(value) : undefined };
            },
          };
        },
      };
    },
    runTransaction<T>(callback: (transaction: {
      get: (ref: { path: string }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      set: (ref: { path: string }, value: Record<string, unknown>) => void;
      delete: (ref: { path: string }) => void;
    }) => Promise<T>) {
      const run = transactionTail.then(() => callback({
        get: async (ref) => {
          const value = documents.get(ref.path);
          return { exists: value !== undefined, data: () => value ? structuredClone(value) : undefined };
        },
        set: (ref, value) => documents.set(ref.path, structuredClone(value)),
        delete: (ref) => documents.delete(ref.path),
      }));
      transactionTail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return { db, documents };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared social publish reservations', () => {
  it('serializes concurrent Facebook publishers against one Page cap', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const base = {
      db,
      platform: 'facebook' as const,
      accountId: 'page-private-id',
      repoRoot: root,
      cap: 1,
      now: '2026-11-03T12:00:00.000Z',
    };

    const [jobs, articles] = await Promise.all([
      reserveSocialPublishBatch({
        ...base,
        reservations: [{ key: socialPublishReservationKey('facebook', 'job', 'job-1') }],
      }),
      reserveSocialPublishBatch({
        ...base,
        reservations: [{ key: socialPublishReservationKey('facebook', 'article', 'article-1') }],
      }),
    ]);

    expect([jobs[0].allowed, articles[0].allowed].filter(Boolean)).toHaveLength(1);
    expect([jobs[0].reason, articles[0].reason]).toContain('daily-cap');
  });

  it('seeds the shared cap from all existing Page ledgers and ignores digest-covered source rows', async () => {
    const root = makeRepoRoot();
    writeLedger(root, 'fb-posted-jobs.json', [{
      id: 'job-old',
      fbPostId: 'page_post_old',
      scheduledFor: '2026-11-03T08:05:00.000Z',
      actualPublishedAt: '2026-11-03T08:06:00.000Z',
    }]);
    writeLedger(root, 'fb-posted-articles.json', [{ id: 'article-old', ts: '2026-11-03T09:00:00.000Z' }]);
    writeLedger(root, 'fb-posted-events.json', [
      { id: 'event-old', postedAt: '2026-11-03T10:00:00.000Z' },
      { id: 'event-covered', postedAt: '2026-11-03T10:00:00.000Z', viaDigest: 'digest-1' },
    ]);
    const baseline = collectSocialPublishLedgerReservations({
      platform: 'facebook',
      repoRoot: root,
      publishDays: ['2026-11-03'],
    });
    expect(baseline.map((item) => item.key)).toHaveLength(3);

    const { db } = memoryFirestore();
    const result = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      cap: 4,
      now: '2026-11-03T12:00:00.000Z',
      reservations: [{ key: socialPublishReservationKey('facebook', 'event', 'event-new') }],
    });
    expect(result[0]).toMatchObject({ allowed: true, reason: null });
    const blocked = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      cap: 4,
      now: '2026-11-03T12:01:00.000Z',
      reservations: [{ key: socialPublishReservationKey('facebook', 'article', 'article-new') }],
    });
    expect(blocked[0]).toMatchObject({ allowed: false, reason: 'daily-cap' });
  });

  it('applies one account-wide daily cap to LinkedIn article and job posts', async () => {
    const root = makeRepoRoot();
    writeLedger(root, 'linkedin-member-posted.json', [
      { id: 'article-old', kind: 'article', ts: '2026-11-03T08:00:00.000Z', linkedinPostId: 'urn:li:share:old' },
    ]);
    const { db } = memoryFirestore();
    const result = await reserveSocialPublishBatch({
      db,
      platform: 'linkedinMember',
      accountId: 'urn:li:person:member-private-id',
      repoRoot: root,
      now: '2026-11-03T12:00:00.000Z',
      reservations: [
        { key: socialPublishReservationKey('linkedinMember', 'member-post', 'job:job-new') },
        { key: socialPublishReservationKey('linkedinMember', 'member-post', 'article:article-new') },
      ],
    });
    expect(result.map((item) => item.allowed)).toEqual([true, false]);
    expect(result[1].reason).toBe('daily-cap');
  });

  it('counts one Telegram jobs digest for multiple ledger rows and caps all message modes together', async () => {
    const root = makeRepoRoot();
    writeLedger(root, 'telegram-posted-jobs.json', [
      { id: 'job-1', ts: '2026-11-03T08:00:00.000Z' },
      { id: 'job-2', ts: '2026-11-03T08:00:00.000Z' },
    ]);
    const baseline = collectSocialPublishLedgerReservations({
      platform: 'telegram',
      repoRoot: root,
      publishDays: ['2026-11-03'],
    });
    expect(baseline).toHaveLength(1);

    const { db } = memoryFirestore();
    const result = await reserveSocialPublishBatch({
      db,
      platform: 'telegram',
      accountId: '@frontaliere-channel',
      repoRoot: root,
      now: '2026-11-03T12:00:00.000Z',
      reservations: [
        { key: socialPublishReservationKey('telegram', 'jobs-digest', 'jobs:2026-11-03') },
        { key: socialPublishReservationKey('telegram', 'border-digest', 'border:2026-W45') },
      ],
    });
    expect(result.map((item) => item.allowed)).toEqual([true, false]);
    expect(result[1].reason).toBe('daily-cap');
  });

  it('holds an unresolved Telegram jobs digest across Zurich midnight even when its daily key changes', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const firstKey = socialPublishReservationKey('telegram', 'jobs-digest', '2026-11-03');
    const first = await reserveSocialPublishBatch({
      db,
      platform: 'telegram',
      accountId: '@frontaliere-channel',
      repoRoot: root,
      cap: 2,
      now: '2026-11-03T22:30:00.000Z',
      reservations: [{ key: firstKey, publishAt: '2026-11-03T22:30:00.000Z', pendingGroup: 'telegram-jobs-digest' }],
    });
    expect(first[0].allowed).toBe(true);

    const nextDay = await reserveSocialPublishBatch({
      db,
      platform: 'telegram',
      accountId: '@frontaliere-channel',
      repoRoot: root,
      cap: 2,
      now: '2026-11-03T23:30:00.000Z',
      reservations: [{
        key: socialPublishReservationKey('telegram', 'jobs-digest', '2026-11-04'),
        publishAt: '2026-11-03T23:30:00.000Z',
        pendingGroup: 'telegram-jobs-digest',
      }],
    });
    expect(nextDay[0]).toMatchObject({ allowed: false, reason: 'pending-publish-reconciliation' });
  });

  it('allows LinkedIn member evergreen content again after the 30-day publisher dedup window', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const key = socialPublishReservationKey('linkedinMember', 'member-post', 'article:evergreen-guide');
    const first = await reserveSocialPublishBatch({
      db,
      platform: 'linkedinMember',
      accountId: 'urn:li:person:member-private-id',
      repoRoot: root,
      now: '2026-10-01T12:00:00.000Z',
      reservations: [{ key, publishAt: '2026-10-01T12:00:00.000Z' }],
    });
    expect(first[0].allowed).toBe(true);
    await markSocialPublishReservationPublished({
      db,
      platform: 'linkedinMember',
      accountId: 'urn:li:person:member-private-id',
      key,
      publishAt: '2026-10-01T12:00:00.000Z',
      publishedAt: '2026-10-01T12:01:00.000Z',
      now: '2026-10-01T12:01:00.000Z',
    });

    const afterDedupWindow = await reserveSocialPublishBatch({
      db,
      platform: 'linkedinMember',
      accountId: 'urn:li:person:member-private-id',
      repoRoot: root,
      now: '2026-11-02T12:00:00.000Z',
      reservations: [{ key, publishAt: '2026-11-02T12:00:00.000Z' }],
    });
    expect(afterDedupWindow[0]).toMatchObject({ allowed: true, reason: null });
  });

  it('releases a definite failure after a LinkedIn identity marker expires', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const key = socialPublishReservationKey('linkedinMember', 'member-post', 'article:evergreen-release');
    await reserveSocialPublishBatch({
      db, platform: 'linkedinMember', accountId: 'urn:li:person:member-private-id', repoRoot: root,
      now: '2026-10-01T12:00:00.000Z', reservations: [{ key, publishAt: '2026-10-01T12:00:00.000Z' }],
    });
    await markSocialPublishReservationPublished({
      db, platform: 'linkedinMember', accountId: 'urn:li:person:member-private-id', key,
      publishAt: '2026-10-01T12:00:00.000Z', publishedAt: '2026-10-01T12:01:00.000Z', now: '2026-10-01T12:01:00.000Z',
    });
    const retry = await reserveSocialPublishBatch({
      db, platform: 'linkedinMember', accountId: 'urn:li:person:member-private-id', repoRoot: root,
      now: '2026-11-02T12:00:00.000Z', reservations: [{ key, publishAt: '2026-11-02T12:00:00.000Z' }],
    });
    expect(retry[0].allowed).toBe(true);
    await expect(releaseSocialPublishReservation({
      db, platform: 'linkedinMember', accountId: 'urn:li:person:member-private-id', key,
      publishAt: '2026-11-02T12:00:00.000Z', now: '2026-11-02T12:01:00.000Z',
    })).resolves.toBe(true);
    const afterRelease = await reserveSocialPublishBatch({
      db, platform: 'linkedinMember', accountId: 'urn:li:person:member-private-id', repoRoot: root,
      now: '2026-11-02T12:02:00.000Z', reservations: [{ key, publishAt: '2026-11-02T12:02:00.000Z' }],
    });
    expect(afterRelease[0].allowed).toBe(true);
  });

  it('reuses a published identity, releases a definite failure, and keeps status transitions idempotent', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const input = {
      db,
      platform: 'instagram' as const,
      accountId: 'instagram-private-id',
      repoRoot: root,
      cap: 1,
      now: '2026-11-03T12:00:00.000Z',
      reservations: [{ key: socialPublishReservationKey('instagram', 'post', 'article-2026-11-03') }],
    };

    expect((await reserveSocialPublishBatch(input))[0].allowed).toBe(true);
    expect((await reserveSocialPublishBatch(input))[0].reason).toBe('already-reserved');
    const reservation = input.reservations[0];
    const update = {
      db,
      platform: input.platform,
      accountId: input.accountId,
      key: reservation.key,
      publishAt: input.now,
    };
    expect(await releaseSocialPublishReservation(update)).toBe(true);
    expect((await reserveSocialPublishBatch(input))[0].allowed).toBe(true);
    expect(await markSocialPublishReservationPublished(update)).toBe(true);
    expect(await markSocialPublishReservationPublished(update)).toBe(true);
    expect(await releaseSocialPublishReservation(update)).toBe(false);
    expect((await reserveSocialPublishBatch(input))[0].reason).toBe('already-published');
  });

  it('reports only stale unresolved reservations for the exact account scope without returning raw keys', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const staleKey = socialPublishReservationKey('instagram', 'post', 'private-content-slug');
    const staleFingerprint = socialPublishContentFingerprint('instagram', { caption: 'Private caption content' });
    await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      accountId: 'instagram-account-private',
      repoRoot: root,
      now: '2026-11-03T08:00:00.000Z',
      reservations: [
        { key: staleKey, publishAt: '2026-11-03T08:00:00.000Z', nativeContentFingerprint: staleFingerprint, pendingGroup: 'instagram-daily-post' },
        { key: socialPublishReservationKey('instagram', 'post', 'future-content'), publishAt: '2026-11-03T12:00:00.000Z' },
      ],
    });

    const rows = await listStaleSocialPublishReservations({
      db,
      platform: 'instagram',
      accountId: 'instagram-account-private',
      now: '2026-11-03T09:00:00.000Z',
      minimumAgeMs: 30 * 60 * 1000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: 'instagram',
      capGroup: 'feed',
      keyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reservedDay: '2026-11-03',
      publishAt: '2026-11-03T08:00:00.000Z',
      ageMs: 60 * 60 * 1000,
      fingerprintAvailable: true,
      pendingGroup: 'instagram-daily-post',
    });
    expect(JSON.stringify(rows)).not.toContain('private-content-slug');
    expect(JSON.stringify(rows)).not.toContain('instagram-account-private');
    expect(JSON.stringify(rows)).not.toContain('future-content');
  });

  it('reconciles a stale reservation only from exact verified post evidence and writes hashed audit data', async () => {
    const root = makeRepoRoot();
    const { db, documents } = memoryFirestore();
    const key = socialPublishReservationKey('facebook', 'article', 'article-secret-slug');
    const nativeContentFingerprint = socialPublishContentFingerprint('facebook', {
      message: 'A verified article caption',
      link: 'https://frontaliereticino.ch/blog/article-secret-slug/',
    });
    await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      now: '2026-11-03T08:00:00.000Z',
      reservations: [{ key, publishAt: '2026-11-03T08:00:00.000Z', nativeContentFingerprint }],
    });
    const [stale] = await listStaleSocialPublishReservations({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      now: '2026-11-03T09:00:00.000Z',
    });

    await expect(reconcileSocialPublishReservationPublished({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      keyHash: stale.keyHash,
      nativePostId: '123456_987654',
      provider: 'facebook-graph',
      nativeContentFingerprint: socialPublishContentFingerprint('facebook', { message: 'A different caption', link: 'https://frontaliereticino.ch/blog/other/' }),
      publishedAt: '2026-11-03T08:05:00.000Z',
      verifiedAt: '2026-11-03T09:00:00.000Z',
    })).rejects.toThrow('social publish reservation is not stale and unresolved for this account');
    await expect(reconcileSocialPublishReservationPublished({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      keyHash: stale.keyHash,
      nativePostId: '123456_987654',
      provider: 'facebook-graph',
      nativeContentFingerprint,
      publishedAt: '2026-11-03T08:05:00.000Z',
      verifiedAt: '2026-11-03T09:00:00.000Z',
    })).resolves.toBe(true);

    const docs = [...documents.entries()];
    const reservationDoc = docs.find(([path]) => path.includes('facebook_'))?.[1];
    expect(reservationDoc?.pending).not.toHaveProperty(stale.keyHash);
    expect(Object.values(reservationDoc?.days || {}).flatMap((bucket: any) => Object.values(bucket.reservations)))
      .toContainEqual(expect.objectContaining({
        keyHash: stale.keyHash,
        status: 'published',
        publishAt: '2026-11-03T08:05:00.000Z',
        nativePostIdHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }));
    const audit = docs.map(([, value]) => value).find((value) => value.kind === 'exact-native-post-reconciliation');
    expect(audit).toMatchObject({
      platform: 'facebook',
      keyHash: stale.keyHash,
      nativePostIdHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      provider: 'facebook-graph',
      publishedAt: '2026-11-03T08:05:00.000Z',
      verifiedAt: '2026-11-03T09:00:00.000Z',
    });
    expect(JSON.stringify(docs)).not.toContain('123456_987654');
    expect(JSON.stringify(docs)).not.toContain('article-secret-slug');
  });

  it('keeps recent, wrong-provider, and unsupported-platform reservations unresolved', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const key = socialPublishReservationKey('telegram', 'announcement', 'alert-1');
    await reserveSocialPublishBatch({
      db,
      platform: 'telegram',
      accountId: '@frontaliere-channel',
      repoRoot: root,
      now: '2026-11-03T08:00:00.000Z',
      reservations: [{ key, publishAt: '2026-11-03T08:00:00.000Z' }],
    });
    const [stale] = await listStaleSocialPublishReservations({
      db,
      platform: 'telegram',
      accountId: '@frontaliere-channel',
      now: '2026-11-03T09:00:00.000Z',
    });
    await expect(reconcileSocialPublishReservationPublished({
      db,
      platform: 'telegram',
      accountId: '@frontaliere-channel',
      keyHash: stale.keyHash,
      nativePostId: '42',
      provider: 'telegram-bot-api',
      publishedAt: '2026-11-03T08:01:00.000Z',
      verifiedAt: '2026-11-03T09:00:00.000Z',
    })).rejects.toThrow('invalid exact native-post reconciliation evidence');
    await expect(reconcileSocialPublishReservationPublished({
      db,
      platform: 'telegram',
      accountId: '@frontaliere-channel',
      keyHash: stale.keyHash,
      nativePostId: '42',
      provider: 'facebook-graph',
      publishedAt: '2026-11-03T08:01:00.000Z',
      verifiedAt: '2026-11-03T09:00:00.000Z',
    })).rejects.toThrow('invalid exact native-post reconciliation evidence');
  });

  it('keeps Instagram Story reservations in their own cap while feed/Reel posts share the feed cap', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const accountId = 'instagram-private-id';
    const now = '2026-11-03T12:00:00.000Z';
    const feed = await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      accountId,
      repoRoot: root,
      cap: 1,
      now,
      reservations: [{ key: socialPublishReservationKey('instagram', 'post', 'article-1') }],
    });
    const story = await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      capGroup: 'story',
      accountId,
      repoRoot: root,
      cap: 1,
      now,
      reservations: [{ key: socialPublishReservationKey('instagram', 'story', 'follow-up-1') }],
    });
    expect(feed[0].allowed).toBe(true);
    expect(story[0].allowed).toBe(true);

    const overCapStory = await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      capGroup: 'story',
      accountId,
      repoRoot: root,
      cap: 1,
      now,
      reservations: [{ key: socialPublishReservationKey('instagram', 'story', 'follow-up-2') }],
    });
    expect(overCapStory[0]).toMatchObject({ allowed: false, reason: 'daily-cap' });
  });

  it('blocks an unresolved content identity across days and beyond daily-bucket retention', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const base = {
      db,
      platform: 'facebook' as const,
      accountId: 'page-private-id',
      repoRoot: root,
      cap: 1,
    };
    const original = socialPublishReservationKey('facebook', 'job', 'job-uncertain');
    const first = await reserveSocialPublishBatch({
      ...base,
      now: '2026-11-03T12:00:00.000Z',
      reservations: [{ key: original, publishAt: '2026-11-03T13:00:00.000Z' }],
    });
    expect(first[0].allowed).toBe(true);

    const nextDay = await reserveSocialPublishBatch({
      ...base,
      now: '2026-11-04T12:00:00.000Z',
      reservations: [{ key: original, publishAt: '2026-11-04T13:00:00.000Z' }],
    });
    expect(nextDay[0]).toMatchObject({ allowed: false, reason: 'already-reserved' });

    const independent = await reserveSocialPublishBatch({
      ...base,
      now: '2026-11-04T12:01:00.000Z',
      reservations: [{ key: socialPublishReservationKey('facebook', 'job', 'job-independent') }],
    });
    expect(independent[0].allowed).toBe(true);

    const beyondRetention = await reserveSocialPublishBatch({
      ...base,
      now: '2026-11-10T12:00:00.000Z',
      reservations: [{ key: original, publishAt: '2026-11-10T13:00:00.000Z' }],
    });
    expect(beyondRetention[0]).toMatchObject({ allowed: false, reason: 'already-reserved' });

    await expect(releaseSocialPublishReservation({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      key: original,
      publishAt: '2026-11-03T13:00:00.000Z',
    })).resolves.toBe(true);
  });

  it('charges a confirmed post to its actual Zurich day when publication crosses midnight', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const originalKey = socialPublishReservationKey('facebook', 'article', 'article-before-midnight');
    const reservation = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      cap: 2,
      now: '2026-11-03T22:59:00.000Z', // 23:59 in Europe/Zurich
      reservations: [{ key: originalKey, publishAt: '2026-11-03T22:59:00.000Z' }],
    });
    expect(reservation[0].allowed).toBe(true);

    const mark = {
      db,
      platform: 'facebook' as const,
      accountId: 'page-private-id',
      key: originalKey,
      publishAt: '2026-11-03T22:59:00.000Z',
      publishedAt: '2026-11-03T23:00:00.000Z', // 00:00 on Nov 4 in Europe/Zurich
    };
    expect(await markSocialPublishReservationPublished(mark)).toBe(true);
    expect(await markSocialPublishReservationPublished(mark)).toBe(true);

    const nextDay = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      cap: 2,
      now: '2026-11-03T23:10:00.000Z',
      reservations: [
        { key: socialPublishReservationKey('facebook', 'article', 'article-after-midnight-1'), publishAt: '2026-11-03T23:10:00.000Z' },
        { key: socialPublishReservationKey('facebook', 'article', 'article-after-midnight-2'), publishAt: '2026-11-03T23:11:00.000Z' },
      ],
    });
    expect(nextDay.map(({ allowed }) => allowed)).toEqual([true, false]);
    expect(nextDay.map(({ reason }) => reason)).toEqual([null, 'daily-cap']);
  });

  it('holds a possible midnight-crossing publish against both days until reconciliation', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const first = await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      accountId: 'instagram-private-id',
      repoRoot: root,
      cap: 1,
      now: '2026-11-03T22:40:00.000Z', // 23:40 in Zurich, within the rollover guard
      reservations: [{
        key: socialPublishReservationKey('instagram', 'post', 'ambiguous-before-midnight'),
        publishAt: '2026-11-03T22:40:00.000Z',
      }],
    });
    expect(first[0].allowed).toBe(true);

    const afterMidnight = await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      accountId: 'instagram-private-id',
      repoRoot: root,
      cap: 1,
      now: '2026-11-03T23:10:00.000Z', // 00:10 the next Zurich day
      reservations: [{
        key: socialPublishReservationKey('instagram', 'post', 'new-post-after-midnight'),
        publishAt: '2026-11-03T23:10:00.000Z',
      }],
    });
    expect(afterMidnight[0]).toMatchObject({ allowed: false, reason: 'daily-cap' });
  });

  it('denies a near-midnight reservation when the destination-day cap is already full', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const nextDayPost = await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      accountId: 'instagram-private-id',
      repoRoot: root,
      cap: 1,
      now: '2026-11-03T22:00:00.000Z', // 23:00 in Zurich
      reservations: [{
        key: socialPublishReservationKey('instagram', 'post', 'already-scheduled-next-day'),
        publishAt: '2026-11-03T23:30:00.000Z', // 00:30 the next Zurich day
      }],
    });
    expect(nextDayPost[0].allowed).toBe(true);

    const nearMidnightPost = await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      accountId: 'instagram-private-id',
      repoRoot: root,
      cap: 1,
      now: '2026-11-03T22:40:00.000Z', // 23:40 in Zurich
      reservations: [{
        key: socialPublishReservationKey('instagram', 'post', 'possible-rollover-post'),
        publishAt: '2026-11-03T22:40:00.000Z',
      }],
    });
    expect(nearMidnightPost[0]).toMatchObject({ allowed: false, reason: 'daily-cap' });
  });

  it('reconciles a pending identity from a late ledger row outside the daily-cap window', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const key = socialPublishReservationKey('facebook', 'job', 'job-late-ledger');
    const first = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      now: '2026-11-03T12:00:00.000Z',
      reservations: [{ key, publishAt: '2026-11-03T13:00:00.000Z' }],
    });
    expect(first[0].allowed).toBe(true);

    writeLedger(root, 'fb-posted-jobs.json', [{
      id: 'job-late-ledger',
      fbPostId: 'page_post',
      scheduledFor: '2026-11-03T13:00:00.000Z',
      actualPublishedAt: '2026-11-03T13:02:00.000Z',
    }]);
    const reconciled = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      now: '2026-11-10T12:00:00.000Z',
      reservations: [{ key, publishAt: '2026-11-10T13:00:00.000Z' }],
    });
    expect(reconciled[0]).toMatchObject({ allowed: false, reason: 'already-published' });
  });

  it('does not count a future Facebook schedule as published before native reconciliation', () => {
    const root = makeRepoRoot();
    writeLedger(root, 'fb-posted-jobs.json', [{
      id: 'job-not-yet-live',
      fbPostId: 'page_post',
      scheduledFor: '2026-11-03T13:00:00.000Z',
      ts: '2026-11-02T13:00:00.000Z',
    }]);

    expect(collectSocialPublishLedgerReservations({ platform: 'facebook', repoRoot: root }))
      .toEqual([]);
  });

  it('attributes a reconciled Facebook schedule to Meta’s actual Europe/Zurich day', () => {
    const root = makeRepoRoot();
    writeLedger(root, 'fb-posted-jobs.json', [{
      id: 'job-actual-day',
      fbPostId: 'page_post',
      scheduledFor: '2026-11-02T22:55:00.000Z',
      actualPublishedAt: '2026-11-02T23:04:00.000Z',
    }]);

    expect(collectSocialPublishLedgerReservations({
      platform: 'facebook',
      repoRoot: root,
      publishDays: ['2026-11-02'],
    })).toEqual([]);
    expect(collectSocialPublishLedgerReservations({
      platform: 'facebook',
      repoRoot: root,
      publishDays: ['2026-11-03'],
    })).toEqual([expect.objectContaining({ publishAt: '2026-11-02T23:04:00.000Z' })]);
  });

  it('reserves a Facebook schedule on its planned and next day until actual publication is known', async () => {
    const root = makeRepoRoot();
    const { db, documents } = memoryFirestore();
    const key = socialPublishReservationKey('facebook', 'job', 'job-rollover');
    const reserved = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      now: '2026-11-02T12:00:00.000Z',
      reservations: [{ key, publishAt: '2026-11-02T22:55:00.000Z', reserveNextDay: true }],
    });
    expect(reserved[0].allowed).toBe(true);
    const reservationDoc = [...documents.entries()].find(([name]) => name.startsWith('social_publish_reservations/facebook_'))?.[1];
    expect(reservationDoc?.days).toHaveProperty('2026-11-02');
    expect(reservationDoc?.days).toHaveProperty('2026-11-03');

    expect(await refreshSocialPublishReservation({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      key,
      publishAt: '2026-11-04T12:00:00.000Z',
      now: '2026-11-04T12:00:00.000Z',
      unpublishedConfirmed: true,
    })).toBe(true);
    const refreshed = [...documents.entries()].find(([name]) => name.startsWith('social_publish_reservations/facebook_'))?.[1];
    expect(refreshed?.days).not.toHaveProperty('2026-11-02');
    expect(refreshed?.days).toHaveProperty('2026-11-04');
    expect(refreshed?.days).toHaveProperty('2026-11-05');
  });

  it('keeps the prior Facebook hold when refreshed target-day buckets are at cap', async () => {
    const root = makeRepoRoot();
    const { db, documents } = memoryFirestore();
    const holdKey = socialPublishReservationKey('facebook', 'job', 'job-still-pending');
    const fullKey = socialPublishReservationKey('facebook', 'job', 'job-day-full');
    await reserveSocialPublishBatch({
      db, platform: 'facebook', accountId: 'page-private-id', repoRoot: root, cap: 1,
      now: '2026-11-02T12:00:00.000Z',
      reservations: [{ key: holdKey, publishAt: '2026-11-02T12:00:00.000Z' }],
    });
    const fullReservation = await reserveSocialPublishBatch({
      db, platform: 'facebook', accountId: 'page-private-id', repoRoot: root, cap: 1,
      now: '2026-11-02T12:01:00.000Z',
      reservations: [{ key: fullKey, publishAt: '2026-11-04T12:00:00.000Z' }],
    });
    expect(fullReservation[0].allowed).toBe(true);
    await markSocialPublishReservationPublished({
      db, platform: 'facebook', accountId: 'page-private-id', key: fullKey,
      publishAt: '2026-11-04T12:00:00.000Z', publishedAt: '2026-11-04T12:00:00.000Z', now: '2026-11-04T12:00:00.000Z',
    });
    const fullDay = [...documents.values()].find((value) => value.platform === 'facebook')?.days?.['2026-11-04'];
    expect(fullDay?.cap).toBe(1);
    expect(Object.values(fullDay?.reservations || {})).toContainEqual(expect.objectContaining({ status: 'published' }));

    await expect(refreshSocialPublishReservation({
      db, platform: 'facebook', accountId: 'page-private-id', key: holdKey,
      publishAt: '2026-11-04T12:00:00.000Z', now: '2026-11-04T12:01:00.000Z', unpublishedConfirmed: true,
    })).resolves.toBe(false);
    const reservationDoc = [...documents.entries()].find(([name]) => name.startsWith('social_publish_reservations/facebook_'))?.[1];
    expect(Object.values(reservationDoc?.pending || {})).toContainEqual(expect.objectContaining({
      keyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      day: '2026-11-02',
      status: 'reserved',
    }));
  });

  it('corrects an old planned-day identity to Meta’s actual publication day', async () => {
    const root = makeRepoRoot();
    const { db, documents } = memoryFirestore();
    const key = socialPublishReservationKey('facebook', 'job', 'job-actual-day');
    const plannedAt = '2026-11-02T22:55:00.000Z';
    const actualAt = '2026-11-02T23:04:00.000Z';
    await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      now: '2026-11-02T12:00:00.000Z',
      reservations: [{ key, publishAt: plannedAt }],
    });
    await markSocialPublishReservationPublished({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      key,
      publishAt: plannedAt,
      publishedAt: plannedAt,
    });
    await markSocialPublishReservationPublished({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      key,
      publishAt: actualAt,
      publishedAt: actualAt,
    });

    const reservationDoc = [...documents.entries()].find(([name]) => name.startsWith('social_publish_reservations/facebook_'))?.[1];
    expect(reservationDoc?.days).not.toHaveProperty('2026-11-02');
    const actualDayReservations = Object.values(reservationDoc?.days?.['2026-11-03']?.reservations || {});
    expect(actualDayReservations).toHaveLength(1);
    expect(actualDayReservations[0]).toMatchObject({ status: 'published', publishAt: actualAt });
    const identity = [...documents.entries()].find(([name]) => name.startsWith('social_publish_reservations/published_'))?.[1];
    expect(identity?.publishedAt).toBe(actualAt);
  });

  it('keeps confirmed publisher identities deduplicated after daily buckets expire', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    const key = socialPublishReservationKey('facebook', 'article', 'manual-article-without-ledger-write');
    const publishAt = '2026-11-03T12:00:00.000Z';
    const first = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      now: publishAt,
      reservations: [{ key, publishAt }],
    });
    expect(first[0].allowed).toBe(true);
    expect(await markSocialPublishReservationPublished({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      key,
      publishAt,
      publishedAt: publishAt,
    })).toBe(true);

    const afterRetention = await reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      now: '2026-11-10T12:00:00.000Z',
      reservations: [{ key, publishAt: '2026-11-10T12:00:00.000Z' }],
    });
    expect(afterRetention[0]).toMatchObject({ allowed: false, reason: 'already-published' });
  });

  it('does not persist account ids, content ids, captions, or destination URLs', async () => {
    const root = makeRepoRoot();
    const { db, documents } = memoryFirestore();
    await reserveSocialPublishBatch({
      db,
      platform: 'instagram',
      accountId: 'instagram-private-id',
      repoRoot: root,
      now: '2026-11-03T12:00:00.000Z',
      reservations: [{
        key: socialPublishReservationKey('instagram', 'post', 'source-private-id'),
        caption: 'private caption',
        url: 'https://private.example/path/',
      }],
    });
    const serialized = JSON.stringify([...documents.values()]);
    expect(serialized).not.toContain('instagram-private-id');
    expect(serialized).not.toContain('source-private-id');
    expect(serialized).not.toContain('private caption');
    expect(serialized).not.toContain('private.example');
  });

  it('fails closed for an absent or malformed ledger', async () => {
    const root = makeRepoRoot();
    const { db } = memoryFirestore();
    rmSync(path.join(root, 'data', 'fb-posted-events.json'));
    await expect(reserveSocialPublishBatch({
      db,
      platform: 'facebook',
      accountId: 'page-private-id',
      repoRoot: root,
      reservations: [{ key: socialPublishReservationKey('facebook', 'job', 'job-1') }],
    })).rejects.toThrow(/Required social publish ledger is missing/);
  });
});
