#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * The Firebase CLI can receive an HTML error page from the Google APIs while
 * updating one function.  It reports that response as a JSON parse failure;
 * the deployment is otherwise idempotent, so one bounded retry is safe.
 */
export const FIREBASE_DEPLOY_ARGS = Object.freeze([
  'deploy',
  '--only',
  'functions',
  '--project',
  'frontaliere-ticino',
  '--force',
]);

export const MAX_ATTEMPTS = 2;
export const FIREBASE_RETRY_DELAY_MS = 30_000;

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
 * Deploy Cloud Functions, retrying only the known transient API response.
 *
 * @param {{
 *   run?: (args: string[], attempt: number) => Promise<{exitCode?: number, output?: string}>,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 * }} [options]
 * @returns {Promise<{exitCode: number, output: string, attempts: number}>}
 */
export async function deployFunctions({
  run = (args) => runFirebaseCli('firebase', args),
  sleep = delay,
  maxAttempts = MAX_ATTEMPTS,
  retryDelayMs = FIREBASE_RETRY_DELAY_MS,
} = {}) {
  let lastResult = { exitCode: 1, output: '' };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await run(FIREBASE_DEPLOY_ARGS, attempt);
    const exitCode = Number.isInteger(lastResult?.exitCode) ? lastResult.exitCode : 1;
    const output = String(lastResult?.output ?? '');

    if (exitCode === 0) {
      return { exitCode: 0, output, attempts: attempt };
    }

    const retryable = isTransientFirebaseApiHtmlFailure(output);
    if (!retryable || attempt >= maxAttempts) {
      return { exitCode, output, attempts: attempt };
    }

    const waitMs = retryDelayMs * attempt;
    console.warn(
      `Firebase Functions deploy hit a transient HTML API response; retrying in ${waitMs}ms `
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

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const result = await deployFunctions();
  if (result.exitCode !== 0) process.exitCode = result.exitCode || 1;
}
