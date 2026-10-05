import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

/**
 * Coverage for scripts/cwv-monitor-check.mjs — the #4302 weekly CLS/INP
 * regression watchdog (GA4 `web_vitals` field data → per-page history
 * → "2 consecutive weeks over threshold" → GitHub backlog issue via the
 * shared scripts/lib/error-issue-sync.mjs sync).
 *
 * main() guards its live GA4 fetch + gh call behind an
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

describe('main() — GA4 is the only source (H9)', () => {
  const originalEnv = { ...process.env };
  const HISTORY = '/tmp/cwv-monitor-check-test-history.json';
  const ALIVE = { alive: true, reason: 'ga4 alive', source: 'ga4', windowDays: 7, floor: 500 };

  /** GA4 web_vitals rows for every target page except `skip`. */
  function ga4Rows({ cls = 0.05, inp = 100, count = 50, skip = [] as string[] } = {}) {
    const rows: any[] = [];
    for (const page of TARGET_PAGES) {
      if (skip.includes(page.path)) continue;
      rows.push({ path: page.path, device: 'mobile', metric: 'CLS', value: cls, count });
      rows.push({ path: page.path, device: 'mobile', metric: 'INP', value: inp, count });
    }
    return Object.assign(rows, { coverage: { timeZone: 'Europe/Zurich' } });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CWV_MONITOR_HISTORY_FILE = HISTORY;
    // In CI l'override vuole un opt-in esplicito, altrimenti main() scrive il
    // file TRACCIATO data/cwv-monitor-history.json (resolve-output-path.mjs).
    process.env.CWV_MONITOR_HISTORY_FILE_ALLOW_CI = '1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    // Best-effort cleanup of the scratch history file used by this suite.
    rmSync(HISTORY, { force: true });
  });

  it('abstains without querying GA4 when the GA4 guard says the source is dead', async () => {
    const ga4FallbackImpl = vi.fn(async () => ga4Rows({ cls: 3.0 }));
    const result = await main({
      checkLivenessImpl: async () => ({ alive: false, reason: 'ga4 ingested < 500 events/day', source: 'ga4', windowDays: 7, floor: 500 }),
      ga4FallbackImpl,
    });
    expect(result.status).toBe('source-unavailable');
    expect(ga4FallbackImpl).not.toHaveBeenCalled();
    const row = loadHistory(HISTORY).pages.home.weeks.at(-1);
    expect(row.cls_p75).toBeNull();
    expect(row.sourceUnavailable).toMatch(/ga4 ingested < 500/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('does not open an issue on the first over-threshold week (needs two in a row)', async () => {
    const now = new Date();
    const checkLivenessImpl = vi.fn(async () => ALIVE);
    const result = await main({ now, checkLivenessImpl, ga4FallbackImpl: async () => ga4Rows({ cls: 1.5 }) });
    // The GA4 guard has the same lag-2 settled window as the report: no shift.
    expect(checkLivenessImpl).toHaveBeenCalledWith({ windowDays: 7, now });
    expect(result.status).toBe('ok');
    expect(result.source).toBe('ga4');
    const snapshot = loadHistory(HISTORY).pages.home.weeks.at(-1);
    expect(snapshot).toMatchObject({ source: 'ga4', minimumSamples: 30, window: { days: 7, lagDays: 2, timezone: 'Europe/Zurich' } });
    expect(snapshot.devices.mobile).toMatchObject({ cls_n: 50, cls_status: 'measured' });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('persists null snapshots when GA4 is alive but has no target observations', async () => {
    const result = await main({ checkLivenessImpl: async () => ALIVE, ga4FallbackImpl: async () => [] });
    expect(result.status).toBe('source-unavailable');

    const history = loadHistory(HISTORY);
    expect(Object.keys(history.pages)).toHaveLength(TARGET_PAGES.length);
    for (const page of TARGET_PAGES) {
      const row = history.pages[page.key].weeks.at(-1);
      expect(row.cls_p75).toBeNull();
      expect(row.inp_p75).toBeNull();
      expect(row.cls_n).toBe(0);
      expect(row.inp_n).toBe(0);
      expect(row.sourceUnavailable).toMatch(/GA4 web_vitals report returned no usable target/);
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('fails closed when one live target page has no target observations', async () => {
    const result = await main({
      checkLivenessImpl: async () => ALIVE,
      ga4FallbackImpl: async () => ga4Rows({ skip: ['/cerca-lavoro-ticino/'] }),
    });

    expect(result.status).toBe('source-unavailable');
    expect(result.unavailablePages).toContain('cerca_lavoro_ticino');
    const history = loadHistory(HISTORY);
    expect(history.pages.cerca_lavoro_ticino.weeks.at(-1)).toMatchObject({
      cls_p75: null,
      cls_n: 0,
      inp_p75: null,
      inp_n: 0,
      sourceUnavailable: 'no target observations in 7d window',
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('no longer reaches PostHog at runtime', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../scripts/cwv-monitor-check.mjs', import.meta.url), 'utf8');
    expect(src).not.toMatch(/posthog-client\.mjs|checkPostHogLiveness|runHogQL|POSTHOG_PERSONAL_API_KEY/);
    expect(src).toMatch(/checkLivenessImpl = checkGa4Liveness/);
  });
});
