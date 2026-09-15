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
import {
  TRAFFIC_PROVIDER_SPECS,
  buildTrafficProviderChain,
  classifyProviderError,
  getTrafficSegmentTravelTimes,
  providerBudget,
  providerPeriod,
  reserveTrafficProviderBudget,
} from './trafficProviderMesh.js';

// Re-export so callers that previously imported from this module keep working.
export { slugifyCrossingName, BORDER_CROSSINGS };

const GOOGLE_DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const TOMTOM_CALCULATE_ROUTE_URL = 'https://api.tomtom.com/routing/1/calculateRoute';
const HERE_ROUTER_URL = 'https://router.hereapi.com/v8/routes';
const TT_FLOW_URL = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0';
const MAX_FLOW_DELAY_MIN = 45;
// HERE "Time Aware Routing" has a paid meter after its free allowance. Each
// crossing costs 2 transactions (crossing segment + approach segment), so the
// scheduler reserves the whole run before issuing requests and hard-caps the
// local monthly budget below the advertised free tier. Override via the
// HERE_MONTHLY_BUDGET env var.
// `Number(process.env.X || 4500)` metteva l'alternativa DENTRO `Number`: una
// variabile presente ma non numerica dava `NaN`, e `NaN` come tetto di spesa
// significa nessun tetto — `usage >= NaN` e' falso, quindi la garanzia «non
// paghiamo mai» sarebbe evaporata in silenzio (issue #7344).
//
// Il predicato e' quello di `scripts/lib/int-from-env.mjs`, ma qui e' scritto
// a mano DELIBERATAMENTE: `functions/` e' un artefatto di deploy separato
// (`firebase deploy --only functions` carica solo questa cartella), quindi un
// import verso `scripts/` risolverebbe in locale e romperebbe in produzione.
const HERE_MONTHLY_BUDGET = (() => {
  const raw = process.env.HERE_MONTHLY_BUDGET;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 4500;
  const trimmed = String(raw).trim();
  const n = Number(trimmed);
  // Anche la FORMA conta: `Number('0x10')` fa 16 e `Number('1e3')` fa 1000, due
  // interi >= 0 che passavano di qui senza avviso e cambiavano il tetto di
  // spesa senza dirlo (issue #7701, item 3). Solo notazione decimale.
  if (!/^[+-]?\d+$/.test(trimmed) || !Number.isInteger(n) || n < 0) {
    console.warn(`[traffic-scheduler] HERE_MONTHLY_BUDGET=${JSON.stringify(String(raw))} non e' un intero decimale >= 0 — uso 4500`);
    return 4500;
  }
  return n;
})();
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
export function resolveTrafficProvider({
 hereApiKey,
 tomtomApiKey,
 googleApiKey,
 googleRoutesApiKey,
 mapboxAccessToken,
 geoapifyApiKey,
 graphhopperApiKey,
 openrouteserviceApiKey,
 stadiaApiKey,
 }) {
 if (tomtomApiKey) return 'tomtom';
 if (hereApiKey) return 'here';
 if (googleRoutesApiKey) return 'google-routes';
 if (mapboxAccessToken) return 'mapbox';
 if (geoapifyApiKey) return 'geoapify';
 if (openrouteserviceApiKey) return 'openrouteservice';
 if (graphhopperApiKey) return 'graphhopper';
 if (stadiaApiKey) return 'stadia';
 if (googleApiKey) return 'google-maps';
 return null;
}

/**
 * Detects a TomTom account-level billing failure (HTTP 403, error code
 * "InsufficientFunds" — the account has run out of prepaid credits) as
 * opposed to a transient/per-request routing error. Unlike a timeout or a
 * single bad route, this failure is account-wide: every subsequent call for
 * the rest of the billing period fails identically (#4743: 135/141 crossings
 * failed with this exact error in one run).
 *
 * @param {string} [message]
 * @returns {boolean}
 */
export function isTomTomAccountExhausted(message = '') {
 return /InsufficientFunds/i.test(message);
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
 const provider = options.providerOverride ?? resolveTrafficProvider(options);
 if (provider === 'here') {
 return getHereMapsRouteTravelTimes(originLat, originLng, destLat, destLng, options.hereApiKey);
 }
 if (provider === 'tomtom') {
 return getTomTomRouteTravelTimes(originLat, originLng, destLat, destLng, options.tomtomApiKey);
 }
 if (provider === 'google-maps') {
 return getGoogleDistanceMatrix(originLat, originLng, destLat, destLng, options.googleApiKey);
 }
 if (provider && provider !== 'tomtom' && provider !== 'here' && provider !== 'google-maps') {
  return getTrafficSegmentTravelTimes(provider, originLat, originLng, destLat, destLng, options);
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

function providerIdFromEntry(entry) {
 return typeof entry === 'string' ? entry : entry?.id;
}

function finiteNonNegative(value) {
 const n = Number(value);
 return Number.isFinite(n) && n >= 0 ? n : null;
}

function officialSignalForCrossing(options, crossing) {
 const signals = options.officialSignals;
 if (!signals) return null;
 const slug = slugifyCrossingName(crossing.name);
 const signal = signals instanceof Map ? signals.get(slug) : signals[slug];
 return signal && typeof signal === 'object' ? signal : null;
}

/** Apply only explicit official queue/approach values; incidents without a
 * measured delay remain provenance, not fabricated minutes. */
function applyOfficialSignal(waitTimeMinutes, approachMinutes, signal) {
 if (!signal) return { waitTimeMinutes, approachMinutes };
 const officialQueue = finiteNonNegative(signal.queueMinutes ?? signal.officialQueueMinutes);
 const officialApproach = finiteNonNegative(signal.approachMinutes ?? signal.officialApproachMinutes);
 return {
  waitTimeMinutes: officialQueue === null ? waitTimeMinutes : Math.max(waitTimeMinutes, Math.round(officialQueue)),
  approachMinutes: officialApproach === null ? approachMinutes : Math.max(approachMinutes, Math.round(officialApproach)),
 };
}

async function getSegmentWithProviderFallback(originLat, originLng, destLat, destLng, options, providerChain) {
 let lastError = null;
 for (const entry of providerChain) {
  const providerId = providerIdFromEntry(entry);
  if (!providerId || options.providerRuntime?.disabled?.has(providerId)) continue;
  try {
   if (options.providerRuntime?.ensureProvider) {
    const allowed = await options.providerRuntime.ensureProvider(providerId);
    if (!allowed) continue;
   }
   const value = await getSegmentTravelTimes(
    originLat,
    originLng,
    destLat,
    destLng,
    { ...options, providerOverride: providerId },
   );
   return { ...value, provider: providerId };
  } catch (error) {
   lastError = error;
   const kind = classifyProviderError(error);
   // A quota/auth failure is account-wide for this run. Transient/data errors
   // still rotate for this segment, but the provider may serve the next one.
   if (kind === 'quota' || kind === 'auth' || error?.code === 'TRAFFIC_PROVIDER_BUDGET_EXHAUSTED') {
    options.providerRuntime?.disabled?.add(providerId);
   }
   console.warn(`⚠️ ${providerId} failed for one traffic segment (${kind}) — rotating fallback`);
  }
 }
 throw lastError ?? new Error('No live traffic provider available');
}

/**
 * Fetches traffic data for a single border crossing via two live-routing calls:
 * 1. Approach segment: Italian approach point (≈500 m south) → crossing
 * 2. Crossing segment: crossing → Swiss checkpoint (≈1 km north)
 *
 * @param {{ name: string, lat: number, lng: number }} crossing
 * @param {{ [key: string]: any }} options
 */
export async function fetchCrossingTraffic(crossing, options = {}) {
 const { lat, lng } = crossing;
 const provider = options.providerOverride ?? resolveTrafficProvider(options);
 const providerChain = options.providerChain;

 if (!provider && !providerChain?.length) {
 throw new Error('No live traffic provider configured');
 }

 // Swiss checkpoint: ≈1 km north of the crossing (same offset used in trafficService.ts)
 const checkpointLat = lat + 0.01;
 // Italian approach point: ≈500 m south of the crossing
 const approachLat = lat - 0.0045;

 const segmentFetcher = providerChain?.length
  ? (originLat, originLng, destLat, destLng) => getSegmentWithProviderFallback(
   originLat,
   originLng,
   destLat,
   destLng,
   options,
   providerChain,
  )
  : (originLat, originLng, destLat, destLng) => getSegmentTravelTimes(
   originLat,
   originLng,
   destLat,
   destLng,
   options,
  ).then((value) => ({ ...value, provider }));

 const [crossingResult, approachResult] = await Promise.allSettled([
 segmentFetcher(lat, lng, checkpointLat, lng),
 segmentFetcher(approachLat, lng, lat, lng),
 ]);

 let waitTimeMinutes = 0;
 let approachMinutes = 0;

 if (crossingResult.status === 'fulfilled') {
 const { durationNormalSec, durationTrafficSec } = crossingResult.value;
 waitTimeMinutes = Math.max(0, Math.round((durationTrafficSec - durationNormalSec) / 60));
 } else {
 console.warn(`⚠️ Crossing segment failed for ${crossing.name}: ${crossingResult.reason?.message}`);
 }

 const observedProviders = new Set(
  [crossingResult, approachResult]
   .filter((result) => result.status === 'fulfilled')
   .map((result) => result.value.provider)
   .filter(Boolean),
 );

 // TomTom Flow sanity check: if road speed is <30% of free flow but routing says 0 min,
 // there's likely a queue the routing API missed. Override conservatively. In the mesh,
 // only a segment actually served by TomTom may trigger this extra API call.
 const tomTomWasUsed = providerChain?.length
  ? observedProviders.has('tomtom')
  : provider === 'tomtom';
 if (((options.enableTomTomFlow ?? !providerChain) || provider === 'tomtom')
  && tomTomWasUsed
  && options.tomtomApiKey
  && waitTimeMinutes < 5) {
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

 const signal = officialSignalForCrossing(options, crossing);
 const officialAdjusted = applyOfficialSignal(waitTimeMinutes, approachMinutes, signal);
 waitTimeMinutes = officialAdjusted.waitTimeMinutes;
 approachMinutes = officialAdjusted.approachMinutes;

 // Source of the wait estimate. `provider` while live routing data exists; flips
 // to 'webcam' below when the webcam becomes the PRIMARY datum (no live routing).
 let source = observedProviders.size === 1
  ? [...observedProviders][0]
  : observedProviders.size > 1
   ? 'traffic-mesh'
   : provider;

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
  // Official measured queues/approach signals are a lower bound. Re-apply them
  // after the webcam sanity filter so a clear image cannot erase an official
  // road authority signal.
  const protectedOfficial = applyOfficialSignal(waitTimeMinutes, approachMinutes, signal);
  waitTimeMinutes = protectedOfficial.waitTimeMinutes;
  approachMinutes = protectedOfficial.approachMinutes;
 } else if (webcam && webcam.visibility === 'good') {
  // (b) Webcam-as-PRIMARY: both routing segments failed but a good-visibility
  // camera saw the road. Use the granular congestion→minutes estimate.
  waitTimeMinutes = Math.max(waitTimeMinutes, estimateWaitFromCongestion(webcam.congestionScore));
  approachMinutes = 0; // no live approach datum to combine with
  source = signal ? 'official+webcam' : 'webcam';
  console.log(
   `📷 Webcam PRIMARY estimate for ${crossing.name}: routing unavailable, ` +
   `congestionScore=${webcam.congestionScore == null ? 'null' : webcam.congestionScore.toFixed(2)} ` +
   `(queueDetected=${webcam.queueDetected}) → ${waitTimeMinutes} min`,
  );
 } else if (signal && (finiteNonNegative(signal.queueMinutes ?? signal.officialQueueMinutes) !== null
  || finiteNonNegative(signal.approachMinutes ?? signal.officialApproachMinutes) !== null)) {
  // Official open-data signals are a useful primary fallback when both route
  // segments fail. Incident-only records deliberately do not reach this path.
  source = 'official';
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

 const officialSources = Array.isArray(signal?.sourceIds)
  ? signal.sourceIds.filter(Boolean).join(',')
  : typeof signal?.sourceId === 'string' ? signal.sourceId : '';
 const result = {
 crossingName: crossing.name,
 waitTimeMinutes,
 approachMinutes,
 totalCrossingMinutes,
 status,
 source,
 };
 if (officialSources) result.officialSources = officialSources;
 if (signal?.updatedAt) result.officialLastUpdate = String(signal.updatedAt);
 if (finiteNonNegative(signal?.queueKm) !== null) result.officialQueueKm = Number(signal.queueKm);
 if (signal) result.dataQuality = hasLiveData ? 'live+official' : 'official';
 return result;
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

function createProviderMeshRuntime(providerChain, callsThisRun) {
 const disabled = new Set();
 const reservations = new Map();

 const ensureProvider = async (providerId) => {
  if (disabled.has(providerId)) return false;
  if (reservations.has(providerId)) return reservations.get(providerId);

  const promise = (async () => {
   try {
    // HERE keeps its historical/reconciled document name. All other providers
    // use the generic provider-period document in trafficProviderMesh.js.
    const reservation = providerId === 'here'
     ? await reserveHereTransactionBudget(callsThisRun)
     : await reserveTrafficProviderBudget(providerId, callsThisRun);
    if (!reservation?.allowed) {
     disabled.add(providerId);
     const budget = reservation?.budget ?? providerBudget(providerId);
     const period = reservation?.period ?? providerPeriod(providerId);
     console.warn(`🛑 ${providerId} local budget reached (${budget}/${period}) — rotating provider`);
     return false;
    }
    return true;
   } catch (error) {
    // A failed budget transaction cannot prove that a paid request is safe.
    // Fail closed and let the chain try a different provider or webcam.
    disabled.add(providerId);
    console.warn(`🛑 ${providerId} budget reservation failed — rotating provider: ${error.message}`);
    return false;
   }
  })();
  reservations.set(providerId, promise);
  return promise;
 };

 return { providerChain, disabled, reservations, ensureProvider };
}

async function runTrafficCollectionWithProviderMesh(options, providerChain) {
 const maxTomTomFlowCalls = providerChain.some((spec) => spec.id === 'tomtom') && options.tomtomApiKey
  ? BORDER_CROSSINGS.length
  : 0;
 const callsThisRun = BORDER_CROSSINGS.length * 2 + 1 + maxTomTomFlowCalls;
 // two route segments + one preflight, plus the worst-case TomTom Flow check
 // for every crossing. Reserving the upper bound keeps a late fallback from
 // spending outside the same provider cap.
 const runtime = createProviderMeshRuntime(providerChain, callsThisRun);
 const probe = BORDER_CROSSINGS[0];
 let selectedProvider = null;

 // Probe in preference order. This catches account-wide 401/403/429 states
 // before the large batch, while per-segment rotation below still handles a
 // limit reached during the run.
 for (const spec of providerChain) {
  const providerId = spec.id;
  if (!(await runtime.ensureProvider(providerId))) continue;
  try {
   await getSegmentTravelTimes(
    probe.lat,
    probe.lng,
    probe.lat + 0.01,
    probe.lng,
    { ...options, providerOverride: providerId },
   );
   selectedProvider = providerId;
   break;
  } catch (error) {
   runtime.disabled.add(providerId);
   console.warn(`🛑 ${providerId} preflight failed (${classifyProviderError(error)}) — rotating provider`);
  }
 }

 if (!selectedProvider) {
  if (options.enableWebcam) {
   console.warn('📷 Provider mesh exhausted — falling back to webcam-only collection');
   return runWebcamOnlyCollection(options);
  }
  return { collected: 0, errors: 0, skipped: 'traffic-provider-mesh-exhausted' };
 }

 const selectedSpec = TRAFFIC_PROVIDER_SPECS[selectedProvider];
 const effectiveOptions = {
  ...options,
  providerChain,
  providerRuntime: runtime,
  enableTomTomFlow: selectedProvider === 'tomtom',
 };
 console.log(`🚦 Starting traffic collection for ${BORDER_CROSSINGS.length} crossings via ${selectedProvider} (provider mesh)…`);

 const results = [];
 let errors = 0;
 const batchSize = selectedSpec?.batchSize ?? 5;
 const batchDelayMs = selectedSpec?.batchDelayMs ?? 250;
 for (let i = 0; i < BORDER_CROSSINGS.length; i += batchSize) {
  const chunk = BORDER_CROSSINGS.slice(i, i + batchSize);
  const settled = await Promise.allSettled(chunk.map((crossing) => fetchCrossingTraffic(crossing, effectiveOptions)));
  for (let j = 0; j < settled.length; j++) {
   const result = settled[j];
   if (result.status === 'fulfilled') results.push(result.value);
   else {
    console.error(`❌ ${chunk[j].name}: ${result.reason?.message}`);
    errors++;
   }
  }
  if (i + batchSize < BORDER_CROSSINGS.length) {
   await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
  }
 }

 if (results.length > 0) await saveTrafficToFirestore(results);
 console.log(`✅ Provider-mesh collection done – ${results.length} OK, ${errors} errors`);
 return { collected: results.length, errors };
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
 // Two writes per crossing remain well within Firestore's 500-operation batch
 // limit for the current crossing catalog.
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
 * the status derivation stays unit-testable without network or sharp.
 *
 * @param {{ name: string }} crossing
 * @param {number} waitTimeMinutes - already mapped via estimateWaitFromCongestion
 * @returns {{ crossingName: string, waitTimeMinutes: number, approachMinutes: number, totalCrossingMinutes: number, status: string, source: string }}
 */
function buildWebcamCrossingResult(crossing, waitTimeMinutes, approachMinutes = 0, signal = null, webcamUsed = true) {
 const totalCrossingMinutes = waitTimeMinutes + approachMinutes;

 // Same green/yellow/red thresholds as fetchCrossingTraffic.
 let status;
 if (waitTimeMinutes < 5) status = 'green';
 else if (waitTimeMinutes < 15) status = 'yellow';
 else status = 'red';

 const result = {
 crossingName: crossing.name,
 waitTimeMinutes,
 approachMinutes,
 totalCrossingMinutes,
 status,
 source: signal ? (webcamUsed ? 'official+webcam' : 'official') : 'webcam',
 };
 const officialSources = Array.isArray(signal?.sourceIds)
  ? signal.sourceIds.filter(Boolean).join(',')
  : typeof signal?.sourceId === 'string' ? signal.sourceId : '';
 if (officialSources) result.officialSources = officialSources;
 if (signal?.updatedAt) result.officialLastUpdate = String(signal.updatedAt);
 if (finiteNonNegative(signal?.queueKm) !== null) result.officialQueueKm = Number(signal.queueKm);
 if (signal) result.dataQuality = webcamUsed ? 'official+webcam' : 'official';
 return result;
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

 const signal = officialSignalForCrossing(options, crossing);
 const officialMinutes = applyOfficialSignal(0, 0, signal);
 const hasOfficialMinutes = signal && (
  finiteNonNegative(signal.queueMinutes ?? signal.officialQueueMinutes) !== null
  || finiteNonNegative(signal.approachMinutes ?? signal.officialApproachMinutes) !== null
 );
 // A camera remains the preferred free primary signal. If it is absent/night,
 // an explicit official queue/approach measurement can still refresh the
 // crossing instead of freezing the whole snapshot.
 if (!webcam || webcam.visibility !== 'good') {
  if (!hasOfficialMinutes) continue;
  results.push(buildWebcamCrossingResult(crossing, officialMinutes.waitTimeMinutes, officialMinutes.approachMinutes, signal, false));
  continue;
 }

 const waitTimeMinutes = Math.max(
  officialMinutes.waitTimeMinutes,
  estimateWaitFromCongestion(webcam.congestionScore),
 );
 results.push(buildWebcamCrossingResult(crossing, waitTimeMinutes, officialMinutes.approachMinutes, signal));
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
 * If TomTom is the resolved provider but its account has run out of prepaid
 * credits (HTTP 403 InsufficientFunds), a preflight check falls back to HERE
 * or Google Maps for the rest of the run instead of failing every crossing.
 * If Google Maps ends up as the resolved provider (the last-resort fallback)
 * and its own preflight call fails (e.g. legacy Distance Matrix API disabled),
 * the run degrades to webcam-only (or a clean skip) instead of reporting a
 * near-total per-crossing failure.
 *
 * @param {{ [key: string]: any }} options
 * @returns {Promise<{collected: number, errors: number}>}
 */
export async function runTrafficCollection(options = {}) {
 const { hereApiKey, tomtomApiKey, googleApiKey } = options;
 const enableWebcam = !!options.enableWebcam;
 console.log(`📷 Webcam analysis: ${enableWebcam ? 'enabled' : 'disabled'}`);
 const providerChain = buildTrafficProviderChain(options);
 const usesExtendedMesh = providerChain.some(
  (spec) => !['tomtom', 'here', 'google-maps'].includes(spec.id),
 );
 if (usesExtendedMesh) {
  return runTrafficCollectionWithProviderMesh(options, providerChain);
 }
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
 // Extracted so the TomTom-exhaustion fallback below (which can also land on
 // 'here') reserves against the same budget instead of billing untracked (#4747).
 const tryReserveHereBudget = async () => {
 const callsThisRun = BORDER_CROSSINGS.length * 2; // crossing + approach segment per crossing
 try {
 return await reserveHereTransactionBudget(callsThisRun);
 } catch (err) {
 // Budget bookkeeping is a backstop, not the primary control (the cron is
 // also throttled). On a transient Firestore error, proceed rather than
 // freeze live data — the next run re-checks.
 console.warn(`⚠️ HERE budget check failed (${err.message}) — proceeding without reservation`);
 return null;
 }
 };
 if (provider === 'here') {
 const budget = await tryReserveHereBudget();
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

 // TomTom's HTTP 403 "InsufficientFunds" error is account-wide (the prepaid
 // credit balance is empty), not per-crossing — running the full batch loop
 // against a doomed key just burns the run's 10-minute timeout collecting
 // nothing (#4743). A single cheap preflight call catches this up front and
 // falls back to the next configured provider (HERE, then Google Maps) so
 // this run still gets real live routing data instead of degrading straight
 // to webcam-only/mock. Mirrors the HERE-budget-exhausted → TomTom fallback
 // above, in the opposite direction.
 if (provider === 'tomtom') {
 const probe = BORDER_CROSSINGS[0];
 try {
 await getTomTomRouteTravelTimes(probe.lat, probe.lng, probe.lat + 0.01, probe.lng, tomtomApiKey);
 } catch (err) {
 if (isTomTomAccountExhausted(err.message)) {
 const fallbackProvider = hereApiKey ? 'here' : googleApiKey ? 'google-maps' : null;
 if (fallbackProvider) {
 console.warn(
 `🛑 TomTom account exhausted (${err.message}) — falling back to ${fallbackProvider} for this run`,
 );
 provider = fallbackProvider;
 const { tomtomApiKey: _droppedTomTomKey, ...rest } = effectiveOptions;
 effectiveOptions = rest;
 // Falling back to HERE still bills "Time Aware Routing" transactions —
 // reserve against the same monthly budget as the initially-resolved-here
 // path above, or this run bills untracked (#4747).
 if (provider === 'here') {
 const budget = await tryReserveHereBudget();
 if (budget && !budget.allowed) {
 console.warn(
 `🛑 HERE monthly budget also reached (${budget.count}/${HERE_MONTHLY_BUDGET} transactions for ${budget.month}) ` +
 `— TomTom is exhausted too, so HERE is not a safe fallback this run.`,
 );
 if (googleApiKey) {
 console.log('🔁 Falling back to Google Maps for this run');
 provider = 'google-maps';
 const { hereApiKey: _droppedHereKey, ...rest2 } = effectiveOptions;
 effectiveOptions = rest2;
 } else if (enableWebcam) {
 console.warn('📷 No further routing fallback — falling back to webcam-only collection');
 return runWebcamOnlyCollection(options);
 } else {
 console.warn('Live data keeps the last snapshot (webcam disabled).');
 return { collected: 0, errors: 0, skipped: 'here-budget' };
 }
 } else if (budget && budget.allowed) {
 console.log(`💳 HERE budget: ${budget.count}/${HERE_MONTHLY_BUDGET} transactions reserved for ${budget.month}`);
 }
 }
 } else {
 console.warn(`🛑 TomTom account exhausted (${err.message}) — no fallback routing key configured`);
 }
 }
 // Any other preflight error (transient network blip) is ignored — the
 // per-crossing loop below already tolerates per-request failures.
 }
 }

 // Google Maps is the last-resort fallback (TomTom exhausted, HERE budget
 // exhausted or unconfigured) with no further routing provider to try. Unlike
 // the TomTom preflight above, a broken Google Maps key/API is NOT transient:
 // the legacy Distance Matrix API can be disabled project-wide, in which case
 // EVERY subsequent call fails identically with REQUEST_DENIED (#4768: 135/141
 // crossings failed this way in one run, exit code 1). A single cheap preflight
 // call catches this before the full per-crossing loop, so a broken Google Maps
 // fallback degrades gracefully to webcam-only (or a clean skip) instead of
 // burning the run and reporting a near-total failure.
 if (provider === 'google-maps') {
 const probe = BORDER_CROSSINGS[0];
 try {
 await getGoogleDistanceMatrix(probe.lat, probe.lng, probe.lat + 0.01, probe.lng, googleApiKey);
 } catch (err) {
 console.warn(`🛑 Google Maps routing unavailable (${err.message}) — no further routing fallback`);
 if (enableWebcam) {
 console.warn('📷 Falling back to webcam-only collection');
 return runWebcamOnlyCollection(options);
 }
 console.warn('Live data keeps the last snapshot (webcam disabled).');
 return { collected: 0, errors: 0, skipped: 'google-maps-unavailable' };
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
