/**
 * Provider mesh for the scheduled border-traffic collector.
 *
 * This module deliberately has no dependency on the UI or on the corpus. It
 * contains the provider adapters, their conservative local budgets, and the
 * pure helpers used by the scheduler to rotate after quota/account errors.
 * The scheduler still owns the legacy HERE counter because the reconciliation
 * job already publishes that counter under `meta/hereTransactionBudget`.
 */

import admin from 'firebase-admin';

const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MAPBOX_DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving-traffic';
const GEOAPIFY_ROUTING_URL = 'https://api.geoapify.com/v1/routing';
const GRAPHHOPPER_ROUTING_URL = 'https://graphhopper.com/api/1/route';
const OPENROUTESERVICE_ROUTING_URL = 'https://api.openrouteservice.org/v2/directions/driving-car';
const STADIA_ROUTING_URL = 'https://api.stadiamaps.com/route/v1/driving';
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Default caps are deliberately below the commonly advertised free quotas.
 * They are a safety ceiling, not a claim about the current commercial plan.
 * A deployment can tighten them further through Remote Config.
 */
export const TRAFFIC_PROVIDER_SPECS = Object.freeze({
  tomtom: Object.freeze({
    id: 'tomtom',
    key: 'tomtomApiKey',
    budgetEnv: 'TOMTOM_DAILY_BUDGET',
    defaultBudget: 2000,
    period: 'day',
    batchSize: 2,
    batchDelayMs: 1000,
    trafficAware: true,
  }),
  here: Object.freeze({
    id: 'here',
    key: 'hereApiKey',
    budgetEnv: 'HERE_MONTHLY_BUDGET',
    defaultBudget: 4500,
    period: 'month',
    batchSize: 5,
    batchDelayMs: 200,
    trafficAware: true,
  }),
  'google-routes': Object.freeze({
    id: 'google-routes',
    key: 'googleRoutesApiKey',
    budgetScope: 'google',
    budgetEnv: 'GOOGLE_ROUTES_MONTHLY_BUDGET',
    defaultBudget: 9000,
    period: 'month',
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
  mapbox: Object.freeze({
    id: 'mapbox',
    key: 'mapboxAccessToken',
    budgetEnv: 'MAPBOX_MONTHLY_BUDGET',
    defaultBudget: 5000,
    period: 'month',
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
  geoapify: Object.freeze({
    id: 'geoapify',
    key: 'geoapifyApiKey',
    budgetEnv: 'GEOAPIFY_DAILY_BUDGET',
    defaultBudget: 2500,
    period: 'day',
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
  openrouteservice: Object.freeze({
    id: 'openrouteservice',
    key: 'openrouteserviceApiKey',
    budgetEnv: 'OPENROUTESERVICE_DAILY_BUDGET',
    defaultBudget: 1500,
    period: 'day',
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: false,
  }),
  graphhopper: Object.freeze({
    id: 'graphhopper',
    key: 'graphhopperApiKey',
    budgetEnv: 'GRAPHHOPPER_DAILY_BUDGET',
    defaultBudget: 400,
    period: 'day',
    batchSize: 3,
    batchDelayMs: 500,
    trafficAware: false,
  }),
  stadia: Object.freeze({
    id: 'stadia',
    key: 'stadiaApiKey',
    budgetEnv: 'STADIA_DAILY_BUDGET',
    defaultBudget: 800,
    period: 'day',
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: false,
  }),
  'google-maps': Object.freeze({
    id: 'google-maps',
    key: 'googleApiKey',
    budgetScope: 'google',
    budgetEnv: 'GOOGLE_MAPS_MONTHLY_BUDGET',
    defaultBudget: 9000,
    period: 'month',
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
});

// Keep the legacy preference order first, then use the independent providers
// as progressively broader fallbacks. Static routers are intentionally after
// traffic-aware APIs: they are valuable geometry fallbacks, not fake traffic.
export const TRAFFIC_PROVIDER_ORDER = Object.freeze([
  'tomtom',
  'here',
  'google-routes',
  'mapbox',
  'geoapify',
  'openrouteservice',
  'graphhopper',
  'stadia',
  'google-maps',
]);

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Strict decimal integer parser used for all provider caps. */
export function parseProviderBudget(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const raw = String(value).trim();
  const parsed = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function providerBudget(providerId, env = process.env) {
  const spec = TRAFFIC_PROVIDER_SPECS[providerId];
  if (!spec) throw new Error(`Unknown traffic provider: ${providerId}`);
  return parseProviderBudget(env[spec.budgetEnv], spec.defaultBudget);
}

export function providerPeriod(providerId, date = new Date()) {
  const spec = TRAFFIC_PROVIDER_SPECS[providerId];
  if (!spec) throw new Error(`Unknown traffic provider: ${providerId}`);
  const iso = date.toISOString();
  return spec.period === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** Pure atomic budget decision; safe to use in tests and transaction code. */
export function computeProviderBudgetDecision({
  storedPeriod,
  storedCount,
  period,
  callsThisRun,
  budget,
}) {
  const current = storedPeriod === period ? Number(storedCount || 0) : 0;
  const calls = Number(callsThisRun);
  const cap = Number(budget);
  if (!Number.isSafeInteger(calls) || calls < 0) return { allowed: false, count: current };
  if (!Number.isSafeInteger(cap) || cap < 0) return { allowed: false, count: current };
  if (current + calls > cap) return { allowed: false, count: current };
  return { allowed: true, count: current + calls };
}

function ensureAdminApp() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  return admin;
}

/**
 * Reserve a full provider run before sending a request. A failed reservation
 * is fail-closed: the caller must rotate to another provider or webcam.
 */
export async function reserveTrafficProviderBudget(providerId, callsThisRun, now = new Date()) {
  const spec = TRAFFIC_PROVIDER_SPECS[providerId];
  if (!spec) throw new Error(`Unknown traffic provider: ${providerId}`);
  const adm = ensureAdminApp();
  const db = adm.firestore();
  const period = providerPeriod(providerId, now);
  const budget = providerBudget(providerId);
  const budgetScope = spec.budgetScope ?? providerId;
  const ref = db.collection('meta').doc(`trafficProviderBudget-${budgetScope}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const decision = computeProviderBudgetDecision({
      storedPeriod: data.period,
      storedCount: data.count,
      period,
      callsThisRun,
      budget,
    });
    if (decision.allowed) {
      tx.set(ref, {
        provider: providerId,
        budgetScope,
        period,
        count: decision.count,
        budget,
        updatedAt: adm.firestore.Timestamp.now(),
      });
    }
    return { ...decision, provider: providerId, period, budget };
  });
}

export function getProviderApiKey(providerId, options = {}) {
  const spec = TRAFFIC_PROVIDER_SPECS[providerId];
  return spec ? options[spec.key] : undefined;
}

/** Return configured providers without exposing any credential value. */
export function buildTrafficProviderChain(options = {}) {
  return TRAFFIC_PROVIDER_ORDER
    .filter((providerId) => hasValue(getProviderApiKey(providerId, options)))
    .map((providerId) => TRAFFIC_PROVIDER_SPECS[providerId]);
}

export function classifyProviderError(error) {
  const message = String(error?.message ?? error ?? '');
  if (/(429|quota|rate.?limit|insufficientfunds|insufficient funds|billing|daily limit|monthly limit|resource exhausted)/i.test(message)) {
    return 'quota';
  }
  if (/(401|403|request_denied|request denied|api.?not.?activated|disabled|invalid.?api.?key|unauthori[sz]ed|forbidden)/i.test(message)) {
    return 'auth';
  }
  if (/(408|409|425|500|502|503|504|timeout|timed out|network|fetch failed)/i.test(message)) {
    return 'transient';
  }
  return 'data';
}

export function isProviderQuotaError(error) {
  return classifyProviderError(error) === 'quota';
}

function safeBody(text) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 240);
}

async function requestJson(url, init = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Traffic provider HTTP ${response.status}: ${safeBody(body)}`);
  }
  return response.json();
}

function durationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  return match ? Number(match[1]) : null;
}

function normaliseTimes(durationTrafficSec, durationNormalSec = durationTrafficSec) {
  if (!Number.isFinite(durationTrafficSec) || !Number.isFinite(durationNormalSec)) {
    throw new Error('Traffic provider: INVALID_TRAVEL_TIMES');
  }
  return {
    durationNormalSec: Math.max(0, durationNormalSec),
    durationTrafficSec: Math.max(0, durationTrafficSec),
  };
}

async function getGoogleRoutesTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl) {
  const data = await requestJson(GOOGLE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
      destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: new Date().toISOString(),
    }),
  }, fetchImpl);
  const route = data?.routes?.[0];
  const traffic = durationSeconds(route?.duration);
  const normal = durationSeconds(route?.staticDuration) ?? traffic;
  if (traffic === null) throw new Error('Google Routes: NO_ROUTE');
  return normaliseTimes(traffic, normal);
}

async function getMapboxTimes(originLat, originLng, destLat, destLng, token, fetchImpl) {
  const coordinates = `${originLng},${originLat};${destLng},${destLat}`;
  const params = new URLSearchParams({
    access_token: token,
    overview: 'false',
    annotations: 'duration',
    depart_at: 'now',
  });
  const data = await requestJson(`${MAPBOX_DIRECTIONS_URL}/${coordinates}?${params}`, {}, fetchImpl);
  const route = data?.routes?.[0];
  const traffic = durationSeconds(route?.duration);
  const normal = durationSeconds(route?.duration_typical) ?? traffic;
  if (traffic === null) throw new Error('Mapbox Directions: NO_ROUTE');
  return normaliseTimes(traffic, normal);
}

async function getGeoapifyTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl) {
  const params = new URLSearchParams({
    waypoints: `${originLat},${originLng}|${destLat},${destLng}`,
    mode: 'drive',
    traffic: 'approximated',
    apiKey,
  });
  const data = await requestJson(`${GEOAPIFY_ROUTING_URL}?${params}`, {}, fetchImpl);
  const props = data?.features?.[0]?.properties;
  const traffic = Number(props?.time ?? props?.duration);
  const normal = Number(props?.base_time ?? props?.time_without_traffic ?? traffic);
  if (!Number.isFinite(traffic)) throw new Error('Geoapify Routing: NO_ROUTE');
  return normaliseTimes(traffic, normal);
}

async function getGraphhopperTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl) {
  const params = new URLSearchParams({
    point: `${originLat},${originLng}`,
    vehicle: 'car',
    points_encoded: 'false',
    instructions: 'false',
    calc_points: 'false',
    key: apiKey,
  });
  params.append('point', `${destLat},${destLng}`);
  const data = await requestJson(`${GRAPHHOPPER_ROUTING_URL}?${params}`, {}, fetchImpl);
  const seconds = Number(data?.paths?.[0]?.time) / 1000;
  if (!Number.isFinite(seconds)) throw new Error('GraphHopper Routing: NO_ROUTE');
  return normaliseTimes(seconds, seconds);
}

async function getOpenRouteServiceTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl) {
  const data = await requestJson(OPENROUTESERVICE_ROUTING_URL, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      coordinates: [[originLng, originLat], [destLng, destLat]],
      instructions: false,
      preference: 'recommended',
    }),
  }, fetchImpl);
  const seconds = Number(data?.features?.[0]?.properties?.summary?.duration);
  if (!Number.isFinite(seconds)) throw new Error('openrouteservice: NO_ROUTE');
  return normaliseTimes(seconds, seconds);
}

async function getStadiaTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl) {
  const coordinates = `${originLng},${originLat};${destLng},${destLat}`;
  const params = new URLSearchParams({ api_key: apiKey, overview: 'false' });
  const data = await requestJson(`${STADIA_ROUTING_URL}/${coordinates}?${params}`, {}, fetchImpl);
  const seconds = Number(data?.routes?.[0]?.duration);
  if (!Number.isFinite(seconds)) throw new Error('Stadia Routing: NO_ROUTE');
  return normaliseTimes(seconds, seconds);
}

/**
 * Fetch one segment through a named non-legacy adapter. Legacy TomTom/HERE/
 * Distance Matrix adapters remain in trafficSchedulerCore.js for compatibility
 * with existing callers and migration tests.
 */
export async function getTrafficSegmentTravelTimes(providerId, originLat, originLng, destLat, destLng, options = {}) {
  const apiKey = getProviderApiKey(providerId, options);
  if (!hasValue(apiKey)) throw new Error(`${providerId}: provider not configured`);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  switch (providerId) {
    case 'google-routes':
      return getGoogleRoutesTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl);
    case 'mapbox':
      return getMapboxTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl);
    case 'geoapify':
      return getGeoapifyTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl);
    case 'openrouteservice':
      return getOpenRouteServiceTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl);
    case 'graphhopper':
      return getGraphhopperTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl);
    case 'stadia':
      return getStadiaTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl);
    default:
      throw new Error(`${providerId}: adapter is implemented in trafficSchedulerCore.js`);
  }
}

/** Build a stable error used when the local cap blocks a fallback. */
export function providerBudgetExhaustedError(providerId, budget, period) {
  const error = new Error(`${providerId} local budget exhausted (${budget}/${period})`);
  error.code = 'TRAFFIC_PROVIDER_BUDGET_EXHAUSTED';
  error.providerId = providerId;
  return error;
}
