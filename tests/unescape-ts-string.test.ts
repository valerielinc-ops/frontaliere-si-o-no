/**
 * Regression suite for issue #5632 (follow-up of #5602): three call sites
 * still decoded TS string-literal escapes with a CHAIN of `.replace()`,
 * which resolves `\\` — the escape that protects every other one — LAST:
 *
 *     value.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ...)
 *          .replace(/\\r/g, '').replace(/\\t/g, ...).replace(/\\\\/g, '\\')
 *
 * On source text `\\n` (backslash, backslash, the letter `n` — i.e. a
 * literal backslash immediately followed by `n`, NOT a newline escape), the
 * `/\\n/` step matches the SECOND backslash together with the `n` and
 * rewrites it to a newline before the `\\` step ever runs, so there is no
 * longer a pair of backslashes left to collapse. The chain produces a lone
 * backslash + a newline instead of the two literal characters `\` and `n`.
 *
 * `scripts/lib/unescape-ts-string.mjs` fixes this with a single left-to-right
 * pass (mirroring the independent fix already shipped for
 * `packages/articles/engine/shared/tsStringEscapes.ts` in #5602 — see that
 * file's own doc comment and `tests/articles-engine-ts-string-escapes.test.ts`
 * for the reference invariant), and all three sites now call through it
 * instead of repeating the chain a third and fourth time.
 *
 * `build-plugins/staticPagesPlugin.ts` cannot be imported here without
 * materializing `data/`/`public/` (~12 files pulled in at module scope by
 * every build-plugin — the same trap `tests/noindex-builders.test.ts`
 * documents), so its wiring is verified by scanning its SOURCE TEXT instead
 * of importing the module — see the last `describe` block.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  unescapeTsString,
  tsStringEscapesWithNewlineAs,
  repairLegacyDoubleEscapedBreaks,
} from '../scripts/lib/unescape-ts-string.mjs';
import { unescapeTsValue } from '../scripts/lib/meta-field-regex.mjs';

const ROOT = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

// The two configurations the three sites actually use.
const BODY_ESCAPES = tsStringEscapesWithNewlineAs('\n'); // backfill-ai-search-optimization.mjs
const META_ESCAPES = tsStringEscapesWithNewlineAs(' '); // staticPagesPlugin.ts

describe('unescapeTsString — the three sequences that discriminate a one-pass decoder', () => {
  it('does not turn a literal backslash followed by n into a newline', () => {
    // Source `\\n` (backslash, backslash, n) -> value must be the two
    // characters `\` and `n`, never a real newline. This is the exact
    // defect: the old chain produced `\` + an actual newline here.
    const decoded = unescapeTsString(String.raw`x\\ny`, BODY_ESCAPES);
    expect(decoded).toBe(String.raw`x\ny`);
    expect(decoded).not.toContain('\n');
  });

  it('collapses a double backslash at the end of the string to a single backslash', () => {
    const decoded = unescapeTsString(String.raw`tail\\`, BODY_ESCAPES);
    expect(decoded).toBe('tail\\');
    expect(decoded.length).toBe(5); // "tail" + one backslash, not two
  });

  it('decodes a combination of escaped single and double quotes correctly', () => {
    const decoded = unescapeTsString(String.raw`he said \"hi\" and it's \'fine\'`, BODY_ESCAPES);
    expect(decoded).toBe(`he said "hi" and it's 'fine'`);
  });
});

describe('unescapeTsString — round-trips a JSON escape the chain could not', () => {
  it('keeps a correctly-escaped JSON newline intact, byte for byte', () => {
    // Source `\\n` is how a JSON newline escape HAS to be spelled inside a
    // single-quoted TS literal; its value is the two characters `\` and `n`.
    const decoded = unescapeTsString(String.raw`line1\\nline2`, BODY_ESCAPES);
    expect(decoded).toBe('line1\\nline2');
    expect(decoded).not.toContain('\n');
    expect(JSON.parse(`"${decoded}"`)).toBe('line1\nline2');
  });

  it('resolves the backslash escape before the escape it protects, for every JSON letter', () => {
    for (const letter of ['n', 't', 'r']) {
      const sourceText = 'a\\\\' + letter + 'b';
      const decoded = unescapeTsString(sourceText, BODY_ESCAPES);
      expect(decoded).toBe('a\\' + letter + 'b');
      expect(() => JSON.parse('"' + decoded + '"')).not.toThrow();
    }
  });
});

describe('unescapeTsString — per-site newline configuration', () => {
  it('flattens \\n to a space for the single-line meta variant (staticPagesPlugin.ts)', () => {
    expect(unescapeTsString(String.raw`a\nb`, META_ESCAPES)).toBe('a b');
    // The bug must stay fixed regardless of which newline target is chosen.
    expect(unescapeTsString(String.raw`x\\ny`, META_ESCAPES)).toBe(String.raw`x\ny`);
  });

  it('keeps \\n as a real newline for the body variant (backfill-ai-search-optimization.mjs)', () => {
    expect(unescapeTsString(String.raw`a\nb`, BODY_ESCAPES)).toBe('a\nb');
  });
});

describe('repairLegacyDoubleEscapedBreaks — space variant added for #5632 item 1', () => {
  // packages/articles/engine/shared/tsStringEscapes.ts's version of this
  // function is hard-coded to a real newline. staticPagesPlugin.ts's `\n`
  // already flattens to a space, so reusing that version unmodified would
  // reintroduce a real newline into single-line text — this is why the
  // shared copy here takes the replacement as a parameter.
  it('collapses a residual literal backslash-n to a single space, not a stray backslash', () => {
    const decoded = unescapeTsString(String.raw`## In breve\\nZurich ha`, META_ESCAPES);
    // Faithful decode alone leaves the stray backslash visible:
    expect(decoded).toContain('\\n');
    const repaired = repairLegacyDoubleEscapedBreaks(decoded, ' ');
    expect(repaired).not.toContain('\\');
    expect(repaired).toBe('## In breve Zurich ha');
  });

  it('defaults to a real newline, matching the #5602 original', () => {
    expect(repairLegacyDoubleEscapedBreaks(String.raw`## In breve\nZurich ha`)).toBe('## In breve\nZurich ha');
  });

  it('must not run on JSON-bound text — documented at the call site, not enforced here', () => {
    // staticPagesPlugin.ts only ever calls this on body1/body2/body3
    // (never on a `.faq` field), so there is nothing to assert at the
    // function level; this test exists so the constraint has a home if a
    // future caller is added.
    const faqJson = String.raw`[{"q":"a","a":"line1\nline2"}]`;
    expect(() => JSON.parse(faqJson)).not.toThrow();
    expect(() => JSON.parse(repairLegacyDoubleEscapedBreaks(faqJson))).toThrow();
  });
});

describe('unescapeTsValue (scripts/lib/meta-field-regex.mjs) — narrower scope, same fix', () => {
  // This function never touches \n/\r/\t (title/excerpt fields are
  // single-line) — that scope is unchanged by #5632. Only the ordering of
  // the escapes it DOES handle (', ", \\) was buggy.
  it('leaves an unrelated backslash-n sequence untouched, same as before', () => {
    expect(unescapeTsValue(String.raw`x\\ny`)).toBe(String.raw`x\ny`);
  });

  it('fixes the quote/backslash ordering bug', () => {
    // Source: two backslashes (-> one literal backslash) followed by an
    // escaped apostrophe. A chain that resolves `\\` last can, depending on
    // input shape, hand the apostrophe rule the wrong pairing.
    expect(unescapeTsValue(String.raw`l\'impatto \\ e "quotato" \"cosi\"`)).toBe(
      `l'impatto \\ e "quotato" "cosi"`,
    );
  });
});

/**
 * COMANDO — the grep that finds a future fourth copy of the buggy chain
 * shape anywhere in the repo (see PR body for the full command and what it
 * found beyond these three sites). Scoped here to the three sites #5632
 * fixes: a full repo-wide instance of this assertion is a much larger,
 * separately-tracked cleanup (PR body, "Non implementato (ancora)").
 */
describe('wiring — the three ratified #5632 sites call the shared decoder', () => {
  const SITES = [
    'build-plugins/staticPagesPlugin.ts',
    'scripts/lib/meta-field-regex.mjs',
    'scripts/backfill-ai-search-optimization.mjs',
  ] as const;

  // Built from character codes rather than a string literal so the count of
  // backslashes is never in question: the SOURCE TEXT of every buggy chain
  // contains the four characters `/`, `\`, `\`, `\`, `\`, `/`, `g` in a row —
  // the backslash-collapsing step, always a discrete `.replace()` call
  // because a chain cannot fold it into the same pass as the other escapes.
  // A correct single-pass decoder never needs this as a separate call.
  const BACKSLASH = String.fromCharCode(92);
  const BUGGY_CHAIN_SIGNATURE = `.replace(/${BACKSLASH}${BACKSLASH}${BACKSLASH}${BACKSLASH}/g`;

  it('the signature itself matches the pre-fix source (sanity check for the check)', () => {
    // scripts/lib/meta-field-regex.mjs's line, verbatim, before this PR:
    //   return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const preFixLine = `  return s.replace(/${BACKSLASH}'/g, "'").replace(/${BACKSLASH}"/g, '"').replace(/${BACKSLASH}${BACKSLASH}${BACKSLASH}${BACKSLASH}/g, '${BACKSLASH}');`;
    expect(preFixLine.includes(BUGGY_CHAIN_SIGNATURE)).toBe(true);
  });

  for (const site of SITES) {
    it(`${site} no longer contains the buggy replace chain`, () => {
      const src = read(site);
      expect(src.includes(BUGGY_CHAIN_SIGNATURE)).toBe(false);
    });

    it(`${site} imports the shared decoder`, () => {
      const src = read(site);
      expect(src).toMatch(/unescape-ts-string\.mjs/);
    });
  }
});
