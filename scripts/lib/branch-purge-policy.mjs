import { conflictHandoffOriginPr } from '../ci/check-issue-already-resolved.mjs';
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

// --- Prove di contenuto (smaltimento manuale del 2026-10-02) -------------------
//
// Una quarantina di worktree restavano report-only anche se il loro contenuto
// era già su main o su GitHub: commit cherry-pickati in una PR poi mergiata
// (GitHub associa la PR solo allo SHA esatto), modifiche non committate già
// committate più avanti nella PR, merge rifatti che differiscono solo in un
// file generato, PR chiuse e riapplicate dal flusso automatico, vecchi
// checkout di main. Qui stanno le sole decisioni: i fatti li raccoglie
// scripts/lib/merged-content-proof.mjs leggendo git. Ogni regola è una PROVA
// che il contenuto esiste altrove; ciò che è solo probabile resta report-only
// con un'annotazione (reportAnnotation).

// Un commit locale è contenuto in una PR MERGED se:
//   • è antenato dell'HEAD della PR, oppure non cambia niente;
//   • riapplicarlo sull'HEAD della PR non cambia l'albero (merge-tree);
//   • ogni suo file ha il patch-id di un file di un commit della PR, e il
//     revert non c'è: nessun commit della PR è l'inverso di quel file e lo
//     squash della PR tocca ancora quel file. Un commit cherry-pickato e poi
//     revertito nella stessa PR ha il patch-id giusto ma non è nello squash.
// Un file binario non ha un patch-id affidabile: senza le prime due prove resta.
export function isCommitContained(facts) {
  if (!facts) return false;
  if (facts.ancestor === true || facts.empty === true || facts.absorbed === true) return true;
  const files = facts.files;
  return Array.isArray(files) && files.length > 0 && files.every((file) => file
    && file.binary !== true
    && file.matched === true
    && file.inverseMatched !== true
    && file.inSquash === true);
}

// File che un generatore riscrive a ogni run: una differenza solo lì non è
// lavoro. Lista esplicita e stretta: un path entra qui solo se un generatore
// del repo lo produce per intero (`.github/corpus-workflows/contract.json` lo
// scrive scripts/ci/prepare-crawler-workflow-corpus-sync.mjs, con
// `sourceCommit` diverso a ogni merge rifatto). Mai lockfile o fingerprint
// che le persone aggiornano a mano.
export const GENERATED_PATHS = Object.freeze([
  '.github/corpus-workflows/contract.json',
]);

export function isGeneratedPath(filePath) {
  return GENERATED_PATHS.includes(String(filePath));
}

// Un merge locale rifatto (stessi genitori di un merge presente nella PR) è
// contenuto se differisce dal gemello solo in file generati. Senza gemello, o
// con una risoluzione diversa in un file scritto a mano, resta.
export function isMergeContained({ twinDiff }) {
  return Array.isArray(twinDiff) && twinDiff.every(isGeneratedPath);
}

// Marcatore di "path assente" (cancellato o mai esistito) nei confronti tra blob.
export const DELETED = 'deleted';

// Modifiche non committate già committate altrove: ogni versione locale di
// ogni path (working tree e index) deve essere uno dei blob ammessi per quel
// path. Rename/copy non si confrontano; i file non tracciati solo se il
// chiamante li ammette (vecchio checkout di main, dove i file aggiunti dopo
// HEAD compaiono come non tracciati).
export function isDirtyContained(entries, { allowUntracked = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every((entry) => {
    if (!entry || /[RC]/.test(entry.status || '')) return false;
    if (entry.status === '??' && !allowUntracked) return false;
    const versions = entry.versions;
    return Array.isArray(versions) && versions.length > 0 && entry.allowed instanceof Set
      && versions.every((v) => typeof v === 'string' && entry.allowed.has(v));
  });
}

// Le regole nuove valgono solo con tutte le guardie esistenti: inattività,
// nessun processo dentro (e lsof leggibile), stato PR leggibile.
export function canRemoveWithProof({ proven, idle, busy, busyKnown, ghOk }) {
  return proven === true && idle === true && busy === false && busyKnown === true && ghOk === true;
}

// Una rimozione autorizzata da una prova nuova lascia sempre un tag sul commit,
// salvo che uno snapshot ci sia già.
export function needsProofSnapshot({ hasSnapshot }) {
  return hasSnapshot !== true;
}

// PR CLOSED con l'HEAD locale identico al suo headRefOid: GitHub conserva quel
// commit in refs/pull/N/head, quindi in locale non resta niente di unico. Solo
// se chiusa da almeno una settimana (una chiusura recente può essere un errore
// che qualcuno sta per riaprire) e senza sporco significativo.
export const CLOSED_AT_HEAD_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function canRemoveClosedAtHead({ pr, head, dirty, now = Date.now(), minAgeMs = CLOSED_AT_HEAD_MIN_AGE_MS }) {
  if (!pr || pr.state !== 'CLOSED' || dirty !== false) return false;
  if (typeof head !== 'string' || head.length === 0 || pr.headRefOid !== head) return false;
  const closedAt = Date.parse(pr.closedAt || '');
  return Number.isFinite(closedAt) && now - closedAt >= minAgeMs;
}

// PR CLOSED riapplicata dal flusso automatico: pr-autorebase apre l'issue
// «Conflitto con main dopo LGTM: riapplicare la PR #P su main», issue-fix la
// chiude con la PR `fix/issue-<issue>`. La prova è la catena intera: l'issue
// nomina ESATTAMENTE #P, è chiusa come COMPLETED e la sua PR è MERGED su main.
// Il parser del titolo è quello dei consumatori CI, non una copia.
export function isReappliedClosedPr({ closedPr, issue, reapplyPr, baseBranch }) {
  return closedPr?.state === 'CLOSED'
    && Number.isInteger(closedPr.number)
    && String(issue?.state || '').toUpperCase() === 'CLOSED'
    && String(issue?.stateReason || '').toUpperCase() === 'COMPLETED'
    && conflictHandoffOriginPr(issue?.title) === closedPr.number
    && reapplyPr?.state === 'MERGED'
    && reapplyPr.baseRefName === baseBranch
    && reapplyPr.headRefName === `fix/issue-${issue.number}`;
}

// Vecchio checkout di main: tutto lo sporco coincide con UN commit first-parent
// di main. La guardia di inattività è più lunga (una fix viva può riportare
// pochi file a una versione vecchia di main) e il commit deve spiegare TUTTI i
// file, non uno per file.
export const STALE_CHECKOUT_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

// Directory orfane: file che non si confrontano perché rumore di macchina o
// cache di build. `.git` lo decide il chiamante (puntatore a un gitdir sparito).
export function isOrphanSkippablePath(relativePath) {
  const parts = String(relativePath).split('/');
  const name = parts[parts.length - 1];
  return name === '.DS_Store'
    || name.endsWith('.tsbuildinfo')
    || parts.includes('node_modules')
    || parts.includes('.cache');
}

// Finestra dei commit first-parent di main con cui una directory orfana può
// coincidere: dal giorno prima di due giorni prima dell'ultima scrittura al
// giorno dopo.
export const ORPHAN_WINDOW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;
export const ORPHAN_WINDOW_AFTER_MS = 24 * 60 * 60 * 1000;

export function orphanWindow(newestMs) {
  if (!Number.isFinite(newestMs) || newestMs <= 0) return null;
  return { sinceMs: newestMs - ORPHAN_WINDOW_BEFORE_MS, untilMs: newestMs + ORPHAN_WINDOW_AFTER_MS };
}

// Ogni file della directory orfana è rumore, ignorato da git, oppure ha lo
// stesso blob allo stesso path in un commit raggiungibile di main. Un blob che
// esiste solo in un commit irraggiungibile non conta: sparisce col gc.
export function isProvenOrphan({ files, idle }) {
  return idle === true && Array.isArray(files) && files.every((file) => file
    && (file.skippable === true || file.ignored === true || file.matched === true));
}

// I numeri che un nome di branch dichiara: `fix/issue-9920`,
// `fix-issue-9920-fingerprint-20260926`, `worker-site-9336-20260920`. Le date
// in coda (8 cifre) non sono numeri di issue.
export function issueNumbersInBranch(branch) {
  const out = [];
  for (const match of String(branch || '').matchAll(/(?:^|[/_-])(\d{2,6})(?=$|[/_-])/g)) {
    const n = Number(match[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// PR candidate per nome: stessa head o una sua variante `<branch>-r1`.
export function namePrefixCandidates(branch, prs) {
  if (!branch) return [];
  return (prs || []).filter((pr) => pr?.headRefName === branch
    || String(pr?.headRefName || '').startsWith(`${branch}-`));
}

// Lo squash su main: «titolo (#N)» e il corpo con i soggetti dei commit della
// PR, uno per riga `* soggetto`. Serve a trovare la PR candidata di un commit
// cherry-pickato; la prova resta il patch-id.
export function squashPrNumber(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(String(subject || ''));
  return match ? Number(match[1]) : null;
}

export function normalizeSubject(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

export function squashSubjects(subject, body) {
  const out = new Set();
  const title = normalizeSubject(String(subject || '').replace(/\s*\(#\d+\)\s*$/, ''));
  if (title) out.add(title);
  for (const line of String(body || '').split('\n')) {
    const match = /^\* (.+)$/.exec(line.trim());
    if (match) out.add(normalizeSubject(match[1]));
  }
  return [...out];
}

// Annotazioni dei casi che NON sono prove: restano report-only, ma il report
// dice dove guardare.
export function reportAnnotation({ partialPr, closedIssue, tmpOnly, staleDirty } = {}) {
  const notes = [];
  if (partialPr) {
    notes.push(`probabile superato da #${partialPr.number}: ${partialPr.unproven} commit non provati dentro la PR (es. ${String(partialPr.example || '').slice(0, 12)}) — verifica`);
  }
  if (tmpOnly) notes.push(`commit provati in #${tmpOnly.number}, restano solo file non tracciati sotto tmp/ (${tmpOnly.count}) — verifica e rimuovi a mano`);
  if (closedIssue) {
    notes.push(`issue #${closedIssue.number} chiusa (${closedIssue.stateReason || 'CLOSED'}): non prova che il contenuto sia su main — verifica`);
  }
  if (staleDirty) notes.push(`sporco fermo da ${staleDirty.days} giorni con ${staleDirty.what}: probabile superato — verifica`);
  return notes.join('; ');
}
