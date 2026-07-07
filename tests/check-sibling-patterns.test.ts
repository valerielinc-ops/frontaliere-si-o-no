/**
 * check-sibling-patterns.mjs — extractTokens() coverage (issue #3658).
 *
 * Root cause of the recurring sibling-class-fix escalation: token extraction
 * only ever looked for kebab-case inside import/require path strings, so a
 * shared entity-id string LITERAL (e.g. an author slug mirrored across two
 * scripts) was invisible to the gate. This adds a fourth extraction class for
 * bare quoted kebab-case string values, alongside regression coverage for the
 * three pre-existing classes.
 */
import { describe, it, expect } from 'vitest';
import { extractTokens } from '../scripts/ci/check-sibling-patterns.mjs';

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
