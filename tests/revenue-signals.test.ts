/**
 * The hourly ad-revenue alarm (scripts/lib/revenue-signals.mjs,
 * scripts/monitor-revenue-signals.mjs, .github/workflows/revenue-signal-monitor.yml).
 *
 * Pinned here:
 * - the detector on synthetic weeks (windows, persistence, low volume, baseline);
 * - two real GA4 cases (tests/fixtures/revenue-signals-ga4-hours.json, hourly
 *   Italy+Switzerland counts): the 2026-09-27 CMP suppression must fire on
 *   consent at the 14h run, the 2026-09-28 afternoon (GA4 lag on the last
 *   hours, reported by the owner as "slowing down") must not;
 * - the issue lifecycle: fixed title outside close-recovered-failure-issues,
 *   body in the bl-planner card shape, open/resolve gated on the run status.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';
import {
  DEFAULT_CONFIG,
  ISSUE_TITLE,
  buildIssueBody,
  dateHourInZone,
  evaluateRevenueSignals,
  monitorDecision,
  shiftDateHour,
  windowKeys,
} from '../scripts/lib/revenue-signals.mjs';
import { earliestHourNeeded, fetchHourlyCounts } from '../scripts/monitor-revenue-signals.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/revenue-signal-monitor.yml'), 'utf8');
const realHours = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tests/fixtures/revenue-signals-ga4-hours.json'), 'utf8'));

type Counts = Record<string, number>;

// Four identical weeks ending on 2026-09-28: busy days 08-21h, quiet nights.
function syntheticWeeks(): Record<string, Counts> {
  const hours: Record<string, Counts> = {};
  for (let k = shiftDateHour('2026092823', -24 * 28); k <= '2026092823'; k = shiftDateHour(k, 1)) {
    const h = Number(k.slice(8));
    const busy = h >= 8 && h <= 21;
    hours[k] = busy
      ? { sessions: 200, pageViews: 500, impressions: 700, revenue: 1.5, ad_filled: 400, ad_consent_granted: 60, ad_consent_denied: 6 }
      : { sessions: 20, pageViews: 40, impressions: 50, revenue: 0.1, ad_filled: 30, ad_consent_granted: 5, ad_consent_denied: 1 };
  }
  return hours;
}

function degrade(hours: Record<string, Counts>, from: string, to: string, patch: (c: Counts) => Counts) {
  for (let k = from; k <= to; k = shiftDateHour(k, 1)) hours[k] = patch({ ...hours[k] });
  return hours;
}

const statusOf = (r: ReturnType<typeof evaluateRevenueSignals>, signal: string) => r.checks.find((c) => c.signal === signal)?.status;

describe('dateHour arithmetic', () => {
  it('crosses midnight and months', () => {
    expect(shiftDateHour('2026093023', 1)).toBe('2026100100');
    expect(shiftDateHour('2026100100', -1)).toBe('2026093023');
    expect(shiftDateHour('2026092814', -168)).toBe('2026092114');
  });

  it('reads the current hour in the property time zone, summer and winter', () => {
    expect(dateHourInZone(new Date('2026-09-28T13:05:00Z'))).toBe('2026092815');
    expect(dateHourInZone(new Date('2026-12-01T23:30:00Z'))).toBe('2026120200');
  });

  it('windows end hours before the run and shift by whole weeks', () => {
    expect(windowKeys('2026092714', DEFAULT_CONFIG.eventsWindow)).toEqual(['2026092711', '2026092712']);
    expect(windowKeys('2026092714', DEFAULT_CONFIG.revenueWindow)).toEqual(['2026092708', '2026092709', '2026092710']);
    expect(windowKeys('2026092714', DEFAULT_CONFIG.eventsWindow, 1)).toEqual(['2026092011', '2026092012']);
  });

  it('fetches far enough back for three baseline weeks and the recovery look-back', () => {
    const earliest = earliestHourNeeded('2026092816');
    for (let back = 0; back < DEFAULT_CONFIG.recoveryRuns; back++) {
      const run = shiftDateHour('2026092816', -back);
      expect(windowKeys(run, DEFAULT_CONFIG.revenueWindow, 3)[0] >= earliest).toBe(true);
    }
  });
});

describe('evaluateRevenueSignals on synthetic weeks', () => {
  it('stays silent on an ordinary day', () => {
    const r = evaluateRevenueSignals({ hours: syntheticWeeks(), currentHour: '2026092816' });
    expect(r.alarms).toEqual([]);
    expect(r.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('fires consent in one run when CMP decisions collapse', () => {
    const hours = degrade(syntheticWeeks(), '2026092811', '2026092816', (c) => ({ ...c, ad_consent_granted: 1, ad_consent_denied: 0 }));
    const r = evaluateRevenueSignals({ hours, currentHour: '2026092814' });
    expect(r.alarms.map((a) => a.signal)).toEqual(['consent']);
    expect(r.alarms[0].ratio).toBeLessThan(0.1);
  });

  it('needs two runs below threshold before fill becomes an alarm', () => {
    const hours = degrade(syntheticWeeks(), '2026092812', '2026092812', (c) => ({ ...c, ad_filled: 20 }));
    // The window of the 14h run is 11-12h: one degraded hour.
    expect(statusOf(evaluateRevenueSignals({ hours, currentHour: '2026092814' }), 'fill')).toBe('ok');
    degrade(hours, '2026092811', '2026092813', (c) => ({ ...c, ad_filled: 20 }));
    expect(statusOf(evaluateRevenueSignals({ hours, currentHour: '2026092814' }), 'fill')).toBe('below_once');
    expect(statusOf(evaluateRevenueSignals({ hours, currentHour: '2026092815' }), 'fill')).toBe('alarm');
  });

  it('reads revenue only on settled hours', () => {
    // The last three hours carry no revenue yet (AdSense link lag): no alarm.
    const hours = degrade(syntheticWeeks(), '2026092813', '2026092815', (c) => ({ ...c, revenue: 0, impressions: 0 }));
    expect(statusOf(evaluateRevenueSignals({ hours, currentHour: '2026092816' }), 'revenue')).toBe('ok');
  });

  it('skips night volumes and missing baselines instead of guessing', () => {
    const hours = syntheticWeeks();
    expect(evaluateRevenueSignals({ hours, currentHour: '2026092805' }).checks.every((c) => c.status === 'low_volume')).toBe(true);
    for (const k of Object.keys(hours)) if (k < '2026092800') delete hours[k];
    expect(evaluateRevenueSignals({ hours, currentHour: '2026092816' }).checks.every((c) => c.status === 'no_baseline')).toBe(true);
  });
});

describe('real GA4 hours (Italy + Switzerland)', () => {
  it('fires consent at the 14h run of the 2026-09-27 CMP suppression (#9974)', () => {
    const r = evaluateRevenueSignals({ hours: realHours, currentHour: '2026092714' });
    expect(r.alarms.map((a) => a.signal)).toEqual(['consent']);
    expect(r.alarms[0].ratio).toBeCloseTo(0.22, 1);
  });

  it('does not fire on the 2026-09-28 afternoon the owner read as slowing down', () => {
    const r = evaluateRevenueSignals({ hours: realHours, currentHour: '2026092816' });
    expect(r.alarms).toEqual([]);
    expect(r.checks.every((c) => c.status === 'ok')).toBe(true);
  });
});

describe('monitorDecision', () => {
  const collapsed = () => degrade(syntheticWeeks(), '2026092711', '2026092716', (c) => ({ ...c, ad_consent_granted: 0, ad_consent_denied: 0 }));

  it('alarms, then watches for a day, then recovers', () => {
    const hours = collapsed();
    expect(monitorDecision({ hours, currentHour: '2026092714' }).status).toBe('alarm');
    const watching = monitorDecision({ hours, currentHour: '2026092808' });
    expect(watching.status).toBe('watching');
    expect(watching.lastAlarmHour).toBe('2026092718');
    expect(monitorDecision({ hours, currentHour: '2026092819' }).status).toBe('recovered');
  });

  it('is quiet when nothing could be measured', () => {
    const hours = syntheticWeeks();
    for (const k of Object.keys(hours)) if (k < '2026092700') delete hours[k];
    expect(monitorDecision({ hours, currentHour: '2026092816' }).status).toBe('quiet');
  });
});

describe('issue lifecycle', () => {
  it('uses a fixed title the dedup and the recovery closer can hold', () => {
    expect(ISSUE_TITLE.length).toBeLessThanOrEqual(60);
    expect(ISSUE_TITLE).not.toMatch(/\d/);
    // Not a `Workflow Failure:` title: a green run must not close a revenue alarm.
    expect(TITLE_RE.test(ISSUE_TITLE)).toBe(false);
  });

  it('writes the bl-planner card, the replay command and real code paths', () => {
    const hours = collapsed();
    const body = buildIssueBody({ decision: monitorDecision({ hours, currentHour: '2026092714' }), runUrl: 'https://example.test/run/1' });
    for (const field of ['SCHEDA:', '1-CAUSA:', '2-FIX:', '3-METRICA:', '4-OSSERVATORE:', '5-FALLIMENTO:']) expect(body).toContain(field);
    expect(body).toContain('ipotesi da verificare, non accertata');
    expect(body).toContain('node scripts/monitor-revenue-signals.mjs --current-hour=2026092714');
    expect(body).toContain('node scripts/probe-live-consent-message.mjs');
    expect(body).toContain('## Suggested action');
    expect(body).toContain('`build-plugins/constants.ts`');
    // check-workflows-scope.mjs routes the fixer from the body: no workflow path in it.
    expect(body).not.toMatch(/\.github\/workflows\//);
    expect(body).toContain(`5-FALLIMENTO: "${ISSUE_TITLE}"`);
  });
});

describe('fetchHourlyCounts', () => {
  const report = (rows: unknown[], rowCount = rows.length) => ({ ok: true, json: async () => ({ rows, rowCount }) });

  it('merges the metrics and the ad events per hour', async () => {
    const calls: string[] = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push(body.dateRanges[0].startDate);
      return body.dimensions.length === 1
        ? report([{ dimensionValues: [{ value: '2026092814' }], metricValues: [{ value: '10' }, { value: '25' }, { value: '30' }, { value: '0.05' }] }])
        : report([{ dimensionValues: [{ value: '2026092814' }, { value: 'ad_filled' }], metricValues: [{ value: '20' }] }]);
    };
    const hours = await fetchHourlyCounts({ token: 't', currentHour: '2026092816', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(hours['2026092814']).toEqual({ sessions: 10, pageViews: 25, impressions: 30, revenue: 0.05, ad_filled: 20 });
    expect(calls).toEqual(['2026-09-06', '2026-09-06']);
  });

  it('refuses a truncated report instead of measuring on partial data', async () => {
    const fetchImpl = async () => report([], 12_000);
    await expect(fetchHourlyCounts({ token: 't', currentHour: '2026092816', fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/truncated/);
  });
});

describe('revenue-signal-monitor.yml', () => {
  const titles = [...workflow.matchAll(/--title "([^"]+)"/g)].map((m) => m[1]);

  it('runs hourly and carries the alarm in the output, not in the exit code', () => {
    expect(workflow).toMatch(/cron: '41 \* \* \* \*'/);
    expect(workflow).toContain('node scripts/monitor-revenue-signals.mjs "${args[@]}"');
    expect(workflow).toContain("if: steps.monitor.outputs.status == 'alarm'");
    expect(workflow).toContain("if: steps.monitor.outputs.status == 'recovered'");
    expect(workflow).not.toMatch(/steps\.monitor\.outcome/);
  });

  it('opens and resolves the same fixed title, with the revenue routing label', () => {
    expect(titles.filter((t) => t === ISSUE_TITLE)).toHaveLength(2);
    expect(workflow).toContain('--resolve');
    expect(workflow).toContain('--label revenue');
    expect(workflow).not.toContain('agent:fix');
  });

  it('reports a run that could not measure as a workflow failure, not as a revenue alarm', () => {
    expect(titles).toContain('Workflow Failure: ${{ github.workflow }}');
    expect(workflow).toMatch(/- name: Report failure to GitHub Issues\n\s+if: failure\(\)/);
  });
});
