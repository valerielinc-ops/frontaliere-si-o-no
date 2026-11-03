#!/usr/bin/env node
/** Persist the Mac browser's Instagram Insights snapshots to private Firestore. */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import {
  loadPrivateSocialNativeInsights,
  mergePrivateSocialInsightPosts,
  normalizeInstagramPrivateSnapshots,
  updatePrivateSocialNativeInsights,
} from '../lib/social-native-insights-store.mjs';
import { withSingleFlightLockAsync } from '../lib/single-flight-lock.mjs';

function readSnapshot(file) {
  if (!file || !existsSync(file)) throw new Error('Instagram browser snapshot is missing');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Instagram browser snapshot is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posts)) {
    throw new Error('Instagram browser snapshot must contain a posts array');
  }
  return parsed;
}

function latestIso(...values) {
  return values
    .map((value) => ({ value, time: Date.parse(String(value || '')) }))
    .filter((row) => Number.isFinite(row.time))
    .sort((left, right) => right.time - left.time)[0]?.value || null;
}

function parseArgs(argv) {
  const options = { dryRun: false, keepLocal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot') options.snapshot = argv[++index];
    else if (arg.startsWith('--snapshot=')) options.snapshot = arg.slice('--snapshot='.length);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--keep-local') options.keepLocal = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help && !options.snapshot) throw new Error('--snapshot is required');
  return options;
}

/** Merge validated Instagram rows into the private cross-channel document. */
export async function persistBrowserInsights({
  snapshot,
  dryRun = false,
  keepLocal = false,
  db = null,
  now = new Date(),
} = {}) {
  const parsed = readSnapshot(snapshot);
  const additions = normalizeInstagramPrivateSnapshots(parsed);
  if (additions.length !== parsed.posts.length) {
    throw new Error('Instagram snapshot contains rows that failed private-store validation; local snapshot retained');
  }
  const firestore = db || await getFirestoreDb();
  const existing = await loadPrivateSocialNativeInsights(firestore, { asOf: now });
  const posts = mergePrivateSocialInsightPosts(existing.posts, additions);
  const sourceStatus = additions.length > 0
    ? 'available'
    : existing.sources?.instagram?.status || 'not-collected-yet';
  const nowIso = new Date(now).toISOString();
  const latestSnapshotAt = latestIso(
    ...additions.map((row) => row.snapshotAt),
    existing.sources?.instagram?.latestSnapshotAt,
  );
  const instagramSource = {
    ...(existing.sources?.instagram || {}),
    status: sourceStatus,
    lastAttemptAt: nowIso,
    lastSuccessAt: nowIso,
    ...(latestSnapshotAt ? { latestSnapshotAt } : {}),
  };
  const changed = JSON.stringify({ sources: existing.sources, posts: existing.posts })
    !== JSON.stringify({
      sources: { ...existing.sources, instagram: instagramSource },
      posts,
    });
  if (dryRun) return { status: changed ? 'ready' : 'unchanged', imported: additions.length, posts: posts.length };
  if (changed) {
    await updatePrivateSocialNativeInsights(firestore, (current) => ({
      schemaVersion: 1,
      generatedAt: nowIso,
      sources: {
        ...current.sources,
        instagram: {
          ...(current.sources?.instagram || {}),
          status: sourceStatus,
          lastAttemptAt: latestIso(current.sources?.instagram?.lastAttemptAt, nowIso),
          lastSuccessAt: latestIso(current.sources?.instagram?.lastSuccessAt, nowIso),
          ...(latestIso(current.sources?.instagram?.latestSnapshotAt, latestSnapshotAt)
            ? { latestSnapshotAt: latestIso(current.sources?.instagram?.latestSnapshotAt, latestSnapshotAt) }
            : {}),
        },
      },
      posts: mergePrivateSocialInsightPosts(current.posts, additions),
      audienceSnapshots: Array.isArray(current.audienceSnapshots) ? current.audienceSnapshots : [],
      audienceBaselines: current.audienceBaselines && typeof current.audienceBaselines === 'object'
        ? current.audienceBaselines
        : {},
      ...(current.weeklyHealth ? { weeklyHealth: current.weeklyHealth } : {}),
      ...(current.communityOutcomes ? { communityOutcomes: current.communityOutcomes } : {}),
      ...(current.robotDelivery ? { robotDelivery: current.robotDelivery } : {}),
    }), { updatedAt: now });
  }
  if (!keepLocal) unlinkSync(snapshot);
  return { status: changed ? 'persisted' : 'unchanged', imported: additions.length, posts: posts.length };
}

function usage() {
  return 'node scripts/social-robot/persist-browser-insights.mjs --snapshot STATE_FILE [--dry-run] [--keep-local]';
}

if (isInvokedDirectly(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const lockPath = `${options.snapshot}.persist.lock`;
    const locked = await withSingleFlightLockAsync(lockPath, () => persistBrowserInsights(options));
    if (!locked.acquired) process.stdout.write('{"status":"busy"}\n');
    else process.stdout.write(`${JSON.stringify(locked.value)}\n`);
  }
}
