import { describe, expect, it } from 'vitest';
import { buildTrafficFilter, fetchTrafficQuality } from '../scripts/lib/ga4-traffic-quality.mjs';
import { classifyAnalyticsPath } from '../scripts/lib/analytics-opportunity-utils.mjs';
import { deriveAnalyticsPageContext } from '../services/analyticsPageContext';

const end = new Date();
end.setUTCDate(end.getUTCDate() - 2);
const date = end.toISOString().slice(0, 10);
const dateRanges = [{ startDate: date, endDate: date }];
const makeRow = (dimensions: string[], metrics: number[]) => ({ dimensionValues: dimensions.map((value) => ({ value })), metricValues: metrics.map((value) => ({ value: String(value) })) });

function fixture(overrides: { partial?: boolean; failure?: boolean; metadata?: object } = {}) {
  const requests: any[] = [];
  const runReport = async (body: any) => {
    requests.push(body);
    if (overrides.failure) return { ok: false, status: 503, json: async () => ({}) };
    const dimension = body.dimensions[0]?.name;
    let rows;
    if (dimension === 'date') rows = [makeRow([date.replaceAll('-', '')], [100, 60, 30])];
    else if (dimension === 'pagePath') rows = body.offset > 0 ? [] : [makeRow(['/prezzi-benzina/oggi/'], [100, 90, 20, 50, 30]), makeRow(['/'], [50, 80, 60, 50, 40])];
    else if (dimension === 'deviceCategory') rows = [makeRow(['desktop', 'Singapore', '(direct) / (none)'], [1000, 2000, 50, 1500, 2])];
    else rows = [makeRow([], [150, 100, 60, 70, 35, 3])];
    return { ok: true, status: 200, json: async () => ({ rows, rowCount: dimension === 'pagePath' && overrides.partial ? 3 : rows.length, metadata: { currencyCode: 'EUR', ...overrides.metadata } }) };
  };
  return { runReport, requests };
}

describe('GA4 traffic quality populations', () => {
  it('keeps raw ranking, qualified ranking and distinct totals separate on identical settled dates', async () => {
    const { runReport, requests } = fixture();
    const report = await fetchTrafficQuality({ runReport, dateRanges });
    expect(report.raw.top50.map((row) => row.path)).toEqual(['/prezzi-benzina/oggi/', '/']);
    expect(report.qualified.top50.map((row) => row.path)).toEqual(['/', '/prezzi-benzina/oggi/']);
    expect(report.raw.summary.sessions).toBe(100); // not the page-session sum of 170
    expect(report.raw.summary.totalUsers).toBe(70); // not the page-user sum of 100
    expect(report.qualified.summary.adRevenuePerSession).toBe(0.03);
    expect(report.raw.pageViewsByTemplate).toContainEqual({ pageTemplate: 'fuel_detail', views: 100, paths: 1 });
    expect(requests.every((body) => JSON.stringify(body.dateRanges) === JSON.stringify(dateRanges))).toBe(true);
    for (const body of requests) {
      expect(body.dimensionFilter).toEqual(body.dimensionFilter.andGroup ? buildTrafficFilter(true) : buildTrafficFilter(false));
      expect(body.metricFilter).toBeUndefined(); // engaged row filtering cannot identify engaged-only pageviews
    }
    expect(report.qualification.media).toEqual(['organic', 'email', 'newsletter']);
    expect(report.segments.rows[0].reviewReason).toBe('high_volume_short_sessions_not_bot_classification');
  });

  it('marks incomplete pagination instead of treating the observed pages as a complete population', async () => {
    const { runReport, requests } = fixture({ partial: true });
    const report = await fetchTrafficQuality({ runReport, dateRanges });
    expect(requests.some((body) => body.offset === 2)).toBe(true);
    expect(report.raw.pageCoverage.status).toBe('partial');
    expect(report.raw.pageCoverage.reasons).toContain('truncated');
    expect(report.raw.summary.engagementRate).toBeNull();
  });

  it('does not convert failures or privacy-limited results into zero or reliable ratios', async () => {
    const failed = await fetchTrafficQuality({ ...fixture({ failure: true }), dateRanges });
    expect(failed.raw.summary).toBeNull();
    expect(failed.raw.pageCoverage.status).toBe('unavailable');
    expect(failed.raw.engagement.reliable).toBe(false);
    const limited = await fetchTrafficQuality({ ...fixture({ metadata: { subjectToThresholding: true } }), dateRanges });
    expect(limited.raw.status).toBe('limited');
    expect(limited.raw.summary.adRevenuePerSession).toBeNull();
    const restricted = await fetchTrafficQuality({ ...fixture({ metadata: { schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'totalAdRevenue', restrictedMetricTypes: ['REVENUE_DATA'] }] } } }), dateRanges });
    expect(restricted.raw.summary.totalAdRevenue).toBeNull();
    expect(restricted.raw.summary.adRevenuePerSession).toBeNull();
    expect(restricted.raw.totalCoverage.reasons).toContain('restricted_metrics');
  });

  it.each(['/prezzi-benzina/oggi/', '/en/diesel-price-switzerland/today/', '/fr/primes-assurance-maladie/', '/de/grenzwartezeiten/', '/eventi/'])('matches runtime taxonomy for %s', (path) => {
    expect(classifyAnalyticsPath(path)).toEqual(deriveAnalyticsPageContext(path));
  });
});
