// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Legacy mode (no `--slice-only`) always lists the per-crawler DIRECTORIES
 * data/jobs/by-crawler/ and data/jobs-crawler-summaries/by-crawler/ among the
 * paths to stage. The staging filter dropped missing file paths but kept every
 * missing directory path, so in a checkout where one of those directories had
 * never existed `git add` aborted the whole invocation with
 * "fatal: pathspec 'data/jobs/by-crawler/' did not match any files" and nothing
 * was published. That is why `canonicalizes expired routes after a successful
 * stash pop` in git-commit-data-append-only-sets.test.ts was red on every
 * platform since #10088; it never ran in the PR gate because that file is in
 * the live-data inventory. This file is dataset-independent on purpose: every
 * repository lives in a temporary directory, never in the real checkout, so
 * the shared stash of the real repo is never touched.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

interface Harness {
  originDir: string;
  repoDir: string;
  otherDir: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initHarness(): Harness {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-legacy-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-legacy-repo-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'gcd-legacy-other-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir], { stdio: 'ignore' });
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  return { originDir, repoDir, otherDir };
}

function writeFile(dir: string, relPath: string, content: string): void {
  mkdirSync(dirname(join(dir, relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), content);
}

function commitAndPush(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
}

/** Another writer moves origin/main, so the script takes the stash/pop sync. */
function pushRemoteOnlyChange(h: Harness): void {
  const clone = join(h.otherDir, 'clone');
  execFileSync('git', ['clone', '-q', h.originDir, clone]);
  git(clone, 'config', 'user.email', 'other@example.com');
  git(clone, 'config', 'user.name', 'Other');
  writeFile(clone, 'remote-only.txt', 'remote change\n');
  commitAndPush(clone, 'remote non-conflicting update');
}

function runLegacyScript(h: Harness, extraPaths: string[]): string {
  return execFileSync(BASH_BIN, [SCRIPT_PATH, 'test commit', ...extraPaths], {
    cwd: h.repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JOBS_SLICE_FILE: '',
      DATA_PIPELINE_LEASE: '0',
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(h.repoDir, 'no-such-slug-history-summary.txt'),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GITHUB_RUN_ID: '',
      GITHUB_REPOSITORY: '',
      GITHUB_OUTPUT: '',
    },
  });
}

function originFiles(h: Harness): string[] {
  return git(h.originDir, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean).sort();
}

function cleanup(h: Harness): void {
  for (const d of [h.originDir, h.repoDir, h.otherDir]) rmSync(d, { recursive: true, force: true });
}

describe('git-commit-data.sh legacy staging of standard directories', () => {
  it('publishes an explicit path when a standard directory has never existed', () => {
    const h = initHarness();
    const extra = 'data/notes/extra.json';
    try {
      writeFile(h.repoDir, extra, '[]\n');
      commitAndPush(h.repoDir, 'seed');
      pushRemoteOnlyChange(h);
      writeFile(h.repoDir, extra, '["local"]\n');

      expect(existsSync(join(h.repoDir, 'data/jobs/by-crawler'))).toBe(false);
      expect(existsSync(join(h.repoDir, 'data/jobs-crawler-summaries/by-crawler'))).toBe(false);
      runLegacyScript(h, [extra]);

      expect(git(h.originDir, 'show', `main:${extra}`)).toBe('["local"]');
      expect(originFiles(h)).toEqual([extra, 'remote-only.txt']);
    } finally {
      cleanup(h);
    }
  });

  it('still stages the deletion of a tracked standard directory removed from disk', () => {
    const h = initHarness();
    const extra = 'data/notes/extra.json';
    const summary = 'data/jobs-crawler-summaries/by-crawler/acme.json';
    try {
      writeFile(h.repoDir, extra, '[]\n');
      writeFile(h.repoDir, summary, '{}\n');
      commitAndPush(h.repoDir, 'seed');
      pushRemoteOnlyChange(h);
      rmSync(join(h.repoDir, 'data/jobs-crawler-summaries'), { recursive: true, force: true });
      writeFile(h.repoDir, extra, '["local"]\n');

      runLegacyScript(h, [extra]);

      expect(git(h.originDir, 'show', `main:${extra}`)).toBe('["local"]');
      expect(originFiles(h)).toEqual([extra, 'remote-only.txt']);
    } finally {
      cleanup(h);
    }
  });
});
