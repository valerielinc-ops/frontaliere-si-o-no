// tests/scripts/lib/alerts/snoozer.test.ts
//
// Spec § 8.4 — auto-snooze logic. After 3 consecutive days the alert is
// snoozed for 7 days; existing snoozes are honored; tracked alerts that
// don't fire today reset their consecutive counter.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applySnoozer,
  loadSnoozes,
  saveSnoozes,
  updateSnoozeState,
} from '../../../../scripts/lib/alerts/snoozer.mjs';

const config = { snooze_after_consecutive_days: 3, snooze_duration_days: 7 };
const DAY = 24 * 3600 * 1000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

let tmpDir: string;
let snoozePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alerts-snoozer-'));
  snoozePath = join(tmpDir, 'alert-snoozes.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSnoozes / saveSnoozes', () => {
  it('returns default when file missing', () => {
    const state = loadSnoozes({ path: snoozePath });
    expect(state.snoozes).toEqual({});
  });

  it('round-trips through disk', () => {
    saveSnoozes({ version: 1, snoozes: { 'foo': { consecutiveDays: 1, lastSeen: '2026-05-08', snoozedUntil: null } } }, { path: snoozePath });
    const loaded = loadSnoozes({ path: snoozePath });
    expect(loaded.snoozes['foo'].consecutiveDays).toBe(1);
  });
});

describe('updateSnoozeState — 3-day rule', () => {
  it('snoozes on the 3rd consecutive day for 7 days', () => {
    const now = day('2026-05-08');
    let state: any = { version: 1, snoozes: {} };
    state = updateSnoozeState(state, [{ id: 'A.1', severity: 'P1' }], config, { now });
    expect(state.snoozes['A.1'].consecutiveDays).toBe(1);
    expect(state.snoozes['A.1'].snoozedUntil).toBeNull();

    state = updateSnoozeState(state, [{ id: 'A.1', severity: 'P1' }], config, { now: now + 1 * DAY });
    expect(state.snoozes['A.1'].consecutiveDays).toBe(2);
    expect(state.snoozes['A.1'].snoozedUntil).toBeNull();

    state = updateSnoozeState(state, [{ id: 'A.1', severity: 'P1' }], config, { now: now + 2 * DAY });
    expect(state.snoozes['A.1'].consecutiveDays).toBe(3);
    expect(state.snoozes['A.1'].snoozedUntil).toBe('2026-05-17');
  });

  it('resets counter when alert does not fire today', () => {
    const now = day('2026-05-08');
    let state: any = { version: 1, snoozes: {} };
    state = updateSnoozeState(state, [{ id: 'A.1', severity: 'P1' }], config, { now });
    state = updateSnoozeState(state, [{ id: 'A.1', severity: 'P1' }], config, { now: now + 1 * DAY });
    state = updateSnoozeState(state, [], config, { now: now + 2 * DAY });
    expect(state.snoozes['A.1']).toBeUndefined();
  });

  it('keeps existing snooze even if alert does not fire today', () => {
    const now = day('2026-05-08');
    const prev = {
      version: 1,
      snoozes: { 'A.1': { consecutiveDays: 0, lastSeen: '2026-05-05', snoozedUntil: '2026-05-12' } },
    };
    const next = updateSnoozeState(prev, [], config, { now });
    expect(next.snoozes['A.1'].snoozedUntil).toBe('2026-05-12');
  });
});

describe('applySnoozer', () => {
  it('routes snoozed alert to snoozedAlerts and active otherwise', () => {
    const now = day('2026-05-08');
    const snoozeState = { version: 1, snoozes: { 'A.1': { consecutiveDays: 3, lastSeen: '2026-05-07', snoozedUntil: '2026-05-12' } } };
    const alerts = [
      { id: 'A.1', severity: 'P1', message: 'snoozed alert', mitigation: '' },
      { id: 'A.2', severity: 'P0', message: 'active alert', mitigation: '' },
    ];
    const { activeAlerts, snoozedAlerts } = applySnoozer(alerts, snoozeState, { now });
    expect(activeAlerts.map((a: any) => a.id)).toEqual(['A.2']);
    expect(snoozedAlerts.map((a: any) => a.id)).toEqual(['A.1']);
    expect(snoozedAlerts[0]._snoozedUntil).toBe('2026-05-12');
  });

  it('does not snooze once snoozedUntil has passed', () => {
    const now = day('2026-05-15');
    const snoozeState = { version: 1, snoozes: { 'A.1': { consecutiveDays: 3, lastSeen: '2026-05-07', snoozedUntil: '2026-05-12' } } };
    const alerts = [{ id: 'A.1', severity: 'P1', message: 'still fires', mitigation: '' }];
    const { activeAlerts, snoozedAlerts } = applySnoozer(alerts, snoozeState, { now });
    expect(activeAlerts.map((a: any) => a.id)).toEqual(['A.1']);
    expect(snoozedAlerts).toEqual([]);
  });
});
