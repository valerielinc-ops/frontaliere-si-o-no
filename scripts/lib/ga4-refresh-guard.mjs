/**
 * Keep refresh consumers fail-closed when a paged GA4 report did not cover
 * the whole population. A partial batch must not be mistaken for a clean
 * zero/negative SEO signal or replace the previous snapshot.
 */
export function guardCompleteGa4Report(report = {}) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const complete = report.complete === true;
  const reportedRows = report.reportedRows ?? report.rowCount ?? null;
  const source = {
    ok: complete,
    complete,
    rowsScanned: rows.length,
    reportedRows,
  };

  if (!complete) {
    source.reason = `incomplete GA4 response (${rows.length}/${reportedRows ?? 'unknown'} rows)`;
  }

  return {
    accepted: complete,
    rows: complete ? rows : [],
    source,
  };
}
