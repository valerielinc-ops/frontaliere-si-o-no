#!/usr/bin/env node
// Fetch single-flight condiviso con prune-merged-worktrees.mjs: la creazione
// simultanea di worktree non deve avviare un trasferimento per ogni sessione.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { withSingleFlightLock } from '../lib/single-flight-lock.mjs';

const [repoRootArg, branch] = process.argv.slice(2);
if (!repoRootArg || !branch) {
  console.error('usage: fetch-origin-main.mjs REPO_ROOT BRANCH');
  process.exit(64);
}

const repoRoot = realpathSync(repoRootArg);
let commonDir;
try {
  const raw = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  commonDir = realpathSync(resolve(repoRoot, raw));
} catch {
  console.error('ℹ️  fetch saltato: directory Git comune non verificabile; uso il ref locale disponibile.');
  process.exit(0);
}

const lockPath = join(commonDir, 'frontaliere-prune-fetch.lock');
const result = withSingleFlightLock(lockPath, () => {
  try {
    execFileSync('git', ['-C', repoRoot, 'fetch', '--quiet', 'origin', branch], {
      stdio: 'ignore',
      timeout: 25 * 60 * 1000,
      killSignal: 'SIGTERM',
    });
    return true;
  } catch {
    return false;
  }
});

if (!result.acquired) {
  console.error(`ℹ️  fetch saltato: un'altra istanza tiene ${lockPath}; uso il ref origin/${branch} locale.`);
} else if (!result.value) {
  console.error(`⚠️  fetch origin/${branch} non riuscito; uso il ref locale disponibile.`);
}
