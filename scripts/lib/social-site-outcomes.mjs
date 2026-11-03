import {
  GA4_READONLY_SCOPE,
  DEFAULT_GA4_PROPERTY_ID,
  ga4DateRange,
  getServiceAccountToken,
  runGa4ReportPaged,
} from './ga4-service-account.mjs';
import {
  SOCIAL_GA4_ACTION_EVENTS,
  SOCIAL_GA4_ACTION_EVENT_NAMES,
  isSocialGa4SessionKeyEventRateEligible,
  SOCIAL_GA4_CHANNEL_BY_UTM_SOURCE,
  SOCIAL_GA4_CHANNELS,
  SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS,
  SOCIAL_GA4_DATA_LAG_DAYS,
  SOCIAL_GA4_EVENT_CONTRACT_VERSION,
} from './social-ga4-contract.mjs';
import {
  listSocialCopySessionKeyEventMetrics,
  socialCopyGa4ReportIssue,
} from '../social-copy/ga4-performance-brief.mjs';

export const SOCIAL_SITE_OUTCOME_WINDOW_DAYS = SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS;
export const SOCIAL_SITE_OUTCOME_LAG_DAYS = SOCIAL_GA4_DATA_LAG_DAYS;

export const SOCIAL_SITE_OUTCOME_CHANNELS = SOCIAL_GA4_CHANNELS;

function dayFromGa4(value) {
  const raw = String(value || '').trim();
  if (!/^\d{8}$/u.test(raw)) return null;
  const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const time = Date.parse(`${day}T12:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? day : null;
}

function dateRangeDays(startDate, endDate) {
  const start = Date.parse(`${startDate}T12:00:00.000Z`);
  const end = Date.parse(`${endDate}T12:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const days = [];
  for (let current = start; current <= end; current += 24 * 60 * 60 * 1000) {
    days.push(new Date(current).toISOString().slice(0, 10));
  }
  return days;
}

function dateInTimeZone(value, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
    const day = `${values.year}-${values.month}-${values.day}`;
    return dateRangeDays(day, day).length === 1 ? day : null;
  } catch {
    return null;
  }
}

function addCalendarDays(day, days) {
  const value = Date.parse(`${day}T12:00:00.000Z`);
  if (!Number.isFinite(value)) return null;
  return new Date(value + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dateRangeInTimeZone(now, timeZone) {
  const localToday = dateInTimeZone(now, timeZone);
  const endDate = localToday && addCalendarDays(localToday, -SOCIAL_SITE_OUTCOME_LAG_DAYS);
  const startDate = endDate && addCalendarDays(endDate, -SOCIAL_SITE_OUTCOME_WINDOW_DAYS + 1);
  return startDate && endDate ? { startDate, endDate } : null;
}

function metric(row, index) {
  const raw = row?.metricValues?.[index]?.value;
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function dimension(row, index) {
  return String(row?.dimensionValues?.[index]?.value || '').trim();
}

function metadataMetricNames(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map((name) => String(name || '').trim()));
  return null;
}

export function buildSocialSiteOutcomeRequest({ startDate, endDate, eventNames = [] } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(startDate || ''))
    || !/^\d{4}-\d{2}-\d{2}$/u.test(String(endDate || ''))) {
    throw new TypeError('valid GA4 startDate and endDate are required');
  }
  if (dateRangeDays(startDate, endDate).length !== SOCIAL_SITE_OUTCOME_WINDOW_DAYS) {
    throw new RangeError(`GA4 social outcome window must be ${SOCIAL_SITE_OUTCOME_WINDOW_DAYS} calendar days`);
  }
  const registered = [...new Set(eventNames.filter((name) => (
    Object.hasOwn(SOCIAL_GA4_ACTION_EVENTS, name) && isSocialGa4SessionKeyEventRateEligible(name)
  )))];
  if (registered.length === 0) return null;
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }, { name: 'sessionManualSource' }],
    metrics: [
      { name: 'sessions' },
      ...registered.map((name) => ({ name: `sessionKeyEventRate:${name}` })),
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionManualMedium',
        stringFilter: { value: 'social', matchType: 'EXACT', caseSensitive: false },
      },
    },
  };
}

/**
 * Turn a complete, unsampled GA4 report into daily channel/event observations.
 * Missing date/source rows become zero-session observations only after the API
 * confirms complete pagination and clean distribution metadata.
 */
export function buildSocialSiteOutcomeSnapshots(report, {
  startDate,
  endDate,
  registeredEventNames = [],
} = {}) {
  const issue = socialCopyGa4ReportIssue(report);
  if (issue) return { status: issue, rows: [] };
  const timeZone = String(report.metadata?.timeZone || '').trim();
  if (!timeZone) return { status: 'time-zone-unavailable', rows: [] };
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date(0));
  } catch {
    return { status: 'time-zone-unavailable', rows: [] };
  }
  const eventNames = [...new Set(registeredEventNames.filter((name) => (
    Object.hasOwn(SOCIAL_GA4_ACTION_EVENTS, name) && isSocialGa4SessionKeyEventRateEligible(name)
  )))];
  const days = dateRangeDays(startDate, endDate);
  if (days.length !== SOCIAL_SITE_OUTCOME_WINDOW_DAYS) return { status: 'invalid-date-range', rows: [] };
  if (!days.length || !eventNames.length) return { status: 'no-registered-key-events', rows: [] };

  const valuesByDayChannel = new Map();
  for (const row of report.rows) {
    const source = String(row?.dimensionValues?.[1]?.value ?? '');
    const channel = SOCIAL_GA4_CHANNEL_BY_UTM_SOURCE[source];
    if (!channel) continue;
    const date = dayFromGa4(dimension(row, 0));
    const sessions = metric(row, 0);
    if (!date || !days.includes(date) || sessions === null || !Number.isSafeInteger(sessions) || sessions <= 0) {
      return { status: 'metric-unavailable', rows: [] };
    }
    const eventRates = {};
    for (const [index, eventName] of eventNames.entries()) {
      const rate = metric(row, index + 1);
      if (rate === null || rate > 1) return { status: 'metric-unavailable', rows: [] };
      eventRates[eventName] = rate;
    }
    const key = `${date}\u0000${channel}`;
    if (valuesByDayChannel.has(key)) return { status: 'duplicate-source-row', rows: [] };
    valuesByDayChannel.set(key, { sessions, eventRates });
  }

  const rows = [];
  for (const date of days) {
    for (const channel of SOCIAL_SITE_OUTCOME_CHANNELS) {
      const value = valuesByDayChannel.get(`${date}\u0000${channel}`);
      for (const eventName of eventNames) {
        rows.push(value
          ? {
            channel,
            eventName,
            eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
            date,
            timeZone,
            sessions: value.sessions,
            sessionKeyEventRate: value.eventRates[eventName],
            status: 'available',
            source: 'ga4-session-key-event-rate',
          }
          : {
            channel,
            eventName,
            eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
            date,
            timeZone,
            sessions: 0,
            sessionKeyEventRate: null,
            status: 'zero-sessions',
            source: 'ga4-complete-report-no-session-row',
          });
      }
    }
  }
  return { status: 'available', rows, timeZone, startDate, endDate, registeredEventNames: eventNames };
}

export async function collectSocialSiteOutcomeSnapshots({
  now = new Date(),
  propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID,
  getTokenImpl = () => getServiceAccountToken([GA4_READONLY_SCOPE], {
    logInfo: () => {},
    logError: () => {},
  }),
  runReportImpl = runGa4ReportPaged,
  listKeyEventMetricsImpl = listSocialCopySessionKeyEventMetrics,
} = {}) {
  let range = ga4DateRange(SOCIAL_SITE_OUTCOME_WINDOW_DAYS, SOCIAL_SITE_OUTCOME_LAG_DAYS, now);
  const token = await getTokenImpl();
  if (!token) return { status: 'credentials-unavailable', rows: [], registeredEventNames: [], ...range };
  let registeredEventNames;
  let hasRegisteredPropertyEvents = false;
  try {
    const metricNames = metadataMetricNames(await listKeyEventMetricsImpl({ token, propertyId }));
    if (!metricNames) return { status: 'metadata-unavailable', rows: [], registeredEventNames: [], ...range };
    const registeredPropertyEventNames = SOCIAL_GA4_ACTION_EVENT_NAMES.filter((name) => metricNames.has(`sessionKeyEventRate:${name}`));
    hasRegisteredPropertyEvents = registeredPropertyEventNames.length > 0;
    registeredEventNames = registeredPropertyEventNames.filter(isSocialGa4SessionKeyEventRateEligible);
  } catch {
    return { status: 'metadata-unavailable', rows: [], registeredEventNames: [], ...range };
  }
  if (!registeredEventNames.length) {
    return {
      status: hasRegisteredPropertyEvents ? 'no-rate-eligible-key-events' : 'no-registered-key-events',
      rows: [],
      registeredEventNames,
      ...range,
    };
  }
  const body = buildSocialSiteOutcomeRequest({ ...range, eventNames: registeredEventNames });
  try {
    let report = await runReportImpl({
      token,
      propertyId,
      body,
      pageSize: 100_000,
      maxRows: 100_000,
    });
    const propertyTimeZone = String(report?.metadata?.timeZone || '').trim();
    const propertyRange = propertyTimeZone ? dateRangeInTimeZone(now, propertyTimeZone) : null;
    if (propertyRange && (propertyRange.startDate !== range.startDate || propertyRange.endDate !== range.endDate)) {
      range = propertyRange;
      report = await runReportImpl({
        token,
        propertyId,
        body: buildSocialSiteOutcomeRequest({ ...range, eventNames: registeredEventNames }),
        pageSize: 100_000,
        maxRows: 100_000,
      });
    }
    const outcome = buildSocialSiteOutcomeSnapshots(report, {
      ...range,
      registeredEventNames,
    });
    return { ...outcome, ...range, registeredEventNames };
  } catch {
    return { status: 'api-error', rows: [], registeredEventNames, ...range };
  }
}
