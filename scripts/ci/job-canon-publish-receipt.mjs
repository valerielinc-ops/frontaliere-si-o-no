#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RUN_ID_RE = /^\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

function identityMatches(candidate, expected) {
  return candidate
    && candidate.sourceRunId === expected.sourceRunId
    && typeof candidate.sourceSha === 'string'
    && SHA_RE.test(candidate.sourceSha)
    && candidate.sourceSha.toLowerCase() === expected.sourceSha.toLowerCase()
    && candidate.buildId === expected.buildId;
}

/**
 * Select the handshake proof from the job that actually ran. A successful
 * early CDN job must carry its own verified output; a skipped CDN job may use
 * only the exact durable receipt resolved from the source SHA and source run.
 */
export function resolveJobCanonPublishProof({
  sourceRunId,
  sourceSha,
  buildId,
  cdnJobResult,
  earlyProof,
  durableReceipt,
} = {}) {
  const expected = {
    sourceRunId: String(sourceRunId ?? '').trim(),
    sourceSha: String(sourceSha ?? '').trim(),
    buildId: String(buildId ?? '').trim(),
  };
  if (!RUN_ID_RE.test(expected.sourceRunId)) return { accepted: false, reason: 'expected source run id is missing or malformed' };
  if (!SHA_RE.test(expected.sourceSha)) return { accepted: false, reason: 'expected source SHA is missing or malformed' };
  if (!RUN_ID_RE.test(expected.buildId)) return { accepted: false, reason: 'expected build id is missing or malformed' };

  if (cdnJobResult === 'success') {
    return identityMatches(earlyProof, expected)
      ? { accepted: true, source: 'early-job-output' }
      : { accepted: false, reason: 'early CDN job output does not prove this source run, SHA, and build' };
  }

  if (cdnJobResult === 'skipped') {
    return durableReceipt?.published === 'true' && identityMatches(durableReceipt, expected)
      ? { accepted: true, source: 'durable-receipt' }
      : { accepted: false, reason: 'durable IT CDN receipt does not prove this source run, SHA, and build' };
  }

  return { accepted: false, reason: `CDN job result ${String(cdnJobResult ?? 'missing')} cannot prove the handshake` };
}

function main() {
  const result = resolveJobCanonPublishProof({
    sourceRunId: process.env.EXPECTED_SOURCE_RUN_ID,
    sourceSha: process.env.EXPECTED_SOURCE_SHA,
    buildId: process.env.EXPECTED_BUILD_ID,
    cdnJobResult: process.env.CDN_JOB_RESULT,
    earlyProof: {
      sourceRunId: process.env.EARLY_SOURCE_RUN_ID,
      sourceSha: process.env.EARLY_SOURCE_SHA,
      buildId: process.env.EARLY_BUILD_ID,
    },
    durableReceipt: {
      published: process.env.DURABLE_RECEIPT_PUBLISHED,
      sourceRunId: process.env.DURABLE_SOURCE_RUN_ID,
      sourceSha: process.env.DURABLE_SOURCE_SHA,
      buildId: process.env.DURABLE_BUILD_ID,
    },
  });
  if (!result.accepted) {
    console.error(`::error::job-canon publication receipt is not verified: ${result.reason}; refusing to upload a Pages artifact with bridge removals`);
    process.exitCode = 1;
    return;
  }
  console.log(`job-canon handshake closed for build ${process.env.EXPECTED_BUILD_ID} via ${result.source}`);
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) main();
