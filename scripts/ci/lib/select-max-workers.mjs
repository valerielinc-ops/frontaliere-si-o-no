/**
 * selectMaxWorkers — sceglie il valore di --maxWorkers da passare a Vitest.
 *
 * VITEST_MAX_WORKERS è tarato sul caso comune di run-related-tests.mjs: un
 * grafo related piccolo (poche decine di file), dove il cap a 1 worker basta.
 * Quando il selettore non trova nessun edge di import statico e
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
 * Rimisurato il 2026-09-30 (banco della PR #10503, 948 file, `tsc` accanto):
 * 2 worker ~560 s contro ~1.144 s a 1; 3 e 4 worker un altro 15-20% ma non in
 * modo coerente fra i giri e rallentando `tsc` fino a 257 s. Resta 2.
 *
 * Questi valori arrivano davvero a Vitest solo attraverso vitestChildEnv (sotto):
 * prima del 2026-09-30 la variabile ereditata li annullava tutti a 1.
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

/**
 * vitestChildEnv — l'env con cui run-related-tests.mjs avvia Vitest.
 *
 * Vitest legge da sé `process.env.VITEST_MAX_WORKERS` e lo applica DOPO le
 * opzioni della riga di comando (in `resolveConfig`: `if
 * (process.env.VITEST_MAX_WORKERS) resolved.maxWorkers = …`). `tests.yml`
 * imposta `VITEST_MAX_WORKERS: 1` come INPUT di selectMaxWorkers, e il figlio
 * lo ereditava: il `--maxWorkers` scelto qui veniva sovrascritto a 1 in ogni
 * caso. Misurato il 2026-09-30 sui 76 artifact `shard-timing-related` di una
 * mattina di PR: concorrenza massima 1 in tutte, comprese le 38 con 100 o più
 * file, per cui i 2 worker di #9026 e i 3 del fallback a suite intera non
 * sono mai stati applicati. Allineare la variabile al valore scelto rende
 * l'override di Vitest concorde con la decisione invece di annullarla; senza
 * un valore scelto la variabile viene tolta e vale il default di Vitest.
 */
export function vitestChildEnv(env, maxWorkers) {
  const child = { ...env };
  if (maxWorkers) child.VITEST_MAX_WORKERS = String(maxWorkers);
  else delete child.VITEST_MAX_WORKERS;
  return child;
}
