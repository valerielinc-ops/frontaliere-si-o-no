#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { loadPrivateSocialNativeInsights } from '../lib/social-native-insights-store.mjs';
import { socialCopyRevisionId } from '../lib/social-copy-revision.mjs';

export const NATIVE_BRIEF_MINIMUM_OBSERVATIONS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
export const NATIVE_BRIEF_BASELINE_DAYS = 30;
const WINDOW_TOLERANCE_HOURS = 6;
const PACK_ID_RE = /^[a-f0-9]{16}$/u;
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/u;

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isMetricAvailable(row, name, value) {
  if (Array.isArray(row.availableMetrics)) return row.availableMetrics.includes(name);
  if (record(row.metricStatus) && Object.hasOwn(row.metricStatus, name)) {
    return row.metricStatus[name] === 'available';
  }
  return value !== null && value !== 0;
}

function valueFor(row, name) {
  const value = numeric(row.metrics?.[name] ?? row[name]);
  return isMetricAvailable(row, name, value) ? value : null;
}

function copyFields(row) {
  return record(row.copy) ? row.copy : row;
}

function exactCopyAttribution(row) {
  if (row.copyAttributionStatus === 'exact') return true;
  if (row.copyAttributionStatus) return false;
  return ['ledger-media-id', 'browser-cover-fingerprint'].includes(String(row.matchMethod || '').trim());
}

function exactCopyVariant(row, channel) {
  if (!exactCopyAttribution(row)) return null;
  const copy = copyFields(row);
  const packId = String(copy.copyPackId || '').trim();
  const copySlot = String(copy.copySlot || '').trim();
  const templateId = String(copy.copyTemplateId || '').trim();
  const assignmentMode = String(copy.copyAssignmentMode || '').trim();
  const copyMode = String(copy.copyMode || '').trim();
  const objective = String(copy.copyObjective || '').trim();
  const angleId = String(copy.copyAngleId || '').trim();
  const pillarId = String(copy.copyPillarId || '').trim();
  const copyRevisionId = socialCopyRevisionId({ copyHook: copy.copyHook, copyCta: copy.copyCta });
  if (copyMode !== 'codex' || !PACK_ID_RE.test(packId)
    || !TEMPLATE_ID_RE.test(copySlot) || !TEMPLATE_ID_RE.test(templateId)
    || (angleId && !TEMPLATE_ID_RE.test(angleId))
    || (pillarId && !TEMPLATE_ID_RE.test(pillarId))
    || Boolean(angleId) !== Boolean(pillarId)
    || !['firebase-balanced', 'firebase-winner', 'deterministic', 'deterministic-fallback'].includes(assignmentMode)) return null;
  const experimentId = String(copy.copyExperimentId || '').trim();
  const experimentIdHash = experimentId
    ? createHash('sha256').update(experimentId).digest('hex').slice(0, 8)
    : null;
  return {
    channel,
    kind: String(row.kind || 'unknown'),
    copySlot,
    packId,
    templateId,
    ...(angleId ? { angleId, pillarId } : {}),
    ...(copyRevisionId ? { copyRevisionId } : {}),
    assignmentMode,
    experimentIdHash,
    objective: objective || null,
  };
}

function storyWithinBaseline(row, asOfMs, baselineDays) {
  const publishedMs = Date.parse(String(row.publishedAt || ''));
  return Number.isFinite(publishedMs)
    && publishedMs <= asOfMs
    && publishedMs >= asOfMs - baselineDays * DAY_MS;
}

function summarizeStoryValues(values, minimumObservations, { denominatorAvailable = true } = {}) {
  const finiteValues = values.filter(Number.isFinite);
  const enough = finiteValues.length >= minimumObservations;
  const status = enough
    ? 'descriptive-sample'
    : finiteValues.length
      ? 'insufficient-sample'
      : denominatorAvailable ? 'unavailable' : 'denominator-unavailable';
  return {
    status,
    observations: finiteValues.length,
    median: enough ? Math.round(median(finiteValues) * 1000) / 1000 : null,
  };
}

function buildInstagramStoryBrief(rows, {
  minimumObservations = NATIVE_BRIEF_MINIMUM_OBSERVATIONS,
  asOfMs,
  baselineDays = NATIVE_BRIEF_BASELINE_DAYS,
} = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!record(row) || !storyWithinBaseline(row, asOfMs, baselineDays)
      || !['first-hour', 'near-24h'].includes(row.measurementWindow)) continue;
    const copy = copyFields(row);
    const variant = {
      measurementWindow: row.measurementWindow,
      storyFollowUpFormat: String(row.followUpFormat || 'unknown'),
      copyAttributionBasis: 'linked-source-feed-post-proxy',
      ...(String(row.copyAngleId || '').trim() ? { sourceFeedAngleId: String(row.copyAngleId).trim() } : {}),
      ...(socialCopyRevisionId({ copyHook: copy.copyHook, copyCta: copy.copyCta })
        ? { sourceFeedCopyRevisionId: socialCopyRevisionId({ copyHook: copy.copyHook, copyCta: copy.copyCta }) }
        : row.copyRevisionId ? { sourceFeedCopyRevisionId: row.copyRevisionId } : {}),
    };
    const key = JSON.stringify(variant);
    const group = groups.get(key) || { ...variant, rows: new Map() };
    const storyId = String(row.storyId || '').trim();
    if (!storyId) continue;
    group.rows.set(storyId, row);
    groups.set(key, group);
  }
  const variants = [...groups.values()].map((group) => {
    const metrics = {};
    const storyRows = [...group.rows.values()];
    for (const name of [
      'views', 'reach', 'totalInteractions', 'replies', 'shares', 'follows', 'profileVisits',
      'tapsForward', 'tapsBack', 'exits', 'swipesForward',
    ]) {
      const values = storyRows
        .filter((row) => row.availableMetrics?.includes(name))
        .map((row) => numeric(row.metrics?.[name]))
        .filter(Number.isFinite);
      metrics[name] = summarizeStoryValues(values, minimumObservations);
    }
    const reachObservations = storyRows.filter((row) => (
      row.availableMetrics?.includes('reach') && numeric(row.metrics?.reach) > 0
    ));
    const rateMetrics = {
      totalInteractions: 'totalInteractionsPerThousandReach',
      replies: 'repliesPerThousandReach',
      shares: 'sharesPerThousandReach',
      follows: 'followsPerThousandReach',
      profileVisits: 'profileVisitsPerThousandReach',
    };
    for (const [sourceName, rateName] of Object.entries(rateMetrics)) {
      const rates = reachObservations.flatMap((row) => {
        if (!row.availableMetrics?.includes(sourceName)) return [];
        const reach = numeric(row.metrics?.reach);
        const value = numeric(row.metrics?.[sourceName]);
        return reach > 0 && value !== null ? [(value / reach) * 1000] : [];
      });
      metrics[rateName] = summarizeStoryValues(rates, minimumObservations, {
        denominatorAvailable: reachObservations.length > 0,
      });
    }
    const ages = storyRows.map((row) => numeric(row.snapshotAgeHours)).filter(Number.isFinite);
    return {
      measurementWindow: group.measurementWindow,
      storyFollowUpFormat: group.storyFollowUpFormat,
      copyAttributionBasis: group.copyAttributionBasis,
      ...(group.sourceFeedAngleId ? { sourceFeedAngleId: group.sourceFeedAngleId } : {}),
      ...(group.sourceFeedCopyRevisionId ? { sourceFeedCopyRevisionId: group.sourceFeedCopyRevisionId } : {}),
      observations: group.rows.size,
      medianSnapshotAgeHours: ages.length ? Math.round(median(ages) * 1000) / 1000 : null,
      eligibleForDescription: Object.values(metrics).some((metric) => metric.status === 'descriptive-sample'),
      metrics,
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    available: variants.length > 0,
    minimumObservations,
    baselineDays,
    variants,
    interpretation: 'Recent Story metrics include only publications from the stated baseline and are grouped by exact-ID first-hour or near-24h windows. Story follow-up format is measured directly; sourceFeedAngleId and sourceFeedCopyRevisionId are linked-feed-post proxies and do not describe text rendered into the Story image. Rates are per 1,000 reach and remain unavailable without a positive reach denominator. Counts are descriptive, never winner selection or causal evidence.',
  };
}

function publishedAtMs(row) {
  const parsed = Date.parse(String(row.publishedAt || row.ts || row.day || row.date || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageHours(row) {
  const declared = numeric(row.snapshotAgeHours);
  if (declared !== null) return declared;
  const published = Date.parse(String(row.publishedAt || ''));
  const snapshot = Date.parse(String(row.snapshotAt || ''));
  return Number.isFinite(published) && Number.isFinite(snapshot) ? (snapshot - published) / 3_600_000 : null;
}

function withinBaseline(row, asOfMs) {
  const published = publishedAtMs(row);
  return published !== null && published >= asOfMs - 30 * DAY_MS && published <= asOfMs;
}

function instagramMetrics(row) {
  if (Number(row.windowHours) !== 72) return null;
  const age = ageHours(row);
  if (age === null || age < 0 || Math.abs(age - 72) > WINDOW_TOLERANCE_HOURS) return null;
  const metrics = {};
  for (const name of [
    'reach', 'views', 'saves', 'shares', 'comments', 'profileVisits', 'linkClicks', 'follows',
    'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate',
  ]) metrics[name] = valueFor(row, name);
  const source = String(row.reachSource || row.audienceMetric || (metrics.reach !== null ? 'reach' : '')).toLowerCase();
  const denominatorName = source === 'views' ? 'views' : source === 'reach' ? 'reach' : '';
  const denominator = denominatorName ? metrics[denominatorName] : null;
  if (denominator !== null && denominator > 0) {
    for (const name of ['saves', 'shares', 'comments', 'profileVisits', 'linkClicks', 'follows']) {
      metrics[`${name}PerThousand${denominatorName === 'views' ? 'Views' : 'Reach'}`] = metrics[name] === null
        ? null
        : (metrics[name] / denominator) * 1000;
    }
  }
  return metrics;
}

function tiktokMetrics(row) {
  if (Number(row.windowHours) !== 72) return null;
  const age = ageHours(row);
  if (age === null || age < 0 || Math.abs(age - 72) > WINDOW_TOLERANCE_HOURS) return null;
  const metrics = {};
  for (const name of ['views', 'likes', 'comments', 'shares']) metrics[name] = valueFor(row, name);
  if (metrics.views > 0 && ['likes', 'comments', 'shares'].every((name) => metrics[name] !== null)) {
    metrics.interactionsPerThousandViews = ((metrics.likes + metrics.comments + metrics.shares) / metrics.views) * 1000;
  }
  return metrics;
}

function linkedinMetrics(row) {
  if (row.measurementWindow !== 'first-seven-utc-calendar-days' || Number(row.windowDays) !== 7) return null;
  const metrics = {};
  for (const name of [
    'impression',
    'members_reached',
    'reaction',
    'comment',
    'reshare',
    'link_clicks',
    'post_save',
    'post_send',
    'follower_gained_from_content',
    'profile_view_from_content',
  ]) {
    metrics[name] = valueFor(row, name);
  }
  if (metrics.impression !== null && metrics.impression > 0 && metrics.link_clicks !== null) {
    metrics.linkClicksPerThousandImpressions = (metrics.link_clicks / metrics.impression) * 1000;
  }
  return metrics;
}

function facebookMetrics(row) {
  if (row.measurementWindow !== 'first-72h-after-facebook-created-time'
    || row.publicationTimeBasis !== 'facebook-created-time'
    || Number(row.windowHours) !== 72) return null;
  const age = ageHours(row);
  if (age === null || age < 0 || Math.abs(age - 72) > WINDOW_TOLERANCE_HOURS) return null;
  const metrics = {};
  for (const name of ['mediaViews', 'uniqueViewers', 'reactions', 'clicks']) metrics[name] = valueFor(row, name);
  if (metrics.uniqueViewers !== null && metrics.uniqueViewers > 0) {
    if (metrics.reactions !== null) {
      metrics.reactionsPerThousandUniqueViewers = (metrics.reactions / metrics.uniqueViewers) * 1000;
    }
    if (metrics.clicks !== null) {
      metrics.clicksPerThousandUniqueViewers = (metrics.clicks / metrics.uniqueViewers) * 1000;
    }
  }
  return metrics;
}

function addRows(groups, rows, channel, asOfMs, metricReader) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!record(row) || !withinBaseline(row, asOfMs)) continue;
    const variant = exactCopyVariant(row, channel);
    const metrics = metricReader(row);
    if (!variant || !metrics) continue;
    const key = JSON.stringify(variant);
    const group = groups.get(key) || { ...variant, posts: new Map() };
    const postId = String(row.postId || row.mediaId || row.id || '');
    if (!postId) continue;
    group.posts.set(postId, metrics);
    groups.set(key, group);
  }
}

/** Aggregate native outcomes by exact Codex copy arm without exposing post IDs or text. */
export function buildNativeSocialPerformanceBrief({
  instagramInsights = null,
  nativeInsights = null,
  tiktokDisplayAnalyticsApproved = false,
  minimumObservations = NATIVE_BRIEF_MINIMUM_OBSERVATIONS,
  asOf = new Date(),
} = {}) {
  if (!Number.isSafeInteger(minimumObservations) || minimumObservations < 1) {
    throw new Error('minimumObservations must be a positive safe integer');
  }
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('asOf must be a valid date');
  const groups = new Map();
  addRows(groups, instagramInsights?.posts, 'instagram', asOfMs, instagramMetrics);
  const nativePosts = Array.isArray(nativeInsights?.posts) ? nativeInsights.posts : [];
  if (tiktokDisplayAnalyticsApproved) {
    addRows(groups, nativePosts.filter((row) => row.channel === 'tiktok'), 'tiktok', asOfMs, tiktokMetrics);
  }
  addRows(groups, nativePosts.filter((row) => row.channel === 'linkedin-member'), 'linkedinMember', asOfMs, linkedinMetrics);
  addRows(groups, nativePosts.filter((row) => row.channel === 'facebook'), 'facebook', asOfMs, facebookMetrics);

  const variants = [...groups.values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((group) => {
      const metricNames = new Set([...group.posts.values()].flatMap((metrics) => Object.keys(metrics)));
      const metrics = {};
      for (const name of [...metricNames].sort()) {
        const values = [...group.posts.values()].map((row) => row[name]).filter(Number.isFinite);
        const enough = values.length >= minimumObservations;
        metrics[name] = {
          status: enough ? 'descriptive-sample' : values.length ? 'insufficient-sample' : 'unavailable',
          observations: values.length,
          median: enough ? Math.round(median(values) * 1000) / 1000 : null,
        };
      }
      return {
        channel: group.channel,
        kind: group.kind,
        copySlot: group.copySlot,
        packId: group.packId,
        templateId: group.templateId,
        ...(group.angleId ? { angleId: group.angleId } : {}),
        ...(group.copyRevisionId ? { copyRevisionId: group.copyRevisionId } : {}),
        ...(group.pillarId ? { pillarId: group.pillarId } : {}),
        assignmentMode: group.assignmentMode,
        experimentIdHash: group.experimentIdHash,
        objective: group.objective,
        observations: group.posts.size,
        eligibleForDescription: Object.values(metrics).some((metric) => metric.status === 'descriptive-sample'),
        metrics,
      };
    });
  return {
    schemaVersion: 1,
    source: 'native-social-insights',
    generatedAt: new Date(asOfMs).toISOString(),
    baselineDays: NATIVE_BRIEF_BASELINE_DAYS,
    minimumObservations,
    variants,
    instagramStories: buildInstagramStoryBrief(nativeInsights?.instagramStorySnapshots, {
      minimumObservations,
      asOfMs,
      baselineDays: NATIVE_BRIEF_BASELINE_DAYS,
    }),
    interpretation: 'Descriptive only; native metrics use channel-specific windows and exact post IDs. copyAngleId is the tested editorial angle; copyRevisionId fingerprints its exact hook/CTA wording. Revision fingerprints are diagnostic and do not qualify winners. Story metrics use a recent 30-day baseline, exact first-hour and near-24h windows, and per-reach rates when denominators exist. No winner, causal claim, or cross-platform rate is inferred. Missing metrics are not zero.',
  };
}

async function main() {
  const db = await getFirestoreDb();
  const nativeInsights = await loadPrivateSocialNativeInsights(db);
  const privatePosts = Array.isArray(nativeInsights?.posts) ? nativeInsights.posts : [];
  const brief = buildNativeSocialPerformanceBrief({
    instagramInsights: {
      posts: privatePosts.filter((row) => row.channel === 'instagram')
        .map((row) => ({ ...row, mediaId: row.postId, ...row.metrics })),
    },
    nativeInsights: { ...nativeInsights, posts: privatePosts.filter((row) => row.channel !== 'instagram') },
    tiktokDisplayAnalyticsApproved: process.env.TIKTOK_DISPLAY_ANALYTICS_APPROVED === 'true',
  });
  process.stdout.write(`${JSON.stringify(brief)}\n`);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`native-performance-brief: ${String(error?.message || error).slice(0, 180)}`);
    process.exitCode = 1;
  });
}
