// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTrackedPaths, evaluateTreeCounts, guardTreeShrink, resolveCommitRevision } from '../scripts/ci/guard-main-tree-shrink.mjs';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('main tree shrink guard', () => {
  it('rejects the incident-sized collapse from tens of thousands of paths to one', () => {
    expect(evaluateTreeCounts(56_251, 1)).toMatchObject({
      removed: 56_250,
      suspicious: true,
    });
  });

  it('allows normal data updates and small repositories', () => {
    expect(evaluateTreeCounts(56_251, 56_000).suspicious).toBe(false);
    expect(evaluateTreeCounts(999, 1).suspicious).toBe(false);
  });

  it('counts tracked paths from commit trees without reading the working tree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'main-tree-shrink-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.name', 'Fixture']);
      git(repo, ['config', 'user.email', 'fixture@example.invalid']);
      for (let index = 0; index < 1_001; index++) {
        writeFileSync(join(repo, `tracked-${index}.txt`), 'x');
      }
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'large tree']);
      const before = git(repo, ['rev-parse', 'HEAD']);
      expect(countTrackedPaths(before, repo)).toBe(1_001);

      for (let index = 1; index < 1_001; index++) rmSync(join(repo, `tracked-${index}.txt`));
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '-m', 'catastrophic shrink']);
      const after = git(repo, ['rev-parse', 'HEAD']);
      expect(guardTreeShrink(before, after, repo).suspicious).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects abbreviated object IDs in a SHA-256 repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'main-tree-shrink-sha256-'));
    try {
      git(repo, ['init', '-q', '--object-format=sha256']);
      git(repo, ['config', 'user.name', 'Fixture']);
      git(repo, ['config', 'user.email', 'fixture@example.invalid']);
      writeFileSync(join(repo, 'tracked.txt'), 'x');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'sha256 tree']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      const abbreviated = head.slice(0, 40);

      expect(head).toHaveLength(64);
      expect(() => countTrackedPaths(abbreviated, repo)).toThrow(/64-character Git object ID/u);
      expect(() => resolveCommitRevision(abbreviated, repo)).toThrow(/full 64-character Git object ID or a named ref/u);
      git(repo, ['branch', abbreviated]);
      expect(resolveCommitRevision(abbreviated, repo)).toBe(head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('guards both git-commit-data main push paths', () => {
    const script = readFileSync(new URL('../scripts/lib/git-commit-data.sh', import.meta.url), 'utf8');
    const isolatedGuard = script.indexOf('--before "$remote_sha" --after "$new_commit"');
    const isolatedPush = script.indexOf('"${new_commit}:refs/heads/main"');
    const legacyGuard = script.indexOf('--before "$main_push_base" --after "$main_push_head"');
    const legacyPush = script.indexOf('git -c pack.window=0 -c pack.threads=1 push --no-thin origin main');

    expect(isolatedGuard).toBeGreaterThanOrEqual(0);
    expect(isolatedPush).toBeGreaterThan(isolatedGuard);
    expect(legacyGuard).toBeGreaterThanOrEqual(0);
    expect(legacyPush).toBeGreaterThan(legacyGuard);
  });
});
