// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT_BLOCK } from '../scripts/ci/lib/hook-exit-codes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GATE = resolve(ROOT, 'scripts/ci/run-mutation-gate.mjs');
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function runGate(stateRoot: string, cwd: string, runId: string) {
  const env = {
    ...process.env,
    FRONTALIERE_HOOK_STATE_DIR: stateRoot,
    FRONTALIERE_RUN_MUTATION_REASON: 'verifica ambiente esterno',
  };
  delete env.GITHUB_REPOSITORY;
  delete env.GH_REPO;
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({
      cwd,
      tool_input: { command: `gh run rerun ${runId}` },
    }),
    encoding: 'utf8',
    env,
  });
}

describe('run-mutation-gate repository scope', () => {
  it('uses the payload cwd origin before enforcing the per-run cap', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'run-mutation-state-'));
    roots.push(stateRoot);

    const first = runGate(stateRoot, ROOT, '12345');
    const second = runGate(stateRoot, ROOT, '12345');

    expect(first.status).toBe(0);
    expect(second.status).toBe(EXIT_BLOCK);
    expect(second.stderr).toMatch(/tetto raggiunto/);
    const files = readdirSync(join(stateRoot, 'run-mutations'));
    expect(files).toHaveLength(1);
  });

  it('passes safely without creating an ambient marker for an unknown target', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'run-mutation-unknown-'));
    const firstCwd = mkdtempSync(join(tmpdir(), 'unknown-hook-target-'));
    const secondCwd = mkdtempSync(join(tmpdir(), 'unknown-hook-target-'));
    roots.push(stateRoot, firstCwd, secondCwd);

    const first = runGate(stateRoot, firstCwd, '12345');
    const second = runGate(stateRoot, secondCwd, '12345');

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(() => readdirSync(join(stateRoot, 'run-mutations'))).toThrow();
  });
});
