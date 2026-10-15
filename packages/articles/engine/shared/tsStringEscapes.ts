/**
 * Decoder for the string literals this package's readers lift out of the
 * corpus `.ts` locale files with a regex instead of a TypeScript parser.
 *
 * WHY THIS FILE EXISTS — the defect it removes
 * --------------------------------------------
 * `ogPagesPlugin` reads `blog.article.<id>.<field>` out of
 * `services/locales/blog-body/<locale>/<id>.ts` with
 *
 *     /'blog\.article\.([^']+)\.(body\d+|faq)'\s*:\s*'((?:[^'\\]|\\.)*)'/g
 *
 * and then has to turn the captured *source text* back into the string value
 * `tsc` would have produced. Until 2026-08-11 that was a chain of
 * `.replace()`:
 *
 *     value.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n')
 *          .replace(/\\r/g, '').replace(/\\t/g, ' ').replace(/\\\\/g, '\\')
 *
 * A chain cannot decode escapes, because each pass re-reads output the
 * previous pass produced and because `\\` — the escape that protects every
 * other one — is resolved LAST. Concretely, on the source text `\\t2`
 * (backslash, backslash, `t`, `2`, whose TypeScript value is the two
 * characters `\t` followed by `2`):
 *
 *   - `/\\t/` matches at offset 1 and yields `\` + ` ` + `2`
 *   - `/\\\\/` then finds no pair left to collapse
 *   - result: `\ 2` — a lone backslash followed by a space
 *
 * For the `faq` field that result is fed to `JSON.parse`, where `\ ` is an
 * invalid escape, so the parse throws and the article silently loses BOTH its
 * `FAQPage` JSON-LD and its visible accordion. The decoder was breaking data
 * that was written correctly: `\\t` in the source is exactly how a JSON tab
 * escape has to be spelled inside a single-quoted TypeScript literal.
 *
 * Measured on corpus `a08f37e8` (15,560 `.faq` fields, 47,036 body fields):
 *
 *   | class                                              | fields |
 *   |----------------------------------------------------|--------|
 *   | `.faq` that fail the engine's own read today        |    102 |
 *   | ...of which this decoder is the cause               |      7 |
 *   | ...corpus-side (unescaped `"` inside the JSON)      |     72 |
 *   | ...corpus-side (<2 pairs, or answers <= 20 chars)   |     23 |
 *   | `.faq` this change regresses                        |      0 |
 *
 * THE INVARIANT
 * -------------
 * One pass, left to right; every escape is consumed exactly once and its
 * output is never re-scanned. The contract is "produce what `tsc` would have
 * produced for this literal" — which is checkable, unlike the chain, whose
 * behaviour was an accident of ordering. Unknown escapes are passed through
 * verbatim (backslash included) rather than swallowed, so a sequence this
 * decoder does not model reaches `JSON.parse`/the renderer unchanged instead
 * of being silently corrupted.
 *
 * `\n` is the one escape whose target differs by call site, so it is a
 * parameter: body/FAQ text keeps real newlines (markdown structure —
 * headings, lists, FAQ blocks depend on them), while title/excerpt/imageAlt
 * flatten to a space because they are emitted into single-line meta tags.
 * That is the ONLY difference between the two former decoders, and making it
 * an argument is what collapses them into one implementation.
 *
 * Deliberately dependency-free: `packages/articles` may not import outside its
 * own folder (`tests/packages-articles-confinement.test.ts` proves it via the
 * TypeScript AST), and this file is also mirrored verbatim into the corpus repo
 * by `.github/workflows/mirror-articles-engine.yml`.
 */

/** `\uXXXX`, or any single character following a backslash. */
const TS_ESCAPE_RX = /\\(u[0-9a-fA-F]{4}|[\s\S])/g;

export interface DecodeTsStringOptions {
  /**
   * What `\n` becomes. `'\n'` preserves markdown structure (body/FAQ);
   * `' '` flattens for single-line meta values. Defaults to a real newline.
   */
  newlineAs?: string;
}

/**
 * Turn the raw source text of a single-quoted TypeScript string literal into
 * the value `tsc` would produce.
 *
 * @param value source text BETWEEN the quotes (no surrounding `'`)
 */
export function decodeTsStringEscapes(
  value: string,
  options: DecodeTsStringOptions = {},
): string {
  const newlineAs = options.newlineAs ?? '\n';
  return value.replace(TS_ESCAPE_RX, (whole, escape: string) => {
    switch (escape[0]) {
      case 'n':
        return newlineAs;
      // Dropped, not turned into a character: the corpus writes CRLF-free
      // text and the previous decoder deleted `\r` too. Kept identical so no
      // published byte moves for this escape.
      case 'r':
        return '';
      case 't':
        return ' ';
      case '\\':
        return '\\';
      case '\'':
        return '\'';
      case '"':
        return '"';
      case 'u': {
        // `[\s\S]` also matches a bare `u` that is NOT followed by 4 hex
        // digits (e.g. `\u` at the very end of a truncated value). Passing it
        // through keeps the byte rather than producing `NaN` -> U+0000.
        if (escape.length !== 5) return whole;
        const codeUnit = Number.parseInt(escape.slice(1), 16);
        return Number.isNaN(codeUnit) ? whole : String.fromCharCode(codeUnit);
      }
      // `\b`, `\f`, `\/`, `\0`, `\xNN`, … — not modelled, so handed on with
      // the backslash intact. For the `faq` field that means a genuine JSON
      // escape survives to `JSON.parse`, which is the component that actually
      // knows how to read it.
      default:
        return whole;
    }
  });
}

/**
 * Legacy double-escaped line breaks in BODY markdown — never in `faq`.
 *
 * Some corpus bodies carry `\\n` in the source, whose TypeScript value is the
 * two literal characters `\` + `n` rather than a line break. The old chain
 * decoder turned that into `\` + a real newline, which is why every heading
 * and bullet on those articles renders with a trailing backslash — live on
 * 2026-08-11, `/articoli-svizzera/zurich-finma-licenziamenti-previdenza/`:
 *
 *     <h3>In breve\</h3><ul><li>Zurich ha licenziato…\</li>
 *
 * Decoding faithfully alone would replace that stray backslash with a visible
 * literal `\n` AND collapse the list into the heading — correct with respect
 * to the source bytes, worse on the page. This repair recovers the author's
 * intent instead: the break is restored and the stray backslash is gone.
 *
 * Measured on corpus `a08f37e8`: 24 of 47,036 body fields change. For 20 of
 * them the new text is exactly the old text minus a stray backslash. The other
 * 4 carry a `\u00a0` that the chain left on the page as literal text — live
 * evidence on `/articoli-frontaliere/permesso-b-imposta-fonte-2026/`:
 *
 *     soglia dei 120\u00a0000 franchi
 *
 * No body field keeps a residual literal `\n` afterwards.
 *
 * MUST NOT be applied to `faq`: there a literal `\` + `n` is a well-formed
 * JSON escape that `JSON.parse` needs to see intact, and rewriting it to a
 * real newline would reintroduce precisely the "raw control character inside a
 * JSON string" failure this change exists to remove.
 */
export function repairLegacyDoubleEscapedBreaks(value: string): string {
  // `\\+` and not `\\`: a source value escaped one level too many (four
  // backslashes then `n`, decoding to two literal backslashes then `n`) would
  // otherwise have only its LAST backslash consumed, leaving a stray one
  // behind — the exact residue this function exists to remove. No such value
  // exists in the corpus at a08f37e8 (measured: zero), so this changes no
  // published byte today; it makes the repair total instead of leaving the
  // next writer bug half-cleaned.
  return value.replace(/\\+n/g, '\n');
}
