// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');

// The script uses `declare -A` (associative arrays), requiring bash 4+.
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

function initClonePair() {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-repo-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  return { originDir, repoDir };
}

function runScript(repoDir: string, sliceFile: string) {
  execFileSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'test commit'], {
    cwd: repoDir,
    env: {
      ...process.env,
      JOBS_SLICE_FILE: sliceFile,
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GITHUB_RUN_ID: '',
      GITHUB_REPOSITORY: '',
      GITHUB_OUTPUT: '',
    },
  });
}

// Regression coverage for the post-#3701 shared-workspace commit-loss class:
// crawler-group workflows run ~25 sibling crawlers as concurrent background
// steps against ONE checkout. The legacy commit path (stash --include-untracked
// → rebase → pop → drop) swept every sibling's not-yet-committed dirty file
// into the stash whenever origin/main had moved; on a pop conflict it restored
// only the invoking crawler's own files and DROPPED the rest — silently
// reverting sibling slices to HEAD (confirmed live: commit d2a7e49e
// "Auto-update EMS-Chemie" contained only a sibling's adapter while EMS's own
// freshly-crawled slice had been wiped; its summary stayed frozen at the
// 2026-07-06 earlyExit). The grouped-isolated path must never mutate the
// shared worktree/index at all: it builds the commit via a private temp index
// on top of the freshly fetched origin/main and pushes the sha directly.
describe('git-commit-data.sh grouped-isolated commit path (shared workspace)', () => {
  it('survives a remote divergence without touching the sibling\'s dirty worktree files (no stash, no rebase)', () => {
    const { originDir, repoDir } = initClonePair();
    // Second clone simulates ANOTHER group's runner pushing to origin
    // after this workspace was checked out.
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-other-'));

    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/c.json'), '[]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // Remote moves AFTER our checkout: crawler "c" (another group) pushes.
      execFileSync('git', ['clone', '-q', originDir, join(otherDir, 'clone')]);
      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
      execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
      writeFileSync(join(otherClone, 'data/jobs/by-crawler/c.json'), '[{"id":"c1"}]\n');
      execFileSync('git', ['add', '.'], { cwd: otherClone });
      execFileSync('git', ['commit', '-q', '-m', 'other group: crawler c'], { cwd: otherClone });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: otherClone });

      // Meanwhile, in THIS shared workspace: crawler "a" finished (invokes the
      // script), sibling crawler "b" is still mid-run with a dirty slice.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[{"id":"b1"}]\n');

      runScript(repoDir, 'data/jobs/by-crawler/a.json');

      // The sibling's dirty file must be EXACTLY as the sibling left it —
      // not stashed, not reverted, not merged away.
      expect(readFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), 'utf-8')).toBe('[{"id":"b1"}]\n');
      const stashList = execFileSync('git', ['stash', 'list'], { cwd: repoDir, encoding: 'utf-8' });
      expect(stashList.trim()).toBe('');

      // origin/main has BOTH crawler c's earlier push AND crawler a's data,
      // but crawler a's commit contains ONLY its own file.
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const committedFiles = execFileSync(
        'git',
        ['show', '--stat', '--format=', 'origin/main'],
        { cwd: repoDir, encoding: 'utf-8' },
      );
      expect(committedFiles).toContain('a.json');
      expect(committedFiles).not.toContain('b.json');
      expect(committedFiles).not.toContain('c.json');
      const aRemote = execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/a.json'], { cwd: repoDir, encoding: 'utf-8' });
      expect(aRemote).toContain('a1');
      const cRemote = execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/c.json'], { cwd: repoDir, encoding: 'utf-8' });
      expect(cRemote).toContain('c1');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('3-way merges a shared tracked file (jobs-ai-cache) when the remote updated it after checkout', () => {
    const { originDir, repoDir } = initClonePair();
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-other-'));

    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs-ai-cache.json'), '{"seed":1}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // Another group's crawler adds ITS ai-cache entry on the remote.
      execFileSync('git', ['clone', '-q', originDir, join(otherDir, 'clone')]);
      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
      execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
      writeFileSync(join(otherClone, 'data/jobs-ai-cache.json'), '{"seed":1,"remoteEntry":2}\n');
      execFileSync('git', ['add', '.'], { cwd: otherClone });
      execFileSync('git', ['commit', '-q', '-m', 'other group: ai-cache'], { cwd: otherClone });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: otherClone });

      // This workspace's crawler also added a DIFFERENT ai-cache entry.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs-ai-cache.json'), '{"seed":1,"localEntry":3}\n');

      runScript(repoDir, 'data/jobs/by-crawler/a.json');

      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const merged = JSON.parse(
        execFileSync('git', ['show', 'origin/main:data/jobs-ai-cache.json'], { cwd: repoDir, encoding: 'utf-8' }),
      );
      // Neither side's concurrent addition may be clobbered.
      expect(merged).toMatchObject({ seed: 1, remoteEntry: 2, localEntry: 3 });
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('commits a brand-new untracked slice file (first-ever run of a crawler in a group)', () => {
    const { originDir, repoDir } = initClonePair();
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/existing.json'), '[]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // New crawler's very first slice: untracked file, no tracked change at
      // all. The legacy whole-tree early-exit would have said "No changes
      // detected" and silently skipped the commit.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/newbie.json'), '[{"id":"n1"}]\n');

      runScript(repoDir, 'data/jobs/by-crawler/newbie.json');

      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const remote = execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/newbie.json'], { cwd: repoDir, encoding: 'utf-8' });
      expect(remote).toContain('n1');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
