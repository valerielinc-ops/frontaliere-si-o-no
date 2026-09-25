/**
 * selectMaxWorkers — sceglie il valore di --maxWorkers da passare a Vitest.
 *
 * VITEST_MAX_WORKERS è tarato sul caso comune di run-related-tests.mjs: un
 * grafo related piccolo (poche decine di file), dove il cap a 1 worker basta
 * a contenere la memoria della costruzione del grafo di Vitest 4 (vedi
 * tests.yml). Quando il selettore non trova nessun edge di import statico e
 * ripiega sull'intera suite (~1900 file indipendenti), lo stesso cap li
 * serializza su un solo core — un profilo di costo diverso, non un grafo
 * grande ma tanti file piccoli. VITEST_MAX_WORKERS_FALLBACK si applica SOLO
 * in quel caso.
 *
 * Per una selezione related grande il cap a 1 serializza invece file
 * indipendenti. La soglia di 100 file prende il caso osservato da 103 file,
 * senza cambiare i diff piccoli (1 e 38 file nel campione): porta il cap
 * ordinario da 1 a 2. Due è intenzionale: il timing reale di una selezione da
 * 106 file ha un test singolo da 213s, quindi un terzo worker non riduce il
 * collo di bottiglia ma aumenta la contesa/memoria su `pool: forks`.
 */
const LARGE_RELATED_TEST_COUNT = 100;
const LARGE_RELATED_WORKERS = '2';

export function selectMaxWorkers({
  usedFullFallback,
  maxWorkers,
  maxWorkersFallback,
  relatedTestCount = 0,
}) {
  if (usedFullFallback && maxWorkersFallback) return maxWorkersFallback;
  if (!usedFullFallback
    && maxWorkers === '1'
    && Number.isInteger(relatedTestCount)
    && relatedTestCount >= LARGE_RELATED_TEST_COUNT) {
    return LARGE_RELATED_WORKERS;
  }
  return maxWorkers;
}
