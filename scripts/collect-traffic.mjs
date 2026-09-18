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
import {
  MAX_CROSSING_FAILURE_RATE,
  runIsPublishable,
  runTrafficCollection,
} from '../functions/src/trafficSchedulerCore.js';
import { collectOfficialTrafficSignals } from './lib/official-traffic-sources.mjs';
import { snapshotBorderWaitFiles } from './snapshot-border-wait-history.mjs';

const hereApiKey = process.env.HERE_API_KEY;
const tomtomApiKey = process.env.TOMTOM_API_KEY;
const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
const googleRoutesApiKey = process.env.GOOGLE_ROUTES_API_KEY || googleApiKey;
const mapboxSecretToken = process.env.MAPBOX_SECRET_TOKEN;
const mapboxAccessToken = mapboxSecretToken || process.env.MAPBOX_PUBLIC_TOKEN;
const geoapifyApiKey = process.env.GEOAPIFY_API_KEY;
const graphhopperApiKey = process.env.GRAPHHOPPER_API_KEY;
const openrouteserviceApiKey = process.env.OPENROUTESERVICE_API_KEY;
const stadiaApiKey = process.env.STADIA_API_KEY;
const enableWebcam = process.env.ENABLE_WEBCAM_ANALYSIS === '1';

if (!hereApiKey && !tomtomApiKey && !googleApiKey && !googleRoutesApiKey && !mapboxAccessToken
  && !geoapifyApiKey && !graphhopperApiKey && !openrouteserviceApiKey && !stadiaApiKey) {
  console.error('❌ No routing API key set (HERE/TomTom/Google/Mapbox/Geoapify/GraphHopper/ORS/Stadia)');
  process.exit(1);
}

let officialSignals = null;
try {
  officialSignals = await collectOfficialTrafficSignals({
    swissApiKey: process.env.OPENTRANSPORTDATA_API_KEY,
  });
  const health = officialSignals.sources.map((source) => `${source.id}:${source.status}`).join(', ');
  console.log(`🛰️ Official traffic sources: ${health}`);
} catch (error) {
  // Open data is a signal layer, never a reason to skip the paid/free provider
  // mesh. The provider budget guards remain the load-bearing safety boundary.
  console.warn(`⚠️ Official traffic layer unavailable: ${error.message}`);
}

const { collected, errors, skipped } = await runTrafficCollection({
  hereApiKey,
  tomtomApiKey,
  googleApiKey,
  googleRoutesApiKey,
  mapboxAccessToken,
  mapboxSecretToken,
  geoapifyApiKey,
  graphhopperApiKey,
  openrouteserviceApiKey,
  stadiaApiKey,
  officialSignals: officialSignals?.byCrossing,
  enableWebcam,
});

// Zero collected is a failure however it is reported. `skipped` covers the
// paths that answer `{ collected: 0, errors: 0 }` — no provider configured,
// provider mesh exhausted at preflight, webcam module unavailable: without
// this branch they fell through to the success log, reached the JSON mirror
// and republished a stale snapshot from a run that had fetched nothing.
if (collected === 0) {
  const why = skipped
    ? `collection skipped (${skipped})`
    : errors > 0
      ? `all ${errors} crossings failed`
      : 'no crossing was polled';
  console.error(`❌ Traffic data NOT collected — ${why}`);
  process.exit(1);
}

// `errors` counts CROSSINGS, one per rejected fetchCrossingTraffic() — not the
// two per-segment warnings that precede each of them. The rate is a share of
// the crossings polled, so the denominator is the crossing list. The ceiling
// lives in trafficSchedulerCore so this exit and the Firestore write obey one
// rule: a run that fails here must not have persisted a partial snapshot.
if (!runIsPublishable(collected, errors)) {
  const failRate = errors / (collected + errors);
  console.error(
    `⚠️ High failure rate: ${collected} crossings collected, ${errors} crossings failed `
    + `of ${collected + errors} polled (${(failRate * 100).toFixed(1)}% of crossings, `
    + `ceiling ${(MAX_CROSSING_FAILURE_RATE * 100).toFixed(1)}%)`,
  );
  process.exit(1);
}

if (errors > 0) {
  console.warn(`⚠️ Partial success: ${collected} crossings collected, ${errors} crossings failed`);
} else {
  console.log(`✅ Done — ${collected} crossings collected, 0 failed`);
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
