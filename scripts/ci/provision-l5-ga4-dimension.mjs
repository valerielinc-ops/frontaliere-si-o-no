#!/usr/bin/env node

import {
  DEFAULT_GA4_PROPERTY_ID,
  getServiceAccountToken,
} from '../lib/ga4-service-account.mjs';
import { ensureGa4CustomDimensions } from '../lib/ga4-custom-dimensions.mjs';
import { L5_DECISION_SESSION_DIMENSION } from '../lib/ga4-l5-decision-dimension.mjs';

const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;

async function main() {
  const token = await getServiceAccountToken([
    'https://www.googleapis.com/auth/analytics.edit',
    'https://www.googleapis.com/auth/analytics.readonly',
  ]);
  if (!token) throw new Error('GA4 service-account token unavailable for L5 custom-dimension provisioning');

  const result = await ensureGa4CustomDimensions({
    propertyId,
    token,
    dimensions: [L5_DECISION_SESSION_DIMENSION],
  });
  for (const parameterName of result.registered) {
    console.log(`Registered GA4 L5 custom dimension: ${parameterName}`);
  }
  for (const parameterName of result.alreadyPresent) {
    console.log(`GA4 L5 custom dimension already present: ${parameterName}`);
  }
  for (const parameterName of result.raced) {
    console.log(`GA4 L5 custom dimension created concurrently: ${parameterName}`);
  }
  if (result.failures.length) {
    throw new Error(`GA4 L5 custom-dimension provisioning failed: ${result.failures.join(' | ')}`);
  }
  console.log('GA4 L5 custom-dimension provisioning complete.');
}

main().catch((error) => {
  console.error(`::error::${error?.message || error}`);
  process.exitCode = 1;
});
