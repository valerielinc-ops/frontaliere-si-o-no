import { describe, expect, it } from 'vitest';
import { ADSENSE_REPORT_MAX_ROWS, adsenseReportCoverage, requireCompleteAdsenseReport } from '../../scripts/lib/adsense-report-coverage.mjs';

describe('AdSense reports.generate completeness', () => {
  it('accepts an exactly full response when the API confirms no rows are missing', () => {
    const report = { totalMatchedRows: String(ADSENSE_REPORT_MAX_ROWS), rows: Array(ADSENSE_REPORT_MAX_ROWS).fill({ cells: [] }) };
    expect(requireCompleteAdsenseReport(report)).toEqual({ complete: true, truncated: false, returnedRows: 100_000, totalMatchedRows: 100_000 });
    expect(adsenseReportCoverage({ ...report, totalMatchedRows: '100001' })).toMatchObject({ complete: false, truncated: true });
  });

  it('distinguishes a confirmed empty report from an unknown population', () => {
    expect(requireCompleteAdsenseReport({ totalMatchedRows: '0' })).toMatchObject({ complete: true, returnedRows: 0, totalMatchedRows: 0 });
    expect(() => requireCompleteAdsenseReport({})).toThrow(/completeness unknown/);
    expect(() => requireCompleteAdsenseReport({ totalMatchedRows: '0', rows: {} })).toThrow(/completeness unknown/);
  });

  it('rejects internally inconsistent totals as well as missing rows', () => {
    expect(() => requireCompleteAdsenseReport({ totalMatchedRows: '0', rows: [{}] })).toThrow(/completeness unknown/);
    expect(() => requireCompleteAdsenseReport({ totalMatchedRows: '2', rows: [{}] })).toThrow(/1\/2 rows/);
  });
});
