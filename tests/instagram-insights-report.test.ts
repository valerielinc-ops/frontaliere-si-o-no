import { describe, expect, it } from 'vitest';

import {
  aggregateCreativePerformance,
  buildCreativeReport,
  normalizeInsightRows,
  parseInstagramInsightsCsv,
} from '../scripts/lib/instagram-insights-report.mjs';

const rows = [
  { id: 'p1', matchMethod: 'ledger-media-id', creativeId: 'proof', kind: 'article', reach: 100, shares: 8, saves: 2, comments: 1 },
  { id: 'p2', matchMethod: 'ledger-media-id', creativeId: 'proof', kind: 'article', reach: 200, shares: 10, saves: 4, comments: 2 },
  { id: 'p3', matchMethod: 'ledger-media-id', creativeId: 'proof', kind: 'article', reach: 100, shares: 7, saves: 1, comments: 1 },
  { id: 'p4', matchMethod: 'ledger-media-id', creativeId: 'save', kind: 'article', reach: 100, shares: 2, saves: 15, comments: 1 },
  { id: 'p5', matchMethod: 'ledger-media-id', creativeId: 'save', kind: 'article', reach: 100, shares: 3, saves: 12, comments: 1 },
];

describe('Instagram Insights creative scorecard', () => {
  it('parses a Dashboard CSV and joins the exact media ID to the creative ledger', () => {
    const csv = '\ufeffPost ID;Reach;Shares;Saves;Comments\nig-media-1;120;9;4;3\n';
    const parsed = parseInstagramInsightsCsv(csv);
    const result = normalizeInsightRows(parsed, {
      windowHours: 24,
      ledger: {
        posted: [{
          queueId: 'article-1',
          instagramMediaId: 'ig-media-1',
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
      postId: 'ig-media-1',
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
      availableMetrics: ['reach', 'shares'],
    }]);
  });

  it('rejects creative outcomes without an exact ledger media ID', () => {
    const unlinked = normalizeInsightRows([{
      id: 'unlinked-post',
      creativeId: 'proof',
      reach: 100,
      shares: 10,
    }]);
    const queueOnly = normalizeInsightRows([{
      id: 'queue-only-post',
      reach: 100,
      shares: 10,
    }], {
      ledger: { posted: [{ queueId: 'queue-only-post', creativeId: 'proof' }] },
    });
    const collidingIdentity = normalizeInsightRows([{
      id: 'shared-id',
      reach: 100,
      shares: 10,
    }], {
      ledger: { posted: [{
        queueId: 'shared-id',
        instagramMediaId: 'shared-id',
        creativeId: 'proof',
      }] },
    });
    const missingMediaId = normalizeInsightRows([{
      matchMethod: 'ledger-media-id',
      creativeId: 'proof',
      reach: 100,
      shares: 10,
    }]);
    const conflictingCreative = normalizeInsightRows([{
      id: 'verified-media-id',
      creativeId: 'save',
      reach: 100,
      shares: 10,
    }], {
      ledger: { posted: [{
        instagramMediaId: 'verified-media-id',
        creativeId: 'proof',
        creativeObjective: 'share',
        primaryMetric: 'shares',
      }] },
    });
    const suppliedMethodWithoutLedgerMatch = normalizeInsightRows([{
      id: 'unknown-media-id',
      matchMethod: 'ledger-media-id',
      creativeId: 'proof',
      reach: 100,
      shares: 10,
    }], { ledger: { posted: [] } });
    const queueIdCollidesWithMediaId = normalizeInsightRows([{
      queueId: 'ig-media-1',
      reach: 100,
      shares: 10,
    }], {
      ledger: { posted: [{
        queueId: 'article-1',
        instagramMediaId: 'ig-media-1',
        creativeId: 'proof',
      }] },
    });
    const queueIdCsv = normalizeInsightRows(parseInstagramInsightsCsv('Queue ID,Reach,Shares\nig-media-1,100,10\n'), {
      ledger: { posted: [{
        queueId: 'article-1',
        instagramMediaId: 'ig-media-1',
        creativeId: 'proof',
      }] },
    });

    expect(unlinked.rows).toEqual([]);
    expect(unlinked.rejected[0].reason).toBe('copy attribution lacks an exact ledger media ID');
    expect(queueOnly.rows).toEqual([]);
    expect(queueOnly.rejected[0].reason).toBe('copy attribution lacks an exact ledger media ID');
    expect(collidingIdentity.rows).toEqual([]);
    expect(collidingIdentity.rejected[0].reason).toBe('copy attribution lacks an exact ledger media ID');
    expect(missingMediaId.rows).toEqual([]);
    expect(missingMediaId.rejected[0].reason).toBe('media ID missing; exact attribution cannot be proven');
    expect(conflictingCreative.rows).toEqual([]);
    expect(conflictingCreative.rejected[0].reason).toBe('creativeId conflicts with the exact ledger media ID');
    expect(suppliedMethodWithoutLedgerMatch.rows).toEqual([]);
    expect(suppliedMethodWithoutLedgerMatch.rejected[0].reason).toBe('media ID does not match an exact ledger media ID');
    expect(queueIdCollidesWithMediaId.rows).toEqual([]);
    expect(queueIdCollidesWithMediaId.rejected[0].reason).toBe('media ID missing; exact attribution cannot be proven');
    expect(queueIdCsv.rows).toEqual([]);
    expect(queueIdCsv.rejected[0].reason).toBe('media ID missing; exact attribution cannot be proven');
  });

  it('normalizes dashboard aliases and derives the treatment objective', () => {
    const result = normalizeInsightRows({ data: [
      {
        media_id: 'media-1',
        matchMethod: 'ledger-media-id',
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
        matchMethod: 'ledger-media-id',
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

  it('preserves an explicitly returned zero from a nested Meta API metric', () => {
    const result = normalizeInsightRows([{
      id: 'media-api-zero-comments',
      matchMethod: 'ledger-media-id',
      creativeId: 'question-choice',
      kind: 'article',
      insights: {
        data: [
          { name: 'reach', values: [{ value: 240 }] },
          { name: 'comments', values: [{ value: 0 }] },
        ],
      },
    }]);

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      primaryMetric: 'comments',
      reach: 240,
      comments: 0,
      availableMetrics: ['reach', 'comments'],
    });
  });

  it('uses browser Views as a separately labeled audience base when Reach is not visible', () => {
    const result = normalizeInsightRows([{
      id: 'browser-media-1',
      matchMethod: 'ledger-media-id',
      creativeId: 'question-choice',
      kind: 'article',
      views: 13,
      comments: 2,
    }]);

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({ views: 13, reach: null, audienceBase: 13, audienceMetric: 'views', reachSource: 'views' });
    expect(aggregateCreativePerformance(result.rows, { minimumObservations: 1 }).treatments[0]).toMatchObject({
      views: 13,
      reach: null,
      audienceBase: 13,
      audienceMetric: 'views',
      reachSource: 'views',
      primaryRate: 2 / 13,
    });
  });

  it('rejects timestamp and browser-fingerprint matches before creative attribution', () => {
    const result = normalizeInsightRows([
      {
        id: 'media-timestamp-match',
        matchMethod: 'confirmation-timestamp',
        creativeId: 'question-choice',
        kind: 'article',
        reach: 100,
        comments: 5,
      },
      {
        id: 'browser-media-match',
        matchMethod: 'browser-cover-fingerprint',
        creativeId: 'question-choice',
        kind: 'article',
        reach: 100,
        comments: 5,
      },
    ]);

    expect(result.rows).toEqual([]);
    expect(result.rejected).toEqual([
      { row: 1, reason: 'timestamp-matched media cannot attribute creative performance' },
      { row: 2, reason: 'copy attribution is not an exact media-to-ledger join' },
    ]);
  });

  it('does not turn legacy missing zero metrics into observed zeros and rejects late snapshots', () => {
    const legacyZero = normalizeInsightRows([{
      id: 'legacy-zero',
      matchMethod: 'ledger-media-id',
      creativeId: 'question-choice',
      kind: 'article',
      views: 100,
      reach: 100,
      reachSource: 'views',
      comments: 0,
      windowHours: 72,
      snapshotAgeHours: 72,
    }]);
    expect(legacyZero.rows).toEqual([]);
    expect(legacyZero.rejected[0].reason).toBe('primary metric comments is unavailable');

    const declaredZero = normalizeInsightRows([{
      id: 'declared-zero',
      matchMethod: 'ledger-media-id',
      creativeId: 'question-choice',
      kind: 'article',
      views: 100,
      comments: 0,
      availableMetrics: ['views', 'comments'],
      windowHours: 72,
      snapshotAgeHours: 72,
    }]);
    expect(declaredZero.rejected).toEqual([]);
    expect(declaredZero.rows[0]).toMatchObject({ comments: 0, audienceMetric: 'views' });

    const late = normalizeInsightRows([{
      id: 'late-snapshot',
      matchMethod: 'ledger-media-id',
      creativeId: 'question-choice',
      kind: 'article',
      views: 100,
      comments: 2,
      windowHours: 72,
      snapshotAgeHours: 473,
    }]);
    expect(late.rows).toEqual([]);
    expect(late.rejected[0].reason).toBe('snapshot age is outside the declared measurement window');
  });

  it('keeps view-based and reach-based rates in separate comparison cohorts', () => {
    const result = aggregateCreativePerformance([
      { creativeId: 'proof-a', objective: 'share', primaryMetric: 'shares', kind: 'article', windowHours: 72, audienceMetric: 'reach', audienceBase: 100, reach: 100, shares: 10, saves: 1, comments: 1 },
      { creativeId: 'proof-b', objective: 'share', primaryMetric: 'shares', kind: 'article', windowHours: 72, audienceMetric: 'views', audienceBase: 100, reach: null, shares: 10, saves: 1, comments: 1 },
    ], { minimumObservations: 1 });

    expect(result.exploratoryWinners).toHaveLength(2);
    expect(result.treatments.map((row) => row.audienceMetric)).toEqual(['reach', 'views']);
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
        copyMode: 'codex',
        copySlot: 'article',
        copyAssignmentMode: 'firebase-balanced',
        copyExperimentId: 'social-copy-balanced-v1',
        copyPromptVersion: 'frontaliere-social-copy-v1',
        copyPackId: 'pack-1',
        copyTemplateId: 'ig-article-uno',
        copyObjective: 'share',
        copyAngleId: 'article-practical-question',
        copyPillarId: 'strumenti-utili',
        copyAngleIntent: 'both',
        copyHook: 'Un dettaglio utile per chi lavora oltre confine',
        copyCta: 'Approfondisci dal link in bio',
      }] },
    });

    expect(result.rejected).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      creativeId: 'proof',
      creativeVariant: 'baseline',
      engagementMechanic: 'direct-share',
      hookType: 'data-proof',
      engagementLoop: 'share-with-utility',
      copyMode: 'codex',
      copySlot: 'article',
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: 'social-copy-balanced-v1',
      copyPackId: 'pack-1',
      copyTemplateId: 'ig-article-uno',
      copyObjective: 'share',
      copyAngleId: 'article-practical-question',
      copyPillarId: 'strumenti-utili',
      copyAngleIntent: 'both',
      copyHook: 'Un dettaglio utile per chi lavora oltre confine',
    });

    const report = aggregateCreativePerformance(result.rows, { minimumObservations: 1 });
    expect(report.treatments[0]).toMatchObject({
      creativeId: 'proof',
      creativeVariant: 'baseline',
      engagementMechanic: 'direct-share',
      followUpFormat: 'story-poll',
      copyVariants: [{
        copyMode: 'codex',
        copyAssignmentMode: 'firebase-balanced',
        copyExperimentId: 'social-copy-balanced-v1',
        copyPackId: 'pack-1',
        copyTemplateId: 'ig-article-uno',
        copyObjective: 'share',
        copyAngleId: 'article-practical-question',
        copyPillarId: 'strumenti-utili',
        copyAngleIntent: 'both',
        observations: 1,
      }],
    });
  });

  it('reports copy outcomes descriptively without lowering treatment eligibility', () => {
    const report = buildCreativeReport([
      {
        id: 'ig-copy-a',
        matchMethod: 'ledger-media-id',
        creativeId: 'proof',
        kind: 'article',
        reach: 100,
        shares: 10,
        copyMode: 'codex',
        copyPackId: 'pack-1',
        copyTemplateId: 'ig-article-uno',
      },
      {
        id: 'ig-copy-b',
        matchMethod: 'ledger-media-id',
        creativeId: 'proof',
        kind: 'article',
        reach: 100,
        shares: 5,
        copyMode: 'codex',
        copyPackId: 'pack-1',
        copyTemplateId: 'ig-article-due',
      },
    ]);

    expect(report.treatments[0]).toMatchObject({
      observations: 2,
      eligible: false,
      status: 'needs-1-more',
      copyVariants: expect.arrayContaining([
        expect.objectContaining({ copyTemplateId: 'ig-article-uno', observations: 1, primaryRate: 0.1 }),
        expect.objectContaining({ copyTemplateId: 'ig-article-due', observations: 1, primaryRate: 0.05 }),
      ]),
    });
  });

  it('rejects a Codex copy objective that conflicts with the creative objective', () => {
    const report = buildCreativeReport([
      {
        id: 'ig-copy-conflict',
        matchMethod: 'ledger-media-id',
        creativeId: 'proof',
        kind: 'article',
        reach: 100,
        shares: 10,
        copyMode: 'codex',
        copyObjective: 'save',
      },
    ]);

    expect(report.acceptedRows).toBe(0);
    expect(report.rejectedRows).toEqual([
      expect.objectContaining({ reason: 'copy objective conflicts with creative objective' }),
    ]);
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
      { id: 'window-24', matchMethod: 'ledger-media-id', creativeId: 'proof', reach: 100, shares: 10, windowHours: 24 },
      { id: 'window-72', matchMethod: 'ledger-media-id', creativeId: 'proof', reach: 200, shares: 15, windowHours: 72 },
    ]).rows;
    const report = aggregateCreativePerformance(normalized, { minimumObservations: 1 });

    expect(report.treatments.map((treatment) => treatment.windowHours)).toEqual([24, 72]);
    expect(report.treatments.every((treatment) => treatment.observations === 1)).toBe(true);
  });

  it('does not pool different content kinds into one treatment decision', () => {
    const normalized = normalizeInsightRows([
      { id: 'article-1', matchMethod: 'ledger-media-id', creativeId: 'proof-local', kind: 'article', reach: 100, shares: 10 },
      { id: 'article-2', matchMethod: 'ledger-media-id', creativeId: 'proof-local', kind: 'article', reach: 100, shares: 10 },
      { id: 'job-1', matchMethod: 'ledger-media-id', creativeId: 'proof-local', kind: 'job', reach: 100, shares: 10 },
      { id: 'job-2', matchMethod: 'ledger-media-id', creativeId: 'proof-local', kind: 'job', reach: 100, shares: 10 },
    ]).rows;
    const report = aggregateCreativePerformance(normalized);

    expect(report.treatments).toEqual([
      expect.objectContaining({ creativeId: 'proof-local', kind: 'article', observations: 2, status: 'needs-1-more' }),
      expect.objectContaining({ creativeId: 'proof-local', kind: 'job', observations: 2, status: 'needs-1-more' }),
    ]);
    expect(report.exploratoryWinner).toBeNull();
  });

  it('keeps the four-arm background test separate from the message treatment', () => {
    const normalized = normalizeInsightRows([
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `navy-${index}`,
        matchMethod: 'ledger-media-id',
        creativeId: 'proof',
        backgroundExperimentId: 'instagram-carousel-background-v1',
        backgroundVariant: 'navy-gradient',
        backgroundLabel: 'Blu notte · controllo',
        kind: 'article',
        reach: 100,
        shares: 10,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `paper-${index}`,
        matchMethod: 'ledger-media-id',
        creativeId: 'proof',
        backgroundExperimentId: 'instagram-carousel-background-v1',
        backgroundVariant: 'paper-amber',
        backgroundLabel: 'Carta calda',
        kind: 'article',
        reach: 100,
        shares: 4,
      })),
    ]).rows;
    const report = aggregateCreativePerformance(normalized);

    expect(report.treatments).toEqual([
      expect.objectContaining({
        creativeId: 'proof',
        backgroundVariant: 'navy-gradient',
        backgroundLabel: 'Blu notte · controllo',
        observations: 3,
        eligible: true,
      }),
      expect.objectContaining({
        creativeId: 'proof',
        backgroundVariant: 'paper-amber',
        backgroundLabel: 'Carta calda',
        observations: 3,
        eligible: true,
      }),
    ]);
    expect(report.methodology.comparisonUnit).toContain('background variant');
    expect(report.exploratoryWinner).toBe('proof--bg-navy-gradient');
  });
});
