#!/usr/bin/env node

/**
 * Pull the corpus and its published HTTP artifacts as one pinned pair.
 * A moving manifest or a mismatched artifact snapshot retries both pulls, up to
 * a fixed cap.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { retryArticleSyncPair } from '../lib/articles-sync-retry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRE_SUCCESS = process.argv.includes('--require-success');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'articles-sync-pair-'));

// These are runtime entrypoints even though the driver runs them in isolated
// child processes. The checkout analyzer consumes this explicit root-relative
// declaration so their import closure (including TypeScript) stays materialised.
export const CHECKOUT_CHILD_ENTRYPOINTS = Object.freeze([
  'scripts/pull-articles-corpus.mjs',
  'scripts/pull-articles-api.mjs',
]);

function readKeyValues(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function appendGitHubFile(envName, line) {
  const file = process.env[envName];
  if (file) fs.appendFileSync(file, `${line}\n`);
}

function writeOutput(name, value) {
  const flat = String(value).replace(/\s*\n\s*/g, ' ').trim();
  appendGitHubFile('GITHUB_OUTPUT', `${name}=${flat}`);
}

function runPull(scriptName, { attempt, commit = null }) {
  const stem = `${attempt}-${scriptName.replace(/[^a-z0-9]+/gi, '-')}`;
  const outputFile = path.join(TEMP_ROOT, `${stem}.out`);
  const envFile = path.join(TEMP_ROOT, `${stem}.env`);
  fs.writeFileSync(outputFile, '');
  fs.writeFileSync(envFile, '');

  const childEnv = { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_ENV: envFile };
  delete childEnv.ARTICLES_SYNC_COMMIT;
  if (commit) childEnv.ARTICLES_SYNC_COMMIT = commit;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      const outputs = readKeyValues(outputFile);
      const env = readKeyValues(envFile);
      resolve({
        exitCode: exitCode ?? 1,
        skipped: outputs.skipped === 'true',
        reason: outputs['retry-reason'] || outputs['skip-reason'],
        retryableSnapshot: outputs['retryable-snapshot'] === 'true',
        commit: env.ARTICLES_SYNC_COMMIT || null,
      });
    };

    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', scriptName)], {
      cwd: ROOT,
      env: childEnv,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      console.error(`[pull-articles-surface] could not start ${scriptName}: ${error.message}`);
      finish(1);
    });
    child.once('close', finish);
  });
}

try {
  const result = await retryArticleSyncPair({
    runCorpus: ({ attempt }) => runPull('pull-articles-corpus.mjs', { attempt }),
    runApi: ({ attempt, commit }) => runPull('pull-articles-api.mjs', { attempt, commit }),
    onRetry: ({ nextAttempt, reason }) => {
      console.log(`::notice::[pull-articles-surface] ${reason}; retrying the pinned pair (${nextAttempt}/3)`);
    },
  });

  if (result.status === 'success') {
    appendGitHubFile('GITHUB_ENV', `ARTICLES_SYNC_COMMIT=${result.commit}`);
    writeOutput('skipped', 'false');
    writeOutput('attempts', result.attempts);
    console.log(`[pull-articles-surface] corpus and HTTP artifacts match ${result.commit} after ${result.attempts} attempt(s)`);
  } else if (result.status === 'skipped') {
    writeOutput('skipped', 'true');
    writeOutput('skip-reason', result.reason);
    writeOutput('attempts', result.attempts);
    console.warn(`::warning::[pull-articles-surface] sync skipped, nothing committed — ${result.reason}`);
    if (REQUIRE_SUCCESS) process.exitCode = 1;
  } else {
    console.error(`[pull-articles-surface] ${result.stage} pull failed${result.reason ? `: ${result.reason}` : ''}`);
    process.exitCode = result.exitCode || 1;
  }
} finally {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
}
