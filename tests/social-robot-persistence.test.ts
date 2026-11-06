import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { persistBrowserInsights } from '../scripts/social-robot/persist-browser-insights.mjs';

const AS_OF = new Date('2026-11-02T12:00:00.000Z');
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-robot-private-insights-'));
  dirs.push(dir);
  return dir;
}

function fakeDb(initial: Record<string, unknown> | null = null) {
  let stored = initial;
  let writes = 0;
  const reference = {
    get: async () => ({ exists: stored !== null, data: () => stored }),
    set: async (document: Record<string, unknown>) => { stored = structuredClone(document); writes += 1; },
  };
  const db = {
    collection(name: string) {
      expect(name).toBe('social_native_insights');
      return {
        doc(id: string) {
          expect(id).toBe('current');
          return reference;
        },
      };
    },
    runTransaction: async (callback: (transaction: any) => Promise<unknown>) => callback({
      get: (ref: typeof reference) => ref.get(),
      set: (ref: typeof reference, document: Record<string, unknown>) => ref.set(document),
    }),
  };
  return { db, read: () => stored, writes: () => writes };
}

function writeSnapshot(root: string, value: unknown): string {
  const file = path.join(root, 'instagram-insights.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function instagramRow(snapshotAt = '2026-10-13T12:00:00.000Z') {
  return {
    postId: 'media-1',
    mediaId: 'media-1',
    queueId: 'article-2026-10-10',
    kind: 'article',
    day: '2026-10-10',
    snapshotAt,
    snapshotAgeHours: 72,
    windowHours: 72,
    reach: 100,
    saves: 5,
    shares: 2,
    comments: 0,
    availableMetrics: ['reach', 'saves', 'shares', 'comments'],
    copyMode: 'codex',
    copySlot: 'article',
    copyPackId: '0123456789abcdef',
    copyTemplateId: 'clear-question',
    copyAssignmentMode: 'firebase-balanced',
  };
}

function tiktokPost() {
  return {
    channel: 'tiktok',
    postId: 'video-1',
    publishedAt: '2026-10-30T12:00:00.000Z',
    snapshotAt: '2026-11-02T12:00:00.000Z',
    snapshotAgeHours: 72,
    windowHours: 72,
    metrics: { views: 50 },
    availableMetrics: ['views'],
    metricStatus: { views: 'available' },
  };
}

function crossChannelGrowthHistory() {
  const audienceBaseline = {
    schemaVersion: 1,
    channel: 'instagram',
    metric: 'followers',
    startAt: '2026-10-01T12:00:00.000Z',
    endAt: '2026-10-31T12:00:00.000Z',
    startValue: 1000,
    endValue: 1020,
    netChange: 20,
    coverageDays: 30,
    observations: 31,
    frozenAt: '2026-11-02T12:00:00.000Z',
  };
  return {
    audienceBaselines: { instagram: audienceBaseline },
    audienceGrowthCycles: {
      instagram: {
        schemaVersion: 1,
        channel: 'instagram',
        cycleNumber: 1,
        status: 'active',
        currentBaseline: audienceBaseline,
        lastCompleted: null,
      },
    },
    followerGainSnapshots: [{
      channel: 'linkedin-member',
      metric: 'followers-gained',
      date: '2026-11-01',
      value: 2,
      snapshotAt: '2026-11-01T12:00:00.000Z',
      status: 'available',
      source: 'linkedin-member-follower-gains',
    }],
    siteOutcomeSnapshots: [{
      channel: 'facebook',
      eventName: 'job_apply_handoff',
      eventContractVersion: 1,
      date: '2026-11-01',
      timeZone: 'UTC',
      sessions: 50,
      sessionKeyEventRate: 0.04,
      status: 'available',
      source: 'ga4-session-key-event-rate',
    }],
    siteOutcomeBaselines: [{
      schemaVersion: 1,
      channel: 'facebook',
      eventName: 'job_apply_handoff',
      eventContractVersion: 1,
      metric: 'session-key-event-rate',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      timeZone: 'UTC',
      sessions: 1000,
      sessionKeyEventRate: 0.04,
      coverageDays: 30,
      observations: 30,
      frozenAt: '2026-07-01T12:00:00.000Z',
    }],
  };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('persistBrowserInsights', () => {
  it('stores normalized Instagram metrics in private Firestore and removes the uploaded local snapshot', async () => {
    const root = tempDir();
    const snapshot = writeSnapshot(root, { schemaVersion: 2, windowHours: 72, posts: [instagramRow()] });
    const storage = fakeDb();

    await expect(persistBrowserInsights({ snapshot, db: storage.db, now: AS_OF })).resolves.toMatchObject({
      status: 'persisted', imported: 1, posts: 1,
    });

    expect(storage.writes()).toBe(1);
    expect((storage.read() as any).sources.instagram).toMatchObject({
      status: 'available',
      lastAttemptAt: AS_OF.toISOString(),
      lastSuccessAt: AS_OF.toISOString(),
      latestSnapshotAt: '2026-10-13T12:00:00.000Z',
    });
    expect((storage.read() as any).posts[0]).toMatchObject({
      channel: 'instagram', postId: 'media-1', metrics: { reach: 100, saves: 5, comments: 0 },
      copyPackId: '0123456789abcdef',
    });
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  it('preserves other channel observations and replaces an older exact Instagram snapshot', async () => {
    const root = tempDir();
    const older = {
      ...instagramRow('2026-10-13T12:00:00.000Z'),
      channel: 'instagram',
      publishedAt: '2026-10-10T12:00:00.000Z',
      metrics: { reach: 10, saves: 1, shares: 0, comments: 0, views: null, profileVisits: null, linkClicks: null, interactions: null },
      availableMetrics: ['reach', 'saves', 'shares', 'comments'],
      metricStatus: { reach: 'available', saves: 'available', shares: 'available', comments: 'available', views: 'unavailable', profileVisits: 'unavailable', linkClicks: 'unavailable', interactions: 'unavailable' },
    };
    const storage = fakeDb({
      schemaVersion: 1,
      sources: { instagram: { status: 'available' }, tiktok: { status: 'available' } },
      posts: [older, tiktokPost()],
    });
    const snapshot = writeSnapshot(root, { schemaVersion: 2, windowHours: 72, posts: [instagramRow('2026-10-13T13:00:00.000Z')] });

    await persistBrowserInsights({ snapshot, db: storage.db, now: AS_OF });

    const posts = (storage.read() as any).posts;
    expect(posts).toHaveLength(2);
    expect(posts.find((row: any) => row.channel === 'tiktok')?.postId).toBe('video-1');
    expect(posts.find((row: any) => row.channel === 'instagram')?.snapshotAt).toBe('2026-10-13T13:00:00.000Z');
  });

  it('preserves all existing cross-channel growth and site-outcome history', async () => {
    const root = tempDir();
    const history = crossChannelGrowthHistory();
    const storage = fakeDb({
      schemaVersion: 1,
      sources: { tiktok: { status: 'available' } },
      posts: [tiktokPost()],
      audienceSnapshots: [],
      ...history,
    });
    const snapshot = writeSnapshot(root, { schemaVersion: 2, windowHours: 72, posts: [instagramRow()] });

    await persistBrowserInsights({ snapshot, db: storage.db, now: AS_OF });

    expect(storage.read()).toMatchObject(history);
  });

  it('keeps a dry-run snapshot and does not write to Firestore', async () => {
    const root = tempDir();
    const snapshot = writeSnapshot(root, { schemaVersion: 2, windowHours: 72, posts: [instagramRow()] });
    const storage = fakeDb();

    await expect(persistBrowserInsights({ snapshot, db: storage.db, now: AS_OF, dryRun: true })).resolves.toMatchObject({
      status: 'ready', imported: 1,
    });
    expect(storage.writes()).toBe(0);
    expect(fs.existsSync(snapshot)).toBe(true);
  });

  it('retains a snapshot and fails closed when any row cannot be normalized', async () => {
    const root = tempDir();
    const snapshot = writeSnapshot(root, {
      schemaVersion: 2,
      windowHours: 72,
      posts: [instagramRow(), { mediaId: 'invalid-without-snapshot-time' }],
    });
    const storage = fakeDb();

    await expect(persistBrowserInsights({ snapshot, db: storage.db, now: AS_OF }))
      .rejects.toThrow('local snapshot retained');
    expect(storage.writes()).toBe(0);
    expect(fs.existsSync(snapshot)).toBe(true);
  });
});
