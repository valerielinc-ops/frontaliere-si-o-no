import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { reduceTranslationDerivedPatchBatchV2 } from './translation-derived-reducer-v2.mjs';
import { validateTranslationDerivedPatchV2 } from './translation-derived-patch-v2.mjs';
import {
  MAX_TRANSLATION_STATE_BATCH_V2,
  TRANSLATION_STATE_QUEUE_CONFLICT_CODE_V2,
  validateTranslationSlicePathV2,
} from './translation-state-store-v2.mjs';
import {
  canonicalTranslationJsonV2,
  deepFreezeTranslationV2,
} from './translation-unit-identity-v2.mjs';

const execFile = promisify(execFileCallback);

export const MAX_TRANSLATION_MAIN_CAS_ATTEMPTS_V2 = 8;
export const TRANSLATION_MAIN_GIT_TIMEOUT_MS_V2 = 30_000;

const MAIN_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function createGitRunner(repository) {
  return async (args, options = {}) => {
    try {
      const result = await execFile('git', args, {
        cwd: repository,
        encoding: 'utf8',
        env: options.env ? { ...process.env, ...options.env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: TRANSLATION_MAIN_GIT_TIMEOUT_MS_V2,
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
  if (!line) throw new Error(`remote ref ${ref} does not exist`);
  return line.split(/\s+/u)[0];
}

async function fetchTip(git, remote, ref) {
  const startedAt = performance.now();
  const tip = await remoteTip(git, remote, ref);
  const present = await git(['cat-file', '-e', `${tip}^{commit}`]);
  if (present.code !== 0) await checked(git, ['fetch', '--no-tags', remote, ref]);
  await checked(git, ['cat-file', '-e', `${tip}^{commit}`]);
  return { tip, startedAt };
}

async function isShallowRepository(git) {
  return (await checked(git, ['rev-parse', '--is-shallow-repository'])) === 'true';
}

async function unshallowMain(git, remote, mainRef) {
  const fetched = await git([
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    '--unshallow',
    '--filter=blob:none',
    remote,
    mainRef,
  ]);
  if (fetched.code !== 0) {
    throw new Error(`git fetch --unshallow failed: ${(fetched.stderr || fetched.stdout).trim()}`);
  }
}

async function ensureCommitAvailable(git, remote, mainRef, commit) {
  const present = await git(['cat-file', '-e', `${commit}^{commit}`]);
  if (present.code === 0) return true;
  await git(['fetch', '--no-tags', '--no-write-fetch-head', remote, commit]);
  const fetched = await git(['cat-file', '-e', `${commit}^{commit}`]);
  if (fetched.code === 0) return true;
  if (!await isShallowRepository(git)) return false;
  await unshallowMain(git, remote, mainRef);
  return (await git(['cat-file', '-e', `${commit}^{commit}`])).code === 0;
}

async function readSlice(git, commit, slicePath) {
  const result = await git(['show', `${commit}:${slicePath}`]);
  if (result.code !== 0) throw new TypeError(`active crawler slice is absent at ${commit}:${slicePath}`);
  let slice;
  try {
    slice = JSON.parse(result.stdout);
  } catch {
    throw new TypeError(`active crawler slice is malformed at ${commit}:${slicePath}`);
  }
  return { raw: result.stdout, slice };
}

function serializeLike(raw, value) {
  const indentMatch = raw.match(/\n([ \t]+)"/u);
  const indent = indentMatch?.[1] ?? 0;
  const trailing = raw.endsWith('\n') ? '\n' : '';
  return `${JSON.stringify(value, null, indent)}${trailing}`;
}

async function createMainCommit(git, parent, slicePath, content) {
  const directory = await mkdtemp(join(tmpdir(), 'translation-main-v2-'));
  const indexPath = join(directory, 'index');
  const sliceFile = join(directory, 'slice.json');
  await writeFile(indexPath, '');
  await writeFile(sliceFile, content);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await checked(git, ['read-tree', parent], { env });
    const blob = await checked(git, ['hash-object', '-w', '--', sliceFile]);
    await checked(git, ['update-index', '--add', '--cacheinfo', `100644,${blob},${slicePath}`], { env });
    const tree = await checked(git, ['write-tree'], { env });
    const commit = await checked(git, [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'translation: apply derived locale batch',
    ]);
    return { commit, blob };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function isAncestor(git, ancestor, descendant) {
  const present = await git(['cat-file', '-e', `${ancestor}^{commit}`]);
  if (present.code !== 0) return false;
  const result = await git(['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base failed: ${result.stderr.trim()}`);
}

async function verifyPublishedIntent(git, remote, mainRef, intent, patches, latestMain) {
  if (!await ensureCommitAvailable(git, remote, mainRef, intent.proposedCommit)) return false;
  if (!await isAncestor(git, intent.proposedCommit, latestMain)) {
    if (!await isShallowRepository(git)) return false;
    await unshallowMain(git, remote, mainRef);
    if (!await isAncestor(git, intent.proposedCommit, latestMain)) return false;
  }
  const parents = (await checked(git, ['rev-list', '--parents', '-n', '1', intent.proposedCommit]))
    .split(/\s+/u);
  if (parents.length !== 2 || parents[1] !== intent.expectedMain) {
    throw new TypeError('translation publish intent commit parent does not match');
  }
  const paths = (await checked(git, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    intent.expectedMain,
    intent.proposedCommit,
  ])).split('\n').filter(Boolean);
  if (paths.length !== 1 || paths[0] !== intent.slicePath) {
    throw new TypeError('translation publish intent commit changed paths outside its slice');
  }
  const actualBlob = await checked(git, ['rev-parse', `${intent.proposedCommit}:${intent.slicePath}`]);
  if (actualBlob !== intent.expectedSliceBlob) {
    throw new TypeError('translation publish intent slice blob does not match');
  }
  const parentSlice = await readSlice(git, intent.expectedMain, intent.slicePath);
  const proposedSlice = await readSlice(git, intent.proposedCommit, intent.slicePath);
  const expected = reduceTranslationDerivedPatchBatchV2(parentSlice.slice, patches);
  if (
    canonicalTranslationJsonV2(expected.slice) !== canonicalTranslationJsonV2(proposedSlice.slice)
    || canonicalTranslationJsonV2(expected.outcomes) !== canonicalTranslationJsonV2(intent.outcomes)
  ) {
    throw new TypeError('translation publish intent commit is not the semantic reducer result');
  }
  return true;
}

function assertPatchBatch(rawPatches) {
  if (
    !Array.isArray(rawPatches)
    || rawPatches.length < 1
    || rawPatches.length > MAX_TRANSLATION_STATE_BATCH_V2
  ) {
    throw new TypeError('translation drainer batch must contain between 1 and 250 patches');
  }
  const patches = rawPatches.map((patch) => validateTranslationDerivedPatchV2(patch));
  if (new Set(patches.map((patch) => patch.patchHash)).size !== patches.length) {
    throw new TypeError('translation drainer batch contains duplicate patches');
  }
  if (new Set(patches.map((patch) => patch.candidate.attemptKey)).size !== patches.length) {
    throw new TypeError('translation drainer batch contains duplicate attempts');
  }
  if (new Set(patches.map((patch) => patch.target.crawlerKey)).size !== 1) {
    throw new TypeError('translation drainer batch must target one crawlerKey');
  }
  return patches;
}

function validateIntentForBatch(intent, slicePath, patches) {
  if (
    intent === null
    || typeof intent !== 'object'
    || intent.schemaVersion !== 2
    || intent.slicePath !== slicePath
    || !Array.isArray(intent.patchHashes)
    || !Array.isArray(intent.outcomes)
    || intent.patchHashes.length !== patches.length
    || intent.patchHashes.some((hash, index) => hash !== patches[index].patchHash)
  ) {
    return false;
  }
  return typeof intent.intentHash === 'string'
    && typeof intent.expectedMain === 'string'
    && typeof intent.proposedCommit === 'string'
    && typeof intent.expectedSliceBlob === 'string';
}

function acknowledgmentMatchesPatch(acknowledgment, slicePath, patch) {
  return acknowledgment.slicePath === slicePath
    && acknowledgment.crawlerKey === patch.target.crawlerKey
    && acknowledgment.patchHash === patch.patchHash
    && acknowledgment.attemptKey === patch.candidate.attemptKey
    && acknowledgment.candidateId === patch.candidate.candidateId;
}

function shouldRequeueAcknowledgment(outcome, observed) {
  if (['stale_target', 'ambiguous_target', 'malformed_target'].includes(outcome)) {
    return observed !== outcome;
  }
  if (['applied', 'already_valid'].includes(outcome)) return observed === 'applied';
  if (outcome === 'target_absent') return observed !== outcome;
  return false;
}

function canRequeueAcknowledgment(outcome) {
  return [
    'applied',
    'already_valid',
    'stale_target',
    'target_absent',
    'ambiguous_target',
    'malformed_target',
  ].includes(outcome);
}

export function createTranslationStateDrainerV2(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('translation drainer options must be an object');
  }
  const repository = options.repository;
  const stateStore = options.stateStore;
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new TypeError('translation drainer repository is required');
  }
  if (stateStore === null || typeof stateStore !== 'object') {
    throw new TypeError('translation drainer stateStore is required');
  }
  const remote = options.remote ?? 'origin';
  if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) {
    throw new TypeError('translation drainer remote is invalid');
  }
  const mainRef = options.mainRef ?? 'refs/heads/main';
  if (
    typeof mainRef !== 'string'
    || !MAIN_REF_PATTERN.test(mainRef)
    || mainRef.includes('..')
    || mainRef.includes('//')
    || mainRef.includes('@{')
    || mainRef.endsWith('/')
    || mainRef.endsWith('.')
    || mainRef.split('/').some((part) => part.endsWith('.lock'))
  ) {
    throw new TypeError('translation drainer mainRef is invalid');
  }
  if (mainRef === stateStore.ref) {
    throw new TypeError('translation drainer mainRef must be separate from its state ref');
  }
  const maxPushAttempts = options.maxPushAttempts ?? MAX_TRANSLATION_MAIN_CAS_ATTEMPTS_V2;
  if (!Number.isSafeInteger(maxPushAttempts) || maxPushAttempts < 1 || maxPushAttempts > 32) {
    throw new TypeError('translation main CAS attempts must be between 1 and 32');
  }
  const git = options.git ?? createGitRunner(repository);
  const onStage = options.onStage ?? (async () => {});
  if (typeof onStage !== 'function') throw new TypeError('translation drainer onStage must be a function');

  async function acknowledge(patches, slicePath, outcomes, mainCommit, publishedCommit, intentHash) {
    await onStage('beforeAck', { outcomes, mainCommit, publishedCommit, intentHash });
    try {
      await stateStore.acknowledgeBatch(patches.map((patch, index) => ({
        patch,
        slicePath,
        outcome: outcomes[index],
        mainCommit,
        publishedCommit,
        intentHash,
      })));
      return true;
    } catch (error) {
      if (error?.code === TRANSLATION_STATE_QUEUE_CONFLICT_CODE_V2) return false;
      throw error;
    }
  }

  async function recoverPublishedAtTip(patches, slicePath, mainCommit) {
    const listed = await stateStore.listIntents(patches[0].patchHash);
    const candidates = listed.intents.filter((intent) => validateIntentForBatch(intent, slicePath, patches));
    const publishedByCommit = new Map();
    for (const intent of candidates) {
      if (!await verifyPublishedIntent(git, remote, mainRef, intent, patches, mainCommit)) continue;
      const duplicate = publishedByCommit.get(intent.proposedCommit);
      if (duplicate !== undefined && duplicate.intentHash !== intent.intentHash) {
        throw new TypeError('translation publish commit has conflicting intents');
      }
      publishedByCommit.set(intent.proposedCommit, intent);
    }
    if (publishedByCommit.size === 0) return { status: 'absent', mainCommit };
    const independent = (await checked(git, [
      'merge-base',
      '--independent',
      ...publishedByCommit.keys(),
    ])).split(/\s+/u).filter(Boolean);
    if (independent.length !== 1) {
      throw new TypeError('published translation intents have ambiguous maximal commits');
    }
    const latestIntent = publishedByCommit.get(independent[0]);
    if (latestIntent === undefined) {
      throw new TypeError('published translation intent maximum is unknown');
    }
    const latestSlice = await readSlice(git, mainCommit, slicePath);
    const observed = reduceTranslationDerivedPatchBatchV2(latestSlice.slice, patches).outcomes;
    if (observed.includes('applied')) return { status: 'needs_apply', mainCommit };
    const outcomes = observed.map((outcome, index) => (
      latestIntent.outcomes[index] === 'applied' && outcome === 'already_valid' ? 'applied' : outcome
    ));
    return {
      status: 'recovered',
      intent: latestIntent,
      mainCommit,
      outcomes,
    };
  }

  async function drain({ slicePath: rawSlicePath, patches: rawPatches }) {
    const slicePath = validateTranslationSlicePathV2(rawSlicePath);
    const requestedPatches = assertPatchBatch(rawPatches);
    await stateStore.initialize();
    const fetchPushDurationsMs = [];
    let attemptBudgetUsed = 0;
    let retries = 0;
    let processedAny = false;
    let allReplayed = true;
    let latestPublishedCommit = null;

    function consumeAttemptBudget() {
      if (attemptBudgetUsed >= maxPushAttempts) {
        throw new Error('translation main CAS retry budget exhausted');
      }
      attemptBudgetUsed += 1;
    }

    async function auditRequestedBatch() {
      const snapshot = await stateStore.readAcknowledgments(
        requestedPatches.map((patch) => patch.patchHash),
      );
      snapshot.acknowledgments.forEach((acknowledgment, index) => {
        if (
          acknowledgment !== null
          && !acknowledgmentMatchesPatch(acknowledgment, slicePath, requestedPatches[index])
        ) {
          throw new TypeError('translation acknowledgment does not match its patch and slice');
        }
      });
      const fresh = await fetchTip(git, remote, mainRef);
      const latestSlice = await readSlice(git, fresh.tip, slicePath);
      const observed = reduceTranslationDerivedPatchBatchV2(latestSlice.slice, requestedPatches).outcomes;
      if (await remoteTip(git, remote, mainRef) !== fresh.tip) {
        consumeAttemptBudget();
        retries += 1;
        return null;
      }
      const confirmedState = await stateStore.readCommit();
      if (confirmedState.commit !== snapshot.commit) {
        consumeAttemptBudget();
        retries += 1;
        return null;
      }
      const outcomes = Array(requestedPatches.length).fill(null);
      const activeIndexes = requestedPatches.flatMap((_patch, index) => {
        const acknowledgment = snapshot.acknowledgments[index];
        if (snapshot.queued[index] || acknowledgment === null) return [index];
        if (shouldRequeueAcknowledgment(acknowledgment.outcome, observed[index])) return [index];
        outcomes[index] = acknowledgment.outcome;
        return [];
      });
      return {
        activeIndexes,
        acknowledgments: snapshot.acknowledgments,
        fresh,
        outcomes,
        queued: snapshot.queued,
      };
    }

    async function processActiveBatch(patches) {
      consumeAttemptBudget();
      const fresh = await fetchTip(git, remote, mainRef);
      const recovered = await recoverPublishedAtTip(patches, slicePath, fresh.tip);
      if (recovered.status === 'recovered') {
        if (await remoteTip(git, remote, mainRef) !== fresh.tip) {
          retries += 1;
          return null;
        }
        const acknowledged = await acknowledge(
          patches,
          slicePath,
          recovered.outcomes,
          recovered.mainCommit,
          recovered.intent.proposedCommit,
          recovered.intent.intentHash,
        );
        if (!acknowledged) {
          retries += 1;
          return 'reconcile';
        }
        return {
          outcomes: recovered.outcomes,
          mainCommit: recovered.mainCommit,
          publishedCommit: recovered.intent.proposedCommit,
          replayed: true,
        };
      }
      const source = await readSlice(git, fresh.tip, slicePath);
      const reduced = reduceTranslationDerivedPatchBatchV2(source.slice, patches);
      if (!reduced.outcomes.includes('applied')) {
        if (recovered.status === 'needs_apply') {
          throw new TypeError('translation recovery disagrees with the reducer result at one main tip');
        }
        const confirmedTip = await remoteTip(git, remote, mainRef);
        if (confirmedTip !== fresh.tip) {
          retries += 1;
          return null;
        }
        if (!await acknowledge(patches, slicePath, reduced.outcomes, fresh.tip, null, null)) {
          retries += 1;
          return 'reconcile';
        }
        return {
          outcomes: reduced.outcomes,
          mainCommit: fresh.tip,
          publishedCommit: null,
          replayed: false,
        };
      }

      const content = serializeLike(source.raw, reduced.slice);
      const proposal = await createMainCommit(git, fresh.tip, slicePath, content);
      let recorded;
      try {
        recorded = await stateStore.recordIntent({
          slicePath,
          patches,
          outcomes: reduced.outcomes,
          expectedMain: fresh.tip,
          proposedCommit: proposal.commit,
          expectedSliceBlob: proposal.blob,
        });
      } catch (error) {
        if (error?.code === TRANSLATION_STATE_QUEUE_CONFLICT_CODE_V2) {
          retries += 1;
          return 'reconcile';
        }
        throw error;
      }
      await onStage('afterIntent', { intent: recorded.intent });
      const pushed = await git(['push', remote, `${proposal.commit}:${mainRef}`]);
      fetchPushDurationsMs.push(performance.now() - fresh.startedAt);
      if (pushed.code !== 0) {
        const moved = await remoteTip(git, remote, mainRef);
        if (moved === fresh.tip) throw new Error(`translation main push failed: ${pushed.stderr.trim()}`);
      }
      const latest = await fetchTip(git, remote, mainRef);
      const published = await recoverPublishedAtTip(patches, slicePath, latest.tip);
      if (pushed.code === 0 && published.status === 'absent') {
        throw new TypeError('published translation commit is not on current main');
      }
      if (published.status !== 'absent') {
        await onStage('afterMainPush', { intent: recorded.intent });
      }
      if (await remoteTip(git, remote, mainRef) !== latest.tip) {
        retries += 1;
        return null;
      }
      if (published.status === 'recovered') {
        const acknowledged = await acknowledge(
          patches,
          slicePath,
          published.outcomes,
          published.mainCommit,
          published.intent.proposedCommit,
          published.intent.intentHash,
        );
        if (!acknowledged) {
          retries += 1;
          return 'reconcile';
        }
        return {
          outcomes: published.outcomes,
          mainCommit: published.mainCommit,
          publishedCommit: published.intent.proposedCommit,
          replayed: false,
        };
      }
      retries += 1;
      return null;
    }

    while (true) {
      const audit = await auditRequestedBatch();
      if (audit === null) continue;
      if (audit.activeIndexes.length === 0) {
        if (audit.outcomes.some((outcome) => outcome === null)) {
          throw new TypeError('translation drainer did not resolve every requested patch');
        }
        return deepFreezeTranslationV2({
          outcomes: audit.outcomes,
          mainCommit: audit.fresh.tip,
          publishedCommit: latestPublishedCommit
            ?? audit.acknowledgments.find((acknowledgment) => acknowledgment !== null)
              ?.publishedCommit
            ?? null,
          retries,
          fetchPushDurationsMs,
          replayed: processedAny ? allReplayed : true,
        });
      }

      for (const index of audit.activeIndexes) {
        const prior = audit.acknowledgments[index]?.outcome;
        if (prior !== undefined && !canRequeueAcknowledgment(prior)) {
          throw new TypeError('translation drainer cannot requeue a terminal outcome');
        }
      }
      const patches = audit.activeIndexes.map((index) => requestedPatches[index]);
      await stateStore.checkpointBatch({
        slicePath,
        patches,
        requeue: audit.activeIndexes.some((index) => audit.acknowledgments[index] !== null),
      });
      await onStage('afterCheckpoint', { slicePath, patches });

      const confirmed = await auditRequestedBatch();
      if (confirmed === null) continue;
      const expectedIndexes = new Set(audit.activeIndexes);
      const checkpointStillOwned = audit.activeIndexes.every((index) => confirmed.queued[index]);
      const activeSetUnchanged = confirmed.activeIndexes.length === audit.activeIndexes.length
        && confirmed.activeIndexes.every((index) => expectedIndexes.has(index));
      if (!checkpointStillOwned || !activeSetUnchanged) {
        consumeAttemptBudget();
        retries += 1;
        continue;
      }

      let processed = null;
      while (processed === null) processed = await processActiveBatch(patches);
      if (typeof processed === 'string') continue;
      processedAny = true;
      allReplayed &&= processed.replayed;
      latestPublishedCommit = processed.publishedCommit ?? latestPublishedCommit;
    }
  }

  return Object.freeze({ drain });
}
