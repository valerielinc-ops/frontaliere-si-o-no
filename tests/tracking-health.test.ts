/**
 * Tracking-health watchdog (scripts/lib/tracking-health.mjs,
 * scripts/monitor-tracking-health.mjs, .github/workflows/tracking-health-monitor.yml).
 *
 * Pinned: GA4 down >40% with stable Cloudflare alarms within one run; GA4 lag is
 * pending, never a zero; a really missing GA4 hour (later hour present) is a
 * zero; falling Cloudflare traffic is not a tracking verdict; the issue
 * lifecycle and that the public output carries no measurements.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { shiftDateHour } from '../scripts/lib/revenue-signals.mjs';
import {
  ISSUE_TITLE,
  buildIssueBody,
  cfHourToDateHour,
  cfRowsToHours,
  earliestHourNeeded,
  evaluateTracking,
  trackingDecision,
} from '../scripts/lib/tracking-health.mjs';
import { fetchCfHours, runMonitor } from '../scripts/monitor-tracking-health.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/tracking-health-monitor.yml'), 'utf8');

const CURRENT = '2026101514'; // run hour; target = 12h
type Ga4 = Record<string, { sessions: number; events: number }>;

function days(): { ga4Hours: Ga4; cfHours: Record<string, number> } {
  const ga4Hours: Ga4 = {};
  const cfHours: Record<string, number> = {};
  for (let k = shiftDateHour(CURRENT, -24 * 4); k <= CURRENT; k = shiftDateHour(k, 1)) {
    ga4Hours[k] = { sessions: 200, events: 1500 };
    cfHours[k] = 900;
  }
  return { ga4Hours, cfHours };
}

describe('tracking decision', () => {
  it('stays ok on steady traffic', () => {
    const d = trackingDecision({ ...days(), currentHour: CURRENT });
    expect(d.status).toBe('recovered');
    expect(d.evaluation.alarms).toEqual([]);
  });

  it('alarms when GA4 falls >40% and Cloudflare is stable', () => {
    const t = days();
    t.ga4Hours['2026101512'] = { sessions: 100, events: 1500 };
    const d = trackingDecision({ ...t, currentHour: CURRENT });
    expect(d.status).toBe('alarm');
    expect(d.evaluation.alarms.map((a) => a.signal)).toEqual(['sessions']);
  });

  it('does not alarm on a 30% drop (under the 40% bar)', () => {
    const t = days();
    t.ga4Hours['2026101512'] = { sessions: 140, events: 1050 };
    expect(trackingDecision({ ...t, currentHour: CURRENT }).evaluation.alarms).toEqual([]);
  });

  it('does not alarm when Cloudflare traffic fell too (real traffic loss)', () => {
    const t = days();
    t.ga4Hours['2026101512'] = { sessions: 60, events: 400 };
    t.cfHours['2026101512'] = 300;
    expect(trackingDecision({ ...t, currentHour: CURRENT }).evaluation.alarms).toEqual([]);
  });

  it('treats GA4 lag as pending, not zero', () => {
    const t = days();
    for (const k of ['2026101512', '2026101513', '2026101514']) delete t.ga4Hours[k];
    const d = trackingDecision({ ...t, currentHour: CURRENT });
    expect(d.status).toBe('pending');
    expect(d.evaluation.checks.every((c) => c.status === 'pending')).toBe(true);
  });

  it('treats a missing target hour as zero once GA4 has returned a later hour', () => {
    const t = days();
    delete t.ga4Hours['2026101512'];
    const d = trackingDecision({ ...t, currentHour: CURRENT });
    expect(d.status).toBe('alarm');
    expect(d.evaluation.alarms).toHaveLength(2);
  });

  it('is pending when Cloudflare has no row for the target hour', () => {
    const t = days();
    t.ga4Hours['2026101512'] = { sessions: 10, events: 50 };
    delete t.cfHours['2026101512'];
    expect(evaluateTracking({ ...t, currentHour: CURRENT }).checks[0]).toMatchObject({ status: 'pending', reason: 'cloudflare_incomplete' });
  });

  it('skips night-volume slots and missing baselines', () => {
    const t = days();
    for (const k of Object.keys(t.ga4Hours)) t.ga4Hours[k] = { sessions: 5, events: 20 };
    expect(evaluateTracking({ ...t, currentHour: CURRENT }).checks[0].status).toBe('low_volume');
    const nb = days();
    for (const k of Object.keys(nb.cfHours)) if (k < '2026101500') delete nb.cfHours[k];
    expect(evaluateTracking({ ...nb, currentHour: CURRENT }).checks[0].status).toBe('no_baseline');
  });

  it('keeps watching after an alarm, then recovers once the target hours are clean', () => {
    const t = days();
    t.ga4Hours['2026101512'] = { sessions: 50, events: 300 };
    // the run at 15h judges 13h but the 12h alarm is still inside the recovery window
    for (let k = '2026101515'; k <= '2026101519'; k = shiftDateHour(k, 1)) {
      t.ga4Hours[k] = { sessions: 200, events: 1500 };
      t.cfHours[k] = 900;
    }
    expect(trackingDecision({ ...t, currentHour: '2026101515' }).status).toBe('watching');
    expect(trackingDecision({ ...t, currentHour: '2026101519' }).status).toBe('recovered');
  });

  it('detects at the first hourly run whose target is the broken hour', () => {
    const t = days();
    t.ga4Hours['2026101512'] = { sessions: 20, events: 100 };
    expect(trackingDecision({ ...t, currentHour: '2026101514' }).status).toBe('alarm');
  });

  it('reads back far enough for the widest baseline', () => {
    expect(earliestHourNeeded('2026101514') <= shiftDateHour('2026101514', -2 - 2 - 48)).toBe(true);
  });
});

describe('cloudflare hour mapping', () => {
  it('maps UTC hours to Zurich dateHour, DST included', () => {
    expect(cfHourToDateHour('2026-10-15T10:00:00Z')).toBe('2026101512');
    expect(cfHourToDateHour('2026-12-15T10:00:00Z')).toBe('2026121511');
    expect(cfHourToDateHour('garbage')).toBeNull();
    expect(cfRowsToHours([{ hour: '2026-10-15T10:00:00Z', count: 4 }, { hour: 'x', count: 1 }])).toEqual({ '2026101512': 4 });
  });
});

describe('issue body and workflow', () => {
  it('uses the card shape and withholds measurements', () => {
    const t = days();
    t.ga4Hours['2026101512'] = { sessions: 1, events: 1 };
    const decision = trackingDecision({ ...t, currentHour: CURRENT });
    const body = buildIssueBody({ decision, runUrl: 'https://example.test/run/1' });
    expect(body).toContain('SCHEDA: tracking-health-monitor');
    expect(body).toContain(`5-FALLIMENTO: "${ISSUE_TITLE}"`);
    expect(body).not.toMatch(/2026101512/);
  });

  it('keeps the same fixed title in open and resolve steps, gated on status', () => {
    expect(workflow.split(ISSUE_TITLE)).toHaveLength(3);
    expect(workflow).toContain("steps.monitor.outputs.status == 'alarm'");
    expect(workflow).toContain("steps.monitor.outputs.status == 'recovered'");
    expect(workflow).toContain('--priority 1');
    expect(workflow).toContain('--label tracking-health-monitor');
    expect(workflow).toContain('Workflow Failure: ${{ github.workflow }}');
  });
});

describe('runMonitor', () => {
  const now = new Date('2026-10-15T12:20:00Z'); // 14:20 Zurich (CEST)

  function fetchStub(sessions: number) {
    return vi.fn(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes('/zones?name=')) return Response.json({ success: true, result: [{ id: 'z' }] });
      if (u.includes('graphql')) {
        const until = Date.parse(JSON.parse(init!.body!).variables.filter.datetime_leq);
        const rows = [];
        for (let h = 0; h < 23; h++) {
          const t = new Date(Math.floor(until / 3_600_000) * 3_600_000 - (h + 1) * 3_600_000).toISOString();
          rows.push({ count: 900, dimensions: { datetimeHour: t } });
        }
        return Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: rows }] } } });
      }
      const rows = [];
      for (let k = shiftDateHour('2026101514', -24 * 4); k <= '2026101514'; k = shiftDateHour(k, 1)) {
        const drop = k === '2026101512';
        rows.push({ dimensionValues: [{ value: k }], metricValues: [{ value: String(drop ? sessions : 200) }, { value: String(drop ? sessions * 7 : 1500) }] });
      }
      return Response.json({ rows, rowCount: rows.length });
    });
  }

  it('writes status for an alarm, a body, and never prints measurements', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trk-'));
    const out = join(dir, 'out.json');
    const bodyOut = join(dir, 'body.md');
    const gh = join(dir, 'gh-output');
    writeFileSync(gh, '');
    const log = { log: vi.fn(), error: vi.fn() };
    const code = await runMonitor({
      argv: [`--out=${out}`, `--body-out=${bodyOut}`],
      env: { CF_API_TOKEN: 't', GITHUB_OUTPUT: gh, RUN_URL: 'https://example.test/r' },
      now,
      fetchImpl: fetchStub(40) as unknown as typeof fetch,
      getToken: async () => 'ga4',
      log,
    });
    expect(code).toBe(0);
    expect(readFileSync(gh, 'utf8')).toContain('status=alarm');
    expect(readFileSync(bodyOut, 'utf8')).toContain('SCHEDA: tracking-health-monitor');
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/ratio|sessions/i);
  });

  it('fails (exit 1, no status output) when it cannot measure', async () => {
    const gh = join(mkdtempSync(join(tmpdir(), 'trk-')), 'gh-output');
    writeFileSync(gh, '');
    const code = await runMonitor({
      env: { CF_API_TOKEN: 't', GITHUB_OUTPUT: gh },
      now,
      fetchImpl: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch,
      getToken: async () => 'ga4',
      log: { log: vi.fn(), error: vi.fn() },
    });
    expect(code).toBe(1);
    expect(readFileSync(gh, 'utf8')).toBe('');
  });

  it('rejects an empty Cloudflare report instead of reading it as zero traffic', async () => {
    const f = vi.fn(async () => Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } }));
    await expect(fetchCfHours({ token: 't', zoneId: 'z', now, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/no hourly rows/);
  });
});
