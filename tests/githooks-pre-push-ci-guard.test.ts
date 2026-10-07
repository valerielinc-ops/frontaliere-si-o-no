// @vitest-environment node
// Tests for the .githooks/pre-push CI automation guard (article-generation
// outage 2026-07-08→10): npm ci's `prepare` activates core.hooksPath=.githooks
// inside GitHub Actions jobs too, where data-refresh workflows push generated
// content straight to main. The strict sibling gate rejected every article
// push (run 29090019854: 13 generated files → 10871 sibling candidates →
// exit 1 → "Article is LOST" ×10 attempts), zeroing article production.
// The guard skips the gate ONLY when running under GitHub Actions AND every
// pushed ref targets main; dev pushes (local) and Actions pushes to claude/*
// branches (issue-fix agents — the gate's designed audience) still run it.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOOK = resolve(ROOT, '.githooks/pre-push');
const OLD_HISTORY_GUARD = resolve(ROOT, 'scripts/lib/old-history-guard.mjs');
const SINGLE_FLIGHT_LOCK = resolve(ROOT, 'scripts/lib/single-flight-lock.mjs');
const ZERO_SHA = '0'.repeat(40);

// Run the hook with a stubbed `node` binary prepended to PATH so the real
// check-sibling-patterns.mjs (multi-minute on this repo) never executes; the
// stub exits 42, letting us assert *whether* the gate would have run without
// paying its cost.
function runHook({ githubActions, stdinRefs }: { githubActions?: string; stdinRefs: string }) {
  const stubDir = mkdtempSync(join(tmpdir(), 'pre-push-guard-'));
  const marker = join(stubDir, 'gate-ran');
  const argsFile = join(stubDir, 'gate-args');
  writeFileSync(
    join(stubDir, 'node'),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == *old-history-guard.mjs ]]; then exit 0; fi\necho ran > "${marker}"\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 42\n`,
  );
  chmodSync(join(stubDir, 'node'), 0o755);
  try {
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [HOOK, 'origin', 'https://github.com/x/y'], {
        cwd: ROOT,
        env: {
          PATH: `${stubDir}:${process.env.PATH}`,
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
    let args: string[] = [];
    try {
      gateRan = readFileSync(marker, 'utf8').includes('ran');
    } catch {
      gateRan = false;
    }
    try {
      args = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      args = [];
    }
    return { code, stdout, gateRan, args };
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
const BRANCH_REF =
  'refs/heads/claude/fix-x 1111111111111111111111111111111111111111 refs/heads/claude/fix-x 2222222222222222222222222222222222222222\n';

describe('.githooks/pre-push CI automation guard', () => {
  it('skips the sibling gate for a GitHub Actions push to main (data-refresh/article path)', () => {
    const { code, stdout, gateRan } = runHook({ githubActions: 'true', stdinRefs: MAIN_REF });
    expect(code).toBe(0);
    expect(stdout).toMatch(/skipped/);
    expect(gateRan).toBe(false);
  });

  it('still runs the gate for a GitHub Actions push to a claude/* branch (issue-fix agents)', () => {
    const { code, gateRan, args } = runHook({ githubActions: 'true', stdinRefs: BRANCH_REF });
    expect(gateRan).toBe(true);
    expect(code).toBe(42);
    expect(args).toContain('--head');
    expect(args).toContain('1111111111111111111111111111111111111111');
  });

  it('still runs the gate for a mixed push (main + branch) under GitHub Actions', () => {
    const { gateRan } = runHook({ githubActions: 'true', stdinRefs: MAIN_REF + BRANCH_REF });
    expect(gateRan).toBe(true);
  });

  it('still runs the gate for a local dev push to main (GITHUB_ACTIONS unset)', () => {
    const { code, gateRan } = runHook({ stdinRefs: MAIN_REF });
    expect(gateRan).toBe(true);
    expect(code).toBe(42);
  });

  it('still runs the gate when stdin lists no refs (nothing to classify — fail closed)', () => {
    const { gateRan } = runHook({ githubActions: 'true', stdinRefs: '' });
    expect(gateRan).toBe(true);
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
