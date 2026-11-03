#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { collectSocialSiteOutcomeSnapshots } from './lib/social-site-outcomes.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import {
  freezeEligibleSocialSiteOutcomeBaselines,
} from './lib/social-growth-scorecard.mjs';
import {
  mergePrivateSocialSiteOutcomeSnapshots,
  updatePrivateSocialNativeInsights,
} from './lib/social-native-insights-store.mjs';

function parseArgs(argv) {
  const options = { dryRun: false, json: false, asOf: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--as-of') options.asOf = new Date(argv[++index]);
    else if (arg.startsWith('--as-of=')) options.asOf = new Date(arg.slice('--as-of='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.asOf.getTime())) throw new Error('--as-of must be a valid date');
  return options;
}

function sourceState(existing, result, asOf) {
  const now = asOf.toISOString();
  const state = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    status: result.status,
    registeredEventNames: Array.isArray(result.registeredEventNames) ? result.registeredEventNames : [],
    ...(result.status === 'available' ? {
      timeZone: result.timeZone,
      latestDataStartDate: result.startDate,
      latestDataEndDate: result.endDate,
    } : {}),
    lastAttemptAt: now,
    lastCheckedAt: now,
    ...(result.status === 'available' ? { lastSuccessAt: now, latestSnapshotAt: now } : {}),
    ...(result.status !== 'available' ? { reasonCode: result.status } : {}),
  };
  if (result.status === 'available') delete state.reasonCode;
  return state;
}

export async function runSocialSiteOutcomeCollection({
  asOf = new Date(),
  dryRun = false,
  db = null,
  collect = collectSocialSiteOutcomeSnapshots,
} = {}) {
  const result = await collect({ now: asOf });
  if (dryRun) return { ...result, persistence: 'dry-run' };
  const firestore = db || await getFirestoreDb();
  let storageBytes = null;
  await updatePrivateSocialNativeInsights(firestore, (current) => {
    const state = sourceState(current.sources?.socialSiteOutcomes, result, asOf);
    const siteOutcomeSnapshots = mergePrivateSocialSiteOutcomeSnapshots(
      current.siteOutcomeSnapshots,
      result.rows,
      { asOf },
    );
    const siteOutcomeBaselines = freezeEligibleSocialSiteOutcomeBaselines(
      current.siteOutcomeBaselines,
      siteOutcomeSnapshots,
      state,
      asOf,
    );
    return {
      ...current,
      generatedAt: asOf.toISOString(),
      sources: { ...current.sources, socialSiteOutcomes: state },
      siteOutcomeSnapshots,
      siteOutcomeBaselines,
    };
  }, { updatedAt: asOf }).then((saved) => {
    storageBytes = saved.bytes;
  });
  return {
    status: result.status,
    startDate: result.startDate || result.start,
    endDate: result.endDate || result.end,
    registeredEventNames: result.registeredEventNames || [],
    observations: Array.isArray(result.rows) ? result.rows.length : 0,
    storageBytes,
    persistence: 'private-firestore',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runSocialSiteOutcomeCollection(options);
  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else {
    process.stdout.write([
      `GA4 social site outcomes: ${summary.status}`,
      `window=${summary.startDate || 'unknown'}..${summary.endDate || 'unknown'}`,
      `registered=${summary.registeredEventNames?.join(',') || 'none'}`,
      `daily observations=${summary.observations ?? 0}`,
      `storage=${summary.persistence}`,
    ].join(' · ') + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`social-site-outcomes: ${String(error?.message || error).slice(0, 180)}`);
    process.exitCode = 1;
  });
}
