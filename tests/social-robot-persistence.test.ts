// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { persistBrowserInsights } from '../scripts/social-robot/persist-browser-insights.mjs';
import { STALE_PACK_AGE_MS } from '../scripts/lib/stale-fetch-pack-sweep.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/social-robot/persist-browser-insights.mjs');
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-robot-persistence-'));
  dirs.push(dir);
  return dir;
}

function snapshotPath(root: string): string {
  const file = path.join(root, 'instagram-insights.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, posts: [] }));
  return file;
}

function runGit(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function fakeGitBin(root: string): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const git = path.join(bin, 'git');
  fs.writeFileSync(git, `#!/bin/sh
case "$*" in
  *"worktree add"*) mkdir -p "$7" ;;
  *"rev-parse"*) printf '%s\\n' '1111111111111111111111111111111111111111' ;;
  *"merge-base --is-ancestor"*) exit 0 ;;
  *"ls-tree"*) printf 'tracked-0\\0tracked-1\\0' ;;
  *"diff --cached --quiet"*) exit 1 ;;
  *"push "*)
    # Two MiB exceeds Node's default execFileSync buffer.
    dd if=/dev/zero bs=1048576 count=2 2>/dev/null
    if [ "\${FAKE_GIT_FAIL:-0}" = "1" ]; then exit 42; fi
    ;;
esac
exit 0
`);
  fs.chmodSync(git, 0o755);
  return bin;
}

function runPersistenceCli(root: string, { failPush = false } = {}) {
  const fakeBin = fakeGitBin(root);
  return spawnSync(process.execPath, [
    SCRIPT,
    '--repo', path.join(root, 'site'),
    '--snapshot', snapshotPath(root),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      FAKE_GIT_FAIL: failPush ? '1' : '0',
    },
  });
}

function fakeGit({ pushFailures = 0, fetchFailures = 0 } = {}) {
  const calls: Array<{
    repo: string;
    args: string[];
    options: { allowFailure?: boolean; env?: Record<string, string> };
  }> = [];
  const git = (
    repo: string,
    args: string[],
    options: { allowFailure?: boolean; env?: Record<string, string> } = {},
  ) => {
    calls.push({ repo, args: [...args], options });
    if (args[0] === 'fetch' || args.includes('fetch')) {
      if (fetchFailures > 0) {
        fetchFailures -= 1;
        throw new Error('fetch timed out');
      }
      return '';
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      fs.mkdirSync(args[4], { recursive: true });
      return '';
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      fs.rmSync(args[3], { recursive: true, force: true });
      return '';
    }
    if (args[0] === 'diff' && options.allowFailure) return null;
    if (args[0] === 'push') {
      if (pushFailures > 0) {
        pushFailures -= 1;
        throw new Error('push rejected');
      }
      return '';
    }
    return '';
  };
  return { calls, git };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('persistBrowserInsights', () => {
  it('preserves the complete main tree from a no-checkout sparse worktree', () => {
    const root = tempDir();
    const repo = path.join(root, 'site');
    const origin = path.join(root, 'origin.git');
    const hooks = path.join(root, 'empty-hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooks);
    runGit(root, ['init', '--bare', origin]);
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'core.hooksPath', hooks]);
    runGit(repo, ['config', 'user.name', 'Persistence test']);
    runGit(repo, ['config', 'user.email', 'persistence-test@example.invalid']);

    for (const [file, contents] of [
      ['README.md', 'keep the main tree\n'],
      ['scripts/keep.mjs', 'export const keep = true;\n'],
      ['data/instagram-insights.json', '{"posts":[]}\n'],
    ]) {
      const filePath = path.join(repo, file);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    }
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-m', 'seed main']);
    runGit(repo, ['remote', 'add', 'origin', origin]);
    runGit(repo, ['push', '-u', 'origin', 'main']);
    runGit(repo, ['fetch', 'origin', 'main']);

    const result = persistBrowserInsights({ repo, snapshot: snapshotPath(root) });

    expect(result).toEqual({ status: 'pushed', attempt: 1 });
    expect(runGit(origin, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n')).toEqual([
      'README.md',
      'data/instagram-insights.json',
      'scripts/keep.mjs',
    ]);
    expect(runGit(origin, ['show', 'main:README.md'])).toBe('keep the main tree\n');
    expect(runGit(origin, ['show', 'main:scripts/keep.mjs'])).toBe('export const keep = true;\n');
    expect(JSON.parse(runGit(origin, ['show', 'main:data/instagram-insights.json']))).toEqual({
      schemaVersion: 1,
      posts: [],
    });
  });

  it('uses the already fetched origin/main without a redundant network fetch', () => {
    const root = tempDir();
    const fake = fakeGit();

    const result = persistBrowserInsights({
      repo: path.join(root, 'site'),
      snapshot: snapshotPath(root),
      gitFn: fake.git,
    });

    expect(result).toEqual({ status: 'pushed', attempt: 1 });
    expect(fake.calls.some(({ args }) => args.includes('fetch'))).toBe(false);
    const pushCalls = fake.calls.filter(({ args }) => args[0] === 'push');
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].options.env).toEqual({ FRONTALIERE_AUTOMATED_DATA_PUSH: 'social-robot-insights' });
    expect(fake.calls.filter(({ args }) => args[0] !== 'push').every(({ options }) => !options.env)).toBe(true);
    expect(fs.existsSync(path.join(root, '.insights-persist.lock'))).toBe(false);
  });

  it('keeps using the cached ref when a retry refresh times out', () => {
    const root = tempDir();
    const fake = fakeGit({ pushFailures: 1, fetchFailures: 1 });

    const result = persistBrowserInsights({
      repo: path.join(root, 'site'),
      snapshot: snapshotPath(root),
      attempts: 2,
      gitFn: fake.git,
    });

    expect(result).toEqual({ status: 'pushed', attempt: 2 });
    expect(fake.calls.filter(({ args }) => args.includes('fetch'))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, '.insights-persist.lock'))).toBe(false);
  });

  it('skips an overlapping writer while the first one owns the lock', () => {
    const root = tempDir();
    const snapshot = snapshotPath(root);
    fs.writeFileSync(
      path.join(root, '.insights-persist.lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
    const fake = fakeGit();

    const result = persistBrowserInsights({ repo: path.join(root, 'site'), snapshot, gitFn: fake.git });

    expect(result).toEqual({ status: 'busy' });
    expect(fake.calls).toEqual([]);
  });

  it('does not fail when git push writes more than 1 MiB', () => {
    const root = tempDir();
    const result = runPersistenceCli(root);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"status":"pushed"');
    expect(`${result.stdout}${result.stderr}`).not.toContain('ENOBUFS');
  });

  it('keeps a real git failure fatal after the large-output path', () => {
    const root = tempDir();
    const result = runPersistenceCli(root, { failPush: true });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('❌ persist browser Insights:');
    expect(result.stdout).not.toContain('"status":"pushed"');
  });

  it('does not retry a storage failure that cannot succeed until the host has space', () => {
    const root = tempDir();
    const snapshot = snapshotPath(root);
    let worktreeAdds = 0;
    const git = (repo: string, args: string[], options: { allowFailure?: boolean; env?: Record<string, string> } = {}) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        worktreeAdds += 1;
        throw new Error('fatal: No space left on device');
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        fs.rmSync(args[3], { recursive: true, force: true });
        return '';
      }
      return '';
    };

    expect(() => persistBrowserInsights({
      repo: path.join(root, 'site'),
      snapshot,
      attempts: 3,
      gitFn: git,
    })).toThrow(/No space left on device/);
    expect(worktreeAdds).toBe(1);
  });

  it('removes stale fetch packs before creating the Insights worktree', () => {
    const root = tempDir();
    const repo = path.join(root, 'site');
    fs.mkdirSync(repo);
    runGit(repo, ['init', '-b', 'main']);
    const packDir = path.resolve(repo, runGit(repo, ['rev-parse', '--git-path', 'objects/pack']).trim());
    const stalePack = path.join(packDir, 'tmp_pack_stale');
    fs.writeFileSync(stalePack, Buffer.alloc(4096));
    const old = new Date(Date.now() - STALE_PACK_AGE_MS - 1_000);
    fs.utimesSync(stalePack, old, old);

    const result = persistBrowserInsights({
      repo,
      snapshot: snapshotPath(root),
      gitFn: fakeGit().git,
    });

    expect(result).toEqual({ status: 'pushed', attempt: 1 });
    expect(fs.existsSync(stalePack)).toBe(false);
  });
});
