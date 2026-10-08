// @vitest-environment node
/**
 * The isolated commit of `git-commit-data.sh` on a blobless checkout, and what
 * it does when the plumbing that builds the commit fails.
 *
 * The monitors that commit a single series check out with `filter: blob:none`
 * and a narrow sparse set. The isolated path seeds a private index with the
 * whole remote tree; a plain `git write-tree` then fetched from the promisor
 * every blob the checkout had left out (298 s and 321 s measured on
 * unsubscribe-credential-monitor, in a job capped at 10 minutes).
 *
 * The same path runs with errexit suspended, so a failed `write-tree` or
 * `commit-tree` used to end in `git push origin :refs/heads/main`: an empty
 * source, i.e. a request to delete the branch.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKTREE_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(WORKTREE_ROOT, 'scripts/lib/git-commit-data.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const SERIES_PATH = 'docs/monitor-rate/history.json';
const UNRELATED_FILES = 40;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Blobs named by the tree of HEAD that the clone does not have. */
function missingBlobs(repoDir: string): number {
  return git(repoDir, 'rev-list', '--objects', '--missing=print', 'HEAD')
    .split('\n')
    .filter((line) => line.startsWith('?')).length;
}

function checkoutFixture({ blobless }: { blobless: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'gcd-blobless-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const runner = join(root, 'runner');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  // A partial clone needs a remote that accepts the filter and fetches by id.
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  execFileSync('git', ['clone', '-q', origin, seed]);
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  mkdirSync(join(seed, 'docs/monitor-rate'), { recursive: true });
  writeFileSync(join(seed, SERIES_PATH), `${JSON.stringify([{ day: 'first', rate: 0 }])}\n`);
  mkdirSync(join(seed, 'public/heavy'), { recursive: true });
  for (let index = 0; index < UNRELATED_FILES; index += 1) {
    writeFileSync(join(seed, 'public/heavy', `asset-${index}.txt`), `asset ${index}\n${'x'.repeat(2_000)}\n`);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  if (blobless) {
    // The monitors' checkout: depth 1, no blobs, sparse on the series.
    execFileSync('git', [
      'clone', '-q', '--depth=1', '--filter=blob:none', '--no-checkout', '--branch', 'main', `file://${origin}`, runner,
    ]);
    git(runner, 'sparse-checkout', 'set', '--no-cone', '/docs/');
    git(runner, 'checkout', '-q', 'main');
  } else {
    execFileSync('git', ['clone', '-q', origin, runner]);
  }
  git(runner, 'config', 'user.email', 'test@example.com');
  git(runner, 'config', 'user.name', 'Test');
  writeFileSync(join(runner, SERIES_PATH), `${JSON.stringify([
    { day: 'first', rate: 0 },
    { day: 'second', rate: 0 },
  ])}\n`);
  return { root, origin, runner };
}

function runExtraOnly(runner: string, env: Record<string, string> = {}) {
  const run = spawnSync(BASH_BIN, [SCRIPT_PATH, '--extra-only', 'monitor series', 'docs/monitor-rate/'], {
    cwd: runner,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_PIPELINE_LEASE: '0',
      SKIP_AI_TRANSLATION: '1',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GITHUB_REPOSITORY: '',
      GITHUB_OUTPUT: '',
      ...env,
    },
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** Fetches git starts on its own, towards the promisor, to obtain missing objects. */
function promisorFetches(trace: string): number {
  return readFileSync(trace, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === 'child_start'
      && Array.isArray(event.argv)
      && event.argv.includes('fetch')
      && event.argv.includes('--stdin')
      && event.argv.some((arg: string) => arg.startsWith('--filter='))).length;
}

/**
 * A `git` placed first on PATH: it records every invocation of the script and
 * can break one plumbing step, then hands over to the real binary.
 */
function gitSpy(root: string) {
  const bin = join(root, 'spy-bin');
  const log = join(root, 'git-spy.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(join(bin, 'git'), [
    '#!/bin/bash',
    'printf \'%s\\n\' "$*" >> "$GIT_SPY_LOG"',
    'args=()',
    'for arg in "$@"; do',
    '  if [ -n "${GIT_SPY_FAIL:-}" ] && [ "$arg" = "$GIT_SPY_FAIL" ]; then',
    '    echo "fatal: simulated $arg failure" >&2',
    '    exit 128',
    '  fi',
    '  if [ "${GIT_SPY_HASH_WITHOUT_WRITE:-}" = "1" ] && [ "$1" = "hash-object" ] && [ "$arg" = "-w" ]; then',
    '    continue',
    '  fi',
    '  args+=("$arg")',
    'done',
    'exec "$GIT_SPY_REAL" "${args[@]}"',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'git'), 0o755);
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, GIT_SPY_LOG: log, GIT_SPY_REAL: realGit },
    pushes: () => readFileSync(log, 'utf8').split('\n').filter((line) => /(^| )push( |$)/u.test(line)),
  };
}

describe('git-commit-data.sh --extra-only from a blobless checkout', () => {
  it('commits the series without downloading the blobs the checkout left out', () => {
    const { root, origin, runner } = checkoutFixture({ blobless: true });
    try {
      // Premise: the checkout lacks the unrelated blobs, or the test measures nothing.
      expect(missingBlobs(runner)).toBe(UNRELATED_FILES);

      const trace = join(root, 'trace2.jsonl');
      const run = runExtraOnly(runner, { GIT_TRACE2_EVENT: trace });

      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('Pushed successfully');
      expect(git(origin, 'show', `main:${SERIES_PATH}`)).toContain('second');
      // The rest of the published tree is the one the remote already had.
      expect(git(origin, 'rev-parse', 'main:public')).toBe(git(origin, 'rev-parse', 'main~1:public'));
      expect(promisorFetches(trace)).toBe(0);
      expect(missingBlobs(runner)).toBe(UNRELATED_FILES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('git-commit-data.sh private index wiring', () => {
  it('writes trees and stages blobs only through the checked helpers', () => {
    // Commands only: comments and the messages that name a command are left out.
    const code = readFileSync(SCRIPT_PATH, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(#|echo )/u.test(line));
    const calls = (needle: string) => code.filter((line) => line.includes(needle));

    // A second, plain `git write-tree` would bring the bulk fetch back.
    expect(calls('git write-tree')).toHaveLength(1);
    expect(calls('git write-tree')[0]).toContain('git write-tree --missing-ok');
    // `--missing-ok` is only safe while every staged blob is vouched for.
    expect(calls('update-index --add --cacheinfo')).toHaveLength(1);
    expect(calls('git cat-file -e "${blob}^{blob}"')).toHaveLength(1);
    expect(calls('stage_isolated_blob "$tmp_index"')).toHaveLength(3);
  });
});

describe('git-commit-data.sh isolated commit when the plumbing fails', () => {
  const failures = [
    { name: 'write-tree fails', env: { GIT_SPY_FAIL: 'write-tree' }, message: 'git write-tree failed' },
    { name: 'commit-tree fails', env: { GIT_SPY_FAIL: 'commit-tree' }, message: 'git commit-tree failed' },
    {
      // `--missing-ok` no longer vouches for the staged content: the script must.
      name: 'the blob it staged is not in the local object store',
      env: { GIT_SPY_HASH_WITHOUT_WRITE: '1' },
      message: 'is not in the local object store',
    },
  ];
  for (const failure of failures) {
    it(`stops before any push when ${failure.name}`, () => {
      const { root, origin, runner } = checkoutFixture({ blobless: false });
      try {
        const spy = gitSpy(root);
        const before = git(origin, 'rev-parse', 'main');
        const run = runExtraOnly(runner, { ...spy.env, ...failure.env, MAX_PUSH_ATTEMPTS: '1' });

        // An empty source ref (`:refs/heads/main`) would be a branch deletion.
        expect(spy.pushes(), run.output).toEqual([]);
        expect(run.status, run.output).toBe(1);
        expect(run.output).toContain(failure.message);
        expect(git(origin, 'rev-parse', 'main')).toBe(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
