/**
 * sibling-check-gate.mjs — false-positive filter tests (issue #3325).
 *
 * The gate now reads the `## Non implementato` section from the `gh pr create`
 * command string and allows PR creation when ALL sibling candidates are
 * explicitly declared as false positives (AGENTS.md #6 escape hatch). Mere
 * deferral ("follow-up") does NOT bypass the gate. Mirrors the
 * pr-body-check-gate.test.ts pattern (shipped in #3332).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeclaredFalsePositive } from '../scripts/ci/sibling-check-gate.mjs';
import { EXIT_BLOCK } from '../scripts/ci/lib/hook-exit-codes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GATE = resolve(ROOT, 'scripts/ci/sibling-check-gate.mjs');

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

describe('isDeclaredFalsePositive — negation-aware (issue #3367)', () => {
  it('"non è un falso positivo" (explicit REJECTION) → NOT a declared FP, gate still blocks', () => {
    const nonImpl =
      '- scripts/foo-parser.mjs: non è un falso positivo, va sistemato in follow-up';
    expect(isDeclaredFalsePositive('scripts/foo-parser.mjs', nonImpl)).toBe(false);
  });

  it('"not a false positive" (English rejection) → NOT a declared FP', () => {
    const nonImpl = '- scripts/bar-crawler.mjs: not a false positive, genuine sibling bug';
    expect(isDeclaredFalsePositive('scripts/bar-crawler.mjs', nonImpl)).toBe(false);
  });

  it('"non è semanticamente diverso" (explicit rejection) → NOT a declared FP', () => {
    const nonImpl = '- scripts/baz.mjs: non è semanticamente diverso, stesso bug del sibling';
    expect(isDeclaredFalsePositive('scripts/baz.mjs', nonImpl)).toBe(false);
  });
});

describe('isDeclaredFalsePositive — basename disambiguation across directories (issue #3367)', () => {
  it('basename-only FP declaration for a DIFFERENT full path does NOT cover the candidate', () => {
    const nonImpl =
      '- scripts/legacy/foo.js: falso positivo — solo lessicalmente simile ma semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/new/foo.js', nonImpl)).toBe(false);
  });

  it('basename-only FP declaration for the SAME full path still covers the candidate', () => {
    const nonImpl =
      '- scripts/legacy/foo.js: falso positivo — solo lessicalmente simile ma semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/legacy/foo.js', nonImpl)).toBe(true);
  });

  it('bare basename (no directory in body) still matches via basename shortcut', () => {
    const nonImpl = '- foo-parser.mjs: falso positivo — semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/update/foo-parser.mjs', nonImpl)).toBe(true);
  });
});

describe('sibling-check-gate hook — cwd forwarding (2026-08-25 incident)', () => {
  // Observed on a real run: a PR opened from a worktree got blocked citing a
  // file dirty only in the UNRELATED main checkout — proof the hook was
  // analysing the wrong directory. See lib/hook-target-cwd.mjs for the root
  // cause.
  //
  // These tests spawn the real check-sibling-patterns.mjs, which does a
  // full-tree `git grep`/pattern-class scan across CODE_DIRS — expensive
  // against THIS ~15GB monorepo (tests/check-sibling-patterns.test.ts avoids
  // it entirely, testing only the pure functions). So spawnSync's own
  // ambient cwd here is a tiny THROWAWAY git repo, not this one — fast, and
  // it still proves the fix: does the analysis follow payload.cwd, or fall
  // back to wherever the hook subprocess itself happens to run from?
  const createdDirs: string[] = [];
  let ambientRepo = '';

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'sibling-gate-ambient-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    // resolveBase() tries `origin/main` first (see check-sibling-patterns.mjs)
    // — a bare local repo has no remote, so give it one.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    ambientRepo = dir;
    createdDirs.push(dir);
  });
  afterAll(() => {
    while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true });
  });

  function runGate(command: string, extraPayload: Record<string, unknown> = {}) {
    const payload = JSON.stringify({ tool_input: { command }, ...extraPayload });
    return spawnSync('node', [GATE], { input: payload, encoding: 'utf8', cwd: ambientRepo });
  }

  it('passes through (exit 0) for non "gh pr create" commands regardless of payload.cwd', () => {
    const res = runGate('git status', { cwd: ambientRepo });
    expect(res.status).toBe(0);
  });

  it('analyses payload.cwd, not this hook subprocess\'s own ambient directory: a directory outside any git repo blocks with "sweep NON ESEGUITO", never silently allowing an unverified PR', () => {
    const outsideAnyRepo = mkdtempSync(join(tmpdir(), 'sibling-gate-cwd-'));
    createdDirs.push(outsideAnyRepo);
    const res = runGate('gh pr create --title x --body "y"', { cwd: outsideAnyRepo });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/NON ESEGUITO/);
  });

  it('falls back to the ambient directory (today\'s pre-fix behaviour) when the payload carries no cwd at all', () => {
    // No `cwd` field in the payload → resolveHookTargetCwd returns undefined
    // → the check script inherits spawnSync's own cwd (ambientRepo, a
    // trivial but VALID repo with `origin/main` resolvable) → must NOT hit
    // the skipped/"NON ESEGUITO" branch, which only fires when the
    // merge-base can't be found.
    const res = runGate('gh pr create --title x --body "y"');
    expect(res.stderr ?? '').not.toMatch(/NON ESEGUITO/);
  });
});
