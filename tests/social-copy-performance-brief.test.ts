import { describe, expect, it } from 'vitest';

import { buildSocialCopyPerformanceBrief } from '../scripts/social-copy/performance-brief.mjs';

describe('social copy performance brief', () => {
  it('exports only aggregated Instagram outcomes and hides groups below the existing sample minimum', () => {
    const insights = [
      { id: 'post-one', creativeId: 'proof', kind: 'article', reach: 100, shares: 10, copyMode: 'codex', copyAssignmentMode: 'firebase-balanced', copyExperimentId: 'social-copy-balanced-v1', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-a', copyAngleId: 'article-practical-question', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both', copyHook: 'Private post text' },
      { id: 'post-two', creativeId: 'proof', kind: 'article', reach: 100, shares: 12, copyMode: 'codex', copyAssignmentMode: 'firebase-balanced', copyExperimentId: 'social-copy-balanced-v1', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-a', copyAngleId: 'article-practical-question', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both', copyHook: 'Private post text' },
      { id: 'post-three', creativeId: 'proof', kind: 'article', reach: 100, shares: 8, copyMode: 'codex', copyAssignmentMode: 'firebase-balanced', copyExperimentId: 'social-copy-balanced-v1', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-a', copyAngleId: 'article-practical-question', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both', copyHook: 'Private post text' },
      { id: 'post-four', creativeId: 'proof', kind: 'article', reach: 100, shares: 4, copyMode: 'codex', copyAssignmentMode: 'deterministic-fallback', copyExperimentId: 'social-copy-balanced-v1', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-b', copyHook: 'Private post text' },
      { id: 'post-five', creativeId: 'proof', kind: 'article', reach: 100, shares: 5, copyMode: 'codex', copyAssignmentMode: 'deterministic-fallback', copyExperimentId: 'social-copy-balanced-v1', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-b', copyHook: 'Private post text' },
      { id: 'post-six', creativeId: 'proof', kind: 'article', reach: 100, shares: 6, copyMode: 'codex', copyAssignmentMode: 'firebase-balanced', copyExperimentId: 'social-copy-balanced-v2', copyPackId: '0123456789abcdef', copyTemplateId: 'ig-article-share-a', copyHook: 'Private post text' },
    ];

    const brief = buildSocialCopyPerformanceBrief(insights, null);

    expect(brief.minimumObservations).toBe(3);
    expect(brief.variants).toEqual([
      expect.objectContaining({
        templateId: 'ig-article-share-a',
        angleId: 'article-practical-question',
        pillarId: 'strumenti-utili',
        angleIntent: 'both',
        assignmentMode: 'firebase-balanced',
        experimentId: 'social-copy-balanced-v1',
        observations: 3,
        eligibleForDescription: true,
        primaryRate: 0.1,
      }),
      expect.objectContaining({
        templateId: 'ig-article-share-a',
        assignmentMode: 'firebase-balanced',
        experimentId: 'social-copy-balanced-v2',
        observations: 1,
        eligibleForDescription: false,
      }),
      expect.objectContaining({
        templateId: 'ig-article-share-b',
        assignmentMode: 'deterministic-fallback',
        experimentId: 'social-copy-balanced-v1',
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
