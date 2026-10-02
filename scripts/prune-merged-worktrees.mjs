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
//   • worktree con PR MERGED su main e HEAD esatto della PR
//                                      → remove worktree + delete branch
//   • snapshot locale con un commit appartenente a una PR MERGED su main
//                                      → remove/delete (anche con squash-merge)
//   • PR CLOSED con commit unici, PR MERGED verso altro base o HEAD divergente
//                                      → REPORT-ONLY
//   • worktree detached / branch fantasma già su main → remove worktree
//   • worktree detached il cui HEAD è antenato dell'HEAD di una PR MERGED su main
//                                      → remove (snapshot del commit prima)
//   • branch `worktree-agent-*` 0-ahead   → delete (orfano EnterWorktree)
//   • branch locale (no worktree) con PR MERGED su main e HEAD esatto → delete
//   • worktree clean, 0-ahead, NESSUNA PR, fermo da IDLE_WORKTREE_MS e senza
//      processi con la cwd dentro      → remove (niente da perdere: è tutto su main)
//   • worktree/branch clean, ahead>0, NESSUNA PR → REPORT-ONLY (può essere pre-PR vivo;
//      upstream-GONE segnalato nel report → tipico worktree Codex fuori dagli hook)
//   • worktree LOCKED, in uso (cwd di un processo), checkout corrente o hooks-main
//                                      → KEEP, mai toccato
//   • branch con PR OPEN o worktree del repo principale (main) → KEEP, mai toccato
//   • directory sotto le cartelle dei worktree che git non conosce più → remove
//      solo se contiene esclusivamente residui (`.DS_Store`, `node_modules`, il body
//      della PR alla radice) ed è ferma da IDLE_WORKTREE_MS, altrimenti REPORT
//
// Prove di contenuto (2026-10-02, dopo lo smaltimento a mano di ~40 worktree che
// lo sweep lasciava indietro). Valgono solo con le guardie di sempre (fermo da
// IDLE_WORKTREE_MS, nessuna cwd dentro e lsof leggibile, gh disponibile) e ogni
// rimozione lascia prima un tag `snapshot/purge/...`:
//   • commit contenuti in una PR MERGED su main, anche non la propria: HEAD
//      antenato della sua head, catena locale già nel suo albero, commit
//      equivalenti per patch-id a commit della PR con il revert escluso, merge
//      rifatti che differiscono dal gemello solo in file generati. La PR
//      candidata viene dal nome, dall'upstream, dall'associazione commit→PR o
//      dai soggetti dei commit nel corpo dello squash su main
//   • sporco tracciato identico ai blob della PR tra HEAD e la sua head
//   • PR CLOSED con HEAD == headRefOid, chiusa da 7 giorni (resta in
//      refs/pull/N/head), o riapplicata dal flusso automatico (issue
//      «riapplicare la PR #P» COMPLETED + PR `fix/issue-<issue>` MERGED)
//   • vecchio checkout di main: tutto lo sporco uguale a UN commit first-parent
//      di main, fermo da 7 giorni
//   • directory orfana i cui file sono tutti in main allo stesso path
//   • (corpus) head della PR scaricata da refs/pull/N/head se manca, con un
//      tetto per run; PR riconosciuta dallo SHA della head, non dal nome; file
//      identici a un commit della PR (trasporto `identical-twins` rifatto sopra
//      main); commit e sporco identici a origin/main; symlink `node_modules`
//      non tracciato = rumore, tolto senza seguirlo
//   • cartelle `.wt/`, `.worktrees/`, `.claude/worktrees/` della ROOT del
//      workspace: una directory lì è orfana solo se NESSUN repo del workspace la
//      registra, e la prova usa i ref del repo a cui appartiene
// Lo stesso script gira nel sito e nel corpus (cwd nel checkout del repo).
// Ciò che è solo probabile (punta superata, issue chiusa, file in tmp/, sporco
// vecchio su PR mergiata) resta REPORT-ONLY con un'annotazione.
//
// Lo sporco che NON è lavoro (output dei cron, il body della PR scritto per
// `--body-file` quando la PR esiste) non trattiene il worktree:
// scripts/lib/worktree-dirty.mjs. Uno stato git illeggibile invece sì: non si
// rimuove ciò che non si è letto.
//
// Uso:
//   node scripts/prune-merged-worktrees.mjs           # dry-run, stampa il piano
//   node scripts/prune-merged-worktrees.mjs --apply    # esegue le rimozioni safe
//   node scripts/prune-merged-worktrees.mjs --only <testo>  # solo worktree,
//        branch e directory il cui path o nome contiene <testo> (diagnosi)
//
// Richiede: git + gh CLI autenticato (per lo stato PR). Senza gh → degrada a
// solo-`worktree-agent-*`-0-ahead + report, senza toccare i branch PR-derivati.

import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import {
  isMergedIntoBaseAtHead,
  makePrStateResolver,
  pickBestAssociatedPr,
  rankPrState,
  SAFE_BRANCH_RE,
} from './lib/pr-state-window.mjs';
import { classifyDirty } from './lib/worktree-dirty.mjs';
import {
  canDeleteClosedCandidate,
  canRemoveClosedAtHead,
  canRemoveIdleOnMain,
  canRemoveWithProof,
  hasAncestryProof,
  IDLE_WORKTREE_MS,
  isAbortedCheckout,
  isIdleSince,
  isOrphanResidueFile,
  isOrphanSkippablePath,
  isPathBusy,
  isProvenOrphan,
  isReappliedClosedPr,
  isRemovableOrphanDir,
  issueNumbersInBranch,
  namePrefixCandidates,
  needsProofSnapshot,
  needsSnapshot,
  normalizeSubject,
  orphanWindow,
  prNumbersInBranch,
  reportAnnotation,
  squashPrNumber,
  squashSubjects,
  STALE_CHECKOUT_IDLE_MS,
} from './lib/branch-purge-policy.mjs';
import {
  isDanglingGitPointer, makeContentProver, makeGitRunner, nodeModulesLinks, removeTreeNoFollow, workingBlob,
} from './lib/merged-content-proof.mjs';

import { withSingleFlightLock } from './lib/single-flight-lock.mjs';
import { sweepStaleFetchPacks } from './lib/stale-fetch-pack-sweep.mjs';

const STARTED_AT = Date.now();
const APPLY = process.argv.includes('--apply');
// --only <testo>: limita lo sweep ai worktree/branch/directory che lo contengono.
const ONLY = (() => {
  const eq = process.argv.find((a) => a.startsWith('--only='));
  if (eq) return eq.slice('--only='.length) || null;
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1] || null : null;
})();
const selected = (...names) => !ONLY || names.some((n) => typeof n === 'string' && n.includes(ONLY));
// --orphans-only: fast-path sicuro per il SessionEnd hook. Cancella SOLO i branch
// `worktree-agent-<id>` 0-ahead orfani (dir worktree già auto-rimossa da
// EnterWorktree). Zero gh, zero rimozione worktree → non-presidiabile.
const ORPHANS_ONLY = process.argv.includes('--orphans-only');

// Costo dello sweep, stampato in coda: le chiamate gh sono la risorsa scarsa
// (quota condivisa col resto del workspace), le prove il tempo in più.
let ghCalls = 0;
let proofMs = 0;

function sh(cmd, { allowFail = false } = {}) {
  if (cmd.startsWith('gh ')) ghCalls++;
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

function gitOut(args, { allowFail = false, maxBuffer = 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer,
    }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function gitOk(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ghOut(args, { allowFail = false } = {}) {
  ghCalls++;
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw e;
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

// Opera SOLO su worktree dentro le dir di isolamento canoniche (AGENTS.md):
// `.claude/worktrees`, `.worktrees` o `.wt`. Il
// checkout principale (`main`) vive fuori da queste e non va MAI toccato. Nota:
// `git rev-parse --show-toplevel` da dentro un worktree dà il path del worktree
// stesso, non del repo principale → non si può identificare main per uguaglianza.
const ISOLATION_RE = /[/\\]\.(?:claude[/\\]worktrees|worktrees|wt)[/\\]/;

// Mappa branch → stato e metadati PR (MERGED|CLOSED|OPEN). NON gateare su
// `gh auth status`:
// scrive lo status su stderr (che sh() scarta) → '' su successo → falso-negativo
// che disabiliterebbe l'intera pulizia PR-based. Ricava ghOk dal risultato di
// `gh pr list` (con --json una lista vuota è "[]", '' = throw = errore reale).
// Protezione OPEN da query DEDICATA `--state open` (set piccolo, mai troncato
// dalla finestra): un branch con PR aperta deve restare protetto anche se la sua
// PR è oltre le N più recenti combinate. Le sole cancellazioni PR-based sono
// MERGED + base main + HEAD esatto; CLOSED resta sempre report-only.
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
const prRecords = new Map();
const prByNumber = new Map(); // numero → record, per le PR candidate delle prove
// headRefOid → record: la PR si riconosce dallo SHA, non dal nome. Nel corpus i
// branch locali hanno spesso un nome diverso dalla PR (`merge-deps-1991` contro
// `update-all-dependencies`), sono detached, o riusano `fix/issue-N` di PR diverse.
const prByHeadOid = new Map();
const windowPrs = []; // tutte le PR lette in blocco, per le candidate per nome
const PR_JSON_FIELDS = 'number,state,baseRefName,headRefName,headRefOid,closedAt';
function ingestPrs(json) {
  let prs;
  try { prs = JSON.parse(json); } catch { return; }
  for (const pr of prs) {
    if (!pr?.headRefName) continue;
    if (Number.isInteger(pr.number) && !prByNumber.has(pr.number)) {
      prByNumber.set(pr.number, pr);
      windowPrs.push(pr);
    }
    if (pr.headRefOid) {
      const byOid = prByHeadOid.get(pr.headRefOid) || [];
      if (!byOid.some((r) => r.number === pr.number)) byOid.push(pr);
      prByHeadOid.set(pr.headRefOid, byOid);
    }
    const records = prRecords.get(pr.headRefName) || [];
    if (records.some((r) => r.number === pr.number && r.headRefOid === pr.headRefOid)) continue;
    records.push(pr);
    prRecords.set(pr.headRefName, records);
    const prev = prState.get(pr.headRefName);
    if (!prev || rankPrState(pr.state) > rankPrState(prev)) prState.set(pr.headRefName, pr.state);
  }
}
if (ghOk) {
  // OPEN: set di protezione, query dedicata, mai troncato silenziosamente.
  const openRaw = sh(`gh pr list --state open --limit 300 --json ${PR_JSON_FIELDS}`, { allowFail: true });
  // all: finestra ampia, recency-sorted; i residui fuori finestra usano --head.
  const allRaw = sh(`gh pr list --state all --limit 400 --json ${PR_JSON_FIELDS}`, { allowFail: true });
  if (openRaw === '' && allRaw === '') {
    ghOk = false; // entrambe throw → gh non utilizzabile
  } else {
    if (allRaw) ingestPrs(allRaw);
    if (openRaw) ingestPrs(openRaw); // OPEN ingerito per ultimo: vince sempre via rank
  }
}

const resolvePrState = makePrStateResolver({
  cache: prState,
  runQuery: (cmd) => {
    const raw = sh(cmd, { allowFail: true });
    if (raw) ingestPrs(raw);
    return raw;
  },
  enabled: ghOk,
});

// Un branch locale puo' essere uno snapshot con un nome diverso da quello
// della PR (oppure un checkout fermato a un commit intermedio della PR). In
// quel caso `gh pr list --head` non lo trova, ma GitHub mantiene l'associazione
// commit → PR. La consultiamo solo per branch non gia' risolti come OPEN o come
// HEAD esatto di una PR MERGED, cosi' il purge programmato non paga una query
// per i branch ordinari 0-ahead.
const repoSlug = ghOk
  ? sh('gh repo view --json nameWithOwner --jq .nameWithOwner', { allowFail: true })
  : '';
const associatedPrCache = new Map(); // commit SHA → record PR migliore o null
const ancestryProofCache = new Map(); // local tip...PR head → boolean
const branchPrResolution = new Map(); // branch → { state, source, pr, sha }

function associatedPrForCommit(sha) {
  if (!ghOk || !repoSlug || !sha) return undefined;
  if (associatedPrCache.has(sha)) return associatedPrCache.get(sha) || undefined;
  // `--slurp` senza `--jq`: il gh reale rifiuta la combinazione, e con
  // `allowFail` il rifiuto sembrava «nessuna PR associata». L'array di pagine
  // si appiattisce qui.
  const raw = sh(
    `gh api --paginate --slurp "repos/${repoSlug}/commits/${sha}/pulls"`,
    { allowFail: true },
  );
  let best;
  if (raw) {
    try {
      best = pickBestAssociatedPr(JSON.parse(raw).flat(), { baseBranch: mainBranch });
    } catch {
      best = undefined;
    }
  }
  associatedPrCache.set(sha, best || null);
  return best;
}

function commitIsAncestorOfPrHead(localTip, pr) {
  const prHead = pr?.head?.sha || pr?.headRefOid;
  if (!localTip || !prHead) return false;
  const key = `${localTip}...${prHead}`;
  if (ancestryProofCache.has(key)) return ancestryProofCache.get(key);
  // Prima la prova locale: se l'HEAD della PR è nel clone, il DAG di git dà la
  // stessa risposta di GitHub. L'endpoint compare risponde 422 «this diff is
  // taking too long to generate» appena i due commit sono lontani (misurato il
  // 2026-10-02 su #8862, #8849, #10025, #10051, #10417): la prova remota da
  // sola lasciava report-only proprio i branch di risoluzione più vecchi.
  if (gitOk(['cat-file', '-e', `${prHead}^{commit}`]) || ensurePrHead({ number: pr?.number, headRefOid: prHead })) {
    const provenLocally = gitOk(['merge-base', '--is-ancestor', localTip, prHead]);
    ancestryProofCache.set(key, provenLocally);
    return provenLocally;
  }
  if (!repoSlug) return false;
  const raw = ghOut([
    'api',
    `repos/${repoSlug}/compare/${localTip}...${prHead}`,
    '--jq',
    '{behind_by,status}',
  ], { allowFail: true });
  let proven = false;
  if (raw) {
    try { proven = hasAncestryProof(JSON.parse(raw)); } catch { /* report-only */ }
  }
  ancestryProofCache.set(key, proven);
  return proven;
}

function resolveBranchPrState(branch) {
  if (!branch) return undefined;
  const namedState = resolvePrState(branch);
  const head = headOfLocalBranch(branch);

  // OPEN resta sempre protetta. Un MERGED con HEAD esatto ha gia' la prova piu'
  // forte disponibile e non deve generare una chiamata REST aggiuntiva.
  if (namedState === 'OPEN') {
    branchPrResolution.set(branch, { state: namedState, source: 'branch-name', sha: head });
    return namedState;
  }
  if (namedState === 'MERGED' && mergedPrAtHead(branch, head)) {
    branchPrResolution.set(branch, { state: namedState, source: 'head', sha: head });
    return namedState;
  }

  // `ahead===0` e' gia' una prova sufficiente per il cleanup conservativo:
  // non c'e' un commit locale unico da perdere. Evita la query commit→PR sui
  // branch appena creati e sugli orfani già confluiti.
  if (aheadOfMain(branch) === 0) {
    branchPrResolution.set(branch, { state: namedState, source: namedState ? 'branch-name' : 'none', sha: head });
    return namedState;
  }

  const associated = associatedPrForCommit(head);
  const associatedMerged = associated?.state === 'MERGED';
  const ancestryProven = !associatedMerged || commitIsAncestorOfPrHead(head, associated);
  if (associated && ancestryProven && (
    !namedState
    || rankPrState(associated.state) > rankPrState(namedState)
    || (namedState === 'MERGED' && associated.state === 'MERGED')
  )) {
    branchPrResolution.set(branch, {
      state: associated.state,
      source: 'commit',
      pr: associated,
      sha: head,
      ancestryProven: associatedMerged,
    });
    return associated.state;
  }

  branchPrResolution.set(branch, {
    state: namedState,
    source: namedState ? 'branch-name' : 'none',
    sha: head,
  });
  return namedState;
}

function mergedPrAtHead(branch, head) {
  return (prRecords.get(branch) || []).some((pr) => isMergedIntoBaseAtHead(pr, {
    baseBranch: mainBranch,
    headOid: head,
  }));
}

// Ritorna il numero di commit unici di `ref` su origin/main, o `null` se git
// fallisce (ref mancante, origin/main non risolto). null = SCONOSCIUTO, MAI
// trattato come 0: i caller cancellano solo su `=== 0` esatto → null preserva.
const aheadCache = new Map();
function aheadOfMain(ref) {
  if (aheadCache.has(ref)) return aheadCache.get(ref);
  const n = sh(`git rev-list --count origin/${mainBranch}..${ref}`, { allowFail: true });
  if (n === '') {
    aheadCache.set(ref, null);
    return null;
  }
  const v = Number.parseInt(n, 10);
  const ahead = Number.isNaN(v) ? null : v;
  aheadCache.set(ref, ahead);
  return ahead;
}

// Upstream configurato ma remote-tracking sparito → `[gone]` in %(upstream:track).
// Segnala (REPORT-only, non cancella) i branch il cui remoto è stato cancellato:
// tipico dei worktree Codex (fuori dagli hook Claude) il cui contenuto è stato
// mergiato altrove. Diagnosi, non azione: ahead>0 + gone resta ambiguo.
function upstreamGone(branch) {
  return sh(`git for-each-ref --format='%(upstream:track)' refs/heads/${branch}`, { allowFail: true }).includes('gone');
}

// --- 1. WORKTREES -----------------------------------------------------------
const repoRoot = sh('git rev-parse --show-toplevel', { allowFail: true });
function canonicalPath(pathname) {
  const absolute = resolve(pathname);
  try { return realpathSync(absolute); } catch { return absolute; }
}

const currentWorktree = canonicalPath(repoRoot || process.cwd());
const infrastructureWorktrees = new Set([
  canonicalPath(process.env.FRONTALIERE_SITE_HOOKS_DIR || join(repoRoot, '.claude/worktrees/hooks-main')),
  canonicalPath(join(repoRoot, '.worktrees/hooks-main')),
]);
function isInfrastructureWorktree(pathname) {
  const canonical = canonicalPath(pathname);
  return infrastructureWorktrees.has(canonical)
    || (basename(canonical) === 'hooks-main' && ISOLATION_RE.test(canonical));
}

function isCurrentWorktree(pathname) {
  return canonicalPath(pathname) === currentWorktree;
}

function headOfLocalBranch(branch) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isAncestorOfMain(ref) {
  if (!ref) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ref, `origin/${mainBranch}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// Directory amministrativa del worktree (`.git/worktrees/<id>`): ci sono HEAD,
// index e reflog, cioè i file che un agente vivo tocca.
function adminDirOf(wtPath) {
  return gitOut(['-C', wtPath, 'rev-parse', '--absolute-git-dir'], { allowFail: true });
}

// Ultima attività git del worktree. La radice del working tree conta perché
// creare/cancellare un file in cima ne cambia la data; le modifiche più in
// profondità rendono il worktree sporco, e quello basta già a tenerlo.
function lastActivityMs(wtPath, adminDir) {
  let newest = 0;
  for (const p of [join(adminDir, 'HEAD'), join(adminDir, 'index'), join(adminDir, 'logs', 'HEAD'), wtPath]) {
    try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* assente: non è attività */ }
  }
  return newest;
}

// true se ogni file (o symlink) presente nel working tree è identico al suo
// blob in HEAD: un checkout interrotto ha scritto solo contenuto già in git.
// Oltre `limit` file non è un checkout interrotto e non si controlla oltre.
function workingFilesMatchHead(wtPath, head, limit = 2000) {
  if (!head) return false;
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (dir === wtPath && entry.name === '.git') continue;
      if (entry.isDirectory()) {
        if (!walk(full)) return false;
      } else {
        files.push(relative(wtPath, full));
        if (files.length > limit) return false;
      }
    }
    return true;
  };
  if (!walk(wtPath)) return false;
  for (const rel of files) {
    let blob;
    try {
      blob = execFileSync('git', ['cat-file', 'blob', `${head}:${rel}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    } catch { return false; } // non tracciato in HEAD → potrebbe essere lavoro
    let local;
    try {
      const full = join(wtPath, rel);
      local = lstatSync(full).isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full);
    } catch { return false; }
    if (!blob.equals(local)) return false;
  }
  return true;
}

// cwd di tutti i processi visibili. `known: false` se lsof non risponde: le
// regole che dipendono dall'inattività allora non si applicano.
function processCwds() {
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-F', 'n'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 30000,
    });
    return { known: true, cwds: out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)) };
  } catch (e) {
    // lsof esce 1 anche quando alcuni processi non sono leggibili: l'output
    // parziale resta valido se c'è.
    const out = typeof e?.stdout === 'string' ? e.stdout : '';
    const cwds = out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
    return { known: cwds.length > 0, cwds };
  }
}
const busySnapshot = processCwds();
function isBusy(wtPath) {
  return isPathBusy(wtPath, busySnapshot.cwds) || isPathBusy(canonicalPath(wtPath), busySnapshot.cwds);
}

function hasSnapshotTag(branch) {
  return hasSnapshotAt(`refs/heads/${branch}`);
}

function hasSnapshotAt(rev) {
  return gitOut(['tag', '--points-at', rev], { allowFail: true })
    .split('\n')
    .some((tag) => tag.startsWith('snapshot/'));
}

function snapshotTagName(branch) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const safe = branch.replace(/[^A-Za-z0-9._-]+/g, '--').replace(/-+/g, '-').slice(0, 160);
  const base = `snapshot/purge/${safe}-${stamp}`;
  let candidate = base;
  let n = 2;
  while (gitOk(['show-ref', '--verify', '--quiet', `refs/tags/${candidate}`])) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

function snapshotNeeded(branch, state, ahead) {
  return needsSnapshot({ prState: state, ahead, hasSnapshot: hasSnapshotTag(branch) });
}

function snapshotBeforeDelete(branch, required) {
  if (!required) return true;
  const sha = headOfLocalBranch(branch);
  if (!sha) return false;
  const tag = snapshotTagName(branch);
  if (!gitOk(['tag', tag, sha])) return false;
  console.log(`snapshot ${tag} -> ${sha.slice(0, 12)}`);
  return true;
}

// Worktree detached: nessun branch tiene in vita il commit dopo la rimozione,
// quindi lo snapshot va sul commit stesso.
function snapshotDetachedBeforeRemove(sha, required) {
  if (!required) return true;
  if (!sha) return false;
  const tag = snapshotTagName(`detached-${sha.slice(0, 12)}`);
  if (!gitOk(['tag', tag, sha])) return false;
  console.log(`snapshot ${tag} -> ${sha.slice(0, 12)}`);
  return true;
}

// --- PROVE DI CONTENUTO -------------------------------------------------------
// Le regole stanno in scripts/lib/branch-purge-policy.mjs, i fatti li legge
// scripts/lib/merged-content-proof.mjs. Qui solo la scelta delle PR candidate
// (nome, upstream, commit→PR, soggetti nello squash) con un tetto di chiamate:
// la lista PR in blocco è già in memoria, il resto costa una chiamata per PR.
const mainRef = `origin/${mainBranch}`;
const prover = makeContentProver({ git: makeGitRunner(process.cwd()), mainRef });
const MAX_CANDIDATES = 5; // PR provate per worktree
const MAX_PR_LOOKUPS = 12; // `gh api pulls/<n>` per run, per le PR fuori finestra
const MAX_REAPPLY_LOOKUPS = 6; // ricerche dell'issue di riapplicazione per run
const SQUASH_SCAN_DAYS = 60; // storia first-parent di main letta per i soggetti
let prLookups = 0;
let reapplyLookups = 0;

function timed(fn) {
  const t0 = Date.now();
  try { return fn(); } finally { proofMs += Date.now() - t0; }
}

// I tre formati (gh pr list, REST commit→PR, REST pulls/<n>) in quello di gh pr list.
function asPrRecord(pr) {
  if (!pr) return undefined;
  const state = pr.merged_at || pr.mergedAt ? 'MERGED' : String(pr.state || '').toUpperCase();
  return {
    number: pr.number,
    state,
    baseRefName: pr.baseRefName || pr.base?.ref,
    headRefName: pr.headRefName || pr.head?.ref,
    headRefOid: pr.headRefOid || pr.head?.sha,
    closedAt: pr.closedAt || pr.closed_at || null,
  };
}

function prRecordByNumber(n) {
  if (!Number.isInteger(n)) return undefined;
  if (prByNumber.has(n)) return prByNumber.get(n) || undefined;
  if (!ghOk || !repoSlug || prLookups >= MAX_PR_LOOKUPS) return undefined;
  prLookups++;
  const raw = ghOut(['api', `repos/${repoSlug}/pulls/${n}`], { allowFail: true });
  let record;
  try { record = raw ? asPrRecord(JSON.parse(raw)) : undefined; } catch { record = undefined; }
  prByNumber.set(n, record || null);
  return record;
}

// Indice soggetto → PR dagli squash su main: «titolo (#N)» più le righe
// `* soggetto` dei commit della PR. Letto una volta per run.
let squashIndex = null;
function squashCandidates(tip) {
  const subjects = gitOut(['log', '--no-merges', '--format=%s', '--max-count=120', tip, '--not', mainRef], { allowFail: true })
    .split('\n').map(normalizeSubject).filter(Boolean);
  if (!subjects.length) return [];
  if (!squashIndex) {
    squashIndex = new Map();
    // Solo gli squash (`(#N)` in coda al soggetto): su main passano anche
    // decine di migliaia di commit dei bot, 29 MB di messaggi in 60 giorni
    // misurati il 2026-10-02, contro 3,5 MB degli squash.
    const raw = gitOut(['log', '--first-parent', `--since=${SQUASH_SCAN_DAYS} days ago`, '-E', '--grep=\\(#[0-9]+\\)$',
      '--format=%x1e%s%x1f%b', mainRef], { allowFail: true, maxBuffer: 256 * 1024 * 1024 });
    for (const record of raw.split('\x1e')) {
      const [subject, body] = record.split('\x1f');
      const n = squashPrNumber(subject);
      if (!n) continue;
      for (const line of squashSubjects(subject, body)) {
        if (!squashIndex.has(line)) squashIndex.set(line, new Set());
        squashIndex.get(line).add(n);
      }
    }
  }
  const votes = new Map();
  for (const subject of subjects) {
    for (const n of squashIndex.get(subject) || []) votes.set(n, (votes.get(n) || 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 3).map(([n]) => n);
}

function upstreamHeadRef(branch) {
  if (!SAFE_BRANCH_RE.test(branch || '')) return null;
  const merge = gitOut(['config', '--get', `branch.${branch}.merge`], { allowFail: true });
  return merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : null;
}

function recordsForHeadRef(ref) {
  if (!ref || !SAFE_BRANCH_RE.test(ref)) return [];
  resolvePrState(ref);
  return prRecords.get(ref) || [];
}

// L'HEAD di una PR candidata deve essere nel clone. Il corpus (e il sito,
// con delete_branch_on_merge) cancella il branch remoto al merge: l'HEAD resta
// solo in refs/pull/N/head. Si scarica solo per le PR candidate, con un tetto
// per run, sotto lo stesso lock single-flight del fetch di main e con un
// timeout (AGENTS.md: hook non presidiato che fa rete). Lock occupato, tetto
// raggiunto o fetch fallito = niente prova, mai un'eccezione.
const MAX_PR_FETCHES = 6;
const PR_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
let prFetches = 0;

function ensurePrHead(pr) {
  const oid = pr?.headRefOid;
  if (!oid) return false;
  if (prover.hasCommit(oid)) return true;
  if (!Number.isInteger(pr.number) || prFetches >= MAX_PR_FETCHES) return false;
  prFetches++;
  let run;
  try {
    run = withSingleFlightLock(fetchLock, () => {
      try {
        execFileSync('git', ['fetch', '--no-write-fetch-head', '-q', 'origin', `refs/pull/${pr.number}/head`], {
          stdio: 'ignore', timeout: PR_FETCH_TIMEOUT_MS, killSignal: 'SIGTERM',
        });
      } catch { /* PR assente o rete giù: niente prova */ }
    });
  } catch { return false; }
  return run?.acquired === true && prover.hasCommit(oid);
}

// PR MERGED su main in cui cercare il contenuto, in ordine di plausibilità.
function mergedCandidates({ branch, head }) {
  const list = [];
  const push = (pr) => {
    const rec = asPrRecord(pr);
    if (!rec || rec.state !== 'MERGED' || rec.baseRefName !== mainBranch || !rec.headRefOid) return;
    if (list.some((x) => x.headRefOid === rec.headRefOid)) return;
    list.push(rec);
  };
  for (const pr of prByHeadOid.get(head) || []) push(pr); // stesso SHA, qualunque nome
  if (branch) {
    for (const pr of prRecords.get(branch) || []) push(pr);
    for (const pr of namePrefixCandidates(branch, windowPrs)) push(pr);
    const up = upstreamHeadRef(branch);
    if (up && up !== branch) for (const pr of recordsForHeadRef(up)) push(pr);
    // `repair-pr-1851`, `verify-pr1871-remote`: il numero nel nome indica la PR.
    for (const n of prNumbersInBranch(branch).slice(0, 3)) push(prRecordByNumber(n));
  }
  push(associatedPrForCommit(head));
  // Merge rifatto (detached): GitHub conosce i genitori, non il merge locale.
  const parents = gitOut(['rev-list', '--parents', '-n', '1', head], { allowFail: true }).split(' ').slice(1);
  if (parents.length > 1) push(associatedPrForCommit(parents[0]));
  for (const n of squashCandidates(head)) {
    if (list.length >= MAX_CANDIDATES) break;
    push(prRecordByNumber(n));
  }
  return list.slice(0, MAX_CANDIDATES);
}

// PR CLOSED che potrebbero contenere l'HEAD: la propria, quella dell'upstream,
// e le `fix/issue-N` dei numeri nel nome del branch.
function closedCandidates(branch) {
  if (!branch) return [];
  const refs = [branch, upstreamHeadRef(branch), ...issueNumbersInBranch(branch).slice(0, 2).map((n) => `fix/issue-${n}`)];
  const list = [];
  for (const ref of [...new Set(refs.filter(Boolean))]) {
    for (const pr of ref === branch ? prRecords.get(branch) || [] : recordsForHeadRef(ref)) {
      if (pr.state === 'CLOSED' && pr.headRefOid && !list.some((x) => x.number === pr.number)) list.push(pr);
    }
  }
  return list;
}

function reapplyIssues(prNumber) {
  if (!ghOk || reapplyLookups >= MAX_REAPPLY_LOOKUPS) return [];
  reapplyLookups++;
  const raw = ghOut(['issue', 'list', '--state', 'closed', '--limit', '10',
    '--search', `"riapplicare la PR #${prNumber}" in:title`,
    '--json', 'number,title,state,stateReason'], { allowFail: true });
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// B2-2: HEAD dentro la head di una PR CLOSED che il flusso automatico ha
// riapplicato su main.
function reappliedProof(head, closedPr) {
  if (!ensurePrHead(closedPr) || !prover.isAncestor(head, closedPr.headRefOid)) return null;
  for (const issue of reapplyIssues(closedPr.number)) {
    const reapplyPr = recordsForHeadRef(`fix/issue-${issue.number}`)
      .find((pr) => pr.state === 'MERGED' && pr.baseRefName === mainBranch);
    if (isReappliedClosedPr({ closedPr, issue, reapplyPr, baseBranch: mainBranch })) return { issue, reapplyPr };
  }
  return null;
}

// Esiti NEGATIVI delle prove, per branch e tip, nella directory comune di git:
// un branch che resta report-only non si riprova a ogni sessione (1-3 s e
// qualche chiamata gh ciascuno, misurati il 2026-10-02). Solo i negativi e
// solo a stato pulito: una rimozione si decide sempre a fresco, e un tip nuovo
// è una chiave nuova. Dopo PROOF_CACHE_TTL_MS si riprova (una PR mergiata nel
// frattempo può contenere il lavoro).
const PROOF_CACHE_FILE = join(gitDir, 'frontaliere-prune-proofs.json');
const PROOF_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const proofCache = (() => {
  if (process.env.PRUNE_PROOF_CACHE === '0') return null;
  try {
    const parsed = JSON.parse(readFileSync(PROOF_CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
})();
let proofCacheChanged = false;

function cachedNegative(key) {
  const entry = proofCache?.[key];
  return entry && Date.now() - entry.at < PROOF_CACHE_TTL_MS ? entry : null;
}

function rememberNegative(key, notes) {
  if (!proofCache) return;
  proofCache[key] = { at: Date.now(), notes };
  proofCacheChanged = true;
}

function saveProofCache() {
  if (!proofCache || !proofCacheChanged) return;
  for (const [key, entry] of Object.entries(proofCache)) {
    if (!(Date.now() - entry?.at < PROOF_CACHE_TTL_MS)) delete proofCache[key];
  }
  const tmp = `${PROOF_CACHE_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(proofCache));
    renameSync(tmp, PROOF_CACHE_FILE); // atomico: due sweep concorrenti non lo corrompono
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* niente da pulire */ }
  }
}

// Il cuore delle regole nuove, per un worktree o un branch. `wtPath` assente =
// branch senza worktree: solo i commit contano. Ritorna { remove } con il
// motivo, oppure le note per il report.
function contentProof({ head, branch, wtPath = null, dirty = false, prExists = false, activityMs = 0, indexMs = 0 }) {
  const cacheKey = !dirty && head ? `${branch || '-'}@${head}` : null;
  const cached = cacheKey ? cachedNegative(cacheKey) : null;
  if (cached) return { notes: cached.notes || {} };
  const result = timed(() => {
    const notes = {};
    if (!head) return { notes };
    // HEAD già su main: non c'è un commit da provare, solo l'eventuale sporco.
    const onMain = aheadOfMain(head) === 0;
    for (const pr of onMain ? [] : mergedCandidates({ branch, head })) {
      if (!ensurePrHead(pr)) continue;
      const chain = prover.proveChain(head, pr.headRefOid);
      if (!chain.proven) {
        if (chain.sharesPr && !notes.partialPr) notes.partialPr = { number: pr.number, unproven: chain.unproven, example: chain.example };
        continue;
      }
      if (!dirty) return { remove: `contenuto nella PR #${pr.number} MERGED: ${chain.how}` };
      const d = prover.dirtyProof(wtPath, head, pr.headRefOid, { prExists });
      if (d.proven) return { remove: `contenuto nella PR #${pr.number} MERGED: ${chain.how}; ${d.files} file non committati identici a blob della PR` };
      if (d.tmpOnly && !notes.tmpOnly) notes.tmpOnly = { number: pr.number, count: d.tmpOnly };
      notes.provenPr = notes.provenPr || pr;
    }
    // PR con questo HEAD esatto, per nome o per SHA (detached, nomi diversi).
    const sameHeadPrs = [...(branch ? prRecords.get(branch) || [] : []), ...(prByHeadOid.get(head) || [])];
    if (!onMain) {
      const atHead = sameHeadPrs.find((pr) => canRemoveClosedAtHead({ pr, head, dirty }));
      if (atHead) {
        return { remove: `PR #${atHead.number} CLOSED il ${String(atHead.closedAt).slice(0, 10)} con HEAD identico alla sua head: il contenuto resta in refs/pull/${atHead.number}/head` };
      }
    }
    if (branch && !onMain) {
      for (const closedPr of closedCandidates(branch)) {
        const reapplied = reappliedProof(head, closedPr);
        if (!reapplied) continue;
        const why = `PR #${closedPr.number} CLOSED riapplicata: issue #${reapplied.issue.number} COMPLETED, PR #${reapplied.reapplyPr.number} MERGED; HEAD dentro refs/pull/${closedPr.number}/head`;
        if (!dirty) return { remove: why };
        const d = prover.dirtyProof(wtPath, head, closedPr.headRefOid, { prExists: true });
        if (d.proven) return { remove: `${why}; ${d.files} file non committati identici a blob della PR` };
      }
    }
    // CA6: commit propri e sporco tutti identici a origin/main (PR CLOSED il cui
    // contenuto è arrivato su main per un'altra strada, o nessuna PR).
    if (!onMain || dirty) {
      const same = prover.identicalToMain(wtPath, head, { prExists });
      const atPrHead = sameHeadPrs.find((pr) => pr.headRefOid === head);
      if (same.proven && (!same.overridden.length || atPrHead)) {
        const kept = same.overridden.length ? `; ${same.overridden.length} versioni committate restano in refs/pull/${atPrHead.number}/head` : '';
        return { remove: `contenuto identico a origin/main: ${same.files} file allo stesso path${kept}` };
      }
    }
    if (wtPath && dirty && onMain && isIdleSince(activityMs, { idleMs: STALE_CHECKOUT_IDLE_MS })) {
      const stale = prover.staleMainCheckout(wtPath, head, { aroundMs: indexMs || activityMs, prExists });
      if (stale.proven) {
        return { remove: `vecchio checkout di main: ${stale.files} file sporchi identici a ${stale.commit.slice(0, 12)} (first-parent di main)` };
      }
    }
    return { notes };
  });
  if (cacheKey && !result.remove) rememberNegative(cacheKey, result.notes);
  return result;
}

// Report: i casi che NON sono prove ma meritano un'indicazione. Le issue nel
// nome si leggono alla fine, in una sola chiamata GraphQL.
const pendingIssueNotes = []; // { entry, numbers }
function attachNotes(entry, notes = {}, { dirty = false, activityMs = 0, state } = {}) {
  const staleDays = activityMs ? Math.floor((Date.now() - activityMs) / 86400000) : 0;
  const staleDirty = dirty && isIdleSince(activityMs, { idleMs: STALE_CHECKOUT_IDLE_MS })
    && (state === 'MERGED' || notes.provenPr)
    ? { days: staleDays, what: `PR #${notes.provenPr?.number ?? entry.resolution?.pr?.number ?? '?'} mergiata` }
    : null;
  const note = reportAnnotation({ partialPr: notes.partialPr, tmpOnly: notes.tmpOnly, staleDirty });
  if (note) entry.reason = `${entry.reason} — ${note}`;
  const numbers = issueNumbersInBranch(entry.branch || entry.name || '').slice(0, 3);
  if (numbers.length) pendingIssueNotes.push({ entry, numbers, dirty, activityMs });
  return entry;
}

function resolveIssueNotes() {
  if (!pendingIssueNotes.length || !ghOk || !repoSlug) return;
  const numbers = [...new Set(pendingIssueNotes.flatMap((p) => p.numbers))].slice(0, 40);
  const [owner, name] = repoSlug.split('/');
  const fields = numbers.map((n) => `i${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { state stateReason } }`).join(' ');
  const raw = ghOut(['api', 'graphql', '-f', `query=query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`], { allowFail: true });
  let repo;
  try { repo = JSON.parse(raw)?.data?.repository; } catch { repo = null; }
  if (!repo) return;
  for (const { entry, numbers: own, dirty, activityMs } of pendingIssueNotes) {
    for (const n of own) {
      const issue = repo[`i${n}`];
      if (issue?.__typename !== 'Issue' || issue.state !== 'CLOSED') continue;
      const note = reportAnnotation({ closedIssue: { number: n, stateReason: issue.stateReason } });
      const stale = dirty && isIdleSince(activityMs, { idleMs: STALE_CHECKOUT_IDLE_MS })
        ? `; ${reportAnnotation({ staleDirty: { days: Math.floor((Date.now() - activityMs) / 86400000), what: `issue #${n} chiusa` } })}`
        : '';
      entry.reason = `${entry.reason} — ${note}${stale}`;
      break;
    }
  }
}

function proofGuardsOk() {
  return ghOk && busySnapshot.known;
}

// Ultimo aggiornamento di un branch senza worktree: il suo reflog, altrimenti
// la data del commit.
function branchActivityMs(branch) {
  try { return statSync(join(gitDir, 'logs', 'refs', 'heads', branch)).mtimeMs; } catch { /* niente reflog */ }
  const ct = Number.parseInt(gitOut(['log', '-1', '--format=%ct', `refs/heads/${branch}`], { allowFail: true }), 10);
  return Number.isFinite(ct) ? ct * 1000 : 0;
}

const wtPorcelain = sh('git worktree list --porcelain');
const worktrees = [];
let cur = null;
for (const line of wtPorcelain.split('\n')) {
  if (line.startsWith('worktree ')) {
    cur = {
      path: line.slice('worktree '.length),
      branch: null,
      head: null,
      detached: false,
      locked: false,
      lockReason: '',
      prunable: false,
    };
    worktrees.push(cur);
  } else if (line.startsWith('branch ')) {
    cur.branch = line.slice('branch refs/heads/'.length);
  } else if (line.startsWith('HEAD ')) {
    cur.head = line.slice('HEAD '.length);
  } else if (line === 'detached') {
    cur.detached = true;
  } else if (line === 'locked') {
    cur.locked = true;
  } else if (line.startsWith('locked ')) {
    cur.locked = true;
    cur.lockReason = line.slice('locked '.length);
  } else if (line.startsWith('prunable')) {
    cur.prunable = true;
  }
}

const removeWt = []; // {path, branch}
const reportWt = []; // {path, branch, reason}
for (const wt of worktrees) {
  if (!ISOLATION_RE.test(wt.path)) continue; // fuori da .claude/worktrees|.worktrees|.wt → mai toccare (incl. main checkout)
  if (!selected(wt.path, wt.branch)) continue;
  if (isCurrentWorktree(wt.path)) {
    reportWt.push({ ...wt, reason: 'checkout corrente — KEEP, mai rimuovere automaticamente' });
    continue;
  }
  if (isInfrastructureWorktree(wt.path)) {
    reportWt.push({ ...wt, reason: 'worktree infrastrutturale hooks-main — KEEP, viene riallineato da bin/site-hooks-refresh' });
    continue;
  }
  if (wt.locked) {
    reportWt.push({
      ...wt,
      reason: `worktree LOCKED${wt.lockReason ? ` (${wt.lockReason})` : ''} — KEEP, sblocco esplicito richiesto`,
    });
    continue;
  }
  if (wt.prunable) {
    reportWt.push({ ...wt, reason: 'directory assente (prunable) — ne pota i metadati `git worktree prune` in --apply' });
    continue;
  }
  if (wt.branch === mainBranch) continue;    // doppia guardia: mai il branch default
  if (isBusy(wt.path)) {
    reportWt.push({ ...wt, reason: 'in uso: un processo ha la cwd dentro il worktree — KEEP' });
    continue;
  }
  const adminDir = adminDirOf(wt.path);
  const hasIndex = adminDir ? existsSync(join(adminDir, 'index')) : true;
  const aborted = Boolean(adminDir) && isAbortedCheckout({
    hasIndex,
    onlyHeadContent: !hasIndex && workingFilesMatchHead(wt.path, wt.head || (wt.branch ? headOfLocalBranch(wt.branch) : '')),
  });
  // Checkout mai completato: `git status` vede tutto "cancellato", ma non c'è
  // un solo file da perdere.
  const { significant, ignored, error: statusError } = aborted
    ? { significant: [], ignored: [], error: false }
    : classifyDirty(wt.path);
  const dirty = statusError || significant.length > 0;
  const dirtyNote = statusError
    ? 'stato git illeggibile'
    : `DIRTY su ${significant.length} file`;
  const head = wt.head || (wt.branch ? headOfLocalBranch(wt.branch) : '');
  const state = wt.branch ? resolveBranchPrState(wt.branch) : undefined;
  const resolution = wt.branch ? branchPrResolution.get(wt.branch) : undefined;
  if (state === 'OPEN') continue; // PR aperta → lavoro vivo
  const activity = adminDir ? lastActivityMs(wt.path, adminDir) : 0;
  const idle = isIdleSince(activity);

  // Prove di contenuto: tentate solo dove lo sweep altrimenti lascerebbe il
  // worktree in report, e solo con le guardie soddisfatte (il calcolo costa).
  const proofOrReport = (reason, { dirtyNow = dirty, prExists = Boolean(state) } = {}) => {
    let proof = {};
    if (!statusError && idle && busySnapshot.known && ghOk) {
      let indexMs = 0;
      try { indexMs = statSync(join(adminDir, 'index')).mtimeMs; } catch { /* senza index */ }
      proof = contentProof({
        head, branch: wt.branch, wtPath: wt.path, dirty: dirtyNow, prExists, activityMs: activity, indexMs,
      });
    }
    if (canRemoveWithProof({ proven: Boolean(proof.remove), idle, busy: false, busyKnown: busySnapshot.known, ghOk })) {
      removeWt.push({
        ...wt,
        snapshot: wt.branch ? needsProofSnapshot({ hasSnapshot: hasSnapshotTag(wt.branch) }) : false,
        snapshotDetached: wt.branch ? false : needsProofSnapshot({ hasSnapshot: hasSnapshotAt(head) }),
        reason: proof.remove,
      });
      return;
    }
    reportWt.push(attachNotes({ ...wt, reason, resolution }, proof.notes, { dirty: dirtyNow, activityMs: activity, state }));
  };

  const mergedAtHead = wt.branch && mergedPrAtHead(wt.branch, head);
  const mergedByCommit = resolution?.source === 'commit' && resolution.state === 'MERGED';
  if (state === 'MERGED' && wt.branch && !mergedAtHead && !mergedByCommit) {
    proofOrReport(`PR MERGED ma base/SHA non coincidono con main/HEAD (${head || 'unknown'}) — REPORT-ONLY`);
    continue;
  }
  if (state === 'MERGED') {
    if (dirty) {
      proofOrReport(`PR ${state} ma worktree ${dirtyNote} — ispeziona a mano: ${significant.slice(0, 5).join(', ')}`);
      continue;
    }
    if (ignored.length) console.log(`ℹ️  ${wt.path}: ${ignored.length} file sporchi ignorati (output di cron / body della PR), PR ${state}.`);
    const ahead = wt.branch ? aheadOfMain(wt.branch) : null;
    removeWt.push({
      ...wt,
      snapshot: wt.branch ? snapshotNeeded(wt.branch, state, ahead) : false,
        reason: mergedByCommit
        ? `PR #${resolution.pr?.number ?? '?'} MERGED: commit ${resolution.sha?.slice(0, 12)} antenato dell'HEAD PR ${resolution.pr?.head?.sha?.slice(0, 12) ?? resolution.pr?.headRefOid?.slice(0, 12) ?? '?'} (behind=0)`
        : 'PR MERGED con HEAD esatto su main',
    });
  } else if (state === 'CLOSED') {
    const ahead = wt.branch ? aheadOfMain(wt.branch) : null;
    if (!dirty && canDeleteClosedCandidate({ ahead })) {
      removeWt.push({ ...wt, reason: 'PR CLOSED ma 0-ahead: nessun commit locale unico' });
    } else {
      proofOrReport(`PR CLOSED ma non mergiata, ahead=${ahead ?? 'unknown'}${dirty ? `, ${dirtyNote}` : ''} — REPORT-ONLY`);
    }
  } else if (wt.detached) {
    if (!dirty && isAncestorOfMain(head)) {
      removeWt.push({ ...wt, reason: 'detached, HEAD già su main' });
      continue;
    }
    // Worktree di risoluzione (`resolve-pr-N`, merge di main in una PR): il
    // commit non è su main per lo squash, ma è dentro l'HEAD di una PR MERGED.
    // Stessa prova dei branch: PR associata al commit + antenato del suo HEAD.
    const associated = !dirty ? associatedPrForCommit(head) : undefined;
    if (associated?.state === 'MERGED' && commitIsAncestorOfPrHead(head, associated)) {
      removeWt.push({
        ...wt,
        snapshotDetached: needsSnapshot({ prState: 'MERGED', ahead: aheadOfMain(head), hasSnapshot: hasSnapshotAt(head) }),
        reason: `detached, PR #${associated.number ?? '?'} MERGED: commit ${head.slice(0, 12)} antenato dell'HEAD PR ${(associated.head?.sha || associated.headRefOid || '?').slice(0, 12)}`,
      });
      continue;
    }
    proofOrReport(`detached HEAD ${head || 'unknown'}, non verificabile come già su main${dirty ? `, ${dirtyNote}` : ''} — REPORT-ONLY`, { prExists: true });
  } else {
    // Worktree senza PR. Con commit propri resta report-only salvo una prova
    // di contenuto: può essere lavoro pre-PR. Con 0 commit propri e niente
    // sporco non c'è niente da perdere; lo si tiene solo finché potrebbe essere
    // un agente appena partito (EnterWorktree / fast-worktree.sh e nessun
    // commit ancora): oltre IDLE_WORKTREE_MS di inattività, e senza processi
    // dentro, si rimuove. Senza PR il body non tracciato è il testo della PR che
    // l'agente stava per aprire: lavoro, non rumore.
    // Una PR con lo stesso HEAD (trovata dallo SHA) esiste anche se il nome no.
    const prByOid = head ? prByHeadOid.get(head) || [] : [];
    const noPr = ignored.length && !aborted && !prByOid.length ? classifyDirty(wt.path, { prExists: false }) : null;
    const dirtyNoPr = noPr ? noPr.error || noPr.significant.length > 0 : dirty;
    const ignoredNoPr = noPr ? noPr.ignored : ignored;
    const ahead = wt.branch ? aheadOfMain(wt.branch) : 0;
    // Un nome di branch che non si sa citare non è stato interrogato su GitHub:
    // per lui "nessuna PR" non è una risposta.
    const prStateKnown = ghOk && SAFE_BRANCH_RE.test(wt.branch || '');
    if (canRemoveIdleOnMain({
      dirty: dirtyNoPr, ahead, idle, busy: false, busyKnown: busySnapshot.known, ghOk: prStateKnown,
    })) {
      const days = Math.floor((Date.now() - activity) / 86400000);
      removeWt.push({
        ...wt,
        reason: `nessuna PR, 0-ahead${aborted ? ' (checkout mai completato)' : ''}, fermo da ${days} giorni: tutto già su main`,
      });
      continue;
    }
    const gone = wt.branch && upstreamGone(wt.branch) ? ' upstream-GONE (remoto cancellato — probabile merged/closed altrove, es. worktree Codex)' : '';
    const noise = ignoredNoPr.length ? ` (+${ignoredNoPr.length} sporchi ignorati: cron/body PR)` : '';
    const why = ahead === 0 && !dirtyNoPr
      ? ` — attività ${idle ? 'vecchia' : 'recente'} (< ${IDLE_WORKTREE_MS / 3600000} h = agente forse attivo)${busySnapshot.known ? '' : ', lsof non disponibile'}${ghOk ? '' : ', gh non disponibile'}`
      : ' — agent forse attivo';
    const reason = `clean=${!dirtyNoPr}${statusError ? ' (stato git illeggibile)' : ''}${noise} ahead=${ahead ?? 'unknown'} no-PR${gone}${why}, REPORT-ONLY`;
    if (prStateKnown) proofOrReport(reason, { dirtyNow: dirtyNoPr, prExists: prByOid.length > 0 });
    else reportWt.push(attachNotes({ ...wt, reason }, {}, { dirty: dirtyNoPr, activityMs: activity }));
  }
}

// --- 1b. DIRECTORY ORFANE sotto le cartelle dei worktree ----------------------
// `git worktree list` non le vede: metadati già potati, directory rimasta. La
// radice è quella del checkout PRINCIPALE (primo record del porcelain), non la
// cwd: lanciato da hooks-main via bin/site-hook, `--show-toplevel` darebbe il
// worktree degli hook.
const mainWorktreeRoot = worktrees[0]?.path || repoRoot;

// Il workspace: la cartella che contiene i checkout (sito, corpus, ...) e
// `bin/site-hook`. I worktree nascono anche nelle sue `.wt/`, `.worktrees/` e
// `.claude/worktrees/`, che ospitano worktree di PIÙ repo: lì una directory è
// orfana solo se nessun repo del workspace la registra, e la prova C1 può
// usare i ref di ciascun repo (un residuo del sito in `.wt/` della root si
// prova con i ref del sito, anche se lo sweep gira nel corpus).
// FRONTALIERE_WORKSPACE serve ai test; WORKSPACE no di proposito: nei test
// erediterebbe il workspace vero.
function detectWorkspaceRoot() {
  for (const candidate of [process.env.FRONTALIERE_WORKSPACE, resolve(canonicalPath(mainWorktreeRoot), '..')]) {
    if (candidate && existsSync(join(candidate, 'bin', 'site-hook'))) return canonicalPath(candidate);
  }
  return null;
}
const WORKSPACE_ROOT = detectWorkspaceRoot();
const ORPHAN_FOLDERS = ['.claude/worktrees', '.worktrees', '.wt'];

// Repo del workspace: la root (se è un repo) e ogni cartella figlia con una
// directory `.git` (i clone, non i worktree). Il repo corrente c'è sempre.
function workspaceRepos() {
  const roots = new Set([canonicalPath(mainWorktreeRoot)]);
  if (WORKSPACE_ROOT) {
    if (existsSync(join(WORKSPACE_ROOT, '.git'))) roots.add(WORKSPACE_ROOT);
    let entries = [];
    try { entries = readdirSync(WORKSPACE_ROOT, { withFileTypes: true }); } catch { /* illeggibile */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(WORKSPACE_ROOT, entry.name);
      try { if (lstatSync(join(dir, '.git')).isDirectory()) roots.add(canonicalPath(dir)); } catch { /* non è un clone */ }
    }
  }
  return [...roots];
}

// Unione dei worktree registrati in tutti i repo del workspace. Se un repo non
// risponde, le directory della root non si toccano (registrazione sconosciuta).
const registered = new Set(worktrees.map((w) => canonicalPath(w.path)));
let registrationKnown = true;
const repoContexts = []; // { root, prover } per le prove C1, il repo corrente per primo
for (const repo of workspaceRepos()) {
  const isCurrent = repo === canonicalPath(mainWorktreeRoot);
  const porcelain = isCurrent ? wtPorcelain : gitOut(['-C', repo, 'worktree', 'list', '--porcelain'], { allowFail: true });
  if (!porcelain) { registrationKnown = false; continue; }
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) registered.add(canonicalPath(line.slice('worktree '.length)));
  }
  const ref = isCurrent
    ? mainRef
    : gitOut(['-C', repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true }) || 'origin/main';
  const context = { root: repo, prover: isCurrent ? prover : makeContentProver({ git: makeGitRunner(repo), mainRef: ref }) };
  if (isCurrent) repoContexts.unshift(context);
  else repoContexts.push(context);
}
const orphanRemove = []; // {path, files}
const orphanReport = []; // {path, reason}

function scanOrphan(dir) {
  // Si ferma al primo file che non è rumore: quel file basta per non toccare.
  const files = [];
  let newest = 0;
  let work = null;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { work = work || relative(dir, current) || '.'; return; }
    try { newest = Math.max(newest, lstatSync(current).mtimeMs); } catch { /* sparito */ }
    for (const entry of entries) {
      if (work) return;
      const full = join(current, entry.name);
      const rel = relative(dir, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (isOrphanResidueFile(rel)) {
        files.push(rel);
        try { newest = Math.max(newest, lstatSync(full).mtimeMs); } catch { /* sparito */ }
      } else {
        work = rel;
      }
    }
  };
  walk(dir);
  return { files, newest, work };
}

// C1: una directory orfana con file veri si rimuove solo se OGNI file è
// rumore, ignorato da .gitignore, o identico al blob dello stesso path in main
// (l'albero attuale o un commit first-parent nella finestra intorno all'ultima
// scrittura). Il blob deve essere raggiungibile da main a quel path: che
// esista nell'object DB non basta, gli irraggiungibili spariscono col gc.
const ORPHAN_MAX_FILES = 60000;

function fullOrphanScan(dir) {
  const files = [];
  let newest = 0;
  let newestFile = 0;
  let unreadable = null;
  let tooMany = false;
  const walk = (current) => {
    if (unreadable || tooMany) return;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { unreadable = relative(dir, current) || '.'; return; }
    try { newest = Math.max(newest, lstatSync(current).mtimeMs); } catch { /* sparito */ }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.cache') walk(full);
        continue;
      }
      let st;
      try { st = lstatSync(full); } catch { continue; }
      newest = Math.max(newest, st.mtimeMs);
      newestFile = Math.max(newestFile, st.mtimeMs);
      if (files.length >= ORPHAN_MAX_FILES) { tooMany = true; return; }
      files.push({ rel: relative(dir, full), full });
    }
  };
  walk(dir);
  return { files, newest, newestFile, unreadable, tooMany };
}

// `contexts`: i repo i cui ref possono provare la directory. Tutti i file
// devono combaciare nello STESSO repo (un residuo appartiene a un repo solo).
function provenOrphan(dir, contexts) {
  if (!busySnapshot.known || !ghOk || !contexts.length) return null;
  return timed(() => {
    const scan = fullOrphanScan(dir);
    if (scan.unreadable || scan.tooMany || !isIdleSince(scan.newest)) return null;
    const base = scan.files.map((f) => ({
      ...f,
      skippable: isOrphanSkippablePath(f.rel) || isOrphanResidueFile(f.rel)
        || (f.rel === '.git' && isDanglingGitPointer(f.full)),
    }));
    for (const f of base) {
      if (f.skippable) continue;
      f.blob = workingBlob(f.full);
      if (typeof f.blob !== 'string' || f.blob === 'deleted') return null;
    }
    const window = orphanWindow(scan.newestFile || scan.newest) || { sinceMs: 0, untilMs: 0 };
    let firstMiss;
    for (const { root, prover: repoProver } of contexts) {
      const files = base.map((f) => ({ ...f }));
      const toCheck = files.filter((f) => !f.skippable);
      const ignored = repoProver.ignoredPaths(root, toCheck.map((f) => f.rel));
      const verify = toCheck.filter((f) => { f.ignored = ignored.has(f.rel); return !f.ignored; });
      const matched = verify.length ? repoProver.orphanFilesMatch(verify, window) : new Map();
      if (!matched) continue;
      for (const f of verify) f.matched = matched.has(f.rel);
      if (isProvenOrphan({ files, idle: isIdleSince(scan.newest) })) {
        return { proven: true, files: files.length, verified: verify.length, newest: scan.newest, repo: basename(root) };
      }
      firstMiss = firstMiss || verify.find((f) => !f.matched)?.rel;
    }
    return { proven: false, miss: firstMiss };
  });
}

function sweepOrphans(dir, contexts) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    const canonical = canonicalPath(full);
    if (registered.has(canonical)) continue;
    // Cartella di raggruppamento (`fix/`, `codex/`) con worktree registrati
    // dentro: si scende a guardare i fratelli, mai si cancella in blocco.
    const prefix = `${canonical}/`;
    if ([...registered].some((p) => p.startsWith(prefix))) {
      sweepOrphans(full, contexts);
      continue;
    }
    if (isBusy(full)) {
      orphanReport.push({ path: full, reason: 'in uso: un processo ha la cwd dentro — KEEP' });
      continue;
    }
    if (!selected(full)) continue;
    const { files, newest, work } = scanOrphan(full);
    if (!work && isRemovableOrphanDir({ files, idle: isIdleSince(newest) })) {
      orphanRemove.push({ path: full, files: files.length });
      continue;
    }
    const proof = work ? provenOrphan(full, contexts) : null;
    if (proof?.proven) {
      orphanRemove.push({ path: full, files: proof.files, proven: proof });
    } else {
      orphanReport.push({
        path: full,
        reason: work
          ? `nessun worktree git registrato ma contiene file (es. ${proof?.miss || work}${proof?.miss ? ', diverso da main' : ''}) — senza metadati git non si può dire se è lavoro, verifica a mano`
          : `solo residui (${files.length} file), modificata da meno di ${IDLE_WORKTREE_MS / 3600000} h`,
      });
    }
  }
}
for (const folder of ORPHAN_FOLDERS) {
  const dir = join(mainWorktreeRoot, folder);
  if (existsSync(dir)) sweepOrphans(dir, repoContexts.slice(0, 1));
}
// Le cartelle della root: solo se ogni repo ha risposto, e con i ref di tutti.
if (WORKSPACE_ROOT && WORKSPACE_ROOT !== canonicalPath(mainWorktreeRoot) && registrationKnown) {
  for (const folder of ORPHAN_FOLDERS) {
    const dir = join(WORKSPACE_ROOT, folder);
    if (existsSync(dir)) sweepOrphans(dir, repoContexts);
  }
}

// --- 2. BRANCH LOCALI senza worktree ----------------------------------------
const wtBranches = new Set(worktrees.map((w) => w.branch).filter(Boolean));
const allLocal = sh("git for-each-ref --format='%(refname:short)' refs/heads")
  .split('\n').filter(Boolean);

const delBranch = []; // name
const reportBranch = []; // {name, reason}
// Branch senza worktree: le stesse prove sui commit (lo sporco non c'è), con
// l'inattività letta dal reflog del branch.
function branchProofOrReport(b, head, state, reason) {
  const activityMs = branchActivityMs(b);
  const idle = isIdleSince(activityMs);
  const proof = idle && proofGuardsOk() ? contentProof({ head, branch: b, activityMs }) : {};
  if (canRemoveWithProof({ proven: Boolean(proof.remove), idle, busy: false, busyKnown: busySnapshot.known, ghOk })) {
    delBranch.push({ name: b, snapshot: needsProofSnapshot({ hasSnapshot: hasSnapshotTag(b) }), reason: proof.remove });
    return;
  }
  reportBranch.push(attachNotes({ name: b, reason }, proof.notes, { state }));
}

for (const b of allLocal) {
  if (b === mainBranch) continue;
  if (wtBranches.has(b)) continue; // gestito sopra come worktree
  if (!selected(b)) continue;
  const state = resolveBranchPrState(b);
  if (state === 'OPEN') continue;
  if (/^worktree-agent-/.test(b) && aheadOfMain(b) === 0) {
    delBranch.push({ name: b, snapshot: false, reason: 'orfano worktree-agent-* 0-ahead' });
    continue;
  }
  if (!ghOk) {
    reportBranch.push({ name: b, reason: 'stato PR non verificabile: gh indisponibile — REPORT-ONLY' });
    continue;
  }
  const head = headOfLocalBranch(b);
  if (state === 'MERGED') {
    const resolution = branchPrResolution.get(b);
    const mergedAtHead = mergedPrAtHead(b, head);
    const mergedByCommit = resolution?.source === 'commit' && resolution.state === 'MERGED';
    if (mergedAtHead || mergedByCommit) {
      delBranch.push({
        name: b,
        snapshot: snapshotNeeded(b, state, aheadOfMain(b)),
        reason: mergedByCommit
          ? `PR #${resolution.pr?.number ?? '?'} MERGED: commit ${resolution.sha?.slice(0, 12)} antenato dell'HEAD PR ${resolution.pr?.head?.sha?.slice(0, 12) ?? resolution.pr?.headRefOid?.slice(0, 12) ?? '?'} (behind=0)`
          : 'PR MERGED con HEAD esatto su main',
      });
    } else branchProofOrReport(b, head, state, `PR MERGED ma base/SHA non coincidono con main/HEAD (${head || 'unknown'}) — REPORT-ONLY`);
    continue;
  }
  if (state === 'CLOSED') {
    const ahead = aheadOfMain(b);
    if (canDeleteClosedCandidate({ ahead })) {
      delBranch.push({ name: b, snapshot: false, reason: 'PR CLOSED ma 0-ahead: nessun commit locale unico' });
    } else {
      branchProofOrReport(b, head, state, `PR CLOSED ma non mergiata, ahead=${ahead ?? 'unknown'} — REPORT-ONLY`);
    }
    continue;
  }
  const ahead = aheadOfMain(b);
  if (ahead === 0) delBranch.push({ name: b, snapshot: false, reason: '0-ahead su main, nessun commit locale unico' });
  else if (!SAFE_BRANCH_RE.test(b)) reportBranch.push({ name: b, reason: `ahead=${ahead ?? 'unknown'} no-PR, nome non interrogabile — REPORT-ONLY` });
  else branchProofOrReport(b, head, state, `ahead=${ahead ?? 'unknown'} no-PR${upstreamGone(b) ? ' upstream-GONE' : ''} — possibile lavoro non in PR, REPORT-ONLY`);
}

resolveIssueNotes();
saveProofCache();
const costLine = () => `ℹ️  costo: ${((Date.now() - STARTED_AT) / 1000).toFixed(1)} s, di cui prove ${(proofMs / 1000).toFixed(1)} s; ${ghCalls} chiamate gh; ${prFetches} fetch di refs/pull.`;

// --- OUTPUT + APPLY ---------------------------------------------------------
console.log(`base = origin/${mainBranch} | gh=${ghOk ? 'ok' : 'UNAVAILABLE (solo worktree-agent-*+0-ahead)'} | mode=${APPLY ? 'APPLY' : 'dry-run'}`);
console.log('');

console.log(`worktree da rimuovere (${removeWt.length}):`);
removeWt.forEach((w) => console.log(
  `  - ${w.path}${w.branch ? ` [${w.branch}]` : ' (detached)'}${w.reason ? ` — ${w.reason}` : ''}${w.snapshot || w.snapshotDetached ? ' — crea snapshot prima della rimozione' : ''}`,
));
console.log(`directory orfane da rimuovere (${orphanRemove.length}):`);
orphanRemove.forEach((o) => console.log(o.proven
  ? `  - ${o.path} — nessun worktree registrato in nessun repo, ${o.proven.verified} file identici a main di ${o.proven.repo} allo stesso path (${o.files} in tutto, il resto rumore o ignorato)`
  : `  - ${o.path} — nessun worktree registrato, solo residui (${o.files} file: .DS_Store / node_modules / body PR)`));
console.log(`branch locali da cancellare (${delBranch.length}):`);
delBranch.forEach((b) => console.log(
  `  - ${b.name}${b.reason ? ` — ${b.reason}` : ''}${b.snapshot ? ' — crea snapshot prima della rimozione' : ''}`,
));

if (reportWt.length || reportBranch.length || orphanReport.length) {
  console.log('');
  console.log('⚠️  REPORT-ONLY (non toccati — decidi a mano):');
  reportWt.forEach((w) => console.log(`  • worktree ${w.path}${w.branch ? ` [${w.branch}]` : ''} → ${w.reason}`));
  reportBranch.forEach((b) => console.log(`  • branch ${b.name} → ${b.reason}`));
  orphanReport.forEach((o) => console.log(`  • directory ${o.path} → ${o.reason}`));
}

if (!APPLY) {
  console.log('');
  console.log('dry-run: niente rimosso. Ri-esegui con --apply per applicare.');
  console.log(costLine());
  process.exit(0);
}

let done = 0;
let failed = 0;
for (const w of removeWt) {
  if (w.branch && !snapshotBeforeDelete(w.branch, w.snapshot)) {
    failed++;
    console.log(`⚠️  FALLITO snapshot ${w.branch} — worktree lasciato intatto`);
    continue;
  }
  if (!w.branch && !snapshotDetachedBeforeRemove(w.head, w.snapshotDetached)) {
    failed++;
    console.log(`⚠️  FALLITO snapshot ${w.head} — worktree lasciato intatto`);
    continue;
  }
  // Il symlink `node_modules` non tracciato si toglie prima, senza seguirlo:
  // `git worktree remove` non deve mai attraversarlo.
  for (const link of nodeModulesLinks(w.path, classifyDirty(w.path).ignored)) {
    try { if (lstatSync(join(w.path, link)).isSymbolicLink()) unlinkSync(join(w.path, link)); } catch { /* già via */ }
  }
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
  if (!snapshotBeforeDelete(b.name, b.snapshot)) {
    failed++;
    console.log(`⚠️  FALLITO snapshot ${b.name} — branch lasciato intatto`);
    continue;
  }
  if (shOk(`git branch -D "${b.name}"`)) {
    done++;
    console.log(`deleted branch ${b.name}`);
  } else {
    failed++;
    console.log(`⚠️  FALLITO branch -D ${b.name} (in checkout? non-merged senza -D?) — saltato`);
  }
}
for (const o of orphanRemove) {
  // Ricontrollo subito prima: nel frattempo qualcuno può averci scritto.
  const again = o.proven ? null : scanOrphan(o.path);
  const recheck = o.proven ? fullOrphanScan(o.path) : null;
  const changed = o.proven
    ? recheck.files.length !== o.files || recheck.newest !== o.proven.newest || isBusy(o.path)
    : again.work || !isRemovableOrphanDir({ files: again.files, idle: isIdleSince(again.newest) });
  if (changed) {
    failed++;
    console.log(`⚠️  SALTATA directory ${o.path}: è cambiata durante lo sweep`);
    continue;
  }
  // Mai `rm -rf`: un symlink (node_modules verso il checkout principale) si
  // toglie senza seguirlo.
  if (removeTreeNoFollow(o.path)) {
    done++;
    console.log(`removed directory ${o.path}`);
  } else {
    failed++;
    console.log(`⚠️  FALLITA rimozione directory ${o.path} — saltata`);
  }
}
sh('git worktree prune', { allowFail: true });
console.log('');
console.log(`✓ applicate ${done} rimozioni${failed ? `, ${failed} FALLITE (vedi sopra)` : ''}. ${reportWt.length + reportBranch.length + orphanReport.length} voci report-only lasciate intatte.`);
console.log(costLine());
