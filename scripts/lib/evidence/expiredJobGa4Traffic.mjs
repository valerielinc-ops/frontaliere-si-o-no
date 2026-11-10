// Dedicated GA4 evidence for expired job pages. Unlike ga4Fetcher.mjs this
// report deliberately has no sessionMedium filter and keeps every page with
// at least one session, so absence can prove zero only with complete coverage.
import { GA4_READONLY_SCOPE, getServiceAccountToken, paginateGa4Report } from '../ga4-service-account.mjs';
import { normalizeExpiredJobPagePath } from '../../../build-plugins/shared/expiredJobEdgePolicy.mjs';

function normalizePropertyId(raw) {
  if (!raw) return null;
  return raw.startsWith('properties/') ? raw : `properties/${raw}`;
}

function safeError(err) {
  const message = String(err?.message || err || 'GA4 fetch failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .split(/\r?\n/, 1)[0]
    .slice(0, 180);
  return message || 'GA4 fetch failed';
}

function hasCoverageRestriction(metadata = {}) {
  return Boolean(
    metadata.dataLossFromOtherRow
    || metadata.subjectToThresholding
    || metadata.dataTruncationReasons?.length
    || metadata.schemaRestrictionResponse?.activeMetricRestrictions?.length
    || metadata.samplingMetadatas?.some((sample) => (
      Number(sample.samplesReadCount) < Number(sample.samplingSpaceSize)
    )),
  );
}

/**
 * Fetch every GA4 pagePath with sessions >= 1 for the supplied 90-day range.
 * Coverage is complete only when pagination reaches rowCount and GA4 reports
 * no sampling, thresholding, truncation, or row restrictions.
 */
export async function fetchExpiredJobGa4Traffic({
  startDate,
  endDate,
  propertyId,
  fetchImpl = fetch,
  getTokenImpl = () => getServiceAccountToken([GA4_READONLY_SCOPE]),
  now = () => new Date(),
  pageSize = 100_000,
} = {}) {
  const generatedAt = now().toISOString();
  const dateRange = { startDate: String(startDate ?? ''), endDate: String(endDate ?? '') };
  const empty = {
    version: 1,
    generatedAt,
    dateRange,
    pages: {},
    coverage: { complete: false, returnedRows: 0, reportedRows: null },
  };

  try {
    const startDateMs = Date.parse(`${dateRange.startDate}T00:00:00Z`);
    const endDateMs = Date.parse(`${dateRange.endDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRange.startDate)
      || !/^\d{4}-\d{2}-\d{2}$/.test(dateRange.endDate)
      || !Number.isFinite(startDateMs)
      || !Number.isFinite(endDateMs)
      || startDateMs > endDateMs) {
      throw new Error('invalid GA4 date range');
    }
    const property = normalizePropertyId(propertyId || process.env.GA4_PROPERTY_ID);
    if (!property) throw new Error('no GA4_PROPERTY_ID');
    const token = await getTokenImpl();
    if (!token) throw new Error('no service-account token');

    const url = `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`;
    const report = await paginateGa4Report({
      pageSize,
      body: {
        dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'sessions' }],
      },
      fetchPage: async (body) => {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`GA4 request failed (${response.status})`);
        return response.json();
      },
    });

    const pages = Object.create(null);
    let rowsValid = true;
    for (const row of report.rows) {
      const pagePath = normalizeExpiredJobPagePath(row.dimensionValues?.[0]?.value);
      const rawSessions = row.metricValues?.[0]?.value;
      const sessions = Number(rawSessions);
      if (!pagePath || rawSessions == null || !Number.isSafeInteger(sessions) || sessions < 1) {
        rowsValid = false;
        continue;
      }
      const totalSessions = (pages[pagePath] ?? 0) + sessions;
      if (!Number.isSafeInteger(totalSessions)) {
        rowsValid = false;
        continue;
      }
      pages[pagePath] = totalSessions;
    }

    const complete = report.complete && rowsValid && !hasCoverageRestriction(report.metadata);
    return {
      ...empty,
      pages,
      coverage: {
        complete,
        returnedRows: report.rows.length,
        reportedRows: Number.isSafeInteger(report.rowCount) ? report.rowCount : null,
        pageCount: report.pages,
      },
      ...(!complete ? { error: 'GA4 report coverage is incomplete or restricted' } : {}),
    };
  } catch (err) {
    return { ...empty, error: safeError(err) };
  }
}
