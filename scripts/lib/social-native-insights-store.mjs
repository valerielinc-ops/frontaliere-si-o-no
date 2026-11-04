import { validateSocialNativeInsightsDocument } from './social-native-insights-schema.mjs';
import { socialCopyRevisionId } from './social-copy-revision.mjs';
import {
  INSTAGRAM_STORY_MAX_ROWS,
  INSTAGRAM_STORY_MEASUREMENT_WINDOW_IDS,
  INSTAGRAM_STORY_RETENTION_DAYS,
  INSTAGRAM_STORY_UNMAPPED_NAVIGATION_ACTION_METRIC,
} from './instagram-story-contract.mjs';

export { INSTAGRAM_STORY_MAX_ROWS, INSTAGRAM_STORY_RETENTION_DAYS };

export const SOCIAL_NATIVE_INSIGHTS_COLLECTION = 'social_native_insights';
export const SOCIAL_NATIVE_INSIGHTS_DOCUMENT = 'current';
export const SOCIAL_NATIVE_INSIGHTS_MAX_DOCUMENT_BYTES = 900_000;
export const SOCIAL_SITE_OUTCOME_RETENTION_DAYS = 100;
export const SOCIAL_FOLLOWER_GAIN_RETENTION_DAYS = 130;

const EMPTY_DOCUMENT = Object.freeze({
  schemaVersion: 1,
  posts: [],
  instagramStoryPublications: [],
  instagramStorySnapshots: [],
  audienceSnapshots: [],
  audienceBaselines: {},
  audienceGrowthCycles: {},
  followerGainSnapshots: [],
  siteOutcomeSnapshots: [],
  siteOutcomeBaselines: [],
  sources: {},
});
const INSTAGRAM_METRICS = Object.freeze([
  'reach', 'views', 'saves', 'shares', 'comments', 'profileVisits', 'linkClicks', 'interactions',
  'follows', 'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate',
]);
const INSTAGRAM_DECIMAL_METRICS = new Set([
  'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate',
]);

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePersistedSocialNativeInsights(document) {
  if (!record(document) || document.schemaVersion !== 1 || !Array.isArray(document.instagramStorySnapshots)) {
    return document;
  }
  let changed = false;
  const instagramStorySnapshots = document.instagramStorySnapshots.map((snapshot) => {
    if (!record(snapshot) || !record(snapshot.metrics) || !record(snapshot.metricStatus)) return snapshot;
    const hasMetric = Object.prototype.hasOwnProperty.call(
      snapshot.metrics,
      INSTAGRAM_STORY_UNMAPPED_NAVIGATION_ACTION_METRIC,
    );
    const hasMetricStatus = Object.prototype.hasOwnProperty.call(
      snapshot.metricStatus,
      INSTAGRAM_STORY_UNMAPPED_NAVIGATION_ACTION_METRIC,
    );
    if (hasMetric && hasMetricStatus) return snapshot;

    changed = true;
    return {
      ...snapshot,
      metrics: {
        ...snapshot.metrics,
        ...(!hasMetric ? { [INSTAGRAM_STORY_UNMAPPED_NAVIGATION_ACTION_METRIC]: null } : {}),
      },
      metricStatus: {
        ...snapshot.metricStatus,
        ...(!hasMetricStatus ? { [INSTAGRAM_STORY_UNMAPPED_NAVIGATION_ACTION_METRIC]: 'unavailable' } : {}),
      },
    };
  });
  return changed ? { ...document, instagramStorySnapshots } : document;
}

function metric(value, name = '') {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return INSTAGRAM_DECIMAL_METRICS.has(name) || Number.isSafeInteger(parsed) ? parsed : null;
}

function asIso(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Convert the browser-owned snapshot format into the private, validated store shape. */
export function normalizeInstagramPrivateSnapshots(snapshot) {
  if (!record(snapshot) || !Array.isArray(snapshot.posts)) {
    throw new Error('Instagram snapshot must contain a posts array');
  }
  return snapshot.posts.flatMap((row) => {
    if (!record(row)) return [];
    const postId = String(row.mediaId || row.postId || '').trim();
    const snapshotAt = asIso(row.snapshotAt);
    const snapshotAgeHours = Number(row.snapshotAgeHours);
    const windowHours = Number(row.windowHours ?? snapshot.windowHours);
    if (!postId || !snapshotAt || !Number.isFinite(snapshotAgeHours) || snapshotAgeHours < 0
      || !Number.isSafeInteger(windowHours) || windowHours < 1 || windowHours > 168) return [];
    const publishedAt = asIso(row.publishedAt)
      || new Date(Date.parse(snapshotAt) - snapshotAgeHours * 3_600_000).toISOString();
    const sourceMetrics = record(row.metrics) ? row.metrics : row;
    const declaredAvailability = sourceMetrics.availableMetrics ?? row.availableMetrics
      ?? sourceMetrics.metricAvailability ?? row.metricAvailability;
    const declaredStatuses = record(sourceMetrics.metricStatus)
      ? sourceMetrics.metricStatus
      : record(row.metricStatus) ? row.metricStatus : {};
    const declaredAvailable = Array.isArray(declaredAvailability)
      ? new Set(declaredAvailability.filter((name) => typeof name === 'string'))
      : record(declaredAvailability)
        ? new Set(Object.entries(declaredAvailability)
          .filter(([, state]) => state === true || state === 'available')
          .map(([name]) => name))
        : null;
    const audienceMetric = String(row.audienceMetric || row.reachSource || '').toLowerCase();
    const availableMetrics = INSTAGRAM_METRICS.filter((name) => {
      const value = metric(sourceMetrics[name], name);
      if (declaredAvailable) return declaredAvailable.has(name) && value !== null;
      // Legacy snapshots filled absent interaction metrics with zero. Keep
      // only positive values as observations unless the collector explicitly
      // declared availability; this avoids turning unknown into a measured 0.
      if (value === null || value === 0) return false;
      // Older browser snapshots copied views into `reach`; retain only the
      // original audience metric when the source tells us that happened.
      if (name === 'reach' && audienceMetric === 'views') return false;
      return true;
    });
    const availableSet = new Set(availableMetrics);
    const metrics = Object.fromEntries(INSTAGRAM_METRICS.map((name) => [
      name,
      availableSet.has(name) ? metric(sourceMetrics[name], name) : null,
    ]));
    const metricStatus = Object.fromEntries(INSTAGRAM_METRICS.map((name) => [
      name,
      availableSet.has(name) ? 'available' : declaredStatuses[name] === 'metric-unavailable' ? 'metric-unavailable' : 'unavailable',
    ]));
    const metadataFields = [
      'queueId', 'kind', 'day', 'creativeId', 'creativeBaseId', 'creativeVariant', 'creativeLabel',
      'creativeObjective', 'primaryMetric', 'engagementMechanic', 'hookType', 'attentionMechanic',
      'engagementLoop', 'followUpFormat', 'copyMode', 'copySlot', 'copyAssignmentMode',
      'copyExperimentId', 'copyBlockId', 'copyBlockCycle', 'copyRegistrationHash',
      'copyPromptVersion', 'copyPackId', 'copyTemplateId', 'copyObjective',
      'copyAngleId', 'copyPillarId', 'copyAngleIntent', 'copyHook', 'copyCta', 'copyRevisionId',
      'reachSource', 'audienceMetric', 'matchMethod', 'visualMatchDistance',
      'copyAttributionStatus', 'mediaType',
    ];
    const metadata = Object.fromEntries(metadataFields
      .filter((field) => row[field] !== undefined && row[field] !== null && row[field] !== '')
      .map((field) => [field, row[field]]));
    const revisionId = socialCopyRevisionId({ copyHook: row.copyHook, copyCta: row.copyCta });
    if (revisionId) metadata.copyRevisionId ||= revisionId;
    return [{
      channel: 'instagram',
      postId,
      publishedAt,
      snapshotAt,
      windowHours,
      snapshotAgeHours,
      metrics,
      availableMetrics,
      metricStatus,
      ...metadata,
    }];
  });
}

function storyMetadata(row) {
  const value = (input) => {
    const text = String(input ?? '').trim();
    return text || null;
  };
  return {
    sourceMediaId: value(row.sourceMediaId),
    followUpFormat: value(row.followUpFormat),
    copyPackId: value(row.copyPackId),
    copyTemplateId: value(row.copyTemplateId),
    copyAngleId: value(row.copyAngleId),
    copyPillarId: value(row.copyPillarId),
    copyRevisionId: value(row.copyRevisionId),
  };
}

/** Keep exact Instagram Story identities private and bounded for live insights collection. */
export function mergePrivateInstagramStoryPublications(existing, additions, {
  asOf = new Date(),
  retentionDays = INSTAGRAM_STORY_RETENTION_DAYS,
} = {}) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs) || !Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('Instagram Story retention and asOf must be valid');
  }
  const cutoff = asOfMs - retentionDays * 24 * 60 * 60 * 1000;
  const byStoryId = new Map();
  for (const row of [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(additions) ? additions : []),
  ]) {
    if (!record(row)) continue;
    const storyId = String(row.storyId || '').trim();
    const publishedAt = asIso(row.publishedAt);
    const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN;
    if (!storyId || storyId.length > 128 || !publishedAt || publishedMs < cutoff || publishedMs > asOfMs) continue;
    const metadata = storyMetadata(row);
    const publication = { storyId, publishedAt, ...metadata };
    const current = byStoryId.get(storyId);
    if (!current || Date.parse(publication.publishedAt) >= Date.parse(current.publishedAt)) {
      byStoryId.set(storyId, publication);
    }
  }
  return [...byStoryId.values()]
    .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))
    .slice(-INSTAGRAM_STORY_MAX_ROWS);
}

/** Merge one early and one near-expiry snapshot per Story, without treating missing metrics as zero. */
export function mergePrivateInstagramStorySnapshots(existing, additions, {
  asOf = new Date(),
  retentionDays = INSTAGRAM_STORY_RETENTION_DAYS,
  publicationIds = null,
} = {}) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs) || !Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('Instagram Story snapshot retention and asOf must be valid');
  }
  if (publicationIds !== null && !(publicationIds instanceof Set)) {
    throw new TypeError('publicationIds must be a Set when supplied');
  }
  const cutoff = asOfMs - retentionDays * 24 * 60 * 60 * 1000;
  const byWindow = new Map();
  for (const row of [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(additions) ? additions : []),
  ]) {
    if (!record(row)) continue;
    const storyId = String(row.storyId || '').trim();
    if (publicationIds && !publicationIds.has(storyId)) continue;
    const publishedAt = asIso(row.publishedAt);
    const snapshotAt = asIso(row.snapshotAt);
    const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN;
    const snapshotMs = snapshotAt ? Date.parse(snapshotAt) : NaN;
    if (!storyId || storyId.length > 128 || !publishedAt || !snapshotAt
      || publishedMs < cutoff || snapshotMs > asOfMs || snapshotMs < publishedMs
      || !INSTAGRAM_STORY_MEASUREMENT_WINDOW_IDS.includes(row.measurementWindow)) continue;
    const key = `${storyId}\u0000${row.measurementWindow}`;
    const current = byWindow.get(key);
    if (!current || snapshotMs >= Date.parse(current.snapshotAt)) {
      byWindow.set(key, {
        storyId,
        publishedAt,
        snapshotAt,
        snapshotAgeHours: Number(row.snapshotAgeHours),
        measurementWindow: row.measurementWindow,
        metrics: record(row.metrics) ? row.metrics : {},
        availableMetrics: Array.isArray(row.availableMetrics) ? row.availableMetrics : [],
        metricStatus: record(row.metricStatus) ? row.metricStatus : {},
        ...storyMetadata(row),
      });
    }
  }
  return [...byWindow.values()]
    .sort((left, right) => left.snapshotAt.localeCompare(right.snapshotAt) || left.storyId.localeCompare(right.storyId))
    .slice(-INSTAGRAM_STORY_MAX_ROWS);
}

/** Merge bounded Story publications and snapshots together so retention cannot orphan a snapshot. */
export function mergePrivateInstagramStoryState(existing, {
  publicationAdditions = [],
  snapshotAdditions = [],
  asOf = new Date(),
  retentionDays = INSTAGRAM_STORY_RETENTION_DAYS,
} = {}) {
  const current = record(existing) ? existing : {};
  const publications = mergePrivateInstagramStoryPublications(
    current.instagramStoryPublications,
    publicationAdditions,
    { asOf, retentionDays },
  );
  const publicationIds = new Set(publications.map(({ storyId }) => storyId));
  const snapshots = mergePrivateInstagramStorySnapshots(
    current.instagramStorySnapshots,
    snapshotAdditions,
    { asOf, retentionDays, publicationIds },
  );
  return {
    instagramStoryPublications: publications,
    instagramStorySnapshots: snapshots,
  };
}

/** Merge one channel's new observations without replacing other private channels. */
export function mergePrivateSocialInsightPosts(existingPosts, additions) {
  const byKey = new Map();
  for (const post of [...(Array.isArray(existingPosts) ? existingPosts : []), ...(Array.isArray(additions) ? additions : [])]) {
    if (!record(post) || !post.channel || !post.postId) continue;
    const key = `${post.channel}\u0000${post.postId}\u0000${post.windowHours || post.windowDays || 'unknown'}`;
    const current = byKey.get(key);
    if (!current || Date.parse(String(post.snapshotAt || '')) >= Date.parse(String(current.snapshotAt || ''))) {
      byKey.set(key, post);
    }
  }
  return [...byKey.values()].sort((left, right) => (
    String(left.publishedAt).localeCompare(String(right.publishedAt))
      || String(left.channel).localeCompare(String(right.channel))
      || String(left.postId).localeCompare(String(right.postId))
  ));
}

/** Merge daily channel-level audience counts without storing account identifiers. */
export function mergePrivateSocialAudienceSnapshots(existingSnapshots, additions, {
  asOf = new Date(),
  retentionDays = 130,
} = {}) {
  const asOfMs = new Date(asOf).getTime();
  const retention = Number(retentionDays);
  if (!Number.isFinite(asOfMs) || !Number.isSafeInteger(retention) || retention < 1) {
    throw new TypeError('audience snapshot retention and asOf must be valid');
  }
  const cutoff = asOfMs - retention * 24 * 60 * 60 * 1000;
  const byDay = new Map();
  for (const snapshot of [
    ...(Array.isArray(existingSnapshots) ? existingSnapshots : []),
    ...(Array.isArray(additions) ? additions : []),
  ]) {
    if (!record(snapshot)) continue;
    const snapshotMs = Date.parse(String(snapshot.snapshotAt || ''));
    if (!Number.isFinite(snapshotMs) || snapshotMs < cutoff || snapshotMs > asOfMs) continue;
    const day = new Date(snapshotMs).toISOString().slice(0, 10);
    const key = `${snapshot.channel}\u0000${snapshot.metric}\u0000${day}`;
    const current = byDay.get(key);
    if (!current || snapshotMs >= Date.parse(current.snapshotAt)) byDay.set(key, snapshot);
  }
  return [...byDay.values()].sort((left, right) => (
    String(left.snapshotAt).localeCompare(String(right.snapshotAt))
      || String(left.channel).localeCompare(String(right.channel))
      || String(left.metric).localeCompare(String(right.metric))
  ));
}

/** Merge daily follower-gain observations separately from lifetime audience totals. */
export function mergePrivateSocialFollowerGainSnapshots(existingSnapshots, additions, {
  asOf = new Date(),
  retentionDays = SOCIAL_FOLLOWER_GAIN_RETENTION_DAYS,
} = {}) {
  const asOfMs = new Date(asOf).getTime();
  const retention = Number(retentionDays);
  if (!Number.isFinite(asOfMs) || !Number.isSafeInteger(retention) || retention < 1) {
    throw new TypeError('follower gain retention and asOf must be valid');
  }
  const cutoff = asOfMs - retention * 24 * 60 * 60 * 1000;
  const byDate = new Map();
  for (const row of [
    ...(Array.isArray(existingSnapshots) ? existingSnapshots : []),
    ...(Array.isArray(additions) ? additions : []),
  ]) {
    if (!record(row)) continue;
    const snapshotMs = Date.parse(String(row.snapshotAt || ''));
    const dateMs = Date.parse(`${String(row.date || '')}T12:00:00.000Z`);
    if (!Number.isFinite(snapshotMs) || !Number.isFinite(dateMs) || snapshotMs < cutoff || snapshotMs > asOfMs) continue;
    const key = `${row.channel}\u0000${row.metric}\u0000${row.date}`;
    const current = byDate.get(key);
    if (!current || snapshotMs >= Date.parse(String(current.snapshotAt || ''))) byDate.set(key, row);
  }
  return [...byDate.values()].sort((left, right) => (
    String(left.date).localeCompare(String(right.date))
      || String(left.channel).localeCompare(String(right.channel))
  ));
}

/** Merge bounded daily GA4 session-rate observations by channel, event, and property date. */
export function mergePrivateSocialSiteOutcomeSnapshots(existingSnapshots, additions, {
  asOf = new Date(),
  retentionDays = SOCIAL_SITE_OUTCOME_RETENTION_DAYS,
} = {}) {
  const asOfMs = new Date(asOf).getTime();
  const retention = Number(retentionDays);
  if (!Number.isFinite(asOfMs) || !Number.isSafeInteger(retention) || retention < 1) {
    throw new TypeError('site outcome retention and asOf must be valid');
  }
  const cutoff = asOfMs - retention * 24 * 60 * 60 * 1000;
  const byKey = new Map();
  for (const row of [
    ...(Array.isArray(existingSnapshots) ? existingSnapshots : []),
    ...(Array.isArray(additions) ? additions : []),
  ]) {
    if (!record(row)) continue;
    const dateMs = Date.parse(`${String(row.date || '')}T12:00:00.000Z`);
    if (!Number.isFinite(dateMs) || dateMs < cutoff || dateMs > asOfMs) continue;
    const key = `${row.channel}\u0000${row.eventName}\u0000${row.date}`;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) => (
    String(left.date).localeCompare(String(right.date))
      || String(left.channel).localeCompare(String(right.channel))
      || String(left.eventName).localeCompare(String(right.eventName))
  ));
}

/** Expand private metric maps for the existing Instagram insight analyzers. */
export function toInstagramBrowserSnapshotDocument(privateDocument) {
  const posts = (Array.isArray(privateDocument?.posts) ? privateDocument.posts : [])
    .filter((post) => post?.channel === 'instagram')
    .map((post) => ({ ...post, mediaId: post.postId, ...post.metrics }));
  return {
    schemaVersion: 2,
    generatedAt: privateDocument?.generatedAt || privateDocument?.storeUpdatedAt || new Date().toISOString(),
    windowHours: 72,
    posts,
  };
}

function documentReference(db) {
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError('a Firestore Admin handle is required');
  }
  return db.collection(SOCIAL_NATIVE_INSIGHTS_COLLECTION).doc(SOCIAL_NATIVE_INSIGHTS_DOCUMENT);
}

/** Load private per-post analytics from Firestore; never mirror it into the public repository. */
export async function loadPrivateSocialNativeInsights(db, { asOf = new Date() } = {}) {
  const snapshot = await documentReference(db).get();
  const document = snapshot.exists ? normalizePersistedSocialNativeInsights(snapshot.data()) : EMPTY_DOCUMENT;
  validateSocialNativeInsightsDocument(document, { asOf });
  return document;
}

/** Persist the bounded private analytics document, refusing Firestore's 1 MiB limit with headroom. */
export async function savePrivateSocialNativeInsights(db, document, { updatedAt = new Date() } = {}) {
  validateSocialNativeInsightsDocument(document, { asOf: updatedAt });
  const stored = { ...document, storeUpdatedAt: new Date(updatedAt).toISOString() };
  const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
  if (bytes > SOCIAL_NATIVE_INSIGHTS_MAX_DOCUMENT_BYTES) {
    throw new Error(`private social insights document exceeds ${SOCIAL_NATIVE_INSIGHTS_MAX_DOCUMENT_BYTES} bytes`);
  }
  await documentReference(db).set(stored);
  return { bytes };
}

/** Apply a read/merge/write update atomically so channel collectors cannot lose each other's rows. */
export async function updatePrivateSocialNativeInsights(db, updateDocument, { updatedAt = new Date() } = {}) {
  if (typeof updateDocument !== 'function') throw new TypeError('updateDocument must be a function');
  if (typeof db?.runTransaction !== 'function') {
    throw new TypeError('Firestore transactions are required for private social insight updates');
  }
  const reference = documentReference(db);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists ? normalizePersistedSocialNativeInsights(snapshot.data()) : EMPTY_DOCUMENT;
    validateSocialNativeInsightsDocument(current, { asOf: updatedAt });
    const next = await updateDocument(current);
    validateSocialNativeInsightsDocument(next, { asOf: updatedAt });
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return { bytes: Buffer.byteLength(JSON.stringify(current), 'utf8'), changed: false };
    }
    const stored = { ...next, storeUpdatedAt: new Date(updatedAt).toISOString() };
    const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
    if (bytes > SOCIAL_NATIVE_INSIGHTS_MAX_DOCUMENT_BYTES) {
      throw new Error(`private social insights document exceeds ${SOCIAL_NATIVE_INSIGHTS_MAX_DOCUMENT_BYTES} bytes`);
    }
    transaction.set(reference, stored);
    return { bytes, changed: true };
  });
}
