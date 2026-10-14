// Pulizia cross-device delle cache e degli artefatti locali ricreabili.
// La regola è conservativa: solo contenuti senza alcuna modifica negli ultimi
// tre giorni; release in uso e puntatori current sono sempre protetti.

import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, readdirSync, realpathSync, rmSync } from 'node:fs';
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

// Prune files and directories below a managed root. A directory is removed as
// one unit only when its complete subtree is stale; mixed active/stale trees
// are traversed so a current session never loses a recent file.
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
    { name: 'codex-sessions', root: join(home, '.codex', 'sessions'), mode: 'tree' },
    { name: 'codex-archived-sessions', root: join(home, '.codex', 'archived_sessions'), mode: 'tree' },
    { name: 'claude-jobs', root: join(home, '.claude', 'jobs'), mode: 'tree' },
    { name: 'claude-projects', root: join(home, '.claude', 'projects'), mode: 'tree' },
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

export function sweepStaleDeviceArtifacts({ apply = false, ...options } = {}) {
  const candidates = listStaleDeviceArtifacts(options);
  if (!apply) return { candidates, removed: 0, bytes: 0 };
  let removed = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    try {
      rmSync(candidate.path, { recursive: true, force: false });
      removed++;
      bytes += candidate.bytes;
    } catch { /* changed/open item: preserve it */ }
  }
  return { candidates, removed, bytes };
}
