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
 *   # webhook secret too (after creating the webhook in the Maileroo dashboard):
 *   MAILEROO_API_KEY=xxxxx MAILEROO_WEBHOOK_SECRET=yyyyy ... node scripts/set-maileroo-rc.mjs
 *
 * Keys are read from env vars (NEVER hard-coded). Each env present → one RC
 * param written. Missing envs are skipped silently.
 */

const PROVIDER_KEYS = [
  {
    rcParam: 'MAILEROO_API_KEY',
    envVar: 'MAILEROO_API_KEY',
    shapeHint: /^[0-9a-f]{32,}$/i,
    description: 'Maileroo sending key for the email cascade (newsletter + job alerts)',
  },
  {
    rcParam: 'MAILEROO_WEBHOOK_SECRET',
    envVar: 'MAILEROO_WEBHOOK_SECRET',
    shapeHint: null,
    description: 'Maileroo webhook HMAC-SHA256 shared secret (delivery event tracking)',
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
    console.log('ℹ️  Nothing to publish — every key matches RC already.');
    return;
  }

  await rc.publishTemplate(template, { force: true });
  console.log(`✅ Published ${changed} Maileroo key(s) to Remote Config.`);
  console.log('   Next CI run of send-newsletter.yml / send-job-alerts.yml picks them up via load-rc-env.mjs.');
}

main().catch((err) => {
  console.error('❌ set-maileroo-rc failed:', err?.message || err);
  process.exit(1);
});
