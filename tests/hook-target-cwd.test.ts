/**
 * hook-target-cwd.mjs — resolveHookTargetCwd tests.
 *
 * See the module's own header for the bug this closes: neither
 * sibling-check-gate.mjs nor pr-body-check-gate.mjs read the PreToolUse
 * payload's `cwd` field, so their child `git`/`readFileSync` calls ran
 * against whichever ambient directory the hook subprocess itself happened
 * to have — not the worktree the gated `gh pr create` was actually in.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHookTargetCwd } from '../scripts/ci/lib/hook-target-cwd.mjs';

describe('resolveHookTargetCwd', () => {
  it('returns the directory when payload.cwd exists on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-target-cwd-'));
    try {
      expect(resolveHookTargetCwd({ cwd: dir })).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when payload.cwd is missing', () => {
    expect(resolveHookTargetCwd({})).toBeUndefined();
    expect(resolveHookTargetCwd(null as unknown as Record<string, unknown>)).toBeUndefined();
    expect(resolveHookTargetCwd(undefined as unknown as Record<string, unknown>)).toBeUndefined();
  });

  it('returns undefined when payload.cwd points at a nonexistent path', () => {
    expect(resolveHookTargetCwd({ cwd: '/definitely/does/not/exist/anywhere' })).toBeUndefined();
  });

  it('returns undefined when payload.cwd points at a FILE, not a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-target-cwd-'));
    const file = join(dir, 'not-a-dir.txt');
    writeFileSync(file, 'x', 'utf8');
    try {
      expect(resolveHookTargetCwd({ cwd: file })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when payload.cwd is not a string', () => {
    expect(resolveHookTargetCwd({ cwd: 123 as unknown as string })).toBeUndefined();
    expect(resolveHookTargetCwd({ cwd: '' })).toBeUndefined();
  });
});
