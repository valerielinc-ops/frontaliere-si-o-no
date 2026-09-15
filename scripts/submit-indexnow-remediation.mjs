#!/usr/bin/env node

/**
 * Submit only the URLs Bing identified as missing via single-URL streaming.
 *
 * The full-sitemap batch remains available as an explicit manual recovery
 * tool; routine remediation must not recreate the batch-mode warning.
 */

import { BING_INDEXNOW_REMEDIATION_URLS } from './seo/bing-seo-policy.mjs';
import { submitIndexNowUrlsStreaming } from './lib/indexnow-submit.mjs';

const dryRun = process.argv.includes('--dry-run');

async function preflight(urls) {
  const live = [];
  const skipped = [];
  const errors = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'frontaliere-indexnow-remediation/1.0 (+https://frontaliereticino.ch/)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      const finalUrl = response.url || url;
      if (response.body?.cancel) await response.body.cancel();
      if (response.status === 404) {
        skipped.push({ url, status: response.status, reason: 'not-found' });
      } else if (response.status >= 200 && response.status < 400) {
        live.push(finalUrl);
      } else {
        errors.push({ url, status: response.status, reason: 'unexpected-status' });
      }
    } catch (error) {
      errors.push({ url, reason: error?.message || String(error) });
    }
  }

  return { live, skipped, errors };
}

const checked = await preflight(BING_INDEXNOW_REMEDIATION_URLS);
const output = {
  dryRun,
  requested: BING_INDEXNOW_REMEDIATION_URLS.length,
  ...checked,
};

if (!dryRun && checked.errors.length === 0 && checked.live.length > 0) {
  output.result = await submitIndexNowUrlsStreaming(checked.live, {
    batchSize: 1,
    delayMs: 750,
  });
  if (output.result.results.some((item) => !item.ok)) process.exitCode = 1;
}

if (checked.errors.length > 0) process.exitCode = 1;
console.log(JSON.stringify(output, null, 2));
