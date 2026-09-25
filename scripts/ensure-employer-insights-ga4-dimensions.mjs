#!/usr/bin/env node

import {
  ensureGa4CustomDimensions,
} from './lib/ga4-custom-dimensions.mjs';

async function main() {
  const result = await ensureGa4CustomDimensions({
    logInfo: (message) => console.log(`ℹ️  ${message}`),
    logWarning: (message) => console.warn(`⚠️  ${message}`),
  });
  console.log(
    `Employer Insights GA4 dimensions ready: ${result.created.length} created, ${result.skipped.length} already present.`,
  );
}

main().catch((error) => {
  console.error(`❌ Employer Insights GA4 dimension preflight failed: ${error?.message || error}`);
  process.exitCode = 1;
});
