// Inventario diagnostico dei temporanei del workspace. L'età non autorizza
// cancellazioni. I worktree appartengono soltanto al pruner con prove Git.

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const STALE_WORKSPACE_ARTIFACT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function defaultWorkspaceRoot({ repoRoot = process.cwd() } = {}) {
  return resolve(process.env.FRONTALIERE_WORKSPACE_ROOT || dirname(repoRoot));
}

export function workspacePruneTargets(workspaceRoot = defaultWorkspaceRoot()) {
  return [
    { name: 'workspace-tmp', root: join(workspaceRoot, 'tmp') },
  ];
}

function listChildren(root, readDir = readdirSync) {
  try { return readDir(root, { withFileTypes: true }); } catch { return []; }
}

function inspectTree(root, { stat = lstatSync, readDir = readdirSync } = {}) {
  const stack = [root];
  let latestMtimeMs = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    let st;
    try { st = stat(current); } catch { return null; }
    latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs);
    if (!st.isDirectory()) { bytes += st.size; continue; }
    let entries;
    try { entries = readDir(current, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) stack.push(join(current, entry.name));
    }
  }
  return { latestMtimeMs, bytes };
}

function activeCwds({ exec = execFileSync } = {}) {
  try {
    const output = process.platform === 'win32'
      ? exec('wmic', ['process', 'get', 'ExecutablePath,CommandLine'], { encoding: 'utf8' })
      : exec('lsof', ['-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    if (process.platform === 'win32') return null;
    return output.split('\n').filter((line) => line.startsWith('n')).map((line) => resolve(line.slice(1)));
  } catch {
    return null;
  }
}

function containsPath(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function listStaleWorkspaceArtifacts({
  workspaceRoot = defaultWorkspaceRoot(),
  now = Date.now(),
  maxAgeMs = STALE_WORKSPACE_ARTIFACT_AGE_MS,
  activePaths = activeCwds(),
  ...options
} = {}) {
  // Se non possiamo osservare i cwd, non assumiamo che una directory sia libera.
  if (activePaths === null) return [];
  const cutoff = now - maxAgeMs;
  const result = [];
  for (const target of workspacePruneTargets(workspaceRoot)) {
    for (const entry of listChildren(target.root, options.readDir ?? readdirSync)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(target.root, entry.name);
      if (activePaths.some((cwd) => containsPath(path, cwd))) continue;
      const info = inspectTree(path, options);
      if (info && info.latestMtimeMs < cutoff) result.push({ ...target, path, bytes: info.bytes });
    }
  }
  return result;
}

/** @param {Parameters<typeof listStaleWorkspaceArtifacts>[0] & { apply?: boolean }} [options] */
export function sweepStaleWorkspaceArtifacts({ apply = false, ...options } = {}) {
  if (apply) throw new Error('Global workspace cleanup disabled: age is not deletion authority');
  const candidates = listStaleWorkspaceArtifacts(options);
  return { candidates, removed: 0, bytes: 0 };
}
