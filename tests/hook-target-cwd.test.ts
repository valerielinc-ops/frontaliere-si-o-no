/**
 * hook-target-cwd.mjs — resolveHookTargetCwd tests.
 *
 * See the module's own header for the two cwd signals exercised here:
 * `payload.cwd` is the tracked fallback, while a literal command `cd` carries
 * the real Codex/sub-agent worktree when the payload stays at the launch root.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeHookTargetCwdFailure,
  resolveHookTargetCwd,
  resolveHookTargetCwdDetails,
} from '../scripts/ci/lib/hook-target-cwd.mjs';

describe('resolveHookTargetCwd', () => {
  it('returns the directory when payload.cwd exists on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-target-cwd-'));
    try {
      expect(resolveHookTargetCwd({ cwd: dir })).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers a literal command cd over a tracked cwd from the payload', () => {
    const tracked = mkdtempSync(join(tmpdir(), 'hook-target-cwd-tracked-'));
    const worktree = mkdtempSync(join(tmpdir(), 'hook-target-cwd-worktree-'));
    try {
      expect(
        resolveHookTargetCwd(
          { cwd: tracked },
          `cd "${worktree}" && gh pr create --title x`,
        ),
      ).toBe(worktree);
    } finally {
      rmSync(tracked, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('retains a non-repository literal cd as an explicit failure', () => {
    const tracked = mkdtempSync(join(tmpdir(), 'hook-target-cwd-tracked-'));
    const outsideRepo = mkdtempSync(join(tmpdir(), 'hook-target-cwd-outside-'));
    try {
      const resolution = resolveHookTargetCwdDetails(
        { cwd: tracked },
        `cd "${outsideRepo}" && gh pr create --title x`,
      );
      expect(resolution.cwd).toBe(outsideRepo);
      expect(resolution.error).toEqual({ kind: 'non-repository', path: outsideRepo });
      expect(describeHookTargetCwdFailure(resolution)).toContain('non appartiene');
    } finally {
      rmSync(tracked, { recursive: true, force: true });
      rmSync(outsideRepo, { recursive: true, force: true });
    }
  });

  it('rejects a relative cd that resolves to a nested different worktree', () => {
    const tracked = mkdtempSync(join(tmpdir(), 'hook-target-cwd-tracked-'));
    const foreign = join(tracked, 'foreign-worktree');
    mkdirSync(foreign);
    execFileSync('git', ['init', '-q', tracked], { stdio: 'ignore' });
    execFileSync('git', ['init', '-q', foreign], { stdio: 'ignore' });
    try {
      const command = 'cd foreign-worktree && gh pr create --title x';
      const resolution = resolveHookTargetCwdDetails({ cwd: tracked }, command);
      expect(resolution.cwd).toBeUndefined();
      expect(resolution.error).toEqual({ kind: 'different-worktree', path: foreign });
      expect(resolveHookTargetCwd({ cwd: tracked }, command)).toBeUndefined();
      expect(describeHookTargetCwdFailure(resolution)).toContain('worktree diverso');
    } finally {
      rmSync(tracked, { recursive: true, force: true });
    }
  });

  it('ignores a shell-substituted command cd and keeps the tracked cwd', () => {
    const tracked = mkdtempSync(join(tmpdir(), 'hook-target-cwd-tracked-'));
    try {
      expect(
        resolveHookTargetCwd(
          { cwd: tracked },
          'cd "$(git rev-parse --show-toplevel)" && gh pr create --title x',
        ),
      ).toBe(tracked);
    } finally {
      rmSync(tracked, { recursive: true, force: true });
    }
  });

  it('does not read a cd phrase from the PR body as a command cwd', () => {
    const tracked = mkdtempSync(join(tmpdir(), 'hook-target-cwd-tracked-'));
    try {
      expect(
        resolveHookTargetCwd(
          { cwd: tracked },
          'gh pr create --body "testo: cd /tmp && gh pr create"',
        ),
      ).toBe(tracked);
    } finally {
      rmSync(tracked, { recursive: true, force: true });
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
