import { fetchRetry, sleep } from './ga4-service-account.mjs';
import { LINKEDIN_REST_VERSION } from './linkedin-links.mjs';

export const LINKEDIN_MEMBER_ANALYTICS_SCOPE = 'r_member_postAnalytics';
export const LINKEDIN_MEMBER_ANALYTICS_STORAGE_APPROVAL_ENV = 'LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED';
export const LINKEDIN_MEMBER_ANALYTICS_WINDOW_DAYS = 7;
export const LINKEDIN_MEMBER_ANALYTICS_MAX_POSTS = 8;
export const LINKEDIN_MEMBER_ANALYTICS_MAX_AGE_DAYS = 90;
export const LINKEDIN_MEMBER_ANALYTICS_METRICS = Object.freeze([
  'IMPRESSION',
  'MEMBERS_REACHED',
  'REACTION',
  'COMMENT',
  'RESHARE',
  'LINK_CLICKS',
  'POST_SAVE',
  'POST_SEND',
  'FOLLOWER_GAINED_FROM_CONTENT',
  'PROFILE_VIEW_FROM_CONTENT',
]);

const API_URL = 'https://api.linkedin.com/rest/memberCreatorPostAnalytics';
const DAY_MS = 24 * 60 * 60 * 1000;
const COPY_FIELDS = Object.freeze(['copyMode', 'copySlot', 'copyPackId', 'copyTemplateId', 'copyAssignmentMode']);
const OPTIONAL_COPY_FIELDS = Object.freeze([
  'copyExperimentId', 'copyBlockId', 'copyBlockCycle', 'copyRegistrationHash',
  'copyObjective', 'copyAngleId', 'copyPillarId', 'copyAngleIntent',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCount(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function entriesFromLedger(ledger) {
  if (Array.isArray(ledger)) return ledger.filter(isRecord);
  return isRecord(ledger) && Array.isArray(ledger.posted) ? ledger.posted.filter(isRecord) : [];
}

function consistentCopyMetadata(entries) {
  const required = {};
  for (const field of COPY_FIELDS) {
    const values = entries.map((entry) => String(entry[field] ?? '').trim());
    if (values.some((value) => !value) || new Set(values).size !== 1) {
      return { status: 'incomplete-or-conflicting', copy: null };
    }
    required[field] = values[0];
  }
  const copy = { ...required };
  for (const field of OPTIONAL_COPY_FIELDS) {
    const values = [...new Set(entries.map((entry) => String(entry[field] ?? '').trim()))];
    if (values.length > 1) return { status: 'incomplete-or-conflicting', copy: null };
    if (values.length === 1 && values[0] !== '') {
      copy[field] = field === 'copyBlockCycle' ? Number(values[0]) : values[0];
    }
  }
  return { status: 'exact', copy };
}

function postGroups(ledger) {
  const groups = new Map();
  for (const row of entriesFromLedger(ledger)) {
    const postId = String(row.linkedinPostId || '').trim();
    if (!/^urn:li:(?:share|ugcPost):\d+$/u.test(postId)) continue;
    const group = groups.get(postId) || {
      postId,
      entries: [],
      sourceIds: new Set(),
      kinds: new Set(),
      timestamps: new Set(),
      days: new Set(),
    };
    group.entries.push(row);
    const sourceId = String(row.id || '').trim();
    const kind = String(row.kind || '').trim();
    const ts = Date.parse(String(row.ts || row.postedAt || ''));
    const day = String(row.day || '').trim();
    if (sourceId) group.sourceIds.add(sourceId);
    if (kind) group.kinds.add(kind);
    if (Number.isFinite(ts)) group.timestamps.add(ts);
    if (day) group.days.add(day);
    groups.set(postId, group);
  }
  return [...groups.values()].map((group) => {
    const timestamps = [...group.timestamps].sort((a, b) => a - b);
    const timestampConflicts = timestamps.length > 1
      && timestamps.at(-1) - timestamps[0] > 5 * 60_000;
    const copyMetadata = consistentCopyMetadata(group.entries);
    return {
      postId: group.postId,
      sourceIds: [...group.sourceIds].sort(),
      kind: group.kinds.size === 1 ? [...group.kinds][0] : group.kinds.size ? 'mixed' : null,
      day: group.days.size === 1 ? [...group.days][0] : null,
      publishedAt: timestamps.length && !timestampConflicts ? new Date(timestamps[0]).toISOString() : null,
      metadataStatus: group.kinds.size > 1 || group.days.size > 1 || timestampConflicts ? 'ambiguous' : 'exact',
      copy: copyMetadata.copy,
      copyAttributionStatus: copyMetadata.status,
    };
  });
}

function dateParts(ms) {
  const date = new Date(ms);
  return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
}

function formatDateRange(startMs, endMs) {
  const start = dateParts(startMs);
  const end = dateParts(endMs);
  return `(start:(day:${start.day},month:${start.month},year:${start.year}),end:(day:${end.day},month:${end.month},year:${end.year}))`;
}

export function buildLinkedInMemberAnalyticsUrl(postId, metricType, startMs, endMs) {
  if (!/^urn:li:(?:share|ugcPost):\d+$/u.test(String(postId || ''))) {
    throw new Error('postId must be an exact LinkedIn share or ugcPost URN');
  }
  if (!LINKEDIN_MEMBER_ANALYTICS_METRICS.includes(metricType)) {
    throw new Error(`unsupported LinkedIn member metric: ${metricType}`);
  }
  const entityType = postId.startsWith('urn:li:share:') ? 'share' : 'ugc';
  const entity = `(${entityType}:${encodeURIComponent(postId)})`;
  return `${API_URL}?q=entity&entity=${entity}&queryType=${metricType}&aggregation=TOTAL&dateRange=${formatDateRange(startMs, endMs)}`;
}

function metricTypeFromElement(value) {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return Object.values(value).find((item) => typeof item === 'string') || null;
  return null;
}

function targetUrnFromElement(value) {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  return Object.values(value).find((item) => typeof item === 'string' && /^urn:li:/u.test(item)) || null;
}

function parseMetricResponse(payload, postId, metricType) {
  if (!Array.isArray(payload?.elements)) return null;
  const matches = payload.elements.filter((element) => (
    isRecord(element)
    && metricTypeFromElement(element.metricType) === metricType
    && targetUrnFromElement(element.targetEntity) === postId
  ));
  if (matches.length !== 1) return null;
  return parseCount(matches[0].count);
}

function errorStatus(status) {
  if (status === 401 || status === 403) return 'permission-unavailable';
  if (status === 429) return 'rate-limited';
  if (status === 404) return 'metric-unavailable';
  return 'api-error';
}

async function fetchPostMetric({ accessToken, postId, metricType, startMs, endMs, fetchImpl }) {
  const response = await fetchImpl(buildLinkedInMemberAnalyticsUrl(postId, metricType, startMs, endMs), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'LinkedIn-Version': LINKEDIN_REST_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) return { status: errorStatus(response.status), value: null, reasonCode: `http_${response.status}` };
  return { status: 'available', value: parseMetricResponse(payload, postId, metricType), reasonCode: null };
}

function utcDayStart(timestampMs) {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Collect one comparable seven-UTC-day window for exact member-post URNs.
 * The API exposes one queryType per request, so each run is bounded to a small
 * backlog and leaves missing scopes/metrics explicitly unavailable.
 */
export async function collectLinkedInMemberInsights({
  accessToken,
  ledger,
  existing = null,
  asOf = new Date(),
  windowDays = LINKEDIN_MEMBER_ANALYTICS_WINDOW_DAYS,
  maxAgeDays = LINKEDIN_MEMBER_ANALYTICS_MAX_AGE_DAYS,
  maxPosts = LINKEDIN_MEMBER_ANALYTICS_MAX_POSTS,
  retentionPolicyApproved = false,
  fetchImpl = fetchRetry,
  sleepImpl = sleep,
  delayMs = 100,
} = {}) {
  const snapshotAt = new Date(asOf).toISOString();
  if (retentionPolicyApproved !== true) {
    return {
      status: 'policy-review-required',
      snapshotAt,
      posts: [],
      skipped: [],
      scope: LINKEDIN_MEMBER_ANALYTICS_SCOPE,
    };
  }
  if (!String(accessToken || '').trim()) {
    return { status: 'credentials-missing', snapshotAt, posts: [], skipped: [] };
  }
  const groups = postGroups(ledger);
  if (groups.length === 0) return { status: 'no-exact-post-ids', snapshotAt, posts: [], skipped: [] };

  const seen = new Set((Array.isArray(existing?.posts) ? existing.posts : [])
    .filter((row) => Number(row.windowDays) === Number(windowDays))
    .map((row) => String(row.postId || '')));
  const nowMs = Date.parse(snapshotAt);
  const eligible = [];
  const skipped = [];
  for (const group of groups) {
    if (!group.publishedAt) {
      skipped.push({ postId: group.postId, reason: 'published-at-ambiguous-or-missing' });
      continue;
    }
    const publishedMs = Date.parse(group.publishedAt);
    const ageDays = (nowMs - publishedMs) / DAY_MS;
    if (ageDays < windowDays) {
      skipped.push({ postId: group.postId, reason: 'window-not-reached' });
      continue;
    }
    if (ageDays > maxAgeDays) {
      skipped.push({ postId: group.postId, reason: 'outside-retention-window' });
      continue;
    }
    if (seen.has(group.postId)) {
      skipped.push({ postId: group.postId, reason: 'window-snapshot-already-recorded' });
      continue;
    }
    eligible.push({ ...group, publishedMs, ageDays });
  }
  eligible.sort((left, right) => left.publishedMs - right.publishedMs || left.postId.localeCompare(right.postId));

  const posts = [];
  for (const group of eligible.slice(0, maxPosts)) {
    const startMs = utcDayStart(group.publishedMs);
    const endMs = startMs + Number(windowDays) * DAY_MS;
    const metrics = {};
    const metricStatus = {};
    let permissionUnavailable = false;
    for (const metricType of LINKEDIN_MEMBER_ANALYTICS_METRICS) {
      const key = metricType.toLowerCase();
      const result = await fetchPostMetric({ accessToken, postId: group.postId, metricType, startMs, endMs, fetchImpl });
      if (result.status !== 'available') {
        if (result.status === 'permission-unavailable') permissionUnavailable = true;
        if (result.status === 'rate-limited') {
          return { status: 'rate-limited', snapshotAt, posts, skipped, scope: LINKEDIN_MEMBER_ANALYTICS_SCOPE };
        }
        if (result.status === 'api-error') {
          return { status: 'api-error', snapshotAt, posts, skipped, scope: LINKEDIN_MEMBER_ANALYTICS_SCOPE };
        }
        metrics[key] = null;
        metricStatus[key] = result.status;
        if (permissionUnavailable) break;
      } else {
        metrics[key] = result.value;
        metricStatus[key] = result.value === null ? 'unavailable' : 'available';
      }
      if (delayMs > 0) await sleepImpl(delayMs);
    }
    if (permissionUnavailable) {
      return { status: 'permission-unavailable', snapshotAt, posts, skipped, scope: LINKEDIN_MEMBER_ANALYTICS_SCOPE };
    }
    posts.push({
      channel: 'linkedin-member',
      postId: group.postId,
      sourceIds: group.sourceIds,
      kind: group.kind,
      day: group.day,
      copy: group.copy,
      copyAttributionStatus: group.copyAttributionStatus,
      publishedAt: group.publishedAt,
      snapshotAt,
      windowDays: Number(windowDays),
      windowStartDay: new Date(startMs).toISOString().slice(0, 10),
      windowEndDayExclusive: new Date(endMs).toISOString().slice(0, 10),
      measurementWindow: 'first-seven-utc-calendar-days',
      metricSource: 'linkedin-memberCreatorPostAnalytics',
      metrics,
      availableMetrics: Object.entries(metricStatus).filter(([, status]) => status === 'available').map(([name]) => name),
      metricStatus,
      metadataStatus: group.metadataStatus,
    });
  }

  const remaining = eligible.length > maxPosts;
  return {
    status: posts.length ? 'snapshots-added' : remaining ? 'backlog-pending' : 'no-new-eligible-posts',
    snapshotAt,
    posts,
    skipped,
    remainingEligiblePosts: Math.max(0, eligible.length - posts.length),
    scope: LINKEDIN_MEMBER_ANALYTICS_SCOPE,
    apiVersion: LINKEDIN_REST_VERSION,
  };
}
