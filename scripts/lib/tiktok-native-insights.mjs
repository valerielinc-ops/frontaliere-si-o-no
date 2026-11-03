import { fetchRetry } from './ga4-service-account.mjs';
import { TIKTOK_API } from './tiktok-publish.mjs';

export const TIKTOK_INSIGHTS_SCOPE = 'video.list';
export const TIKTOK_INSIGHTS_WINDOW_HOURS = 72;
export const TIKTOK_INSIGHTS_TOLERANCE_HOURS = 6;
export const TIKTOK_INSIGHTS_MAX_PAGES = 10;
export const TIKTOK_INSIGHTS_PAGE_SIZE = 20;
export const TIKTOK_VIDEO_FIELDS = Object.freeze([
  'id',
  'create_time',
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
]);

const METRIC_FIELDS = Object.freeze({
  views: 'view_count',
  likes: 'like_count',
  comments: 'comment_count',
  shares: 'share_count',
});
const COPY_FIELDS = Object.freeze(['copyMode', 'copySlot', 'copyPackId', 'copyTemplateId', 'copyAssignmentMode']);
const OPTIONAL_COPY_FIELDS = Object.freeze([
  'copyExperimentId', 'copyObjective', 'copyAngleId', 'copyPillarId', 'copyAngleIntent',
]);

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function metric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function postedRows(ledger) {
  if (Array.isArray(ledger)) return ledger.filter(record);
  return record(ledger) && Array.isArray(ledger.posted) ? ledger.posted.filter(record) : [];
}

function consistentCopyMetadata(entries) {
  const required = {};
  for (const field of COPY_FIELDS) {
    const values = entries.map((entry) => String(entry[field] || '').trim());
    if (values.some((value) => !value) || new Set(values).size !== 1) {
      return { status: 'incomplete-or-conflicting', copy: null };
    }
    required[field] = values[0];
  }
  const copy = { ...required };
  for (const field of OPTIONAL_COPY_FIELDS) {
    const values = [...new Set(entries.map((entry) => String(entry[field] || '').trim()))];
    if (values.length > 1) return { status: 'incomplete-or-conflicting', copy: null };
    if (values.length === 1 && values[0]) copy[field] = values[0];
  }
  return { status: 'exact', copy };
}

function normalizeVideo(item) {
  if (!record(item) || !String(item.id || '').trim()) return null;
  const createTime = metric(item.create_time);
  const metrics = Object.fromEntries(Object.entries(METRIC_FIELDS).map(([name, field]) => [name, metric(item[field])]));
  return {
    postId: String(item.id).trim(),
    publishedAt: createTime === null ? null : new Date(createTime * 1000).toISOString(),
    metrics,
    availableMetrics: Object.entries(metrics).filter(([, value]) => value !== null).map(([name]) => name),
  };
}

function classifyApiFailure(status, code) {
  const normalized = String(code || '').toLowerCase();
  if (status === 401 || status === 403 || /scope|permission|access_token|unauthorized/u.test(normalized)) {
    return 'permission-unavailable';
  }
  if (status === 429 || /rate_limit/u.test(normalized)) return 'rate-limited';
  return 'api-error';
}

/** Fetch the authenticated user's public videos using the official Display API. */
export async function listTikTokVideos(accessToken, {
  fetchImpl = fetchRetry,
  maxPages = TIKTOK_INSIGHTS_MAX_PAGES,
  pageSize = TIKTOK_INSIGHTS_PAGE_SIZE,
} = {}) {
  if (!String(accessToken || '').trim()) return { status: 'credentials-missing', videos: [], pages: 0 };

  const videos = [];
  const seenIds = new Set();
  let cursor;
  let pages = 0;
  for (; pages < maxPages; pages += 1) {
    const url = new URL(`${TIKTOK_API}/video/list/`);
    url.searchParams.set('fields', TIKTOK_VIDEO_FIELDS.join(','));
    let response;
    let payload;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ max_count: pageSize, ...(cursor === undefined ? {} : { cursor }) }),
      });
      payload = await response.json().catch(() => null);
    } catch (error) {
      const errorName = String(error?.name || 'request_failed').replace(/[^a-z0-9_-]/giu, '_').slice(0, 60);
      return { status: 'network-error', reasonCode: errorName, videos, pages: pages + 1 };
    }
    const apiCode = payload?.error?.code;
    if (!response.ok || (apiCode && apiCode !== 'ok')) {
      return {
        status: classifyApiFailure(response.status, apiCode),
        reasonCode: String(apiCode || `http_${response.status}`).slice(0, 80),
        videos,
        pages: pages + 1,
      };
    }
    const page = payload?.data;
    if (!record(page) || !Array.isArray(page.videos)) {
      return { status: 'malformed-response', reasonCode: 'videos_missing', videos, pages: pages + 1 };
    }
    for (const raw of page.videos) {
      const video = normalizeVideo(raw);
      if (video && !seenIds.has(video.postId)) {
        seenIds.add(video.postId);
        videos.push(video);
      }
    }
    if (page.has_more !== true) return { status: 'available', videos, pages: pages + 1 };
    const nextCursor = metric(page.cursor);
    if (nextCursor === null || nextCursor === cursor) {
      return { status: 'malformed-response', reasonCode: 'pagination_cursor_invalid', videos, pages: pages + 1 };
    }
    cursor = nextCursor;
  }
  return { status: 'truncated', reasonCode: 'page_limit', videos, pages };
}

function exactLedgerGroups(ledger) {
  const groups = new Map();
  for (const entry of postedRows(ledger)) {
    const postId = String(entry.tiktokPostId || '').trim();
    if (!postId) continue;
    const group = groups.get(postId) || {
      postId,
      entries: [],
      sourceIds: new Set(),
      kinds: new Set(),
      days: new Set(),
    };
    group.entries.push(entry);
    const sourceId = String(entry.id || '').trim();
    if (sourceId) group.sourceIds.add(sourceId);
    const kind = String(entry.kind || '').trim();
    if (kind) group.kinds.add(kind);
    const day = String(entry.day || '').trim();
    if (day) group.days.add(day);
    groups.set(postId, group);
  }
  return groups;
}

/** Join only on the TikTok video ID written by the publisher; never infer by caption or time. */
export function matchTikTokVideosToLedger(videos, ledger, { listingComplete = true } = {}) {
  const groups = exactLedgerGroups(ledger);
  const matches = [];
  const unmatched = [];
  for (const video of videos || []) {
    const group = groups.get(String(video?.postId || '').trim());
    if (!group) {
      unmatched.push({ postId: String(video?.postId || ''), reason: 'exact-ledger-id-missing' });
      continue;
    }
    const copyMetadata = consistentCopyMetadata(group.entries);
    matches.push({
      ...video,
      sourceIds: [...group.sourceIds].sort(),
      kind: group.kinds.size === 1 ? [...group.kinds][0] : group.kinds.size ? 'mixed' : null,
      day: group.days.size === 1 ? [...group.days][0] : null,
      ledgerMetadataStatus: group.kinds.size > 1 || group.days.size > 1 ? 'ambiguous' : 'exact',
      copy: copyMetadata.copy,
      copyAttributionStatus: copyMetadata.status,
    });
  }
  const knownIds = new Set(groups.keys());
  for (const id of knownIds) {
    if (!(videos || []).some((video) => String(video?.postId || '').trim() === id)) {
      unmatched.push({
        postId: id,
        reason: listingComplete ? 'exact-id-not-returned-by-display-api' : 'exact-id-not-in-returned-prefix',
      });
    }
  }
  return { matches, unmatched, exactLedgerIds: groups.size };
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Create a fixed-age native snapshot, preserving unavailable metrics as null. */
export async function collectTikTokNativeInsights({
  accessToken,
  ledger,
  existing = null,
  asOf = new Date(),
  windowHours = TIKTOK_INSIGHTS_WINDOW_HOURS,
  toleranceHours = TIKTOK_INSIGHTS_TOLERANCE_HOURS,
  maxPages = TIKTOK_INSIGHTS_MAX_PAGES,
  pageSize = TIKTOK_INSIGHTS_PAGE_SIZE,
  fetchImpl = fetchRetry,
} = {}) {
  const snapshotAt = new Date(asOf).toISOString();
  if (!String(accessToken || '').trim()) {
    return { status: 'credentials-missing', snapshotAt, posts: [], unmatched: [] };
  }
  const listing = await listTikTokVideos(accessToken, { fetchImpl, maxPages, pageSize });
  const partialListing = listing.status !== 'available' && listing.videos.length > 0;
  if (listing.status !== 'available' && !partialListing) {
    return { ...listing, snapshotAt, posts: [], unmatched: [] };
  }
  const matched = matchTikTokVideosToLedger(listing.videos, ledger, { listingComplete: !partialListing });
  const seen = new Set((Array.isArray(existing?.posts) ? existing.posts : [])
    .filter((post) => Number(post.windowHours) === Number(windowHours))
    .map((post) => String(post.postId || '')));
  const posts = [];
  const skipped = [];
  const nowMs = Date.parse(snapshotAt);
  for (const item of matched.matches) {
    if (seen.has(item.postId)) {
      skipped.push({ postId: item.postId, reason: 'window-snapshot-already-recorded' });
      continue;
    }
    const publishedMs = timestamp(item.publishedAt);
    if (publishedMs === null) {
      skipped.push({ postId: item.postId, reason: 'published-at-unavailable' });
      continue;
    }
    const ageHours = (nowMs - publishedMs) / 3_600_000;
    if (ageHours < Number(windowHours) - Number(toleranceHours)) {
      skipped.push({ postId: item.postId, reason: 'window-not-reached' });
      continue;
    }
    if (ageHours > Number(windowHours) + Number(toleranceHours)) {
      skipped.push({ postId: item.postId, reason: 'window-expired' });
      continue;
    }
    posts.push({
      channel: 'tiktok',
      postId: item.postId,
      sourceIds: item.sourceIds,
      kind: item.kind,
      day: item.day,
      copy: item.copy,
      copyAttributionStatus: item.copyAttributionStatus,
      publishedAt: item.publishedAt,
      snapshotAt,
      snapshotAgeHours: Math.round(ageHours * 1000) / 1000,
      windowHours: Number(windowHours),
      measurementWindow: 'fixed-age',
      metricSource: 'tiktok-display-video-list',
      metrics: item.metrics,
      availableMetrics: item.availableMetrics,
      metricStatus: Object.fromEntries(Object.entries(item.metrics).map(([name, value]) => [name, value === null ? 'unavailable' : 'available'])),
      ledgerMetadataStatus: item.ledgerMetadataStatus,
    });
  }
  const status = posts.length
    ? partialListing ? 'partial-snapshots-added' : 'snapshots-added'
    : partialListing ? 'partial-no-window-matches'
      : matched.exactLedgerIds === 0 ? 'mapping-unavailable' : 'no-window-matches';
  return {
    status,
    partial: partialListing,
    listingStatus: listing.status,
    ...(listing.reasonCode ? { reasonCode: listing.reasonCode } : {}),
    snapshotAt,
    posts,
    unmatched: matched.unmatched,
    skipped,
    exactLedgerIds: matched.exactLedgerIds,
    listedVideos: listing.videos.length,
    pages: listing.pages,
    scope: TIKTOK_INSIGHTS_SCOPE,
  };
}
