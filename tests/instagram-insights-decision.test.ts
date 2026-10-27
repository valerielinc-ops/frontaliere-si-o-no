import { describe, expect, it } from 'vitest';

import {
  buildAutonomousDecisions,
  decisionStateChanges,
  mergeAutonomousDecisionState,
  resolveInstagramDecisionConfig,
} from '../scripts/lib/instagram-insights-decision.mjs';
import { buildCreativeReport } from '../scripts/lib/instagram-insights-report.mjs';

function rowsFor(creativeId: string, shares: number[], overrides: Record<string, unknown> = {}) {
  return shares.map((value, index) => ({
    id: `${creativeId}-${index}`,
    creativeId,
    kind: 'article',
    reach: 100,
    shares: value,
    ...overrides,
  }));
}

function reportFrom(rows: Record<string, unknown>[]) {
  return buildCreativeReport(rows, { minimumObservations: 3, windowHours: 72 });
}

describe('Instagram autonomous Insights decisions', () => {
  it('requires a comparable second variant and three independent observations', () => {
    const report = reportFrom(rowsFor('proof', [8, 8, 8]));
    const decisions = buildAutonomousDecisions(report);

    expect(decisions.creativeComparisons[0]).toMatchObject({
      status: 'needs-comparator',
      winner: null,
    });
    expect(decisions.winnerCount).toBe(0);
  });

  it('promotes the primary-metric leader only after both lift gates pass', () => {
    const report = reportFrom([
      ...rowsFor('proof', [2, 2, 2]),
      ...rowsFor('proof-local', [8, 8, 8]),
    ]);
    const decisions = buildAutonomousDecisions(report);

    expect(decisions.creativeComparisons).toHaveLength(1);
    expect(decisions.creativeComparisons[0]).toMatchObject({
      status: 'winner',
      winnerKey: 'article:proof:share',
      winner: expect.objectContaining({ creativeId: 'proof-local', observations: 3 }),
    });
    expect(decisions.creativeWinners).toEqual({ article: { proof: { share: 'proof-local' } } });
  });

  it('keeps a zero-signal or low-lift test in exploration', () => {
    const zero = buildAutonomousDecisions(reportFrom([
      ...rowsFor('proof', [0, 0, 0]),
      ...rowsFor('proof-local', [0, 0, 0]),
    ]));
    expect(zero.creativeComparisons[0].status).toBe('insufficient-signal');

    const lowLift = buildAutonomousDecisions(reportFrom([
      ...rowsFor('proof', [9.5, 9.5, 9.5]),
      ...rowsFor('proof-local', [10, 10, 10]),
    ]));
    expect(lowLift.creativeComparisons[0].status).toBe('insufficient-lift');
    expect(lowLift.creativeWinners).toEqual({});
  });

  it('evaluates background arms separately from creative variants', () => {
    const report = reportFrom([
      ...rowsFor('proof', [2, 2, 2], { backgroundVariant: 'navy-gradient', backgroundExperimentId: 'instagram-carousel-background-v1' }),
      ...rowsFor('proof', [8, 8, 8], { backgroundVariant: 'paper-amber', backgroundExperimentId: 'instagram-carousel-background-v1' }),
    ]);
    const decisions = buildAutonomousDecisions(report);

    expect(decisions.backgroundComparisons[0]).toMatchObject({
      status: 'winner',
      winnerKey: 'article:proof:share',
      winner: expect.objectContaining({ backgroundVariant: 'paper-amber' }),
    });
    expect(decisions.backgroundWinners).toEqual({ 'article:proof:share': 'paper-amber' });
  });

  it('resets stale winners for evaluated scopes and returns only actual Remote Config changes', () => {
    const current = {
      creativeWinners: { article: { proof: { share: 'proof' } } },
      backgroundWinners: { 'article:proof:share': 'navy-gradient' },
    };
    const next = mergeAutonomousDecisionState({
      currentCreativeWinners: current.creativeWinners,
      currentBackgroundWinners: current.backgroundWinners,
      decisions: {
        creativeComparisons: [{
          type: 'creative',
          kind: 'article',
          baseId: 'proof',
          objective: 'share',
          status: 'winner',
          winner: { creativeId: 'proof-local' },
        }],
        backgroundComparisons: [{
          type: 'background',
          kind: 'article',
          creativeId: 'proof',
          objective: 'share',
          status: 'insufficient-lift',
        }],
      },
    });
    expect(next).toEqual({
      creativeWinners: { article: { proof: { share: 'proof-local' } } },
      backgroundWinners: {},
    });
    expect(decisionStateChanges(current, next)).toEqual([{
      parameter: 'INSTAGRAM_AUTONOMOUS_CREATIVE_WINNERS',
      value: '{"article":{"proof":{"share":"proof-local"}}}',
    }, {
      parameter: 'INSTAGRAM_CAROUSEL_BACKGROUND_AB_WINNERS',
      value: '{}',
    }]);
  });

  it('keeps creative and background winners objective-scoped', () => {
    const report = reportFrom([
      ...rowsFor('proof-views-a', [8, 8, 8], {
        creativeBaseId: 'proof',
        objective: 'share',
        primaryMetric: 'shares',
      }),
      ...rowsFor('proof-views-b', [2, 2, 2], {
        creativeBaseId: 'proof',
        objective: 'share',
        primaryMetric: 'shares',
      }),
      ...rowsFor('proof-shares-a', [2, 2, 2], {
        creativeBaseId: 'proof',
        objective: 'save',
        primaryMetric: 'saves',
        saves: 2,
        shares: 0,
      }),
      ...rowsFor('proof-shares-b', [8, 8, 8], {
        creativeBaseId: 'proof',
        objective: 'save',
        primaryMetric: 'saves',
        saves: 8,
        shares: 0,
      }),
      ...rowsFor('proof', [8, 8, 8], {
        objective: 'share',
        primaryMetric: 'shares',
        backgroundVariant: 'navy-gradient',
        backgroundExperimentId: 'instagram-carousel-background-v1',
      }),
      ...rowsFor('proof', [2, 2, 2], {
        objective: 'share',
        primaryMetric: 'shares',
        backgroundVariant: 'paper-amber',
        backgroundExperimentId: 'instagram-carousel-background-v1',
      }),
      ...rowsFor('proof', [2, 2, 2], {
        objective: 'save',
        primaryMetric: 'saves',
        saves: 2,
        shares: 0,
        backgroundVariant: 'navy-gradient',
        backgroundExperimentId: 'instagram-carousel-background-v1',
      }),
      ...rowsFor('proof', [8, 8, 8], {
        objective: 'save',
        primaryMetric: 'saves',
        saves: 8,
        shares: 0,
        backgroundVariant: 'paper-amber',
        backgroundExperimentId: 'instagram-carousel-background-v1',
      }),
    ]);
    const decisions = buildAutonomousDecisions(report);

    expect(decisions.creativeWinners).toEqual({
      article: {
        proof: {
          save: 'proof-shares-b',
          share: 'proof-views-a',
        },
      },
    });
    expect(decisions.creativeComparisons.map((comparison) => comparison.winnerKey)).toEqual([
      'article:proof:save',
      'article:proof:share',
    ]);
    expect(decisions.backgroundWinners).toEqual({
      'article:proof:save': 'paper-amber',
      'article:proof:share': 'navy-gradient',
    });
  });

  it('uses safe local defaults and parses Remote Config settings', () => {
    expect(resolveInstagramDecisionConfig({})).toMatchObject({
      enabled: false,
      windowHours: 72,
      minimumObservations: 3,
      minimumRelativeLift: 0.15,
      minimumAbsoluteLift: 0.005,
      currentCreativeWinners: {},
      currentBackgroundWinners: {},
    });
    expect(resolveInstagramDecisionConfig({
      INSTAGRAM_INSIGHTS_AUTONOMOUS_DECISIONS_ENABLED: 'true',
      INSTAGRAM_INSIGHTS_DECISION_WINDOW_HOURS: '72',
      INSTAGRAM_INSIGHTS_MIN_OBSERVATIONS: '4',
      INSTAGRAM_INSIGHTS_MIN_RELATIVE_LIFT: '0.2',
      INSTAGRAM_INSIGHTS_MIN_ABSOLUTE_LIFT: '0.01',
      INSTAGRAM_AUTONOMOUS_CREATIVE_WINNERS: '{"article":{"proof":{"share":"proof-local"}}}',
      INSTAGRAM_CAROUSEL_BACKGROUND_AB_WINNERS: '{"article:proof:share":"paper-amber"}',
    })).toMatchObject({
      enabled: true,
      minimumObservations: 4,
      minimumRelativeLift: 0.2,
      minimumAbsoluteLift: 0.01,
      currentCreativeWinners: { article: { proof: { share: 'proof-local' } } },
      currentBackgroundWinners: { 'article:proof:share': 'paper-amber' },
    });
  });
});
