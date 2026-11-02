import { describe, expect, it } from 'vitest';

import { buildSocialCopyPerformanceBrief } from '../scripts/social-copy/performance-brief.mjs';

describe('social copy performance brief', () => {
  it('exports only aggregated Instagram outcomes and hides groups below the existing sample minimum', () => {
    const insights = [
      { id: 'post-one', creativeId: 'proof', kind: 'article', reach: 100, shares: 10, copyMode: 'codex', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-a', copyHook: 'Private post text' },
      { id: 'post-two', creativeId: 'proof', kind: 'article', reach: 100, shares: 12, copyMode: 'codex', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-a', copyHook: 'Private post text' },
      { id: 'post-three', creativeId: 'proof', kind: 'article', reach: 100, shares: 8, copyMode: 'codex', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-a', copyHook: 'Private post text' },
      { id: 'post-four', creativeId: 'proof', kind: 'article', reach: 100, shares: 4, copyMode: 'codex', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-b', copyHook: 'Private post text' },
      { id: 'post-five', creativeId: 'proof', kind: 'article', reach: 100, shares: 5, copyMode: 'codex', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-b', copyHook: 'Private post text' },
    ];

    const brief = buildSocialCopyPerformanceBrief(insights, null);

    expect(brief.minimumObservations).toBe(3);
    expect(brief.variants).toEqual([
      expect.objectContaining({
        templateId: 'ig-article-share-a',
        observations: 3,
        eligibleForDescription: true,
        primaryRate: 0.1,
      }),
      expect.objectContaining({
        templateId: 'ig-article-share-b',
        observations: 2,
        eligibleForDescription: false,
        primaryRate: null,
      }),
    ]);
    expect(JSON.stringify(brief)).not.toContain('Private post text');
    expect(JSON.stringify(brief)).not.toContain('post-one');
    expect(brief.interpretation).toContain('no winner');
  });
});
