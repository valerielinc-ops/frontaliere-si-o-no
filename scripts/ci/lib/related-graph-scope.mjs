/**
 * Quali file tracciati entrano nel grafo di import di `run-related-tests.mjs`.
 *
 * Vive qui, e non nel runner, perche' ha DUE consumatori che devono restare
 * d'accordo: il runner, che su questo insieme costruisce il grafo, e il guard
 * di `tests/ci-vitest-check-name.test.ts`, che pretende che lo sparse-checkout
 * del job `vitest:` li materializzi tutti. Se le due liste divergessero, il
 * guard direbbe verde su un insieme che il runner non usa — e il contatore
 * `unreadable` del runner tornerebbe > 0 senza che nulla lo segnali,
 * rendendo `Assemble + migrate` non piu' saltabile su NESSUNA PR.
 */

/** Estensioni che l'analisi degli import sa leggere. */
export const GRAPH_SOURCE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;

/** Bucket di dato generato: non sono sorgenti, non hanno edge di import. */
export const GRAPH_IGNORED_RE = /^(?:data|public|reports|docs|_newsletter_variants|node_modules)\//;

/** Radici applicative di cui il grafo segue l'albero intero. */
export const GRAPH_PROJECT_RE = /^(?:tests|scripts\/(?:ci|lib|dev|evals)\/|services|components|hooks|server|infra|build-plugins|functions|packages\/[^/]+\/(?:engine|src|tests)\/)/;

/**
 * True quando il file tracciato `file` (path POSIX relativo alla root, gia'
 * normalizzato) fa parte del grafo. `.github/` e' escluso qui perche' entra
 * come ASSET, non come sorgente — vedi `trackedAssets()` nel runner.
 */
export function isGraphSourceFile(file) {
  if (file.startsWith('.github/')) return false;
  if (GRAPH_IGNORED_RE.test(file)) return false;
  if (!GRAPH_SOURCE_RE.test(file)) return false;
  return !file.includes('/')
    || GRAPH_PROJECT_RE.test(file)
    || /^scripts\/[^/]+$/.test(file)
    || /^packages\/[^/]+\/[^/]+$/.test(file);
}
