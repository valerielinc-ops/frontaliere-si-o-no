import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
 buildIssueBody,
 buildSnapshot,
 comparableSnapshot,
 detectStale,
 diagnose,
 evaluateClosedDay,
 evaluateIntraday,
 hourlyDeltas,
 localClock,
 monitorDecision,
 shiftDate,
 snapshotId,
} from '../scripts/lib/adsense-hourly.mjs';
import { LOOP_CLOCK_ENTRIES } from '../functions/src/loopClockTable.js';

const snap = (date: string, minuteOfDay: number, earnings: number, pageViews = 1000) => ({
 date,
 minuteOfDay,
 earnings,
 pageViews,
 capturedAt: `${date}T${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}:00.000Z`,
});
const day = (date: string, earnings: number, pageViews = 3000) => ({ date, earnings, pageViews });

describe('calendar helpers', () => {
 it('reads the account clock, not UTC', () => {
  expect(localClock(new Date('2026-10-31T23:30:00Z'))).toEqual({ date: '2026-11-01', hour: 0, minuteOfDay: 30 });
  expect(localClock(new Date('2026-07-01T22:30:00Z')).date).toBe('2026-07-02');
 });

 it('crosses month ends and keeps the id unique across the DST repeated hour', () => {
  expect(shiftDate('2026-11-03', -7)).toBe('2026-10-27');
  expect(snapshotId(new Date('2026-10-25T00:30:00Z'))).not.toBe(snapshotId(new Date('2026-10-25T01:30:00Z')));
 });

 it('stores zero, not undefined, before AdSense has a row for the day', () => {
  const snapshot = buildSnapshot({ capturedAt: new Date('2026-10-31T23:05:00Z'), today: undefined });
  expect(snapshot).toMatchObject({ date: '2026-11-01', earnings: 0, pageViews: 0, coverage: null });
 });
});

describe('hourlyDeltas', () => {
 it('derives hourly amounts and flags a downward revision instead of hiding it', () => {
  const rows = [snap('2026-10-31', 60, 1), snap('2026-10-31', 120, 3.5, 1500), snap('2026-10-31', 180, 3, 1600)];
  const deltas = hourlyDeltas(rows, '2026-10-31');
  expect(deltas.map((d) => d.earnings)).toEqual([1, 2.5, -0.5]);
  expect(deltas.map((d) => d.revised)).toEqual([false, false, true]);
  expect(deltas[1].spanMinutes).toBe(60);
 });
});

describe('comparableSnapshot', () => {
 it('picks the nearest run and refuses one outside the tolerance', () => {
  const rows = [snap('2026-10-24', 540, 3), snap('2026-10-24', 600, 4)];
  expect(comparableSnapshot(rows, '2026-10-24', 590, 45)?.earnings).toBe(4);
  expect(comparableSnapshot(rows, '2026-10-24', 700, 45)).toBeNull();
 });
});

describe('evaluateIntraday', () => {
 const baseline = [600, 660, 720].map((m) => snap('2026-10-24', m, 10));

 it('waits for a week of history', () => {
  const today = [600, 660, 720].map((m) => snap('2026-10-31', m, 1));
  expect(evaluateIntraday(today, '2026-10-31').status).toBe('pending');
 });

 it('needs every confirmation run under the threshold', () => {
  const single = [snap('2026-10-31', 600, 9), snap('2026-10-31', 660, 9), snap('2026-10-31', 720, 7)];
  expect(evaluateIntraday([...baseline, ...single], '2026-10-31').status).toBe('ok');
  const all = [600, 660, 720].map((m) => snap('2026-10-31', m, 7));
  expect(evaluateIntraday([...baseline, ...all], '2026-10-31')).toMatchObject({ status: 'alarm', key: 'intraday-2026-10-31', severe: true });
 });

 it('stays silent on a night total too small to mean anything', () => {
  const night = [60, 120, 180].map((m) => snap('2026-10-24', m, 1));
  const today = [60, 120, 180].map((m) => snap('2026-10-31', m, 0.1));
  expect(evaluateIntraday([...night, ...today], '2026-10-31').status).toBe('pending');
 });
});

describe('evaluateClosedDay', () => {
 it('compares yesterday with the same weekday a week earlier, exactly at -20%', () => {
  const rows = [day('2026-10-23', 10), day('2026-10-30', 8)];
  expect(evaluateClosedDay(rows, '2026-10-31', 12)).toMatchObject({ status: 'alarm', date: '2026-10-30', baselineDate: '2026-10-23', severe: false, consecutive: false });
  expect(evaluateClosedDay([day('2026-10-23', 10), day('2026-10-30', 8.5)], '2026-10-31', 12).status).toBe('ok');
 });

 it('waits for the morning settlement and for both days', () => {
  expect(evaluateClosedDay([day('2026-10-23', 10), day('2026-10-30', 1)], '2026-10-31', 11).status).toBe('pending');
  expect(evaluateClosedDay([day('2026-10-30', 1)], '2026-10-31', 12).status).toBe('pending');
 });

 it('marks the real 25-26/10 sequence as consecutive', () => {
  const rows = [day('2026-10-18', 19.45), day('2026-10-19', 30.08), day('2026-10-25', 14.64), day('2026-10-26', 23.09)];
  expect(evaluateClosedDay(rows, '2026-10-27', 12)).toMatchObject({ status: 'alarm', consecutive: true });
 });
});

describe('detectStale', () => {
 it('fires on a frozen daytime total only', () => {
  const frozen = [600, 660, 720, 780].map((m) => snap('2026-10-31', m, 5));
  expect(detectStale(frozen, '2026-10-31')).toBe(true);
  expect(detectStale(frozen.map((s, i) => ({ ...s, earnings: i })), '2026-10-31')).toBe(false);
  expect(detectStale([60, 120, 180, 240].map((m) => snap('2026-10-31', m, 5)), '2026-10-31')).toBe(false);
 });
});

describe('monitorDecision', () => {
 const ok = { status: 'ok' };
 const pending = { status: 'pending' };
 const alarm = { status: 'alarm', key: 'closed-2026-10-30', severe: false, consecutive: false, pageViewsChange: -0.3, rpmChange: 0 };

 it('notifies a day once, at medium priority unless deep or repeated', () => {
  expect(monitorDecision({ closed: alarm, intraday: pending, stale: null })).toMatchObject({ status: 'alarm', priority: 3 });
  expect(monitorDecision({ closed: { ...alarm, consecutive: true }, intraday: pending, stale: null }).priority).toBe(2);
  expect(monitorDecision({ closed: alarm, intraday: pending, stale: null, alreadyNotified: () => true }).status).toBe('notified');
 });

 it('recovers only on a measured healthy day', () => {
  expect(monitorDecision({ closed: ok, intraday: ok, stale: null }).status).toBe('recovered');
  expect(monitorDecision({ closed: pending, intraday: ok, stale: null }).status).toBe('pending');
 });

 it('tells traffic from monetization in the issue', () => {
  const decision = monitorDecision({
   closed: { ...alarm, kind: 'closed', date: '2026-10-30', baselineDate: '2026-10-23', earnings: 7, baselineEarnings: 10, change: -0.3 },
   intraday: pending,
   stale: null,
  });
  expect(diagnose(decision.alarms[0] as never)).toContain('traffico');
  expect(diagnose({ kind: 'closed', pageViewsChange: 0, rpmChange: -0.3 } as never)).toContain('monetizzazione');
  expect(buildIssueBody({ decision, runUrl: 'https://example.test/run' })).toContain('-30%');
 });
});

describe('adsense-hourly-monitor.yml', () => {
 const workflow = readFileSync(resolve(__dirname, '../.github/workflows/adsense-hourly-monitor.yml'), 'utf8');

 it('runs on the external clock, because the native cron is not hourly here', () => {
  const entry = LOOP_CLOCK_ENTRIES.find((e) => e.workflow === 'adsense-hourly-monitor.yml');
  expect(entry).toMatchObject({ id: 'site-adsense-hourly-monitor', repo: 'site', everyMinutes: 60 });
  expect(workflow).toContain('loop_clock:');
  expect(workflow).toContain('[loop-clock');
 });

 it('acknowledges an alarm only after the issue exists', () => {
  expect(workflow.indexOf('github-issue-creator.mjs')).toBeLessThan(workflow.indexOf('--ack='));
 });
});
