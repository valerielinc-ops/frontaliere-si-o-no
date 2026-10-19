// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/lib/main-push-guard.mjs');
const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function runGuard(repo: string, args: string[], env = process.env) {
  const result = spawnSync(process.execPath, [SCRIPT, '--repo', repo, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function setupRepository() {
  const root = mkdtempSync(join(tmpdir(), 'main-push-guard-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const writer = join(root, 'writer');
  mkdirSync(writer);
  git(root, ['init', '-q', '--bare', '--initial-branch=main', origin]);
  git(writer, ['init', '-q', '--initial-branch=main']);
  git(writer, ['config', 'user.name', 'Guard Test']);
  git(writer, ['config', 'user.email', 'guard-test@example.invalid']);
  for (let index = 0; index < 8; index += 1) {
    const file = join(writer, `tracked-${index}.txt`);
    writeFileSync(file, `seed-${index}\n`);
  }
  git(writer, ['add', '.']);
  git(writer, ['commit', '-q', '-m', 'seed main']);
  git(writer, ['remote', 'add', 'origin', origin]);
  git(writer, ['push', '-q', '-u', 'origin', 'main']);
  git(writer, ['fetch', '-q', 'origin', 'main']);
  return { root, origin, writer, base: git(writer, ['rev-parse', 'origin/main']).trim() };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('main-push-guard.mjs', () => {
  it('rejects a descendant whose tree collapses to a tiny subset of main', () => {
    const scenario = setupRepository();
    for (let index = 1; index < 8; index += 1) {
      rmSync(join(scenario.writer, `tracked-${index}.txt`));
    }
    git(scenario.writer, ['add', '-A']);
    git(scenario.writer, ['commit', '-q', '-m', 'accidental collapsed tree']);

    const result = runGuard(scenario.writer, [
      '--base', scenario.base,
      '--candidate', 'HEAD',
      '--check-only',
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('candidate tree collapse');
    expect(git(scenario.writer, ['rev-parse', 'origin/main']).trim()).toBe(scenario.base);
  });

  it('rejects a push when another writer advances main after the captured base', () => {
    const scenario = setupRepository();
    const other = join(scenario.root, 'other');
    git(scenario.root, ['clone', '-q', scenario.origin, other]);
    git(other, ['config', 'user.name', 'Concurrent Test']);
    git(other, ['config', 'user.email', 'concurrent-test@example.invalid']);
    writeFileSync(join(scenario.writer, 'writer.txt'), 'writer\n');
    git(scenario.writer, ['add', 'writer.txt']);
    git(scenario.writer, ['commit', '-q', '-m', 'writer candidate']);
    writeFileSync(join(other, 'other.txt'), 'other\n');
    git(other, ['add', 'other.txt']);
    git(other, ['commit', '-q', '-m', 'concurrent writer']);
    git(other, ['push', '-q', 'origin', 'main']);

    const result = runGuard(scenario.writer, [
      '--base', scenario.base,
      '--candidate', 'HEAD',
      '--push',
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/main push rejected|stale info|fetch first|non-fast-forward/);
    expect(git(scenario.writer, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0])
      .toBe(git(other, ['rev-parse', 'HEAD']).trim());
    expect(() => git(scenario.origin, ['show', 'main:other.txt'])).not.toThrow();
    expect(() => git(scenario.origin, ['show', 'main:writer.txt'])).toThrow();
  });

  it('publishes a valid candidate with the captured lease', () => {
    const scenario = setupRepository();
    writeFileSync(join(scenario.writer, 'valid.txt'), 'valid\n');
    git(scenario.writer, ['add', 'valid.txt']);
    git(scenario.writer, ['commit', '-q', '-m', 'valid guarded write']);

    const result = runGuard(scenario.writer, [
      '--base', scenario.base,
      '--candidate', 'HEAD',
      '--push',
    ]);

    expect(result.status).toBe(0);
    expect(git(scenario.origin, ['show', 'main:valid.txt'])).toBe('valid\n');
  });

  it('publishes the SHA inspected before a symbolic HEAD moves', () => {
    const scenario = setupRepository();
    writeFileSync(join(scenario.writer, 'valid.txt'), 'valid\n');
    git(scenario.writer, ['add', 'valid.txt']);
    git(scenario.writer, ['commit', '-q', '-m', 'valid candidate before late HEAD move']);
    const candidate = git(scenario.writer, ['rev-parse', 'HEAD']).trim();

    const bin = mkdtempSync(join(tmpdir(), 'main-push-guard-sha-bin-'));
    roots.push(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "push" ]; then
    "${realGit}" -C "${scenario.writer}" rm -q valid.txt
    "${realGit}" -C "${scenario.writer}" commit -q -m "late HEAD mutation"
    break
  fi
done
exec "${realGit}" "$@"
`);
    chmodSync(wrapper, 0o755);

    const result = runGuard(scenario.writer, [
      '--base', scenario.base,
      '--candidate', 'HEAD',
      '--push',
    ], { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` });

    expect(result.status, result.output).toBe(0);
    expect(git(scenario.origin, ['rev-parse', 'main']).trim()).toBe(candidate);
    expect(git(scenario.origin, ['show', 'main:valid.txt'])).toBe('valid\n');
  });

  it('shares one deadline across inspection and the network push', () => {
    const scenario = setupRepository();
    writeFileSync(join(scenario.writer, 'deadline.txt'), 'deadline\n');
    git(scenario.writer, ['add', 'deadline.txt']);
    git(scenario.writer, ['commit', '-q', '-m', 'deadline candidate']);

    const bin = mkdtempSync(join(tmpdir(), 'main-push-guard-bin-'));
    roots.push(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "push" ]; then
    sleep 2
    exec "${realGit}" "$@"
  fi
done
sleep 0.3
exec "${realGit}" "$@"
`);
    chmodSync(wrapper, 0o755);

    const result = runGuard(scenario.writer, [
      '--base', scenario.base,
      '--candidate', 'HEAD',
      '--push',
      '--timeout-seconds', '3',
    ], { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/main push deadline exceeded during (?:inspecting tree|git push)/u);
    expect(git(scenario.writer, ['rev-parse', 'origin/main']).trim()).toBe(scenario.base);
  });
});
