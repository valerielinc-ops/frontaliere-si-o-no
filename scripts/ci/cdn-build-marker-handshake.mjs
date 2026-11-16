#!/usr/bin/env node
/**
 * Purge and validate the stable CDN generation marker after it is written.
 * GitHub Pages does not give this file a deploy-controlled no-store header, so
 * a successful Pages push alone is not evidence that all edge PoPs serve the
 * new marker. This gate is deliberately fail-closed for production publishes.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CDN_BASE, keyToUrl } from './purge-changed-cdn-assets.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const HANDSHAKE_TIMEOUT_MS = Number(process.env.CDN_MARKER_HANDSHAKE_TIMEOUT_MS) || 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.CDN_MARKER_FETCH_TIMEOUT_MS) || 20_000;
const RETRY_INTERVAL_MS = Number(process.env.CDN_MARKER_RETRY_INTERVAL_MS) || 5_000;

function markerUrl(base) {
  return keyToUrl('cdn-build-id.txt', base);
}

function purgeMarker(base, execFile = execFileSync) {
  const purgeScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'cf-purge-cache.mjs');
  execFile(process.execPath, [purgeScript, `--files=${markerUrl(base)}`], {
    env: process.env,
    stdio: 'inherit',
    timeout: Number(process.env.CDN_MARKER_PURGE_TIMEOUT_MS) || 120_000,
  });
}

async function fetchMarker(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: controller.signal,
    });
    return { status: response.status, body: (await response.text()).trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** Validate the stable marker and a query-busted marker variant. */
export async function verifyMarker(
  buildId,
  base = DEFAULT_CDN_BASE,
  fetchImpl = globalThis.fetch,
  { cacheBustOnly = false } = {},
) {
  const stable = markerUrl(base);
  const fresh = `${stable}?nocache=handshake-${Date.now()}`;
  for (const url of cacheBustOnly ? [fresh] : [stable, fresh]) {
    const result = await fetchMarker(fetchImpl, url);
    if (result.status !== 200 || result.body !== String(buildId)) {
      throw new Error(`${url}: expected marker ${buildId}, got HTTP ${result.status} body=${result.body || '<empty>'}`);
    }
  }
}

async function verifyUntilFresh(buildId, base, options = {}) {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await verifyMarker(buildId, base, globalThis.fetch, options);
      console.log(`CDN marker ${buildId} is live on the stable and cache-busted URLs (attempt ${attempt})`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      console.log(`::notice::CDN marker propagation pending (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`);
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
  const buildId = flags['build-id'];
  const base = flags.base || process.env.CDN_PURGE_BASE || DEFAULT_CDN_BASE;
  if (!buildId || !/^\d+$/.test(buildId)) throw new Error('--build-id must contain digits');
  if (!process.env.CF_API_TOKEN) throw new Error('CF_API_TOKEN is required for the CDN marker handshake');
  // Wait for the Pages/R2 origin to expose this generation before purging the
  // stable URL; otherwise a Pages propagation delay could refill the edge with
  // the previous marker and make the subsequent validation impossible.
  await verifyUntilFresh(buildId, base, { cacheBustOnly: true });
  purgeMarker(base);
  await verifyUntilFresh(buildId, base);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::CDN marker handshake failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
