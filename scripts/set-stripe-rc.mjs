#!/usr/bin/env node
/**
 * One-shot: push Stripe publisher-portal config to Firebase Remote Config so the
 * Cloud Functions `createPublisherCheckout` / `stripeWebhook` can read them via
 * functions/src/remoteConfigSecrets.js (getRemoteConfigValue).
 *
 * Safe to re-run: writes/overwrites only the params present in env, publishes a
 * new RC template version on change. Keys are read from env (NEVER hard-coded).
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS → a Firebase SA with `Firebase Remote
 * Config Admin`.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_… \
 *   STRIPE_PRICE_AD_UNIT=price_… \
 *   STRIPE_WEBHOOK_SECRET=whsec_… \
 *     GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-stripe-rc.mjs
 *
 * (Set whichever you have; missing envs are skipped. STRIPE_WEBHOOK_SECRET is
 *  produced when you create the webhook endpoint in Stripe pointing at the
 *  deployed `stripeWebhook` function.)
 */

import { readFirebaseServiceAccountCredentials } from './lib/firebase-service-account-credentials.mjs';
import {
  RC_SERVER_NAMESPACE,
  getRemoteConfig,
  fetchRcTemplate,
  stageRcParam,
  publishRcTemplate,
  setRcParamsWithEtag,
} from './lib/remote-config-admin.mjs';

const PROVIDER_KEYS = [
  {
    rcParam: 'SERVER_STRIPE_SECRET_KEY',
    envVar: 'STRIPE_SECRET_KEY',
    shapeHint: /^sk_(test|live)_[A-Za-z0-9]+$/,
    description: 'Stripe secret key (publisher checkout + webhook)',
  },
  {
    rcParam: 'STRIPE_PRICE_AD_UNIT',
    envVar: 'STRIPE_PRICE_AD_UNIT',
    shapeHint: /^price_[A-Za-z0-9]+$/,
    description: 'Stripe recurring Price id for one ad-unit (CHF 49 / 30 days)',
  },
  {
    rcParam: 'STRIPE_PRICE_AZIENDA',
    envVar: 'STRIPE_PRICE_AZIENDA',
    shapeHint: /^price_[A-Za-z0-9]+$/,
    description: 'Stripe recurring Price id for Piano Azienda (CHF 299 / 30 days, ruoli illimitati)',
  },
  {
    rcParam: 'STRIPE_PRICE_READER_NOADS',
    envVar: 'STRIPE_PRICE_READER_NOADS',
    shapeHint: /^price_[A-Za-z0-9]+$/,
    description: 'CHF 2.99/month recurring Price for the reader ad-free subscription',
  },
  {
    rcParam: 'STRIPE_PRICE_CONSULTING_BASE',
    envVar: 'STRIPE_PRICE_CONSULTING_BASE',
    shapeHint: /^price_[A-Za-z0-9]+$/,
    description: 'CHF 49 one-time Price for the /consulenza/ base (30min) session',
  },
  {
    rcParam: 'STRIPE_PRICE_CONSULTING_PREMIUM',
    envVar: 'STRIPE_PRICE_CONSULTING_PREMIUM',
    shapeHint: /^price_[A-Za-z0-9]+$/,
    description: 'CHF 99 one-time Price for the /consulenza/ premium (60min) session',
  },
  {
    rcParam: 'SERVER_STRIPE_WEBHOOK_SECRET',
    envVar: 'STRIPE_WEBHOOK_SECRET',
    shapeHint: /^whsec_[A-Za-z0-9]+$/,
    description: 'Stripe webhook signing secret (stripeWebhook signature verification)',
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
    bail('No Stripe values present in env. Set at least one of: ' + PROVIDER_KEYS.map(p => p.envVar).join(', '));
  }

  for (const p of pending) {
    if (p.shapeHint && !p.shapeHint.test(p.value)) {
      console.warn(`⚠️  ${p.envVar} does not match the expected shape — continuing anyway.`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const privateValues = pending.filter((p) => p.rcParam.startsWith('SERVER_'));
  const publicValues = pending.filter((p) => !p.rcParam.startsWith('SERVER_'));

  if (privateValues.length) {
    const credentials = readFirebaseServiceAccountCredentials(process.env, {
      purpose: 'write Stripe credentials to private Remote Config',
    });
    if (!credentials?.project_id) bail('Firebase service-account credentials missing.');
    const result = await setRcParamsWithEtag({
      credentials,
      namespace: RC_SERVER_NAMESPACE,
      params: privateValues.map((p) => ({
        name: p.rcParam,
        value: p.value,
        description: `${p.description} (set ${today})`,
      })),
      versionDescription: 'Set private Stripe credentials',
    });
    if (!result.ok) bail(`Private Stripe Remote Config write failed: ${result.detail || 'unknown error'}`);
  }

  let publicChanged = 0;
  if (publicValues.length) {
    const rc = await getRemoteConfig();
    const template = await fetchRcTemplate(rc);
    for (const p of publicValues) {
      if (stageRcParam(template, p.rcParam, p.value, `${p.description} (set ${today})`)) publicChanged++;
    }
    if (publicChanged) await publishRcTemplate(rc, template, publicChanged);
  }

  console.log(`✅ Private Stripe credentials ${privateValues.length ? 'updated or already current' : 'unchanged'}; public price IDs ${publicChanged ? 'updated' : 'already current or not supplied'}.`);
}

main().catch((err) => {
  console.error('❌ set-stripe-rc failed:', err?.message || err);
  process.exit(1);
});
