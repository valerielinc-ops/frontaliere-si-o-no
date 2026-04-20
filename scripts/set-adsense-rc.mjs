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
      description: `AdSense OAuth credential for weekly revenue-monitor (set ${new Date().toISOString().slice(0, 10)})`,
    };
    changed++;
  }

  if (changed === 0) {
    console.log('ℹ️  All 3 SERVER_ADSENSE_* params already up-to-date. Nothing to publish.');
    return;
  }

  await rc.publishTemplate(template, { force: true });
  console.log(`✅ Published ${changed} SERVER_ADSENSE_* param(s) to Remote Config.`);
  console.log('   Next Monday the revenue-monitor workflow will pick them up via load-rc-env.mjs.');
}

main().catch((err) => {
  console.error('❌ set-adsense-rc failed:', err?.message || err);
  process.exit(1);
});
