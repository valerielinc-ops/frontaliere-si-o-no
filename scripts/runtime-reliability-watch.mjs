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
 * Since 2026-09-25 the probe also walks the WHOLE chunk graph the four locales
 * load (scripts/ci/cdn-chunk-graph.mjs): every JS/CSS chunk reachable from the
 * entry pages, edge vs origin in both cache variants, plus a link check of
 * every named import against what the edge serves. The five critical assets
 * below stay as the cheap, always-available core of the verdict.
 *
 * No credentials are needed to probe. The script never prints response bodies;
 * it emits only status, sizes, hashes and URLs safe for a GitHub issue.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  chunkGraphSignature,
  crawlChunkGraph,
  defaultRotation,
  evaluateChunkGraph,
  purgeUrlsInBatches,
} from './ci/cdn-chunk-graph.mjs';

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
    // Only the failing part of the graph: a new divergence or a new broken
    // link must reopen the repair path, a healthy chunk must not churn it.
    chunkGraph: chunkGraphSignature(result?.chunkGraph),
    markerState: result?.markerState || 'unknown',
    siteBuildId: result?.siteBuildId || null,
    version: 'runtime-reliability/v2',
  };
  return sha256(JSON.stringify(signature)).slice(0, 16);
}

/**
 * Decide whether an exact-URL purge is useful.  The state is stored by the
 * workflow in an Actions cache, so repeated schedule/deploy triggers do not
 * spend Cloudflare quota on the same unchanged divergence.  evaluateProbe
 * emits purge candidates only while the markers are coherent or a rollout is
 * in progress; a marker regression or an unreadable marker yields none and is
 * reported as `blocked_marker`.
 */
export function evaluateRepairPolicy({
  probe,
  previousState = {},
  nowMs = Date.now(),
  cooldownMs = RUNTIME_CIRCUIT_COOLDOWN_MS,
} = {}) {
  const fingerprint = probe?.fingerprint || runtimeFailureFingerprint(probe);
  const markerAllowsPurge = probe?.markerState === 'coherent'
    || probe?.markerState === 'rollout_in_progress';
  const previousAt = Date.parse(previousState?.lastActionAt || '');
  const sameFailure = previousState?.fingerprint === fingerprint;
  const cooldownActive = sameFailure
    && Number.isFinite(previousAt)
    && nowMs >= previousAt
    && nowMs - previousAt < Math.max(0, Number(cooldownMs) || 0);
  if (!probe?.purgeUrls?.length) {
    return {
      action: markerAllowsPurge ? 'none' : 'blocked_marker',
      circuit: 'closed',
      fingerprint,
      reason: markerAllowsPurge ? 'no_targeted_assets' : 'marker_not_coherent',
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
 * WHICH URLS MAY BE PURGED — coherent AND rollout in progress.
 *
 * A targeted purge can only make the edge refill from R2, the single origin of
 * cdn.frontaliereticino.ch. The deploy itself uploads the new generation to R2
 * in its build leg and immediately purges every key it re-uploaded
 * (deploy-it-pages-prep.sh → scripts/ci/purge-changed-cdn-assets.mjs), hours
 * before the apex HTML goes live. So while the CDN marker is ahead of the apex
 * ("rollout in progress") the INTENDED edge state is already R2's generation,
 * and a key whose edge copy still differs from R2 is one that purge missed —
 * exactly the mixed generation that breaks module linking (2026-09-25: 3945
 * changed keys, 1000 purged, `JobBoard.js` new next to an old
 * `shared-services.js`). Until 2026-09-25 this function withheld the purge
 * outside the coherent state; run 36096588819 (04:58Z, rollout in progress)
 * saw `/assets/index.css: stale`, blocked the repair, and at 11:55Z the edge
 * still served the 24-09 21:21 object while R2 held the 25-09 04:55 one. The
 * coherent window is the exception (the rollout lasts about as long as the
 * deploy period), so that gate meant "never".
 *
 * The purge stays withheld when the markers carry no authority: with the apex
 * AHEAD of the CDN (`marker_regression`, e.g. after an R2 rollback) or a marker
 * that cannot be read, R2 may hold an older or unknown generation than the one
 * the live HTML wants, and refilling the edge from it could replace the right
 * object with the wrong one. Those states are reported, never "repaired".
 *
 * The marker pair has three meanings, not two. The deploy uploads CDN assets
 * and mints `cdn-build-id.txt` in the build leg, while the apex `build-id.txt`
 * only goes live once deploy-publish.yml has pushed the ~13 GB Pages artifact —
 * hours later. `cdnBuildId > siteBuildId` is therefore the *normal* state of a
 * healthy rollout (measured 2.61h–7.03h on 2026-09-18). `siteBuildId >
 * cdnBuildId` is the break worth failing on: the apex is serving HTML for a
 * generation whose assets the CDN never received.
 */
export function evaluateProbe({ siteCached, siteFresh, cdnMarker, assets, chunkGraph = null }) {
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

  const graph = chunkGraph ? evaluateChunkGraph(chunkGraph) : null;
  // Critical assets first (they boot every page), then the graph's own order
  // (chunks on a broken link first). Only states a purge can repair — the edge
  // disagrees with an R2 copy that exists — and only while the markers say R2
  // holds the generation the site is moving to (see the docblock).
  const purgeAllowed = markerState === 'coherent' || markerState === 'rollout_in_progress';
  const purgeUrls = !purgeAllowed ? [] : [...new Set([
    ...assetResults
      .filter((asset) => asset.state === 'stale' || asset.state === 'cached_failure')
      .map((asset) => `${CDN_ORIGIN}${asset.path}`),
    ...(graph?.purgeUrls || []),
  ])];
  const unhealthyAssets = assetResults.filter((asset) => asset.state !== 'healthy');
  // A rollout explains the marker skew, not which generation a stable asset
  // belongs to: `classifyAssetResponses` only proves that two 200s hash
  // differently, so an even older generation or an incompatible 200 would pass
  // as "explained". Every non-healthy asset therefore stays blocking in both
  // marker states — and is purgeable in both (see the docblock above): the
  // verdict turns green only once the post-purge probe finds the edge equal to
  // R2. `assetResults.length` is required because observing nothing is not the
  // same as observing health. The chunk graph, when walked, has to be clean
  // too: that is the part a browser actually links.
  const blockingAssets = unhealthyAssets;
  const ok = (markerState === 'coherent' || markerState === 'rollout_in_progress')
    && assetResults.length > 0
    && blockingAssets.length === 0
    && (graph ? graph.ok : true);

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
    chunkGraph: graph ? {
      ok: graph.ok,
      checked: graph.checked,
      entries: chunkGraph.entries,
      families: chunkGraph.families || [],
      namedImports: chunkGraph.namedImports || null,
      colos: chunkGraph.colos || [],
      durationMs: chunkGraph.durationMs ?? null,
      truncated: Boolean(chunkGraph.truncated),
      divergent: graph.divergent,
      broken: graph.broken,
      purgeUrls: graph.purgeUrls,
      reasons: graph.reasons,
      warnings: graph.warnings,
      chunks: chunkGraph.chunks,
    } : null,
    purgeUrls,
    warnings: graph?.warnings || [],
    reasons: [
      markerState !== 'coherent' ? `build markers: ${markerState}` : null,
      // Print the measured skew on every run so the next tightening of this
      // check argues from data instead of intuition.
      Number.isFinite(siteBehindMs) && siteBehindMs !== 0
        ? formatMarkerSkew(siteBehindMs)
        : null,
      ...blockingAssets.map((asset) => `${asset.path}: ${asset.state}`),
      ...(graph?.reasons || []),
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
  // `false` skips the full walk (unit tests of the marker/critical-asset core).
  chunkGraph = true,
  chunkGraphOptions = {},
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
  let graph = null;
  if (chunkGraph) {
    try {
      graph = await crawlChunkGraph({ fetchImpl, nonce, ...chunkGraphOptions });
    } catch (error) {
      // A crash of the walk must degrade the verdict (and reach the issue),
      // not kill the step and leave a red run with no report.
      graph = { entries: [], chunks: [], broken: [], error: String(error?.message || error) };
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    ...evaluateProbe({ siteCached, siteFresh, cdnMarker, assets, chunkGraph: graph }),
  };
}

/**
 * The rotation step of the chunk graph's content sample. The workflow pins it
 * once per job (CHUNK_GRAPH_ROTATION) so the post-purge verification walks
 * the SAME window the first probe did.
 */
export function rotationFromEnv(env = process.env, nowMs = Date.now()) {
  const raw = env.CHUNK_GRAPH_ROTATION;
  return raw !== undefined && /^\d+$/.test(String(raw).trim())
    ? Number(String(raw).trim())
    : defaultRotation(nowMs);
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return String(url); }
}

/**
 * Markdown body of the reliability issue. Only paths, states, validators and
 * counts — never response bodies.
 */
export function formatIssueDescription(final, { first = null, runUrl = '' } = {}) {
  const lines = ['## Runtime degradation', ''];
  if (runUrl) lines.push(`- Run: ${runUrl}`);
  lines.push(
    `- Marker state: ${final?.markerState || 'unknown'}`,
    `- Site build: ${final?.siteBuildId || 'unavailable'}`,
    `- CDN build: ${final?.cdnBuildId || 'unavailable'}`,
  );
  const graph = final?.chunkGraph;
  if (graph) {
    const families = (graph.families || [])
      .map((f) => `${f.loader}: ${f.sampled}/${f.total} content chunks (rotating window ${f.window + 1} of ${f.windows})`)
      .join('; ');
    lines.push(
      `- Chunk graph: ${graph.checked} chunk(s) from ${(graph.entries || []).length} entry page(s) in it/en/de/fr, both cache variants, ${graph.namedImports?.browser ?? 0} named import(s) link-checked, edge colo ${(graph.colos || []).join(', ') || 'unknown'}${families ? `; ${families}` : ''}`,
    );
  }
  const repair = first?.repair;
  if (repair) {
    const count = (first?.purgeUrls || []).length;
    lines.push(`- Repair: ${repair.action}${repair.action === 'purge' ? ` of ${count} URL(s) (exact files, both cache variants)` : ''} — ${repair.reason}`);
  }
  const verificationRepair = final?.repair;
  if (verificationRepair) {
    const count = verificationRepair.urls ?? (final?.purgeUrls || []).length;
    lines.push(`- Verification repair: ${verificationRepair.action}${verificationRepair.action === 'purge' ? ` of ${count} URL(s) (exact files, both cache variants)` : ''} — ${verificationRepair.reason}`);
  }
  lines.push('', '### Reasons', '');
  for (const reason of final?.reasons || []) lines.push(`- ${reason}`);
  if (!(final?.reasons || []).length) lines.push('- (none recorded)');

  const divergent = graph?.divergent || [];
  if (divergent.length) {
    lines.push('', `### Chunks differing edge vs origin in the final probe (${divergent.length})`, '');
    const byUrl = new Map((graph.chunks || []).map((c) => [c.url, c]));
    for (const d of divergent.slice(0, 40)) {
      const rec = byUrl.get(d.url);
      const edge = d.variants
        .map((v) => `${v} ${rec?.variants?.[v]?.lastModified || rec?.variants?.[v]?.status || '?'}`)
        .join(', ');
      lines.push(`- \`${d.path}\` — edge: ${edge}; origin: ${rec?.origin?.lastModified || rec?.origin?.status || '?'}`);
    }
    if (divergent.length > 40) lines.push(`- … ${divergent.length - 40} more in the run artifact`);
  }
  const broken = (graph?.broken || []).filter((b) => b.reason === 'missing_export');
  if (broken.length) {
    lines.push('', `### Broken named imports on the edge graph (${broken.length})`, '');
    for (const b of broken.slice(0, 25)) {
      lines.push(`- \`${pathOf(b.from)}\` imports \`${b.name}\` from \`${pathOf(b.to)}\`, which does not export it (${b.variant} variant)`);
    }
  }
  const targetedPurgeAttempted = [repair, verificationRepair]
    .some((attempt) => attempt?.action === 'purge');
  lines.push('', targetedPurgeAttempted
    ? 'The watchdog attempted only exact CDN URL purges (scripts/cf-purge-cache.mjs `--files=`, batches of at most 30, both cache variants). No zone-wide purge was performed.'
    : 'The watchdog did not perform a targeted purge. No zone-wide purge was performed.');
  return lines.join('\n');
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

async function main() {
  // --purge-from <report.json>: exact-URL purge of the report's candidates.
  const purgeFrom = argValue('--purge-from');
  if (purgeFrom) {
    const report = readJson(purgeFrom);
    const urls = report.purgeUrls || [];
    if (!urls.length) {
      console.log('Runtime reliability: no purge candidates.');
      return;
    }
    const outcome = purgeUrlsInBatches(urls);
    console.log(`Runtime reliability: purge dispatched for ${outcome.purged}/${urls.length} URL(s) in ${outcome.batches} batch(es).`);
    for (const failure of outcome.failed) {
      console.log(`::warning title=Runtime reliability purge batch failed::batch ${failure.index + 1}/${outcome.batches}: ${failure.error}`);
    }
    if (outcome.failed.length) process.exitCode = 1;
    return;
  }
  // --issue-body <final.json> [--first <first.json>]: markdown for the issue.
  const issueBody = argValue('--issue-body');
  if (issueBody) {
    const first = argValue('--first');
    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';
    process.stdout.write(formatIssueDescription(readJson(issueBody), {
      first: first && fs.existsSync(first) ? readJson(first) : null,
      runUrl,
    }));
    return;
  }
  // --annotate <report.json>: surface reasons/warnings as run annotations, so
  // a degraded graph is visible on the run page even when nobody opens a log.
  const annotate = argValue('--annotate');
  if (annotate) {
    const report = readJson(annotate);
    for (const reason of report.reasons || []) console.log(`::warning title=Runtime reliability::${reason}`);
    for (const warning of report.warnings || []) console.log(`::warning title=Runtime reliability (coverage)::${warning}`);
    return;
  }

  const json = process.argv.includes('--json');
  const result = await probeRuntime({ chunkGraphOptions: { rotation: rotationFromEnv() } });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // stdout is redirected to the report file, so keep the measured skew on
    // stderr: it has to be readable in the run log of every run, not only in
    // the uploaded artifact.
    const graph = result.chunkGraph;
    console.error(
      `Runtime reliability: ${result.ok ? 'healthy' : 'degraded'} — ${result.markerState}`
      + ` (site=${result.siteBuildId || '—'}, cdn=${result.cdnBuildId || '—'},`
      + ` ${formatMarkerSkew(result.siteBehindMs)})`
      + (graph ? `; chunk graph ${graph.checked} chunk(s), ${graph.namedImports?.browser ?? 0} named imports checked, ${graph.divergent.length} divergent, ${graph.broken.filter((b) => b.reason === 'missing_export').length} broken import(s), ${graph.durationMs}ms` : ''),
    );
  } else {
    console.log(`Runtime reliability: ${result.ok ? 'healthy' : 'degraded'}`);
    console.log(`Markers: ${result.markerState} (site=${result.siteBuildId || '—'}, cdn=${result.cdnBuildId || '—'})`);
    if (result.chunkGraph) {
      console.log(`Chunk graph: ${result.chunkGraph.checked} chunk(s), colo ${result.chunkGraph.colos.join(', ') || '?'}, ${result.chunkGraph.durationMs}ms`);
    }
    for (const reason of result.reasons) console.log(`- ${reason}`);
    for (const warning of result.warnings || []) console.log(`- (coverage) ${warning}`);
    if (result.purgeUrls.length) console.log(`Targeted purge candidates (${result.purgeUrls.length}): ${result.purgeUrls.join(',')}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`runtime-reliability-watch failed: ${error.message}`);
    process.exitCode = 1;
  });
}
