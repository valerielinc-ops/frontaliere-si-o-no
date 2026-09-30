#!/usr/bin/env node
/**
 * Decrypt the evidence the assisted-application agent stored for an order
 * (layer 5 of its personal-data protection). Local use only: it prints
 * personal data.
 *
 *   node scripts/assisted-application/decrypt-run.mjs --order <id>            # list files
 *   node scripts/assisted-application/decrypt-run.mjs --path <storage path>   # decrypt one
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS; the key ASSISTED_APPLICATION_RUN_KEY
 * is read from the environment or, when absent, from Remote Config.
 */

import { parseArgs } from 'node:util';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from '../../functions/src/assistedApplicationCvCheck.js';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { decryptJson, runKeyFrom } from './lib/secure-run.mjs';

const BUCKET = ASSISTED_APPLICATION_STORAGE_BUCKET;

async function main() {
  const { values } = parseArgs({ options: { order: { type: 'string' }, path: { type: 'string' } } });
  await getFirestoreDb();
  const { getStorage } = await import('firebase-admin/storage');
  const bucket = getStorage().bucket(BUCKET);
  if (values.order) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(values.order)) throw new Error('invalid order id');
    const [files] = await bucket.getFiles({ prefix: `assisted-application-uploads/${values.order}/run-` });
    for (const file of files) console.log(file.name);
    return;
  }
  if (!values.path || !/^assisted-application-uploads\/[A-Za-z0-9_-]+\/run-[A-Za-z0-9._-]+\.json\.enc$/.test(values.path)) {
    throw new Error('pass --order <id> or --path assisted-application-uploads/<id>/run-….json.enc');
  }
  const [content] = await bucket.file(values.path).download();
  console.log(JSON.stringify(decryptJson(JSON.parse(content.toString('utf8')), await runKey()), null, 2));
}

/** The key from the environment, else straight from Remote Config (same service account). */
async function runKey() {
  if (process.env.ASSISTED_APPLICATION_RUN_KEY) return runKeyFrom();
  const { getRemoteConfig } = await import('firebase-admin/remote-config');
  const template = await getRemoteConfig().getTemplate();
  return runKeyFrom(template.parameters?.ASSISTED_APPLICATION_RUN_KEY?.defaultValue?.value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
