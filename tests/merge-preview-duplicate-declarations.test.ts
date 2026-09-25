/**
 * Merge-preview duplicate-declaration gate (#5215) coverage.
 *
 * `isMergePreviewCheckedPath` is pure and unit-tested directly.
 * `checkMergePreviewDuplicates` shells out to real `git` — exercised against
 * a throwaway local repo (no network) that reproduces the #5187+#5170 shape:
 * two branches independently add the SAME top-level binding to DIFFERENT,
 * non-overlapping line ranges of the same file, so git merges them with NO
 * conflict. The resulting tree must still be flagged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkMergePreviewDuplicates,
  isMergePreviewCheckedPath,
} from '../scripts/ci/lib/mergePreviewCheck.mjs';

describe('isMergePreviewCheckedPath', () => {
  it('matches direct children of build-plugins/ and build-plugins/shared/', () => {
    expect(isMergePreviewCheckedPath('build-plugins/constants.ts')).toBe(true);
    expect(isMergePreviewCheckedPath('build-plugins/shared/seoPageShell.ts')).toBe(true);
  });

  it('excludes nested subdirectories, other trees, and .d.ts', () => {
    expect(isMergePreviewCheckedPath('build-plugins/shared/nested/x.ts')).toBe(false);
    expect(isMergePreviewCheckedPath('scripts/lib/foo.ts')).toBe(false);
    expect(isMergePreviewCheckedPath('build-plugins/constants.d.ts')).toBe(false);
  });
});

describe('checkMergePreviewDuplicates (real git, local-only repo)', () => {
  let repo: string;
  let mainBranch: string;

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  }
  function write(rel: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  function commit(msg: string) {
    git(['add', '-A']);
    git(['commit', '-q', '-m', msg]);
    return git(['rev-parse', 'HEAD']);
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-preview-test-'));
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(repo, '.gitkeep'), '');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'root']);
    mainBranch = git(['branch', '--show-current']);
    // checkMergePreviewDuplicates fetches each sha from `origin` (mirrors the
    // real CI checkout); point it at the repo itself so shas already present
    // locally resolve without a network remote.
    git(['remote', 'add', 'origin', repo]);
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('flags a clean (no-git-conflict) merge that duplicates a top-level binding', () => {
    // Base: a file with room at the top AND bottom so two independent
    // far-apart insertions don't touch the same lines (real #5187+#5170
    // shape — different line ranges, no git conflict).
    const base = Array.from({ length: 20 }, (_, i) => `// filler line ${i}`).join('\n') + '\n';
    write('build-plugins/constants.ts', base);
    const baseSha = commit('base');

    git(['checkout', '-q', '-b', 'head-branch']);
    const withHelperA = base + '\nexport function replaceRobotsMeta(h: string): string { return h; }\n';
    write('build-plugins/constants.ts', withHelperA);
    const headSha = commit('head adds helper');

    git(['checkout', '-q', mainBranch]);
    // Same helper, DIFFERENT wording (still a duplicate top-level binding),
    // inserted at the TOP instead of the bottom — no overlapping lines vs head.
    const withHelperB = 'export function replaceRobotsMeta(x: string): string { return x + x; }\n\n' + base;
    write('build-plugins/constants.ts', withHelperB);
    const mainSha = commit('main adds same-named helper independently');

    const result = checkMergePreviewDuplicates({ headSha, baseSha: mainSha, mergeBaseSha: baseSha, cwd: repo });
    expect(result.ok).toBe(false);
    expect(result.dupesByFile?.['build-plugins/constants.ts']).toContain('replaceRobotsMeta');
  });

  it('allows a clean merge with no duplicate binding', () => {
    write('build-plugins/other.ts', 'export const OTHER_MARKER = 1;\n');
    const baseSha = commit('base2');

    git(['checkout', '-q', '-b', 'head-branch-2']);
    write('build-plugins/other.ts', 'export const OTHER_MARKER = 1;\nexport function helperA() { return 1; }\n');
    const headSha = commit('head adds helperA');

    git(['checkout', '-q', mainBranch]);
    write('build-plugins/other.ts', 'export const OTHER_MARKER = 1;\nexport function helperB() { return 2; }\n');
    const mainSha = commit('main adds unrelated helperB');

    const result = checkMergePreviewDuplicates({ headSha, baseSha: mainSha, mergeBaseSha: baseSha, cwd: repo });
    expect(result.ok).toBe(true);
  });

  it('is conservative (ok: true) when a sha is missing/unfetchable', () => {
    const result = checkMergePreviewDuplicates({ headSha: '', baseSha: 'deadbeef', mergeBaseSha: 'deadbeef' });
    expect(result.ok).toBe(true);
  });
});
