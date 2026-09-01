#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { canonicalJson, digestDocument } from './canonical-json-digest.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OUTCOMES = Object.freeze(['noop', 'pushed', 'push_contention', 'failed']);
const OUTCOME_SET = new Set(OUTCOMES);
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const OBJECT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CRAWLER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_FILES = 128;
const MAX_COMMIT_MESSAGE_BYTES = 128 * 1024;
export const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_HASHED_SLICE_BYTES = 128 * 1024 * 1024;

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareCodePoint);
  const expected = [...keys].sort(compareCodePoint);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validRepositoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || path.isAbsolute(value)) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isValidCrawlerSlicePath(value) {
  return typeof value === 'string' && /^data\/jobs\/by-crawler\/[a-z0-9][a-z0-9._-]*\.json$/.test(value);
}

function sha256Blob(cwd, blobOid) {
  const size = Number(execFileSync('git', ['cat-file', '-s', blobOid], { cwd, encoding: 'utf8', timeout: 30_000 }).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_HASHED_SLICE_BYTES) {
    throw new TypeError('Crawler slice exceeds hashed byte limit');
  }
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-blob-'));
  const tempFile = path.join(tempDirectory, 'blob');
  try {
    const output = fs.openSync(tempFile, 'w');
    try {
      execFileSync('git', ['cat-file', 'blob', blobOid], {
        cwd, stdio: ['ignore', output, 'pipe'], timeout: 30_000, killSignal: 'SIGTERM',
      });
    } finally {
      fs.closeSync(output);
    }
    const hash = createHash('sha256');
    const input = fs.openSync(tempFile, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead;
      while ((bytesRead = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead));
    } finally {
      fs.closeSync(input);
    }
    return `sha256:${hash.digest('hex')}`;
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function readCommitFile(cwd, commit, filePath) {
  const options = { cwd, encoding: null, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGTERM' };
  const listing = execFileSync('git', ['ls-tree', '-z', commit, '--', filePath], options);
  if (listing.length === 0) return { path: filePath, state: 'absent', blobOid: null, sha256: null };
  const blobOid = execFileSync('git', ['rev-parse', `${commit}:${filePath}`], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }).trim();
  const isJobSlice = isValidCrawlerSlicePath(filePath);
  return { path: filePath, state: 'present', blobOid, sha256: isJobSlice ? sha256Blob(cwd, blobOid) : null };
}

/** Build one deterministic receipt from the exact tree created by the private index. */
export function createCrawlerGenerationReceipt(input) {
  if (!CRAWLER_ID_RE.test(input.crawlerId ?? '')) throw new TypeError('Invalid crawler receipt identity');
  if (!OUTCOME_SET.has(input.outcome)) throw new TypeError('Invalid crawler receipt outcome');
  if (!COMMIT_RE.test(input.commit ?? '') || !COMMIT_RE.test(input.remoteBaseCommit ?? '')) {
    throw new TypeError('Invalid crawler receipt commit');
  }
  if ((input.outcome === 'noop') !== (input.commit === input.remoteBaseCommit)) {
    throw new TypeError('Crawler receipt outcome does not match its commit transition');
  }
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_FILES) {
    throw new TypeError('Invalid crawler receipt path count');
  }
  if (input.paths.some((filePath) => !validRepositoryPath(filePath))) {
    throw new TypeError('Invalid crawler receipt path');
  }
  const paths = [...input.paths].sort(compareCodePoint);
  if (new Set(paths).size !== paths.length) throw new TypeError('Duplicate crawler receipt path');
  execFileSync('git', ['cat-file', '-e', `${input.commit}^{commit}`], {
    cwd: input.cwd,
    stdio: 'ignore',
    timeout: 30_000,
    killSignal: 'SIGTERM',
  });
  const payload = {
    schemaVersion: 1,
    crawlerId: input.crawlerId,
    outcome: input.outcome,
    commit: input.commit,
    remoteBaseCommit: input.remoteBaseCommit,
    files: paths.map((filePath) => readCommitFile(input.cwd, input.commit, filePath)),
  };
  const receipt = { ...payload, digest: digestDocument(payload) };
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES) {
    throw new TypeError('Crawler generation receipt exceeds byte limit');
  }
  return receipt;
}

export function validateCrawlerGenerationReceipt(receipt) {
  const errors = [];
  if (!exactKeys(receipt, [
    'schemaVersion', 'crawlerId', 'outcome', 'commit', 'remoteBaseCommit', 'files', 'digest',
  ])) return { valid: false, errors: ['unsupported_schema'] };
  if (receipt.schemaVersion !== 1) errors.push('unsupported_schema_version');
  if (!CRAWLER_ID_RE.test(receipt.crawlerId ?? '')) errors.push('invalid_crawler_id');
  if (!OUTCOME_SET.has(receipt.outcome)) errors.push('invalid_outcome');
  if (!COMMIT_RE.test(receipt.commit ?? '')) errors.push('invalid_commit');
  if (!COMMIT_RE.test(receipt.remoteBaseCommit ?? '')) errors.push('invalid_remote_base_commit');
  if ((receipt.outcome === 'noop') !== (receipt.commit === receipt.remoteBaseCommit)) errors.push('invalid_commit_transition');
  if (!Array.isArray(receipt.files) || receipt.files.length === 0 || receipt.files.length > MAX_FILES) {
    errors.push('invalid_files');
  } else {
    const paths = [];
    for (const file of receipt.files) {
      if (!exactKeys(file, ['path', 'state', 'blobOid', 'sha256'])) {
        errors.push('invalid_file_schema');
        continue;
      }
      paths.push(file.path);
      if (!validRepositoryPath(file.path)) errors.push('invalid_file_path');
      if (!['present', 'absent'].includes(file.state)) errors.push('invalid_file_state');
      if (file.state === 'present' && !OBJECT_RE.test(file.blobOid ?? '')) errors.push('invalid_blob_oid');
      if (file.state === 'present' && isValidCrawlerSlicePath(file.path) && !HASH_RE.test(file.sha256 ?? '')) errors.push('invalid_file_hash');
      if (file.state === 'present' && !isValidCrawlerSlicePath(file.path) && file.sha256 !== null) errors.push('unexpected_non_slice_hash');
      if (file.state === 'absent' && (file.blobOid !== null || file.sha256 !== null)) errors.push('invalid_absent_hash');
    }
    if (new Set(paths).size !== paths.length) errors.push('duplicate_file_path');
    if (canonicalJson(paths) !== canonicalJson([...paths].sort(compareCodePoint))) errors.push('non_canonical_file_order');
  }
  if (!HASH_RE.test(receipt.digest ?? '')) errors.push('invalid_digest');
  try {
    const { digest, ...payload } = receipt;
    if (digestDocument(payload) !== digest) errors.push('digest_mismatch');
    if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES) errors.push('receipt_too_large');
  } catch {
    errors.push('invalid_canonical_payload');
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)].sort(compareCodePoint) };
}

export function createCrawlerGroupCommitDescriptor(input) {
  if (!CRAWLER_ID_RE.test(input.crawlerId ?? '')) throw new TypeError('Invalid crawler commit descriptor identity');
  if (typeof input.commitMessage !== 'string' || input.commitMessage.trim().length === 0 ||
      Buffer.byteLength(input.commitMessage) > MAX_COMMIT_MESSAGE_BYTES) {
    throw new TypeError('Invalid crawler commit descriptor message');
  }
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_FILES) {
    throw new TypeError('Invalid crawler commit descriptor path count');
  }
  if (input.paths.some((filePath) => !validRepositoryPath(filePath))) {
    throw new TypeError('Invalid crawler commit descriptor path');
  }
  const paths = [...input.paths].sort(compareCodePoint);
  if (new Set(paths).size !== paths.length) throw new TypeError('Duplicate crawler commit descriptor path');
  return {
    schemaVersion: 1,
    crawlerId: input.crawlerId,
    commitMessage: input.commitMessage,
    paths,
  };
}

export function validateCrawlerGroupCommitDescriptor(descriptor) {
  const errors = [];
  if (!exactKeys(descriptor, ['schemaVersion', 'crawlerId', 'commitMessage', 'paths'])) {
    return { valid: false, errors: ['unsupported_schema'] };
  }
  if (descriptor.schemaVersion !== 1) errors.push('unsupported_schema_version');
  if (!CRAWLER_ID_RE.test(descriptor.crawlerId ?? '')) errors.push('invalid_crawler_id');
  if (typeof descriptor.commitMessage !== 'string' || descriptor.commitMessage.trim().length === 0 ||
      Buffer.byteLength(descriptor.commitMessage ?? '') > MAX_COMMIT_MESSAGE_BYTES) {
    errors.push('invalid_commit_message');
  }
  if (!Array.isArray(descriptor.paths) || descriptor.paths.length === 0 || descriptor.paths.length > MAX_FILES) {
    errors.push('invalid_paths');
  } else {
    if (descriptor.paths.some((filePath) => !validRepositoryPath(filePath))) errors.push('invalid_path');
    if (new Set(descriptor.paths).size !== descriptor.paths.length) errors.push('duplicate_path');
    if (canonicalJson(descriptor.paths) !== canonicalJson([...descriptor.paths].sort(compareCodePoint))) {
      errors.push('non_canonical_path_order');
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)].sort(compareCodePoint) };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(root, target) {
  if (fs.lstatSync(root).isSymbolicLink()) throw new TypeError('RUNNER_TEMP cannot be a symlink');
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new TypeError('Receipt output cannot cross a symlink');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function canonicalFuturePath(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

export function assertSafeRunnerReportOutput(cwd, runnerTemp, target, relativeRoot) {
  const resolvedCwd = fs.realpathSync(cwd);
  const resolvedRunnerTemp = fs.realpathSync(runnerTemp);
  if (isWithin(resolvedCwd, resolvedRunnerTemp)) throw new TypeError('RUNNER_TEMP cannot be inside the repository');
  const allowedRoot = path.join(resolvedRunnerTemp, relativeRoot);
  const resolvedTarget = canonicalFuturePath(target);
  if (!isWithin(allowedRoot, resolvedTarget)) throw new TypeError('Unsafe crawler generation report output');
  assertNoSymlinkComponents(resolvedRunnerTemp, resolvedTarget);
  return resolvedTarget;
}

function safeReceiptOutput(cwd, receiptDir, runnerTemp, crawlerId) {
  const receiptRoot = path.isAbsolute(receiptDir)
    ? path.resolve(receiptDir)
    : path.resolve(runnerTemp, receiptDir);
  const output = path.join(receiptRoot, `${crawlerId}.json`);
  return assertSafeRunnerReportOutput(cwd, runnerTemp, output, path.join('crawler-generation', 'receipts'));
}

function safeBatchDescriptorOutput(cwd, descriptorDir, runnerTemp, crawlerId) {
  const descriptorRoot = path.isAbsolute(descriptorDir)
    ? path.resolve(descriptorDir)
    : path.resolve(runnerTemp, descriptorDir);
  const output = path.join(descriptorRoot, `${crawlerId}.json`);
  return assertSafeRunnerReportOutput(cwd, runnerTemp, output, path.join('crawler-generation', 'commit-batch'));
}

function safeBatchDescriptorRoot(cwd, descriptorDir, runnerTemp) {
  const descriptorRoot = path.isAbsolute(descriptorDir)
    ? path.resolve(descriptorDir)
    : path.resolve(runnerTemp, descriptorDir);
  return assertSafeRunnerReportOutput(
    cwd,
    runnerTemp,
    descriptorRoot,
    path.join('crawler-generation', 'commit-batch'),
  );
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Missing ${name}`);
  return value;
}

export function runCrawlerGenerationReceiptCli(paths = process.argv.slice(2)) {
  const cwd = process.cwd();
  const crawlerId = requiredEnv('JOBS_HOUSEKEEPING_SCOPE');
  const receipt = createCrawlerGenerationReceipt({
    cwd,
    crawlerId,
    outcome: requiredEnv('CRAWLER_GENERATION_RECEIPT_OUTCOME'),
    commit: requiredEnv('CRAWLER_GENERATION_RECEIPT_COMMIT'),
    remoteBaseCommit: requiredEnv('CRAWLER_GENERATION_RECEIPT_REMOTE_BASE'),
    paths,
  });
  const output = safeReceiptOutput(
    cwd,
    requiredEnv('CRAWLER_GENERATION_RECEIPT_DIR'),
    requiredEnv('RUNNER_TEMP'),
    crawlerId,
  );
  writeJsonAtomic(output, receipt);
  return receipt;
}

export function runCrawlerGroupCommitDescriptorCli(paths = process.argv.slice(3)) {
  const cwd = process.cwd();
  const crawlerId = requiredEnv('JOBS_HOUSEKEEPING_SCOPE');
  const descriptor = createCrawlerGroupCommitDescriptor({
    crawlerId,
    commitMessage: requiredEnv('CRAWLER_GROUP_COMMIT_MESSAGE'),
    paths,
  });
  const output = safeBatchDescriptorOutput(
    cwd,
    requiredEnv('CRAWLER_GROUP_COMMIT_DIR'),
    requiredEnv('RUNNER_TEMP'),
    crawlerId,
  );
  writeJsonAtomic(output, descriptor);
  return descriptor;
}

export function readCrawlerGroupCommitDescriptors({
  cwd = process.cwd(),
  descriptorDir = requiredEnv('CRAWLER_GROUP_COMMIT_DIR'),
  runnerTemp = requiredEnv('RUNNER_TEMP'),
} = {}) {
  const root = safeBatchDescriptorRoot(cwd, descriptorDir, runnerTemp);
  if (!fs.existsSync(root)) return [];
  if (!fs.lstatSync(root).isDirectory()) throw new TypeError('Crawler commit descriptor root must be a directory');
  const descriptors = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => compareCodePoint(left.name, right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
      throw new TypeError('Invalid crawler commit descriptor entry');
    }
    const descriptor = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8'));
    const validation = validateCrawlerGroupCommitDescriptor(descriptor);
    if (!validation.valid || entry.name !== `${descriptor.crawlerId}.json`) {
      throw new TypeError(`Invalid crawler commit descriptor: ${validation.errors.join(',') || 'identity_mismatch'}`);
    }
    descriptors.push(descriptor);
  }
  if (new Set(descriptors.map(({ crawlerId }) => crawlerId)).size !== descriptors.length) {
    throw new TypeError('Duplicate crawler commit descriptor identity');
  }
  return descriptors;
}

export function crawlerGroupCommitPaths(descriptors) {
  return [...new Set(descriptors.flatMap(({ paths }) => paths))].sort(compareCodePoint);
}

export function crawlerGroupCommitMessage(baseMessage, descriptors) {
  if (typeof baseMessage !== 'string' || baseMessage.trim().length === 0) {
    throw new TypeError('Missing crawler group commit message');
  }
  const attribution = descriptors.map(({ crawlerId, commitMessage }) => (
    `--- ${crawlerId} ---\n${commitMessage.trimEnd()}`
  ));
  return attribution.length === 0
    ? baseMessage.trimEnd()
    : `${baseMessage.trimEnd()}\n\nPer-crawler attribution:\n\n${attribution.join('\n\n')}`;
}

export function runCrawlerGroupCommitBatchReceiptsCli() {
  const cwd = process.cwd();
  const descriptors = readCrawlerGroupCommitDescriptors({ cwd });
  const outcome = requiredEnv('CRAWLER_GENERATION_RECEIPT_OUTCOME');
  const commit = requiredEnv('CRAWLER_GENERATION_RECEIPT_COMMIT');
  const remoteBaseCommit = requiredEnv('CRAWLER_GENERATION_RECEIPT_REMOTE_BASE');
  for (const descriptor of descriptors) {
    const receipt = createCrawlerGenerationReceipt({
      cwd,
      crawlerId: descriptor.crawlerId,
      outcome,
      commit,
      remoteBaseCommit,
      paths: descriptor.paths,
    });
    const output = safeReceiptOutput(
      cwd,
      requiredEnv('CRAWLER_GENERATION_RECEIPT_DIR'),
      requiredEnv('RUNNER_TEMP'),
      descriptor.crawlerId,
    );
    writeJsonAtomic(output, receipt);
  }
  return descriptors.length;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    const command = process.argv[2];
    if (command === '--defer-group-commit') {
      runCrawlerGroupCommitDescriptorCli();
    } else if (command === '--batch-paths') {
      const paths = crawlerGroupCommitPaths(readCrawlerGroupCommitDescriptors());
      process.stdout.write(paths.length === 0 ? '' : `${paths.join('\0')}\0`);
    } else if (command === '--batch-message') {
      process.stdout.write(crawlerGroupCommitMessage(process.argv[3] ?? '', readCrawlerGroupCommitDescriptors()));
    } else if (command === '--batch-receipts') {
      runCrawlerGroupCommitBatchReceiptsCli();
    } else {
      runCrawlerGenerationReceiptCli();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
