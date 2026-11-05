#!/usr/bin/env node
/**
 * One-shot: push PostHog project ID + UI host to Firebase Remote Config so
 * `scripts/load-rc-env.mjs` can hydrate POSTHOG_PROJECT_ID + POSTHOG_HOST in
 * CI runs of `articles-performance-snapshot.yml` (and any other PostHog-aware
 * workflow). Companion to scripts/set-adsense-rc.mjs.
 *
 * Safe to re-run: writes/overwrites only the SERVER_POSTHOG_* params and
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

import { readFirebaseServiceAccountCredentials } from './lib/firebase-service-account-credentials.mjs';
import {
  RC_SERVER_NAMESPACE,
  stageRcParamValue,
  updateRcTemplateWithEtag,
} from './lib/remote-config-admin.mjs';

// value + description per param. None are secrets: project ids and the EU host
// are discoverable from the dashboard URL.
const RC_PARAMS = {
  SERVER_POSTHOG_PROJECT_ID: { value: '157802', description: 'PostHog project ID for HogQL queries (set 2026-05-07)' },
  SERVER_POSTHOG_HOST: { value: 'https://eu.posthog.com', description: 'PostHog API host (eu | us). Default eu (set 2026-05-07)' },
};

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const credentials = readFirebaseServiceAccountCredentials(process.env, {
    purpose: 'write PostHog query metadata to server-only Remote Config',
  });
  if (!credentials?.project_id) {
    bail('Firebase service-account credentials not set.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = await updateRcTemplateWithEtag({
    credentials,
    namespace: RC_SERVER_NAMESPACE,
    versionDescription: `Set PostHog query metadata (${today})`,
    stage: (template) => {
      let next = template;
      let changed = false;
      for (const [name, { value, description }] of Object.entries(RC_PARAMS)) {
        const staged = stageRcParamValue(next, name, value, description);
        if (staged.error) return staged;
        changed ||= staged.changed;
        if (staged.changed) next = staged.template;
      }
      return { changed, template: next };
    },
  });
  if (!result?.ok) {
    bail(`server Remote Config update failed: ${result?.detail || 'unknown error'}`);
  }
  console.log(`✅ SERVER_POSTHOG_* params ${result.changed ? 'updated' : 'already current'} in firebase-server.`);
}

main().catch((err) => {
  console.error('❌ set-posthog-rc failed:', err?.message || err);
  process.exit(1);
});
