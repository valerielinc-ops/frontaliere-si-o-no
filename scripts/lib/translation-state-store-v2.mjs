import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createEmptyTranslationMemoryV2,
  serializeTranslationMemoryV2,
} from './content-addressed-translation-memory-v2.mjs';
import {
  createTranslationJournalEventV2,
  getTranslationJournalStateV2,
  replayTranslationJournalV2,
} from './translation-journal-v2.mjs';
import {
  serializeTranslationDerivedPatchV2,
  validateTranslationDerivedPatchV2,
} from './translation-derived-patch-v2.mjs';
import {
  assertTranslationExactKeysV2,
  assertTranslationPlainObjectV2,
  canonicalTranslationJsonV2,
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
} from './translation-unit-identity-v2.mjs';

const execFile = promisify(execFileCallback);

export const DEFAULT_TRANSLATION_STATE_REF_V2 = 'refs/heads/translation-state-v2';
export const MAX_TRANSLATION_STATE_BATCH_V2 = 250;
export const MAX_TRANSLATION_STATE_CAS_ATTEMPTS_V2 = 8;
export const MAX_TRANSLATION_STATE_ARTIFACT_BYTES_V2 = 1024 * 1024;
export const MAX_TRANSLATION_STATE_EVENTS_PER_ATTEMPT_V2 = 64;
export const MAX_TRANSLATION_STATE_INTENTS_PER_PATCH_V2 = 1024;
export const TRANSLATION_STATE_GIT_TIMEOUT_MS_V2 = 30_000;
export const TRANSLATION_STATE_QUEUE_CONFLICT_CODE_V2 = 'TRANSLATION_STATE_QUEUE_CONFLICT_V2';

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SLICE_PATH_PATTERN = /^data\/jobs\/by-crawler\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const OUTCOMES = new Set([
  'applied',
  'already_valid',
  'stale_source',
  'stale_target',
  'target_absent',
  'ambiguous_target',
  'rejected_candidate',
  'malformed_target',
]);
const INTENT_KEYS = [
  'crawlerKey',
  'expectedMain',
  'expectedSliceBlob',
  'intentHash',
  'outcomes',
  'patchHashes',
  'proposedCommit',
  'schemaVersion',
  'slicePath',
];
const INTENT_POINTER_KEYS = ['intentHash', 'patchHash', 'schemaVersion'];
const ACK_KEYS = [
  'ackHash',
  'attemptKey',
  'candidateId',
  'crawlerKey',
  'intentHash',
  'lifecycleEventId',
  'lifecycleSequence',
  'mainCommit',
  'outcome',
  'patchHash',
  'publishedCommit',
  'schemaVersion',
  'slicePath',
];

function queueConflict(message) {
  return Object.assign(new TypeError(message), {
    code: TRANSLATION_STATE_QUEUE_CONFLICT_CODE_V2,
  });
}

function assertBatch(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TRANSLATION_STATE_BATCH_V2) {
    throw new TypeError(`${label} must contain between 1 and ${MAX_TRANSLATION_STATE_BATCH_V2} items`);
  }
}

export function validateTranslationSlicePathV2(value) {
  if (typeof value !== 'string' || !SLICE_PATH_PATTERN.test(value)) {
    throw new TypeError('translation slicePath must match data/jobs/by-crawler/<safe filename>.json');
  }
  return value;
}

function validateStateRef(value) {
  if (
    typeof value !== 'string'
    || !REF_PATTERN.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.split('/').some((part) => part.endsWith('.lock'))
    || value === 'refs/heads/main'
  ) {
    throw new TypeError('translation state ref must be a dedicated refs/heads/* ref other than main');
  }
  return value;
}

function validateSha(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a Git object id`);
  }
  return value;
}

function digestKey(value) {
  const parts = value.split(':');
  return parts.at(-1);
}

function crawlerDigest(crawlerKey) {
  return digestTranslationDocumentV2({ crawlerKey });
}

function patchPath(patch) {
  return `v2/patches/${patch.patchHash.slice(0, 2)}/${patch.patchHash}.json`;
}

function memoryPath(patch) {
  const digest = digestKey(patch.candidate.candidateId);
  return `v2/memory/${patch.identity.identityHash.slice(0, 2)}/${patch.identity.identityHash}/${digest}.json`;
}

function queuePath(patch) {
  const crawlerHash = crawlerDigest(patch.target.crawlerKey);
  return `v2/queue/${crawlerHash.slice(0, 2)}/${crawlerHash}/${patch.patchHash.slice(0, 2)}/${patch.patchHash}.json`;
}

function ackPrefix(patchHash) {
  return `v2/acks/${patchHash.slice(0, 2)}/${patchHash}`;
}

function ackPath(patchHash, ackHash) {
  return `${ackPrefix(patchHash)}/${ackHash}.json`;
}

function journalPrefix(attemptKey) {
  const digest = digestKey(attemptKey);
  return `v2/journal/${digest.slice(0, 2)}/${digest}`;
}

function journalEventPath(event) {
  const eventDigest = digestKey(event.eventId);
  return `${journalPrefix(event.attemptKey)}/${String(event.sequence).padStart(4, '0')}-${eventDigest}.json`;
}

function intentObjectPath(intentHash) {
  return `v2/intents/by-hash/${intentHash.slice(0, 2)}/${intentHash}.json`;
}

function intentIndexPrefix(patchHash) {
  return `v2/intents/by-patch/${patchHash.slice(0, 2)}/${patchHash}`;
}

function intentIndexPath(patchHash, intentHash) {
  return `${intentIndexPrefix(patchHash)}/${intentHash}.json`;
}

function boundedArtifact(text) {
  if (Buffer.byteLength(text) > MAX_TRANSLATION_STATE_ARTIFACT_BYTES_V2) {
    throw new TypeError('translation state artifact exceeds the bounded size');
  }
  return text;
}

function canonicalArtifact(value) {
  return boundedArtifact(`${canonicalTranslationJsonV2(value)}\n`);
}

function candidateMemory(patch) {
  return boundedArtifact(serializeTranslationMemoryV2({
    schemaVersion: createEmptyTranslationMemoryV2().schemaVersion,
    records: [{ identity: patch.identity, candidates: [patch.candidate] }],
  }));
}

function queueRecord(patch, slicePath) {
  return deepFreezeTranslationV2({
    schemaVersion: 2,
    crawlerKey: patch.target.crawlerKey,
    slicePath,
    patchHash: patch.patchHash,
    attemptKey: patch.candidate.attemptKey,
    candidateId: patch.candidate.candidateId,
  });
}

function validateQueueRecord(value) {
  const expected = ['attemptKey', 'candidateId', 'crawlerKey', 'patchHash', 'schemaVersion', 'slicePath'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid queue record');
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('invalid queue record schema');
  }
  if (value.schemaVersion !== 2 || typeof value.crawlerKey !== 'string') throw new TypeError('invalid queue record');
  validateTranslationSlicePathV2(value.slicePath);
  if (!/^[a-f0-9]{64}$/.test(value.patchHash)) throw new TypeError('invalid queue patchHash');
  if (!/^translation-attempt:v2:[a-f0-9]{64}$/.test(value.attemptKey)) throw new TypeError('invalid queue attemptKey');
  if (!/^translation-candidate:v2:[a-f0-9]{64}$/.test(value.candidateId)) throw new TypeError('invalid queue candidateId');
  return deepFreezeTranslationV2({ ...value });
}

function assertQueueMatches(queue, patch, slicePath) {
  const validated = validateQueueRecord(queue);
  if (
    validated.crawlerKey !== patch.target.crawlerKey
    || validated.slicePath !== slicePath
    || validated.patchHash !== patch.patchHash
    || validated.attemptKey !== patch.candidate.attemptKey
    || validated.candidateId !== patch.candidate.candidateId
  ) {
    throw new TypeError('translation queue record does not match its patch and slice');
  }
  return validated;
}

function validateIntent(value, expectedPatchHash = null) {
  assertTranslationPlainObjectV2(value, 'translation publish intent');
  assertTranslationExactKeysV2(value, INTENT_KEYS, 'translation publish intent');
  if (value.schemaVersion !== 2 || typeof value.crawlerKey !== 'string' || value.crawlerKey.length === 0) {
    throw new TypeError('translation publish intent is invalid');
  }
  validateTranslationSlicePathV2(value.slicePath);
  assertBatch(value.patchHashes, 'translation publish intent patch hashes');
  if (
    value.patchHashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
    || new Set(value.patchHashes).size !== value.patchHashes.length
  ) {
    throw new TypeError('translation publish intent patch hashes are invalid');
  }
  if (expectedPatchHash !== null && !value.patchHashes.includes(expectedPatchHash)) {
    throw new TypeError('translation publish intent is stored under the wrong patch');
  }
  if (
    !Array.isArray(value.outcomes)
    || value.outcomes.length !== value.patchHashes.length
    || value.outcomes.some((outcome) => !OUTCOMES.has(outcome))
  ) {
    throw new TypeError('translation publish intent outcomes are invalid');
  }
  validateSha(value.expectedMain, 'translation intent expectedMain');
  validateSha(value.proposedCommit, 'translation intent proposedCommit');
  validateSha(value.expectedSliceBlob, 'translation intent expectedSliceBlob');
  if (typeof value.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.intentHash)) {
    throw new TypeError('translation publish intent hash is invalid');
  }
  const { intentHash, ...payload } = value;
  if (intentHash !== digestTranslationDocumentV2(payload)) {
    throw new TypeError('translation publish intent hash does not match');
  }
  return deepFreezeTranslationV2({ ...value, outcomes: [...value.outcomes], patchHashes: [...value.patchHashes] });
}

function validateIntentPointer(value, expectedPatchHash) {
  assertTranslationPlainObjectV2(value, 'translation publish intent pointer');
  assertTranslationExactKeysV2(value, INTENT_POINTER_KEYS, 'translation publish intent pointer');
  if (
    value.schemaVersion !== 2
    || value.patchHash !== expectedPatchHash
    || typeof value.intentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.intentHash)
  ) {
    throw new TypeError('translation publish intent pointer is invalid');
  }
  return deepFreezeTranslationV2({ ...value });
}

function validateAcknowledgment(value, expectedPatchHash = null) {
  assertTranslationPlainObjectV2(value, 'translation acknowledgment');
  assertTranslationExactKeysV2(value, ACK_KEYS, 'translation acknowledgment');
  if (value.schemaVersion !== 2 || typeof value.crawlerKey !== 'string' || value.crawlerKey.length === 0) {
    throw new TypeError('translation acknowledgment is invalid');
  }
  validateTranslationSlicePathV2(value.slicePath);
  if (typeof value.patchHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.patchHash)) {
    throw new TypeError('translation acknowledgment patchHash is invalid');
  }
  if (expectedPatchHash !== null && value.patchHash !== expectedPatchHash) {
    throw new TypeError('translation acknowledgment is stored under the wrong patch');
  }
  if (!/^translation-attempt:v2:[a-f0-9]{64}$/.test(value.attemptKey)) {
    throw new TypeError('translation acknowledgment attemptKey is invalid');
  }
  if (!/^translation-candidate:v2:[a-f0-9]{64}$/.test(value.candidateId)) {
    throw new TypeError('translation acknowledgment candidateId is invalid');
  }
  if (!OUTCOMES.has(value.outcome)) throw new TypeError('translation acknowledgment outcome is invalid');
  validateSha(value.mainCommit, 'translation acknowledgment mainCommit');
  validateSha(value.publishedCommit, 'translation acknowledgment publishedCommit', { nullable: true });
  if (value.intentHash !== null && (typeof value.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.intentHash))) {
    throw new TypeError('translation acknowledgment intentHash is invalid');
  }
  if ((value.publishedCommit === null) !== (value.intentHash === null)) {
    throw new TypeError('translation acknowledgment publish commit and intent must both be present or absent');
  }
  if (value.outcome === 'applied' && value.publishedCommit === null) {
    throw new TypeError('applied translation acknowledgment requires publish provenance');
  }
  if (
    !Number.isSafeInteger(value.lifecycleSequence)
    || value.lifecycleSequence < 1
    || value.lifecycleSequence > MAX_TRANSLATION_STATE_EVENTS_PER_ATTEMPT_V2
    || !/^translation-event:v2:[a-f0-9]{64}$/.test(value.lifecycleEventId)
  ) {
    throw new TypeError('translation acknowledgment lifecycle proof is invalid');
  }
  if (typeof value.ackHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.ackHash)) {
    throw new TypeError('translation acknowledgment hash is invalid');
  }
  const { ackHash, ...payload } = value;
  if (ackHash !== digestTranslationDocumentV2(payload)) {
    throw new TypeError('translation acknowledgment hash does not match');
  }
  return deepFreezeTranslationV2({ ...value });
}

function createGitRunner(repository) {
  return async (args, options = {}) => {
    try {
      const result = await execFile('git', args, {
        cwd: repository,
        encoding: 'utf8',
        env: options.env ? { ...process.env, ...options.env } : process.env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: TRANSLATION_STATE_GIT_TIMEOUT_MS_V2,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (typeof error?.code === 'number') {
        return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      }
      throw error;
    }
  };
}

async function checked(git, args, options) {
  const result = await git(args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

async function remoteTip(git, remote, ref) {
  const result = await git(['ls-remote', '--refs', remote, ref]);
  if (result.code !== 0) throw new Error(`git ls-remote failed: ${result.stderr.trim()}`);
  const line = result.stdout.trim();
  return line ? line.split(/\s+/u)[0] : null;
}

async function ensureCommit(git, remote, ref, tip) {
  if (tip === null) return;
  const present = await git(['cat-file', '-e', `${tip}^{commit}`]);
  if (present.code === 0) return;
  await checked(git, ['fetch', '--no-tags', remote, ref]);
  await checked(git, ['cat-file', '-e', `${tip}^{commit}`]);
}

async function readPath(git, tip, path) {
  if (tip === null) return null;
  const result = await git(['show', `${tip}:${path}`]);
  if (result.code !== 0) return null;
  if (Buffer.byteLength(result.stdout) > MAX_TRANSLATION_STATE_ARTIFACT_BYTES_V2) {
    throw new TypeError(`translation state artifact ${path} exceeds the bounded size`);
  }
  return result.stdout;
}

async function listPaths(git, tip, prefix, limit = Number.POSITIVE_INFINITY) {
  if (tip === null) return [];
  const result = await git(['ls-tree', '-r', '--name-only', tip, '--', prefix]);
  if (result.code !== 0) throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean).sort().slice(0, limit);
}

async function parsePath(git, tip, path) {
  const raw = await readPath(git, tip, path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError(`translation state artifact ${path} is not JSON`);
  }
}

async function readAttemptJournal(git, tip, attemptKey) {
  const paths = await listPaths(git, tip, journalPrefix(attemptKey));
  if (paths.length > MAX_TRANSLATION_STATE_EVENTS_PER_ATTEMPT_V2) {
    throw new TypeError('translation state journal exceeds the bounded event count');
  }
  const events = [];
  for (const path of paths) events.push(await parsePath(git, tip, path));
  return replayTranslationJournalV2(events);
}

function assertAcknowledgmentLifecycleProof(journal, receipt) {
  const event = journal.events.find((item) => item.sequence === receipt.lifecycleSequence);
  if (
    event?.eventId !== receipt.lifecycleEventId
    || event?.candidateId !== receipt.candidateId
    || event?.fromState !== 'queued'
    || event?.toState !== receipt.outcome
  ) {
    throw new TypeError('translation acknowledgment lifecycle proof does not match its journal event');
  }
  return receipt;
}

function nextEvent(journal, patch, toState) {
  const current = getTranslationJournalStateV2(journal, patch.candidate.attemptKey);
  const sequence = journal.events.filter((event) => event.attemptKey === patch.candidate.attemptKey).length + 1;
  if (sequence > MAX_TRANSLATION_STATE_EVENTS_PER_ATTEMPT_V2) {
    throw new TypeError('translation state journal exceeds the bounded event count');
  }
  return createTranslationJournalEventV2({
    attemptKey: patch.candidate.attemptKey,
    candidateId: toState === 'missing' ? null : patch.candidate.candidateId,
    fromState: current.state,
    sequence,
    toState,
  });
}

async function writeCommit(git, tip, changes, message, { deterministicRoot = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'translation-state-v2-'));
  const indexPath = join(directory, 'index');
  await writeFile(indexPath, '');
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    if (tip === null) await checked(git, ['read-tree', '--empty'], { env });
    else await checked(git, ['read-tree', tip], { env });

    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (change.content === null) {
        await checked(git, ['update-index', '--force-remove', '--', change.path], { env });
        continue;
      }
      const artifactPath = join(directory, `artifact-${index}`);
      await writeFile(artifactPath, change.content);
      const blob = await checked(git, ['hash-object', '-w', '--', artifactPath]);
      await checked(git, ['update-index', '--add', '--cacheinfo', `100644,${blob},${change.path}`], { env });
    }
    const tree = await checked(git, ['write-tree'], { env });
    const args = ['commit-tree', tree, '-m', message];
    if (tip !== null) args.splice(2, 0, '-p', tip);
    const commitEnv = deterministicRoot ? {
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_AUTHOR_EMAIL: 'translation-state-v2@example.invalid',
      GIT_AUTHOR_NAME: 'Translation State V2',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_EMAIL: 'translation-state-v2@example.invalid',
      GIT_COMMITTER_NAME: 'Translation State V2',
    } : undefined;
    return await checked(git, args, commitEnv ? { env: commitEnv } : undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function putImmutable(git, tip, changes, path, content) {
  const pending = changes.find((change) => change.path === path);
  if (pending) {
    if (pending.content !== content) throw new TypeError(`translation state conflict at ${path}`);
    return false;
  }
  const existing = await readPath(git, tip, path);
  if (existing !== null) {
    if (existing !== content) throw new TypeError(`translation state conflict at ${path}`);
    return false;
  }
  changes.push({ path, content });
  return true;
}

function validateStateSchema(value) {
  assertTranslationPlainObjectV2(value, 'translation state schema');
  assertTranslationExactKeysV2(value, ['layout', 'schemaVersion'], 'translation state schema');
  if (value.schemaVersion !== 2 || value.layout !== 'translation-state-v2') {
    throw new TypeError('translation state ref has an unsupported schema or layout');
  }
}

async function assertStateOnlyLineage(git, tip, expectedRoot) {
  const topLevel = (await checked(git, ['ls-tree', '--name-only', tip])).split('\n').filter(Boolean);
  if (topLevel.length !== 1 || topLevel[0] !== 'v2') {
    throw new TypeError('translation state ref contains paths outside v2/');
  }
  validateStateSchema(await parsePath(git, tip, 'v2/schema.json'));
  const ancestry = await git(['merge-base', '--is-ancestor', expectedRoot, tip]);
  if (ancestry.code !== 0) {
    throw new TypeError('translation state ref does not descend from the state-only root');
  }
  const lineage = (await checked(git, ['rev-list', '--parents', `${expectedRoot}..${tip}`]))
    .split('\n')
    .filter(Boolean);
  if (lineage.some((line) => line.split(/\s+/u).length !== 2)) {
    throw new TypeError('translation state ref must use single-parent CAS commits');
  }
  const changedPaths = (await checked(git, [
    'log',
    '--format=',
    '--name-only',
    '-z',
    '--no-renames',
    `${expectedRoot}..${tip}`,
  ])).split('\0').filter(Boolean);
  if (changedPaths.some((path) => !path.startsWith('v2/'))) {
    throw new TypeError('translation state ref history contains paths outside v2/');
  }
}

export function createTranslationStateStoreV2(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('translation state store options must be an object');
  }
  const repository = options.repository;
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new TypeError('translation state store repository is required');
  }
  const remote = options.remote ?? 'origin';
  if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) {
    throw new TypeError('translation state store remote is invalid');
  }
  const ref = validateStateRef(options.ref ?? DEFAULT_TRANSLATION_STATE_REF_V2);
  const maxCasAttempts = options.maxCasAttempts ?? MAX_TRANSLATION_STATE_CAS_ATTEMPTS_V2;
  if (!Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1 || maxCasAttempts > 32) {
    throw new TypeError('translation state CAS attempts must be between 1 and 32');
  }
  const git = options.git ?? createGitRunner(repository);
  const onStage = options.onStage ?? (async () => {});
  if (typeof onStage !== 'function') throw new TypeError('translation state onStage must be a function');
  const validatedStateTips = new Set();
  let expectedStateRoot = null;

  async function getExpectedStateRoot() {
    if (expectedStateRoot === null) {
      expectedStateRoot = await writeCommit(
        git,
        null,
        [{
          path: 'v2/schema.json',
          content: canonicalArtifact({ schemaVersion: 2, layout: 'translation-state-v2' }),
        }],
        'translation-state-v2: initialize',
        { deterministicRoot: true },
      );
    }
    return expectedStateRoot;
  }

  async function transact(message, buildChanges) {
    for (let attempt = 1; attempt <= maxCasAttempts; attempt += 1) {
      const tip = await remoteTip(git, remote, ref);
      await ensureCommit(git, remote, ref, tip);
      if (tip !== null && !validatedStateTips.has(tip)) {
        await assertStateOnlyLineage(git, tip, await getExpectedStateRoot());
        validatedStateTips.add(tip);
      }
      const changes = await buildChanges(tip);
      if (changes.length === 0) return { commit: tip, retries: attempt - 1, changed: false };
      const commit = await writeCommit(git, tip, changes, message, { deterministicRoot: tip === null });
      await onStage('beforeStatePush', { attempt, commit, message, tip });
      const pushed = await git(['push', remote, `${commit}:${ref}`]);
      if (pushed.code === 0) {
        validatedStateTips.add(commit);
        return { commit, retries: attempt - 1, changed: true };
      }
      const moved = await remoteTip(git, remote, ref);
      if (moved === tip) throw new Error(`translation state push failed: ${pushed.stderr.trim()}`);
    }
    throw new Error('translation state CAS retry budget exhausted');
  }

  async function snapshotTip() {
    const tip = await remoteTip(git, remote, ref);
    await ensureCommit(git, remote, ref, tip);
    if (tip !== null && !validatedStateTips.has(tip)) {
      await assertStateOnlyLineage(git, tip, await getExpectedStateRoot());
      validatedStateTips.add(tip);
    }
    return tip;
  }

  async function initialize() {
    return transact('translation-state-v2: initialize', async (tip) => {
      if (tip !== null) return [];
      return [{
        path: 'v2/schema.json',
        content: canonicalArtifact({ schemaVersion: 2, layout: 'translation-state-v2' }),
      }];
    });
  }

  async function checkpointBatch({ slicePath, patches: rawPatches, requeue = false }) {
    const checkedSlicePath = validateTranslationSlicePathV2(slicePath);
    assertBatch(rawPatches, 'translation state checkpoint batch');
    const patches = rawPatches.map((patch) => validateTranslationDerivedPatchV2(patch));
    if (new Set(patches.map((patch) => patch.patchHash)).size !== patches.length) {
      throw new TypeError('translation state batch contains duplicate patches');
    }
    if (new Set(patches.map((patch) => patch.candidate.attemptKey)).size !== patches.length) {
      throw new TypeError('translation state batch contains duplicate attempts');
    }
    const crawlerKeys = new Set(patches.map((patch) => patch.target.crawlerKey));
    if (crawlerKeys.size !== 1) throw new TypeError('translation state batch must target one crawlerKey');
    if (typeof requeue !== 'boolean') throw new TypeError('translation state requeue must be boolean');
    for (const patch of patches) {
      if (patch.candidate.status !== 'validated') {
        throw new TypeError('translation state drainer accepts only validated candidates');
      }
    }

    const transaction = await transact('translation-state-v2: checkpoint batch', async (tip) => {
      const changes = [];
      for (const patch of patches) {
        const existingAcks = await listPaths(git, tip, ackPrefix(patch.patchHash), 1);
        if (existingAcks.length > 0 && !requeue) continue;
        await putImmutable(
          git,
          tip,
          changes,
          patchPath(patch),
          boundedArtifact(serializeTranslationDerivedPatchV2(patch)),
        );
        await putImmutable(git, tip, changes, memoryPath(patch), candidateMemory(patch));

        let journal = await readAttemptJournal(git, tip, patch.candidate.attemptKey);
        let current = getTranslationJournalStateV2(journal, patch.candidate.attemptKey).state;
        const targets = current === null
          ? ['missing', 'generated', 'validated', 'queued']
          : current === 'queued'
            ? []
            : ['stale_target', 'ambiguous_target', 'malformed_target', 'applied', 'already_valid'].includes(current)
              ? ['queued']
              : current === 'target_absent'
                ? ['missing', 'generated', 'validated', 'queued']
                : [];
        for (const target of targets) {
          const event = nextEvent(journal, patch, target);
          await putImmutable(git, tip, changes, journalEventPath(event), canonicalArtifact(event));
          journal = replayTranslationJournalV2([...journal.events, event]);
          current = target;
        }
        if (current !== 'queued') {
          throw new TypeError(`translation attempt cannot be queued from lifecycle state ${current}`);
        }
        await putImmutable(
          git,
          tip,
          changes,
          queuePath(patch),
          canonicalArtifact(queueRecord(patch, checkedSlicePath)),
        );
      }
      return changes;
    });
    return deepFreezeTranslationV2({ ...transaction, patches });
  }

  async function listPending({ crawlerKey, limit = MAX_TRANSLATION_STATE_BATCH_V2 }) {
    if (typeof crawlerKey !== 'string' || crawlerKey.length === 0) throw new TypeError('crawlerKey is required');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRANSLATION_STATE_BATCH_V2) {
      throw new TypeError('translation pending limit must be between 1 and 250');
    }
    const tip = await snapshotTip();
    const crawlerHash = crawlerDigest(crawlerKey);
    const paths = await listPaths(git, tip, `v2/queue/${crawlerHash.slice(0, 2)}/${crawlerHash}`, limit);
    const pending = [];
    for (const path of paths) {
      const queue = validateQueueRecord(await parsePath(git, tip, path));
      if (queue.crawlerKey !== crawlerKey) throw new TypeError('translation queue crawler hash collision');
      const patch = validateTranslationDerivedPatchV2(await parsePath(git, tip, patchPath(queue)));
      assertQueueMatches(queue, patch, queue.slicePath);
      if (path !== queuePath(patch)) throw new TypeError('translation queue record is stored under the wrong path');
      pending.push(deepFreezeTranslationV2({ patch, queue }));
    }
    return deepFreezeTranslationV2({ commit: tip, pending });
  }

  async function recordIntent(rawIntent) {
    assertBatch(rawIntent?.patches, 'translation publish intent patch batch');
    const patches = rawIntent.patches.map((patch) => validateTranslationDerivedPatchV2(patch));
    const slicePath = validateTranslationSlicePathV2(rawIntent.slicePath);
    const expectedMain = validateSha(rawIntent.expectedMain, 'translation intent expectedMain');
    const proposedCommit = validateSha(rawIntent.proposedCommit, 'translation intent proposedCommit');
    const expectedSliceBlob = validateSha(rawIntent.expectedSliceBlob, 'translation intent expectedSliceBlob');
    const patchHashes = [...new Set(patches.map((patch) => patch.patchHash))];
    if (patchHashes.length !== patches.length) throw new TypeError('translation publish intent has duplicate patches');
    if (
      !Array.isArray(rawIntent.outcomes)
      || rawIntent.outcomes.length !== patches.length
      || rawIntent.outcomes.some((outcome) => !OUTCOMES.has(outcome))
    ) {
      throw new TypeError('translation publish intent outcomes do not match its patch batch');
    }
    const crawlerKeys = new Set(patches.map((patch) => patch.target.crawlerKey));
    if (crawlerKeys.size !== 1) throw new TypeError('translation publish intent must target one crawlerKey');
    const intentPayload = {
      schemaVersion: 2,
      crawlerKey: patches[0].target.crawlerKey,
      slicePath,
      patchHashes,
      outcomes: [...rawIntent.outcomes],
      expectedMain,
      proposedCommit,
      expectedSliceBlob,
    };
    const intent = deepFreezeTranslationV2({
      ...intentPayload,
      intentHash: digestTranslationDocumentV2(intentPayload),
    });
    const transaction = await transact('translation-state-v2: record publish intent', async (tip) => {
      const changes = [];
      for (const patch of patches) {
        const queue = await parsePath(git, tip, queuePath(patch));
        if (queue === null) throw queueConflict('translation publish intent requires queued patches');
        assertQueueMatches(queue, patch, slicePath);
        const existingIntents = await listPaths(git, tip, intentIndexPrefix(patch.patchHash));
        const targetPath = intentIndexPath(patch.patchHash, intent.intentHash);
        if (existingIntents.length >= MAX_TRANSLATION_STATE_INTENTS_PER_PATCH_V2
          && !existingIntents.includes(targetPath)) {
          throw new TypeError('translation state publish intents exceed the bounded count');
        }
        await putImmutable(
          git,
          tip,
          changes,
          targetPath,
          canonicalArtifact({ schemaVersion: 2, patchHash: patch.patchHash, intentHash: intent.intentHash }),
        );
      }
      await putImmutable(git, tip, changes, intentObjectPath(intent.intentHash), canonicalArtifact(intent));
      return changes;
    });
    return deepFreezeTranslationV2({ ...transaction, intent });
  }

  async function listIntents(patchHash) {
    if (typeof patchHash !== 'string' || !/^[a-f0-9]{64}$/.test(patchHash)) {
      throw new TypeError('translation intent patchHash is invalid');
    }
    const tip = await snapshotTip();
    const paths = await listPaths(git, tip, intentIndexPrefix(patchHash));
    if (paths.length > MAX_TRANSLATION_STATE_INTENTS_PER_PATCH_V2) {
      throw new TypeError('translation state publish intents exceed the bounded count');
    }
    const intents = [];
    for (const path of paths) {
      const pointer = validateIntentPointer(await parsePath(git, tip, path), patchHash);
      if (path !== intentIndexPath(patchHash, pointer.intentHash)) {
        throw new TypeError('translation publish intent pointer path does not match its hash');
      }
      const intent = validateIntent(await parsePath(git, tip, intentObjectPath(pointer.intentHash)), patchHash);
      if (intent.intentHash !== pointer.intentHash) throw new TypeError('translation publish intent pointer does not match');
      intents.push(intent);
    }
    return deepFreezeTranslationV2({ commit: tip, intents });
  }

  async function acknowledgeBatch(rawAcks) {
    assertBatch(rawAcks, 'translation acknowledgment batch');
    const acknowledgments = rawAcks.map((ack) => {
      const patch = validateTranslationDerivedPatchV2(ack.patch);
      const slicePath = validateTranslationSlicePathV2(ack.slicePath);
      if (!OUTCOMES.has(ack.outcome)) throw new TypeError('translation acknowledgment outcome is invalid');
      const mainCommit = validateSha(ack.mainCommit, 'translation acknowledgment mainCommit');
      const publishedCommit = validateSha(
        ack.publishedCommit,
        'translation acknowledgment publishedCommit',
        { nullable: true },
      );
      if (ack.intentHash !== null && (typeof ack.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(ack.intentHash))) {
        throw new TypeError('translation acknowledgment intentHash is invalid');
      }
      if ((publishedCommit === null) !== (ack.intentHash === null)) {
        throw new TypeError('translation acknowledgment publish commit and intent must both be present or absent');
      }
      if (ack.outcome === 'applied' && publishedCommit === null) {
        throw new TypeError('applied translation acknowledgment requires a publish intent');
      }
      return { patch, payload: {
        schemaVersion: 2,
        crawlerKey: patch.target.crawlerKey,
        slicePath,
        patchHash: patch.patchHash,
        attemptKey: patch.candidate.attemptKey,
        candidateId: patch.candidate.candidateId,
        outcome: ack.outcome,
        mainCommit,
        publishedCommit,
        intentHash: ack.intentHash,
      } };
    });
    if (new Set(acknowledgments.map(({ patch }) => patch.patchHash)).size !== acknowledgments.length) {
      throw new TypeError('translation acknowledgment batch contains duplicate patches');
    }
    if (new Set(acknowledgments.map(({ patch }) => patch.candidate.attemptKey)).size !== acknowledgments.length) {
      throw new TypeError('translation acknowledgment batch contains duplicate attempts');
    }

    let committedReceipts = [];
    const transaction = await transact('translation-state-v2: acknowledge batch', async (tip) => {
      const changes = [];
      const receipts = [];
      for (const { patch, payload } of acknowledgments) {
        const queued = await parsePath(git, tip, queuePath(patch));
        if (queued === null) {
          const paths = await listPaths(git, tip, ackPrefix(patch.patchHash));
          const journal = await readAttemptJournal(git, tip, patch.candidate.attemptKey);
          const existing = [];
          for (const path of paths) {
            const receipt = validateAcknowledgment(await parsePath(git, tip, path), patch.patchHash);
            assertAcknowledgmentLifecycleProof(journal, receipt);
            existing.push(receipt);
          }
          const match = existing.find((receipt) => Object.entries(payload)
            .every(([key, value]) => canonicalTranslationJsonV2(receipt[key]) === canonicalTranslationJsonV2(value)));
          if (!match) throw queueConflict('translation acknowledgment requires a queued patch');
          receipts.push(match);
          continue;
        }
        assertQueueMatches(queued, patch, payload.slicePath);
        if (payload.intentHash !== null) {
          const intent = validateIntent(
            await parsePath(git, tip, intentObjectPath(payload.intentHash)),
            patch.patchHash,
          );
          if (
            intent.intentHash !== payload.intentHash
            || intent.crawlerKey !== payload.crawlerKey
            || intent.slicePath !== payload.slicePath
            || intent.proposedCommit !== payload.publishedCommit
          ) {
            throw new TypeError('translation acknowledgment does not match its publish intent');
          }
        }
        const journal = await readAttemptJournal(git, tip, patch.candidate.attemptKey);
        if (getTranslationJournalStateV2(journal, patch.candidate.attemptKey).state !== 'queued') {
          throw new TypeError('translation acknowledgment requires queued lifecycle state');
        }
        const event = nextEvent(journal, patch, payload.outcome);
        const receiptPayload = {
          ...payload,
          lifecycleSequence: event.sequence,
          lifecycleEventId: event.eventId,
        };
        const receipt = deepFreezeTranslationV2({
          ...receiptPayload,
          ackHash: digestTranslationDocumentV2(receiptPayload),
        });
        await putImmutable(git, tip, changes, journalEventPath(event), canonicalArtifact(event));
        await putImmutable(
          git,
          tip,
          changes,
          ackPath(patch.patchHash, receipt.ackHash),
          canonicalArtifact(receipt),
        );
        changes.push({ path: queuePath(patch), content: null });
        receipts.push(receipt);
      }
      committedReceipts = receipts;
      return changes;
    });
    return deepFreezeTranslationV2({
      ...transaction,
      receipts: committedReceipts,
    });
  }

  async function readAcknowledgmentAtTip(tip, patchHash) {
    const paths = await listPaths(git, tip, ackPrefix(patchHash));
    if (paths.length > MAX_TRANSLATION_STATE_EVENTS_PER_ATTEMPT_V2) {
      throw new TypeError('translation acknowledgments exceed the bounded lifecycle count');
    }
    const receipts = [];
    for (const path of paths) {
      const receipt = validateAcknowledgment(await parsePath(git, tip, path), patchHash);
      if (!path.endsWith(`/${receipt.ackHash}.json`)) {
        throw new TypeError('translation acknowledgment path does not match its hash');
      }
      receipts.push(receipt);
    }
    let journal = null;
    if (receipts.length > 0) {
      journal = await readAttemptJournal(git, tip, receipts[0].attemptKey);
      for (const receipt of receipts) {
        if (receipt.attemptKey !== receipts[0].attemptKey) {
          throw new TypeError('translation acknowledgments for one patch span multiple attempts');
        }
        assertAcknowledgmentLifecycleProof(journal, receipt);
      }
    }
    const storedPatch = await parsePath(git, tip, `v2/patches/${patchHash.slice(0, 2)}/${patchHash}.json`);
    let queued = false;
    if (storedPatch !== null) {
      const patch = validateTranslationDerivedPatchV2(storedPatch);
      if (patch.patchHash !== patchHash) {
        throw new TypeError('translation state patch path does not match its hash');
      }
      journal ??= await readAttemptJournal(git, tip, patch.candidate.attemptKey);
      const queue = await parsePath(git, tip, queuePath(patch));
      queued = getTranslationJournalStateV2(journal, patch.candidate.attemptKey).state === 'queued';
      if (queued !== (queue !== null)) {
        throw new TypeError('translation queue and lifecycle state disagree');
      }
      if (queue !== null) assertQueueMatches(queue, patch, queue.slicePath);
    }
    receipts.sort((left, right) => left.lifecycleSequence - right.lifecycleSequence);
    return deepFreezeTranslationV2({
      commit: tip,
      acknowledgment: receipts.at(-1) ?? null,
      queued,
    });
  }

  async function readAcknowledgments(patchHashes) {
    assertBatch(patchHashes, 'translation acknowledgment read batch');
    if (
      patchHashes.some((patchHash) => typeof patchHash !== 'string' || !/^[a-f0-9]{64}$/.test(patchHash))
      || new Set(patchHashes).size !== patchHashes.length
    ) {
      throw new TypeError('translation acknowledgment patch hashes are invalid or duplicated');
    }
    const tip = await snapshotTip();
    const acknowledgments = [];
    const queued = [];
    for (const patchHash of patchHashes) {
      const result = await readAcknowledgmentAtTip(tip, patchHash);
      acknowledgments.push(result.acknowledgment);
      queued.push(result.queued);
    }
    return deepFreezeTranslationV2({ commit: tip, acknowledgments, queued });
  }

  async function readCommit() {
    return deepFreezeTranslationV2({ commit: await snapshotTip() });
  }

  async function readAcknowledgment(patchHash) {
    const result = await readAcknowledgments([patchHash]);
    return deepFreezeTranslationV2({
      commit: result.commit,
      acknowledgment: result.acknowledgments[0],
      queued: result.queued[0],
    });
  }

  return Object.freeze({
    ref,
    initialize,
    checkpointBatch,
    listPending,
    recordIntent,
    listIntents,
    acknowledgeBatch,
    readCommit,
    readAcknowledgments,
    readAcknowledgment,
  });
}
