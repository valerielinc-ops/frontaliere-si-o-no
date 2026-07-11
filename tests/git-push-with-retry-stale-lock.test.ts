// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-push-with-retry.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf-8');

// Regression coverage for the sibling of the group-06 incident fix (flagged
// by PR review on #3729): scripts/lib/git-push-with-retry.sh has no flock
// wrapper of its own, but crawl-events.yml invokes it TWICE in one job
// (lines ~119 and ~205, both `continue-on-error: true`), sharing one working
// directory and one `.git`. If the first invocation crashes mid
// commit/rebase and leaves `.git/index.lock` behind, the second invocation's
// git fetch/rebase/stash/reset calls would all hit git's own "Another git
// process seems to be running..." guard and fail too — silently, since both
// steps swallow errors. Same root cause and same fix as
// scripts/lib/git-commit-data.sh: clear a stale index.lock unconditionally
// before any operation.
describe('git-push-with-retry.sh stale .git/index.lock recovery', () => {
  it('removes .git/index.lock before the first git operation', () => {
    const lockCheckIndex = SCRIPT.indexOf('.git/index.lock');
    const setEIndex = SCRIPT.indexOf('set -euo pipefail');
    // The push carries --no-verify (skips the .githooks/pre-push sibling
    // gate — data-refresh pushes to main are not pre-PR dev pushes).
    const firstPushIndex = SCRIPT.search(/\bgit push (--no-verify )?origin\b/);

    expect(firstPushIndex, 'no git push invocation found in git-push-with-retry.sh').toBeGreaterThan(-1);

    expect(lockCheckIndex, 'no .git/index.lock handling found in git-push-with-retry.sh').toBeGreaterThan(-1);
    expect(SCRIPT).toMatch(/if \[ -f "\.git\/index\.lock" \]; then[\s\S]*?rm -f "\.git\/index\.lock"/);

    expect(lockCheckIndex).toBeGreaterThan(setEIndex);
    expect(lockCheckIndex).toBeLessThan(firstPushIndex);
  });

  it('functionally recovers: proceeds past a stale index.lock left by a crashed prior invocation in the same job', () => {
    // Model crawl-events.yml's shape: one working directory, one .git, two
    // sequential invocations of this script within the same job. The first
    // "invocation" crashes mid-operation and leaves .git/index.lock behind;
    // the second invocation must still be able to run git commands.
    const repoDir = mkdtempSync(join(tmpdir(), 'git-push-with-retry-stale-lock-'));
    const remoteDir = mkdtempSync(join(tmpdir(), 'git-push-with-retry-remote-'));
    try {
      execFileSync('git', ['init', '-q', '--bare'], { cwd: remoteDir });

      execFileSync('git', ['clone', '-q', remoteDir, repoDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      writeFileSync(join(repoDir, 'seed.txt'), 'seed\n');
      execFileSync('git', ['add', 'seed.txt'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // Simulate the crashed first invocation in the shared job: it created
      // a local commit (caller contract: commit happens before invoking this
      // script) and the index.lock git itself would hold during a
      // git-mutating step, then died before finishing.
      writeFileSync(join(repoDir, 'first-invocation-output.txt'), 'partial\n');
      execFileSync('git', ['add', 'first-invocation-output.txt'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'first invocation commit'], { cwd: repoDir });
      writeFileSync(join(repoDir, '.git', 'index.lock'), '');

      // Sanity check: without recovery, git itself refuses to proceed on any
      // index-mutating operation (e.g. the `git reset --hard HEAD` the
      // no-conflict-resolver retry path runs before rebasing) — this is
      // exactly what the second crawl-events.yml step would hit.
      expect(() => execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoDir })).not.toThrow();
      expect(() => execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repoDir })).toThrow(/index\.lock/);

      // Extract the actual recovery guard from the shipped script (not a
      // reimplementation) so this test tracks the real fix.
      const guardMatch = SCRIPT.match(/if \[ -f "\.git\/index\.lock" \]; then\n(?:.*\n)*?fi\n/);
      expect(guardMatch, 'could not extract stale-lock guard block from git-push-with-retry.sh').not.toBeNull();
      const guardScript = guardMatch![0];

      // Run the second invocation's critical section: recovery guard, then a
      // real git push, exactly as the second crawl-events.yml step would.
      execFileSync(
        'bash',
        ['-euo', 'pipefail', '-c', `${guardScript}\ngit push origin HEAD:main`],
        { cwd: repoDir },
      );

      const log = execFileSync('git', ['log', '--oneline', 'origin/main'], { cwd: repoDir }).toString();
      expect(log).toContain('first invocation commit');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});
