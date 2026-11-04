#!/usr/bin/env node
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { collectInstagramStoryInsights } from './lib/instagram-story-insights.mjs';
import { buildInstagramCapabilityReadiness } from './lib/instagram-publish-readiness.mjs';
import { probeInstagramPageLink } from './lib/instagram-page-link-probe.mjs';
import {
  probeInstagramPermissions,
  probeInstagramPublisherToken,
} from './lib/instagram-publisher-readiness-probes.mjs';
import {
  loadPrivateSocialNativeInsights,
  mergePrivateInstagramStoryState,
  updatePrivateSocialNativeInsights,
} from './lib/social-native-insights-store.mjs';

export function instagramStoryInsightsExitCode(result) {
  return result?.status === 'credentials-missing'
    || result?.status === 'permission-missing'
    || result?.status === 'permission-unavailable'
    || result?.status === 'capability-unavailable'
    || result?.status === 'metrics-unavailable'
    || result?.persistedStatus === 'credentials-missing'
    || result?.persistedStatus === 'permission-missing'
    || result?.persistedStatus === 'permission-unavailable'
    || result?.persistedStatus === 'capability-unavailable'
    || result?.persistedStatus === 'metrics-unavailable'
    || Number(result?.retryableUnavailable) > 0
    ? 2
    : 0;
}

export async function runInstagramStoryInsights({
  env = process.env,
  asOf = new Date(),
  db = null,
  fetchImpl = fetch,
  sleepImpl,
  probePermissions = probeInstagramPermissions,
  probePageLink = probeInstagramPageLink,
  probePublisherToken = probeInstagramPublisherToken,
  getDb = getFirestoreDb,
  loadInsights = loadPrivateSocialNativeInsights,
  updateInsights = updatePrivateSocialNativeInsights,
} = {}) {
  const accessToken = String(env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  const firestore = db || await getDb();
  if (!accessToken) {
    const attemptedAt = new Date(asOf).toISOString();
    const saved = await updateInsights(firestore, (current) => ({
      ...current,
      sources: {
        ...current.sources,
        instagramStoryInsights: {
          ...(current.sources?.instagramStoryInsights || {}),
          status: 'credentials-missing',
          lastAttemptStatus: 'credentials-missing',
          lastAttemptAt: attemptedAt,
        },
      },
    }), { updatedAt: asOf });
    return {
      status: 'credentials-missing',
      persistedStatus: 'credentials-missing',
      snapshots: 0,
      candidates: 0,
      attemptedMetrics: 0,
      requestAttempts: 0,
      persisted: saved.changed !== false,
    };
  }
  const permissionResult = await probePermissions({ userAccessToken: env.FB_USER_ACCESS_TOKEN, fetchImpl });
  const requiredPermissionStatuses = [
    permissionResult?.permissionStatuses?.instagram_basic || 'unavailable',
    permissionResult?.permissionStatuses?.instagram_manage_insights || 'unavailable',
  ];
  const permissionStatus = requiredPermissionStatuses.every((status) => status === 'granted')
    ? 'granted'
    : requiredPermissionStatuses.includes('missing') ? 'missing' : 'unavailable';
  if (permissionStatus !== 'granted') {
    const status = permissionStatus === 'missing' ? 'permission-missing' : 'permission-unavailable';
    const attemptedAt = new Date(asOf).toISOString();
    const saved = await updateInsights(firestore, (current) => ({
      ...current,
      sources: {
        ...current.sources,
        instagramStoryInsights: {
          ...(current.sources?.instagramStoryInsights || {}),
          status,
          permissionStatus,
          lastAttemptStatus: status,
          lastAttemptAt: attemptedAt,
        },
      },
    }), { updatedAt: asOf });
    return {
      status,
      persistedStatus: status,
      permissionStatus,
      snapshots: 0,
      candidates: 0,
      attemptedMetrics: 0,
      requestAttempts: 0,
      persisted: saved.changed !== false,
    };
  }
  const [pageLinkResult, publisherTokenResult] = await Promise.all([
    probePageLink({
      pageId: env.FB_PAGE_ID,
      userAccessToken: env.FB_USER_ACCESS_TOKEN,
      instagramAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      publisherAccessToken: accessToken,
      fetchImpl,
    }),
    probePublisherToken({
      instagramAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      accessToken,
      fetchImpl,
    }),
  ]);
  const accountReadiness = {
    pageLinkStatus: pageLinkResult?.pageLinkStatus || 'unavailable',
    publisherPageBindingStatus: pageLinkResult?.publisherTokenSourceStatus || 'unavailable',
    publisherAccountStatus: publisherTokenResult?.publisherTokenStatus || 'unavailable',
    pageAnalyzeTaskStatus: pageLinkResult?.pageTaskStatuses?.analyze || 'unavailable',
  };
  const insightReadiness = buildInstagramCapabilityReadiness({
    permissionStatuses: permissionResult?.permissionStatuses,
    pageTaskStatuses: pageLinkResult?.pageTaskStatuses,
    pageLinkStatus: pageLinkResult?.pageLinkStatus,
    publisherTokenSourceStatus: pageLinkResult?.publisherTokenSourceStatus,
    publisherTokenStatus: publisherTokenResult?.publisherTokenStatus,
  }).insights;
  const accountReady = insightReadiness.state === 'ready';
  if (!accountReady) {
    const status = 'capability-unavailable';
    const attemptedAt = new Date(asOf).toISOString();
    const saved = await updateInsights(firestore, (current) => ({
      ...current,
      sources: {
        ...current.sources,
        instagramStoryInsights: {
          ...(current.sources?.instagramStoryInsights || {}),
          status,
          ...accountReadiness,
          lastAttemptStatus: status,
          lastAttemptAt: attemptedAt,
        },
      },
    }), { updatedAt: asOf });
    return {
      status,
      persistedStatus: status,
      ...accountReadiness,
      snapshots: 0,
      candidates: 0,
      attemptedMetrics: 0,
      requestAttempts: 0,
      persisted: saved.changed !== false,
    };
  }
  const existing = await loadInsights(firestore, { asOf });
  const result = await collectInstagramStoryInsights({
    publications: existing.instagramStoryPublications,
    existing: existing.instagramStorySnapshots,
    accessToken,
    asOf,
    fetchImpl,
    ...(sleepImpl ? { sleepImpl } : {}),
  });
  const additions = Array.isArray(result.additions) ? result.additions : [];
  const hasAvailableMetrics = additions.some((row) => row.availableMetrics?.length > 0);
  const attemptedAt = new Date(asOf).toISOString();
  let persistedStatus = result.status;
  const saved = await updateInsights(firestore, (current) => {
    const previousState = current.sources?.instagramStoryInsights || {};
    const retainPreviousFailure = result.status === 'no-ready-stories'
      && ['credentials-missing', 'metrics-unavailable', 'partial-metrics'].includes(previousState.status);
    persistedStatus = retainPreviousFailure ? previousState.status : result.status;
    const instagramStoryState = mergePrivateInstagramStoryState(current, {
      snapshotAdditions: additions,
      asOf,
    });
    return {
      ...current,
      sources: {
        ...current.sources,
        instagramStoryInsights: {
          ...previousState,
          status: persistedStatus,
          lastAttemptStatus: result.status,
          lastAttemptAt: attemptedAt,
          ...(hasAvailableMetrics ? { lastSuccessAt: attemptedAt } : {}),
          ...(additions.length ? { latestSnapshotAt: attemptedAt } : {}),
        },
      },
      ...instagramStoryState,
    };
  }, { updatedAt: asOf });
  return {
    status: result.status,
    persistedStatus,
    snapshots: additions.length,
    candidates: result.candidates || 0,
    attemptedMetrics: result.attempted || 0,
    requestAttempts: result.requestAttempts || 0,
    unavailableMetrics: result.unavailable || 0,
    retryableUnavailable: result.retryableUnavailable || 0,
    persisted: saved.changed !== false,
  };
}

async function main() {
  const result = await runInstagramStoryInsights();
  const summary = [
    '# Instagram Story insights',
    '',
    '| Last attempt | Stored source status | Story windows written | Due Stories | Metric requests | HTTP attempts | Unavailable fields | Retryable failures |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    `| ${result.status} | ${result.persistedStatus || result.status} | ${result.snapshots} | ${result.candidates} | ${result.attemptedMetrics} | ${result.requestAttempts} | ${result.unavailableMetrics || 0} | ${result.retryableUnavailable || 0} |`,
    '',
    'Only exact-ID first-hour and 22–24h observations are stored in private Firestore. Missing metrics are not zero; the brief sent to Codex contains aggregates without Story IDs.',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (instagramStoryInsightsExitCode(result) !== 0) {
    process.stderr.write('Instagram Story Insights collection is incomplete; check credentials and metric availability.\n');
    process.exitCode = instagramStoryInsightsExitCode(result);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`instagram-story-insights: ${String(error?.name || 'error')}\n`);
    process.exitCode = 1;
  });
}
