#!/usr/bin/env node
/**
 * Runtime reliability watchdog for the public HTML/CDN build pair.
 *
 * A deploy publishes the CDN marker last, but the CDN serves mutable stable
 * asset URLs. A stale edge object can therefore coexist with a current
 * `cdn-build-id.txt` even when the normal CI probe is green. This probe fetches
 * a cache-busted copy of a small critical-asset set and compares it with the
 * copy a browser would receive at the stable URL. The companion workflow then
 * purges only the divergent URLs through the existing, variant-aware
 * Cloudflare purge helper.
 *
 * No credentials are needed to probe. The script never prints response bodies;
 * it emits only status, sizes, hashes and URLs safe for a GitHub issue.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const SITE_ORIGIN = 'https://frontaliereticino.ch';
export const CDN_ORIGIN = 'https://cdn.frontaliereticino.ch';
export const SITE_BUILD_ID_PATH = '/build-id.txt';
export const CDN_BUILD_ID_PATH = '/cdn-build-id.txt';
export const RUNTIME_CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000;

// These are the stable bundle files involved in the observed version-skew
// family. Keep the list short: the goal is a cheap liveness/coherence signal,
// not a second full-site download.
export const CRITICAL_ASSET_PATHS = [
  '/assets/App.js',
  '/assets/index-entry.js',
  '/assets/functionsBase.js',
  '/assets/Skeletons.js',
  '/assets/index.css',
];

const DEFAULT_TIMEOUT_MS = 12_000;
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 300;
const USER_AGENT = 'FrontaliereTicino-RuntimeReliability/1.0 (+https://frontaliereticino.ch)';

function cacheBust(url, nonce) {
  const parsed = new URL(url);
  parsed.searchParams.set('ft_reliability', nonce);
  return parsed.href;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Stable identity of one observed failure.  It intentionally excludes the
 * clock, cache-busting nonce and response bodies: a retry of the same
 * generation must be deduplicated, while a new deploy or a changed asset
 * must reopen the repair path.
 */
export function runtimeFailureFingerprint(result) {
  const signature = {
    assets: (result?.assets || []).map((asset) => ({
      cachedHash: asset.cachedHash || null,
      cachedStatus: asset.cachedStatus || 0,
      error: asset.error || null,
      freshHash: asset.freshHash || null,
      freshStatus: asset.freshStatus || 0,
      path: asset.path,
      state: asset.state,
    })),
    cdnBuildId: result?.cdnBuildId || null,
    markerState: result?.markerState || 'unknown',
    siteBuildId: result?.siteBuildId || null,
    version: 'runtime-reliability/v1',
  };
  return sha256(JSON.stringify(signature)).slice(0, 16);
}

/**
 * Decide whether an exact-URL purge is safe and useful.  The state is stored
 * by the workflow in an Actions cache, so repeated schedule/deploy triggers
 * do not spend Cloudflare quota on the same unchanged divergence.  A marker
 * mismatch remains blocked: there is no safe generation to purge against.
 */
export function evaluateRepairPolicy({
  probe,
  previousState = {},
  nowMs = Date.now(),
  cooldownMs = RUNTIME_CIRCUIT_COOLDOWN_MS,
} = {}) {
  const fingerprint = probe?.fingerprint || runtimeFailureFingerprint(probe);
  const previousAt = Date.parse(previousState?.lastActionAt || '');
  const sameFailure = previousState?.fingerprint === fingerprint;
  const cooldownActive = sameFailure
    && Number.isFinite(previousAt)
    && nowMs >= previousAt
    && nowMs - previousAt < Math.max(0, Number(cooldownMs) || 0);
  if (!probe?.purgeUrls?.length) {
    return {
      action: probe?.markerState === 'coherent' ? 'none' : 'blocked_marker',
      circuit: 'closed',
      fingerprint,
      reason: probe?.markerState === 'coherent' ? 'no_targeted_assets' : 'marker_not_coherent',
    };
  }
  if (cooldownActive) {
    return {
      action: 'skip_duplicate_purge',
      circuit: 'open',
      fingerprint,
      reason: 'same_fingerprint_within_cooldown',
    };
  }
  return {
    action: 'purge',
    circuit: 'closed',
    fingerprint,
    reason: sameFailure ? 'cooldown_elapsed' : 'new_fingerprint',
  };
}

/**
 * Name the direction instead of leaning on the sign. A `marker_regression`
 * would otherwise be reported as "apex behind CDN by -2.61h", which reads as a
 * negative lag rather than as the apex being ahead — the one direction an
 * operator has to act on.
 */
export function formatMarkerSkew(siteBehindMs) {
  if (!Number.isFinite(siteBehindMs)) return 'apex/CDN skew unmeasurable';
  const hours = (Math.abs(siteBehindMs) / 3_600_000).toFixed(2);
  if (siteBehindMs === 0) return 'apex and CDN on the same generation';
  return siteBehindMs > 0
    ? `apex behind CDN by ${hours}h`
    : `apex AHEAD of CDN by ${hours}h`;
}

function validBuildId(value) {
  const id = String(value || '').trim();
  return /^\d{10,20}$/.test(id) ? id : null;
}

async function readUrl(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastFailure = null;
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/plain,text/css,application/javascript,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      const body = await response.text();
      const result = {
        url,
        status: response.status,
        ok: response.ok,
        body,
        bytes: Buffer.byteLength(body, 'utf8'),
        hash: response.ok ? sha256(body) : null,
      };
      if (response.ok || (response.status >= 400 && response.status < 500)) return result;
      lastFailure = { ...result, error: `HTTP ${response.status}` };
    } catch (error) {
      lastFailure = {
        url,
        status: 0,
        ok: false,
        body: '',
        bytes: 0,
        hash: null,
        error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < TRANSIENT_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  return lastFailure;
}

/** Classify the normal CDN response against a cache-busted origin response. */
export function classifyAssetResponses(cached, fresh) {
  if (cached.ok && fresh.ok && cached.hash === fresh.hash) return 'healthy';
  if (!cached.ok && fresh.ok) return 'cached_failure';
  if (cached.ok && !fresh.ok) return 'fresh_failure';
  if (cached.ok && fresh.ok && cached.hash !== fresh.hash) return 'stale';
  return 'unavailable';
}

/**
 * Pure verdict used by the CLI and unit tests.
 *
 * Purging is allowed only when both build markers agree. If the CDN marker is
 * behind/ahead, invalidating its assets could make the edge refill from the
 * wrong generation; that condition is reported for human/issue automation,
 * never “fixed” by a blind purge.
 *
 * The marker pair has three meanings, not two. The deploy uploads CDN assets
 * and mints `cdn-build-id.txt` in the build leg, while the apex `build-id.txt`
 * only goes live once deploy-publish.yml has pushed the ~13 GB Pages artifact
 * — hours later. `cdnBuildId > siteBuildId` is therefore the *normal* state of
 * a healthy rollout (measured 2.61h–7.03h on 2026-09-18, and the deploy period
 * is of the same order, so coherence is the exception rather than the rule).
 * `siteBuildId > cdnBuildId` is the break worth failing on: the apex is serving
 * HTML for a generation whose assets the CDN never received.
 */
export function evaluateProbe({ siteCached, siteFresh, cdnMarker, assets }) {
  // The cache-busted site marker is the authoritative current origin value.
  // Falling back to the normal cached marker would turn an origin/network
  // failure into a false green and could authorize a purge against an old
  // generation.
  const siteBuildId = siteFresh?.ok ? validBuildId(siteFresh.body) : null;
  const cdnBuildId = cdnMarker?.ok ? validBuildId(cdnMarker.body) : null;
  // Build ids are epoch milliseconds minted once per deploy, so the pair also
  // carries the direction and the size of the skew — no extra state needed.
  const markerState = !siteBuildId
    ? 'site_marker_unavailable'
    : !cdnBuildId
      ? 'cdn_marker_unavailable'
      : siteBuildId === cdnBuildId
        ? 'coherent'
        // BigInt, not Number: validBuildId accepts up to 20 digits, and past
        // 2^53 a Number comparison could misclassify the direction of the skew
        // — which is the difference between a benign rollout and a regression.
        : BigInt(cdnBuildId) > BigInt(siteBuildId)
          ? 'rollout_in_progress'
          : 'marker_regression';
  // Positive while the apex is still serving an older generation than the CDN,
  // negative when it is ahead. Kept as a Number for the report: the magnitude
  // is a human-readable duration, and only the comparison above needs to be
  // exact.
  const siteBehindMs = siteBuildId && cdnBuildId
    ? Number(BigInt(cdnBuildId) - BigInt(siteBuildId))
    : null;

  const assetResults = assets.map(({ path, cached, fresh }) => ({
    path,
    cachedStatus: cached.status,
    freshStatus: fresh.status,
    cachedBytes: cached.bytes,
    freshBytes: fresh.bytes,
    cachedHash: cached.hash,
    freshHash: fresh.hash,
    state: classifyAssetResponses(cached, fresh),
    error: cached.error || fresh.error || null,
  }));

  const purgeUrls = markerState === 'coherent'
    ? assetResults
      .filter((asset) => asset.state === 'stale' || asset.state === 'cached_failure')
      .map((asset) => `${CDN_ORIGIN}${asset.path}`)
    : [];
  const unhealthyAssets = assetResults.filter((asset) => asset.state !== 'healthy');
  // The failure mode this watchdog exists for is scoped, by its own contract,
  // to the coherent state: a stable asset URL still serving the previous edge
  // object *after the current build marker is live*. While the CDN marker is
  // ahead the apex is still serving the previous generation's HTML, which wants
  // the previous asset — so an edge/origin hash difference is the intended
  // state there, and purging it would break the live page. Timeliness of the
  // rollout is owned by pages-publish-lag-watchdog.yml, which files its own
  // issue; post-deploy-validate-live.yml likewise records an apex that has not
  // caught up as "an older VALID build (not broken)". Only the reverse skew is
  // a coherence break: apex HTML referencing a generation the CDN never got.
  // A rollout explains the MARKER skew and nothing else. It is tempting to also
  // excuse a `stale` asset — the edge holding the object the live HTML still
  // references — but `classifyAssetResponses` only proves that two 200s hash
  // differently: it cannot show the cached body is the generation the apex HTML
  // actually wants, so an even older generation or an incompatible 200 would
  // pass as "explained". Every asset therefore has to be healthy in both marker
  // states, and `assetResults.length` is required because observing nothing is
  // not the same as observing health.
  const ok = (markerState === 'coherent' || markerState === 'rollout_in_progress')
    && assetResults.length > 0
    && unhealthyAssets.length === 0;

  const result = {
    ok,
    markerState,
    siteBuildId,
    cdnBuildId,
    siteBehindMs,
    siteCachedStatus: siteCached?.status || 0,
    siteFreshStatus: siteFresh?.status || 0,
    cdnMarkerStatus: cdnMarker?.status || 0,
    // Normal apex HTML can legitimately be up to its bounded 600s edge TTL
    // behind the cache-busted origin marker; expose this fact without failing
    // the runtime verdict or initiating a zone-wide purge.
    siteCachedBuildId: validBuildId(siteCached?.body),
    siteFreshBuildId: validBuildId(siteFresh?.body),
    assets: assetResults,
    purgeUrls,
    reasons: [
      markerState !== 'coherent' ? `build markers: ${markerState}` : null,
      // Print the measured skew on every run so the next tightening of this
      // check argues from data instead of intuition.
      Number.isFinite(siteBehindMs) && siteBehindMs !== 0
        ? formatMarkerSkew(siteBehindMs)
        : null,
      ...unhealthyAssets.map((asset) => `${asset.path}: ${asset.state}`),
    ].filter(Boolean),
  };
  result.fingerprint = runtimeFailureFingerprint(result);
  return result;
}

export async function probeRuntime({
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  assetPaths = CRITICAL_ASSET_PATHS,
} = {}) {
  const nonce = `${now instanceof Date ? now.getTime() : Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const siteBuildUrl = `${SITE_ORIGIN}${SITE_BUILD_ID_PATH}`;
  const cdnMarkerUrl = `${CDN_ORIGIN}${CDN_BUILD_ID_PATH}`;
  const [siteCached, siteFresh, cdnMarker] = await Promise.all([
    readUrl(siteBuildUrl, { fetchImpl, timeoutMs }),
    readUrl(cacheBust(siteBuildUrl, nonce), { fetchImpl, timeoutMs }),
    readUrl(cacheBust(cdnMarkerUrl, nonce), { fetchImpl, timeoutMs }),
  ]);
  const assets = await Promise.all(assetPaths.map(async (path) => {
    const url = `${CDN_ORIGIN}${path}`;
    const [cached, fresh] = await Promise.all([
      readUrl(url, { fetchImpl, timeoutMs }),
      readUrl(cacheBust(url, nonce), { fetchImpl, timeoutMs }),
    ]);
    return { path, cached, fresh };
  }));
  return {
    checkedAt: new Date().toISOString(),
    ...evaluateProbe({ siteCached, siteFresh, cdnMarker, assets }),
  };
}

async function main() {
  const json = process.argv.includes('--json');
  const result = await probeRuntime();
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // stdout is redirected to the report file, so keep the measured skew on
    // stderr: it has to be readable in the run log of every run, not only in
    // the uploaded artifact.
    console.error(
      `Runtime reliability: ${result.ok ? 'healthy' : 'degraded'} — ${result.markerState}`
      + ` (site=${result.siteBuildId || '—'}, cdn=${result.cdnBuildId || '—'},`
      + ` ${formatMarkerSkew(result.siteBehindMs)})`,
    );
  } else {
    console.log(`Runtime reliability: ${result.ok ? 'healthy' : 'degraded'}`);
    console.log(`Markers: ${result.markerState} (site=${result.siteBuildId || '—'}, cdn=${result.cdnBuildId || '—'})`);
    for (const reason of result.reasons) console.log(`- ${reason}`);
    if (result.purgeUrls.length) console.log(`Targeted purge candidates: ${result.purgeUrls.join(',')}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`runtime-reliability-watch failed: ${error.message}`);
    process.exitCode = 1;
  });
}
