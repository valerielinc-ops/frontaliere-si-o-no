#!/usr/bin/env node
/**
 * One-shot: push the Maileroo sending key (and optional webhook secret) to
 * Firebase Remote Config so `scripts/load-rc-env.mjs` hydrates them into CI runs
 * of send-newsletter.yml / send-job-alerts.yml, and so the webhook Cloud
 * Function (newsletterMailerooWebhook) can read MAILEROO_WEBHOOK_SECRET.
 *
 * Safe to re-run: writes/overwrites only the params present in env, publishes
 * a new RC template version on change.
 *
 * Auth:
 *   GOOGLE_APPLICATION_CREDENTIALS must point at a Firebase SA with the
 *   `Firebase Remote Config Admin` role.
 *
 * Usage:
 *   MAILEROO_API_KEY=xxxxx \
 *     GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-maileroo-rc.mjs
 *
 *   MAILEROO_TRANSACTIONAL_API_KEY=xxxxx MAILEROO_NEWSLETTER_API_KEY=yyyyy \
 *     GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-maileroo-rc.mjs
 *
 *   # Email Testing key: create it in Maileroo Profile → API Management with
 *   # only email_testing.inboxes.write and email_testing.messages.read scopes.
 *   MAILEROO_EMAIL_TESTING_API_KEY=roo_xxxxx \
 *     GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-maileroo-rc.mjs
 *
 *   # webhook secret too (after creating the webhook in the Maileroo dashboard):
 *   MAILEROO_API_KEY=xxxxx MAILEROO_WEBHOOK_SECRET=yyyyy ... node scripts/set-maileroo-rc.mjs
 *
 * Keys are read from env vars (NEVER hard-coded). Each env present → one RC
 * param written. Missing envs are skipped silently.
 */

import { readFirebaseServiceAccountCredentials } from './lib/firebase-service-account-credentials.mjs';
import { RC_SERVER_NAMESPACE, setRcParamsWithEtag } from './lib/remote-config-admin.mjs';

const PROVIDER_KEYS = [
  {
    rcParam: 'SERVER_MAILEROO_API_KEY',
    envVar: 'MAILEROO_API_KEY',
    shapeHint: /^[0-9a-f]{32,}$/i,
    description: 'Maileroo legacy sending key fallback for the email cascade',
  },
  {
    rcParam: 'SERVER_MAILEROO_TRANSACTIONAL_API_KEY',
    envVar: 'MAILEROO_TRANSACTIONAL_API_KEY',
    shapeHint: /^[0-9a-f]{32,}$/i,
    description: 'Maileroo Application sending key for transactional and operational messages',
  },
  {
    rcParam: 'SERVER_MAILEROO_NEWSLETTER_API_KEY',
    envVar: 'MAILEROO_NEWSLETTER_API_KEY',
    shapeHint: /^[0-9a-f]{32,}$/i,
    description: 'Maileroo Application sending key for newsletters and alerts',
  },
  {
    rcParam: 'SERVER_MAILEROO_WEBHOOK_SECRET',
    envVar: 'MAILEROO_WEBHOOK_SECRET',
    shapeHint: null,
    description: 'Maileroo webhook HMAC-SHA256 shared secret (delivery event tracking)',
  },
  {
    rcParam: 'SERVER_MAILEROO_EMAIL_TESTING_API_KEY',
    envVar: 'MAILEROO_EMAIL_TESTING_API_KEY',
    shapeHint: /^roo_[A-Za-z0-9_-]{16,}$/,
    description: 'Restricted Maileroo Email Testing API key for CI mailbox capture and assertions',
  },
  {
    rcParam: 'SERVER_MAILEROO_ACCOUNT_API_KEY',
    envVar: 'MAILEROO_ACCOUNT_API_KEY',
    shapeHint: null,
    // Account API key from Maileroo's dashboard "Applications" section — a
    // DIFFERENT credential from MAILEROO_API_KEY (a per-domain Sending Key).
    // Verified live: the sending key gets 401 "invalid or revoked" against
    // account-level endpoints (account, statistics, domains, logs, suppressions),
    // even with the correct `Authorization: Bearer` header.
    description: 'Maileroo Account API key — powers real usage-based cascade pacing (fetchMailerooCycleUsage)',
  },
];

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    bail('GOOGLE_APPLICATION_CREDENTIALS not set.');
  }

  const pending = PROVIDER_KEYS
    .map(p => ({ ...p, value: (process.env[p.envVar] || '').trim() }))
    .filter(p => p.value.length > 0);

  if (pending.length === 0) {
    bail('No Maileroo keys present in env. Set at least one of: ' + PROVIDER_KEYS.map(p => p.envVar).join(', '));
  }

  for (const p of pending) {
    if (p.shapeHint && !p.shapeHint.test(p.value)) {
      console.warn(`⚠️  ${p.envVar} does not match the expected shape — continuing anyway.`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const credentials = readFirebaseServiceAccountCredentials(process.env, {
    purpose: 'write Maileroo credentials to private Remote Config',
  });
  if (!credentials?.project_id) bail('Firebase service-account credentials missing.');
  const result = await setRcParamsWithEtag({
    credentials,
    namespace: RC_SERVER_NAMESPACE,
    params: pending.map((p) => ({
      name: p.rcParam,
      value: p.value,
      description: `${p.description} (set ${today})`,
    })),
    versionDescription: 'Set private Maileroo credentials',
  });
  if (!result.ok) bail(`Private Maileroo Remote Config write failed: ${result.detail || 'unknown error'}`);
  console.log(`✅ Private Maileroo credentials ${result.changed ? 'updated' : 'already current'} in Remote Config.`);
  console.log('   CI and Cloud Functions load these values through the private server-template reader.');
}

main().catch((err) => {
  console.error('❌ set-maileroo-rc failed:', err?.message || err);
  process.exit(1);
});
