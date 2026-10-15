/**
 * Pure contract shared by the Codex fallback callers.
 *
 * Keep this module free of CLI entrypoints and runtime provider logic: it is
 * also imported by code reachable from the Vite config bundle.
 */

/** Modello e reasoning effort vincolanti per l'esecuzione di fallback. */
export const CODEX_FALLBACK_MODEL = 'gpt-5.6-luna';
export const CODEX_FALLBACK_EFFORT = 'max';

/**
 * Effort ammessi per tier. Il default resta `max` per ogni chiamante che non
 * lo sceglie; la review in `tests.yml` passa `high` ai tier minimal,
 * incremental e normal e tiene `max` per high/high-mega. Il contratto resta
 * chiuso: un valore fuori da questo insieme invalida l'evidenza.
 */
export const CODEX_ALLOWED_EFFORTS = Object.freeze(['high', 'max']);

export function isAllowedCodexEffort(value) {
  return CODEX_ALLOWED_EFFORTS.includes(value);
}
