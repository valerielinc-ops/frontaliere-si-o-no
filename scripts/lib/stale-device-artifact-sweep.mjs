// Inventario diagnostico, NON prova di eliminabilità. Nessuna cancellazione:
// anche una cache vecchia può contenere dati non recuperabili.

import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const STALE_DEVICE_ARTIFACT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function treeInfo(path, { stat = lstatSync, readDir = readdirSync } = {}) {
  let st;
  try { st = stat(path); } catch { return { latestMtimeMs: 0, bytes: 0 }; }
  if (!st.isDirectory()) return { latestMtimeMs: st.mtimeMs, bytes: st.size };

  let latestMtimeMs = st.mtimeMs;
  let bytes = 0;
  for (const entry of listChildren(path, readDir)) {
    if (entry.isSymbolicLink()) continue;
    const child = treeInfo(join(path, entry.name), { stat, readDir });
    latestMtimeMs = Math.max(latestMtimeMs, child.latestMtimeMs);
    bytes += child.bytes;
  }
  return { latestMtimeMs, bytes };
}

function listChildren(root, readDir = readdirSync) {
  try { return readDir(root, { withFileTypes: true }); } catch { return []; }
}

// Report old entries below a diagnostic root. A directory is reported as one
// unit only when its complete subtree is stale; this is NOT deletion authority.
function listStaleTree(root, cutoff, options = {}) {
  const { stat = lstatSync, readDir = readdirSync } = options;
  const stale = [];
  function inspect(path) {
    let st;
    try { st = stat(path); } catch { return { latestMtimeMs: 0, bytes: 0 }; }
    if (!st.isDirectory()) return { latestMtimeMs: st.mtimeMs, bytes: st.size };

    let latestMtimeMs = st.mtimeMs;
    let bytes = 0;
    for (const entry of listChildren(path, readDir)) {
      if (entry.isSymbolicLink()) continue;
      const childPath = join(path, entry.name);
      const child = inspect(childPath);
      latestMtimeMs = Math.max(latestMtimeMs, child.latestMtimeMs);
      bytes += child.bytes;
    }
    return { latestMtimeMs, bytes };
  }

  function visit(parent) {
    for (const entry of listChildren(parent, readDir)) {
      if (entry.isSymbolicLink()) continue;
      const path = join(parent, entry.name);
      const info = inspect(path);
      if (info.latestMtimeMs < cutoff) stale.push({ path, bytes: info.bytes });
      else if (entry.isDirectory()) visit(path);
    }
  }
  visit(resolve(root));
  return stale;
}

function activeCommandLines({ exec = execFileSync } = {}) {
  try {
    if (process.platform === 'win32') return exec('tasklist', ['/fo', 'csv'], { encoding: 'utf8' });
    return exec('ps', ['-axo', 'command='], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function protectedReleasePaths(packageRoot, { stat = lstatSync, readLink = readlinkSync, realPath = realpathSync } = {}) {
  const protectedPaths = new Set();
  const releases = join(packageRoot, 'releases');
  for (const name of ['current']) {
    const pointer = join(packageRoot, name);
    try { protectedPaths.add(realPath(pointer)); } catch {
      try { protectedPaths.add(resolve(dirname(pointer), readLink(pointer))); } catch { /* absent */ }
    }
  }
  const commands = activeCommandLines();
  if (commands === null) {
    // Se non possiamo osservare i processi, non cancelliamo release: fail-safe.
    for (const entry of listChildren(releases)) if (entry.isDirectory()) protectedPaths.add(join(releases, entry.name));
  } else {
    for (const entry of listChildren(releases)) {
      if (entry.isDirectory() && commands.includes(join(releases, entry.name))) {
        protectedPaths.add(join(releases, entry.name));
      }
    }
  }
  return protectedPaths;
}

export function devicePruneTargets(home = os.homedir()) {
  return [
    { name: 'npm', root: join(home, '.npm'), mode: 'tree' },
    { name: 'uv-cache', root: join(home, '.cache', 'uv'), mode: 'tree' },
    { name: 'user-cache', root: join(home, 'Library', 'Caches'), mode: 'tree' },
    { name: 'codex-cache', root: join(home, '.codex', 'cache'), mode: 'tree' },
    { name: 'claude-cache', root: join(home, '.claude', 'cache'), mode: 'tree' },
    { name: 'codex-standalone-releases', root: join(home, '.codex', 'packages', 'standalone', 'releases'), mode: 'releases', packageRoot: join(home, '.codex', 'packages', 'standalone') },
    { name: 'codex-app-server-releases', root: join(home, '.codex', 'packages', 'app-server-daemon', 'releases'), mode: 'releases', packageRoot: join(home, '.codex', 'packages', 'app-server-daemon') },
  ];
}

export function listStaleDeviceArtifacts({ home = os.homedir(), now = Date.now(), maxAgeMs = STALE_DEVICE_ARTIFACT_AGE_MS, ...options } = {}) {
  const cutoff = now - maxAgeMs;
  const result = [];
  for (const target of devicePruneTargets(home)) {
    if (target.mode === 'releases') {
      const protectedPaths = protectedReleasePaths(target.packageRoot, options);
      for (const entry of listChildren(target.root, options.readDir ?? readdirSync)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = join(target.root, entry.name);
        if (protectedPaths.has(path)) continue;
        const info = treeInfo(path, options);
        if (info.latestMtimeMs < cutoff) result.push({ ...target, path, bytes: info.bytes });
      }
    } else {
      for (const item of listStaleTree(target.root, cutoff, options)) result.push({ ...target, ...item });
    }
  }
  return result;
}

/** @param {Parameters<typeof listStaleDeviceArtifacts>[0] & { apply?: boolean }} [options] */
export function sweepStaleDeviceArtifacts({ apply = false, ...options } = {}) {
  if (apply) throw new Error('Global device cleanup disabled: age is not deletion authority');
  const candidates = listStaleDeviceArtifacts(options);
  return { candidates, removed: 0, bytes: 0 };
}
