import { describe, expect, it } from 'vitest';

import {
  buildChannelRows,
  buildConversionSummary,
  buildLandingMatrix,
  buildReportBodies,
  diffByKey,
} from '../scripts/lib/conversion-funnel-report.mjs';

describe('conversion funnel report helpers', () => {
  it('builds read-only GA4 filters for the clean conversion signals', () => {
    const bodies = buildReportBodies({ startDate: '2026-09-01', endDate: '2026-09-07' });

    expect(bodies.conversions.calculate.dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: 'eventName',
              stringFilter: { matchType: 'EXACT', value: 'funnel_step' },
            },
          },
          {
            filter: {
              fieldName: 'customEvent:step_name',
              stringFilter: { matchType: 'EXACT', value: 'calculate' },
            },
          },
        ],
      },
    });
    expect(bodies.conversions.newsletter_subscribe.dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: 'eventName',
              stringFilter: { matchType: 'EXACT', value: 'newsletter' },
            },
          },
          {
            filter: {
              fieldName: 'customEvent:action',
              stringFilter: { matchType: 'EXACT', value: 'subscribe' },
            },
          },
        ],
      },
    });
  });

  it('joins landing pages and conversion sessions while flagging unattributed traffic', () => {
    const landing = {
      rows: [
        {
          dimensionValues: [{ value: '/prezzi-benzina/oggi' }],
          metricValues: [
            { value: '100' },
            { value: '70' },
            { value: '0.7' },
            { value: '0.3' },
          ],
        },
        {
          dimensionValues: [{ value: '(not set)' }],
          metricValues: [
            { value: '20' },
            { value: '4' },
            { value: '0.2' },
            { value: '0.8' },
          ],
        },
      ],
    };
    const newsletter = {
      rows: [{
        dimensionValues: [{ value: '/prezzi-benzina/oggi' }],
        metricValues: [{ value: '3' }, { value: '2' }, { value: '2' }],
      }],
    };
    const matrix = buildLandingMatrix(landing, { newsletter_subscribe: newsletter });
    const fuel = matrix.find((row) => row.landingPage === '/prezzi-benzina/oggi');
    const unattributed = matrix.find((row) => row.landingPage === '(not set)');

    expect(fuel).toMatchObject({
      sessions: 100,
      engagedSessions: 70,
      newsletter_subscribe: {
        events: 3,
        conversionSessions: 2,
        rate: 0.02,
      },
    });
    expect(unattributed).toMatchObject({ qualityFlag: 'not_set', sessions: 20 });
  });

  it('keeps AI and email channel rows visible and computes period deltas', () => {
    const channels = buildChannelRows({
      rows: [
        { dimensionValues: [{ value: 'AI Assistant' }], metricValues: [{ value: '12' }, { value: '10' }, { value: '0.8333' }] },
        { dimensionValues: [{ value: 'Email' }], metricValues: [{ value: '8' }, { value: '6' }, { value: '0.75' }] },
      ],
    });
    const current = [{ landingPage: '/en/find-jobs-zurich', sessions: 12, engagementRate: 0.4 }];
    const previous = [{ landingPage: '/en/find-jobs-zurich', sessions: 8, engagementRate: 0.5 }];

    expect(channels.map((row) => row.channel)).toEqual(['AI Assistant', 'Email']);
    expect(diffByKey(current, previous)[0]).toMatchObject({
      previousSessions: 8,
      sessionDelta: 4,
      sessionDeltaRate: 0.5,
    });
    expect(diffByKey(current, previous)[0].engagementRateDelta).toBeCloseTo(-0.1, 10);
  });

  it('summarizes the conversion rate against the landing-page session base', () => {
    const summary = buildConversionSummary(
      { rows: [{ dimensionValues: [{ value: '/jobs' }], metricValues: [{ value: '50' }] }] },
      { calculate: { rows: [{ dimensionValues: [{ value: '/jobs' }], metricValues: [{ value: '8' }, { value: '5' }, { value: '5' }] }] } },
    );
    expect(summary.calculate).toMatchObject({ events: 8, conversionSessions: 5, rate: 0.1 });
  });
});
