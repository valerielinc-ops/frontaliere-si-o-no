#!/usr/bin/env node
/**
 * setup-ga4-ad-page-diag-definitions.mjs — register the EVENT-scoped GA4
 * custom dimensions and metrics of `ad_page_diag` (list and rationale in
 * scripts/lib/ga4-ad-page-diag-definitions.mjs).
 *
 * Idempotent and additive only: it lists what the property already has, never
 * creates a parameterName that exists (in either list), never updates or
 * archives anything, and treats a concurrent 409 as success. The three shared
 * dimensions (page_template, consent_state, gate_status) are only checked.
 *
 * Auth: same service account and property as the other GA4 admin scripts.
 *   GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/frontaliere/sa-frontaliere-ticino.json \
 *     node scripts/setup-ga4-ad-page-diag-definitions.mjs [--dry-run]
 *
 * Exits non-zero on any failure (one-off admin script, not a CI step).
 */
import { DEFAULT_GA4_PROPERTY_ID, fetchRetry, getServiceAccountToken } from './lib/ga4-service-account.mjs';
import {
  AD_PAGE_DIAG_GA4_CUSTOM_DIMENSIONS,
  AD_PAGE_DIAG_GA4_CUSTOM_METRICS,
  AD_PAGE_DIAG_GA4_SHARED_DIMENSIONS,
} from './lib/ga4-ad-page-diag-definitions.mjs';

const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
const dryRun = process.argv.includes('--dry-run');
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';

async function listAll(headers, kind) {
  const out = [];
  let pageToken = '';
  do {
    const url = `${ADMIN}/${propertyId}/${kind}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetchRetry(url, { headers });
    if (!res.ok) throw new Error(`list ${kind}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const body = await res.json();
    out.push(...(body[kind] || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function create(headers, kind, definition) {
  const res = await fetchRetry(`${ADMIN}/${propertyId}/${kind}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...definition, scope: 'EVENT' }),
  });
  if (res.ok || res.status === 409) return res.status === 409 ? 'raced' : 'created';
  throw new Error(`create ${kind} ${definition.parameterName}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
}

async function main() {
  const token = await getServiceAccountToken([
    'https://www.googleapis.com/auth/analytics.edit',
    'https://www.googleapis.com/auth/analytics.readonly',
  ]);
  if (!token) throw new Error('service-account token unavailable (set GOOGLE_APPLICATION_CREDENTIALS)');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const dimensions = await listAll(headers, 'customDimensions');
  const metrics = await listAll(headers, 'customMetrics');
  const taken = new Set([...dimensions, ...metrics].map((d) => d.parameterName));
  const eventDims = dimensions.filter((d) => d.scope === 'EVENT').length;
  console.log(`GA4 ${propertyId}: ${eventDims} event dimensions, ${metrics.length} metrics registered`);

  for (const name of AD_PAGE_DIAG_GA4_SHARED_DIMENSIONS) {
    if (!taken.has(name)) throw new Error(`shared dimension ${name} is missing from the property`);
    console.log(`shared   ${name}`);
  }

  const plan = [
    ...AD_PAGE_DIAG_GA4_CUSTOM_DIMENSIONS.map((d) => ['customDimensions', d]),
    ...AD_PAGE_DIAG_GA4_CUSTOM_METRICS.map((m) => ['customMetrics', m]),
  ];
  for (const [kind, definition] of plan) {
    if (taken.has(definition.parameterName)) {
      console.log(`exists   ${definition.parameterName}`);
      continue;
    }
    if (dryRun) {
      console.log(`would create ${kind} ${definition.parameterName}`);
      continue;
    }
    const outcome = await create(headers, kind, definition);
    console.log(`${outcome.padEnd(8)} ${kind} ${definition.parameterName} (${definition.displayName})`);
  }
}

main().catch((error) => {
  console.error(`setup-ga4-ad-page-diag-definitions failed: ${error?.message || error}`);
  process.exitCode = 1;
});
