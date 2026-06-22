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
const HERE_ROUTER_URL = 'https://router.hereapi.com/v8/routes';
const TT_FLOW_URL = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0';
const MAX_FLOW_DELAY_MIN = 45;
// HERE "Time Aware Routing" free tier is 5 000 transactions / calendar month
// (Base Plan v6.0 Tier 1, 0–5000 = €0; May 2026 over-ran to 8 962 → first
// invoice). Each crossing costs 2 transactions (crossing segment +
// approach segment), so a full run of 26 crossings = 52. We hard-cap monthly
// HERE usage below the free tier and skip further runs once the budget is
// exhausted — the deterministic guarantee that we never pay, independent of how
// GitHub schedules the cron. Override via the HERE_MONTHLY_BUDGET env var.
const HERE_MONTHLY_BUDGET = Number(process.env.HERE_MONTHLY_BUDGET || 4500);
const WEBCAM_QUEUE_MIN_WAIT_MIN = 8;
const WEBCAM_CLEAR_HIGH_WAIT_MIN = 30;
const WEBCAM_CLEAR_APPROACH_MAX_MIN = 5;
const WEBCAM_CLEAR_FALLBACK_WAIT_MIN = 4;
// Minimum congestionScore at which a good-visibility webcam is trusted to
// drive a PRIMARY wait estimate (no live routing). Below this we treat the
// road as effectively clear and report 0 — see estimateWaitFromCongestion.
const WEBCAM_PRIMARY_MIN_SCORE = 0.4;

/**
 * Coarse, conservative mapping from a webcam congestion score (0..1) to an
 * estimated border wait in minutes. Used ONLY as a PRIMARY fallback when no
 * live routing datum exists for a crossing (both provider segments failed, or
 * no provider/collection is configured for it). When live routing data IS
 * available the routing estimate wins and the webcam only sanity-adjusts it via
 * applyWebcamTrafficSanity — this function NEVER overrides a successful provider
 * estimate.
 *
 * A camera cannot measure exact minutes: image variance is only a rough proxy
 * for "how many vehicles sit in the road zone". The mapping is therefore a
 * documented, monotonic step function with a hard 30-minute cap. It is an
 * UNVALIDATED heuristic — see the PR `## Non implementato` revert-trigger.
 *
 * Breakpoints (monotonic, non-decreasing):
 *   null / non-finite / < 0.40 → 0   (no usable signal / road effectively clear)
 *   0.40 – < 0.60              → 8   (light queue forming; aligns with WEBCAM_QUEUE_MIN_WAIT_MIN)
 *   0.60 – < 0.80              → 15  (moderate congestion)
 *   0.80 – < 0.95              → 22  (heavy congestion)
 *   ≥ 0.95                     → 30  (cap — saturated frame, treat as severe)
 *
 * @param {number|null|undefined} congestionScore - 0..1 from webcam CV, or null
 * @returns {number} estimated wait in whole minutes (0..30)
 */
export function estimateWaitFromCongestion(congestionScore) {
 if (congestionScore == null || !Number.isFinite(congestionScore)) return 0;
 if (congestionScore < WEBCAM_PRIMARY_MIN_SCORE) return 0;
 if (congestionScore < 0.60) return 8;
 if (congestionScore < 0.80) return 15;
 if (congestionScore < 0.95) return 22;
 return 30;
}

/**
 * Pick the live-routing provider by preference order.
 *
 * TomTom is preferred over HERE (#2180): HERE bills every routing call as a
 * "Time Aware Routing" transaction and the scheduled demand (~21k/month) is
 * ~4.6× HERE's 4,500/month free tier, so HERE exhausts ~day 6 and the run
 * already falls back to TomTom for the rest of the month — i.e. TomTom already
 * serves the large majority of the month. TomTom's free tier (2,500 req/day ≈
 * 75k/month) comfortably covers full demand and is unmetered here, so making it
 * primary keeps live routing consistent ALL month at $0 and stops the real
 * monthly HERE overage (6,350/4,500 billed in 2026-06). HERE stays as the
 * fallback when no TomTom key is configured (its budget guard below still
 * caps any spend). Google Maps is the last resort.
 *
 * @param {{hereApiKey?:string, tomtomApiKey?:string, googleApiKey?:string}} keys
 * @returns {'tomtom'|'here'|'google-maps'|null}
 */
export function resolveTrafficProvider({ hereApiKey, tomtomApiKey, googleApiKey }) {
 if (tomtomApiKey) return 'tomtom';
 if (hereApiKey) return 'here';
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

/**
 * Calls HERE Maps Routing API v8 for one origin→destination pair.
 * Returns baseDuration (free-flow) and duration (with traffic) in seconds.
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {number} destLat
 * @param {number} destLng
 * @param {string} apiKey
 * @returns {Promise<{durationNormalSec: number, durationTrafficSec: number}>}
 */
export async function getHereMapsRouteTravelTimes(originLat, originLng, destLat, destLng, apiKey) {
 const params = new URLSearchParams({
 apikey: apiKey,
 origin: `${originLat},${originLng}`,
 destination: `${destLat},${destLng}`,
 transportMode: 'car',
 return: 'summary',
 departureTime: new Date().toISOString(),
 });
 const res = await fetch(`${HERE_ROUTER_URL}?${params}`);
 if (!res.ok) {
 const body = await res.text().catch(() => '');
 throw new Error(`HERE HTTP ${res.status}: ${body.slice(0, 200)}`);
 }
 const data = await res.json();
 const summary = data?.routes?.[0]?.sections?.[0]?.summary;
 if (!summary) throw new Error('HERE: NO_ROUTE_SUMMARY');
 return {
 durationNormalSec: summary.baseDuration,
 durationTrafficSec: summary.duration,
 };
}

/**
 * Calls TomTom Traffic Flow API for a given point.
 * Returns speed ratio (currentSpeed/freeFlowSpeed): 1.0 = free, 0.0 = standstill.
 * Uses tile-based endpoint (50k/day free quota).
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} apiKey
 * @returns {Promise<{ratio: number, confidence: number, currentSpeed: number, freeFlowSpeed: number}>}
 */
export async function getTomTomFlowSegmentData(lat, lng, apiKey) {
 const url = `${TT_FLOW_URL}/16/json?key=${apiKey}&point=${lat},${lng}&unit=KMPH`;
 const res = await fetch(url);
 if (!res.ok) throw new Error(`TomTom Flow HTTP ${res.status}`);
 const d = await res.json();
 const seg = d?.flowSegmentData;
 if (!seg) throw new Error('TomTom Flow: NO_SEGMENT');
 return {
 ratio: seg.currentSpeed / seg.freeFlowSpeed,
 confidence: seg.confidence,
 currentSpeed: seg.currentSpeed,
 freeFlowSpeed: seg.freeFlowSpeed,
 };
}

async function getSegmentTravelTimes(originLat, originLng, destLat, destLng, options) {
 const provider = resolveTrafficProvider(options);
 if (provider === 'here') {
 return getHereMapsRouteTravelTimes(originLat, originLng, destLat, destLng, options.hereApiKey);
 }
 if (provider === 'tomtom') {
 return getTomTomRouteTravelTimes(originLat, originLng, destLat, destLng, options.tomtomApiKey);
 }
 if (provider === 'google-maps') {
 return getGoogleDistanceMatrix(originLat, originLng, destLat, destLng, options.googleApiKey);
 }
 throw new Error('No live traffic provider configured');
}

export function applyWebcamTrafficSanity(waitTimeMinutes, approachMinutes, webcam, crossingName = 'crossing') {
 if (!webcam || webcam.visibility !== 'good') return waitTimeMinutes;

 if (webcam.queueDetected && waitTimeMinutes < WEBCAM_QUEUE_MIN_WAIT_MIN) {
 console.log(`📷 Webcam override for ${crossingName}: queueDetected=true → ${WEBCAM_QUEUE_MIN_WAIT_MIN} min`);
 return WEBCAM_QUEUE_MIN_WAIT_MIN;
 }

 if (
 !webcam.queueDetected &&
 waitTimeMinutes >= WEBCAM_CLEAR_HIGH_WAIT_MIN &&
 approachMinutes <= WEBCAM_CLEAR_APPROACH_MAX_MIN
 ) {
 console.warn(
 `📷 Webcam sanity filter for ${crossingName}: provider=${waitTimeMinutes} min, ` +
 `approach=${approachMinutes} min, clear webcam → ${WEBCAM_CLEAR_FALLBACK_WAIT_MIN} min`,
 );
 return WEBCAM_CLEAR_FALLBACK_WAIT_MIN;
 }

 return waitTimeMinutes;
}

/**
 * Fetches traffic data for a single border crossing via two live-routing calls:
 * 1. Approach segment: Italian approach point (≈500 m south) → crossing
 * 2. Crossing segment: crossing → Swiss checkpoint (≈1 km north)
 *
 * @param {{ name: string, lat: number, lng: number }} crossing
 * @param {{ hereApiKey?: string, tomtomApiKey?: string, googleApiKey?: string }} options
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

 // TomTom Flow sanity check: if road speed is <30% of free flow but routing says 0 min,
 // there's likely a queue the routing API missed. Override conservatively.
 if (options.tomtomApiKey && waitTimeMinutes < 5) {
 try {
 const flow = await getTomTomFlowSegmentData(crossing.lat, crossing.lng, options.tomtomApiKey);
 if (flow.ratio < 0.3 && flow.confidence > 0.5) {
 waitTimeMinutes = Math.round((1 - flow.ratio) * MAX_FLOW_DELAY_MIN);
 console.log(`🚦 Flow override for ${crossing.name}: ratio=${flow.ratio.toFixed(2)} → ${waitTimeMinutes} min`);
 }
 } catch (flowErr) {
 // Flow check is best-effort — never block on it
 console.warn(`⚠️ TomTom Flow check failed for ${crossing.name}: ${flowErr.message}`);
 }
 }

 if (approachResult.status === 'fulfilled') {
 const { durationNormalSec, durationTrafficSec } = approachResult.value;
 approachMinutes = Math.max(0, Math.round((durationTrafficSec - durationNormalSec) / 60));
 } else {
 console.warn(`⚠️ Approach segment failed for ${crossing.name}: ${approachResult.reason?.message}`);
 }

 const hasLiveData =
 crossingResult.status === 'fulfilled' || approachResult.status === 'fulfilled';

 // Source of the wait estimate. `provider` while live routing data exists; flips
 // to 'webcam' below when the webcam becomes the PRIMARY datum (no live routing).
 let source = provider;

 // Webcam analysis serves two distinct roles depending on whether live routing
 // data exists. We fetch it once (only road-facing CV cameras vote; tourist/
 // lake/town feeds are cvDetect:false and already excluded upstream) and branch:
 //   (a) live data present → applyWebcamTrafficSanity ADJUSTS the routing estimate
 //       (raise missed visible queues / suppress single-provider red outliers).
 //   (b) NO live data (both segments failed) → the webcam is the PRIMARY source:
 //       derive a granular estimate from congestionScore instead of throwing and
 //       letting the SPA fall back to the statistical mock model.
 // Only active when webcam analysis is enabled (options.enableWebcam) and the
 // crossing actually has a camera (analyzeWebcamForCrossing returns null otherwise).
 let webcam = null;
 if (options.enableWebcam) {
  try {
   const { analyzeWebcamForCrossing } = await import('../../scripts/analyze-webcam-frame.mjs');
   webcam = await analyzeWebcamForCrossing(slugifyCrossingName(crossing.name));
  } catch (webcamErr) {
   console.warn(`⚠️ Webcam analysis skipped for ${crossing.name}: ${webcamErr.message}`);
  }
 }

 if (hasLiveData) {
  // (a) Adjust-only: never let the webcam replace a successful routing estimate.
  waitTimeMinutes = applyWebcamTrafficSanity(waitTimeMinutes, approachMinutes, webcam, crossing.name);
 } else if (webcam && webcam.visibility === 'good') {
  // (b) Webcam-as-PRIMARY: both routing segments failed but a good-visibility
  // camera saw the road. Use the granular congestion→minutes estimate.
  waitTimeMinutes = estimateWaitFromCongestion(webcam.congestionScore);
  approachMinutes = 0; // no live approach datum to combine with
  source = 'webcam';
  console.log(
   `📷 Webcam PRIMARY estimate for ${crossing.name}: routing unavailable, ` +
   `congestionScore=${webcam.congestionScore == null ? 'null' : webcam.congestionScore.toFixed(2)} ` +
   `(queueDetected=${webcam.queueDetected}) → ${waitTimeMinutes} min`,
  );
 } else {
  // (b') No live data AND no usable webcam (night/poor/no camera) → preserve the
  // existing behavior: throw so the crossing gets no data and the SPA falls back
  // to the statistical mock model.
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
 source,
 };
}

// ─── Firebase Admin init ──────────────────────────────────────

export function ensureAdminApp() {
 if (!admin.apps.length) {
 admin.initializeApp({ credential: admin.credential.applicationDefault() });
 }
 return admin;
}

// ─── HERE monthly budget guard ─────────────────────────────────

/**
 * Pure budget-decision logic (no I/O — unit-testable).
 *
 * Given the persisted `{ storedMonth, storedCount }`, the current `month`, the
 * number of calls this run wants, and the monthly `budget`, decides whether the
 * run may proceed and what the new running count should be. A month change
 * resets the count to 0. The reservation is rejected when it would push the
 * month total *over* the budget (`>`), so a run that lands exactly on the budget
 * is still allowed.
 *
 * @param {{ storedMonth?: string, storedCount?: number, month: string, callsThisRun: number, budget: number }} input
 * @returns {{ allowed: boolean, count: number }}
 */
export function computeHereBudgetDecision({ storedMonth, storedCount, month, callsThisRun, budget }) {
 const current = storedMonth === month ? Number(storedCount || 0) : 0;
 if (current + callsThisRun > budget) {
 return { allowed: false, count: current };
 }
 return { allowed: true, count: current + callsThisRun };
}

/**
 * Atomically reserves `callsThisRun` HERE transactions against the current
 * calendar month's budget (Firestore doc `meta/hereTransactionBudget`).
 *
 * Returns `{ allowed, count, month }`. When `allowed` is false the caller MUST
 * NOT issue HERE requests this run — the free-tier budget is exhausted. The
 * reservation is conservative (counts attempted calls, not billed ones) so we
 * always land *under* the real HERE meter.
 *
 * @param {number} callsThisRun
 * @returns {Promise<{ allowed: boolean, count: number, month: string }>}
 */
export async function reserveHereTransactionBudget(callsThisRun) {
 const adm = ensureAdminApp();
 const db = adm.firestore();
 const ref = db.collection('meta').doc('hereTransactionBudget');
 // Calendar month in Europe/Rome (en-CA gives YYYY-MM-DD → slice to YYYY-MM).
 const month = new Date()
 .toLocaleDateString('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
 .slice(0, 7);

 return db.runTransaction(async (tx) => {
 const snap = await tx.get(ref);
 const data = snap.exists ? snap.data() : {};
 const { allowed, count } = computeHereBudgetDecision({
 storedMonth: data.month,
 storedCount: data.count,
 month,
 callsThisRun,
 budget: HERE_MONTHLY_BUDGET,
 });

 if (allowed) {
 tx.set(ref, { month, count, updatedAt: adm.firestore.Timestamp.now() });
 }
 return { allowed, count, month };
 });
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

// ─── Webcam-only collection (no routing provider available) ────

/**
 * Builds the same result-object shape `fetchCrossingTraffic` returns, but with
 * the wait derived purely from a webcam congestion score. Pure + synchronous so
 * the status/direction derivation stays unit-testable without network or sharp.
 *
 * @param {{ name: string }} crossing
 * @param {number} waitTimeMinutes - already mapped via estimateWaitFromCongestion
 * @returns {{ crossingName: string, waitTimeMinutes: number, approachMinutes: number, totalCrossingMinutes: number, status: string, direction: string, source: string }}
 */
function buildWebcamCrossingResult(crossing, waitTimeMinutes) {
 const approachMinutes = 0; // no live approach datum from a camera
 const totalCrossingMinutes = waitTimeMinutes + approachMinutes;

 // Same green/yellow/red thresholds as fetchCrossingTraffic.
 let status;
 if (waitTimeMinutes < 5) status = 'green';
 else if (waitTimeMinutes < 15) status = 'yellow';
 else status = 'red';

 // Cloud Functions use UTC by default; derive the local hour in Europe/Rome.
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
 source: 'webcam',
 };
}

/**
 * Webcam-only collection: derive a PRIMARY wait estimate from the road-facing
 * webcams for every crossing that has a CV-eligible camera, and persist the
 * snapshot through the SAME Firestore path the normal collection uses
 * (saveTrafficToFirestore → trafficCurrent/{slug} + trafficHistory). The
 * downstream JSON mirror in scripts/collect-traffic.mjs then refreshes
 * data/border-wait-current.json off that Firestore write, so the SPA shows the
 * fresh webcam-derived value instead of freezing on a stale snapshot.
 *
 * Used when no live routing datum exists for the whole run — either the HERE
 * monthly free-tier budget is exhausted, or no routing key is configured at all.
 * Only crossings whose `analyzeWebcamForCrossing` returns a good-visibility
 * verdict get a result; crossings with no camera or night/poor visibility are
 * skipped and keep falling back to the SPA's statistical mock model (intentional).
 *
 * @param {{ enableWebcam?: boolean }} options
 * @returns {Promise<{collected: number, errors: number, source: string}>}
 */
export async function runWebcamOnlyCollection(options = {}) {
 let analyzeWebcamForCrossing;
 try {
 ({ analyzeWebcamForCrossing } = await import('../../scripts/analyze-webcam-frame.mjs'));
 } catch (err) {
 console.warn(`⚠️ Webcam module load failed — no webcam-only collection: ${err.message}`);
 return { collected: 0, errors: 0, source: 'webcam-only' };
 }

 console.log(`📷 Webcam-only collection for ${BORDER_CROSSINGS.length} crossings (no live routing)…`);

 const results = [];
 let errors = 0;

 for (const crossing of BORDER_CROSSINGS) {
 let webcam = null;
 try {
 webcam = await analyzeWebcamForCrossing(slugifyCrossingName(crossing.name));
 } catch (err) {
 console.warn(`⚠️ Webcam analysis failed for ${crossing.name}: ${err.message}`);
 errors++;
 continue;
 }

 // Skip crossings with no CV camera (null) or unusable visibility
 // (night/poor) — they keep falling back to the statistical mock model.
 if (!webcam || webcam.visibility !== 'good') continue;

 const waitTimeMinutes = estimateWaitFromCongestion(webcam.congestionScore);
 results.push(buildWebcamCrossingResult(crossing, waitTimeMinutes));
 console.log(
 `📷 Webcam-only estimate for ${crossing.name}: ` +
 `congestionScore=${webcam.congestionScore == null ? 'null' : webcam.congestionScore.toFixed(2)} ` +
 `(queueDetected=${webcam.queueDetected}) → ${waitTimeMinutes} min`,
 );
 }

 if (results.length > 0) {
 await saveTrafficToFirestore(results);
 }

 console.log(`✅ Webcam-only collection done – ${results.length} OK, ${errors} errors`);
 return { collected: results.length, errors, source: 'webcam-only' };
}

// ─── Main entry point ─────────────────────────────────────────

/**
 * Collects traffic data for all active border crossings and persists it to Firestore.
 * This is the single entry point called by all three onSchedule functions.
 *
 * When no live routing datum is available for the run (HERE monthly free-tier
 * budget exhausted, or no routing key configured) and webcam analysis is enabled
 * (options.enableWebcam), the run falls back to runWebcamOnlyCollection so the
 * road-facing cameras still refresh the snapshot instead of freezing it. When
 * webcam analysis is disabled the original skip-and-return-0 behavior is kept.
 *
 * @param {{ hereApiKey?: string, tomtomApiKey?: string, googleApiKey?: string, enableWebcam?: boolean }} options
 * @returns {Promise<{collected: number, errors: number}>}
 */
export async function runTrafficCollection(options = {}) {
 const { hereApiKey, tomtomApiKey, googleApiKey } = options;
 const enableWebcam = !!options.enableWebcam;
 console.log(`📷 Webcam analysis: ${enableWebcam ? 'enabled' : 'disabled'}`);
 let provider = resolveTrafficProvider({ hereApiKey, tomtomApiKey, googleApiKey });
 // Options forwarded to the per-crossing routing loop. May be rewritten (HERE
 // key dropped) when falling back to TomTom so resolveTrafficProvider inside
 // the loop resolves to 'tomtom' instead of 'here'.
 let effectiveOptions = options;
 if (!provider) {
 if (enableWebcam) {
 console.warn('⚠️ No routing API key set — falling back to webcam-only collection');
 return runWebcamOnlyCollection(options);
 }
 console.warn('⚠️ No routing API key set (HERE_API_KEY, TOMTOM_API_KEY, or GOOGLE_MAPS_API_KEY) – skipping traffic collection');
 return { collected: 0, errors: 0 };
 }

 // HERE bills every routing call as a "Time Aware Routing" transaction. Reserve
 // this run's calls against the monthly free-tier budget before issuing any —
 // if the month is exhausted, skip the run entirely so we never get billed.
 // Other providers (TomTom/Google) have their own free tiers and are unmetered here.
 if (provider === 'here') {
 const callsThisRun = BORDER_CROSSINGS.length * 2; // crossing + approach segment per crossing
 let budget;
 try {
 budget = await reserveHereTransactionBudget(callsThisRun);
 } catch (err) {
 // Budget bookkeeping is a backstop, not the primary control (the cron is
 // also throttled). On a transient Firestore error, proceed rather than
 // freeze live data — the next run re-checks.
 console.warn(`⚠️ HERE budget check failed (${err.message}) — proceeding without reservation`);
 budget = null;
 }
 if (budget && !budget.allowed) {
 console.warn(
 `🛑 HERE monthly budget reached (${budget.count}/${HERE_MONTHLY_BUDGET} transactions for ${budget.month}) ` +
 `— skipping routing to stay in the free tier.`,
 );
 // Prefer real live routing over webcam-only/mock: TomTom's free tier
 // (2,500 req/day) dwarfs HERE's exhausted monthly allowance and is
 // UNMETERED in this module. Switch the effective provider to TomTom and
 // run the SAME per-crossing routing loop. We've already skipped the HERE
 // reservation above, so the HERE counter is NOT charged for this run.
 // Dropping hereApiKey makes resolveTrafficProvider resolve to 'tomtom'
 // inside fetchCrossingTraffic/getSegmentTravelTimes.
 if (tomtomApiKey) {
 console.log('🔁 HERE budget exhausted — falling back to TomTom (free tier) for live routing');
 provider = 'tomtom';
 const { hereApiKey: _droppedHereKey, ...rest } = options;
 effectiveOptions = rest;
 // Fall through to the normal per-crossing routing loop with provider='tomtom'.
 } else if (enableWebcam) {
 // No TomTom key: don't freeze the snapshot for a whole month — the free
 // webcams can still refresh the CV-capable crossings while routing is paused.
 console.warn('📷 HERE budget exhausted — falling back to webcam-only collection');
 return runWebcamOnlyCollection(options);
 } else {
 console.warn('Live data keeps the last snapshot (webcam disabled).');
 return { collected: 0, errors: 0, skipped: 'here-budget' };
 }
 }
 if (budget && budget.allowed) {
 console.log(`💳 HERE budget: ${budget.count}/${HERE_MONTHLY_BUDGET} transactions reserved for ${budget.month}`);
 }
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
 chunk.map(c => fetchCrossingTraffic(c, effectiveOptions)),
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
