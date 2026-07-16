/**
 * check-sibling-patterns.mjs — extractTokens() + extractRemovedExpressions() +
 * pattern-class registry coverage.
 *
 * extractTokens (issue #3658): token extraction only ever looked for kebab-case
 * inside import/require path strings, so a shared entity-id string LITERAL was
 * invisible to the gate. Added a fourth class for bare quoted kebab-case values.
 *
 * extractRemovedExpressions (issue #4260): the recurring sibling-class-fix
 * escalation persisted because token-match misses siblings that share only the
 * OLD removed anti-pattern — they do not yet import the NEW helper introduced by
 * the fix, so no token is common. The verbatim removed-line pass addresses this.
 *
 * PATTERN_CLASSES / detectCapBeforeMutation / detectCloseBundleOrdering (issue
 * #4260 escalation, round 2): the sibling-class-fix bucket kept recurring past
 * the verbatim pass (6× in 14 days) because some repeat findings are the SAME
 * bug SHAPE re-implemented with different variable/helper names — no shared
 * token or expression to grep for. These detectors are curated, heuristic,
 * shape-level checks (see the doc comment above PATTERN_CLASSES in the script
 * for the worked examples — issue #4208 and issue #4263 item 4).
 */
import { describe, it, expect } from 'vitest';
import {
  extractTokens,
  extractRemovedExpressions,
  detectCapBeforeMutation,
  detectCloseBundleOrdering,
  PATTERN_CLASSES,
} from '../scripts/ci/check-sibling-patterns.mjs';

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

describe('PATTERN_CLASSES registry (issue #4260 escalation, round 2)', () => {
  it('registers the two curated bug-shape classes', () => {
    const names = PATTERN_CLASSES.map((c) => c.name);
    expect(names).toContain('cap-before-mutation');
    expect(names).toContain('closeBundle-ordering');
    for (const cls of PATTERN_CLASSES) {
      expect(typeof cls.description).toBe('string');
      expect(cls.description.length).toBeGreaterThan(0);
      expect(typeof cls.detect).toBe('function');
    }
  });
});

describe('detectCapBeforeMutation (worked example: issue #4208)', () => {
  it('flags a cap/headroom computed from an object, then that SAME object mutated afterward without recompute', () => {
    const buggy = [
      'function planAdds(job, incoming) {',
      '  const cap = 20;',
      '  const headroom = Math.max(0, cap - job.slugs.length);',
      '  const adds = incoming.slice(0, headroom);',
      '  // BUG: job.slugs mutated after headroom was computed from its',
      '  // pre-mutation length; headroom is never recomputed.',
      '  job.slugs.push(...adds);',
      '  return adds;',
      '}',
    ].join('\n');
    const findings = detectCapBeforeMutation(buggy);
    expect(findings.length).toBe(1);
    expect(findings[0].snippet).toContain('headroom');
  });

  it('does NOT flag when the mutation lands on an unrelated object (clean)', () => {
    const clean = [
      'function planAdds(job, incoming) {',
      '  const cap = 20;',
      '  const headroom = Math.max(0, cap - job.slugs.length);',
      '  const adds = incoming.slice(0, headroom);',
      '  const auditLog = [];',
      '  auditLog.push(...adds); // mutates auditLog, not job.slugs — safe',
      '  return adds;',
      '}',
    ].join('\n');
    expect(detectCapBeforeMutation(clean)).toEqual([]);
  });

  it('does NOT flag when the cap is recomputed before the mutation runs (fixed shape, clean)', () => {
    const clean = [
      'function planAdds(job, incoming) {',
      '  const cap = 20;',
      '  let headroom = Math.max(0, cap - job.slugs.length);',
      '  const adds = incoming.slice(0, headroom);',
      '  // Recompute right before mutating — safe even if something else',
      '  // touched job.slugs in between.',
      '  headroom = Math.max(0, cap - job.slugs.length);',
      '  if (headroom > 0) job.slugs.push(...adds.slice(0, headroom));',
      '  return adds;',
      '}',
    ].join('\n');
    expect(detectCapBeforeMutation(clean)).toEqual([]);
  });

  it('does NOT flag a bare cap computation with no mutation at all (clean)', () => {
    const clean = [
      'function headroomOnly(job) {',
      '  const cap = 20;',
      '  const headroom = Math.max(0, cap - job.slugs.length);',
      '  return headroom;',
      '}',
    ].join('\n');
    expect(detectCapBeforeMutation(clean)).toEqual([]);
  });
});

describe('detectCloseBundleOrdering (worked example: issue #4263 item 4)', () => {
  it('flags a closeBundle hook reading a dist-output path without `sequential: true`', () => {
    const buggy = [
      'export function siblingBridgePlugin(rootDir) {',
      '  return {',
      "    name: 'sibling-bridge',",
      "    apply: 'build',",
      '    async closeBundle() {',
      "      const distDir = path.resolve(rootDir, 'dist');",
      "      const targetFile = path.join(distDir, eventSlug, 'index.html');",
      '      if (!fs.existsSync(targetFile)) {',
      '        // fall back — but the sibling plugin that writes targetFile',
      '        // may not have finished yet: this hook declares no ordering guard.',
      "        console.log('fallback');",
      '      }',
      '    },',
      '  };',
      '}',
    ].join('\n');
    const findings = detectCloseBundleOrdering(buggy);
    expect(findings.length).toBe(1);
    expect(findings[0].snippet).toContain('existsSync');
  });

  it('does NOT flag when the hook declares `sequential: true` (object-form, fixed shape, clean)', () => {
    const clean = [
      'export function siblingBridgeSafePlugin(rootDir) {',
      '  return {',
      "    name: 'sibling-bridge-safe',",
      "    apply: 'build',",
      '    closeBundle: {',
      '      sequential: true,',
      '      async handler() {',
      "        const distDir = path.resolve(rootDir, 'dist');",
      "        const targetFile = path.join(distDir, 'events', 'index.html');",
      '        if (!fs.existsSync(targetFile)) {',
      "          console.log('safe — sequential guarantees ordering');",
      '        }',
      '      },',
      '    },',
      '  };',
      '}',
    ].join('\n');
    expect(detectCloseBundleOrdering(clean)).toEqual([]);
  });

  it('does NOT flag a closeBundle with no cross-plugin dist read at all (clean)', () => {
    const clean = [
      'async closeBundle() {',
      "  const distDir = path.resolve(rootDir, 'dist');",
      "  fs.writeFileSync(path.join(distDir, 'own-output.html'), html, 'utf-8');",
      '}',
    ].join('\n');
    expect(detectCloseBundleOrdering(clean)).toEqual([]);
  });

  it('does NOT flag the bare `existsSync(distDir)` bail-out idiom alone (clean, common, not cross-plugin)', () => {
    const clean = [
      'async closeBundle() {',
      "  const distDir = path.resolve(rootDir, 'dist');",
      '  if (!fs.existsSync(distDir)) return;',
      "  fs.writeFileSync(path.join(distDir, 'own-output.html'), html, 'utf-8');",
      '}',
    ].join('\n');
    expect(detectCloseBundleOrdering(clean)).toEqual([]);
  });

  it('does NOT flag a var holding a HARDCODED literal filename off distDir, even when read via existsSync (regression guard: literal-segment exclusion must not be defeated by the space after the comma)', () => {
    // Real shape from build-plugins/adminDataPlugin.ts: `indexHtml` is a
    // literal `dist/index.html` path (own build's core output, not another
    // plugin's dynamic per-page output) — reading it back is not the
    // cross-plugin ordering risk this class targets.
    const clean = [
      'closeBundle() {',
      "  const distDir = path.resolve(root, 'dist');",
      "  const indexHtml = path.resolve(distDir, 'index.html');",
      '  if (fs.existsSync(indexHtml)) {',
      "    const shell = fs.readFileSync(indexHtml, 'utf-8');",
      '  }',
      '}',
    ].join('\n');
    expect(detectCloseBundleOrdering(clean)).toEqual([]);
  });
});
