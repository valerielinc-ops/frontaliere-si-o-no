import { describe, expect, it, vi } from 'vitest';
import {
  MANUAL_SLOT_DIMENSIONS, MANUAL_SLOT_METRICS,
  fetchManualSlotReport, manualSlotReportParams, parseManualSlotReport, renderManualSlotReport,
} from '../../scripts/lib/adsense-manual-slot-report.mjs';
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const options = { account: 'accounts/pub-test', start: daysAgo(30), end: daysAgo(2), domain: 'frontaliereticino.ch', accountTimeZone: 'Europe/Rome' };
const registry = { HOMEPAGE_MID_DISPLAY: { slot: '42' }, FT_DRIVEBY_ATF_DISPLAY: { slot: '42' } };
function fixture(overrides: Record<string, string> = {}) {
  // Deliberately shuffled headers: parser must use names, not cell order.
  const names = [...MANUAL_SLOT_METRICS, ...MANUAL_SLOT_DIMENSIONS].reverse();
  const values: Record<string, string> = {
    AD_UNIT_ID: 'ca-pub-test:42', AD_UNIT_NAME: 'shared display', PLATFORM_TYPE_CODE: 'HighEndMobile', DOMAIN_NAME: options.domain,
    AD_REQUESTS: '1000', MATCHED_AD_REQUESTS: '850', IMPRESSIONS: '800', ACTIVE_VIEW_MEASURABILITY: '0.95', ACTIVE_VIEW_VIEWABILITY: '0.2', ESTIMATED_EARNINGS: '1.25', ...overrides,
  };
  const apiDate = (value: string) => { const [year, month, day] = value.split('-').map(Number); return { year, month, day }; };
  return { startDate: apiDate(options.start), endDate: apiDate(options.end), totalMatchedRows: '1', headers: names.map((name) => ({ name, ...(name === 'ESTIMATED_EARNINGS' ? { currencyCode: 'EUR' } : {}) })), rows: [{ cells: names.map((name) => ({ value: values[name] })) }] };
}
describe('AdSense network slot × device report', () => {
  it('queries an exact domain with every network denominator and no PAGE_VIEWS RPM', () => {
    const params = manualSlotReportParams(options);
    expect(params.getAll('dimensions')).toEqual(MANUAL_SLOT_DIMENSIONS);
    expect(params.getAll('metrics')).toEqual(MANUAL_SLOT_METRICS);
    expect(params.getAll('filters')).toEqual(['DOMAIN_NAME==frontaliereticino.ch']);
    expect(params.get('reportingTimeZone')).toBe('ACCOUNT_TIME_ZONE');
    expect(params.getAll('metrics')).not.toContain('PAGE_VIEWS_RPM');
  });
  it('reads ratios and currency by headers and never reconstructs missing counts or homepage revenue', () => {
    const report = parseManualSlotReport(fixture(), { ...options, registry });
    expect(report.rows[0]).toMatchObject({ slot: '42', requests: 1000, matched: 850, impressions: 800, measurableRatio: 0.95, viewableRatio: 0.2, measurableCount: null, viewableCount: null, estimatedEarnings: 1.25, currencyCode: 'EUR', sharedUnit: true, coverage: 0.85 });
    expect(report.rows[0].placements).toEqual(['HOMEPAGE_MID_DISPLAY', 'FT_DRIVEBY_ATF_DISPLAY']);
    expect(report.rows[0].attribution).toBe('shared_ad_unit_no_page_attribution');
    expect(report.window).toMatchObject({ start: options.start, end: options.end, inclusive: true, accountTimeZone: 'Europe/Rome' });
    expect(renderManualSlotReport(report)).toContain('(condivisa)');
    expect(renderManualSlotReport(report)).toContain('conteggi esatti misurabili/visibili non sono esposti');
  });
  it('keeps missing values unknown while real zero remains zero', () => {
    const report = parseManualSlotReport(fixture({ AD_REQUESTS: '0', ESTIMATED_EARNINGS: '0', ACTIVE_VIEW_MEASURABILITY: '', ACTIVE_VIEW_VIEWABILITY: '' }), { ...options, registry });
    expect(report.rows[0]).toMatchObject({ requests: 0, estimatedEarnings: 0, coverage: null, measurableRatio: null, viewableRatio: null });
  });
  it('rejects truncated, wrong-domain and currency-less results', () => {
    expect(() => parseManualSlotReport({ ...fixture(), totalMatchedRows: '2' }, options)).toThrow(/truncated/);
    expect(() => parseManualSlotReport(fixture({ DOMAIN_NAME: 'other.example' }), options)).toThrow(/another domain/);
    const report = fixture(); report.headers.forEach((header) => { delete header.currencyCode; });
    expect(() => parseManualSlotReport(report, options)).toThrow(/currency/);
  });
  it('surfaces network warnings and rejects a date window changed by the API', () => {
    const report = fixture();
    const warned = parseManualSlotReport({ ...report, warnings: ['Some data may be delayed'] }, options);
    expect(warned.status).toBe('complete_with_warnings');
    expect(renderManualSlotReport(warned)).toContain('Some data may be delayed');
    expect(() => parseManualSlotReport({ ...report, endDate: report.startDate }, options)).toThrow(/actual date window/);
  });
  it('uses the returned currency and does not silently relabel money', () => {
    const report = fixture(); report.headers.find((header) => header.name === 'ESTIMATED_EARNINGS')!.currencyCode = 'CHF';
    expect(parseManualSlotReport(report, options).rows[0].currencyCode).toBe('CHF');
  });
  it('reports source failures rather than fabricated zeros and avoids leaking response bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'private-error-body' });
    await expect(fetchManualSlotReport({ ...options, token: 'test-token', fetchImpl })).rejects.toThrow('AdSense manual slot report HTTP 403');
    expect(renderManualSlotReport({ status: 'unmeasurable', reason: 'HTTP 403' })).toContain('non misurabile');
  });
});
