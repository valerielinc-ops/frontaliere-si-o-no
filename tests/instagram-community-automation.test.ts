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

const NOW = new Date('2026-10-10T12:00:00.000Z');

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fakeInstagramFetch() {
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
      return response({ data: [{ id: 'comment-1', text: '1', from: { id: 'person-1' }, timestamp: '2026-10-10T11:00:00.000Z' }] });
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
    }],
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
    const firstResult = await runInstagramCommunityAutomation({
      accountId: 'account-1',
      accessToken: 'token-never-printed',
      pageId: '',
      pageAccessToken: '',
      ledger: ledger(),
      statePath,
      mode: 'live',
      now: NOW,
      fetchImpl: first.fetchImpl,
      sleepImpl: async () => {},
      log: { log: () => {}, warn: () => {} },
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
    expect(first.calls.every(({ url }) => !url.includes('token-never-printed'))).toBe(true);
    expect(readFileSync(statePath, 'utf8')).not.toContain('comment-1');
    expect(readFileSync(statePath, 'utf8')).not.toContain('message-1');

    const second = fakeInstagramFetch();
    const secondResult = await runInstagramCommunityAutomation({
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
    });
    expect(secondResult).toMatchObject({ commentsSeen: 1, commentsReplied: 0, privateRepliesSent: 0, directMessagesSent: 0, storiesPublished: 0 });
    expect(second.calls.filter(({ options }) => options.method === 'POST')).toHaveLength(0);

    expect(loadCommunityState(statePath).actions).toHaveLength(4);
    rmSync(temp, { recursive: true, force: true });
  });

  it('fails closed without credentials and does not call the network', async () => {
    let called = false;
    const result = await runInstagramCommunityAutomation({
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
});
