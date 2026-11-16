#!/usr/bin/env node
/**
 * Purge and live-validate every changed /job-canon shard before the CDN
 * generation marker can unblock Pages/Worker consumers.
 *
 * A missing CF token is a hard failure here. The ordinary purge helper is
 * intentionally fail-open for advisory callers, but a bridge-removal publish
 * must not claim success when its edge invalidation is unavailable.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  batch,
  DEFAULT_CDN_BASE,
  keyToUrl,
  PURGE_BATCH_SIZE,
} from './purge-changed-cdn-assets.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const HANDSHAKE_TIMEOUT_MS = Number(process.env.JOB_CANON_HANDSHAKE_TIMEOUT_MS) || 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.JOB_CANON_FETCH_TIMEOUT_MS) || 20_000;
const RETRY_INTERVAL_MS = Number(process.env.JOB_CANON_RETRY_INTERVAL_MS) || 5_000;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.JOB_CANON_VERIFY_CONCURRENCY) || 4);

function readAffectedFile(file) {
  if (!existsSync(file)) throw new Error(`affected job-canon inventory is missing: ${file}`);
  const keys = [...new Set(readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].sort();
  for (const key of keys) {
    if (!/^job-canon\/(?:[0-9a-f]{2}\.json|v2\/[0-9a-f]{3}\.json)$/.test(key)) {
      throw new Error(`invalid affected job-canon key: ${key}`);
    }
  }
  return keys;
}

function localPathForKey(mapDir, key) {
  if (!key.startsWith('job-canon/')) throw new Error(`unexpected map key: ${key}`);
  return join(mapDir, key.slice('job-canon/'.length));
}

function expectedBytes(mapDir, key) {
  const path = localPathForKey(mapDir, key);
  return existsSync(path) ? readFileSync(path) : null;
}

function purgeBatches(keys, base, execFile = execFileSync) {
  const purgeScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'cf-purge-cache.mjs');
  for (const urls of batch(keys, PURGE_BATCH_SIZE).map((group) => group.map((key) => keyToUrl(key, base)))) {
    execFile(process.execPath, [purgeScript, `--files=${urls.join(',')}`], {
      env: process.env,
      stdio: 'inherit',
      timeout: Number(process.env.JOB_CANON_PURGE_TIMEOUT_MS) || 120_000,
    });
  }
}

async function fetchWithTimeout(fetchImpl, url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...extraHeaders },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    bytes,
    vary: response.headers?.get?.('vary') || '',
  };
}

async function verifyOne(key, mapDir, base, fetchImpl = globalThis.fetch, { cacheBust = false } = {}) {
  const expected = expectedBytes(mapDir, key);
  const stableUrl = keyToUrl(key, base);
  const url = cacheBust ? `${stableUrl}?nocache=job-canon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : stableUrl;
  const response = await readResponse(await fetchWithTimeout(fetchImpl, url));
  const isMissing = response.status === 404 || response.status === 410;
  if (!expected) {
    if (!isMissing) throw new Error(`${key}: expected deleted shard, got HTTP ${response.status}`);
    return;
  }
  if (response.status !== 200) throw new Error(`${key}: expected HTTP 200, got ${response.status}`);
  const expectedHash = createHash('sha256').update(expected).digest('hex');
  const actualHash = createHash('sha256').update(response.bytes).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(`${key}: live bytes are stale (expected ${expectedHash}, got ${actualHash})`);
  }

  // Cloudflare may keep a distinct Vary: Origin cache entry. Probe the
  // browser-facing variant too whenever the origin declares that split.
  if (/\borigin\b/i.test(response.vary)) {
    const originResponse = await readResponse(await fetchWithTimeout(fetchImpl, url, {
      Origin: 'https://frontaliereticino.ch',
    }));
    if (originResponse.status !== 200 || !originResponse.bytes.equals(expected)) {
      throw new Error(`${key}: Vary: Origin response is not the staged shard`);
    }
  }
}

/** Verify all affected map keys; exported for deterministic unit tests. */
export async function verifyMapFreshness(
  keys,
  mapDir,
  base = DEFAULT_CDN_BASE,
  fetchImpl = globalThis.fetch,
  options = {},
) {
  let cursor = 0;
  const errors = [];
  const worker = async () => {
    while (cursor < keys.length) {
      const index = cursor++;
      try {
        await verifyOne(keys[index], mapDir, base, fetchImpl, options);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, keys.length) }, worker));
  if (errors.length) throw new AggregateError(errors, `job-canon live validation failed for ${errors.length} shard(s)`);
}

async function verifyUntilFresh(keys, mapDir, base, options = {}) {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await verifyMapFreshness(keys, mapDir, base, globalThis.fetch, options);
      console.log(`job-canon live validation passed for ${keys.length} shard(s) on attempt ${attempt}`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      console.log(`::notice::job-canon edge propagation pending (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
    }
  }
}

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const mapDir = flags['map-dir'];
  const affectedFile = flags['affected-file'];
  const base = flags.base || process.env.CDN_PURGE_BASE || DEFAULT_CDN_BASE;
  if (!mapDir || !affectedFile) throw new Error('usage: --map-dir=<dir> --affected-file=<file> [--base=<url>]');
  const keys = readAffectedFile(affectedFile);
  if (keys.length === 0) {
    console.log('job-canon publication handshake: no changed shards');
    return;
  }
  if (!process.env.CF_API_TOKEN) {
    throw new Error('CF_API_TOKEN is required for the job-canon publication handshake');
  }
  // GitHub Pages may acknowledge the git push before its origin serves the
  // new bytes. Prove the origin generation through a unique query first, so a
  // purge cannot refill Cloudflare with the previous map.
  await verifyUntilFresh(keys, mapDir, base, { cacheBust: true });
  purgeBatches(keys, base);
  await verifyUntilFresh(keys, mapDir, base);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::job-canon publication handshake failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
