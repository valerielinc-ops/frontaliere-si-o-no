#!/usr/bin/env node
// Sweep dei worktree/branch LOCALI accumulati. Dry-run di default; --apply per agire.
//
// Perché esiste (AGENTS.md → "Leak locale di worktree/branch", 2026-06-03): il cleanup
// ancorato all'evento-merge nel turn dell'agent lascia 3 buchi che fanno accumulare
// worktree e branch locali finché qualcuno non li nota (osservati 33 orfani):
//   a) EnterWorktree auto-rimuove la dir worktree se unchanged ma LASCIA il branch
//      `worktree-agent-<id>` (0-ahead) orfano — nessuno lo cancella.
//   b) Squash-merge: GitHub auto-cancella il remoto (delete_branch_on_merge) ma il
//      branch LOCALE resta e `git branch --merged` lo vede unmerged (lo squash riscrive)
//      → non viene mai potato.
//   c) Sessione morta/timeout: l'agent non raggiunge mai il pre-task-close.
//
// Decisioni (conservative — il dubbio = keep, mai distruggere lavoro non in PR):
//   • worktree con PR head MERGED|CLOSED  → remove worktree + delete branch
//   • worktree detached / branch fantasma → remove worktree (no branch da toccare)
//   • branch `worktree-agent-*` 0-ahead   → delete (orfano EnterWorktree)
//   • branch locale (no worktree) con PR MERGED|CLOSED → delete
//   • worktree/branch clean, ahead>0, NESSUNA PR → REPORT-ONLY (può essere pre-PR vivo)
//   • branch con PR OPEN o worktree del repo principale (main) → KEEP, mai toccato
//
// Uso:
//   node scripts/prune-merged-worktrees.mjs           # dry-run, stampa il piano
//   node scripts/prune-merged-worktrees.mjs --apply    # esegue le rimozioni safe
//
// Richiede: git + gh CLI autenticato (per lo stato PR). Senza gh → degrada a
// solo-`worktree-agent-*`-0-ahead + report, senza toccare i branch PR-derivati.

import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
// --orphans-only: fast-path sicuro per il SessionEnd hook. Cancella SOLO i branch
// `worktree-agent-<id>` 0-ahead orfani (dir worktree già auto-rimossa da
// EnterWorktree). Zero gh, zero rimozione worktree → non-presidiabile.
const ORPHANS_ONLY = process.argv.includes('--orphans-only');

function sh(cmd, { allowFail = false } = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

// Esegue un comando distruttivo e ritorna true SOLO se è uscito 0. Necessario in
// --apply: un `git branch -D`/`worktree remove` fallito (branch in checkout,
// worktree lockato) non deve essere contato come rimozione avvenuta → niente
// falso-positivo "applicate N rimozioni" su un tool distruttivo.
function shOk(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const mainBranch = sh('git symbolic-ref --quiet --short refs/remotes/origin/HEAD', { allowFail: true })
  .replace(/^origin\//, '') || 'main';

// --- FAST PATH: --orphans-only (SessionEnd hook) ----------------------------
// Solo i branch worktree-agent-* 0-ahead SENZA worktree attaccato (case c:
// sessione morta non raggiunge il pre-task-close). Self-contained, niente gh,
// niente rimozione worktree, NIENTE fetch di rete → istantaneo, safe da girare
// non-presidiato a ogni fine sessione. Usa l'origin/<main> locale: anche se
// leggermente stale, un worktree-agent-* nasce branchato da main recente → resta
// 0-ahead; se per stale risultasse ahead>0, viene saltato (mai cancellato a torto).
if (ORPHANS_ONLY) {
  const attached = new Set(
    sh('git worktree list --porcelain', { allowFail: true })
      .split('\n').filter((l) => l.startsWith('branch '))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );
  const orphans = sh("git for-each-ref --format='%(refname:short)' refs/heads", { allowFail: true })
    .split('\n').filter(Boolean)
    .filter((b) => /^worktree-agent-/.test(b) && !attached.has(b))
    .filter((b) => sh(`git rev-list --count origin/${mainBranch}..${b}`, { allowFail: true }) === '0');
  if (!APPLY) {
    console.log(`[orphans-only] ${orphans.length} branch worktree-agent-* 0-ahead orfani:`);
    orphans.forEach((b) => console.log(`  - ${b}`));
    console.log(orphans.length ? 'dry-run: ri-esegui con --apply.' : 'niente da fare.');
    process.exit(0);
  }
  let n = 0;
  for (const b of orphans) if (shOk(`git branch -D "${b}"`)) { n++; console.log(`deleted ${b}`); }
  if (orphans.length) console.log(`[orphans-only] ${n}/${orphans.length} branch orfani cancellati.`);
  process.exit(0);
}

// Aggiorna origin/<main> (best-effort): se è stale, un branch già su main mostra
// ahead>0 e finisce report-only invece di essere potato → riduce l'efficacia del
// cleanup. `--prune` pota i ref remote-tracking stantii (EC5): senza, `git branch
// -r` mostra branch già cancellati su origin → diagnosi falsata ("merged ma
// ancora lì" fantasma).
sh(`git fetch origin ${mainBranch} --prune -q`, { allowFail: true });

// Opera SOLO su worktree dentro le dir di isolamento canoniche (AGENTS.md): il
// checkout principale (`main`) vive fuori da queste e non va MAI toccato. Nota:
// `git rev-parse --show-toplevel` da dentro un worktree dà il path del worktree
// stesso, non del repo principale → non si può identificare main per uguaglianza.
const ISOLATION_RE = /[/\\]\.(?:claude[/\\]worktrees|worktrees)[/\\]/;

// Mappa branch → stato PR (MERGED|CLOSED|OPEN). NON gateare su `gh auth status`:
// scrive lo status su stderr (che sh() scarta) → '' su successo → falso-negativo
// che disabiliterebbe l'intera pulizia PR-based. Ricava ghOk dal risultato di
// `gh pr list` (con --json una lista vuota è "[]", '' = throw = errore reale).
// Protezione OPEN da query DEDICATA `--state open` (set piccolo, mai troncato
// dalla finestra): un branch con PR aperta deve restare protetto anche se la sua
// PR è oltre le N più recenti combinate. Cancellazioni (MERGED|CLOSED) da una
// finestra closed più larga; un MERGED/CLOSED oltre finestra ricade in "no-PR" e
// viene cancellato solo se 0-ahead (= niente di unico), quindi safe.
let ghOk = sh('gh --version', { allowFail: true }) !== '';
const prState = new Map();
const rankState = (s) => ({ OPEN: 3, MERGED: 2, CLOSED: 1 }[s] ?? 0);
function ingestPrs(json) {
  for (const pr of JSON.parse(json)) {
    const prev = prState.get(pr.headRefName);
    if (!prev || rankState(pr.state) > rankState(prev)) prState.set(pr.headRefName, pr.state);
  }
}
if (ghOk) {
  // OPEN: set di protezione, query dedicata, mai troncato silenziosamente.
  const openRaw = sh(`gh pr list --state open --limit 300 --json state,headRefName`, { allowFail: true });
  // closed+merged: candidati alla cancellazione (finestra ampia, recency-sorted).
  const closedRaw = sh(`gh pr list --state all --limit 400 --json state,headRefName`, { allowFail: true });
  if (openRaw === '' && closedRaw === '') {
    ghOk = false; // entrambe throw → gh non utilizzabile
  } else {
    if (closedRaw) ingestPrs(closedRaw);
    if (openRaw) ingestPrs(openRaw); // OPEN ingerito per ultimo: vince sempre via rank
  }
}

// Ritorna il numero di commit unici di `ref` su origin/main, o `null` se git
// fallisce (ref mancante, origin/main non risolto). null = SCONOSCIUTO, MAI
// trattato come 0: i caller cancellano solo su `=== 0` esatto → null preserva.
function aheadOfMain(ref) {
  const n = sh(`git rev-list --count origin/${mainBranch}..${ref}`, { allowFail: true });
  if (n === '') return null;
  const v = Number.parseInt(n, 10);
  return Number.isNaN(v) ? null : v;
}

// --- 1. WORKTREES -----------------------------------------------------------
const wtPorcelain = sh('git worktree list --porcelain');
const worktrees = [];
let cur = null;
for (const line of wtPorcelain.split('\n')) {
  if (line.startsWith('worktree ')) {
    cur = { path: line.slice('worktree '.length), branch: null, detached: false };
    worktrees.push(cur);
  } else if (line.startsWith('branch ')) {
    cur.branch = line.slice('branch refs/heads/'.length);
  } else if (line === 'detached') {
    cur.detached = true;
  }
}

const removeWt = []; // {path, branch}
const reportWt = []; // {path, branch, reason}
for (const wt of worktrees) {
  if (!ISOLATION_RE.test(wt.path)) continue; // fuori da .claude/worktrees|.worktrees → mai toccare (incl. main checkout)
  if (wt.branch === mainBranch) continue;    // doppia guardia: mai il branch default
  const dirty = sh(`git -C "${wt.path}" status --porcelain`, { allowFail: true }).length > 0;
  const state = wt.branch ? prState.get(wt.branch) : undefined;
  if (state === 'OPEN') continue; // PR aperta → lavoro vivo
  if (state === 'MERGED' || state === 'CLOSED') {
    if (dirty) { reportWt.push({ ...wt, reason: `PR ${state} ma worktree DIRTY — ispeziona a mano` }); continue; }
    removeWt.push(wt);
  } else if (wt.detached) {
    reportWt.push({ ...wt, reason: 'detached HEAD, nessuna PR — probabile abbandono (rimuovi a mano se confermi)' });
  } else {
    // Worktree senza PR: NON auto-rimuovere mai. Un worktree clean+0-ahead è
    // indistinguibile da un agent che ha appena fatto EnterWorktree e non ha
    // ancora committato → rimuoverlo distruggerebbe lavoro vivo. Report-only.
    const ahead = wt.branch ? aheadOfMain(wt.branch) : 0;
    reportWt.push({ ...wt, reason: `clean=${!dirty} ahead=${ahead ?? 'unknown'} no-PR — agent forse attivo (anche se 0-ahead = pre-primo-commit), REPORT-ONLY` });
  }
}

// --- 2. BRANCH LOCALI senza worktree ----------------------------------------
const wtBranches = new Set(worktrees.map((w) => w.branch).filter(Boolean));
const allLocal = sh("git for-each-ref --format='%(refname:short)' refs/heads")
  .split('\n').filter(Boolean);

const delBranch = []; // name
const reportBranch = []; // {name, reason}
for (const b of allLocal) {
  if (b === mainBranch) continue;
  if (wtBranches.has(b)) continue; // gestito sopra come worktree
  const state = prState.get(b);
  if (state === 'OPEN') continue;
  if (/^worktree-agent-/.test(b) && aheadOfMain(b) === 0) { delBranch.push(b); continue; }
  if (state === 'MERGED' || state === 'CLOSED') { delBranch.push(b); continue; }
  const ahead = aheadOfMain(b);
  if (ahead === 0) delBranch.push(b); // contenuto già su main
  else reportBranch.push({ name: b, reason: `ahead=${ahead ?? 'unknown'} no-PR — possibile lavoro non in PR, REPORT-ONLY` });
}

// --- OUTPUT + APPLY ---------------------------------------------------------
console.log(`base = origin/${mainBranch} | gh=${ghOk ? 'ok' : 'UNAVAILABLE (solo worktree-agent-*+0-ahead)'} | mode=${APPLY ? 'APPLY' : 'dry-run'}`);
console.log('');

console.log(`worktree da rimuovere (${removeWt.length}):`);
removeWt.forEach((w) => console.log(`  - ${w.path}${w.branch ? ` [${w.branch}]` : ' (detached)'}`));
console.log(`branch locali da cancellare (${delBranch.length}):`);
delBranch.forEach((b) => console.log(`  - ${b}`));

if (reportWt.length || reportBranch.length) {
  console.log('');
  console.log('⚠️  REPORT-ONLY (non toccati — decidi a mano):');
  reportWt.forEach((w) => console.log(`  • worktree ${w.path}${w.branch ? ` [${w.branch}]` : ''} → ${w.reason}`));
  reportBranch.forEach((b) => console.log(`  • branch ${b.name} → ${b.reason}`));
}

if (!APPLY) {
  console.log('');
  console.log('dry-run: niente rimosso. Ri-esegui con --apply per applicare.');
  process.exit(0);
}

let done = 0;
let failed = 0;
for (const w of removeWt) {
  // Conta/logga solo a esito 0: una rimozione fallita (worktree lockato, branch
  // in checkout) NON deve gonfiare il totale.
  if (!shOk(`git worktree remove --force "${w.path}"`)) {
    failed++;
    console.log(`⚠️  FALLITO worktree remove ${w.path} (lockato? in uso?) — saltato`);
    continue;
  }
  if (w.branch) shOk(`git branch -D "${w.branch}"`); // best-effort: la dir è già via
  done++;
  console.log(`removed worktree ${w.path}`);
}
for (const b of delBranch) {
  if (shOk(`git branch -D "${b}"`)) {
    done++;
    console.log(`deleted branch ${b}`);
  } else {
    failed++;
    console.log(`⚠️  FALLITO branch -D ${b} (in checkout? non-merged senza -D?) — saltato`);
  }
}
sh('git worktree prune', { allowFail: true });
console.log('');
console.log(`✓ applicate ${done} rimozioni${failed ? `, ${failed} FALLITE (vedi sopra)` : ''}. ${reportWt.length + reportBranch.length} voci report-only lasciate intatte.`);
