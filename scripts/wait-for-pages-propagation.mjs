#!/usr/bin/env node
/**
 * wait-for-pages-propagation.mjs — Poll the GitHub Pages CDN for the freshly
 * deployed build-id.txt. Returns as soon as the live URL serves the same value
 * as the local dist/build-id.txt, instead of blindly sleeping 90s.
 *
 * Why: `actions/deploy-pages` reports success the moment the artifact is
 * registered, but the Fastly edge in front of GitHub Pages can keep serving
 * the previous HTML for ~1-2 minutes. We need to wait for propagation before
 * running the availability probe, otherwise we'd test the old build.
 *
 * Strategy: short progressive backoff (0s / 15s / 30s / 60s, then 30s steps)
 * up to a hard timeout. Each request adds a unique `?_=<ts>` query param +
 * `Cache-Control: no-cache` request header to defeat any caching layer.
 *
 * Exit codes:
 *   0 — live build-id matches local within timeout
 *   1 — timeout reached without seeing the expected build-id
 *   2 — local dist/build-id.txt is missing or unreadable
 *
 * Usage:
 *   node scripts/wait-for-pages-propagation.mjs
 *   node scripts/wait-for-pages-propagation.mjs --url=https://example.com/build-id.txt
 *   node scripts/wait-for-pages-propagation.mjs --timeout-ms=240000
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCAL_PATH = path.join(REPO_ROOT, 'dist', 'build-id.txt');
const DEFAULT_LIVE_URL = 'https://frontaliereticino.ch/build-id.txt';
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000; // 4 min hard ceiling
const PER_REQUEST_TIMEOUT_MS = 8_000;
const UA = 'FrontaliereTicino-PropagationCheck/1.0';

// Progressive backoff schedule (ms between attempts after the first one).
// First attempt is immediate; subsequent gaps grow then plateau.
const BACKOFF_SCHEDULE_MS = [15_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchLiveBuildId(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
  const cacheBustUrl = `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
  try {
    const res = await fetch(cacheBustUrl, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { value: null, status: res.status, error: null };
    const text = (await res.text()).trim();
    return { value: text, status: res.status, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'unknown');
    return { value: null, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const localPath = args['local'] || DEFAULT_LOCAL_PATH;
  const liveUrl = args['url'] || DEFAULT_LIVE_URL;
  const timeoutMs = Number(args['timeout-ms']) > 0 ? Number(args['timeout-ms']) : DEFAULT_TIMEOUT_MS;

  let expected;
  try {
    expected = (await readFile(localPath, 'utf8')).trim();
  } catch (err) {
    console.error(`[wait-pages] Cannot read local build-id at ${localPath}: ${err.message}`);
    process.exit(2);
  }
  if (!expected) {
    console.error(`[wait-pages] Local build-id at ${localPath} is empty.`);
    process.exit(2);
  }

  console.log(`[wait-pages] Expecting build-id="${expected}" at ${liveUrl} (timeout ${Math.round(timeoutMs / 1000)}s)`);

  const startedAt = Date.now();
  let attempt = 0;
  let lastSeen = null;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const result = await fetchLiveBuildId(liveUrl);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (result.value === expected) {
      console.log(`[wait-pages] OK — build-id matches after ${elapsed}s (attempt ${attempt})`);
      process.exit(0);
    }
    lastSeen = result.value ?? `<status ${result.status}${result.error ? ` ${result.error}` : ''}>`;
    console.log(`[wait-pages] attempt ${attempt} (t+${elapsed}s) — saw "${lastSeen}", expected "${expected}"`);

    const idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1);
    const wait = BACKOFF_SCHEDULE_MS[idx];
    if (Date.now() - startedAt + wait >= timeoutMs) break;
    await sleep(wait);
  }

  console.error(`[wait-pages] FAIL — timed out after ${Math.round((Date.now() - startedAt) / 1000)}s. Last live value: "${lastSeen}". Expected: "${expected}".`);
  process.exit(1);
}

main().catch(err => {
  console.error('[wait-pages] Unexpected failure:', err);
  process.exit(2);
});
