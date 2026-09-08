// Separa lo sporco di un worktree che è LAVORO da quello che è rumore di
// macchina.
//
// Un worktree "DIRTY" non è di per sé lavoro da salvare. Misurato il
// 2026-09-04 sui 21 worktree accumulati in questo clone: lo sporco era output
// di cron (`data/gsc-orphan-queries-clusters.json`, `data/jobs/by-crawler/*`,
// `data/parser-quality-report.json`). Trattarlo come lavoro impediva a
// `prune-merged-worktrees.mjs` di rimuovere worktree la cui PR era già
// mergiata.
//
// Gli ignorati vengono restituiti separatamente, mai scartati in silenzio: chi
// chiama li conta e li riporta.
import { execSync } from 'node:child_process';

import { isCronManagedPath } from './cron-managed-paths.mjs';

// Il porcelain v1 è `XY<spazio>PATH`. NON usare un helper che fa trim
// sull'output: il trim mangia lo spazio iniziale della prima riga
// (` M file` → `M file`) e sfasa il campo di stato di un carattere.
export function parsePorcelainPaths(porcelain) {
  const paths = [];
  for (const line of String(porcelain).split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3).trim();
    // Rename/copy: `R  vecchio -> nuovo`. Conta la destinazione.
    const filePath = (rest.includes(' -> ') ? rest.split(' -> ').pop() : rest).replace(/^"|"$/g, '');
    if (filePath) paths.push(filePath);
  }
  return paths;
}

// Puro: decide su una lista di path già estratta, col predicato iniettabile —
// così il test non ha bisogno di un worktree vero.
export function classifyDirtyPaths(paths, { isCronManaged = isCronManagedPath } = {}) {
  const significant = [];
  const ignored = [];
  for (const filePath of paths) {
    if (isCronManaged(filePath)) ignored.push(filePath);
    else significant.push(filePath);
  }
  return { significant, ignored };
}

function statusPorcelain(wtPath) {
  try {
    // `core.quotePath=false`: senza, git cita in stile C i path non-ASCII
    // (`"data/jobs/by-crawler/caf\303\251.json"`) e lo strip dei soli apici
    // esterni lascia gli escape, quindi `isCronManagedPath()` non matcha e il
    // file torna a contare come lavoro — il worktree resta immortale proprio
    // sul path che si voleva ignorare.
    return execSync(`git -C "${wtPath}" -c core.quotePath=false status --porcelain`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return ''; }
}

export function classifyDirty(wtPath) {
  return classifyDirtyPaths(parsePorcelainPaths(statusPorcelain(wtPath)));
}
