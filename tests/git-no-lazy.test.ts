// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNoLazyGitInvocation } from '../scripts/lib/git-no-lazy.mjs';
import { makeContentProver } from '../scripts/lib/merged-content-proof.mjs';

const roots: string[] = [];

function fakeGit(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'git-no-lazy-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const trace = join(root, 'trace.log');
  mkdirSync(bin);
  const executable = join(bin, 'git');
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf \'git version %s\\n\' "$FAKE_GIT_VERSION"\n  printf \'version\\n\' >>"$FAKE_GIT_TRACE"\n  exit 0\nfi\nprintf \'command:%s\\n\' "$*" >>"$FAKE_GIT_TRACE"\nexit 97\n');
  chmodSync(executable, 0o755);
  return {
    trace,
    env: { ...process.env, PATH: bin, FAKE_GIT_VERSION: version, FAKE_GIT_TRACE: trace },
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('git-no-lazy', () => {
  it.each([
    ['2.39.2 (Apple Git-143)', false],
    ['2.44.0', true],
    ['2.56.0', true],
  ] as const)('risolve Git %s una volta e abilita solo le versioni compatibili', (version, supported) => {
    const fake = fakeGit(version);
    const invocationFor = createNoLazyGitInvocation({ env: fake.env });

    expect(invocationFor(['cat-file', '-e', 'deadbeef^{commit}'])).toEqual(supported
      ? { args: ['--no-lazy-fetch', 'cat-file', '-e', 'deadbeef^{commit}'], env: { GIT_NO_LAZY_FETCH: '1' } }
      : null);
    expect(invocationFor(['merge-base', 'a', 'b'])).toEqual(supported
      ? { args: ['--no-lazy-fetch', 'merge-base', 'a', 'b'], env: { GIT_NO_LAZY_FETCH: '1' } }
      : null);
    expect(readFileSync(fake.trace, 'utf8')).toBe('version\n');
  });

  it('hasCommit tratta Git vecchio come assente senza eseguire una sonda sull’OID', () => {
    const fake = fakeGit('2.39.2');
    const gitCalls: string[][] = [];
    const prover = makeContentProver({
      mainRef: 'origin/main',
      git: (args: string[]) => { gitCalls.push(args); return null; },
      noLazyGitInvocation: createNoLazyGitInvocation({ env: fake.env }),
    });
    const sha = 'e'.repeat(40);

    expect(prover.hasCommit(sha)).toBe(false);
    expect(prover.hasCommit(sha)).toBe(false);
    expect(prover.hasCommit(sha, { refresh: true })).toBe(false);
    expect(gitCalls).toEqual([]);
    expect(readFileSync(fake.trace, 'utf8')).toBe('version\n');
  });
});
