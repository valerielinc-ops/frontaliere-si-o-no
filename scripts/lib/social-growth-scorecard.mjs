import {
  SOCIAL_GA4_ACTION_EVENTS,
  SOCIAL_GA4_ACTION_EVENT_NAMES,
  isSocialGa4SessionKeyEventRateEligible,
  SOCIAL_GA4_CHANNELS,
  SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS,
  SOCIAL_GA4_EVENT_CONTRACT_VERSION,
  SOCIAL_GA4_SITE_OUTCOME_MINIMUM_DAYS,
  SOCIAL_GA4_SITE_OUTCOME_MINIMUM_SESSIONS,
  SOCIAL_GA4_SITE_OUTCOME_MAX_AGE_HOURS,
} from './social-ga4-contract.mjs';
import { summarizeSocialRobotDelivery } from './social-robot-delivery-health.mjs';

export const SOCIAL_GROWTH_MINIMUM_POSTS = 3;
export const SOCIAL_GROWTH_BASELINE_DAYS = SOCIAL_GA4_ATTRIBUTION_WINDOW_DAYS;
export const SOCIAL_AUDIENCE_MINIMUM_DAYS = 25;
export const SOCIAL_AUDIENCE_MAX_AGE_HOURS = 48;
export const SOCIAL_SITE_OUTCOME_MINIMUM_DAYS = SOCIAL_GA4_SITE_OUTCOME_MINIMUM_DAYS;
export const SOCIAL_SITE_OUTCOME_MINIMUM_SESSIONS = SOCIAL_GA4_SITE_OUTCOME_MINIMUM_SESSIONS;
export const SOCIAL_SITE_OUTCOME_MAX_AGE_HOURS = SOCIAL_GA4_SITE_OUTCOME_MAX_AGE_HOURS;
export const SOCIAL_GROWTH_TARGET_POLICY_VERSION = 2;
export const SOCIAL_GROWTH_TARGET_HORIZON_DAYS = 90;
export const SOCIAL_BUSINESS_OUTCOME_TARGET_RELATIVE_LIFT = 0.25;
export const SOCIAL_BUSINESS_OUTCOME_TARGET_RATE_RETENTION = 0.9;
export const SOCIAL_CHANNEL_PILOT_CONTRACT_VERSION = 4;

const CHANNEL_PILOT_CONTRACTS = Object.freeze({
  instagram: Object.freeze({
    deliveryPath: 'existing Graph API and Mac-host robot/queue',
    cadenceCap: 'shared atomic cap: feed/Reels 2/day, Stories 6/day across Graph API, Reels, and robot; normal schedule keeps the existing slots; no automated cadence increase',
    dailyCap: 2,
    trackedCapGroup: 'feed',
    audienceKey: 'instagram',
    ledgerKey: 'instagram',
    nativeChannel: 'instagram',
    measurementWindow: { hours: 72, label: '72h' },
    stopCriteria: Object.freeze(['policy-or-scope-change', 'source-stale-for-two-intervals', 'exact-post-id-coverage-incomplete', 'confirmed-duplicate-or-reservation-leak', 'existing-publisher-cap-exceeded']),
  }),
  tiktok: Object.freeze({
    deliveryPath: 'held pending eligible creator-facing use case',
    cadenceCap: 'no-publishing-route-while-policy-held',
    audienceKey: 'tiktok',
    ledgerKey: 'tiktok',
    nativeChannel: 'tiktok',
    measurementWindow: { hours: 72, label: '72h' },
    stopCriteria: Object.freeze(['policy-review-required', 'scope-change', 'exact-post-id-coverage-incomplete', 'source-stale-for-two-intervals']),
  }),
  facebook: Object.freeze({
    deliveryPath: 'existing Graph API schedulers',
    cadenceCap: 'shared atomic Page cap 144/day across scheduled jobs, articles, events, and manual posts; configured job schedules and batch limits remain unchanged',
    dailyCap: 144,
    trackedCapGroup: 'feed',
    audienceKey: 'facebook',
    ledgerKey: 'facebook',
    nativeChannel: 'facebook',
    measurementWindow: { hours: 72, label: '72h; snapshot age within ±6h; Page Insights requires ≥100 Page likes' },
    stopCriteria: Object.freeze(['policy-or-scope-change', 'source-stale-for-two-intervals', 'existing-publisher-cap-exceeded']),
  }),
  linkedinMember: Object.freeze({
    deliveryPath: 'existing LinkedIn member publisher',
    cadenceCap: 'shared atomic member cap 2/day across one article and one job slot; no cadence increase',
    dailyCap: 2,
    trackedCapGroup: 'feed',
    audienceKey: 'linkedinMember',
    ledgerKey: 'linkedinMember',
    nativeChannel: 'linkedin-member',
    measurementWindow: { days: 7, label: 'first seven UTC calendar days' },
    stopCriteria: Object.freeze(['policy-or-scope-change', 'source-stale-for-two-intervals', 'exact-post-id-coverage-incomplete', 'existing-publisher-cap-exceeded']),
  }),
  telegram: Object.freeze({
    deliveryPath: 'existing Telegram Bot API publisher',
    cadenceCap: 'daily jobs digest; weekly border ranking; no increase',
    dailyCap: 2,
    trackedCapGroup: 'feed',
    audienceKey: 'telegram',
    ledgerKey: 'telegram',
    nativeChannel: null,
    measurementWindow: { hours: null, label: 'Bot API has no verified per-post analytics contract' },
    stopCriteria: Object.freeze(['policy-or-scope-change', 'source-stale-for-two-intervals', 'existing-publisher-cap-exceeded']),
  }),
  reddit: Object.freeze({
    deliveryPath: 'held pending Devvit review and domain access',
    cadenceCap: 'no-publishing-route-while-review-blocked',
    audienceKey: 'reddit',
    nativeChannel: 'reddit',
    measurementWindow: { hours: null, label: 'no approved delivery/analytics contract' },
    stopCriteria: Object.freeze(['review-or-domain-grant-missing', 'policy-change', 'exact-post-id-contract-unavailable']),
  }),
  youtubeShorts: Object.freeze({
    deliveryPath: 'candidate; no account or OAuth configured',
    cadenceCap: 'no-publishing-route-before-account-probe',
    audienceKey: 'youtubeShorts',
    nativeChannel: 'youtube-shorts',
    measurementWindow: { hours: null, label: 'not probed' },
    stopCriteria: Object.freeze(['account-or-scope-missing', 'metric-definition-changed', 'exact-post-id-coverage-incomplete']),
  }),
  threads: Object.freeze({
    deliveryPath: 'candidate; no account or OAuth configured',
    cadenceCap: 'no-publishing-route-before-account-probe',
    audienceKey: 'threads',
    nativeChannel: 'threads',
    measurementWindow: { hours: null, label: 'not probed' },
    stopCriteria: Object.freeze(['account-or-scope-missing', 'metric-contract-changed', 'exact-post-id-coverage-incomplete']),
  }),
  linkedinCompanyPage: Object.freeze({
    deliveryPath: 'held pending organization-social permission',
    cadenceCap: 'no-publishing-route-before-organization-grant',
    audienceKey: 'linkedinCompanyPage',
    nativeChannel: 'linkedin-company-page',
    measurementWindow: { hours: null, label: 'not authorized or probed' },
    stopCriteria: Object.freeze(['organization-social-grant-missing', 'account-or-scope-missing', 'exact-post-id-coverage-incomplete']),
  }),
  x: Object.freeze({
    deliveryPath: 'candidate; no account or OAuth configured',
    cadenceCap: 'no-publishing-route-before-account-probe',
    audienceKey: 'x',
    nativeChannel: 'x',
    measurementWindow: { hours: null, label: 'not probed' },
    stopCriteria: Object.freeze(['account-or-scope-missing', 'metric-contract-changed', 'exact-post-id-coverage-incomplete']),
  }),
  whatsappChannels: Object.freeze({
    deliveryPath: 'candidate; no account or API use case configured',
    cadenceCap: 'no-publishing-route-before-account-and-api-probe',
    audienceKey: 'whatsappChannels',
    nativeChannel: 'whatsapp-channels',
    measurementWindow: { hours: null, label: 'not probed' },
    stopCriteria: Object.freeze(['account-or-supported-api-missing', 'metric-contract-changed', 'exact-post-id-coverage-incomplete']),
  }),
});

const AUDIENCE_SOURCE_BY_CHANNEL = Object.freeze({
  instagram: { metric: 'followers', source: 'instagramAudience' },
  tiktok: { metric: 'followers', source: 'tiktokAudience' },
  facebook: { metric: 'followers', source: 'facebookAudience' },
  'linkedin-member': { metric: 'followers', source: 'linkedinAudience' },
  telegram: { metric: 'members', source: 'telegramAudience' },
  'youtube-shorts': { metric: 'subscribers', source: 'youtubeShortsAudience' },
  threads: { metric: 'followers', source: 'threadsAudience' },
  reddit: { metric: 'followers', source: 'redditAudience' },
});
const AUDIENCE_STORAGE_CHANNEL_BY_SCORECARD_KEY = Object.freeze({
  linkedinMember: 'linkedin-member',
  youtubeShorts: 'youtube-shorts',
});
const SOURCE_FRESHNESS_CONTRACTS = Object.freeze([
  { key: 'instagramPostInsights', source: 'instagram', channel: 'instagram', intervalHours: 24 },
  { key: 'tiktokPostInsights', source: 'tiktok', channel: 'tiktok', intervalHours: 6 },
  { key: 'facebookPostInsights', source: 'facebook', channel: 'facebook', intervalHours: 6 },
  { key: 'linkedinMemberPostInsights', source: 'linkedinMember', channel: 'linkedin-member', intervalHours: 24 },
  { key: 'instagramAudience', source: 'instagramAudience', channel: 'instagram', metric: 'followers', intervalHours: 24 },
  { key: 'tiktokAudience', source: 'tiktokAudience', channel: 'tiktok', metric: 'followers', intervalHours: 24 },
  { key: 'facebookAudience', source: 'facebookAudience', channel: 'facebook', metric: 'followers', intervalHours: 24 },
  { key: 'linkedinMemberAudience', source: 'linkedinAudience', channel: 'linkedin-member', metric: 'followers', intervalHours: 24 },
  { key: 'linkedinMemberFollowerGains', source: 'linkedinFollowerGains', channel: 'linkedin-member', followerGains: true, intervalHours: 24 },
  { key: 'telegramAudience', source: 'telegramAudience', channel: 'telegram', metric: 'members', intervalHours: 24 },
  { key: 'socialSiteOutcomes', source: 'socialSiteOutcomes', channel: 'social', siteOutcome: true, intervalHours: 168 },
  { key: 'socialRobotDelivery', source: 'socialRobotDelivery', channel: 'social', intervalHours: 12, staleAfterHours: 36, delivery: true },
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_TELEGRAM_DIGEST_CLUSTER_MS = 5_000;
const WINDOW_TOLERANCE_HOURS = 6;

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metricIsAvailable(row, name) {
  const available = row?.availableMetrics;
  if (Array.isArray(available)) return available.includes(name);
  const metricStatus = row?.metricStatus;
  if (record(metricStatus) && Object.prototype.hasOwnProperty.call(metricStatus, name)) {
    return metricStatus[name] === 'available';
  }
  const value = finite(row?.metrics?.[name] ?? row?.[name]);
  return value !== null && value !== 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dateMs(row) {
  const values = [row.publishedAt, row.ts, row.day, row.date];
  for (const value of values) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function snapshotAgeHours(row) {
  const declared = finite(row.snapshotAgeHours);
  if (declared !== null) return declared;
  const publishedAt = Date.parse(String(row.publishedAt || ''));
  const snapshotAt = Date.parse(String(row.snapshotAt || ''));
  if (!Number.isFinite(publishedAt) || !Number.isFinite(snapshotAt)) return null;
  return (snapshotAt - publishedAt) / 3_600_000;
}

function recentPosts(rows, asOfMs, days) {
  const lower = asOfMs - days * DAY_MS;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!record(row)) return false;
    const at = dateMs(row);
    if (at === null || at < lower || at > asOfMs) return false;
    const snapshotValue = String(row.snapshotAt || '').trim();
    if (snapshotValue) {
      const snapshotMs = Date.parse(snapshotValue);
      if (!Number.isFinite(snapshotMs) || snapshotMs > asOfMs) return false;
    }
    return true;
  });
}

function summarizeMetric(rows, readValue, {
  minimumPosts = SOCIAL_GROWTH_MINIMUM_POSTS,
  sourceStatus = 'available',
} = {}) {
  const values = rows.map(readValue).filter((value) => Number.isFinite(value) && value >= 0);
  const observedMedian = median(values);
  const status = values.length >= minimumPosts
    ? 'available'
    : values.length > 0 ? 'insufficient-sample'
      : sourceStatus === 'available' ? 'no-attributable-observations' : sourceStatus;
  const baselineMedian = status === 'available' ? observedMedian : null;
  return {
    status,
    observations: values.length,
    minimumPosts,
    observedMedian,
    baselineMedian,
  };
}

function denominatorForInstagram(row) {
  const source = String(row.reachSource || row.audienceMetric || '').toLowerCase();
  if (source === 'views') return finite(row.views);
  return finite(row.reach);
}

function perThousand(numerator, denominator) {
  const top = finite(numerator);
  const bottom = finite(denominator);
  return top === null || bottom === null || bottom <= 0 ? null : (top / bottom) * 1000;
}

function measurementPosts(rows, windowHours, asOfMs) {
  return recentPosts(rows, asOfMs, SOCIAL_GROWTH_BASELINE_DAYS).filter((row) => {
    if (Number(row.windowHours) !== windowHours) return false;
    const age = snapshotAgeHours(row);
    if (age === null || age < 0 || Math.abs(age - windowHours) > WINDOW_TOLERANCE_HOURS) return false;
    return true;
  });
}

function instagramScorecard(insights, asOfMs, sourceStatus, minimumPosts) {
  const posts = measurementPosts(insights?.posts, 72, asOfMs);
  const reels = posts.filter((row) => String(row.kind || row.copySlot || '').toLowerCase() === 'reel');
  const reachPosts = posts.filter((row) => String(row.reachSource || row.audienceMetric || 'reach') !== 'views'
    && denominatorForInstagram(row) > 0);
  const viewPosts = posts.filter((row) => String(row.reachSource || row.audienceMetric || '') === 'views'
    && denominatorForInstagram(row) > 0);
  const reelReachPosts = reels.filter((row) => String(row.reachSource || row.audienceMetric || 'reach') !== 'views'
    && denominatorForInstagram(row) > 0);
  const reelViewPosts = reels.filter((row) => String(row.reachSource || row.audienceMetric || '') === 'views'
    && denominatorForInstagram(row) > 0);
  const rates = (rows, field) => summarizeMetric(
    rows.filter((row) => metricIsAvailable(row, field)),
    (row) => perThousand(row[field], denominatorForInstagram(row)),
    { sourceStatus, minimumPosts },
  );
  const reelRates = (rows, field) => summarizeMetric(
    rows.filter((row) => metricIsAvailable(row, field)),
    (row) => perThousand(row.metrics?.[field] ?? row[field], denominatorForInstagram(row)),
    { sourceStatus, minimumPosts },
  );
  const reelFollows = reels.filter((row) => metricIsAvailable(row, 'follows'));
  return {
    status: sourceStatus,
    measurementWindow: '72h; snapshot age within ±6h',
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    metrics: {
      reachPerPost: summarizeMetric(reachPosts.filter((row) => metricIsAvailable(row, 'reach')), (row) => row.reach, { sourceStatus, minimumPosts }),
      viewsPerPost: summarizeMetric(viewPosts.filter((row) => metricIsAvailable(row, 'views')), (row) => row.views, { sourceStatus, minimumPosts }),
      savesPerThousandReach: rates(reachPosts, 'saves'),
      savesPerThousandViews: rates(viewPosts, 'saves'),
      sharesPerThousandReach: rates(reachPosts, 'shares'),
      sharesPerThousandViews: rates(viewPosts, 'shares'),
      profileVisitsPerThousandReach: rates(reachPosts, 'profileVisits'),
      profileVisitsPerThousandViews: rates(viewPosts, 'profileVisits'),
      linkClicksPerThousandReach: rates(reachPosts, 'linkClicks'),
      linkClicksPerThousandViews: rates(viewPosts, 'linkClicks'),
      commentsPerThousandReach: rates(reachPosts, 'comments', null),
      commentsPerThousandViews: rates(viewPosts, 'comments', null),
      reelFollowsPerPost: summarizeMetric(
        reelFollows,
        (row) => finite(row.metrics?.follows ?? row.follows),
        { sourceStatus, minimumPosts },
      ),
      reelFollowsPerThousandReach: reelRates(reelReachPosts, 'follows'),
      reelFollowsPerThousandViews: reelRates(reelViewPosts, 'follows'),
    },
    denominatorSources: [...new Set([...reachPosts.map(() => 'reach'), ...viewPosts.map(() => 'views')])].sort(),
  };
}

function tiktokScorecard(nativePosts, asOfMs, sourceStatus, minimumPosts) {
  const posts = sourceStatus === 'policy-review-required'
    ? []
    : measurementPosts(nativePosts, 72, asOfMs);
  const available = posts.filter((row) => metricIsAvailable(row, 'views'));
  return {
    status: sourceStatus,
    measurementWindow: '72h; snapshot age within ±6h',
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    metrics: {
      viewsPerPost: summarizeMetric(available, (row) => row.metrics?.views, { sourceStatus, minimumPosts }),
      interactionsPerThousandViews: summarizeMetric(available.filter((row) => ['likes', 'comments', 'shares'].every((name) => metricIsAvailable(row, name))),
        (row) => perThousand(
          ['likes', 'comments', 'shares'].reduce((sum, name) => sum + finite(row.metrics?.[name]), 0),
          row.metrics?.views,
        ), { sourceStatus, minimumPosts }),
    },
  };
}

function facebookScorecard(nativePosts, asOfMs, sourceStatus, minimumPosts) {
  const posts = measurementPosts(nativePosts.filter((row) => row.channel === 'facebook'), 72, asOfMs);
  const views = posts.filter((row) => metricIsAvailable(row, 'mediaViews'));
  const viewers = posts.filter((row) => metricIsAvailable(row, 'uniqueViewers')
    && finite(row.metrics?.uniqueViewers) > 0);
  return {
    status: sourceStatus,
    measurementWindow: '72h; snapshot age within ±6h; Page Insights requires ≥100 Page likes',
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    metrics: {
      mediaViewsPerPost: summarizeMetric(views, (row) => row.metrics?.mediaViews, { sourceStatus, minimumPosts }),
      uniqueViewersPerPost: summarizeMetric(viewers, (row) => row.metrics?.uniqueViewers, { sourceStatus, minimumPosts }),
      reactionsPerThousandUniqueViewers: summarizeMetric(
        viewers.filter((row) => metricIsAvailable(row, 'reactions')),
        (row) => perThousand(row.metrics?.reactions, row.metrics?.uniqueViewers),
        { sourceStatus, minimumPosts },
      ),
      clicksPerThousandUniqueViewers: summarizeMetric(
        viewers.filter((row) => metricIsAvailable(row, 'clicks')),
        (row) => perThousand(row.metrics?.clicks, row.metrics?.uniqueViewers),
        { sourceStatus, minimumPosts },
      ),
    },
  };
}

function linkedinScorecard(nativePosts, asOfMs, sourceStatus, minimumPosts) {
  const posts = recentPosts(nativePosts, asOfMs, SOCIAL_GROWTH_BASELINE_DAYS)
    .filter((row) => row.channel === 'linkedin-member' && row.measurementWindow === 'first-seven-utc-calendar-days');
  const impressions = posts.filter((row) => metricIsAvailable(row, 'impression'));
  const clicks = posts.filter((row) => metricIsAvailable(row, 'link_clicks') && metricIsAvailable(row, 'impression'));
  const followers = posts.filter((row) => metricIsAvailable(row, 'follower_gained_from_content'));
  return {
    status: sourceStatus,
    measurementWindow: 'first seven UTC calendar days',
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    metrics: {
      impressionsPerPost: summarizeMetric(impressions, (row) => row.metrics?.impression, { sourceStatus, minimumPosts }),
      followersGainedPerPost: summarizeMetric(followers, (row) => row.metrics?.follower_gained_from_content, { sourceStatus, minimumPosts }),
      linkClicksPerThousandImpressions: summarizeMetric(clicks,
        (row) => perThousand(row.metrics?.link_clicks, row.metrics?.impression),
        { sourceStatus, minimumPosts }),
    },
  };
}

function parseHistory(history) {
  if (Array.isArray(history)) return history.filter(record);
  if (typeof history !== 'string') return [];
  return history.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return record(row) ? [row] : [];
    } catch {
      return [];
    }
  });
}

function telegramScorecard(historyInput, asOfMs, sourceStatus) {
  const lower = asOfMs - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS;
  const history = parseHistory(historyInput)
    .map((row) => ({ ...row, at: Date.parse(`${String(row.date || '').slice(0, 10)}T00:00:00.000Z`) }))
    .filter((row) => Number.isFinite(row.at) && row.at >= lower && row.at <= asOfMs && Number.isSafeInteger(row.count) && row.count >= 0)
    .sort((left, right) => left.at - right.at);
  const net = history.length >= 2 ? history.at(-1).count - history[0].count : null;
  const status = sourceStatus !== 'available' ? sourceStatus : history.length >= 2 ? 'available' : 'insufficient-sample';
  return {
    status,
    measurementWindow: 'member-count change over the last 30 days; not post-level attribution',
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    metrics: {
      netMembers30d: {
        status,
        observations: history.length,
        minimumObservations: 2,
        baseline: net,
      },
    },
  };
}

function audienceChangeScorecard(snapshots, channel, metric, asOfMs, sourceStatus) {
  const lower = asOfMs - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS;
  const rows = (Array.isArray(snapshots) ? snapshots : [])
    .filter((row) => record(row)
      && row.channel === channel
      && row.metric === metric
      && row.status === 'available'
      && Number.isSafeInteger(row.value)
      && row.value >= 0)
    .map((row) => ({ ...row, at: Date.parse(String(row.snapshotAt || '')) }))
    .filter((row) => Number.isFinite(row.at) && row.at >= lower && row.at <= asOfMs)
    .sort((left, right) => left.at - right.at);
  const latest = rows.at(-1) || null;
  const coverageDays = new Set(rows.map((row) => new Date(row.at).toISOString().slice(0, 10))).size;
  const spanDays = rows.length > 1 ? Math.floor((rows.at(-1).at - rows[0].at) / DAY_MS) : 0;
  const ageHours = latest ? (asOfMs - latest.at) / 3_600_000 : null;
  const status = sourceStatus !== 'available'
    ? sourceStatus
    : !latest ? 'no-audience-observations'
      : ageHours > SOCIAL_AUDIENCE_MAX_AGE_HOURS ? 'stale'
        : rows.length < SOCIAL_AUDIENCE_MINIMUM_DAYS || spanDays < SOCIAL_AUDIENCE_MINIMUM_DAYS
          ? 'insufficient-coverage'
          : 'available';
  return {
    status,
    metric,
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    minimumObservations: SOCIAL_AUDIENCE_MINIMUM_DAYS,
    observations: rows.length,
    coverageDays,
    spanDays,
    latestSnapshotAt: latest?.snapshotAt || null,
    netChange: status === 'available' ? rows.at(-1).value - rows[0].value : null,
  };
}

function linkedinFollowerGainSummary(snapshots, asOfMs, sourceStatus) {
  const end = new Date(asOfMs);
  end.setUTCHours(0, 0, 0, 0);
  const endDate = end.toISOString().slice(0, 10);
  const start = new Date(end.getTime() - 30 * DAY_MS);
  const startDate = start.toISOString().slice(0, 10);
  const rowsByDate = new Map();
  for (const row of Array.isArray(snapshots) ? snapshots : []) {
    if (!record(row) || row.channel !== 'linkedin-member' || row.metric !== 'followers-gained'
      || row.status !== 'available' || !Number.isSafeInteger(row.value) || row.value < 0
      || typeof row.date !== 'string' || row.date < startDate || row.date >= endDate) continue;
    const snapshotMs = Date.parse(String(row.snapshotAt || ''));
    if (!Number.isFinite(snapshotMs) || snapshotMs > asOfMs
      || new Date(snapshotMs).toISOString().slice(0, 10) !== row.date) continue;
    rowsByDate.set(row.date, row);
  }
  const rows = [...rowsByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  const latest = rows.at(-1) || null;
  const latestMs = latest ? Date.parse(latest.snapshotAt) : null;
  const ageHours = latestMs === null ? null : Math.max(0, (asOfMs - latestMs) / 3_600_000);
  const observedFollowerGains = rows.length ? rows.reduce((sum, row) => sum + row.value, 0) : null;
  const status = !rows.length
    ? sourceStatus === 'available' || sourceStatus === 'partial' ? 'no-observations' : sourceStatus
    : ageHours > SOCIAL_AUDIENCE_MAX_AGE_HOURS ? 'stale'
      : rows.length === 30 ? 'available' : 'partial';
  return {
    status,
    sourceStatus,
    metric: 'followers-gained',
    periodDays: 30,
    expectedDays: 30,
    coverageDays: rows.length,
    latestDate: latest?.date || null,
    ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
    observedFollowerGains,
    followerGains30d: status === 'available' ? observedFollowerGains : null,
    interpretation: 'LinkedIn daily channel-level followers gained; not account-level net change and not attributed to an individual post.',
  };
}

function sourceStatusValue(sources, source) {
  const value = sources?.[source];
  return typeof value === 'string' ? value : String(value?.status || 'not-collected-yet');
}

function communityResponseSummary(outcomes, asOfMs) {
  if (!record(outcomes) || !Array.isArray(outcomes.weeks) || !outcomes.weeks.length) {
    return { status: 'not-collected-yet', week: null, latestRun: null, eventsTruncated: false };
  }
  const asOfDate = new Date(asOfMs);
  const dayFromMonday = (asOfDate.getUTCDay() + 6) % 7;
  asOfDate.setUTCHours(0, 0, 0, 0);
  asOfDate.setUTCDate(asOfDate.getUTCDate() - dayFromMonday);
  const currentWeek = asOfDate.toISOString().slice(0, 10);
  const week = outcomes.weeks
    .filter((item) => item?.weekStart <= currentWeek && Date.parse(String(item.generatedAt || '')) <= asOfMs)
    .sort((left, right) => String(right.weekStart).localeCompare(String(left.weekStart)))[0] || null;
  const generatedAtMs = Date.parse(String(outcomes.generatedAt || ''));
  const ageHours = Number.isFinite(generatedAtMs) ? Math.max(0, (asOfMs - generatedAtMs) / 3_600_000) : null;
  const status = !week ? 'no-week-summary'
    : ageHours === null || ageHours > 72 ? 'stale'
      : outcomes.eventsTruncated || outcomes.coverageGap || outcomes.latestRun?.status !== 'completed' ? 'partial'
        : 'available';
  return {
    status,
    week,
    latestRun: outcomes.latestRun || null,
    generatedAt: outcomes.generatedAt || null,
    ageHours,
    eventsTruncated: outcomes.eventsTruncated === true,
    coverageGap: outcomes.coverageGap === true,
    trackedFrom: outcomes.trackedFrom || null,
  };
}

function postedAtMs(row) {
  for (const value of [row?.publishedAt, row?.postedAt, row?.confirmedAt, row?.ts, row?.date, row?.day]) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const parsed = Date.parse(raw.length === 10 ? `${raw}T12:00:00.000Z` : raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function facebookPublishedAtMs(row) {
  if (row?.scheduledFor) {
    const actual = Date.parse(String(row.actualPublishedAt || ''));
    return Number.isFinite(actual) ? actual : null;
  }
  return postedAtMs(row);
}

function usablePostId(value) {
  const id = String(value || '').trim();
  return id && !['unknown', 'none', 'null', 'undefined'].includes(id.toLowerCase()) ? id : null;
}

function postLedgerIdentity(row, channel) {
  const postId = channel === 'instagram'
    ? usablePostId(row?.instagramMediaId || row?.mediaId || row?.media_id)
    : channel === 'tiktok'
      ? usablePostId(row?.tiktokPostId)
      : channel === 'facebook'
        ? usablePostId(row?.fbPostId || row?.postId || row?.facebookPostId)
        : usablePostId(row?.linkedinPostId);
  if (postId) return { identity: `id:${postId}`, postId };
  if (channel === 'instagram') {
    const creative = String(row?.creativeId || row?.creative_id || '').trim();
    const day = String(row?.day || '').slice(0, 10);
    const kind = String(row?.kind || row?.contentKind || '').trim();
    return { identity: `fallback:${kind}:${day}:${creative}`, postId: null };
  }
  if (channel === 'tiktok') {
    const day = String(row?.day || '').slice(0, 10);
    const kind = String(row?.kind || '').trim();
    return { identity: `fallback:${kind}:${day}`, postId: null };
  }
  const entryId = String(row?.id || '').trim();
  const publishedAt = channel === 'facebook' ? facebookPublishedAtMs(row) : postedAtMs(row);
  return { identity: `fallback:${entryId}:${publishedAt ?? 'unknown'}`, postId: null };
}

function channelPostIdCoverage({ channel, ledgerState, snapshots, asOfMs, measurementWindow }) {
  if (!record(ledgerState) || ledgerState.status !== 'available' || !Array.isArray(ledgerState.posts)) {
    return {
      status: String(ledgerState?.status || 'ledger-not-provided'),
      measurementWindow: measurementWindow.label,
      publishedPosts30d: null,
      exactPostIds30d: null,
      exactPostIdCoverageRate: null,
      eligibleForMetrics: null,
      postsWithExactMetricSnapshot: null,
      exactMetricJoinRate: null,
      untimestampedPosts: null,
    };
  }
  const lower = asOfMs - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS;
  const grouped = new Map();
  let untimestampedPosts = 0;
  for (const row of ledgerState.posts) {
    if (!record(row)) continue;
    // Weekend digest ledgers also include covered events so the per-event
    // scheduler will not repost them. Those entries are not separate posts.
    if (channel === 'facebook' && row.viaDigest) continue;
    if (channel === 'facebook' && row.scheduledFor && facebookPublishedAtMs(row) === null) continue;
    const { identity, postId } = postLedgerIdentity(row, channel);
    const at = channel === 'facebook' ? facebookPublishedAtMs(row) : postedAtMs(row);
    const group = grouped.get(identity) || { postId, at };
    group.postId ||= postId;
    if (at !== null) group.at = group.at === null ? at : Math.min(group.at, at);
    grouped.set(identity, group);
  }
  const recent = [...grouped.values()].filter((item) => {
    if (item.at === null || item.at > asOfMs) {
      untimestampedPosts += 1;
      return false;
    }
    return item.at >= lower;
  });
  const exactPostIds30d = recent.filter((item) => item.postId).length;
  const eligibleMs = measurementWindow.hours != null
    ? measurementWindow.hours * 3_600_000
    : measurementWindow.days != null ? measurementWindow.days * DAY_MS : null;
  const eligible = eligibleMs === null ? [] : recent.filter((item) => asOfMs - item.at >= eligibleMs && item.postId);
  const exactSnapshotIds = new Set((Array.isArray(snapshots) ? snapshots : [])
    .filter((row) => row?.channel === (channel === 'linkedinMember' ? 'linkedin-member' : channel))
    .filter((row) => measurementWindow.hours != null
      ? Number(row.windowHours) === measurementWindow.hours
      : Number(row.windowDays) === measurementWindow.days)
    .map((row) => usablePostId(row?.postId))
    .filter(Boolean));
  const joined = eligible.filter((item) => exactSnapshotIds.has(item.postId)).length;
  const idRate = recent.length ? exactPostIds30d / recent.length : null;
  const joinRate = eligible.length ? joined / eligible.length : null;
  const status = untimestampedPosts ? 'partial-ledger-timestamps'
    : !recent.length ? 'no-published-posts'
      : exactPostIds30d < recent.length ? 'exact-post-ids-incomplete'
        : eligible.length === 0 ? 'awaiting-measurement-window'
          : joined < eligible.length ? 'exact-metric-join-incomplete' : 'available';
  return {
    status,
    measurementWindow: measurementWindow.label,
    publishedPosts30d: recent.length,
    exactPostIds30d,
    exactPostIdCoverageRate: idRate,
    eligibleForMetrics: eligible.length,
    postsWithExactMetricSnapshot: joined,
    exactMetricJoinRate: joinRate,
    untimestampedPosts,
  };
}

function channelPublicationCount({ ledgerState, asOfMs }) {
  if (!record(ledgerState) || ledgerState.status !== 'available' || !Array.isArray(ledgerState.posts)) {
    return {
      status: String(ledgerState?.status || 'ledger-not-provided'),
      publishedPosts30d: null,
      exactPostIds30d: null,
      exactPostIdCoverageRate: null,
      eligibleForMetrics: null,
      postsWithExactMetricSnapshot: null,
      exactMetricJoinRate: null,
      untimestampedPosts: null,
    };
  }
  const lower = asOfMs - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS;
  const grouped = new Map();
  const legacyTelegramJobRows = [];
  const publicationGroupingBasis = new Set();
  let untimestampedPosts = 0;
  for (const row of ledgerState.posts) {
    if (!record(row)) continue;
    const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id).trim() : '';
    if (!id) continue;
    const at = postedAtMs(row);
    const source = typeof row.ledgerSource === 'string' ? row.ledgerSource : '';
    const deliveryId = typeof row.telegramDeliveryId === 'string'
      && /^[a-f0-9-]{36}$/iu.test(row.telegramDeliveryId.trim())
      ? row.telegramDeliveryId.trim().toLowerCase()
      : '';
    const messageId = Number.isSafeInteger(row.telegramMessageId) && row.telegramMessageId > 0
      ? String(row.telegramMessageId)
      : '';
    if (source === 'telegramJobs' && !deliveryId && !messageId && at !== null) {
      publicationGroupingBasis.add('legacy-send-time-cluster-inference');
      legacyTelegramJobRows.push({ id, at });
      continue;
    }
    if (deliveryId) publicationGroupingBasis.add('telegram-delivery-id');
    else if (messageId) publicationGroupingBasis.add('telegram-message-id-fallback');
    else publicationGroupingBasis.add('ledger-row-id');
    const groupId = source === 'telegramJobs'
      ? deliveryId ? `${source}:delivery:${deliveryId}`
        : messageId ? `${source}:message:${messageId}` : `${source}:job:${id}`
      : source === 'telegramAnnouncements'
        ? deliveryId ? `${source}:delivery:${deliveryId}`
          : messageId ? `${source}:message:${messageId}` : `${source}:announcement:${id}`
        : source ? `${source}:post:${id}` : `post:${id}`;
    const existing = grouped.get(groupId);
    if (!existing || (at !== null && (existing.at === null || at < existing.at))) {
      grouped.set(groupId, { at });
    }
  }
  legacyTelegramJobRows.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  let legacyCluster = null;
  for (const row of legacyTelegramJobRows) {
    const day = zurichDayKey(row.at);
    if (legacyCluster?.day === day && row.at - legacyCluster.lastAt <= LEGACY_TELEGRAM_DIGEST_CLUSTER_MS) {
      legacyCluster.lastAt = row.at;
      continue;
    }
    const groupId = `telegramJobs:legacy-digest:${day}:${row.at}`;
    grouped.set(groupId, { at: row.at });
    legacyCluster = { day, lastAt: row.at };
  }
  const recent = [...grouped.values()].filter(({ at }) => {
    if (at === null || at > asOfMs) {
      untimestampedPosts += 1;
      return false;
    }
    return at >= lower;
  });
  return {
    status: untimestampedPosts ? 'partial-ledger-timestamps' : recent.length ? 'count-only-no-native-post-metrics' : 'no-published-posts',
    publishedPosts30d: recent.length,
    exactPostIds30d: null,
    exactPostIdCoverageRate: null,
    eligibleForMetrics: null,
    postsWithExactMetricSnapshot: null,
    exactMetricJoinRate: null,
    untimestampedPosts,
    publicationCountBasis: publicationGroupingBasis.size
      ? [...publicationGroupingBasis].sort().join('+')
      : 'no-ledger-rows',
  };
}

function zurichDayKey(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function dailyCadenceEvidence({ channel, ledgerState, asOfMs, cap }) {
  if (!record(ledgerState) || ledgerState.status !== 'available' || !Array.isArray(ledgerState.posts)) {
    return {
      status: String(ledgerState?.status || 'ledger-not-provided'),
      timezone: 'Europe/Zurich',
      capPerDay: cap,
      daysObserved: null,
      maximumPostsPerDay: null,
      overrunDays: null,
      lastOverrunDay: null,
    };
  }

  const lower = asOfMs - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS;
  const grouped = new Map();
  const legacyTelegramRows = [];
  let untimestampedPosts = 0;
  for (const row of ledgerState.posts) {
    if (!record(row) || (channel === 'facebook' && row.viaDigest)) continue;
    if (channel === 'facebook' && row.scheduledFor && !Number.isFinite(Date.parse(String(row.actualPublishedAt || '')))) continue;
    const rawAt = channel === 'facebook'
      ? row.actualPublishedAt || row.publishedAt || row.postedAt || row.confirmedAt || row.ts || row.date || row.day
      : row.publishedAt || row.postedAt || row.confirmedAt || row.ts || row.date || row.day;
    const at = Date.parse(String(rawAt || ''));
    if (!Number.isFinite(at)) {
      untimestampedPosts += 1;
      continue;
    }
    if (at > asOfMs || at < lower) continue;

    const source = typeof row.ledgerSource === 'string' ? row.ledgerSource : '';
    const reservationType = String(row.socialReservationType || '').trim();
    const reservationId = String(row.socialReservationId || '').trim();
    const deliveryId = String(row.telegramDeliveryId || '').trim();
    const messageId = Number.isSafeInteger(row.telegramMessageId) && row.telegramMessageId > 0
      ? String(row.telegramMessageId) : '';
    const linkedinPostId = usablePostId(row.linkedinPostId);
    if (channel === 'telegram' && source === 'telegramJobs' && !reservationId && !deliveryId && !messageId) {
      legacyTelegramRows.push({ at, id: String(row.id || '') });
      continue;
    }
    const identity = reservationType && reservationId
      ? `${reservationType}:${reservationId}`
      : channel === 'telegram'
        ? source === 'telegramJobs'
          ? deliveryId ? `jobs:delivery:${deliveryId}` : `jobs:message:${messageId}`
          : deliveryId ? `announcement:delivery:${deliveryId}`
            : messageId ? `announcement:message:${messageId}` : `announcement:${row.id || ''}`
        : channel === 'linkedinMember'
          ? `member:${linkedinPostId || `${row.kind || 'post'}:${row.id || ''}:${at}`}`
          : channel === 'facebook'
            ? `${source}:${row.fbPostId || row.postId || row.id || ''}`
            : channel === 'instagram'
              ? `instagram:${row.queueId || row.mediaId || row.id || ''}`
              : `${channel}:${row.id || ''}`;
    const existing = grouped.get(identity);
    if (!existing || at < existing.at) grouped.set(identity, { at });
  }

  legacyTelegramRows.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  let legacyCluster = null;
  for (const row of legacyTelegramRows) {
    const day = zurichDayKey(row.at);
    if (legacyCluster?.day === day && row.at - legacyCluster.lastAt <= LEGACY_TELEGRAM_DIGEST_CLUSTER_MS) {
      legacyCluster.lastAt = row.at;
      continue;
    }
    grouped.set(`telegram:legacy:${day}:${row.at}`, { at: row.at });
    legacyCluster = { day, lastAt: row.at };
  }

  const dailyCounts = new Map();
  for (const { at } of grouped.values()) {
    const day = zurichDayKey(at);
    dailyCounts.set(day, (dailyCounts.get(day) || 0) + 1);
  }
  const overruns = [...dailyCounts.entries()]
    .filter(([, count]) => count > cap)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    status: untimestampedPosts ? 'partial-ledger-timestamps' : overruns.length ? 'cap-exceeded' : 'within-cap',
    timezone: 'Europe/Zurich',
    capPerDay: cap,
    daysObserved: dailyCounts.size,
    maximumPostsPerDay: Math.max(0, ...dailyCounts.values()),
    overrunDays: overruns.length,
    lastOverrunDay: overruns.at(-1)?.[0] || null,
    untimestampedPosts,
  };
}

function buildChannelPilotObservability({ audienceGrowth, sources, publicationLedgers, nativePosts, asOfMs }) {
  const snapshots = [...(Array.isArray(nativePosts) ? nativePosts : [])];
  return Object.fromEntries(Object.entries(CHANNEL_PILOT_CONTRACTS).map(([key, contract]) => {
    const sourceStatus = key === 'linkedinMember'
      ? statusFor(sources, 'linkedinAudience', 'not-collected-yet')
      : key === 'linkedinCompanyPage' ? statusFor(sources, key, 'organization-social-permission-missing')
      : key === 'youtubeShorts' ? statusFor(sources, 'youtubeShorts', 'account-not-configured')
        : key === 'reddit' ? statusFor(sources, 'reddit', 'external-review-required')
        : key === 'threads' ? statusFor(sources, 'threads', 'account-and-oauth-not-configured')
          : ['x', 'whatsappChannels'].includes(key) ? statusFor(sources, key, 'account-and-oauth-not-configured')
            : statusFor(sources, key, key === 'tiktok' ? 'policy-review-required' : 'not-collected-yet');
    const audience = audienceGrowth[key] || { status: 'not-supported' };
    const ledgerState = contract.ledgerKey ? publicationLedgers?.[contract.ledgerKey] : null;
    const postIdCoverage = contract.ledgerKey && contract.nativeChannel
      ? channelPostIdCoverage({
        channel: key,
        ledgerState,
        snapshots,
        asOfMs,
        measurementWindow: contract.measurementWindow,
      })
      : contract.ledgerKey
        ? channelPublicationCount({ ledgerState, asOfMs })
      : {
        status: contract.nativeChannel ? 'exact-id-coverage-not-collected' : 'not-supported',
        measurementWindow: contract.measurementWindow.label,
        publishedPosts30d: null,
        exactPostIds30d: null,
        exactPostIdCoverageRate: null,
        eligibleForMetrics: null,
        postsWithExactMetricSnapshot: null,
        exactMetricJoinRate: null,
        untimestampedPosts: null,
      };
    const cadenceOverrun = contract.dailyCap && ledgerState
      ? dailyCadenceEvidence({ channel: key, ledgerState, asOfMs, cap: contract.dailyCap })
      : {
        status: contract.dailyCap ? 'ledger-not-provided' : 'not-supported',
        timezone: 'Europe/Zurich',
        capPerDay: contract.dailyCap ?? null,
        daysObserved: null,
        maximumPostsPerDay: null,
        overrunDays: null,
        lastOverrunDay: null,
      };
    const deliveryBlocked = sourceStatus === 'policy-review-required'
      || sourceStatus === 'external-devvit-review-required'
      || sourceStatus === 'account-and-oauth-not-configured'
      || sourceStatus === 'account-not-configured'
      || sourceStatus === 'organization-social-permission-missing'
      || sourceStatus === 'external-review-required';
    const readinessStatus = deliveryBlocked ? 'delivery-held-or-unconfigured'
      : audience.status !== 'available' ? 'audience-baseline-building'
        : ['available', 'awaiting-measurement-window', 'no-published-posts'].includes(postIdCoverage.status)
          ? 'measurement-building' : 'exact-post-evidence-incomplete';
    return [key, {
      contractVersion: SOCIAL_CHANNEL_PILOT_CONTRACT_VERSION,
      readinessStatus,
      sourceStatus,
      deliveryPath: contract.deliveryPath,
      cadenceCap: contract.cadenceCap,
      cadenceOverrun,
      stopCriteriaTriggered: cadenceOverrun.overrunDays > 0 ? ['existing-publisher-cap-exceeded'] : [],
      untrackedCapGroups: key === 'instagram' ? ['story'] : [],
      cadenceIncreaseAllowed: false,
      minimumOrganicPilotDays: 28,
      audienceMetricStatus: audience.status,
      postIdCoverage,
      promotionStatus: 'descriptive-only-protocol-unqualified',
      stopCriteria: [...contract.stopCriteria],
      interpretation: 'Pilot readiness and exact-ID coverage are operational checks, not evidence of content lift or a qualified winner.',
    }];
  }));
}

/** Freeze the first qualified 30-day audience baseline per channel and metric. */
export function freezeEligibleAudienceBaselines(existingBaselines, audienceSnapshots, sources, asOf = new Date()) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('asOf must be a valid date');
  const rowsInput = Array.isArray(audienceSnapshots) ? audienceSnapshots : [];
  const baselines = record(existingBaselines) ? { ...existingBaselines } : {};
  for (const [channel, contract] of Object.entries(AUDIENCE_SOURCE_BY_CHANNEL)) {
    if (baselines[channel] || sourceStatusValue(sources, contract.source) !== 'available') continue;
    const summary = audienceChangeScorecard(rowsInput, channel, contract.metric, asOfMs, 'available');
    if (summary.status !== 'available') continue;
    const rows = rowsInput
      .filter((row) => row?.channel === channel && row?.metric === contract.metric && row?.status === 'available')
      .map((row) => ({ ...row, at: Date.parse(String(row.snapshotAt || '')) }))
      .filter((row) => Number.isFinite(row.at)
        && row.at >= asOfMs - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS
        && row.at <= asOfMs)
      .sort((left, right) => left.at - right.at);
    if (rows.length < SOCIAL_AUDIENCE_MINIMUM_DAYS) continue;
    const start = rows[0];
    const end = rows.at(-1);
    baselines[channel] = {
      schemaVersion: 1,
      channel,
      metric: contract.metric,
      startAt: new Date(start.at).toISOString(),
      endAt: new Date(end.at).toISOString(),
      startValue: start.value,
      endValue: end.value,
      netChange: end.value - start.value,
      coverageDays: summary.coverageDays,
      observations: rows.length,
      frozenAt: new Date(asOfMs).toISOString(),
    };
  }
  return baselines;
}

function deriveAudienceGrowthTarget(baseline) {
  if (!record(baseline)) return { status: 'awaiting-qualified-baseline' };
  const startAt = Date.parse(String(baseline.startAt || ''));
  const endAt = Date.parse(String(baseline.endAt || ''));
  const startValue = Number(baseline.startValue);
  const endValue = Number(baseline.endValue);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt
    || !Number.isSafeInteger(startValue) || startValue < 0
    || !Number.isSafeInteger(endValue) || endValue < 0
    || !Number.isFinite(Number(baseline.netChange))) {
    return { status: 'baseline-invalid' };
  }
  const spanDays = (endAt - startAt) / DAY_MS;
  const observedMonthlyNetChange = Number(baseline.netChange) * SOCIAL_GROWTH_BASELINE_DAYS / spanDays;
  if (!Number.isFinite(observedMonthlyNetChange)) return { status: 'baseline-invalid' };
  const paceStretch = Math.ceil(Math.max(0, observedMonthlyNetChange) * 3 * 1.5);
  const baselineFloor = Math.ceil(endValue * 0.25);
  const targetNetChange = Math.max(1, paceStretch, baselineFloor);
  return {
    status: 'available',
    policyVersion: SOCIAL_GROWTH_TARGET_POLICY_VERSION,
    horizonDays: SOCIAL_GROWTH_TARGET_HORIZON_DAYS,
    targetAt: new Date(endAt + SOCIAL_GROWTH_TARGET_HORIZON_DAYS * DAY_MS).toISOString(),
    baselineStartValue: startValue,
    baselineEndValue: endValue,
    targetNetChange,
    targetAudienceValue: endValue + targetNetChange,
    targetWindowDays: SOCIAL_GROWTH_TARGET_HORIZON_DAYS,
    observedMonthlyNetChange: Math.round(observedMonthlyNetChange * 1000) / 1000,
    formula: 'max(150%-of-linearized-baseline-pace,25%-of-follow-up-start-audience,1-audience-member)',
  };
}

function compareAudienceBaseline(audienceSnapshots, baseline, asOfMs) {
  if (!record(baseline)) return { status: 'baseline-not-frozen' };
  const target = deriveAudienceGrowthTarget(baseline);
  const baselineEnd = Date.parse(String(baseline.endAt || ''));
  const frozenAt = Date.parse(String(baseline.frozenAt || ''));
  if (!Number.isFinite(baselineEnd) || !Number.isFinite(frozenAt) || frozenAt < baselineEnd) {
    return { status: 'baseline-invalid' };
  }
  if (frozenAt > asOfMs) return { status: 'baseline-not-frozen-as-of' };
  const targetAt = baselineEnd + SOCIAL_GROWTH_TARGET_HORIZON_DAYS * DAY_MS;
  const eligible = (Array.isArray(audienceSnapshots) ? audienceSnapshots : [])
    .filter((row) => row?.channel === baseline.channel && row?.metric === baseline.metric && row?.status === 'available')
    .map((row) => ({ ...row, at: Date.parse(String(row.snapshotAt || '')) }))
    .filter((row) => Number.isFinite(row.at) && row.at <= asOfMs && Math.abs(row.at - targetAt) <= 2 * DAY_MS)
    .sort((left, right) => Math.abs(left.at - targetAt) - Math.abs(right.at - targetAt));
  const observation = eligible[0];
  if (!observation) {
    return {
      status: asOfMs < targetAt - 2 * DAY_MS ? 'follow-up-in-progress' : 'follow-up-observation-missing',
      daysUntilTarget: Math.max(0, Math.ceil((targetAt - asOfMs) / DAY_MS)),
      baselineNetChange: baseline.netChange,
      targetNetChange: target.targetNetChange ?? null,
      targetAudienceValue: target.targetAudienceValue ?? null,
      targetMet: null,
    };
  }
  const elapsedDays = (observation.at - baselineEnd) / DAY_MS;
  const followupNetChange = observation.value - baseline.endValue;
  const targetNetChangeForObservedWindow = Number.isSafeInteger(target.targetNetChange)
    && Number.isFinite(elapsedDays) && elapsedDays > 0
    ? Math.ceil(target.targetNetChange * elapsedDays / target.horizonDays)
    : null;
  return {
    status: 'descriptive-comparison-available',
    baselineWindowDays: SOCIAL_GROWTH_BASELINE_DAYS,
    followupWindowDays: Math.round(elapsedDays),
    baselineNetChange: baseline.netChange,
    followupNetChange,
    followupMonthlyEquivalent: elapsedDays > 0 ? Math.round((followupNetChange * 30 / elapsedDays) * 1000) / 1000 : null,
    targetNetChange: target.targetNetChange ?? null,
    targetNetChangeForObservedWindow,
    targetAudienceValue: target.targetAudienceValue ?? null,
    targetMet: Number.isSafeInteger(targetNetChangeForObservedWindow)
      ? followupNetChange >= targetNetChangeForObservedWindow : null,
    observationAt: observation.snapshotAt,
    interpretation: 'descriptive-only; target is an automatic stretch goal, not a causal estimate or winner decision',
  };
}

function makeAudienceBaselineForCycle(channel, metric, snapshots, endAtMs, frozenAtMs) {
  const lowerBound = endAtMs - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS;
  const byDay = new Map();
  for (const row of Array.isArray(snapshots) ? snapshots : []) {
    if (row?.channel !== channel || row?.metric !== metric || row?.status !== 'available'
      || !Number.isSafeInteger(row?.value) || row.value < 0) continue;
    const at = Date.parse(String(row.snapshotAt || ''));
    if (!Number.isFinite(at) || at < lowerBound || at > endAtMs || at > frozenAtMs) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const existing = byDay.get(day);
    if (!existing || at > existing.at) byDay.set(day, { ...row, at });
  }
  const rows = [...byDay.values()].sort((left, right) => left.at - right.at);
  if (rows.length < SOCIAL_AUDIENCE_MINIMUM_DAYS) return null;
  const start = rows[0];
  const end = rows.at(-1);
  const coverageDays = Math.floor((end.at - start.at) / DAY_MS);
  if (coverageDays < SOCIAL_AUDIENCE_MINIMUM_DAYS) return null;
  return {
    schemaVersion: 1,
    channel,
    metric,
    startAt: new Date(start.at).toISOString(),
    endAt: new Date(end.at).toISOString(),
    startValue: start.value,
    endValue: end.value,
    netChange: end.value - start.value,
    coverageDays,
    observations: rows.length,
    frozenAt: new Date(frozenAtMs).toISOString(),
  };
}

/**
 * Keep one active 90-day target per channel. Once its qualified endpoint is
 * observed, freeze the trailing 30-day audience window as the next cycle's
 * pace baseline without changing the immutable first baseline.
 */
export function advanceAudienceGrowthCycles(existingCycles, initialBaselines, audienceSnapshots, sources, asOf = new Date()) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('asOf must be a valid date');
  const cycles = record(existingCycles) ? { ...existingCycles } : {};
  for (const [channel, contract] of Object.entries(AUDIENCE_SOURCE_BY_CHANNEL)) {
    if (sourceStatusValue(sources, contract.source) !== 'available') continue;
    let state = cycles[channel];
    if (!record(state)) {
      const baseline = initialBaselines?.[channel];
      if (!record(baseline)) continue;
      state = {
        schemaVersion: 1,
        channel,
        cycleNumber: 1,
        status: 'active',
        currentBaseline: baseline,
        lastCompleted: null,
      };
    }
    const comparison = compareAudienceBaseline(audienceSnapshots, state.currentBaseline, asOfMs);
    if (comparison.status !== 'descriptive-comparison-available') {
      cycles[channel] = state;
      continue;
    }
    const observedAt = Date.parse(String(comparison.observationAt || ''));
    if (!Number.isFinite(observedAt)
      || asOfMs - observedAt > SOCIAL_AUDIENCE_MAX_AGE_HOURS * 60 * 60 * 1000) {
      cycles[channel] = state;
      continue;
    }
    const completedCycle = {
      cycleNumber: state.cycleNumber,
      baselineStartAt: state.currentBaseline.startAt,
      baselineEndAt: state.currentBaseline.endAt,
      targetAt: new Date(Date.parse(state.currentBaseline.endAt)
        + SOCIAL_GROWTH_TARGET_HORIZON_DAYS * DAY_MS).toISOString(),
      observationAt: comparison.observationAt,
      completedAt: new Date(asOfMs).toISOString(),
      baselineNetChange: comparison.baselineNetChange,
      followupNetChange: comparison.followupNetChange,
      targetNetChange: comparison.targetNetChange,
      targetNetChangeForObservedWindow: comparison.targetNetChangeForObservedWindow,
      targetMet: comparison.targetMet,
    };
    const nextBaseline = makeAudienceBaselineForCycle(
      channel,
      contract.metric,
      audienceSnapshots,
      observedAt,
      asOfMs,
    );
    cycles[channel] = nextBaseline
      ? {
        schemaVersion: 1,
        channel,
        cycleNumber: state.cycleNumber + 1,
        status: 'active',
        currentBaseline: nextBaseline,
        lastCompleted: completedCycle,
      }
      : {
        ...state,
        status: 'awaiting-qualified-next-baseline',
        lastCompleted: completedCycle,
      };
  }
  return cycles;
}

function dateDayMs(value) {
  const day = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const parsed = Date.parse(`${day}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? parsed : null;
}

function addUtcDays(day, days) {
  const at = dateDayMs(day);
  return at === null ? null : new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

function dateInTimeZone(atMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(atMs));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const day = `${values.year}-${values.month}-${values.day}`;
    return dateDayMs(day) === null ? null : day;
  } catch {
    return null;
  }
}

function weightedSiteOutcomeRate(rows) {
  const sessions = rows.reduce((sum, row) => sum + (Number.isSafeInteger(row.sessions) ? row.sessions : 0), 0);
  if (sessions <= 0) return { sessions, rate: null };
  const weighted = rows.reduce((sum, row) => sum + (row.sessions > 0 && Number.isFinite(row.sessionKeyEventRate)
    ? row.sessions * row.sessionKeyEventRate : 0), 0);
  return { sessions, rate: weighted / sessions };
}

function isAtOrAboveFloatingPointBoundary(value, threshold) {
  const roundingTolerance = Number.EPSILON * 4 * Math.max(1, Math.abs(threshold));
  return value >= threshold || threshold - value <= roundingTolerance;
}

function siteOutcomeRowsFor(snapshots, channel, eventName, startDate, endDate) {
  const startMs = dateDayMs(startDate);
  const endMs = dateDayMs(endDate);
  if (startMs === null || endMs === null || startMs > endMs) return [];
  return (Array.isArray(snapshots) ? snapshots : [])
    .filter((row) => row?.channel === channel && row?.eventName === eventName
      && ['available', 'zero-sessions'].includes(row?.status))
    .map((row) => ({ ...row, at: dateDayMs(row.date) }))
    .filter((row) => row.at !== null && row.at >= startMs && row.at <= endMs)
    .sort((left, right) => left.at - right.at);
}

function siteOutcomeSummary(snapshots, channel, eventName, sourceState, asOfMs) {
  const sourceStatus = typeof sourceState === 'string' ? sourceState : String(sourceState?.status || 'not-collected-yet');
  if (!isSocialGa4SessionKeyEventRateEligible(eventName)) return {
    status: 'event-not-rate-eligible',
    eventName,
    eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
    metric: 'not-rate-eligible',
    observations: 0,
    coverageDays: 0,
    sessions: null,
    sessionKeyEventRate: null,
    frozenBaselineComparison: { status: 'event-not-rate-eligible' },
  };
  const registered = Array.isArray(sourceState?.registeredEventNames)
    ? sourceState.registeredEventNames.includes(eventName)
    : false;
  if (sourceStatus !== 'available') return {
    status: sourceStatus,
    eventName,
    eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
    metric: 'session-key-event-rate',
    observations: 0,
    coverageDays: 0,
    sessions: null,
    sessionKeyEventRate: null,
    frozenBaselineComparison: { status: sourceStatus },
  };
  if (!registered) return {
    status: 'key-event-not-registered',
    eventName,
    eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
    metric: 'session-key-event-rate',
    observations: 0,
    coverageDays: 0,
    sessions: null,
    sessionKeyEventRate: null,
    frozenBaselineComparison: { status: 'key-event-not-registered' },
  };
  const timeZone = String(sourceState?.timeZone || '').trim();
  const currentPropertyDate = timeZone ? dateInTimeZone(asOfMs, timeZone) : null;
  const dataEndDate = dateDayMs(sourceState?.latestDataEndDate)
    ? sourceState.latestDataEndDate
    : currentPropertyDate;
  if (!timeZone || !currentPropertyDate || !dataEndDate) return {
    status: 'time-zone-unavailable',
    eventName,
    eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
    metric: 'session-key-event-rate',
    observations: 0,
    coverageDays: 0,
    sessions: null,
    sessionKeyEventRate: null,
    frozenBaselineComparison: { status: 'time-zone-unavailable' },
  };
  const startDate = addUtcDays(dataEndDate, -SOCIAL_GROWTH_BASELINE_DAYS + 1);
  const rows = siteOutcomeRowsFor(snapshots, channel, eventName, startDate, dataEndDate);
  if (rows.some((row) => row.timeZone !== timeZone)) return {
    status: 'time-zone-changed',
    eventName,
    eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
    metric: 'session-key-event-rate',
    observations: rows.length,
    coverageDays: new Set(rows.map((row) => row.date)).size,
    sessions: null,
    sessionKeyEventRate: null,
    frozenBaselineComparison: { status: 'time-zone-changed' },
  };
  const coverageDays = new Set(rows.map((row) => row.date)).size;
  const spanDays = rows.length > 1 ? Math.floor((rows.at(-1).at - rows[0].at) / DAY_MS) : 0;
  const latest = rows.at(-1) || null;
  const ageHours = latest
    ? Math.max(0, (dateDayMs(currentPropertyDate) - latest.at) / DAY_MS * 24)
    : null;
  const { sessions, rate } = weightedSiteOutcomeRate(rows);
  const status = !latest ? 'no-attributable-observations'
    : ageHours > SOCIAL_SITE_OUTCOME_MAX_AGE_HOURS ? 'stale'
      : rows.length < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
        || coverageDays < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
        || spanDays < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS ? 'insufficient-coverage'
        : sessions < SOCIAL_SITE_OUTCOME_MINIMUM_SESSIONS ? 'insufficient-sessions'
          : rate === null ? 'no-session-denominator' : 'available';
  return {
    status,
    eventName,
    eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
    metric: 'session-key-event-rate',
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    observations: rows.length,
    coverageDays,
    spanDays,
    latestDate: latest?.date || null,
    sessions: status === 'available' ? sessions : null,
    sessionKeyEventRate: status === 'available' ? rate : null,
    minimumSessions: SOCIAL_SITE_OUTCOME_MINIMUM_SESSIONS,
  };
}

/** Freeze first qualified channel/event GA4 outcome baseline; event claims stay separate. */
export function freezeEligibleSocialSiteOutcomeBaselines(existingBaselines, snapshots, sourceState, asOf = new Date()) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('asOf must be a valid date');
  const baselines = Array.isArray(existingBaselines) ? [...existingBaselines] : [];
  if (sourceStatusValue({ socialSiteOutcomes: sourceState }, 'socialSiteOutcomes') !== 'available') return baselines;
  const registered = new Set(Array.isArray(sourceState?.registeredEventNames)
    ? sourceState.registeredEventNames.filter(isSocialGa4SessionKeyEventRateEligible)
    : []);
  const timeZone = String(sourceState?.timeZone || '').trim();
  const currentPropertyDate = timeZone ? dateInTimeZone(asOfMs, timeZone) : null;
  const dataEndDate = dateDayMs(sourceState?.latestDataEndDate)
    ? sourceState.latestDataEndDate
    : currentPropertyDate;
  if (!timeZone || !currentPropertyDate || !dataEndDate) return baselines;
  const startDate = addUtcDays(dataEndDate, -SOCIAL_GROWTH_BASELINE_DAYS + 1);
  for (const channel of SOCIAL_GA4_CHANNELS) {
    for (const eventName of Object.keys(SOCIAL_GA4_ACTION_EVENTS)) {
      if (!registered.has(eventName)
        || baselines.some((baseline) => baseline?.channel === channel && baseline?.eventName === eventName)) continue;
      const rows = siteOutcomeRowsFor(snapshots, channel, eventName, startDate, dataEndDate);
      const coverageDays = new Set(rows.map((row) => row.date)).size;
      const spanDays = rows.length > 1 ? Math.floor((rows.at(-1).at - rows[0].at) / DAY_MS) : 0;
      const { sessions, rate } = weightedSiteOutcomeRate(rows);
      const timeZones = [...new Set(rows.map((row) => String(row.timeZone || '')).filter(Boolean))];
      if (rows.some((row) => row.timeZone !== timeZone)
        || rows.length < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
        || coverageDays < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
        || spanDays < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
        || sessions < SOCIAL_SITE_OUTCOME_MINIMUM_SESSIONS
        || rate === null || timeZones.length !== 1) continue;
      baselines.push({
        schemaVersion: 1,
        channel,
        eventName,
        eventContractVersion: SOCIAL_GA4_EVENT_CONTRACT_VERSION,
        metric: 'session-key-event-rate',
        startDate: rows[0].date,
        endDate: rows.at(-1).date,
        timeZone: timeZones[0],
        sessions,
        sessionKeyEventRate: rate,
        coverageDays,
        observations: rows.length,
        frozenAt: new Date(asOfMs).toISOString(),
      });
    }
  }
  return baselines.sort((left, right) => String(left.channel).localeCompare(String(right.channel))
    || String(left.eventName).localeCompare(String(right.eventName)));
}

function compareSocialSiteOutcomeBaseline(snapshots, baseline, sourceState, asOfMs) {
  if (!isSocialGa4SessionKeyEventRateEligible(baseline?.eventName)) return { status: 'event-not-rate-eligible' };
  if (sourceState?.status !== 'available') return { status: String(sourceState?.status || 'source-unavailable') };
  if (!Array.isArray(sourceState?.registeredEventNames)
    || !sourceState.registeredEventNames.includes(baseline.eventName)) return { status: 'key-event-not-registered' };
  const baselineEndMs = dateDayMs(baseline.endDate);
  if (baselineEndMs === null) return { status: 'baseline-invalid' };
  const targetDate = addUtcDays(baseline.endDate, 90);
  const targetMs = dateDayMs(targetDate);
  const currentPropertyDate = dateInTimeZone(asOfMs, String(sourceState?.timeZone || ''));
  const dataEndDate = dateDayMs(sourceState?.latestDataEndDate)
    ? sourceState.latestDataEndDate
    : currentPropertyDate;
  if (!currentPropertyDate || !dataEndDate) return { status: 'time-zone-unavailable' };
  if (targetMs === null || Date.parse(String(baseline.frozenAt || '')) > asOfMs) {
    return { status: 'baseline-not-frozen-as-of' };
  }
  const candidates = [...new Set((Array.isArray(snapshots) ? snapshots : [])
    .filter((row) => row?.channel === baseline.channel && row?.eventName === baseline.eventName)
    .map((row) => row?.date)
    .filter((date) => {
      const at = dateDayMs(date);
      return at !== null && at <= dateDayMs(dataEndDate)
        && Math.abs(at - targetMs) <= 6 * DAY_MS;
    }))]
    .sort((left, right) => Math.abs(dateDayMs(left) - targetMs) - Math.abs(dateDayMs(right) - targetMs));
  for (const endDate of candidates) {
    const startDate = addUtcDays(endDate, -SOCIAL_GROWTH_BASELINE_DAYS + 1);
    const rows = siteOutcomeRowsFor(snapshots, baseline.channel, baseline.eventName, startDate, endDate);
    const coverageDays = new Set(rows.map((row) => row.date)).size;
    const spanDays = rows.length > 1 ? Math.floor((rows.at(-1).at - rows[0].at) / DAY_MS) : 0;
    const { sessions, rate } = weightedSiteOutcomeRate(rows);
    if (rows.length < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
      || coverageDays < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
      || spanDays < SOCIAL_SITE_OUTCOME_MINIMUM_DAYS
      || sessions < SOCIAL_SITE_OUTCOME_MINIMUM_SESSIONS
      || rate === null) continue;
    if (rows.some((row) => row.timeZone !== baseline.timeZone)) return { status: 'time-zone-changed' };
    return {
      status: 'descriptive-comparison-available',
      baselineWindowDays: SOCIAL_GROWTH_BASELINE_DAYS,
      followupWindowDays: SOCIAL_GROWTH_BASELINE_DAYS,
      targetDate,
      observedEndDate: endDate,
      sessions,
      baselineSessions: baseline.sessions,
      targetSessions: Math.ceil(baseline.sessions * (1 + SOCIAL_BUSINESS_OUTCOME_TARGET_RELATIVE_LIFT)),
      targetSessionsMet: sessions >= Math.ceil(baseline.sessions * (1 + SOCIAL_BUSINESS_OUTCOME_TARGET_RELATIVE_LIFT)),
      baselineSessionKeyEventRate: baseline.sessionKeyEventRate,
      followupSessionKeyEventRate: rate,
      absoluteRateChange: rate - baseline.sessionKeyEventRate,
      relativeRateChange: baseline.sessionKeyEventRate > 0 ? (rate - baseline.sessionKeyEventRate) / baseline.sessionKeyEventRate : null,
      rateGuardrailFloor: baseline.sessionKeyEventRate > 0
        ? baseline.sessionKeyEventRate * SOCIAL_BUSINESS_OUTCOME_TARGET_RATE_RETENTION : null,
      rateGuardrailMet: baseline.sessionKeyEventRate > 0
        ? isAtOrAboveFloatingPointBoundary(
          rate,
          baseline.sessionKeyEventRate * SOCIAL_BUSINESS_OUTCOME_TARGET_RATE_RETENTION,
        ) : null,
      targetMet: baseline.sessionKeyEventRate > 0
        ? sessions >= Math.ceil(baseline.sessions * (1 + SOCIAL_BUSINESS_OUTCOME_TARGET_RELATIVE_LIFT))
          && isAtOrAboveFloatingPointBoundary(
            rate,
            baseline.sessionKeyEventRate * SOCIAL_BUSINESS_OUTCOME_TARGET_RATE_RETENTION,
          )
        : null,
      targetStatus: baseline.sessionKeyEventRate > 0
        ? sessions >= Math.ceil(baseline.sessions * (1 + SOCIAL_BUSINESS_OUTCOME_TARGET_RELATIVE_LIFT))
          && isAtOrAboveFloatingPointBoundary(
            rate,
            baseline.sessionKeyEventRate * SOCIAL_BUSINESS_OUTCOME_TARGET_RATE_RETENTION,
          )
          ? 'met' : 'not-met'
        : 'baseline-rate-zero',
      coverageDays,
      interpretation: 'descriptive-only; channel-level tagged sessions, not causal and not a winner decision',
    };
  }
  return {
    status: dataEndDate <= addUtcDays(targetDate, 6) ? 'follow-up-in-progress' : 'follow-up-observation-missing',
    targetDate,
    baselineSessions: baseline.sessions,
    baselineSessionKeyEventRate: baseline.sessionKeyEventRate,
  };
}

function statusFor(sources, channel, fallback) {
  const value = sources?.[channel]?.status;
  return typeof value === 'string' && value ? value : fallback;
}

function latestSnapshotAt(rows, predicate, asOfMs) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      if (!record(row) || !predicate(row)) return false;
      const at = Date.parse(String(row.snapshotAt || (row.date ? `${row.date}T12:00:00.000Z` : '')));
      return Number.isFinite(at) && at <= asOfMs;
    })
    .map((row) => String(row.snapshotAt || `${row.date}T12:00:00.000Z`))
    .sort()
    .at(-1) || null;
}

function buildSourceFreshness({ nativeInsights, sources, asOfMs, tiktokEnabled }) {
  const posts = Array.isArray(nativeInsights?.posts) ? nativeInsights.posts : [];
  const audience = Array.isArray(nativeInsights?.audienceSnapshots) ? nativeInsights.audienceSnapshots : [];
  const siteOutcomes = Array.isArray(nativeInsights?.siteOutcomeSnapshots) ? nativeInsights.siteOutcomeSnapshots : [];
  const followerGains = Array.isArray(nativeInsights?.followerGainSnapshots) ? nativeInsights.followerGainSnapshots : [];
  return Object.fromEntries(SOURCE_FRESHNESS_CONTRACTS.map((contract) => {
    const state = sources?.[contract.source];
    const status = typeof state === 'string' ? state : String(state?.status || 'not-collected-yet');
    const tiktokSource = contract.source === 'tiktok' || contract.source === 'tiktokAudience';
    if (tiktokSource && !tiktokEnabled) {
      return [contract.key, {
        status: 'policy-review-required',
        expectedIntervalHours: contract.intervalHours,
        staleAfterHours: contract.intervalHours * 2,
        lastSuccessAt: null,
        ageHours: null,
      }];
    }
    const fallbackSnapshotAt = contract.metric
      ? latestSnapshotAt(audience, (row) => row.channel === contract.channel && row.metric === contract.metric && row.status === 'available', asOfMs)
      : contract.siteOutcome
        ? latestSnapshotAt(siteOutcomes, (row) => ['available', 'zero-sessions'].includes(row.status), asOfMs)
        : contract.followerGains
          ? latestSnapshotAt(followerGains, (row) => row.channel === contract.channel && row.metric === 'followers-gained' && row.status === 'available', asOfMs)
        : contract.delivery
          ? nativeInsights?.robotDelivery?.coverage === 'complete'
            ? nativeInsights?.robotDelivery?.recordedAt || null
            : null
        : latestSnapshotAt(posts, (row) => row.channel === contract.channel, asOfMs);
    const declaredLastSuccessAt = typeof state === 'object' ? state?.lastSuccessAt : null;
    const declaredLastSuccessMs = Date.parse(String(declaredLastSuccessAt || ''));
    const lastSuccessAt = Number.isFinite(declaredLastSuccessMs) && declaredLastSuccessMs <= asOfMs
      ? declaredLastSuccessAt
      : fallbackSnapshotAt;
    const lastSuccessMs = Date.parse(String(lastSuccessAt || ''));
    const ageHours = Number.isFinite(lastSuccessMs) ? Math.max(0, (asOfMs - lastSuccessMs) / 3_600_000) : null;
    const notConfigured = /account|credential|policy-review|required|scope|external|not-configured|not-collected-yet|history-unavailable/iu.test(status);
    const staleAfterHours = contract.staleAfterHours || contract.intervalHours * 2;
    const freshnessStatus = contract.delivery && status === 'partial' ? 'partial'
      : ageHours === null
      ? contract.delivery ? 'no-successful-collection'
        : notConfigured ? 'not-configured-or-unavailable' : 'no-successful-collection'
      : ageHours > staleAfterHours ? 'stale' : 'fresh';
    return [contract.key, {
      status: freshnessStatus,
      sourceStatus: status,
      expectedIntervalHours: contract.intervalHours,
      staleAfterHours,
      lastSuccessAt: Number.isFinite(lastSuccessMs) ? new Date(lastSuccessMs).toISOString() : null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
    }];
  }));
}

export function utcWeekStart(asOf = new Date()) {
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime())) throw new Error('asOf must be a valid date');
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

/** Keep one private signal per source/status, deduplicated to one snapshot per UTC week. */
export function createWeeklySocialHealthSnapshot(scorecard, previous = null, asOf = new Date()) {
  const generatedAt = new Date(asOf).toISOString();
  const weekStart = utcWeekStart(asOf);
  if (previous?.schemaVersion === 1 && previous.weekStart === weekStart) {
    return { snapshot: previous, deduplicated: true };
  }
  const prior = new Map((Array.isArray(previous?.signals) ? previous.signals : [])
    .map((signal) => [`${signal.source}\u0000${signal.status}`, signal]));
  const signals = [];
  for (const [source, freshness] of Object.entries(scorecard?.sourceFreshness || {})) {
    let status = null;
    if (freshness.status === 'stale') status = 'stale';
    else if (freshness.status === 'no-successful-collection') status = 'no-successful-collection';
    else if (/partial|permission-unavailable|metric-unavailable|api-error|rate-limited|mapping-unavailable|exact-post-ids-missing|incomplete-report|data-loss|threshold|sampled|truncated|metric-restricted|time-zone-unavailable|no-(?:rate-eligible-|registered-)key-events|metadata-unavailable/iu.test(String(freshness.sourceStatus || ''))) {
      status = 'partial';
    }
    if (!status) continue;
    const key = `${source}\u0000${status}`;
    const old = prior.get(key);
    signals.push({
      source,
      status,
      firstSeenAt: old?.firstSeenAt || generatedAt,
      lastSeenAt: generatedAt,
      occurrenceWeeks: old ? Math.min(52, old.occurrenceWeeks + 1) : 1,
    });
  }
  return {
    snapshot: { schemaVersion: 1, weekStart, generatedAt, signals },
    deduplicated: false,
  };
}

/** Build dated descriptive benchmarks and operating targets; never forecast outcomes. */
export function buildSocialGrowthScorecard({
  instagramInsights = null,
  nativeInsights = null,
  publicationLedgers = {},
  audienceSnapshots: requestedAudienceSnapshots = null,
  telegramHistory = null,
  sources = {},
  asOf = new Date(),
  minimumPosts: requestedMinimumPosts = SOCIAL_GROWTH_MINIMUM_POSTS,
} = {}) {
  const minimumPosts = Number(requestedMinimumPosts);
  if (!Number.isSafeInteger(minimumPosts) || minimumPosts < 1) {
    throw new Error('minimumPosts must be a positive safe integer');
  }
  const asOfMs = Date.parse(new Date(asOf).toISOString());
  const nativePosts = Array.isArray(nativeInsights?.posts) ? nativeInsights.posts : [];
  const followerGainSnapshots = Array.isArray(nativeInsights?.followerGainSnapshots) ? nativeInsights.followerGainSnapshots : [];
  const audienceSnapshots = Array.isArray(requestedAudienceSnapshots)
    ? requestedAudienceSnapshots
    : Array.isArray(nativeInsights?.audienceSnapshots) ? nativeInsights.audienceSnapshots : [];
  const tiktokStatus = statusFor(sources, 'tiktok', 'unavailable');
  const linkedinStatus = statusFor(sources, 'linkedinMember', 'unavailable');
  const instagramStatus = statusFor(sources, 'instagram', Array.isArray(instagramInsights?.posts) ? 'available' : 'unavailable');
  const telegramStatus = statusFor(sources, 'telegram', Array.isArray(telegramHistory) || typeof telegramHistory === 'string' ? 'available' : 'unavailable');
  const audienceGrowth = {
    instagram: audienceChangeScorecard(audienceSnapshots, 'instagram', 'followers', asOfMs, statusFor(sources, 'instagramAudience', 'not-collected-yet')),
    tiktok: audienceChangeScorecard(audienceSnapshots, 'tiktok', 'followers', asOfMs, statusFor(sources, 'tiktokAudience', 'not-collected-yet')),
    facebook: audienceChangeScorecard(audienceSnapshots, 'facebook', 'followers', asOfMs, statusFor(sources, 'facebookAudience', 'scope-probe-pending')),
    linkedinMember: audienceChangeScorecard(audienceSnapshots, 'linkedin-member', 'followers', asOfMs, statusFor(sources, 'linkedinAudience', 'post-attributed-only-no-account-snapshot')),
    telegram: audienceChangeScorecard(audienceSnapshots, 'telegram', 'members', asOfMs, statusFor(sources, 'telegramAudience', 'not-collected-yet')),
    youtubeShorts: audienceChangeScorecard(audienceSnapshots, 'youtube-shorts', 'subscribers', asOfMs, statusFor(sources, 'youtubeShortsAudience', 'account-not-configured')),
    threads: audienceChangeScorecard(audienceSnapshots, 'threads', 'followers', asOfMs, statusFor(sources, 'threadsAudience', 'account-not-configured')),
    reddit: audienceChangeScorecard(audienceSnapshots, 'reddit', 'followers', asOfMs, statusFor(sources, 'redditAudience', 'external-review-required')),
  };
  const linkedinFollowerGains = linkedinFollowerGainSummary(
    followerGainSnapshots,
    asOfMs,
    statusFor(sources, 'linkedinFollowerGains', 'not-collected-yet'),
  );
  for (const [channelKey, summary] of Object.entries(audienceGrowth)) {
    const storageChannel = AUDIENCE_STORAGE_CHANNEL_BY_SCORECARD_KEY[channelKey] || channelKey;
    const contract = AUDIENCE_SOURCE_BY_CHANNEL[storageChannel];
    const sourceStatus = sourceStatusValue(sources, contract.source);
    const cycle = nativeInsights?.audienceGrowthCycles?.[storageChannel] || null;
    const baseline = cycle?.currentBaseline || nativeInsights?.audienceBaselines?.[storageChannel] || null;
    audienceGrowth[channelKey] = {
      ...summary,
      growthTarget90d: deriveAudienceGrowthTarget(baseline),
      growthTargetCycle: {
        cycleNumber: Number.isSafeInteger(cycle?.cycleNumber) ? cycle.cycleNumber : baseline ? 1 : null,
        status: cycle?.status || (baseline ? 'active' : 'awaiting-qualified-baseline'),
        lastCompleted: cycle?.lastCompleted || null,
      },
      frozenBaselineComparison: sourceStatus === 'available'
        ? compareAudienceBaseline(audienceSnapshots, baseline, asOfMs)
        : { status: sourceStatus },
    };
  }
  const siteOutcomeSnapshots = Array.isArray(nativeInsights?.siteOutcomeSnapshots) ? nativeInsights.siteOutcomeSnapshots : [];
  const siteOutcomeSourceState = sources?.socialSiteOutcomes || { status: 'not-collected-yet' };
  const siteOutcomeBaselines = Array.isArray(nativeInsights?.siteOutcomeBaselines) ? nativeInsights.siteOutcomeBaselines : [];
  const siteOutcomeGrowth = Object.fromEntries(SOCIAL_GA4_CHANNELS.map((channel) => {
    const metrics = Object.fromEntries(Object.keys(SOCIAL_GA4_ACTION_EVENTS).map((eventName) => {
      const summary = channel === 'tiktok' && tiktokStatus === 'policy-review-required'
        ? {
          status: 'policy-review-required',
          eventName,
          metric: 'session-key-event-rate',
          observations: 0,
          coverageDays: 0,
          sessions: null,
          sessionKeyEventRate: null,
        }
        : siteOutcomeSummary(siteOutcomeSnapshots, channel, eventName, siteOutcomeSourceState, asOfMs);
      const baseline = isSocialGa4SessionKeyEventRateEligible(eventName)
        ? siteOutcomeBaselines.find((item) => item?.channel === channel && item?.eventName === eventName) || null
        : null;
      return [eventName, {
        ...summary,
        baselineSessionKeyEventRate: baseline?.sessionKeyEventRate ?? null,
        baselineSessions: baseline?.sessions ?? null,
        baselineEndDate: baseline?.endDate || null,
        frozenBaselineComparison: baseline
          ? compareSocialSiteOutcomeBaseline(siteOutcomeSnapshots, baseline, siteOutcomeSourceState, asOfMs)
          : { status: summary.status === 'available' ? 'baseline-not-frozen' : summary.status },
      }];
    }));
    const availableMetrics = Object.values(metrics).filter((metric) => metric.status === 'available').length;
    const status = channel === 'tiktok' && tiktokStatus === 'policy-review-required'
      ? 'policy-review-required'
      : availableMetrics ? 'available'
        : Object.values(metrics)[0]?.status || 'not-collected-yet';
    return [channel, { status, attributionLevel: 'tagged-channel-session-only', metrics }];
  }));
  const measuredSiteOutcomeChannels = Object.entries(siteOutcomeGrowth)
    .filter(([, channel]) => Object.values(channel.metrics).some((metric) => metric.status === 'available'))
    .map(([channel]) => channel);
  const notYetMeasuredSiteOutcomeChannels = SOCIAL_GA4_CHANNELS.filter((channel) => !measuredSiteOutcomeChannels.includes(channel));
  const registeredSiteOutcomeEvents = Array.isArray(siteOutcomeSourceState?.registeredEventNames)
    ? SOCIAL_GA4_ACTION_EVENT_NAMES.filter((eventName) => (
      isSocialGa4SessionKeyEventRateEligible(eventName)
      && siteOutcomeSourceState.registeredEventNames.includes(eventName)
    ))
    : [];
  const expectedSiteOutcomePairs = SOCIAL_GA4_CHANNELS.flatMap((channel) => registeredSiteOutcomeEvents
    .map((eventName) => ({ channel, eventName })));
  const pilotPosts = [
    ...nativePosts,
    ...(Array.isArray(instagramInsights?.posts) ? instagramInsights.posts : [])
      .map((row) => ({ ...row, channel: row.channel || 'instagram', postId: row.postId || row.mediaId })),
  ];
  const channelPilots = buildChannelPilotObservability({
    audienceGrowth,
    sources,
    publicationLedgers,
    nativePosts: pilotPosts,
    asOfMs,
  });
  const pilotKeyByGa4Channel = {
    'linkedin-member': 'linkedinMember',
    'youtube-shorts': 'youtubeShorts',
  };
  const activePilotChannels = SOCIAL_GA4_CHANNELS.filter((channel) => {
    const pilot = channelPilots[pilotKeyByGa4Channel[channel] || channel];
    return pilot?.readinessStatus !== 'delivery-held-or-unconfigured'
      && Number.isSafeInteger(pilot?.postIdCoverage?.publishedPosts30d)
      && pilot.postIdCoverage.publishedPosts30d > 0;
  });
  const activePilotSiteOutcomePairs = expectedSiteOutcomePairs.filter(({ channel }) => (
    activePilotChannels.includes(channel)
  ));
  const measuredSiteOutcomePairs = expectedSiteOutcomePairs.filter(({ channel, eventName }) => (
    siteOutcomeGrowth[channel]?.metrics?.[eventName]?.status === 'available'
  ));
  const measuredSiteOutcomePairKeys = new Set(measuredSiteOutcomePairs.map(({ channel, eventName }) => `${channel}\u0000${eventName}`));
  const notYetMeasuredSiteOutcomePairs = expectedSiteOutcomePairs.filter(({ channel, eventName }) => (
    !measuredSiteOutcomePairKeys.has(`${channel}\u0000${eventName}`)
  ));
  const businessOutcomePairStates = activePilotSiteOutcomePairs.map(({ channel, eventName }) => {
    const hasBaseline = siteOutcomeBaselines.some((baseline) => (
      baseline?.channel === channel && baseline?.eventName === eventName
    ));
    const comparisonStatus = siteOutcomeGrowth[channel]?.metrics?.[eventName]?.frozenBaselineComparison?.status || 'not-reported';
    return { hasBaseline, comparisonStatus };
  });
  const qualifiedBaselinePairCount = businessOutcomePairStates.filter((pair) => pair.hasBaseline).length;
  const availableComparisonCount = businessOutcomePairStates
    .filter((pair) => pair.comparisonStatus === 'descriptive-comparison-available').length;
  const pendingFollowupCount = businessOutcomePairStates
    .filter((pair) => pair.hasBaseline && pair.comparisonStatus === 'follow-up-in-progress').length;
  const missingFollowupCount = businessOutcomePairStates
    .filter((pair) => pair.hasBaseline && pair.comparisonStatus === 'follow-up-observation-missing').length;
  const businessOutcomeTargetStatus = !registeredSiteOutcomeEvents.length
    ? 'awaiting-registered-channel-events'
    : !activePilotSiteOutcomePairs.length
      ? 'awaiting-active-pilot-publications'
      : !qualifiedBaselinePairCount
      ? 'awaiting-qualified-channel-event-baselines'
      : missingFollowupCount
        ? availableComparisonCount ? 'partial-with-missing-follow-up' : 'follow-up-observation-missing'
        : availableComparisonCount === activePilotSiteOutcomePairs.length
          ? 'all-qualified-comparisons-available'
          : availableComparisonCount
            ? 'partial-qualified-comparisons-available'
            : pendingFollowupCount
              ? 'qualified-baseline-follow-up-in-progress'
              : 'qualified-baseline-comparison-pending';
  const notYetMeasuredChannels = Object.entries(audienceGrowth)
    .filter(([, metric]) => metric.status !== 'available')
    .map(([channel]) => channel);
  const result = {
    schemaVersion: 9,
    generatedAt: new Date(asOfMs).toISOString(),
    baselineWindowDays: SOCIAL_GROWTH_BASELINE_DAYS,
    baselineAsOf: new Date(asOfMs).toISOString(),
    minimumPosts,
    growthObjective: {
      status: 'default',
      primaryMetric: 'net-followers-per-channel',
      primaryMetricMeasurement: {
        status: notYetMeasuredChannels.length ? 'incomplete' : 'available',
        notYetMeasuredChannels,
        channelLevelCaveats: {
          linkedinMember: 'post-attributed follower gains are not account-level net growth',
          telegram: 'member-count history does not attribute change to individual posts',
        },
      },
      secondaryMetric: 'qualified-social-attributed-sessions-per-channel-and-registered-event',
      qualityGuardrailMetric: 'registered-key-event-session-rate-per-channel-and-event',
      secondaryMetricMeasurement: {
        status: !measuredSiteOutcomePairs.length ? 'not-yet-measured'
          : notYetMeasuredSiteOutcomePairs.length ? 'partial' : 'available',
        measuredChannels: measuredSiteOutcomeChannels,
        notYetMeasuredChannels: notYetMeasuredSiteOutcomeChannels,
        registeredEvents: registeredSiteOutcomeEvents,
        measuredChannelEventPairs: measuredSiteOutcomePairs,
        notYetMeasuredChannelEventPairs: notYetMeasuredSiteOutcomePairs,
        minimumDailyObservations: SOCIAL_SITE_OUTCOME_MINIMUM_DAYS,
        minimumSessions: SOCIAL_SITE_OUTCOME_MINIMUM_SESSIONS,
        attributionLevel: 'tagged-channel-session-only; not per-post unless the destination itself is post-specific',
        qualityGuardrail: 'compare registered-event session rate with its frozen baseline; do not call handoff clicks completed applications',
      },
      targetPolicy: {
        status: 'available-after-qualified-channel-baseline',
        version: SOCIAL_GROWTH_TARGET_POLICY_VERSION,
        horizonDays: SOCIAL_GROWTH_TARGET_HORIZON_DAYS,
        paceStretchMultiplier: 1.5,
        startingAudienceFloor: 0.25,
        minimumNetAudienceCount: 1,
        recurrence: 'advance-after-qualified-88-to-92-day-observation-and-new-25-day-baseline',
        scope: 'per-channel; never aggregate across platforms',
      },
      comparison: 'per-channel; frozen-30-day-baseline-required-for-recurring-90-day-decisions',
      businessOutcomeTarget: {
        metric: 'qualified-social-attributed-sessions-per-channel-and-registered-event',
        horizonDays: SOCIAL_GROWTH_TARGET_HORIZON_DAYS,
        minimumRelativeLift: SOCIAL_BUSINESS_OUTCOME_TARGET_RELATIVE_LIFT,
        minimumBaselineSessions: SOCIAL_SITE_OUTCOME_MINIMUM_SESSIONS,
        rateGuardrailRetention: SOCIAL_BUSINESS_OUTCOME_TARGET_RATE_RETENTION,
        scope: 'per-channel-and-event; only after a qualified frozen baseline',
        interpretation: 'default operating target; descriptive comparison, not causal attribution or a revenue forecast',
      },
      businessOutcomeTargetCoverage: {
        registeredUtmChannelEventPairs: expectedSiteOutcomePairs.length,
        activePilotChannelEventPairs: activePilotSiteOutcomePairs.length,
        activePilotQualifiedFrozenBaselinePairs: qualifiedBaselinePairCount,
        activePilotAvailableComparisons: availableComparisonCount,
        activePilotPendingFollowups: pendingFollowupCount,
        activePilotMissingFollowups: missingFollowupCount,
      },
      businessOutcomeTargetStatus,
      decisionMode: 'descriptive-until-predeclared-experiment-meets-sample-and-guardrails',
    },
    interpretation: 'Dated rolling descriptive benchmarks; per-channel stretch goals appear only after a frozen baseline. No combined target, forecast, or causal claim. Rates stay separate by channel and event; missing metrics are not imputed as zero.',
    sourceCoverage: {
      instagram: instagramStatus,
      tiktok: tiktokStatus,
      linkedinMember: linkedinStatus,
      linkedinFollowerGains: statusFor(sources, 'linkedinFollowerGains', 'not-collected-yet'),
      facebook: statusFor(sources, 'facebook', 'scope-probe-pending'),
      telegram: telegramStatus,
      reddit: statusFor(sources, 'reddit', 'external-review-required'),
      youtubeShorts: statusFor(sources, 'youtubeShorts', 'account-not-configured'),
      linkedinCompanyPage: statusFor(sources, 'linkedinCompanyPage', 'organization-social-permission-missing'),
      x: statusFor(sources, 'x', 'account-and-oauth-not-configured'),
      whatsappChannels: statusFor(sources, 'whatsappChannels', 'account-and-oauth-not-configured'),
      audience: Object.fromEntries(Object.entries(AUDIENCE_SOURCE_BY_CHANNEL)
        .map(([channel, contract]) => [channel, statusFor(sources, contract.source, 'not-collected-yet')])),
      socialSiteOutcomes: statusFor(sources, 'socialSiteOutcomes', 'not-collected-yet'),
      socialRobotDelivery: statusFor(sources, 'socialRobotDelivery', 'not-collected-yet'),
    },
    sourceFreshness: buildSourceFreshness({
      nativeInsights,
      sources,
      asOfMs,
      tiktokEnabled: tiktokStatus !== 'policy-review-required',
    }),
    instagramCommunityResponse: communityResponseSummary(nativeInsights?.communityOutcomes, asOfMs),
    socialRobotDelivery: summarizeSocialRobotDelivery(nativeInsights?.robotDelivery, new Date(asOfMs)),
    audienceGrowth,
    linkedinFollowerGains,
    siteOutcomeGrowth,
    channelPilots,
    channels: {
      instagram: instagramScorecard(instagramInsights, asOfMs, instagramStatus, minimumPosts),
      tiktok: tiktokScorecard(nativePosts.filter((row) => row.channel === 'tiktok'), asOfMs, tiktokStatus, minimumPosts),
      linkedinMember: linkedinScorecard(nativePosts, asOfMs, linkedinStatus, minimumPosts),
      facebook: {
        status: statusFor(sources, 'facebook', 'scope-probe-pending'),
        ...facebookScorecard(nativePosts, asOfMs, statusFor(sources, 'facebook', 'scope-probe-pending'), minimumPosts),
      },
      telegram: telegramScorecard(telegramHistory, asOfMs, telegramStatus),
      reddit: {
        status: statusFor(sources, 'reddit', 'external-review-required'),
        measurementWindow: 'no live automated delivery in the current repository path',
        baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
        metrics: {},
      },
      youtubeShorts: {
        status: statusFor(sources, 'youtubeShorts', 'account-not-configured'),
        measurementWindow: 'candidate channel; no account or OAuth identity configured',
        baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
        metrics: {},
      },
    },
  };
  result.channels.threads = {
    status: statusFor(sources, 'threads', 'account-not-configured'),
    measurementWindow: 'candidate channel; no account or OAuth identity configured',
    baselineDays: SOCIAL_GROWTH_BASELINE_DAYS,
    metrics: {},
  };
  return result;
}

export function renderSocialGrowthScorecard(scorecard) {
  const lines = [
    `# Social growth scorecard — ${scorecard.generatedAt}`,
    '',
    `Benchmark mobile al ${scorecard.baselineAsOf}: ultimi ${scorecard.baselineWindowDays} giorni · minimo ${scorecard.minimumPosts} post per metrica.`,
    '',
    '| Canale | Stato | Metrica | Mediana 30g | Campioni |',
    '|---|---|---|---:|---:|',
  ];
  for (const [channelName, channel] of Object.entries(scorecard.channels || {})) {
    const metrics = Object.entries(channel.metrics || {});
    if (!metrics.length) {
      lines.push(`| ${channelName} | ${channel.status} | — | — | 0 |`);
      continue;
    }
    for (const [metricName, metricResult] of metrics) {
      const baseline = metricResult.baselineMedian ?? metricResult.baseline ?? null;
      lines.push(`| ${channelName} | ${metricResult.status || channel.status} | ${metricName} | ${baseline ?? '—'} | ${metricResult.observations ?? 0} |`);
    }
  }
  lines.push(
    '',
    '## Pilot readiness by channel',
    '',
    '| Canale | Stato | Percorso | Cadenza/dispatch | Sforamenti cap 30g | Post 30g | ID nativi | Copertura ID | Elegibili alla finestra | Join metriche esatto | Promozione |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
  );
  for (const [channelName, pilot] of Object.entries(scorecard.channelPilots || {})) {
    const coverage = pilot.postIdCoverage || {};
    const idRate = Number.isFinite(coverage.exactPostIdCoverageRate)
      ? `${(coverage.exactPostIdCoverageRate * 100).toFixed(1)}%` : coverage.status || '—';
    const joinRate = Number.isFinite(coverage.exactMetricJoinRate)
      ? `${(coverage.exactMetricJoinRate * 100).toFixed(1)}%` : coverage.status || '—';
    const cadence = pilot.cadenceOverrun || {};
    const overrun = Number.isSafeInteger(cadence.overrunDays)
      ? `${cadence.overrunDays} giorni (max ${cadence.maximumPostsPerDay}/${cadence.capPerDay})`
      : cadence.status || '—';
    lines.push(`| ${channelName} | ${pilot.readinessStatus} | ${pilot.deliveryPath} | ${pilot.cadenceCap || '—'} | ${overrun} | ${coverage.publishedPosts30d ?? '—'} | ${coverage.exactPostIds30d ?? '—'} | ${idRate} | ${coverage.eligibleForMetrics ?? '—'} | ${joinRate} | ${pilot.promotionStatus} |`);
  }
  lines.push('', 'La cadenza descrive i job pianificati e le opzioni di dispatch; i cap atomici sono applicati al confine comune dei publisher abilitati. Gli sforamenti confrontano i ledger aggregati con i cap dichiarati sugli ultimi 30 giorni Europe/Zurich; Telegram storico usa raggruppamento conservativo dei digest, Facebook misura gli slot pianificati, e Instagram Stories resta non osservabile nel ledger. Le stop rule governano il pilot. La copertura mostra solo conteggi aggregati; nessun ID nativo viene incluso nel report.');
  if (String(scorecard.channelPilots?.telegram?.postIdCoverage?.publicationCountBasis || '')
    .includes('legacy-send-time-cluster-inference')) {
    lines.push('Le righe Telegram storiche sono raggruppate per timestamp di invio entro 5 secondi; i nuovi invii usano una chiave univoca per messaggio.');
  }
  lines.push(
    '',
    '## Net audience change — rolling 30 days',
    '',
    '| Canale | Stato | Metrica | Netto 30g mobile | Copertura | Baseline 30g | Obiettivo netto 90g (+25% min.) | Seguito/ciclo | Target per finestra raggiunto |',
    '|---|---|---|---:|---:|---:|---:|---|---|',
  );
  for (const [channelName, metric] of Object.entries(scorecard.audienceGrowth || {})) {
    const frozen = metric.frozenBaselineComparison || {};
    const target = metric.growthTarget90d || {};
    const followup = frozen.followupNetChange === undefined
      ? frozen.status || '—'
      : `${frozen.followupNetChange} (${frozen.followupWindowDays}g)`;
    const targetValue = target.status === 'available'
      ? `${target.targetAudienceValue} (+${target.targetNetChange})`
      : target.status || '—';
    const cycle = metric.growthTargetCycle || {};
    const cycleLabel = `ciclo ${cycle.cycleNumber ?? '—'} (${cycle.status || '—'})`;
    const targetMet = frozen.targetMet === true ? `sì (soglia +${frozen.targetNetChangeForObservedWindow})`
      : frozen.targetMet === false ? `no (soglia +${frozen.targetNetChangeForObservedWindow})` : '—';
    lines.push(`| ${channelName} | ${metric.status} | ${metric.metric} | ${metric.netChange ?? '—'} | ${metric.coverageDays}/${metric.observations} | ${frozen.baselineNetChange ?? '—'} | ${targetValue} | ${followup} · ${cycleLabel} | ${targetMet} |`);
  }
  const businessTarget = scorecard.growthObjective?.businessOutcomeTarget || {};
  const businessTargetCoverage = scorecard.growthObjective?.businessOutcomeTargetCoverage || {};
  lines.push(
    '',
    'Copertura target GA4: coppie canale/evento dei pilot attivi coperte '
      + (businessTargetCoverage.activePilotAvailableComparisons ?? 0)
      + '/'
      + (businessTargetCoverage.activePilotChannelEventPairs ?? 0)
      + '; coppie registrate nel mapping UTM '
      + (businessTargetCoverage.registeredUtmChannelEventPairs ?? 0)
      + '; baseline qualificate '
      + (businessTargetCoverage.activePilotQualifiedFrozenBaselinePairs ?? 0)
      + '; follow-up in corso '
      + (businessTargetCoverage.activePilotPendingFollowups ?? 0)
      + '; follow-up mancanti '
      + (businessTargetCoverage.activePilotMissingFollowups ?? 0)
      + '.',
  );
  lines.push('', `Target operativo GA4: ${scorecard.growthObjective?.businessOutcomeTargetStatus || 'not-reported'}; +${Math.round((businessTarget.minimumRelativeLift || 0) * 100)}% sessioni social-attribuite per canale/evento a ${businessTarget.horizonDays || '—'} giorni, baseline ≥${businessTarget.minimumBaselineSessions || '—'} sessioni, tasso dell'evento non inferiore al ${(businessTarget.rateGuardrailRetention || 0) * 100}% del baseline quando il tasso iniziale è positivo. Confronto descrittivo, non causale.`);
  const linkedinFollowerGains = scorecard.linkedinFollowerGains || {};
  lines.push(
    '',
    '## LinkedIn daily followers gained — descriptive',
    '',
    '| Stato | Guadagni osservati nei giorni coperti | Totale mobile 30g completo | Copertura | Ultimo giorno | Fonte |',
    '|---|---:|---:|---:|---|---|',
    `| ${linkedinFollowerGains.status || 'not-reported'} | ${linkedinFollowerGains.observedFollowerGains ?? '—'} | ${linkedinFollowerGains.followerGains30d ?? '—'} | ${linkedinFollowerGains.coverageDays ?? 0}/${linkedinFollowerGains.expectedDays ?? 30} | ${linkedinFollowerGains.latestDate || '—'} | ${linkedinFollowerGains.sourceStatus || 'not-collected-yet'} |`,
    '',
    'I guadagni LinkedIn sono un conteggio giornaliero a livello di canale: non equivalgono al saldo netto dei follower e non attribuiscono il risultato a un singolo post. I giorni mancanti restano sconosciuti e non sono sommati come zero.',
  );
  lines.push(
    '',
    '## Social-attributed site outcomes — rolling 30 days',
    '',
    '| Canale | Evento | Stato | Tasso sessioni con evento | Sessioni | Giorni | Baseline congelata | Seguito ~90g | Target +25% sessioni |',
    '|---|---|---|---:|---:|---:|---:|---|---|',
  );
  for (const [channelName, channel] of Object.entries(scorecard.siteOutcomeGrowth || {})) {
    for (const [eventName, metric] of Object.entries(channel.metrics || {})) {
      const rate = Number.isFinite(metric.sessionKeyEventRate)
        ? `${(metric.sessionKeyEventRate * 100).toFixed(2)}%` : '—';
      const baselineRate = Number.isFinite(metric.baselineSessionKeyEventRate)
        ? `${(metric.baselineSessionKeyEventRate * 100).toFixed(2)}%` : '—';
      const frozen = metric.frozenBaselineComparison || {};
      const followup = frozen.followupSessionKeyEventRate === undefined
        ? frozen.status || '—'
        : `${(frozen.followupSessionKeyEventRate * 100).toFixed(2)}% (${frozen.coverageDays}g)`;
      const target = Number.isSafeInteger(frozen.targetSessions)
        ? `${frozen.sessions}/${frozen.targetSessions}; ${frozen.targetStatus || 'pending'}`
        : frozen.status || '—';
      lines.push(`| ${channelName} | ${eventName} | ${metric.status} | ${rate} | ${metric.sessions ?? '—'} | ${metric.coverageDays ?? 0} | ${baselineRate} | ${followup} | ${target} |`);
    }
  }
  const community = scorecard.instagramCommunityResponse || {};
  lines.push(
    '',
    '## Instagram community response — settimana UTC',
    '',
  );
  if (!community.week) {
    lines.push(`Stato: ${community.status || 'not-reported'}; non ci sono ancora aggregati delle interazioni osservate.`);
  } else {
    lines.push(`Stato: ${community.status}; settimana ${community.week.weekStart}; ultimo aggiornamento ${community.generatedAt || community.week.generatedAt}; copertura ${community.latestRun?.coverage || 'unknown'}${community.eventsTruncated ? '; diario locale troncato' : ''}${community.coverageGap ? '; possibile interruzione del diario locale, conteggi non completi' : ''}.`);
    lines.push('', '| Superficie | Osservate | Risposte | SLA ≤24h (risposte/eligible) | Pendenti <24h | Senza risposta >24h | Età ignota | Latenze <1/1–4/4–24/>24h | Escalation |', '|---|---:|---:|---:|---:|---:|---:|---|---:|');
    for (const [surface, metrics] of Object.entries(community.week.bySurface || {})) {
      const escalationSummary = Object.entries(metrics.escalations || {})
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(', ') || '0';
      const slaEligible = metrics.responsesWithin24h + metrics.responsesAfter24h + metrics.unansweredAfter24h;
      const latency = metrics.latencyBuckets || {};
      const latencySummary = `${latency.under1h || 0}/${latency.oneToFourHours || 0}/${latency.fourTo24Hours || 0}/${latency.over24Hours || 0}`;
      lines.push(`| ${surface} | ${metrics.observed} | ${metrics.responded} | ${metrics.responsesWithin24h}/${slaEligible} | ${metrics.pendingWithin24h} | ${metrics.unansweredAfter24h} | ${metrics.timestampUnknown} | ${latencySummary} | ${escalationSummary} |`);
    }
    lines.push('', 'Sono conteggi unici del diario locale per interazioni osservate, con paginazione limitata; non sono il volume totale di commenti o DM dell’account. Il worker browser non legge l’età dei DM e li lascia alla revisione umana.');
  }
  const robot = scorecard.socialRobotDelivery || {};
  lines.push(
    '',
    '## Social robot delivery heartbeat',
    '',
  );
  if (!robot.recordedAt) {
    lines.push('Stato: nessun heartbeat registrato; non è possibile distinguere una coda vuota da un host non operativo.');
  } else {
    lines.push(`Stato: ${robot.status}; copertura ${robot.coverage || 'unknown'}; ultima esecuzione ${robot.recordedAt}; età ${robot.ageHours}h; modalità ${robot.mode}; dry-run ${robot.dryRun ? 'sì' : 'no'}; stale dopo ${robot.staleAfterHours}h.`);
    lines.push('', '| Canale | Stato | Esito ultimo run | In coda | Scaduti | Più vecchio (ore / TTL) | Pubblicati nel run | Dispatch conferma falliti |', '|---|---|---|---:|---:|---|---:|---:|');
    for (const channel of robot.channels || []) {
      const oldest = channel.oldestPendingAgeHours === null || channel.oldestPendingAgeHours === undefined
        ? '—'
        : `${channel.oldestPendingAgeHours} / ${channel.oldestPendingTtlHours ?? '—'}`;
      lines.push(`| ${channel.channel} | ${channel.status} | ${channel.outcome} | ${channel.pendingCount ?? '—'} | ${channel.expiredPendingCount ?? '—'} | ${oldest} | ${channel.publishedCount} | ${channel.confirmationDispatchFailureCount} |`);
    }
    lines.push('', 'Il heartbeat contiene solo stato operativo aggregato: nessun ID, caption, URL o dato dell’account. Le righe UI-confirmed vengono tolte dalla coda; gli errori di dispatch della conferma GitHub restano un conteggio separato.');
  }
  lines.push(
    '',
    '## Freshness fonti',
    '',
    '| Fonte | Stato | Ultimo successo | Età (ore) | Stale dopo (ore) |',
    '|---|---|---|---:|---:|',
  );
  for (const [sourceName, freshness] of Object.entries(scorecard.sourceFreshness || {})) {
    lines.push(`| ${sourceName} | ${freshness.status} | ${freshness.lastSuccessAt || '—'} | ${freshness.ageHours ?? '—'} | ${freshness.staleAfterHours} |`);
  }
  lines.push(
    '',
    `Copertura fonti: ${[
      ...Object.entries(scorecard.sourceCoverage || {})
        .filter(([, status]) => typeof status === 'string')
        .map(([name, status]) => `${name}=${status}`),
      ...Object.entries(scorecard.sourceCoverage?.audience || {})
        .map(([name, status]) => `audience.${name}=${status}`),
      `socialSiteOutcomes=${scorecard.sourceCoverage?.socialSiteOutcomes || 'not-reported'}`,
      `socialRobotDelivery=${scorecard.sourceCoverage?.socialRobotDelivery || 'not-reported'}`,
    ].join(', ')}.`,
    `Copertura metrica follower: ${scorecard.growthObjective?.primaryMetricMeasurement?.status || 'not-reported'}; non misurata per ${scorecard.growthObjective?.primaryMetricMeasurement?.notYetMeasuredChannels?.join(', ') || 'nessun canale indicato'}.`,
    '',
    scorecard.interpretation,
    'Obiettivo operativo predefinito: aumentare i follower per canale; i tassi di sessione con key event GA4 registrato sono l’esito secondario per canale ed evento.',
    'Ogni canale si confronta con il proprio baseline di 30 giorni. Il target numerico resta vuoto finché il baseline non è completo; i dati descrittivi non decidono vincitori né volume. I tassi social sono a livello canale/UTM e non attribuiscono il post senza un URL specifico.',
  );
  return `${lines.join('\n')}\n`;
}
