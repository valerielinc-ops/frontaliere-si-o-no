// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');

// The script uses `declare -A` (associative arrays), requiring bash 4+.
// CI (ubuntu-latest) ships bash 5 as the default `bash`. macOS ships bash 3.2
// as the default `/bin/bash` for licensing reasons — prefer a Homebrew bash
// if present so this test also runs for real on a macOS dev machine.
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

// Regression coverage for cross-crawler commit misattribution: crawler-group
// workflows (post-#3701) run ~25 sibling crawlers concurrently against ONE
// shared checkout. Confirmed live on run 28852047487 — the SPITEX BASEL
// crawler's "Commit and push" step swept in and committed 5 siblings' dirty
// slice files (lindt-spruengli, sonarsource, stadt-luzern, usz, vista) under
// a commit attributed to "SPITEX BASEL" alone, because --slice-only mode's
// STANDARD_FILES staged whole shared directories (`data/jobs/by-crawler/`)
// rather than this crawler's own file. The fix scopes staging to exactly the
// invoking crawler's own file via JOBS_SLICE_FILE (already exported into every
// crawler-group background step's env for the crawler's own pipeline).
describe('git-commit-data.sh --slice-only scoping via JOBS_SLICE_FILE', () => {
  it('commits only the invoking crawler\'s own slice, leaving a concurrently-dirty sibling slice uncommitted', () => {
    const originDir = mkdtempSync(join(tmpdir(), 'git-commit-data-origin-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'git-commit-data-repo-'));

    try {
      // --initial-branch=main: for an empty repo, git's smart-protocol symref
      // advertisement means the SERVER's (origin's) default-branch name wins
      // on clone, regardless of the client's own init.defaultBranch config —
      // so this must be set on the bare origin itself, not on the clone. Machine/
      // CI-image default-branch naming varies (some default to 'master'), but
      // the script below pushes explicitly to 'main', so origin's one real
      // branch must actually be named 'main'.
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
      execFileSync('git', ['clone', '-q', originDir, repoDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // Simulate two sibling crawlers, both mid-run in the same shared
      // checkout: crawler "a" (the one invoking git-commit-data.sh below) and
      // crawler "b" (a sibling that has already written its own slice but not
      // yet reached its own commit step).
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[{"id":"b1"}]\n');

      // Real script, not a reimplementation — tracks the actual shipped fix.
      execFileSync(
        BASH_BIN,
        [SCRIPT_PATH, '--slice-only', 'test commit'],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JOBS_SLICE_FILE: 'data/jobs/by-crawler/a.json',
            SKIP_AI_TRANSLATION: '1',
            SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            GITHUB_RUN_ID: '',
            GITHUB_REPOSITORY: '',
            GITHUB_OUTPUT: '',
          },
        },
      );

      // Assert on the PUSHED commit (origin/main), not local HEAD: the
      // grouped-isolated path deliberately never advances local refs (the
      // job's checkout must stay the 3-way merge base for later siblings),
      // so HEAD still points at the seed commit after a successful push.
      const committedFiles = execFileSync(
        'git',
        ['show', '--stat', '--format=', 'origin/main'],
        { cwd: repoDir, encoding: 'utf-8' },
      );
      expect(committedFiles).toContain('a.json');
      expect(committedFiles).not.toContain('b.json');

      // Sibling's own dirty file must survive untouched in the working tree,
      // ready for its own crawler's later commit step to pick up.
      const status = execFileSync('git', ['status', '--short'], { cwd: repoDir, encoding: 'utf-8' });
      expect(status).toContain('b.json');
      expect(readFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), 'utf-8')).toContain('b1');

      // Pushed successfully; origin/main reflects the scoped commit.
      const originLog = execFileSync(
        'git',
        ['log', '-1', '--format=%s', 'origin/main'],
        { cwd: repoDir, encoding: 'utf-8' },
      );
      expect(originLog.trim()).toBe('test commit');

      // Regression (review of the isolated path): local refs must NOT be
      // fast-forwarded after the push. Advancing refs/heads/main would shift
      // the 3-way merge base for LATER siblings of the same run, making a
      // mid-run remote change to their files look base-identical — skipping
      // the merge and silently reverting it with the stale worktree copy.
      const localMain = execFileSync(
        'git',
        ['rev-parse', 'refs/heads/main'],
        { cwd: repoDir, encoding: 'utf-8' },
      ).trim();
      const pushedSha = execFileSync(
        'git',
        ['rev-parse', 'origin/main'],
        { cwd: repoDir, encoding: 'utf-8' },
      ).trim();
      expect(localMain).not.toBe(pushedSha);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('falls back to directory-wide staging when JOBS_SLICE_FILE is unset (e.g. translate-pending.yml)', () => {
    const originDir = mkdtempSync(join(tmpdir(), 'git-commit-data-origin-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'git-commit-data-repo-'));

    try {
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
      execFileSync('git', ['clone', '-q', originDir, repoDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

      // Legacy fallback stages whole directories (`git add data/jobs/expired/
      // by-crawler/`), which only works if the directory already exists on
      // disk — true in the real repo (tracked, populated by other crawlers)
      // even when this specific fixture doesn't need those files itself.
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs/expired/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/translation-cache'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/expired/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/translation-cache/.gitkeep'), '');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[{"id":"b1"}]\n');

      execFileSync(
        BASH_BIN,
        [SCRIPT_PATH, '--slice-only', 'test commit'],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JOBS_SLICE_FILE: '',
            SKIP_AI_TRANSLATION: '1',
            SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            GITHUB_RUN_ID: '',
            GITHUB_REPOSITORY: '',
            GITHUB_OUTPUT: '',
          },
        },
      );

      // Assert on the PUSHED commit (origin/main), not local HEAD: the
      // grouped-isolated path deliberately never advances local refs (the
      // job's checkout must stay the 3-way merge base for later siblings),
      // so HEAD still points at the seed commit after a successful push.
      const committedFiles = execFileSync(
        'git',
        ['show', '--stat', '--format=', 'origin/main'],
        { cwd: repoDir, encoding: 'utf-8' },
      );
      expect(committedFiles).toContain('a.json');
      expect(committedFiles).toContain('b.json');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not resurrect a slice deleted upstream after a stale writer checkout', () => {
    const originDir = mkdtempSync(join(tmpdir(), 'git-commit-data-origin-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'git-commit-data-repo-'));
    const concurrentDir = mkdtempSync(join(tmpdir(), 'git-commit-data-concurrent-'));

    try {
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
      execFileSync('git', ['clone', '-q', originDir, repoDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs/expired/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/translation-cache'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/active.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/retired.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/expired/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/translation-cache/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/translation-cache/retired.json'), '{}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // The sequential writer keeps running on this checkout and modifies both
      // slices. Meanwhile another actor retires one of them on origin/main.
      execFileSync('git', ['clone', '-q', originDir, concurrentDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: concurrentDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: concurrentDir });
      execFileSync('git', ['rm', '-q', 'data/jobs/by-crawler/retired.json'], { cwd: concurrentDir });
      execFileSync('git', ['rm', '-q', 'data/translation-cache/retired.json'], { cwd: concurrentDir });
      execFileSync('git', ['commit', '-q', '-m', 'retire slice'], { cwd: concurrentDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: concurrentDir });

      writeFileSync(join(repoDir, 'data/jobs/by-crawler/active.json'), '[{"id":"active-1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/retired.json'), '[{"id":"stale-1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/fresh.json'), '[{"id":"fresh-1"}]\n');
      writeFileSync(join(repoDir, 'data/translation-cache/retired.json'), '{"stale":true}\n');

      execFileSync(
        BASH_BIN,
        [SCRIPT_PATH, '--slice-only', 'stale writer commit'],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            JOBS_SLICE_FILE: '',
            SKIP_AI_TRANSLATION: '1',
            SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            GITHUB_RUN_ID: '',
            GITHUB_REPOSITORY: '',
            GITHUB_OUTPUT: '',
          },
        },
      );

      expect(readFileSync(join(repoDir, 'data/jobs/by-crawler/retired.json'), 'utf8'))
        .toContain('stale-1');
      expect(execFileSync(
        'git',
        ['show', 'origin/main:data/jobs/by-crawler/active.json'],
        { cwd: repoDir, encoding: 'utf8' },
      )).toContain('active-1');
      expect(execFileSync(
        'git',
        ['show', 'origin/main:data/jobs/by-crawler/fresh.json'],
        { cwd: repoDir, encoding: 'utf8' },
      )).toContain('fresh-1');
      expect(() => execFileSync(
        'git',
        ['cat-file', '-e', 'origin/main:data/jobs/by-crawler/retired.json'],
        { cwd: repoDir, stdio: 'pipe' },
      )).toThrow();
      // The retirement guard is deliberately limited to active/expired job
      // slices. Non-slice consumers retain their pre-existing merge behavior
      // instead of inheriting an unreviewed global delete-wins policy.
      expect(execFileSync(
        'git',
        ['show', 'origin/main:data/translation-cache/retired.json'],
        { cwd: repoDir, encoding: 'utf8' },
      )).toContain('stale');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(concurrentDir, { recursive: true, force: true });
    }
  });
});
