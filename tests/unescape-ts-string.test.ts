/**
 * Regression suite for issue #5632 (follow-up of #5602) and #5780 (12 more
 * copies of the same defect, found by grepping the whole repo). All fifteen
 * call sites decoded TS string-literal escapes with a CHAIN of `.replace()`,
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
 * for the reference invariant), and all fifteen sites now call through it
 * instead of repeating the chain a fourth, fifth, ... sixteenth time.
 *
 * `build-plugins/staticPagesPlugin.ts`, `build-plugins/pdfWhitepapersPlugin.ts`
 * and the other `.test.ts` sites cannot be imported here without materializing
 * `data/`/`public/` (~12 files pulled in at module scope by every
 * build-plugin, or by `scripts/create-article.mjs`'s own transitive
 * imports — the same trap `tests/noindex-builders.test.ts` documents), so
 * their wiring is verified by scanning SOURCE TEXT instead of importing the
 * module — see the `describe('wiring — ...')` blocks below, including the
 * repo-wide scan that closes this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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
 * COMANDO — the grep that finds a future copy of the buggy chain shape
 * anywhere in the repo (see PR body for the full command). Issue #5780
 * ran it repo-wide and found 12 further copies beyond the three #5632
 * fixed here, all now converted too — see SITES below and the repo-wide
 * scan in the next `describe` block, which is the "separately-tracked
 * cleanup" this comment used to defer.
 */

// Built from character codes rather than a string literal so the count of
// backslashes is never in question: the SOURCE TEXT of every buggy chain
// contains the four characters `/`, `\`, `\`, `\`, `\`, `/`, `g` in a row —
// the backslash-collapsing step, always a discrete `.replace()` call
// because a chain cannot fold it into the same pass as the other escapes.
// A correct single-pass decoder never needs this as a separate call.
//
// Module-scoped (not inside a single `describe`) because both the
// enumerated-SITES check below AND the repo-wide scan further down need
// the exact same signature.
const BACKSLASH = String.fromCharCode(92);
const BUGGY_CHAIN_SIGNATURE = `.replace(/${BACKSLASH}${BACKSLASH}${BACKSLASH}${BACKSLASH}/g`;

describe('wiring — the fifteen ratified #5632/#5780 sites call the shared decoder', () => {
  const SITES = [
    // #5632
    'build-plugins/staticPagesPlugin.ts',
    'scripts/lib/meta-field-regex.mjs',
    'scripts/backfill-ai-search-optimization.mjs',
    // #5780 — same defect, 12 further sites (15 occurrences: two chains
    // each in batch-add-faq-to-articles.mjs and three each in
    // repair-truncated-article-titles.mjs, both listed once here since the
    // check reads the whole file, not a single line).
    'build-plugins/pdfWhitepapersPlugin.ts',
    'tests/faq-coverage.test.ts',
    'tests/it-microcopy-guard.test.ts',
    'tests/google-news-compliance.test.ts',
    'tests/blog-headline-validation.test.ts',
    'scripts/batch-add-faq-to-articles.mjs',
    'scripts/backfill-small-images.mjs',
    'scripts/create-article.mjs',
    'scripts/lib/blog-body-io.mjs',
    'scripts/lib/article-topic-selector.mjs',
    'scripts/one-off/fix-itemlist-articoli-frontaliere.mjs',
    'scripts/one-off/repair-truncated-article-titles.mjs',
  ] as const;

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

/**
 * The repo-wide instance the previous `describe` block's doc comment used
 * to defer (issue #5780). SITES above is a fixed enumeration — it catches
 * regressions on the fifteen known sites but says nothing about a
 * sixteenth. This scans every tracked source file instead, so a future
 * copy is caught the first time CI runs, not the next time someone
 * happens to grep for it by hand.
 *
 * Scoped to `git ls-files` under source-code directories only — NOT the
 * whole repo. `data/` and `public/` are excluded on purpose: this repo is
 * routinely worked from a SPARSE worktree that never materializes those
 * two directories (~3.5 GB combined; see tests/noindex-builders.test.ts /
 * CLAUDE.md for the same trap on build-plugin imports), and `git ls-files`
 * lists tracked paths from the index regardless of what sparse-checkout
 * has actually materialized — so reading one unconditionally would throw
 * ENOENT there, not report a false offender. Neither directory holds
 * hand-rolled TS/JSON string decoders in the first place: `data/` is pure
 * content/types, `public/` is static assets.
 */
describe('wiring — repo-wide: the buggy chain shape cannot exist anywhere in the scanned source tree', () => {
  // Every directory that has EVER held one of these decoders (SITES above
  // touches all of build-plugins/, scripts/, tests/), plus the neighbours
  // most likely to grow a sixteenth copy next.
  const SCAN_ROOTS = [
    'scripts',
    'build-plugins',
    'tests',
    'components',
    'services',
    'src',
    'packages/articles',
    '.github',
  ];

  // Paths where the literal signature text below appears WITHOUT being a
  // live decoder:
  //  - this file and unescape-ts-string.mjs itself quote the historical
  //    buggy line verbatim in a comment, for humans reading the fix;
  //  - tsStringEscapes.ts (the independent #5602 fix for
  //    packages/articles) does the same in its own doc comment;
  //  - rhb-job-parser.mjs's one `.replace(/\\\\/g, '\\')` is a single
  //    isolated call that reduces one level of an ALREADY-JSON-escaped
  //    string — it is never chained with other escape substitutions, so
  //    it cannot have the reordering bug (verified during the #5780
  //    investigation, which is why it was excluded from that issue's
  //    count of 12 real sites).
  const ALLOW = new Set([
    'tests/unescape-ts-string.test.ts',
    'scripts/lib/unescape-ts-string.mjs',
    'packages/articles/engine/shared/tsStringEscapes.ts',
    'scripts/lib/rhb-job-parser.mjs',
  ]);

  function trackedSourceFiles(): string[] {
    const out = execFileSync('git', ['ls-files', '--', ...SCAN_ROOTS], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out
      .split('\n')
      .filter(Boolean)
      .filter((p) => /\.(ts|mjs)$/.test(p));
  }

  it('no tracked file under the scan roots contains the buggy replace-chain signature, outside the documented exceptions', () => {
    const offenders: string[] = [];
    for (const rel of trackedSourceFiles()) {
      if (ALLOW.has(rel)) continue;
      let src: string;
      try {
        src = readFileSync(resolve(ROOT, rel), 'utf8');
      } catch {
        // Not materialized in this worktree. Cannot happen for the roots
        // above in a correctly-configured sparse checkout (only data/ and
        // public/ are excluded), but skip rather than false-fail if it does.
        continue;
      }
      if (src.includes(BUGGY_CHAIN_SIGNATURE)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
