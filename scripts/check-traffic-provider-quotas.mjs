#!/usr/bin/env node
/**
 * Non-billable provider health/quota report.
 *
 * The report intentionally distinguishes “the provider exposes an API usage
 * endpoint” from “we have a local hard cap”. Mapbox's official statistics are
 * dashboard-only, so this script validates the token through the Tokens API and
 * reports the Firestore cap as the enforceable guard. It never sends a route
 * request: the scheduler's already-budgeted preflight is the route health check.
 */

import { buildTrafficProviderChain, providerQuotaDefinition } from '../functions/src/trafficProviderMesh.js';

const jsonOutput = process.argv.includes('--json');
const requireOtdPlans = process.argv.includes('--require-otd-plans');

const OTD_PLANS = Object.freeze([
  {
    id: 'astra-situation',
    label: 'ASTRA traffic situations',
    operation: 'traffic-situations',
    tokenEnv: 'OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN',
    hashEnv: 'OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN_HASH',
  },
  {
    id: 'astra-lsa',
    label: 'ASTRA LSA traffic lights',
    operation: 'traffic-lights',
    tokenEnv: 'OPENTRANSPORTDATA_ASTRA_LSA_TOKEN',
    hashEnv: 'OPENTRANSPORTDATA_ASTRA_LSA_TOKEN_HASH',
  },
  {
    id: 'astra-counters',
    label: 'ASTRA traffic counters',
    operation: 'traffic-counters',
    tokenEnv: 'OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN',
    hashEnv: 'OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN_HASH',
  },
]);

const PROVIDER_CREDENTIALS = Object.freeze([
  { id: 'tomtom', env: 'TOMTOM_API_KEY' },
  { id: 'here', env: 'HERE_API_KEY' },
  { id: 'google-routes', env: 'GOOGLE_ROUTES_API_KEY', fallbackEnv: 'GOOGLE_MAPS_API_KEY' },
  { id: 'google-maps', env: 'GOOGLE_MAPS_API_KEY' },
  { id: 'mapbox', env: 'MAPBOX_SECRET_TOKEN', fallbackEnv: 'MAPBOX_PUBLIC_TOKEN' },
  { id: 'geoapify', env: 'GEOAPIFY_API_KEY' },
  { id: 'openrouteservice', env: 'OPENROUTESERVICE_API_KEY' },
  { id: 'graphhopper', env: 'GRAPHHOPPER_API_KEY' },
  { id: 'stadia', env: 'STADIA_API_KEY' },
]);

function has(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function mapboxTokenPayload(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function checkMapbox() {
  const token = process.env.MAPBOX_SECRET_TOKEN || process.env.MAPBOX_PUBLIC_TOKEN;
  if (!has(token)) return { id: 'mapbox', status: 'skipped', reason: 'missing token' };
  const payload = mapboxTokenPayload(token);
  try {
    const response = await fetch(`https://api.mapbox.com/tokens/v2?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({}));
    return {
      id: 'mapbox',
      status: response.ok ? 'ok' : 'error',
      tokenValid: response.ok,
      tokenKind: token.startsWith('pk.') ? 'public' : 'other',
      tokenIdPresent: Boolean(body?.id || payload?.id),
      usageApiAvailable: false,
      guard: 'firestore-local-budget',
    };
  } catch (error) {
    return { id: 'mapbox', status: 'error', error: error.message, guard: 'firestore-local-budget' };
  }
}

function configuredProviderReport() {
  return buildTrafficProviderChain({
    tomtomApiKey: process.env.TOMTOM_API_KEY,
    hereApiKey: process.env.HERE_API_KEY,
    googleRoutesApiKey: process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY,
    mapboxAccessToken: process.env.MAPBOX_SECRET_TOKEN || process.env.MAPBOX_PUBLIC_TOKEN,
    geoapifyApiKey: process.env.GEOAPIFY_API_KEY,
    openrouteserviceApiKey: process.env.OPENROUTESERVICE_API_KEY,
    graphhopperApiKey: process.env.GRAPHHOPPER_API_KEY,
    stadiaApiKey: process.env.STADIA_API_KEY,
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
  }).map((spec) => providerReport(spec.id));
}

function providerCredentialReport() {
  return PROVIDER_CREDENTIALS.map((provider) => {
    const direct = has(process.env[provider.env]);
    const fallback = provider.fallbackEnv ? has(process.env[provider.fallbackEnv]) : false;
    return {
      id: provider.id,
      credential: direct ? 'direct' : fallback ? 'fallback' : 'missing',
      configured: direct || fallback,
      fallback: fallback ? provider.fallbackEnv : null,
    };
  });
}

function providerReport(providerId, operation = 'route') {
  const quota = providerQuotaDefinition(providerId, operation);
  return {
    id: providerId,
    operation,
    configured: true,
    unitCost: quota.unitCost,
    limits: quota.limits.map((limit) => ({
      period: limit.period,
      currentPeriod: limit.periodKey(new Date()),
      localBudget: limit.budget,
      scope: limit.quotaScope,
    })),
    rateLimit: quota.rateLimit,
    usageApi: providerId === 'mapbox' ? 'dashboard-only' : 'not-polled-without-billable-probe',
    rotation: 'on-429-or-account-limit-or-local-quota',
  };
}

function officialTrafficPlanReport(plan) {
  const quota = providerQuotaDefinition('opentransportdata', plan.operation);
  const tokenPresent = has(process.env[plan.tokenEnv]);
  const tokenHashPresent = has(process.env[plan.hashEnv]);
  return {
    id: 'opentransportdata',
    plan: plan.id,
    label: plan.label,
    operation: plan.operation,
    configured: tokenPresent,
    status: tokenPresent ? 'configured' : 'skipped',
    tokenPresent,
    tokenHashPresent,
    tokenHashUsed: false,
    limits: quota.limits.map((limit) => ({
      period: limit.period,
      currentPeriod: limit.periodKey(new Date()),
      localBudget: limit.budget,
      scope: limit.quotaScope,
    })),
    rateLimit: quota.rateLimit,
    usageApi: 'not-polled-without-billable-probe',
    guard: 'firestore-local-budget-and-rate-limit',
  };
}

const officialTrafficPlans = OTD_PLANS.map(officialTrafficPlanReport);
// Keep the original field for consumers that only render the LSA feed.
const officialTraffic = officialTrafficPlans.find((plan) => plan.operation === 'traffic-lights');

const report = {
  generatedAt: new Date().toISOString(),
  mapbox: await checkMapbox(),
  providerCredentials: providerCredentialReport(),
  configuredProviders: configuredProviderReport(),
  officialTraffic,
  officialTrafficPlans,
  guarantees: {
    noRouteProbe: true,
    budgetReservation: 'Firestore transaction immediately before each provider request; fail-closed on check errors',
    rateLimit: 'OpenTransportData ASTRA plans: independent Firestore interval guards at 12.5 seconds (<=5/minute)',
    mapboxUsage: 'official usage API unavailable; dashboard remains authoritative',
    requiredOtdPlans: requireOtdPlans,
  },
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Traffic provider health — ${report.generatedAt}`);
  console.log(`Mapbox token: ${report.mapbox.status}; usage API: dashboard-only; guard: Firestore budget`);
  for (const provider of report.providerCredentials) {
    console.log(`${provider.id}: ${provider.credential}`);
  }
  for (const provider of report.configuredProviders) {
    const caps = provider.limits.map((limit) => `${limit.localBudget}/${limit.currentPeriod}`).join(',');
    console.log(`${provider.id}/${provider.operation}: configured; cap=${caps}; rotation=${provider.rotation}`);
  }
  for (const plan of report.officialTrafficPlans) {
    const cap = plan.limits[0];
    console.log(
      `opentransportdata/${plan.plan}: ${plan.configured ? 'configured' : 'skipped'}; ` +
      `tokenHash=${plan.tokenHashPresent ? 'present' : 'absent'}; ` +
      (plan.configured
        ? `cap=${cap.localBudget}/${cap.currentPeriod}; rate<=5/min`
        : 'missing token'),
    );
  }
  if (!report.configuredProviders.length) console.log('No provider key loaded from Remote Config.');
}

// Only token/authentication failure is a health failure. Unknown usage is an
// expected state for providers that do not expose a public metering endpoint.
if (report.mapbox.status === 'error') process.exitCode = 1;
if (requireOtdPlans && report.officialTrafficPlans.some((plan) => !plan.configured)) process.exitCode = 1;
