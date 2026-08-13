/**
 * Single-pass decoder for the raw source text of a single-quoted TypeScript
 * string literal, lifted out of a `.ts` locale file with a regex instead of
 * a real parser — the same capture shape used by `metaFieldRegex` in this
 * directory and by the body/meta readers in `staticPagesPlugin.ts` and
 * `backfill-ai-search-optimization.mjs`.
 *
 * WHY THIS EXISTS (issue #5632, follow-up of #5602)
 * --------------------------------------------------
 * All three of those call sites used to decode escapes with a CHAIN of
 * `.replace()`, e.g.:
 *
 *     value.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n')
 *          .replace(/\\r/g, '').replace(/\\t/g, ' ').replace(/\\\\/g, '\\')
 *
 * A chain cannot decode escapes correctly: each `.replace()` re-scans the
 * OUTPUT of the previous one, and `\\` — the escape that protects every
 * other escape from being misread — was always resolved LAST. Concretely,
 * on source text `\\n` (three characters: backslash, backslash, the letter
 * `n` — i.e. a literal backslash immediately followed by `n`, NOT a newline
 * escape): the `/\\n/` step matches the *second* backslash together with
 * the `n` and rewrites it to a newline before the final `\\` step ever
 * runs, so there is no longer a pair of backslashes left to collapse. The
 * chain produces a lone backslash followed by a newline instead of the two
 * literal characters `\` and `n`.
 *
 * This exact defect was already fixed once, independently, in
 * `packages/articles/engine/shared/tsStringEscapes.ts` (`decodeTsStringEscapes`,
 * #5602) — but that fix could not reach these three sites: they live outside
 * `packages/articles`, which `tests/packages-articles-confinement.test.ts`
 * proves via the TypeScript AST never imports anything beyond its own folder
 * (Node builtins and its own declared dependencies). Nothing stops the
 * REVERSE direction, but `tsStringEscapes.ts`'s own doc comment explains why
 * it stays dependency-free anyway (it is also mirrored verbatim into the
 * corpus repo). This file is the equivalent decoder for everything on the
 * outside, so all three copies decode through ONE implementation instead of
 * three independent (and, twice already, independently broken) ones.
 *
 * Both implementations share the same invariant: decode every escape in a
 * SINGLE left-to-right pass over the ORIGINAL text, so no already-decoded
 * output is ever re-scanned by a later step.
 *
 * A future fourth copy of the buggy chain shape is easy to find:
 *
 *     grep -rnE "replace\(/\\\\\\\\\\\\\\\\/g" --include='*.ts' --include='*.mjs' --include='*.js' .
 *
 * (matches any `.replace(/\\\\/g, ...)` — the backslash-collapsing step —
 * which every buggy chain has, and which no single-pass decoder needs).
 */

const ESCAPE_RX = /\\([\s\S])/g;

/**
 * Decode escape sequences out of raw TS string-literal source text.
 *
 * @param {string} value - the raw text captured BETWEEN the quotes.
 * @param {Record<string, string>} escapes - map from the escaped character
 *   (e.g. `"'"`, `'"'`, `'\\'`, `'n'`, `'r'`, `'t'`) to what it decodes to.
 *   An escaped character that is NOT a key of this map is passed through
 *   UNCHANGED (backslash + character kept intact) rather than silently
 *   dropped — matching what every one of the three original chains already
 *   did for any escape it didn't list, and letting a caller further down
 *   the pipeline (e.g. `JSON.parse` on a `faq` field) see it.
 * @returns {string} the decoded value.
 */
export function unescapeTsString(value, escapes) {
  return value.replace(ESCAPE_RX, (whole, ch) => (
    Object.prototype.hasOwnProperty.call(escapes, ch) ? escapes[ch] : whole
  ));
}

/**
 * The escape set shared by the body/meta readers: quotes and a literal
 * backslash always decode, `\r` drops and `\t` flattens to a space the same
 * way every original chain already did. `\n` is the one escape whose target
 * differs by call site — a real newline for body/markdown text (structure
 * depends on it) versus a single space for single-line meta fields — so it
 * is the caller-supplied parameter, mirroring `decodeTsStringEscapes`'s own
 * `newlineAs` option.
 *
 * @param {string} newlineAs - what `\n` decodes to.
 * @returns {Record<string, string>}
 */
export function tsStringEscapesWithNewlineAs(newlineAs) {
  return {
    "'": "'",
    '"': '"',
    '\\': '\\',
    n: newlineAs,
    r: '',
    t: ' ',
  };
}

/**
 * Repairs legacy DOUBLE-escaped line breaks left in body/markdown text by an
 * older corpus writer bug: the source spelled `\\n` (backslash, backslash,
 * `n`) where a single `\n` newline escape was intended. A faithful,
 * byte-correct decode of that source reproduces the literal two characters
 * `\` and `n` — correct with respect to the bytes, but it shows up on the
 * rendered page as a visible stray backslash next to a heading or list item.
 * This recovers the author's intent instead: any residual run of one-or-more
 * literal backslashes immediately followed by `n` collapses to a single
 * `replaceWith`.
 *
 * MUST run on the DECODED value (this module's `unescapeTsString` output),
 * never on raw source text. MUST NOT run on a `faq` field: there a literal
 * `\` + `n` is a well-formed JSON escape that `JSON.parse` needs to see
 * intact, and collapsing it would put a raw control character inside a JSON
 * string.
 *
 * Mirrors `repairLegacyDoubleEscapedBreaks` in
 * packages/articles/engine/shared/tsStringEscapes.ts (#5602), which is
 * hard-coded to a real newline because every caller there needs one. This
 * copy takes the target as a parameter because #5632 item 1 needs the SAME
 * repair for staticPagesPlugin.ts's body1/body2/body3 reader, whose `\n`
 * already flattens to a space — collapsing to a bare `'\n'` there would
 * reintroduce a real newline into what is meant to stay single-line prose.
 * Measured on this repo's corpus copy: 9 of 39,276 body1/2/3 fields carry
 * this damage.
 *
 * @param {string} value - already-decoded text (NOT raw source).
 * @param {string} replaceWith - what a residual backslash-run + `n` becomes.
 * @returns {string}
 */
export function repairLegacyDoubleEscapedBreaks(value, replaceWith = '\n') {
  return value.replace(/\\+n/g, replaceWith);
}
