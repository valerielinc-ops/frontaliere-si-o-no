import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const MINUTE = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const callsFor = (sub: string) => execFileSync.mock.calls
  .filter((call) => call[0] === 'gh' && call[1][0] === 'issue' && call[1][1] === sub)
  .map((call) => call[1] as string[]);

const timeoutJob = {
  name: 'crawler-group-01',
  conclusion: 'cancelled',
  check_run_url: 'https://api.github.com/repos/o/r/check-runs/1',
};
const timeoutAnnotations = [
  { message: 'The job has exceeded the maximum execution time of 350 minutes.' },
];

function runFixture(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Crawler Group 01',
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    event: 'schedule',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'cancelled',
    created_at: iso(350 * MINUTE),
    updated_at: iso(MINUTE),
    ...overrides,
  };
}

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
  process.env.TIMEOUT_SCAN_LOOKBACK_MINUTES = '40';
  process.env.HOST_KILL_SETTLE_MS = '120000';
});

afterEach(() => {
  delete process.env.GH_REPO;
  delete process.env.TIMEOUT_SCAN_LOOKBACK_MINUTES;
  delete process.env.HOST_KILL_SETTLE_MS;
});

describe('observation window — completion time, not start time', () => {
  it('observes a timeout updated now after queueing and an upstream job pushed creation two days back', async () => {
    const run = runFixture(101, { created_at: iso(2 * 24 * 60 * MINUTE) });
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) return JSON.stringify({ workflow_runs: [run] });
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes(`/runs/${run.id}/jobs`)) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/1';
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(1);
    expect(callsFor('create')[0].join(' ')).toContain(run.html_url);
  });

  it('continues beyond 200 created-at-ordered runs and bounds created by the full workflow lifetime', async () => {
    const oldRuns = Array.from({ length: 100 }, (_, index) => runFixture(index, {
      created_at: iso(8 * 60 * MINUTE),
      updated_at: iso(7 * 60 * MINUTE),
    }));
    const observable = runFixture(999, {
      created_at: iso(350 * MINUTE),
      updated_at: iso(MINUTE),
    });
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] !== 'api') return '[]';
      if (args[1].includes('actions/runs?status=cancelled')) {
        const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
        if (page <= 2) return JSON.stringify({ workflow_runs: oldRuns });
        if (page === 3) return JSON.stringify({ workflow_runs: [observable] });
        return JSON.stringify({ workflow_runs: [] });
      }
      if (args[1].includes('actions/runs?status=failure')) {
        return JSON.stringify({ workflow_runs: [] });
      }
      if (args[1].includes(`/runs/${observable.id}/jobs`)) return JSON.stringify({ jobs: [] });
      return '{}';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    const runListCalls = execFileSync.mock.calls.filter(
      (call) => call[0] === 'gh' && call[1][0] === 'api' && call[1][1].includes('actions/runs?'),
    );
    expect(runListCalls.some((call) => call[1][1].includes('page=3'))).toBe(true);
    const createdRanges = runListCalls.map((call) => {
      const query = new URLSearchParams(call[1][1].split('?')[1]);
      return query.get('created') || '';
    });
    expect(createdRanges.every((range) => range.includes('..'))).toBe(true);
    const [oldest] = createdRanges[0].split('..');
    expect(Date.now() - Date.parse(oldest)).toBeGreaterThanOrEqual(35 * 24 * 60 * MINUTE);
  });

  it('bisects a created range above GitHub\'s 1,000-result search cap and reaches the later slice', async () => {
    const oldRuns = Array.from({ length: 100 }, (_, index) => runFixture(index, {
      created_at: iso(20 * 24 * 60 * MINUTE),
      updated_at: iso(19 * 24 * 60 * MINUTE),
    }));
    const observable = runFixture(999, {
      created_at: iso(2 * 24 * 60 * MINUTE),
      updated_at: iso(MINUTE),
    });
    let rootRange = '';
    let leftRange = '';
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] !== 'api') return '[]';
      if (args[1].includes('actions/runs?status=cancelled')) {
        const query = new URLSearchParams(args[1].split('?')[1]);
        const range = query.get('created') || '';
        const page = Number(query.get('page'));
        if (!rootRange) {
          rootRange = range;
          return JSON.stringify({ total_count: 1001, workflow_runs: oldRuns });
        }
        if (range !== rootRange && !leftRange) leftRange = range;
        if (range === leftRange) {
          return JSON.stringify({ total_count: 1000, workflow_runs: page <= 10 ? oldRuns : [] });
        }
        return JSON.stringify({ total_count: 1, workflow_runs: [observable] });
      }
      if (args[1].includes('actions/runs?status=failure')) {
        return JSON.stringify({ total_count: 0, workflow_runs: [] });
      }
      if (args[1].includes(`/runs/${observable.id}/jobs`)) return JSON.stringify({ jobs: [] });
      return '{}';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    const cancelledCalls = execFileSync.mock.calls.filter(
      (call) => call[0] === 'gh' && call[1][0] === 'api'
        && call[1][1].includes('actions/runs?status=cancelled'),
    );
    const ranges = new Set(cancelledCalls.map((call) => (
      new URLSearchParams(call[1][1].split('?')[1]).get('created')
    )));
    expect(ranges.size).toBe(3); // original search + two disjoint halves
    expect(cancelledCalls.some((call) => call[1][1].includes('page=10'))).toBe(true);
    expect(execFileSync.mock.calls.some(
      (call) => call[0] === 'gh' && call[1][0] === 'api'
        && call[1][1].includes(`/runs/${observable.id}/jobs`),
    )).toBe(true);
  });
});

describe('host-kill settle — the next overlapping scan still owns the run', () => {
  it('skips the transient first read, then reports the same old-started run after settle', async () => {
    const run = runFixture(202, { conclusion: 'failure', updated_at: iso(30 * 1000) });
    let completedAt = iso(30 * 1000);
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [run] });
        if (args[1].includes(`/runs/${run.id}/jobs`)) {
          return JSON.stringify({ jobs: [{
            name: 'crawler-group-01',
            status: 'completed',
            conclusion: 'failure',
            completed_at: completedAt,
            steps: [{ number: 7, name: 'Run crawler', status: 'in_progress', conclusion: null }],
          }] });
        }
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/2';
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    expect(callsFor('create')).toHaveLength(0);

    completedAt = iso(3 * MINUTE);
    await main();
    expect(callsFor('create')).toHaveLength(1);
  });
});

describe('persistent run dedup — occurrence key, not workflow title', () => {
  it('merges search and open listing when an old indexed issue masks the fresh canonical', async () => {
    const run = runFixture(300);
    const oldIssue = { number: 8, title: 'CI Failure: Crawler Group 01' };
    const freshIssue = { number: 9, title: 'CI Failure: Crawler Group 01' };
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) return JSON.stringify({ workflow_runs: [run] });
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes(`/runs/${run.id}/jobs`)) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify(args.includes('--search') ? [oldIssue] : [freshIssue]);
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        const number = args[2];
        return JSON.stringify({ body: number === '9' ? `already ${run.html_url}` : 'older run', comments: [] });
      }
      if (args[0] === 'issue' && (args[1] === 'create' || args[1] === 'comment')) {
        throw new Error('persisted run must not emit');
      }
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(0);
    expect(callsFor('comment')).toHaveLength(0);
    const lists = callsFor('list');
    expect(lists.some((args) => args.includes('--search'))).toBe(true);
    expect(lists.some((args) => !args.includes('--search'))).toBe(true);
    const openListing = lists.find((args) => !args.includes('--search'));
    expect(openListing?.[openListing.indexOf('--limit') + 1]).toBe('1000');
  });

  it('same run does not re-emit across scans; a different run on the canonical issue does', async () => {
    const first = runFixture(301);
    const second = runFixture(302);
    let currentRun = first;
    let issueBody = '';
    let issueExists = false;
    const jobs = [
      timeoutJob,
      { ...timeoutJob, name: 'crawler-group-01-retry', check_run_url: 'https://api.github.com/repos/o/r/check-runs/2' },
    ];
    const existing = { number: 9, title: 'CI Failure: Crawler Group 01', url: 'https://github.com/o/r/issues/9' };

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) return JSON.stringify({ workflow_runs: [currentRun] });
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes(`/runs/${currentRun.id}/jobs`)) return JSON.stringify({ jobs });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issueExists ? [existing] : []);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ body: issueBody, comments: [] });
      }
      if (args[0] === 'issue' && args[1] === 'create') {
        issueExists = true;
        issueBody = args[args.indexOf('--body') + 1];
        return existing.url;
      }
      if (args[0] === 'issue' && args[1] === 'comment') return existing.url;
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();
    await main();
    expect(callsFor('create')).toHaveLength(1);
    expect(callsFor('comment')).toHaveLength(0);
    const createdBody = callsFor('create')[0].join(' ');
    expect(createdBody).toContain('crawler-group-01');
    expect(createdBody).toContain('crawler-group-01-retry');

    currentRun = second;
    await main();
    expect(callsFor('create')).toHaveLength(1);
    expect(callsFor('comment')).toHaveLength(1); // one atomic recurrence write
    expect(callsFor('comment')[0].join(' ')).toContain(second.html_url);
    expect(callsFor('comment')[0].join(' ')).toContain('crawler-group-01-retry');
  });

  it('reopens a closed canonical for a different run instead of commenting while closed', async () => {
    const first = runFixture(303);
    const second = runFixture(304);
    const title = 'CI Failure: Crawler Group 01';
    const closedIssue = {
      number: 12,
      title,
      url: 'https://github.com/o/r/issues/12',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: iso(MINUTE),
      labels: [],
    };

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) {
          return JSON.stringify({ workflow_runs: [first, second] });
        }
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes('/jobs')) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        const state = args[args.indexOf('--state') + 1];
        if (state === 'all' || state === 'closed') return JSON.stringify([closedIssue]);
        return '[]';
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ body: `already ${first.html_url}`, comments: [] });
      }
      if (args[0] === 'issue' && args[1] === 'reopen') return closedIssue.url;
      if (args[0] === 'issue' && args[1] === 'comment') return closedIssue.url;
      if (args[0] === 'issue' && args[1] === 'create') {
        throw new Error('the recently closed canonical must be reopened');
      }
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(callsFor('reopen')).toHaveLength(1);
    expect(callsFor('create')).toHaveLength(0);
    expect(callsFor('comment')).toHaveLength(1);
    expect(callsFor('comment')[0].join(' ')).toContain(second.html_url);
  });

  it('uses the shared search-safe prefix to find a closed long-title occurrence', async () => {
    const workflow = 'Crawler Group Very Long Name (Dedicated Regional Nightly Sequence)';
    const run = runFixture(305, { name: workflow });
    const title = `CI Failure: ${workflow}`;
    const safePrefix = 'CI Failure: Crawler Group Very Long Name';
    const rawPrefix = title.slice(0, 60);
    const closedIssue = { number: 13, title, state: 'CLOSED' };

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) return JSON.stringify({ workflow_runs: [run] });
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes(`/runs/${run.id}/jobs`)) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        const state = args[args.indexOf('--state') + 1];
        const search = args[args.indexOf('--search') + 1];
        if (state === 'all' && search === `${safePrefix} in:title`) {
          return JSON.stringify([closedIssue]);
        }
        return '[]';
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ body: run.html_url, comments: [] });
      }
      if (args[0] === 'issue' && (args[1] === 'create' || args[1] === 'comment' || args[1] === 'reopen')) {
        throw new Error('the persisted occurrence must not emit');
      }
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    const indexedLookup = callsFor('list').find((args) => args.includes('--search'));
    expect(indexedLookup?.[indexedLookup.indexOf('--search') + 1]).toBe(`${safePrefix} in:title`);
    expect(indexedLookup?.join(' ')).not.toContain(rawPrefix);
    expect(callsFor('create')).toHaveLength(0);
    expect(callsFor('comment')).toHaveLength(0);
    expect(callsFor('reopen')).toHaveLength(0);
  });
});

describe('write failures — loud, retryable, never memoized as persisted', () => {
  it('a failed create makes the scan fail; the next invocation records both distinct runs', async () => {
    const first = runFixture(401);
    const second = runFixture(402);
    let failCreate = true;

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) {
          return JSON.stringify({ workflow_runs: [first, second] });
        }
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes('/jobs')) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') {
        if (failCreate) throw new Error('GitHub write unavailable');
        return 'https://github.com/o/r/issues/21';
      }
      if (args[0] === 'issue' && args[1] === 'comment') return 'https://github.com/o/r/issues/21';
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await expect(main()).rejects.toThrow(`failed to persist ${first.html_url}`);

    failCreate = false;
    await main();

    expect(callsFor('create')).toHaveLength(2); // failed attempt + successful retry
    expect(callsFor('comment')).toHaveLength(1);
    expect(callsFor('comment')[0].join(' ')).toContain(second.html_url);
  });

  it('a failed recurrence comment makes the scan fail and the next invocation retries it', async () => {
    const first = runFixture(403);
    const second = runFixture(404);
    const existing = {
      number: 22,
      title: 'CI Failure: Crawler Group 01',
      url: 'https://github.com/o/r/issues/22',
      state: 'OPEN',
    };
    let issueExists = false;
    let issueBody = '';
    let failedComments = 0;

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) {
          return JSON.stringify({ workflow_runs: [first, second] });
        }
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes('/jobs')) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify(issueExists ? [existing] : []);
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ body: issueBody, comments: [] });
      }
      if (args[0] === 'issue' && args[1] === 'create') {
        issueExists = true;
        issueBody = args[args.indexOf('--body') + 1];
        return existing.url;
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        if (failedComments === 0) {
          failedComments += 1;
          throw new Error('GitHub comment unavailable');
        }
        issueBody += `\n${args[args.indexOf('--body') + 1]}`;
        return existing.url;
      }
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await expect(main()).rejects.toThrow(`failed to persist recurrence for ${second.html_url}`);
    await main();

    expect(callsFor('create')).toHaveLength(1);
    expect(callsFor('comment')).toHaveLength(2); // failed attempt + successful retry
    expect(callsFor('comment')[1].join(' ')).toContain(second.html_url);
  });

  it('an OPEN canonical comment failure returned by createGithubIssue stays retryable', async () => {
    const run = runFixture(405);
    const existing = {
      number: 23,
      title: 'CI Failure: Crawler Group 01',
      url: 'https://github.com/o/r/issues/23',
      state: 'OPEN',
    };
    let failedComments = 0;

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) return JSON.stringify({ workflow_runs: [run] });
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes(`/runs/${run.id}/jobs`)) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([existing]);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ body: 'older occurrence', comments: [] });
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        if (failedComments === 0) {
          failedComments += 1;
          throw new Error('GitHub open-issue comment unavailable');
        }
        return existing.url;
      }
      if (args[0] === 'issue' && (args[1] === 'create' || args[1] === 'reopen')) {
        throw new Error('the open canonical must own the recurrence');
      }
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await expect(main()).rejects.toThrow(`failed to persist ${run.html_url}`);
    await main();

    expect(callsFor('comment')).toHaveLength(2);
    expect(callsFor('create')).toHaveLength(0);
    expect(callsFor('reopen')).toHaveLength(0);
  });

  it('a REOPEN recurrence-comment failure stays retryable after the issue became OPEN', async () => {
    const run = runFixture(406);
    let issueState = 'CLOSED';
    let failedComments = 0;
    const issue = () => ({
      number: 24,
      title: 'CI Failure: Crawler Group 01',
      url: 'https://github.com/o/r/issues/24',
      state: issueState,
      stateReason: 'COMPLETED',
      closedAt: iso(MINUTE),
      labels: [],
    });

    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        if (args[1].includes('status=cancelled')) return JSON.stringify({ workflow_runs: [run] });
        if (args[1].includes('status=failure')) return JSON.stringify({ workflow_runs: [] });
        if (args[1].includes(`/runs/${run.id}/jobs`)) return JSON.stringify({ jobs: [timeoutJob] });
        if (args[1].endsWith('/annotations')) return JSON.stringify(timeoutAnnotations);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        const requested = args[args.indexOf('--state') + 1];
        if (requested === 'all' || requested.toUpperCase() === issueState) {
          return JSON.stringify([issue()]);
        }
        return '[]';
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ body: 'older occurrence', comments: [] });
      }
      if (args[0] === 'issue' && args[1] === 'reopen') {
        issueState = 'OPEN';
        return issue().url;
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        if (failedComments === 0) {
          failedComments += 1;
          throw new Error('GitHub reopen comment unavailable');
        }
        return issue().url;
      }
      if (args[0] === 'issue' && args[1] === 'create') {
        throw new Error('the reopened canonical must own the recurrence');
      }
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await expect(main()).rejects.toThrow(`failed to persist ${run.html_url}`);
    expect(issueState).toBe('OPEN');
    await main();

    expect(callsFor('reopen')).toHaveLength(1);
    expect(callsFor('comment')).toHaveLength(2);
    expect(callsFor('create')).toHaveLength(0);
  });
});
