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
try {
  execFileSync('git', ['check-ref-format', `refs/heads/${branch}`], {
    stdio: 'ignore',
  });
} catch {
  console.error(`ref remoto non valido: ${branch}`);
  process.exit(64);
}

let commonDir;
try {
  const raw = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  commonDir = realpathSync(resolve(repoRoot, raw));
} catch {
  console.error('directory Git comune non verificabile; rifiuto di creare un worktree da un ref forse obsoleto.');
  process.exit(69);
}

const lockPath = join(commonDir, 'frontaliere-prune-fetch.lock');
const result = withSingleFlightLock(lockPath, () => {
  try {
    execFileSync('git', [
      '-C', repoRoot,
      'fetch',
      '--quiet',
      '--no-tags',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ], {
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
  console.error(`fetch concorrente in corso (${lockPath}); riprova dopo il suo completamento, senza usare il ref locale.`);
  process.exit(75);
} else if (!result.value) {
  console.error(`fetch origin/${branch} non riuscito; rifiuto di creare un worktree da un ref forse obsoleto.`);
  process.exit(1);
}
