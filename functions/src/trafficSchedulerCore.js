/**
 * Traffic Scheduler Core
 *
 * Called by the scheduled GitHub Actions workflow (traffic-scheduler.yml).
 *
 * For each active border crossing the job:
 *  1. Queries Google Maps Distance Matrix REST API for:
 *     - Approach traffic: ~500 m before the crossing on the Italian side
 *     - Crossing delay:   crossing point → Swiss checkpoint (~1 km north)
 *  2. Persists the snapshot to Firestore:
 *     - trafficCurrent/{slug}                          → latest state (overwrite)
 *     - trafficHistory/{slug}/snapshots/{snapshotId}   → append-only historical record
 */

import admin from 'firebase-admin';
import { slugifyCrossingName, BORDER_CROSSINGS } from './borderCrossingsData.js';

// Re-export so callers that previously imported from this module keep working.
export { slugifyCrossingName, BORDER_CROSSINGS };

// ─── Google Maps Distance Matrix REST API ─────────────────────

const DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

/**
 * Calls the Google Maps Distance Matrix REST API for one origin→destination pair.
 * Returns normal duration (seconds) and with-traffic duration (seconds).
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {number} destLat
 * @param {number} destLng
 * @param {string} apiKey
 * @returns {Promise<{durationNormalSec: number, durationTrafficSec: number}>}
 */
export async function getDistanceMatrix(originLat, originLng, destLat, destLng, apiKey) {
  const url = `${DISTANCE_MATRIX_URL}` +
    `?origins=${originLat},${originLng}` +
    `&destinations=${destLat},${destLng}` +
    `&mode=driving` +
    `&departure_time=now` +
    `&traffic_model=best_guess` +
    `&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Distance Matrix HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix API: ${data.status} – ${data.error_message ?? ''}`);
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`Route element: ${element?.status ?? 'NO_DATA'}`);
  }

  return {
    durationNormalSec:  element.duration.value,
    durationTrafficSec: element.duration_in_traffic?.value ?? element.duration.value,
  };
}

// ─── Per-crossing traffic measurement ─────────────────────────

/**
 * Fetches traffic data for a single border crossing via two Distance Matrix calls:
 *  1. Approach segment: Italian approach point (≈500 m south) → crossing
 *  2. Crossing segment: crossing → Swiss checkpoint (≈1 km north)
 *
 * @param {{ name: string, lat: number, lng: number }} crossing
 * @param {string} apiKey
 */
export async function fetchCrossingTraffic(crossing, apiKey) {
  const { lat, lng } = crossing;

  // Swiss checkpoint: ≈1 km north of the crossing (same offset used in trafficService.ts)
  const checkpointLat = lat + 0.01;
  // Italian approach point: ≈500 m south of the crossing
  const approachLat = lat - 0.0045;

  const [crossingResult, approachResult] = await Promise.allSettled([
    getDistanceMatrix(lat, lng, checkpointLat, lng, apiKey),
    getDistanceMatrix(approachLat, lng, lat, lng, apiKey),
  ]);

  let waitTimeMinutes = 0;
  let approachMinutes = 0;

  if (crossingResult.status === 'fulfilled') {
    const { durationNormalSec, durationTrafficSec } = crossingResult.value;
    waitTimeMinutes = Math.max(0, Math.round((durationTrafficSec - durationNormalSec) / 60));
  } else {
    console.warn(`⚠️  Crossing segment failed for ${crossing.name}: ${crossingResult.reason?.message}`);
  }

  if (approachResult.status === 'fulfilled') {
    const { durationNormalSec, durationTrafficSec } = approachResult.value;
    approachMinutes = Math.max(0, Math.round((durationTrafficSec - durationNormalSec) / 60));
  } else {
    console.warn(`⚠️  Approach segment failed for ${crossing.name}: ${approachResult.reason?.message}`);
  }

  const totalCrossingMinutes = waitTimeMinutes + approachMinutes;

  let status;
  if (waitTimeMinutes < 5) status = 'green';
  else if (waitTimeMinutes < 15) status = 'yellow';
  else status = 'red';

  // Cloud Functions use UTC by default; derive the local hour in Europe/Rome
  const hour = Number(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false }),
  );
  let direction;
  if (hour >= 6 && hour < 10) direction = 'IT → CH';
  else if (hour >= 16 && hour < 20) direction = 'CH → IT';
  else direction = 'Entrambi';

  return {
    crossingName: crossing.name,
    waitTimeMinutes,
    approachMinutes,
    totalCrossingMinutes,
    status,
    direction,
    source: 'google-maps',
  };
}

// ─── Firebase Admin init ──────────────────────────────────────

export function ensureAdminApp() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  return admin;
}

// ─── Firestore persistence ─────────────────────────────────────

/**
 * Writes a batch of crossing results to Firestore.
 *
 * Collections written:
 *  - trafficCurrent/{slug}                           → latest state (overwrite)
 *  - trafficHistory/{slug}/snapshots/{snapshotId}    → historical append-only
 */
export async function saveTrafficToFirestore(crossingResults) {
  const adm = ensureAdminApp();
  const db = adm.firestore();
  const now = adm.firestore.Timestamp.now();
  // Use the current timestamp (ms) as a chronologically sortable document ID.
  const snapshotId = Date.now().toString();

  const nowDate = new Date();
  const hour = nowDate.getHours();
  const dayOfWeek = nowDate.getDay();

  // Firestore batches are limited to 500 operations; each crossing = 2 writes.
  // With 22 crossings (44 ops) we are well within limits.
  const batch = db.batch();

  for (const result of crossingResults) {
    const slug = slugifyCrossingName(result.crossingName);
    const docData = {
      ...result,
      lastUpdate: now,
      hour,
      dayOfWeek,
    };

    // Current state – overwrite on every run
    const currentRef = db.collection('trafficCurrent').doc(slug);
    batch.set(currentRef, docData);

    // Historical snapshot – append only
    const historyRef = db
      .collection('trafficHistory')
      .doc(slug)
      .collection('snapshots')
      .doc(snapshotId);
    batch.set(historyRef, docData);
  }

  await batch.commit();
  console.log(`✅ Saved traffic snapshot for ${crossingResults.length} crossings (snapshotId=${snapshotId})`);
}

// ─── Main entry point ─────────────────────────────────────────

/**
 * Collects traffic data for all active border crossings and persists it to Firestore.
 * This is the single entry point called by all three onSchedule functions.
 *
 * @param {string} apiKey  Google Maps API key (from Secret Manager)
 * @returns {Promise<{collected: number, errors: number}>}
 */
export async function runTrafficCollection(apiKey) {
  if (!apiKey) {
    console.warn('⚠️  GOOGLE_MAPS_API_KEY is not set – skipping traffic collection');
    return { collected: 0, errors: 0 };
  }

  console.log(`🚦 Starting traffic collection for ${BORDER_CROSSINGS.length} crossings…`);

  const results = [];
  let errors = 0;

  // Process in small parallel batches to respect Google Maps rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < BORDER_CROSSINGS.length; i += BATCH_SIZE) {
    const chunk = BORDER_CROSSINGS.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      chunk.map(c => fetchCrossingTraffic(c, apiKey)),
    );

    for (let j = 0; j < settled.length; j++) {
      const res = settled[j];
      if (res.status === 'fulfilled') {
        results.push(res.value);
      } else {
        console.error(`❌ ${chunk[j].name}: ${res.reason?.message}`);
        errors++;
      }
    }

    // Brief pause between chunks to avoid bursting API quota
    if (i + BATCH_SIZE < BORDER_CROSSINGS.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (results.length > 0) {
    await saveTrafficToFirestore(results);
  }

  console.log(`✅ Collection done – ${results.length} OK, ${errors} errors`);
  return { collected: results.length, errors };
}
