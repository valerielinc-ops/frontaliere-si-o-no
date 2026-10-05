import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const { summarizeBursts, isStaleBurst, buildIssueBody } = cfSync;

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

  it('keeps endpoint status, origin and cache evidence correlated to the URL', () => {
    const shape = summarizeBursts([
      {
        status: 503,
        url: 'frontaliereticino.ch/fr/trouver-emploi-suisse/recherche-kurs-basel/',
        hour: '2026-08-06T06:00:00Z',
        count: 30,
        originResponseStatus: 0,
        cacheStatus: 'none',
      },
    ], RUN_AT).get('frontaliereticino.ch/fr/trouver-emploi-suisse/recherche-kurs-basel/');
    expect(shape.endpointEvidence).toEqual([
      { edgeStatus: '503', originStatus: '0', cacheStatus: 'none', count: 30 },
    ]);
  });
});

describe('issue triage for #8839, #8840 and #10342', () => {
  const reports = [
    { url: 'gh-default.frontaliereticino.ch/github/webhook', surface: 'github-webhook-default' },
    { url: 'gh-default-agenti.frontaliereticino.ch/github/webhook', surface: 'github-webhook-default-agenti' },
    { url: 'gh-nanako.frontaliereticino.ch/github/webhook', surface: 'github-webhook-nanako' },
    { url: 'frontaliereticino.ch/fr/trouver-emploi-suisse/recherche-kurs-basel/', surface: 'worker-shard' },
  ];

  it.each(reports)('does not call $url a current outage without hourly evidence', ({ url, surface }) => {
    const body = buildIssueBody({ url, status: 503, count: 30, shape: undefined });
    expect(body).toContain(`Host/path classification: \`${surface}\``);
    expect(body).toContain('current failure is unverified');
    expect(body).toContain('Endpoint diagnostics:** unavailable');
    expect(body).not.toContain('Questo URL sta rispondendo 5xx adesso');
  });

  it('includes only URL-correlated origin/cache rows when hourly evidence is complete', () => {
    const url = reports.find((report) => report.surface === 'worker-shard')!.url;
    const shape = summarizeBursts([
      {
        status: 503,
        url,
        hour: '2026-08-06T06:00:00Z',
        count: 30,
        originResponseStatus: 503,
        cacheStatus: 'none',
      },
    ], RUN_AT).get(url);
    const body = buildIssueBody({ url, status: 503, count: 30, shape });
    expect(body).toContain('edge=503/origin=503/cache=none (30)');
    expect(body).toContain('Host/path classification: `worker-shard`');
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
    mockReport({ detail: REAL_TOTALS, detailByHour: REAL_BURSTS, detailByHourComplete: true });

    await cfSync.main();

    // Pre-fix this created exactly two issues: #5231 and #5232.
    expect(createCalls()).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: the same counts still file when the burst is current', async () => {
    mockReport({
      detail: REAL_TOTALS,
      detailByHourComplete: true,
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
      detailByHourComplete: true,
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
      detailByHourComplete: true,
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

describe('webhook tunnel offline (530) non conia nel sito', () => {
  // site#8839 / site#8840: il 530 dei due host webhook e' il tunnel senza
  // connettore (Mac in stop). Decisione del proprietario 2026-10-04: l'allarme
  // vive in bin/github-coordinator-health.mjs del workspace, non nel sito.
  // I NEGATIVE CONTROL pinnano che la regola resta UNA coppia (due host, 530).
  const GH_DEFAULT = 'gh-default.frontaliereticino.ch/github/webhook';
  const GH_NANAKO = 'gh-nanako.frontaliereticino.ch/github/webhook';
  const CURRENT_HOUR = '2026-08-06T06:00:00Z';

  /** Una riga `detail` + la sua riga oraria corrente, cosi' il gate di recency la tiene. */
  function liveReport(rows: Array<{ status: number; url: string; count: number }>) {
    mockReport({
      detail: rows,
      detailByHourComplete: true,
      detailByHour: rows.map((r) => ({ ...r, hour: CURRENT_HOUR })),
    });
  }
  function createdTitles(): string[] {
    return createCalls().map((c) => c[c.indexOf('--title') + 1]);
  }

  it('530 su gh-default con burst corrente: nessuna issue, e il log lo nomina', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    liveReport([{ status: 530, url: GH_DEFAULT, count: 5365 }]);

    await cfSync.main();

    expect(createCalls()).toHaveLength(0);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('cf-5xx webhook tunnel offline');
    expect(printed).toContain('tunnel_not_ready');
    expect(printed).toContain(`solo ${cfSync.TUNNEL_OFFLINE_STATUS} del tunnel webhook`);
    log.mockRestore();
  });

  it('NEGATIVE CONTROL: stesso URL con 502 conia ancora', async () => {
    liveReport([{ status: 502, url: GH_DEFAULT, count: 173 }]);

    await cfSync.main();

    expect(createdTitles()).toEqual([`CF 5xx: ${GH_DEFAULT}`]);
  });

  it('NEGATIVE CONTROL: 503 su gh-default e 502 su gh-nanako coniano, il 530 accanto no', async () => {
    liveReport([
      { status: 530, url: GH_NANAKO, count: 1487 },
      { status: 503, url: GH_DEFAULT, count: 121 },
      { status: 502, url: GH_NANAKO, count: 40 },
    ]);

    await cfSync.main();

    // Una issue per ciascuna riga non-530, nessuna per il 530 di gh-nanako.
    expect([...createdTitles()].sort()).toEqual([`CF 5xx: ${GH_DEFAULT}`, `CF 5xx: ${GH_NANAKO}`].sort());
    const statuses = createCalls().map((c) => c[c.indexOf('--body') + 1].split('\n')[0]);
    expect(statuses).not.toContain('**Status:** 530');
  });

  it('NEGATIVE CONTROL: un 530 su worker-shard o sul CDN conia (la regola non si allarga)', async () => {
    const shard = 'frontaliereticino.ch/en/jobs/';
    const cdn = 'cdn.frontaliereticino.ch/assets/app.js';
    liveReport([
      { status: 530, url: shard, count: 50 },
      { status: 530, url: cdn, count: 30 },
    ]);

    await cfSync.main();

    const titles = createdTitles();
    expect(titles).toContain(`CF 5xx: ${shard}`);
    expect(titles).toContain(`CF 5xx: ${cdn}`);
    expect(cfSync.isTunnelOffline530({ status: 530, url: shard })).toBe(false);
    expect(cfSync.isTunnelOffline530({ status: '530', url: GH_NANAKO })).toBe(true);
  });

  it('il body di un 502 webhook assegna la fix al workspace, non al sito', () => {
    const body = buildIssueBody({ url: GH_DEFAULT, status: 502, count: 173, shape: undefined });
    expect(body).toContain('**REPO**: workspace');
    expect(body).toContain('bin/github-webhook-receiver.mjs');
    expect(body).toContain('bin/github-coordinator-health.mjs');
    expect(body).not.toContain('**REPO**: sito');
  });

  it('recognizes the observed default-agenti hostname as a webhook tunnel for 530 handling', () => {
    expect(cfSync.isTunnelOffline530({
      status: 530,
      url: 'gh-default-agenti.frontaliereticino.ch/github/webhook',
    })).toBe(true);
  });

  it('il triage nomina l\'osservatore a cui e\' passato l\'allarme', () => {
    const triage = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'CF-5XX-TRIAGE.md'), 'utf8');
    expect(triage).toContain('tunnel_not_ready');
  });

  it('un 530 dell\'ora del run non tiene vivo un 502 finito ore prima sullo stesso URL', async () => {
    // Il cron gira alle 03:50 UTC, a Mac quasi sempre in stop: senza filtrare
    // le righe orarie del 530, `summarizeBursts` (per URL, status mescolati)
    // vedrebbe l'ultima ora nel 530 e ricommenterebbe il 502 del pomeriggio.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReport({
      detail: [
        { status: 502, url: GH_DEFAULT, count: 40 },
        { status: 530, url: GH_DEFAULT, count: 300 },
      ],
      detailByHourComplete: true,
      detailByHour: [
        { status: 502, url: GH_DEFAULT, hour: '2026-08-05T14:00:00Z', count: 40 },
        { status: 530, url: GH_DEFAULT, hour: CURRENT_HOUR, count: 300 },
      ],
    });

    await cfSync.main();

    expect(createCalls()).toHaveLength(0);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain(`skip ${GH_DEFAULT}`);
    log.mockRestore();
  });
});

describe('la fase «riconcilia» gira anche quando non c\'è niente da coniare', () => {
  it('nessun path sopra soglia → la riconciliazione gira comunque', async () => {
    // Prima: `return` secco su «nothing to sync». È proprio il giorno in cui
    // le issue guarite andrebbero chiuse, e nessuno le guardava.
    mockReport({ detail: [], detailByHour: [], detailByHourComplete: true });

    await cfSync.main();

    expect(createCalls()).toHaveLength(0);
    const listed = ghCalls().filter(
      (a) => a[0] === 'api' && a.some((x) => x.includes('issues?state=open&labels=cloudflare-5xx')),
    );
    expect(listed.length).toBeGreaterThan(0);
  });
});

describe('the gate cannot be disarmed silently', () => {
  it('asks cf-status-report for the hourly rows', async () => {
    mockReport({ detail: REAL_TOTALS, detailByHour: REAL_BURSTS, detailByHourComplete: true });

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
    const bodies = createCalls().map((c) => c[c.indexOf('--body') + 1]);
    expect(bodies.every((body) => body.includes('current failure is unverified'))).toBe(true);
    expect(bodies.every((body) => !body.includes('sta rispondendo 5xx adesso'))).toBe(true);
    warn.mockRestore();
  });

  it('does not suppress a stale-looking URL when hourly rows hit the result cap', async () => {
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReport({
      detail: [REAL_TOTALS[0]],
      detailByHour: REAL_BURSTS,
      detailByHourComplete: false,
    });

    await cfSync.main();

    expect(createCalls()).toHaveLength(1);
    const body = createCalls()[0][createCalls()[0].indexOf('--body') + 1];
    expect(body).toContain('current failure is unverified');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('row cap reached');
    warn.mockRestore();
  });
});
