// Allarme «la coda di ritraduzione non drena».
//
// Modulo SENZA import — nemmeno relativi. Lo consuma lo script inline
// `node --input-type=module` dentro `job-description-locale-audit.yml`, e
// importare da li' `audit-job-description-locale.mjs` tirerebbe dentro il
// rilevatore di lingua e la popolazione dei locale solo per fare un confronto
// fra due numeri. AGENTS.md documenta la classe di guasto (`Script Node prima
// di npm ci`): un import npm in una libreria condivisa uccide in silenzio i
// workflow che la caricano prima dell'install.

/**
 * Legge un conteggio o una soglia senza accettare le coercizioni che `Number()`
 * lascia passare: booleani, stringa vuota, frazioni, infiniti. Tutto il resto è
 * `null`, cioè «non lo so» — mai un numero.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseNonNegativeInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * La coda è ferma? Separa «misurato e sotto soglia» da «non misurabile», che il
 * workflow confondeva.
 *
 * L'espressione inline che questo sostituisce era
 * `Number(q.staleSourceCopyJobs || 0) > queueStaleAlert`. Un campo mancante o
 * illeggibile diventava `0`, `0 > 100` è falso, e l'audit riportava una coda
 * sana: un falso negativo silenzioso su un allarme, prodotto dall'unico input
 * che l'allarme esiste per sorvegliare. Un conteggio illeggibile non è una
 * buona notizia, quindi `valid: false` torna con `queueStuck: true` e il report
 * lo dice invece di tacere.
 *
 * @param {unknown} staleSourceCopyJobs
 * @param {unknown} staleAlertThreshold
 * @returns {{ valid: boolean, queueStuck: boolean, count: number | null, threshold: number | null }}
 */
export function evaluateQueueAlarm(staleSourceCopyJobs, staleAlertThreshold) {
  const count = parseNonNegativeInteger(staleSourceCopyJobs);
  const threshold = parseNonNegativeInteger(staleAlertThreshold);
  if (count === null || threshold === null) {
    return { valid: false, queueStuck: true, count, threshold };
  }
  return { valid: true, queueStuck: count > threshold, count, threshold };
}
