import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runL4,
  validateAlertReturn,
} from '../scripts/ci/loop-l4-alert-return.mjs';

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
