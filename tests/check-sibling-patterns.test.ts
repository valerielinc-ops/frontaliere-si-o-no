/**
 * check-sibling-patterns.mjs — extractTokens() + extractRemovedExpressions() coverage.
 *
 * extractTokens (issue #3658): token extraction only ever looked for kebab-case
 * inside import/require path strings, so a shared entity-id string LITERAL was
 * invisible to the gate. Added a fourth class for bare quoted kebab-case values.
 *
 * extractRemovedExpressions (issue #4260): the recurring sibling-class-fix
 * escalation persisted because token-match misses siblings that share only the
 * OLD removed anti-pattern — they do not yet import the NEW helper introduced by
 * the fix, so no token is common. The verbatim removed-line pass addresses this.
 */
import { describe, it, expect } from 'vitest';
import { extractTokens, extractRemovedExpressions } from '../scripts/ci/check-sibling-patterns.mjs';

describe('extractTokens — SCREAMING_SNAKE_CASE constants', () => {
  it('extracts constants with ≥1 underscore and length ≥5', () => {
    const text = 'const POST_WALK_WORKERS = 4;';
    expect(extractTokens(text).has('POST_WALK_WORKERS')).toBe(true);
  });

  it('ignores short all-caps tokens (<5 chars)', () => {
    const text = 'const A_B = 1;';
    expect(extractTokens(text).has('A_B')).toBe(false);
  });
});

describe('extractTokens — distinctive camelCase/PascalCase helpers', () => {
  it('extracts mixed-case identifiers ≥8 chars', () => {
    const text = 'export function truncateSlugAtWordBoundary(s) {}';
    expect(extractTokens(text).has('truncateSlugAtWordBoundary')).toBe(true);
  });

  it('ignores short identifiers (<8 chars)', () => {
    const text = 'const getId = () => 1;';
    expect(extractTokens(text).has('getId')).toBe(false);
  });
});

describe('extractTokens — kebab-case basenames inside import/require paths', () => {
  it('extracts the basename from an import path', () => {
    const text = "import { floor } from './lib/compat-paths-floor-guard.mjs';";
    expect(extractTokens(text).has('compat-paths-floor-guard')).toBe(true);
  });
});

describe('extractTokens — bare quoted kebab-case string literal VALUES (issue #3658)', () => {
  it('extracts a standalone quoted kebab-case id/slug value (≥10 chars)', () => {
    const text = "const AUTHORS = { 'anna-keller-wyss': { name: 'Anna Keller Wyss' } };";
    expect(extractTokens(text).has('anna-keller-wyss')).toBe(true);
  });

  it('does not extract it when embedded inside an import path (already covered by the path class)', () => {
    const text = "import x from './anna-keller-wyss-bio.mjs';";
    expect(extractTokens(text).has('anna-keller-wyss-bio')).toBe(true);
    // Extracted via the import-path class, not double-counted oddly by the literal class.
  });

  it('ignores short common compound words (<10 chars) to limit noise', () => {
    const text = "res.setHeader('Cache-Control', 'max-age=600');".toLowerCase();
    expect(extractTokens(text).has('max-age')).toBe(false);
  });

  it('extracts multi-segment slugs used as plain values', () => {
    const text = "reviewer.assign('marco-rossi-bianchi', task);";
    expect(extractTokens(text).has('marco-rossi-bianchi')).toBe(true);
  });
});

describe('extractRemovedExpressions — verbatim removed-line detection (issue #4260)', () => {
  it('extracts a property-assignment expression from a removed line (PR #4224 pattern)', () => {
    const diff = [
      '--- a/build-plugins/salaryHubArticles.ts',
      '+++ b/build-plugins/salaryHubArticles.ts',
      ' context line',
      '-  description: copy.description,',
      '+  description: guardArticleJsonLdDescription(copy.description),',
    ].join('\n');
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.has('description: copy.description')).toBe(true);
  });

  it('extracts a function-call expression from a removed line (PR #4199 pattern)', () => {
    const diff = [
      '-  const html = `${esc(job.company)} — ${esc(job.location)}`;',
    ].join('\n');
    const exprs = extractRemovedExpressions(diff);
    expect([...exprs].some((e) => e.includes('esc(job.company)'))).toBe(true);
  });

  it('strips trailing comma before storing', () => {
    const diff = '-  description: copy.description,';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.has('description: copy.description')).toBe(true);
    expect(exprs.has('description: copy.description,')).toBe(false);
  });

  it('strips trailing semicolon before storing', () => {
    const diff = '-  return someHelper(value);';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.has('return someHelper(value)')).toBe(true);
    expect(exprs.has('return someHelper(value);')).toBe(false);
  });

  it('ignores the --- file-header line', () => {
    const diff = '--- a/build-plugins/foo.ts';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores added (+) lines', () => {
    const diff = '+  description: guardArticleJsonLdDescription(copy.description),';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores context lines (no + or - prefix)', () => {
    const diff = '  description: copy.description,';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores short removed content (<20 chars after strip)', () => {
    const diff = '-  return null;';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores comment lines (// prefix)', () => {
    const diff = '-  // description: copy.description (old way)';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores block-comment lines (* prefix)', () => {
    const diff = '-   * description: copy.description,';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores import lines', () => {
    const diff = "-  import { truncateCodeUnits } from './safe-truncate.mjs';";
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores require() lines', () => {
    const diff = "-  const x = require('./some-module');";
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores export-declaration lines', () => {
    const diff = '-  export const MY_CONST = 42;';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('ignores very long lines (>120 chars) to avoid noise', () => {
    const longLine = '-  ' + 'description: copy.description'.padEnd(125, ' + extraStuff');
    const exprs = extractRemovedExpressions(longLine);
    expect(exprs.size).toBe(0);
  });

  it('requires a code-expression indicator (ident( or ident:)', () => {
    const diff = '-  "just a plain string value in the file"';
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.size).toBe(0);
  });

  it('handles a real diff block with multiple removed lines', () => {
    const diff = [
      '--- a/build-plugins/somePlugin.ts',
      '+++ b/build-plugins/somePlugin.ts',
      '@@ -10,5 +10,5 @@',
      ' const base = {',
      "-  description: copy.description,",
      "-  longPropertyName: someValue.anotherProp,",
      "+  description: guardDescription(copy.description),",
      "+  longPropertyName: guardHelper(someValue.anotherProp),",
      ' };',
    ].join('\n');
    const exprs = extractRemovedExpressions(diff);
    expect(exprs.has('description: copy.description')).toBe(true);
    expect(exprs.has('longPropertyName: someValue.anotherProp')).toBe(true);
  });
});
