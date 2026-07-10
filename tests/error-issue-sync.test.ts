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

const { syncErrorIssues, ISSUE_DENY_PATTERNS, isIssueDenied } = await import('../scripts/lib/error-issue-sync.mjs');
const { MODULE_LINK_SKEW_PATTERNS } = await import('../services/resilientImport');
const { UNIVERSAL_BENIGN_PATTERNS } = await import('../services/benignErrorPatterns');
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

  it('applies the shared deny-list to GA4 entries too (version-skew SyntaxError never files an issue)', async () => {
    issueListEmptyThenCreate(103);
    readFileSync.mockReturnValue(JSON.stringify({
      ga4: {
        errorHealth: {
          totalErrors: 60,
          errorRate: 0.3,
          healthStatus: '🟢 HEALTHY',
          appErrors: [
            // Denied even above threshold: self-healed skew class (#3759).
            { errorType: 'SyntaxError', errorMessage: "window_error: SyntaxError: The requested module './constants.js' does not provide an export named 'a'", pagePath: '/', count: 30, users: 8 },
            // Real actionable error — must still be synced.
            { errorType: 'TypeError', errorMessage: 'x is not a function', pagePath: '/it/lavoro', count: 12, users: 9 },
          ],
          topStacks: [],
        },
      },
    }));

    await appErrorSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(1);
    const title = calls[0][calls[0].indexOf('--title') + 1];
    expect(title).toContain('x is not a function');
    expect(title).not.toContain('does not provide an export');
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

  it('does not create issues for self-healed version-skew SyntaxErrors or opaque "Script error." (#3758/#3759/#3761)', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'k';
    process.env.POSTHOG_PROJECT_ID = 'p';
    issueListEmptyThenCreate(203);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          // Denied: link-time version-skew wordings across engines — already
          // self-healed client-side (cache-bust + budgeted reload) and kept in
          // PostHog for chunk-load dashboards.
          ["The requested module './vendor-firebase-core.js' does not provide an export named 'createWebChannelTransport'", 'SyntaxError', 16, 9, 'https://frontaliereticino.ch/cerca-lavoro-ticino/'],
          ["The requested module './constants.js' does not provide an export named 'a'", 'SyntaxError', 37, 8, 'https://frontaliereticino.ch/'],
          ['import not found: House', 'SyntaxError', 6, 3, 'https://frontaliereticino.ch/'],
          ['ambiguous indirect export: House', 'SyntaxError', 6, 3, 'https://frontaliereticino.ch/'],
          ["Importing binding name 'House' is not found.", 'SyntaxError', 6, 3, 'https://frontaliereticino.ch/'],
          // Denied: opaque cross-origin "Script error." (already dropped at
          // before_send; residual pre-deploy events must not re-file issues).
          ['Script error.', 'Error', 41, 12, 'https://frontaliereticino.ch/vita-in-ticino/vacanze-scolastiche-ticino-2026/'],
          // Real actionable error — must still be synced.
          ['Cannot read properties of null', 'TypeError', 9, 7, 'https://frontaliereticino.ch/it/lavoro/'],
        ],
      }),
    }));

    await posthogSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(1);
    const title = calls[0][calls[0].indexOf('--title') + 1];
    expect(title).toContain('Cannot read properties');
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  });

  it('does not create a GitHub issue for "Importing a module script failed" even above threshold (#3762)', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'k';
    process.env.POSTHOG_PROJECT_ID = 'p';
    issueListEmptyThenCreate(202);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          // Denied: kept in PostHog for chunk-load dashboards but not a backlog ticket.
          ['Importing a module script failed.', 'TypeError', 13, 10, 'https://frontaliereticino.ch/en/find-jobs-ticino/'],
          // Real actionable error — must still be synced.
          ['Cannot read properties of null', 'TypeError', 9, 7, 'https://frontaliereticino.ch/it/lavoro/'],
        ],
      }),
    }));

    await posthogSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(1);
    const title = calls[0][calls[0].indexOf('--title') + 1];
    expect(title).toContain('Cannot read properties');
    expect(title).not.toContain('Importing a module script');
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  });
});

describe('deny-list parity (scripts/lib/error-issue-sync.mjs cannot import the .ts sources)', () => {
  it('mirrors every MODULE_LINK_SKEW_PATTERNS source from services/resilientImport.ts byte-for-byte', () => {
    const denySources = ISSUE_DENY_PATTERNS.map((p: RegExp) => p.source);
    for (const skew of MODULE_LINK_SKEW_PATTERNS) {
      expect(denySources).toContain(skew.source);
    }
  });

  it('mirrors the anchored "Script error." pattern from services/benignErrorPatterns.ts byte-for-byte', () => {
    const benignScriptError = UNIVERSAL_BENIGN_PATTERNS.find((p) => p.test('Script error.') && p.source.startsWith('^'));
    expect(benignScriptError).toBeDefined();
    expect(ISSUE_DENY_PATTERNS.map((p: RegExp) => p.source)).toContain(benignScriptError!.source);
  });

  it('isIssueDenied keeps real errors issue-able (incl. call-time skew TypeErrors and chunk-load 404s)', () => {
    // Call-time skew TypeErrors are deliberately NOT denied: the same message
    // shape can be a genuine first-party bug, so they must keep filing issues.
    expect(isIssueDenied('ls(...).then is not a function')).toBe(false);
    // Chunk-load fetch failures can indicate a persistent CDN prune/outage bug
    // (the #1810 class) that self-heal cannot fix — keep them issue-able.
    expect(isIssueDenied('Failed to fetch dynamically imported module: https://cdn.frontaliereticino.ch/assets/App.js')).toBe(false);
    expect(isIssueDenied('Cannot read properties of null')).toBe(false);
    // Contextualized "Script error." variants (not the bare opaque message) stay issue-able.
    expect(isIssueDenied('[boot] Script error. while loading map widget')).toBe(false);
    // And the denied class, for contrast:
    expect(isIssueDenied("The requested module './vendor-firebase-core.js' does not provide an export named 'createWebChannelTransport'")).toBe(true);
    expect(isIssueDenied('Script error.')).toBe(true);
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
