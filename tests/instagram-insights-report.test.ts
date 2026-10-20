import { describe, expect, it } from 'vitest';

import {
  aggregateCreativePerformance,
  buildCreativeReport,
  normalizeInsightRows,
  parseInstagramInsightsCsv,
} from '../scripts/lib/instagram-insights-report.mjs';

const rows = [
  { id: 'p1', creativeId: 'proof', kind: 'article', reach: 100, shares: 8, saves: 2, comments: 1 },
  { id: 'p2', creativeId: 'proof', kind: 'article', reach: 200, shares: 10, saves: 4, comments: 2 },
  { id: 'p3', creativeId: 'proof', kind: 'article', reach: 100, shares: 7, saves: 1, comments: 1 },
  { id: 'p4', creativeId: 'save', kind: 'article', reach: 100, shares: 2, saves: 15, comments: 1 },
  { id: 'p5', creativeId: 'save', kind: 'article', reach: 100, shares: 3, saves: 12, comments: 1 },
];

describe('Instagram Insights creative scorecard', () => {
  it('parses a Dashboard CSV and joins a queue id to the creative ledger', () => {
    const csv = '\ufeffPost ID;Reach;Shares;Saves;Comments\narticle-1;120;9;4;3\n';
    const parsed = parseInstagramInsightsCsv(csv);
    const result = normalizeInsightRows(parsed, {
      windowHours: 24,
      ledger: {
        posted: [{
          queueId: 'article-1',
          kind: 'article',
          creativeId: 'question-choice',
          creativeObjective: 'conversation',
          primaryMetric: 'comments',
          hookType: 'forced-choice',
        }],
      },
    });

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      postId: 'article-1',
      kind: 'article',
      creativeId: 'question-choice',
      objective: 'conversation',
      primaryMetric: 'comments',
      hookType: 'forced-choice',
      reach: 120,
      comments: 3,
      windowHours: 24,
    });
  });

  it('handles quoted commas in CSV fields without shifting metric columns', () => {
    const parsed = parseInstagramInsightsCsv('Post ID,Creative ID,Reach,Shares\n"post,1",proof,100,8\n');

    expect(parsed).toEqual([{
      id: 'post,1',
      creativeId: 'proof',
      reach: '100',
      shares: '8',
    }]);
  });

  it('normalizes dashboard aliases and derives the treatment objective', () => {
    const result = normalizeInsightRows({ data: [
      {
        media_id: 'media-1',
        creative_id: 'question-story',
        reach_count: '100',
        shares_count: 4,
        saved: 12,
        comments_count: 3,
        window_hours: 72,
      },
    ] });

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      postId: 'media-1',
      creativeId: 'question-story',
      objective: 'conversation',
      primaryMetric: 'comments',
      engagementMechanic: null,
      reach: 100,
      shares: 4,
      saves: 12,
      comments: 3,
      windowHours: 72,
    });
  });

  it('normalizes Meta API metrics nested under insights.data', () => {
    const result = normalizeInsightRows([
      {
        id: 'media-api-1',
        creativeId: 'save-checklist',
        kind: 'article',
        insights: {
          data: [
            { name: 'reach', values: [{ value: 240 }] },
            { name: 'shares', values: [{ value: 3 }] },
            { name: 'saves', values: [{ value: 18 }] },
            { name: 'comments', values: [{ value: 2 }] },
          ],
        },
      },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      postId: 'media-api-1',
      creativeId: 'save-checklist',
      objective: 'save',
      primaryMetric: 'saves',
      reach: 240,
      shares: 3,
      saves: 18,
      comments: 2,
    });
  });

  it('uses browser Views as the declared audience base when Reach is not visible', () => {
    const result = normalizeInsightRows([{
      id: 'browser-media-1',
      creativeId: 'question-choice',
      kind: 'article',
      views: 13,
      comments: 2,
    }]);

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({ views: 13, reach: 13, reachSource: 'views' });
    expect(aggregateCreativePerformance(result.rows, { minimumObservations: 1 }).treatments[0]).toMatchObject({
      views: 13,
      audienceMetric: 'views',
      reachSource: 'views',
      primaryRate: 2 / 13,
    });
  });

  it('joins a media id to creative metadata in the posted ledger', () => {
    const result = normalizeInsightRows([
      { id: 'ig-123', reach: 100, shares: 5, saves: 1, comments: 0 },
    ], {
      ledger: { posted: [{
        instagramMediaId: 'ig-123',
        creativeId: 'proof',
        creativeBaseId: 'proof',
        creativeVariant: 'baseline',
        creativeLabel: 'Dato verificabile',
        engagementMechanic: 'direct-share',
        hookType: 'data-proof',
        attentionMechanic: 'single-source-number',
        engagementLoop: 'share-with-utility',
        followUpFormat: 'story-poll',
      }] },
    });

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      creativeId: 'proof',
      creativeVariant: 'baseline',
      engagementMechanic: 'direct-share',
      hookType: 'data-proof',
      engagementLoop: 'share-with-utility',
    });

    const report = aggregateCreativePerformance(result.rows, { minimumObservations: 1 });
    expect(report.treatments[0]).toMatchObject({
      creativeId: 'proof',
      creativeVariant: 'baseline',
      engagementMechanic: 'direct-share',
      followUpFormat: 'story-poll',
    });
  });

  it('rejects incomplete rows instead of turning missing reach into a zero-rate winner', () => {
    const result = buildCreativeReport([
      { creativeId: 'proof', shares: 8 },
      { creativeId: 'save', reach: 0, saves: 4 },
      { creativeId: 'question', reach: 100, comments: -1 },
    ]);

    expect(result.acceptedRows).toBe(0);
    expect(result.rejectedRows).toHaveLength(3);
    expect(result.exploratoryWinner).toBeNull();
  });

  it('keeps primary rates separate and withholds eligibility before three observations', () => {
    const normalized = normalizeInsightRows(rows).rows;
    const report = aggregateCreativePerformance(normalized);
    const proof = report.treatments.find((treatment) => treatment.creativeId === 'proof')!;
    const save = report.treatments.find((treatment) => treatment.creativeId === 'save')!;

    expect(proof).toMatchObject({
      observations: 3,
      kind: 'article',
      primaryMetric: 'shares',
      primaryTotal: 25,
      primaryRate: 25 / 400,
      eligible: true,
      status: 'eligible',
    });
    expect(save).toMatchObject({
      observations: 2,
      kind: 'article',
      primaryMetric: 'saves',
      primaryTotal: 27,
      eligible: false,
      status: 'needs-1-more',
    });
    expect(report.exploratoryWinner).toBe('proof');
  });

  it('separates measurement windows so 24h and 72h are never pooled', () => {
    const normalized = normalizeInsightRows([
      { creativeId: 'proof', reach: 100, shares: 10, windowHours: 24 },
      { creativeId: 'proof', reach: 200, shares: 15, windowHours: 72 },
    ]).rows;
    const report = aggregateCreativePerformance(normalized, { minimumObservations: 1 });

    expect(report.treatments.map((treatment) => treatment.windowHours)).toEqual([24, 72]);
    expect(report.treatments.every((treatment) => treatment.observations === 1)).toBe(true);
  });

  it('does not pool different content kinds into one treatment decision', () => {
    const normalized = normalizeInsightRows([
      { creativeId: 'proof-local', kind: 'article', reach: 100, shares: 10 },
      { creativeId: 'proof-local', kind: 'article', reach: 100, shares: 10 },
      { creativeId: 'proof-local', kind: 'job', reach: 100, shares: 10 },
      { creativeId: 'proof-local', kind: 'job', reach: 100, shares: 10 },
    ]).rows;
    const report = aggregateCreativePerformance(normalized);

    expect(report.treatments).toEqual([
      expect.objectContaining({ creativeId: 'proof-local', kind: 'article', observations: 2, status: 'needs-1-more' }),
      expect.objectContaining({ creativeId: 'proof-local', kind: 'job', observations: 2, status: 'needs-1-more' }),
    ]);
    expect(report.exploratoryWinner).toBeNull();
  });
});
