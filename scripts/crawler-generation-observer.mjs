#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { assertSafeRunnerReportOutput } from './lib/crawler-generation-receipt.mjs';
import {
  createCrawlerGenerationObserverReport,
  createSentinelSetBinding,
} from './lib/crawler-generation-observer-report.mjs';
import {
  createGitHubActionsReadClient,
  isMissingExactGitHubResource,
} from './lib/github-actions-read-client.mjs';
import {
  CALLER_REPOSITORY,
  CRAWLER_GENERATION_GITHUB_API_VERSION,
  GROUP_IDS,
  MAX_CYCLE_MANIFEST_BYTES,
  MAX_GROUP_MANIFEST_BYTES,
  MAX_SENTINEL_BYTES,
  SITE_REPOSITORY,
  canonicalJson,
  crawlerGenerationSentinelWorkflowIdentity,
  deriveCrawlerGenerationSourceCommit,
  digestDocument,
  evaluateCrawlerGenerationBarrier,
  resolveCrawlerGenerationSentinels,
  validateCrawlerGenerationWorkflowRun,
  validateCrawlerGenerationRoster,
  validateCrawlerGenerationSentinel,
  validateGroupTerminalManifest,
} from './lib/crawler-generation-contract.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_ID_RE = /^[1-9][0-9]*$/;
const GIT_TIMEOUT_MS = 30_000;
const MAX_REPLAY_SENTINELS = 16;
export const MAX_ARTIFACT_ARCHIVE_BYTES = 64 * 1024;

class ObserverDataError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class ObserverInfrastructureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function classifyObserverFailure(error) {
  return error instanceof ObserverDataError
    ? { status: 'blocked', reason: error.code }
    : { status: 'infrastructure_error', reason: error?.code ?? 'observer_internal_error' };
}

export function validateBoundCrawlerRun(run, binding) {
  const validation = validateCrawlerGenerationWorkflowRun(run, binding);
  if (!validation.valid) {
    throw new ObserverDataError('run_binding_invalid', 'Crawler run binding is invalid');
  }
  return validation.observation;
}

export function selectBoundArtifact(artifacts, binding) {
  const exact = Array.isArray(artifacts)
    ? artifacts.filter((artifact) => artifact?.name === binding.artifactName)
    : [];
  if (exact.length === 0) throw new ObserverDataError('artifact_missing', 'Bound artifact is missing');
  if (exact.length !== 1) throw new ObserverDataError('artifact_ambiguous', 'Bound artifact is ambiguous');
  const artifact = exact[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1
      || String(artifact.workflow_run?.id ?? '') !== binding.runId) {
    throw new ObserverDataError('artifact_binding_invalid', 'Artifact run binding is invalid');
  }
  if (artifact.expired !== false) throw new ObserverDataError('artifact_expired', 'Bound artifact is expired');
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
      || artifact.size_in_bytes > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new ObserverDataError('artifact_too_large', 'Artifact exceeds byte limit');
  }
  return artifact;
}

/** Read one regular JSON member without extracting attacker-controlled paths. */
export function readBoundedArtifactJson(archivePath, expectedName, maxBytes) {
  const stat = fs.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new ObserverDataError('artifact_archive_invalid', 'Artifact archive is not a bounded regular file');
  }
  let names;
  let verbose;
  try {
    names = execFileSync('unzip', ['-Z', '-1', archivePath], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024,
    }).split('\n').filter(Boolean);
    verbose = execFileSync('unzip', ['-Z', '-v', archivePath], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024,
    });
  } catch {
    throw new ObserverDataError('artifact_archive_invalid', 'Artifact archive directory is invalid');
  }
  if (names.length !== 1) {
    throw new ObserverDataError('artifact_archive_invalid', 'Artifact archive must contain exactly one entry');
  }
  if (names[0] !== expectedName || expectedName.includes('/') || expectedName.includes('\\')) {
    throw new ObserverDataError('artifact_archive_invalid', 'Artifact entry name is invalid');
  }
  const sizeMatch = /uncompressed size:\s+(\d+) bytes/.exec(verbose);
  const modeMatch = /Unix file attributes \((\d{6}) octal\):\s+([^\n]+)/.exec(verbose);
  if (!sizeMatch || !modeMatch || !modeMatch[1].startsWith('100') || !modeMatch[2].startsWith('-')) {
    throw new ObserverDataError('artifact_archive_invalid', 'Artifact entry is not a regular file');
  }
  const uncompressedBytes = Number(sizeMatch[1]);
  if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes < 1 || uncompressedBytes > maxBytes) {
    throw new ObserverDataError('artifact_too_large', 'Artifact entry exceeds byte limit');
  }
  try {
    const bytes = execFileSync('unzip', ['-p', archivePath, expectedName], {
      encoding: null, timeout: GIT_TIMEOUT_MS, maxBuffer: maxBytes + 1,
    });
    if (bytes.length !== uncompressedBytes || bytes.length > maxBytes) throw new Error('size mismatch');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ObserverDataError('artifact_archive_invalid', 'Artifact JSON payload is invalid');
  }
}

function createObserverReport({
  evaluatedAt,
  generationToken = null,
  siteCodeCommit = null,
  corpusCodeCommit = null,
  sentinelDigest = null,
  sentinelSetDigest = null,
  sentinelReplayCount = null,
  dispatchDiagnostics = null,
  evidenceDigest = null,
  status,
  reasons,
  barrier,
}) {
  return createCrawlerGenerationObserverReport({
    evaluatedAt,
    generationToken,
    siteCodeCommit,
    corpusCodeCommit,
    sentinelDigest,
    sentinelSetDigest,
    sentinelReplayCount,
    dispatchDiagnostics,
    evidenceDigest,
    status,
    reasons,
    barrier,
  });
}

function sentinelReportBinding(sentinel, replayCount, sentinelSet = null) {
  return {
    generationToken: sentinel?.generationToken ?? null,
    siteCodeCommit: sentinel?.siteCodeCommit ?? null,
    corpusCodeCommit: sentinel?.corpusCodeCommit ?? null,
    sentinelDigest: sentinel?.digest ?? null,
    sentinelSetDigest: sentinelSet?.sentinelSetDigest ?? null,
    sentinelReplayCount: Number.isInteger(replayCount) && replayCount >= 0 ? replayCount : null,
    dispatchDiagnostics: sentinel?.dispatchDiagnostics ?? null,
  };
}

function deterministicEvidenceTimestamp(manifests, fallback) {
  const timestamps = GROUP_IDS.map((group) => (
    validateGroupTerminalManifest(manifests[group]).valid
      ? Date.parse(manifests[group].checkedAt)
      : Number.NaN
  ));
  return timestamps.every(Number.isFinite)
    ? new Date(Math.max(...timestamps)).toISOString()
    : fallback;
}

function createEvidenceDigest({ sentinel, observations, manifests, sourceCommit, barrier }) {
  return digestDocument({
    schemaVersion: 1,
    generationToken: sentinel.generationToken,
    siteCodeCommit: sentinel.siteCodeCommit,
    corpusCodeCommit: sentinel.corpusCodeCommit,
    sentinelDigest: sentinel.digest,
    runObservations: observations,
    manifestDigests: Object.fromEntries(GROUP_IDS.map((group) => [group, manifests[group]?.digest ?? null])),
    sourceCommit,
    barrierDigest: barrier.digest,
  });
}

function sentinelRunRegistry(sentinel) {
  return {
    schemaVersion: 1,
    cycleId: sentinel.generationToken,
    generationToken: sentinel.generationToken,
    groups: Object.fromEntries(GROUP_IDS.map((group) => [group, {
      repository: CALLER_REPOSITORY,
      workflow: sentinel.groups[group].workflowFile,
      runId: sentinel.groups[group].runId,
      runName: sentinel.groups[group].runName,
    }])),
  };
}

/** Event adapter independent core; callers provide exact-ID GitHub and Git oracles. */
export async function observeCrawlerGeneration({
  sentinels,
  roster,
  evaluatedAt,
  timedOut = false,
  getRun,
  listRunArtifacts,
  readArtifact,
  prepareSource,
}) {
  let sentinelSet = null;
  try { sentinelSet = createSentinelSetBinding(sentinels); } catch { /* malformed input remains fail-closed */ }
  const resolution = resolveCrawlerGenerationSentinels(sentinels);
  if (resolution.status !== 'accepted') {
    const candidate = Array.isArray(sentinels) && validateCrawlerGenerationSentinel(sentinels[0]).valid
      ? sentinels[0]
      : null;
    return createObserverReport({
      evaluatedAt,
      ...sentinelReportBinding(candidate, resolution.replayCount, sentinelSet),
      status: 'blocked',
      reasons: [resolution.reason],
      barrier: null,
    });
  }
  const sentinel = resolution.sentinel;
  const reportBinding = sentinelReportBinding(sentinel, resolution.replayCount, sentinelSet);
  if (GROUP_IDS.some((group) => sentinel.groups[group].runId === null)) {
    return createObserverReport({
      evaluatedAt,
      ...reportBinding,
      status: 'blocked',
      reasons: ['blocked_dispatch_missing'],
      barrier: null,
    });
  }
  if (!validateCrawlerGenerationRoster(roster).valid) {
    return createObserverReport({
      evaluatedAt, ...reportBinding,
      status: 'blocked', reasons: ['roster_invalid'], barrier: null,
    });
  }
  const observations = {};
  const manifests = {};
  try {
    for (const group of GROUP_IDS) {
      const binding = sentinel.groups[group];
      observations[group] = validateBoundCrawlerRun(await getRun(binding.runId), binding);
    }
  } catch (error) {
    const failure = classifyObserverFailure(error);
    return createObserverReport({
      evaluatedAt,
      ...reportBinding,
      status: failure.status,
      reasons: [failure.reason],
      barrier: null,
    });
  }
  if (Object.values(observations).some((observation) => observation.status !== 'completed')) {
    return createObserverReport({
      evaluatedAt,
      ...reportBinding,
      status: timedOut ? 'blocked' : 'waiting',
      reasons: [timedOut ? 'observer_timeout' : 'caller_runs_incomplete'],
      barrier: null,
    });
  }

  let aggregateArtifactBytes = 0;
  try {
    // Two-phase by construction: no artifact is listed or downloaded until
    // every exact run is terminal. Event-driven replays therefore issue at
    // most one 23-artifact read for the generation instead of O(groups²).
    for (const group of GROUP_IDS) {
      const binding = sentinel.groups[group];
      const artifact = selectBoundArtifact(await listRunArtifacts(binding.runId), binding);
      aggregateArtifactBytes += artifact.size_in_bytes;
      if (aggregateArtifactBytes > MAX_CYCLE_MANIFEST_BYTES) {
        throw new ObserverDataError('artifact_cycle_too_large', 'Aggregate artifacts exceed cycle byte limit');
      }
      manifests[group] = await readArtifact(
        artifact,
        `crawler-group-${group}-terminal.json`,
        MAX_GROUP_MANIFEST_BYTES,
      );
    }
  } catch (error) {
    const failure = classifyObserverFailure(error);
    return createObserverReport({
      evaluatedAt,
      ...reportBinding,
      status: failure.status,
      reasons: [failure.reason],
      barrier: null,
    });
  }

  let source;
  try {
    source = await prepareSource(manifests, sentinel);
  } catch (error) {
    return createObserverReport({
      evaluatedAt,
      ...reportBinding,
      status: 'infrastructure_error',
      reasons: [error?.code ?? 'source_snapshot_failed'],
      barrier: null,
    });
  }
  if (source.status !== 'ready') {
    return createObserverReport({
      evaluatedAt,
      ...reportBinding,
      status: source.status === 'infrastructure_error' ? 'infrastructure_error' : 'blocked',
      reasons: [source.reason],
      barrier: null,
    });
  }
  const evidenceEvaluatedAt = deterministicEvidenceTimestamp(manifests, evaluatedAt);
  const barrier = evaluateCrawlerGenerationBarrier({
    cycleId: sentinel.generationToken,
    runRegistry: sentinelRunRegistry(sentinel),
    runObservations: observations,
    manifests,
    roster,
    sourceCommit: source.sourceCommit,
    evaluatedAt: evidenceEvaluatedAt,
    timedOut,
    isAncestor: source.isAncestor,
    sourceFileMatches: source.sourceFileMatches,
  });
  const evidenceDigest = createEvidenceDigest({
    sentinel,
    observations,
    manifests,
    sourceCommit: source.sourceCommit,
    barrier,
  });
  return createObserverReport({
    evaluatedAt,
    ...reportBinding,
    evidenceDigest,
    status: barrier.barrier.status === 'ready'
      ? 'ready'
      : barrier.barrier.status === 'waiting' ? 'waiting' : 'blocked',
    reasons: barrier.barrier.status === 'ready' ? [] : [barrier.barrier.status],
    barrier,
  });
}

function runGit(repository, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: repository,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function commitIsPresent(repository, commit) {
  try {
    runGit(repository, ['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function fetchCommit(repository, commit) {
  if (commitIsPresent(repository, commit)) return;
  runGit(repository, ['fetch', '--no-tags', '--filter=blob:none', '--depth=2000', 'origin', commit]);
  if (!commitIsPresent(repository, commit)) throw new ObserverInfrastructureError('source_fetch_failed', 'Fetched commit is unavailable');
}

function commitIsAncestor(repository, ancestor, descendant) {
  try {
    runGit(repository, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

export function loadCrawlerGenerationSourceTree(repository, commit) {
  const listing = runGit(repository, ['ls-tree', '-r', '-z', commit, '--', 'data/jobs/by-crawler'], null);
  const blobs = new Map();
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const [mode, type, blobOid] = record.slice(0, separator).split(' ');
    const filePath = record.slice(separator + 1);
    if (separator < 0 || mode !== '100644' || type !== 'blob'
        || !COMMIT_RE.test(blobOid ?? '') || blobs.has(filePath)) {
      throw new ObserverInfrastructureError('source_tree_invalid', 'Immutable source tree is invalid');
    }
    blobs.set(filePath, blobOid);
  }
  return blobs;
}

async function prepareGitSource(repository, manifests, sentinel) {
  const commits = [...new Set(GROUP_IDS.map((group) => manifests[group]?.remote?.commit)
    .filter((commit) => COMMIT_RE.test(commit ?? '')))];
  try {
    for (const commit of commits) fetchCommit(repository, commit);
    const derived = deriveCrawlerGenerationSourceCommit({
      manifests,
      siteCodeCommit: sentinel.siteCodeCommit,
      isAncestor: (ancestor, descendant) => commitIsAncestor(repository, ancestor, descendant),
    });
    if (derived.status !== 'ready') return derived;
    const blobs = loadCrawlerGenerationSourceTree(repository, derived.sourceCommit);
    return {
      ...derived,
      isAncestor: (ancestor, descendant) => descendant === derived.sourceCommit
        && commitIsAncestor(repository, ancestor, descendant),
      sourceFileMatches: (commit, slice) => {
        if (commit !== derived.sourceCommit) return false;
        const blobOid = blobs.get(slice.path) ?? null;
        return slice.state === 'absent' ? blobOid === null && slice.blobOid === null : blobOid === slice.blobOid;
      },
    };
  } catch (error) {
    return {
      status: 'infrastructure_error',
      sourceCommit: null,
      reason: error instanceof ObserverInfrastructureError ? error.code : 'source_fetch_failed',
    };
  }
}

function parseArguments(argv) {
  const mode = argv[0];
  if (!['prepare-sentinel', 'observe', 'observe-event'].includes(mode)) throw new TypeError('Invalid observer mode');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/.test(flag ?? '') || typeof value !== 'string' || value.length === 0 || flag in values) {
      throw new TypeError('Invalid observer arguments');
    }
    values[flag] = value;
  }
  const required = mode === 'prepare-sentinel'
    ? ['--input', '--expected-generation-token', '--expected-site-code-commit', '--runner-temp', '--output']
    : mode === 'observe-event'
      ? ['--generation-token', '--sentinel-run-id', '--roster', '--repository', '--runner-temp', '--output']
      : ['--sentinel', '--roster', '--repository', '--runner-temp', '--output'];
  const optional = mode === 'observe-event' ? ['--timed-out'] : [];
  if (Object.keys(values).some((flag) => !required.includes(flag) && !optional.includes(flag))) {
    throw new TypeError('Unsupported observer argument');
  }
  for (const flag of required) if (!(flag in values)) throw new TypeError(`Missing ${flag}`);
  if (values['--timed-out'] !== undefined && !['true', 'false'].includes(values['--timed-out'])) {
    throw new TypeError('Invalid --timed-out value');
  }
  return { mode, values };
}

function readJsonFile(filePath, maxBytes) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    throw new TypeError('Observer JSON input exceeds byte limit');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeOutput(repository, runnerTemp, output, relativeRoot = 'crawler-generation-observer') {
  return assertSafeRunnerReportOutput(repository, runnerTemp, path.resolve(output), relativeRoot);
}

function validateSentinelArtifactMetadata(artifact, generationToken) {
  if (artifact?.name !== `crawler-generation-sentinel-${generationToken}`
      || artifact?.expired !== false
      || !Number.isSafeInteger(artifact?.id) || artifact.id < 1
      || !Number.isSafeInteger(artifact?.workflow_run?.id) || artifact.workflow_run.id < 1
      || !Number.isSafeInteger(artifact?.size_in_bytes) || artifact.size_in_bytes < 1
      || artifact.size_in_bytes > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new ObserverDataError('sentinel_artifact_invalid', 'Sentinel artifact metadata is invalid');
  }
}

export function selectSentinelReplayArtifacts(artifacts, generationToken, currentRunId) {
  const normalizedCurrentRunId = String(currentRunId ?? '');
  if (!RUN_ID_RE.test(normalizedCurrentRunId) || !Array.isArray(artifacts)) {
    throw new ObserverDataError('sentinel_replay_invalid', 'Sentinel replay set is invalid');
  }
  const seenRunIds = new Set();
  const replayArtifacts = [];
  for (const artifact of artifacts) {
    validateSentinelArtifactMetadata(artifact, generationToken);
    const artifactRunId = String(artifact.workflow_run.id);
    if (seenRunIds.has(artifactRunId)) {
      throw new ObserverDataError('sentinel_replay_ambiguous', 'A sentinel run has multiple artifacts');
    }
    seenRunIds.add(artifactRunId);
    if (artifactRunId !== normalizedCurrentRunId) replayArtifacts.push(artifact);
  }
  if (replayArtifacts.length + 1 > MAX_REPLAY_SENTINELS) {
    throw new ObserverDataError('sentinel_replay_overflow', 'Sentinel replay set exceeds its run bound');
  }
  return { artifacts: replayArtifacts, replayCount: replayArtifacts.length + 1 };
}

export function validateBoundSentinelRun(run, generationToken, runId, corpusCodeCommit = null) {
  const binding = crawlerGenerationSentinelWorkflowIdentity(
    generationToken,
    String(runId),
    corpusCodeCommit,
  );
  if (!validateCrawlerGenerationWorkflowRun(run, binding, CALLER_REPOSITORY).valid) {
    throw new ObserverDataError('sentinel_run_invalid', 'Sentinel workflow run binding is invalid');
  }
}

async function downloadJsonArtifact(client, artifact, expectedName, maxBytes, repository, runnerTemp) {
  const archivePath = safeOutput(
    repository,
    runnerTemp,
    path.join(runnerTemp, 'crawler-generation-observer', 'downloads', `${artifact.id}.zip`),
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, await client.bytes(
    `/repos/${CALLER_REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    MAX_ARTIFACT_ARCHIVE_BYTES,
  ));
  try {
    return readBoundedArtifactJson(archivePath, expectedName, maxBytes);
  } finally {
    try { fs.unlinkSync(archivePath); } catch { /* runner temp cleanup is best-effort */ }
  }
}

async function discoverSentinelReplays({ client, sentinel, currentRunId, repository, runnerTemp }) {
  const name = `crawler-generation-sentinel-${sentinel.generationToken}`;
  const response = await client.json(
    `/repos/${CALLER_REPOSITORY}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
  );
  if (!Number.isInteger(response.total_count) || !Array.isArray(response.artifacts)
      || response.total_count !== response.artifacts.length
      || response.total_count > 100) {
    throw new ObserverDataError('sentinel_replay_overflow', 'Sentinel replay set is ambiguous or exceeds its bound');
  }
  const selected = selectSentinelReplayArtifacts(
    response.artifacts, sentinel.generationToken, currentRunId,
  );
  const values = [sentinel];
  let aggregateBytes = Buffer.byteLength(canonicalJson(sentinel));
  for (const artifact of selected.artifacts) {
    const run = await client.json(`/repos/${CALLER_REPOSITORY}/actions/runs/${artifact.workflow_run.id}`);
    aggregateBytes += artifact.size_in_bytes;
    if (aggregateBytes > MAX_CYCLE_MANIFEST_BYTES) {
      throw new ObserverDataError('sentinel_replay_overflow', 'Sentinel replay bytes exceed cycle byte limit');
    }
    const replay = await downloadJsonArtifact(
      client, artifact, 'crawler-generation-sentinel.json', MAX_SENTINEL_BYTES, repository, runnerTemp,
    );
    if (!validateCrawlerGenerationSentinel(replay).valid
        || replay.generationToken !== sentinel.generationToken) {
      throw new ObserverDataError('sentinel_invalid', 'Replay sentinel is invalid');
    }
    validateBoundSentinelRun(
      run,
      replay.generationToken,
      artifact.workflow_run.id,
      replay.corpusCodeCommit,
    );
    values.push(replay);
  }
  return values;
}

async function loadEventSentinel({ client, generationToken, sentinelRunId, repository, runnerTemp }) {
  const name = `crawler-generation-sentinel-${generationToken}`;
  const response = await client.json(
    `/repos/${CALLER_REPOSITORY}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
  );
  if (!Number.isInteger(response.total_count) || !Array.isArray(response.artifacts)
      || response.total_count !== response.artifacts.length || response.total_count > 100) {
    throw new ObserverDataError('sentinel_replay_overflow', 'Sentinel artifact set is invalid');
  }
  const exact = response.artifacts.filter(
    (artifact) => String(artifact?.workflow_run?.id ?? '') === sentinelRunId,
  );
  if (exact.length !== 1) throw new ObserverDataError('sentinel_artifact_invalid', 'Sentinel owner artifact is not unique');
  validateSentinelArtifactMetadata(exact[0], generationToken);
  const run = await client.json(`/repos/${CALLER_REPOSITORY}/actions/runs/${sentinelRunId}`);
  validateBoundSentinelRun(run, generationToken, sentinelRunId, run?.head_sha);
  const sentinel = await downloadJsonArtifact(
    client, exact[0], 'crawler-generation-sentinel.json', MAX_SENTINEL_BYTES, repository, runnerTemp,
  );
  if (!validateCrawlerGenerationSentinel(sentinel).valid || sentinel.generationToken !== generationToken) {
    throw new ObserverDataError('sentinel_invalid', 'Event sentinel is invalid');
  }
  validateBoundSentinelRun(run, generationToken, sentinelRunId, sentinel.corpusCodeCommit);
  return sentinel;
}

export async function getBoundGroupRun(client, runId) {
  try {
    return await client.json(`/repos/${CALLER_REPOSITORY}/actions/runs/${runId}`);
  } catch (error) {
    if (isMissingExactGitHubResource(error)) {
      throw new ObserverDataError('run_binding_invalid', 'Bound crawler run is permanently unavailable');
    }
    throw error;
  }
}

export async function runCrawlerGenerationObserverCli(argv = process.argv.slice(2), env = process.env) {
  const { mode, values } = parseArguments(argv);
  const repository = path.resolve(mode === 'prepare-sentinel' ? process.cwd() : values['--repository']);
  const runnerTemp = fs.realpathSync(values['--runner-temp']);
  const output = safeOutput(repository, runnerTemp, values['--output']);
  if (mode === 'prepare-sentinel') {
    const sentinel = readJsonFile(path.resolve(values['--input']), MAX_SENTINEL_BYTES);
    if (!validateCrawlerGenerationSentinel(sentinel).valid
        || sentinel.generationToken !== values['--expected-generation-token']
        || sentinel.siteCodeCommit !== values['--expected-site-code-commit']) {
      throw new TypeError('Sentinel input does not match the manual dispatch binding');
    }
    writeJsonAtomic(output, sentinel, { compact: true });
    return sentinel;
  }

  const token = env.GH_TOKEN;
  const apiUrl = env.GITHUB_API_URL;
  if (typeof token !== 'string' || token.length === 0 || typeof apiUrl !== 'string' || !/^https?:\/\//.test(apiUrl)) {
    throw new TypeError('Missing GitHub observer API environment');
  }
  const client = createGitHubActionsReadClient({
    apiUrl: apiUrl.replace(/\/$/, ''),
    token,
    apiVersion: CRAWLER_GENERATION_GITHUB_API_VERSION,
  });
  const currentRunId = mode === 'observe-event'
    ? String(values['--sentinel-run-id'] ?? '')
    : String(env.GITHUB_RUN_ID ?? '');
  if (!RUN_ID_RE.test(currentRunId)) throw new TypeError('Missing current GitHub observer run ID');
  let currentSentinel;
  try {
    currentSentinel = mode === 'observe-event'
      ? await loadEventSentinel({
        client,
        generationToken: values['--generation-token'],
        sentinelRunId: currentRunId,
        repository,
        runnerTemp,
      })
      : readJsonFile(path.resolve(values['--sentinel']), MAX_SENTINEL_BYTES);
    if (!validateCrawlerGenerationSentinel(currentSentinel).valid) {
      throw new ObserverDataError('sentinel_invalid', 'Current sentinel is invalid');
    }
    if (runGit(repository, ['rev-parse', 'HEAD']).trim() !== currentSentinel.siteCodeCommit) {
      throw new ObserverInfrastructureError(
        'observer_checkout_mismatch',
        'Observer checkout is not pinned to sentinel siteCodeCommit',
      );
    }
  } catch (error) {
    if (mode !== 'observe-event') throw error;
    const failure = classifyObserverFailure(error);
    const report = createObserverReport({
      evaluatedAt: env.CRAWLER_GENERATION_EVALUATED_AT || new Date().toISOString(),
      generationToken: values['--generation-token'],
      ...createSentinelSetBinding([]),
      status: failure.status,
      reasons: [failure.reason],
      barrier: null,
    });
    writeJsonAtomic(output, report, { compact: true });
    process.stdout.write(`${JSON.stringify({ status: report.observer.status, reasons: report.observer.reasons })}\n`);
    return report;
  }
  let report;
  let observedSentinels = [currentSentinel];
  try {
    observedSentinels = await discoverSentinelReplays({
      client, sentinel: currentSentinel, currentRunId, repository, runnerTemp,
    });
    const roster = readJsonFile(path.resolve(values['--roster']), MAX_CYCLE_MANIFEST_BYTES);
    report = await observeCrawlerGeneration({
      sentinels: observedSentinels,
      roster,
      evaluatedAt: env.CRAWLER_GENERATION_EVALUATED_AT || new Date().toISOString(),
      timedOut: values['--timed-out'] === 'true',
      getRun: (runId) => getBoundGroupRun(client, runId),
      listRunArtifacts: async (runId) => {
        const response = await client.json(`/repos/${CALLER_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`);
        if (!Number.isInteger(response.total_count) || !Array.isArray(response.artifacts)
            || response.total_count !== response.artifacts.length || response.total_count > 100) {
          throw new ObserverDataError('artifact_list_invalid', 'Run artifact list is invalid or truncated');
        }
        return response.artifacts;
      },
      readArtifact: (artifact, expectedName, maxBytes) => downloadJsonArtifact(
        client, artifact, expectedName, maxBytes, repository, runnerTemp,
      ),
      prepareSource: (manifests, sentinel) => prepareGitSource(repository, manifests, sentinel),
    });
  } catch (error) {
    const failure = classifyObserverFailure(error);
    report = createObserverReport({
      evaluatedAt: env.CRAWLER_GENERATION_EVALUATED_AT || new Date().toISOString(),
      ...sentinelReportBinding(
        currentSentinel,
        observedSentinels.length,
        createSentinelSetBinding(observedSentinels),
      ),
      status: failure.status,
      reasons: [failure.reason],
      barrier: null,
    });
  }
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_CYCLE_MANIFEST_BYTES) {
    throw new TypeError('Observer report exceeds cycle byte limit');
  }
  writeJsonAtomic(output, report, { compact: true });
  process.stdout.write(`${JSON.stringify({ status: report.observer.status, reasons: report.observer.reasons })}\n`);
  return report;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  runCrawlerGenerationObserverCli().then((report) => {
    if (report?.observer?.status === 'infrastructure_error') process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
