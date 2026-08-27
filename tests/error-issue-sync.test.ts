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

const { syncErrorIssues, ISSUE_DENY_PATTERNS, isIssueDenied, isSelfHealedPage404, page404Path, extractStackFrameOrigins } = await import('../scripts/lib/error-issue-sync.mjs');
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

  it('skips message-less "(not set)" / empty GA4 buckets (#4148 — no message, reason or stack to act on)', async () => {
    issueListEmptyThenCreate(104);
    readFileSync.mockReturnValue(JSON.stringify({
      ga4: {
        errorHealth: {
          totalErrors: 200,
          errorRate: 5.8,
          healthStatus: '🔴 CRITICAL',
          appErrors: [
            // Message-less bucket: GA4 renders an empty error_message as "(not set)".
            { errorType: 'unhandled_rejection', errorMessage: '(not set)', pagePath: '/', count: 143, users: 2 },
            // Genuinely empty string — same message-less class.
            { errorType: 'unhandled_rejection', errorMessage: '', pagePath: '/', count: 40, users: 2 },
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
    expect(title).not.toContain('not set');
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
  /**
   * main() now runs the PostHog vitality guard (scripts/lib/source-liveness.mjs)
   * before its $exception query, and the guard reaches PostHog through the same
   * global fetch these tests stub. A flat stub would answer the liveness probe
   * with the $exception rows, which parse to zero events/day — the monitor would
   * correctly abstain and every assertion below would fail for the wrong reason.
   *
   * So the stub dispatches on the query: liveness probes get a healthy 45 days
   * at the last measured pre-outage volume (90.027/day on 2026-07-22), the
   * $exception query gets `rows`. The guard's abstention behaviour itself is
   * covered in tests/monitor-source-liveness-guard.test.ts.
   */
  const livenessProbeDays = () => {
    const out: Array<[string, number]> = [];
    const now = new Date();
    for (let back = 0; back <= 45; back += 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - back);
      out.push([d.toISOString().slice(0, 10), 90027]);
    }
    return out;
  };

  const stubPostHogFetch = (rows: unknown[]) => {
    const mock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = String(init?.body ?? '');
      const isProbe = body.includes('GROUP BY d') && body.includes('toDate(timestamp)');
      return { ok: true, json: async () => ({ results: isProbe ? livenessProbeDays() : rows }) };
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  };

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
    stubPostHogFetch([
          ['Cannot read properties of null', 'TypeError', 9, 7, 'https://frontaliereticino.ch/it/lavoro/'],
          ['rare one-off', 'Error', 1, 1, 'https://frontaliereticino.ch/it/x/'],
        ]);

    await posthogSync.main();

    expect(createCalls()).toHaveLength(1);
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  });

  it('does not create issues for self-healed version-skew SyntaxErrors or opaque "Script error." (#3758/#3759/#3761)', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'k';
    process.env.POSTHOG_PROJECT_ID = 'p';
    issueListEmptyThenCreate(203);
    stubPostHogFetch([
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
        ]);

    await posthogSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(1);
    const title = calls[0][calls[0].indexOf('--title') + 1];
    expect(title).toContain('Cannot read properties');
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  });

  it('includes resolved stack origins (sample) in the body when $exception_list resolves frames, and "unresolved (0 frames)" otherwise (#5999)', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'k';
    process.env.POSTHOG_PROJECT_ID = 'p';
    issueListEmptyThenCreate(204);
    // HogQL's `any(properties.$exception_list)` (and every other read of a
    // JSON-typed column) comes back as a JSON-ENCODED STRING, not a parsed
    // array/object — confirmed live against the PostHog API while fixing
    // #5999 itself. Stubbing a plain object here (as this test previously
    // did) hid the real bug: extractStackFrameOrigins() silently returned
    // [] for every real row because Array.isArray() on a string is false.
    stubPostHogFetch([
      [
        'Ba', 'Error', 7, 2, 'https://frontaliereticino.ch/en/find-jobs-basel/quality-solution-lead-roche-ch/',
        JSON.stringify([{ stacktrace: { frames: [{ filename: 'https://accounts.google.com/gsi/client' }, { filename: 'https://accounts.google.com/gsi/client' }] } }]),
      ],
      [
        'no frames resolved', 'Error', 6, 3, 'https://frontaliereticino.ch/it/',
        JSON.stringify([{ stacktrace: { frames: [] } }]),
      ],
    ]);

    await posthogSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(2);
    const bodyFor = (title: string) => {
      const call = calls.find((c) => c[c.indexOf('--title') + 1].includes(title))!;
      return call[call.indexOf('--body') + 1];
    };
    expect(bodyFor('Ba')).toContain('**Resolved stack origins (sample):** https://accounts.google.com/gsi/client, https://accounts.google.com/gsi/client');
    expect(bodyFor('no frames resolved')).toContain('**Resolved stack origins (sample):** unresolved (0 frames)');
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  });

  it('does not create a GitHub issue for "Importing a module script failed" even above threshold (#3762)', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'k';
    process.env.POSTHOG_PROJECT_ID = 'p';
    issueListEmptyThenCreate(202);
    stubPostHogFetch([
          // Denied: kept in PostHog for chunk-load dashboards but not a backlog ticket.
          ['Importing a module script failed.', 'TypeError', 13, 10, 'https://frontaliereticino.ch/en/find-jobs-ticino/'],
          // Real actionable error — must still be synced.
          ['Cannot read properties of null', 'TypeError', 9, 7, 'https://frontaliereticino.ch/it/lavoro/'],
        ]);

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

describe('extractStackFrameOrigins (#5999: HogQL returns $exception_list as a JSON string)', () => {
  it('parses a JSON-string $exception_list, the shape any()/every row read of a JSON column actually returns from HogQL', () => {
    const raw = JSON.stringify([{ stacktrace: { frames: [{ filename: 'https://frontaliereticino.ch/it/' }] } }]);
    expect(extractStackFrameOrigins(raw)).toEqual(['https://frontaliereticino.ch/it/']);
  });

  it('returns [] (fail-open) for malformed JSON instead of throwing', () => {
    expect(extractStackFrameOrigins('not json')).toEqual([]);
  });

  it('still accepts an already-parsed array (defensive, in case a caller pre-parses)', () => {
    const parsed = [{ stacktrace: { frames: [{ filename: 'https://example.com/a.js' }] } }];
    expect(extractStackFrameOrigins(parsed)).toEqual(['https://example.com/a.js']);
  });

  it('returns [] for null/undefined/number without throwing', () => {
    expect(extractStackFrameOrigins(null)).toEqual([]);
    expect(extractStackFrameOrigins(undefined)).toEqual([]);
    expect(extractStackFrameOrigins(42)).toEqual([]);
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

  it('mirrors the AbortError pattern from services/benignErrorPatterns.ts byte-for-byte (#4147)', () => {
    const benignAbortError = UNIVERSAL_BENIGN_PATTERNS.find((p) =>
      p.test('AbortError: The user aborted a request.'),
    );
    expect(benignAbortError).toBeDefined();
    expect(ISSUE_DENY_PATTERNS.map((p: RegExp) => p.source)).toContain(benignAbortError!.source);
  });

  it('mirrors the anchored bare-transport-failure patterns ("Failed to fetch" / "Load failed" / "NetworkError") from services/benignErrorPatterns.ts byte-for-byte (#4150)', () => {
    // The three cross-browser bare transport-failure wordings must be denied
    // at issue-creation time (environmental noise — no actionable fix). Pattern
    // anchoring ensures contextualized and chunk-load variants stay issue-able.
    // Filter to the ANCHORED bare forms only (starts with `^(?:TypeError: )?`)
    // to exclude the Remote Config pattern which incidentally matches the same
    // keywords but is a different deny-class.
    const transportPatterns = UNIVERSAL_BENIGN_PATTERNS.filter((p) => {
      if (!p.source.startsWith('^(?:TypeError: )?')) return false;
      return p.test('Failed to fetch') || p.test('Load failed') || p.test('NetworkError when attempting to fetch resource.');
    });
    expect(transportPatterns).toHaveLength(3); // sanity: all three browser wordings covered
    const denySources = ISSUE_DENY_PATTERNS.map((p: RegExp) => p.source);
    for (const tp of transportPatterns) {
      expect(denySources).toContain(tp.source);
    }
  });

  it('mirrors the Firebase auth/network-request-failed pattern from services/benignErrorPatterns.ts byte-for-byte (#4174)', () => {
    const benignPattern = UNIVERSAL_BENIGN_PATTERNS.find((p) =>
      p.test('Firebase: Error (auth/network-request-failed).'),
    );
    expect(benignPattern).toBeDefined();
    expect(ISSUE_DENY_PATTERNS.map((p: RegExp) => p.source)).toContain(benignPattern!.source);
  });

  it('mirrors the unsupported-browser "Unexpected token ?" parse pattern from services/benignErrorPatterns.ts byte-for-byte (#4172)', () => {
    const benignPattern = UNIVERSAL_BENIGN_PATTERNS.find((p) => p.test("Unexpected token '?'"));
    expect(benignPattern).toBeDefined();
    expect(ISSUE_DENY_PATTERNS.map((p: RegExp) => p.source)).toContain(benignPattern!.source);
  });

  it('mirrors the NotReadableError I/O file-read pattern from services/benignErrorPatterns.ts byte-for-byte (#4175)', () => {
    const benignPattern = UNIVERSAL_BENIGN_PATTERNS.find((p) =>
      p.test('NotReadableError: The I/O read operation failed.'),
    );
    expect(benignPattern).toBeDefined();
    expect(ISSUE_DENY_PATTERNS.map((p: RegExp) => p.source)).toContain(benignPattern!.source);
  });

  it('denies unsupported-browser parse failures (#4172) and OS/hardware file-read failures (#4175)', () => {
    // Old browser parsing optional-chaining / nullish on a modern chunk.
    expect(isIssueDenied("Unexpected token '?'")).toBe(true);
    expect(isIssueDenied('Unexpected token ?')).toBe(true);
    expect(isIssueDenied("SyntaxError: Unexpected token '?'")).toBe(true);
    // But HTML-served-for-JS (real CDN fault) and JSON parse bugs still file.
    expect(isIssueDenied("Unexpected token '<'")).toBe(false);
    expect(isIssueDenied("Unexpected token 'o', \"<!DOCTYPE \"... is not valid JSON")).toBe(false);
    // OS/hardware file-read failure — user's disk/file, unfixable in code.
    expect(isIssueDenied('NotReadableError: The I/O read operation failed.')).toBe(true);
    expect(isIssueDenied('DOMException: NotReadableError: The I/O read operation failed.')).toBe(true);
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
    // The dynamic-import() rejection shape of a stale-chunk report (message carries the
    // rejection reason, not a bare URL — see the "sw_cache_stale bare-URL JS events" test
    // below for the bare-URL shape, which IS denied) remains issue-able: it can surface a
    // persistent CDN/chunk-load outage, not just a propagation-window blip.
    expect(isIssueDenied('Stale chunk: Failed to fetch dynamically imported module: https://cdn.frontaliereticino.ch/assets/App.js')).toBe(false);
    // And the denied class, for contrast:
    expect(isIssueDenied("The requested module './vendor-firebase-core.js' does not provide an export named 'createWebChannelTransport'")).toBe(true);
    // GA4 hard-truncates the error_message custom parameter at 100 chars
    // BEFORE it reaches this feeder, which can cut "an export named" off the
    // full-phrase pattern above (issue #5063: a long `[SilentBoundary:name]`
    // prefix pushed the phrase past the cutoff, so the message arrived here
    // reading only "...does not provide "). Must still be denied.
    expect(isIssueDenied("[SilentBoundary:ai-chatbot] SyntaxError: The requested module './internalLinks.js' does not provide ")).toBe(true);
    expect(isIssueDenied('Script error.')).toBe(true);
    // Bare transport failures (#4150): Chrome / Safari / Firefox wordings all denied.
    expect(isIssueDenied('TypeError: Failed to fetch')).toBe(true);
    expect(isIssueDenied('Failed to fetch')).toBe(true);
    expect(isIssueDenied('TypeError: Load failed')).toBe(true);
    expect(isIssueDenied('Load failed')).toBe(true);
    expect(isIssueDenied('NetworkError when attempting to fetch resource.')).toBe(true);
    // But "Failed to fetch" WITH a URL/context is NOT denied — CDN/chunk-load bugs.
    expect(isIssueDenied('[exchangeRate] Failed to fetch')).toBe(false);
    // AbortError class (#4147): user-cancelled navigation/fetch — benign, no code fix possible.
    expect(isIssueDenied('AbortError: The user aborted a request.')).toBe(true);
    expect(isIssueDenied('AbortError: The operation was aborted.')).toBe(true);
    expect(isIssueDenied('AbortError: signal is aborted without reason')).toBe(true);
    expect(isIssueDenied('AbortError: AbortError')).toBe(true);
    // Firebase auth/network-request-failed (#4174): transient client network failure during sign-in.
    expect(isIssueDenied('Firebase: Error (auth/network-request-failed).')).toBe(true);
    // Contextualized variant (reportCaughtError-shaped) also denied.
    expect(isIssueDenied('[auth.googleSignIn] Firebase: Error (auth/network-request-failed).')).toBe(true);
  });

  it('denies sw_cache_stale CSS events (#4151) — self-healed by the inline reload, not a backlog ticket', () => {
    // The CSS entry file and any per-chunk CSS are self-healed by the inline
    // link-error handler (bust + reload); the GA4 sw_cache_stale event keeps
    // the metric visible but must not flood the backlog with auto-fix issues.
    expect(isIssueDenied('Stale chunk: https://cdn.frontaliereticino.ch/assets/index.css')).toBe(true);
    expect(isIssueDenied('Stale chunk: https://cdn.frontaliereticino.ch/assets/seo-static.css')).toBe(true);
  });

  it('denies sw_cache_stale bare-URL JS events too (#4592) — same self-heal, not CSS-specific', () => {
    // it-core.js is modulepreloaded on nearly every IT page (preloadLocalePlugin.ts)
    // so it hits the post-deploy CDN propagation window at far higher volume than a
    // lazy chunk, inflating the site-wide error-rate alarm for an already-self-healed
    // event (data/error-triage-baseline.json already logged this exact "sw_cache_stale"
    // cluster, and NewsletterPopup.js's bare-URL variant, as "already-self-healing").
    expect(isIssueDenied('Stale chunk: https://cdn.frontaliereticino.ch/assets/it-core.js')).toBe(true);
    expect(isIssueDenied('Stale chunk: https://cdn.frontaliereticino.ch/assets/it-calculator.js')).toBe(true);
    expect(isIssueDenied('Stale chunk: https://cdn.frontaliereticino.ch/assets/App.js')).toBe(true);
    expect(isIssueDenied('Stale chunk: https://cdn.frontaliereticino.ch/assets/NewsletterPopup.js')).toBe(true);
    // But the DIFFERENT message shape from a dynamic import() rejection (unhandledrejection
    // handler, not the bare <script>/<link> error handler) still stays issue-able — it can
    // surface a persistent CDN/chunk-load outage, not just a propagation-window blip.
    expect(isIssueDenied('Stale chunk: Failed to fetch dynamically imported module: https://cdn.frontaliereticino.ch/assets/App.js')).toBe(false);
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


// ── #5064 / #5065: stale page_404 telemetry ────────────────────────────────
// The GA4 report window is a TRAILING 30 days, so a 404 fixed on day 3 keeps
// opening `priority:high` + `needs-human` issues for another 27 days. Both
// issues were verified live: the two job URLs answer HTTP 200 with a complete
// JobPosting page. The feeder now re-checks the URL against production before
// filing — a URL that answers 200 is not a 404.
describe('page404Path — identifying a page_404 candidate', () => {
  it('reads the path from pagePath', () => {
    expect(page404Path({ errorType: 'page_404', pagePath: '/cerca-lavoro-berna/x/' }))
      .toBe('/cerca-lavoro-berna/x/');
  });

  it('falls back to the message when pagePath is absent', () => {
    expect(page404Path({ errorType: 'page_404', errorMessage: 'Page not found: /cerca-lavoro-ginevra/y/' }))
      .toBe('/cerca-lavoro-ginevra/y/');
  });

  it('strips the query string (the 404 is a fact about the path)', () => {
    expect(page404Path({ errorType: 'page_404', pagePath: '/a/b/?utm_source=x' })).toBe('/a/b/');
  });

  it('returns empty for any other error class', () => {
    expect(page404Path({ errorType: 'TypeError', pagePath: '/a/' })).toBe('');
    expect(page404Path({ errorType: 'page_404', pagePath: 'https://evil.example/a' })).toBe('');
  });
});

describe('isSelfHealedPage404 — probe production before filing', () => {
  it('is true when the URL answers 200 today (stale telemetry)', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    await expect(
      isSelfHealedPage404({ errorType: 'page_404', pagePath: '/cerca-lavoro-berna/x/' }, { fetchImpl }),
    ).resolves.toBe(true);
  });

  it('is true for a 301 to a live page (canton-drift recovery also resolves the URL)', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 301 }));
    await expect(
      isSelfHealedPage404({ errorType: 'page_404', pagePath: '/a/' }, { fetchImpl }),
    ).resolves.toBe(true);
  });

  it('is false when the URL still 404s — a real defect keeps its issue', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404 }));
    await expect(
      isSelfHealedPage404({ errorType: 'page_404', pagePath: '/a/' }, { fetchImpl }),
    ).resolves.toBe(false);
  });

  it('fails OPEN when the probe throws — an unreachable prod never hides a 404', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(
      isSelfHealedPage404({ errorType: 'page_404', pagePath: '/a/' }, { fetchImpl }),
    ).resolves.toBe(false);
  });

  it('never probes a non-page_404 entry', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    await expect(
      isSelfHealedPage404({ errorType: 'TypeError', errorMessage: 'boom', pagePath: '/a/' }, { fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // #5532: a plain Node fetch sends no User-Agent, which Cloudflare's
  // "unidentified-scripted-traffic-challenge" rule treats as empty and
  // managed_challenge's with 403 — the probe then always concluded "not
  // self-healed" regardless of the page's real status.
  it('sends the shared live-check User-Agent so Cloudflare does not 403-block the probe', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    await isSelfHealedPage404({ errorType: 'page_404', pagePath: '/a/' }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('FrontaliereTicino') }) }),
    );
  });

  // Declared choice (issue #5532): a 301 only counts as self-healed when it
  // lands on a SPECIFIC resolved page (canton-drift canonical, company-hub
  // fix, legacy-cluster board). The Worker's last-resort
  // recoverExpiredJobToCantonRoot 301s a genuinely expired job slug to the
  // generic canton SECTION ROOT instead — that must still read as a live 404.
  it('is false for a 301 to the generic canton section root (expired-job last-resort fallback, not a real fix)', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 301,
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? '/cerca-lavoro-berna/' : null) },
    }));
    await expect(
      isSelfHealedPage404({ errorType: 'page_404', pagePath: '/cerca-lavoro-berna/some-expired-job/' }, { fetchImpl }),
    ).resolves.toBe(false);
  });

  it('is true for a 301 to a SPECIFIC other page (canton-drift recovered to its real canonical URL)', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 301,
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? '/cerca-lavoro-zurigo/some-job-real-canton/' : null) },
    }));
    await expect(
      isSelfHealedPage404({ errorType: 'page_404', pagePath: '/cerca-lavoro-berna/some-job-real-canton/' }, { fetchImpl }),
    ).resolves.toBe(true);
  });
});

describe('app-error-issue-sync.mjs — page_404 liveness gate (#5064/#5065)', () => {
  const report = (pagePath: string) => JSON.stringify({
    ga4: {
      errorHealth: {
        totalErrors: 45,
        errorRate: 4.94,
        healthStatus: '🔴 CRITICAL',
        appErrors: [
          {
            errorType: 'page_404',
            errorMessage: `Page not found: ${pagePath}`,
            pagePath,
            count: 21,
            users: 13,
          },
        ],
      },
    },
  });

  it('does NOT file an issue for a page_404 whose URL resolves today', async () => {
    issueListEmptyThenCreate(501);
    readFileSync.mockReturnValue(report('/cerca-lavoro-berna/venditore-in-food-coop-unterseen-3357ff/'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));

    await appErrorSync.main();

    expect(createCalls()).toHaveLength(0);
  });

  it('still files an issue for a page_404 that is genuinely dead', async () => {
    issueListEmptyThenCreate(502);
    readFileSync.mockReturnValue(report('/cerca-lavoro-berna/davvero-morto/'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404 })));

    await appErrorSync.main();

    expect(createCalls()).toHaveLength(1);
  });
});
