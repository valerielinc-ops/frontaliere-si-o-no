import { describe, expect, it, vi } from 'vitest';

import * as redditMod from '../../../scripts/lib/topic-sources/reddit.mjs';

const { fetchRedditCandidates, isItLocaleConfident } = redditMod as any;

// Helper: build a fetch Response-shaped object returning a Reddit listing JSON.
function makeListingRes(posts: Array<Record<string, unknown>>) {
  const body = {
    data: {
      children: posts.map((data) => ({ data })),
    },
  };
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Helper: a "passing" Reddit post — meets the score/comments/question gates
// (score>=5, comments>=3, is_self=true, ends with '?') and the relevance regex
// (contains a frontaliere-domain term).
function passingPost(title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    score: 50,
    num_comments: 12,
    is_self: true,
    permalink: '/r/test/comments/abc/x/',
    ...extra,
  };
}

describe('isItLocaleConfident', () => {
  it('Italian title → kept (true)', () => {
    expect(isItLocaleConfident('Come si calcola lo stipendio del frontaliere?')).toBe(true);
  });

  it('clearly English title → dropped (false)', () => {
    expect(
      isItLocaleConfident('How much can I save when working as a cross-border worker?'),
    ).toBe(false);
  });

  it('clearly German title → dropped (false)', () => {
    expect(
      isItLocaleConfident('Wie kann ich als Grenzgaenger meine Steuern berechnen und was ist?'),
    ).toBe(false);
  });

  it('low-confidence / unclassifiable title → kept (fail-safe)', () => {
    // Proper-noun-heavy short title — detectLocale defaults to 'it'.
    expect(isItLocaleConfident('Lugano Mendrisio Chiasso')).toBe(true);
  });

  it('empty / non-string input → kept (fail-safe)', () => {
    expect(isItLocaleConfident('')).toBe(true);
    expect(isItLocaleConfident(null as any)).toBe(true);
    expect(isItLocaleConfident(undefined as any)).toBe(true);
  });
});

describe('fetchRedditCandidates — r/Switzerland locale filter', () => {
  const approvedEnv = {
    REDDIT_DATA_API_APPROVED: 'true',
    REDDIT_USER_AGENT: 'web:frontaliereticino:test (by /u/tester)',
  };

  it('does not access Reddit while explicit Data API approval is absent', async () => {
    const fetchImpl = vi.fn();
    const getAccessTokenFn = vi.fn();
    const r = await fetchRedditCandidates({
      env: {},
      fetchImpl,
      getAccessTokenFn,
      sleepFn: async () => {},
    });

    expect(r.ok).toBe(false);
    expect(r.authMode).toBe('disabled');
    expect(r.perSubreddit.redditTicino.reason).toBe('reddit_data_api_unapproved');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getAccessTokenFn).not.toHaveBeenCalled();
  });

  it('uses OAuth only and retains locale filtering when explicitly approved', async () => {
    const fetchImpl = vi.fn(async (url: string, _init: any) => {
      if (url.includes('/r/Switzerland/')) {
        return makeListingRes([
          passingPost('How much can I save as a cross-border worker from Italy?'),
          passingPost('Qualcuno sa come funziona la busta paga per un frontaliere?'),
        ]);
      }
      return makeListingRes([]);
    });

    const r = await fetchRedditCandidates({
      env: approvedEnv,
      getAccessTokenFn: async () => 'test-token',
      fetchImpl: fetchImpl as any,
      sleepFn: async () => {},
    });

    const swissCandidates = r.perSubreddit.redditSwitzerland.candidates;
    expect(r.authMode).toBe('oauth');
    expect(swissCandidates).toHaveLength(1);
    expect(swissCandidates[0].keyword).toMatch(/Qualcuno sa/);
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toMatch(/^https:\/\/oauth\.reddit\.com\//);
      expect(init.headers.Authorization).toBe('Bearer test-token');
      expect(init.headers['User-Agent']).toBe(approvedEnv.REDDIT_USER_AGENT);
    }
  });

  it('does not retry authorization rejection or switch to anonymous endpoints', async () => {
    const unauthorized = Object.assign(new Error('reddit 403'), { status: 403 });
    const fetchImpl = vi.fn(async () => { throw unauthorized; });
    const r = await fetchRedditCandidates({
      env: approvedEnv,
      getAccessTokenFn: async () => 'test-token',
      fetchImpl: fetchImpl as any,
      sleepFn: async () => {},
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.perSubreddit.redditTicino.ok).toBe(false);
    expect(r.perSubreddit.redditItaly.reason).toBe('reddit_oauth_rejected');
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/oauth\.reddit\.com\//);
  });

  it('retries a rate-limited OAuth request with bounded retry and no scraping fallback', async () => {
    let calls = 0;
    const rateLimited = Object.assign(new Error('reddit 429'), { status: 429 });
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw rateLimited;
      return makeListingRes([
        passingPost('Come funziona la busta paga del frontaliere?'),
      ]);
    });

    const r = await fetchRedditCandidates({
      env: approvedEnv,
      getAccessTokenFn: async () => 'test-token',
      fetchImpl: fetchImpl as any,
      sleepFn: async () => {},
    });

    expect(r.candidates.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith('https://oauth.reddit.com/'))).toBe(true);
  });
});
