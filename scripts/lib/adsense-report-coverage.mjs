/** reports.generate has one response, capped at 100,000 rows, not token pagination.
 * https://developers.google.com/adsense/management/reference/rest/v2/accounts.reports/generate
 */
export const ADSENSE_REPORT_MAX_ROWS = 100_000;

export function adsenseReportCoverage(report) {
  const rawTotal = report?.totalMatchedRows;
  const parsedTotal = typeof rawTotal === 'number' || (typeof rawTotal === 'string' && /^\d+$/.test(rawTotal))
    ? Number(rawTotal) : NaN;
  const totalMatchedRows = Number.isSafeInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
  const validRows = report?.rows === undefined || Array.isArray(report.rows);
  const returnedRows = Array.isArray(report?.rows) ? report.rows.length : 0;
  return {
    complete: validRows && totalMatchedRows !== null && returnedRows === totalMatchedRows,
    returnedRows,
    totalMatchedRows,
    truncated: totalMatchedRows !== null && returnedRows < totalMatchedRows,
  };
}

export function requireCompleteAdsenseReport(report, label = 'AdSense report') {
  const coverage = adsenseReportCoverage(report);
  if (!coverage.complete) throw new Error(`${label} truncated or completeness unknown (${coverage.returnedRows}/${coverage.totalMatchedRows ?? 'unknown'} rows)`);
  return coverage;
}
