#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateGeneratedImageRegistry,
  validateGeneratedImageRecord,
} from '../packages/articles/engine/shared/generatedImageRegistry.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const registryPath = path.resolve(argument('--registry', 'data/event-image-library.json'));
const assetDir = path.resolve(argument('--asset-dir', '.cache/event-image-library'));
const beforeRegistryPath = process.argv.includes('--before-registry')
  ? path.resolve(argument('--before-registry'))
  : null;
const uploader = path.resolve('scripts/lib/upload-cdn-file.sh');
const cacheControl = argument('--cache-control', 'public, max-age=31536000, immutable');

function cdnKey(record) {
  return `images/events/library/${record.assetId}.webp`;
}

function remoteObjectExists(key) {
  const result = spawnSync('bash', [uploader, '--check', key], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (output.includes('✅ exists')) return true;
  if (output.includes('❌ missing')) return false;
  console.error(`${key}: CDN existence check was indeterminate; scheduling a defensive upload`);
  return null;
}

if (!fs.existsSync(registryPath)) {
  console.error(`Registry not found: ${registryPath}`);
  process.exit(2);
}
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const assets = Array.isArray(registry.assets) ? registry.assets : [];
if (!assets.length) {
  console.error('Registry contains no assets; nothing to upload.');
  process.exit(2);
}
const registryValidation = validateGeneratedImageRegistry(registry, { scope: 'event-library' });
if (!registryValidation.valid) {
  console.error(`Invalid event image registry: ${registryValidation.errors.join('; ')}`);
  process.exit(1);
}

let uploaded = 0;
let previousById = new Map();
if (beforeRegistryPath) {
  if (!fs.existsSync(beforeRegistryPath)) {
    console.error(`Previous registry not found: ${beforeRegistryPath}`);
    process.exit(2);
  }
  const previous = JSON.parse(fs.readFileSync(beforeRegistryPath, 'utf8'));
  previousById = new Map((Array.isArray(previous.assets) ? previous.assets : []).map((record) => [record?.assetId, record]));
}
const assetsToUpload = beforeRegistryPath
  ? assets.filter((record) => {
    const previous = previousById.get(record?.assetId);
    if (!previous || previous.sha256 !== record.sha256) return true;
    const key = cdnKey(record);
    const exists = remoteObjectExists(key);
    if (exists === true) return false;
    if (exists === false) console.error(`${record.assetId}: CDN object is missing; scheduling a repair upload`);
    return true;
  })
  : assets;

for (const record of assetsToUpload) {
  const validation = validateGeneratedImageRecord(record);
  if (!validation.valid) {
    console.error(`${record?.assetId || '<unknown>'}: invalid registry record: ${validation.errors.join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  const localFile = path.join(assetDir, `${record.assetId}.webp`);
  if (!fs.existsSync(localFile)) {
    console.error(`${record.assetId}: generated file missing at ${localFile}`);
    process.exitCode = 1;
    continue;
  }
  const localBytes = fs.readFileSync(localFile);
  const localSha256 = crypto.createHash('sha256').update(localBytes).digest('hex');
  if (localBytes.byteLength !== record.bytes || localSha256 !== record.sha256) {
    console.error(`${record.assetId}: local bytes do not match the registry sha256/size`);
    process.exitCode = 1;
    continue;
  }
  const key = cdnKey(record);
  const result = spawnSync('bash', [uploader, localFile, key, cacheControl], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error || result.status !== 0 || !output.includes('✅ uploaded')) {
    console.error(`${record.assetId}: CDN upload did not report success`);
    process.exitCode = 1;
    continue;
  }
  uploaded += 1;
}
console.error(`Uploaded ${uploaded}/${assetsToUpload.length} event-library asset(s) to images/events/library/.`);
if (process.exitCode) process.exit(process.exitCode);
