#!/usr/bin/env node
/**
 * Prepare or register the USER-scoped GA4 dimensions for the assisted
 * application copy experiment. Dry-run is the default because GA4 custom
 * dimensions are durable and cannot be deleted once created.
 *
 *   node scripts/experiments/assisted-application-copy-ga4.mjs
 *   node scripts/experiments/assisted-application-copy-ga4.mjs --apply
 *
 * Requires GA4_PROPERTY_ID and service-account credentials. --apply should be
 * used only after the owner has reviewed the exact dry-run proposal.
 */
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  getServiceAccountToken,
  fetchRetry,
} from '../lib/ga4-service-account.mjs';
import { ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS } from '../../services/assistedApplicationCopyAnalyticsContract.mjs';

export const GA4_STANDARD_USER_DIMENSION_LIMIT = 25;

function normalizePropertyId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('GA4_PROPERTY_ID is required; refusing to use an implicit property.');
  return raw.startsWith('properties/') ? raw : `properties/${raw}`;
}

export function planUserDimensionRegistration(existingDimensions, requestedDimensions = ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS, limit = GA4_STANDARD_USER_DIMENSION_LIMIT) {
  const dimensions = Array.isArray(existingDimensions) ? existingDimensions : [];
  const userCount = dimensions.filter((dimension) => dimension?.scope === 'USER').length;
  const existing = new Map(dimensions.filter((dimension) => dimension?.parameterName).map((dimension) => [dimension.parameterName, dimension]));
  const alreadyPresent = [];
  const missing = [];
  const failures = [];

  for (const requested of requestedDimensions) {
    const current = existing.get(requested.parameterName);
    if (!current) {
      missing.push(requested);
      continue;
    }
    const mismatches = ['scope', 'displayName', 'description'].filter((field) => current[field] !== requested[field]);
    if (mismatches.length) {
      failures.push(`${requested.parameterName} already exists with incompatible ${mismatches.join(', ')}; no changes made.`);
    } else {
      alreadyPresent.push(requested.parameterName);
    }
  }

  if (!failures.length && userCount + missing.length > limit) {
    failures.push(`GA4 property is at the ${limit} USER-dimension limit (${userCount} registered); cannot add ${missing.map((d) => d.parameterName).join(', ')}.`);
  }
  return { propertyCount: userCount, limit, alreadyPresent, missing, failures };
}

function parseCli(argv) {
  return parseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }).values;
}

async function readDimensions(property, token, fetchImpl = fetchRetry) {
  const response = await fetchImpl(
    `https://analyticsadmin.googleapis.com/v1beta/${property}/customDimensions?pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`List GA4 custom dimensions failed: HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.customDimensions) ? body.customDimensions : [];
}

async function createDimension(property, token, dimension, fetchImpl = fetchRetry) {
  const response = await fetchImpl(`https://analyticsadmin.googleapis.com/v1beta/${property}/customDimensions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(dimension),
  });
  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).replace(/Bearer\s+\S+/giu, 'Bearer [redacted]').slice(0, 300);
    throw new Error(`Create ${dimension.parameterName} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
  }
}

export async function runRegistration(argv = process.argv.slice(2), {
  propertyId = process.env.GA4_PROPERTY_ID,
  getToken = getServiceAccountToken,
  fetchImpl = fetchRetry,
} = {}) {
  const args = parseCli(argv);
  if (args.help) {
    console.log('Dry-run by default. Set GA4_PROPERTY_ID and credentials; pass --apply only after owner review.');
    return { exitCode: 0 };
  }
  const property = normalizePropertyId(propertyId);
  const token = await getToken([
    'https://www.googleapis.com/auth/analytics.edit',
    'https://www.googleapis.com/auth/analytics.readonly',
  ]);
  if (!token) throw new Error('GA4 Admin API authentication failed.');
  const dimensions = await readDimensions(property, token, fetchImpl);
  const plan = planUserDimensionRegistration(dimensions);
  console.log(`GA4 property: ${property}`);
  console.log(`USER custom dimensions: ${plan.propertyCount}/${plan.limit}`);
  for (const name of plan.alreadyPresent) console.log(`= ${name}: already registered with USER scope`);
  for (const dimension of plan.missing) console.log(`+ ${dimension.parameterName}: scope=${dimension.scope}, displayName=${JSON.stringify(dimension.displayName)}`);
  for (const failure of plan.failures) console.error(`ERROR: ${failure}`);
  if (plan.failures.length) return { exitCode: 1, plan };
  if (!args.apply || args['dry-run']) {
    console.log('Dry-run: no GA4 definitions created. Owner review is required before --apply.');
    return { exitCode: 0, plan };
  }
  for (const dimension of plan.missing) {
    await createDimension(property, token, dimension, fetchImpl);
    console.log(`Created ${dimension.parameterName}.`);
  }
  return { exitCode: 0, plan };
}

if (isInvokedDirectly(import.meta.url)) {
  runRegistration().then(({ exitCode }) => process.exit(exitCode)).catch((error) => {
    console.error(`assisted-application-copy-ga4: ${error?.message || error}`);
    process.exit(1);
  });
}
