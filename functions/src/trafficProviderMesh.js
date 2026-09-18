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
const OPENROUTESERVICE_ROUTING_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car';
const STADIA_ROUTING_URL = 'https://api.stadiamaps.com/route/v1';
const REQUEST_TIMEOUT_MS = 12_000;

// Every route/flow request reserves its unit in its own Firestore transaction
// against ONE document per provider, and the collector fires a whole batch
// concurrently (5 crossings × 2 segments = 10 writers on the same document for
// mapbox). Firestore's default of 5 attempts is not enough headroom for that
// burst: on 2026-09-18 three reservations returned `10 ABORTED` and the run
// lost its only working provider. Contention retries are cheap and serialize
// naturally; the budget decision stays exact either way.
const RESERVATION_TX_MAX_ATTEMPTS = 15;

function quotaLimit({ period, quotaScope, documentId = null, budgetEnv, defaultBudget, safeMaximum = defaultBudget }) {
  return Object.freeze({ period, quotaScope, documentId, budgetEnv, defaultBudget, safeMaximum });
}

function quotaOperation({ unitCost = 1, limits, rateLimit = null }) {
  return Object.freeze({ unitCost, limits: Object.freeze(limits), rateLimit });
}

function openTransportDataQuota(plan) {
  return quotaOperation({
    limits: [quotaLimit({
      // ASTRA plan pages expose a 260,000-request allowance. Keep a lower
      // local ceiling by default and scope the ledger independently per plan.
      period: 'six-month',
      quotaScope: `opentransportdata-${plan}`,
      budgetEnv: 'OPENTRANSPORTDATA_QUOTA',
      defaultBudget: 234_000,
      safeMaximum: 260_000,
    })],
    // Five calls/minute => at least 12.5s between reservations, shared by
    // overlapping schedulers through Firestore.
    rateLimit: { maxPerMinute: 5, minIntervalMs: 12_500 },
  });
}

/**
 * Default caps are deliberately below the commonly advertised free quotas.
 * They are a safety ceiling, not a claim about the current commercial plan.
 * A deployment can tighten them further through Remote Config.
 */
export const TRAFFIC_PROVIDER_SPECS = Object.freeze({
  tomtom: Object.freeze({
    id: 'tomtom',
    key: 'tomtomApiKey',
    budgetScope: 'tomtom',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [quotaLimit({
          period: 'month',
          quotaScope: 'tomtom-routing',
          budgetEnv: 'TOMTOM_ROUTING_MONTHLY_BUDGET',
          defaultBudget: 18_000,
          safeMaximum: 20_000,
        })],
      }),
      flow: quotaOperation({
        limits: [quotaLimit({
          period: 'month',
          quotaScope: 'tomtom-flow',
          budgetEnv: 'TOMTOM_FLOW_MONTHLY_BUDGET',
          defaultBudget: 18_000,
          safeMaximum: 20_000,
        })],
      }),
    }),
    batchSize: 2,
    batchDelayMs: 1000,
    trafficAware: true,
  }),
  here: Object.freeze({
    id: 'here',
    key: 'hereApiKey',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [
          quotaLimit({
            period: 'day',
            quotaScope: 'here-daily',
            budgetEnv: 'HERE_DAILY_BUDGET',
            defaultBudget: 900,
            safeMaximum: 1_000,
          }),
          quotaLimit({
            period: 'month',
            quotaScope: 'here-monthly',
            // Keep reading/writing the document reconciled by
            // scripts/reconcile-here-usage.mjs. The generic quota fields are
            // compatible with its legacy `month` field via the read fallback.
            documentId: 'hereTransactionBudget',
            budgetEnv: 'HERE_MONTHLY_BUDGET',
            defaultBudget: 4_000,
            safeMaximum: 4_500,
          }),
        ],
      }),
    }),
    batchSize: 4,
    batchDelayMs: 1000,
    trafficAware: true,
  }),
  'google-routes': Object.freeze({
    id: 'google-routes',
    key: 'googleRoutesApiKey',
    budgetScope: 'google',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [quotaLimit({
          period: 'month',
          quotaScope: 'google',
          budgetEnv: 'GOOGLE_MONTHLY_BUDGET',
          defaultBudget: 4_500,
          safeMaximum: 5_000,
        })],
      }),
    }),
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
  mapbox: Object.freeze({
    id: 'mapbox',
    key: 'mapboxAccessToken',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [quotaLimit({
          period: 'month',
          quotaScope: 'mapbox',
          budgetEnv: 'MAPBOX_MONTHLY_BUDGET',
          defaultBudget: 5_000,
          safeMaximum: 100_000,
        })],
      }),
    }),
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
  geoapify: Object.freeze({
    id: 'geoapify',
    key: 'geoapifyApiKey',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [quotaLimit({
          period: 'day',
          quotaScope: 'geoapify',
          budgetEnv: 'GEOAPIFY_DAILY_BUDGET',
          defaultBudget: 2_500,
          safeMaximum: 3_000,
        })],
      }),
    }),
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
  openrouteservice: Object.freeze({
    id: 'openrouteservice',
    key: 'openrouteserviceApiKey',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [quotaLimit({
          period: 'day',
          quotaScope: 'openrouteservice',
          budgetEnv: 'OPENROUTESERVICE_DAILY_BUDGET',
          defaultBudget: 1_500,
          safeMaximum: 2_000,
        })],
      }),
    }),
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: false,
  }),
  graphhopper: Object.freeze({
    id: 'graphhopper',
    key: 'graphhopperApiKey',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [quotaLimit({
          period: 'day',
          quotaScope: 'graphhopper',
          budgetEnv: 'GRAPHHOPPER_DAILY_BUDGET',
          defaultBudget: 450,
          safeMaximum: 500,
        })],
      }),
    }),
    batchSize: 3,
    batchDelayMs: 500,
    trafficAware: false,
  }),
  stadia: Object.freeze({
    id: 'stadia',
    key: 'stadiaApiKey',
    quotas: Object.freeze({
      route: quotaOperation({
        unitCost: 20,
        limits: [quotaLimit({
          period: 'month',
          quotaScope: 'stadia',
          budgetEnv: 'STADIA_MONTHLY_CREDITS',
          defaultBudget: 180_000,
          safeMaximum: 200_000,
        })],
      }),
    }),
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: false,
  }),
  'google-maps': Object.freeze({
    id: 'google-maps',
    key: 'googleApiKey',
    budgetScope: 'google',
    quotas: Object.freeze({
      route: quotaOperation({
        limits: [quotaLimit({
          period: 'month',
          quotaScope: 'google',
          budgetEnv: 'GOOGLE_MONTHLY_BUDGET',
          defaultBudget: 4_500,
          safeMaximum: 5_000,
        })],
      }),
    }),
    batchSize: 5,
    batchDelayMs: 250,
    trafficAware: true,
  }),
  opentransportdata: Object.freeze({
    id: 'opentransportdata',
    key: 'opentransportdataApiKey',
    quotas: Object.freeze({
      // Keep route as a compatibility alias for callers that only know the
      // original LSA collector operation.
      route: openTransportDataQuota('traffic-lights'),
      'traffic-situations': openTransportDataQuota('traffic-situations'),
      'traffic-lights': openTransportDataQuota('traffic-lights'),
      'traffic-counters': openTransportDataQuota('traffic-counters'),
    }),
    batchSize: 1,
    batchDelayMs: 12_500,
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
  return providerQuotaDefinition(providerId, 'route', env).limits[0].budget;
}

export function providerPeriod(providerId, date = new Date()) {
  return providerQuotaDefinition(providerId, 'route').limits[0].periodKey(date);
}

function periodKey(period, date = new Date()) {
  const iso = date.toISOString();
  if (period === 'lifetime') return 'all-time';
  if (period === 'month') return iso.slice(0, 7);
  if (period === 'six-month') {
    const half = Number(iso.slice(5, 7)) <= 6 ? 'H1' : 'H2';
    return `${iso.slice(0, 4)}-${half}`;
  }
  return iso.slice(0, 10);
}

export function providerQuotaDefinition(providerId, operation = 'route', env = process.env) {
  const spec = TRAFFIC_PROVIDER_SPECS[providerId];
  if (!spec) throw new Error(`Unknown traffic provider: ${providerId}`);
  const selected = spec.quotas?.[operation] ?? spec.quotas?.route;
  if (!selected) throw new Error(`Unknown ${providerId} quota operation: ${operation}`);
  return {
    unitCost: selected.unitCost ?? 1,
    rateLimit: selected.rateLimit ?? null,
    limits: selected.limits.map((limit) => ({
      ...limit,
      budget: Math.min(
        parseProviderBudget(env[limit.budgetEnv], limit.defaultBudget),
        limit.safeMaximum ?? Number.MAX_SAFE_INTEGER,
      ),
      periodKey: (date) => periodKey(limit.period, date),
    })),
  };
}

/**
 * Firestore counters are written as numbers. Accept a strict decimal string
 * for compatibility with an old deployment, but never coerce blank, null, or
 * arbitrary values to zero: a current-period malformed counter is unsafe.
 */
function parsePersistedInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : Number.NaN;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
  }
  return value === undefined || value === null || value === '' ? null : Number.NaN;
}

/** Pure atomic budget decision; safe to use in tests and transaction code. */
export function computeProviderBudgetDecision({
  storedPeriod,
  storedCount,
  period,
  callsThisRun,
  budget,
}) {
  const current = storedPeriod === period
    ? parsePersistedInteger(storedCount)
    : 0;
  const calls = Number(callsThisRun);
  const cap = Number(budget);
  if (!Number.isSafeInteger(current) || current < 0) return { allowed: false, count: current };
  if (!Number.isSafeInteger(calls) || calls < 0) return { allowed: false, count: current };
  if (!Number.isSafeInteger(cap) || cap < 0) return { allowed: false, count: current };
  if (!Number.isSafeInteger(current + calls)) return { allowed: false, count: current };
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
  return reserveTrafficProviderRequest(providerId, 'route', callsThisRun, now);
}

/**
 * Atomically reserves the smallest unit that is about to be sent to a provider.
 * Every actual route/flow request uses this guard immediately before fetch.
 * Firestore is the shared state because scheduled runs and manual dispatches
 * can overlap on different runners.
 */
export async function reserveTrafficProviderRequest(providerId, operation = 'route', units = null, now = new Date()) {
  const spec = TRAFFIC_PROVIDER_SPECS[providerId];
  if (!spec) throw new Error(`Unknown traffic provider: ${providerId}`);
  const quota = providerQuotaDefinition(providerId, operation);
  const requestedUnits = units === null ? quota.unitCost : Number(units);
  if (!Number.isSafeInteger(requestedUnits) || requestedUnits <= 0) {
    return { allowed: false, reason: 'invalid-units', provider: providerId, operation };
  }
  const adm = ensureAdminApp();
  const db = adm.firestore();
  const quotaRefs = quota.limits.map((limit) => ({
    limit,
    ref: db.collection('meta').doc(limit.documentId ?? `trafficProviderQuota-${limit.quotaScope}`),
  }));
  // Before the mesh, the generic guard stored provider totals under this
  // document. Read it in the same transaction so the first new reservation
  // cannot reset an existing counter and spend a second full allowance.
  const legacyBudgetScope = spec.budgetScope ?? providerId;
  const legacyRef = db.collection('meta').doc(`trafficProviderBudget-${legacyBudgetScope}`);
  const legacyIsSeparate = !quotaRefs.some(({ ref }) => ref.path === legacyRef.path);
  const legacyQuota = providerQuotaDefinition(providerId, 'route');
  const legacyPeriodType = legacyQuota.limits[0].period;
  const legacyBudget = legacyQuota.limits[0].budget;
  const rateRef = quota.rateLimit
    ? db.collection('meta').doc(`trafficProviderRate-${providerId}-${operation}`)
    : null;

  return db.runTransaction(async (tx) => {
    const snapshots = [];
    for (const item of quotaRefs) snapshots.push({ ...item, snap: await tx.get(item.ref) });
    const legacySnap = legacyIsSeparate ? await tx.get(legacyRef) : null;
    const rateSnap = rateRef ? await tx.get(rateRef) : null;
    const legacyData = legacySnap?.exists ? legacySnap.data() : {};
    const legacyPeriod = providerPeriod(providerId, now);
    const legacyStoredPeriod = legacyData.period ?? legacyData.month;
    const legacyDecision = legacyIsSeparate
      ? computeProviderBudgetDecision({
        storedPeriod: legacyStoredPeriod,
        storedCount: legacyData.count,
        period: legacyPeriod,
        callsThisRun: requestedUnits,
        budget: legacyBudget,
      })
      : null;
    if (legacyDecision && !legacyDecision.allowed && legacyStoredPeriod === legacyPeriod) {
      return {
        allowed: false,
        reason: 'legacy-quota-state',
        provider: providerId,
        operation,
        period: legacyPeriod,
        count: legacyDecision.count,
      };
    }
    const decisions = snapshots.map(({ limit, snap }) => {
      const period = periodKey(limit.period, now);
      const data = snap.exists ? snap.data() : {};
      const storedPeriod = data.period ?? data.month;
      const hasCurrentQuotaState = storedPeriod === period;
      // A legacy current-period counter is the conservative starting point
      // only when the new operation document has not started its own period.
      // If the new document is current but malformed, computeProviderBudgetDecision
      // remains fail-closed instead of hiding corruption behind the fallback.
      const useLegacyState = !hasCurrentQuotaState
        && legacyDecision
        && legacyStoredPeriod === legacyPeriod
        && limit.period === legacyPeriodType;
      return {
        limit,
        period,
        decision: computeProviderBudgetDecision({
          // `month` keeps compatibility with the pre-mesh HERE document while
          // the new quota docs use the neutral `period` field.
          storedPeriod: useLegacyState ? period : storedPeriod,
          storedCount: useLegacyState ? legacyData.count : data.count,
          period,
          callsThisRun: requestedUnits,
          budget: limit.budget,
        }),
      };
    });
    const rateData = rateSnap?.exists ? rateSnap.data() : null;
    const rawLastRequestAtMs = rateData?.lastRequestAtMs;
    const lastRequestAtMs = parsePersistedInteger(rawLastRequestAtMs);
    const nowMs = now.getTime();
    const minIntervalMs = quota.rateLimit?.minIntervalMs ?? 0;
    if (minIntervalMs > 0 && rateSnap?.exists
      && (!Number.isSafeInteger(lastRequestAtMs) || lastRequestAtMs <= 0)) {
      return {
        allowed: false,
        reason: 'invalid-rate-state',
        provider: providerId,
        operation,
      };
    }
    if (minIntervalMs > 0 && Number.isFinite(lastRequestAtMs) && lastRequestAtMs > 0
      && nowMs - lastRequestAtMs < minIntervalMs) {
      return {
        allowed: false,
        reason: 'rate-limit',
        provider: providerId,
        operation,
        retryAfterMs: minIntervalMs - (nowMs - lastRequestAtMs),
      };
    }
    const failed = decisions.find((item) => !item.decision.allowed);
    if (failed) {
      return {
        allowed: false,
        reason: 'quota',
        provider: providerId,
        operation,
        period: failed.period,
        budget: failed.limit.budget,
        count: failed.decision.count,
      };
    }
    const updatedAt = adm.firestore.Timestamp.now();
    for (const [index, item] of decisions.entries()) {
      tx.set(quotaRefs[index].ref, {
        provider: providerId,
        operation,
        period: item.period,
        ...(quotaRefs[index].limit.documentId ? { month: item.period } : {}),
        count: item.decision.count,
        budget: item.limit.budget,
        units: 'provider-defined',
        updatedAt,
      }, { merge: true });
    }
    if (legacyIsSeparate && legacyDecision) {
      tx.set(legacyRef, {
        provider: providerId,
        budgetScope: legacyBudgetScope,
        period: legacyPeriod,
        count: legacyDecision.count,
        budget: legacyBudget,
        updatedAt,
      }, { merge: true });
    }
    if (rateRef) tx.set(rateRef, {
      provider: providerId,
      operation,
      lastRequestAtMs: nowMs,
      minIntervalMs,
      updatedAt,
    });
    return {
      allowed: true,
      provider: providerId,
      operation,
      units: requestedUnits,
      periods: decisions.map((item) => ({ period: item.period, count: item.decision.count, budget: item.limit.budget })),
    };
  }, { maxAttempts: RESERVATION_TX_MAX_ATTEMPTS });
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

/**
 * Reservation refusals that describe a MOMENTARY condition, not a spent
 * allowance. The reservation itself still fails closed — an unmetered paid
 * request is never sent — but the provider must stay eligible for the next
 * segment.
 *
 * `quota-check-failed` is the Firestore transaction itself failing, typically
 * `10 ABORTED: cross-transaction contention` because a batch of 5 crossings
 * reserves 10 units concurrently against the same `meta/trafficProviderQuota-*`
 * document. `rate-limit` is a per-provider minimum interval that carries its
 * own `retryAfterMs`. Treating either as account-wide is what turned three
 * aborted transactions into a 5.6-hour outage on 2026-09-18: mapbox — the only
 * provider that actually serves all 141 crossings — was banned mid-run and the
 * mesh collapsed onto its misconfigured fallbacks.
 */
export const TRANSIENT_RESERVATION_REASONS = Object.freeze(['quota-check-failed', 'rate-limit']);

/** True when a refusal must not disable the provider for the rest of the run. */
export function isTransientProviderRefusal(error) {
  return TRANSIENT_RESERVATION_REASONS.includes(error?.reason);
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

async function reserveRequestIfNeeded(options, providerId, operation = 'route') {
  const reserveRequest = options?.providerRuntime?.reserveRequest;
  if (typeof reserveRequest !== 'function') return;
  const result = await reserveRequest(providerId, operation);
  if (result === false || result?.allowed === false) {
    const error = providerBudgetExhaustedError(
      providerId,
      result?.budget,
      result?.period,
      result?.reason ?? 'quota',
    );
    error.retryAfterMs = result?.retryAfterMs;
    throw error;
  }
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

async function getGoogleRoutesTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options = {}) {
  await reserveRequestIfNeeded(options, 'google-routes');
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

async function getMapboxTimes(originLat, originLng, destLat, destLng, token, fetchImpl, options = {}) {
  await reserveRequestIfNeeded(options, 'mapbox');
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

async function getGeoapifyTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options = {}) {
  await reserveRequestIfNeeded(options, 'geoapify');
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

async function getGraphhopperTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options = {}) {
  await reserveRequestIfNeeded(options, 'graphhopper');
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

async function getOpenRouteServiceTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options = {}) {
  await reserveRequestIfNeeded(options, 'openrouteservice');
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

/**
 * Stadia Maps routing is Valhalla, not OSRM: `POST /route/v1?api_key=…` with a
 * JSON body. The original adapter called it OSRM-style — a GET on
 * `/route/v1/driving/{lng,lat;lng,lat}` — which is not a route on that host and
 * answered `HTTP 404` with an empty body on EVERY segment since the provider
 * was added. It was the final error for 45 of the 141 crossings in run
 * 35358498994, and its 20-credit reservation was spent on each of those 404s.
 *
 * Both response shapes are accepted: `trip.summary.time` is the native reply,
 * `routes[0].duration` the OSRM-formatted one.
 */
async function getStadiaTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options = {}) {
  await reserveRequestIfNeeded(options, 'stadia');
  const params = new URLSearchParams({ api_key: apiKey });
  const data = await requestJson(`${STADIA_ROUTING_URL}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [
        { lat: originLat, lon: originLng },
        { lat: destLat, lon: destLng },
      ],
      costing: 'auto',
      directions_options: { units: 'kilometers' },
    }),
  }, fetchImpl);
  const seconds = Number(data?.trip?.summary?.time ?? data?.routes?.[0]?.duration);
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
      return getGoogleRoutesTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options);
    case 'mapbox':
      return getMapboxTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options);
    case 'geoapify':
      return getGeoapifyTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options);
    case 'openrouteservice':
      return getOpenRouteServiceTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options);
    case 'graphhopper':
      return getGraphhopperTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options);
    case 'stadia':
      return getStadiaTimes(originLat, originLng, destLat, destLng, apiKey, fetchImpl, options);
    default:
      throw new Error(`${providerId}: adapter is implemented in trafficSchedulerCore.js`);
  }
}

/** Build a stable error used when the local cap blocks a fallback. */
export function providerBudgetExhaustedError(providerId, budget, period, reason = 'quota') {
  const error = new Error(
    `${providerId} reservation refused (${reason}) — local budget ${budget}/${period}`,
  );
  error.code = 'TRAFFIC_PROVIDER_BUDGET_EXHAUSTED';
  error.providerId = providerId;
  error.reason = reason;
  return error;
}
