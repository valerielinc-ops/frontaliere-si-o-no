// Pulizia conservativa delle directory temporanee lasciate da sessioni finite.
// Si considerano solo i figli diretti della directory temporanea di sistema:
// niente glob ricorsivi e nessuna cancellazione del root stesso.

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';

export const STALE_TEMP_DIR_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const PROTECTED_TEMP_NAMES = new Set([
  'frontaliere-coordinator-state',
]);

// FRONTALIERE_PRUNE_TMP_ROOT consente di puntare al root temporaneo condiviso
// del device. macOS usa /private/tmp per gli artefatti condivisi fra agenti;
// gli altri sistemi seguono il root temporaneo nativo di Node.
export function defaultTempRoot({ platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  return process.env.FRONTALIERE_PRUNE_TMP_ROOT
    ? resolve(process.env.FRONTALIERE_PRUNE_TMP_ROOT)
    : platform === 'darwin'
      ? '/private/tmp'
      : resolve(tmpdir);
}

function isProtectedTempName(name) {
  return PROTECTED_TEMP_NAMES.has(name)
    || /^(?:cc|claude|codex)-(?:daemon|socks)(?:-|$)/.test(name)
    || /^(?:claude|codex)-\d+$/.test(name)
    || /^com\.apple\.launchd\./.test(name)
    || /-cwd$/.test(name);
}

function inspectTree(root, { stat = lstatSync, readDir = readdirSync } = {}) {
  const stack = [root];
  let latestMtimeMs = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    let st;
    try {
      st = stat(current);
    } catch {
      continue; // sparito durante lo scan: non è un candidato da forzare
    }
    latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs);
    if (!st.isDirectory()) {
      bytes += st.size;
      continue;
    }
    let entries;
    try {
      entries = readDir(current, { withFileTypes: true });
    } catch {
      return { readable: false, latestMtimeMs, bytes };
    }
    for (const entry of entries) {
      // Symlink: non seguire mai percorsi fuori dal tmp root.
      if (entry.isSymbolicLink()) continue;
      stack.push(join(current, entry.name));
    }
  }
  return { readable: true, latestMtimeMs, bytes };
}

export function listStaleTempDirs(
  tmpRoot,
  { now = Date.now(), maxAgeMs = STALE_TEMP_DIR_AGE_MS, stat = lstatSync, readDir = readdirSync } = {},
) {
  const root = resolve(tmpRoot);
  let entries;
  try {
    entries = readDir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || isProtectedTempName(entry.name)) continue;
    const path = join(root, entry.name);
    const inspected = inspectTree(path, { stat, readDir });
    if (inspected.readable && now - inspected.latestMtimeMs > maxAgeMs) {
      stale.push({ path, bytes: inspected.bytes, latestMtimeMs: inspected.latestMtimeMs });
    }
  }
  return stale;
}

export function sweepStaleTempDirs(tmpRoot, { apply = false, ...options } = {}) {
  const candidates = listStaleTempDirs(tmpRoot, options);
  if (!apply) return { candidates: candidates.length, removed: 0, bytes: 0, paths: candidates };
  let removed = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    try {
      rmSync(candidate.path, { recursive: true, force: false });
      removed++;
      bytes += candidate.bytes;
    } catch {
      // Un file aperto o una directory cambiata durante lo scan resta intatta.
    }
  }
  return { candidates: candidates.length, removed, bytes, paths: candidates };
}
