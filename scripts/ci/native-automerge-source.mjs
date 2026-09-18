#!/usr/bin/env node
/**
 * Validate the small, trusted source tree used by the native auto-merge
 * workflows.
 *
 * The workflows check out `main` into a dedicated sparse/partial worktree
 * before invoking this file. The source list is intentionally explicit: a
 * missing, empty, symlinked, or syntactically invalid helper fails the job
 * closed, so no later step can accidentally run a partial gate.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const NATIVE_AUTOMERGE_SOURCE_CHECKOUT_DIR = 'native-automerge-main';

// Keep the eight gate helpers together as a named contract. The two Remote
// Config files, this validator, and the ledger registry are runtime support
// for that same gate and are included in the complete source list below.
export const NATIVE_AUTOMERGE_HELPER_FILES = Object.freeze([
  'scripts/ci/native-automerge-gate.mjs',
  'scripts/ci/review-test-policy.mjs',
  'scripts/ci/lib/automation-risk-policy.mjs',
  'scripts/ci/lib/fetchPrFiles.mjs',
  'scripts/ci/lib/vitestCheck.mjs',
  'scripts/ci/lib/constants.mjs',
  'scripts/ci/lib/pr-review-admission.mjs',
  'scripts/lib/loop-fleet-contract.mjs',
]);

export const NATIVE_AUTOMERGE_SOURCE_FILES = Object.freeze([
  'scripts/ci/native-automerge-source.mjs',
  'scripts/load-rc-env.mjs',
  'scripts/lib/google-service-account-token.mjs',
  ...NATIVE_AUTOMERGE_HELPER_FILES,
  'data/loop-fleet/loop-registry.json',
]);

/**
 * The same trusted source list, minus the two Remote Config files, for the
 * caller that opts a PR in from INSIDE the required `tests` job.
 *
 * That caller does not read Remote Config: it uses the App token already minted
 * in its job, because `scripts/load-rc-env.mjs` may not enter `tests.yml` at all
 * — it writes ~92 variables to `$GITHUB_ENV`, visible to every later step of the
 * same job, and that pollution once turned 14 tests red across 11 files. The
 * invariant is defended by `tests/ci-vitest-check-name.test.ts`; naming the
 * loader even in a checkout cone would trip it, so the in-job profile does not
 * fetch it. This is a SUBSET, never a relaxation: it still contains every file
 * the gate can execute or import (the eight helpers are import-closed over this
 * list, and the loader is only ever executed by a workflow step, never
 * imported), and a missing or invalid one still fails the job closed.
 */
export const NATIVE_AUTOMERGE_IN_JOB_SOURCE_FILES = Object.freeze([
  'scripts/ci/native-automerge-source.mjs',
  ...NATIVE_AUTOMERGE_HELPER_FILES,
  'data/loop-fleet/loop-registry.json',
]);

export const NATIVE_AUTOMERGE_SOURCE_PROFILES = Object.freeze({
  full: NATIVE_AUTOMERGE_SOURCE_FILES,
  'in-job': NATIVE_AUTOMERGE_IN_JOB_SOURCE_FILES,
});

const UNAVAILABLE_SOURCE_CODE = 'ERR_NATIVE_AUTOMERGE_SOURCE_UNAVAILABLE';

function pathInsideRoot(root, file) {
  const candidate = resolve(root, file);
  const rootPrefix = `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new Error(`percorso source fuori dalla root: ${file}`);
  }
  return candidate;
}

function syntaxCheck(file) {
  execFileSync(process.execPath, ['--check', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function errorText(error) {
  const details = [error?.stderr, error?.stdout, error?.message, error]
    .map((value) => String(value ?? '').trim())
    .find(Boolean) || 'errore non specificato';
  return details.replace(/\s+/gu, ' ').slice(0, 240);
}

function unavailableError(root, unavailable) {
  const error = new Error(
    `Sorgente native auto-merge non disponibile in ${root}: ${unavailable
      .map(({ file, reason }) => `${file} (${reason})`)
      .join(', ')}`,
  );
  error.code = UNAVAILABLE_SOURCE_CODE;
  error.unavailable = unavailable;
  return error;
}

/**
 * Validate the exact files that the native gate may execute or import.
 *
 * @param {string} sourceRoot absolute or relative checkout root
 * @param {{syntaxCheck?: (file: string) => void, files?: readonly string[]}} options
 * @returns {{root: string, helperDir: string, files: readonly string[]}}
 */
export function validateNativeAutoMergeSource(sourceRoot, {
  syntaxCheck: check = syntaxCheck,
  files = NATIVE_AUTOMERGE_SOURCE_FILES,
} = {}) {
  if (typeof sourceRoot !== 'string' || sourceRoot.trim() === '') {
    throw new TypeError('root della sorgente native auto-merge mancante');
  }
  if (typeof check !== 'function') {
    throw new TypeError('syntaxCheck deve essere una funzione');
  }
  if (!Array.isArray(files) || files.length === 0
    || files.some((file) => !NATIVE_AUTOMERGE_SOURCE_FILES.includes(file))) {
    throw new TypeError('lista sorgente native auto-merge non riconosciuta');
  }

  const root = resolve(sourceRoot);
  const unavailable = [];
  for (const file of files) {
    const absolute = pathInsideRoot(root, file);
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile()) {
        throw new Error('non è un file regolare');
      }
      const contents = readFileSync(absolute, 'utf8');
      if (contents.trim() === '') {
        throw new Error('file vuoto');
      }
      if (file.endsWith('.mjs')) {
        check(absolute);
      } else if (file.endsWith('.json')) {
        JSON.parse(contents);
      }
    } catch (error) {
      unavailable.push({ file, reason: errorText(error) });
    }
  }

  if (unavailable.length > 0) {
    throw unavailableError(root, unavailable);
  }

  return Object.freeze({
    root,
    helperDir: join(root, 'scripts/ci'),
    files: Object.freeze([...files]),
  });
}

/**
 * Make the validated source paths available to later Actions steps.
 */
export function persistNativeAutoMergeEnvironment(validated, envFile) {
  if (!validated || typeof validated.root !== 'string' || typeof validated.helperDir !== 'string') {
    throw new TypeError('sorgente native auto-merge non validata');
  }
  if (typeof envFile !== 'string' || envFile.trim() === '') {
    throw new TypeError('file GITHUB_ENV mancante');
  }
  appendFileSync(envFile, [
    `NATIVE_AUTOMERGE_SOURCE_ROOT=${validated.root}`,
    `NATIVE_AUTOMERGE_HELPER_DIR=${validated.helperDir}`,
    '',
  ].join('\n'));
}

function main() {
  const sourceRoot = process.env.NATIVE_AUTOMERGE_SOURCE_ROOT
    || process.argv[2]
    || resolve(process.cwd(), NATIVE_AUTOMERGE_SOURCE_CHECKOUT_DIR);
  const profile = process.env.NATIVE_AUTOMERGE_SOURCE_PROFILE || 'full';
  const files = NATIVE_AUTOMERGE_SOURCE_PROFILES[profile];
  if (!files) {
    throw new Error(`profilo sorgente native auto-merge sconosciuto: ${profile}`);
  }
  const validated = validateNativeAutoMergeSource(sourceRoot, { files });
  persistNativeAutoMergeEnvironment(validated, process.env.GITHUB_ENV);
  const head = (() => {
    try {
      return execFileSync('git', ['-C', validated.root, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return 'unknown-head';
    }
  })();
  console.log(`Native auto-merge source validated from main checkout (${head}); profile=${profile}; ${validated.files.length} files ready.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    const code = error?.code === UNAVAILABLE_SOURCE_CODE ? error.code : 'ERR_NATIVE_AUTOMERGE_SOURCE_LOAD';
    console.error(`::error::${code}: ${errorText(error)}`);
    process.exitCode = 1;
  }
}
