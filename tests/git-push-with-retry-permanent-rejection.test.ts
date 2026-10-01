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
      expect(output).toMatch(/fetch first/);
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
});
