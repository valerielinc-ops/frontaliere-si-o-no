import { describe, expect, it } from 'vitest';

import {
  chooseVisualMatches,
  coverUrlForInstagramGroup,
  fingerprintDistance,
  hasVisibleAudienceMetrics,
  mergeInstagramBrowserSnapshots,
  parseInstagramBrowserMetrics,
  parseInstagramMediaId,
} from '../scripts/lib/instagram-insights-browser.mjs';

describe('Chrome Instagram Insights adapter', () => {
  it('parses the visible Italian detail labels without borrowing a neighbouring metric', () => {
    const metrics = parseInstagramBrowserMetrics([
      'Visualizzazioni', 'Visualizzazioni', '13',
      'Follower', '100%', 'Non follower', '0%',
      'Interazioni', 'Interazioni', '1',
      'Mi piace', '1', 'Commenti', '0', 'Salvataggi', '0', 'Condivisioni', '0',
      'Visite al profilo', '0', 'Tocchi sul link esterno', '0',
    ].join('\n'));

    expect(metrics).toMatchObject({
      views: 13,
      reach: 13,
      reachSource: 'views',
      audienceMetric: 'views',
      interactions: 1,
      shares: 0,
      saves: 0,
      comments: 0,
    });
  });

  it('keeps English thousands separators numeric', () => {
    expect(parseInstagramBrowserMetrics(['Views', 'Views', '1,234', 'Interactions', '0'].join('\n'))).toMatchObject({
      views: 1234,
      reach: 1234,
      audienceMetric: 'views',
    });
  });

  it('keeps a legitimate zero audience observation', () => {
    expect(hasVisibleAudienceMetrics({ views: 0, reach: 0 })).toBe(true);
    expect(hasVisibleAudienceMetrics({ views: null, reach: null })).toBe(false);
  });

  it('recognizes the detail media id and derives deterministic carousel covers', () => {
    expect(parseInstagramMediaId('https://www.instagram.com/insights/media/4004480545324664095/')).toBe('4004480545324664095');
    expect(coverUrlForInstagramGroup({ kind: 'article', day: '2026-10-09' })).toBe(
      'https://cdn.frontaliereticino.ch/images/social/instagram/article-2026-10-09-0.jpg',
    );
    expect(coverUrlForInstagramGroup({
      kind: 'reel', sourceKind: 'job', day: '2026-10-09', creativeId: 'reel-number',
    })).toContain('/reel-job-2026-10-09-reel-number-0.jpg');
  });

  it('accepts one strict visual attribution and rejects a tied card', () => {
    const expected = [
      { identity: 'article-1', fingerprint: [0, 0, 0, 1, 1, 1] },
      { identity: 'job-1', fingerprint: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
    ];
    const actual = [
      { buttonIndex: 2, fingerprint: [0, 0, 0, 1, 1, 1] },
      { buttonIndex: 7, fingerprint: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
    ];
    expect(fingerprintDistance(expected[0].fingerprint, actual[0].fingerprint)).toBe(0);
    expect(chooseVisualMatches(expected, actual).matches.map((item) => item.expected.identity)).toEqual(['article-1', 'job-1']);

    const ambiguous = chooseVisualMatches(
      [{ identity: 'same', fingerprint: [0, 0, 0] }],
      [{ buttonIndex: 1, fingerprint: [0, 0, 0] }, { buttonIndex: 2, fingerprint: [0, 0, 0] }],
    );
    expect(ambiguous.matches).toEqual([]);
    expect(ambiguous.unmatched[0].reason).toBe('visual-cover-ambiguous');
  });

  it('merges browser additions idempotently with a repository snapshot', () => {
    const addition = {
      postId: 'media-1', mediaId: 'media-1', queueId: 'article-1', windowHours: 72,
      snapshotAt: '2026-10-13T12:00:00.000Z', creativeId: 'question-choice',
      reach: 13, views: 13, reachSource: 'views', comments: 0,
    };
    const document = mergeInstagramBrowserSnapshots({ posts: [addition] }, { additions: [addition] }, {
      generatedAt: '2026-10-13T12:00:00.000Z',
    });
    expect(document.posts).toHaveLength(1);
    expect(document.posts[0]).toMatchObject({ mediaId: 'media-1', postId: 'media-1', reachSource: 'views' });
  });
});
