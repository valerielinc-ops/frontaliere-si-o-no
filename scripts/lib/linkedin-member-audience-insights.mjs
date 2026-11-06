import { fetchRetry } from './ga4-service-account.mjs';
import { LINKEDIN_REST_VERSION } from './linkedin-links.mjs';

export const LINKEDIN_MEMBER_AUDIENCE_SCOPE = 'r_member_profileAnalytics';
const API_URL = 'https://api.linkedin.com/rest/memberFollowersCount?q=me';
const FOLLOWER_GAIN_API_URL = 'https://api.linkedin.com/rest/memberFollowersCount';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u;

function parseDateOnly(value) {
  const day = String(value || '');
  if (!DATE_ONLY_RE.test(day)) return null;
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : null;
}

function dateParts(date) {
  const day = String(date || '');
  const [year, month, value] = day.split('-').map(Number);
  return { year, month, day: value };
}

function formatDateParts(value) {
  if (!value || !Number.isSafeInteger(value.year) || !Number.isSafeInteger(value.month)
    || !Number.isSafeInteger(value.day)) return null;
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  const normalized = date.toISOString().slice(0, 10);
  return date.getUTCFullYear() === value.year
    && date.getUTCMonth() + 1 === value.month
    && date.getUTCDate() === value.day
    ? normalized
    : null;
}

function addUtcDays(day, amount) {
  const time = parseDateOnly(day);
  return time === null ? null : new Date(time + amount * 86_400_000).toISOString().slice(0, 10);
}

function dateRangeQuery(startDate, endDate) {
  const start = dateParts(startDate);
  const end = dateParts(endDate);
  const value = `(start:(year:${start.year},month:${start.month},day:${start.day}),end:(year:${end.year},month:${end.month},day:${end.day}))`;
  const url = new URL(FOLLOWER_GAIN_API_URL);
  url.searchParams.set('q', 'dateRange');
  url.searchParams.set('dateRange', value);
  url.searchParams.set('count', '50');
  return url.toString();
}

function safeCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function statusForHttp(status) {
  if (status === 401 || status === 403) return 'permission-unavailable';
  if (status === 429) return 'rate-limited';
  return 'api-error';
}

/** Read the authenticated member's lifetime follower total for a private daily snapshot. */
export async function collectLinkedInMemberAudienceSnapshot({
  accessToken,
  asOf = new Date(),
  fetchImpl = fetchRetry,
} = {}) {
  const snapshotAt = new Date(asOf).toISOString();
  if (!String(accessToken || '').trim()) return { status: 'credentials-missing', snapshotAt, snapshot: null };

  let response;
  let payload;
  try {
    response = await fetchImpl(API_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'LinkedIn-Version': LINKEDIN_REST_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    }, 2, 30_000);
    payload = await response.json().catch(() => null);
  } catch (error) {
    return {
      status: 'network-error',
      reasonCode: String(error?.name || 'request-failed').replace(/[^a-z0-9_-]/giu, '_').slice(0, 60),
      snapshotAt,
      snapshot: null,
    };
  }

  if (!response?.ok) {
    return {
      status: statusForHttp(Number(response?.status)),
      reasonCode: `http-${Number(response?.status) || 0}`,
      snapshotAt,
      snapshot: null,
    };
  }

  const elements = payload?.elements;
  const value = Array.isArray(elements) && elements.length === 1
    ? safeCount(elements[0]?.memberFollowersCount)
    : null;
  if (value === null) {
    return { status: 'metric-unavailable', reasonCode: 'lifetime-count-shape-unavailable', snapshotAt, snapshot: null };
  }

  return {
    status: 'available',
    snapshotAt,
    scope: LINKEDIN_MEMBER_AUDIENCE_SCOPE,
    apiVersion: LINKEDIN_REST_VERSION,
    snapshot: {
      channel: 'linkedin-member',
      metric: 'followers',
      value,
      snapshotAt,
      status: 'available',
      source: 'linkedin-member-followers-count',
    },
  };
}

/** Read LinkedIn's daily gained-follower series without conflating it with net audience totals. */
export async function collectLinkedInMemberFollowerGains({
  accessToken,
  startDate,
  endDate,
  asOf = new Date(),
  fetchImpl = fetchRetry,
} = {}) {
  const snapshotAt = new Date(asOf).toISOString();
  const startMs = parseDateOnly(startDate);
  const endMs = parseDateOnly(endDate);
  if (!String(accessToken || '').trim()) return { status: 'credentials-missing', snapshotAt, snapshots: [] };
  if (startMs === null || endMs === null || endMs <= startMs
    || (endMs - startMs) / 86_400_000 > 31
    || endMs > parseDateOnly(new Date(asOf).toISOString().slice(0, 10))) {
    return { status: 'invalid-date-range', snapshotAt, snapshots: [] };
  }

  const elements = [];
  let expectedTotal = null;
  let start = 0;
  let pages = 0;
  let terminalFailure = null;
  while (pages < 4 && (expectedTotal === null || start < expectedTotal)) {
    const url = new URL(dateRangeQuery(startDate, endDate));
    url.searchParams.set('start', String(start));
    let response;
    let payload;
    try {
      response = await fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'LinkedIn-Version': LINKEDIN_REST_VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }, 2, 30_000);
      payload = await response.json().catch(() => null);
    } catch (error) {
      // fetch-failure-status: terminalFailure is returned or marks the partial result below; this is not an empty listing.
      terminalFailure = {
        status: 'network-error',
        reasonCode: String(error?.name || 'request-failed').replace(/[^a-z0-9_-]/giu, '_').slice(0, 60),
      };
      break;
    }
    if (!response?.ok) {
      terminalFailure = {
        status: statusForHttp(Number(response?.status)),
        reasonCode: `http-${Number(response?.status) || 0}`,
      };
      break;
    }
    if (!Array.isArray(payload?.elements)
      || expectedTotal !== null && Number.isSafeInteger(payload?.paging?.total) && payload.paging.total !== expectedTotal) {
      terminalFailure = { status: 'metric-unavailable', reasonCode: 'daily-gain-series-shape-unavailable' };
      break;
    }
    if (expectedTotal === null) {
      expectedTotal = Number.isSafeInteger(payload?.paging?.total) && payload.paging.total >= 0
        ? payload.paging.total
        : payload.elements.length;
    }
    elements.push(...payload.elements);
    pages += 1;
    if (payload.elements.length === 0) break;
    start += payload.elements.length;
  }
  if (terminalFailure && elements.length === 0) {
    return { ...terminalFailure, snapshotAt, snapshots: [] };
  }
  const byDate = new Map();
  const seenDates = new Set();
  let malformedRows = false;
  for (const element of elements) {
    const dateRange = element?.dateRange;
    const start = formatDateParts(dateRange?.start);
    const end = formatDateParts(dateRange?.end);
    const value = safeCount(element?.memberFollowersCount);
    if (!start || !end || value === null || end !== addUtcDays(start, 1)
      || parseDateOnly(start) < startMs || parseDateOnly(start) >= endMs) {
      malformedRows = true;
      continue;
    }
    if (seenDates.has(start)) {
      malformedRows = true;
      continue;
    }
    seenDates.add(start);
    byDate.set(start, {
      channel: 'linkedin-member',
      metric: 'followers-gained',
      date: start,
      value,
      snapshotAt: `${start}T12:00:00.000Z`,
      status: 'available',
      source: 'linkedin-member-follower-gains',
    });
  }
  const snapshots = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (!snapshots.length) {
    return { status: 'metric-unavailable', reasonCode: 'daily-gain-series-empty', snapshotAt, snapshots: [] };
  }
  const expectedDays = Math.floor((endMs - startMs) / 86_400_000);
  const dates = new Set(snapshots.map((row) => row.date));
  const complete = !malformedRows && !terminalFailure && expectedTotal === elements.length
    && dates.size === expectedDays;
  return {
    status: complete ? 'available' : 'partial',
    ...(complete ? {} : {
      reasonCode: terminalFailure?.reasonCode
        || (malformedRows ? 'daily-gain-series-malformed-or-duplicate' : 'daily-gain-series-incomplete'),
    }),
    snapshotAt,
    scope: LINKEDIN_MEMBER_AUDIENCE_SCOPE,
    apiVersion: LINKEDIN_REST_VERSION,
    expectedDays,
    coverageDays: dates.size,
    snapshots,
  };
}
