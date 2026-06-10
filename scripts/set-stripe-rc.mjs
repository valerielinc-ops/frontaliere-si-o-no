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

const PROVIDER_KEYS = [
  {
    rcParam: 'STRIPE_SECRET_KEY',
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
    rcParam: 'STRIPE_WEBHOOK_SECRET',
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

  const adminMod = await import('firebase-admin');
  const admin = adminMod.default || adminMod;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const rc = admin.remoteConfig();
  const template = await rc.getTemplate();
  template.parameters = template.parameters || {};

  const today = new Date().toISOString().slice(0, 10);
  let changed = 0;
  for (const p of pending) {
    const existing = template.parameters[p.rcParam]?.defaultValue?.value;
    if (existing === p.value) {
      console.log(`ℹ️  ${p.rcParam} already up-to-date.`);
      continue;
    }
    template.parameters[p.rcParam] = {
      defaultValue: { value: p.value },
      valueType: 'STRING',
      description: `${p.description} (set ${today})`,
    };
    changed++;
    console.log(`📝 Staged ${p.rcParam} for publish.`);
  }

  if (changed === 0) {
    console.log('ℹ️  Nothing to publish — every value matches RC already.');
    return;
  }

  await rc.publishTemplate(template, { force: true });
  console.log(`✅ Published ${changed} Stripe value(s) to Remote Config.`);
  console.log('   The publisher Cloud Functions read these via getRemoteConfigValue().');
}

main().catch((err) => {
  console.error('❌ set-stripe-rc failed:', err?.message || err);
  process.exit(1);
});
