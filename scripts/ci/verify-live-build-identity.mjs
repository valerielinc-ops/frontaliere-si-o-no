#!/usr/bin/env node
/**
 * Verify that the build whose artifacts are about to drive post-deploy
 * side-effects is still the build serving the live site.
 *
 * The propagation gate intentionally accepts a newer build: that is correct
 * while deciding whether a deploy is live, but unsafe immediately before
 * IndexNow/GSC/previous-slug publication. This guard therefore requires an
 * exact build-id match and fails closed on every missing or malformed input.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchLiveBuildId } from '../wait-for-pages-propagation.mjs';

export const DEFAULT_LIVE_BUILD_ID_URL = 'https://frontaliereticino.ch/build-id.txt';
const BUILD_ID_RE = /^\d+$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Exact identity is required here. `live > expected` is acceptable to the
 * propagation gate, but means this publisher is stale and must not announce
 * URLs or mutate registries for an older source.
 */
export function isExactBuildId(expectedBuildId, liveBuildId) {
  const expected = String(expectedBuildId ?? '').trim();
  const live = String(liveBuildId ?? '').trim();
  return BUILD_ID_RE.test(expected) && BUILD_ID_RE.test(live) && expected === live;
}

/**
 * A newer live build means another serialized publisher won the Pages lock
 * while this source was waiting. That race is a safe no-op for this run, but
 * an older live build is still an unexpected identity failure.
 */
export function isNewerBuildId(expectedBuildId, liveBuildId) {
  const expected = String(expectedBuildId ?? '').trim();
  const live = String(liveBuildId ?? '').trim();
  if (!BUILD_ID_RE.test(expected) || !BUILD_ID_RE.test(live)) return false;
  return BigInt(live) > BigInt(expected);
}

/**
 * @param {object} input
 * @param {string} input.expectedBuildId
 * @param {string} input.sourceRef
 * @param {string} [input.liveBuildIdUrl]
 * @param {typeof fetchLiveBuildId} [input.fetchBuildId]
 * @returns {Promise<{ok: boolean, expected: string, live: string|null, sourceRef: string, reason?: string}>}
 */
export async function verifyLiveBuildIdentity({
  expectedBuildId,
  sourceRef,
  liveBuildIdUrl = DEFAULT_LIVE_BUILD_ID_URL,
  fetchBuildId = fetchLiveBuildId,
}) {
  const expected = String(expectedBuildId ?? '').trim();
  const ref = String(sourceRef ?? '').trim();

  if (!COMMIT_SHA_RE.test(ref)) {
    return {
      ok: false,
      kind: 'invalid',
      expected,
      live: null,
      sourceRef: ref,
      reason: 'deploy_ref is missing or is not a full commit SHA',
    };
  }
  if (!BUILD_ID_RE.test(expected)) {
    return {
      ok: false,
      kind: 'invalid',
      expected,
      live: null,
      sourceRef: ref,
      reason: 'the source build-id.txt is missing, empty, or malformed',
    };
  }

  let result;
  try {
    result = await fetchBuildId(liveBuildIdUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || 'unknown error');
    return {
      ok: false,
      kind: 'fetch-failure',
      expected,
      live: null,
      sourceRef: ref,
      reason: `live build-id fetch failed: ${detail}`,
    };
  }

  const live = result?.value == null ? null : String(result.value).trim();
  const statusCode = Number(result?.status);
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300 || live === null) {
    const status = Number.isInteger(statusCode) && statusCode > 0 ? `HTTP ${statusCode}` : 'no HTTP response';
    return {
      ok: false,
      kind: 'fetch-failure',
      expected,
      live,
      sourceRef: ref,
      reason: `live build-id fetch failed (${status})`,
    };
  }
  if (!isExactBuildId(expected, live)) {
    const newerLive = isNewerBuildId(expected, live);
    return {
      ok: false,
      kind: newerLive ? 'stale' : 'mismatch',
      expected,
      live,
      sourceRef: ref,
      reason: newerLive
        ? `stale publisher source: live build-id "${live}" does not exactly match source build-id "${expected}"`
        : `live build-id "${live}" does not match source build-id "${expected}"`,
    };
  }

  return { ok: true, kind: 'match', expected, live, sourceRef: ref };
}

async function writeStatus(status) {
  const outputFile = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputFile) return;
  await appendFile(outputFile, `status=${status}\n`, 'utf8');
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedFile = args['expected-file'];
  const liveBuildIdUrl = args['live-url'] || DEFAULT_LIVE_BUILD_ID_URL;
  const sourceRef = args['source-ref'] || '';
  const stalePolicy = args['stale-policy'] || 'fail';

  if (!['fail', 'skip'].includes(stalePolicy)) {
    console.error(`::error::unsupported --stale-policy=${stalePolicy}; expected fail or skip`);
    await writeStatus('error');
    return 1;
  }

  if (!expectedFile) {
    console.error('::error::live build identity check requires --expected-file');
    await writeStatus('error');
    return 1;
  }

  let expectedBuildId;
  try {
    expectedBuildId = await readFile(expectedFile, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || 'unknown error');
    console.error(`::error::cannot read source build-id.txt at ${expectedFile}: ${detail}`);
    await writeStatus('error');
    return 1;
  }

  const verdict = await verifyLiveBuildIdentity({
    expectedBuildId,
    sourceRef,
    liveBuildIdUrl,
  });
  if (!verdict.ok) {
    if (verdict.kind === 'stale' && stalePolicy === 'skip') {
      await writeStatus('stale');
      console.log(`::notice::${verdict.reason}; skipping post-deploy side effects because a newer live build already won the publisher race`);
      return 0;
    }
    await writeStatus('error');
    console.error(`::error title=Post-deploy source is stale::${verdict.reason}; source_ref=${verdict.sourceRef || '<missing>'}; expected=${verdict.expected || '<missing>'}; live=${verdict.live || '<missing>'}`);
    return 1;
  }

  await writeStatus('match');
  console.log(`✅ [publish] live build-id "${verdict.live}" matches source build ${verdict.sourceRef}`);
  return 0;
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`::error::unexpected live build identity check failure: ${error?.message || error}`);
      process.exitCode = 1;
    });
}
