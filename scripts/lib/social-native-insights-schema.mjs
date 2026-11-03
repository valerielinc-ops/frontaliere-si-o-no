import {
  SOCIAL_GA4_ACTION_EVENT_NAMES,
  SOCIAL_GA4_CHANNELS,
  SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS,
  SOCIAL_GA4_EVENT_CONTRACT_VERSION,
  SOCIAL_GA4_SITE_OUTCOME_MINIMUM_DAYS,
  SOCIAL_GA4_SITE_OUTCOME_MINIMUM_SESSIONS,
} from './social-ga4-contract.mjs';
import {
  INSTAGRAM_STORY_MAX_ROWS,
  INSTAGRAM_STORY_MEASUREMENT_WINDOWS,
  INSTAGRAM_STORY_METRICS,
} from './instagram-story-contract.mjs';

const CHANNELS = new Set(['instagram', 'tiktok', 'linkedin-member', 'facebook']);
const FACEBOOK_METRICS = new Set(['mediaViews', 'uniqueViewers', 'reactions', 'clicks']);
const DECIMAL_INSTAGRAM_METRICS = new Set([
  'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate',
]);
const SOURCE_NAMES = new Set([
  'instagram', 'tiktok', 'linkedinMember', 'facebook', 'telegram', 'reddit', 'youtubeShorts',
  'instagramAudience', 'tiktokAudience', 'facebookAudience', 'linkedinAudience',
  'telegramAudience', 'youtubeShortsAudience', 'threadsAudience', 'socialRobotDelivery',
  'socialSiteOutcomes', 'linkedinFollowerGains',
  'instagramPostInsights', 'instagramStoryInsights',
]);
const HEALTH_SIGNAL_SOURCES = new Set([
  'instagramPostInsights', 'tiktokPostInsights', 'facebookPostInsights', 'linkedinMemberPostInsights',
  'instagramStoryInsights',
  'instagramAudience', 'tiktokAudience', 'facebookAudience', 'telegramAudience',
  'linkedinAudience',
  'linkedinFollowerGains', 'socialSiteOutcomes', 'socialRobotDelivery',
]);
const ROBOT_DELIVERY_CHANNELS = new Set(['instagram', 'tiktok']);
const ROBOT_DELIVERY_STATES = new Set(['eligible', 'policy-held']);
const COPY_ANGLE_INTENTS = new Set(['searchable', 'shareable', 'both']);
const ROBOT_DELIVERY_OUTCOMES = new Set([
  'unconfirmed', 'error', 'held', 'paused', 'published', 'dry-run', 'cap', 'skipped',
  'empty', 'no-result', 'policy-held', 'mode-off',
]);
const COMMUNITY_SURFACES = Object.freeze(['comments', 'directMessages']);
const COMMUNITY_SOURCES = new Set(['graph', 'browser']);
const COMMUNITY_COVERAGE = new Set([
  'graph-bounded-pages-and-recent-media',
  'business-suite-thread-list-only; sender-and-age-unavailable',
]);
const COMMUNITY_ESCALATIONS = Object.freeze([
  'personal-or-sensitive', 'source-required', 'outside-window', 'timestamp-unavailable',
  'delivery-failed', 'reply-limit-reached', 'empty-or-unreadable',
]);
const COMMUNITY_LATENCY_BUCKETS = Object.freeze(['under1h', 'oneToFourHours', 'fourTo24Hours', 'over24Hours']);
const AUDIENCE_METRICS = Object.freeze({
  instagram: new Set(['followers']),
  tiktok: new Set(['followers']),
  facebook: new Set(['followers']),
  'linkedin-member': new Set(['followers']),
  telegram: new Set(['members']),
  'youtube-shorts': new Set(['subscribers']),
  threads: new Set(['followers']),
  reddit: new Set(['followers']),
});
const SENSITIVE_KEY = /(?:access|refresh)?token|secret|password|authorization|cookie|private.?key|browser.?state/iu;

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function rejectSecrets(value, path = '$', seen = new WeakSet()) {
  if (!record(value) && !Array.isArray(value)) return;
  if (seen.has(value)) throw new Error(`cyclic value in social insights document at ${path}`);
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`sensitive field is forbidden in social insights document at ${path}.${key}`);
    rejectSecrets(nested, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function validTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed);
}

function validateAudienceBaselines(baselines, nowMs) {
  if (baselines === undefined) return;
  if (!record(baselines)) throw new Error('social audience baselines must be an object');
  for (const [channel, baseline] of Object.entries(baselines)) {
    const allowedMetrics = AUDIENCE_METRICS[channel];
    if (!allowedMetrics || !record(baseline) || baseline.schemaVersion !== 1
      || baseline.channel !== channel || !allowedMetrics.has(baseline.metric)
      || !validTimestamp(baseline.startAt) || !validTimestamp(baseline.endAt)
      || !validTimestamp(baseline.frozenAt)
      || !Number.isSafeInteger(baseline.startValue) || baseline.startValue < 0
      || !Number.isSafeInteger(baseline.endValue) || baseline.endValue < 0
      || baseline.netChange !== baseline.endValue - baseline.startValue
      || !Number.isSafeInteger(baseline.coverageDays) || baseline.coverageDays < 25
      || !Number.isSafeInteger(baseline.observations) || baseline.observations < baseline.coverageDays) {
      throw new Error(`invalid frozen audience baseline for ${channel}`);
    }
    const startMs = Date.parse(baseline.startAt);
    const endMs = Date.parse(baseline.endAt);
    const frozenMs = Date.parse(baseline.frozenAt);
    if (startMs > endMs || endMs > frozenMs || frozenMs > nowMs
      || Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) < 25) {
      throw new Error(`frozen audience baseline timestamps are out of range for ${channel}`);
    }
  }
}

function validateAudienceGrowthCycles(cycles, nowMs) {
  if (cycles === undefined) return;
  if (!record(cycles)) throw new Error('social audience growth cycles must be an object');
  const dayMs = 24 * 60 * 60 * 1000;
  for (const [channel, cycle] of Object.entries(cycles)) {
    if (!AUDIENCE_METRICS[channel]
      || !hasExactKeys(cycle, ['schemaVersion', 'channel', 'cycleNumber', 'status', 'currentBaseline', 'lastCompleted'])
      || cycle.schemaVersion !== 1 || cycle.channel !== channel
      || !Number.isSafeInteger(cycle.cycleNumber) || cycle.cycleNumber < 1
      || !['active', 'awaiting-qualified-next-baseline'].includes(cycle.status)) {
      throw new Error(`invalid audience growth cycle for ${channel}`);
    }
    validateAudienceBaselines({ [channel]: cycle.currentBaseline }, nowMs);
    if (cycle.lastCompleted === null) {
      if (cycle.cycleNumber !== 1 || cycle.status !== 'active') {
        throw new Error(`audience growth cycle history is missing for ${channel}`);
      }
      continue;
    }
    const completed = cycle.lastCompleted;
    if (!hasExactKeys(completed, [
      'cycleNumber', 'baselineStartAt', 'baselineEndAt', 'targetAt', 'observationAt', 'completedAt',
      'baselineNetChange', 'followupNetChange', 'targetNetChange', 'targetNetChangeForObservedWindow', 'targetMet',
    ]) || !Number.isSafeInteger(completed.cycleNumber) || completed.cycleNumber < 1
      || !validTimestamp(completed.baselineStartAt) || !validTimestamp(completed.baselineEndAt)
      || !validTimestamp(completed.targetAt) || !validTimestamp(completed.observationAt)
      || !validTimestamp(completed.completedAt)
      || !Number.isSafeInteger(completed.baselineNetChange)
      || !Number.isSafeInteger(completed.followupNetChange)
      || !Number.isSafeInteger(completed.targetNetChange) || completed.targetNetChange < 1
      || !Number.isSafeInteger(completed.targetNetChangeForObservedWindow) || completed.targetNetChangeForObservedWindow < 1
      || typeof completed.targetMet !== 'boolean') {
      throw new Error(`invalid completed audience growth cycle for ${channel}`);
    }
    const baselineStartMs = Date.parse(completed.baselineStartAt);
    const baselineEndMs = Date.parse(completed.baselineEndAt);
    const targetMs = Date.parse(completed.targetAt);
    const observationMs = Date.parse(completed.observationAt);
    const completedMs = Date.parse(completed.completedAt);
    if (baselineStartMs > baselineEndMs || baselineEndMs > completedMs
      || targetMs !== baselineEndMs + 90 * dayMs
      || Math.abs(observationMs - targetMs) > 2 * dayMs
      || observationMs > completedMs || completedMs > nowMs
      || completed.cycleNumber !== (cycle.status === 'active' ? cycle.cycleNumber - 1 : cycle.cycleNumber)) {
      throw new Error(`completed audience growth cycle timestamps are out of range for ${channel}`);
    }
  }
}

function validDateOnly(value) {
  const day = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return false;
  const parsed = Date.parse(`${day}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function validateSocialSiteOutcomeSnapshots(rows, nowMs) {
  if (rows === undefined) return;
  if (!Array.isArray(rows) || rows.length > 5_000) throw new Error('invalid social site outcome snapshot collection');
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (!hasExactKeys(row, [
      'channel', 'eventName', 'eventContractVersion', 'date', 'timeZone', 'sessions',
      'sessionKeyEventRate', 'status', 'source',
    ]) || !SOCIAL_GA4_CHANNELS.includes(row.channel)
      || !SOCIAL_GA4_ACTION_EVENT_NAMES.includes(row.eventName)
      || row.eventContractVersion !== SOCIAL_GA4_EVENT_CONTRACT_VERSION || !validDateOnly(row.date) || !validTimeZone(row.timeZone)
      || !Number.isSafeInteger(row.sessions) || row.sessions < 0
      || !['available', 'zero-sessions'].includes(row.status)) {
      throw new Error(`invalid social site outcome row at siteOutcomeSnapshots[${index}]`);
    }
    const snapshotMs = Date.parse(`${row.date}T12:00:00.000Z`);
    if (snapshotMs > nowMs) throw new Error(`social site outcome date is in the future at siteOutcomeSnapshots[${index}]`);
    if (row.status === 'available') {
      if (row.sessions < 1 || !Number.isFinite(row.sessionKeyEventRate)
        || row.sessionKeyEventRate < 0 || row.sessionKeyEventRate > 1
        || row.source !== 'ga4-session-key-event-rate') {
        throw new Error(`invalid social site outcome rate at siteOutcomeSnapshots[${index}]`);
      }
    } else if (row.sessions !== 0 || row.sessionKeyEventRate !== null
      || row.source !== 'ga4-complete-report-no-session-row') {
      throw new Error(`invalid zero-session social site outcome at siteOutcomeSnapshots[${index}]`);
    }
    const key = `${row.channel}\u0000${row.eventName}\u0000${row.date}`;
    if (seen.has(key)) throw new Error(`duplicate social site outcome row at siteOutcomeSnapshots[${index}]`);
    seen.add(key);
  }
}

function validateFollowerGainSnapshots(rows, nowMs) {
  if (rows === undefined) return;
  if (!Array.isArray(rows) || rows.length > 130) throw new Error('invalid social follower-gain snapshot collection');
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (!hasExactKeys(row, ['channel', 'metric', 'date', 'value', 'snapshotAt', 'status', 'source'])
      || row.channel !== 'linkedin-member' || row.metric !== 'followers-gained'
      || !validDateOnly(row.date) || !validTimestamp(row.snapshotAt)
      || row.status !== 'available' || row.source !== 'linkedin-member-follower-gains'
      || !Number.isSafeInteger(row.value) || row.value < 0) {
      throw new Error(`invalid LinkedIn follower-gain row at followerGainSnapshots[${index}]`);
    }
    const snapshotMs = Date.parse(row.snapshotAt);
    if (snapshotMs > nowMs || row.snapshotAt !== `${row.date}T12:00:00.000Z`) {
      throw new Error(`LinkedIn follower-gain snapshot timestamp is invalid at followerGainSnapshots[${index}]`);
    }
    if (seen.has(row.date)) throw new Error(`duplicate LinkedIn follower-gain snapshot at followerGainSnapshots[${index}]`);
    seen.add(row.date);
  }
}

function validateSocialSiteOutcomeBaselines(baselines, nowMs) {
  if (baselines === undefined) return;
  if (!Array.isArray(baselines) || baselines.length > SOCIAL_GA4_CHANNELS.length * SOCIAL_GA4_ACTION_EVENT_NAMES.length) {
    throw new Error('invalid social site outcome baselines');
  }
  const seen = new Set();
  for (const [index, baseline] of baselines.entries()) {
    if (!hasExactKeys(baseline, [
      'schemaVersion', 'channel', 'eventName', 'eventContractVersion', 'metric',
      'startDate', 'endDate', 'timeZone', 'sessions', 'sessionKeyEventRate',
      'coverageDays', 'observations', 'frozenAt',
    ]) || baseline.schemaVersion !== 1 || !SOCIAL_GA4_CHANNELS.includes(baseline.channel)
      || !SOCIAL_GA4_ACTION_EVENT_NAMES.includes(baseline.eventName) || baseline.eventContractVersion !== SOCIAL_GA4_EVENT_CONTRACT_VERSION
      || baseline.metric !== 'session-key-event-rate' || !validDateOnly(baseline.startDate)
      || !validDateOnly(baseline.endDate) || !validTimeZone(baseline.timeZone)
      || !Number.isSafeInteger(baseline.sessions) || baseline.sessions < SOCIAL_GA4_SITE_OUTCOME_MINIMUM_SESSIONS
      || !Number.isFinite(baseline.sessionKeyEventRate) || baseline.sessionKeyEventRate < 0 || baseline.sessionKeyEventRate > 1
      || !Number.isSafeInteger(baseline.coverageDays) || baseline.coverageDays < SOCIAL_GA4_SITE_OUTCOME_MINIMUM_DAYS
      || !Number.isSafeInteger(baseline.observations) || baseline.observations < baseline.coverageDays
      || !validTimestamp(baseline.frozenAt)) {
      throw new Error(`invalid frozen social site outcome baseline at siteOutcomeBaselines[${index}]`);
    }
    const startMs = Date.parse(`${baseline.startDate}T12:00:00.000Z`);
    const endMs = Date.parse(`${baseline.endDate}T12:00:00.000Z`);
    const frozenMs = Date.parse(baseline.frozenAt);
    if (startMs > endMs || endMs > frozenMs || frozenMs > nowMs
      || Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) < SOCIAL_GA4_SITE_OUTCOME_MINIMUM_DAYS) {
      throw new Error(`social site outcome baseline timestamps are out of range at siteOutcomeBaselines[${index}]`);
    }
    const key = `${baseline.channel}\u0000${baseline.eventName}`;
    if (seen.has(key)) throw new Error(`duplicate social site outcome baseline at siteOutcomeBaselines[${index}]`);
    seen.add(key);
  }
}

function validateWeeklyHealth(weeklyHealth, nowMs) {
  if (weeklyHealth === undefined) return;
  if (!record(weeklyHealth) || weeklyHealth.schemaVersion !== 1
    || !/^\d{4}-\d{2}-\d{2}$/u.test(String(weeklyHealth.weekStart || ''))
    || !validTimestamp(weeklyHealth.generatedAt)
    || !Array.isArray(weeklyHealth.signals) || weeklyHealth.signals.length > HEALTH_SIGNAL_SOURCES.size) {
    throw new Error('invalid weekly social health snapshot');
  }
  const generatedMs = Date.parse(weeklyHealth.generatedAt);
  const weekStartMs = Date.parse(`${weeklyHealth.weekStart}T00:00:00.000Z`);
  if (!Number.isFinite(weekStartMs)
    || new Date(weekStartMs).toISOString().slice(0, 10) !== weeklyHealth.weekStart
    || generatedMs < weekStartMs || generatedMs >= weekStartMs + 7 * 24 * 60 * 60 * 1000
    || generatedMs > nowMs) {
    throw new Error('weekly social health snapshot timestamp is out of range');
  }
  const seen = new Set();
  for (const [index, signal] of weeklyHealth.signals.entries()) {
    if (!record(signal) || !HEALTH_SIGNAL_SOURCES.has(signal.source)
      || !['stale', 'partial', 'no-successful-collection'].includes(signal.status)
      || !validTimestamp(signal.firstSeenAt) || !validTimestamp(signal.lastSeenAt)
      || !Number.isSafeInteger(signal.occurrenceWeeks) || signal.occurrenceWeeks < 1 || signal.occurrenceWeeks > 52) {
      throw new Error(`invalid weekly social health signal at signals[${index}]`);
    }
    const key = `${signal.source}\u0000${signal.status}`;
    const firstMs = Date.parse(signal.firstSeenAt);
    const lastMs = Date.parse(signal.lastSeenAt);
    if (seen.has(key) || firstMs > lastMs || lastMs > generatedMs) {
      throw new Error(`weekly social health signal timestamps or identity are invalid at signals[${index}]`);
    }
    seen.add(key);
  }
}

function validateSocialRobotDelivery(snapshot, nowMs) {
  if (snapshot === undefined) return;
  if (!hasExactKeys(snapshot, [
    'schemaVersion', 'startedAt', 'recordedAt', 'expectedIntervalHours', 'staleAfterHours',
    'coverage', 'mode', 'dryRun', 'channels',
  ]) || snapshot.schemaVersion !== 1
    || !validTimestamp(snapshot.startedAt) || !validTimestamp(snapshot.recordedAt)
    || !['off', 'dry', 'live'].includes(snapshot.mode) || typeof snapshot.dryRun !== 'boolean'
    || !['complete', 'partial'].includes(snapshot.coverage)
    || snapshot.expectedIntervalHours !== 12 || snapshot.staleAfterHours !== 36
    || !Array.isArray(snapshot.channels) || snapshot.channels.length > ROBOT_DELIVERY_CHANNELS.size) {
    throw new Error('invalid social robot delivery snapshot');
  }
  const startedMs = Date.parse(snapshot.startedAt);
  const recordedMs = Date.parse(snapshot.recordedAt);
  if (startedMs > recordedMs || recordedMs > nowMs) {
    throw new Error('social robot delivery timestamps are out of range');
  }
  const seen = new Set();
  for (const [index, channel] of snapshot.channels.entries()) {
    if (!hasExactKeys(channel, [
      'channel', 'state', 'outcome', 'publishedCount', 'confirmationDispatchFailureCount',
      'queueStatus', 'pendingCount', 'expiredPendingCount', 'unmeasuredPendingCount',
      'oldestPendingAgeHours', 'oldestPendingKind', 'oldestPendingTtlHours',
    ]) || !ROBOT_DELIVERY_CHANNELS.has(channel.channel)
      || !ROBOT_DELIVERY_STATES.has(channel.state)
      || !ROBOT_DELIVERY_OUTCOMES.has(channel.outcome)
      || !['available', 'unavailable', 'invalid'].includes(channel.queueStatus)
      || !validCounter(channel.publishedCount) || !validCounter(channel.confirmationDispatchFailureCount)
      || seen.has(channel.channel)) {
      throw new Error(`invalid social robot delivery channel at channels[${index}]`);
    }
    seen.add(channel.channel);
    const queueCounts = ['pendingCount', 'expiredPendingCount', 'unmeasuredPendingCount'];
    const queueMeasurements = ['oldestPendingAgeHours', 'oldestPendingTtlHours'];
    if (channel.queueStatus === 'available') {
      if (queueCounts.some((field) => !validCounter(channel[field]))) {
        throw new Error(`invalid social robot queue counts at channels[${index}]`);
      }
      if (channel.oldestPendingAgeHours !== null
        && (!Number.isFinite(channel.oldestPendingAgeHours) || channel.oldestPendingAgeHours < 0)) {
        throw new Error(`invalid social robot queue age at channels[${index}]`);
      }
      if (channel.oldestPendingTtlHours !== null
        && (!Number.isSafeInteger(channel.oldestPendingTtlHours) || channel.oldestPendingTtlHours < 1)) {
        throw new Error(`invalid social robot queue TTL at channels[${index}]`);
      }
      if (channel.oldestPendingKind !== null
        && (typeof channel.oldestPendingKind !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/u.test(channel.oldestPendingKind))) {
        throw new Error(`invalid social robot queue kind at channels[${index}]`);
      }
    } else if (queueCounts.some((field) => channel[field] !== null)
      || queueMeasurements.some((field) => channel[field] !== null)
      || channel.oldestPendingKind !== null) {
      throw new Error(`unavailable social robot queue has measurements at channels[${index}]`);
    }
  }
  if ((snapshot.coverage === 'complete') !== (seen.size === ROBOT_DELIVERY_CHANNELS.size)) {
    throw new Error('social robot delivery coverage does not match its channel set');
  }
}

function validateInstagramStoryRows(document, nowMs) {
  const publications = document.instagramStoryPublications ?? [];
  const snapshots = document.instagramStorySnapshots ?? [];
  if (!Array.isArray(publications) || publications.length > INSTAGRAM_STORY_MAX_ROWS) {
    throw new Error('invalid Instagram Story publication collection');
  }
  if (!Array.isArray(snapshots) || snapshots.length > INSTAGRAM_STORY_MAX_ROWS) {
    throw new Error('invalid Instagram Story snapshot collection');
  }
  const publicationById = new Map();
  for (const [index, row] of publications.entries()) {
    if (!hasExactKeys(row, [
      'storyId', 'publishedAt', 'sourceMediaId', 'followUpFormat', 'copyPackId',
      'copyTemplateId', 'copyAngleId', 'copyPillarId', 'copyRevisionId',
    ]) || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(String(row.storyId || ''))
      || !validTimestamp(row.publishedAt)
      || row.sourceMediaId !== null && !/^[A-Za-z0-9_.:-]{1,128}$/u.test(String(row.sourceMediaId || ''))
      || row.followUpFormat !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(String(row.followUpFormat || ''))
      || row.copyPackId !== null && !/^[a-f0-9]{16}$/u.test(String(row.copyPackId || ''))
      || row.copyTemplateId !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(String(row.copyTemplateId || ''))
      || row.copyAngleId !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(String(row.copyAngleId || ''))
      || row.copyPillarId !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(String(row.copyPillarId || ''))
      || row.copyRevisionId !== null && !/^[a-f0-9]{16}$/u.test(String(row.copyRevisionId || ''))) {
      throw new Error(`invalid Instagram Story publication at instagramStoryPublications[${index}]`);
    }
    const publishedMs = Date.parse(row.publishedAt);
    if (publishedMs > nowMs) throw new Error(`Instagram Story publication is in the future at instagramStoryPublications[${index}]`);
    if (publicationById.has(row.storyId)) throw new Error(`duplicate Instagram Story publication at instagramStoryPublications[${index}]`);
    publicationById.set(row.storyId, row);
  }
  const seen = new Set();
  for (const [index, row] of snapshots.entries()) {
    if (!hasExactKeys(row, [
      'storyId', 'publishedAt', 'snapshotAt', 'snapshotAgeHours', 'measurementWindow',
      'metrics', 'availableMetrics', 'metricStatus', 'sourceMediaId', 'followUpFormat',
      'copyPackId', 'copyTemplateId', 'copyAngleId', 'copyPillarId', 'copyRevisionId',
    ]) || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(String(row.storyId || ''))
      || !validTimestamp(row.publishedAt) || !validTimestamp(row.snapshotAt)
      || !Number.isFinite(row.snapshotAgeHours) || row.snapshotAgeHours < 0 || row.snapshotAgeHours > 24
      || !INSTAGRAM_STORY_MEASUREMENT_WINDOWS.some(({ id }) => id === row.measurementWindow)
      || !hasExactKeys(row.metrics, INSTAGRAM_STORY_METRICS)
      || !Array.isArray(row.availableMetrics) || !record(row.metricStatus)
      || !hasExactKeys(row.metricStatus, INSTAGRAM_STORY_METRICS)) {
      throw new Error(`invalid Instagram Story snapshot at instagramStorySnapshots[${index}]`);
    }
    const publication = publicationById.get(row.storyId);
    if (!publication || publication.publishedAt !== row.publishedAt) {
      throw new Error(`Instagram Story snapshot has no matching publication at instagramStorySnapshots[${index}]`);
    }
    const publishedMs = Date.parse(row.publishedAt);
    const snapshotMs = Date.parse(row.snapshotAt);
    const actualAgeHours = (snapshotMs - publishedMs) / 3_600_000;
    const measurementWindow = INSTAGRAM_STORY_MEASUREMENT_WINDOWS.find(({ id }) => id === row.measurementWindow);
    if (snapshotMs > nowMs || snapshotMs < publishedMs || Math.abs(actualAgeHours - row.snapshotAgeHours) > 0.01
      || !measurementWindow || row.snapshotAgeHours < measurementWindow.minHours
      || row.snapshotAgeHours >= measurementWindow.maxHours) {
      throw new Error(`Instagram Story snapshot window is invalid at instagramStorySnapshots[${index}]`);
    }
    for (const field of [
      'sourceMediaId', 'followUpFormat', 'copyPackId', 'copyTemplateId', 'copyAngleId', 'copyPillarId', 'copyRevisionId',
    ]) {
      if (row[field] !== publication[field]) {
        throw new Error(`Instagram Story metadata mismatch for ${field} at instagramStorySnapshots[${index}]`);
      }
    }
    if (row.availableMetrics.some((name) => !INSTAGRAM_STORY_METRICS.includes(name))
      || new Set(row.availableMetrics).size !== row.availableMetrics.length) {
      throw new Error(`invalid Instagram Story metric list at instagramStorySnapshots[${index}]`);
    }
    for (const name of INSTAGRAM_STORY_METRICS) {
      const value = row.metrics[name];
      const status = row.metricStatus[name];
      const available = row.availableMetrics.includes(name);
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)
        || available !== (value !== null)
        || (available ? status !== 'available' : !['unavailable', 'metric-unavailable'].includes(status))) {
        throw new Error(`invalid Instagram Story metric ${name} at instagramStorySnapshots[${index}]`);
      }
    }
    const key = `${row.storyId}\u0000${row.measurementWindow}`;
    if (seen.has(key)) throw new Error(`duplicate Instagram Story snapshot at instagramStorySnapshots[${index}]`);
    seen.add(key);
  }
}

function isUtcMonday(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
    && date.getUTCDay() === 1;
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCommunitySurface(surface, path) {
  const countFields = [
    'observed', 'responded', 'responsesWithin24h', 'responsesAfter24h',
    'pendingWithin24h', 'unansweredAfter24h', 'timestampUnknown',
  ];
  if (!hasExactKeys(surface, [...countFields, 'latencyBuckets', 'escalations'])
    || countFields.some((field) => !validCounter(surface[field]))
    || !hasExactKeys(surface.latencyBuckets, COMMUNITY_LATENCY_BUCKETS)
    || COMMUNITY_LATENCY_BUCKETS.some((field) => !validCounter(surface.latencyBuckets[field]))
    || !hasExactKeys(surface.escalations, COMMUNITY_ESCALATIONS)
    || COMMUNITY_ESCALATIONS.some((field) => !validCounter(surface.escalations[field]))) {
    throw new Error(`invalid Instagram community outcome counters at ${path}`);
  }
  const latencyCount = COMMUNITY_LATENCY_BUCKETS.reduce((sum, field) => sum + surface.latencyBuckets[field], 0);
  if (surface.responded > surface.observed
    || surface.responsesWithin24h + surface.responsesAfter24h !== latencyCount
    || surface.responsesWithin24h + surface.responsesAfter24h > surface.responded
    || surface.pendingWithin24h + surface.unansweredAfter24h > surface.observed) {
    throw new Error(`inconsistent Instagram community outcome counters at ${path}`);
  }
}

function validateCommunityOutcomes(outcomes, nowMs) {
  if (outcomes === undefined) return;
  if (!hasExactKeys(outcomes, ['schemaVersion', 'generatedAt', 'latestRun', 'trackedFrom', 'trackingStartedAt', 'eventsTruncated', 'coverageGap', 'weeks'])
    || outcomes.schemaVersion !== 1
    || !validTimestamp(outcomes.generatedAt)
    || !isUtcMonday(outcomes.trackedFrom)
    || !validTimestamp(outcomes.trackingStartedAt)
    || outcomes.eventsTruncated !== true && outcomes.eventsTruncated !== false
    || outcomes.coverageGap !== true && outcomes.coverageGap !== false
    || !hasExactKeys(outcomes.latestRun, ['source', 'status', 'coverage'])
    || !COMMUNITY_SOURCES.has(outcomes.latestRun.source)
    || typeof outcomes.latestRun.status !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(outcomes.latestRun.status)
    || !COMMUNITY_COVERAGE.has(outcomes.latestRun.coverage)
    || !Array.isArray(outcomes.weeks) || outcomes.weeks.length > 26) {
    throw new Error('invalid Instagram community outcome history');
  }
  if (Date.parse(outcomes.generatedAt) > nowMs || Date.parse(outcomes.trackingStartedAt) > nowMs) {
    throw new Error('Instagram community outcome timestamp is in the future');
  }
  const seen = new Set();
  let priorWeek = '';
  for (const [index, week] of outcomes.weeks.entries()) {
    if (!hasExactKeys(week, ['weekStart', 'generatedAt', 'sources', 'bySurface'])
      || !isUtcMonday(week.weekStart) || !validTimestamp(week.generatedAt)
      || Date.parse(week.weekStart) > nowMs || Date.parse(week.generatedAt) > nowMs || !Array.isArray(week.sources)
      || week.sources.some((source) => !COMMUNITY_SOURCES.has(source))
      || new Set(week.sources).size !== week.sources.length || !record(week.bySurface)) {
      throw new Error(`invalid Instagram community outcome week at weeks[${index}]`);
    }
    if (seen.has(week.weekStart) || (priorWeek && week.weekStart <= priorWeek)) {
      throw new Error(`duplicate or unordered Instagram community outcome week at weeks[${index}]`);
    }
    if (!hasExactKeys(week.bySurface, COMMUNITY_SURFACES)) {
      throw new Error(`invalid Instagram community outcome surfaces at weeks[${index}]`);
    }
    for (const surface of COMMUNITY_SURFACES) validateCommunitySurface(week.bySurface[surface], `weeks[${index}].${surface}`);
    seen.add(week.weekStart);
    priorWeek = week.weekStart;
  }
}

/** Validate the persisted, aggregated native metric ledger before it is written. */
export function validateSocialNativeInsightsDocument(document, { asOf = new Date() } = {}) {
  if (!record(document) || document.schemaVersion !== 1 || !Array.isArray(document.posts) || !record(document.sources)) {
    throw new Error('social insights document must use schemaVersion 1 with sources and posts');
  }
  rejectSecrets(document);
  const nowMs = new Date(asOf).getTime();
  for (const [source, state] of Object.entries(document.sources)) {
    if (!SOURCE_NAMES.has(source) || !record(state) || typeof state.status !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(state.status)) {
      throw new Error(`invalid social insights source status: ${source}`);
    }
    if (source === 'socialSiteOutcomes' && state.registeredEventNames !== undefined
      && (!Array.isArray(state.registeredEventNames)
        || state.registeredEventNames.some((name) => !SOCIAL_GA4_ACTION_EVENT_NAMES.includes(name))
        || new Set(state.registeredEventNames).size !== state.registeredEventNames.length)) {
      throw new Error('invalid registered GA4 social event list');
    }
    if (source === 'socialSiteOutcomes') {
      if (state.timeZone !== undefined && !validTimeZone(state.timeZone)) {
        throw new Error('invalid GA4 social outcome time zone');
      }
      for (const field of ['latestDataStartDate', 'latestDataEndDate']) {
        if (state[field] !== undefined && !validDateOnly(state[field])) {
          throw new Error(`invalid GA4 social outcome date: ${field}`);
        }
      }
      if ((state.latestDataStartDate === undefined) !== (state.latestDataEndDate === undefined)
        || state.latestDataEndDate !== undefined && state.timeZone === undefined) {
        throw new Error('incomplete GA4 social outcome date range metadata');
      }
      if (state.latestDataStartDate !== undefined && state.latestDataEndDate !== undefined) {
        const startMs = Date.parse(`${state.latestDataStartDate}T12:00:00.000Z`);
        const endMs = Date.parse(`${state.latestDataEndDate}T12:00:00.000Z`);
        if (startMs > endMs
          || Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) !== SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS - 1) {
          throw new Error('invalid GA4 social outcome date range');
        }
      }
    }
    for (const timestampField of ['lastAttemptAt', 'lastCheckedAt', 'lastSuccessAt', 'latestSnapshotAt']) {
      if (state[timestampField] !== undefined) {
        const timestampMs = Date.parse(String(state[timestampField]));
        if (!Number.isFinite(timestampMs) || timestampMs > nowMs) {
          throw new Error(`invalid social insights source timestamp: ${source}.${timestampField}`);
        }
      }
    }
  }

  validateAudienceBaselines(document.audienceBaselines, nowMs);
  validateAudienceGrowthCycles(document.audienceGrowthCycles, nowMs);
  validateFollowerGainSnapshots(document.followerGainSnapshots, nowMs);
  validateSocialSiteOutcomeSnapshots(document.siteOutcomeSnapshots, nowMs);
  validateSocialSiteOutcomeBaselines(document.siteOutcomeBaselines, nowMs);
  validateWeeklyHealth(document.weeklyHealth, nowMs);
  validateCommunityOutcomes(document.communityOutcomes, nowMs);
  validateSocialRobotDelivery(document.robotDelivery, nowMs);
  validateInstagramStoryRows(document, nowMs);
  const audienceRows = document.audienceSnapshots === undefined ? [] : document.audienceSnapshots;
  if (!Array.isArray(audienceRows)) throw new Error('social audience snapshots must be an array');
  const audienceSeen = new Set();
  for (const [index, snapshot] of audienceRows.entries()) {
    const allowedMetrics = AUDIENCE_METRICS[snapshot?.channel];
    if (!record(snapshot) || !allowedMetrics?.has(snapshot.metric)
      || snapshot.status !== 'available' || typeof snapshot.source !== 'string'
      || !/^[a-z0-9-]{1,80}$/u.test(snapshot.source)
      || !Number.isSafeInteger(snapshot.value) || snapshot.value < 0
      || !validTimestamp(snapshot.snapshotAt)) {
      throw new Error(`invalid social audience snapshot at audienceSnapshots[${index}]`);
    }
    const snapshotMs = Date.parse(snapshot.snapshotAt);
    if (snapshotMs > nowMs) throw new Error(`social audience snapshot is in the future at audienceSnapshots[${index}]`);
    const day = new Date(snapshotMs).toISOString().slice(0, 10);
    const key = `${snapshot.channel}\u0000${snapshot.metric}\u0000${day}`;
    if (audienceSeen.has(key)) throw new Error(`duplicate social audience snapshot at audienceSnapshots[${index}]`);
    audienceSeen.add(key);
  }

  const seen = new Set();
  for (const [index, post] of document.posts.entries()) {
    if (!record(post) || !CHANNELS.has(post.channel) || !String(post.postId || '').trim()) {
      throw new Error(`invalid social insight post identity at posts[${index}]`);
    }
    if (!validTimestamp(post.publishedAt) || !validTimestamp(post.snapshotAt)) {
      throw new Error(`invalid social insight timestamp at posts[${index}]`);
    }
    const publishedMs = Date.parse(post.publishedAt);
    const snapshotMs = Date.parse(post.snapshotAt);
    if (publishedMs > nowMs || snapshotMs > nowMs || snapshotMs < publishedMs) {
      throw new Error(`social insight timestamps are out of range at posts[${index}]`);
    }
    if (!record(post.metrics) || !Array.isArray(post.availableMetrics) || !record(post.metricStatus)) {
      throw new Error(`social insight metrics are malformed at posts[${index}]`);
    }
    if (post.copyAttributionStatus !== undefined
      && !['exact', 'inferred'].includes(post.copyAttributionStatus)) {
      throw new Error(`invalid copy attribution status at posts[${index}]`);
    }
    if (post.copyRevisionId !== undefined && !/^[a-f0-9]{16}$/u.test(String(post.copyRevisionId || ''))) {
      throw new Error(`invalid exact-copy revision fingerprint at posts[${index}]`);
    }
    const copyMetadata = record(post.copy) ? post.copy : post;
    const copyBlockId = String(copyMetadata.copyBlockId || '').trim();
    const copyBlockCycle = copyMetadata.copyBlockCycle;
    const copyRegistrationHash = String(copyMetadata.copyRegistrationHash || '').trim();
    if ((copyBlockId || copyBlockCycle !== undefined || copyRegistrationHash)
      && (!/^[a-f0-9]{64}$/u.test(copyBlockId)
        || !Number.isSafeInteger(copyBlockCycle) || copyBlockCycle < 0
        || (copyRegistrationHash && !/^[a-f0-9]{64}$/u.test(copyRegistrationHash)))) {
      throw new Error(`invalid social copy experiment block metadata at posts[${index}]`);
    }
    const copyAngleId = String(copyMetadata.copyAngleId || '').trim();
    const copyPillarId = String(copyMetadata.copyPillarId || '').trim();
    const copyAngleIntent = String(copyMetadata.copyAngleIntent || '').trim();
    if ((copyAngleId || copyPillarId || copyAngleIntent)
      && (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(copyAngleId)
        || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(copyPillarId)
        || !COPY_ANGLE_INTENTS.has(copyAngleIntent))) {
      throw new Error(`invalid editorial angle metadata at posts[${index}]`);
    }
    const key = `${post.channel}\u0000${post.postId}\u0000${post.windowHours || post.windowDays || 'unknown'}`;
    if (seen.has(key)) throw new Error(`duplicate social insight snapshot at posts[${index}]`);
    seen.add(key);

    for (const [name, metric] of Object.entries(post.metrics)) {
      if (post.channel === 'facebook' && !FACEBOOK_METRICS.has(name)) {
        throw new Error(`invalid Facebook insight metric ${name} at posts[${index}]`);
      }
      const validMetric = metric === null || (
        Number.isFinite(metric)
        && metric >= 0
        && (post.channel === 'instagram' && DECIMAL_INSTAGRAM_METRICS.has(name) || Number.isSafeInteger(metric))
      );
      if (!validMetric) {
        throw new Error(`invalid social insight metric ${name} at posts[${index}]`);
      }
      const declaredAvailable = post.availableMetrics.includes(name);
      const declaredStatus = post.metricStatus[name];
      if (declaredAvailable !== (metric !== null)
        || (metric === null ? !['unavailable', 'metric-unavailable'].includes(declaredStatus) : declaredStatus !== 'available')) {
        throw new Error(`social insight metric availability disagrees for ${name} at posts[${index}]`);
      }
    }
    if (post.channel === 'tiktok' && (post.windowHours !== 72 || !Number.isFinite(post.snapshotAgeHours)
      || Math.abs(post.snapshotAgeHours - 72) > 6)) {
      throw new Error(`TikTok snapshot is outside the fixed 72-hour window at posts[${index}]`);
    }
    if (post.channel === 'facebook' && (post.windowHours !== 72 || !Number.isFinite(post.snapshotAgeHours)
      || Math.abs(post.snapshotAgeHours - 72) > 6
      || post.measurementWindow !== 'first-72h-after-facebook-created-time'
      || post.publicationTimeBasis !== 'facebook-created-time')) {
      throw new Error(`Facebook snapshot is outside the fixed 72-hour window at posts[${index}]`);
    }
    if (post.channel === 'instagram' && (!Number.isSafeInteger(post.windowHours)
      || post.windowHours < 1 || post.windowHours > 168
      || !Number.isFinite(post.snapshotAgeHours) || post.snapshotAgeHours < 0)) {
      throw new Error(`Instagram snapshot has an unsupported measurement window at posts[${index}]`);
    }
    if (post.channel === 'linkedin-member' && (post.windowDays !== 7
      || post.measurementWindow !== 'first-seven-utc-calendar-days')) {
      throw new Error(`LinkedIn snapshot has an unsupported measurement window at posts[${index}]`);
    }
  }
  return document;
}
