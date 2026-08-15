/**
 * pr-autorebase.mjs — rebase reale delle PR a un passo dal merge (zero-Claude).
 *
 * stale-pr-rescuer.yml oggi LABELLA + commenta "fai git merge origin/main", ma
 * nessuno lo esegue → le PR restano ferme. Qui lo automatizziamo, ma con
 * FRUGALITÀ (zero Claude): dopo il rebase NON ri-eseguiamo la review — ri-
 * eseguiamo SOLO vitest (dispatch di tests.yml) e lasciamo che auto-merge-eval
 * porti avanti l'`## LGTM` esistente (il contributo proprio della PR è invariato
 * su un rebase di solo main-merge). Tocchiamo solo le PR "near-merge".
 *
 * NB sul trigger: il push del rebase si autentica via App/PAT (x-access-token) e
 * RI-TRIGGERA i workflow `pull_request` — incluso `pr-review-loop`, che con
 * `cancel-in-progress` cancella la review in corso. Per NON bruciare quota Claude
 * né innescare un livelock, (a) dispatchiamo comunque tests.yml esplicitamente
 * (più affidabile di affidarsi al push per il solo vitest) e (b) **defer del
 * rebase finché una review è in volo** (vedi reviewInProgress): rebasare mentre la
 * review gira la cancella, e con main caldo non concluderebbe mai (la PR
 * collision-risk va behind a ogni tick) → niente `## LGTM`, niente merge.
 * (Storico: il claim "push PAT non ri-triggera pull_request" su #1587/#1526 era
 * uno zero-check-run da rebase pre-#1597 che non dispatchava, non l'assenza di
 * trigger; il push autenticato App/PAT ri-triggera, osservato su #3038.)
 *
 * Per ogni PR OPEN non-draft:
 *   GATE (frugalità): procedi solo se "near-merge" =
 *     - ha una review claude-bot con `## LGTM` su un qualche commit, OPPURE
 *     - porta label `collision-risk` o `stale-review`.
 *     Altrimenti skip.
 *   - behind = commit di origin/main non nella head. behind==0 (già allineata):
 *     di norma skip, MA si HEAL-dispatcha tests.yml (no rebase) in due casi così
 *     auto-merge-eval può gattare+mergiare, senza i quali la PR near-merge resta
 *     stuck per sempre: (a) head "orfana" (0 check-run `vitest`, lasciata da un
 *     push PAT che non ri-triggera `pull_request` o da un rebase pre-#1597 che
 *     non dispatchava) — #1595/#1526; (b) verdetto vitest rosso da CANCELLAZIONE
 *     da concurrency (transient, non test rotti) e senza run fresco pendente:
 *     `cancelled` sul check stesso con il job singolo di oggi, oppure `failure`
 *     collassato dagli shard nella vecchia matrice — #2438 (vedi
 *     vitestVerdictIsTransientCancellation). Un `failure` REALE → skip
 *     (niente re-run gratis: AGENTS #5 + frugalità CI).
 *   - mergeable (gh pr view --json mergeable; UNKNOWN → poll una volta dopo una
 *     breve attesa; se ancora UNKNOWN → skip questo run).
 *   - MERGEABLE → fetch + checkout branch + `git merge origin/main` (identity
 *     canonica). Clean → push via PAT + dispatch tests.yml sul branch (vitest
 *     sull'head; LGTM portato avanti da auto-merge-eval). Log.
 *   - CONFLITTO (CONFLICTING o merge nonzero) → `git merge --abort`; assicura
 *     label `stale-review` (così rescuer/recycle gestiscono); commenta UNA volta
 *     (dedup via marker `<!-- AUTOREBASE_CONFLICT -->`). Niente loop.
 *   Cap: ~10 PR/run; logga le skippate per cap (AGENTS.md no-silent-cap).
 *
 * Uso:  node scripts/ci/pr-autorebase.mjs [--dry-run]
 * Env:  GH_TOKEN (PAT, per push + dispatch tests.yml; serve scope actions:write),
 *       GITHUB_REPOSITORY. Richiede `gh` + `git` in un checkout full-history.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { VITEST_CHECK_NAME } from './lib/constants.mjs';
import {
  latestCompletedVitestConclusion,
  vitestVerdictIsTransientCancellation,
  vitestFailureIsNotAttributableToPr,
} from './lib/vitestCheck.mjs';
import { hasCommentMarker as hasCommentMarkerShared, upsertStickyComment } from './lib/prComments.mjs';
import { runBudgetFromEnv, rotateForFairness } from './lib/run-budget.mjs';
import {
  REOPEN_BUDGET_MARKER,
  BREAKER_LABEL,
  DEFAULT_MAX_REOPENS,
  reopenFingerprint,
  parseReopenBudget,
  decideReopen,
  decideNeedsHumanPass,
  renderReopenBudget,
} from './lib/reopen-breaker.mjs';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GH_TOKEN || '';
const MAX_PER_RUN = 10;
// Costo tipico di una PR nel loop, misurato sui run reali (fase di lavoro
// 19-114s per 1-10 PR): ~30s copre il caso normale con margine. È una STIMA per
// decidere se COMINCIARE, non un timer: nessuna PR viene interrotta a metà.
const PR_COST_MS = Number(process.env.AUTOREBASE_PR_COST_MS || 30_000);
// Sezione critica NON atomica: `gh pr close` + `gh pr reopen`. Se il job muore
// fra le due la PR resta CHIUSA e nessuno la riapre (vedi reopenToRetrigger).
// Non si entra senza il tempo di uscirne — con margine largo rispetto a due
// chiamate API che nel caso peggiore ritentano.
/** Tentativi di reopen e pausa fra uno e l'altro — vedi reopenToRetrigger. */
const REOPEN_ATTEMPTS = Number(process.env.AUTOREBASE_REOPEN_ATTEMPTS || 4);
const REOPEN_RETRY_SLEEP_S = Number(process.env.AUTOREBASE_REOPEN_RETRY_SLEEP_S || 5);
/**
 * DERIVATO dai due sopra, non scritto a mano: il guard vale solo se il tempo
 * riservato copre davvero il peggior caso della sezione critica. Con un numero
 * fisso, alzare i tentativi o la pausa lo renderebbe silenziosamente
 * insufficiente — e un budget che sottostima è esattamente il modo in cui il
 * job muore fra `close` e `reopen` lasciando la PR chiusa.
 * close + N chiamate reopen (≈3s l'una, generoso su un'API degradata) + le pause.
 */
const REOPEN_COST_MS = Number(process.env.AUTOREBASE_REOPEN_COST_MS
  || 3_000 + REOPEN_ATTEMPTS * 3_000 + (REOPEN_ATTEMPTS - 1) * REOPEN_RETRY_SLEEP_S * 1_000);
/**
 * Etichetta che dice al worktree-branch-janitor di NON cancellare l'head ref di
 * questa PR. Si applica solo quando la coppia close+reopen si è rotta a metà:
 * la chiusura si recupera a mano, la perdita del branch no.
 */
const REOPEN_FAILED_LABEL = 'autorebase-reopen-failed';
/** Tetto di riaperture sullo STESSO stato — vedi lib/reopen-breaker.mjs. */
const MAX_REOPENS = Number(process.env.AUTOREBASE_MAX_REOPENS || DEFAULT_MAX_REOPENS);

const budget = runBudgetFromEnv();
const CONFLICT_MARKER = '<!-- AUTOREBASE_CONFLICT -->';
// One-shot per PR: `vitestFailureIsNotAttributableToPr` è pura e ri-risponderebbe
// `true` a ogni tick finché l'head resta rosso. Il marker rende il rescue
// irripetibile: una PR ri-testata contro main verde che torna ROSSA è rotta per
// conto suo e non va ri-rebasata all'infinito (frugalità CI + niente rebase-thrash,
// la stessa classe di livelock di #2415). Da lì la prendono recycle-stale-prs /
// un umano.
const STUCK_RED_MARKER = '<!-- AUTOREBASE_STUCK_RED_RESCUE -->';
// Backstop `stale` di vitestFailureIsNotAttributableToPr: un vitest rosso più
// vecchio di N ore va ri-verificato una volta anche senza prova di main-rosso
// (copre i fallimenti INFRA, es. #5019: `RPC failed; curl 56` + runner shutdown
// durante il checkout, zero test eseguiti, con main verde in quel momento).
const STUCK_RED_STALE_H = Number(process.env.AUTOREBASE_STUCK_RED_STALE_H || 24);
// Activity-guard: don't rebase-push a branch whose head was pushed in the last
// N minutes — a contributor/agent is likely mid-flight (still pushing fixes on
// top of an LGTM'd PR). Rebasing then races their push: ours lands first, their
// non-fast-forward push is rejected, and they must fetch+reset+cherry-pick to
// recover (observed on #1616 this session). The rebase isn't urgent — main is
// always seconds-fresh — so deferring one tick (~30m) is free. 0 disables.
const ACTIVITY_GUARD_MIN = Number(process.env.AUTOREBASE_ACTIVITY_GUARD_MIN || 6);

function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return json ? JSON.parse(out) : out;
  } catch (e) {
    if (allowFail) return json ? null : '';
    throw e;
  }
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authedUrl() {
  // Push via PAT così review + vitest ri-partono (anti-ricorsione GITHUB_TOKEN).
  return `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
}

// Push del branch forzando l'identità del TOKEN (App → `<app>[bot]`, fallback PAT
// → valerielinc-ops). `actions/checkout` (persist-credentials:true) persiste
// `http.https://github.com/.extraheader = AUTHORIZATION: basic <GITHUB_TOKEN>`,
// header che viaggia su OGNI push verso github.com e SOVRASCRIVE lo
// `x-access-token:<App/PAT>` embeddato in authedUrl() → il push si autentica come
// `github-actions[bot]`, e GitHub mette ogni workflow PR risultante in
// `action_required` (approvazione manuale, anti-ricorsione) — che non si
// auto-sblocca mai e si accumula. Azzerare l'extraheader per il SOLO push (`-c
// http.https://github.com/.extraheader=`) neutralizza l'override: vince il token
// in URL → i check ri-partono da soli, niente più approvazioni manuali. Se il
// TOKEN è invalido il push FALLISCE in modo visibile (niente fallback silenzioso
// a github-actions[bot]).
function pushBranch(branch) {
  return git(
    ['-c', 'http.https://github.com/.extraheader=', 'push', authedUrl(), `${branch}:${branch}`],
    { allowFail: true },
  );
}

/** Una review claude-bot con `## LGTM` (su qualunque commit)? */
function hasLgtmReview(num) {
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews`, '--paginate'], { allowFail: true });
  if (!Array.isArray(reviews)) return false;
  return reviews.some(
    (r) => r.user && r.user.type === 'Bot' && /^claude/i.test(r.user.login || '') &&
      (r.body || '').includes('## LGTM')
  );
}

/** Esiste ALMENO una review claude-bot (LGTM o 🔴, qualunque esito)? Serve a
 * distinguere la classe-A "review mai postata" (workflow-validation drift 401:
 * run review fallita, body vuoto) da "review postata con 🔴" (gestita dal
 * redflag-fixer, NON va ri-triggerata qui). */
function hasAnyClaudeReview(num) {
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews`, '--paginate'], { allowFail: true });
  if (!Array.isArray(reviews)) return true; // fail-safe: su errore API assumi review esistente (no reopen)
  return reviews.some(
    (r) => r.user && r.user.type === 'Bot' && /^claude/i.test(r.user.login || '')
  );
}

/** Re-trigger DETERMINISTICO di review+tests per una PR classe-A: il push PAT
 * non ri-triggera `pull_request` in modo affidabile e pr-review-loop non ha
 * workflow_dispatch — ma un close+reopen via PAT emette `reopened`, che
 * triggera SIA pr-review-loop SIA tests.yml. Senza questo, una PR rebasata ma
 * senza review resta senza LGTM fino al recycle 24h (finestra morta ~22h
 * osservata, dead-end #4 della mappa loop 2026-06-12). */
function reopenToRetrigger(num) {
  if (DRY) { console.log(`[dry] close+reopen #${num} (re-trigger review+tests)`); return true; }
  // BUDGET GUARD (#5145/#5144). Questa è la sola sezione NON ATOMICA dello
  // script: fra `close` e `reopen` la PR è CHIUSA. I guard sotto coprono il
  // fallimento dell'API, non il job UCCISO dal `timeout-minutes` — in quel caso
  // il processo sparisce fra le due chiamate e la PR resta chiusa senza che
  // nessuno la riapra (danno reale e duraturo, l'opposto di un run rosso
  // innocuo). Se non c'è il tempo di completare la coppia NON si comincia: la
  // PR resta intatta e il prossimo tick rifà la stessa valutazione.
  if (!budget.canAfford(REOPEN_COST_MS)) {
    console.log(`PR #${num}: budget di run insufficiente per la coppia close+reopen — NON la tocco (una chiusura senza riapertura lascerebbe la PR chiusa). Rimandata al prossimo tick.`);
    budget.defer(`#${num} (close+reopen)`);
    return false;
  }
  // NIENTE allowFail qui: con `json:false` allowFail ritorna '' sia su successo
  // (gh pr close/reopen confermano su stderr, stdout vuoto) sia su fallimento —
  // l'unico segnale affidabile è l'eccezione (🔴 review #1930: i guard ===null
  // non scattavano mai → rischio PR lasciata CHIUSA con falso successo).
  try {
    gh(['pr', 'close', String(num), '--repo', REPO], { json: false });
  } catch (e) {
    console.log(`PR #${num}: close fallito (${String(e).slice(0, 120)}) — skip reopen, PR intatta.`);
    return false;
  }
  // Da qui la PR È CHIUSA: mai uscire senza riaprirla. Retry con pausa, poi
  // ::error forte — invariante "mai lasciare la PR chiusa".
  //
  // La pausa non è cosmetica. Il 2026-08-06, durante un `major_outage` di
  // GitHub Actions, entrambi i tentativi immediati sono falliti sulla stessa
  // API degradata (`Could not open the pull request`) e #5269 è rimasta chiusa.
  // Due chiamate a distanza di millisecondi campionano lo stesso istante di
  // un'API che sta fallendo: distanziarle è ciò che le rende due tentativi.
  for (let attempt = 1; attempt <= REOPEN_ATTEMPTS; attempt++) {
    try {
      gh(['pr', 'reopen', String(num), '--repo', REPO], { json: false });
      return true;
    } catch (e) {
      if (attempt < REOPEN_ATTEMPTS) {
        try { execFileSync('sleep', [String(REOPEN_RETRY_SLEEP_S)]); } catch { /* best effort */ }
        continue;
      }
      // Esauriti i tentativi. L'`::error::` da solo non basta: nel run è
      // visibile a chi lo apre, e nel frattempo `delete-closed-unmerged` del
      // worktree-branch-janitor vede una PR closed-unmerged e CANCELLA il
      // branch — 8 secondi dopo, il 2026-08-06. Da lì il lavoro non è piu'
      // raggiungibile da remoto e la PR non è nemmeno riapribile (GitHub
      // rifiuta il reopen di una PR il cui head ref non esiste piu').
      //
      // La chiusura è recuperabile a mano; la cancellazione del branch no. La
      // label è il segnale che ferma proprio quella: il janitor la legge e
      // risparmia l'head ref. Vedi .github/workflows/worktree-branch-janitor.yml.
      gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', REOPEN_FAILED_LABEL],
        { json: false, allowFail: true });
      console.log(`::error::PR #${num} chiusa ma reopen FALLITO ${REOPEN_ATTEMPTS} volte (${String(e).slice(0, 120)}) — etichettata \`${REOPEN_FAILED_LABEL}\` per salvarne il branch; riaprire a mano.`);
      return false;
    }
  }
  return false;
}

/**
 * Impronta dello stato della PR per il breaker. Vedi il razionale completo in
 * lib/reopen-breaker.mjs: NIENTE head OID e NIENTE conteggio commit, perché
 * questo stesso script pusha un merge commit di main a ogni tick e li
 * cambierebbe SEMPRE, azzerando il contatore a ogni giro.
 */
function reopenStateFingerprint(num, vitestConclusion) {
  const d = gh(['pr', 'view', String(num), '--repo', REPO, '--json',
    'additions,deletions,changedFiles'], { allowFail: true }) || {};
  const reviews = gh(['api', `repos/${REPO}/pulls/${num}/reviews`, '--paginate',
    '--jq', 'length'], { json: false, allowFail: true });
  return reopenFingerprint({
    additions: d.additions,
    deletions: d.deletions,
    changedFiles: d.changedFiles,
    vitestConclusion,
    reviewCount: parseInt((reviews || '0').trim(), 10) || 0,
  });
}

/** Ultimo verdetto vitest sull'head, NORMALIZZATO: una cancellazione da
 * concurrency non è un verdetto sul codice e non deve valere come `failure`
 * per la precondizione (altrimenti bloccherebbe PR sane). */
function normalizedVitestConclusion(head) {
  const out = gh(['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`],
    { json: true, allowFail: true });
  const runs = (out && out.check_runs) || [];
  if (vitestVerdictIsTransientCancellation(runs)) return 'transient';
  return latestCompletedVitestConclusion(runs) || '';
}

/**
 * `reopenToRetrigger` con precondizione + circuit breaker davanti.
 *
 * TUTTE le riaperture passano di qui: chiamare `reopenToRetrigger` direttamente
 * rimetterebbe in piedi il loop misurato su #5896/#5906 (12 e 10 riaperture,
 * 55% di tutta la CI del repo in 8h). Il breaker non è un extra: il close+reopen
 * emette `reopened`, e `tests.yml` ha `on: pull_request` senza `types:` →
 * eredita `[opened, synchronize, reopened]`, quindi OGNI giro sbagliato costa
 * una vitest intera (~18min) su una coda serializzata.
 */
function guardedReopen(num, head) {
  const vitestConclusion = normalizedVitestConclusion(head);
  const fingerprint = reopenStateFingerprint(num, vitestConclusion);
  const body = readReopenBudgetBody(num);
  const prior = parseReopenBudget(body);
  const d = decideReopen({ vitestConclusion, fingerprint, prior, max: MAX_REOPENS });

  if (d.action !== 'reopen') {
    // Segnalazione UNA SOLA: commento STICKY riscritto in place (non un
    // commento nuovo a ogni giro, non una issue nuova a ogni giro). Se il body
    // è già identico non si riscrive nemmeno quello — N tick = 0 notifiche in
    // più. Una segnalazione ripetuta sarebbe lo stesso difetto in altra forma.
    const next = renderReopenBudget({
      count: d.count, max: MAX_REOPENS, fingerprint, action: d.action, reason: d.reason,
    });
    console.log(`PR #${num}: NO reopen (${d.action}) — ${d.reason}`);
    if (!DRY && !labelsOf(num).includes(BREAKER_LABEL)) {
      gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', BREAKER_LABEL],
        { json: false, allowFail: true });
    }
    if (body !== next) {
      upsertStickyComment(gh, REPO, num, REOPEN_BUDGET_MARKER, next, { dry: DRY });
    }
    return false;
  }

  // Il contatore si scrive PRIMA della coppia close+reopen: se il job muore in
  // mezzo il tentativo è comunque contato. Contarlo dopo renderebbe il breaker
  // cieco proprio ai giri che falliscono, cioè quelli che contano di più.
  const next = renderReopenBudget({
    count: d.count, max: MAX_REOPENS, fingerprint, action: d.action, reason: d.reason,
  });
  if (body !== next) {
    upsertStickyComment(gh, REPO, num, REOPEN_BUDGET_MARKER, next, { dry: DRY });
  }
  console.log(`PR #${num}: reopen consentito — ${d.reason}`);
  return reopenToRetrigger(num);
}

/** Body del commento sticky del budget, o '' se non c'è. */
function readReopenBudgetBody(num) {
  const raw = gh(['api', `repos/${REPO}/issues/${num}/comments`, '--paginate',
    '--jq', `[.[] | select(.body // "" | contains("${REOPEN_BUDGET_MARKER}")) | .body] | last // ""`],
  { json: false, allowFail: true });
  return raw || '';
}

/** Label correnti della PR (rilette: il breaker può averle appena cambiate). */
function labelsOf(num) {
  const raw = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'labels',
    '--jq', '[.labels[].name] | join(",")'], { json: false, allowFail: true });
  return (raw || '').trim().split(',').filter(Boolean);
}

/** behind_by: commit di main non nella head. */
function behindMain(head) {
  const out = gh(['api', `repos/${REPO}/compare/main...${head}`, '--jq', '.behind_by // 0'],
    { json: false, allowFail: true });
  return parseInt((out || '0').trim(), 10) || 0;
}

/** Minuti dall'ultimo push sull'head = committer date del commit head. Serve
 * all'activity-guard: un head appena pushato = contributor/agent mid-flight. */
function headPushedMinutesAgo(head) {
  const iso = gh(['api', `repos/${REPO}/commits/${head}`, '--jq', '.commit.committer.date'],
    { json: false, allowFail: true });
  const t = Date.parse((iso || '').trim());
  if (Number.isNaN(t)) return Infinity; // sconosciuto → non bloccare il rebase
  return (Date.now() - t) / 60000;
}

/** Esiste già un check-run `vitest (unit + integration)` sull'head (qualunque
 * stato: queued/in_progress/completed)? Serve a (a) non ri-dispatchare se vitest
 * sta già girando o è concluso, e (b) rilevare gli head "orfani" a 0 check-run
 * lasciati da un push PAT che non ha ri-triggerato `pull_request` o da un
 * autorebase pre-#1597 che pushava senza dispatchare. */
function headHasVitestCheck(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`,
      '--jq', `[.check_runs[] | select(.name == ${JSON.stringify(VITEST_CHECK_NAME)})] | length`],
    { json: false, allowFail: true });
  return (parseInt((out || '0').trim(), 10) || 0) > 0;
}

/** Conclusion del check-run `vitest (unit + integration)` sull'head (''
 * se assente/pending). Diverso da headHasVitestCheck (sola presenza): serve a
 * NON skippare il rebase quando vitest=`failure` — una PR behind+LGTM con vitest
 * rosso NON è mergeable-as-is (auto-merge-eval esige conclusion==success), quindi
 * va rebasata per ereditare eventuali fix lato main invece di restare stuck
 * (autorebase skippa, auto-merge rifiuta → loop). Prende l'ultimo check-run
 * vitest COMPLETATO (per completed_at), non un `[0]` arbitrario, così un
 * workflow_dispatch manuale cancellato sullo stesso SHA non avvelena il verdetto
 * (stessa classe del bug #2394). Vedi lib/vitestCheck.mjs. */
function vitestConclusion(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`],
    { json: true, allowFail: true });
  return latestCompletedVitestConclusion(out && out.check_runs);
}

/** Il verdetto vitest rosso sull'head è una cancellazione transient da
 * concurrency e NON un test rotto? Due topologie: job singolo (post-de-shard
 * #2882) → il check-run stesso è `cancelled`; matrice a shard (#2438) →
 * l'aggregatore collassa cancelled→failure e il helper riapre gli shard. Serve
 * al ramo behind===0: senza, una PR LGTM+behind=0 con un rosso transient restava
 * ferma (heal solo su check ASSENTE). Vedi lib/vitestCheck.mjs. */
function vitestVerdictIsTransient(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`],
    { json: true, allowFail: true });
  return vitestVerdictIsTransientCancellation(out && out.check_runs);
}

/** Ultimi run COMPLETATI di `tests.yml` sul branch main, per stabilire se main è
 * tornato verde DOPO che una PR è stata testata (vedi
 * `vitestFailureIsNotAttributableToPr`). Fetchato UNA volta per run
 * dell'autorebase e memoizzato: è lo stesso identico dato per tutte le PR, e la
 * finestra di 50 run copre abbondantemente sia una giornata di main caldo sia i
 * ~3 giorni della finestra rossa 2026-08-02→04. */
let _mainTestsRuns = null;
function mainTestsRuns() {
  if (_mainTestsRuns) return _mainTestsRuns;
  const out = gh(
    ['api', `repos/${REPO}/actions/workflows/tests.yml/runs?branch=main&status=completed&per_page=50`],
    { json: true, allowFail: true });
  _mainTestsRuns = (out && out.workflow_runs) || [];
  return _mainTestsRuns;
}

/** Il vitest rosso sull'head NON è attribuibile alla PR (main rosso al momento
 * del test e poi tornato verde, oppure rosso stantio da >24h = infra)? Ritorna
 * la `reason` (`'red-main'`/`'stale'`) o '' . Vedi lib/vitestCheck.mjs. */
function stuckRedRescueReason(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`],
    { json: true, allowFail: true });
  const { rescue, reason } = vitestFailureIsNotAttributableToPr({
    checkRuns: (out && out.check_runs) || [],
    mainTestsRuns: mainTestsRuns(),
    staleHours: STUCK_RED_STALE_H,
  });
  return rescue ? reason : '';
}

/** Un commento della PR contiene già `marker`? Dedup condivisa fra il comment di
 * conflitto e il rescue one-shot dello stuck-red. */
function hasCommentMarker(num, marker) {
  return hasCommentMarkerShared(gh, REPO, num, marker);
}

/** C'è una review Claude (`pr-review-loop`, check-run `review`) ANCORA in volo
 * sull'head (status `queued`/`in_progress`)? Il push del rebase si autentica via
 * App/PAT (x-access-token) e quindi RI-TRIGGERA `pull_request` → `pr-review-loop`
 * ha `cancel-in-progress: true` → il nostro push CANCELLA la review in corso e ne
 * avvia un'altra. Con main caldo (commit ogni pochi minuti) e una review da
 * ~8-11min, una PR collision-risk va `behind>0` a metà review, l'autorebase la
 * rebasa, il push cancella la review, che riparte → LIVELOCK: la review non
 * conclude mai, l'`## LGTM` non viene mai postato, niente merge (e quota Claude
 * bruciata a ogni restart). Difesa: se una review è in volo, DEFER il rebase di un
 * tick (come ACTIVITY_GUARD). Il rebase non è urgente (main è sempre fresco); la
 * review conclude, posta il verdetto, e auto-merge-eval porta avanti l'LGTM. */
function reviewInProgress(head) {
  const out = gh(
    ['api', `repos/${REPO}/commits/${head}/check-runs?per_page=100`,
      '--jq', '[.check_runs[] | select(.name == "review" and (.status == "in_progress" or .status == "queued"))] | length'],
    { json: false, allowFail: true });
  return (parseInt((out || '0').trim(), 10) || 0) > 0;
}

/**
 * Decisione rebase per una PR near-merge che è behind>0 (valutata DOPO il check
 * CONFLITTO). Pura → testabile; il razionale del livelock è al call-site.
 * @param {{lgtm: boolean, collisionRisk: boolean, vitestConclusion: string, hasVitestCheck: boolean}} s
 * @returns {'rebase'|'skip'|'heal'}
 *   'rebase' = la PR va rebasata (collision-risk esige 0-behind, OPPURE
 *              vitest=failure va rebasato per ereditare i fix di main, OPPURE
 *              non-LGTM → non near-merge-as-is).
 *   'skip'   = LGTM, non-collision, vitest non-failure, check vitest PRESENTE →
 *              non rebasare (main è non-strict, auto-merge la mergia behind);
 *              rebasare orfanizzerebbe l'head (LIVELOCK).
 *   'heal'   = come 'skip' MA head orfana (nessun check vitest) → dispatch tests
 *              invece di rebasare, così il vitest atterra su head stabile.
 */
export function rebaseActionForLgtmPr({ lgtm, collisionRisk, vitestConclusion, hasVitestCheck }) {
  if (!lgtm || collisionRisk || vitestConclusion === 'failure') return 'rebase';
  return hasVitestCheck ? 'skip' : 'heal';
}

/** Dispatcha tests.yml sul branch → il check-run vitest atterra sull'head e il
 * suo `workflow_run: completed` ri-valuta auto-merge-on-lgtm (LGTM portato avanti
 * da auto-merge-eval). Best-effort: serve PAT con scope actions:write. */
function dispatchTests(num, branch) {
  if (DRY) { console.log(`[dry] dispatch tests.yml --ref ${branch} (#${num})`); return true; }
  const d = gh(['workflow', 'run', 'tests.yml', '--ref', branch], { json: false, allowFail: true });
  if (d === null) {
    console.log(`::warning::PR #${num}: 'gh workflow run tests.yml --ref ${branch}' fallito — vitest potrebbe non ripartire sull'head; verifica scope actions:write del PAT.`);
    return false;
  }
  return true;
}

/** mergeable con un poll su UNKNOWN. */
async function mergeableState(num) {
  let m = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'mergeable',
    '--jq', '.mergeable'], { json: false, allowFail: true });
  m = (m || '').trim();
  if (m === 'UNKNOWN' || m === '') {
    await sleep(4000); // GitHub calcola la mergeability in async
    m = gh(['pr', 'view', String(num), '--repo', REPO, '--json', 'mergeable',
      '--jq', '.mergeable'], { json: false, allowFail: true });
    m = (m || '').trim();
  }
  return m;
}

function ensureStaleLabel(num) {
  if (DRY) { console.log(`[dry] +label stale-review #${num}`); return; }
  gh(['pr', 'edit', String(num), '--repo', REPO, '--add-label', 'stale-review'],
    { json: false, allowFail: true });
}

function commentConflictOnce(num, branch) {
  // Dedup: salta se il marker è già presente in un commento.
  if (hasCommentMarker(num, CONFLICT_MARKER)) {
    console.log(`PR #${num}: marker conflitto già presente — no comment.`);
    return;
  }
  const body = `${CONFLICT_MARKER}\n♻️ **autorebase**: \`git merge origin/main\` su \`${branch}\` ha prodotto un CONFLITTO — abort eseguito, branch invariato. Etichettata \`stale-review\`: il branch è dietro main e va rebasato a mano (o verrà riciclato da recycle-stale-prs se resta fermo). _Segnale deterministico da pr-autorebase.yml (zero-Claude)._`;
  if (DRY) { console.log(`[dry] comment conflict #${num}`); return; }
  gh(['pr', 'comment', String(num), '--repo', REPO, '--body', body], { json: false, allowFail: true });
}

// --- AUTO-RESOLVE conflitti import-union (la classe #1 dei conflitti cross-PR) -
// Quando due PR toccano gli `import` dello stesso file, `git merge origin/main`
// produce un conflitto di SOLE righe import (entrambi i lati aggiungono import
// DISTINTI). È risolvibile in modo sicuro per UNIONE (tieni entrambi). Osservato
// #2057: `import {FX_HREF,...} from './comparatorHref'` (PR) vs `import
// {cantonGrossSalaryBand} from './cantonSalaryIndex'` (main) → stuck CONFLICTING
// finché un umano non l'ha risolto a mano. Questo automatizza ESATTAMENTE quel
// caso, restando STRETTO: risolve solo se OGNI hunk di OGNI file conflittuale è
// import-only-additivo; qualunque altro conflitto → return false → il chiamante
// aborta e flagga stale-review (recycle). Guard anti-collisione: se l'unione
// importerebbe lo STESSO binding due volte (stesso simbolo, path diversi) →
// non-sicuro → false. Il push post-resolve passa comunque dal gate vitest di
// auto-merge-eval: una risoluzione errata non mergia (test rossi).

/** Risolve i conflitti import-only nel testo di UN file. Ritorna il testo
 * risolto, o null se un hunk NON è import-only (→ non sicuro da auto-risolvere).
 * Un lato "import-only" = ogni riga è `import ...`, commento, o vuota. */
export function resolveImportConflictsInText(text) {
  const lines = text.split('\n');
  const out = [];
  const importedBindings = new Set();
  const collectBindings = (impLines) => {
    for (const l of impLines) {
      const m = /import\s+(?:type\s+)?\{([^}]*)\}/.exec(l);
      if (m) for (const b of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
        if (importedBindings.has(b)) return false; // stesso binding 2× → collisione, non-sicuro
        importedBindings.add(b);
      }
    }
    return true;
  };
  const isImportOnly = (block) =>
    block.every((l) => l.trim() === '' || /^\s*import\s/.test(l) || /^\s*\/\//.test(l) || /^\s*\*/.test(l));
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) { out.push(lines[i]); continue; }
    // raccogli hunk: <<<<<<< … ======= … >>>>>>>
    const ours = []; const theirs = []; let sep = false; let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].startsWith('=======')) { sep = true; continue; }
      if (lines[j].startsWith('>>>>>>>')) { closed = true; break; }
      (sep ? theirs : ours).push(lines[j]);
    }
    if (!closed) return null; // marker malformato → non toccare
    if (!isImportOnly(ours) || !isImportOnly(theirs)) return null; // non import-only → non sicuro
    // union dedup-ata, preservando l'ordine (ours poi theirs non già presenti)
    const seen = new Set();
    const union = [];
    for (const l of [...ours, ...theirs]) {
      const key = l.trim();
      if (key === '') continue;
      if (seen.has(key)) continue;
      seen.add(key); union.push(l);
    }
    if (!collectBindings(union)) return null; // collisione di binding → non sicuro
    out.push(...union);
    i = j; // salta al >>>>>>>
  }
  return out.join('\n');
}

/** Applica resolveImportConflictsInText a tutti i file in conflitto. true se TUTTI
 * risolti in modo sicuro (import-only) + `git add`-ati; false se almeno uno non è
 * auto-risolvibile (il chiamante deve `git merge --abort`). */
function resolveImportUnionConflicts() {
  const raw = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '';
  const files = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!files.length) return false;
  for (const f of files) {
    let resolved;
    try { resolved = resolveImportConflictsInText(readFileSync(f, 'utf8')); }
    catch { return false; }
    if (resolved === null) { console.log(`  conflitto non import-only in ${f} → non auto-risolvibile`); return false; }
    try { writeFileSync(f, resolved); } catch { return false; }
    git(['add', f], { allowFail: true });
  }
  console.log(`auto-resolve: ${files.length} file conflitto import-union risolti per unione`);
  return true;
}

async function processPR(pr) {
  const num = pr.number;
  const branch = pr.headRefName;
  const head = pr.headRefOid;
  const labels = (pr.labels || []).map((l) => l.name);

  // GATE `needs-human`: una passata SOLO se lo stato è cambiato.
  //
  // Deve stare QUI, prima di tutto il resto, e non sul `dispatchTests` del ramo
  // needs-human più sotto. Quel ramo viene DOPO `pushBranch`, e il push del
  // rebase — autenticato App/PAT — ri-triggera da sé i workflow `pull_request`
  // (#3038, vedi header): togliere il solo dispatch lascerebbe in piedi sia la
  // vitest sia `pr-review-loop`, cioè quota Claude, su una PR che aspetta una
  // persona. Il lavoro da non fare è la passata intera.
  //
  // Costo evitato: cron `*/30` = 48 tick/giorno × ~18 min di vitest ≈ 14,4 h di
  // CI al giorno per UNA PR ferma. La coda è serializzata: le pagano le altre.
  //
  // Le tre chiamate API dell'impronta costano ~1s e sostituiscono ~18 min di CI.
  if (labels.includes('needs-human')) {
    const vc = normalizedVitestConclusion(head);
    const fp = reopenStateFingerprint(num, vc);
    const body = readReopenBudgetBody(num);
    const prior = parseReopenBudget(body);
    const d = decideNeedsHumanPass({ fingerprint: fp, prior });
    if (d.action === 'skip-idle') {
      console.log(`PR #${num}: ${d.reason}`);
      return;
    }
    // Stato cambiato → si prosegue con UNA passata piena (rebase + dispatch dal
    // ramo needs-human più sotto). L'impronta si registra ORA: se la passata
    // muore a metà non si ripete comunque a raffica, e l'umano che arriva vede
    // perché. `count: 0` è coerente — il breaker riparte da zero su uno stato
    // nuovo, esattamente come nel reset normale.
    const next = renderReopenBudget({
      count: 0, max: MAX_REOPENS, fingerprint: fp, action: 'needs-human-pass', reason: d.reason,
    });
    if (body !== next) {
      upsertStickyComment(gh, REPO, num, REOPEN_BUDGET_MARKER, next, { dry: DRY });
    }
    console.log(`PR #${num}: ${d.reason}`);
  }

  // GATE frugalità: solo near-merge.
  const lgtm = hasLgtmReview(num);
  let nearMerge =
    labels.includes('collision-risk') ||
    labels.includes('stale-review') ||
    lgtm;

  // ── QUARTA classe near-merge: STUCK-RED (2026-08-05) ───────────────────────
  // Le prime tre classi presuppongono che una PR bloccata abbia GIÀ un segnale:
  // un `## LGTM`, o una label messa da qualcun altro. Una PR il cui vitest è
  // rosso non ne ha NESSUNO, e non può acquisirne, perché ogni produttore di
  // segnale è a valle del vitest verde:
  //   pr-review-loop.yml gira solo su `workflow_run.conclusion == 'success'`
  //     → niente review ⇒ niente LGTM ⇒ niente label;
  //   stale-pr-rescuer.yml classe A esige `tests == success`, classe B esige una
  //     review con 🔴 → cade nell'`else` ⇒ non mette nemmeno `stale-review`;
  //   e qui il gate sopra la skippa.
  // Il grafo non ha archi uscenti: la PR resta rossa PER SEMPRE, anche dopo che
  // main è tornato verde. Misurato su 8 PR (#5019 #5067 #5068 #5070 #5072 #5073
  // #5074 #5085), ferme 1-4 giorni con `vitest (unit + integration)` come UNICO
  // check rosso (`detect` e `contract` verdi su tutte, mergeable=MERGEABLE: non
  // erano conflitti né il body-contract).
  // Rompiamo il ciclo SOLO con prova positiva che il rosso non è della PR
  // (vitestFailureIsNotAttributableToPr: main tornato verde dopo il test, o rosso
  // stantio >24h = infra) e SOLO se la PR è behind — se è già allineata a main
  // non c'è nulla di nuovo da ereditare e il rosso è suo. One-shot via marker.
  // `behind` serve sia allo stuck-red sia al flusso normale: memoizzato per non
  // pagare due volte la compare API (l'unica chiamata IN PIÙ rispetto a prima è
  // per le PR non-near-merge, dove prima si usciva subito).
  let _behind = null;
  const behindOf = () => (_behind ??= behindMain(head));

  let stuckRedReason = '';
  if (!nearMerge && behindOf() > 0) {
    stuckRedReason = stuckRedRescueReason(head);
    if (stuckRedReason && hasCommentMarker(num, STUCK_RED_MARKER)) {
      console.log(`PR #${num} stuck-red (${stuckRedReason}) ma GIÀ ri-testata una volta (marker) — skip: il rosso è suo.`);
      stuckRedReason = '';
    }
    if (stuckRedReason) nearMerge = true;
  }

  if (!nearMerge) {
    console.log(`PR #${num} non near-merge (no LGTM/collision-risk/stale-review/stuck-red) — skip.`);
    return;
  }

  const behind = behindOf();

  if (stuckRedReason) {
    console.log(`PR #${num} STUCK-RED (${stuckRedReason}): vitest rosso non attribuibile alla PR, ${behind} dietro main → rescue one-shot (rebase + re-test).`);
    if (!DRY) {
      const why = stuckRedReason === 'red-main'
        ? 'il suo `vitest` è stato eseguito sul merge ref mentre `main` era ROSSO, ed è tornato verde dopo'
        : 'il suo `vitest` è rosso da oltre ' + STUCK_RED_STALE_H + 'h senza che nulla possa ri-eseguirlo (probabile fallimento infrastrutturale)';
      gh(['pr', 'comment', String(num), '--repo', REPO, '--body',
        `${STUCK_RED_MARKER}\n♻️ **autorebase / stuck-red**: questa PR è ferma perché ${why}.\n\nCon vitest rosso \`pr-review-loop\` non parte (gira solo su \`tests\` success), quindi la PR non può ottenere né \`## LGTM\` né una label — e senza quelli nessun workflow la ri-testa: stato assorbente. Rebase su \`origin/main\` + ri-esecuzione dei test, **una sola volta**. Se torna rossa, il fallimento è della PR.\n\n_Segnale deterministico da pr-autorebase.yml (zero-Claude)._`],
        { json: false, allowFail: true });
    }
  }

  if (behind === 0) {
    // Già allineata a main, ma l'head può essere "orfano" (0 check-run vitest):
    // rebasato da un push PAT che non ha ri-triggerato `pull_request`, o da un
    // autorebase pre-#1597 che pushava senza dispatchare. In quel caso
    // auto-merge-eval resta in attesa per sempre (gate vitest==success mai
    // soddisfatto) → PR near-merge bloccata (osservato #1595/#1526). HEAL: se
    // manca del tutto il check vitest, dispatchiamo tests.yml. Idempotente:
    // appena un run è queued, headHasVitestCheck torna true → niente
    // ri-dispatch. Nessun rebase, nessuna review Claude.
    if (!headHasVitestCheck(head)) {
      if (!lgtm && !hasAnyClaudeReview(num)) {
        // Classe-A: nemmeno la review esiste (drift 401) — il solo vitest non
        // sblocca (auto-merge esige LGTM). Reopen = review+tests insieme.
        console.log(`PR #${num} 0 dietro main, NESSUNA review claude e niente vitest → close+reopen (re-trigger review+tests).`);
        guardedReopen(num, head);
      } else {
        console.log(`PR #${num} 0 dietro main ma head ${head.slice(0, 8)} SENZA check-run vitest → dispatch tests.yml (heal, no rebase).`);
        dispatchTests(num, branch);
      }
    } else if (vitestVerdictIsTransient(head)) {
      // Il check vitest ESISTE ma il suo verdetto rosso è una CANCELLAZIONE da
      // concurrency, non un test rotto, e nessun run fresco è già pendente:
      // `cancelled` sul check stesso (job singolo, post-de-shard #2882) o
      // `failure` collassato da shard cancellati (vecchia matrice, #2438).
      // L'head resterebbe ferma (l'heal sopra scatta solo su check ASSENTE;
      // auto-merge esige `success`) finché un evento esterno non ri-dispatcha.
      // Ri-dispatch tests.yml (heal), NESSUN rebase. Un `failure` REALE non passa
      // di qui → niente re-run gratis (AGENTS #5 + frugalità CI).
      console.log(`PR #${num} 0 dietro main, vitest rosso da CANCELLAZIONE (transient, nessun verdetto sul codice) → dispatch tests.yml (heal, no rebase).`);
      dispatchTests(num, branch);
    } else {
      console.log(`PR #${num} 0 dietro main, vitest già presente sull'head — skip.`);
    }
    return;
  }
  // CONFLITTO con main: va gestito PRIMA dello skip wave-11. Senza questo, una
  // PR lgtm+verde+CONFLICTING veniva skippata (lo skip presume "auto-merge la
  // mergia così com'è" — ma auto-merge NON mergia un conflitto) → restava stuck
  // senza stale-review, quindi nemmeno recycle la prendeva (gap #2057, ferma
  // 2.5h, label vuote). Qui: TENTA l'auto-resolve import-union (la classe #1 dei
  // conflitti cross-PR, es. #2057: due PR aggiungono import distinti allo stesso
  // file → unione sicura); se non auto-risolvibile → stale-review (recycle).
  // Solo behind>0 può confliggere (behind===0 già gestito sopra).
  {
    const mc = await mergeableState(num);
    if (mc === 'CONFLICTING') {
      if (DRY) { console.log(`[dry] #${num} CONFLICTING → tenta auto-resolve import-union, else stale-review`); return; }
      let done = false;
      git(['fetch', 'origin', branch, 'main'], { allowFail: true });
      const co = git(['checkout', '-B', branch, `origin/${branch}`], { allowFail: true });
      if (co !== null) {
        git(['config', 'user.name', 'Valerie Linc']);
        git(['config', 'user.email', 'valerielinc@gmail.com']);
        const mg = git(['merge', '--no-edit', 'origin/main'], { allowFail: true });
        if (mg === null && resolveImportUnionConflicts() && git(['commit', '--no-edit'], { allowFail: true }) !== null) {
          const pushed = pushBranch(branch);
          if (pushed !== null) {
            // Push OK: la PR è ora mergeable. Dispatch tests (gate vitest di
            // auto-merge-eval valida la risoluzione: se l'unione fosse errata i
            // test falliscono e non si mergia). LGTM carry-forward.
            console.log(`✅ PR #${num}: conflitto import-union AUTO-RISOLTO + pushato → mergeable; dispatch tests.`);
            dispatchTests(num, branch);
            done = true;
          }
        }
        if (!done) git(['merge', '--abort'], { allowFail: true });
      }
      if (!done) {
        console.log(`PR #${num} CONFLICTING non auto-risolvibile (non import-only) → stale-review + comment (recycle).`);
        ensureStaleLabel(num);
        commentConflictOnce(num, branch);
      }
      return;
    }
  }

  // SKIP rebase delle PR già pronte al merge (2026-06-15): main NON richiede
  // branch up-to-date (branch protection `strict=false`, required_checks=[]),
  // quindi una PR LGTM'd + vitest verde sull'head viene squash-mergiata da
  // auto-merge ANCHE se dietro main — il rebase è inutile e DANNOSO: il merge
  // di origin/main crea un nuovo head, il synchronize del push-PAT va
  // `action_required`/non ricrea il check-run, il vitest verde sparisce e
  // auto-merge-eval (gate vitest==success) si blocca per sempre (circolo vizioso
  // osservato 00:30Z: #2026/#2028/#855 LGTM'd rebasati → action_required → stuck;
  // più la PR aspetta, più l'autorebase la rompe). Tocchiamo solo le PR che il
  // rebase serve DAVVERO: collision-risk (il gate collisione esige il rebase
  // oltre l'altra PR) e stale-review (drift/conflitto). Una LGTM'd+verde senza
  // collisione → lasciala ad auto-merge.
  // NB: vitest deve essere non-`failure`. Su failure va rebasata per ereditare
  // eventuali fix lato main (una PR behind+LGTM con vitest=failure NON è
  // mergeable-as-is: auto-merge-eval esige conclusion==success).
  // NON gattare lo skip su headHasVitestCheck(head): era la race che innescava
  // il LIVELOCK. Appena un rebase orfanizza l'head, headHasVitestCheck torna
  // false → lo skip NON scattava → si ri-rebasava → nuova head orfana → loop
  // (osservato 2026-06-17 su main caldo: #2415 rebasata 3× in 15min, vitest
  // sempre queued/cancelled, mai verde, mai mergiata). Per una LGTM'd
  // non-collision NON si rebasa MAI (main è non-strict → auto-merge la mergia
  // behind così com'è); se l'head è orfana (nessun check vitest) lo SKIP da solo
  // la lascerebbe stuck (gate 3 mai success) → la SANIAMO dispatchando tests
  // (orphan-heal esteso a behind>0, prima solo behind===0), senza rebasare: il
  // check vitest atterra su una head STABILE e auto-merge la mergia behind.
  const action = rebaseActionForLgtmPr({
    lgtm,
    collisionRisk: labels.includes('collision-risk'),
    vitestConclusion: vitestConclusion(head),
    hasVitestCheck: headHasVitestCheck(head),
  });
  if (action === 'heal') {
    console.log(`PR #${num} LGTM non-collision, ${behind} dietro main, head ${head.slice(0, 8)} SENZA check-run vitest → dispatch tests (heal, NO rebase: main non-strict, auto-merge la mergia behind).`);
    dispatchTests(num, branch);
    return;
  }
  if (action === 'skip') {
    console.log(`PR #${num} LGTM + vitest non-failure sull'head, no collision, ${behind} dietro main → SKIP rebase (main non-strict: auto-merge la mergia così com'è; rebasarla orfanizzerebbe l'head).`);
    return;
  }
  console.log(`PR #${num} (${branch}) è ${behind} dietro main, near-merge → valuto rebase.`);

  // Review-in-flight guard: NON rebasare mentre una review Claude è in volo
  // sull'head. Il push del rebase (App/PAT) ri-triggera pr-review-loop, che con
  // cancel-in-progress CANCELLA la review in corso e la riavvia → con main caldo
  // la review non conclude mai (livelock; quota bruciata). Defer di un tick: la
  // review conclude, posta il verdetto, auto-merge-eval porta avanti l'LGTM. Il
  // rebase non è urgente (main è sempre fresco). NB: l'orphan-heal sopra dispatcha
  // solo tests (no push), quindi non è soggetto a questa race.
  if (reviewInProgress(head)) {
    console.log(`PR #${num}: review Claude in volo sull'head ${head.slice(0, 8)} — skip rebase questo tick (un push ora la cancellerebbe; defer finché conclude).`);
    return;
  }

  // Activity-guard: se l'head è stato pushato pochi minuti fa, un contributor/
  // agent è probabilmente mid-flight (sta ancora pushando fix su una PR LGTM'd).
  // Rebasare ora racerebbe il suo push → skip, riprova al prossimo tick (il
  // rebase non è urgente: main è sempre fresco). Non tocca l'orphan-heal sopra
  // (quello dispatcha solo tests, nessuna race di push).
  if (ACTIVITY_GUARD_MIN > 0) {
    const mins = headPushedMinutesAgo(head);
    if (mins < ACTIVITY_GUARD_MIN) {
      console.log(`PR #${num}: head pushato ${mins.toFixed(1)}min fa (< ${ACTIVITY_GUARD_MIN}min) — contributor mid-flight, skip rebase questo tick.`);
      return;
    }
  }

  const m = await mergeableState(num);
  if (m === 'UNKNOWN' || m === '') {
    console.log(`PR #${num} mergeable=UNKNOWN dopo poll — skip questo run (riprova al prossimo tick).`);
    return;
  }

  if (m === 'CONFLICTING') {
    console.log(`PR #${num} mergeable=CONFLICTING → label stale-review + comment once.`);
    ensureStaleLabel(num);
    commentConflictOnce(num, branch);
    return;
  }

  if (m !== 'MERGEABLE') {
    console.log(`PR #${num} mergeable=${m} (non MERGEABLE/CONFLICTING) — skip.`);
    return;
  }

  // MERGEABLE → tenta il merge di origin/main nel branch.
  if (DRY) { console.log(`[dry] rebase #${num}: fetch + merge origin/main + push ${branch}`); return; }

  git(['fetch', 'origin', branch, 'main'], { allowFail: true });
  // checkout del branch sull'head remoto (worktree CI pulito).
  const co = git(['checkout', '-B', branch, `origin/${branch}`], { allowFail: true });
  if (co === null) { console.log(`PR #${num}: checkout di ${branch} fallito — skip.`); return; }
  git(['config', 'user.name', 'Valerie Linc']);
  git(['config', 'user.email', 'valerielinc@gmail.com']);

  const merged = git(['merge', '--no-edit', 'origin/main'], { allowFail: true });
  if (merged === null) {
    // Conflitto a runtime (mergeable era ottimista o è cambiato tra check e
    // merge). Tenta l'auto-resolve import-union come nel path CONFLICTING; se
    // non import-only → abort + stale-review.
    if (resolveImportUnionConflicts() && git(['commit', '--no-edit'], { allowFail: true }) !== null) {
      console.log(`PR #${num}: conflitto runtime AUTO-RISOLTO (import-union) → proseguo col push.`);
    } else {
      console.log(`PR #${num}: merge origin/main ha conflitto non auto-risolvibile → abort + stale-review + comment.`);
      git(['merge', '--abort'], { allowFail: true });
      ensureStaleLabel(num);
      commentConflictOnce(num, branch);
      return;
    }
  }

  // Push via PAT. TOCTOU: tra mergeable-check e push un nuovo commit potrebbe
  // essere arrivato → push non-fast-forward fallisce (no --force): skip, il
  // prossimo tick ricalcola.
  const pushed = pushBranch(branch);
  if (pushed === null) {
    console.log(`PR #${num}: push fallito (probabile non-fast-forward / TOCTOU) — skip, riprova al prossimo tick.`);
    return;
  }

  // Ri-esegui SOLO i test sull'head rebasato — NON la review Claude (frugalità
  // quota). Un push PAT su un branch PR NON ri-triggera in modo affidabile i
  // workflow `pull_request` (osservato: head rebasati di #1587/#1526 con ZERO
  // check-run), quindi dispatchiamo esplicitamente `tests.yml` sul branch: il
  // check-run `vitest (unit + integration)` atterra sull'head (= gate 3 di
  // auto-merge-eval) e il suo `workflow_run: completed` ri-valuta
  // auto-merge-on-lgtm. L'LGTM esistente viene portato avanti da
  // auto-merge-eval (contributo PR invariato su un rebase di solo main-merge),
  // quindi NESSUNA review Opus/Sonnet gira di nuovo. Best-effort: se il
  // dispatch fallisce (PAT senza scope actions:write) lo logghiamo soltanto.
  // !lgtm dopo un rebase = la PR NON è pronta al merge (manca l'LGTM): o non ha
  // mai avuto review (classe-A, drift 401), o ne ha una con 🔴/❓ non chiuso. In
  // ENTRAMBI i casi il rebase ha appena allineato i workflow a main (drift
  // workflow-validation risolto), ma serve ri-triggerare review+redflag: un
  // semplice dispatch tests NON rilancia pr-review-loop/redflag-fixer (triggerano
  // su review submitted), quindi il 🔴+drift resterebbe stuck fino al recycle
  // 24h. close+reopen emette `reopened` → review gira drift-free → (se 🔴)
  // redflag-fixer riparte. ECCEZIONE needs-human: già escalata (round-cap),
  // reopen riavvierebbe review inutilmente → skip (il round-cap marker persiste,
  // niente loop, ma evitiamo la review-quota su una PR che aspetta un umano).
  if (!lgtm) {
    if (labels.includes('needs-human')) {
      console.log(`PR #${num}: rebasata ma needs-human (round-cap) → no reopen (attende umano); solo dispatch tests.`);
      dispatchTests(num, branch);
      return;
    }
    const why = hasAnyClaudeReview(num) ? '🔴/❓ non chiuso + drift sanato' : 'classe-A senza review';
    // Il reopen passa dal breaker: è QUESTO call-site che ha prodotto le 12+10
    // riaperture di #5896/#5906. `!lgtm` con vitest rosso è una condizione che
    // il reopen non può cambiare (pr-review-loop gira solo su tests success),
    // quindi senza guardia si ripete a ogni tick per sempre.
    if (guardedReopen(num, head)) {
      console.log(`✅ PR #${num}: rebasata, pushata e ri-aperta (${why}) → review+redflag ri-triggerati drift-free.`);
    }
    return;
  }
  if (dispatchTests(num, branch)) {
    console.log(`✅ PR #${num}: rebasata su origin/main, pushata (${branch}) e dispatchato tests.yml → vitest sull'head; LGTM carry-forward, zero Claude.`);
  }
}

async function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  if (!TOKEN) { console.error('::warning::GH_TOKEN (PAT) assente → autorebase inerte (serve per push + dispatch tests.yml).'); process.exit(0); }
  console.log(`pr-autorebase${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

  let prs;
  try {
    prs = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50',
      '--json', 'number,headRefName,headRefOid,isDraft,labels']);
  } catch (e) {
    console.error(`gh pr list fallito: ${String(e).slice(0, 160)}`);
    process.exit(0);
  }
  const openUnrotated = (prs || []).filter((p) => !p.isDraft);
  // Rotazione anti-starvation (#5145/#5144 punto 3): il cap `MAX_PER_RUN` e il
  // budget di run tagliano entrambi la CODA della lista. Partendo sempre dalla
  // stessa testa, una PR lenta in posizione 1 non consuma solo il proprio turno:
  // rende irraggiungibili tutte quelle dietro, a ogni run. Ruotando su
  // GITHUB_RUN_NUMBER ogni PR passa dalla testa nell'arco di pochi tick.
  const open = rotateForFairness(openUnrotated, process.env.GITHUB_RUN_NUMBER);
  console.log(`PR open non-draft: ${open.length}${open.length > 1 ? ` (ordine ruotato su run #${process.env.GITHUB_RUN_NUMBER || '?'} — anti-starvation)` : ''}`);
  if (budget.enabled) {
    console.log(`budget di run: ${Math.round(budget.remainingMs() / 1000)}s utilizzabili prima della deadline del job.`);
  }

  let processed = 0;
  let cappedSkipped = 0;
  for (const pr of open) {
    if (processed >= MAX_PER_RUN) {
      cappedSkipped++;
      continue;
    }
    // BUDGET GUARD: fermarsi PRIMA di cominciare una PR che non si farebbe in
    // tempo a finire. Le PR non valutate restano esattamente com'erano — non
    // c'è nessuno stato da ripulire — e il prossimo tick le rivaluta da zero
    // (il loop è già interamente idempotente: ogni decisione è ricalcolata da
    // GitHub, niente è memorizzato fra un run e l'altro).
    if (!budget.take(`#${pr.number}`, PR_COST_MS)) {
      continue;
    }
    processed++;
    try {
      await processPR(pr);
    } catch (e) {
      console.log(`::warning::PR #${pr.number} errore in processPR: ${String(e).slice(0, 160)}`);
    }
  }
  if (cappedSkipped > 0) {
    console.log(`::warning::cap raggiunto (${MAX_PER_RUN}/run): ${cappedSkipped} PR non valutate questo run (verranno valutate al prossimo tick).`);
  }
  budget.report();
  console.log(`autorebase scan completo (${processed} PR valutate).`);
}

// Esegui solo come CLI (non quando importato dai test → resolveImportConflictsInText
// testabile in isolamento, come classify-issue.mjs / alert-pat-down.mjs).
if (process.argv[1] && process.argv[1].endsWith('pr-autorebase.mjs')) {
  main();
}
