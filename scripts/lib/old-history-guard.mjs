#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

import { withSingleFlightLock } from './single-flight-lock.mjs';
import {
  appendGitConfigEnvironment,
  checkoutFetchTarget,
  checkoutHttpExtraHeaders,
  resolveScratchRemote,
} from './git-fetch-target.mjs';

export { appendGitConfigEnvironment, checkoutFetchTarget };

// Primo commit cambiato dalla riscrittura della storia. Potrà essere tolto
// solo dopo la riscrittura e la bonifica di tutti i clone e worktree che
// possono ancora conoscere la storia precedente.
export const OLD_HISTORY_FIRST_CHANGED_COMMIT = 'dab77221540a4e369440f762228be7e0be21155d';

const DEFAULT_BASE_REF = 'refs/remotes/origin/main';
const FETCH_TIMEOUT_MS = 30_000;
// Two short `gh compare` reads replace materializing the rewritten commit
// graph in authenticated data-refresh workflows. If GitHub cannot answer
// quickly, the existing bounded/fail-closed Git proof remains authoritative.
const GITHUB_COMPARE_TIMEOUT_MS = 2_250;
// A shallow refresh may need the complete commit graph to prove that a
// fetched marker is not hidden beyond the shallow boundary. This fetch stays
// tree-filtered, but its duration scales with the repository's commit graph;
// the old 30-second cap made valid data-refresh PRs fail closed before the
// history check could finish. Keep a separate, bounded budget for this slower
// operation instead of relaxing the guard or sharing the short-fetch timeout.
export const HISTORY_GRAPH_FETCH_TIMEOUT_MS = 5 * 60_000;
// How many commits a head may add over the refreshed base and still be decided
// without the history graph. A data writer adds a handful; a longer list is not
// the ordinary case the bounded proof exists for.
const BOUNDED_PROOF_MAX_ADDED_COMMITS = 2_000;
// The shallow remote-branch probe usually brings only the branch delta (0.7 to
// 2.7 seconds measured); if it cannot establish descent quickly, the complete
// check remains the authority.
const REMOTE_DESCENT_FETCH_TIMEOUT_MS = 15_000;
// Commit timestamps can move backwards between machines; widen the shallow
// window by one day so a clock skew does not hide the old base commit.
const REMOTE_DESCENT_SINCE_SKEW_SECONDS = 86_400;

const OLD_HISTORY_REMEDIATION = [
  'Ricrea il branch da origin/main aggiornato e riporta solo i tuoi commit con:',
  '  git rebase --onto origin/main <vecchia base> <branch>',
  'oppure ricrea il branch da origin/main e riporta i tuoi commit.',
].join('\n');

const OLD_HISTORY_BLOCK_MESSAGE = 'Controllo storia precedente fallito: il branch della PR contiene la storia precedente alla riscrittura, ma il base aggiornato non la contiene.';

function safeGitErrorDetail(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .join('\n')
    .replace(/https:\/\/x-access-token:[^@\s]+@/gu, 'https://x-access-token:[REDACTED]@')
    .trim();
}

function runGit(args, { cwd, stdio = 'ignore', timeout, env } = {}) {
  const output = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio,
    timeout,
    env,
  });
  return output ? output.trim() : '';
}


// What a parent git exports to bind its children to one repository, index and
// object store: `git rev-parse --local-env-vars`, minus the two that carry
// configuration, which is where a caller hands over its credentials. A pre-push
// hook in a linked worktree runs with GIT_DIR set (githooks(5)). With it in
// place every command meant for the scratch repository acts on the checkout
// instead: measured on a shallow one, it gained a stray branch and a promisor
// remote without a URL, and lost its shallow boundary.
export const REPOSITORY_BINDING_ENVIRONMENT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
];

/** The environment of a git command that must act on a repository of its own. */
export function detachedRepositoryEnvironment(baseEnv, entries = []) {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0' };
  for (const name of REPOSITORY_BINDING_ENVIRONMENT) delete env[name];
  return appendGitConfigEnvironment(env, entries);
}

// An existence probe answers from the local object store, and nothing else.
// On a partial clone a plain `cat-file -e` first asks the promisor for the
// object: a fetch with no time limit that the trace never shows, and one that
// succeeds for the marker, since the remote still serves the previous history
// by id (2.7 s and 2.2 MB against the real remote from a blobless checkout).
// Whoever needs a commit that is not local fetches it explicitly, bounded and
// timed: fetchCommitObject, refreshOriginBranch, completeShallowHistory.
function commitExists(ref, cwd, env = process.env) {
  try {
    runGit(['cat-file', '-e', `${ref}^{commit}`], { cwd, env: { ...env, GIT_NO_LAZY_FETCH: '1' } });
    return true;
  } catch {
    return false;
  }
}

function isAncestor(ancestor, descendant, cwd, env) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  if (result.status === 0) return true;
  if (result.status === 1) return false;

  const detail = (result.stderr || result.error?.message || 'errore git sconosciuto').trim();
  throw new Error(`Impossibile verificare l'ascendenza git (${ancestor} -> ${descendant}): ${detail}`);
}

function isShallowRepository(cwd) {
  return runGit(['rev-parse', '--is-shallow-repository'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }) === 'true';
}

function resolveCommit(ref, cwd) {
  try {
    return runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

// The commits whose parents the checkout does not have. `null` means the
// boundary cannot be read, which callers must treat as "unknown", not "none".
function shallowBoundaryCommits(cwd) {
  if (!isShallowRepository(cwd)) return new Set();
  try {
    const shallowPath = resolve(cwd, runGit(['rev-parse', '--git-path', 'shallow'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
    return new Set(readFileSync(shallowPath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

function timed(trace, step, fn) {
  const startedAt = Date.now();
  let failed = true;
  try {
    const value = fn();
    failed = false;
    return value;
  } finally {
    trace?.push({ step, ms: Date.now() - startedAt, ...(failed ? { failed: true } : {}) });
  }
}

function historyGuardLockPath(cwd) {
  return resolve(cwd, gitCommonDir(cwd), 'frontaliere-old-history-guard.lock');
}

function withHistoryGuardLock(cwd, fn) {
  const result = withSingleFlightLock(historyGuardLockPath(cwd), fn);
  if (!result.acquired) {
    throw new Error('non è stato possibile acquisire il lock per aggiornare il grafo della storia.');
  }
  return result.value;
}

function isRemoteObjectUnavailable(detail) {
  const normalized = detail.toLowerCase();
  return normalized.includes('not our ref')
    || normalized.includes("couldn't find remote ref")
    || normalized.includes('could not find remote ref')
    || normalized.includes('no such remote ref');
}

function isRemoteRefUnavailable(detail, ref) {
  const normalized = detail.toLowerCase();
  const target = ref.toLowerCase();
  return normalized.includes(`couldn't find remote ref ${target}`)
    || normalized.includes(`could not find remote ref ${target}`)
    || normalized.includes(`no such remote ref ${target}`)
    || normalized.includes(`not our ref ${target}`);
}

function isRemoteObjectUnavailableFor(detail, objectRef) {
  return isRemoteObjectUnavailable(detail) && detail.toLowerCase().includes(objectRef.toLowerCase());
}

function fetchCommitObject({ cwd, remote, commitRef }) {
  // A zero object ID is Git's deletion sentinel, not a fetchable commit. The
  // pre-push caller normally filters it, but the library also accepts direct
  // callers; classify it as an unavailable marker without asking the remote
  // to resolve an invalid ref.
  if (/^0{40}$/u.test(commitRef)) return false;
  try {
    const fetchTarget = checkoutFetchTarget({ cwd, remote });
    runGit([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--filter=tree:0',
      fetchTarget.remote,
      commitRef,
    ], { cwd, timeout: FETCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env: fetchTarget.env });
  } catch (error) {
    const detail = safeGitErrorDetail(error);
    if (isRemoteObjectUnavailable(detail)) return commitExists(commitRef, cwd);
    throw new Error(`Impossibile recuperare il commit del marker dal remoto: ${detail || 'errore git sconosciuto'}`);
  }
  return commitExists(commitRef, cwd);
}

function remoteHeadRef({ headRef, branch }) {
  const match = /^refs\/remotes\/[^/]+\/(.+)$/u.exec(headRef);
  return `refs/heads/${match?.[1] || branch}`;
}

function completeShallowHistory({ cwd, remote, headRef, branch, baseRef, markerRef }) {
  const branchRef = `refs/heads/${branch}`;
  const requiredHeadRef = remoteHeadRef({ headRef, branch });
  const headCommit = resolveCommit(headRef, cwd);
  let fetchTarget;
  const args = [
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
  ];
  if (isShallowRepository(cwd)) args.push('--unshallow');
  try {
    fetchTarget = checkoutFetchTarget({ cwd, remote });
    args.push('--filter=tree:0', fetchTarget.remote, `+${branchRef}:${baseRef}`);
    if (requiredHeadRef !== branchRef) args.push(requiredHeadRef);
    // If the marker is absent, fetch it in the same request as the branch
    // graph. The old fallback fetched the marker and then the graph in two
    // filtered requests, repeating commit history and registering the
    // credential-bearing URL twice.
    if (markerRef && !commitExists(markerRef, cwd)) args.push(markerRef);
    runGit(args, { cwd, timeout: HISTORY_GRAPH_FETCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env: fetchTarget.env });
  } catch (error) {
    const detail = safeGitErrorDetail(error);
    // GitHub deletes a stable PR branch after merge. The caller has already
    // fetched this exact head, so retry only when that source ref disappeared,
    // pinning the same commit while keeping the bounded graph and marker fetch.
    // If the pinned commit is no longer fetchable, the history proof fails
    // closed below.
    if (requiredHeadRef !== branchRef && headCommit && isRemoteRefUnavailable(detail, requiredHeadRef)) {
      const fallbackArgs = args.filter((arg) => arg !== requiredHeadRef);
      if (!fallbackArgs.includes(headCommit)) fallbackArgs.push(headCommit);
      try {
        runGit(fallbackArgs, {
          cwd,
          timeout: HISTORY_GRAPH_FETCH_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: fetchTarget.env,
        });
      } catch (fallbackError) {
        const fallbackDetail = safeGitErrorDetail(fallbackError);
        if (markerRef && !commitExists(markerRef, cwd)
          && isRemoteObjectUnavailableFor(fallbackDetail, markerRef)) return false;
        throw new Error(`Impossibile completare il grafo della storia per verificare il marker: ${fallbackDetail || 'errore git sconosciuto'}`);
      }
    } else {
      if (markerRef && !commitExists(markerRef, cwd)
        && isRemoteObjectUnavailableFor(detail, markerRef)) return false;
      throw new Error(`Impossibile completare il grafo della storia per verificare il marker: ${detail || 'errore git sconosciuto'}`);
    }
  }
  if (isShallowRepository(cwd)) {
    throw new Error('Il checkout resta shallow dopo il fetch del grafo della storia; controllo non verificabile.');
  }
  return true;
}

function markerIsAncestorOfHead({ cwd, markerRef, headRef }) {
  if (!commitExists(markerRef, cwd)) return { markerAvailable: false, markerInHead: false };
  if (!commitExists(headRef, cwd)) {
    throw new Error(`HEAD '${headRef}' non è disponibile nel checkout.`);
  }
  return { markerAvailable: true, markerInHead: isAncestor(markerRef, headRef, cwd) };
}

/**
 * Answers the history question without changing refs or the working tree.
 * `base-unavailable` lets the CLI refresh the base before deciding. This pure
 * inspection deliberately reports a missing marker; `checkOldHistory` probes
 * the remote first when refresh is enabled, then passes only if it is still
 * unavailable after that probe.
 */
export function inspectOldHistory({
  cwd = process.cwd(),
  markerRef = OLD_HISTORY_FIRST_CHANGED_COMMIT,
  headRef = 'HEAD',
  baseRef = DEFAULT_BASE_REF,
} = {}) {
  const { markerAvailable, markerInHead } = markerIsAncestorOfHead({ cwd, markerRef, headRef });
  if (!markerAvailable) {
    return { outcome: 'pass', reason: 'marker-unavailable' };
  }
  if (!markerInHead) {
    return { outcome: 'pass', reason: 'marker-not-in-head' };
  }
  if (!commitExists(baseRef, cwd)) {
    return { outcome: 'base-unavailable', markerRef, headRef, baseRef };
  }
  if (isAncestor(markerRef, baseRef, cwd)) {
    return { outcome: 'pass', reason: 'marker-in-base' };
  }
  return { outcome: 'blocked', markerRef, headRef, baseRef };
}

function gitCommonDir(cwd) {
  return runGit(['rev-parse', '--git-common-dir'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Fetches only commit metadata/tree-on-demand and refreshes the destination
 * remote-tracking ref. The lock keeps local pre-push/data writers single-flight.
 */
export function refreshOriginBranch({
  cwd = process.cwd(),
  remote = 'origin',
  branch = 'main',
  destinationRef = `refs/remotes/origin/${branch}`,
} = {}) {
  try {
    withHistoryGuardLock(cwd, () => {
      const fetchTarget = checkoutFetchTarget({ cwd, remote });
      runGit([
        'fetch',
        '--quiet',
        '--no-tags',
        '--filter=tree:0',
        fetchTarget.remote,
        `+refs/heads/${branch}:${destinationRef}`,
      ], { cwd, timeout: FETCH_TIMEOUT_MS, env: fetchTarget.env });
    });
  } catch (error) {
    throw new Error(`Impossibile aggiornare il base ref: ${safeGitErrorDetail(error) || 'errore git sconosciuto'}`);
  }
}

/**
 * Decides whether the verdict can still be `blocked`, using only the commits
 * the checkout already has. It never answers "is the marker an ancestor of the
 * head?": a shallow history cannot.
 *
 * `blocked` needs the marker to be an ancestor of the head and not of the base.
 * Every commit that is an ancestor of the head and not of the base is listed by
 * `rev-list head --not base`, provided no listed commit sits on the shallow
 * boundary: a boundary commit hides its parents, so the list could stop short
 * of an ancestor. A truncated history on the base side can only make the list
 * longer. When the list is closed and the marker is not in it, completing the
 * history graph cannot change the outcome.
 *
 * The answer is relative to `baseRef` as it is now. A caller that needs the
 * verdict against the remote branch refreshes the ref first: a checkout still
 * on the previous history then lists its own boundary commit and is not proven.
 */
export function proveHeadAddsNoOldHistory({
  cwd = process.cwd(),
  markerRef = OLD_HISTORY_FIRST_CHANGED_COMMIT,
  headRef = 'HEAD',
  baseRef = DEFAULT_BASE_REF,
} = {}) {
  // The marker does not have to be in the checkout: a commit that is not local
  // cannot be among the listed ones, and the comparison below says so.
  const marker = /^[0-9a-f]{40,64}$/u.test(markerRef) ? markerRef : resolveCommit(markerRef, cwd);
  if (!marker) return { proven: false, why: 'marker-unresolved' };
  if (!commitExists(headRef, cwd) || !commitExists(baseRef, cwd)) return { proven: false, why: 'ref-unavailable' };
  let added;
  try {
    added = runGit([
      'rev-list',
      `--max-count=${BOUNDED_PROOF_MAX_ADDED_COMMITS + 1}`,
      headRef,
      '--not',
      baseRef,
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
  } catch {
    return { proven: false, why: 'rev-list-failed' };
  }
  if (added.length > BOUNDED_PROOF_MAX_ADDED_COMMITS) return { proven: false, why: 'too-many-added-commits' };
  if (added.includes(marker)) return { proven: false, why: 'marker-among-added-commits' };
  const boundary = shallowBoundaryCommits(cwd);
  if (!boundary) return { proven: false, why: 'shallow-boundary-unreadable' };
  if (added.some((sha) => boundary.has(sha))) return { proven: false, why: 'added-commit-on-shallow-boundary' };
  return { proven: true, addedCommits: added.length };
}

function githubRepositoryForRemote({ cwd, remote }) {
  const expectedRepository = process.env.GITHUB_REPOSITORY || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expectedRepository)) return '';

  const location = resolveScratchRemote({ cwd, remote });
  let owner;
  let repository;
  try {
    const url = new URL(location);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com') return '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return '';
    [owner, repository] = parts;
  } catch {
    const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(location);
    if (!match) return '';
    [, owner, repository] = match;
  }
  repository = repository.replace(/\.git$/iu, '');
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repository)) return '';
  const actualRepository = `${owner}/${repository}`;
  return actualRepository.toLowerCase() === expectedRepository.toLowerCase() ? actualRepository : '';
}

function compareAncestryOnGitHub({ cwd, repository, base, head }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GH_TOKEN && env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN;
  const result = spawnSync('gh', [
    'api',
    `repos/${repository}/compare/${encodeURIComponent(`${base}...${head}`)}`,
    '--jq',
    '.status',
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    timeout: GITHUB_COMPARE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const status = result.stdout.trim();
  if (status === 'ahead' || status === 'identical') return true;
  if (status === 'behind' || status === 'diverged') return false;
  return null;
}

/**
 * Use GitHub's commit-compare endpoint only when the authenticated repository
 * and the requested remote agree. This answers the same ancestry relation as
 * merge-base without downloading commit objects or writing a promisor remote.
 */
function inspectShallowHistoryOnGitHub({ cwd, markerRef, headRef, remote, branch }) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return null;
  const repository = githubRepositoryForRemote({ cwd, remote });
  if (!repository) return null;
  const marker = /^[0-9a-f]{40,64}$/iu.test(markerRef) ? markerRef : resolveCommit(markerRef, cwd);
  const head = resolveCommit(headRef, cwd);
  if (!marker || !head || !branch || /[\\\r\n]/u.test(branch)) return null;

  try {
    const markerInBase = compareAncestryOnGitHub({ cwd, repository, base: marker, head: branch });
    if (markerInBase === true) return { attempted: true, result: { outcome: 'pass', reason: 'marker-in-base' } };
    if (markerInBase === null) return { attempted: true, result: null };

    const markerInHead = compareAncestryOnGitHub({ cwd, repository, base: marker, head });
    if (markerInHead === null) return { attempted: true, result: null };
    return {
      attempted: true,
      result: markerInHead
        ? { outcome: 'blocked', markerRef, headRef, baseRef: `refs/heads/${branch}` }
        : { outcome: 'pass', reason: 'marker-not-in-head' },
    };
  } catch {
    return { attempted: true, result: null };
  }
}

function remoteDescentFailure(error) {
  const detail = safeGitErrorDetail(error);
  return {
    proven: false,
    why: isRemoteObjectUnavailable(detail) ? 'base-not-in-remote-branch' : 'remote-descent-unverified',
  };
}

/**
 * Proves that the remote branch still descends from the checkout's old base.
 *
 * `blocked` is equivalent to marker ∈ ancestors(head) and marker ∉
 * ancestors(B_new), where B_new is the current remote branch tip. Let B_old
 * be the local base and A = `rev-list head --not B_old`. If A is closed (no
 * commit in A is on the shallow boundary) and the marker is not in A, then
 * marker ∈ ancestors(head) implies marker ∈ ancestors(B_old), exactly as the
 * existing bounded proof establishes. If B_old is also an ancestor of B_new,
 * ancestors(B_old) ⊆ ancestors(B_new), so the marker cannot be outside the
 * new base and the verdict cannot be `blocked`.
 * A checkout left on the old history has a B_old that is not an ancestor of a
 * rewritten B_new, so this proof stays undecided and the existing path blocks
 * it when the marker is confirmed in the old history.
 *
 * The old base is checked against the remote tip in a disposable shallow bare
 * repository. Shallow boundaries remove parent edges but never add them, so a
 * path from the remote tip to B_old in that repository proves the real
 * ancestry. If the date cut hides B_old, this proof simply remains undecided.
 */
function proveRemoteBranchDescendsFromBase({ cwd, remote, branch, baseRef }) {
  const base = resolveCommit(baseRef, cwd);
  if (!base) return { proven: false, why: 'base-unresolved' };

  let scratch = '';
  try {
    const committedAt = Number.parseInt(runGit(['show', '-s', '--format=%ct', base], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }), 10);
    if (!Number.isFinite(committedAt)) return { proven: false, why: 'remote-descent-unverified' };
    const since = committedAt - REMOTE_DESCENT_SINCE_SKEW_SECONDS;
    const remoteUrl = resolveScratchRemote({ cwd, remote });
    // The URL and the checkout's credentials reach the scratch repository
    // through the environment only: nothing of them is written to disk.
    const env = detachedRepositoryEnvironment(process.env, [
      { key: 'remote.guard.url', value: remoteUrl },
      ...checkoutHttpExtraHeaders(cwd),
    ]);
    // The two reads below answer from what the fetch brought, and nothing else.
    const readEnv = { ...env, GIT_NO_LAZY_FETCH: '1' };

    scratch = mkdtempSync(join(tmpdir(), 'old-history-guard-'));
    runGit(['init', '--quiet', '--bare', scratch], {
      cwd: scratch,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    runGit([
      '--git-dir',
      scratch,
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--filter=tree:0',
      `--shallow-since=${since}`,
      'guard',
      `+refs/heads/${branch}:refs/heads/remote`,
    ], {
      cwd: scratch,
      timeout: REMOTE_DESCENT_FETCH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    if (!commitExists(base, scratch, readEnv)) return { proven: false, why: 'base-not-in-remote-branch' };
    return isAncestor(base, 'refs/heads/remote', scratch, readEnv)
      ? { proven: true }
      : { proven: false, why: 'base-not-in-remote-branch' };
  } catch (error) {
    return remoteDescentFailure(error);
  } finally {
    if (scratch) {
      try {
        // A fetch stopped by its timeout can leave a helper writing for a moment.
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // The scratch repository is best-effort cleanup and never changes the verdict.
      }
    }
  }
}

/**
 * A shallow checkout is decided without the full graph only when the remote
 * branch is proven to descend from the old base and the bounded local proof is
 * closed. Otherwise one combined filtered fetch updates the base, retrieves a
 * missing marker, and completes the shallow history; no ordinary full-tree
 * refresh precedes a second copy of the commit graph.
 */
function decideShallowWithoutHistoryGraph({ cwd, markerRef, headRef, baseRef, remote, branch, trace }) {
  let remoteDescent;
  try {
    remoteDescent = timed(trace, 'remote-descends-from-base', () => proveRemoteBranchDescendsFromBase({
      cwd,
      remote,
      branch,
      baseRef,
    }));
  } catch {
    remoteDescent = { proven: false, why: 'remote-descent-unverified' };
  }
  const remoteDescentTrace = trace?.at(-1);
  if (remoteDescentTrace?.step === 'remote-descends-from-base') {
    remoteDescentTrace.proven = remoteDescent.proven;
    if (!remoteDescent.proven) remoteDescentTrace.why = remoteDescent.why;
  }
  if (remoteDescent.proven) {
    const proof = proveHeadAddsNoOldHistory({ cwd, markerRef, headRef, baseRef });
    trace?.push({ step: 'bounded-proof', ...proof });
    if (proof.proven) return { proven: true, baseRefreshed: false };
  }
  try {
    const completed = timed(trace, 'complete-shallow-history', () => withHistoryGuardLock(cwd, () => completeShallowHistory({
      cwd,
      remote,
      headRef,
      branch,
      baseRef,
      markerRef,
    })));
    if (completed) {
      const proof = proveHeadAddsNoOldHistory({ cwd, markerRef, headRef, baseRef });
      trace?.push({ step: 'bounded-proof', ...proof });
      return { proven: proof.proven, baseRefreshed: true };
    }
  } catch {
    // The full inspector below remains the authority. If the combined fetch
    // did not establish the graph, its fail-closed check will report that.
  }
  return { proven: false, baseRefreshed: false };
}

export function checkOldHistory({
  cwd = process.cwd(),
  markerRef = OLD_HISTORY_FIRST_CHANGED_COMMIT,
  headRef = 'HEAD',
  baseRef = DEFAULT_BASE_REF,
  refreshBase = false,
  remote = 'origin',
  branch = 'main',
  trace,
} = {}) {
  let result = inspectOldHistory({ cwd, markerRef, headRef, baseRef });
  let baseRefreshed = false;
  // On a shallow CI checkout, a remote force-push can make the local graph
  // unable to answer either ancestry question. GitHub's compare endpoint can
  // answer against the current head and base without the 124k-commit fetch;
  // if it is unavailable or inconclusive, continue through the existing
  // bounded Git path rather than weakening the guard.
  if (refreshBase && isShallowRepository(cwd)) {
    const compareStartedAt = Date.now();
    const comparison = inspectShallowHistoryOnGitHub({
      cwd,
      markerRef,
      headRef,
      remote,
      branch,
    });
    if (comparison?.attempted) {
      const compareTrace = {
        step: 'github-compare',
        ms: Date.now() - compareStartedAt,
        verdict: comparison.result?.reason || comparison.result?.outcome || 'unavailable; using bounded Git proof',
      };
      trace?.push(compareTrace);
      if (comparison.result) return comparison.result;
    }
  }
  // A missing marker can use the bounded proof without fetching that object.
  // When the marker is local but merge-base says it is unrelated, the shallow
  // boundary can still hide a parent path: complete the graph before treating
  // that negative as conclusive.
  if (refreshBase && result.reason === 'marker-unavailable' && isShallowRepository(cwd)) {
    const decision = decideShallowWithoutHistoryGraph({ cwd, markerRef, headRef, baseRef, remote, branch, trace });
    if (decision.proven) return { outcome: 'pass', reason: 'head-adds-no-old-history' };
    baseRefreshed = decision.baseRefreshed;
    result = inspectOldHistory({ cwd, markerRef, headRef, baseRef });
  }
  if (result.reason === 'marker-unavailable' && refreshBase) {
    const markerFetched = timed(trace, 'fetch-marker', () => withHistoryGuardLock(cwd, () => fetchCommitObject({ cwd, remote, commitRef: markerRef })));
    if (!markerFetched) return result;
    result = inspectOldHistory({ cwd, markerRef, headRef, baseRef });
  }
  // Any available marker can produce an inconclusive false result from
  // `merge-base --is-ancestor` when the repository is shallow: the marker may
  // be beyond the shallow boundary, even when its object is already local.
  // `marker-in-base` is the one conclusive fast path because both ancestry
  // checks have already succeeded.
  const historyMayNeedCompletion = result.reason !== 'marker-unavailable'
    && result.reason !== 'marker-in-base';
  if (refreshBase && historyMayNeedCompletion && commitExists(markerRef, cwd) && isShallowRepository(cwd)) {
    const completed = timed(trace, 'complete-shallow-history', () => withHistoryGuardLock(cwd, () => completeShallowHistory({
      cwd,
      remote,
      headRef,
      branch,
      baseRef,
      markerRef,
    })));
    baseRefreshed = completed || baseRefreshed;
    result = inspectOldHistory({ cwd, markerRef, headRef, baseRef });
  }
  const baseNeedsRefresh = result.reason === 'marker-in-base'
    || result.outcome === 'blocked'
    || result.outcome === 'base-unavailable';
  if (baseNeedsRefresh && refreshBase && !baseRefreshed) {
    refreshOriginBranch({ cwd, remote, branch, destinationRef: baseRef });
    result = inspectOldHistory({ cwd, markerRef, headRef, baseRef });
  }
  if (result.outcome === 'base-unavailable') {
    throw new Error(`Il base ref '${baseRef}' non è disponibile: controllo della storia non verificabile.`);
  }
  return result;
}

export function assertOldHistorySafe(options = {}) {
  const result = checkOldHistory(options);
  if (result.outcome === 'blocked') {
    throw new Error(`${OLD_HISTORY_BLOCK_MESSAGE}\n${OLD_HISTORY_REMEDIATION}`);
  }
  return result;
}

export function isOldHistoryBlockedError(value) {
  const text = typeof value === 'string'
    ? value
    : [value?.message, value?.stdout, value?.stderr].filter(Boolean).join('\n');
  return text.includes(OLD_HISTORY_BLOCK_MESSAGE);
}

const TRACE_STEP_LABELS = {
  'github-compare': 'confronto remoto GitHub',
  'remote-descends-from-base': 'discendenza del ramo remoto dal base',
  'refresh-base': 'aggiornamento del base',
  'fetch-marker': 'recupero del marker',
  'complete-shallow-history': 'completamento del grafo della storia',
};

// What the check cost and which proof decided it, on the same line as the
// verdict: a job that starts paying for the whole commit graph again shows it
// in its own log.
export function describeTrace(trace = []) {
  const parts = trace.map((entry) => {
    if (entry.step === 'github-compare') {
      const seconds = `${(entry.ms / 1000).toFixed(1)} s`;
      return `${TRACE_STEP_LABELS[entry.step]}: ${entry.verdict || 'non conclusivo'} dopo ${seconds}`;
    }
    if (entry.step === 'remote-descends-from-base') {
      const seconds = `${(entry.ms / 1000).toFixed(1)} s`;
      if (entry.proven) return `${TRACE_STEP_LABELS[entry.step]}: ${seconds}`;
      return `${TRACE_STEP_LABELS[entry.step]}: non conclusiva: ${entry.why || 'remote-descent-unverified'} dopo ${seconds}`;
    }
    if (entry.step === 'bounded-proof') {
      return entry.proven
        ? `prova limitata riuscita, ${entry.addedCommits} commit sopra il base`
        : `prova limitata non conclusiva: ${entry.why}`;
    }
    const seconds = `${(entry.ms / 1000).toFixed(1)} s`;
    return `${TRACE_STEP_LABELS[entry.step] || entry.step}: ${entry.failed ? `non riuscito dopo ${seconds}` : seconds}`;
  });
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

function printResult(result, trace) {
  if (result.outcome === 'blocked') {
    console.error(`::error::${OLD_HISTORY_BLOCK_MESSAGE}`);
    console.error(OLD_HISTORY_REMEDIATION);
    if (trace?.length) console.error(`old-history-guard:${describeTrace(trace)}`);
    return 1;
  }

  const messages = {
    'marker-unavailable': 'il marker non è disponibile nel checkout remoto; controllo superato.',
    'marker-not-in-head': 'il marker non è antenato dell’head; controllo superato.',
    'marker-in-base': 'il marker è ancora antenato del base; controllo inerte prima della riscrittura.',
    'head-adds-no-old-history': 'l’head aggiunge al base solo commit già noti, e il marker non è fra questi; controllo superato senza scaricare il grafo.',
  };
  console.log(`old-history-guard: ${messages[result.reason] || 'controllo superato.'}${describeTrace(trace)}`);
  return 0;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    headRef: 'HEAD',
    baseRef: DEFAULT_BASE_REF,
    refreshBase: false,
    remote: 'origin',
    branch: 'main',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--head' || arg === '--base' || arg === '--remote' || arg === '--branch' || arg === '--cwd') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} richiede un valore.`);
      const key = { '--head': 'headRef', '--base': 'baseRef', '--remote': 'remote', '--branch': 'branch', '--cwd': 'cwd' }[arg];
      options[key] = value;
      index += 1;
    } else if (arg === '--refresh-base') {
      options.refreshBase = true;
    } else {
      throw new Error(`Argomento sconosciuto: ${arg}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const trace = [];
  try {
    const result = checkOldHistory({ ...parseArgs(argv), trace });
    process.exitCode = printResult(result, trace);
  } catch (error) {
    console.error(`::error::Controllo storia precedente non verificabile: ${error.message}${describeTrace(trace)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  await main();
}
