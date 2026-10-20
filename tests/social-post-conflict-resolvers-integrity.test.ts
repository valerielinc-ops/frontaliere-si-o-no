// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const cases = [
  ['resolve-fb-posted-articles-conflict.mjs', 'data/fb-posted-articles.json'],
  ['resolve-fb-posted-jobs-conflict.mjs', 'data/fb-posted-jobs.json'],
  ['resolve-reddit-posted-jobs-conflict.mjs', 'data/reddit-posted-jobs.json'],
] as const;
const dirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-post-resolver-'));
  dirs.push(dir);
  return dir;
}

function fakeGitBin(dir: string) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const git = path.join(bin, 'git');
  fs.writeFileSync(git, `#!/bin/sh
if [ "$1" = "diff" ]; then
  printf '%s\\n' "$TARGET_PATH"
  exit 0
fi
if [ "$1" = "show" ]; then
  case "$2" in
    :2:*) printf '{broken'; exit 0 ;;
    :3:*) printf '{"schemaVersion":1,"posted":[{"id":"local-post"}]}'; exit 0 ;;
  esac
fi
if [ "$1" = "add" ]; then exit 0; fi
exit 1
`);
  fs.chmodSync(git, 0o755);
  return bin;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('social posted-ledger conflict resolvers', () => {
  it.each(cases)('%s leaves a malformed conflicted ledger unresolved', (script, target) => {
    const dir = tempDir();
    fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
    const conflictText = '<<<<<<< ours\n{broken\n=======\n{"posted":[]}\n>>>>>>> theirs\n';
    fs.writeFileSync(path.join(dir, target), conflictText);
    const fakeBin = fakeGitBin(dir);

    const result = spawnSync(process.execPath, [path.join(root, 'scripts/lib', script)], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        TARGET_PATH: target,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('version is not a valid ledger');
    expect(fs.readFileSync(path.join(dir, target), 'utf8')).toBe(conflictText);
  });
});
