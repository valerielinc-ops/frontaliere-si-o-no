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
// Misurato di nuovo il 2026-10-02 su 85 worktree: 21 dei 44 rimovibili erano
// tenuti in vita da UN solo file non tracciato, il body della PR scritto per
// `gh pr create --body-file` (`.pr-body-9108.md`, `.codex-pr-body.md`,
// `PR_BODY.md`, `.issue-831-comment.md`). Quel testo vive su GitHub nella PR o
// nel commento: la copia locale è un residuo dello strumento, non lavoro.
//
// Gli ignorati vengono restituiti separatamente, mai scartati in silenzio: chi
// chiama li conta e li riporta.
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { isCronManagedPath } from './cron-managed-paths.mjs';

// Solo file NON tracciati alla radice del worktree: un `PR_BODY.md` tracciato e
// modificato, o lo stesso nome in una sottocartella, resta lavoro.
// `.observer-pr<N>-body-<data>.md`: il body che l'observer del corpus scrive per la sua PR.
const PR_SCRATCH_RE = /^(?:\.pr-body[\w.-]*|\.codex-pr-body|PR_BODY|\.issue-\d+-comment|\.observer-pr\d+-body[\w.-]*)\.md$/;

export function isPrScratchPath(filePath) {
  return PR_SCRATCH_RE.test(String(filePath));
}

function pathOf(rest) {
  // Rename/copy: `R  vecchio -> nuovo`. Conta la destinazione.
  return (rest.includes(' -> ') ? rest.split(' -> ').pop() : rest).replace(/^"|"$/g, '');
}

// Il porcelain v1 è `XY<spazio>PATH`. NON usare un helper che fa trim
// sull'output: il trim mangia lo spazio iniziale della prima riga
// (` M file` → `M file`) e sfasa il campo di stato di un carattere.
export function parsePorcelainEntries(porcelain) {
  const entries = [];
  for (const line of String(porcelain).split('\n')) {
    if (line.length < 4) continue;
    const filePath = pathOf(line.slice(3).trim());
    if (filePath) entries.push({ status: line.slice(0, 2), path: filePath });
  }
  return entries;
}

export function parsePorcelainPaths(porcelain) {
  return parsePorcelainEntries(porcelain).map((entry) => entry.path);
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

// Un `node_modules` non tracciato che è un symlink (i worktree del corpus lo
// fanno puntare al node_modules del checkout principale o del sito, con un
// path relativo o assoluto) non è lavoro: è un collegamento, e toglierlo senza
// seguirlo non tocca niente. Una CARTELLA node_modules vera resta sporco.
export function isNodeModulesLinkEntry({ status, path: filePath }, isSymlink) {
  const name = String(filePath).replace(/\/+$/, '').split('/').pop();
  return status === '??' && name === 'node_modules' && typeof isSymlink === 'function' && isSymlink(filePath) === true;
}

// Come classifyDirtyPaths, ma conosce lo stato porcelain: il body di una PR è
// rumore solo se non è tracciato (`??`) e solo se la PR esiste, in qualunque
// stato (`prExists`). Il body di una PR non ancora aperta è il testo che
// l'agente stava per pubblicare: lavoro, non residuo. `isSymlink` (path →
// boolean) abilita il symlink `node_modules` come rumore.
export function classifyDirtyEntries(entries, { isCronManaged = isCronManagedPath, prExists = true, isSymlink } = {}) {
  const significant = [];
  const significantEntries = [];
  const ignored = [];
  for (const entry of entries) {
    const { status, path: filePath } = entry;
    if (isCronManaged(filePath)) ignored.push(filePath);
    else if (prExists && status === '??' && isPrScratchPath(filePath)) ignored.push(filePath);
    else if (isNodeModulesLinkEntry(entry, isSymlink)) ignored.push(filePath);
    else {
      significant.push(filePath);
      significantEntries.push(entry);
    }
  }
  return { significant, significantEntries, ignored };
}

// `null` = git non ha risposto. NON è "pulito": un worktree di cui non si può
// leggere lo stato non si rimuove (prima l'errore diventava '' e quindi
// "nessuna modifica").
function statusPorcelain(wtPath) {
  try {
    // `core.quotePath=false`: senza, git cita in stile C i path non-ASCII
    // (`"data/jobs/by-crawler/caf\303\251.json"`) e lo strip dei soli apici
    // esterni lascia gli escape, quindi `isCronManagedPath()` non matcha e il
    // file torna a contare come lavoro — il worktree resta immortale proprio
    // sul path che si voleva ignorare.
    // `--no-optional-locks`: lo sweep non riscrive l'index dei worktree che
    // ispeziona (ne cambierebbe la data, che è il segnale di attività) e non
    // contende il lock a un agente che ci sta lavorando.
    return execFileSync('git', [
      '--no-optional-locks', '-C', wtPath, '-c', 'core.quotePath=false', 'status', '--porcelain',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch { return null; }
}

// Il symlink si legge con lstat: mai seguito.
export function symlinkProbe(wtPath) {
  return (filePath) => {
    try { return lstatSync(join(wtPath, String(filePath).replace(/\/+$/, ''))).isSymbolicLink(); } catch { return false; }
  };
}

export function classifyDirty(wtPath, { prExists = true } = {}) {
  const porcelain = statusPorcelain(wtPath);
  if (porcelain === null) return { significant: [], significantEntries: [], ignored: [], error: true };
  return { ...classifyDirtyEntries(parsePorcelainEntries(porcelain), { prExists, isSymlink: symlinkProbe(wtPath) }), error: false };
}
