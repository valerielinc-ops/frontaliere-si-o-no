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
import { lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

function gitRead(wtPath, args, { input } = {}) {
  return execFileSync('git', ['--no-optional-locks', '-C', wtPath, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function normalizeRelativePath(filePath) {
  return String(filePath).split(sep).join('/');
}

function headTree(wtPath) {
  const tree = new Map();
  const raw = gitRead(wtPath, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('ls-tree ha restituito un record senza path');
    const [mode, type, oid] = record.slice(0, tab).split(/\s+/);
    const filePath = normalizeRelativePath(record.slice(tab + 1));
    if (!mode || !type || !oid || !filePath) throw new Error('ls-tree ha restituito un record incompleto');
    tree.set(filePath, { mode, type, oid });
  }
  return tree;
}

function indexFlags(wtPath) {
  const flags = new Map();
  const raw = gitRead(wtPath, ['ls-files', '-v', '-z']);
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const filePath = normalizeRelativePath(record.slice(2));
    if (record.length < 3 || record[1] !== ' ' || !filePath) throw new Error('ls-files ha restituito un record incompleto');
    flags.set(filePath, record[0]);
  }
  return flags;
}

function isSkipWorktree(flag) {
  return flag === 'S' || flag === 's';
}

function walkWorkingFiles(wtPath) {
  const files = [];
  const ignored = [];
  const walk = (directory, relativeDirectory, isRoot = false) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`lettura di ${directory} fallita: ${error?.message || 'errore sconosciuto'}`);
    }
    for (const entry of entries) {
      // A linked worktree has a `.git` file; a main worktree has a `.git`
      // directory. Neither is part of the working tree content.
      if (isRoot && entry.name === '.git') continue;
      const filePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      let lstat;
      try { lstat = lstatSync(fullPath); } catch (error) {
        throw new Error(`stat di ${fullPath} fallita: ${error?.message || 'errore sconosciuto'}`);
      }
      if (lstat.isSymbolicLink()) {
        if (isRoot && entry.name === 'node_modules') ignored.push(filePath);
        else files.push({ path: normalizeRelativePath(filePath), kind: 'symlink', fullPath });
        continue;
      }
      if (lstat.isDirectory()) {
        // Traversing an installed dependency tree is both expensive and unsafe:
        // it is machine state, never a source change to preserve in a snapshot.
        // A real directory is kept fail-closed because unlike the usual symlink
        // it would be removed with this worktree.
        if (isRoot && entry.name === 'node_modules') {
          throw new Error('node_modules è una directory reale, non un symlink: classificazione non sicura');
        }
        walk(fullPath, normalizeRelativePath(filePath));
        continue;
      }
      if (lstat.isFile()) files.push({ path: normalizeRelativePath(filePath), kind: 'file', fullPath });
    }
  };
  walk(wtPath, '', true);
  return { files, ignored };
}

function hashWorkingFiles(wtPath, files) {
  const regular = files.filter((file) => file.kind === 'file');
  const hashes = new Map();
  if (regular.length) {
    if (regular.some((file) => file.path.includes('\n') || file.path.includes('\0'))) {
      throw new Error('path con newline/NUL: hash-object --stdin-paths non è sicuro');
    }
    const output = gitRead(wtPath, ['hash-object', '--no-filters', '--stdin-paths'], {
      input: `${regular.map((file) => file.path).join('\n')}\n`,
    });
    const values = output.split('\n').filter(Boolean);
    if (values.length !== regular.length) throw new Error('hash-object ha restituito un numero di blob inatteso');
    regular.forEach((file, index) => hashes.set(file.path, values[index]));
  }
  for (const file of files.filter((entry) => entry.kind === 'symlink')) {
    const target = readlinkSync(file.fullPath);
    hashes.set(file.path, execFileSync('git', ['--no-optional-locks', '-C', wtPath, 'hash-object', '--no-filters', '--stdin'], {
      input: target,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim());
  }
  return hashes;
}

function workingMode(file) {
  if (file.kind === 'symlink') return '120000';
  return (statSync(file.fullPath).mode & 0o111) ? '100755' : '100644';
}

// Classifica il contenuto reale sul disco, indipendentemente da un index
// corrotto. `git status` non è adatto al reclaim: su sparse worktree con un
// index incoerente può dichiarare migliaia di cancellazioni staged mentre i
// file sono tutti presenti e il contenuto è quasi intatto. Qui confrontiamo
// direttamente i blob di HEAD con hash-object sui file presenti.
export function classifyRealChanges(wtPath, { prExists = true } = {}) {
  try {
    const tree = headTree(wtPath);
    const flags = indexFlags(wtPath);
    const { files, ignored } = walkWorkingFiles(wtPath);
    const hashes = hashWorkingFiles(wtPath, files);
    const significantEntries = [];
    const significant = [];
    const present = new Set();

    for (const file of files) {
      present.add(file.path);
      if (isCronManagedPath(file.path)
        || (prExists && file.kind === 'file' && isPrScratchPath(file.path))) {
        ignored.push(file.path);
        continue;
      }
      const head = tree.get(file.path);
      const mode = workingMode(file);
      const oid = hashes.get(file.path);
      if (!oid) throw new Error(`hash mancante per ${file.path}`);
      if (!head || head.oid !== oid || head.mode !== mode) {
        const entry = { path: file.path, kind: file.kind, mode, oid, missing: false };
        significantEntries.push(entry);
        significant.push(file.path);
      }
    }

    for (const [filePath, head] of tree) {
      if (present.has(filePath) || isCronManagedPath(filePath)) continue;
      if (isSkipWorktree(flags.get(filePath))) continue;
      // A missing path with no skip-worktree bit is a real deletion. Keeping
      // this check separate from the physical walk is what makes staged-D +
      // restored-file sparse indexes safe to reclaim.
      const entry = { path: filePath, kind: 'file', mode: head.mode, oid: null, missing: true };
      significantEntries.push(entry);
      significant.push(filePath);
    }

    return {
      significant,
      significantEntries,
      ignored: [...new Set(ignored)],
      error: false,
    };
  } catch (error) {
    return {
      significant: [],
      significantEntries: [],
      ignored: [],
      error: true,
      errorMessage: error?.message || 'classificazione hash fallita',
    };
  }
}
