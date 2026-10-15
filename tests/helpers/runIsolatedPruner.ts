import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Node permissions block direct out-of-fixture fs writes, but NOT child
// processes or symlink escapes. On macOS the OS sandbox additionally restricts
// the entire process tree (including symlink targets). Elsewhere fixtures must
// still use local bare remotes and fake gh/lsof, never production repos.
export function isolatedPrunerArgs(root: string): string[] {
  const canonical = fs.realpathSync(root);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), canonical);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Pruner fixture must be a dedicated directory below os.tmpdir()');
  }
  const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission')
    ? '--permission' : '--experimental-permission';
  return [permissionFlag, '--allow-fs-read=*',
    `--allow-fs-write=${canonical}`, '--allow-child-process'];
}

export function runIsolatedPruner(
  script: string, args: string[], root: string, cwd: string, env: NodeJS.ProcessEnv,
): string {
  const canonicalRoot = fs.realpathSync(root);
  const relative = path.relative(canonicalRoot, fs.realpathSync(cwd));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Pruner cwd must belong to its fixture');
  }
  const fixtureEnv: NodeJS.ProcessEnv = { ...env, FRONTALIERE_WORKSPACE: canonicalRoot };
  delete fixtureEnv.NODE_OPTIONS;
  delete fixtureEnv.FRONTALIERE_SITE_HOOKS_DIR;
  const nodeArgs = [...isolatedPrunerArgs(root), script, ...args];
  const command = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : process.execPath;
  // Fail closed on macOS if sandbox-exec is missing/unusable: no fallback.
  const commandArgs = process.platform === 'darwin'
    ? ['-p', `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(canonicalRoot)}) (literal "/dev/null"))`,
      process.execPath, ...nodeArgs]
    : nodeArgs;
  return execFileSync(command, commandArgs, {
    cwd, env: fixtureEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90_000,
  });
}
