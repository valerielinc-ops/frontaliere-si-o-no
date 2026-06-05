import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock `gh` invocations, routed by sub-command — same approach as
// github-issue-creator-gate.test.ts.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const { resolveGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.GH_REPO;
  delete process.env.ENABLE_FAILURE_REPORT;
});

describe('resolveGithubIssue — close canonical issue on green', () => {
  it('closes the OPEN canonical issue (comment + close --reason completed)', () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          { number: 1247, title: 'Validation Failure (dist): post-deploy', url: 'u', state: 'OPEN' },
        ]);
      }
      return ''; // comment + close succeed
    });

    const res = resolveGithubIssue('Validation Failure (dist): post-deploy', {
      workflow: 'Post-deploy Validate Dist',
      runUrl: 'https://example/run/1',
    });

    expect(res?.number).toBe(1247);
    const calls = ghCalls();
    const close = calls.find((a) => a[0] === 'issue' && a[1] === 'close');
    expect(close).toBeTruthy();
    expect(close).toContain('1247');
    expect(close).toContain('--reason');
    expect(close).toContain('completed');
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.[2]).toBe('1247');
  });

  it('is a no-op when no matching OPEN issue exists', () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      return '';
    });

    const res = resolveGithubIssue('CI Failure (build): Deploy to GitHub Pages', {});

    expect(res).toBeNull();
    expect(ghCalls().some((a) => a[1] === 'close')).toBe(false);
  });

  it('only matches an exact stable-title prefix, not a fuzzy token hit', () => {
    // gh search is fuzzy: a "(live)" issue must not be closed by a "(dist)" green.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          { number: 800, title: 'Validation Failure (live): post-deploy', url: 'u', state: 'OPEN' },
        ]);
      }
      return '';
    });

    const res = resolveGithubIssue('Validation Failure (dist): post-deploy', {});

    expect(res).toBeNull();
    expect(ghCalls().some((a) => a[1] === 'close')).toBe(false);
  });

  it('respects ENABLE_FAILURE_REPORT=false (skips entirely)', () => {
    process.env.ENABLE_FAILURE_REPORT = 'false';
    const res = resolveGithubIssue('Validation Failure (dist): post-deploy', {});
    expect(res).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
