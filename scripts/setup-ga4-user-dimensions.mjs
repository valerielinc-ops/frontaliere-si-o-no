#!/usr/bin/env node
/**
 * setup-ga4-user-dimensions.mjs — register the 3 USER-scoped GA4 custom
 * dimensions needed for revenue-per-user reporting (Stage 2, companion to
 * the Stage 1 event-emitting code that sets these as GA4 user properties):
 *
 *   - is_registered
 *   - is_newsletter_subscriber
 *   - is_job_alert_subscriber
 *
 * All three are boolean, USER scope (`scope: 'USER'`), so they persist on
 * every event for a user session, not just the event that set them —
 * unlike the EVENT-scoped custom dimensions already auto-registered in
 * scripts/analytics-report.mjs (error/funnel tracking).
 *
 * Idempotent: GETs existing custom dimensions first and skips any
 * parameterName already registered, so it's safe to re-run.
 *
 * NOTE: GA4 custom dimensions, once created, CANNOT be deleted via the API
 * or UI (only archived by leaving them unused) — this is why the script
 * checks before creating rather than blindly POSTing.
 *
 * Auth (same service account as scripts/analytics-report.mjs):
 *   GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/setup-ga4-user-dimensions.mjs
 *
 * The service account needs:
 *   1. OAuth scope https://www.googleapis.com/auth/analytics.edit (requested
 *      below — analytics.readonly alone is NOT enough for Admin API writes).
 *   2. Editor (or Administrator) role granted on THIS GA4 property via
 *      GA4 Admin > Property Access Management — a scope alone does not
 *      grant property access; a human with GA4 login must add the SA's
 *      email as a property user. This step cannot be done via API by a
 *      service account (chicken-and-egg: you need existing access to grant
 *      access).
 *
 * Environment variables:
 *   GA4_PROPERTY_ID — GA4 numeric property ID (e.g. "properties/123456789").
 *                     Defaults to the property analytics-report.mjs already
 *                     reports against.
 *
 * Exits non-zero on failure (this is a one-off admin script, not a CI report
 * step — unlike analytics-report.mjs it should NOT silently succeed).
 */

// GA4 property ID is a public numeric identifier, not a secret — same
// default as scripts/analytics-report.mjs reportGA4().
const propertyId = process.env.GA4_PROPERTY_ID || 'properties/524485296';

const REQUIRED_USER_DIMS = [
  {
    parameterName: 'is_registered',
    displayName: 'Is Registered User',
    description: 'Whether the user has a registered account (true/false), for revenue-per-user segmentation',
  },
  {
    parameterName: 'is_newsletter_subscriber',
    displayName: 'Is Newsletter Subscriber',
    description: 'Whether the user is subscribed to the newsletter (true/false), for revenue-per-user segmentation',
  },
  {
    parameterName: 'is_job_alert_subscriber',
    displayName: 'Is Job Alert Subscriber',
    description: 'Whether the user is subscribed to job alerts (true/false), for revenue-per-user segmentation',
  },
];

async function getServiceAccountToken(scopes) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('❌ GOOGLE_APPLICATION_CREDENTIALS not set. See script header for usage.');
    process.exit(1);
  }
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes });
  const client = await auth.getClient();
  // Log SA email for diagnostics (not a secret — it's a public GCP identifier)
  if (client.email) console.log(`ℹ️  Using service account: ${client.email}`);
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('getAccessToken() returned no token');
  return token;
}

async function listExistingDimensions(headers) {
  const res = await fetch(
    `https://analyticsadmin.googleapis.com/v1beta/${propertyId}/customDimensions?pageSize=200`,
    { headers }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`list customDimensions ${res.status}: ${errText.slice(0, 500)}`);
  }
  const data = await res.json();
  const existing = new Map();
  for (const dim of data.customDimensions || []) {
    existing.set(dim.parameterName, dim);
  }
  return existing;
}

async function createDimension(headers, dim) {
  const res = await fetch(
    `https://analyticsadmin.googleapis.com/v1beta/${propertyId}/customDimensions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        parameterName: dim.parameterName,
        displayName: dim.displayName,
        description: dim.description,
        scope: 'USER',
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`create "${dim.parameterName}" ${res.status}: ${errText.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  if (!propertyId || propertyId === 'properties/XXXXXXXX') {
    console.error('❌ GA4_PROPERTY_ID not configured and no default available.');
    process.exit(1);
  }
  console.log(`📊 GA4 property: ${propertyId}`);

  const token = await getServiceAccountToken([
    'https://www.googleapis.com/auth/analytics.edit',
    'https://www.googleapis.com/auth/analytics.readonly',
  ]);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  console.log('🔎 Listing existing custom dimensions...');
  const existing = await listExistingDimensions(headers);

  let created = 0;
  let skipped = 0;
  for (const dim of REQUIRED_USER_DIMS) {
    const existingDim = existing.get(dim.parameterName);
    if (existingDim) {
      const scopeNote = existingDim.scope !== 'USER' ? ` ⚠️  scope is ${existingDim.scope}, expected USER` : '';
      console.log(`↩︎  Exists: ${dim.parameterName} (scope=${existingDim.scope})${scopeNote}`);
      skipped++;
      continue;
    }
    await createDimension(headers, dim);
    console.log(`✅ Created: ${dim.parameterName} (scope=USER)`);
    created++;
  }

  console.log(`\nDone. ${created} created, ${skipped} already existed.`);
  if (created > 0) {
    console.log('Note: new custom dimensions can take up to 24-48h before GA4 accepts historical data for them; new events report immediately.');
  }
}

main().catch((err) => {
  console.error('❌ setup-ga4-user-dimensions failed:', err?.message || err);
  process.exit(1);
});
