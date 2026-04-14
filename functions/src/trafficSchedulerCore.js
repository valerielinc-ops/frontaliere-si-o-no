/**
 * Traffic Scheduler Core
 *
 * Called by the scheduled GitHub Actions workflow (traffic-scheduler.yml).
 *
 * For each active border crossing the job:
 * 1. Queries a live routing provider for:
 * - Approach traffic: ~500 m before the crossing on the Italian side
 * - Crossing delay: crossing point → Swiss checkpoint (~1 km north)
 * 2. Persists the snapshot to Firestore:
 * - trafficCurrent/{slug} → latest state (overwrite)
 * - trafficHistory/{slug}/snapshots/{snapshotId} → append-only historical record
 */

import admin from 'firebase-admin';
import { slugifyCrossingName, BORDER_CROSSINGS } from './borderCrossingsData.js';

// Re-export so callers that previously imported from this module keep working.
export { slugifyCrossingName, BORDER_CROSSINGS };

const GOOGLE_DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const TOMTOM_CALCULATE_ROUTE_URL = 'https://api.tomtom.com/routing/1/calculateRoute';

function resolveTrafficProvider({ tomtomApiKey, googleApiKey }) {
 if (tomtomApiKey) return 'tomtom';
 if (googleApiKey) return 'google-maps';
 return null;
}

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
export async function getGoogleDistanceMatrix(originLat, originLng, destLat, destLng, apiKey) {
 const url = `${GOOGLE_DISTANCE_MATRIX_URL}` +
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
 durationNormalSec: element.duration.value,
 durationTrafficSec: element.duration_in_traffic?.value ?? element.duration.value,
 };
}

/**
 * Calls the TomTom Routing API for one origin→destination pair.
 * Returns the no-traffic and live-traffic travel times in seconds.
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {number} destLat
 * @param {number} destLng
 * @param {string} apiKey
 * @returns {Promise<{durationNormalSec: number, durationTrafficSec: number}>}
 */
export async function getTomTomRouteTravelTimes(originLat, originLng, destLat, destLng, apiKey) {
 const routePlanningLocations = `${originLat},${originLng}:${destLat},${destLng}`;
 const params = new URLSearchParams({
 key: apiKey,
 traffic: 'true',
 travelMode: 'car',
 routeType: 'fastest',
 routeRepresentation: 'summaryOnly', // 'none' requires computeBestOrder=true
 computeTravelTimeFor: 'all',
 departAt: new Date().toISOString(),
 });

 const url = `${TOMTOM_CALCULATE_ROUTE_URL}/${routePlanningLocations}/json?${params.toString()}`;
 const response = await fetch(url);
 if (!response.ok) {
 let errorBody = '';
 try { errorBody = await response.text(); } catch { /* ignore */ }
 throw new Error(`TomTom Routing HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
 }

 const data = await response.json();
 const summary = data?.routes?.[0]?.summary;
 if (!summary) {
 throw new Error('TomTom Routing API: NO_ROUTE_SUMMARY');
 }

 const durationTrafficSec = summary.travelTimeInSeconds;
 const durationNormalSec =
 summary.noTrafficTravelTimeInSeconds ??
 Math.max(durationTrafficSec - (summary.trafficDelayInSeconds ?? 0), 0);

 if (!Number.isFinite(durationTrafficSec) || !Number.isFinite(durationNormalSec)) {
 throw new Error('TomTom Routing API: INVALID_TRAVEL_TIMES');
 }

 return { durationNormalSec, durationTrafficSec };
}

async function getSegmentTravelTimes(originLat, originLng, destLat, destLng, options) {
 const provider = resolveTrafficProvider(options);
 if (provider === 'tomtom') {
 return getTomTomRouteTravelTimes(originLat, originLng, destLat, destLng, options.tomtomApiKey);
 }
 if (provider === 'google-maps') {
 return getGoogleDistanceMatrix(originLat, originLng, destLat, destLng, options.googleApiKey);
 }
 throw new Error('No live traffic provider configured');
}

/**
 * Fetches traffic data for a single border crossing via two live-routing calls:
 * 1. Approach segment: Italian approach point (≈500 m south) → crossing
 * 2. Crossing segment: crossing → Swiss checkpoint (≈1 km north)
 *
 * @param {{ name: string, lat: number, lng: number }} crossing
 * @param {{ tomtomApiKey?: string, googleApiKey?: string }} options
 */
export async function fetchCrossingTraffic(crossing, options = {}) {
 const { lat, lng } = crossing;
 const provider = resolveTrafficProvider(options);

 if (!provider) {
 throw new Error('No live traffic provider configured');
 }

 // Swiss checkpoint: ≈1 km north of the crossing (same offset used in trafficService.ts)
 const checkpointLat = lat + 0.01;
 // Italian approach point: ≈500 m south of the crossing
 const approachLat = lat - 0.0045;

 const [crossingResult, approachResult] = await Promise.allSettled([
 getSegmentTravelTimes(lat, lng, checkpointLat, lng, options),
 getSegmentTravelTimes(approachLat, lng, lat, lng, options),
 ]);

 let waitTimeMinutes = 0;
 let approachMinutes = 0;

 if (crossingResult.status === 'fulfilled') {
 const { durationNormalSec, durationTrafficSec } = crossingResult.value;
 waitTimeMinutes = Math.max(0, Math.round((durationTrafficSec - durationNormalSec) / 60));
 } else {
 console.warn(`⚠️ Crossing segment failed for ${crossing.name}: ${crossingResult.reason?.message}`);
 }

 if (approachResult.status === 'fulfilled') {
 const { durationNormalSec, durationTrafficSec } = approachResult.value;
 approachMinutes = Math.max(0, Math.round((durationTrafficSec - durationNormalSec) / 60));
 } else {
 console.warn(`⚠️ Approach segment failed for ${crossing.name}: ${approachResult.reason?.message}`);
 }

 // If BOTH segments failed, propagate the error instead of silently returning 0-minute data
 if (crossingResult.status === 'rejected' && approachResult.status === 'rejected') {
 throw new Error(`Both segments failed for ${crossing.name}: ${crossingResult.reason?.message}`);
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
 source: provider,
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
 * - trafficCurrent/{slug} → latest state (overwrite)
 * - trafficHistory/{slug}/snapshots/{snapshotId} → historical append-only
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
 * @param {{ tomtomApiKey?: string, googleApiKey?: string }} options
 * @returns {Promise<{collected: number, errors: number}>}
 */
export async function runTrafficCollection(options = {}) {
 const provider = resolveTrafficProvider(options);
 if (!provider) {
 console.warn('⚠️ Neither TOMTOM_API_KEY nor GOOGLE_MAPS_API_KEY is set – skipping traffic collection');
 return { collected: 0, errors: 0 };
 }

 console.log(`🚦 Starting traffic collection for ${BORDER_CROSSINGS.length} crossings via ${provider}…`);

 const results = [];
 let errors = 0;

 // Process in provider-aware batches to stay below default QPS limits.
 const BATCH_SIZE = provider === 'tomtom' ? 2 : 5;
 const BATCH_DELAY_MS = provider === 'tomtom' ? 1000 : 200;
 for (let i = 0; i < BORDER_CROSSINGS.length; i += BATCH_SIZE) {
 const chunk = BORDER_CROSSINGS.slice(i, i + BATCH_SIZE);
 const settled = await Promise.allSettled(
 chunk.map(c => fetchCrossingTraffic(c, options)),
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

 // Brief pause between chunks to avoid bursting API quota.
 if (i + BATCH_SIZE < BORDER_CROSSINGS.length) {
 await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
 }
 }

 if (results.length > 0) {
 await saveTrafficToFirestore(results);
 }

 console.log(`✅ Collection done – ${results.length} OK, ${errors} errors`);
 return { collected: results.length, errors };
}
