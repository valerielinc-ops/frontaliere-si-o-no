import { isPrScratchPath } from './worktree-dirty.mjs';

// Guardie pure del purge. Tenerle senza git/gh rende verificabile la parte
// rischiosa della decisione: uno stato chiuso non prova che il contenuto sia
// confluito; zero commit ahead e' l'unica prova locale disponibile in quel
// caso. Una PR MERGED e' invece una prova esplicita sufficiente, anche con
// squash-merge (dove ahead resta > 0 per costruzione).

export function canDeleteClosedCandidate({ ahead }) {
  return ahead === 0;
}

export function canDeleteIssueFix({ issueState, issueReason, ahead }) {
  return issueState === 'closed'
    && issueReason !== 'not_planned'
    && canDeleteClosedCandidate({ ahead });
}

export function needsSnapshot({ prState, ahead, hasSnapshot }) {
  return prState === 'MERGED' && ahead !== 0 && !hasSnapshot;
}

// `git rev-list` nel clone locale non basta per i PR squashati: il commit
// della PR puo' non essere presente nel clone, mentre GitHub puo' confrontarlo
// con l'HEAD remoto. La prova ammessa e' quindi il risultato di
// `compare/<local-tip>...<pr-head>` con zero commit dietro: il tip locale e'
// contenuto nella storia della PR mergiata (o coincide con il suo HEAD).
export function hasAncestryProof(compare) {
  return Number.isInteger(compare?.behind_by) && compare.behind_by === 0;
}

// --- Worktree senza PR, già interamente su main --------------------------------
//
// Un worktree pulito con HEAD antenato di origin/main non ha niente da perdere:
// ogni suo commit è già su main. Restava report-only per sempre perché è
// indistinguibile da un agente che ha appena creato il worktree e non ha ancora
// scritto nulla (misurati il 2026-10-02: 18 worktree così, 7,1 GB, fermi da 3 a
// 10 giorni). Il discriminante è il tempo: un agente vivo tocca HEAD, l'index o
// il reflog del suo worktree; uno fermo da più di IDLE_WORKTREE_MS no.
export const IDLE_WORKTREE_MS = 24 * 60 * 60 * 1000;

export function isIdleSince(lastActivityMs, { now = Date.now(), idleMs = IDLE_WORKTREE_MS } = {}) {
  return Number.isFinite(lastActivityMs) && lastActivityMs > 0 && now - lastActivityMs >= idleMs;
}

// Tutte le condizioni sono necessarie. `busyKnown` falso (lsof non disponibile)
// e `ghOk` falso (stato PR non leggibile: una PR aperta non sarebbe vista)
// lasciano il worktree com'è.
export function canRemoveIdleOnMain({ dirty, ahead, idle, busy, busyKnown, ghOk }) {
  return dirty === false
    && ahead === 0
    && idle === true
    && busy === false
    && busyKnown === true
    && ghOk === true;
}

// Un processo con la cwd dentro il worktree (dev server, vitest, una shell) lo
// sta usando: rimuoverlo gli toglierebbe la directory da sotto.
export function isPathBusy(worktreePath, cwds) {
  const prefix = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`;
  for (const cwd of cwds || []) {
    if (cwd === worktreePath || cwd.startsWith(prefix)) return true;
  }
  return false;
}

// `git worktree add --no-checkout` seguito da un checkout mai completato
// (scripts/dev/fast-worktree.sh interrotto): niente index, e nel working tree
// al più qualche file già scritto identico a HEAD (nel caso misurato il
// 2026-10-02, otto symlink tracciati). `git status` senza index vede tutto
// "cancellato" e lo tiene per sporco, ma non c'è niente da salvare.
export function isAbortedCheckout({ hasIndex, onlyHeadContent }) {
  return hasIndex === false && onlyHeadContent === true;
}

// --- Directory orfane --------------------------------------------------------
//
// Directory sotto le cartelle dei worktree che git non conosce più: la
// rimozione è riuscita a metà oppure qualcosa ha riscritto file dopo
// (`.DS_Store` del Finder, la cache di vitest in `node_modules/.vite`). Lo
// script vedeva solo `git worktree list`, quindi restavano lì. Si cancellano da
// sole solo quando contengono esclusivamente quel rumore; tutto il resto è
// report-only, perché senza metadati git non c'è modo di dire se un file è
// lavoro.
// Il body di una PR (`.pr-body-*.md`) conta come residuo solo alla radice
// della directory, come in worktree-dirty.mjs.
export function isOrphanResidueFile(relativePath) {
  const parts = String(relativePath).split('/');
  return parts[parts.length - 1] === '.DS_Store'
    || parts.includes('node_modules')
    || (parts.length === 1 && isPrScratchPath(parts[0]));
}

export function isRemovableOrphanDir({ files, idle }) {
  return idle === true && Array.isArray(files) && files.every(isOrphanResidueFile);
}
