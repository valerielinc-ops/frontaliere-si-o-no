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
//   • branch/worktree `fix/issue-N` SENZA PR ma issue #N CLOSED → delete/remove
//     (leftover issue-fix: pushato senza PR, spesso orfano shallow → ahead unknown;
//      lo stato ISSUE lo sblocca dove il PR-state non esiste — cfr. AGENTS.md)
//   • worktree/branch clean, ahead>0, NESSUNA PR → REPORT-ONLY (può essere pre-PR vivo;
//      upstream-GONE segnalato nel report → tipico worktree Codex fuori dagli hook)
//   • branch con PR OPEN o worktree del repo principale (main) → KEEP, mai toccato
//
// Uso:
//   node scripts/prune-merged-worktrees.mjs           # dry-run, stampa il piano
//   node scripts/prune-merged-worktrees.mjs --apply    # esegue le rimozioni safe
//
// Richiede: git + gh CLI autenticato (per lo stato PR). Senza gh → degrada a
// solo-`worktree-agent-*`-0-ahead + report, senza toccare i branch PR-derivati.

import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';

import { makePrStateResolver, rankPrState } from './lib/pr-state-window.mjs';
import { classifyDirty } from './lib/worktree-dirty.mjs';

import { withSingleFlightLock } from './lib/single-flight-lock.mjs';
import { sweepStaleFetchPacks } from './lib/stale-fetch-pack-sweep.mjs';

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
// SINGLE-FLIGHT + TIMEOUT (incidente 2026-08-17). Il SessionStart hook lancia
// questo script detached: senza guard, N sessioni = N fetch concorrenti sullo
// stesso `.git` che si contendono il lock di git, non finiscono mai e lasciano
// `tmp_pack_*` abortiti (misurati: 23 fetch vivi >20min, 38.8 GB di residui,
// `.git` a 55 GB). Il lock fa lavorare solo il primo; il timeout impedisce che
// un fetch patologico resti appeso per l'intera sessione; lo sweep pota i
// residui che git non pota da sé. Fetch mancato = origin/<main> leggermente
// stale, caso già tollerato dallo script (degrada a report-only, mai a una
// cancellazione a torto).
const gitDir = sh('git rev-parse --git-common-dir', { allowFail: true }) || '.git';
const fetchLock = join(gitDir, 'frontaliere-prune-fetch.lock');

// Il timeout è un guard anti-APPESO, non un tetto al lavoro legittimo: a
// impedire il pile-up ci pensa il lock, non il timeout. Va quindi tenuto SOPRA
// il fetch di catch-up più lento misurato (~20 min per 24'309 commit di
// arretrato, docs/REPO-WEIGHT-STRATEGY.md), altrimenti un repo molto indietro
// vedrebbe ogni tentativo ucciso a metà e resterebbe stale PER SEMPRE, con un
// tmp_pack_* nuovo a ogni giro: esattamente il guasto che questo codice esiste
// per prevenire. Invariante: FETCH_TIMEOUT_MS < STALE_LOCK_MS, o un'altra
// sessione considera abbandonato un lock il cui titolare sta ancora fetchando e
// si torna ai fetch concorrenti. Verificata in tests/prune-fetch-single-flight.
const FETCH_TIMEOUT_MS = 25 * 60 * 1000;

const fetchRun = withSingleFlightLock(fetchLock, () => {
  // execFileSync, NON execSync: `execSync` di una stringa passa da `sh -c`, e il
  // segnale di timeout arriverebbe alla shell, non al `git fetch` figlio (che
  // resterebbe vivo, appeso, con il suo pack temporaneo aperto). Senza shell in
  // mezzo il segnale colpisce git direttamente.
  //
  // SIGTERM e non SIGKILL: git intercetta SIGTERM e rimuove il proprio
  // tmp_pack_* uscendo; con SIGKILL il residuo resta per definizione. Qui la
  // convenzione SIGKILL degli script CI di report NON si applica: quelli
  // uccidono una `gh api` senza stato su disco, questo uccide un trasferimento
  // che sta scrivendo un pack multi-GB.
  try {
    execFileSync('git', ['fetch', 'origin', mainBranch, '--prune', '-q'], {
      stdio: 'ignore',
      timeout: FETCH_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
  } catch {
    /* fetch fallito/scaduto: si prosegue con l'origin/<main> locale (vedi sopra) */
  }
  return sweepStaleFetchPacks(join(gitDir, 'objects', 'pack'));
});

if (!fetchRun.acquired) {
  console.log(`ℹ️  fetch saltato: un'altra istanza tiene ${fetchLock} — uso origin/${mainBranch} locale.`);
} else if (fetchRun.value?.removed) {
  const mb = Math.round(fetchRun.value.bytes / 1048576);
  console.log(`🧹 potati ${fetchRun.value.removed} pack temporanei di fetch abortiti (${mb} MB).`);
}

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
// finestra closed più larga.
//
// La finestra da sola NON basta e non è "safe" cadere in no-PR quando sfora.
// Misurato il 2026-09-04: 400 PR su questo repo coprono NOVE GIORNI (la più
// vecchia in finestra era #6571 del 26-08, la più recente #7332). Il vecchio
// commento si difendeva dicendo che un MERGED fuori finestra «viene cancellato
// solo se 0-ahead, quindi safe» — ma con lo squash-merge i commit del branch
// non sono mai antenati di main, quindi `ahead>0` SEMPRE, anche quando il
// contenuto è interamente su main. Le due condizioni si incastravano e il
// branch restava report-only per sempre: 21 worktree e 14 GB accumulati, con
// #6022, #6299, #6313 e #6855 tutte mergiate e invisibili allo script.
// Da qui `resolvePrState()`: la finestra resta la via veloce, e per i soli
// branch che non risolve si paga UNA query mirata `--head`, che non ha
// finestra. Costo proporzionale ai residui, non al volume di PR del repo.
let ghOk = sh('gh --version', { allowFail: true }) !== '';
const prState = new Map();
function ingestPrs(json) {
  for (const pr of JSON.parse(json)) {
    const prev = prState.get(pr.headRefName);
    if (!prev || rankPrState(pr.state) > rankPrState(prev)) prState.set(pr.headRefName, pr.state);
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

const resolvedViaHead = new Set();
const resolvePrState = makePrStateResolver({
  cache: prState,
  runQuery: (cmd) => sh(cmd, { allowFail: true }),
  enabled: ghOk,
  viaHead: resolvedViaHead,
});

// Un `CLOSED` che la finestra non conosceva puo' venire da qualunque punto
// della storia del repo, e `CLOSED` non e' `MERGED`: quel contenuto NON e' su
// main. Prima di questa query un branch cosi' cadeva nel ramo no-PR e restava
// report-only; allargare il delete a tutta la storia senza guardare `ahead`
// distruggerebbe l'unica copia di lavoro chiuso per un guasto invece che per
// una decisione (il gemello remoto lo protegge con la label
// `autorebase-reopen-failed` dopo l'incidente #5269/#5275; qui quella rete non
// c'e'). `MERGED` resta cancellabile a prescindere: e' il caso che questo
// script esiste per riparare, e lo squash rende `ahead>0` permanente.
function safeToDeleteClosed(branch) {
  if (!resolvedViaHead.has(branch)) return true; // dalla finestra: comportamento invariato
  return aheadOfMain(branch) === 0; // niente di unico da perdere
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

// Per i branch `fix/issue-N`: l'issue #N è CLOSED? La issue-fix automation crea
// `fix/issue-<N>` ma a volte pusha senza mai aprire PR (run fallito/crash) e da
// un checkout shallow → branch ORFANO (no common-ancestor → aheadOfMain=null).
// Quei branch non hanno PR-state (NONE) e ahead unknown → finirebbero report-only
// PER SEMPRE. Lo stato ISSUE (non PR) li sblocca: issue CLOSED = lavoro risolto
// → leftover safe da cancellare (il branch è su origin/reflog se mai servisse).
// Cache per non interrogare gh due volte (loop worktree + loop branch).
const issueStateCache = new Map();
function issueClosed(branch) {
  if (!ghOk) return false;
  const m = /^fix\/issue-(\d+)$/.exec(branch || '');
  if (!m) return false;
  const n = m[1];
  if (!issueStateCache.has(n)) {
    issueStateCache.set(n, sh(`gh issue view ${n} --json state --jq .state`, { allowFail: true }));
  }
  return issueStateCache.get(n) === 'CLOSED';
}

// Upstream configurato ma remote-tracking sparito → `[gone]` in %(upstream:track).
// Segnala (REPORT-only, non cancella) i branch il cui remoto è stato cancellato:
// tipico dei worktree Codex (fuori dagli hook Claude) il cui contenuto è stato
// mergiato altrove. Diagnosi, non azione: ahead>0 + gone resta ambiguo.
function upstreamGone(branch) {
  return sh(`git for-each-ref --format='%(upstream:track)' refs/heads/${branch}`, { allowFail: true }).includes('gone');
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
  const { significant, ignored } = classifyDirty(wt.path);
  const dirty = significant.length > 0;
  const state = wt.branch ? resolvePrState(wt.branch) : undefined;
  if (state === 'OPEN') continue; // PR aperta → lavoro vivo
  if (state === 'CLOSED' && wt.branch && !safeToDeleteClosed(wt.branch)) {
    reportWt.push({
      ...wt,
      reason: `PR CLOSED (non mergiata) trovata fuori finestra e ahead=${aheadOfMain(wt.branch) ?? 'unknown'} — i commit unici sono l'unica copia, REPORT-ONLY`,
    });
    continue;
  }
  if (state === 'MERGED' || state === 'CLOSED') {
    if (dirty) {
      reportWt.push({
        ...wt,
        reason: `PR ${state} ma worktree DIRTY su ${significant.length} file — ispeziona a mano: ${significant.slice(0, 5).join(', ')}`,
      });
      continue;
    }
    if (ignored.length) console.log(`ℹ️  ${wt.path}: ${ignored.length} file sporchi ignorati (output di cron / blocco gitnexus), PR ${state}.`);
    removeWt.push(wt);
  } else if (wt.detached) {
    reportWt.push({ ...wt, reason: 'detached HEAD, nessuna PR — probabile abbandono (rimuovi a mano se confermi)' });
  } else if (issueClosed(wt.branch)) {
    // fix/issue-N senza PR ma issue #N CLOSED → lavoro risolto, worktree leftover.
    if (dirty) reportWt.push({ ...wt, reason: `issue #${/\d+/.exec(wt.branch)[0]} CLOSED ma worktree DIRTY su ${significant.length} file — ispeziona a mano` });
    else removeWt.push(wt);
  } else {
    // Worktree senza PR: NON auto-rimuovere mai. Un worktree clean+0-ahead è
    // indistinguibile da un agent che ha appena fatto EnterWorktree e non ha
    // ancora committato → rimuoverlo distruggerebbe lavoro vivo. Report-only.
    const ahead = wt.branch ? aheadOfMain(wt.branch) : 0;
    const gone = wt.branch && upstreamGone(wt.branch) ? ' upstream-GONE (remoto cancellato — probabile merged/closed altrove, es. worktree Codex)' : '';
    const noise = ignored.length ? ` (+${ignored.length} sporchi ignorati: cron/gitnexus)` : '';
    reportWt.push({ ...wt, reason: `clean=${!dirty}${noise} ahead=${ahead ?? 'unknown'} no-PR${gone} — agent forse attivo (anche se 0-ahead = pre-primo-commit), REPORT-ONLY` });
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
  const state = resolvePrState(b);
  if (state === 'OPEN') continue;
  if (/^worktree-agent-/.test(b) && aheadOfMain(b) === 0) { delBranch.push(b); continue; }
  if (state === 'CLOSED' && !safeToDeleteClosed(b)) {
    reportBranch.push({
      name: b,
      reason: `PR CLOSED (non mergiata) trovata fuori finestra e ahead=${aheadOfMain(b) ?? 'unknown'} — i commit unici sono l'unica copia, REPORT-ONLY`,
    });
    continue;
  }
  if (state === 'MERGED' || state === 'CLOSED') { delBranch.push(b); continue; }
  if (issueClosed(b)) { delBranch.push(b); continue; } // fix/issue-N, issue CLOSED, no PR → leftover
  const ahead = aheadOfMain(b);
  if (ahead === 0) delBranch.push(b); // contenuto già su main
  else reportBranch.push({ name: b, reason: `ahead=${ahead ?? 'unknown'} no-PR${upstreamGone(b) ? ' upstream-GONE' : ''} — possibile lavoro non in PR, REPORT-ONLY` });
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
