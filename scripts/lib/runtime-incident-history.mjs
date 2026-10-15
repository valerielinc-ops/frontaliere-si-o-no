import { runHogQL } from './posthog-client.mjs';

const DAY_MS = 86_400_000;
const boundedQuery = (query) => runHogQL(query, {
  fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }),
});
const SIGNATURES = [
  { id: 'newsletter_chunk', messageFragment: 'NewsletterPopup.js' },
  { id: 'firebase_api_key', messageFragment: 'Firebase Web API key' },
];

function utcDay(value) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Expected an ISO calendar date');
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== text) {
    throw new Error('Invalid calendar date');
  }
  return { text, timestamp };
}

/**
 * Historical telemetry, not a synthetic health verdict. Direct app_error
 * query deliberately includes sw_cache_stale Newsletter errors filtered out
 * by the actionable-error feeder. No new PostHog instrumentation is added.
 */
export async function fetchRuntimeIncidentHistory({
  startDate,
  endDate,
  recentDays = 7,
  runQuery = boundedQuery,
} = {}) {
  const start = utcDay(startDate);
  const end = utcDay(endDate);
  const days = (end.timestamp - start.timestamp) / DAY_MS + 1;
  if (days < 1 || days > 366 || !Number.isInteger(recentDays) || recentDays < 1) {
    throw new Error('Incident window must span 1–366 days and recentDays must be positive');
  }
  const recentStart = new Date(Math.max(start.timestamp, end.timestamp - (recentDays - 1) * DAY_MS)).toISOString().slice(0, 10);
  const endExclusive = new Date(end.timestamp + DAY_MS).toISOString().slice(0, 10);
  const metadata = {
    source: 'posthog_app_error',
    hostname: 'frontaliereticino.ch',
    startDate: start.text,
    endDate: end.text,
    endDateComplete: end.text < new Date().toISOString().slice(0, 10),
    recentStartDate: recentStart,
    timezone: 'UTC',
    affectedUsersDefinition: 'Distinct PostHog distinct_id within each signature and day; not additive across days.',
    interpretation: 'Observed telemetry only: no observed events does not prove that every visitor was error-free.',
  };
  const signatureExpr = `multiIf(properties.error_message LIKE '%NewsletterPopup.js%', 'newsletter_chunk', 'firebase_api_key')`;
  const limit = days * SIGNATURES.length + 1;
  const query = `SELECT
    toDate(toTimeZone(timestamp, 'UTC')) AS day,
    ${signatureExpr} AS signature,
    count() AS event_count,
    uniqExact(distinct_id) AS affected_users,
    max(toTimeZone(timestamp, 'UTC')) AS last_occurrence
  FROM events
  WHERE timestamp >= toDateTime('${start.text} 00:00:00', 'UTC')
    AND timestamp < toDateTime('${endExclusive} 00:00:00', 'UTC')
    AND properties.$host = 'frontaliereticino.ch'
    AND event = 'app_error'
    AND (properties.error_message LIKE '%NewsletterPopup.js%'
      OR properties.error_message LIKE '%Firebase Web API key%')
  GROUP BY day, signature ORDER BY day, signature LIMIT ${limit}`;

  try {
    const response = await runQuery(query);
    if (response?.error || !Array.isArray(response?.results) || response.hasMore || response.results.length >= limit) {
      return { ...metadata, status: 'unavailable', reason: 'incomplete_query_result', signatures: [] };
    }
    const bySignature = new Map(SIGNATURES.map(({ id }) => [id, new Map()]));
    for (const [day, signature, count, users, lastOccurrence] of response.results) {
      const daily = bySignature.get(signature);
      if (!daily || typeof day !== 'string' || utcDay(day).text < start.text || day > end.text
        || !Number.isInteger(Number(count)) || !Number.isInteger(Number(users))
        || Number(count) <= 0 || Number(users) < 0 || Number(users) > Number(count) || daily.has(day)
        || typeof lastOccurrence !== 'string' || !Number.isFinite(Date.parse(lastOccurrence))
        || lastOccurrence.slice(0, 10) !== day) {
        return { ...metadata, status: 'unavailable', reason: 'invalid_query_result', signatures: [] };
      }
      daily.set(day, { day, eventCount: Number(count), affectedUsers: Number(users), lastOccurrence: lastOccurrence || null });
    }
    const signatures = SIGNATURES.map(({ id, messageFragment }) => {
      const rows = bySignature.get(id);
      const daily = Array.from({ length: days }, (_, index) => {
        const day = new Date(start.timestamp + index * DAY_MS).toISOString().slice(0, 10);
        return rows.get(day) || { day, eventCount: 0, affectedUsers: 0, lastOccurrence: null };
      });
      const eventCount = daily.reduce((sum, row) => sum + row.eventCount, 0);
      const recentEventCount = daily.filter((row) => row.day >= recentStart).reduce((sum, row) => sum + row.eventCount, 0);
      const lastOccurrence = daily.filter((row) => row.lastOccurrence).at(-1)?.lastOccurrence || null;
      return {
        id, messageFragment, eventCount, recentEventCount, lastOccurrence, daily,
        status: recentEventCount > 0 ? 'observed_recently' : eventCount > 0 ? 'historical_only' : 'not_observed',
      };
    });
    return { ...metadata, status: 'available', signatures };
  } catch {
    // The shared client may include a response body in its thrown message.
    // Reports need an availability state, never an upstream body or token.
    return { ...metadata, status: 'unavailable', reason: 'query_failed', signatures: [] };
  }
}
