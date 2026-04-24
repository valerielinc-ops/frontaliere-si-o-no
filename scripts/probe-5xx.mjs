#!/usr/bin/env node
/**
 * probe-5xx.mjs — Production canary that fails fast on 5XX responses.
 *
 * Reads a list of URLs from scripts/probe-urls.txt (override with
 * --file=<path>) and HTTP-GETs each with:
 *   - concurrency: 5
 *   - per-request timeout: 10s
 *   - retries: 2x with 1s backoff (handles transient Cloudflare/edge 5XX)
 *
 * Exit codes:
 *   0 — every URL returned a non-5XX status on the final attempt
 *   1 — at least one URL returned a 5XX (or network error) on every attempt
 *
 * Emits a summary table (URL, status, latency_ms, attempts) on stdout and a
 * machine-readable JSON blob on stderr under the prefix `PROBE_RESULT_JSON=`
 * for downstream parsing (CI log artifacts etc.).
 *
 * Usage:
 *   node scripts/probe-5xx.mjs                  # default URL list
 *   node scripts/probe-5xx.mjs --file=my.txt    # custom URL list
 *   node scripts/probe-5xx.mjs --concurrency=3  # override concurrency
 *
 * Why a dedicated script? Static GitHub Pages paths cannot themselves return
 * 5XX, but (a) Cloudflare in front occasionally surfaces 5XX and (b) Firebase
 * Cloud Functions called from the SPA can regress silently. This probe catches
 * either class of regression within ~15 min via production-canary.yml.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URLS_FILE = path.join(SCRIPT_DIR, 'probe-urls.txt');
const UA = 'FrontaliereTicino-Probe5xx/1.0 (+https://frontaliereticino.ch)';
const PER_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 5;
const RETRY_ATTEMPTS = 3; // 1 initial + 2 retries
const RETRY_BACKOFF_MS = 1_000;

/**
 * Parse CLI args of the form `--key=value`.
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(a);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/**
 * Load URLs from a text file, stripping comments and blank lines.
 * @param {string} filePath
 * @returns {Promise<string[]>}
 */
async function loadUrls(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

/**
 * Single HTTP GET attempt with AbortController timeout.
 * Returns `{ status, latencyMs, error }` — status is `0` on network/abort.
 */
async function attemptProbe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: controller.signal,
      redirect: 'follow',
    });
    return { status: res.status, latencyMs: Date.now() - startedAt, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'unknown_error');
    return { status: 0, latencyMs: Date.now() - startedAt, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Probe one URL with retry on 5XX / network errors.
 * @returns {Promise<{ url: string, status: number, latencyMs: number, attempts: number, error: string|null, failed: boolean }>}
 */
async function probeWithRetry(url) {
  let lastResult = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    lastResult = await attemptProbe(url);
    const is5xx = lastResult.status >= 500 && lastResult.status < 600;
    const isNetErr = lastResult.status === 0;
    if (!is5xx && !isNetErr) {
      return { url, ...lastResult, attempts: attempt, failed: false };
    }
    if (attempt < RETRY_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  return { url, ...lastResult, attempts: RETRY_ATTEMPTS, failed: true };
}

/**
 * Run an async worker over a queue with a concurrency cap.
 * Preserves input order in the returned results array.
 */
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function loop() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const lanes = Array.from({ length: Math.max(1, concurrency) }, loop);
  await Promise.all(lanes);
  return results;
}

function formatRow(url, status, latencyMs, attempts) {
  const statusStr = status === 0 ? 'ERR' : String(status);
  const latencyStr = `${latencyMs}ms`.padStart(7, ' ');
  const attemptsStr = `${attempts}/${RETRY_ATTEMPTS}`;
  return `  ${statusStr.padEnd(5)} ${latencyStr}  ${attemptsStr.padEnd(4)}  ${url}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urlsFile = args.file || DEFAULT_URLS_FILE;
  const concurrency = Number(args.concurrency) > 0 ? Number(args.concurrency) : DEFAULT_CONCURRENCY;

  let urls;
  try {
    urls = await loadUrls(urlsFile);
  } catch (err) {
    console.error(`[probe-5xx] Cannot read URL list at ${urlsFile}: ${err.message}`);
    process.exit(2);
  }

  if (urls.length === 0) {
    console.error(`[probe-5xx] URL list ${urlsFile} is empty.`);
    process.exit(2);
  }

  console.log(`[probe-5xx] Probing ${urls.length} URL(s) (concurrency=${concurrency}, retries=${RETRY_ATTEMPTS - 1}, timeout=${PER_REQUEST_TIMEOUT_MS}ms)`);
  console.log('  STATUS LATENCY   ATT   URL');

  const started = Date.now();
  const results = await runWithConcurrency(urls, concurrency, async (url) => {
    const result = await probeWithRetry(url);
    console.log(formatRow(result.url, result.status, result.latencyMs, result.attempts));
    return result;
  });

  const elapsedMs = Date.now() - started;
  const failures = results.filter(r => r.failed);
  const ok = results.length - failures.length;

  console.log('');
  console.log(`[probe-5xx] Completed in ${elapsedMs}ms — ${ok} ok, ${failures.length} failed`);

  // Machine-readable JSON for CI artifact upload.
  const summary = {
    tsIso: new Date().toISOString(),
    total: results.length,
    ok,
    failed: failures.length,
    elapsedMs,
    concurrency,
    results: results.map(r => ({
      url: r.url,
      status: r.status,
      latencyMs: r.latencyMs,
      attempts: r.attempts,
      error: r.error,
      failed: r.failed,
    })),
  };
  console.error(`PROBE_RESULT_JSON=${JSON.stringify(summary)}`);

  if (failures.length > 0) {
    console.error('[probe-5xx] FAIL — the following URL(s) returned 5XX or a network error on every attempt:');
    for (const f of failures) {
      const reason = f.status === 0 ? `network_error: ${f.error}` : `HTTP ${f.status}`;
      console.error(`  - ${f.url}  (${reason})`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[probe-5xx] Unexpected failure:', err);
  process.exit(2);
});
