#!/usr/bin/env node
/**
 * One-shot: store the three ASTRA OpenTransportData plan credentials in
 * Firebase Remote Config.
 *
 * The values are accepted only through the environment and are never printed.
 * Token hashes are retained for plan inventory; the API itself authenticates
 * with the bearer token only.
 *
 * Usage:
 *   OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN=... \
 *   OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN_HASH=... \
 *   OPENTRANSPORTDATA_ASTRA_LSA_TOKEN=... \
 *   OPENTRANSPORTDATA_ASTRA_LSA_TOKEN_HASH=... \
 *   OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN=... \
 *   OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN_HASH=... \
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *   node scripts/set-opentransportdata-rc.mjs
 */

import {
  RC_SERVER_NAMESPACE,
  fetchRcTemplate,
  getRemoteConfig,
  publishRcTemplate,
  stageRcParam,
  setRcParamsWithEtag,
} from './lib/remote-config-admin.mjs';
import { readFirebaseServiceAccountCredentials } from './lib/firebase-service-account-credentials.mjs';

const CREDENTIALS = Object.freeze([
  {
    rcParam: 'SERVER_OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN',
    envVar: 'OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN',
    description: 'OpenTransportData ASTRA traffic situations plan bearer token',
  },
  {
    rcParam: 'OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN_HASH',
    envVar: 'OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN_HASH',
    hash: true,
    description: 'OpenTransportData ASTRA traffic situations plan token hash (inventory only)',
  },
  {
    rcParam: 'SERVER_OPENTRANSPORTDATA_ASTRA_LSA_TOKEN',
    envVar: 'OPENTRANSPORTDATA_ASTRA_LSA_TOKEN',
    description: 'OpenTransportData ASTRA LSA traffic-lights plan bearer token',
  },
  {
    rcParam: 'OPENTRANSPORTDATA_ASTRA_LSA_TOKEN_HASH',
    envVar: 'OPENTRANSPORTDATA_ASTRA_LSA_TOKEN_HASH',
    hash: true,
    description: 'OpenTransportData ASTRA LSA traffic-lights plan token hash (inventory only)',
  },
  {
    rcParam: 'SERVER_OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN',
    envVar: 'OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN',
    description: 'OpenTransportData ASTRA traffic counters plan bearer token',
  },
  {
    rcParam: 'OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN_HASH',
    envVar: 'OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN_HASH',
    hash: true,
    description: 'OpenTransportData ASTRA traffic counters plan token hash (inventory only)',
  },
]);

function bail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    bail('GOOGLE_APPLICATION_CREDENTIALS not set.');
  }

  const pending = CREDENTIALS.map((credential) => ({
    ...credential,
    value: (process.env[credential.envVar] || '').trim(),
  }));
  const missing = pending.filter((credential) => !credential.value);
  if (missing.length > 0) {
    bail(`Missing required environment variable(s): ${missing.map((credential) => credential.envVar).join(', ')}`);
  }

  for (const credential of pending.filter((item) => item.hash)) {
    if (!/^[0-9a-f]{32}$/i.test(credential.value)) {
      console.warn(`⚠️  ${credential.envVar} is not a 32-character hexadecimal hash; storing it unchanged.`);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const privateTokens = pending.filter((credential) => !credential.hash);
  const publicHashes = pending.filter((credential) => credential.hash);
  const serviceAccount = readFirebaseServiceAccountCredentials(process.env, {
    purpose: 'write ASTRA bearer tokens to private Remote Config',
  });
  if (!serviceAccount?.project_id) bail('Firebase service-account credentials missing.');
  const privateResult = await setRcParamsWithEtag({
    credentials: serviceAccount,
    namespace: RC_SERVER_NAMESPACE,
    params: privateTokens.map((credential) => ({
      name: credential.rcParam,
      value: credential.value,
      description: `${credential.description} (set ${date})`,
    })),
    versionDescription: 'Set private OpenTransportData ASTRA bearer tokens',
  });
  if (!privateResult.ok) bail(`Private ASTRA Remote Config write failed: ${privateResult.detail || 'unknown error'}`);

  const rc = await getRemoteConfig();
  const template = await fetchRcTemplate(rc);
  let publicChanged = 0;
  for (const credential of publicHashes) {
    if (stageRcParam(template, credential.rcParam, credential.value, `${credential.description} (set ${date})`)) {
      publicChanged++;
      console.log(`📝 Staged ${credential.rcParam} for publish.`);
    } else {
      console.log(`ℹ️  ${credential.rcParam} already up-to-date.`);
    }
  }

  if (publicChanged) await publishRcTemplate(rc, template, publicChanged);
  console.log(`✅ Private ASTRA bearer tokens ${privateResult.changed ? 'updated' : 'already current'}; ${publicChanged} inventory hash(es) ${publicChanged ? 'published' : 'already current'}.`);
}

main().catch((error) => {
  console.error('❌ set-opentransportdata-rc failed:', error?.message || error);
  process.exit(1);
});
