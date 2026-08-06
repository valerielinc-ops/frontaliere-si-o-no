import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression tests for the recency gate in scripts/cf-5xx-issue-sync.mjs
 * (issues #5231 / #5232).
 *
 * The defect these guard against is not a crash and not a wrong number — every
 * number the feeder printed was correct. It selected on a path's 5xx TOTAL over
 * a trailing 23h window, which has no time resolution, so "failing for 23 hours"
 * and "failed for 60 seconds, 14 hours ago" reduced to the same integer. The
 * old docblock even claimed it filed on "sustained 5xx volume"; nothing in the
 * code or the tests could observe sustained-ness.
 *
 * The fixtures below are the real incident, not invented shapes. Re-queried
 * from Cloudflare's httpRequestsAdaptiveGroups at `datetimeMinute` resolution
 * on 2026-08-06:
 *
 *   cdn.frontaliereticino.ch/assets/vendor-fdb-auth.js   24 5xx, ALL at 16:03Z
 *   cdn.frontaliereticino.ch/assets/borderWaitFormat.js  21 5xx, ALL at 15:41Z
 *
 * both on 2026-08-05, both zero in every one of the ~14 hours that followed,
 * both serving 200/HIT when probed — yet both were filed as priority:medium
 * `agent:fix-queued` issues at 2026-08-06T06:18Z.
 *
 * NEGATIVE CONTROL is the point of this file: the same counts with a CURRENT
 * last-hour must still file. A gate that suppressed both would be worse than
 * the bug.
 */

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const cfSync = await import('../scripts/cf-5xx-issue-sync.mjs');
const { summarizeBursts, isStaleBurst } = cfSync;

/** The moment cf-5xx-monitor.yml actually filed #5231 and #5232. */
const RUN_AT = new Date('2026-08-06T06:18:14Z');

const VENDOR = 'cdn.frontaliereticino.ch/assets/vendor-fdb-auth.js';
const BORDER = 'cdn.frontaliereticino.ch/assets/borderWaitFormat.js';

/** The exact rows Cloudflare returns for the two issue paths. */
const REAL_BURSTS = [
  { status: 502, url: VENDOR, hour: '2026-08-05T16:00:00Z', count: 24 },
  { status: 502, url: BORDER, hour: '2026-08-05T15:00:00Z', count: 21 },
];

const REAL_TOTALS = [
  { status: 502, url: VENDOR, count: 24 },
  { status: 502, url: BORDER, count: 21 },
];

function ghCalls(): string[][] {
  return execFileSync.mock.calls.filter((c) => c[0] === 'gh').map((c) => c[1] as string[]);
}
function createCalls(): string[][] {
  return ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'create');
}

/** Wire the cf-status-report subprocess + a gh CLI that always creates. */
function mockReport(payload: Record<string, unknown>) {
  execFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'node' && args[0] === 'scripts/cf-status-report.mjs') return JSON.stringify(payload);
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return '[]';
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      return 'https://github.com/o/r/issues/9001';
    }
    return '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(RUN_AT);
  process.env.CF_API_TOKEN = 't';
  delete process.env.GH_REPO;
  delete process.env.CF_5XX_MAX_AGE_HOURS;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CF_API_TOKEN;
});

describe('summarizeBursts — the time dimension the feeder never had', () => {
  it('reports #5231 as a single-hour burst that ended 14h before the run', () => {
    const shape = summarizeBursts(REAL_BURSTS, RUN_AT).get(VENDOR);
    expect(shape.total).toBe(24);
    expect(shape.activeHours).toBe(1);
    expect(shape.peakShare).toBe(1); // 100% of the 5xx in one hour bucket
    expect(shape.lastHour).toBe('2026-08-05T16:00:00Z');
    expect(shape.hoursSinceLast).toBeCloseTo(14.3, 1);
  });

  it('separates a genuinely sustained failure from a blip of the same total', () => {
    const sustained = Array.from({ length: 12 }, (_, i) => ({
      url: 'frontaliereticino.ch/x/',
      hour: `2026-08-0${5 + Math.floor((18 + i) / 24)}T${String((18 + i) % 24).padStart(2, '0')}:00:00Z`,
      count: 2,
    }));
    const shape = summarizeBursts(sustained, RUN_AT).get('frontaliereticino.ch/x/');
    expect(shape.total).toBe(24); // same total as #5231 …
    expect(shape.activeHours).toBe(12); // … completely different shape
    expect(shape.peakShare).toBeLessThan(0.2);
  });

  it('ignores unusable rows instead of inventing a shape', () => {
    const shapes = summarizeBursts(
      [
        { url: VENDOR, hour: 'not-a-date', count: 9 },
        { url: '', hour: '2026-08-05T16:00:00Z', count: 9 },
        { url: BORDER, hour: '2026-08-05T15:00:00Z', count: 0 },
      ],
      RUN_AT,
    );
    expect(shapes.size).toBe(0);
  });
});

describe('isStaleBurst — refuses to guess', () => {
  it('is true for a burst that ended well outside the window', () => {
    expect(isStaleBurst(summarizeBursts(REAL_BURSTS, RUN_AT).get(VENDOR), 2)).toBe(true);
  });

  it('is false for an error inside the current hour (an outage happening now)', () => {
    const live = [{ url: VENDOR, hour: '2026-08-06T06:00:00Z', count: 24 }];
    expect(isStaleBurst(summarizeBursts(live, RUN_AT).get(VENDOR), 2)).toBe(false);
  });

  it('is false when the shape is unknown — no evidence is not evidence of absence', () => {
    expect(isStaleBurst(undefined, 2)).toBe(false);
  });

  it('is false when the gate is disabled (maxAgeHours <= 0)', () => {
    expect(isStaleBurst(summarizeBursts(REAL_BURSTS, RUN_AT).get(VENDOR), 0)).toBe(false);
  });
});

describe('cf-5xx-issue-sync.mjs — #5231 / #5232 must not be filed', () => {
  it('files NOTHING for two bursts that were already over when the monitor ran', async () => {
    mockReport({ detail: REAL_TOTALS, detailByHour: REAL_BURSTS });

    await cfSync.main();

    // Pre-fix this created exactly two issues: #5231 and #5232.
    expect(createCalls()).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: the same counts still file when the burst is current', async () => {
    mockReport({
      detail: REAL_TOTALS,
      detailByHour: [
        { status: 502, url: VENDOR, hour: '2026-08-06T06:00:00Z', count: 24 },
        { status: 502, url: BORDER, hour: '2026-08-06T05:00:00Z', count: 21 },
      ],
    });

    await cfSync.main();

    const calls = createCalls();
    expect(calls).toHaveLength(2);
    const titles = calls.map((c) => c[c.indexOf('--title') + 1]);
    expect(titles.some((t) => t.includes('vendor-fdb-auth.js'))).toBe(true);
  });

  it('files a still-live path even when a stale one outranks it', async () => {
    mockReport({
      detail: [
        { status: 502, url: VENDOR, count: 240 }, // biggest total, but over
        { status: 503, url: 'frontaliereticino.ch/live/', count: 22 },
      ],
      detailByHour: [
        { status: 502, url: VENDOR, hour: '2026-08-05T16:00:00Z', count: 240 },
        { status: 503, url: 'frontaliereticino.ch/live/', hour: '2026-08-06T06:00:00Z', count: 22 },
      ],
    });

    await cfSync.main();

    const titles = createCalls().map((c) => c[c.indexOf('--title') + 1]);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain('frontaliereticino.ch/live/');
  });

  it('carries the burst shape into the body, so nobody re-derives it by hand', async () => {
    mockReport({
      detail: REAL_TOTALS,
      detailByHour: [{ status: 502, url: VENDOR, hour: '2026-08-06T06:00:00Z', count: 24 }],
    });

    await cfSync.main();

    const call = createCalls()[0];
    const body = call[call.indexOf('--body') + 1];
    expect(body).toContain('**Last 5xx:** 2026-08-06T06:00:00Z');
    expect(body).toContain('1 of 23 hours had 5xx');
    // The old label called 24 the number of REQUESTS; the asset served 22,387
    // that day. It is the number of 5xx responses.
    expect(body).toContain('**5xx responses (last 23h):** 24');
  });
});

describe('the gate cannot be disarmed silently', () => {
  it('asks cf-status-report for the hourly rows', async () => {
    mockReport({ detail: REAL_TOTALS, detailByHour: REAL_BURSTS });

    await cfSync.main();

    const reportArgs = execFileSync.mock.calls.find(
      (c) => c[0] === 'node' && (c[1] as string[])[0] === 'scripts/cf-status-report.mjs',
    )![1] as string[];
    // Drop --by-hour and detailByHour is always undefined → gate permanently
    // open with no other symptom. That is the regression this pins.
    expect(reportArgs).toContain('--by-hour');
  });

  it('fails OPEN and says so when the hourly rows are missing', async () => {
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReport({ detail: REAL_TOTALS }); // no detailByHour

    await cfSync.main();

    expect(createCalls()).toHaveLength(2); // nothing suppressed on missing data
    const printed = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('recency gate inactive');
    warn.mockRestore();
  });
});
