import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import {
  BODY_FILE_INFRA,
  extractPrBody,
  validatePrBody,
} from '../scripts/ci/pr-body-check-gate.mjs';
import { EXIT_BLOCK } from '../scripts/ci/lib/hook-exit-codes.mjs';

/**
 * Analogous to sibling-check-gate's PreToolUse contract: this hook intercepts
 * `gh pr create` and blocks (exit 1 + stderr) when the mandatory
 * `## Implementato` / `## Non implementato` headers (AGENTS.md § Workflow,
 * Non-Negotiable #8) are missing from the PR body. See #3325/#3326.
 */

const ROOT = resolve(import.meta.dirname, '..');
const GATE = resolve(ROOT, 'scripts/ci/pr-body-check-gate.mjs');
const SHIM = resolve(ROOT, 'scripts/gh-pr-body-check.mjs');
const RUN_MUTATION_GATE = resolve(ROOT, 'scripts/ci/run-mutation-gate.mjs');
const BODY_WRITE_GATE = resolve(ROOT, 'scripts/ci/pr-body-write-gate.mjs');

const BOTH_HEADERS = '## Implementato\n\nfoo\n\n## Non implementato (ancora)\n\nNessuno';
const MISSING_NON = '## Implementato\n\nfoo bar baz';
const MISSING_IMPL = '## Non implementato (ancora)\n\nNessuno';
const MISSING_BOTH = '## Summary\n\nfoo\n\n## Test plan\n\nbar';

function runGate(command: string, extraPayload: Record<string, unknown> = {}) {
  const payload = JSON.stringify({ tool_input: { command }, ...extraPayload });
  return spawnSync('node', [GATE], { input: payload, encoding: 'utf8' });
}

function runReviewGate(
  gate: string,
  command: string,
  env: Record<string, string> = {},
  extraPayload: Record<string, unknown> = {},
) {
  const payload = JSON.stringify({ tool_input: { command }, ...extraPayload });
  return spawnSync(process.execPath, [gate], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('extractPrBody', () => {
  it('extracts a simple double-quoted --body', () => {
    const cmdInline = `gh pr create --title "x" --body "hello world"`;
    expect(extractPrBody(cmdInline)).toBe('hello world');
  });

  it('extracts a single-quoted --body', () => {
    const cmd = `gh pr create --title 'x' --body 'hello world'`;
    expect(extractPrBody(cmd)).toBe('hello world');
  });

  it('extracts a heredoc --body "$(cat <<\'EOF\' ... EOF)"', () => {
    const cmd = [
      'gh pr create --title "x" --body "$(cat <<\'EOF\'',
      BOTH_HEADERS,
      'EOF',
      ')"',
    ].join('\n');
    expect(extractPrBody(cmd)).toBe(BOTH_HEADERS);
  });

  it('extracts --body-file content from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    const file = join(dir, 'body.md');
    writeFileSync(file, BOTH_HEADERS, 'utf8');
    try {
      const cmd = `gh pr create --title "x" --body-file ${file}`;
      expect(extractPrBody(cmd)).toBe(BOTH_HEADERS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no --body/--body-file is present', () => {
    expect(extractPrBody('gh pr create --title "x"')).toBeUndefined();
  });

  it('returns undefined when --body-file points at a missing path', () => {
    expect(
      extractPrBody('gh pr create --title "x" --body-file /nope/does-not-exist.md'),
    ).toBeUndefined();
  });

  // 2026-08-25: neither this function nor localDiffPaths() resolved a RELATIVE
  // --body-file against the directory the gated `gh pr create` was actually
  // running in — both defaulted to `process.cwd()`, this hook subprocess's
  // own ambient directory, which is NOT the worktree Claude Code's tracked
  // `cwd` (payload.cwd) points at. See scripts/ci/lib/hook-target-cwd.mjs.
  it('resolves a RELATIVE --body-file against the given cwd, not process.cwd()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    try {
      writeFileSync(join(dir, 'body.md'), BOTH_HEADERS, 'utf8');
      const cmd = `gh pr create --title "x" --body-file body.md`;
      // No cwd → resolves against process.cwd() (this test file's cwd), where
      // body.md does not exist.
      expect(extractPrBody(cmd)).toBeUndefined();
      // Given the worktree's cwd explicitly → finds it.
      expect(extractPrBody(cmd, dir)).toBe(BOTH_HEADERS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pr-body-check-gate hook (process behavior)', () => {
  const createdDirs: string[] = [];
  afterEach(() => {
    while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true });
  });

  it('passes through (exit 0) for non gh-pr-create commands', () => {
    const res = runGate('git status');
    expect(res.status).toBe(0);
  });

  it('allows (exit 0) when both headers are present', () => {
    const cmd = `gh pr create --title "x" --body '${BOTH_HEADERS}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(0);
  });

  it('blocks (EXIT_BLOCK=2) when `## Non implementato` is missing', () => {
    const cmd = `gh pr create --title "x" --body '${MISSING_NON}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/Non implementato/);
    expect(res.stderr).toMatch(/PR bloccata/);
  });

  it('blocks (EXIT_BLOCK=2) when `## Implementato` is missing', () => {
    const cmd = `gh pr create --title "x" --body '${MISSING_IMPL}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/Implementato/);
  });

  it('blocks (EXIT_BLOCK=2) when both headers are missing (## Summary/## Test plan variant)', () => {
    const cmd = `gh pr create --title "x" --body '${MISSING_BOTH}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/Implementato/);
    expect(res.stderr).toMatch(/Non implementato/);
  });

  it('allows (exit 0) when both headers are present via --body-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    createdDirs.push(dir);
    const file = join(dir, 'body.md');
    writeFileSync(file, BOTH_HEADERS, 'utf8');
    const cmd = `gh pr create --title "x" --body-file ${file}`;
    const res = runGate(cmd);
    expect(res.status).toBe(0);
  });

  it('blocks (EXIT_BLOCK=2) when a header is missing via --body-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    createdDirs.push(dir);
    const file = join(dir, 'body.md');
    writeFileSync(file, MISSING_NON, 'utf8');
    const cmd = `gh pr create --title "x" --body-file ${file}`;
    const res = runGate(cmd);
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/Non implementato/);
  });

  it('fails safe (exit 0) when body cannot be extracted at all', () => {
    // No --body / --body-file at all: gate should not block on its own
    // inability to locate the argument.
    const res = runGate('gh pr create --title "x"');
    expect(res.status).toBe(0);
  });

  // #6300 / recidiva #6289: `PR concatenata` senza `#N` deve bloccare
  // `gh pr create` (EXIT_BLOCK), non solo avvisare. Il gate remoto applica la
  // stessa regola tramite la CLI `--body-file`.
  it('blocks (EXIT_BLOCK=2) when a residual bullet says "PR concatenata" without #N', () => {
    const body =
      '## Implementato\n\n- fatto in questa PR\n\n## Non implementato (ancora)\n\n- foo — PR concatenata, non ancora aperta\n';
    const cmd = `gh pr create --title "x" --body '${body}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/PR concatenata/);
    expect(res.stderr).toMatch(/PR bloccata/);
  });

  it('allows (exit 0) when the residual bullet is "PR concatenata #6287"', () => {
    const body =
      '## Implementato\n\n- fatto in questa PR\n\n## Non implementato (ancora)\n\n- foo — PR concatenata #6287\n';
    const cmd = `gh pr create --title "x" --body '${body}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(0);
  });

  it('blocks a generic stateless residual bullet before the PR is created', () => {
    const body =
      '## Implementato\n\n- fatto in questa PR\n\n## Non implementato (ancora)\n\n- foo resta da fare più tardi\n';
    const cmd = `gh pr create --title "x" --body '${body}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/bullet-without-state/);
  });

  it('uses the same strict pure validator for the hook and the workflow CLI', () => {
    const body =
      '## Implementato\n\n- fatto in questa PR\n\n## Non implementato (ancora)\n\n- foo resta da fare più tardi\n';
    const result = validatePrBody(body);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.type)).toContain('bullet-without-state');
  });

  it('returns EXIT_BLOCK from the workflow CLI for a contract violation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-cli-'));
    createdDirs.push(dir);
    const file = join(dir, 'body.md');
    writeFileSync(file, MISSING_NON, 'utf8');
    const res = spawnSync('node', [GATE, '--body-file', file], { encoding: 'utf8' });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/body PR non conforme/);
  });

  it('returns a distinct infrastructure code when the workflow body file is unreadable', () => {
    const file = join(tmpdir(), `missing-pr-body-${process.pid}-${Date.now()}.md`);
    const res = spawnSync('node', [GATE, '--body-file', file], { encoding: 'utf8' });
    expect(res.status).toBe(BODY_FILE_INFRA);
    expect(res.stderr).toMatch(/body-file non leggibile/);
  });

  it('the workflow gh shim blocks a create that omits the body-file', () => {
    const res = spawnSync('node', [SHIM, 'pr', 'create', '--title', 'x'], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/richiede `--body-file`/);
  });

  it('the workflow gh shim blocks inline body writes for create and edit', () => {
    for (const args of [
      ['pr', 'create', '--body', 'body'],
      ['pr', 'edit', '123', '--body', 'body'],
      ['pr', 'create', '-b', 'body'],
      ['pr', 'edit', '123', '-b', 'body'],
    ]) {
      const res = spawnSync('node', [SHIM, ...args], { encoding: 'utf8' });
      expect(res.status).toBe(EXIT_BLOCK);
      expect(res.stderr).toMatch(/body.*inline/);
    }
  });

  it('the workflow gh shim recognizes the short body-file alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-shim-'));
    createdDirs.push(dir);
    const file = join(dir, 'body.md');
    writeFileSync(file, MISSING_NON, 'utf8');
    const res = spawnSync(process.execPath, [SHIM, 'pr', 'create', '-F', file], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/Non implementato/);
  });

  it('passes through non-body `gh pr edit` mutations to the real gh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-shim-'));
    createdDirs.push(dir);
    const fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\nprintf \'real-gh-called\\n\'\n', 'utf8');
    chmodSync(fakeGh, 0o755);
    const res = spawnSync(process.execPath, [SHIM, 'pr', 'edit', '123', '--add-label', 'needs-human'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir,
        PR_BODY_GATE_BIN: join(dir, 'wrapper-bin'),
      },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('real-gh-called');
  });

  it('the workflow gh shim skips an unreadable body-file without failing the job', () => {
    const file = join(tmpdir(), `missing-shim-pr-body-${process.pid}-${Date.now()}.md`);
    const res = spawnSync(process.execPath, [SHIM, 'pr', 'create', '--body-file', file], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/nessun body PR scritto/);
  });

  it('the workflow gh shim treats a remote gh failure as infrastructure after validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-shim-'));
    createdDirs.push(dir);
    const file = join(dir, 'body.md');
    writeFileSync(file, BOTH_HEADERS, 'utf8');
    const res = spawnSync(process.execPath, [SHIM, 'pr', 'create', '--body-file', file], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '', PR_BODY_GATE_BIN: join(dir, 'wrapper-bin') },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/gh non avviabile/);
  });

  // 2026-08-25: end-to-end proof that payload.cwd reaches extractPrBody, not
  // just the unit-level default-parameter test above. Without the fix this
  // command would exit 0 fail-safe (relative body-file unreadable from this
  // hook subprocess's own ambient cwd → extractPrBody returns undefined →
  // "can't verify, don't block") EVEN THOUGH the body is missing a header.
  it('blocks (EXIT_BLOCK=2) via a RELATIVE --body-file resolved against payload.cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    createdDirs.push(dir);
    writeFileSync(join(dir, 'body.md'), MISSING_NON, 'utf8');
    const cmd = 'gh pr create --title "x" --body-file body.md';
    const res = runGate(cmd, { cwd: dir });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/Non implementato/);
  });

  it('blocks via a RELATIVE --body-file in the command worktree when payload.cwd points elsewhere', () => {
    const tracked = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-tracked-'));
    const worktree = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-worktree-'));
    createdDirs.push(tracked, worktree);
    writeFileSync(join(worktree, 'body.md'), MISSING_NON, 'utf8');
    const cmd = `cd "${worktree}" && gh pr create --title "x" --body-file body.md`;
    const res = runGate(cmd, { cwd: tracked });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/Non implementato/);
  });

  it('fails safe when a --body-file path is absent instead of reporting a header violation', () => {
    const tracked = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-tracked-'));
    createdDirs.push(tracked);
    const res = runGate('gh pr create --title "x" --body-file missing-body.md', { cwd: tracked });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/header obbligatori mancanti/);
  });

  it('without payload.cwd, the same relative --body-file fails safe (exit 0) — the pre-fix behaviour', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    createdDirs.push(dir);
    writeFileSync(join(dir, 'body.md'), MISSING_NON, 'utf8');
    const cmd = 'gh pr create --title "x" --body-file body.md';
    const res = runGate(cmd); // no cwd in payload
    expect(res.status).toBe(0);
  });
});

describe('B22 review-efficiency gates — process invariants', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true });
  });

  function stateDir() {
    const dir = mkdtempSync(join(tmpdir(), 'b22-hook-state-'));
    createdDirs.push(dir);
    return dir;
  }

  it('blocks `gh run rerun` without an explicit authorization reason', () => {
    const res = runReviewGate(RUN_MUTATION_GATE, 'gh run rerun 123');
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toContain('384.354');
    expect(res.stderr).toMatch(/log|verde/i);
    expect(res.stderr).toContain('FRONTALIERE_RUN_MUTATION_REASON');
  });

  it('allows one authorized run mutation, then blocks above the per-run cap', () => {
    const env = {
      FRONTALIERE_HOOK_STATE_DIR: stateDir(),
      FRONTALIERE_RUN_MUTATION_REASON: 'guasto ambiente esterno alla PR',
    };
    const first = runReviewGate(RUN_MUTATION_GATE, 'gh run rerun 123', env);
    const second = runReviewGate(RUN_MUTATION_GATE, 'gh run rerun 123', env);

    expect(first.status).toBe(0);
    expect(second.status).toBe(EXIT_BLOCK);
    expect(second.stderr).toMatch(/tetto|cap/i);
  });

  it.each([
    ['quoted data', `printf '%s' 'gh run rerun 123'`],
    ['heredoc data', "cat <<'EOF'\ngh run rerun 123\nEOF"],
    ['comment data', "# gh run rerun 123\nprintf '%s' ok"],
  ])('passes when rerun words are %s, not an executed command', (_label, command) => {
    const res = runReviewGate(RUN_MUTATION_GATE, command);
    expect(res.status).toBe(0);
  });

  it('passes when mutation state is unreadable (fail-safe)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'b22-hook-state-error-'));
    createdDirs.push(parent);
    const statePath = join(parent, 'state-file');
    writeFileSync(statePath, 'not a directory', 'utf8');
    const res = runReviewGate(RUN_MUTATION_GATE, 'gh run cancel 456', {
      FRONTALIERE_HOOK_STATE_DIR: statePath,
      FRONTALIERE_RUN_MUTATION_REASON: 'guasto ambiente esterno alla PR',
    });
    expect(res.status).toBe(0);
  });

  it('allows the first body write for a PR and blocks the second', () => {
    const env = { FRONTALIERE_HOOK_STATE_DIR: stateDir() };
    const command = 'gh pr edit 8076 --body-file /tmp/body.md';
    const first = runReviewGate(BODY_WRITE_GATE, command, env);
    const second = runReviewGate(BODY_WRITE_GATE, command, env);

    expect(first.status).toBe(0);
    expect(second.status).toBe(EXIT_BLOCK);
    expect(second.stderr).toMatch(/seconda|second|riscrittura/i);
    expect(second.stderr).toContain('FRONTALIERE_ALLOW_PR_BODY_REWRITE_REASON');
  });

  it('allows an explicitly authorized body correction after the first write', () => {
    const env = { FRONTALIERE_HOOK_STATE_DIR: stateDir() };
    const command = 'gh pr edit 8076 --body-file /tmp/body.md';
    expect(runReviewGate(BODY_WRITE_GATE, command, env).status).toBe(0);
    const override = runReviewGate(BODY_WRITE_GATE, command, {
      ...env,
      FRONTALIERE_ALLOW_PR_BODY_REWRITE_REASON: 'correzione richiesta dal gate del body',
    });

    expect(override.status).toBe(0);
    expect(override.stderr).toContain('correzione richiesta dal gate del body');
  });

  it('keeps body state separate per PR and ignores non-body edits', () => {
    const env = { FRONTALIERE_HOOK_STATE_DIR: stateDir() };
    expect(runReviewGate(BODY_WRITE_GATE, 'gh pr edit 8076 --add-label needs-human', env).status).toBe(0);
    expect(runReviewGate(BODY_WRITE_GATE, 'gh pr edit 8076 --body "first"', env).status).toBe(0);
    expect(runReviewGate(BODY_WRITE_GATE, 'gh pr edit 8077 --body "first"', env).status).toBe(0);
  });

  it('passes on an unparseable command instead of blocking it', () => {
    const res = runReviewGate(RUN_MUTATION_GATE, 'gh run "rerun 123');
    expect(res.status).toBe(0);
  });

  it('passes when the hook payload itself is malformed', () => {
    const res = spawnSync(process.execPath, [RUN_MUTATION_GATE], {
      input: 'not-json: gh run rerun 123',
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
  });
});
