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
 * da solo). La selezione "ultimo COMPLETATO per completed_at" è invariante
 * all'ordine API e ai duplicati: vince il verdetto finito più fresco per il
 * codice all'HEAD.
 *
 * I run in-progress/queued (senza `completed_at`) sono ignorati di proposito:
 * un dispatch manuale appeso non deve bloccare il merge per sempre. Se NESSUN
 * vitest è ancora concluso ritorna '' (gate in attesa) — preserva l'invariante
 * #1454 "niente merge su pending/missing".
 */
import { VITEST_CHECK_NAME, VITEST_SHARD_NAME_RE } from './constants.mjs';

/**
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 *   L'array `.check_runs` della GitHub check-runs API.
 * @returns {string} La conclusion del check-run vitest COMPLETATO più recente
 *   (per `completed_at`), o '' se nessuno è ancora concluso/presente.
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
 * COMPLETATO per `completed_at`), estratta per non duplicare il filtro fragile.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 * @returns {{name?: string, status?: string, conclusion?: string, completed_at?: string}|null}
 */
export function latestCompletedVitestRun(checkRuns) {
  if (!Array.isArray(checkRuns)) return null;
  const completed = checkRuns
    .filter(
      (c) =>
        c &&
        c.name === VITEST_CHECK_NAME &&
        c.status === 'completed' &&
        typeof c.completed_at === 'string' &&
        c.completed_at,
    )
    .sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at));
  return completed[completed.length - 1] || null;
}

/**
 * Il `failure` del check vitest AGGREGATORE sull'HEAD è una cancellazione
 * TRANSIENT (shard cancellati da concurrency) e NON un test rotto?
 *
 * Perché serve (#2438): `tests.yml` ha N shard (`vitest shard i/4`) + un job
 * aggregatore `vitest (unit + integration)` che fa `exit 1` se
 * `needs.vitest-shard.result != success`. Una cancellazione di massa
 * (`cancel-in-progress` durante un'ondata di rebase/push su main) lascia gli
 * shard `cancelled` → l'aggregatore COLLASSA `cancelled` in `failure` (RED),
 * indistinguibile da un fail reale al solo aggregatore. Una PR LGTM'd,
 * non-collision, behind=0 con questo `failure` transient veniva SKIPPATA da
 * pr-autorebase (il ramo behind=0 ri-dispatcha solo se il check vitest è ASSENTE,
 * non se è `failure`) e BLOCCATA da auto-merge-eval (gate `success`) → ferma
 * finché un evento esterno non ri-dispatcha i test.
 *
 * Riapriamo gli shard sottostanti per ricostruire l'informazione che
 * l'aggregatore ha perso: la failure è transient SOLO se TUTTI gli shard sono
 * `completed`, NESSUNO è una failure reale (`failure`/`timed_out`/
 * `action_required`/`stale`), e ALMENO uno è `cancelled`. Un solo shard
 * `failure` → fail reale, NON ri-eseguire (AGENTS #5: «test fail = right finché
 * non provato contrario»; frugalità CI).
 *
 * Guardie anti-spuria:
 *  - L'aggregatore COMPLETATO più recente dev'essere `failure` (riusa
 *    `latestCompletedVitestConclusion`): se l'ultimo run è già `success` non c'è
 *    nulla da sanare.
 *  - NESSUN check-run vitest (aggregatore o shard) dev'essere in-progress/queued:
 *    un run fresco già in coda risolverà da sé → non ri-dispatchare (il caso che
 *    #2438 lascia scoperto è ESATTAMENTE "cancelled→failure SENZA run fresco
 *    pendente"). Questo gestisce anche i duplicati su SHA immutabile: se esiste
 *    un set di shard più nuovo ancora in corso, attendiamo invece di sommare.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, completed_at?: string}>} checkRuns
 *   L'array `.check_runs` della GitHub check-runs API per l'HEAD SHA.
 * @returns {boolean} true SOLO se il `failure` aggregato è una cancellazione
 *   transient sicura da ri-dispatchare (heal); false su fail reale, run fresco
 *   pendente, aggregatore non-`failure`, o input non valido.
 */
export function vitestFailureIsTransientCancellation(checkRuns) {
  if (!Array.isArray(checkRuns)) return false;

  const vitestRuns = checkRuns.filter(
    (c) =>
      c &&
      (c.name === VITEST_CHECK_NAME || VITEST_SHARD_NAME_RE.test(c.name || '')),
  );
  if (vitestRuns.length === 0) return false;

  // Run fresco pendente (aggregatore o shard non concluso) → attendi, non sanare.
  if (vitestRuns.some((c) => c.status !== 'completed')) return false;

  // L'esito aggregato corrente dev'essere proprio un failure da sanare.
  if (latestCompletedVitestConclusion(checkRuns) !== 'failure') return false;

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
 * Il commento storico di `vitestFailureIsTransientCancellation` afferma «un
 * vitest=failure sull'HEAD è sempre un fail reale». Sul merge ref quella
 * premessa è FALSA, e su di essa poggiava l'intera catena di recupero, che
 * diventa uno stato ASSORBENTE:
 *   1. `pr-review-loop.yml` gira solo su `workflow_run.conclusion == 'success'`
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
 * `vitestFailureIsTransientCancellation`).
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
