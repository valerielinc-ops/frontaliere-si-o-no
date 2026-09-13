// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_STATE_SCHEMA,
  hashKey,
  resolveHookRepositoryScope,
} from '../scripts/ci/lib/hook-state.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('hook state namespaces', () => {
  it('includes the explicit state schema in marker keys', () => {
    const key = 'valerielinc-ops/frontaliere-si-o-no:123';
    const expected = createHash('sha256')
      .update(`${HOOK_STATE_SCHEMA}:${key}`)
      .digest('hex')
      .slice(0, 32);
    const legacy = createHash('sha256').update(key).digest('hex').slice(0, 32);

    expect(hashKey(key)).toBe(expected);
    expect(hashKey(key)).not.toBe(legacy);
  });

  it('resolves an origin declared by an included git config file', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-state-origin-'));
    roots.push(root);
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo]);
    writeFileSync(
      join(root, 'origin.inc'),
      '[remote "origin"]\n\turl = git@github.com:Example/Included-Repo.git\n',
      'utf8',
    );
    appendFileSync(
      join(repo, '.git', 'config'),
      '\n[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[include]\n\tpath = ../../origin.inc\n',
      'utf8',
    );

    expect(resolveHookRepositoryScope(repo)).toBe('example/included-repo');
  });
});
