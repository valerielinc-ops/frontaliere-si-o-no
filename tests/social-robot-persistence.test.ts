// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { persistBrowserInsights } from '../scripts/social-robot/persist-browser-insights.mjs';

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

function fakeGitBin(root: string): string {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const git = path.join(bin, 'git');
  fs.writeFileSync(git, `#!/bin/sh
case "$*" in
  *"worktree add"*) mkdir -p "$7" ;;
  *"diff --cached --quiet"*) exit 1 ;;
  *"push origin HEAD:main"*)
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
  const calls: Array<{ repo: string; args: string[] }> = [];
  const git = (repo: string, args: string[], options: { allowFailure?: boolean } = {}) => {
    calls.push({ repo, args: [...args] });
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
});
