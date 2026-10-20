#!/usr/bin/env node

import {
  DEFAULT_GA4_PROPERTY_ID,
  getServiceAccountToken,
} from './lib/ga4-service-account.mjs';
import {
  EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS,
  ensureGa4CustomDimensions,
} from './lib/ga4-employer-insights-dimensions.mjs';

const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;

async function main() {
  const token = await getServiceAccountToken([
    'https://www.googleapis.com/auth/analytics.edit',
    'https://www.googleapis.com/auth/analytics.readonly',
  ]);
  if (!token) throw new Error('GA4 service-account token unavailable for custom-dimension provisioning');

  const result = await ensureGa4CustomDimensions({
    propertyId,
    token,
  });
  for (const parameterName of result.registered) {
    console.log(`Registered GA4 employer-insights custom dimension: ${parameterName}`);
  }
  for (const parameterName of result.alreadyPresent) {
    console.log(`GA4 employer-insights custom dimension already present: ${parameterName}`);
  }
  for (const parameterName of result.raced) {
    console.log(`GA4 employer-insights custom dimension created concurrently: ${parameterName}`);
  }
  if (result.failures.length) {
    throw new Error(`GA4 employer-insights custom-dimension provisioning failed: ${result.failures.join(' | ')}`);
  }
  console.log(
    `GA4 employer-insights custom-dimension provisioning complete (${EMPLOYER_INSIGHTS_GA4_CUSTOM_DIMENSIONS.length} required parameters).`,
  );
}

main().catch((error) => {
  console.error(`::error::${error?.message || error}`);
  process.exitCode = 1;
});
