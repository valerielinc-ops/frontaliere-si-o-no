#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { withSingleFlightLock } from './single-flight-lock.mjs';

// Primo commit cambiato dalla riscrittura della storia. Potrà essere tolto
// solo dopo la riscrittura e la bonifica di tutti i clone e worktree che
// possono ancora conoscere la storia precedente.
export const OLD_HISTORY_FIRST_CHANGED_COMMIT = 'dab77221540a4e369440f762228be7e0be21155d';

const DEFAULT_BASE_REF = 'refs/remotes/origin/main';
const FETCH_TIMEOUT_MS = 30_000;

const OLD_HISTORY_REMEDIATION = [
  'Ricrea il branch da origin/main aggiornato e riporta solo i tuoi commit con:',
  '  git rebase --onto origin/main <vecchia base> <branch>',
  'oppure ricrea il branch da origin/main e riporta i tuoi commit.',
].join('\n');

const OLD_HISTORY_BLOCK_MESSAGE = 'Controllo storia precedente fallito: il branch della PR contiene la storia precedente alla riscrittura, ma il base aggiornato non la contiene.';

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

function markerIsAncestorOfHead({ cwd, markerRef, headRef }) {
  if (!commitExists(markerRef, cwd)) return { markerAvailable: false, markerInHead: false };
  if (!commitExists(headRef, cwd)) {
    throw new Error(`HEAD '${headRef}' non è disponibile nel checkout.`);
  }
  return { markerAvailable: true, markerInHead: isAncestor(markerRef, headRef, cwd) };
}

/**
 * Answers the history question without changing refs or the working tree.
 * `base-unavailable` lets the CLI refresh the base before deciding; a missing
 * marker is an intentional pass because GitHub may already have discarded it.
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
  return runGit(['rev-parse', '--git-common-dir'], { cwd });
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
  const lockPath = resolve(cwd, gitCommonDir(cwd), 'frontaliere-old-history-guard.lock');
  const result = withSingleFlightLock(lockPath, () => {
    runGit([
      'fetch',
      '--quiet',
      '--no-tags',
      '--filter=tree:0',
      remote,
      `+refs/heads/${branch}:${destinationRef}`,
    ], { cwd, timeout: FETCH_TIMEOUT_MS });
  });
  if (!result.acquired) {
    throw new Error('non è stato possibile acquisire il lock per aggiornare il base ref.');
  }
}

export function checkOldHistory({
  cwd = process.cwd(),
  markerRef = OLD_HISTORY_FIRST_CHANGED_COMMIT,
  headRef = 'HEAD',
  baseRef = DEFAULT_BASE_REF,
  refreshBase = false,
  remote = 'origin',
  branch = 'main',
} = {}) {
  let result = inspectOldHistory({ cwd, markerRef, headRef, baseRef });
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

function printResult(result) {
  if (result.outcome === 'blocked') {
    console.error(`::error::${OLD_HISTORY_BLOCK_MESSAGE}`);
    console.error(OLD_HISTORY_REMEDIATION);
    return 1;
  }

  const messages = {
    'marker-unavailable': 'il marker non è disponibile nel checkout remoto; controllo superato.',
    'marker-not-in-head': 'il marker non è antenato dell’head; controllo superato.',
    'marker-in-base': 'il marker è ancora antenato del base; controllo inerte prima della riscrittura.',
  };
  console.log(`old-history-guard: ${messages[result.reason] || 'controllo superato.'}`);
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
  try {
    const result = checkOldHistory(parseArgs(argv));
    process.exitCode = printResult(result);
  } catch (error) {
    console.error(`::error::Controllo storia precedente non verificabile: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
