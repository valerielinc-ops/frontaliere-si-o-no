#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  EXPIRED_JOB_EDGE_DATASET_PREFIX,
  EXPIRED_JOB_EDGE_SCHEMA_VERSION,
  EXPIRED_JOB_EDGE_SHARD_COUNT,
  isExpiredJobEdgeManifestUsable,
  isExpiredJobEdgeShardUsable,
} from './lib/expired-job-edge-dataset.mjs';
import { CDN_BASE } from '../infra/cloudflare-worker/locale-router.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE_CONTROL = 'public, max-age=60';
const LOCALE_RE = /^(it|en|de|fr)$/;
const GENERATION_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const SHARD_ID_RE = /^[0-9a-f]{2}$/;

export function createExpiredJobEdgeUploadPlan({ distDir, manifest, cdnBase = CDN_BASE }) {
  if (!manifest || manifest.version !== EXPIRED_JOB_EDGE_SCHEMA_VERSION || !LOCALE_RE.test(manifest.locale)) {
    throw new TypeError('Expired-job edge manifest has an unsupported schema or locale');
  }
  if (!GENERATION_RE.test(manifest.generation) || manifest.datasetPrefix !== EXPIRED_JOB_EDGE_DATASET_PREFIX) {
    throw new TypeError('Expired-job edge manifest has an invalid generation or prefix');
  }
  if (!manifest.coverage || typeof manifest.coverage.complete !== 'boolean'
    || !Array.isArray(manifest.shardIds)
    || !manifest.shardIds.every((shardId) => SHARD_ID_RE.test(shardId))
    || new Set(manifest.shardIds).size !== manifest.shardIds.length
    || !Number.isSafeInteger(manifest.pageCount)
    || manifest.pageCount < 0
    || manifest.shardIds.length > EXPIRED_JOB_EDGE_SHARD_COUNT
    || !Array.isArray(manifest.availableSections)
    || !Array.isArray(manifest.activeSections)
    || !manifest.activeSections.every((section) => manifest.availableSections.includes(section))) {
    throw new TypeError('Expired-job edge manifest coverage or shard list is malformed');
  }
  if (manifest.activeSections.length > 0
    && (!isExpiredJobEdgeManifestUsable(manifest, manifest.locale) || manifest.pageCount === 0)) {
    throw new Error('An active expired-job edge manifest must have complete evidence and page records');
  }

  const localeDir = path.join(distDir, 'edge', 'expired-jobs', 'v1', manifest.locale);
  const generationDir = path.join(localeDir, manifest.generation);
  const plan = [];
  let countedPages = 0;
  for (const shardId of manifest.shardIds) {
    const localFile = path.join(generationDir, `${shardId}.json`);
    if (!fs.existsSync(localFile)) throw new Error(`Missing expired-job edge shard ${shardId}`);
    let shard;
    try {
      shard = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    } catch {
      throw new Error(`Invalid JSON in expired-job edge shard ${shardId}`);
    }
    if (!isExpiredJobEdgeShardUsable(shard, { locale: manifest.locale, generation: manifest.generation, shardId })) {
      throw new Error(`Expired-job edge shard ${shardId} failed its schema check`);
    }
    const pageCount = Object.keys(shard.pages).length;
    if (pageCount === 0) throw new Error(`Expired-job edge shard ${shardId} is empty`);
    countedPages += pageCount;
    plan.push({
      localFile,
      cdnKey: `${EXPIRED_JOB_EDGE_DATASET_PREFIX}/${manifest.locale}/${manifest.generation}/${shardId}.json`,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      kind: 'shard',
    });
  }
  if (countedPages !== manifest.pageCount) {
    throw new Error(`Expired-job edge page count mismatch (${countedPages} shards, ${manifest.pageCount} manifest)`);
  }
  plan.push({
    localFile: path.join(localeDir, 'manifest.json'),
    cdnKey: `${EXPIRED_JOB_EDGE_DATASET_PREFIX}/${manifest.locale}/manifest.json`,
    cacheControl: MANIFEST_CACHE_CONTROL,
    kind: 'manifest',
  });
  return plan;
}

function uploadFile(entry) {
  const result = spawnSync('bash', [
    path.join(REPO_ROOT, 'scripts/lib/upload-cdn-file.sh'),
    entry.localFile,
    entry.cdnKey,
    entry.cacheControl,
  ], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.error || result.status !== 0 || !output.includes('✅ uploaded')) {
    throw new Error(`R2 upload did not confirm ${entry.cdnKey}`);
  }
}

function purgeManifestCache(entry) {
  const url = new URL(entry.cdnKey, CDN_BASE).toString();
  const result = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts/cf-purge-cache.mjs'),
    `--files=${url}`,
  ], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Could not purge the expired-job edge manifest cache: ${result.error?.message ?? result.status}`);
}

export async function publishExpiredJobEdgeDataset({ distDir = path.resolve('dist') } = {}) {
  const buildLocale = (process.env.BUILD_LOCALE || '').trim();
  const localeDir = path.join(distDir, 'edge', 'expired-jobs', 'v1', buildLocale);
  const manifestPath = path.join(localeDir, 'manifest.json');
  if (!LOCALE_RE.test(buildLocale) || !fs.existsSync(manifestPath)) {
    throw new Error(`Expired-job edge manifest missing for BUILD_LOCALE=${buildLocale || '(unset)'}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Expired-job edge manifest is invalid JSON for ${buildLocale}`);
  }
  const plan = createExpiredJobEdgeUploadPlan({ distDir, manifest });
  for (const entry of plan) uploadFile(entry);
  purgeManifestCache(plan[plan.length - 1]);
  console.log(`[expired-job-edge-publish] ${buildLocale}: ${manifest.pageCount} page records in ${manifest.shardIds.length} shards; manifest published last`);
  fs.rmSync(localeDir, { recursive: true, force: true });
  console.log(`[expired-job-edge-publish] ${buildLocale}: removed local dataset from the Pages artifact`);
  return { locale: buildLocale, pageCount: manifest.pageCount, shardCount: manifest.shardIds.length };
}

if (isInvokedDirectly(import.meta.url)) {
  publishExpiredJobEdgeDataset().catch((error) => {
    console.error(`::error::[expired-job-edge-publish] ${error.message}`);
    process.exitCode = 1;
  });
}
