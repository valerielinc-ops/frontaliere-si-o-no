#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { withSingleFlightLock } from './single-flight-lock.mjs';

// Primo commit cambiato dalla riscrittura della storia. Potrà essere tolto
// solo dopo la riscrittura e la bonifica di tutti i clone e worktree che
// possono ancora conoscere la storia precedente.
export const OLD_HISTORY_FIRST_CHANGED_COMMIT = 'dab77221540a4e369440f762228be7e0be21155d';

const DEFAULT_BASE_REF = 'refs/remotes/origin/main';
const FETCH_TIMEOUT_MS = 30_000;
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
// The refresh the bounded proof starts from brings what the branch gained since
// the checkout: 0.7 to 2.7 seconds measured. A checkout that shares nothing
// with the branch would be sent its whole history instead, so the budget is
// short: past it the proof is abandoned and the complete check decides.
const BOUNDED_PROOF_FETCH_TIMEOUT_MS = 15_000;

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

function runGit(args, { cwd, stdio = 'ignore', timeout } = {}) {
  const output = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio,
    timeout,
  });
  return output ? output.trim() : '';
}

function commitExists(ref, cwd) {
  try {
    runGit(['cat-file', '-e', `${ref}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function isAncestor(ancestor, descendant, cwd) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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

function fetchCommitObject({ cwd, remote, commitRef }) {
  // A zero object ID is Git's deletion sentinel, not a fetchable commit. The
  // pre-push caller normally filters it, but the library also accepts direct
  // callers; classify it as an unavailable marker without asking the remote
  // to resolve an invalid ref.
  if (/^0{40}$/u.test(commitRef)) return false;
  try {
    runGit([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--filter=tree:0',
      remote,
      commitRef,
    ], { cwd, timeout: FETCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
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

function completeShallowHistory({ cwd, remote, headRef, branch }) {
  try {
    runGit([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--unshallow',
      '--filter=tree:0',
      remote,
      remoteHeadRef({ headRef, branch }),
    ], { cwd, timeout: HISTORY_GRAPH_FETCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = safeGitErrorDetail(error);
    throw new Error(`Impossibile completare il grafo della storia per verificare il marker: ${detail || 'errore git sconosciuto'}`);
  }
  if (isShallowRepository(cwd)) {
    throw new Error('Il checkout resta shallow dopo il fetch del grafo della storia; controllo non verificabile.');
  }
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
      runGit([
        'fetch',
        '--quiet',
        '--no-tags',
        '--filter=tree:0',
        remote,
        `+refs/heads/${branch}:${destinationRef}`,
      ], { cwd, timeout: FETCH_TIMEOUT_MS });
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

// The bounded proof is about the remote branch as it is now, so its base is
// refreshed first. No `--filter` here, on purpose: this is the fetch a data
// writer runs next anyway, and an ordinary fetch leaves the checkout the kind
// of clone `actions/checkout` made, not a treeless one. It also registers no
// promisor remote: a filtered fetch names that remote after its URL, and the
// callers that publish data pass a URL that carries their token (issue 12320).
function refreshBaseForBoundedProof({ cwd, remote, branch, baseRef }) {
  withHistoryGuardLock(cwd, () => {
    runGit([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      remote,
      `+refs/heads/${branch}:${baseRef}`,
    ], { cwd, timeout: BOUNDED_PROOF_FETCH_TIMEOUT_MS });
  });
}

/**
 * A shallow checkout whose head adds only known commits to the refreshed base
 * is decided here, in one ordinary fetch. Anything this cannot prove, including
 * a fetch that fails or times out, is left to the complete check below.
 */
function decideShallowWithoutHistoryGraph({ cwd, markerRef, headRef, baseRef, remote, branch, trace }) {
  try {
    timed(trace, 'refresh-base', () => refreshBaseForBoundedProof({ cwd, remote, branch, baseRef }));
  } catch {
    trace?.push({ step: 'bounded-proof', proven: false, why: 'base-refresh-failed' });
    return false;
  }
  const proof = proveHeadAddsNoOldHistory({ cwd, markerRef, headRef, baseRef });
  trace?.push({ step: 'bounded-proof', ...proof });
  return proof.proven;
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
  // Both of these answers are a shallow negative: the marker is not in the
  // checkout, or it is and no local path leads to it. Before paying for the
  // marker and for the whole commit graph, try the proof that needs neither.
  const shallowNegative = result.reason === 'marker-unavailable' || result.reason === 'marker-not-in-head';
  if (refreshBase && shallowNegative && isShallowRepository(cwd)
    && decideShallowWithoutHistoryGraph({ cwd, markerRef, headRef, baseRef, remote, branch, trace })) {
    return { outcome: 'pass', reason: 'head-adds-no-old-history' };
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
    timed(trace, 'complete-shallow-history', () => withHistoryGuardLock(cwd, () => completeShallowHistory({ cwd, remote, headRef, branch })));
    result = inspectOldHistory({ cwd, markerRef, headRef, baseRef });
  }
  const baseNeedsRefresh = result.reason === 'marker-in-base'
    || result.outcome === 'blocked'
    || result.outcome === 'base-unavailable';
  if (baseNeedsRefresh && refreshBase) {
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
  'refresh-base': 'aggiornamento del base',
  'fetch-marker': 'recupero del marker',
  'complete-shallow-history': 'completamento del grafo della storia',
};

// What the check cost and which proof decided it, on the same line as the
// verdict: a job that starts paying for the whole commit graph again shows it
// in its own log.
export function describeTrace(trace = []) {
  const parts = trace.map((entry) => {
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
    'head-adds-no-old-history': 'l’head aggiunge al base aggiornato solo commit già noti, e il marker non è fra questi; controllo superato senza scaricare il grafo.',
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
