#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  GROUP_IDS,
  GROUP_MANIFEST_REASON_CODES,
  SITE_MAIN_REF,
  SITE_REPOSITORY,
  createGroupTerminalManifest,
  digestDocument,
} from './lib/crawler-generation-contract.mjs';
import {
  MAX_RECEIPT_BYTES,
  assertSafeRunnerReportOutput,
  validateCrawlerGenerationReceipt,
} from './lib/crawler-generation-receipt.mjs';
import { isCrawlerGenerationToken } from './lib/crawler-generation-token.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GIT_TIMEOUT_MS = 30_000;
export const CRAWLER_GENERATION_LEDGER_PATH = 'data/crawler-generation-ledger.jsonl';
const LEDGER_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LEDGER_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const LEDGER_REASON_SET = new Set(GROUP_MANIFEST_REASON_CODES);

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeLedgerPath(cwd, requestedPath = CRAWLER_GENERATION_LEDGER_PATH) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || path.isAbsolute(requestedPath)
      || requestedPath.includes('\\')) throw new TypeError('Crawler generation ledger path must be a relative POSIX path');
  const parts = requestedPath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new TypeError('Crawler generation ledger path escapes the repository');
  }
  const repositoryRoot = fs.realpathSync(runGit(cwd, ['rev-parse', '--show-toplevel']).trim());
  const target = path.resolve(repositoryRoot, ...parts);
  const relative = path.relative(repositoryRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new TypeError('Crawler generation ledger path escapes the repository');
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = fs.realpathSync(parent);
  const parentRelative = path.relative(repositoryRoot, realParent);
  if (parentRelative.startsWith(`..${path.sep}`) || parentRelative === '..' || path.isAbsolute(parentRelative)) {
    throw new TypeError('Crawler generation ledger parent escapes the repository');
  }
  if (fs.existsSync(target) && (!fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) {
    throw new TypeError('Crawler generation ledger must be a regular file');
  }
  return target;
}

function ledgerPayload(manifest) {
  return {
    schemaVersion: 1,
    group: manifest.group,
    generationToken: manifest.generationToken,
    callerRepository: manifest.callerRepository,
    callerRunId: manifest.callerRunId,
    callerRunAttempt: manifest.callerRunAttempt,
    checkedAt: manifest.checkedAt,
    remoteCommit: manifest.remote?.commit ?? null,
    manifestDigest: manifest.digest,
    valid: manifest.valid,
    reasons: manifest.reasons,
  };
}

export function createCrawlerGenerationLedgerEntry(manifest) {
  const payload = ledgerPayload(manifest);
  return { ...payload, digest: digestDocument(payload) };
}

export function validateCrawlerGenerationLedgerEntry(entry) {
  const keys = [
    'schemaVersion', 'group', 'generationToken', 'callerRepository', 'callerRunId', 'callerRunAttempt',
    'checkedAt', 'remoteCommit', 'manifestDigest', 'valid', 'reasons', 'digest',
  ];
  if (!exactKeys(entry, keys)) return { valid: false, errors: ['unsupported_schema'] };
  const errors = [];
  if (entry.schemaVersion !== 1) errors.push('unsupported_schema_version');
  if (!GROUP_IDS.includes(entry.group)) errors.push('invalid_group');
  if (entry.generationToken !== null && !isCrawlerGenerationToken(entry.generationToken)) errors.push('invalid_generation_token');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.callerRepository ?? '')) errors.push('invalid_caller_repository');
  if (!/^[1-9][0-9]*$/.test(entry.callerRunId ?? '')) errors.push('invalid_caller_run_id');
  if (!Number.isInteger(entry.callerRunAttempt) || entry.callerRunAttempt < 1) errors.push('invalid_caller_run_attempt');
  if (typeof entry.checkedAt !== 'string' || Number.isNaN(Date.parse(entry.checkedAt))) errors.push('invalid_checked_at');
  if (entry.remoteCommit !== null && !LEDGER_COMMIT_RE.test(entry.remoteCommit ?? '')) errors.push('invalid_remote_commit');
  if (!LEDGER_HASH_RE.test(entry.manifestDigest ?? '')) errors.push('invalid_manifest_digest');
  if (typeof entry.valid !== 'boolean') errors.push('invalid_valid_flag');
  if (!Array.isArray(entry.reasons) || entry.reasons.some((reason) => !LEDGER_REASON_SET.has(reason))) errors.push('invalid_reasons');
  if (Array.isArray(entry.reasons) && new Set(entry.reasons).size !== entry.reasons.length) errors.push('duplicate_reasons');
  if (entry.valid === true && Array.isArray(entry.reasons) && entry.reasons.length > 0) errors.push('valid_entry_has_reasons');
  if (entry.valid === false && Array.isArray(entry.reasons) && entry.reasons.length === 0) errors.push('invalid_entry_without_reasons');
  if (entry.generationToken === null && Array.isArray(entry.reasons) && !entry.reasons.includes('generation_token_missing')) errors.push('missing_generation_token_reason');
  if (!LEDGER_HASH_RE.test(entry.digest ?? '')) errors.push('invalid_digest');
  try {
    const { digest: _digest, ...payload } = entry;
    if (digestDocument(payload) !== entry.digest) errors.push('digest_mismatch');
  } catch { errors.push('digest_mismatch'); }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors: [...new Set(errors)] };
}

export function readCrawlerGenerationLedger(cwd, requestedPath = CRAWLER_GENERATION_LEDGER_PATH) {
  const target = safeLedgerPath(cwd, requestedPath);
  if (!fs.existsSync(target)) return [];
  const raw = fs.readFileSync(target, 'utf8');
  if (raw.length === 0) return [];
  if (!raw.endsWith('\n')) throw new TypeError('Crawler generation ledger has a partial final record');
  const entries = [];
  for (const [index, line] of raw.split('\n').slice(0, -1).entries()) {
    if (line.length === 0) throw new TypeError(`Crawler generation ledger has an empty record at line ${index + 1}`);
    let entry;
    try { entry = JSON.parse(line); } catch { throw new TypeError(`Crawler generation ledger has invalid JSON at line ${index + 1}`); }
    const validation = validateCrawlerGenerationLedgerEntry(entry);
    if (!validation.valid) throw new TypeError(`Crawler generation ledger record ${index + 1} is invalid: ${validation.errors.join(', ')}`);
    entries.push(entry);
  }
  return entries;
}

export function appendCrawlerGenerationLedger(cwd, manifest, requestedPath = CRAWLER_GENERATION_LEDGER_PATH) {
  const target = safeLedgerPath(cwd, requestedPath);
  readCrawlerGenerationLedger(cwd, requestedPath);
  const entry = createCrawlerGenerationLedgerEntry(manifest);
  const validation = validateCrawlerGenerationLedgerEntry(entry);
  if (!validation.valid) throw new TypeError(`Cannot append invalid crawler generation ledger record: ${validation.errors.join(', ')}`);
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  return entry;
}

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

  let manifest;
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
    manifest = createGroupTerminalManifest({
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
    manifest = createGroupTerminalManifest({
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
  appendCrawlerGenerationLedger(input.cwd, manifest, input.ledgerPath ?? CRAWLER_GENERATION_LEDGER_PATH);
  return manifest;
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
    generationToken: requiredEnv('CRAWLER_GENERATION_TOKEN'),
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
    ledgerPath: process.env.CRAWLER_GENERATION_LEDGER_PATH || CRAWLER_GENERATION_LEDGER_PATH,
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
