#!/usr/bin/env node
/**
 * One-shot: push the Cloudflare Email Service API token to Firebase Remote Config
 * so `scripts/load-rc-env.mjs` hydrates it into CI runs of send-newsletter.yml /
 * send-job-alerts.yml, where the email cascade uses it as the `cloudflare`
 * provider (send) and the usage/analytics verification (check-email-quotas.mjs).
 *
 * The account id (CF_ACCOUNT_ID) is already in Remote Config — shared with the
 * CDN/Workers config — so only the token needs to be set here.
 *
 * One token, both scopes: the token must carry **Email Sending: Edit** (to send)
 * AND **Analytics Read** (to query emailSendingAdaptiveGroups for delivery-event
 * observation). A single token with both scopes covers the whole integration.
 *
 * Safe to re-run: writes/overwrites only the params present in env, publishes a
 * new RC template version on change.
 *
 * Auth:
 *   GOOGLE_APPLICATION_CREDENTIALS must point at a Firebase SA with the
 *   `Firebase Remote Config Admin` role.
 *
 * Usage:
 *   CLOUDFLARE_EMAIL_API_TOKEN=xxxxx \
 *     GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-cloudflare-email-rc.mjs
 *
 * Keys are read from env vars (NEVER hard-coded). Each env present → one RC param
 * written. Missing envs are skipped silently.
 */

const PROVIDER_KEYS = [
  {
    rcParam: 'CLOUDFLARE_EMAIL_API_TOKEN',
    envVar: 'CLOUDFLARE_EMAIL_API_TOKEN',
    // Cloudflare API tokens are ~40 chars of [A-Za-z0-9_-]; warn (not block) if off.
    shapeHint: /^[A-Za-z0-9_-]{30,}$/,
    description: 'Cloudflare Email Service token (Email Sending: Edit + Analytics Read) for the email cascade',
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
    bail('No Cloudflare email keys present in env. Set: ' + PROVIDER_KEYS.map(p => p.envVar).join(', '));
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
  console.log(`✅ Published ${changed} Cloudflare email key(s) to Remote Config.`);
  console.log('   Verify with: eval "$(node scripts/load-rc-env.mjs)" && node scripts/check-email-quotas.mjs');
}

main().catch((err) => {
  console.error('❌ set-cloudflare-email-rc failed:', err?.message || err);
  process.exit(1);
});
