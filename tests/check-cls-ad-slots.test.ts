/**
 * Lock test for the zero-Claude gate `scripts/ci/check-cls-ad-slots.mjs`
 * (escalation lessons-harvester #1954, reviewer-finding/cls-layout).
 *
 * The recurring antipattern (e.g. PR #1910): a build plugin emits a raw AdSense
 * `<ins class="adsbygoogle" …>` with a hand-coded min-height/format instead of the
 * registry-driven `adSlotHtml()` helper → under-reserved space → CLS that degrades
 * RPM. The gate enforces the invariant: only `build-plugins/lib/adSlotHtml.ts` may
 * contain the raw `adsbygoogle` ins literal.
 *
 * Verifies:
 *  1. the current tree is CLEAN (no hard-coded ad <ins> in build-plugins) — so the
 *     invariant holds and any future violation turns the suite red;
 *  2. the CLI exits 0 on the clean tree and 1 when a violation is injected.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findViolations, ALLOWED, AD_MARKER, stripComments } from '../scripts/ci/check-cls-ad-slots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-cls-ad-slots.mjs');

describe('check-cls-ad-slots — invariant', () => {
  it('the current build-plugins tree has no hard-coded AdSense <ins>', () => {
    expect(findViolations()).toEqual([]);
  });

  it('allow-lists only the sanctioned emitter + ad-loader infra', () => {
    expect(ALLOWED.has('build-plugins/lib/adSlotHtml.ts')).toBe(true);
    // constants.ts (loader) + htmlTemplate.ts (detection) reference the literal
    // legitimately; every other build-plugin must use adSlotHtml().
    expect(ALLOWED.has('build-plugins/constants.ts')).toBe(true);
    expect(ALLOWED.has('build-plugins/htmlTemplate.ts')).toBe(true);
    expect(AD_MARKER).toBe('adsbygoogle');
  });
});

describe('check-cls-ad-slots — CLI gate', () => {
  it('exits 0 on the clean tree', () => {
    const out = execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf-8' });
    expect(out).toMatch(/no hard-coded AdSense/);
  });

  it('exits 1 when a TOP-LEVEL build-plugin hard-codes an ad <ins>', () => {
    // Fixture must be a TOP-LEVEL build-plugins/*.ts (not a subdir) — that is the
    // #1910 file class and the case the original `**/*.ts` pathspec bug silently
    // skipped. A subdir fixture would pass even with the bug.
    const file = path.join(ROOT, 'build-plugins', '_clsgate_bad.ts');
    fs.writeFileSync(
      file,
      'export const X = `<ins class="adsbygoogle" style="min-height:280px"></ins>`;\n',
    );
    try {
      // git grep only sees tracked files → stage the temp file.
      execFileSync('git', ['add', '-f', file], { cwd: ROOT });
      expect(findViolations()).toContain('build-plugins/_clsgate_bad.ts');
      let exitCode = 0;
      try {
        execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf-8' });
      } catch (e: unknown) {
        exitCode = (e as { status?: number }).status ?? -1;
      }
      expect(exitCode).toBe(1);
    } finally {
      execFileSync('git', ['rm', '-f', '--quiet', file], { cwd: ROOT });
    }
  });

  it('does NOT flag a build-plugin that names adsbygoogle only in a comment (#2127)', () => {
    // The recurring false positive: a plain comment mentioning the loader script
    // (`// …load adsbygoogle.js post-hydration`) tripped the bare-substring grep on
    // PRs that never touched ad markup, failing the full-tree gate until each branch
    // reworded prose. Comment-awareness must let this through.
    const file = path.join(ROOT, 'build-plugins', '_clsgate_commentonly.ts');
    fs.writeFileSync(
      file,
      [
        '// Loader note: the SPA <AdSenseBanner> loads adsbygoogle.js post-hydration.',
        '/* block comment also naming adsbygoogle should not count */',
        'export const Y = `<div class="ad-wrap"></div>`; // trailing note: adsbygoogle',
        '',
      ].join('\n'),
    );
    try {
      execFileSync('git', ['add', '-f', file], { cwd: ROOT });
      expect(findViolations()).not.toContain('build-plugins/_clsgate_commentonly.ts');
    } finally {
      execFileSync('git', ['rm', '-f', '--quiet', file], { cwd: ROOT });
    }
  });
});

describe('check-cls-ad-slots — stripComments', () => {
  it('blanks line, trailing, and block comments but keeps code', () => {
    const src = [
      '// pure adsbygoogle comment',
      'const a = `<ins class="adsbygoogle">`; // trailing adsbygoogle',
      '/* block adsbygoogle */',
      ' * jsdoc-body adsbygoogle line',
    ].join('\n');
    const out = stripComments(src);
    expect(out).toContain('<ins class="adsbygoogle">'); // real code survives
    expect(out).not.toMatch(/pure adsbygoogle comment/);
    expect(out).not.toMatch(/trailing adsbygoogle/);
    expect(out).not.toMatch(/block adsbygoogle/);
    expect(out).not.toMatch(/jsdoc-body adsbygoogle/);
  });

  it('tolerates nullish input', () => {
    expect(stripComments(undefined)).toBe('');
    expect(stripComments('')).toBe('');
  });
});
