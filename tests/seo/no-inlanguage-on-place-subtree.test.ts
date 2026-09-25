/**
 * Gate C — fast pre-build regression check.
 *
 * Scans `services/seo/seo-pages.ts`,
 * `build-plugins/borderWaitPagesPlugin.ts`, and
 * `build-plugins/borderWaitMapPlugin.ts` for any object literal that
 * declares `'@type': 'Place'`, `'@type': 'GeoCoordinates'`, or
 * `'@type': 'PostalAddress'` AND ALSO carries an `inLanguage` property
 * inside the same object literal.
 *
 * Why: schema.org's `inLanguage` lives on `CreativeWork` (and a few
 * explicit non-CW types like Event, JobPosting, Product). The Place
 * subtree — Place, PostalAddress, GeoCoordinates, plus Organization,
 * LocalBusiness, etc. — does NOT accept `inLanguage`. Putting it there
 * trips Semrush + Google's structured-data validator with "property not
 * recognized" warnings.
 *
 * Note on Map: per commit `573ea9e15` and the canonical whitelist in
 * `services/seo/inlanguage-whitelist.ts`, `Map` IS a CreativeWork
 * subtype and DOES accept `inLanguage`. So Map is intentionally excluded
 * from the forbidden set here.
 *
 * Companion: `tests/seo/no-inlanguage-on-forbidden-schemas.test.ts`
 * already covers BreadcrumbList / ItemList / Place / Organization /
 * LocalBusiness / Offer with a JSON-correct walker. This test is a
 * complementary fast-path source-grep tripwire, deliberately narrow to
 * the GeoCoordinates + PostalAddress subtypes plus Place, focused on
 * the three files most likely to introduce them.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

const TARGETS = [
  path.join(ROOT, 'services', 'seo', 'seo-pages.ts'),
  path.join(ROOT, 'build-plugins', 'borderWaitPagesPlugin.ts'),
  path.join(ROOT, 'build-plugins', 'borderWaitMapPlugin.ts'),
];

// Per services/seo/inlanguage-whitelist.ts, Map IS a CreativeWork
// descendant and DOES accept inLanguage. Keep it OUT of this set.
const FORBIDDEN_TYPES = ['Place', 'GeoCoordinates', 'PostalAddress'] as const;

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly schemaType: string;
  readonly snippet: string;
}

/**
 * Extract the balanced { ... } block starting at `pos` (which must point
 * to an opening brace). Returns null if no balanced block found. Aware
 * of single, double, and template-literal string boundaries so braces
 * inside strings don't corrupt the depth counter.
 */
function extractBalanced(src: string, pos: number): string | null {
  if (src[pos] !== '{') return null;
  let depth = 0;
  let inStr: '"' | "'" | '`' | null = null;
  for (let j = pos; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c as '"' | "'" | '`';
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.substring(pos, j + 1);
    }
  }
  return null;
}

/**
 * Find every object literal that contains `'@type': '<forbidden>'` AND,
 * within the SAME balanced object literal (not in a nested object),
 * an `inLanguage` key.
 *
 * "Same object literal" means: from the enclosing `{` of the @type key,
 * walk forward maintaining brace depth. Any `inLanguage:` we encounter
 * at depth 1 (i.e. inside the object that owns the @type) is an
 * offender. inLanguage in nested children is allowed — those children
 * could be CreativeWork subtypes.
 */
function scanFile(file: string): readonly Offender[] {
  const src = fs.readFileSync(file, 'utf8');
  const offenders: Offender[] = [];

  for (const type of FORBIDDEN_TYPES) {
    // Match either single- or double-quoted forms of the @type key/value.
    const re = new RegExp(`['"]@type['"]\\s*:\\s*['"]${type}['"]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Bounded backwards search for the enclosing `{`. Track string
      // boundaries so we don't latch onto a `{` inside a string literal.
      const typePos = m.index;
      let openPos = -1;
      let depth = 0;
      let inStr: '"' | "'" | '`' | null = null;
      // Walk backwards from typePos, but counting `{`/`}` is fragile in
      // reverse; instead, repeatedly scan the file in extractBalanced
      // from candidate `{` positions until we find one whose balanced
      // body covers the @type position.
      const searchStart = Math.max(0, typePos - 16384);
      for (let k = typePos - 1; k >= searchStart; k--) {
        // String-aware reverse scan is hard, so do a forward extract from
        // every candidate `{` and check whether it covers typePos.
        if (src[k] !== '{') continue;
        // Skip template-literal interpolation `${`
        if (k > 0 && src[k - 1] === '$') continue;
        const block = extractBalanced(src, k);
        if (block && k + block.length > typePos) {
          openPos = k;
          break;
        }
      }
      if (openPos === -1) continue;
      const block = extractBalanced(src, openPos);
      if (!block) continue;

      // Now walk `block` looking for `inLanguage` at depth 1 from the
      // outer `{`. depth starts at 0 because we include the `{` itself
      // at index 0 and `{` immediately bumps it to 1 — depth 1 == "in
      // the owning object".
      depth = 0;
      inStr = null;
      let foundInLanguageAtDepth1 = false;
      for (let j = 0; j < block.length; j++) {
        const c = block[j];
        if (inStr) {
          if (c === '\\') { j++; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') {
          inStr = c as '"' | "'" | '`';
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (depth === 1) {
          // Look for `inLanguage` keyword (bare or quoted) followed by `:`
          if (c === 'i' || c === '"' || c === "'") {
            const slice = block.substring(j, j + 16);
            if (
              /^["']?inLanguage["']?\s*:/.test(slice) &&
              // ensure it's a key boundary: previous char is `{`, `,`, or whitespace
              /[{,\s]/.test(block[j - 1] ?? '{')
            ) {
              foundInLanguageAtDepth1 = true;
              break;
            }
          }
        }
      }

      if (foundInLanguageAtDepth1) {
        const before = src.slice(0, typePos);
        const line = before.split('\n').length;
        const lineStart = before.lastIndexOf('\n') + 1;
        const lineEnd = src.indexOf('\n', typePos);
        const snippet = src
          .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
          .trim();
        offenders.push({
          file: path.relative(ROOT, file),
          line,
          schemaType: type,
          snippet,
        });
      }
    }
  }

  return offenders;
}

describe('Gate C — no inLanguage on Place / GeoCoordinates / PostalAddress', () => {
  it('zero forbidden inLanguage declarations on Place subtree types in target source files', () => {
    const all: Offender[] = [];
    for (const file of TARGETS) {
      if (!fs.existsSync(file)) continue;
      all.push(...scanFile(file));
    }
    const formatted = all.map(
      (o) => `${o.file}:${o.line} (${o.schemaType}) — ${o.snippet}`,
    );
    expect(formatted).toEqual([]);
  });
});
