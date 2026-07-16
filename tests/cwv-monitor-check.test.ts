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
  evaluateConsecutiveRegression,
  main,
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
  it('returns null when threshold is undefined for that metric', () => {
    const weeks = [{ date: '2026-07-01', cls_p75: 2 }, { date: '2026-07-08', cls_p75: 2 }];
    expect(evaluateConsecutiveRegression(weeks, 'cls_p75', undefined)).toBeNull();
  });

  it('returns null with fewer than 2 recorded weeks', () => {
    const weeks = [{ date: '2026-07-08', cls_p75: 2 }];
    expect(evaluateConsecutiveRegression(weeks, 'cls_p75', 0.25)).toBeNull();
  });

  it('returns null when only the latest week is over threshold (one bad week is noise)', () => {
    const weeks = [
      { date: '2026-07-01', cls_p75: 0.1 },
      { date: '2026-07-08', cls_p75: 0.5 },
    ];
    expect(evaluateConsecutiveRegression(weeks, 'cls_p75', 0.25)).toBeNull();
  });

  it('returns the two data points when the last two recorded weeks are BOTH over threshold', () => {
    const weeks = [
      { date: '2026-06-24', cls_p75: 0.1 }, // ignored — only the last two matter
      { date: '2026-07-01', cls_p75: 0.4 },
      { date: '2026-07-08', cls_p75: 0.5 },
    ];
    const result = evaluateConsecutiveRegression(weeks, 'cls_p75', 0.25);
    expect(result).not.toBeNull();
    expect(result!.previous.date).toBe('2026-07-01');
    expect(result!.current.date).toBe('2026-07-08');
  });

  it('skips weeks where the metric failed to record (null) when picking the "last two"', () => {
    const weeks = [
      { date: '2026-07-01', cls_p75: 0.4 },
      { date: '2026-07-08', cls_p75: null },
      { date: '2026-07-15', cls_p75: 0.5 },
    ];
    // Only two real data points exist (0.4, 0.5) — both over 0.25 → regression.
    const result = evaluateConsecutiveRegression(weeks, 'cls_p75', 0.25);
    expect(result).not.toBeNull();
    expect(result!.previous.date).toBe('2026-07-01');
    expect(result!.current.date).toBe('2026-07-15');
  });

  it('recovers (no regression) once the latest week drops back under threshold', () => {
    const weeks = [
      { date: '2026-07-01', cls_p75: 0.5 },
      { date: '2026-07-08', cls_p75: 0.5 },
      { date: '2026-07-15', cls_p75: 0.1 },
    ];
    expect(evaluateConsecutiveRegression(weeks, 'cls_p75', 0.25)).toBeNull();
  });
});

describe('recordSnapshot', () => {
  it('creates a new page entry and appends a week row', () => {
    const history = { pages: {} };
    recordSnapshot(history, 'home', '/', '2026-07-08', { cls_p75: 0.05, cls_n: 100, inp_p75: 200, inp_n: 90 });
    expect(history.pages.home.path).toBe('/');
    expect(history.pages.home.weeks).toHaveLength(1);
    expect(history.pages.home.weeks[0]).toMatchObject({ date: '2026-07-08', cls_p75: 0.05 });
  });

  it('overwrites in place (does not duplicate) when the same date is recorded twice', () => {
    const history = { pages: {} };
    recordSnapshot(history, 'home', '/', '2026-07-08', { cls_p75: 0.05, cls_n: 100, inp_p75: 200, inp_n: 90 });
    recordSnapshot(history, 'home', '/', '2026-07-08', { cls_p75: 0.09, cls_n: 150, inp_p75: 210, inp_n: 95 });
    expect(history.pages.home.weeks).toHaveLength(1);
    expect(history.pages.home.weeks[0].cls_p75).toBe(0.09);
  });

  it('appends a second row for a new date, preserving history (never pruned)', () => {
    const history = { pages: {} };
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
});

describe('main()', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.POSTHOG_PERSONAL_API_KEY = 'test-key';
    process.env.POSTHOG_PROJECT_ID = '123';
    process.env.CWV_MONITOR_HISTORY_FILE = '/tmp/cwv-monitor-check-test-history.json';
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
    await main();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not open an issue on the first over-threshold week (needs two in a row)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [[1.5, 50, 100, 40]] }), // cls_p75=1.5 (way over every threshold)
    });
    await main();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
