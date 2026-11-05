#!/usr/bin/env node
/**
 * One-shot: push the AdSense OAuth refresh token + client credentials to
 * Firebase Remote Config so `scripts/load-rc-env.mjs` can hydrate the env
 * vars for CI runs of `revenue-monitor.mjs`.
 *
 * Safe to re-run: overwrites the three SERVER_ADSENSE_* RC parameters
 * (marked SECRET) and publishes a new template version.
 *
 * Sources (local only — never committed):
 *   - .cache/adsense-oauth.json          (refresh_token; produced by
 *                                        scripts/adsense-slot-audit.mjs)
 *   - mcp-gsc-main/client_secret.json    (client_id + client_secret)
 *
 * Auth:
 *   GOOGLE_APPLICATION_CREDENTIALS must point at a Firebase SA with the
 *   `Firebase Remote Config Admin` role (typical SA works).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-adsense-rc.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readFirebaseServiceAccountCredentials } from './lib/firebase-service-account-credentials.mjs';
import { RC_SERVER_NAMESPACE, setRcParamsWithEtag } from './lib/remote-config-admin.mjs';

const ROOT = process.cwd();
const TOKEN_CACHE = path.join(ROOT, '.cache', 'adsense-oauth.json');
const CLIENT_SECRET = path.join(ROOT, 'mcp-gsc-main', 'client_secret.json');

const RC_PARAMS = {
  SERVER_ADSENSE_REFRESH_TOKEN: null,
  SERVER_ADSENSE_CLIENT_ID: null,
  SERVER_ADSENSE_CLIENT_SECRET: null,
};

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function loadLocalSecrets() {
  if (!existsSync(TOKEN_CACHE)) {
    bail(`Missing ${TOKEN_CACHE}. Run \`node scripts/adsense-slot-audit.mjs\` once to generate it.`);
  }
  if (!existsSync(CLIENT_SECRET)) {
    bail(`Missing ${CLIENT_SECRET}.`);
  }
  const cache = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'));
  if (!cache.refresh_token) bail('No refresh_token in .cache/adsense-oauth.json');
  const secret = JSON.parse(readFileSync(CLIENT_SECRET, 'utf8'));
  const cs = secret.web || secret.installed;
  if (!cs?.client_id || !cs?.client_secret) bail('client_secret.json has no client_id/client_secret');

  RC_PARAMS.SERVER_ADSENSE_REFRESH_TOKEN = cache.refresh_token;
  RC_PARAMS.SERVER_ADSENSE_CLIENT_ID = cs.client_id;
  RC_PARAMS.SERVER_ADSENSE_CLIENT_SECRET = cs.client_secret;
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    bail('GOOGLE_APPLICATION_CREDENTIALS not set.');
  }

  loadLocalSecrets();

  const description = `AdSense OAuth credential for weekly revenue-monitor (set ${new Date().toISOString().slice(0, 10)})`;
  const credentials = readFirebaseServiceAccountCredentials(process.env, {
    purpose: 'write AdSense OAuth credentials to private Remote Config',
  });
  if (!credentials?.project_id) bail('Firebase service-account credentials missing.');
  const result = await setRcParamsWithEtag({
    credentials,
    namespace: RC_SERVER_NAMESPACE,
    params: Object.entries(RC_PARAMS).map(([name, value]) => ({ name, value, description })),
    versionDescription: 'Set private AdSense OAuth credentials',
  });
  if (!result.ok) bail(`Private AdSense Remote Config write failed: ${result.detail || 'unknown error'}`);
  console.log(`✅ Private SERVER_ADSENSE_* credentials ${result.changed ? 'updated' : 'already current'} in Remote Config.`);
  console.log('   The revenue-monitor workflow reads them through the private server-template loader.');
}

main().catch((err) => {
  console.error('❌ set-adsense-rc failed:', err?.message || err);
  process.exit(1);
});
