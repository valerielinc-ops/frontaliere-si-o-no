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
 * in quel caso; il percorso related-only comune non cambia.
 */
export function selectMaxWorkers({ usedFullFallback, maxWorkers, maxWorkersFallback }) {
  if (usedFullFallback && maxWorkersFallback) return maxWorkersFallback;
  return maxWorkers;
}
