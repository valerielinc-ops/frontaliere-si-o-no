import { FACEBOOK_GRAPH_API_VERSION } from './facebook-audience-insights.mjs';

export const FACEBOOK_POST_INSIGHTS_WINDOW_HOURS = 72;
export const FACEBOOK_POST_INSIGHTS_TOLERANCE_HOURS = 6;
// Ledger timestamps locate posts that might be due for the fixed-age sample.
// A wider search window handles normal scheduler drift; the persisted window
// is still validated against Meta's exact created_time below.
const FACEBOOK_POST_INSIGHTS_CANDIDATE_TOLERANCE_HOURS = 18;
export const FACEBOOK_POST_INSIGHTS_METRICS = Object.freeze([
  'post_media_view',
  'post_total_media_view_unique',
  'post_reactions_by_type_total',
  'post_clicks',
]);

const REQUIRED_COPY_FIELDS = Object.freeze([
  'copyMode', 'copySlot', 'copyPackId', 'copyTemplateId', 'copyAssignmentMode',
]);
const OPTIONAL_COPY_FIELDS = Object.freeze([
  'copyExperimentId', 'copyObjective', 'copyAngleId', 'copyPillarId', 'copyAngleIntent',
]);
const METRIC_FIELD_MAP = Object.freeze({
  mediaViews: 'post_media_view',
  uniqueViewers: 'post_total_media_view_unique',
  reactions: 'post_reactions_by_type_total',
  clicks: 'post_clicks',
});

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function postedRows(ledger) {
  if (Array.isArray(ledger)) return ledger.filter(record);
  return record(ledger) && Array.isArray(ledger.posted) ? ledger.posted.filter(record) : [];
}

function safePostId(row) {
  const value = String(row?.fbPostId || row?.facebookPostId || row?.postId || '').trim();
  return /^\d+(?:_\d+)?$/u.test(value) ? value : null;
}

function expectedPublishedAt(row) {
  for (const field of ['scheduledFor', 'publishedAt', 'postedAt', 'ts']) {
    const parsed = Date.parse(String(row?.[field] || ''));
    if (Number.isFinite(parsed)) return { at: parsed, basis: field === 'scheduledFor' ? 'scheduled-for' : 'ledger-posted-at' };
  }
  return null;
}

function numericCount(value) {
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function countValue(value) {
  const direct = numericCount(value);
  if (direct !== null) return direct;
  if (!record(value)) return null;
  const counts = Object.values(value).map(numericCount);
  return counts.length && counts.every((count) => count !== null)
    ? counts.reduce((sum, count) => sum + count, 0)
    : null;
}

function graphErrorStatus(response, body) {
  const code = Number(body?.error?.code);
  if (response.status === 429 || [4, 17, 32, 613].includes(code)) return 'rate-limited';
  if (code === 190) return 'credentials-invalid';
  if ([10, 200].includes(code) || [401, 403].includes(response.status)) return 'permission-unavailable';
  if (code === 100) return 'metric-unavailable';
  return 'api-error';
}

function copyMetadata(entries) {
  const values = [...REQUIRED_COPY_FIELDS, ...OPTIONAL_COPY_FIELDS].map((field) => (
    entries.map((entry) => String(entry?.[field] || '').trim())
  ));
  if (values.some((fieldValues) => new Set(fieldValues).size > 1)) {
    return { copy: null, copyAttributionStatus: 'incomplete-or-conflicting' };
  }
  const copy = {};
  REQUIRED_COPY_FIELDS.forEach((field, index) => { copy[field] = values[index][0]; });
  if (REQUIRED_COPY_FIELDS.some((field) => !copy[field])) {
    return { copy: null, copyAttributionStatus: 'incomplete-or-conflicting' };
  }
  for (const field of OPTIONAL_COPY_FIELDS) {
    const value = String(entries[0]?.[field] || '').trim();
    if (value) copy[field] = value;
  }
  return { copy, copyAttributionStatus: 'exact' };
}

function exactPostGroups(ledger) {
  const groups = new Map();
  for (const row of postedRows(ledger)) {
    const postId = safePostId(row);
    const expected = expectedPublishedAt(row);
    if (!postId || !expected || row.viaDigest) continue;
    const group = groups.get(postId) || { postId, expectedPublishedAt: expected, entries: [] };
    if (Math.abs(group.expectedPublishedAt.at - expected.at) > 5 * 60 * 1000) {
      group.timeConflict = true;
    }
    group.entries.push(row);
    groups.set(postId, group);
  }
  return [...groups.values()];
}

function parseMetricRows(body) {
  if (!Array.isArray(body?.data)) return null;
  const byName = new Map();
  for (const row of body.data) {
    if (!record(row) || !FACEBOOK_POST_INSIGHTS_METRICS.includes(row.name)
      || !Array.isArray(row.values) || row.values.length !== 1) continue;
    byName.set(row.name, countValue(row.values[0]?.value));
  }
  const metrics = Object.fromEntries(Object.entries(METRIC_FIELD_MAP).map(([field, apiName]) => [
    field,
    byName.has(apiName) ? byName.get(apiName) : null,
  ]));
  const availableMetrics = Object.entries(metrics)
    .filter(([, value]) => value !== null)
    .map(([field]) => field);
  const metricStatus = Object.fromEntries(Object.entries(metrics).map(([field, value]) => [
    field,
    value === null ? 'metric-unavailable' : 'available',
  ]));
  return { metrics, availableMetrics, metricStatus };
}

async function graphGet(url, accessToken, fetchImpl) {
  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12_000),
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    return {
      ok: false,
      status: error?.name === 'TimeoutError' ? 'api-error' : 'network-error',
      reasonCode: error?.name === 'TimeoutError' ? 'timeout' : 'network-error',
    };
  }
  if (!response.ok || body?.error) {
    return { ok: false, status: graphErrorStatus(response, body), reasonCode: `meta-${Number(body?.error?.code) || response.status}` };
  }
  return { ok: true, body };
}

/** Collect only exact, publisher-recorded Facebook post IDs at a fixed 72-hour age. */
export async function collectFacebookPostInsights({
  ledger,
  existingPosts = [],
  eligibilityStatus = 'post-insights-eligibility-unverified',
  pageId = process.env.FB_PAGE_ID,
  accessToken = process.env.FB_PAGE_ACCESS_TOKEN,
  asOf = new Date(),
  fetchImpl = fetch,
} = {}) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new TypeError('asOf must be a valid date');
  const safePageId = String(pageId || '').trim();
  const safeToken = String(accessToken || '').trim();
  if (!safePageId || !safeToken) return { status: 'credentials-missing', posts: [], attempted: 0, skipped: 0 };
  if (eligibilityStatus === 'post-insights-below-100-page-likes') {
    return { status: 'post-insights-below-100-page-likes', posts: [], attempted: 0, skipped: 0 };
  }
  if (eligibilityStatus !== 'post-insights-exact-id-probe-required') {
    return { status: 'post-insights-eligibility-unverified', posts: [], attempted: 0, skipped: 0 };
  }

  const existingKeys = new Set((Array.isArray(existingPosts) ? existingPosts : [])
    .filter((row) => row?.channel === 'facebook' && row.windowHours === FACEBOOK_POST_INSIGHTS_WINDOW_HOURS
      && row.availableMetrics?.includes('mediaViews') && row.availableMetrics?.includes('reactions'))
    .map((row) => String(row.postId || '')));
  if (!/^\d+$/u.test(safePageId)) return { status: 'account-id-invalid', posts: [], attempted: 0, skipped: 0 };
  const minAge = FACEBOOK_POST_INSIGHTS_WINDOW_HOURS - FACEBOOK_POST_INSIGHTS_CANDIDATE_TOLERANCE_HOURS;
  const maxAge = FACEBOOK_POST_INSIGHTS_WINDOW_HOURS + FACEBOOK_POST_INSIGHTS_CANDIDATE_TOLERANCE_HOURS;
  const candidates = exactPostGroups(ledger).filter((group) => {
    if (group.timeConflict || existingKeys.has(group.postId) || !group.postId.startsWith(`${safePageId}_`)) return false;
    const ageHours = (asOfMs - group.expectedPublishedAt.at) / 3_600_000;
    return ageHours >= minAge && ageHours <= maxAge;
  });
  if (!candidates.length) return { status: 'no-posts-in-window', posts: [], attempted: 0, skipped: 0 };

  const posts = [];
  const failures = [];
  for (const group of candidates) {
    const postUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(group.postId)}`);
    postUrl.searchParams.set('fields', 'id,is_published,created_time');
    const postResult = await graphGet(postUrl.toString(), safeToken, fetchImpl);
    if (!postResult.ok) {
      failures.push(postResult);
      continue;
    }
    if (String(postResult.body?.id || '') !== group.postId || postResult.body?.is_published !== true) {
      failures.push({ ok: false, status: 'post-not-published-or-identity-mismatch', reasonCode: 'post-state-unverified' });
      continue;
    }
    const publishedAtMs = Date.parse(String(postResult.body?.created_time || ''));
    if (!Number.isFinite(publishedAtMs)) {
      failures.push({ ok: false, status: 'publication-time-unavailable', reasonCode: 'created-time-missing' });
      continue;
    }
    const ageHours = (asOfMs - publishedAtMs) / 3_600_000;
    if (ageHours < FACEBOOK_POST_INSIGHTS_WINDOW_HOURS - FACEBOOK_POST_INSIGHTS_TOLERANCE_HOURS
      || ageHours > FACEBOOK_POST_INSIGHTS_WINDOW_HOURS + FACEBOOK_POST_INSIGHTS_TOLERANCE_HOURS) continue;

    const insightsUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(group.postId)}/insights`);
    insightsUrl.searchParams.set('metric', FACEBOOK_POST_INSIGHTS_METRICS.join(','));
    insightsUrl.searchParams.set('period', 'lifetime');
    const insightResult = await graphGet(insightsUrl.toString(), safeToken, fetchImpl);
    if (!insightResult.ok) {
      failures.push(insightResult);
      continue;
    }
    const normalized = parseMetricRows(insightResult.body);
    if (!normalized) {
      failures.push({ ok: false, status: 'malformed-response', reasonCode: 'insights-data-missing' });
      continue;
    }
    const copy = copyMetadata(group.entries);
    const row = {
      channel: 'facebook',
      postId: group.postId,
      publishedAt: new Date(publishedAtMs).toISOString(),
      publicationTimeBasis: 'facebook-created-time',
      snapshotAt: new Date(asOfMs).toISOString(),
      windowHours: FACEBOOK_POST_INSIGHTS_WINDOW_HOURS,
      snapshotAgeHours: ageHours,
      measurementWindow: 'first-72h-after-facebook-created-time',
      metrics: normalized.metrics,
      availableMetrics: normalized.availableMetrics,
      metricStatus: normalized.metricStatus,
      ...copy,
    };
    posts.push(row);
  }

  const status = failures.length
    ? posts.length ? 'partial' : failures[0].status
    : posts.length === 0 ? 'no-posts-in-window'
      : posts.some((post) => post.availableMetrics.length < Object.keys(METRIC_FIELD_MAP).length) ? 'partial'
        : 'available';
  const reasonCodes = [...new Set(failures.map((failure) => failure.reasonCode).filter(Boolean))].sort();
  return {
    status,
    posts,
    attempted: candidates.length,
    skipped: failures.length,
    ...(reasonCodes.length ? { reasonCodes } : {}),
  };
}
