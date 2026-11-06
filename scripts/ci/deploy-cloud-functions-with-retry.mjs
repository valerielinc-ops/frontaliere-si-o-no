#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';

import { spawn } from 'node:child_process';

const FUNCTIONS_INDEX_URL = new URL('../../functions/index.js', import.meta.url);

/**
 * Firebase CLI 15.32.0 updates a whole codebase through an internal queue with
 * concurrency 40.  A large codebase can therefore exhaust the regional Cloud
 * Run read and Cloud Functions mutation quotas before the queue drains.  Keep
 * each invocation below that burst size and leave a short gap between batches.
 * The values are deliberately constants: changing either changes the
 * production API-rate contract and must be reviewed with the quota evidence.
 */
export const FUNCTION_BATCH_SIZE = 8;
export const FUNCTION_BATCH_DELAY_MS = 2_000;

export const FIREBASE_DEPLOY_ARGS = Object.freeze([
  'deploy',
  '--project',
  'frontaliere-ticino',
  '--force',
]);

export const MAX_ATTEMPTS = 2;
export const FIREBASE_RETRY_DELAY_MS = 30_000;

const FUNCTION_EXPORT_RE = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/gmu;
const TOP_LEVEL_EXPORT_RE = /^export\b/gmu;
const TRIGGER_INITIALIZER_RE = /^(?:on[A-Z][A-Za-z0-9]*|functionsV1\.runWith)\b/u;
const FUNCTION_TARGET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * Parse the deployable top-level exports without importing application code.
 * Unknown export shapes fail closed rather than silently omitting a function
 * from a production deploy.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseFunctionNames(source) {
  const matches = [...String(source ?? '').matchAll(FUNCTION_EXPORT_RE)];
  const allExports = [...String(source ?? '').matchAll(TOP_LEVEL_EXPORT_RE)];
  if (matches.length === 0) {
    throw new Error('No top-level Cloud Functions exports found in functions/index.js');
  }
  if (allExports.length !== matches.length) {
    throw new Error('Unsupported top-level export shape in functions/index.js; refusing a partial deploy');
  }

  const names = matches.map((match) => match[1]);
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(`Duplicate Cloud Functions export(s): ${[...new Set(duplicateNames)].join(', ')}`);
  }

  const invalidNames = names.filter((name) => !FUNCTION_TARGET_NAME_RE.test(name));
  if (invalidNames.length > 0) {
    throw new Error(`Invalid Cloud Functions target name(s): ${invalidNames.join(', ')}`);
  }

  const unsupportedInitializers = matches
    .filter((match) => !TRIGGER_INITIALIZER_RE.test(match[2].trim()))
    .map((match) => match[1]);
  if (unsupportedInitializers.length > 0) {
    throw new Error(
      `Unsupported Cloud Functions initializer(s): ${unsupportedInitializers.join(', ')}; refusing a partial deploy`,
    );
  }

  return names;
}

export const FUNCTION_NAMES = Object.freeze(
  parseFunctionNames(readFileSync(FUNCTIONS_INDEX_URL, 'utf8')),
);

/**
 * @param {string[]} values
 * @param {number} size
 * @returns {string[][]}
 */
export function chunkFunctionNames(values, size = FUNCTION_BATCH_SIZE) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Function batch size must be a positive integer, got ${size}`);
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('At least one Cloud Functions export is required');
  }
  const batches = [];
  for (let offset = 0; offset < values.length; offset += size) {
    batches.push(values.slice(offset, offset + size));
  }
  return batches;
}

/**
 * @param {string[]} names
 * @returns {string[]}
 */
export function buildFirebaseDeployArgs(names) {
  const batch = chunkFunctionNames(names, names.length);
  return [
    ...FIREBASE_DEPLOY_ARGS,
    '--only',
    batch[0].map((name) => `functions:${name}`).join(','),
  ];
}

/**
 * Match only the observed transient signature.  Other Firebase failures must
 * stay fail-closed instead of being hidden behind a generic retry.
 *
 * @param {unknown} output
 * @returns {boolean}
 */
export function isTransientFirebaseApiHtmlFailure(output) {
  const text = String(output ?? '');
  return /Unable to parse JSON\b.*Unexpected token\s+['"]?</iu.test(text)
    && /<!DOCTYPE\b/iu.test(text);
}

/**
 * Quota exhaustion is transient and the scoped deploy is idempotent.  Keep
 * the match tied to both the status and quota wording so permission/IAM
 * failures remain fatal and visible.
 *
 * @param {unknown} output
 * @returns {boolean}
 */
export function isTransientFirebaseQuotaFailure(output) {
  const text = String(output ?? '');
  return /\b(?:HTTP\s+Error:\s*)?429\b/iu.test(text)
    && /quota\s+exceed(?:ed|s)|quota\s+exhaust(?:ed|ion)|per\s+project\s+mutation\s+requests|read\s+requests\s+per\s+minute/iu.test(text);
}

/**
 * @param {unknown} output
 * @returns {boolean}
 */
export function isTransientFirebaseFailure(output) {
  return isTransientFirebaseApiHtmlFailure(output) || isTransientFirebaseQuotaFailure(output);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Run a child process while preserving the CLI output in the Actions log.
 * Keeping the output also lets the retry decision use the exact failure
 * emitted by Firebase CLI, without guessing from the exit code alone.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{exitCode: number, output: string}>}
 */
export function runFirebaseCli(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;

    const forward = (stream, target) => {
      stream?.on('data', (chunk) => {
        output += String(chunk);
        target.write(chunk);
      });
    };

    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveRun(result);
    };

    child.once('error', (error) => {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      output += message;
      process.stderr.write(`${message}\n`);
      finish({ exitCode: 1, output });
    });
    child.once('close', (code) => {
      finish({ exitCode: Number.isInteger(code) ? code : 1, output });
    });
  });
}

/**
 * Deploy one bounded function batch, retrying only known transient failures.
 *
 * @param {{
 *   names: string[],
 *   run: (args: string[], attempt: number, names: string[]) => Promise<{exitCode?: number, output?: string}>,
 *   sleep: (ms: number) => Promise<void>,
 *   maxAttempts: number,
 *   retryDelayMs: number,
 * }} options
 * @returns {Promise<{exitCode: number, output: string, attempts: number}>}
 */
async function deployFunctionBatch({ names, run, sleep, maxAttempts, retryDelayMs }) {
  let lastResult = { exitCode: 1, output: '' };
  const args = buildFirebaseDeployArgs(names);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await run(args, attempt, names);
    const exitCode = Number.isInteger(lastResult?.exitCode) ? lastResult.exitCode : 1;
    const output = String(lastResult?.output ?? '');

    if (exitCode === 0) {
      return { exitCode: 0, output, attempts: attempt };
    }

    if (!isTransientFirebaseFailure(output) || attempt >= maxAttempts) {
      return { exitCode, output, attempts: attempt };
    }

    const waitMs = retryDelayMs * attempt;
    console.warn(
      `Firebase Functions batch hit a bounded transient API failure; retrying in ${waitMs}ms `
      + `(attempt ${attempt + 1}/${maxAttempts}).`,
    );
    await sleep(waitMs);
  }

  return {
    exitCode: Number.isInteger(lastResult?.exitCode) ? lastResult.exitCode : 1,
    output: String(lastResult?.output ?? ''),
    attempts: maxAttempts,
  };
}

/**
 * Deploy Cloud Functions in bounded target batches, retrying only known
 * transient API responses. A failed batch stops the deployment so no later
 * batch can be mistaken for a complete production release.
 *
 * @param {{
 *   run?: (args: string[], attempt: number, names: string[]) => Promise<{exitCode?: number, output?: string}>,
 *   sleep?: (ms: number) => Promise<void>,
 *   functionNames?: string[],
 *   batchSize?: number,
 *   batchDelayMs?: number,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 * }} [options]
 * @returns {Promise<{exitCode: number, output: string, attempts: number, batches: number}>}
 */
export async function deployFunctions({
  run = (args) => runFirebaseCli('firebase', args),
  sleep = delay,
  functionNames = FUNCTION_NAMES,
  batchSize = FUNCTION_BATCH_SIZE,
  batchDelayMs = FUNCTION_BATCH_DELAY_MS,
  maxAttempts = MAX_ATTEMPTS,
  retryDelayMs = FIREBASE_RETRY_DELAY_MS,
} = {}) {
  const batches = chunkFunctionNames(functionNames, batchSize);
  let output = '';
  let attempts = 0;

  for (let index = 0; index < batches.length; index += 1) {
    const names = batches[index];
    console.log(
      `Deploying Cloud Functions batch ${index + 1}/${batches.length} `
      + `(${names.length} functions).`,
    );
    const result = await deployFunctionBatch({
      names,
      run,
      sleep,
      maxAttempts,
      retryDelayMs,
    });
    output += `${result.output}${result.output.endsWith('\n') ? '' : '\n'}`;
    attempts += result.attempts;

    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, output, attempts, batches: index + 1 };
    }

    if (index + 1 < batches.length && batchDelayMs > 0) {
      await sleep(batchDelayMs);
    }
  }

  return { exitCode: 0, output, attempts, batches: batches.length };
}

const isMain = process.argv[1]
  && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();

if (isMain) {
  const result = await deployFunctions();
  if (result.exitCode !== 0) process.exitCode = result.exitCode || 1;
}
