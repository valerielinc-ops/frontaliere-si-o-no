#!/usr/bin/env node
/**
 * Collect border-crossing traffic data and persist to Firestore.
 *
 * Designed to run inside the scheduled GitHub Actions workflow
 * (traffic-scheduler.yml).  Uses GOOGLE_APPLICATION_CREDENTIALS
 * for Firebase auth and prefers TOMTOM_API_KEY for the live routing provider.
 * GOOGLE_MAPS_API_KEY remains supported as a temporary fallback during migration.
 *
 * Usage:
 *   TOMTOM_API_KEY=… node scripts/collect-traffic.mjs
 */

import { runTrafficCollection } from '../functions/src/trafficSchedulerCore.js';

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
