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
 * ── PHASE 2: deep-sample gate (2026-07-14, sticky-404 send-window incident) ──
 * build-id.txt alone is NOT proof the whole artifact serves: for this
 * ~650k-file site, Pages can serve the new build-id within seconds of
 * deployment activation while a TAIL of pages still returns origin 404 for an
 * extended window. The caller purges the whole Cloudflare edge as soon as this
 * script exits 0 — purging away the previous build's good copies at exactly
 * the moment origin has holes. Measured 2026-07-14: ~2.5k canonical job URLs
 * 404'd for ~2h after the 03:59 UTC activation; the 04:38 job-alert run's
 * live-link preflight filtered 15-30% of every CH-wide alert as "dead links",
 * and Cloudflare logged 27.5k distinct 404 paths in 24h (data/cf-hot-404s.json
 * grows day over day from exactly this).
 *
 * Phase 2 therefore samples N URLs of THIS build (from the sitemaps bundle's
 * new-sitemap-urls.json, staged by deploy-it-pages-prep.sh) spread across the
 * whole sitemap set, and keeps polling until ≥ --sample-min-ok of them respond
 * 200 at origin (cache-busted). Only then does the caller purge. On timeout it
 * exits 1 — the caller's existing propagation_timeout classification applies:
 * NO purge (edge keeps absorbing the origin holes with the previous build's
 * pages — stale-but-200 beats fresh-404), NO rollback, publish gated off.
 * Fail-open: a missing/empty/unparseable sample file skips phase 2 with a
 * warning, preserving the legacy build-id-only behavior.
 *
 * Exit codes:
 *   0 — live build-id matches local within timeout (and, when a sample file is
 *       available, the deep sample converged too)
 *   1 — timeout reached without seeing the expected build-id, OR the deep
 *       sample did not converge within its own window
 *   2 — local dist/build-id.txt is missing or unreadable
 *
 * Usage:
 *   node scripts/wait-for-pages-propagation.mjs
 *   node scripts/wait-for-pages-propagation.mjs --url=https://example.com/build-id.txt
 *   node scripts/wait-for-pages-propagation.mjs --timeout-ms=240000
 *   node scripts/wait-for-pages-propagation.mjs \
 *     --sample-file=/tmp/sitemaps-bundle/new-sitemap-urls.json \
 *     --sample-size=60 --sample-min-ok=0.97 --sample-timeout-ms=900000
 */

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkLink } from './lib/live-link-check.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCAL_PATH = path.join(REPO_ROOT, 'dist', 'build-id.txt');
const DEFAULT_LIVE_URL = 'https://frontaliereticino.ch/build-id.txt';
// Two distinct propagation timescales — do not conflate them:
//   • Healthy deploy: actions/deploy-pages returns success only AFTER server-side
//     syncing_files→updating_pages, and this probe is cache-busted (see Strategy
//     above), so build-id detection is bounded by the ~1-2 min Fastly edge lag,
//     not by it — measured p100 = 1s across late-May→Jun healthy runs. The sole
//     CI caller (post-deploy-validate-live.yml) therefore passes --timeout-ms
//     =240000 (above the edge lag, well under the old 25 min).
//   • Double-action-timeout deploy: the ~13 GB / ~470k-file publish can land
//     server-side ~30 min end-to-end (measured 2026-05-30), far past any sane
//     wait — that branch almost always times out regardless, so we no longer
//     wait it out (the next deploy re-publishes + re-validates).
// This default is the conservative ad-hoc fallback; the operative value is the
// caller's --timeout-ms. (Was 25 min; the older 4-min ceiling predated the
// cache-bust analysis.)
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
const PER_REQUEST_TIMEOUT_MS = 8_000;
const UA = 'FrontaliereTicino-PropagationCheck/1.0';

// Progressive backoff schedule (ms between attempts after the first one).
// First attempt is immediate; subsequent gaps grow then plateau.
const BACKOFF_SCHEDULE_MS = [15_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];

// ── Phase-2 deep-sample defaults ──────────────────────────────────────────────
// Staged (non-fatally) by deploy-it-pages-prep.sh step_stage_bundle and
// downloaded by post-deploy-validate-live.yml into /tmp/sitemaps-bundle.
const DEFAULT_SAMPLE_FILE = '/tmp/sitemaps-bundle/new-sitemap-urls.json';
// 60 URLs spread across the full sitemap set: with the measured post-activation
// hole concentration (15-30% of non-TI job pages), a 60-URL spread sample
// detects a hole-window with P > 99.99%; at the same time 60 cache-busted HEADs
// per poll round are negligible origin load.
const DEFAULT_SAMPLE_SIZE = 60;
// ≥97% of the sample must be live (60 → up to 1 non-200 tolerated) so a single
// flaky request / genuinely-expired sitemap straggler can't wedge the gate.
const DEFAULT_SAMPLE_MIN_OK = 0.97;
// Phase-2 window. Distinct from the phase-1 (--timeout-ms) window on purpose:
// build-id detection is bounded by Fastly edge lag (seconds), while full-
// artifact propagation is bounded by Pages' server-side fanout (minutes).
const DEFAULT_SAMPLE_TIMEOUT_MS = 15 * 60 * 1000;
const SAMPLE_CONCURRENCY = 6;
const SAMPLE_POLL_GAP_MS = 30_000;

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

// ── Phase-2 helpers (pure where possible — unit-tested in
// tests/wait-pages-deep-sample.test.ts) ───────────────────────────────────────

/**
 * Deterministic spread sample: every k-th entry of the (sorted) URL list, so
 * the sample covers the whole artifact — head AND tail — instead of clustering
 * on one section. Deterministic on purpose: the same build re-polled must
 * check the same URLs, or a converging gate could flap between poll rounds.
 *
 * @param {string[]} urls  All sitemap URLs of THIS build (already sorted by
 *                         the bundler; sorted defensively here anyway).
 * @param {number} size    Max sample size.
 * @returns {string[]}
 */
export function pickSpreadSample(urls, size) {
  const list = [...new Set((urls || []).filter((u) => typeof u === 'string' && u.startsWith('http')))].sort();
  if (list.length <= size) return list;
  const step = list.length / size;
  const out = [];
  for (let i = 0; i < size; i++) out.push(list[Math.floor(i * step)]);
  return [...new Set(out)];
}

/**
 * Has the sample converged? Pure threshold math: tolerated failures =
 * floor(size × (1 − minOk)) — e.g. 60 URLs at 0.97 tolerates 1.
 *
 * @param {number} okCount
 * @param {number} sampleSize
 * @param {number} minOkRatio
 * @returns {boolean}
 */
export function sampleConverged(okCount, sampleSize, minOkRatio) {
  if (sampleSize <= 0) return true;
  const tolerated = Math.floor(sampleSize * (1 - minOkRatio));
  return sampleSize - okCount <= tolerated;
}

/** Extract the sample-source URL list from a parsed new-sitemap-urls.json
 * (version 2 shape: `{ _allUrls: string[] }`). Returns [] on any other shape
 * so the caller can fail open. */
export function extractBundleUrls(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const all = parsed._allUrls;
  return Array.isArray(all) ? all.filter((u) => typeof u === 'string') : [];
}

/** Cache-busted origin liveness probe for one URL — the SHARED checkLink()
 * (scripts/lib/live-link-check.mjs: HEAD → 405/501 ranged-GET fallback, never
 * throws) with cache-bust + no-cache headers so the gate reads the ORIGIN, not
 * an edge-cached copy. Reused, not re-implemented, per that module's own
 * docstring (review 🟡 on PR #4181): "live" must mean the same thing here and
 * in send-job-alerts' dead-link preflight. */
function probeSampleUrl(url) {
  return checkLink(url, PER_REQUEST_TIMEOUT_MS, {
    cacheBust: true,
    headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
}

/** Probe `urls` with bounded concurrency; returns the Set of urls that FAILED. */
async function probeAll(urls, probe = probeSampleUrl) {
  const failed = new Set();
  let cursor = 0;
  async function run() {
    while (cursor < urls.length) {
      const i = cursor;
      cursor += 1;
      if (!(await probe(urls[i]))) failed.add(urls[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SAMPLE_CONCURRENCY, urls.length || 1) }, run));
  return failed;
}

/**
 * Phase 2: poll the deep sample until convergence or timeout. Re-probes ONLY
 * the still-failing URLs on each round (a URL that already served 200 for this
 * build cannot regress mid-propagation).
 *
 * @returns {Promise<boolean>} true = converged, false = timed out.
 */
async function waitForDeepSample({ sample, minOk, timeoutMs, probe = probeSampleUrl, pollGapMs = SAMPLE_POLL_GAP_MS }) {
  const startedAt = Date.now();
  let pending = [...sample];
  let round = 0;
  while (true) {
    round += 1;
    const failed = await probeAll(pending, probe);
    const okCount = sample.length - failed.size;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (sampleConverged(okCount, sample.length, minOk)) {
      console.log(`[wait-pages] deep-sample OK — ${okCount}/${sample.length} live after ${elapsed}s (round ${round})`);
      return true;
    }
    const preview = [...failed].slice(0, 10).map((u) => `\n[wait-pages]     ${u}`).join('');
    console.log(`[wait-pages] deep-sample round ${round} (t+${elapsed}s) — ${okCount}/${sample.length} live, ${failed.size} still 404/unreachable:${preview}${failed.size > 10 ? `\n[wait-pages]     … and ${failed.size - 10} more` : ''}`);
    if (Date.now() - startedAt + pollGapMs >= timeoutMs) return false;
    pending = [...failed];
    await sleep(pollGapMs);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const localPath = args['local'] || DEFAULT_LOCAL_PATH;
  const liveUrl = args['url'] || DEFAULT_LIVE_URL;
  const timeoutMs = Number(args['timeout-ms']) > 0 ? Number(args['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  const sampleFile = args['sample-file'] || DEFAULT_SAMPLE_FILE;
  const sampleSize = Number(args['sample-size']) > 0 ? Number(args['sample-size']) : DEFAULT_SAMPLE_SIZE;
  const sampleMinOk = Number(args['sample-min-ok']) > 0 ? Number(args['sample-min-ok']) : DEFAULT_SAMPLE_MIN_OK;
  const sampleTimeoutMs = Number(args['sample-timeout-ms']) > 0 ? Number(args['sample-timeout-ms']) : DEFAULT_SAMPLE_TIMEOUT_MS;

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

  // build-id is a monotonic Date.now() millisecond stamp generated per build.
  // Accept the live site as "propagated" when it serves a build-id >= ours:
  // an exact match means our deploy is live; a strictly-greater value means a
  // NEWER deploy already superseded ours and is live — the site is still at
  // least as fresh as this run, so the freshness gate is satisfied (under deploy
  // congestion ours may never be the one that lands, and waiting for an exact
  // match would time out forever). Falls back to exact string match if either
  // value isn't a plain number.
  const expectedNum = /^\d+$/.test(expected) ? Number(expected) : null;
  const isPropagated = (live) => {
    if (live == null) return false;
    if (live === expected) return true;
    if (expectedNum !== null && /^\d+$/.test(live)) return Number(live) >= expectedNum;
    return false;
  };

  const startedAt = Date.now();
  let attempt = 0;
  let lastSeen = null;
  let buildIdLive = false;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const result = await fetchLiveBuildId(liveUrl);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (isPropagated(result.value)) {
      const how = result.value === expected ? 'matches' : `>= ours (live "${result.value}" ≥ "${expected}", newer deploy live)`;
      console.log(`[wait-pages] OK — build-id ${how} after ${elapsed}s (attempt ${attempt})`);
      buildIdLive = true;
      break;
    }
    lastSeen = result.value ?? `<status ${result.status}${result.error ? ` ${result.error}` : ''}>`;
    console.log(`[wait-pages] attempt ${attempt} (t+${elapsed}s) — saw "${lastSeen}", expected "${expected}"`);

    const idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1);
    const wait = BACKOFF_SCHEDULE_MS[idx];
    if (Date.now() - startedAt + wait >= timeoutMs) break;
    await sleep(wait);
  }

  if (!buildIdLive) {
    console.error(`[wait-pages] FAIL — timed out after ${Math.round((Date.now() - startedAt) / 1000)}s. Last live value: "${lastSeen}". Expected: "${expected}".`);
    process.exit(1);
  }

  // ── Phase 2: deep-sample gate ───────────────────────────────────────────────
  // build-id.txt live ≠ whole artifact live (see header). Sample this build's
  // own sitemap URLs and hold the gate until they serve, so the caller's edge
  // purge can never expose an origin still full of propagation holes.
  let sampleUrls = [];
  try {
    const parsed = JSON.parse(await readFile(sampleFile, 'utf8'));
    sampleUrls = extractBundleUrls(parsed);
  } catch (err) {
    console.warn(`[wait-pages] ::warning:: deep-sample skipped — cannot read ${sampleFile} (${err?.message || err}). Legacy build-id-only gate applies.`);
    process.exit(0);
  }
  const sample = pickSpreadSample(sampleUrls, sampleSize);
  if (sample.length === 0) {
    console.warn(`[wait-pages] ::warning:: deep-sample skipped — ${sampleFile} contains no URLs. Legacy build-id-only gate applies.`);
    process.exit(0);
  }
  console.log(`[wait-pages] deep-sample gate: ${sample.length} URLs (spread across ${sampleUrls.length} sitemap URLs), min-ok ${Math.round(sampleMinOk * 100)}%, window ${Math.round(sampleTimeoutMs / 1000)}s`);
  const converged = await waitForDeepSample({ sample, minOk: sampleMinOk, timeoutMs: sampleTimeoutMs });
  if (!converged) {
    console.error(`[wait-pages] FAIL — deep sample did not converge within ${Math.round(sampleTimeoutMs / 1000)}s: origin still has propagation holes. Caller must NOT purge the edge (previous build's cached pages are covering the holes) — propagation_timeout semantics apply.`);
    process.exit(1);
  }
  process.exit(0);
}

// Only run main() when executed directly (not when imported by tests) — same
// realpath-based guard as scripts/send-job-alerts.mjs.
const isEntryPoint = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch(err => {
    console.error('[wait-pages] Unexpected failure:', err);
    process.exit(2);
  });
}

// Test-only export: exercised by tests/wait-pages-deep-sample.test.ts with an
// injected probe — never used by the CLI path with a custom probe.
export { waitForDeepSample };
