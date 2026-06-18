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
  if (!Array.isArray(checkRuns)) return '';
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
  const last = completed[completed.length - 1];
  return last ? last.conclusion || '' : '';
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
