import { describe, expect, it } from 'vitest';
import {
  aggregateLandingValue,
  buildLandingValueReport,
  buildReportBodies,
  parseArgs,
  renderMarkdown,
} from '../scripts/landing-value-report.mjs';
import { buildAutomationFleetExclusion } from '../scripts/lib/ga4-automation-fleet.mjs';

const row = (landing: string, metrics: number[]) => ({
  dimensionValues: [{ value: landing }],
  metricValues: metrics.map((value) => ({ value: String(value) })),
});

// landings: sessions, engagedSessions, totalAdRevenue, publisherAdClicks
const landingRows = [
  row('/cerca-lavoro-ticino/infermieri-lugano-123/', [100, 90, 2, 20]),
  row('/articoli-frontaliere/tasse-2026/', [200, 180, 0.8, 8]),
  row('/articoli-frontaliere/ristorni/', [100, 90, 0.4, 4]),
  row('(not set)', [999, 0, 9, 90]),
];
// applies: eventCount, sessions
const applyRows = [row('/cerca-lavoro-ticino/infermieri-lugano-123/', [5, 4])];

describe('landing value by template', () => {
  it('turns ad revenue and applications into value per session, indexed on articles', () => {
    const result = aggregateLandingValue({ landingRows, applyRows });
    const job = result.templates.find((t: { pageTemplate: string }) => t.pageTemplate === 'job_detail');
    const article = result.templates.find((t: { pageTemplate: string }) => t.pageTemplate === 'article_detail');
    // revenue per ad click = (2 + 0.8 + 0.4) / (20 + 8 + 4) = 0.1; (not set) is dropped.
    expect(result.model.revenuePerAdClick).toBe(0.1);
    expect(article.sessions).toBe(300);
    expect(article.adRevenuePerSession).toBe(0.004);
    expect(job.appliesPer100).toBe(5);
    expect(job.applySessionsPer100).toBe(4);
    // 2/100 + 5/100 × 0.1 = 0.025 → 0.025 / 0.004 = 6.25×
    expect(job.valuePerSession).toBe(0.025);
    expect(job.valueIndex).toBe(6.25);
    expect(article.valueIndex).toBe(1);
  });

  it('honours an explicit application value', () => {
    const result = aggregateLandingValue({ landingRows, applyRows, applyValue: 1 });
    const job = result.templates.find((t: { pageTemplate: string }) => t.pageTemplate === 'job_detail');
    expect(job.valuePerSession).toBe(0.07);
    expect(result.model.applyValueSource).toBe('--apply-value');
  });

  it('queries organic production sessions with the headless fleet excluded', () => {
    const bodies = buildReportBodies({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-28' } });
    for (const body of [bodies.landings, bodies.applies]) {
      const serialized = JSON.stringify(body.dimensionFilter);
      expect(serialized).toContain('"Organic Search"');
      expect(serialized).toContain('"frontaliereticino.ch"');
      expect(serialized).toContain(JSON.stringify(buildAutomationFleetExclusion()));
    }
    expect(JSON.stringify(bodies.applies.dimensionFilter)).toContain('"job_apply_handoff"');
    expect(JSON.stringify(buildReportBodies({ dateRange: { startDate: 'a', endDate: 'b' }, channel: 'all' }).landings.dimensionFilter)).not.toContain('Organic Search');
  });

  it('builds a dated report from the GA4 runner and flags incomplete coverage', async () => {
    const run = async ({ body }: { body: { metrics: Array<{ name: string }> } }) => (body.metrics.length === 4
      ? { rows: landingRows, metadata: { currencyCode: 'EUR' }, complete: true }
      : { rows: applyRows, metadata: { subjectToThresholding: true }, complete: false });
    const report = await buildLandingValueReport({ token: 't', propertyId: 'properties/1', run: run as never, now: new Date('2026-10-24T08:00:00Z') });
    expect(report.window).toEqual({ startDate: '2026-09-25', endDate: '2026-10-22' });
    expect(report.currency).toBe('EUR');
    expect(report.dataQuality).toEqual(['applies: incomplete pagination', 'applies: thresholding']);
    expect(renderMarkdown(report)).toContain('| job_detail | 100 |');
  });

  it('flags GA4 truncation, schema restrictions, and sampling metadata', async () => {
    const metadata = {
      dataTruncationReasons: ['x'],
      schemaRestrictionResponse: { activeMetricRestrictions: [{}] },
      samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '2' }],
    };
    const report = await buildLandingValueReport({
      token: 't',
      propertyId: 'properties/1',
      run: async () => ({ rows: [], complete: true, metadata }) as never,
    });
    expect(['dataTruncationReasons', 'schemaRestrictionResponse', 'samplingMetadatas']
      .every((key) => report.dataQuality.some((reason) => reason.includes(key)))).toBe(true);
  });

  it('parses CLI options and rejects a negative application value', () => {
    expect(parseArgs(['--days', '56', '--channel', 'all', '--apply-value', '0.5'])).toMatchObject({ days: 56, channel: 'all', applyValue: 0.5 });
    expect(() => parseArgs(['--apply-value', '-1'])).toThrow();
  });
});
