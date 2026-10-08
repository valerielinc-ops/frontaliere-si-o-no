// @vitest-environment node
/**
 * A refspec with an empty source (":main") asks the remote to delete the
 * branch. push-locale-shard.sh and push-section-shard.sh build "<commit>:main"
 * from a commit id they have just computed, and they run without errexit: a
 * failed `commit-tree` reached `git push -f`, three times, as ":main".
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HELPERS = resolve(import.meta.dirname, '..', 'scripts/lib/shard-git-helpers.sh');

/** Runs helper statements with a `git` that records its arguments and fails. */
function runWithGitSpy(statements: string) {
  const root = mkdtempSync(join(tmpdir(), 'shard-empty-source-'));
  try {
    const bin = join(root, 'bin');
    const log = join(root, 'git.log');
    mkdirSync(bin);
    writeFileSync(log, '');
    writeFileSync(join(bin, 'git'), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$GIT_SPY_LOG"\nexit 1\n');
    chmodSync(join(bin, 'git'), 0o755);
    const run = spawnSync('env', [
      '-u', 'GITHUB_PAT', '-u', 'SHARD_PUSH_PAT',
      'bash', '-c', `set -uo pipefail; source "${HELPERS}"; ${statements}`,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_SPY_LOG: log, SHARD_PUSH_RETRY_DELAY: '0' },
      timeout: 60_000,
    });
    return {
      output: `${run.stdout}\n${run.stderr}`,
      pushes: readFileSync(log, 'utf8').split('\n').filter((line) => /(^| )push( |$)/u.test(line)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('shard pushes with an empty source ref', () => {
  it('shard_push_with_retry refuses ":main" before any push', () => {
    const run = runWithGitSpy('shard_push_with_retry "$PWD" "git@example.invalid:o/r.git" ":main" "it shard"; echo "rc=$?"');

    expect(run.pushes, run.output).toEqual([]);
    expect(run.output).toContain('rc=1');
    expect(run.output).toContain('its source is empty');
  });

  it('shard_pat_push refuses it too', () => {
    const run = runWithGitSpy('shard_pat_push "$PWD" "git@example.invalid:o/r.git" ":main" "it shard" 1; echo "rc=$?"');

    expect(run.pushes, run.output).toEqual([]);
    expect(run.output).toContain('rc=1');
    expect(run.output).toContain('its source is empty');
  });

  it('still pushes a refspec that names its source', () => {
    // The control: without it, a spy that never sees a push proves nothing.
    const run = runWithGitSpy('shard_push_with_retry "$PWD" "git@example.invalid:o/r.git" "0123abc:main" "it shard"; echo "rc=$?"');

    expect(run.pushes.length, run.output).toBeGreaterThan(0);
    for (const push of run.pushes) expect(push).toContain('0123abc:main');
    expect(run.output).not.toContain('its source is empty');
  });
});
