// @vitest-environment node
// Tests for the .githooks/pre-push CI automation guard (article-generation
// outage 2026-07-08→10): npm ci's `prepare` activates core.hooksPath=.githooks
// inside GitHub Actions jobs too, where data-refresh workflows push generated
// content straight to main. The strict sibling gate rejected every article
// push (run 29090019854: 13 generated files → 10871 sibling candidates →
// exit 1 → "Article is LOST" ×10 attempts), zeroing article production.
// The guard skips the gate ONLY when running under GitHub Actions or an
// explicitly named automated data writer, AND every pushed ref targets main;
// dev pushes (local) and pushes to claude/* branches (issue-fix agents — the
// gate's designed audience) still run it.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOOK = resolve(ROOT, '.githooks/pre-push');
const OLD_HISTORY_GUARD = resolve(ROOT, 'scripts/lib/old-history-guard.mjs');
const GIT_FETCH_TARGET = resolve(ROOT, 'scripts/lib/git-fetch-target.mjs');
const SINGLE_FLIGHT_LOCK = resolve(ROOT, 'scripts/lib/single-flight-lock.mjs');
const MAIN_TREE_SHRINK_GUARD = resolve(ROOT, 'scripts/ci/guard-main-tree-shrink.mjs');
const ZERO_SHA = '0'.repeat(40);

// Run the hook with a stubbed `node` binary prepended to PATH so the real
// check-sibling-patterns.mjs (multi-minute on this repo) never executes; the
// stub exits 42, letting us assert *whether* the gate would have run without
// paying its cost.
function runHook({
  automatedDataPush,
  githubActions,
  stdinRefs,
}: { automatedDataPush?: string; githubActions?: string; stdinRefs: string }) {
  const stubDir = mkdtempSync(join(tmpdir(), 'pre-push-guard-'));
  const marker = join(stubDir, 'gate-ran');
  const argsFile = join(stubDir, 'gate-args');
  const oldHistoryMarker = join(stubDir, 'old-history-ran');
  const treeShrinkMarker = join(stubDir, 'tree-shrink-ran');
  writeFileSync(
    join(stubDir, 'node'),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == *guard-main-tree-shrink.mjs ]]; then echo ran > "${treeShrinkMarker}"; exit 0; fi\nif [[ "\${1:-}" == *old-history-guard.mjs ]]; then echo ran > "${oldHistoryMarker}"; exit 0; fi\necho ran > "${marker}"\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 42\n`,
  );
  chmodSync(join(stubDir, 'node'), 0o755);
  writeFileSync(join(stubDir, 'git'), '#!/usr/bin/env bash\nif [[ "${1:-}" == cat-file ]]; then exit 0; fi\nexit 1\n');
  chmodSync(join(stubDir, 'git'), 0o755);
  try {
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [HOOK, 'origin', 'https://github.com/x/y'], {
        cwd: ROOT,
        env: {
          PATH: `${stubDir}:${process.env.PATH}`,
          ...(automatedDataPush !== undefined ? { FRONTALIERE_AUTOMATED_DATA_PUSH: automatedDataPush } : {}),
          ...(githubActions !== undefined ? { GITHUB_ACTIONS: githubActions } : {}),
        },
        input: stdinRefs,
        encoding: 'utf8',
        timeout: 10_000,
      });
    } catch (e: any) {
      code = e.status ?? 1;
      stdout = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    }
    let gateRan = false;
    let oldHistoryRan = false;
    let treeShrinkRan = false;
    let args: string[] = [];
    try {
      gateRan = readFileSync(marker, 'utf8').includes('ran');
    } catch {
      gateRan = false;
    }
    try {
      oldHistoryRan = readFileSync(oldHistoryMarker, 'utf8').includes('ran');
    } catch {
      oldHistoryRan = false;
    }
    try {
      treeShrinkRan = readFileSync(treeShrinkMarker, 'utf8').includes('ran');
    } catch {
      treeShrinkRan = false;
    }
    try {
      args = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      args = [];
    }
    return { code, stdout, gateRan, oldHistoryRan, treeShrinkRan, args };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[], input?: string | Buffer) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    input,
  }).trim();
}

function createHistoryGuardFixture({ includeMarker }: { includeMarker: boolean }) {
  const repo = mkdtempSync(join(tmpdir(), 'pre-push-history-guard-repo-'));
  const remote = mkdtempSync(join(tmpdir(), 'pre-push-history-guard-remote-'));

  try {
    runGit(repo, ['init', '-q']);
    runGit(remote, ['init', '--bare', '-q']);
    mkdirSync(join(repo, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
    const oldHistoryGuardSource = readFileSync(OLD_HISTORY_GUARD, 'utf8');
    writeFileSync(
      join(repo, 'scripts', 'lib', 'single-flight-lock.mjs'),
      readFileSync(SINGLE_FLIGHT_LOCK),
    );
    writeFileSync(
      join(repo, 'scripts', 'lib', 'git-fetch-target.mjs'),
      readFileSync(GIT_FETCH_TARGET),
    );
    writeFileSync(join(repo, 'scripts', 'ci', 'check-sibling-patterns.mjs'), 'process.exit(0);\n');
    runGit(repo, ['config', 'user.name', 'Fixture']);
    runGit(repo, ['config', 'user.email', 'fixture@example.invalid']);

    const emptyTree = runGit(repo, ['mktree'], '');
    const rewrittenMain = runGit(repo, ['commit-tree', emptyTree, '-m', 'rewritten main']);
    const marker = includeMarker
      ? runGit(repo, ['commit-tree', emptyTree, '-m', 'pre-rewrite marker'])
      : undefined;
    writeFileSync(
      join(repo, 'scripts', 'lib', 'old-history-guard.mjs'),
      marker
        ? oldHistoryGuardSource.replace(
          /export const OLD_HISTORY_FIRST_CHANGED_COMMIT = '[0-9a-f]{40}';/,
          `export const OLD_HISTORY_FIRST_CHANGED_COMMIT = '${marker}';`,
        )
        : oldHistoryGuardSource,
    );
    const localHead = marker
      ? runGit(repo, ['commit-tree', emptyTree, '-p', marker, '-m', 'legacy branch'])
      : runGit(repo, ['commit-tree', emptyTree, '-m', 'current branch']);

    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, [
      'push',
      '-q',
      'origin',
      `${localHead}:refs/heads/legacy`,
      `${rewrittenMain}:refs/heads/main`,
    ]);
    runGit(repo, ['update-ref', 'refs/heads/test-branch', localHead]);
    runGit(repo, ['update-ref', 'refs/remotes/origin/main', marker ? localHead : rewrittenMain]);

    const hook = readFileSync(HOOK, 'utf8');
    const hookPath = join(repo, 'pre-push');
    writeFileSync(hookPath, hook);
    chmodSync(hookPath, 0o755);

    const env = {
      ...process.env,
    };
    delete env.GITHUB_ACTIONS;

    return {
      env,
      hookPath,
      localHead,
      marker,
      remote,
      repo,
      rewrittenMain,
    };
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    throw error;
  }
}

function runHistoryGuard(
  fixture: ReturnType<typeof createHistoryGuardFixture>,
  stdinRefs: string,
) {
  try {
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [fixture.hookPath, 'origin', 'https://example.invalid/repo'], {
        cwd: fixture.repo,
        env: fixture.env,
        input: stdinRefs,
        encoding: 'utf8',
        timeout: 10_000,
      });
    } catch (error: any) {
      code = error.status ?? 1;
      stdout = (error.stdout?.toString() ?? '') + (error.stderr?.toString() ?? '');
    }
    return { code, stdout };
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
}

const MAIN_REF =
  'refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n';
const NEW_SHA256_MAIN_REF =
  `refs/heads/main ${'1'.repeat(64)} refs/heads/main ${'0'.repeat(64)}\n`;
const DELETE_MAIN_REF =
  `refs/heads/main ${'0'.repeat(40)} refs/heads/main ${'2'.repeat(40)}\n`;
const BRANCH_REF =
  'refs/heads/claude/fix-x 1111111111111111111111111111111111111111 refs/heads/claude/fix-x 2222222222222222222222222222222222222222\n';

describe('.githooks/pre-push CI automation guard', () => {
  it('skips the sibling gate for a GitHub Actions push to main (data-refresh/article path)', () => {
    const { code, stdout, gateRan, oldHistoryRan, treeShrinkRan } = runHook({ githubActions: 'true', stdinRefs: MAIN_REF });
    expect(code).toBe(0);
    expect(stdout).toMatch(/skipped/);
    expect(gateRan).toBe(false);
    expect(oldHistoryRan).toBe(true);
    expect(treeShrinkRan).toBe(true);
  });

  it('still runs the gate for a GitHub Actions push to a claude/* branch (issue-fix agents)', () => {
    const { code, gateRan, treeShrinkRan, args } = runHook({ githubActions: 'true', stdinRefs: BRANCH_REF });
    expect(gateRan).toBe(true);
    expect(treeShrinkRan).toBe(false);
    expect(code).toBe(42);
    expect(args).toContain('--head');
    expect(args).toContain('1111111111111111111111111111111111111111');
  });

  it('still runs the gate for a mixed push (main + branch) under GitHub Actions', () => {
    const { gateRan, treeShrinkRan } = runHook({ githubActions: 'true', stdinRefs: MAIN_REF + BRANCH_REF });
    expect(gateRan).toBe(true);
    expect(treeShrinkRan).toBe(true);
  });

  it('still runs the gate for a local dev push to main (GITHUB_ACTIONS unset)', () => {
    const { code, gateRan, oldHistoryRan, treeShrinkRan } = runHook({ stdinRefs: MAIN_REF });
    expect(gateRan).toBe(true);
    expect(oldHistoryRan).toBe(true);
    expect(treeShrinkRan).toBe(true);
    expect(code).toBe(42);
  });

  it('skips only the sibling gate for a named automated data push to main', () => {
    const { code, stdout, gateRan, oldHistoryRan, treeShrinkRan } = runHook({
      automatedDataPush: 'social-robot-insights',
      stdinRefs: MAIN_REF,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('sibling-gate: skipped (automated data push to main: social-robot-insights)');
    expect(gateRan).toBe(false);
    expect(oldHistoryRan).toBe(true);
    expect(treeShrinkRan).toBe(true);
  });

  it('skips tree comparison when creating main with a 64-character null SHA', () => {
    const { code, treeShrinkRan } = runHook({ githubActions: 'true', stdinRefs: NEW_SHA256_MAIN_REF });
    expect(code).toBe(0);
    expect(treeShrinkRan).toBe(false);
  });

  it('refuses to delete main before running any other push gate', () => {
    const { code, stdout, treeShrinkRan } = runHook({ githubActions: 'true', stdinRefs: DELETE_MAIN_REF });
    expect(code).toBe(1);
    expect(stdout).toContain('Refusing to delete refs/heads/main');
    expect(treeShrinkRan).toBe(false);
  });

  it('runs the sibling gate for a named automated data push to a non-main branch', () => {
    const { code, gateRan, oldHistoryRan, treeShrinkRan } = runHook({
      automatedDataPush: 'social-robot-insights',
      stdinRefs: BRANCH_REF,
    });
    expect(code).toBe(42);
    expect(gateRan).toBe(true);
    expect(oldHistoryRan).toBe(true);
    expect(treeShrinkRan).toBe(false);
  });

  it('still runs the gate when stdin lists no refs (nothing to classify — fail closed)', () => {
    const { gateRan, treeShrinkRan } = runHook({ githubActions: 'true', stdinRefs: '' });
    expect(gateRan).toBe(true);
    expect(treeShrinkRan).toBe(false);
  });
});

describe('.githooks/pre-push main tree base fetch', () => {
  it('fetches an advertised main SHA missing from a shallow checkout into a temporary ref', () => {
    const root = mkdtempSync(join(tmpdir(), 'pre-push-main-tree-fetch-'));
    const pushRemote = join(root, 'push.git');
    const fetchRemote = join(root, 'fetch.git');
    const seed = join(root, 'seed');
    const repo = join(root, 'shallow');
    const stubDir = join(root, 'bin');
    const scriptsDir = join(repo, 'scripts', 'ci');
    const hookPath = join(repo, 'pre-push');
    try {
      mkdirSync(pushRemote, { recursive: true });
      mkdirSync(fetchRemote, { recursive: true });
      mkdirSync(seed, { recursive: true });
      mkdirSync(stubDir, { recursive: true });
      runGit(pushRemote, ['init', '--bare', '-q', '--initial-branch=main']);
      runGit(fetchRemote, ['init', '--bare', '-q', '--initial-branch=main']);
      runGit(seed, ['init', '-q', '--initial-branch=main']);
      runGit(seed, ['config', 'user.name', 'Fixture']);
      runGit(seed, ['config', 'user.email', 'fixture@example.invalid']);
      writeFileSync(join(seed, 'base.txt'), 'base\n');
      runGit(seed, ['add', '.']);
      runGit(seed, ['commit', '-q', '-m', 'base']);
      runGit(seed, ['remote', 'add', 'push', pushRemote]);
      runGit(seed, ['remote', 'add', 'fetch', fetchRemote]);
      runGit(seed, ['push', '-q', 'push', 'main']);
      runGit(seed, ['push', '-q', 'fetch', 'main']);

      execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${fetchRemote}`, repo]);
      expect(runGit(repo, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      const shallowPath = runGit(repo, ['rev-parse', '--git-path', 'shallow']);
      const originalShallowFile = readFileSync(join(repo, shallowPath), 'utf8');
      runGit(repo, ['remote', 'set-url', '--push', 'origin', pushRemote]);
      writeFileSync(join(seed, 'remote.txt'), 'remote main advance\n');
      runGit(seed, ['add', '.']);
      runGit(seed, ['commit', '-q', '-m', 'advance remote main']);
      const remoteSha = runGit(seed, ['rev-parse', 'HEAD']);
      runGit(seed, ['push', '-q', 'push', 'main']);
      expect(() => runGit(repo, ['cat-file', '-e', `${remoteSha}^{commit}`])).toThrow();

      runGit(repo, ['config', 'user.name', 'Fixture']);
      runGit(repo, ['config', 'user.email', 'fixture@example.invalid']);
      writeFileSync(join(repo, 'candidate.txt'), 'local candidate\n');
      runGit(repo, ['add', 'candidate.txt']);
      runGit(repo, ['commit', '-q', '-m', 'local candidate']);
      const localSha = runGit(repo, ['rev-parse', 'HEAD']);

      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(scriptsDir, 'guard-main-tree-shrink.mjs'), readFileSync(MAIN_TREE_SHRINK_GUARD));
      mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
      writeFileSync(join(repo, 'scripts', 'lib', 'old-history-guard.mjs'), readFileSync(OLD_HISTORY_GUARD));
      writeFileSync(join(repo, 'scripts', 'lib', 'git-fetch-target.mjs'), readFileSync(GIT_FETCH_TARGET));
      writeFileSync(join(repo, 'scripts', 'lib', 'single-flight-lock.mjs'), readFileSync(SINGLE_FLIGHT_LOCK));
      writeFileSync(hookPath, readFileSync(HOOK));
      chmodSync(hookPath, 0o755);
      writeFileSync(join(stubDir, 'node'), [
        '#!/usr/bin/env bash',
        `if [[ "\${1:-}" == scripts/ci/guard-main-tree-shrink.mjs ]]; then exec ${JSON.stringify(process.execPath)} "$@"; fi`,
        'if [[ "${1:-}" == *old-history-guard.mjs ]]; then exit 0; fi',
        'exit 99',
        '',
      ].join('\n'));
      chmodSync(join(stubDir, 'node'), 0o755);

      const output = execFileSync('bash', [hookPath, 'origin', pushRemote], {
        cwd: repo,
        env: { ...process.env, GITHUB_ACTIONS: 'true', PATH: `${stubDir}:${process.env.PATH}` },
        input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(output).toMatch(/tree-shrink guard: main tree paths: \d+ → \d+/u);
      expect(output).not.toContain('Unable to verify main tree size');
      expect(runGit(repo, ['cat-file', '-e', `${remoteSha}^{commit}`])).toBe('');
      expect(runGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/ci/main-tree-guard/fetch'])).toBe('');
      expect(readFileSync(join(repo, shallowPath), 'utf8')).toBe(originalShallowFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches a missing advertised main SHA without making a complete checkout shallow', () => {
    const root = mkdtempSync(join(tmpdir(), 'main-tree-fetch-complete-'));
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const repo = join(root, 'complete');
    try {
      mkdirSync(remote, { recursive: true });
      mkdirSync(seed, { recursive: true });
      runGit(remote, ['init', '--bare', '-q', '--initial-branch=main']);
      runGit(seed, ['init', '-q', '--initial-branch=main']);
      runGit(seed, ['config', 'user.name', 'Fixture']);
      runGit(seed, ['config', 'user.email', 'fixture@example.invalid']);
      writeFileSync(join(seed, 'base.txt'), 'base\n');
      runGit(seed, ['add', '.']);
      runGit(seed, ['commit', '-q', '-m', 'base']);
      runGit(seed, ['remote', 'add', 'origin', remote]);
      runGit(seed, ['push', '-q', 'origin', 'main']);

      execFileSync('git', ['clone', '--quiet', remote, repo]);
      expect(runGit(repo, ['rev-parse', '--is-shallow-repository'])).toBe('false');
      writeFileSync(join(seed, 'remote.txt'), 'remote main advance\n');
      runGit(seed, ['add', '.']);
      runGit(seed, ['commit', '-q', '-m', 'advance remote main']);
      const remoteSha = runGit(seed, ['rev-parse', 'HEAD']);
      runGit(seed, ['push', '-q', 'origin', 'main']);
      expect(() => runGit(repo, ['cat-file', '-e', `${remoteSha}^{commit}`])).toThrow();

      runGit(repo, ['config', 'user.name', 'Fixture']);
      runGit(repo, ['config', 'user.email', 'fixture@example.invalid']);
      writeFileSync(join(repo, 'candidate.txt'), 'local candidate\n');
      runGit(repo, ['add', 'candidate.txt']);
      runGit(repo, ['commit', '-q', '-m', 'local candidate']);
      const localSha = runGit(repo, ['rev-parse', 'HEAD']);

      mkdirSync(join(repo, 'scripts', 'ci'), { recursive: true });
      mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
      writeFileSync(join(repo, 'scripts', 'ci', 'guard-main-tree-shrink.mjs'), readFileSync(MAIN_TREE_SHRINK_GUARD));
      writeFileSync(join(repo, 'scripts', 'lib', 'old-history-guard.mjs'), readFileSync(OLD_HISTORY_GUARD));
      writeFileSync(join(repo, 'scripts', 'lib', 'git-fetch-target.mjs'), readFileSync(GIT_FETCH_TARGET));
      writeFileSync(join(repo, 'scripts', 'lib', 'single-flight-lock.mjs'), readFileSync(SINGLE_FLIGHT_LOCK));

      const output = execFileSync(process.execPath, [
        join(repo, 'scripts', 'ci', 'guard-main-tree-shrink.mjs'),
        '--before', remoteSha,
        '--after', localSha,
        '--fetch-missing-from', remote,
      ], { cwd: repo, encoding: 'utf8', timeout: 10_000 });

      expect(output).toMatch(/tree-shrink guard: main tree paths: \d+ → \d+/u);
      expect(runGit(repo, ['rev-parse', '--is-shallow-repository'])).toBe('false');
      expect(runGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/ci/main-tree-guard/fetch'])).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('.githooks/pre-push old-history rewrite guard', () => {
  it('rejects a branch after fetching rewritten remote main when the tracking ref is stale', () => {
    const fixture = createHistoryGuardFixture({ includeMarker: true });
    const result = runHistoryGuard(
      fixture,
      `refs/heads/test-branch ${fixture.localHead} refs/heads/test-branch ${ZERO_SHA}\n`,
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('storia precedente');
    expect(result.stdout).toContain('base aggiornato non la contiene');
    expect(result.stdout).toContain('git rebase --onto origin/main <vecchia base> <branch>');
  });

  it('leaves the push alone while origin/main still contains the marker', () => {
    const fixture = createHistoryGuardFixture({ includeMarker: true });
    runGit(fixture.remote, ['update-ref', 'refs/heads/main', fixture.localHead]);
    runGit(fixture.repo, ['update-ref', 'refs/remotes/origin/main', fixture.localHead]);
    const result = runHistoryGuard(
      fixture,
      `refs/heads/test-branch ${fixture.localHead} refs/heads/test-branch ${ZERO_SHA}\n`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('storia precedente alla riscrittura');
  });

  it('passes when the marker object is absent from a new clone', () => {
    const fixture = createHistoryGuardFixture({ includeMarker: false });
    const result = runHistoryGuard(
      fixture,
      `refs/heads/test-branch ${fixture.localHead} refs/heads/test-branch ${ZERO_SHA}\n`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('storia precedente alla riscrittura');
  });

  it('passes a remote-ref deletion even when the old marker is present', () => {
    const fixture = createHistoryGuardFixture({ includeMarker: true });
    const result = runHistoryGuard(
      fixture,
      `refs/heads/test-branch ${ZERO_SHA} refs/heads/test-branch ${fixture.localHead}\n`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('storia precedente alla riscrittura');
  });
});
