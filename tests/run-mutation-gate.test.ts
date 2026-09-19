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

/**
 * Same class as `tests/pr-body-write-gate.test.ts`: the authorization must be
 * reachable by the caller the gate stops. An agent cannot set a variable in
 * the hook's process, so the declaration has to ride the command line.
 */
describe('run-mutation-gate: the authorization is reachable from the command', () => {
  function runCommand(stateRoot: string, command: string) {
    const env = { ...process.env, FRONTALIERE_HOOK_STATE_DIR: stateRoot };
    delete env.GITHUB_REPOSITORY;
    delete env.GH_REPO;
    delete env.FRONTALIERE_RUN_MUTATION_REASON;
    return spawnSync(process.execPath, [GATE], {
      input: JSON.stringify({ cwd: ROOT, tool_input: { command } }),
      encoding: 'utf8',
      env,
    });
  }

  it('accepts the reason declared on the same line as the command', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'run-mutation-inline-'));
    roots.push(stateRoot);

    const declared = runCommand(
      stateRoot,
      "FRONTALIERE_RUN_MUTATION_REASON='runner morto a meta job' gh run rerun 987654",
    );
    expect(declared.status).toBe(0);

    // The cap still holds: one authorized attempt, not a bypass.
    const second = runCommand(
      stateRoot,
      "FRONTALIERE_RUN_MUTATION_REASON='runner morto a meta job' gh run rerun 987654",
    );
    expect(second.status).toBe(EXIT_BLOCK);
    expect(second.stderr).toMatch(/tetto raggiunto/);
  });

  it('still blocks an undeclared rerun and shows the in-command form', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'run-mutation-undeclared-'));
    roots.push(stateRoot);

    const blocked = runCommand(stateRoot, 'gh run rerun 987655');
    expect(blocked.status).toBe(EXIT_BLOCK);
    expect(blocked.stderr).toContain("FRONTALIERE_RUN_MUTATION_REASON='");
    expect(blocked.stderr).toContain("non vede l'ambiente della tua shell");
  });

  it('does not accept a reason that reached the hook unexpanded', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'run-mutation-unexpanded-'));
    roots.push(stateRoot);

    const blocked = runCommand(stateRoot, 'FRONTALIERE_RUN_MUTATION_REASON="$MOTIVO" gh run rerun 987656');
    expect(blocked.status).toBe(EXIT_BLOCK);
  });
});
