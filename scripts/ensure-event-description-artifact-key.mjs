#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  ensureEventDescriptionArtifactKey,
  readEventDescriptionArtifactKey,
} from './lib/event-description-artifact-key.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const output = option('--out');
if (!output) throw new Error('--out is required');

const readOnly = process.argv.includes('--read-only');
let key;
if (readOnly) {
  key = await readEventDescriptionArtifactKey();
} else {
  const rawCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required to provision the artifact key');

  let credentials;
  try {
    credentials = JSON.parse(rawCredentials);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  key = await ensureEventDescriptionArtifactKey({ credentials });
}

const target = path.resolve(output);
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
fs.writeFileSync(target, `${key}\n`, { mode: 0o600 });
fs.chmodSync(target, 0o600);
console.log(JSON.stringify({ status: 'ready' }));
