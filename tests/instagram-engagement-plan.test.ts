import { describe, expect, it } from 'vitest';

import {
  buildInstagramEngagementPlan,
  parseArgs,
} from '../scripts/instagram-engagement-plan.mjs';

describe('Instagram engagement plan', () => {
  it('keeps the daily creative, CTA loop and metric aligned', () => {
    const plan = buildInstagramEngagementPlan({ kind: 'article', day: '2026-10-09' });

    expect(plan).toMatchObject({
      kind: 'article',
      creativeId: 'question-choice',
      creativeObjective: 'conversation',
      primaryMetric: 'comments',
      engagementMechanic: 'keyword-comment',
      hookType: 'forced-choice',
      engagementLoop: 'comment-to-poll',
      followUpFormat: 'story-result',
      automationMode: 'chrome-browser',
      manualOnly: false,
      responseSlaHours: 24,
      followUpWithinHours: 72,
    });
    expect(plan.commentPrompt).toContain('Quale tema scegli');
    expect(plan.measurement).toMatchObject({
      diagnosticWindowHours: 24,
      decisionWindowHours: 72,
      minimumComparableObservations: 3,
    });
  });

  it('supports a Reel source kind without mixing its cohort with carousels', () => {
    const plan = buildInstagramEngagementPlan({ kind: 'reel', sourceKind: 'job', day: '2026-10-11' });

    expect(plan).toMatchObject({
      kind: 'reel',
      sourceKind: 'job',
      creativeBaseId: 'reel',
      creativeId: 'reel-number',
      primaryAction: 'share',
      primaryMetric: 'shares',
      engagementLoop: 'share-to-help',
      followUpFormat: 'story-result',
    });
    expect(plan.measurement.comparisonUnit).toContain('content kind');
  });

  it('parses safe CLI options and rejects invalid dates', () => {
    expect(parseArgs(['--date=2026-10-10', '--kind=reel', '--source-kind', 'job', '--json'])).toMatchObject({
      date: '2026-10-10',
      kind: 'reel',
      sourceKind: 'job',
      json: true,
    });
    expect(() => parseArgs(['--date=2026-02-30'])).toThrow('valid YYYY-MM-DD');
  });
});
