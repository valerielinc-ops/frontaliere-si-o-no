#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  SITE_MAIN_REF,
  SITE_REPOSITORY,
  createGroupTerminalManifest,
} from './lib/crawler-generation-contract.mjs';
import {
  MAX_RECEIPT_BYTES,
  assertSafeRunnerReportOutput,
  validateCrawlerGenerationReceipt,
} from './lib/crawler-generation-receipt.mjs';
import { isCrawlerGenerationToken } from './lib/crawler-generation-token.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GIT_TIMEOUT_MS = 30_000;

function runGit(cwd, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function commitFile(cwd, commit, filePath) {
  const listing = runGit(cwd, ['ls-tree', '-z', commit, '--', filePath], null);
  if (listing.length === 0) return { state: 'absent', blobOid: null };
  return { state: 'present', blobOid: runGit(cwd, ['rev-parse', `${commit}:${filePath}`]).trim() };
}

function receiptMatchesCommit(cwd, receipt) {
  try {
    runGit(cwd, ['cat-file', '-e', `${receipt.commit}^{commit}`]);
    if (receipt.outcome !== 'noop' && runGit(cwd, ['rev-parse', `${receipt.commit}^`]).trim() !== receipt.remoteBaseCommit) {
      return false;
    }
  } catch {
    return false;
  }
  return receipt.files.every((file) => {
    const actual = commitFile(cwd, receipt.commit, file.path);
    return actual.state === file.state && actual.blobOid === file.blobOid;
  });
}

function receiptIsAncestor(cwd, receipt, remoteCommit) {
  try {
    runGit(cwd, ['merge-base', '--is-ancestor', receipt.commit, remoteCommit]);
    return true;
  } catch {
    return false;
  }
}

function loadReceipts(receiptsDir, expectedCrawlerIds, generationToken, reasons) {
  const expected = new Set(expectedCrawlerIds);
  const receipts = [];
  if (!isCrawlerGenerationToken(generationToken)) {
    // Distinct from a bad receipt file: this group's own dispatch never
    // carried a token (e.g. a caller job resolved a reusable-workflow ref
    // pinned to an old, pre-token-binding definition mid-rollout). Fails
    // closed exactly like `receipt_invalid`, but tagged so on-call can tell
    // a rollout race apart from a tampered/corrupt receipt.
    reasons.push('generation_token_missing');
    return receipts;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(receiptsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') reasons.push('receipt_invalid');
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      reasons.push('receipt_invalid');
      continue;
    }
    const crawlerId = entry.name.slice(0, -5);
    if (!expected.has(crawlerId)) {
      reasons.push('receipt_invalid');
      continue;
    }
    try {
      const receiptPath = path.join(receiptsDir, entry.name);
      if (fs.statSync(receiptPath).size > MAX_RECEIPT_BYTES + 1) {
        reasons.push('receipt_invalid');
        continue;
      }
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (receipt.crawlerId !== crawlerId || receipt.generationToken !== generationToken ||
          !validateCrawlerGenerationReceipt(receipt, { allowLegacyV1: false }).valid) {
        reasons.push('receipt_invalid');
      } else {
        receipts.push(receipt);
      }
    } catch {
      reasons.push('receipt_invalid');
    }
  }
  return receipts;
}

/** Build a report from exact private-index receipts; the stale worktree is deliberately ignored. */
export function finalizeCrawlerGroup(input) {
  const expectedCrawlers = Array.isArray(input.expectedCrawlers) ? [...input.expectedCrawlers] : [];
  const expectedCrawlerIds = expectedCrawlers.map((entry) => entry?.crawlerId);
  const expectedPrimarySlices = Object.fromEntries(expectedCrawlers.flatMap((entry) => (
    typeof entry?.crawlerId === 'string' && typeof entry?.primarySlice === 'string'
      ? [[entry.crawlerId, entry.primarySlice]] : []
  )));
  const additionalReasons = [];
  let receipts = [];
  let remoteCommit = null;
  const remoteSliceOids = {};

  try {
    receipts = loadReceipts(input.receiptsDir, expectedCrawlerIds, input.generationToken, additionalReasons);
    runGit(input.cwd, ['fetch', '--no-tags', '--depth=2000', input.remoteName, 'main']);
    remoteCommit = runGit(input.cwd, ['rev-parse', `${input.remoteName}/main`]).trim();

    for (const receipt of receipts) {
      if (!receiptMatchesCommit(input.cwd, receipt)) additionalReasons.push('receipt_blob_mismatch');
      if (!receiptIsAncestor(input.cwd, receipt, remoteCommit)) additionalReasons.push('receipt_commit_not_ancestor');
      for (const file of receipt.files) {
        if (file.path.startsWith('data/jobs/by-crawler/') && file.path.endsWith('.json')) {
          remoteSliceOids[file.path] = commitFile(input.cwd, remoteCommit, file.path).blobOid;
        }
      }
    }
  } catch {
    additionalReasons.push(remoteCommit === null ? 'remote_fetch_failed' : 'manifest_internal_error');
  }

  try {
    return createGroupTerminalManifest({
      group: input.group,
      generationToken: input.generationToken ?? null,
      callerRepository: input.callerRepository,
      callerRunId: input.callerRunId,
      callerRunAttempt: input.callerRunAttempt,
      waitOutcome: input.waitOutcome,
      checkedAt: input.checkedAt,
      remoteRepository: input.remoteRepository,
      remoteRef: input.remoteRef,
      remoteCommit,
      expectedCrawlerIds,
      expectedPrimarySlices,
      receipts,
      remoteSliceOids,
      additionalReasons,
    });
  } catch {
    return createGroupTerminalManifest({
      group: input.group,
      generationToken: input.generationToken ?? null,
      callerRepository: input.callerRepository,
      callerRunId: input.callerRunId,
      callerRunAttempt: input.callerRunAttempt,
      waitOutcome: input.waitOutcome,
      checkedAt: input.checkedAt,
      remoteRepository: SITE_REPOSITORY,
      remoteRef: SITE_MAIN_REF,
      remoteCommit: null,
      expectedCrawlerIds: expectedCrawlerIds.length > 0 ? expectedCrawlerIds : ['invalid-roster'],
      expectedPrimarySlices: expectedCrawlerIds.length > 0 ? expectedPrimarySlices : { 'invalid-roster': 'data/jobs/by-crawler/invalid-roster.json' },
      receipts: [],
      remoteSliceOids: {},
      additionalReasons: ['manifest_internal_error'],
    });
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Missing ${name}`);
  return value;
}

export function runCrawlerGroupGenerationFinalizerCli() {
  const expectedCrawlers = JSON.parse(requiredEnv('CRAWLER_GENERATION_EXPECTED_CRAWLERS'));
  const runnerTemp = requiredEnv('RUNNER_TEMP');
  const group = requiredEnv('CRAWLER_GENERATION_GROUP');
  const outputPath = assertSafeRunnerReportOutput(
    process.cwd(), runnerTemp, path.resolve(requiredEnv('CRAWLER_GENERATION_OUTPUT')), 'crawler-generation',
  );
  const receiptDirectory = requiredEnv('CRAWLER_GENERATION_RECEIPT_DIR');
  const receiptsDir = assertSafeRunnerReportOutput(
    process.cwd(),
    runnerTemp,
    path.isAbsolute(receiptDirectory)
      ? path.resolve(receiptDirectory)
      : path.resolve(runnerTemp, receiptDirectory),
    path.join('crawler-generation', 'receipts'),
  );
  const manifest = finalizeCrawlerGroup({
    cwd: process.cwd(),
    group,
    generationToken: process.env.CRAWLER_GENERATION_TOKEN || null,
    callerRepository: requiredEnv('CRAWLER_GENERATION_CALLER_REPOSITORY'),
    callerRunId: requiredEnv('CRAWLER_GENERATION_CALLER_RUN_ID'),
    callerRunAttempt: Number(requiredEnv('CRAWLER_GENERATION_CALLER_RUN_ATTEMPT')),
    waitOutcome: requiredEnv('CRAWLER_GENERATION_WAIT_OUTCOME'),
    checkedAt: process.env.CRAWLER_GENERATION_CHECKED_AT || new Date().toISOString(),
    remoteRepository: SITE_REPOSITORY,
    remoteName: 'origin',
    remoteRef: SITE_MAIN_REF,
    expectedCrawlers,
    receiptsDir,
  });
  writeJsonAtomic(outputPath, manifest, { compact: true });
  process.stdout.write(`${JSON.stringify({ valid: manifest.valid, reasons: manifest.reasons })}\n`);
  return manifest;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    runCrawlerGroupGenerationFinalizerCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
