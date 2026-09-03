// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const CRAWLER_ROSTER = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/ci/crawler-generation-roster.json'), 'utf8'),
) as { primarySlices: Record<string, string> };
const [REGISTERED_SLICE_PATH, NEW_REGISTERED_SLICE_PATH] = Object.values(CRAWLER_ROSTER.primarySlices);
if (!REGISTERED_SLICE_PATH || !NEW_REGISTERED_SLICE_PATH) {
  throw new Error('crawler generation roster has fewer than two primary slices');
}
const REGISTERED_SLICE_FILE = basename(REGISTERED_SLICE_PATH);

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

  it('preserves an unregistered retirement while allowing a registered base-absent create', () => {
    const originDir = mkdtempSync(join(tmpdir(), 'git-commit-data-origin-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'git-commit-data-repo-'));
    const concurrentDir = mkdtempSync(join(tmpdir(), 'git-commit-data-concurrent-'));
    const postRetirementDir = mkdtempSync(join(tmpdir(), 'git-commit-data-post-retirement-'));

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
      writeFileSync(join(repoDir, NEW_REGISTERED_SLICE_PATH), '[{"id":"fresh-1"}]\n');
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
        ['show', `origin/main:${NEW_REGISTERED_SLICE_PATH}`],
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

      // A writer starting only after retirement has no base blob. Registry
      // absence must still distinguish the retired path from a genuine new,
      // registered crawler slice.
      execFileSync('git', ['clone', '-q', originDir, postRetirementDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: postRetirementDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: postRetirementDir });
      writeFileSync(
        join(postRetirementDir, 'data/jobs/by-crawler/retired.json'),
        '[{"id":"post-retirement-resurrection"}]\n',
      );
      execFileSync(
        BASH_BIN,
        [SCRIPT_PATH, '--slice-only', 'post-retirement writer'],
        {
          cwd: postRetirementDir,
          env: {
            ...process.env,
            JOBS_SLICE_FILE: '',
            SKIP_AI_TRANSLATION: '1',
            SLUG_HISTORY_SUMMARY_FILE: join(postRetirementDir, 'no-such-slug-history-summary.txt'),
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            GITHUB_RUN_ID: '',
            GITHUB_REPOSITORY: '',
            GITHUB_OUTPUT: '',
          },
        },
      );
      expect(() => execFileSync(
        'git',
        ['cat-file', '-e', 'origin/main:data/jobs/by-crawler/retired.json'],
        { cwd: postRetirementDir, stdio: 'pipe' },
      )).toThrow();
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(concurrentDir, { recursive: true, force: true });
      rmSync(postRetirementDir, { recursive: true, force: true });
    }
  });

  it('treats an unregistered path with no prior history as a first-run create, not a retirement', () => {
    // Regression for issue #7221: a fresh CI checkout always starts from the
    // current origin/main tree, so an absent `base_blob` alone cannot tell a
    // genuinely brand-new (not-yet-registered) slice apart from one that was
    // already retired before this checkout existed — both look identical at
    // the tree level. Only reachable git history disambiguates them.
    const originDir = mkdtempSync(join(tmpdir(), 'git-commit-data-origin-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'git-commit-data-repo-'));
    const NEW_UNREGISTERED_SLICE_PATH = 'data/jobs/by-crawler/unregistered-new.json';

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
      writeFileSync(join(repoDir, 'data/jobs/expired/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/translation-cache/.gitkeep'), '');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // NEW_UNREGISTERED_SLICE_PATH never appears in the seed commit, so it
      // has no base_blob AND no reachable history — a genuine first-run
      // create for a crawler the roster doesn't know about yet.
      writeFileSync(
        join(repoDir, NEW_UNREGISTERED_SLICE_PATH),
        '[{"id":"unregistered-new-1"}]\n',
      );

      execFileSync(
        BASH_BIN,
        [SCRIPT_PATH, '--slice-only', 'unregistered first-run create'],
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

      expect(execFileSync(
        'git',
        ['show', `origin/main:${NEW_UNREGISTERED_SLICE_PATH}`],
        { cwd: repoDir, encoding: 'utf8' },
      )).toContain('unregistered-new-1');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('preserves a retirement older than the checkout\'s shallow depth instead of resurrecting it', () => {
    // Regression for the #7221 review follow-up: crawler-group workflows
    // checkout with `fetch-depth: 50`, so `git log` on that checkout only
    // sees the last 50 reachable commits and silently returns empty beyond
    // that boundary — indistinguishable from a path that never existed. A
    // shallow clone here reproduces that truncation with a depth of 1
    // instead of 50 so the test doesn't need 50+ filler commits.
    const originDir = mkdtempSync(join(tmpdir(), 'git-commit-data-origin-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'git-commit-data-repo-'));
    const shallowDir = mkdtempSync(join(tmpdir(), 'git-commit-data-shallow-'));
    const UNREGISTERED_RETIRED_PATH = 'data/jobs/by-crawler/shallow-retired.json';

    try {
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
      execFileSync('git', ['clone', '-q', originDir, repoDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs/expired/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/translation-cache'), { recursive: true });
      writeFileSync(join(repoDir, UNREGISTERED_RETIRED_PATH), '[{"id":"shallow-retired-1"}]\n');
      // Kept alongside the retired slice so `data/jobs/by-crawler/` still
      // exists in the shallow checkout after retirement — git doesn't track
      // empty directories, and this test needs the dir present to write the
      // (would-be) resurrection attempt into it below.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/keep.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/expired/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/translation-cache/.gitkeep'), '');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed with unregistered slice'], { cwd: repoDir });

      execFileSync('git', ['rm', '-q', UNREGISTERED_RETIRED_PATH], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'retire unregistered slice'], { cwd: repoDir });

      // Filler commits push the retirement commit outside a --depth 1 clone.
      writeFileSync(join(repoDir, 'data/translation-cache/filler.json'), '{}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'filler after retirement'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${originDir}`, shallowDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: shallowDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: shallowDir });
      expect(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: shallowDir, encoding: 'utf8' }).trim())
        .toBe('true');
      expect(execFileSync(
        'git',
        ['log', '-1', '--format=%H', '--', UNREGISTERED_RETIRED_PATH],
        { cwd: shallowDir, encoding: 'utf8' },
      ).trim()).toBe('');

      writeFileSync(
        join(shallowDir, UNREGISTERED_RETIRED_PATH),
        '[{"id":"shallow-post-retirement-resurrection"}]\n',
      );
      execFileSync(
        BASH_BIN,
        [SCRIPT_PATH, '--slice-only', 'shallow-checkout writer'],
        {
          cwd: shallowDir,
          env: {
            ...process.env,
            JOBS_SLICE_FILE: '',
            SKIP_AI_TRANSLATION: '1',
            SLUG_HISTORY_SUMMARY_FILE: join(shallowDir, 'no-such-slug-history-summary.txt'),
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            GITHUB_RUN_ID: '',
            GITHUB_REPOSITORY: '',
            GITHUB_OUTPUT: '',
          },
        },
      );

      expect(() => execFileSync(
        'git',
        ['cat-file', '-e', `origin/main:${UNREGISTERED_RETIRED_PATH}`],
        { cwd: shallowDir, stdio: 'pipe' },
      )).toThrow();
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(shallowDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a still-registered primary slice disappears upstream', () => {
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
      writeFileSync(join(repoDir, REGISTERED_SLICE_PATH), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/expired/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/jobs-crawler-summaries/by-crawler/.gitkeep'), '');
      writeFileSync(join(repoDir, 'data/translation-cache/.gitkeep'), '');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      execFileSync('git', ['clone', '-q', originDir, concurrentDir]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: concurrentDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: concurrentDir });
      execFileSync('git', ['rm', '-q', REGISTERED_SLICE_PATH], { cwd: concurrentDir });
      execFileSync('git', ['commit', '-q', '-m', 'accidental remote deletion'], { cwd: concurrentDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: concurrentDir });

      writeFileSync(
        join(repoDir, REGISTERED_SLICE_PATH),
        `[{"id":"${REGISTERED_SLICE_FILE}-updated"}]\n`,
      );

      const malformedRosterPath = join(repoDir, 'malformed-crawler-roster.json');
      writeFileSync(malformedRosterPath, JSON.stringify({ primarySlices: {} }));
      for (const invalidRosterPath of [join(repoDir, 'missing-crawler-roster.json'), malformedRosterPath]) {
        let invalidRosterOutput = '';
        expect(() => {
          try {
            execFileSync(
              BASH_BIN,
              [SCRIPT_PATH, '--slice-only', 'invalid roster writer'],
              {
                cwd: repoDir,
                env: {
                  ...process.env,
                  CRAWLER_GENERATION_ROSTER_FILE: invalidRosterPath,
                  JOBS_SLICE_FILE: '',
                  SKIP_AI_TRANSLATION: '1',
                  SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
                  GH_TOKEN: '',
                  GITHUB_TOKEN: '',
                  GITHUB_RUN_ID: '',
                  GITHUB_REPOSITORY: '',
                  GITHUB_OUTPUT: '',
                },
                stdio: 'pipe',
              },
            );
          } catch (error) {
            const failure = error as { stdout?: Buffer; stderr?: Buffer };
            invalidRosterOutput = `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`;
            throw error;
          }
        }).toThrow();
        expect(invalidRosterOutput).toContain('cannot validate primary slice registry');
      }

      let failureOutput = '';
      expect(() => {
        try {
          execFileSync(
            BASH_BIN,
            [SCRIPT_PATH, '--slice-only', 'registered slice writer'],
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
              stdio: 'pipe',
            },
          );
        } catch (error) {
          const failure = error as { stdout?: Buffer; stderr?: Buffer };
          failureOutput = `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`;
          throw error;
        }
      }).toThrow();
      expect(failureOutput).toContain(
        `${REGISTERED_SLICE_PATH} disappeared upstream but remains in crawler-generation-roster.json`,
      );

      expect(() => execFileSync(
        'git',
        ['cat-file', '-e', `origin/main:${REGISTERED_SLICE_PATH}`],
        { cwd: repoDir, stdio: 'pipe' },
      )).toThrow();
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(concurrentDir, { recursive: true, force: true });
    }
  });
});
