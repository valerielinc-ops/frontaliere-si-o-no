#!/usr/bin/env node
/**
 * One-shot: push PostHog project ID + UI host to Firebase Remote Config so
 * `scripts/load-rc-env.mjs` can hydrate POSTHOG_PROJECT_ID + POSTHOG_HOST in
 * CI runs of `articles-performance-snapshot.yml` (and any other PostHog-aware
 * workflow). Companion to scripts/set-adsense-rc.mjs.
 *
 * Safe to re-run: writes/overwrites only the two SERVER_POSTHOG_* params and
 * publishes a new RC template version.
 *
 * Auth:
 *   GOOGLE_APPLICATION_CREDENTIALS must point at a Firebase SA with the
 *   `Firebase Remote Config Admin` role.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-posthog-rc.mjs
 *
 * The values are inlined here (not secrets — project IDs and the EU host are
 * already discoverable from the PostHog dashboard URL). Edit them here if
 * the project gets re-keyed.
 */

const RC_PARAMS = {
  SERVER_POSTHOG_PROJECT_ID: '157802',
  SERVER_POSTHOG_HOST: 'https://eu.posthog.com',
};

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    bail('GOOGLE_APPLICATION_CREDENTIALS not set.');
  }

  const adminMod = await import('firebase-admin');
  const admin = adminMod.default || adminMod;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const rc = admin.remoteConfig();
  const template = await rc.getTemplate();
  template.parameters = template.parameters || {};

  let changed = 0;
  for (const [key, value] of Object.entries(RC_PARAMS)) {
    const existing = template.parameters[key]?.defaultValue?.value;
    if (existing === value) continue;
    template.parameters[key] = {
      defaultValue: { value },
      valueType: 'STRING',
      description:
        key === 'SERVER_POSTHOG_PROJECT_ID'
          ? 'PostHog project ID for HogQL queries (set 2026-05-07)'
          : 'PostHog API host (eu | us). Default eu (set 2026-05-07)',
    };
    changed++;
  }

  if (changed === 0) {
    console.log('ℹ️  Both SERVER_POSTHOG_* params already up-to-date. Nothing to publish.');
    return;
  }

  await rc.publishTemplate(template, { force: true });
  console.log(`✅ Published ${changed} SERVER_POSTHOG_* param(s) to Remote Config.`);
  console.log('   Next CI run of articles-performance-snapshot.yml will pick them up via load-rc-env.mjs.');
}

main().catch((err) => {
  console.error('❌ set-posthog-rc failed:', err?.message || err);
  process.exit(1);
});
