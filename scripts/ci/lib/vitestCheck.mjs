/**
 * vitestCheck.mjs — selezione robusta del verdetto del check-run vitest sull'HEAD.
 *
 * Estratto in UN modulo condiviso perché DUE consumer leggevano lo stesso
 * costrutto fragile: `auto-merge-eval.mjs` (gate 3: HEAD vitest == success) e
 * `pr-autorebase.mjs` (`vitestConclusion`, decide se rebasare una PR behind con
 * vitest rosso). Entrambi facevano `[.check_runs[] | select(.name == NAME)][0]`
 * — il PRIMO della lista per ordine API, NON il più recente.
 *
 * Perché era un bug (osservato su PR #2394, experiment(build)): un singolo SHA
 * immutabile può portare PIÙ check-run con lo STESSO nome `vitest (unit +
 * integration)` — il run `pull_request` PIÙ qualunque `workflow_dispatch`
 * manuale di tests.yml sullo stesso branch. Un dispatch cancellato/fallito
 * lascia un check-run `failure` su quello SHA; `[0]` ne pescava uno ARBITRARIO,
 * così un `failure` stantio mascherava il `success` reale → auto-merge bloccato
 * a oltranza pur con i test verdi (l'auto-merge è event-driven e non ri-valuta
 * da solo). La selezione "ultimo COMPLETATO con verdetto per completed_at" è
 * invariante all'ordine API e ai duplicati: vince il verdetto finito più fresco
 * per il codice all'HEAD. Un job `skipped` è completato ma non è un verdetto e
 * viene escluso.
 *
 * I run in-progress/queued (senza `completed_at`) sono ignorati di proposito:
 * un dispatch manuale appeso non deve bloccare il merge per sempre. Se NESSUN
 * vitest è ancora concluso ritorna '' (gate in attesa) — preserva l'invariante
 * #1454 "niente merge su pending/missing".
 */
import {
  VITEST_CHECK_NAME,
  VITEST_EXECUTION_JOB_NAME,
  VITEST_SHARD_NAME_RE,
} from './constants.mjs';

/**
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 *   L'array `.check_runs` della GitHub check-runs API.
 * @returns {string} La conclusion del check-run vitest COMPLETATO con verdetto
 *   più recente (per `completed_at`), o '' se nessuno è ancora concluso/presente.
 */
export function latestCompletedVitestConclusion(checkRuns) {
  const last = latestCompletedVitestRun(checkRuns);
  return last ? last.conclusion || '' : '';
}

/**
 * Come `latestCompletedVitestConclusion` ma ritorna il check-run INTERO, non solo
 * la sua conclusion: serve a chi ha bisogno anche del `completed_at` (quando la
 * PR è stata testata) per correlarlo con lo stato di `main` a quell'istante —
 * vedi `vitestFailureIsNotAttributableToPr`. Stessa identica selezione (ultimo
 * COMPLETATO con verdetto per `completed_at`), estratta per non duplicare il
 * filtro fragile.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 * @returns {{name?: string, status?: string, conclusion?: string, completed_at?: string}|null}
 */
export function latestCompletedVitestRun(checkRuns) {
  return latestCompletedRunByName(checkRuns, VITEST_CHECK_NAME);
}

/**
 * Il job che esegue la suite e la review pubblica anche il check required.
 * Questo helper restituisce il suo link Jobs API ai consumer che leggono gli
 * step; la selezione coincide con quella del verdetto required.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 * @returns {{name?: string, status?: string, conclusion?: string, completed_at?: string, details_url?: string}|null}
 */
export function latestCompletedVitestExecutionRun(checkRuns) {
  return latestCompletedRunByName(checkRuns, VITEST_EXECUTION_JOB_NAME);
}

/**
 * Generalizzazione di `latestCompletedVitestRun` a un check-run name
 * arbitrario — stessa selezione ("ultimo COMPLETATO con verdetto per
 * `completed_at`", non
 * un `[0]` arbitrario), stessa ragione (un SHA immutabile può portare più
 * check-run con lo stesso nome, es. un `workflow_dispatch` manuale sullo
 * stesso branch). Usata anche per `GENERATOR_CI_JOB_NAME` (#242: il gate
 * dell'auto-merge sul check "test" di generator-ci.yml non deve ripetere il
 * bug del `[0]` arbitrario che questo modulo esiste per chiudere).
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 * @param {string} name
 * @returns {{name?: string, status?: string, conclusion?: string, completed_at?: string}|null}
 */
export function latestCompletedRunByName(checkRuns, name) {
  if (!Array.isArray(checkRuns)) return null;
  const completed = checkRuns
    .filter(
      (c) =>
        c &&
        c.name === name &&
        c.status === 'completed' &&
        c.conclusion !== 'skipped' &&
        typeof c.completed_at === 'string' &&
        c.completed_at,
    )
    .sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at));
  return completed[completed.length - 1] || null;
}

/**
 * Conclusion del check-run COMPLETATO con verdetto più recente per un nome arbitrario, o
 * `''` se nessuno è ancora concluso/presente. Sibling di
 * `latestCompletedVitestConclusion` per check-run diversi da vitest (#242).
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 * @param {string} name
 * @returns {string}
 */
export function latestCompletedConclusionByName(checkRuns, name) {
  const last = latestCompletedRunByName(checkRuns, name);
  return last ? last.conclusion || '' : '';
}

/**
 * Il verdetto vitest rosso sull'HEAD è una cancellazione TRANSIENT (concurrency)
 * e NON un test rotto?
 *
 * ── Perché il nome è cambiato (2026-08-05) ─────────────────────────────────
 * Si chiamava `vitestFailureIsTransientCancellation` e guardava SOLO il caso
 * `failure`, perché nella topologia a shard il rosso transient non poteva
 * presentarsi altrimenti. Dopo il de-sharding (#2882) può, e il nome mentiva:
 * un verdetto `cancelled` non è un `failure`. Vedi le due topologie sotto.
 *
 * ── Topologia CORRENTE: un unico job required ─────────────
 * `tests.yml` ha un unico job che esegue i controlli e pubblica il required, senza
 * matrice. Una cancellazione (concurrency `cancel-in-progress`, runner
 * shutdown) atterra quindi come `cancelled` sul check required, senza
 * collasso in `failure`. Quel verdetto non è un fallimento del codice: il run
 * non ha prodotto NESSUN verdetto, quindi ri-eseguirlo non può mascherare un
 * test rotto — è l'unico modo per ottenere un'informazione che al momento non
 * esiste.
 *
 * Senza questo ramo `cancelled` è uno stato ASSORBENTE, la stessa trappola
 * chiusa da `vitestFailureIsNotAttributableToPr` per il caso `failure`:
 *   - `auto-merge-eval` esige `success` → blocca;
 *   - la review Claude gira dentro il job di esecuzione, DOPO i test (fino al
 *     2026-08-26 era `pr-review-loop.yml`, gattato su `tests` success)
 *     → nessuna review ⇒ nessun `## LGTM`, nessuna label;
 *   - `vitestFailureIsNotAttributableToPr` esige `failure` → non copre;
 *   - `pr-autorebase` senza label/LGTM/stuck-red → skip.
 * Nessun arco uscente. (Rete di sicurezza indipendente a 2h: la classe C di
 * `stale-pr-rescuer.yml`, che etichetta `stale-review` e riapre il grafo.)
 *
 * ── Topologia a SHARD: conservata (#2438) ──────────────────────────────────
 * Con una matrice `vitest shard i/N` + job aggregatore che fa `exit 1` se
 * `needs.vitest-shard.result != success`, una cancellazione di massa lascia gli
 * shard `cancelled` e l'aggregatore COLLASSA `cancelled` in `failure`,
 * indistinguibile da un fail reale al solo aggregatore. Riapriamo gli shard per
 * ricostruire l'informazione persa: transient SOLO se NESSUNO shard è una
 * failure reale (`failure`/`timed_out`/`action_required`/`stale`) e ALMENO uno è
 * `cancelled`. Un solo shard `failure` → fail reale, NON ri-eseguire (AGENTS #5:
 * «test fail = right finché non provato contrario»; frugalità CI).
 * Il ramo resta perché `tests.yml` può tornare a shardare: cancellarlo
 * renderebbe il de-sharding irreversibile senza un revert di questo file.
 *
 * ── Guardie anti-spuria (valgono per entrambe le topologie) ────────────────
 *  - NESSUN check-run vitest (aggregatore o shard) dev'essere in-progress/queued:
 *    un run fresco già in coda risolverà da sé → non ri-dispatchare. Questo
 *    gestisce anche i duplicati su SHA immutabile (un `workflow_dispatch` manuale
 *    sullo stesso SHA): se esiste un set più nuovo ancora in corso, attendiamo.
 *  - Il verdetto COMPLETATO con conclusion non-`skipped` più recente (`latestCompletedVitestConclusion`, non
 *    un `[0]` arbitrario) dev'essere `cancelled` o `failure`: se l'ultimo run è
 *    già `success` non c'è nulla da sanare.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 *   L'array `.check_runs` della GitHub check-runs API per l'HEAD SHA.
 * @returns {boolean} true SOLO se il verdetto rosso è una cancellazione
 *   transient sicura da ri-dispatchare (heal); false su fail reale, run fresco
 *   pendente, verdetto non-rosso, o input non valido.
 */
export function vitestVerdictIsTransientCancellation(checkRuns) {
  if (!Array.isArray(checkRuns)) return false;

  const vitestRuns = checkRuns.filter(
    (c) =>
      c &&
      (c.name === VITEST_CHECK_NAME || VITEST_SHARD_NAME_RE.test(c.name || '')),
  );
  if (vitestRuns.length === 0) return false;

  // Run fresco pendente (aggregatore o shard non concluso) → attendi, non sanare.
  if (vitestRuns.some((c) => c.status !== 'completed')) return false;

  const verdict = latestCompletedVitestConclusion(checkRuns);

  // Topologia corrente (job singolo): la cancellazione è già il verdetto finale.
  // Nessuno shard da riaprire, e nessun verdetto sul codice da contraddire.
  if (verdict === 'cancelled') return true;

  // Topologia a shard: l'aggregatore ha collassato cancelled→failure.
  if (verdict !== 'failure') return false;

  const shards = vitestRuns.filter((c) => VITEST_SHARD_NAME_RE.test(c.name || ''));
  if (shards.length === 0) return false;

  const REAL_FAILURE = new Set(['failure', 'timed_out', 'action_required', 'stale']);
  if (shards.some((c) => REAL_FAILURE.has(c.conclusion))) return false;

  return shards.some((c) => c.conclusion === 'cancelled');
}

/**
 * Il `failure` di vitest sull'HEAD di una PR è NON attribuibile alla PR stessa,
 * quindi merita UNA ri-esecuzione contro main aggiornato?
 *
 * ── Il buco che chiude (misurato 2026-08-05, 8 PR ferme: #5019 #5067 #5068 #5070
 * #5072 #5073 #5074 #5085) ──────────────────────────────────────────────────
 * `tests.yml` gira sul MERGE REF (`refs/pull/N/merge`), quindi il verdetto
 * vitest di una PR contiene anche il codice di `main` a quell'istante. Quando
 * main è rosso, OGNI PR testata in quella finestra eredita il rosso senza che il
 * suo diff c'entri nulla. Misurato: main è stato `failure` dal 2026-08-02T09:14Z
 * al 2026-08-04T13:37Z (14 run tests.yml consecutive rosse su main) ed è tornato
 * verde alle 18:02Z col commit 3641631c; le 7 PR testate dentro quella finestra
 * fallivano tutte su `tests/workflows/articles-mirror-trigger.test.ts` (+
 * `blog-slugs-sitemap-sync`, `i18n-completeness`, `keyword-landing-plan`), file
 * che NESSUNA di loro tocca. Su main corrente quei 4 file passano (52/52).
 *
 * Il commento storico di `vitestVerdictIsTransientCancellation` afferma «un
 * vitest=failure sull'HEAD è sempre un fail reale». Sul merge ref quella
 * premessa è FALSA, e su di essa poggiava l'intera catena di recupero, che
 * diventa uno stato ASSORBENTE:
 *   1. la review Claude gira dentro il job di esecuzione, DOPO i test (fino al
 *      2026-08-26 era `pr-review-loop.yml`, gattato su `tests` success)
 *      → vitest rosso ⇒ nessuna review ⇒ nessun `## LGTM`, nessuna label.
 *   2. `pr-autorebase.mjs` tratta come near-merge solo LGTM / `collision-risk` /
 *      `stale-review` → nessuno dei tre ⇒ skip, niente rebase, niente re-test.
 *   3. `stale-pr-rescuer.yml` classe A esige `tests == success`, classe B esige
 *      una review con 🔴 → cade nell'`else` ⇒ skip, non mette nemmeno la label
 *      `stale-review` che sbloccherebbe (2).
 * Nessun arco esce dallo stato: la PR resta rossa per sempre anche dopo che main
 * è tornato verde. È esattamente ciò che è successo alle 8 PR.
 *
 * ── Il criterio ────────────────────────────────────────────────────────────
 * Ri-testiamo SOLO con prova positiva che il rosso non è della PR, mai «a
 * gratis» (AGENTS #5 + frugalità CI). Due prove, entrambe deterministiche:
 *  - `red-main`: dopo il vitest rosso della PR, `tests.yml` su main ha chiuso
 *    `success` almeno una volta ⇒ esiste su main codice noto-buono che la PR non
 *    ha mai visto. Copre le 7 PR della finestra rossa.
 *  - `stale`: il vitest rosso è più vecchio di `staleHours` (default 24h). È il
 *    backstop per i rossi non-di-main e non-di-PR (infrastruttura): #5019 è
 *    morta il 2026-08-01 su `error: RPC failed; curl 56 Recv failure` +
 *    `The runner has received a shutdown signal` durante il CHECKOUT, senza
 *    eseguire un singolo test, con main VERDE in quel momento — quindi `red-main`
 *    non la coprirebbe.
 *
 * Guardia: se un run vitest è già in volo sull'head (queued/in_progress) NON
 * proponiamo nulla — si risolverà da sé (stessa logica di
 * `vitestVerdictIsTransientCancellation`).
 *
 * Complementare, non sovrapposta, a `vitestVerdictIsTransientCancellation`:
 * quella copre il rosso SENZA verdetto sul codice (`cancelled`), questa il rosso
 * CON un verdetto che però appartiene a `main` e non alla PR (`failure` sul merge
 * ref). I due predicati si escludono a vicenda sul valore di `conclusion`.
 *
 * Il chiamante DEVE rendere l'azione one-shot per PR (marker/label): questa
 * funzione è pura e ri-risponderebbe `true` a ogni tick.
 *
 * @param {object} args
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} args.checkRuns
 *   `.check_runs` della check-runs API per l'HEAD SHA della PR.
 * @param {Array<{conclusion?: string, updated_at?: string}>} args.mainTestsRuns
 *   `.workflow_runs` di `actions/workflows/tests.yml/runs?branch=main`.
 * @param {number} [args.nowMs] Clock iniettabile (test).
 * @param {number} [args.staleHours] Soglia del backstop `stale`. 0 = disattivato.
 * @returns {{rescue: boolean, reason: string}} `reason` ∈ `'red-main'|'stale'|''`.
 */
export function vitestFailureIsNotAttributableToPr({
  checkRuns,
  mainTestsRuns,
  nowMs = Date.now(),
  staleHours = 24,
} = {}) {
  const NO = { rescue: false, reason: '' };
  if (!Array.isArray(checkRuns)) return NO;

  // Un run fresco già in coda/in corso risolverà da sé → non proporre nulla.
  const anyVitest = checkRuns.filter((c) => c && c.name === VITEST_CHECK_NAME);
  if (anyVitest.some((c) => c.status !== 'completed')) return NO;

  const last = latestCompletedVitestRun(checkRuns);
  if (!last || last.conclusion !== 'failure') return NO;

  const failedAt = Date.parse(last.completed_at);
  if (Number.isNaN(failedAt)) return NO;

  // Prova 1 — main è tornato verde DOPO che la PR è stata testata.
  if (Array.isArray(mainTestsRuns)) {
    const greenAfter = mainTestsRuns.some((r) => {
      if (!r || r.conclusion !== 'success') return false;
      const t = Date.parse(r.updated_at || '');
      return !Number.isNaN(t) && t > failedAt;
    });
    if (greenAfter) return { rescue: true, reason: 'red-main' };
  }

  // Prova 2 — backstop: rosso troppo vecchio per essere ancora informativo.
  if (staleHours > 0 && nowMs - failedAt > staleHours * 3600 * 1000) {
    return { rescue: true, reason: 'stale' };
  }

  return NO;
}

/**
 * Nome dello step di `tests.yml` che rende rosso il job `vitest (unit +
 * integration)` quando la review Claude sulla HEAD non è approvante (manca
 * `## LGTM`, oppure c'è un finding 🔴 Important). Vive qui e non in un literal
 * sparso perché è il DISCRIMINANTE fra due rossi che si chiamano uguali ma
 * vogliono cure opposte — vedi `vitestFailureIsReviewGate`.
 */
export const REVIEW_GATE_STEP_NAME = 'Require approving Claude review';

/** Nome dello step che esegue davvero la review dentro il job di esecuzione. */
export const CLAUDE_REVIEW_STEP_NAME = 'Run Claude review';

/** Nome dello step che rende esplicita una review abortita senza verdetto. */
export const REVIEW_ABORT_STEP_NAME = 'Fail on transient API error (no review posted)';

const REVIEW_STEP_IN_FLIGHT = new Set(['queued', 'in_progress']);
const NON_GATING_REVIEW_STEPS = new Set([
  'Mint GitHub App token for Claude review',
  'Claude usage metrics',
  'Explain the job verdict in the run summary',
]);
// Questi due step appartengono alla review, non al codice della PR. Un loro
// rosso non deve trasformare un gate puro in un falso rosso dei test.
export const REVIEW_DEATH_STEP_NAMES = new Set([
  CLAUDE_REVIEW_STEP_NAME,
  REVIEW_ABORT_STEP_NAME,
]);

/**
 * La review è in volo secondo la Jobs API?
 *
 * Il check-run non si chiama più `review`: dal 2026-08-26 la review è uno
 * step del job required `vitest (unit + integration)`. Il chiamante deve quindi
 * leggere `.steps` del job corrente e non cercare un check-run ormai morto.
 */
export function reviewStepIsInFlight(steps) {
  if (!Array.isArray(steps)) return false;
  return steps.some(
    (step) => step?.name === CLAUDE_REVIEW_STEP_NAME && REVIEW_STEP_IN_FLIGHT.has(String(step.status || '')),
  );
}

/** Uno step advisory non è un test né il review gate. */
export function isNonGatingReviewStep(name) {
  return NON_GATING_REVIEW_STEPS.has(String(name || ''));
}

/**
 * Il rosso del check required `vitest (unit + integration)` è il REVIEW GATE
 * del job di esecuzione e non i test?
 *
 * ── PERCHÉ SERVE ───────────────────────────────────────────────────────────
 * Fino al 2026-08-26 la review Claude era un workflow a parte
 * (`pr-review-loop.yml`) innescato da `workflow_run` su `tests` == success:
 * con vitest rosso la review NON partiva, quindi «vitest rosso» implicava
 * «nessuna review possibile» e riciclare la PR era inutile per costruzione.
 * Da `80a8c73f73a` («Unify tests and PR review workflow») la review è uno step
 * DENTRO il job `vitest (unit + integration)`, e gira PRIMA dello step che fa
 * fallire il job. La premessa si è quindi invertita: un vitest rosso causato
 * dal review gate significa che la review È GIÀ PARTITA e ha emesso un
 * verdetto — e un re-trigger è esattamente ciò che ne produce uno nuovo.
 *
 * ── IL SEGNALE ─────────────────────────────────────────────────────────────
 * Gli step del job, dalla jobs API: il gate è rosso ⇔ lo step
 * `REVIEW_GATE_STEP_NAME` è `failure`. Conservativo: se ANCHE un altro step è
 * fallito il rosso non è puro (ci sono test rotti sotto) → `false`, e vale la
 * precondizione normale. Meglio non riciclare una PR riciclabile che riciclare
 * all'infinito una PR coi test rossi (#5896/#5906).
 *
 * Pura: nessuna I/O. Il chiamante fetcha gli step e rende l'azione one-shot.
 *
 * @param {Array<{name?: string, conclusion?: string}>} steps `.steps` di
 *   `repos/{repo}/actions/jobs/{job_id}`.
 * @returns {boolean}
 */
export function vitestFailureIsReviewGate(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  let gateFailed = false;
  for (const s of steps) {
    // `cancelled` è un rosso operativo quanto `failure`: un cap del job può
    // lasciare i test senza verdetto, e ignorarlo farebbe passare il caso per
    // review pura (#1185).
    if (!s || !['failure', 'cancelled'].includes(s.conclusion)) continue;
    // Jobs API può esporre `failure` anche per `continue-on-error: true`.
    // Questi step sono advisory: il solo fallimento del review gate resta il
    // discriminante, non il rumore di token/metriche dopo il gate.
    if (isNonGatingReviewStep(s.name)) continue;
    if (s.name === REVIEW_GATE_STEP_NAME && s.conclusion === 'failure') gateFailed = true;
    else if (REVIEW_DEATH_STEP_NAMES.has(s.name)) continue;
    else return false; // un altro step rosso: non è (solo) il gate.
  }
  return gateFailed;
}

/**
 * Il gate è rosso perché il `Re-review guard` ha saltato Claude, non perché la
 * review sia fallita a metà? Pura e conservativa: un abort esplicito della
 * review prevale sul semplice `skipped`, così un errore API non consuma/nega
 * il one-shot del review gate (#1140).
 *
 * @param {Array<{name?: string, conclusion?: string}>} steps
 * @returns {boolean}
 */
export function reviewSkippedByGuard(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  const gate = steps.find((s) => s && s.name === REVIEW_GATE_STEP_NAME);
  if (!gate || gate.conclusion !== 'failure') return false;
  const abort = steps.find((s) => s && s.name === REVIEW_ABORT_STEP_NAME);
  if (abort && ['failure', 'cancelled'].includes(abort.conclusion)) return false;
  const review = steps.find((s) => s && s.name === CLAUDE_REVIEW_STEP_NAME);
  return Boolean(review && review.conclusion === 'skipped');
}

/**
 * La review è partita ma è morta senza postare il proprio verdetto?
 * L'output esplicito dello step di abort è la prova disponibile al consumer.
 *
 * @param {Array<{name?: string, conclusion?: string}>} steps
 * @returns {boolean}
 */
export function reviewAbortedWithoutVerdict(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  const gate = steps.find((s) => s && s.name === REVIEW_GATE_STEP_NAME);
  if (!gate || gate.conclusion !== 'failure') return false;
  const abort = steps.find((s) => s && s.name === REVIEW_ABORT_STEP_NAME);
  return Boolean(abort && abort.conclusion === 'failure');
}

/**
 * Il riferimento al JOB di Actions contenuto nel `details_url` di un check-run
 * (`https://github.com/<o>/<r>/actions/runs/<run_id>/job/<job_id>`), che è
 * l'unico puntatore al job che la check-runs API espone.
 *
 * Estrae ANCHE il `run_id`, non solo il job id: senza il run non si può
 * chiedere a GitHub quali job appartengono all'ATTEMPT corrente, e la
 * verifica di freschezza sotto (`currentAttemptJobSteps`) diventa impossibile.
 *
 * @param {{details_url?: string}|null} checkRun
 * @returns {{runId: string, jobId: string}|null} null se il link manca o non è
 *   nella forma attesa (chiamante: fail-CLOSED).
 */
export function jobRefFromCheckRun(checkRun) {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec((checkRun && checkRun.details_url) || '');
  return m ? { runId: m[1], jobId: m[2] } : null;
}

/**
 * Gli step del job puntato da un check-run, MA solo se quel job è ancora
 * quello dell'attempt CORRENTE del suo workflow-run.
 *
 * ── PERCHÉ NON BASTA `GET /actions/jobs/{job_id}` ──────────────────────────
 * Quell'endpoint risponde per QUALUNQUE job, compresi quelli di un attempt
 * superato: dopo un «Re-run failed jobs» (o su un run con `run_attempt > 1`)
 * il job id preso dal `details_url` di un check-run completato può descrivere
 * l'attempt PRECEDENTE. Gli step tornerebbero comunque — solo che sono la
 * lista di un'altra esecuzione. `vitestFailureIsReviewGate` deciderebbe allora
 * su dati stantii: concedere il one-shot del review gate quando il rosso
 * corrente sono i test (riciclo inutile, ~18min di CI su una coda
 * serializzata), o negarlo quando il rosso corrente è solo il gate (la PR
 * resta ferma e il messaggio torna a dire «far passare i test» a una PR coi
 * test verdi). È la stessa classe del bug #2394: prendere UN oggetto per un
 * puntatore comodo invece che per la sua freschezza.
 *
 * ── IL DISCRIMINANTE ───────────────────────────────────────────────────────
 * `GET /actions/runs/{run_id}/jobs` con `filter=latest` elenca i job del SOLO
 * attempt corrente, con i loro `steps`. Se il job id del `details_url` non è
 * in quella lista, per costruzione appartiene a un attempt superato → `[]`.
 * Nessuna soglia e nessuna euristica temporale: o il job è nell'attempt
 * corrente o non c'è.
 *
 * In più due controlli di IDENTITÀ, perché «attempt corrente» non implica
 * «lo stesso verdetto su cui stiamo decidendo»: il job dev'essere `completed`
 * (una lista di step parziale non dimostra niente) e la sua `conclusion` e il
 * suo `head_sha` devono coincidere con quelli del check-run selezionato. Se
 * divergono, i due oggetti descrivono esecuzioni diverse e vale il
 * fail-CLOSED.
 *
 * Pura: nessuna I/O. Il chiamante fetcha la lista dei job.
 *
 * @param {{checkRun: {conclusion?: string, head_sha?: string}|null,
 *          jobId: string|number,
 *          jobs: Array<{id?: number, status?: string, conclusion?: string,
 *                       head_sha?: string, steps?: Array<object>}>|null}} s
 * @returns {Array<{name?: string, conclusion?: string}>} gli step, o `[]`.
 */
export function currentAttemptJobSteps({ checkRun, jobId, jobs }) {
  if (!checkRun || !Array.isArray(jobs) || jobId === undefined || jobId === null) return [];
  const job = jobs.find((j) => j && String(j.id) === String(jobId));
  if (!job) return []; // attempt superato: il job non è più fra i correnti.
  if (job.status !== 'completed') return [];
  if (!checkRun.conclusion || job.conclusion !== checkRun.conclusion) return [];
  if (checkRun.head_sha && job.head_sha && job.head_sha !== checkRun.head_sha) return [];
  return Array.isArray(job.steps) ? job.steps : [];
}
