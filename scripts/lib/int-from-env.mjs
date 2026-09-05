/**
 * int-from-env.mjs — un intero da una variabile d'ambiente, o il default.
 *
 * ## IL DIFETTO CHE CHIUDE (issue #7344, follow-up di #7300)
 *
 * `Number(process.env.X || 8000)` non e' `Number(process.env.X) || 8000`: nel
 * primo l'alternativa sta DENTRO `Number`, quindi si applica solo quando la
 * variabile e' assente o vuota. Se la variabile c'e' ed e' spazzatura — un
 * `"8_000"`, un `"30s"`, uno spazio, un `${{ }}` non risolto che arriva come
 * `"$VAR"` — il risultato e' `NaN`, e `NaN` non lancia: si propaga.
 *
 * `NaN` come tetto significa nessun tetto (`n > NaN` e' falso, `n < NaN` pure);
 * come limite di concorrenza significa `Math.min(NaN, k) === NaN`; come
 * finestra temporale significa che nessuna scadenza scatta mai. In tutti e tre
 * i casi il codice CONTINUA e riporta successo. Nel repo il costrutto compare
 * 90 volte, su tetti di spesa (`HERE_MONTHLY_BUDGET`), cap di batch, deadline
 * di run e budget di quota: ogni occorrenza e' lo stesso guasto silenzioso in
 * un punto diverso della pipeline.
 *
 * ## LA REGOLA
 *
 * Un valore che non e' un intero finito NON e' un'opinione da propagare: e' un
 * errore di configurazione. Si cade sul default e lo si DICE (`::warning::`,
 * cosi' GitHub Actions lo mostra sullo Step Summary invece di seppellirlo).
 * Assente o vuoto e' invece legittimo — significa «non l'ho impostata» — e cade
 * sul default in silenzio.
 *
 * `Number('')` fa `0` e `Number.isFinite(0)` e' vero: e' per questo che la
 * stringa vuota va intercettata PRIMA, altrimenti un `X=''` (che in bash e' il
 * modo normale di non passare un valore) azzererebbe un tetto invece di
 * lasciarlo al default.
 */

/**
 * @param {string} name nome della variabile d'ambiente
 * @param {number} fallback valore da usare se assente, vuota o non intera
 * @param {{ env?: Record<string, string|undefined>, warn?: (msg: string) => void }} [opts]
 * @returns {number}
 */
export function intFromEnv(name, fallback, { env = process.env, warn = console.warn } = {}) {
  const raw = env?.[name];
  // Assente o solo spazi: la variabile non e' stata impostata. Nessun avviso.
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;

  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) {
    warn(
      `::warning::[int-from-env] ${name}=${JSON.stringify(String(raw))} non e' un intero — `
      + `uso il default ${fallback}. Un valore non numerico qui diventava NaN, e NaN non lancia: `
      + 'si propagava in tetti, limiti di concorrenza e finestre temporali senza rendere rosso niente.',
    );
    return fallback;
  }
  return n;
}

export default intFromEnv;
