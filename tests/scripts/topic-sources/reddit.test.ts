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
  it('drops English r/Switzerland posts but keeps Italian ones', async () => {
    // Build a fetch mock that returns:
    // - r/Ticino: empty
    // - r/italy: empty
    // - r/Lugano: empty
    // - r/Switzerland: one EN post (should be dropped) + one IT post (should be kept)
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/r/Switzerland/')) {
        return makeListingRes([
          passingPost(
            'How much can I save as a cross-border worker from Italy?',
          ),
          passingPost(
            'Qualcuno sa come funziona la busta paga per un frontaliere?',
          ),
        ]);
      }
      // All other endpoints: empty listing → 0 candidates from those subs.
      return makeListingRes([]);
    });

    const r = await fetchRedditCandidates({
      fetchImpl: fetchImpl as any,
      sleepFn: async () => {},
      playwrightFallback: async () => [],
    });

    const swissCandidates = r.perSubreddit.redditSwitzerland.candidates;
    expect(swissCandidates).toHaveLength(1);
    expect(swissCandidates[0].keyword).toMatch(/Qualcuno sa/);
  });

  it('does NOT apply the locale filter to r/Ticino (English title kept if it passes other filters)', async () => {
    // r/Ticino post in English with frontaliere-relevant content. Without the
    // locale filter being applied to Ticino, the post should pass through the
    // engagement+relevance gates and produce a candidate.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/r/Ticino/')) {
        return makeListingRes([
          passingPost(
            'Anyone know how to commute from Como to Lugano with a permesso G?',
          ),
        ]);
      }
      return makeListingRes([]);
    });

    const r = await fetchRedditCandidates({
      fetchImpl: fetchImpl as any,
      sleepFn: async () => {},
      playwrightFallback: async () => [],
    });

    const ticinoCandidates = r.perSubreddit.redditTicino.candidates;
    expect(ticinoCandidates).toHaveLength(1);
    expect(ticinoCandidates[0].keyword).toMatch(/Como to Lugano/);
  });

  it('keeps a low-confidence (unclassifiable) r/Switzerland title (fail-safe)', async () => {
    // Title detectLocale falls back to 'it' on (proper-noun-heavy short text).
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/r/Switzerland/')) {
        return makeListingRes([
          passingPost('Lugano Mendrisio Chiasso frontaliere?'),
        ]);
      }
      return makeListingRes([]);
    });

    const r = await fetchRedditCandidates({
      fetchImpl: fetchImpl as any,
      sleepFn: async () => {},
      playwrightFallback: async () => [],
    });

    const swissCandidates = r.perSubreddit.redditSwitzerland.candidates;
    expect(swissCandidates).toHaveLength(1);
  });
});
