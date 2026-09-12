import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { createGithubIssueMock, commentOnGithubIssueMock, execFileSyncMock } = vi.hoisted(() => ({
  createGithubIssueMock: vi.fn(),
  commentOnGithubIssueMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('../scripts/lib/github-issue-creator.mjs', () => ({
  createGithubIssue: createGithubIssueMock,
  commentOnGithubIssue: commentOnGithubIssueMock,
  searchSafePrefix: (title: string) => String(title).slice(0, 60),
}));

vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
  return { ...mock, default: mock };
});

describe('scan-job-timeouts — conserva lo stato restituito dal creator (#8032)', () => {
  const now = new Date().toISOString();
  const runs = [1, 2].map((id) => ({
    id,
    name: 'Lighthouse CI',
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    event: 'push',
    head_branch: 'main',
    created_at: now,
    updated_at: now,
  }));

  beforeEach(() => {
    execFileSyncMock.mockReset();
    createGithubIssueMock.mockReset();
    commentOnGithubIssueMock.mockReset();
    vi.resetModules();
    process.env.GH_REPO = 'o/r';
    delete process.env.ENABLE_FAILURE_REPORT;
  });

  afterEach(() => {
    delete process.env.GH_REPO;
  });

  it('non commenta una issue CLOSED su una seconda run con lo stesso titolo', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const endpoint = String(args[1]);
        if (endpoint.includes('actions/runs?status=cancelled')) {
          return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
        }
        if (endpoint.includes('actions/runs?status=failure')) {
          return JSON.stringify({ total_count: 0, workflow_runs: [] });
        }
        if (endpoint.includes('/actions/runs/1/jobs')) {
          return JSON.stringify({ jobs: [{
            name: 'lighthouse-1',
            conclusion: 'cancelled',
            check_run_url: 'https://api.github.com/repos/o/r/check-runs/1',
          }] });
        }
        if (endpoint.includes('/actions/runs/2/jobs')) {
          return JSON.stringify({ jobs: [{
            name: 'lighthouse-2',
            conclusion: 'cancelled',
            check_run_url: 'https://api.github.com/repos/o/r/check-runs/2',
          }] });
        }
        if (endpoint.endsWith('/annotations')) {
          return JSON.stringify([[
            { message: 'The job exceeded the maximum execution time of 45 minutes.' },
          ]]);
        }
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      return '';
    });
    createGithubIssueMock
      .mockResolvedValueOnce({ number: 42, title: 'CI Failure: Lighthouse CI', state: 'CLOSED', persisted: true })
      .mockResolvedValueOnce({ number: 43, title: 'CI Failure: Lighthouse CI', state: 'OPEN', persisted: true });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(createGithubIssueMock).toHaveBeenCalledTimes(2);
    expect(commentOnGithubIssueMock).not.toHaveBeenCalled();
  });
});
