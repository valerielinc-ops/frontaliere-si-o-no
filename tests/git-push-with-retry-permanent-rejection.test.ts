// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-push-with-retry.sh');

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Local bare remote whose pre-receive hook speaks like GitHub's ruleset
 * (GH013) and counts how many pushes reached it. The remote is a filesystem
 * path, so configure-main-push-auth.sh leaves the origin untouched.
 */
function setupRejectingRemote(hookMessage: string) {
  const root = mkdtempSync(join(tmpdir(), 'git-push-permanent-reject-'));
  const bare = join(root, 'remote.git');
  const local = join(root, 'local');
  const bin = join(root, 'bin');
  const counter = join(root, 'push-count');
  git(root, ['init', '-q', '--bare', '--initial-branch=main', bare]);
  git(root, ['init', '-q', '--initial-branch=main', local]);
  git(local, ['config', 'user.name', 'Test Runner']);
  git(local, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(local, 'data.json'), '{}\n');
  git(local, ['add', 'data.json']);
  git(local, ['commit', '-q', '-m', 'seed']);
  git(local, ['remote', 'add', 'origin', bare]);
  git(local, ['push', '-q', 'origin', 'main']);
  // The main-push guard validates against the checkout's captured remote tip.
  git(local, ['fetch', '-q', 'origin', 'main']);
  writeFileSync(join(local, 'data.json'), '{"fresh":true}\n');
  git(local, ['commit', '-q', '-am', 'snapshot']);

  writeFileSync(counter, '');
  writeFileSync(
    join(bare, 'hooks', 'pre-receive'),
    `#!/bin/sh\necho x >> '${counter}'\necho '${hookMessage}' >&2\nexit 1\n`,
  );
  chmodSync(join(bare, 'hooks', 'pre-receive'), 0o755);

  // The retry loop sleeps between attempts; a no-op sleep keeps the test fast.
  mkdirSync(bin);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'sleep'), 0o755);

  return {
    root,
    local,
    pushes: () => readFileSync(counter, 'utf8').split('\n').filter(Boolean).length,
    run: (args: string[]) => {
      const result = spawnSync('bash', [SCRIPT_PATH, '--branch', 'main', ...args], {
        cwd: local,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_PAT: '', APP_TOKEN: '' },
      });
      return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    },
  };
}

const REJECTION_LIB = resolve(ROOT, 'scripts/lib/git-push-rejection.sh');

/** Runs one function of git-push-rejection.sh on a push transcript. */
function classify(fn: string, output: string) {
  const result = spawnSync('bash', ['-c', `source "${REJECTION_LIB}"; ${fn} "$1"`, 'bash', output], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '' };
}

// The transcript of publisher run 43692928043, job commit-it-dist-history.
const GH001_TRANSCRIPT = [
  'remote: error: Trace: 5d63e3a2e8dd0d3b5c1d7a1b',
  'remote: error: See https://gh.io/lfs for more information.',
  "remote: error: File data/url-first-seen.json is 213.54 MB; this exceeds GitHub's file size limit of 100.00 MB",
  'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.',
  ' ! [remote rejected] HEAD -> main (pre-receive hook declined)',
].join('\n');

describe('git-push-rejection.sh classification', () => {
  it('GH001 / file-size-limit is a permanent rejection, and is named as such', () => {
    expect(classify('git_push_rejection_is_permanent', GH001_TRANSCRIPT).status).toBe(0);
    expect(classify('git_push_rejection_is_file_size', GH001_TRANSCRIPT).status).toBe(0);
    const reason = classify('git_push_rejection_reason', GH001_TRANSCRIPT).stdout;
    expect(reason).toContain('GH001');
    expect(reason).toContain('100 MB');
    expect(reason).not.toContain('GH013');
  });

  it('either line alone is enough (the summary line is not always printed)', () => {
    expect(classify('git_push_rejection_is_permanent', "remote: error: File x is 150 MB; this exceeds GitHub's file size limit of 100.00 MB").status).toBe(0);
    expect(classify('git_push_rejection_is_permanent', 'remote: error: GH001: Large files detected.').status).toBe(0);
  });

  it('GH013 / GH006 stay permanent but are not file-size, and keep their own reason', () => {
    for (const out of ['error: GH013: Repository rule violations found for refs/heads/main.', 'error: GH006: Protected branch update failed']) {
      expect(classify('git_push_rejection_is_permanent', out).status).toBe(0);
      expect(classify('git_push_rejection_is_file_size', out).status).toBe(1);
      expect(classify('git_push_rejection_reason', out).stdout).toContain('declined by a repository rule (GH013/GH006)');
    }
  });

  it('a lost ref race, a hook failure and a transport error are NOT permanent', () => {
    for (const out of [
      ' ! [rejected] HEAD -> main (fetch first)',
      'error: transient hook failure',
      'fatal: unable to access: Could not resolve host',
      'remote: error: cannot lock ref refs/heads/main',
    ]) {
      expect(classify('git_push_rejection_is_permanent', out).status).toBe(1);
    }
  });
});

describe('git-push-with-retry.sh — a repository-rule decline is not a ref race', () => {
  it('fails at the first GH013 instead of rebasing and retrying until the job cap', () => {
    const scenario = setupRejectingRemote(
      'error: GH013: Repository rule violations found for refs/heads/main.',
    );
    try {
      const { status, output } = scenario.run(['--max-attempts', '5']);
      expect(status).toBe(1);
      expect(scenario.pushes()).toBe(1);
      expect(output).toContain('GH013');
      expect(output).toMatch(/::error::Push to main declined by a repository rule/);
      expect(output).not.toMatch(/Push rejected \(attempt/);
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('stays a hard failure under --soft-fail-exhausted: the identity is declined on every run', () => {
    const scenario = setupRejectingRemote(
      'error: GH006: Protected branch update failed for refs/heads/main.',
    );
    try {
      const { status, output } = scenario.run(['--max-attempts', '5', '--soft-fail-exhausted']);
      expect(status).toBe(1);
      expect(scenario.pushes()).toBe(1);
      expect(output).not.toContain('soft-fail');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('stops at the FIRST GH001 (file over 100 MB) with an explicit ::error, instead of rebasing the same blob 5 times', () => {
    // (no apostrophe in the hook text: it is embedded in a single-quoted sh echo)
    const scenario = setupRejectingRemote('remote: error: GH001: Large files detected. You may want to try Git Large File Storage.');
    try {
      const { status, output } = scenario.run(['--max-attempts', '5']);
      expect(status).toBe(1);
      expect(scenario.pushes()).toBe(1);
      expect(output).toContain('GH001');
      expect(output).toMatch(/::error::Push to main refused at attempt 1: a file in the commit exceeds GitHub's 100 MB file size limit \(GH001\)/);
      expect(output).not.toMatch(/Push rejected \(attempt/);
      expect(output).not.toContain('Failed to push after');
      expect(output).not.toMatch(/declined by a repository rule/);
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('GH001 is a hard failure under --soft-fail-exhausted too: the blob does not shrink by itself', () => {
    const scenario = setupRejectingRemote("remote: error: GH001: Large files detected.");
    try {
      const { status, output } = scenario.run(['--max-attempts', '5', '--soft-fail-exhausted']);
      expect(status).toBe(1);
      expect(scenario.pushes()).toBe(1);
      expect(output).not.toContain('soft-fail');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('still treats a lost ref race (fetch first) as retryable and lands the push', () => {
    const scenario = setupRejectingRemote('unused');
    try {
      // No rule hook here: another writer advances main first, so the first
      // push is a plain `! [rejected] … (fetch first)`.
      rmSync(join(scenario.root, 'remote.git', 'hooks', 'pre-receive'));
      const other = join(scenario.root, 'other');
      git(scenario.root, ['clone', '-q', join(scenario.root, 'remote.git'), other]);
      git(other, ['config', 'user.name', 'Other Writer']);
      git(other, ['config', 'user.email', 'other@example.invalid']);
      writeFileSync(join(other, 'other.json'), '{}\n');
      git(other, ['add', 'other.json']);
      git(other, ['commit', '-q', '-m', 'concurrent writer']);
      git(other, ['push', '-q', 'origin', 'main']);

      const { status, output } = scenario.run(['--max-attempts', '3']);
      expect(status, output).toBe(0);
      expect(output).toMatch(/stale info|fetch first/);
      expect(output).toMatch(/Push rejected \(attempt 1\/3\)/);
      expect(output).not.toMatch(/declined by a repository rule/);
      expect(git(scenario.local, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0])
        .toBe(git(scenario.local, ['rev-parse', 'HEAD']));
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('still retries an ordinary declined push up to --max-attempts', () => {
    const scenario = setupRejectingRemote('error: transient hook failure');
    try {
      const { status, output } = scenario.run(['--max-attempts', '3']);
      expect(status).toBe(1);
      expect(scenario.pushes()).toBe(3);
      expect(output).toContain('Failed to push after 3 attempts');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('rebases when the refreshed local base makes the candidate look stale', () => {
    const scenario = setupRejectingRemote('unused');
    try {
      rmSync(join(scenario.root, 'remote.git', 'hooks', 'pre-receive'));
      const other = join(scenario.root, 'other');
      git(scenario.root, ['clone', '-q', join(scenario.root, 'remote.git'), other]);
      git(other, ['config', 'user.name', 'Other Writer']);
      git(other, ['config', 'user.email', 'other@example.invalid']);
      writeFileSync(join(other, 'other.json'), '{}\n');
      git(other, ['add', 'other.json']);
      git(other, ['commit', '-q', '-m', 'concurrent writer']);
      git(other, ['push', '-q', 'origin', 'main']);

      // This is the state observed in the failing workflow: the candidate was
      // committed from the old tip, then the retry helper refreshed its local
      // origin/main before invoking the guarded push.
      git(scenario.local, ['fetch', '-q', 'origin', 'main']);

      const { status, output } = scenario.run(['--max-attempts', '3']);
      expect(status, output).toBe(0);
      expect(output).toContain('candidate');
      expect(output).toMatch(/Push rejected \(attempt 1\/3\)|Rebase/);
      expect(git(scenario.local, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0])
        .toBe(git(scenario.local, ['rev-parse', 'HEAD']));
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });
});
