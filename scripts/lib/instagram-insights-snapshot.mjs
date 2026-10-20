/**
 * Read-only Instagram Insights snapshot collector.
 *
 * The Playwright robot confirms a post in the UI, but the confirmation does
 * not necessarily contain Meta's media id. We therefore match confirmed
 * ledger groups to the account's recent media by timestamp and refuse
 * ambiguous matches. A wrong attribution would poison the creative test, so
 * a missing or ambiguous match is always skipped.
 */
import { fetchRetry } from './ga4-service-account.mjs';
import { matchInstagramMedia } from './instagram-media-matching.mjs';
import { GRAPH_API } from './instagram-graph-constants.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_WINDOW_HOURS = 72;
export const DEFAULT_WINDOW_TOLERANCE_HOURS = 0;
export const DEFAULT_MEDIA_MATCH_MINUTES = 30;
export const DEFAULT_MEDIA_FIELDS = Object.freeze(['id', 'timestamp', 'media_type', 'permalink']);
export const DEFAULT_INSIGHT_METRICS = Object.freeze(['reach', 'saved', 'shares', 'comments']);

const METRIC_ALIASES = Object.freeze({
  reach: ['reach'],
  shares: ['shares', 'share_count', 'shares_count'],
  saves: ['saved', 'saves', 'save_count', 'saved_count'],
  comments: ['comments', 'comment_count', 'comments_count'],
  profileVisits: ['profile_activity', 'profile_visits', 'profileVisits'],
  linkClicks: ['website_clicks', 'link_clicks', 'linkClicks'],
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  const valueText = String(value ?? '').trim();
  return valueText || null;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return null;
}

export function snapshotRows(document) {
  if (Array.isArray(document)) return document.filter(isRecord);
  if (!isRecord(document)) return [];
  for (const key of ['posts', 'snapshots', 'data', 'rows', 'results']) {
    if (Array.isArray(document[key])) return document[key].filter(isRecord);
  }
  return [];
}

function postedRows(ledger) {
  if (Array.isArray(ledger)) return ledger.filter(isRecord);
  return isRecord(ledger) && Array.isArray(ledger.posted) ? ledger.posted.filter(isRecord) : [];
}

function rowIdentity(row) {
  return firstText(
    row.queueId,
    row.queue_id,
    row.mediaId,
    row.media_id,
    row.instagramMediaId,
    row.postId,
    row.id,
    row.identity,
  );
}

function snapshotIdentity(value, windowHours) {
  const identity = rowIdentity(value);
  return identity ? `${identity}\u0000${windowHours}` : null;
}

/** Group the five ledger rows belonging to one carousel into one post. */
export function groupPostedLedger(ledger) {
  const groups = new Map();
  for (const entry of postedRows(ledger)) {
    const creativeId = firstText(entry.creativeId, entry.creative_id);
    if (!creativeId) continue;
    const kind = firstText(entry.kind, entry.contentKind, entry.content_kind) || 'unknown';
    const day = firstText(entry.day) || null;
    const mediaId = firstText(entry.instagramMediaId, entry.mediaId, entry.media_id);
    const queueId = firstText(entry.queueId, entry.queue_id);
    const entryTs = timestamp(entry.ts || entry.postedAt || entry.confirmedAt || entry.createdAt);
    const identity = mediaId || queueId || `${kind}:${day || 'unknown'}:${creativeId}`;
    const group = groups.get(identity) || {
      identity,
      mediaId,
      queueId,
      kind,
      day,
      sourceKind: firstText(entry.sourceKind, entry.source_kind),
      sourceId: firstText(entry.sourceId, entry.source_id),
      storyImageUrl: firstText(entry.instagramStoryImageUrl, entry.storyImageUrl, entry.story_image_url),
      creativeId,
      creativeBaseId: firstText(entry.creativeBaseId, entry.creative_base_id),
      creativeVariant: firstText(entry.creativeVariant, entry.creative_variant),
      creativeLabel: firstText(entry.creativeLabel, entry.creative_label),
      creativeObjective: firstText(entry.creativeObjective, entry.creative_objective),
      primaryMetric: firstText(entry.primaryMetric, entry.primary_metric),
      engagementMechanic: firstText(entry.engagementMechanic, entry.engagement_mechanic),
      hookType: firstText(entry.hookType, entry.hook_type),
      attentionMechanic: firstText(entry.attentionMechanic, entry.attention_mechanic),
      engagementLoop: firstText(entry.engagementLoop, entry.engagement_loop),
      followUpFormat: firstText(entry.followUpFormat, entry.follow_up_format),
      publishedAtMs: entryTs,
      entries: 0,
      conflictingCreativeId: false,
    };
    if (group.creativeId !== creativeId) group.conflictingCreativeId = true;
    group.mediaId ||= mediaId;
    group.queueId ||= queueId;
    group.sourceKind ||= firstText(entry.sourceKind, entry.source_kind);
    group.sourceId ||= firstText(entry.sourceId, entry.source_id);
    group.storyImageUrl ||= firstText(entry.instagramStoryImageUrl, entry.storyImageUrl, entry.story_image_url);
    group.creativeBaseId ||= firstText(entry.creativeBaseId, entry.creative_base_id);
    group.creativeVariant ||= firstText(entry.creativeVariant, entry.creative_variant);
    group.creativeLabel ||= firstText(entry.creativeLabel, entry.creative_label);
    group.creativeObjective ||= firstText(entry.creativeObjective, entry.creative_objective);
    group.primaryMetric ||= firstText(entry.primaryMetric, entry.primary_metric);
    group.engagementMechanic ||= firstText(entry.engagementMechanic, entry.engagement_mechanic);
    group.hookType ||= firstText(entry.hookType, entry.hook_type);
    group.attentionMechanic ||= firstText(entry.attentionMechanic, entry.attention_mechanic);
    group.engagementLoop ||= firstText(entry.engagementLoop, entry.engagement_loop);
    group.followUpFormat ||= firstText(entry.followUpFormat, entry.follow_up_format);
    group.publishedAtMs = group.publishedAtMs === null
      ? entryTs
      : entryTs === null ? group.publishedAtMs : Math.min(group.publishedAtMs, entryTs);
    group.entries += 1;
    groups.set(identity, group);
  }
  return [...groups.values()];
}

function existingSnapshotKeys(existing, windowHours) {
  return new Set(
    snapshotRows(existing)
      .map((row) => snapshotIdentity(row, Number(row.windowHours) || windowHours))
      .filter(Boolean),
  );
}

/** Select posts old enough for a stable target-window snapshot. */
export function selectSnapshotCandidates(
  ledger,
  existing,
  { asOf = new Date(), windowHours = DEFAULT_WINDOW_HOURS, toleranceHours = DEFAULT_WINDOW_TOLERANCE_HOURS } = {},
) {
  const asOfMs = timestamp(asOf) ?? Date.now();
  const targetHours = Number(windowHours);
  const tolerance = Math.max(0, Number(toleranceHours) || 0);
  const keys = existingSnapshotKeys(existing, targetHours);
  const candidates = [];
  const skipped = [];
  for (const group of groupPostedLedger(ledger)) {
    const key = snapshotIdentity(group, targetHours);
    if (group.conflictingCreativeId) {
      skipped.push({ reason: 'conflicting-creative-metadata' });
    } else if (!group.publishedAtMs) {
      skipped.push({ reason: 'published-at-missing' });
    } else if (keys.has(key)) {
      skipped.push({ reason: 'snapshot-already-recorded' });
    } else {
      const ageHours = (asOfMs - group.publishedAtMs) / 3_600_000;
      if (ageHours < 0) {
        skipped.push({ reason: 'published-in-future' });
      } else if (ageHours < targetHours - tolerance) {
        skipped.push({ reason: 'window-not-reached' });
      } else {
        candidates.push({ ...group, ageHours });
      }
    }
  }
  return { candidates, skipped };
}

async function graphGet(pathSuffix, params, accessToken, { fetchImpl = fetchRetry } = {}) {
  const query = new URLSearchParams({ ...params, access_token: accessToken });
  const response = await fetchImpl(`${GRAPH_API}/${pathSuffix}?${query.toString()}`, {}, 2, 30_000);
  const body = await response.json().catch(() => ({}));
  if (!response?.ok || body?.error) {
    throw new Error(`Instagram Graph API ${response?.status || 'error'}: ${body?.error?.message || 'request failed'}`);
  }
  return body;
}

export async function listAccountMedia(
  accountId,
  accessToken,
  { fetchImpl = fetchRetry, fields = DEFAULT_MEDIA_FIELDS, maxPages = 10 } = {},
) {
  const media = [];
  let after = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = { fields: fields.join(','), limit: '100' };
    if (after) params.after = after;
    const body = await graphGet(`${encodeURIComponent(accountId)}/media`, params, accessToken, { fetchImpl });
    if (Array.isArray(body.data)) media.push(...body.data.filter(isRecord));
    after = text(body.paging?.cursors?.after);
    if (!after) break;
  }
  return media;
}

/**
 * Match ledger groups to recent media. Ties and reused media candidates are
 * rejected instead of guessing, because a wrong creative attribution is
 * worse than a missing observation.
 */
export function matchLedgerToMedia(groups, media, { maxDistanceMinutes = DEFAULT_MEDIA_MATCH_MINUTES } = {}) {
  return matchInstagramMedia(groups, media, {
    maxDistanceMinutes,
    missingMediaIdReason: 'ledger-media-id-not-returned',
  });
}

function metricValue(item) {
  if (Array.isArray(item?.values)) return item.values.at(-1)?.value;
  return item?.value;
}

export function normalizeMediaInsights(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.insights?.data) ? payload.insights.data : [];
  const values = {};
  for (const item of list) {
    if (!isRecord(item)) continue;
    const rawName = text(item.name);
    if (!rawName) continue;
    const value = number(metricValue(item));
    if (value === null || value < 0) continue;
    for (const [canonical, aliases] of Object.entries(METRIC_ALIASES)) {
      if (aliases.includes(rawName)) values[canonical] = value;
    }
  }
  if (!Number.isFinite(values.reach) || values.reach <= 0) {
    throw new Error('Insights response did not contain a positive reach metric');
  }
  return {
    reach: values.reach,
    shares: values.shares || 0,
    saves: values.saves || 0,
    comments: values.comments || 0,
    profileVisits: values.profileVisits || 0,
    linkClicks: values.linkClicks || 0,
  };
}

export async function fetchMediaInsights(
  mediaId,
  accessToken,
  { fetchImpl = fetchRetry, metrics = DEFAULT_INSIGHT_METRICS } = {},
) {
  const body = await graphGet(
    `${encodeURIComponent(mediaId)}/insights`,
    { metric: metrics.join(',') },
    accessToken,
    { fetchImpl },
  );
  return normalizeMediaInsights(body);
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function buildSnapshotDocument(existing, additions, { generatedAt = new Date(), windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const current = snapshotRows(existing);
  const rows = [...current];
  const seen = new Set(current.map((row) => snapshotIdentity(row, Number(row.windowHours) || windowHours)).filter(Boolean));
  for (const addition of additions) {
    const key = snapshotIdentity(addition, Number(addition.windowHours) || windowHours);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(addition);
  }
  rows.sort((a, b) => String(a.snapshotAt || '').localeCompare(String(b.snapshotAt || '')) || String(a.postId || '').localeCompare(String(b.postId || '')));
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    windowHours: Number(windowHours),
    posts: rows,
  };
}

export async function collectSnapshots({
  ledger,
  existing = null,
  accountId,
  accessToken,
  asOf = new Date(),
  windowHours = DEFAULT_WINDOW_HOURS,
  toleranceHours = DEFAULT_WINDOW_TOLERANCE_HOURS,
  maxDistanceMinutes = DEFAULT_MEDIA_MATCH_MINUTES,
  fetchImpl = fetchRetry,
} = {}) {
  const asOfMs = timestamp(asOf) ?? Date.now();
  const asOfIso = new Date(asOfMs).toISOString();
  const targetWindow = Number(windowHours);
  const candidatesResult = selectSnapshotCandidates(ledger, existing, {
    asOf: asOfMs,
    windowHours: targetWindow,
    toleranceHours,
  });
  if (!accountId || !accessToken) {
    return {
      status: 'credentials-missing',
      additions: [],
      candidates: candidatesResult.candidates.length,
      skipped: candidatesResult.skipped,
    };
  }
  if (candidatesResult.candidates.length === 0) {
    return { status: 'nothing-ready', additions: [], candidates: 0, skipped: candidatesResult.skipped };
  }

  const media = await listAccountMedia(accountId, accessToken, { fetchImpl });
  const matched = matchLedgerToMedia(candidatesResult.candidates, media, { maxDistanceMinutes });
  const additions = [];
  const skipped = [...candidatesResult.skipped, ...matched.unmatched.map((item) => ({ reason: item.reason }))];
  for (const { group, media: mediaItem, method } of matched.matches) {
    try {
      const metrics = await fetchMediaInsights(mediaItem.id, accessToken, { fetchImpl });
      additions.push({
        postId: String(mediaItem.id),
        mediaId: String(mediaItem.id),
        queueId: group.queueId || undefined,
        kind: group.kind,
        day: group.day || undefined,
        creativeId: group.creativeId,
        creativeBaseId: group.creativeBaseId || undefined,
        creativeVariant: group.creativeVariant || undefined,
        creativeLabel: group.creativeLabel || undefined,
        creativeObjective: group.creativeObjective || undefined,
        primaryMetric: group.primaryMetric || undefined,
        engagementMechanic: group.engagementMechanic || undefined,
        hookType: group.hookType || undefined,
        attentionMechanic: group.attentionMechanic || undefined,
        engagementLoop: group.engagementLoop || undefined,
        followUpFormat: group.followUpFormat || undefined,
        mediaType: text(mediaItem.media_type),
        permalink: text(mediaItem.permalink),
        windowHours: targetWindow,
        snapshotAt: asOfIso,
        snapshotAgeHours: round(group.ageHours),
        matchMethod: method,
        ...metrics,
      });
    } catch (error) {
      skipped.push({ reason: 'insights-fetch-failed', message: String(error.message || error).slice(0, 180) });
    }
  }
  return {
    status: additions.length ? 'snapshots-added' : 'nothing-collected',
    additions,
    candidates: candidatesResult.candidates.length,
    media: media.length,
    matched: matched.matches.length,
    skipped,
  };
}
