/**
 * Pure helpers for the weekly conversion-funnel report.
 *
 * The report deliberately uses only GA4 Data API read queries. Keeping the
 * request shapes and aggregation here makes the CLI testable without network
 * access and gives future dashboards one stable data contract.
 */

export const CONVERSION_DEFINITIONS = [
  {
    key: 'calculate',
    label: 'Calcolo avviato',
    eventName: 'funnel_step',
    parameterName: 'step_name',
    parameterValue: 'calculate',
  },
  {
    key: 'newsletter_subscribe',
    label: 'Newsletter iscritta',
    eventName: 'newsletter',
    parameterName: 'action',
    parameterValue: 'subscribe',
  },
  {
    key: 'job_apply',
    label: 'Candidatura avviata',
    eventName: 'job_apply',
  },
  {
    key: 'job_alert_created',
    label: 'Job alert creato',
    eventName: 'job_alert_created',
  },
  {
    key: 'affiliate_click',
    label: 'Click affiliato',
    eventName: 'affiliate_click',
  },
];

// Keep the baseline complete enough for `(not set)` and conversion rates;
// the CLI still prints only the top rows. GA4 accepts this bounded page size.
const DEFAULT_LIMIT = 10000;

function exactStringFilter(fieldName, value) {
  return {
    filter: {
      fieldName,
      stringFilter: {
        matchType: 'EXACT',
        value,
      },
    },
  };
}

function buildEventFilter(definition) {
  const filters = [exactStringFilter('eventName', definition.eventName)];
  if (definition.parameterName) {
    filters.push(exactStringFilter(
      `customEvent:${definition.parameterName}`,
      definition.parameterValue,
    ));
  }
  return filters.length === 1 ? filters[0] : { andGroup: { expressions: filters } };
}

function normalizeLimit(limit) {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT;
  return Math.min(10000, Math.max(1, Math.floor(numeric)));
}

function commonBody({ startDate, endDate, limit }) {
  return {
    dateRanges: [{ startDate, endDate }],
    limit: normalizeLimit(limit),
  };
}

export function buildReportBodies({ startDate, endDate, limit = DEFAULT_LIMIT } = {}) {
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');

  const normalizedLimit = normalizeLimit(limit);
  const landingPages = {
    ...commonBody({ startDate, endDate, limit: normalizedLimit }),
    dimensions: [{ name: 'landingPage' }],
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'engagementRate' },
      { name: 'bounceRate' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  };

  const channels = {
    ...commonBody({ startDate, endDate, limit: normalizedLimit }),
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'engagementRate' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  };

  const conversions = Object.fromEntries(
    CONVERSION_DEFINITIONS.map((definition) => [definition.key, {
      ...commonBody({ startDate, endDate, limit: normalizedLimit }),
      dimensions: [{ name: 'landingPage' }],
      metrics: [
        { name: 'eventCount' },
        { name: 'sessions' },
        { name: 'totalUsers' },
      ],
      dimensionFilter: buildEventFilter(definition),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    }]),
  );

  return { landingPages, channels, conversions };
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Convert a raw GA4 response into dimension/metric arrays without losing 0s. */
export function parseGa4Rows(data) {
  return (Array.isArray(data?.rows) ? data.rows : []).map((row) => ({
    dimensions: (row.dimensionValues || []).map((item) => item?.value || '(not set)'),
    metrics: (row.metricValues || []).map((item) => numericValue(item?.value)),
  }));
}

function emptyConversion() {
  return { events: 0, conversionSessions: 0, users: 0, rate: 0 };
}

function createLandingRow(landingPage) {
  return {
    landingPage,
    sessions: 0,
    engagedSessions: 0,
    engagementRate: 0,
    bounceRate: 0,
    qualityFlag: landingPage === '(not set)' ? 'not_set' : null,
  };
}

function conversionMetricName(definition) {
  return definition.key;
}

/**
 * Join the landing-page baseline with one event-filtered report per
 * conversion. The resulting rows are intentionally wide: they are useful in
 * JSON, CLI output and a future sheet/dashboard without a second join.
 */
export function buildLandingMatrix(landingData, conversionReports = {}) {
  const rowsByLandingPage = new Map();
  for (const row of parseGa4Rows(landingData)) {
    const landingPage = row.dimensions[0] || '(not set)';
    const item = rowsByLandingPage.get(landingPage) || createLandingRow(landingPage);
    item.sessions += row.metrics[0] || 0;
    item.engagedSessions += row.metrics[1] || 0;
    item.engagementRate = item.sessions > 0 ? item.engagedSessions / item.sessions : 0;
    item.bounceRate = row.metrics[3] ?? (item.sessions > 0 ? 1 - item.engagementRate : 0);
    rowsByLandingPage.set(landingPage, item);
  }

  for (const definition of CONVERSION_DEFINITIONS) {
    const conversionKey = conversionMetricName(definition);
    const reportRows = parseGa4Rows(conversionReports[conversionKey]);
    for (const row of reportRows) {
      const landingPage = row.dimensions[0] || '(not set)';
      const item = rowsByLandingPage.get(landingPage) || createLandingRow(landingPage);
      const conversion = item[conversionKey] || emptyConversion();
      conversion.events += row.metrics[0] || 0;
      conversion.conversionSessions += row.metrics[1] || 0;
      conversion.users += row.metrics[2] || 0;
      conversion.rate = item.sessions > 0 ? conversion.conversionSessions / item.sessions : 0;
      item[conversionKey] = conversion;
      rowsByLandingPage.set(landingPage, item);
    }
  }

  const rows = [...rowsByLandingPage.values()];
  for (const row of rows) {
    for (const definition of CONVERSION_DEFINITIONS) {
      const key = conversionMetricName(definition);
      row[key] ||= emptyConversion();
      row[key].rate = row.sessions > 0 ? row[key].conversionSessions / row.sessions : 0;
    }
  }
  return rows.sort((a, b) => b.sessions - a.sessions || a.landingPage.localeCompare(b.landingPage));
}

export function buildChannelRows(data) {
  return parseGa4Rows(data)
    .map((row) => ({
      channel: row.dimensions[0] || '(not set)',
      sessions: row.metrics[0] || 0,
      engagedSessions: row.metrics[1] || 0,
      engagementRate: row.metrics[2] || 0,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.channel.localeCompare(b.channel));
}

/** Match two report arrays by a stable key and expose a session delta. */
export function diffByKey(currentRows, previousRows, key = 'landingPage') {
  const previousByKey = new Map((previousRows || []).map((row) => [row[key], row]));
  return (currentRows || []).map((row) => {
    const previous = previousByKey.get(row[key]);
    const previousSessions = previous?.sessions || 0;
    return {
      ...row,
      previousSessions,
      sessionDelta: row.sessions - previousSessions,
      sessionDeltaRate: previousSessions > 0 ? (row.sessions - previousSessions) / previousSessions : null,
      previousEngagementRate: previous?.engagementRate || 0,
      engagementRateDelta: row.engagementRate - (previous?.engagementRate || 0),
    };
  });
}

export function buildConversionSummary(landingData, conversionReports = {}) {
  const totalSessions = parseGa4Rows(landingData).reduce((sum, row) => sum + (row.metrics[0] || 0), 0);
  return Object.fromEntries(CONVERSION_DEFINITIONS.map((definition) => {
    const rows = parseGa4Rows(conversionReports[definition.key]);
    const events = rows.reduce((sum, row) => sum + (row.metrics[0] || 0), 0);
    const conversionSessions = rows.reduce((sum, row) => sum + (row.metrics[1] || 0), 0);
    const users = rows.reduce((sum, row) => sum + (row.metrics[2] || 0), 0);
    return [definition.key, {
      label: definition.label,
      events,
      conversionSessions,
      users,
      rate: totalSessions > 0 ? conversionSessions / totalSessions : 0,
    }];
  }));
}

export function buildDataQuality(landingRows) {
  const notSet = landingRows.find((row) => row.landingPage === '(not set)');
  const notSetSessions = notSet?.sessions || 0;
  const totalSessions = landingRows.reduce((sum, row) => sum + row.sessions, 0);
  const notSetRate = totalSessions > 0 ? notSetSessions / totalSessions : 0;
  return {
    notSetSessions,
    notSetRate,
    warning: notSetRate >= 0.1
      ? 'Una quota elevata di sessioni non ha una landing page attribuibile: interpreta i tassi per pagina con cautela.'
      : null,
  };
}
