#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EVENT_DESCRIPTION_BACKLOG_OBJECT,
  privateEventDescriptionBucket,
  uploadPrivateEventDescriptionSources,
} from './lib/private-event-description-sources.mjs';
import { isValidSourceDescriptionHash } from './lib/event-description-policy.mjs';

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function loadRecords(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.records)) return parsed.records;
    return [parsed];
  } catch {
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
}

const input = option('--input');
if (!input) throw new Error('--input is required');
const object = option('--object', EVENT_DESCRIPTION_BACKLOG_OBJECT);
const records = loadRecords(path.resolve(input));
if (!records.length) throw new Error('private source export is empty');
if (records.some((record) => !record?.id || !isValidSourceDescriptionHash(record.sourceDescriptionHash))) {
  throw new Error('private source export contains an invalid record');
}

const payload = Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
const bucket = await privateEventDescriptionBucket();
await uploadPrivateEventDescriptionSources(bucket, payload, object);
console.log(JSON.stringify({ object, records: records.length, bytes: payload.byteLength, sha256: crypto.createHash('sha256').update(payload).digest('hex') }));
