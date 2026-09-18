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

const NATIVE_AUTOMERGE_EXECUTABLE_FILES = Object.freeze(
  NATIVE_AUTOMERGE_SOURCE_FILES.filter((file) => file.endsWith('.mjs')),
);
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
 * @param {{syntaxCheck?: (file: string) => void}} options
 * @returns {{root: string, helperDir: string, files: readonly string[]}}
 */
export function validateNativeAutoMergeSource(sourceRoot, { syntaxCheck: check = syntaxCheck } = {}) {
  if (typeof sourceRoot !== 'string' || sourceRoot.trim() === '') {
    throw new TypeError('root della sorgente native auto-merge mancante');
  }
  if (typeof check !== 'function') {
    throw new TypeError('syntaxCheck deve essere una funzione');
  }

  const root = resolve(sourceRoot);
  const unavailable = [];
  for (const file of NATIVE_AUTOMERGE_SOURCE_FILES) {
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
      if (NATIVE_AUTOMERGE_EXECUTABLE_FILES.includes(file)) {
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
    files: NATIVE_AUTOMERGE_SOURCE_FILES,
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
  const validated = validateNativeAutoMergeSource(sourceRoot);
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
  console.log(`Native auto-merge source validated from main checkout (${head}); ${validated.files.length} files ready.`);
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
