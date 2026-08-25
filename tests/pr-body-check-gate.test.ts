import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { extractPrBody } from '../scripts/ci/pr-body-check-gate.mjs';
import { EXIT_BLOCK } from '../scripts/ci/lib/hook-exit-codes.mjs';

/**
 * Analogous to sibling-check-gate's PreToolUse contract: this hook intercepts
 * `gh pr create` and blocks (exit 1 + stderr) when the mandatory
 * `## Implementato` / `## Non implementato` headers (AGENTS.md § Workflow,
 * Non-Negotiable #8) are missing from the PR body. See #3325/#3326.
 */

const ROOT = resolve(import.meta.dirname, '..');
const GATE = resolve(ROOT, 'scripts/ci/pr-body-check-gate.mjs');

const BOTH_HEADERS = '## Implementato\n\nfoo\n\n## Non implementato (ancora)\n\nNessuno';
const MISSING_NON = '## Implementato\n\nfoo bar baz';
const MISSING_IMPL = '## Non implementato (ancora)\n\nNessuno';
const MISSING_BOTH = '## Summary\n\nfoo\n\n## Test plan\n\nbar';

function runGate(command: string, extraPayload: Record<string, unknown> = {}) {
  const payload = JSON.stringify({ tool_input: { command }, ...extraPayload });
  return spawnSync('node', [GATE], { input: payload, encoding: 'utf8' });
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
  // `gh pr create` (EXIT_BLOCK), non solo avvisare. I restanti bullet
  // senza stato restano advisory.
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

  it('does not promote a generic stateless bullet to EXIT_BLOCK', () => {
    const body =
      '## Implementato\n\n- fatto in questa PR\n\n## Non implementato (ancora)\n\n- foo resta da fare più tardi\n';
    const cmd = `gh pr create --title "x" --body '${body}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(0);
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

  it('without payload.cwd, the same relative --body-file fails safe (exit 0) — the pre-fix behaviour', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    createdDirs.push(dir);
    writeFileSync(join(dir, 'body.md'), MISSING_NON, 'utf8');
    const cmd = 'gh pr create --title "x" --body-file body.md';
    const res = runGate(cmd); // no cwd in payload
    expect(res.status).toBe(0);
  });
});
