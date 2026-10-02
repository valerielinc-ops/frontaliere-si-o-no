import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

/**
 * Coverage for scripts/cwv-monitor-check.mjs — the #4302 weekly CLS/INP
 * regression watchdog (PostHog `$web_vitals` field data → per-page history
 * → "2 consecutive weeks over threshold" → GitHub backlog issue via the
 * shared scripts/lib/error-issue-sync.mjs sync).
 *
 * main() guards its live PostHog fetch + gh call behind an
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check (same
 * pattern as scripts/posthog-error-issue-sync.mjs), so importing the module
 * here never fires a real network/gh call on its own — the pure
 * history/regression helpers (loadHistory, recordSnapshot,
 * evaluateConsecutiveRegression) are exercised directly, and main() itself is
 * exercised with mocked fetch/fs/gh.
 */

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const {
  TARGET_PAGES,
  loadHistory,
  saveHistory,
  recordSnapshot,
  recordSourceUnavailableSnapshots,
  evaluateConsecutiveRegression,
  main,
  buildQuery,
  ga4CwvSnapshot,
} = await import('../scripts/cwv-monitor-check.mjs');

describe('TARGET_PAGES', () => {
  it('every page has a stable key, a leading/trailing-slash path, and at least one threshold', () => {
    expect(TARGET_PAGES.length).toBeGreaterThan(0);
    const seenKeys = new Set<string>();
    for (const page of TARGET_PAGES) {
      expect(page.key).toMatch(/^[a-z0-9_]+$/);
      expect(seenKeys.has(page.key)).toBe(false);
      seenKeys.add(page.key);
      expect(page.path.startsWith('/')).toBe(true);
      expect(page.path.endsWith('/')).toBe(true);
      expect(page.cls != null || page.inp != null).toBe(true);
    }
  });

  it('includes the #4302 mappa-confine page with BOTH a CLS and an INP target', () => {
    const mappa = TARGET_PAGES.find((p) => p.key === 'mappa_confine');
    expect(mappa).toBeDefined();
    expect(mappa!.path).toBe('/guida-frontaliere/mappa-confine/');
    expect(mappa!.cls).toBe(0.25);
    expect(mappa!.inp).toBe(500);
  });
});

describe('evaluateConsecutiveRegression', () => {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const day = (ago: number) => new Date(end.getTime() - ago * 86400000).toISOString().slice(0, 10);
  const week = (ago: number, value: number | null = 0.5, count = 40) => ({
    date: day(ago), source: 'posthog', cls_p75: value, cls_n: count,
    window: { startDate: day(ago + 6), endDate: day(ago), days: 7, lagDays: 2, timezone: 'UTC' },
    devices: { mobile: { cls_p75: value, cls_n: count } },
  });

  it('requires two sampled observations above an explicit target', () => {
    expect(evaluateConsecutiveRegression([week(7), week(0)], 'cls_p75', undefined)).toBeNull();
    expect(evaluateConsecutiveRegression([week(0)], 'cls_p75', 0.25)).toBeNull();
    expect(evaluateConsecutiveRegression([week(7, 0.1), week(0)], 'cls_p75', 0.25)).toBeNull();
    expect(evaluateConsecutiveRegression([week(7), week(0, 0.1)], 'cls_p75', 0.25)).toBeNull();
    expect(evaluateConsecutiveRegression([week(7), week(0)], 'cls_p75', 0.25, 'mobile')).toMatchObject({ device: 'mobile' });
  });

  it('never bridges an outage, low-sample period or unknown legacy provenance', () => {
    expect(evaluateConsecutiveRegression([week(14), week(7, null), week(0)], 'cls_p75', 0.25)).toBeNull();
    expect(evaluateConsecutiveRegression([week(7, 0.5, 29), week(0)], 'cls_p75', 0.25)).toBeNull();
    expect(evaluateConsecutiveRegression([{ cls_p75: 1, cls_n: 40 }, week(0)], 'cls_p75', 0.25)).toBeNull();
  });

  it('rejects source changes, different window lengths and overlapping reruns', () => {
    expect(evaluateConsecutiveRegression([week(7), { ...week(0), source: 'ga4' }], 'cls_p75', 0.25)).toBeNull();
    expect(evaluateConsecutiveRegression([week(7), { ...week(0), window: { ...week(0).window, days: 30 } }], 'cls_p75', 0.25)).toBeNull();
    expect(evaluateConsecutiveRegression([week(3), week(0)], 'cls_p75', 0.25)).toBeNull();
  });

  it('does not let healthy desktop samples mask mobile', () => {
    const rows = [
      { path: '/', device: 'mobile', metric: 'INP', value: 1500, count: 30 },
      { path: '/', device: 'desktop', metric: 'INP', value: 100, count: 1000 },
    ];
    expect(ga4CwvSnapshot(rows, '/', 'mobile')).toMatchObject({ inp_p75: 1500, inp_n: 30 });
    expect(ga4CwvSnapshot(rows, '/', 'desktop')).toMatchObject({ inp_p75: 100, inp_n: 1000 });
    const query = buildQuery('/', { startDate: day(6), endDate: day(0) });
    expect(query).toContain('GROUP BY device');
    expect(query).toContain(day(6));
    expect(query).not.toContain('now()');
  });
});

describe('recordSnapshot', () => {
  it('creates a new page entry and appends a week row', () => {
    const history: { pages: Record<string, any> } = { pages: {} };
    recordSnapshot(history, 'home', '/', '2026-07-08', { cls_p75: 0.05, cls_n: 100, inp_p75: 200, inp_n: 90 });
    expect(history.pages.home.path).toBe('/');
    expect(history.pages.home.weeks).toHaveLength(1);
    expect(history.pages.home.weeks[0]).toMatchObject({ date: '2026-07-08', cls_p75: 0.05 });
  });

  it('overwrites in place (does not duplicate) when the same date is recorded twice', () => {
    const history: { pages: Record<string, any> } = { pages: {} };
    recordSnapshot(history, 'home', '/', '2026-07-08', { cls_p75: 0.05, cls_n: 100, inp_p75: 200, inp_n: 90 });
    recordSnapshot(history, 'home', '/', '2026-07-08', { cls_p75: 0.09, cls_n: 150, inp_p75: 210, inp_n: 95 });
    expect(history.pages.home.weeks).toHaveLength(1);
    expect(history.pages.home.weeks[0].cls_p75).toBe(0.09);
  });

  it('appends a second row for a new date, preserving history (never pruned)', () => {
    const history: { pages: Record<string, any> } = { pages: {} };
    recordSnapshot(history, 'home', '/', '2026-07-01', { cls_p75: 0.05, cls_n: 100, inp_p75: 200, inp_n: 90 });
    recordSnapshot(history, 'home', '/', '2026-07-08', { cls_p75: 0.06, cls_n: 110, inp_p75: 210, inp_n: 95 });
    expect(history.pages.home.weeks).toHaveLength(2);
  });
});

describe('loadHistory / saveHistory round-trip', () => {
  it('returns an empty { pages: {} } shape when the file does not exist', () => {
    const history = loadHistory('/tmp/does-not-exist-cwv-history-4302.json');
    expect(history).toEqual({ pages: {} });
  });

  it('records an explicit null snapshot for every target when the source is unavailable', () => {
    const history: { pages: Record<string, any> } = { pages: {} };
    recordSourceUnavailableSnapshots(history, '2026-07-08', 'PostHog down; GA4 empty');

    expect(Object.keys(history.pages)).toHaveLength(TARGET_PAGES.length);
    for (const page of TARGET_PAGES) {
      expect(history.pages[page.key].weeks).toEqual([{
        date: '2026-07-08',
        cls_p75: null,
        cls_n: 0,
        inp_p75: null,
        inp_n: 0,
        sourceUnavailable: 'PostHog down; GA4 empty',
      }]);
    }
  });
});

describe('main()', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.POSTHOG_PERSONAL_API_KEY = 'test-key';
    process.env.POSTHOG_PROJECT_ID = '123';
    process.env.CWV_MONITOR_HISTORY_FILE = '/tmp/cwv-monitor-check-test-history.json';
    // In CI l'override vuole un opt-in esplicito, altrimenti main() scrive il
    // file TRACCIATO data/cwv-monitor-history.json (resolve-output-path.mjs).
    process.env.CWV_MONITOR_HISTORY_FILE_ALLOW_CI = '1';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    // Best-effort cleanup of the scratch history file used by this suite.
    rmSync('/tmp/cwv-monitor-check-test-history.json', { force: true });
  });

  it('returns early without querying PostHog when credentials are missing', async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
    global.fetch = vi.fn();
    const result = await main({ ga4FallbackImpl: async () => [] });
    expect(result.status).toBe('source-unavailable');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not open an issue on the first over-threshold week (needs two in a row)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [[1.5, 50, 100, 40]] }), // cls_p75=1.5 (way over every threshold)
    });
    const now = new Date();
    const checkLivenessImpl = vi.fn(async () => ({ alive: true }));
    const result = await main({ now, checkLivenessImpl, ga4FallbackImpl: async () => [] });
    expect(checkLivenessImpl).toHaveBeenCalledWith({ windowDays: 7, now: new Date(now.getTime() - 86400000) });
    expect(result.status).toBe('ok');
    const snapshot = loadHistory('/tmp/cwv-monitor-check-test-history.json').pages.home.weeks.at(-1);
    expect(snapshot).toMatchObject({ source: 'posthog', minimumSamples: 30, window: { days: 7, lagDays: 2, timezone: 'UTC' } });
    expect(snapshot.devices.unknown).toMatchObject({ cls_n: 50, cls_status: 'measured' });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('persists null snapshots when PostHog is dead and GA4 has no target observations', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    const result = await main({ ga4FallbackImpl: async () => [] });
    expect(result.status).toBe('source-unavailable');

    const history = loadHistory('/tmp/cwv-monitor-check-test-history.json');
    expect(Object.keys(history.pages)).toHaveLength(TARGET_PAGES.length);
    for (const page of TARGET_PAGES) {
      const row = history.pages[page.key].weeks.at(-1);
      expect(row.cls_p75).toBeNull();
      expect(row.inp_p75).toBeNull();
      expect(row.cls_n).toBe(0);
      expect(row.inp_n).toBe(0);
      expect(row.sourceUnavailable).toMatch(/GA4 fallback returned no target/);
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('fails closed when one live target page has no target observations', async () => {
    const runHogQLImpl = vi.fn(async (query: string) => {
      if (query.includes("properties.$pathname = '/cerca-lavoro-ticino/'")) {
        return { results: [[null, 1, null, 0]] };
      }
      return { results: [[0.05, 100, 200, 100]] };
    });
    const result = await main({
      checkLivenessImpl: async () => ({
        alive: true,
        reason: 'test source alive',
        source: 'posthog',
        windowDays: 7,
        floor: 500,
      }),
      runHogQLImpl,
      ga4FallbackImpl: async () => [],
    });

    expect(result.status).toBe('source-unavailable');
    expect(result.unavailablePages).toContain('cerca_lavoro_ticino');
    const history = loadHistory('/tmp/cwv-monitor-check-test-history.json');
    expect(history.pages.cerca_lavoro_ticino.weeks.at(-1)).toMatchObject({
      cls_p75: null,
      cls_n: 0,
      inp_p75: null,
      inp_n: 0,
      sourceUnavailable: 'no target observations in 7d window',
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
