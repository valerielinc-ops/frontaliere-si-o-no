// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const dirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winners-resolver-'));
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
    :2:*) cat "$MALFORMED_STAGE_PATH"; exit 0 ;;
    :3:*) printf '{"TI::en::old-slug":{"winnerJobIdentifier":"fresh","winnerCanonical":"new-slug"}}'; exit 0 ;;
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

describe('previous-slug winner conflict resolver integrity', () => {
  it.each([
    ['malformed JSON', '{broken'],
    ['invalid root shape', '[]'],
    ['invalid winner entry', '{"TI::en::old-slug":null}'],
  ])('leaves the conflict unresolved for %s', (_label, malformedStage) => {
    const dir = tempDir();
    const target = 'data/previous-slug-winners.json';
    fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
    const conflictText = '<<<<<<< ours\n{broken\n=======\n{}\n>>>>>>> theirs\n';
    fs.writeFileSync(path.join(dir, target), conflictText);
    const malformedStagePath = path.join(dir, 'malformed-stage.json');
    fs.writeFileSync(malformedStagePath, malformedStage);
    const fakeBin = fakeGitBin(dir);

    const result = spawnSync(process.execPath, [path.join(root, 'scripts/lib/resolve-winners-conflict.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        TARGET_PATH: target,
        MALFORMED_STAGE_PATH: malformedStagePath,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('[resolve-winners] upstream');
    expect(fs.readFileSync(path.join(dir, target), 'utf8')).toBe(conflictText);
  });
});
