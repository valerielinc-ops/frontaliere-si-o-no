// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * HEAD never advances after a push (it is the 3-way merge base for the whole
 * run), so a directory path expands on every later commit to ALL the slices
 * touched since the run began, including those already published. Corpus run
 * 37272320066 spent ~1766 s in six commits re-merging 230-371 files each for
 * 1-2 real changes. Files byte-identical to origin/main are now skipped.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const SLICE_DIR = 'data/jobs/by-crawler';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function slice(key: string, jobs: Array<Record<string, unknown>>) {
  return `${JSON.stringify({ companyKey: key, jobs }, null, 2)}\n`;
}
function job(key: string, n: number, extra: Record<string, unknown> = {}) {
  return { url: `https://jobs.example.com/${key}/${n}`, title: `Job ${key}${n}`, ...extra };
}

function setup(keys: string[]) {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-skip-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-skip-repo-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'gcd-skip-other-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  mkdirSync(join(repoDir, SLICE_DIR), { recursive: true });
  for (const key of keys) writeFileSync(join(repoDir, SLICE_DIR, `${key}.json`), slice(key, [job(key, 1), job(key, 2)]));
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-q', '-m', 'seed');
  git(repoDir, 'push', '-q', 'origin', 'HEAD:main');
  const run = () => {
    const r = spawnSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'translate commit', `${SLICE_DIR}/`], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        MAX_PUSH_ATTEMPTS: '3',
        SKIP_AI_TRANSLATION: '1',
        SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
        JOBS_HOUSEKEEPING_PROOF_DIR: join(originDir, 'no-proofs'),
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        GITHUB_RUN_ID: '',
        GITHUB_REPOSITORY: '',
        GITHUB_OUTPUT: '',
      },
    });
    return { status: r.status, log: `${r.stdout}${r.stderr}` };
  };
  const cleanup = () => {
    for (const dir of [originDir, repoDir, otherDir]) rmSync(dir, { recursive: true, force: true });
  };
  return { originDir, repoDir, otherDir, run, cleanup };
}

const edit = (repoDir: string, key: string, tag: string) =>
  writeFileSync(
    join(repoDir, SLICE_DIR, `${key}.json`),
    slice(key, [job(key, 1, { titleByLocale: { en: tag } }), job(key, 2)]),
  );

describe('git-commit-data: files identical to origin/main are skipped', () => {
  it('commits only the slice that really changed after an earlier commit of the same run', () => {
    const t = setup(['a', 'b', 'c']);
    try {
      edit(t.repoDir, 'a', 'A1');
      edit(t.repoDir, 'b', 'B1');
      const first = t.run();
      expect(first.status, first.log).toBe(0);
      expect(first.log).toContain('0 file(s) skipped because identical to origin/main, 2 candidate(s)');

      // HEAD is unchanged: a and b still differ from it, but are on origin/main.
      edit(t.repoDir, 'c', 'C1');
      const second = t.run();
      expect(second.status, second.log).toBe(0);
      expect(second.log).toContain('2 file(s) skipped because identical to origin/main, 1 candidate(s)');
      expect(second.log).toContain('Pushed successfully');

      git(t.repoDir, 'fetch', '-q', 'origin', 'main');
      expect(git(t.repoDir, 'diff', '--name-only', 'origin/main~1', 'origin/main')).toBe(`${SLICE_DIR}/c.json`);
    } finally {
      t.cleanup();
    }
  });

  it('does not push when every slice is already identical to origin/main', () => {
    const t = setup(['a', 'b']);
    try {
      edit(t.repoDir, 'a', 'A1');
      edit(t.repoDir, 'b', 'B1');
      expect(t.run().status).toBe(0);
      git(t.repoDir, 'fetch', '-q', 'origin', 'main');
      const before = git(t.repoDir, 'rev-parse', 'origin/main');

      const again = t.run();
      expect(again.status, again.log).toBe(0);
      expect(again.log).toContain('2 file(s) skipped because identical to origin/main, 0 candidate(s)');
      expect(again.log).toContain('nothing to commit');
      expect(again.log).not.toContain('Pushed successfully');
      git(t.repoDir, 'fetch', '-q', 'origin', 'main');
      expect(git(t.repoDir, 'rev-parse', 'origin/main')).toBe(before);
    } finally {
      t.cleanup();
    }
  });

  it('keeps another writer\'s newer edit of a different slice when ours is skipped', () => {
    const t = setup(['a', 'b', 'c']);
    try {
      edit(t.repoDir, 'a', 'A1');
      expect(t.run().status).toBe(0);

      // Another writer lands a newer version of b on main.
      execFileSync('git', ['clone', '-q', t.originDir, join(t.otherDir, 'clone')]);
      const other = join(t.otherDir, 'clone');
      git(other, 'config', 'user.email', 'other@example.com');
      git(other, 'config', 'user.name', 'Other');
      writeFileSync(join(other, SLICE_DIR, 'b.json'), slice('b', [job('b', 1, { title: 'Job b1 (remote edit)' }), job('b', 2)]));
      git(other, 'commit', '-q', '-am', 'other writer: b');
      git(other, 'push', '-q', 'origin', 'HEAD:main');

      edit(t.repoDir, 'c', 'C1');
      const second = t.run();
      expect(second.status, second.log).toBe(0);
      expect(second.log).toContain('1 file(s) skipped because identical to origin/main, 1 candidate(s)');

      git(t.repoDir, 'fetch', '-q', 'origin', 'main');
      const remote = (key: string) => JSON.parse(git(t.repoDir, 'show', `origin/main:${SLICE_DIR}/${key}.json`));
      expect(remote('b').jobs[0].title).toBe('Job b1 (remote edit)');
      expect(remote('a').jobs[0].titleByLocale).toEqual({ en: 'A1' });
      expect(remote('c').jobs[0].titleByLocale).toEqual({ en: 'C1' });
    } finally {
      t.cleanup();
    }
  });
});
