/**
 * false-positive-declaration.mjs — negation-aware AGENTS.md #6 escape-hatch
 * matcher for the "declared false positive" language ("falso positivo — solo
 * lessicalmente simile ma semanticamente diverso" / "false positive — not the
 * same bug class").
 *
 * Why this lives in one module (#3367): `sibling-check-gate.mjs` and
 * `harvest-agent-lessons.mjs` each carried a byte-identical copy of this regex
 * (`FALSE_POSITIVE_RE` / `SIBLING_CLASS_FALSE_POSITIVE_RE`), kept in sync by a
 * docstring promise only ("mirrors X — keep in sync if the regex changes
 * there"). PR #3367's own review found the bug in one copy; a promise-only
 * "keep in sync" is exactly the drift AGENTS.md non-negotiable #6 forbids —
 * centralizing makes the drift impossible by construction.
 *
 * The bug: naive substring matching reads a REJECTED declaration as an
 * AFFIRMATIVE one. "non è un falso positivo, va sistemato in follow-up" still
 * contains the substring "falso positivo" — matching it verbatim bypasses the
 * gate / drops the harvester bucket entry on exactly the line where the author
 * says the opposite. `NEGATION_LOOKBEHIND` rejects the match when a negation
 * ("non è/sono/erano (un/una) " or "not (a) ") immediately precedes the
 * trigger phrase.
 *
 * `non è (?:lo stesso|la stessa) ...` / `not the same ...` are NOT guarded —
 * negation is part of their correct affirmative meaning ("is NOT the same
 * construct" = a genuine false-positive declaration, not a negation of one).
 */
/**
 * Every shape of "this is NOT a false positive" that must NOT be read as a
 * declaration. Measured on #9134: the first two arms alone let four negations
 * through, each one closing a bullet whose author said the opposite —
 * `isn't a false positive`, `aren't false positive`, `wasn't a false positive`
 * and `never a false positive` all matched, and so did the ASCII Italian
 * `non e un falso positivo` (the arm required the accented `è`).
 *
 * Contractions are the load-bearing case: `isn't` does not contain the word
 * `not`, so `\bnot\s+` cannot see it. Keep this list and its test in
 * tests/followup-bullet-state-classes.test.ts in step.
 */
export const NEGATION_LOOKBEHIND =
  // Italian: "non è/sono/erano/e (un|una) ". The unaccented `e` is last so the
  // longer alternatives win first; an ASCII-only body still means the negation.
  '(?<!\\bnon\\s+(?:è|sono|erano|e)\\s+(?:un\\s+|una\\s+)?)'
  // English, uncontracted: "not (a) ".
  + '(?<!\\bnot\\s+(?:a\\s+)?)'
  // English, contracted: "isn't/aren't/wasn't/weren't (a) ", straight or curly
  // apostrophe — neither spelling contains the token `not`.
  + "(?<!\\b(?:is|are|was|were)n['’]t\\s+(?:a\\s+)?)"
  // English, adverbial: "never (a) ".
  + '(?<!\\bnever\\s+(?:a\\s+)?)';

export const FALSE_POSITIVE_DECLARATION_RE = new RegExp(
  `${NEGATION_LOOKBEHIND}falso positivo` +
    `|${NEGATION_LOOKBEHIND}false positive` +
    `|${NEGATION_LOOKBEHIND}solo lessicalmente simil\\w*` +
    `|lessicalmente simil\\w*(?:[^.]{0,40})semanticamente divers\\w*` +
    `|${NEGATION_LOOKBEHIND}semanticamente divers\\w*` +
    `|non è (?:lo stesso|la stessa) (?:anti-?pattern|costrutto|classe)` +
    `|not the same (?:anti-?pattern|construct|bug class)`,
  'i',
);
