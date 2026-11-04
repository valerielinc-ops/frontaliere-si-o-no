#!/usr/bin/env node
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { collectInstagramStoryInsights } from './lib/instagram-story-insights.mjs';
import {
  loadPrivateSocialNativeInsights,
  mergePrivateInstagramStoryPublications,
  mergePrivateInstagramStorySnapshots,
  updatePrivateSocialNativeInsights,
} from './lib/social-native-insights-store.mjs';

export function instagramStoryInsightsExitCode(result) {
  return result?.status === 'credentials-missing'
    || result?.status === 'metrics-unavailable'
    || result?.persistedStatus === 'credentials-missing'
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
  getDb = getFirestoreDb,
  loadInsights = loadPrivateSocialNativeInsights,
  updateInsights = updatePrivateSocialNativeInsights,
} = {}) {
  const accessToken = String(env.INSTAGRAM_ACCESS_TOKEN || '').trim()
    || String(env.FB_PAGE_ACCESS_TOKEN || '').trim();
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
    const instagramStoryPublications = mergePrivateInstagramStoryPublications(
      current.instagramStoryPublications,
      [],
      { asOf },
    );
    const retainedStoryIds = new Set(instagramStoryPublications.map(({ storyId }) => storyId));
    const instagramStorySnapshots = mergePrivateInstagramStorySnapshots(
      current.instagramStorySnapshots,
      additions,
      { asOf, publicationIds: retainedStoryIds },
    );
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
      instagramStoryPublications,
      instagramStorySnapshots,
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
