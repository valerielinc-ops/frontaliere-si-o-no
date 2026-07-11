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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOOK = resolve(ROOT, '.githooks/pre-push');

// Run the hook with a stubbed `node` binary prepended to PATH so the real
// check-sibling-patterns.mjs (multi-minute on this repo) never executes; the
// stub exits 42, letting us assert *whether* the gate would have run without
// paying its cost.
function runHook({ githubActions, stdinRefs }: { githubActions?: string; stdinRefs: string }) {
  const stubDir = mkdtempSync(join(tmpdir(), 'pre-push-guard-'));
  const marker = join(stubDir, 'gate-ran');
  writeFileSync(
    join(stubDir, 'node'),
    `#!/usr/bin/env bash\necho ran > "${marker}"\nexit 42\n`,
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
    try {
      gateRan = readFileSync(marker, 'utf8').includes('ran');
    } catch {
      gateRan = false;
    }
    return { code, stdout, gateRan };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
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
    const { code, gateRan } = runHook({ githubActions: 'true', stdinRefs: BRANCH_REF });
    expect(gateRan).toBe(true);
    expect(code).toBe(42);
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
