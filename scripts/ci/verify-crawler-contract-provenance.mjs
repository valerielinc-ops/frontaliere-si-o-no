#!/usr/bin/env node

/**
 * Verify that the portable crawler artifacts in this checkout still describe
 * the bytes at the committed source revision on GitHub.
 *
 * The local contract is an assertion about a generated artifact, not proof
 * that the remote source still contains that artifact.  In particular, a
 * transport manifest can remain green while the source repository moves or a
 * generated file is changed without its contract being refreshed.  This
 * verifier reads the source commit from the contract, fetches each selected
 * sitePath from that exact commit, and compares both the local and remote
 * bytes with the declared SHA-256.  `--strict` makes any unreadable or
 * divergent value fail closed for CI.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONTRACT_PATH = '.github/corpus-workflows/contract.json';
export const DEFAULT_ARTIFACT_DIRECTORY = '.github/corpus-workflows';
export const DEFAULT_SOURCE_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const TRANSLATE_PENDING_FILE = 'translate-pending.yml';

const COMMIT_RE = /^[a-f0-9]{40}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ARTIFACT_FILE_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function sha256(bytes) {
  return crypto.createHash('sha256').update(asBytes(bytes)).digest('hex');
}

function validateRepository(repository) {
  const normalized = String(repository || '').trim();
  if (!REPOSITORY_RE.test(normalized)) {
    throw new Error(`GitHub repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
  return normalized;
}

function validateArtifactFile(file) {
  const normalized = String(file || '').trim();
  if (!ARTIFACT_FILE_RE.test(normalized)) {
    throw new Error(`crawler contract artifact file is invalid, got ${JSON.stringify(file)}`);
  }
  return normalized;
}

function validateCommit(commit) {
  const normalized = String(commit || '').trim();
  if (!COMMIT_RE.test(normalized)) {
    throw new Error(`crawler contract sourceCommit must be a 40-character lowercase SHA, got ${JSON.stringify(commit)}`);
  }
  return normalized;
}

function validateSha256(digest, label) {
  const normalized = String(digest || '').trim();
  if (!SHA256_RE.test(normalized)) {
    throw new Error(`${label} must be a 64-character lowercase SHA-256, got ${JSON.stringify(digest)}`);
  }
  return normalized;
}

function normalizeApiBase(apiBase) {
  const value = String(apiBase || DEFAULT_GITHUB_API_URL).trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`GitHub API URL is invalid: ${JSON.stringify(apiBase)}`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('GitHub API URL must be an https URL without credentials, query, or fragment');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
}

/**
 * Build the raw Contents API URL without placing credentials in the URL.
 * Every path segment is encoded independently so the repository path remains
 * an API path rather than becoming an opaque single segment.
 */
export function buildRawContentsUrl({
  apiBase = DEFAULT_GITHUB_API_URL,
  repository,
  filePath,
  ref,
} = {}) {
  const base = normalizeApiBase(apiBase);
  const repo = validateRepository(repository);
  const normalizedPath = String(filePath || '').replace(/^\/+|\/+$/gu, '');
  if (!normalizedPath || normalizedPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`GitHub contents path is invalid: ${JSON.stringify(filePath)}`);
  }
  const normalizedRef = String(ref || '').trim();
  if (!normalizedRef || /\s/u.test(normalizedRef)) {
    throw new Error(`GitHub contents ref is invalid: ${JSON.stringify(ref)}`);
  }
  const encodedPath = normalizedPath.split('/').map(encodeURIComponent).join('/');
  return `${base}/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(normalizedRef)}`;
}

function githubToken(env = process.env) {
  return String(env.GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_PAT || '').trim();
}

function fetchRemoteBytesViaGh({ url, token, timeoutMs }) {
  const env = { ...process.env };
  if (token && !env.GH_TOKEN) env.GH_TOKEN = token;
  return Buffer.from(execFileSync(
    'gh',
    ['api', '-H', 'Accept: application/vnd.github.raw', url],
    {
      env,
      encoding: 'buffer',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    },
  ));
}

/** Fetch exact remote bytes from the GitHub Contents API. */
export async function fetchRemoteBytes({
  repository,
  filePath,
  ref,
  apiBase = process.env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL,
  token,
  fetchImpl,
  transport = 'auto',
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid fetch timeout: ${timeoutMs}`);
  const url = buildRawContentsUrl({ apiBase, repository, filePath, ref });
  const authToken = token ?? githubToken();
  const canUseGh = transport === 'gh'
    || (transport === 'auto' && fetchImpl === undefined && normalizeApiBase(apiBase) === DEFAULT_GITHUB_API_URL);
  if (canUseGh) {
    try {
      const bytes = fetchRemoteBytesViaGh({ url, token: authToken, timeoutMs });
      if (bytes.length === 0) throw new Error(`gh returned an empty artifact for ${filePath}@${ref}`);
      return bytes;
    } catch (error) {
      if (transport === 'gh') {
        throw new Error(`gh api could not read ${filePath}@${ref}: ${error.message}`);
      }
    }
  }
  const effectiveFetch = fetchImpl ?? globalThis.fetch;
  if (typeof effectiveFetch !== 'function') throw new Error('global fetch is unavailable');
  const headers = {
    Accept: 'application/vnd.github.raw',
    'User-Agent': 'frontaliere-crawler-contract-provenance',
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await effectiveFetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) {
    throw new Error(`GitHub Contents API returned HTTP ${response?.status ?? 'unknown'} for ${filePath}@${ref}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`GitHub returned an empty artifact for ${filePath}@${ref}`);
  return bytes;
}

function validateContract(contract, expectedRepository) {
  if (!isRecord(contract)) throw new Error('crawler contract must be a JSON object');
  const repository = validateRepository(contract.sourceRepository);
  if (repository !== expectedRepository) {
    throw new Error(`crawler contract sourceRepository ${repository} does not match expected ${expectedRepository}`);
  }
  const sourceCommit = validateCommit(contract.sourceCommit);
  if (contract.sourceRef !== 'main') {
    throw new Error(`crawler contract sourceRef must be main, got ${JSON.stringify(contract.sourceRef)}`);
  }
  if (!isRecord(contract.artifactObservation)
      || contract.artifactObservation.sourceRepository !== undefined
      || contract.artifactObservation.sourceCommit !== sourceCommit
      || contract.artifactObservation.sourceRef !== 'main') {
    throw new Error('crawler contract artifactObservation is missing or disagrees with source lineage');
  }
  if (!Array.isArray(contract.artifacts) || contract.artifacts.length === 0) {
    throw new Error('crawler contract artifacts must be a non-empty array');
  }
  const artifacts = contract.artifacts.map((artifact) => {
    if (!isRecord(artifact)) throw new Error('crawler contract contains a malformed artifact');
    return {
      ...artifact,
      file: validateArtifactFile(artifact.file),
      artifactSha256: validateSha256(artifact.artifactSha256, `${artifact.file} artifactSha256`),
    };
  });
  const uniqueFiles = new Set(artifacts.map(({ file }) => file));
  if (uniqueFiles.size !== artifacts.length) throw new Error('crawler contract contains duplicate artifact files');
  if (Number.isSafeInteger(contract.artifactCount) && contract.artifactCount !== artifacts.length) {
    throw new Error(`crawler contract artifactCount ${contract.artifactCount} disagrees with ${artifacts.length} artifacts`);
  }
  return { repository, sourceCommit, artifacts };
}

/** Compare the local and remote bytes against one generated-artifact record. */
export function compareArtifactProvenance({ artifact, localBytes, remoteBytes } = {}) {
  if (!isRecord(artifact)) throw new Error('artifact is required');
  const file = validateArtifactFile(artifact.file);
  const declaredSha256 = validateSha256(artifact.artifactSha256, `${file} artifactSha256`);
  const local = asBytes(localBytes);
  const remote = asBytes(remoteBytes);
  const localSha256 = sha256(local);
  const remoteSha256 = sha256(remote);
  const reasons = [];
  if (localSha256 !== declaredSha256) reasons.push('local-artifact-digest-mismatch');
  if (remoteSha256 !== declaredSha256) reasons.push('remote-artifact-digest-mismatch');
  if (!local.equals(remote)) reasons.push('local-remote-bytes-mismatch');
  return {
    file,
    bytes: { local: local.length, remote: remote.length },
    declaredSha256,
    localSha256,
    remoteSha256,
    ok: reasons.length === 0,
    reasons,
  };
}

function readContract(contractPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read crawler contract ${contractPath}: ${error.message}`);
  }
  return parsed;
}

/**
 * Verify one selected artifact or the complete generated artifact set.
 * Network and shape errors are returned per artifact so a strict CLI report
 * can identify every failed remote read without silently accepting any one.
 */
export async function verifyCrawlerContractProvenance({
  rootDir = process.cwd(),
  contractPath = DEFAULT_CONTRACT_PATH,
  file = '',
  expectedRepository = process.env.GITHUB_REPOSITORY || DEFAULT_SOURCE_REPOSITORY,
  apiBase = process.env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL,
  token,
  fetchImpl,
  transport = 'auto',
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const absoluteRoot = path.resolve(rootDir);
  const absoluteContract = path.resolve(absoluteRoot, contractPath);
  const expected = validateRepository(expectedRepository);
  const contract = readContract(absoluteContract);
  const lineage = validateContract(contract, expected);
  const selectedFile = file ? validateArtifactFile(file) : '';
  const artifacts = selectedFile
    ? lineage.artifacts.filter((artifact) => artifact.file === selectedFile)
    : lineage.artifacts;
  if (artifacts.length === 0) throw new Error(`crawler contract has no artifact ${selectedFile}`);

  const results = [];
  for (const artifact of artifacts) {
    const localPath = path.resolve(absoluteRoot, DEFAULT_ARTIFACT_DIRECTORY, artifact.file);
    try {
      const localBytes = fs.readFileSync(localPath);
      const remoteBytes = await fetchRemoteBytes({
        repository: lineage.repository,
        filePath: `${DEFAULT_ARTIFACT_DIRECTORY}/${artifact.file}`,
        ref: lineage.sourceCommit,
        apiBase,
        token,
        fetchImpl,
        transport,
        timeoutMs,
      });
      results.push(compareArtifactProvenance({ artifact, localBytes, remoteBytes }));
    } catch (error) {
      results.push({
        file: artifact.file,
        ok: false,
        reasons: ['provenance-read-failed'],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: results.every((result) => result.ok),
    repository: lineage.repository,
    sourceRef: contract.sourceRef,
    sourceCommit: lineage.sourceCommit,
    artifacts: results,
  };
}

function parseArgs(argv) {
  const options = { contractPath: DEFAULT_CONTRACT_PATH, file: '', strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--strict') {
      options.strict = true;
      continue;
    }
    if (argument === '--contract' || argument === '--file') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--contract') options.contractPath = value;
      else options.file = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--contract=')) {
      options.contractPath = argument.slice('--contract='.length);
      continue;
    }
    if (argument.startsWith('--file=')) {
      options.file = argument.slice('--file='.length);
      continue;
    }
    throw new Error(`unknown option ${argument}`);
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await verifyCrawlerContractProvenance(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.strict && !result.ok) {
    const failed = result.artifacts
      .filter((artifact) => !artifact.ok)
      .map((artifact) => `${artifact.file}: ${(artifact.reasons || ['unknown']).join(', ')}`)
      .join('; ');
    throw new Error(`crawler contract provenance failed in strict mode: ${failed}`);
  }
  return result;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}
