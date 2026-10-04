/**
 * The hourly deploy-skew alarm seen from real users (scripts/lib/deploy-skew-signal.mjs,
 * scripts/monitor-deploy-skew.mjs, .github/workflows/deploy-skew-monitor.yml).
 *
 * Pinned here:
 * - the detector on the real GA4 hours measured on 2026-10-03 (property
 *   524485296, `app_error` on frontaliereticino.ch, either skew signature, per
 *   dateHour Europe/Zurich): the 2026-09-25 incident fires on Italy +
 *   Switzerland, the 2026-10-01 bot wave fires only without the country filter;
 * - the request: country filter and BOTH signatures, so dropping either one
 *   (bots back in, or the "expected exports missing" shape lost) turns red;
 * - thresholds, recovery and the CLI contract (output shape, exit codes,
 *   GITHUB_OUTPUT only after a real measurement);
 * - the workflow: hourly, both halves of the issue lifecycle, no diagnosis flag.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';
import {
  DEFAULT_CONFIG,
  ISSUE_TITLE,
  SKEW_MESSAGE_FRAGMENT,
  SKEW_STACK_FRAGMENT,
  buildIssueBody,
  buildSkewRequests,
  evaluateSkew,
} from '../scripts/lib/deploy-skew-signal.mjs';
import { TARGET_MARKET_COUNTRIES } from '../scripts/lib/ga4-target-market.mjs';
import { shiftDateHour } from '../scripts/lib/revenue-signals.mjs';
import { runMonitor } from '../scripts/monitor-deploy-skew.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/deploy-skew-monitor.yml'), 'utf8');

type Hour = { dateHour: string; events: number; users: number };

// Italy + Switzerland, 2026-09-24 → 10-03: the incident hours and every hour
// above 5 events (51 hours had events, none other above 7 events / 4 users).
const IT_CH: Hour[] = [
  { dateHour: '2026092422', events: 7, users: 1 },
  { dateHour: '2026092507', events: 92, users: 22 },
  { dateHour: '2026092508', events: 82, users: 15 },
  { dateHour: '2026092917', events: 7, users: 1 },
  { dateHour: '2026093022', events: 7, users: 2 },
  { dateHour: '2026100117', events: 7, users: 3 },
  { dateHour: '2026100215', events: 7, users: 2 },
  { dateHour: '2026100221', events: 6, users: 4 },
];

// All countries, 2026-10-01 (a Singapore bot fleet: 2,966 events / 1,554 users in 10 days).
const ALL_COUNTRIES_1001: Hour[] = [
  { dateHour: '2026100108', events: 202, users: 106 },
  { dateHour: '2026100110', events: 277, users: 145 },
  { dateHour: '2026100111', events: 249, users: 128 },
  { dateHour: '2026100112', events: 477, users: 248 },
  { dateHour: '2026100113', events: 227, users: 118 },
  { dateHour: '2026100114', events: 158, users: 89 },
];

describe('evaluateSkew on the real GA4 hours', () => {
  it('fires on both hours of the 2026-09-25 incident (IT+CH)', () => {
    const r = evaluateSkew({ hours: IT_CH, currentHour: '2026092509' });
    expect(r.status).toBe('alarm');
    expect(r.alarmHours).toEqual(['2026092507', '2026092508']);
    expect(r.lastAlarmHour).toBe('2026092508');
  });

  it('stays silent on 2026-10-01 for Italy + Switzerland', () => {
    const r = evaluateSkew({ hours: IT_CH, currentHour: '2026100114' });
    expect(r.status).toBe('ok');
    expect(r.alarmHours).toEqual([]);
  });

  it('would fire on the same day without the country filter (the bots)', () => {
    const r = evaluateSkew({ hours: ALL_COUNTRIES_1001, currentHour: '2026100114' });
    expect(r.status).toBe('alarm');
    expect(r.alarmHours).toEqual(['2026100111', '2026100112', '2026100113']);
  });

  it('never fires on an IT+CH hour outside the incident, hour by hour over ten days', () => {
    for (let h = '2026092406'; h <= '2026100314'; h = shiftDateHour(h, 1)) {
      const r = evaluateSkew({ hours: IT_CH, currentHour: h });
      for (const a of r.alarmHours) expect(['2026092507', '2026092508']).toContain(a);
    }
  });

  it('judges only closed hours, most recent first, zero-filled', () => {
    const r = evaluateSkew({ hours: [{ dateHour: '2026100222', events: 500, users: 100 }, ...IT_CH], currentHour: '2026100222' });
    expect(r.status).toBe('ok');
    expect(r.checks).toEqual([
      { dateHour: '2026100221', events: 6, users: 4, status: 'ok' },
      { dateHour: '2026100220', events: 0, users: 0, status: 'ok' },
      { dateHour: '2026100219', events: 0, users: 0, status: 'ok' },
    ]);
  });
});

describe('thresholds', () => {
  const one = (events: number, users: number) => evaluateSkew({ hours: [{ dateHour: '2026100110', events, users }], currentHour: '2026100111' }).status;

  it('needs minEvents AND minUsers in the same hour', () => {
    expect(one(DEFAULT_CONFIG.minEvents - 1, DEFAULT_CONFIG.minUsers)).toBe('ok');
    expect(one(DEFAULT_CONFIG.minEvents, DEFAULT_CONFIG.minUsers - 1)).toBe('ok');
    expect(one(DEFAULT_CONFIG.minEvents, DEFAULT_CONFIG.minUsers)).toBe('alarm');
  });

  it('keeps the values the GA4 series was measured against', () => {
    expect(DEFAULT_CONFIG).toEqual({ lookbackHours: 3, minEvents: 20, minUsers: 5, recoveryHours: 6, historyHours: 30 });
  });
});

describe('recovery', () => {
  const spike: Hour[] = [{ dateHour: '2026100110', events: 40, users: 10 }];
  const at = (offset: number) => evaluateSkew({ hours: spike, currentHour: shiftDateHour('2026100110', offset) }).status;

  it('alarms through the look-back, then waits, then recovers after recoveryHours clean closed hours', () => {
    for (let k = 1; k <= DEFAULT_CONFIG.lookbackHours; k++) expect(at(k)).toBe('alarm');
    for (let k = DEFAULT_CONFIG.lookbackHours + 1; k <= DEFAULT_CONFIG.recoveryHours; k++) expect(at(k)).toBe('ok');
    expect(at(DEFAULT_CONFIG.recoveryHours + 1)).toBe('recovered');
    expect(at(DEFAULT_CONFIG.historyHours)).toBe('recovered');
    expect(at(DEFAULT_CONFIG.historyHours + 1)).toBe('ok');
  });

  it('is ok, not recovered, without a previous alarm', () => {
    expect(evaluateSkew({ hours: [], currentHour: '2026100110' }).status).toBe('ok');
  });
});

type Filter = { filter?: { fieldName: string; stringFilter?: { matchType: string; value: string; caseSensitive?: boolean }; inListFilter?: { values: string[] } }; orGroup?: { expressions: Filter[] }; andGroup?: { expressions: Filter[] } };

describe('buildSkewRequests', () => {
  const { errors, probe } = buildSkewRequests({ currentHour: '2026092509' });
  const expressions = (errors.dimensionFilter as { andGroup: { expressions: Filter[] } }).andGroup.expressions;
  const field = (name: string) => expressions.find((e) => e.filter?.fieldName === name)?.filter;

  it('reads app_error on the production host, Italy + Switzerland only', () => {
    expect(field('eventName')?.stringFilter).toEqual({ matchType: 'EXACT', value: 'app_error' });
    expect(field('hostName')?.stringFilter).toEqual({ matchType: 'EXACT', value: 'frontaliereticino.ch' });
    expect(field('country')?.inListFilter?.values).toEqual([...TARGET_MARKET_COUNTRIES]);
  });

  it('matches BOTH skew signatures, case-insensitively', () => {
    const or = expressions.find((e) => e.orGroup)?.orGroup?.expressions.map((e) => e.filter);
    expect(or).toEqual([
      { fieldName: 'customEvent:error_stack', stringFilter: { matchType: 'CONTAINS', value: SKEW_STACK_FRAGMENT, caseSensitive: false } },
      { fieldName: 'customEvent:error_message', stringFilter: { matchType: 'CONTAINS', value: SKEW_MESSAGE_FRAGMENT, caseSensitive: false } },
    ]);
    expect(SKEW_STACK_FRAGMENT).toBe('does not provide an export');
    expect(SKEW_MESSAGE_FRAGMENT).toBe('dynamically imported module');
  });

  it('covers the history window with events and users per hour', () => {
    expect(errors.dateRanges).toEqual([{ startDate: '2026-09-24', endDate: '2026-09-25' }]);
    expect(errors.dimensions).toEqual([{ name: 'dateHour' }]);
    expect(errors.metrics).toEqual([{ name: 'eventCount' }, { name: 'totalUsers' }]);
  });

  it('probes sessions on the same scope with no error filter', () => {
    expect(probe.metrics).toEqual([{ name: 'sessions' }]);
    const probeFields = (probe.dimensionFilter as { andGroup: { expressions: Filter[] } }).andGroup.expressions.map((e) => e.filter?.fieldName);
    expect(probeFields).toEqual(['hostName', 'country']);
  });

  it('drops only the country filter for --all-countries (diagnosis)', () => {
    const all = buildSkewRequests({ currentHour: '2026092509', allCountries: true });
    const fields = (all.errors.dimensionFilter as { andGroup: { expressions: Filter[] } }).andGroup.expressions.map((e) => e.filter?.fieldName ?? 'or');
    expect(fields).toEqual(['eventName', 'hostName', 'or']);
  });
});

describe('runMonitor (CLI contract)', () => {
  const row = (h: Hour) => ({ dimensionValues: [{ value: h.dateHour }], metricValues: [{ value: String(h.events) }, { value: String(h.users) }] });
  const sessionsFor = (currentHour: string) => Array.from({ length: DEFAULT_CONFIG.historyHours }, (_, i) => ({
    dimensionValues: [{ value: shiftDateHour(currentHour, -(i + 1)) }], metricValues: [{ value: '100' }],
  }));
  function ga4({ errors, sessions, errorRowCount }: { errors: Hour[]; sessions: unknown[]; errorRowCount?: number }) {
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const isProbe = body.metrics[0].name === 'sessions';
      const rows = isProbe ? sessions : errors.map(row);
      return { ok: true, json: async () => ({ rows, rowCount: isProbe ? rows.length : errorRowCount ?? rows.length }) };
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }
  const quietLog = () => {
    const errors: string[] = [];
    return { errors, log: { log: () => {}, error: (m: string) => errors.push(m) } };
  };
  const tmp = () => mkdtempSync(resolve(tmpdir(), 'deploy-skew-'));

  it('writes the exact JSON shape and status to GITHUB_OUTPUT on the 2026-09-25 replay', async () => {
    const dir = tmp();
    const { log } = quietLog();
    const { fetchImpl } = ga4({ errors: IT_CH, sessions: sessionsFor('2026092509') });
    const code = await runMonitor({ argv: ['--current-hour=2026092509', `--out=${dir}/out.json`, `--body-out=${dir}/body.md`], env: { GITHUB_OUTPUT: `${dir}/gh`, RUN_URL: 'https://example.test/run/1' }, fetchImpl, getToken: async () => 't', log });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(`${dir}/out.json`, 'utf8'));
    expect(Object.keys(out)).toEqual(['currentHour', 'status', 'alarmHours', 'lastAlarmHour', 'scope', 'config', 'checks', 'probe']);
    expect(out).toMatchObject({ currentHour: '2026092509', status: 'alarm', alarmHours: ['2026092507', '2026092508'], lastAlarmHour: '2026092508', scope: 'IT+CH', config: DEFAULT_CONFIG });
    expect(out.checks).toHaveLength(DEFAULT_CONFIG.lookbackHours);
    expect(out.checks[0]).toEqual({ dateHour: '2026092508', events: 82, users: 15, status: 'alarm' });
    expect(out.probe).toEqual({ hours: DEFAULT_CONFIG.historyHours, sessions: DEFAULT_CONFIG.historyHours * 100 });
    expect(readFileSync(`${dir}/gh`, 'utf8')).toBe('status=alarm\nalarm_hours=2026092507,2026092508\n');
    const body = readFileSync(`${dir}/body.md`, 'utf8');
    expect(body).toContain('node scripts/monitor-deploy-skew.mjs --current-hour=2026092509');
    expect(body).toContain('https://example.test/run/1');
  });

  it('reports ok with an empty alarmHours array when the errors report is empty and sessions exist', async () => {
    const dir = tmp();
    const { log } = quietLog();
    const { fetchImpl } = ga4({ errors: [], sessions: sessionsFor('2026100114') });
    expect(await runMonitor({ argv: ['--current-hour=2026100114', `--out=${dir}/out.json`, `--body-out=${dir}/body.md`], env: { GITHUB_OUTPUT: `${dir}/gh` }, fetchImpl, getToken: async () => 't', log })).toBe(0);
    const out = JSON.parse(readFileSync(`${dir}/out.json`, 'utf8'));
    expect(out.status).toBe('ok');
    expect(out.alarmHours).toEqual([]);
    expect(out.lastAlarmHour).toBeNull();
    expect(existsSync(`${dir}/body.md`)).toBe(false);
    expect(readFileSync(`${dir}/gh`, 'utf8')).toBe('status=ok\nalarm_hours=\n');
  });

  it('sends the country filter, and drops it only with --all-countries', async () => {
    const { log } = quietLog();
    const run = async (argv: string[]) => {
      const dir = tmp();
      const { fetchImpl, calls } = ga4({ errors: [], sessions: sessionsFor('2026100114') });
      await runMonitor({ argv: [...argv, `--out=${dir}/out.json`], env: {}, fetchImpl, getToken: async () => 't', log });
      return { calls, out: JSON.parse(readFileSync(`${dir}/out.json`, 'utf8')) };
    };
    const scoped = await run(['--current-hour=2026100114']);
    expect(JSON.stringify(scoped.calls)).toContain('"inListFilter":{"values":["Italy","Switzerland"]}');
    expect(scoped.out.scope).toBe('IT+CH');
    const all = await run(['--current-hour=2026100114', '--all-countries']);
    expect(JSON.stringify(all.calls)).not.toContain('"country"');
    expect(all.out.scope).toBe('all-countries');
  });

  it('fails with ::error:: and no status= on a truncated report', async () => {
    const dir = tmp();
    const { errors, log } = quietLog();
    const { fetchImpl } = ga4({ errors: IT_CH, sessions: sessionsFor('2026092509'), errorRowCount: 5000 });
    expect(await runMonitor({ argv: ['--current-hour=2026092509'], env: { GITHUB_OUTPUT: `${dir}/gh` }, fetchImpl, getToken: async () => 't', log })).toBe(1);
    expect(errors.join('\n')).toMatch(/::error::.*truncated/);
    expect(existsSync(`${dir}/gh`)).toBe(false);
  });

  it('fails with ::error:: and no status= when the sessions probe has no rows', async () => {
    const dir = tmp();
    const { errors, log } = quietLog();
    const { fetchImpl } = ga4({ errors: [], sessions: [] });
    expect(await runMonitor({ argv: ['--current-hour=2026100114'], env: { GITHUB_OUTPUT: `${dir}/gh` }, fetchImpl, getToken: async () => 't', log })).toBe(1);
    expect(errors.join('\n')).toMatch(/::error::.*no sessions/);
    expect(existsSync(`${dir}/gh`)).toBe(false);
  });

  it('fails without credentials', async () => {
    const { errors, log } = quietLog();
    const { fetchImpl, calls } = ga4({ errors: [], sessions: [] });
    expect(await runMonitor({ argv: [], env: {}, fetchImpl, getToken: async () => null, log })).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/::error::.*no GA4 credentials/);
  });

  it('rejects an hour that does not exist before calling GA4', async () => {
    const { errors, log } = quietLog();
    const { fetchImpl, calls } = ga4({ errors: [], sessions: [] });
    expect(await runMonitor({ argv: ['--current-hour=2026093214'], env: {}, fetchImpl, getToken: async () => 't', log })).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join('\n')).toContain('::error::');
  });
});

describe('issue body', () => {
  const body = buildIssueBody({ result: evaluateSkew({ hours: IT_CH, currentHour: '2026092509' }), runUrl: 'https://example.test/run/1' });

  it('carries the scheda with the replay command and the remediation paths', () => {
    expect(body).toContain('## Scheda');
    expect(body).toContain('**COMANDO**: `node scripts/monitor-deploy-skew.mjs --current-hour=2026092509`');
    expect(body).toMatch(/\*\*3-METRICA\.\*\* prima=92 eventi \/ 22 utenti .*atteso=/);
    expect(body).toContain('`scripts/ci/purge-changed-cdn-assets.mjs`');
    expect(body).toContain('`scripts/runtime-reliability-watch.mjs`');
    expect(body).toContain(`**5-FALLIMENTO.** "${ISSUE_TITLE}"`);
    expect(body).toContain('| 25-09 08h | 82 | 15 | alarm |');
  });

  it('names no workflow path (check-workflows-scope.mjs routes the fixer from the body)', () => {
    expect(body).not.toMatch(/\.github\/workflows\//);
    expect(body).not.toMatch(/\.ya?ml\b/);
  });

  it('uses a fixed title the dedup and the closers keep apart from workflow failures', () => {
    expect(ISSUE_TITLE.startsWith('Deploy skew IT+CH')).toBe(true);
    expect(ISSUE_TITLE).not.toMatch(/\d/);
    expect(TITLE_RE.test(ISSUE_TITLE)).toBe(false);
  });
});

describe('deploy-skew-monitor.yml', () => {
  const titles = [...workflow.matchAll(/--title "([^"]+)"/g)].map((m) => m[1]);

  it('runs hourly and on dispatch, carrying the alarm in the output, not in the exit code', () => {
    expect(workflow).toMatch(/schedule:\n\s+# [^\n]*\n(?:\s+#[^\n]*\n)*\s+- cron: '43 \* \* \* \*'/);
    expect(workflow).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+current_hour:/);
    expect(workflow).toContain('node scripts/monitor-deploy-skew.mjs "${args[@]}"');
    expect(workflow).toContain("if: steps.monitor.outputs.status == 'alarm'");
    expect(workflow).toContain("if: steps.monitor.outputs.status == 'recovered'");
  });

  it('opens and resolves the same fixed title', () => {
    expect(titles.filter((t) => t === ISSUE_TITLE)).toHaveLength(2);
    expect(workflow).toContain('--resolve');
    expect(workflow).toContain('--label deploy-skew-monitor');
  });

  it('reports a run that could not measure as a workflow failure, not as a skew alarm', () => {
    expect(titles).toContain('Workflow Failure: ${{ github.workflow }}');
    expect(workflow).toMatch(/- name: Report failure to GitHub Issues\n\s+if: failure\(\)/);
  });

  it('never runs the diagnosis mode that drops the country filter', () => {
    expect(workflow).not.toContain('--all-countries');
  });
});
