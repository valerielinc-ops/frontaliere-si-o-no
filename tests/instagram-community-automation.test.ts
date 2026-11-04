// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildDirectMessageReply,
  buildPrivateReply,
  buildPublicCommentReply,
  listConversations,
  loadCommunityState,
  matchLedgerGroupsToMedia,
  resolveInstagramCommunityMode,
  runInstagramCommunityAutomation,
  shouldSendPrivateReply,
} from '../scripts/lib/instagram-community-automation.mjs';
import { mergeInstagramCommunityOutcomeSnapshots } from '../scripts/lib/instagram-community-outcomes.mjs';
import { socialCopyRevisionId } from '../scripts/lib/social-copy-revision.mjs';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const STORY_PUBLISHED_AT = new Date('2026-10-10T12:15:00.000Z');

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fakeInstagramFetch({ comments = [{ id: 'comment-1', text: '1', from: { id: 'person-1' }, timestamp: '2026-10-10T11:00:00.000Z' }] } = {}) {
  const calls: { url: string; options: any }[] = [];
  const fetchImpl = async (url: string, options: any = {}) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    const method = options.method || 'GET';
    if (method === 'GET' && parsed.pathname.endsWith('/account-1/media')) {
      return response({ data: [{
        id: 'media-1',
        timestamp: '2026-10-09T06:00:00.000Z',
        media_type: 'CAROUSEL_ALBUM',
        permalink: 'https://instagram.test/p/1',
        media_url: 'https://cdn.test/story.jpg',
      }] });
    }
    if (method === 'GET' && parsed.pathname.endsWith('/media-1/comments')) {
      return response({ data: comments });
    }
    if (method === 'GET' && parsed.pathname.endsWith('/account-1/conversations')) {
      return response({ data: [{ id: 'conversation-1' }] });
    }
    if (method === 'GET' && parsed.pathname.endsWith('/conversation-1/messages')) {
      return response({ data: [{
        id: 'message-1',
        from: { id: 'person-1' },
        message: 'Mi mandi il link?',
        created_time: '2026-10-10T11:30:00.000Z',
      }] });
    }
    if (method === 'GET' && parsed.pathname.endsWith('/story-container')) {
      return response({ status_code: 'FINISHED' });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/account-1/media')) {
      return response({ id: 'story-container' });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/comment-1/replies')) {
      return response({ id: 'reply-1' });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/comment-1/private_replies')) {
      return response({ id: 'private-1' });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/account-1/messages')) {
      return response({ message_id: 'sent-1' });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/account-1/media_publish')) {
      return response({ id: 'story-1' });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function ledger() {
  return {
    posted: [{
      id: 'article-1',
      kind: 'article',
      day: '2026-10-09',
      ts: '2026-10-09T06:00:00.000Z',
      instagramMediaId: 'media-1',
      creativeId: 'question-choice',
      primaryMetric: 'comments',
      followUpFormat: 'story-result',
      copyPackId: '0123456789abcdef',
      copyTemplateId: 'clear-question',
      copyAngleId: 'practical-question',
      copyPillarId: 'useful-tools',
      copyHook: 'Traffico al valico',
      copyCta: 'Controlla ora',
    }],
  };
}

const verifiedPermissionProbe = async () => ({
  permissionStatuses: {
    instagram_basic: 'granted',
    instagram_content_publish: 'granted',
    instagram_manage_comments: 'granted',
    instagram_manage_messages: 'granted',
    pages_manage_metadata: 'granted',
  },
});
const verifiedPageLinkProbe = async () => ({
  pageLinkStatus: 'matched',
  publisherTokenSourceStatus: 'matched',
  pageTaskStatuses: { createContent: 'granted', moderate: 'granted', messaging: 'granted' },
});
const verifiedPublisherTokenProbe = async () => ({ publisherTokenStatus: 'matched' });

function runWithVerifiedPermissions(options: Parameters<typeof runInstagramCommunityAutomation>[0]) {
  return runInstagramCommunityAutomation({
    ...options,
    permissionProbe: verifiedPermissionProbe,
    publisherTokenProbe: verifiedPublisherTokenProbe,
    pageLinkProbe: verifiedPageLinkProbe,
  });
}

function storyReservationClient(allowed = true) {
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      reserveBatch: async (args: Record<string, unknown>) => {
        calls.push({ action: 'reserve', args });
        const reservations = args.reservations as Array<{ key: string }>;
        return reservations.map(({ key }) => ({ key, allowed, reason: allowed ? null : 'daily-cap' }));
      },
      markPublished: async (args: Record<string, unknown>) => { calls.push({ action: 'published', args }); return true; },
      release: async (args: Record<string, unknown>) => { calls.push({ action: 'released', args }); return true; },
    },
  };
}

describe('Instagram community automation', () => {
  it('uses the existing Firebase-controlled live switch and defaults safely', () => {
    expect(resolveInstagramCommunityMode({})).toBe('dry');
    expect(resolveInstagramCommunityMode({ SOCIAL_ROBOT_MODE: 'live' })).toBe('live');
    expect(resolveInstagramCommunityMode({ SOCIAL_ROBOT_MODE: 'off' })).toBe('off');
  });

  it('rejects ambiguous timestamp joins instead of replying under the wrong post', () => {
    const result = matchLedgerGroupsToMedia(
      [{ identity: 'q-1', publishedAtMs: Date.parse('2026-10-09T06:00:00.000Z'), mediaId: null }],
      [
        { id: 'm-1', timestamp: '2026-10-09T05:59:30.000Z' },
        { id: 'm-2', timestamp: '2026-10-09T06:00:30.000Z' },
      ],
    );
    expect(result.matches).toHaveLength(0);
    expect(result.unmatched[0].reason).toBe('ambiguous-media-timestamp');
  });

  it('uses the Page Conversations surface when Facebook Login credentials are available', async () => {
    const calls: { url: string; options: any }[] = [];
    await listConversations('ig-1', 'ig-token', {
      pageId: 'page-1',
      pageAccessToken: 'page-token',
      fetchImpl: async (url: string, options: any) => {
        calls.push({ url, options });
        return response({ data: [] });
      },
    });
    expect(new URL(calls[0].url).pathname).toContain('/page-1/conversations');
    expect(calls[0].options.headers.Authorization).toBe('Bearer page-token');
  });

  it('builds restrained automatic replies and only opens a private reply for an actionable request', () => {
    expect(shouldSendPrivateReply('1')).toBe(true);
    expect(shouldSendPrivateReply('bellissimo post')).toBe(false);
    expect(buildPublicCommentReply({ commentText: '1', primaryMetric: 'comments' })).toContain('scelto 1');
    expect(buildPrivateReply({ permalink: 'https://instagram.test/p/1' })).toContain('https://instagram.test/p/1');
    expect(buildDirectMessageReply({ message: 'mi mandi il link?' })).toContain('frontaliereticino.ch/');
  });

  it('replies to comments, inbound DMs and publishes one Story, then deduplicates the next pass', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'instagram-community-'));
    const statePath = path.join(temp, 'nested', 'state.json');
    const first = fakeInstagramFetch();
    const reservations = storyReservationClient();
    const firstResult = await runWithVerifiedPermissions({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      clock: () => STORY_PUBLISHED_AT,
      fetchImpl: first.fetchImpl,
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
      socialPublishReservations: reservations.client,
    });

    expect(firstResult).toMatchObject({
      status: 'completed',
      commentsSeen: 1,
      commentsReplied: 1,
      privateRepliesSent: 1,
      conversationsSeen: 1,
      directMessagesSent: 1,
      storiesPublished: 1,
    });
    expect(firstResult.publishedStories).toEqual([{
      storyId: 'story-1',
      sourceMediaId: 'media-1',
      publishedAt: STORY_PUBLISHED_AT.toISOString(),
      followUpFormat: 'story-result',
      copyPackId: '0123456789abcdef',
      copyTemplateId: 'clear-question',
      copyAngleId: 'practical-question',
      copyPillarId: 'useful-tools',
      copyRevisionId: socialCopyRevisionId({ copyHook: 'Traffico al valico', copyCta: 'Controlla ora' }),
    }]);
    expect(first.calls.every(({ url }) => !url.includes('token-never-printed'))).toBe(true);
    expect(reservations.calls.map(({ action }) => action)).toEqual(['reserve', 'published']);
    expect(reservations.calls[0].args).toMatchObject({
      platform: 'instagram', capGroup: 'story', accountId: 'account-1',
    });
    expect(readFileSync(statePath, 'utf8')).not.toContain('comment-1');
    expect(readFileSync(statePath, 'utf8')).not.toContain('message-1');

    const second = fakeInstagramFetch();
    const secondResult = await runWithVerifiedPermissions({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      fetchImpl: second.fetchImpl,
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
      socialPublishReservations: reservations.client,
    });
    expect(secondResult).toMatchObject({ commentsSeen: 1, commentsReplied: 0, privateRepliesSent: 0, directMessagesSent: 0, storiesPublished: 0 });
    expect(second.calls.filter(({ options }) => options.method === 'POST')).toHaveLength(0);

    expect(loadCommunityState(statePath).actions).toHaveLength(4);
    rmSync(temp, { recursive: true, force: true });
  });

  it('stores only hashed topic categories from public questions and applies the ten-comment floor', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'instagram-community-topics-'));
    const statePath = path.join(temp, 'state.json');
    const question = 'Quali documenti servono per il permesso G?';
    const comments = Array.from({ length: 10 }, (_, index) => ({
      id: `topic-comment-${index}`,
      text: question,
      from: { id: `person-${index}` },
      timestamp: '2026-10-10T11:00:00.000Z',
    }));
    const run = fakeInstagramFetch({ comments });
    const result = await runWithVerifiedPermissions({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      fetchImpl: run.fetchImpl,
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
      socialPublishReservations: storyReservationClient().client,
    });
    const persisted = readFileSync(statePath, 'utf8');

    expect(result.outcomes.questionTopicDemand).toMatchObject({
      status: 'available',
      categories: [{ category: 'permessi-amministrazione', countBand: '10-24' }],
    });
    expect(loadCommunityState(statePath).topicSignals).toHaveLength(10);
    expect(persisted).not.toContain(question);
    expect(persisted).not.toContain('topic-comment-0');
    expect(persisted).not.toContain('person-0');
    expect(JSON.stringify(result.outcomes.questionTopicDemand)).not.toContain('topic-comment');
    rmSync(temp, { recursive: true, force: true });
  });

  it('preserves rolling topic demand when a legacy schema-1 collector has no topic result', () => {
    const questionTopicDemand = {
      status: 'available',
      categories: [{ category: 'lavoro-contratti', countBand: '10-24' }],
    };
    const merged = mergeInstagramCommunityOutcomeSnapshots({
      schemaVersion: 2,
      questionTopicDemand,
      weeks: [],
    }, {
      schemaVersion: 1,
      generatedAt: '2026-10-11T12:00:00.000Z',
      latestRun: 'legacy-browser-run',
      weeks: [],
    });
    expect(merged).toMatchObject({ schemaVersion: 2, questionTopicDemand });
  });

  it('does not replay a community POST after its response is lost', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'instagram-community-uncertain-'));
    const statePath = path.join(temp, 'state.json');
    const baseline = fakeInstagramFetch();
    const uncertainCalls: { url: string; options: any }[] = [];
    const firstResult = await runWithVerifiedPermissions({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'POST' && String(url).includes('/comment-1/replies')) {
          uncertainCalls.push({ url: String(url), options });
          throw new Error('network timeout after comment reply');
        }
        return baseline.fetchImpl(url, options);
      },
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
      socialPublishReservations: storyReservationClient().client,
    });
    expect(firstResult.status).toBe('partial');
    expect(uncertainCalls).toHaveLength(1);
    expect(loadCommunityState(statePath).actions).toContainEqual(expect.objectContaining({ status: 'uncertain' }));

    const second = fakeInstagramFetch();
    const secondResult = await runWithVerifiedPermissions({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      fetchImpl: second.fetchImpl,
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
      socialPublishReservations: storyReservationClient().client,
    });
    expect(secondResult.commentsReplied).toBe(0);
    expect(second.calls.some(({ url, options }) => options.method === 'POST' && url.includes('/comment-1/replies'))).toBe(false);
    rmSync(temp, { recursive: true, force: true });
  });

  it('holds a Story when the shared daily Story cap is full', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'instagram-community-cap-'));
    const statePath = path.join(temp, 'state.json');
    const fetch = fakeInstagramFetch();
    const reservations = storyReservationClient(false);
    const result = await runWithVerifiedPermissions({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      fetchImpl: fetch.fetchImpl,
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
      socialPublishReservations: reservations.client,
    });
    expect(result).toMatchObject({ status: 'completed', storiesPublished: 0, storiesSkipped: 1 });
    expect(fetch.calls.filter(({ url, options }) => options.method === 'POST' && new URL(url).pathname.endsWith('/media_publish'))).toHaveLength(0);
    expect(reservations.calls.map(({ action }) => action)).toEqual(['reserve']);
    rmSync(temp, { recursive: true, force: true });
  });

  it('keeps the Story reservation after an ambiguous media_publish transport failure', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'instagram-community-ambiguous-'));
    const statePath = path.join(temp, 'state.json');
    const fetch = fakeInstagramFetch();
    const reservations = storyReservationClient();
    const fetchImpl = async (url: string, options: any = {}) => {
      const parsed = new URL(url);
      if (options.method === 'POST' && parsed.pathname.endsWith('/media_publish')) {
        throw new Error('connection reset after request send');
      }
      return fetch.fetchImpl(url, options);
    };
    const result = await runWithVerifiedPermissions({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      fetchImpl,
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
      socialPublishReservations: reservations.client,
    });

    expect(result).toMatchObject({ status: 'partial', storiesAttempted: 1, storiesPublished: 0 });
    expect(reservations.calls.map(({ action }) => action)).toEqual(['reserve']);
    rmSync(temp, { recursive: true, force: true });
  });

  it('fails closed without credentials and does not call the network', async () => {
    let called = false;
    const result = await runWithVerifiedPermissions({
      accountId: '',
      accessToken: '',
      pageId: '',
      pageAccessToken: '',
      mode: 'live',
      fetchImpl: async () => { called = true; return response({}); },
    });
    expect(result.status).toBe('credentials-missing');
    expect(called).toBe(false);
  });

  it('holds live community work when no Meta capability is verified', async () => {
    const fetch = fakeInstagramFetch();
    const result = await runInstagramCommunityAutomation({
      accountId: 'account-1',
      accessToken: 'page-token',
      pageId: 'page-1',
      pageAccessToken: 'page-token',
      mode: 'live',
      fetchImpl: fetch.fetchImpl,
      permissionProbe: async () => ({ permissionStatuses: {} }),
      publisherTokenProbe: async () => ({ publisherTokenStatus: 'matched' }),
      pageLinkProbe: async () => ({ pageLinkStatus: 'unavailable', pageTaskStatuses: {} }),
    });

    expect(result).toMatchObject({
      status: 'capability-unavailable',
      capabilities: { comments: 'action-required', directMessages: 'action-required', stories: 'action-required' },
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it('runs only the community surface with its own verified permission', async () => {
    const fetch = fakeInstagramFetch();
    const result = await runInstagramCommunityAutomation({
      accountId: 'account-1',
      accessToken: 'page-token',
      pageId: 'page-1',
      pageAccessToken: 'page-token',
      ledger: ledger(),
      mode: 'live',
      now: NOW,
      fetchImpl: fetch.fetchImpl,
      permissionProbe: async () => ({
        permissionStatuses: { instagram_basic: 'granted', instagram_manage_comments: 'granted' },
      }),
      publisherTokenProbe: verifiedPublisherTokenProbe,
      pageLinkProbe: async () => ({
        pageLinkStatus: 'matched',
        publisherTokenSourceStatus: 'matched',
        pageTaskStatuses: { moderate: 'granted' },
      }),
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
    });

    expect(result).toMatchObject({
      status: 'capabilities-limited',
      commentsReplied: 1,
      directMessagesSent: 0,
      storiesPublished: 0,
      blockedCapabilities: ['directMessages', 'stories'],
    });
    expect(fetch.calls.some(({ url }) => new URL(url).pathname.endsWith('/account-1/conversations'))).toBe(false);
    expect(fetch.calls.some(({ url, options }) => options.method === 'POST' && new URL(url).pathname.endsWith('/media_publish'))).toBe(false);
  });

  it.each([
    ['publisher token resolves to a different Instagram account', 'matched', 'mismatch'],
    ['publisher token is not tied to the verified Page', 'mismatch', 'matched'],
  ])('holds every community surface when %s', async (_label, sourceStatus, publisherStatus) => {
    const fetch = fakeInstagramFetch();
    const result = await runInstagramCommunityAutomation({
      accountId: 'account-1',
      accessToken: 'page-token',
      pageId: 'page-1',
      pageAccessToken: 'page-token',
      mode: 'live',
      fetchImpl: fetch.fetchImpl,
      permissionProbe: verifiedPermissionProbe,
      pageLinkProbe: async () => ({
        pageLinkStatus: 'matched',
        publisherTokenSourceStatus: sourceStatus,
        pageTaskStatuses: { createContent: 'granted', moderate: 'granted', messaging: 'granted' },
      }),
      publisherTokenProbe: async () => ({ publisherTokenStatus: publisherStatus }),
    });

    expect(result.status).toBe('capability-unavailable');
    expect(fetch.calls).toHaveLength(0);
  });
});
