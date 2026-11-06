#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Repository-owned admission check for recurring OSS Scanner builds.
 *
 * The scanner is allowed to build only when this source tree carries a
 * machine-readable written-approval reference and the Dockerfile still
 * resolves the checked-out source to one exact commit.  The image contract is
 * a SHA-256 of the Dockerfile with this metadata block removed.  It is a
 * stable source identity, not a claim about an external registry response;
 * callers may pass the value carried by an image label with --image-contract.
 *
 * This checker deliberately does not call GitHub or fabricate an approval
 * response.  A missing, malformed, or mismatched local proof is a hard
 * failure, so the recurring scanner remains disabled until its source-backed
 * record is repaired.
 */

export const ENROLLMENT_START = '# --- OSS-SCANNER-ENROLLMENT v1 ---';
export const ENROLLMENT_END = '# --- END OSS-SCANNER-ENROLLMENT ---';
export const EXPECTED_SCANNER = 'anthropic-oss-scanner';
export const EXPECTED_IMAGE_REF = 'dockerfile:.oss-scanner/Dockerfile';
export const EXPECTED_APPROVAL_REF = 'github:valerielinc-ops/frontaliere-si-o-no/issues/14549';

const REQUIRED_FIELDS = Object.freeze([
  'approval-kind',
  'approval-ref',
  'image-contract',
  'image-ref',
  'scanner',
  'source-contract',
]);
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const APPROVAL_REF_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*$/u;
const EXACT_COMMIT_MARKERS = Object.freeze([
  'COPY .git/ /tmp/oss-scanner-git/',
  'git init --quiet /src;',
  'git -C /src fetch --quiet --no-tags --depth=1 origin "$commit"',
  'git -C /src checkout --quiet --detach FETCH_HEAD;',
  'test "$(git -C /src rev-parse HEAD)" = "$commit";',
]);
const GIT_CONTEXT_MARKERS = Object.freeze([
  '!.git/',
  '!.git/HEAD',
  '!.git/packed-refs',
  '!.git/refs/',
  '!.git/refs/**',
]);

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n');
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Return the source without the enrollment block.  Hashing this projection
 * avoids a self-referential hash while still binding the proof to every
 * executable Dockerfile line.
 */
export function stripEnrollmentBlock(source) {
  const lines = normalizeText(source).split('\n');
  const starts = lines.flatMap((line, index) => (line === ENROLLMENT_START ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === ENROLLMENT_END ? [index] : []));
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error('Dockerfile must contain exactly one complete OSS Scanner enrollment block');
  }
  return lines.slice(0, starts[0]).concat(lines.slice(ends[0] + 1)).join('\n');
}

/**
 * Parse the deliberately narrow comment record embedded in the Dockerfile.
 * Unknown or repeated fields are rejected: silently ignoring a typo would
 * turn an unverified approval into a green recurring scan.
 */
export function parseEnrollmentProof(source) {
  const lines = normalizeText(source).split('\n');
  const starts = lines.flatMap((line, index) => (line === ENROLLMENT_START ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === ENROLLMENT_END ? [index] : []));
  const errors = [];

  if (starts.length !== 1) errors.push(`expected one enrollment start marker, found ${starts.length}`);
  if (ends.length !== 1) errors.push(`expected one enrollment end marker, found ${ends.length}`);
  if (errors.length > 0) return { record: null, errors };
  if (ends[0] <= starts[0]) {
    return { record: null, errors: ['enrollment end marker precedes its start marker'] };
  }

  const record = {};
  for (const line of lines.slice(starts[0] + 1, ends[0])) {
    const match = line.match(/^# ([a-z][a-z0-9-]*): ([^\n]+)$/u);
    if (!match) {
      errors.push(`invalid enrollment field line: ${line || '<blank>'}`);
      continue;
    }
    const [, key, rawValue] = match;
    if (!REQUIRED_FIELDS.includes(key)) {
      errors.push(`unknown enrollment field: ${key}`);
      continue;
    }
    if (Object.hasOwn(record, key)) {
      errors.push(`duplicate enrollment field: ${key}`);
      continue;
    }
    const value = rawValue.trim();
    if (!value) errors.push(`empty enrollment field: ${key}`);
    record[key] = value;
  }

  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, key)) errors.push(`missing enrollment field: ${key}`);
  }

  return { record: errors.length === 0 ? record : null, errors };
}

function validateRecord(record, sourceWithoutBlock) {
  const errors = [];
  if (!record) return ['enrollment record is missing or malformed'];

  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...REQUIRED_FIELDS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    errors.push('enrollment record fields are not an exact match for the v1 contract');
  }
  if (record.scanner !== EXPECTED_SCANNER) {
    errors.push(`enrollment scanner must be ${EXPECTED_SCANNER}`);
  }
  if (record['approval-kind'] !== 'written') {
    errors.push('enrollment approval-kind must be written');
  }
  if (!APPROVAL_REF_RE.test(record['approval-ref'] || '')) {
    errors.push('enrollment approval-ref must be a repository-verifiable GitHub issue or pull reference');
  } else if (record['approval-ref'] !== EXPECTED_APPROVAL_REF) {
    errors.push(`enrollment approval-ref must be ${EXPECTED_APPROVAL_REF}`);
  }
  if (record['source-contract'] !== 'exact-commit') {
    errors.push('enrollment source-contract must be exact-commit');
  }
  if (record['image-ref'] !== EXPECTED_IMAGE_REF) {
    errors.push(`enrollment image-ref must be ${EXPECTED_IMAGE_REF}`);
  }
  if (!SHA256_RE.test(record['image-contract'] || '')) {
    errors.push('enrollment image-contract must be a sha256: digest');
  } else if (record['image-contract'] !== sha256(sourceWithoutBlock)) {
    errors.push('enrollment image-contract does not match the Dockerfile source');
  }
  return errors;
}

function resolveGitDir(repoRoot) {
  const gitPath = path.join(repoRoot, '.git');
  if (!existsSync(gitPath)) return null;
  const stat = (() => {
    try { return realpathSync(gitPath); } catch { return gitPath; }
  })();
  // A linked worktree stores a gitdir pointer in .git; a normal checkout has
  // the directory itself.  Resolve only local metadata, never a remote ref.
  try {
    const content = readFileSync(gitPath, 'utf8');
    if (content.startsWith('gitdir:')) {
      return path.resolve(repoRoot, content.slice('gitdir:'.length).trim());
    }
  } catch {
    // The directory form is handled below.  The caller will fail closed if
    // its HEAD cannot be read.
  }
  return stat;
}

function readRef(gitDir, ref) {
  const candidates = [path.join(gitDir, ref)];
  const commonDirPath = path.join(gitDir, 'commondir');
  if (existsSync(commonDirPath)) {
    try {
      const commonDir = path.resolve(gitDir, readFileSync(commonDirPath, 'utf8').trim());
      candidates.push(path.join(commonDir, ref));
      candidates.push(path.join(commonDir, 'packed-refs'));
    } catch {
      // Missing/incomprehensible common-dir metadata is a failed proof.
    }
  }
  for (const candidate of candidates) {
    try {
      if (candidate.endsWith('packed-refs')) {
        const packed = readFileSync(candidate, 'utf8');
        const line = packed.split('\n').find((entry) => entry.endsWith(` ${ref}`));
        if (line) return line.slice(0, line.indexOf(' '));
      } else if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf8').trim();
      }
    } catch {
      // Continue through the local candidates, then fail closed.
    }
  }
  return null;
}

/** Read the checked-out commit from local Git metadata without a network call. */
export function readRepositoryHead(repoRoot = process.cwd()) {
  const gitDir = resolveGitDir(path.resolve(repoRoot));
  if (!gitDir) return null;
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) return readRef(gitDir, head.slice('ref: '.length));
    return head;
  } catch {
    return null;
  }
}

function exactCommitContractErrors(source) {
  const errors = [];
  for (const marker of EXACT_COMMIT_MARKERS) {
    if (!source.includes(marker)) errors.push(`Dockerfile is missing exact-commit guard: ${marker}`);
  }
  if (/\b(?:COPY|ADD)\s+\.\s+\/src\/?/u.test(source)) {
    errors.push('Dockerfile copies an unverified working tree over the exact checkout');
  }
  return errors;
}

function dockerIgnoreErrors(dockerIgnoreSource) {
  if (dockerIgnoreSource == null) return [];
  const lines = normalizeText(dockerIgnoreSource).split('\n').map((line) => line.trim());
  return GIT_CONTEXT_MARKERS
    .filter((marker) => !lines.includes(marker))
    .map((marker) => `Dockerfile.dockerignore does not preserve exact-commit metadata: ${marker}`);
}

/**
 * Evaluate the local enrollment proof.  Optional runtime values are checked
 * when supplied by the recurring scanner; source-only invocation still
 * verifies the checked-out commit and the complete repository-owned record.
 */
export function checkOssScannerEnrollment({
  repoRoot = process.cwd(),
  dockerfilePath = path.join(repoRoot, '.oss-scanner', 'Dockerfile'),
  dockerfileSource,
  dockerIgnoreSource,
  expectedCommit,
  imageRef,
  imageContract,
  approvalRef,
} = {}) {
  const root = path.resolve(repoRoot);
  const filePath = path.resolve(dockerfilePath);
  let source = dockerfileSource;
  const errors = [];

  if (source == null) {
    try {
      source = readFileSync(filePath, 'utf8');
    } catch (error) {
      errors.push(`cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      source = '';
    }
  }
  source = normalizeText(source);

  let parsed = { record: null, errors: [] };
  let sourceWithoutBlock = '';
  try {
    parsed = parseEnrollmentProof(source);
    sourceWithoutBlock = stripEnrollmentBlock(source);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  errors.push(...parsed.errors);
  errors.push(...exactCommitContractErrors(source));
  if (parsed.record && sourceWithoutBlock) {
    errors.push(...validateRecord(parsed.record, sourceWithoutBlock));
  }

  let ignoreSource = dockerIgnoreSource;
  if (ignoreSource == null) {
    const ignorePath = path.join(path.dirname(filePath), 'Dockerfile.dockerignore');
    if (existsSync(ignorePath)) {
      try { ignoreSource = readFileSync(ignorePath, 'utf8'); } catch (error) {
        errors.push(`cannot read ${ignorePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  errors.push(...dockerIgnoreErrors(ignoreSource));

  const record = parsed.record;
  const actualHead = readRepositoryHead(root);
  const commit = expectedCommit || actualHead;
  if (!commit || !COMMIT_RE.test(commit)) {
    errors.push('checked-out source commit is missing or is not a full immutable SHA');
  }
  if (expectedCommit && actualHead && expectedCommit !== actualHead) {
    errors.push(`requested source commit ${expectedCommit} differs from checked-out HEAD ${actualHead}`);
  }
  if (record && imageRef != null && imageRef !== record['image-ref']) {
    errors.push(`image reference ${imageRef} does not match enrolled image ${record['image-ref']}`);
  }
  if (record && imageContract != null && imageContract !== record['image-contract']) {
    errors.push(`image contract ${imageContract} does not match enrolled contract ${record['image-contract']}`);
  }
  if (record && approvalRef != null && approvalRef !== record['approval-ref']) {
    errors.push(`approval reference ${approvalRef} does not match enrolled approval ${record['approval-ref']}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    record,
    commit: actualHead,
    imageContract: record?.['image-contract'] || null,
  };
}

function parseArgs(argv) {
  const args = {};
  const flags = new Map([
    ['--repo-root', 'repoRoot'],
    ['--dockerfile', 'dockerfilePath'],
    ['--commit', 'expectedCommit'],
    ['--image', 'imageRef'],
    ['--image-ref', 'imageRef'],
    ['--image-contract', 'imageContract'],
    ['--approval-ref', 'approvalRef'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') return { help: true };
    const key = flags.get(name);
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`unknown or incomplete argument: ${name}`);
    }
    args[key] = argv[index + 1];
    index += 1;
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (args.help) {
    console.log('Usage: node scripts/ci/check-oss-scanner-enrollment.mjs [--repo-root DIR] [--dockerfile FILE] [--commit SHA] [--image IMAGE] [--image-contract sha256:…] [--approval-ref github:OWNER/REPO/issues/N]');
    return 0;
  }
  const result = checkOssScannerEnrollment(args);
  if (result.ok) {
    console.log(`✅ OSS Scanner enrollment verified for exact commit ${result.commit}`);
    return 0;
  }
  console.error(`::error::OSS Scanner enrollment refused: ${result.errors.join('; ')}`);
  return 1;
}

const isMain = (() => {
  try {
    return process.argv[1]
      && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) process.exitCode = main();
