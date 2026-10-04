import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runL4,
  validateAlertReturn,
} from '../scripts/ci/loop-l4-alert-return.mjs';
import { updateSnoozeState } from '../scripts/lib/alerts/snoozer.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function config() {
  return {
    version: 1,
    monoculture_threshold: 0.4,
    quota_oscillation_threshold: 15,
    winrate_collapse_threshold: 0.2,
    engagement_dive_threshold: 0.4,
    snooze_after_consecutive_days: 3,
    snooze_duration_days: 7,
  };
}

function snoozes() {
  return {
    version: 1,
    snoozes: {
      'loop.example': {
        consecutiveDays: 3,
        lastSeen: '2026-09-08',
        snoozedUntil: '2026-09-15',
      },
    },
  };
}

function outcomes(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    eligibleConsentedUsers: 120,
    deliveredAlerts: 100,
    openedAlerts: 60,
    clickedAlerts: 30,
    returningUsers7d: 20,
    duplicateSends: 0,
    consentViolations: 0,
    export: {
      consentChecked: true,
      deduplicationChecked: true,
      quietHoursChecked: true,
      quietHoursEvidence: 'test sender schedule',
      externalDeliveryUntouched: true,
      unattributedDeliveries: 0,
    },
    ...overrides,
  };
}

function tempSource(outcomeValue: unknown = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l4-test-'));
  const configPath = path.join(dir, 'config.json');
  const snoozesPath = path.join(dir, 'snoozes.json');
  const outcomePath = path.join(dir, 'outcomes.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config())}\n`);
  fs.writeFileSync(snoozesPath, `${JSON.stringify(snoozes())}\n`);
  if (outcomeValue !== null) fs.writeFileSync(outcomePath, `${JSON.stringify(outcomeValue)}\n`);
  return { dir, configPath, snoozesPath, outcomePath };
}

describe('L4 Alert → Return', () => {
  it('accepts explicit consent/delivery/return evidence', () => {
    const verdict = validateAlertReturn({ config: config(), snoozes: snoozes(), outcomes: outcomes() }, { now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot.outcomes).toMatchObject({ eligibleConsentedUsers: 120, returningUsers7d: 20 });
  });

  it('keeps missing outcome data partial and metrics null', () => {
    const verdict = validateAlertReturn({ config: config(), snoozes: snoozes(), outcomes: null }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.outcomes.returningUsers7d).toBeNull();
  });

  it('rejects impossible delivery ordering and consent violations', () => {
    const verdict = validateAlertReturn({
      config: config(),
      snoozes: snoozes(),
      outcomes: outcomes({ openedAlerts: 101, consentViolations: 2 }),
    }, { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('openedAlerts exceeds');
    expect(verdict.issues.join(' ')).toContain('consentViolations');
  });

  it('keeps an incomplete exporter fail-closed', () => {
    const verdict = validateAlertReturn({
      config: config(),
      snoozes: snoozes(),
      outcomes: outcomes({
        export: {
          consentChecked: false,
          deduplicationChecked: false,
          quietHoursChecked: true,
          quietHoursEvidence: 'test sender schedule',
          externalDeliveryUntouched: true,
          unattributedDeliveries: 1,
        },
      }),
    }, { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('outcomes.export.deduplicationChecked');
    expect(verdict.issues.join(' ')).toContain('unattributedDeliveries');
  });

  it('marks stale outcomes and keeps a future timestamp from starting the window', async () => {
    const verdict = validateAlertReturn({ config: config(), snoozes: snoozes(), outcomes: outcomes({ generatedAt: '2026-09-01T12:00:00.000Z' }) }, { now: NOW });
    expect(verdict.quality).toBe('stale');
    const source = tempSource(outcomes({ generatedAt: '2026-09-12T18:00:00.000Z' }));
    const result = await runL4({
      now: NOW,
      configPath: source.configPath,
      snoozesPath: source.snoozesPath,
      outcomePath: source.outcomePath,
      logger: { log() {} },
    });
    expect(result.decision.startedAt).toBe(NOW.toISOString());
  });

  it('does not manufacture a zero return rate from an empty cohort', async () => {
    const source = tempSource(outcomes({ eligibleConsentedUsers: 0, deliveredAlerts: 0, openedAlerts: 0, clickedAlerts: 0, returningUsers7d: 0 }));
    const result = await runL4({
      now: NOW,
      configPath: source.configPath,
      snoozesPath: source.snoozesPath,
      outcomePath: source.outcomePath,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('zero');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('writes only reversible suppress/defer actions and persists a result after issue creation', async () => {
    const source = tempSource();
    const reportDir = path.join(source.dir, 'report');
    const issues: unknown[] = [];
    const result = await runL4({
      now: NOW,
      configPath: source.configPath,
      snoozesPath: source.snoozesPath,
      outcomePath: source.outcomePath,
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload) => { issues.push(payload); },
      logger: { log() {} },
    });
    expect(result.actionsWritten).toBe(true);
    expect(result.issued).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l4-safe-actions.json'), 'utf8')))
      .toMatchObject({ appliesToExternalDelivery: false, actions: [{ autonomy: 'A4', reversible: true }] });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l4-result.json'), 'utf8')))
      .toMatchObject({ ok: false, issued: true, actionsWritten: true });
    expect(issues).toHaveLength(1);
  });

  it('keeps missing config unmeasurable', async () => {
    const source = tempSource();
    const result = await runL4({
      now: NOW,
      configPath: path.join(source.dir, 'no-config.json'),
      snoozesPath: source.snoozesPath,
      outcomePath: source.outcomePath,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('unmeasurable');
    expect(result.observation.denominator).toBeNull();
  });

  it('does not write a result when issue creation fails', async () => {
    const source = tempSource();
    const reportDir = path.join(source.dir, 'report');
    await expect(runL4({
      now: NOW,
      configPath: source.configPath,
      snoozesPath: source.snoozesPath,
      outcomePath: source.outcomePath,
      reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue service unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l4-result.json'))).toBe(false);
  });
});

describe('L4 Alert to Return: snoozedUntil null dello snoozer rifiutato dal validatore', () => {
  // The writer is the real snoozer, not a fixture: an alert counted for fewer
  // days than the threshold is stored with `snoozedUntil: null` ("not snoozed"),
  // one that reached it gets a date. Both shapes must pass the validator.
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

  function snoozerState(daysFired: number) {
    let state = { version: 1, snoozes: {} as Record<string, unknown> };
    const alerts = [{ id: 'B.2.gsc-fetch-failure' }];
    for (let i = 0; i < daysFired; i += 1) {
      state = updateSnoozeState(state, alerts, config(), { now: day('2026-09-10') + i * 86_400_000 });
    }
    return state;
  }

  it('accepts the counted-but-not-snoozed rows the snoozer writes (snoozedUntil: null)', () => {
    const state = snoozerState(2);
    expect(state.snoozes['B.2.gsc-fetch-failure']).toMatchObject({ consecutiveDays: 2, snoozedUntil: null });
    const verdict = validateAlertReturn({ config: config(), snoozes: state, outcomes: outcomes() }, { now: NOW });
    expect(verdict.issues).toEqual([]);
    expect(verdict.candidates).toEqual([]);
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
  });

  it('accepts the snoozed rows the snoozer writes once the threshold is reached', () => {
    const state = snoozerState(config().snooze_after_consecutive_days);
    expect(state.snoozes['B.2.gsc-fetch-failure']).toMatchObject({ snoozedUntil: expect.any(String) });
    const verdict = validateAlertReturn({ config: config(), snoozes: state, outcomes: outcomes() }, { now: NOW });
    expect(verdict.issues).toEqual([]);
  });

  it('still rejects a missing, malformed or contradictory snoozedUntil', () => {
    const state = {
      version: 1,
      snoozes: {
        'a.missing': { consecutiveDays: 1, lastSeen: '2026-09-11' },
        'b.garbage': { consecutiveDays: 1, lastSeen: '2026-09-11', snoozedUntil: 'not-a-date' },
        'c.threshold': { consecutiveDays: config().snooze_after_consecutive_days, lastSeen: '2026-09-11', snoozedUntil: null },
      },
    };
    const verdict = validateAlertReturn({ config: config(), snoozes: state, outcomes: outcomes() }, { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.candidates.map((candidate: { key: string }) => candidate.key)).toEqual(['a.missing', 'b.garbage', 'c.threshold']);
    expect(verdict.issues.join('\n')).toContain('snoozes.a.missing: snoozedUntil is missing or invalid');
    expect(verdict.issues.join('\n')).toContain('snoozes.b.garbage: snoozedUntil is missing or invalid');
    expect(verdict.issues.join('\n')).toContain('snoozes.c.threshold: snoozedUntil is null although consecutiveDays reached the snooze threshold');
  });
});
