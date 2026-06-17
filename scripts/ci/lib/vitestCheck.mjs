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
import { VITEST_CHECK_NAME } from './constants.mjs';

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
