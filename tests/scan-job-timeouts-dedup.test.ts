import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression cover for #5305/#5306: ONE cancelled run (31171006342) whose
// `Lighthouse CI` workflow timed out in more than one job produced TWO identical
// `CI Failure: Lighthouse CI` issues, 3 seconds apart. `scan-job-timeouts.mjs`
// called `createGithubIssue` once per job, and that dedup resolved through
// GitHub's SEARCH INDEX — eventually consistent, so the second call could not yet
// see what the first had just created.
//
// Two layers are asserted here, because either one alone still leaks:
//   (a) the in-process memo in the scanner — kills the intra-scan race outright;
//   (b) the plain-listing fallback in `searchIssuesByTitlePrefix` — an
//       immediately-consistent read that also covers the CROSS-process race,
//       which (a) by construction cannot see.
//
// `gh` is mocked and routed by sub-command, same approach as
// github-issue-creator-gate.test.ts / github-issue-resolve.test.ts.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

const callsFor = (sub: string) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);

beforeEach(() => {
  execFileSync.mockReset();
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
  delete process.env.ENABLE_FAILURE_REPORT;
});

afterEach(() => {
  delete process.env.GH_REPO;
});

describe('scan-job-timeouts — two timed-out jobs of one run ⇒ ONE issue', () => {
  const RUN = {
    id: 31171006342,
    name: 'Lighthouse CI',
    html_url: 'https://github.com/o/r/actions/runs/31171006342',
    event: 'push',
    head_branch: 'main',
    created_at: new Date().toISOString(),
  };
  const JOBS = [
    { name: 'lighthouse', conclusion: 'cancelled', check_run_url: 'https://api.github.com/repos/o/r/check-runs/1' },
    { name: 'lighthouse-probe', conclusion: 'cancelled', check_run_url: 'https://api.github.com/repos/o/r/check-runs/2' },
  ];
  // The literal signature GitHub stamps only for a `timeout-minutes` cancellation.
  const ANNOTATIONS = [
    { message: 'The job running on runner ubuntu-latest has exceeded the maximum execution time of 45 minutes.' },
  ];

  it('opens one atomic issue containing both jobs (index fully blind)', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1];
        if (path.includes('actions/runs?status=cancelled')) return JSON.stringify({ workflow_runs: [RUN] });
        if (path.includes(`actions/runs/${RUN.id}/jobs`)) return JSON.stringify({ jobs: JOBS });
        if (path.endsWith('/annotations')) return JSON.stringify(ANNOTATIONS);
        return '{}';
      }
      // Worst case on purpose: BOTH the search and the listing come back empty,
      // so nothing but the in-process memo can stop the second create.
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/5305';
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    // The bug: this was 2.
    expect(callsFor('create')).toHaveLength(1);
    const created = callsFor('create')[0];
    expect(created[created.indexOf('--title') + 1]).toBe('CI Failure: Lighthouse CI');

    // Both jobs land in the create body. There is no best-effort secondary
    // comment that could fail after the run URL has already been persisted.
    expect(callsFor('comment')).toHaveLength(0);
    const body = created[created.indexOf('--body') + 1];
    expect(body).toContain('lighthouse');
    expect(body).toContain('lighthouse-probe');
    expect(body).toContain('exceeded the maximum execution time');
  });

  it('reports every job in one write — no partial multi-job state is possible', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') {
        const path = args[1];
        if (path.includes('actions/runs?status=cancelled')) return JSON.stringify({ workflow_runs: [RUN] });
        if (path.includes(`actions/runs/${RUN.id}/jobs`)) return JSON.stringify({ jobs: JOBS });
        if (path.endsWith('/annotations')) return JSON.stringify(ANNOTATIONS);
        return '{}';
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/5305';
      return '';
    });

    const { main } = await import('../scripts/ci/scan-job-timeouts.mjs');
    await main();

    expect(callsFor('create')).toHaveLength(1);
    expect(callsFor('comment')).toHaveLength(0);
    const createdBody = (() => {
      const c = callsFor('create')[0];
      return c[c.indexOf('--body') + 1];
    })();
    expect(createdBody).toContain('lighthouse');
    expect(createdBody).toContain('lighthouse-probe');
  });
});

describe('searchIssuesByTitlePrefix — listing fallback beats search-index lag', () => {
  const EXISTING = {
    number: 5305,
    title: 'CI Failure: Lighthouse CI',
    url: 'https://github.com/o/r/issues/5305',
    state: 'OPEN',
  };

  it('finds an issue the search index has not indexed yet ⇒ comment, no duplicate', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        // The index has NOT caught up with the issue opened seconds ago …
        if (args.includes('--search')) return '[]';
        // … but the plain repository listing is immediately consistent.
        return JSON.stringify([EXISTING]);
      }
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/9999';
      return '';
    });

    const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');
    const res = await createGithubIssue({
      title: 'CI Failure: Lighthouse CI',
      description: 'Job cancellato per timeout',
      priority: 2,
      labels: ['Bug', 'ci-timeout'],
    } as any);

    expect(res?.number).toBe(5305);
    expect(callsFor('create')).toHaveLength(0); // no twin issue
    expect(callsFor('comment')[0]?.[2]).toBe('5305');
  });

  it('still filters the fallback listing by exact title prefix (no wrong canonical)', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        if (args.includes('--search')) return '[]';
        // Listing returns the whole open backlog — a different workflow's issue
        // must NOT be mistaken for this one's canonical.
        return JSON.stringify([
          { number: 4000, title: 'CI Failure: Deploy to GitHub Pages', url: 'u', state: 'OPEN' },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/5307';
      return '';
    });

    const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');
    const res = await createGithubIssue({
      title: 'CI Failure: Lighthouse CI',
      description: 'Job cancellato per timeout',
      priority: 2,
      labels: ['Bug', 'ci-timeout'],
    } as any);

    expect(res?.number).toBe(5307);
    expect(callsFor('create')).toHaveLength(1);
    expect(callsFor('comment')).toHaveLength(0);
  });

  it('does not pay for the fallback listing when the search already hit', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        if (args.includes('--search')) return JSON.stringify([EXISTING]);
        throw new Error('fallback listing must not run when the search resolved');
      }
      return '';
    });

    const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');
    const res = await createGithubIssue({
      title: 'CI Failure: Lighthouse CI',
      description: 'again',
      priority: 2,
      labels: ['Bug', 'ci-timeout'],
    } as any);

    expect(res?.number).toBe(5305);
    const listCalls = callsFor('list');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toContain('--search');
  });
});

describe('crawler-transient ledger — a SECOND ledger stops the streak counter', () => {
  // Same root cause, worse blast radius: the ledger is a singleton counter, and
  // two of them split the streaks. On the corpus repo #24 and #25 were both
  // created on 2026-08-07, 3s apart; keys sitting at 2/3 on #25 could never
  // reach 3/3, so the escalation to a routable issue never fired.
  const LEDGER = {
    number: 25,
    title: 'Crawler transient failures (rolling ledger)',
    url: 'https://github.com/o/r/issues/25',
    state: 'OPEN',
  };
  const CRAWLER_TITLE = 'Crawler Failure: Generate Blog Article';
  const ISO = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

  const isLedgerLookup = (a: string[]) => a[0] === 'issue' && a[1] === 'list' && a.includes('--label');

  it('reuses the existing ledger even when the search index is blind', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        if (args.includes('--label')) return JSON.stringify([LEDGER]); // listing: consistent
        return '[]'; // both the title search and its listing fallback see nothing
      }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [] });
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/26';
      return '';
    });

    const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');
    const res = await createGithubIssue({
      title: CRAWLER_TITLE,
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
    } as any);

    expect(res?.number).toBe(25);
    expect(callsFor('create')).toHaveLength(0); // no twin ledger #26
    const comment = callsFor('comment')[0];
    expect(comment[2]).toBe('25');
    expect(comment[comment.indexOf('--body') + 1]).toContain(`transient-key: ${CRAWLER_TITLE}`);
  });

  it('looks the ledger up by label listing, never through the search index', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        if (args.includes('--label')) return JSON.stringify([LEDGER]);
        return '[]';
      }
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [] });
      return '';
    });

    const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');
    await createGithubIssue({ title: CRAWLER_TITLE, description: 'x', priority: 2, labels: ['Bug'] } as any);

    const lookup = callsFor('list').find(isLedgerLookup);
    expect(lookup).toBeTruthy();
    expect(lookup).toContain('crawler-transient');
    expect(lookup).toContain('open');
    // The whole point: this lookup must not depend on the eventually-consistent index.
    expect(lookup).not.toContain('--search');
  });

  it('one ledger keeps counting: the 3rd entry escalates to a routable issue', async () => {
    // The behaviour the duplicate ledger silently destroyed.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        if (args.includes('--label')) return JSON.stringify([LEDGER]);
        return '[]';
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          comments: [
            { createdAt: ISO(30), body: `🔁 x\n\n\`transient-key: ${CRAWLER_TITLE}\`` },
            { createdAt: ISO(10), body: `🔁 x\n\n\`transient-key: ${CRAWLER_TITLE}\`` },
          ],
        });
      }
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/30';
      return '';
    });

    const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');
    const res = await createGithubIssue({
      title: CRAWLER_TITLE,
      description: 'fetch failed',
      priority: 2,
      labels: ['Bug'],
    } as any);

    expect(res?.number).toBe(30);
    const created = callsFor('create')[0];
    expect(created).toBeTruthy();
    const labels: string[] = [];
    for (let i = 0; i < created.length; i++) if (created[i] === '--label') labels.push(created[i + 1]);
    expect(labels).toContain('priority:high');
    expect(labels).not.toContain('crawler-transient');
  });
});
