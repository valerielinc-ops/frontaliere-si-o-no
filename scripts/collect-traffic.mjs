#!/usr/bin/env node
/**
 * Collect border-crossing traffic data and persist to Firestore.
 *
 * Designed to run inside the scheduled GitHub Actions workflow
 * (traffic-scheduler.yml).  Uses GOOGLE_APPLICATION_CREDENTIALS
 * for Firebase auth and prefers TOMTOM_API_KEY for the live routing provider.
 * GOOGLE_MAPS_API_KEY remains supported as a temporary fallback during migration.
 *
 * After every successful Firestore write the script also mirrors the
 * just-collected state into the on-disk JSON files consumed by the static
 * SEO build (`data/border-wait-current.json` + `data/border-wait-history/*.json`).
 * This eliminates the separate daily snapshot workflow and keeps the static
 * pages as fresh as the last cron run.
 *
 * Usage:
 *   TOMTOM_API_KEY=… node scripts/collect-traffic.mjs
 */

import admin from 'firebase-admin';
import { runTrafficCollection } from '../functions/src/trafficSchedulerCore.js';
import { snapshotBorderWaitFiles } from './snapshot-border-wait-history.mjs';

const tomtomApiKey = process.env.TOMTOM_API_KEY;
const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

if (!tomtomApiKey && !googleApiKey) {
  console.error('❌ Neither TOMTOM_API_KEY nor GOOGLE_MAPS_API_KEY is set');
  process.exit(1);
}

const { collected, errors } = await runTrafficCollection({ tomtomApiKey, googleApiKey });

if (collected === 0 && errors > 0) {
  console.error(`❌ All ${errors} crossings failed — traffic data NOT collected`);
  process.exit(1);
}

if (errors > 0) {
  const failRate = errors / (collected + errors);
  if (failRate > 0.5) {
    console.error(`⚠️ High failure rate: ${collected} collected, ${errors} errors (${Math.round(failRate * 100)}% failure)`);
    process.exit(1);
  }
  console.warn(`⚠️ Partial success: ${collected} collected, ${errors} errors`);
} else {
  console.log(`✅ Done — ${collected} collected, ${errors} errors`);
}

// Mirror Firestore state into data/*.json so the static SEO build always
// sees data as fresh as the last cron run. Firestore is the load-bearing
// path for the SPA — if the JSON write fails we log and move on.
//
// Reuses the firebase-admin app already initialised inside
// `runTrafficCollection()` (it idempotently calls initializeApp once).
try {
  const db = admin.firestore();
  const { slugs, dayFile, currentPath } = await snapshotBorderWaitFiles(db);
  console.log(`✅ Mirrored ${slugs.length} crossings → ${currentPath}`);
  console.log(`✅ Mirrored ${slugs.length} crossings × 24h → ${dayFile}`);
} catch (err) {
  console.warn(`⚠️ JSON mirror failed (Firestore write already succeeded): ${err.message}`);
}
