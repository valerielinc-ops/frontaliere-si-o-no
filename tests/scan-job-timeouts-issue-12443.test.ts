import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for #12443. The five real incidents in the issue were
// cancelled runs whose timeout annotation was invisible to every in-job
// `if: failure()` reporter. The other five fixtures model concurrency/manual
// cancellations and must not produce a false positive.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const nowIso = () => new Date().toISOString();
const calls = () => execFileSync.mock.calls
  .filter((call) => call[0] === 'gh')
  .map((call) => call[1] as string[]);
const issueCreates = () => calls().filter((args) => args[0] === 'issue' && args[1] === 'create');

function run(id: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    event: 'schedule',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'cancelled',
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
}

function timeoutJob(id: number) {
  return {
    name: `job-${id}`,
    conclusion: 'cancelled',
    check_run_url: `https://api.github.com/repos/o/r/check-runs/${id}`,
  };
}

function installGh({
  cancelledRuns = [],
  failedRuns = [],
  completedRuns = [],
  jobs = new Map<number, unknown>(),
  annotations = new Map<number, unknown>(),
}: {
  cancelledRuns?: unknown[];
  failedRuns?: unknown[];
  completedRuns?: unknown[];
  jobs?: Map<number, unknown>;
  annotations?: Map<number, unknown>;
} = {}) {
  execFileSync.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'api') {
      const path = String(args[1]);
      if (path.includes('actions/runs?status=cancelled')) {
        return JSON.stringify({ total_count: cancelledRuns.length, workflow_runs: cancelledRuns });
      }
      if (path.includes('actions/runs?status=failure')) {
        return JSON.stringify({ total_count: failedRuns.length, workflow_runs: failedRuns });
      }
      if (path.includes('actions/runs?status=startup_failure')) {
        const startupRuns = completedRuns.filter((candidate) => candidate?.conclusion === 'startup_failure');
        return JSON.stringify({ total_count: startupRuns.length, workflow_runs: startupRuns });
      }
      if (path.includes('actions/runs?status=completed')) {
        return JSON.stringify({ total_count: completedRuns.length, workflow_runs: completedRuns });
      }
      const jobsMatch = /actions\/runs\/(\d+)\/jobs/.exec(path);
      if (jobsMatch) return JSON.stringify(jobs.get(Number(jobsMatch[1])) ?? { total_count: 0, jobs: [] });
      const annotationsMatch = /check-runs\/(\d+)\/annotations$/.exec(path);
      if (annotationsMatch) return JSON.stringify(annotations.get(Number(annotationsMatch[1])) ?? [[]]);
      return '{}';
    }
    if (args[0] === 'issue' && args[1] === 'list') return '[]';
    if (args[0] === 'issue' && args[1] === 'create') {
      return `https://github.com/o/r/issues/${issueCreates().length + 1}`;
    }
    return '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
  // At the ceiling, main does not spend an API call reading its own previous
  // scheduled run; this keeps the fixture focused on the observer contract.
  process.env.TIMEOUT_SCAN_LOOKBACK_MINUTES = '720';
  process.env.TIMEOUT_SCAN_ALLOW_TRUNCATED_CREATED_HORIZON = 'true';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GH_REPO;
  delete process.env.TIMEOUT_SCAN_LOOKBACK_MINUTES;
  delete process.env.TIMEOUT_SCAN_ALLOW_TRUNCATED_CREATED_HORIZON;
});

describe('issue #12443 — timeout annotations are the only cancelled-run signal', () => {
  it('reports the five timeout fixtures and none of five benign cancellations', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const timeoutRuns = Array.from({ length: 5 }, (_, index) => run(100 + index, `Timeout workflow ${index + 1}`));
    const benignRuns = Array.from({ length: 5 }, (_, index) => run(200 + index, `Cancelled workflow ${index + 1}`));
    const cancelledRuns = [...timeoutRuns, ...benignRuns];
    const jobs = new Map<number, unknown>();
    const annotations = new Map<number, unknown>();
    for (const candidate of cancelledRuns) {
      const checkRunId = Number(candidate.id);
      jobs.set(checkRunId, { total_count: 1, jobs: [timeoutJob(checkRunId)] });
      annotations.set(checkRunId, candidate.id < 200
        ? [[{ message: 'The job has exceeded the maximum execution time of 30m0s.' }]]
        : [[{ message: 'The operation was canceled because a higher priority waiting request started.' }]]);
    }
    installGh({ cancelledRuns, jobs, annotations });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(issueCreates()).toHaveLength(5);
    const bodies = issueCreates().map((args) => args[args.indexOf('--body') + 1]);
    for (const candidate of timeoutRuns) {
      expect(bodies.some((body) => body.includes(candidate.html_url))).toBe(true);
    }
    for (const candidate of benignRuns) {
      expect(bodies.some((body) => body.includes(candidate.html_url))).toBe(false);
    }
    const annotationPaths = calls()
      .filter((args) => args[0] === 'api' && String(args[1]).endsWith('/annotations'))
      .map((args) => String(args[1]));
    expect(annotationPaths).toHaveLength(10);
    expect(annotationPaths.every((path) => path.startsWith('repos/o/r/check-runs/'))).toBe(true);

    const summary = log.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('timeout summary'));
    expect(summary).toContain('5 timeout su 10 run cancellate');
    expect(summary).toContain('5 senza annotazione di timeout');
  });
});

describe('issue #12443 follow-up — startup failures leave no reporter job', () => {
  it('reports startup_failure and a failed run whose jobs endpoint is explicitly empty', async () => {
    const startup = run(301, 'Broken reusable workflow', {
      event: 'workflow_dispatch',
      conclusion: 'startup_failure',
    });
    const zeroJobFailure = run(302, 'Workflow failed before job creation', {
      event: 'repository_dispatch',
      conclusion: 'failure',
    });
    const jobs = new Map<number, unknown>([
      [301, { total_count: 0, jobs: [] }],
      [302, { total_count: 0, jobs: [] }],
    ]);
    installGh({ completedRuns: [startup], failedRuns: [zeroJobFailure], jobs });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(issueCreates()).toHaveLength(2);
    const bodies = issueCreates().map((args) => args[args.indexOf('--body') + 1]);
    expect(bodies.some((body) => body.includes('startup_failure'))).toBe(true);
    expect(bodies.some((body) => body.includes(zeroJobFailure.html_url))).toBe(true);
    expect(bodies.every((body) => body.includes('Job restituiti da Actions'))).toBe(true);
  });
});
