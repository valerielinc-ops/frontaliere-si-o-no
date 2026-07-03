import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { extractPrBody } from '../scripts/ci/pr-body-check-gate.mjs';

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

function runGate(command: string) {
  const payload = JSON.stringify({ tool_input: { command } });
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

  it('blocks (exit 1) when `## Non implementato` is missing', () => {
    const cmd = `gh pr create --title "x" --body '${MISSING_NON}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Non implementato/);
    expect(res.stderr).toMatch(/PR bloccata/);
  });

  it('blocks (exit 1) when `## Implementato` is missing', () => {
    const cmd = `gh pr create --title "x" --body '${MISSING_IMPL}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Implementato/);
  });

  it('blocks (exit 1) when both headers are missing (## Summary/## Test plan variant)', () => {
    const cmd = `gh pr create --title "x" --body '${MISSING_BOTH}'`;
    const res = runGate(cmd);
    expect(res.status).toBe(1);
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

  it('blocks (exit 1) when a header is missing via --body-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-check-gate-'));
    createdDirs.push(dir);
    const file = join(dir, 'body.md');
    writeFileSync(file, MISSING_NON, 'utf8');
    const cmd = `gh pr create --title "x" --body-file ${file}`;
    const res = runGate(cmd);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Non implementato/);
  });

  it('fails safe (exit 0) when body cannot be extracted at all', () => {
    // No --body / --body-file at all: gate should not block on its own
    // inability to locate the argument.
    const res = runGate('gh pr create --title "x"');
    expect(res.status).toBe(0);
  });
});
