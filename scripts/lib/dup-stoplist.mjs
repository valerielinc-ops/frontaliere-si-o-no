/**
 * Duplicate-detection domain stoplist.
 *
 * Canonical tokens (post SYNONYM_GROUPS in it-text-similarity.mjs) that
 * recur in ≥40 % of existing frontaliere article IDs. They are stripped
 * from both sides of similarity comparisons so the resulting score
 * reflects DISTINCTIVE content overlap, not the shared domain vocabulary
 * every frontaliere article has by construction.
 *
 * 2026-05-11 measurement (live run 25690785422): without filtering,
 * 81/92 of `topic già coperto` drops hit the threshold at exactly 0.75 —
 * many were fresh news stories blocked only because they shared
 * 3 of 4 structural tokens (frontaliere, svizzera, disoccup, ticino)
 * with an existing ID. At ~2.4k articles in the corpus the gate had
 * saturated. The stoplist restores discriminative signal.
 */

export const DOMAIN_DUP_STOPLIST = new Set([
  // Canonical synonym outputs
  'frontaliere', 'svizzera', 'italia', 'ticino',
  'lavoro', 'permesso', 'imposta', 'pensione',
  'cambio', 'costo',
  // Stems the Italian stemmer can produce for the above.
  // `tic` comes from `ticino` (stem strips `ino` suffix), confirmed
  // against tokenizeIt() on representative IDs. Without it, every
  // ID containing `-ticino` keeps a 3-char structural token in the
  // distinctive set and falsely lifts similarity.
  'frontalier', 'svizzer', 'italian', 'lavor', 'tic',
  // Generic news markers
  'nuovo', 'nuovi', 'nuova', 'nuove',
  'ticinese', 'ticinesi',
]);

export function filterDistinctive(tokens) {
  return tokens.filter(t => !DOMAIN_DUP_STOPLIST.has(t));
}
