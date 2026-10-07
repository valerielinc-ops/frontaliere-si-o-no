#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { withSingleFlightLock } from '../lib/single-flight-lock.mjs';

// Il pre-push deve aggiornare origin/main prima del controllo, ma più sessioni
// possono spingere dallo stesso clone. Il lock evita fetch concorrenti; il
// timeout impedisce che una rete bloccata trattenga il push indefinitamente.
const FETCH_TIMEOUT_MS = 30_000;

function gitCommonDir() {
  return execFileSync('git', ['rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

try {
  const lockPath = resolve(gitCommonDir(), 'frontaliere-pre-push-origin-main.lock');
  const result = withSingleFlightLock(lockPath, () => {
    execFileSync('git', ['fetch', '--quiet', '--no-tags', 'origin', 'main'], {
      stdio: 'ignore',
      timeout: FETCH_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
  });

  if (!result.acquired) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
