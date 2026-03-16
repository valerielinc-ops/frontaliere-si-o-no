#!/usr/bin/env node
/**
 * Collect border-crossing traffic data and persist to Firestore.
 *
 * Designed to run inside the scheduled GitHub Actions workflow
 * (traffic-scheduler.yml).  Uses GOOGLE_APPLICATION_CREDENTIALS
 * for Firebase auth and GOOGLE_MAPS_API_KEY for the Distance Matrix API.
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=… node scripts/collect-traffic.mjs
 */

import { runTrafficCollection } from '../functions/src/trafficSchedulerCore.js';

const apiKey = process.env.GOOGLE_MAPS_API_KEY;
if (!apiKey) {
  console.error('❌ GOOGLE_MAPS_API_KEY is not set');
  process.exit(1);
}

const { collected, errors } = await runTrafficCollection(apiKey);

if (collected === 0 && errors > 0) {
  console.error(`❌ All ${errors} crossings failed`);
  process.exit(1);
}

console.log(`✅ Done — ${collected} collected, ${errors} errors`);
