import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Coverage for the GA4 / PostHog / Cloudflare "top-N recurring error →
 * GitHub backlog issue" sync (scripts/lib/error-issue-sync.mjs +
 * scripts/{app-error,posthog-error,cf-5xx}-issue-sync.mjs).
 *
 * All three entry scripts guard their live-call `main()` behind an
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check (same
 * pattern as scripts/dmarc-monitor.mjs), so importing them here never fires
 * a real gh/PostHog/Cloudflare call — every external boundary (gh CLI via
 * node:child_process, PostHog via fetch, the cf-status-report.mjs subprocess,
 * and reports/analytics-latest.json via node:fs) is mocked.
 */

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const readFileSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: unknown[]) => readFileSync(...args) };
});

const { syncErrorIssues } = await import('../scripts/lib/error-issue-sync.mjs');
const appErrorSync = await import('../scripts/app-error-issue-sync.mjs');
const posthogSync = await import('../scripts/posthog-error-issue-sync.mjs');
const cfSync = await import('../scripts/cf-5xx-issue-sync.mjs');

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

function createCalls(): string[][] {
  return ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'create');
}

function issueListEmptyThenCreate(nextNumber: number) {
  execFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return '[]';
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      return `https://github.com/o/r/issues/${nextNumber}`;
    }
    return '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  readFileSync.mockReset();
  delete process.env.GH_REPO;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncErrorIssues (shared loop)', () => {
  it('creates one issue per entry, capped at maxIssues, in entry order', async () => {
    issueListEmptyThenCreate(1);
    const entries = [{ n: 1 }, { n: 2 }, { n: 3 }];
    await syncErrorIssues({
      entries,
      maxIssues: 2,
      labels: ['stability'],
      source: 'test',
      titleFor: (e: { n: number }) => `Error ${e.n}`,
      bodyFor: () => 'body',
    });
    expect(createCalls()).toHaveLength(2);
  });

  it('skips an entry whose titleFor returns falsy', async () => {
    issueListEmptyThenCreate(1);
    const entries = [{ n: 1 }, { n: 2 }];
    await syncErrorIssues({
      entries,
      labels: [],
      source: 'test',
      titleFor: (e: { n: number }) => (e.n === 1 ? '' : `Error ${e.n}`),
      bodyFor: () => 'body',
    });
    expect(createCalls()).toHaveLength(1);
  });

  it('defaults to priority 3 (medium) when priorityFor is omitted', async () => {
    issueListEmptyThenCreate(1);
    await syncErrorIssues({
      entries: [{ n: 1 }],
      labels: [],
      source: 'test',
      titleFor: () => 'Error',
      bodyFor: () => 'body',
    });
    const labels: string[] = [];
    const call = createCalls()[0];
    for (let i = 0; i < call.length; i++) if (call[i] === '--label') labels.push(call[i + 1]);
    expect(labels).toContain('priority:medium');
  });

  it('applies priorityFor per-entry to escalate above the default', async () => {
    issueListEmptyThenCreate(1);
    await syncErrorIssues({
      entries: [{ n: 1 }],
      labels: [],
      source: 'test',
      priorityFor: () => 2,
      titleFor: () => 'Error',
      bodyFor: () => 'body',
    });
    const labels: string[] = [];
    const call = createCalls()[0];
    for (let i = 0; i < call.length; i++) if (call[i] === '--label') labels.push(call[i + 1]);
    expect(labels).toContain('priority:high');
  });
});

describe('app-error-issue-sync.mjs', () => {
  it('exits silently (no gh call) when the report file is missing', async () => {
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await appErrorSync.main();
    expect(ghCalls()).toHaveLength(0);
  });

  it('exits silently when errorHealth has zero errors', async () => {
    readFileSync.mockReturnValue(JSON.stringify({ ga4: { errorHealth: { totalErrors: 0 } } }));
    await appErrorSync.main();
    expect(ghCalls()).toHaveLength(0);
  });

  it('filters out app_error entries below MIN_COUNT and syncs the rest, attaching the matching stack', async () => {
    issueListEmptyThenCreate(101);
    readFileSync.mockReturnValue(JSON.stringify({
      ga4: {
        errorHealth: {
          totalErrors: 50,
          errorRate: 0.2,
          healthStatus: '🟢 HEALTHY',
          appErrors: [
            { errorType: 'TypeError', errorMessage: 'x is not a function', pagePath: '/it/lavoro', count: 12, users: 9 },
            { errorType: 'TypeError', errorMessage: 'one-off, below threshold', pagePath: '/it/x', count: 1, users: 1 },
          ],
          topStacks: [{ message: 'x is not a function', stack: 'at foo (bar.js:1:1)' }],
        },
      },
    }));

    await appErrorSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(1); // only the >=5-count entry syncs
    const body = calls[0][calls[0].indexOf('--body') + 1];
    expect(body).toContain('x is not a function');
    expect(body).toContain('at foo (bar.js:1:1)');
  });

  it('escalates priority to high when the site-wide error rate is critical', async () => {
    issueListEmptyThenCreate(102);
    readFileSync.mockReturnValue(JSON.stringify({
      ga4: {
        errorHealth: {
          totalErrors: 500,
          errorRate: 2.5, // >= 1.0 threshold
          healthStatus: '🔴 CRITICAL',
          appErrors: [
            { errorType: 'TypeError', errorMessage: 'boom', pagePath: '/it/x', count: 6, users: 6 },
          ],
          topStacks: [],
        },
      },
    }));

    await appErrorSync.main();

    const call = createCalls()[0];
    const labels: string[] = [];
    for (let i = 0; i < call.length; i++) if (call[i] === '--label') labels.push(call[i + 1]);
    expect(labels).toContain('priority:high');
  });

  it('truncate() collapses whitespace and ellipsizes past the limit', () => {
    expect(appErrorSync.truncate('a   b\nc', 100)).toBe('a b c');
    expect(appErrorSync.truncate('x'.repeat(10), 5)).toBe('xxxx…');
  });
});

describe('posthog-error-issue-sync.mjs', () => {
  it('exits silently (no fetch, no gh call) when credentials are missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;

    await posthogSync.main();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ghCalls()).toHaveLength(0);
  });

  it('exits silently when the HogQL query throws', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'k';
    process.env.POSTHOG_PROJECT_ID = 'p';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));

    await posthogSync.main();

    expect(ghCalls()).toHaveLength(0);
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  });

  it('filters rows below MIN_COUNT and syncs the rest', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'k';
    process.env.POSTHOG_PROJECT_ID = 'p';
    issueListEmptyThenCreate(201);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          ['Cannot read properties of null', 'TypeError', 9, 7, 'https://frontaliereticino.ch/it/lavoro/'],
          ['rare one-off', 'Error', 1, 1, 'https://frontaliereticino.ch/it/x/'],
        ],
      }),
    }));

    await posthogSync.main();

    expect(createCalls()).toHaveLength(1);
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  });
});

describe('cf-5xx-issue-sync.mjs', () => {
  it('exits silently (no subprocess, no gh call) when CF_API_TOKEN is missing', async () => {
    delete process.env.CF_API_TOKEN;
    await cfSync.main();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('exits silently when the cf-status-report subprocess fails', async () => {
    process.env.CF_API_TOKEN = 't';
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'node' && args[0] === 'scripts/cf-status-report.mjs') throw new Error('boom');
      return '';
    });

    await cfSync.main();

    expect(ghCalls()).toHaveLength(0);
    delete process.env.CF_API_TOKEN;
  });

  it('filters paths below MIN_COUNT (default 20) and syncs only the sustained one', async () => {
    // cf-status-report.mjs builds `url` as clientRequestHTTPHost +
    // clientRequestPath — host+path only, Cloudflare's GraphQL dimension
    // never carries a query string here — so a realistic fixture has none.
    process.env.CF_API_TOKEN = 't';
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'node' && args[0] === 'scripts/cf-status-report.mjs') {
        return JSON.stringify({
          detail: [
            { status: 502, url: 'frontaliereticino.ch/it/lavoro/', count: 45 },
            { status: 500, url: 'frontaliereticino.ch/it/rare/', count: 3 },
          ],
        });
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return '[]';
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/301';
      return '';
    });

    await cfSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(1);
    const title = calls[0][calls[0].indexOf('--title') + 1];
    expect(title).toContain('frontaliereticino.ch/it/lavoro/');
    delete process.env.CF_API_TOKEN;
  });
});
