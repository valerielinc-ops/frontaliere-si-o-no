import { describe, expect, it } from 'vitest';

import {
  buildInstagramEngagementBrief,
  formatInstagramEngagementBrief,
  instagramEngagementMechanic,
} from '../scripts/lib/instagram-engagement.mjs';

const creativeEntry = (overrides: Record<string, unknown> = {}) => ({
  channel: 'instagram',
  id: 'article-2026-10-10',
  kind: 'article',
  day: '2026-10-10',
  ledgerEntries: [{
    id: 'article-slug',
    kind: 'article',
    creativeId: 'question-choice',
    creativeBaseId: 'question',
    creativeVariant: 'choice',
    primaryMetric: 'comments',
    engagementMechanic: 'keyword-comment',
    hookType: 'forced-choice',
    attentionMechanic: 'low-friction-choice',
    engagementLoop: 'comment-to-poll',
    followUpFormat: 'story-result',
    ...overrides,
  }],
});

describe('Instagram engagement brief', () => {
  it('derives an automatic 24/48/72-hour loop from queued creative metadata', () => {
    const brief = buildInstagramEngagementBrief(creativeEntry());

    expect(brief).toMatchObject({
      queueId: 'article-2026-10-10',
      creativeId: 'question-choice',
      primaryMetric: 'comments',
      engagementMechanic: 'keyword-comment',
      hookType: 'forced-choice',
      attentionMechanic: 'low-friction-choice',
      engagementLoop: 'comment-to-poll',
      followUpFormat: 'story-result',
      responseSlaHours: 24,
      storySlaHours: 48,
      decisionWindowHours: 72,
      minimumComparableObservations: 3,
      automationMode: 'chrome-browser',
      manualOnly: false,
    });
    expect(brief?.responseAction).toContain('24h');
    expect(brief?.followUpAction).toContain('48h');
    expect(brief?.decisionAction).toContain('3 osservazioni');
  });

  it('keeps metric fallbacks deterministic for a newly introduced treatment', () => {
    expect(instagramEngagementMechanic('comments')).toBe('keyword-comment');
    const brief = buildInstagramEngagementBrief(creativeEntry({
      creativeId: 'future-treatment',
      primaryMetric: 'shares',
      engagementMechanic: '',
      followUpFormat: 'comment-reply-reel',
    }));
    expect(brief).toMatchObject({
      creativeId: 'future-treatment',
      primaryMetric: 'shares',
      engagementMechanic: 'direct-share',
      storySlaHours: null,
    });
    expect(brief?.followUpAction).toContain('Reel');
  });

  it('does not infer a strategy for TikTok or legacy rows without a creative id', () => {
    expect(buildInstagramEngagementBrief({ ...creativeEntry(), channel: 'tiktok' })).toBeNull();
    expect(buildInstagramEngagementBrief({
      ...creativeEntry(),
      ledgerEntries: [{ id: 'legacy', kind: 'article', primaryMetric: 'comments' }],
    })).toBeNull();
  });

  it('formats a readable automatic worker brief', () => {
    const output = formatInstagramEngagementBrief(buildInstagramEngagementBrief(creativeEntry()));
    expect(output).toContain('🧭 Instagram engagement — article-2026-10-10 · question-choice · comments');
    expect(output).toContain('Automatico: commenti e DM consentiti vengono gestiti dal worker Chrome; le Stories restano nel fallback Graph esplicito.');
  });
});
