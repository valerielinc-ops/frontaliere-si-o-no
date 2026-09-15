// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-push-with-retry.sh');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function configureRepo(cwd: string): void {
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
}

describe('git-push-with-retry.sh --stash-dirty', () => {
  it('keeps generated WIP when the rebased tree changed the same path', () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-remote-'));
    const seedDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-seed-'));
    const localDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-local-'));
    const remoteWriterDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-writer-'));
    const wrapDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-wrap-'));
    const sentinel = join(wrapDir, 'first-push-rejected');
    try {
      git(remoteDir, ['init', '-q', '--bare']);

      git(seedDir, ['init', '-q']);
      configureRepo(seedDir);
      writeFileSync(join(seedDir, 'generated.txt'), 'seed\n');
      git(seedDir, ['add', 'generated.txt']);
      git(seedDir, ['commit', '-q', '-m', 'seed']);
      git(seedDir, ['remote', 'add', 'origin', remoteDir]);
      git(seedDir, ['push', '-q', 'origin', 'HEAD:main']);

      git(localDir, ['clone', '-q', '--branch', 'main', remoteDir, '.']);
      configureRepo(localDir);
      git(remoteWriterDir, ['clone', '-q', '--branch', 'main', remoteDir, '.']);
      configureRepo(remoteWriterDir);

      // The remote advances the generated file while the build's local WIP
      // still contains the output that later steps need.
      writeFileSync(join(remoteWriterDir, 'generated.txt'), 'remote build\n');
      git(remoteWriterDir, ['add', 'generated.txt']);
      git(remoteWriterDir, ['commit', '-q', '-m', 'remote generated output']);
      git(remoteWriterDir, ['push', '-q', 'origin', 'HEAD:main']);

      writeFileSync(join(localDir, 'history.txt'), 'local history commit\n');
      git(localDir, ['add', 'history.txt']);
      git(localDir, ['commit', '-q', '-m', 'local history']);
      writeFileSync(join(localDir, 'generated.txt'), 'local build output\n');

      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const wrapperPath = join(wrapDir, 'git');
      writeFileSync(
        wrapperPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "push" ] && [ ! -f "\${GIT_PUSH_RETRY_SENTINEL}" ]; then
  : > "\${GIT_PUSH_RETRY_SENTINEL}"
  echo "simulated first push rejection" >&2
  exit 1
fi
exec "\${GIT_PUSH_RETRY_REAL_GIT}" "$@"
`,
      );
      execFileSync('chmod', ['+x', wrapperPath]);

      const output = execFileSync('bash', [SCRIPT_PATH, '--max-attempts', '2', '--stash-dirty'], {
        cwd: localDir,
        env: {
          ...process.env,
          PATH: `${wrapDir}:${process.env.PATH || ''}`,
          GIT_PUSH_RETRY_REAL_GIT: realGit,
          GIT_PUSH_RETRY_SENTINEL: sentinel,
        },
        encoding: 'utf8',
      });

      expect(output).toContain('Stashed working tree restored after resolving generated-file conflicts');
      expect(git(remoteDir, ['show', 'refs/heads/main:history.txt'])).toBe('local history commit\n');
      expect(git(remoteDir, ['show', 'refs/heads/main:generated.txt'])).toBe('remote build\n');
      expect(readFileSync(join(localDir, 'generated.txt'), 'utf8')).toBe('local build output\n');
      expect(git(localDir, ['status', '--porcelain'])).toContain(' M generated.txt');
      expect(git(localDir, ['stash', 'list'])).toBe('');
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
      rmSync(remoteWriterDir, { recursive: true, force: true });
      rmSync(wrapDir, { recursive: true, force: true });
    }
  });

  it('keeps the stash when an untracked WIP path cannot be restored', () => {
    const remoteDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-mixed-remote-'));
    const seedDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-mixed-seed-'));
    const localDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-mixed-local-'));
    const remoteWriterDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-mixed-writer-'));
    const wrapDir = mkdtempSync(join(tmpdir(), 'git-push-retry-stash-mixed-wrap-'));
    const sentinel = join(wrapDir, 'first-push-rejected');
    try {
      git(remoteDir, ['init', '-q', '--bare']);

      git(seedDir, ['init', '-q']);
      configureRepo(seedDir);
      writeFileSync(join(seedDir, 'generated.txt'), 'seed\n');
      git(seedDir, ['add', 'generated.txt']);
      git(seedDir, ['commit', '-q', '-m', 'seed']);
      git(seedDir, ['remote', 'add', 'origin', remoteDir]);
      git(seedDir, ['push', '-q', 'origin', 'HEAD:main']);

      git(localDir, ['clone', '-q', '--branch', 'main', remoteDir, '.']);
      configureRepo(localDir);
      git(remoteWriterDir, ['clone', '-q', '--branch', 'main', remoteDir, '.']);
      configureRepo(remoteWriterDir);

      writeFileSync(join(remoteWriterDir, 'generated.txt'), 'remote build\n');
      writeFileSync(join(remoteWriterDir, 'artifact.txt'), 'remote artifact\n');
      git(remoteWriterDir, ['add', 'generated.txt', 'artifact.txt']);
      git(remoteWriterDir, ['commit', '-q', '-m', 'remote generated output']);
      git(remoteWriterDir, ['push', '-q', 'origin', 'HEAD:main']);

      writeFileSync(join(localDir, 'history.txt'), 'local history commit\n');
      git(localDir, ['add', 'history.txt']);
      git(localDir, ['commit', '-q', '-m', 'local history']);
      writeFileSync(join(localDir, 'generated.txt'), 'local build output\n');
      writeFileSync(join(localDir, 'artifact.txt'), 'local untracked artifact\n');

      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const wrapperPath = join(wrapDir, 'git');
      writeFileSync(
        wrapperPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "push" ] && [ ! -f "\${GIT_PUSH_RETRY_SENTINEL}" ]; then
  : > "\${GIT_PUSH_RETRY_SENTINEL}"
  echo "simulated first push rejection" >&2
  exit 1
fi
exec "\${GIT_PUSH_RETRY_REAL_GIT}" "$@"
`,
      );
      execFileSync('chmod', ['+x', wrapperPath]);

      let status = 0;
      let output = '';
      try {
        execFileSync('bash', [SCRIPT_PATH, '--max-attempts', '2', '--stash-dirty'], {
          cwd: localDir,
          env: {
            ...process.env,
            PATH: `${wrapDir}:${process.env.PATH || ''}`,
            GIT_PUSH_RETRY_REAL_GIT: realGit,
            GIT_PUSH_RETRY_SENTINEL: sentinel,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
        status = typeof e.status === 'number' ? e.status : 1;
        output = `${e.stdout || ''}${e.stderr || ''}`;
      }

      expect(status).toBeGreaterThan(0);
      expect(output).toContain('Stashed working tree includes an untracked path that could not be restored');
      expect(git(localDir, ['stash', 'list'])).toContain('git-push-with-retry-wip');
      expect(readFileSync(join(localDir, 'artifact.txt'), 'utf8')).toBe('remote artifact\n');
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
      rmSync(remoteWriterDir, { recursive: true, force: true });
      rmSync(wrapDir, { recursive: true, force: true });
    }
  });
});
