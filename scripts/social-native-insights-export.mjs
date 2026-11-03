#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { loadPrivateSocialNativeInsights, toInstagramBrowserSnapshotDocument } from './lib/social-native-insights-store.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') options.output = argv[++index];
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.output && !options.help) throw new Error('--output is required');
  return options;
}

export async function exportPrivateInstagramInsights(output, { db, asOf = new Date() } = {}) {
  if (!output) throw new Error('output path is required');
  const firestore = db || await getFirestoreDb();
  const document = await loadPrivateSocialNativeInsights(firestore, { asOf });
  const snapshot = toInstagramBrowserSnapshotDocument(document);
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return { status: snapshot.posts.length ? 'available' : 'no-observations', rows: snapshot.posts.length };
}

if (isInvokedDirectly(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write('node scripts/social-native-insights-export.mjs --output TEMP_FILE\n');
  else exportPrivateInstagramInsights(options.output)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(`social-native-insights-export: ${String(error?.message || error).slice(0, 180)}`);
      process.exitCode = 1;
    });
}
