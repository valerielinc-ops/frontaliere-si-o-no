/**
 * Lettura condivisa del report del reporter `json` di Vitest: quale FILE di
 * test è rosso, e quanti lo sono.
 *
 * Perché un modulo: il report ha due contatori che sembrano file e non lo sono.
 * `numTotalTestSuites`/`numFailedTestSuites` vengono da `getSuites(files)`
 * (`@vitest/runner`), cioè il file PIÙ ogni blocco `describe` annidato: un solo
 * test rosso dentro un `describe` fa due suite rosse. Misurato su un report
 * reale di tre file (uno verde con quattro `describe`, due rossi senza):
 * `numTotalTestSuites` = 7, file = 3. L'unità «file» è `testResults`, una voce
 * per file. `scripts/ci/full-suite-red-files.mjs` e
 * `scripts/ci/report-vitest-failure.mjs` leggono lo stesso report per dire
 * quanti file sono rossi: la regola sta qui una volta sola.
 */

// Stati di file che non sono un rosso. Un file senza stato leggibile conta
// rosso: per un conteggio di file rossi il default sicuro è non nasconderlo.
const OK_FILE_STATUSES = new Set(['passed', 'skipped', 'pending', 'todo']);

/**
 * Un file è rosso quando il suo `status` non è verde/saltato, oppure quando
 * contiene almeno un'asserzione `failed`. Il primo caso copre il file caduto in
 * raccolta (import rotto, errore in `beforeAll`): nessuna asserzione, solo
 * `message`. Il secondo copre un report in cui lo stato del file e quello dei
 * test divergono.
 */
export function isRedTestFileResult(result) {
  const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : [];
  if (assertions.some((assertion) => assertion?.status === 'failed')) return true;
  return !OK_FILE_STATUSES.has(String(result?.status ?? ''));
}

/** Numero di file rossi del report; 0 se il report non ha `testResults`. */
export function countRedTestFiles(report) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  return results.filter(isRedTestFileResult).length;
}
