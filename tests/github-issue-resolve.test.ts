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

function mockOpenCanonical(opts: { closeOk?: boolean; viewState?: string | null } = {}) {
  const { closeOk = true, viewState = 'CLOSED' } = opts;
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'list') {
      return JSON.stringify([
        { number: 1247, title: 'Validation Failure (dist): post-deploy', url: 'u', state: 'OPEN' },
      ]);
    }
    if (args[0] === 'issue' && args[1] === 'close') {
      if (!closeOk) throw new Error('HTTP 403: Resource not accessible by integration');
      return 'https://github.com/o/r/issues/1247';
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      if (viewState == null) throw new Error('HTTP 502');
      return JSON.stringify({ state: viewState });
    }
    return '';
  });
}

describe('resolveGithubIssue — close canonical issue on green', () => {
  it('closes the OPEN canonical issue (comment + close --reason completed)', () => {
    mockOpenCanonical();

    const res = resolveGithubIssue('Validation Failure (dist): post-deploy', {
      workflow: 'Post-deploy Validate Dist',
      runUrl: 'https://example/run/1',
    });

    expect(res?.number).toBe(1247);
    expect(res?.persisted).toBe(true);
    const calls = ghCalls();
    const close = calls.find((a) => a[0] === 'issue' && a[1] === 'close');
    expect(close).toBeTruthy();
    expect(close).toContain('1247');
    expect(close).toContain('--reason');
    expect(close).toContain('completed');
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.[2]).toBe('1247');
    const view = calls.find((a) => a[0] === 'issue' && a[1] === 'view');
    expect(view).toContain('1247');
    expect(view).toContain('--json');
    expect(view).toContain('state');
  });

  it('does not report success when gh issue close is refused', () => {
    mockOpenCanonical({ closeOk: false, viewState: 'OPEN' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let caught: unknown;
    try {
      resolveGithubIssue('Validation Failure (dist): post-deploy', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/could not close #1247 \(close rejected\)/);
    expect((caught as { persisted?: boolean }).persisted).toBe(false);
    expect((caught as { number?: number }).number).toBe(1247);

    errorSpy.mockRestore();
  });

  it('does not report success when close stdout is non-null but the issue stays OPEN', () => {
    mockOpenCanonical({ closeOk: true, viewState: 'OPEN' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resolveGithubIssue('Validation Failure (dist): post-deploy', {})).toThrow(
      /could not close #1247 \(post-condition not closed\)/,
    );

    errorSpy.mockRestore();
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
