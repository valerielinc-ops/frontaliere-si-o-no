/**
 * sibling-check-gate.mjs — false-positive filter tests (issue #3325).
 *
 * The gate now reads the `## Non implementato` section from the `gh pr create`
 * command string and allows PR creation when ALL sibling candidates are
 * explicitly declared as false positives (AGENTS.md #6 escape hatch). Mere
 * deferral ("follow-up") does NOT bypass the gate. Mirrors the
 * pr-body-check-gate.test.ts pattern (shipped in #3332).
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { isDeclaredFalsePositive } from '../scripts/ci/sibling-check-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('isDeclaredFalsePositive — only AGENTS.md #6 escape-hatch language qualifies', () => {
  const FP_NONIMPL = `
- scripts/foo-parser.mjs: falso positivo — solo lessicalmente simile ma semanticamente diverso
`;
  const FP_EN_NONIMPL = `
- scripts/bar-crawler.mjs: false positive — not the same bug class, different semantic context
`;
  const DEFERRED_NONIMPL = `
- scripts/baz-crawler.mjs: deferred — will fix in follow-up PR
`;
  const BARE_NONIMPL = `
- scripts/qux-parser.mjs: candidate detected by gate, listed here
`;
  const EXPLICIT_FP_MULTILINE = `
- scripts/alpha.mjs: semanticamente diverso dal costrutto fixato qui
- scripts/beta.mjs: not the same anti-pattern, different class
`;

  it('falso positivo + lessicalmente simile language → declared FP (bypasses gate)', () => {
    expect(isDeclaredFalsePositive('scripts/foo-parser.mjs', FP_NONIMPL)).toBe(true);
  });

  it('English "false positive — not the same bug class" → declared FP', () => {
    expect(isDeclaredFalsePositive('scripts/bar-crawler.mjs', FP_EN_NONIMPL)).toBe(true);
  });

  it('"semanticamente diverso" without "lessicalmente simile" prefix → declared FP', () => {
    expect(isDeclaredFalsePositive('scripts/alpha.mjs', EXPLICIT_FP_MULTILINE)).toBe(true);
  });

  it('"not the same anti-pattern" → declared FP', () => {
    expect(isDeclaredFalsePositive('scripts/beta.mjs', EXPLICIT_FP_MULTILINE)).toBe(true);
  });

  it('deferral note ("will fix in follow-up") → NOT a false positive (gate still blocks)', () => {
    expect(isDeclaredFalsePositive('scripts/baz-crawler.mjs', DEFERRED_NONIMPL)).toBe(false);
  });

  it('bare mention without FP language → NOT a false positive', () => {
    expect(isDeclaredFalsePositive('scripts/qux-parser.mjs', BARE_NONIMPL)).toBe(false);
  });

  it('file NOT mentioned at all → false', () => {
    expect(isDeclaredFalsePositive('scripts/missing.mjs', FP_NONIMPL)).toBe(false);
  });

  it('basename match (no path prefix) → finds FP declaration', () => {
    const nonImpl = '- foo-parser.mjs: falso positivo — semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/update/foo-parser.mjs', nonImpl)).toBe(true);
  });

  it('very short basename (≤3 chars) is NOT matched by basename shortcut (anti-noise)', () => {
    const nonImpl = '- js: falso positivo — semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/foo.js', nonImpl)).toBe(false);
  });

  it('empty nonImplText → false', () => {
    expect(isDeclaredFalsePositive('scripts/foo.mjs', '')).toBe(false);
  });

  it('empty candidatePath → false', () => {
    expect(isDeclaredFalsePositive('', FP_NONIMPL)).toBe(false);
  });

  it('null / undefined inputs → false (no throw)', () => {
    expect(isDeclaredFalsePositive(null as unknown as string, FP_NONIMPL)).toBe(false);
    expect(isDeclaredFalsePositive('scripts/foo.mjs', null as unknown as string)).toBe(false);
  });
});
