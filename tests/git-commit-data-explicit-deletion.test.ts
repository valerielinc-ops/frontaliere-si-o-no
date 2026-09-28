// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const ARCHIVE_PATH = 'data/jobs/expired/by-crawler/coop-ticino-locale-cache.json';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initHarness() {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-delete-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-delete-repo-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  mkdirSync(dirname(join(repoDir, ARCHIVE_PATH)), { recursive: true });
  writeFileSync(join(repoDir, ARCHIVE_PATH), '[{"companyKey":"coop-ticino"}]\n');
  git(repoDir, 'add', ARCHIVE_PATH);
  git(repoDir, 'commit', '-q', '-m', 'seed archive');
  git(repoDir, 'push', '-q', 'origin', 'HEAD:main');
  return { originDir, repoDir };
}

function runExtraOnly(repoDir: string) {
  return spawnSync(
    BASH_BIN,
    [SCRIPT_PATH, '--extra-only', 'purge retired archive', ARCHIVE_PATH],
    {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATA_PIPELINE_LEASE: '0',
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
}

describe('git-commit-data.sh --extra-only explicit deletions', () => {
  it('publishes an explicitly requested deletion', () => {
    const { originDir, repoDir } = initHarness();
    try {
      rmSync(join(repoDir, ARCHIVE_PATH));

      const result = runExtraOnly(repoDir);
      const log = `${result.stdout}${result.stderr}`;

      expect(result.status, log).toBe(0);
      expect(log).toContain('Pushed successfully');
      expect(spawnSync('git', ['cat-file', '-e', `main:${ARCHIVE_PATH}`], { cwd: originDir }).status)
        .not.toBe(0);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the remote file changed after the checkout', () => {
    const { originDir, repoDir } = initHarness();
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-delete-other-'));
    try {
      execFileSync('git', ['clone', '-q', originDir, otherDir]);
      git(otherDir, 'config', 'user.email', 'other@example.com');
      git(otherDir, 'config', 'user.name', 'Other');
      writeFileSync(join(otherDir, ARCHIVE_PATH), '[{"companyKey":"coop-ticino","new":true}]\n');
      git(otherDir, 'add', ARCHIVE_PATH);
      git(otherDir, 'commit', '-q', '-m', 'remote archive update');
      git(otherDir, 'push', '-q', 'origin', 'HEAD:main');
      rmSync(join(repoDir, ARCHIVE_PATH));

      const result = runExtraOnly(repoDir);
      const log = `${result.stdout}${result.stderr}`;

      expect(result.status, log).toBe(1);
      expect(log).toContain('delete conflicts with a newer remote blob');
      expect(git(originDir, 'show', `main:${ARCHIVE_PATH}`)).toContain('"new":true');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
