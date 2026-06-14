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
import { findViolations, ALLOWED, AD_MARKER } from '../scripts/ci/check-cls-ad-slots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-cls-ad-slots.mjs');

describe('check-cls-ad-slots — invariant', () => {
  it('the current build-plugins tree has no hard-coded AdSense <ins>', () => {
    expect(findViolations()).toEqual([]);
  });

  it('only adSlotHtml.ts is allow-listed as the raw <ins> emitter', () => {
    expect(ALLOWED.has('build-plugins/lib/adSlotHtml.ts')).toBe(true);
    expect(AD_MARKER).toBe('adsbygoogle');
  });
});

describe('check-cls-ad-slots — CLI gate', () => {
  it('exits 0 on the clean tree', () => {
    const out = execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf-8' });
    expect(out).toMatch(/no hard-coded AdSense/);
  });

  it('exits 1 when a build-plugin hard-codes an ad <ins>', () => {
    const dir = path.join(ROOT, 'build-plugins', '_clsgate_test_tmp');
    const file = path.join(dir, 'bad.ts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      'export const X = `<ins class="adsbygoogle" style="min-height:280px"></ins>`;\n',
    );
    try {
      // git grep only sees tracked files → stage the temp file.
      execFileSync('git', ['add', '-f', file], { cwd: ROOT });
      let exitCode = 0;
      try {
        execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf-8' });
      } catch (e: unknown) {
        exitCode = (e as { status?: number }).status ?? -1;
      }
      expect(exitCode).toBe(1);
    } finally {
      execFileSync('git', ['rm', '-f', '--quiet', file], { cwd: ROOT });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
