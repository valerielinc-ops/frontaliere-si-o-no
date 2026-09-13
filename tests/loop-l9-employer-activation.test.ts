import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runL9,
  validateEmployerActivation,
  validateEmployerProfiles,
} from '../scripts/ci/loop-l9-employer-activation.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function profile(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'azienda-demo',
    name: 'Azienda Demo AG',
    companyKey: 'azienda-demo',
    sector: 'Industria',
    activeJobs: 12,
    cantons: [{ name: 'TI', count: 8 }, { name: 'ZH', count: 2 }],
    cities: [{ name: 'Lugano', count: 5 }, { name: 'Bellinzona', count: 2 }],
    salaryMedianChf: 72000,
    salarySamples: 10,
    trend: { added: 4, removed: 1, net: 3, windowDays: 28 },
    ...overrides,
  };
}

function profiles(...entries: Record<string, unknown>[]) {
  const list = entries.length ? entries : [profile()];
  return {
    _meta: {
      schemaVersion: 1,
      generatedAt: '2026-09-12T11:00:00.000Z',
      floor: 5,
      bridgeFloor: 2,
      trendWindowDays: 28,
      sourceJobs: 20,
      aboveFloorCount: list.length,
      belowFloorCount: 2,
    },
    profiles: list,
  };
}

function outcomes(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-09-12T11:30:00.000Z',
    inventoryScope: {
      cohortKey: 'employer-profiles-v1',
      profileSource: 'data/employer-profiles.json',
      profileCount: 1,
      profileGeneratedAt: '2026-09-12T11:00:00.000Z',
    },
    eligibleEmployerAccounts: 100,
    profileViewAccounts: 80,
    leadAccounts: 40,
    checkoutStartAccounts: 20,
    paidActivations: 10,
    activeSubscriptions: 8,
    attachedJobs: 15,
    renewals: 2,
    freeProfiles: 0,
    sponsoredProfiles: 1,
    mrrRecognizedChf: 1200,
    export: {
      accountIdentity: 'publisherUid',
      inventoryUntouched: true,
      subscriptionStateUntouched: true,
      pricesUntouched: true,
      outreachSent: false,
    },
    ...overrides,
  };
}

function writeJson(dir: string, name: string, value: unknown) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

describe('L9 Employer Supply → Paid Activation', () => {
  it('accepts coherent inventory and independent funnel outcomes', () => {
    const verdict = validateEmployerActivation({ profiles: profiles(), outcomes: outcomes() }, { now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot).toMatchObject({
      profiles: { profileCount: 1, validProfileCount: 1 },
      outcomes: { eligibleEmployerAccounts: 100, paidActivations: 10, mrrRecognizedChf: 1200 },
    });
  });

  it('treats inventory as supply evidence and does not infer paid activation', () => {
    const verdict = validateEmployerActivation({ profiles: profiles(), outcomes: null }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'unmeasurable' });
    expect(verdict.snapshot.outcomes).toMatchObject({ eligibleEmployerAccounts: null, paidActivations: null });
    expect(verdict.candidates.some((candidate) => candidate.action.includes('draft-outreach'))).toBe(true);
  });

  it('does not exempt a present but malformed outcome ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l9-test-'));
    const profilesPath = writeJson(dir, 'profiles.json', profiles());
    const outcomePath = writeJson(dir, 'outcomes.json', null);
    const result = await runL9({
      now: NOW,
      profilesPath,
      outcomePath,
      reportDir: path.join(dir, 'report'),
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('partial');
    expect(result.verdict.snapshot.outcomes).toMatchObject({ missing: false });
    expect(result.verdict.issues).toContain('employer funnel outcome ledger is present but malformed');
    expect(result.verdict.snapshot.profiles.validProfileCount).toBe(1);
  });

  it('rejects a profile whose location distribution exceeds its active inventory', () => {
    const verdict = validateEmployerProfiles(profiles(profile({
      cantons: [{ name: 'TI', count: 13 }],
    })), { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot).toMatchObject({ validProfileCount: 0, invalidProfileCount: 1 });
    expect(verdict.issues.join(' ')).toContain('exceeds activeJobs');
  });

  it('rejects funnel cardinality that grows between stages', () => {
    const verdict = validateEmployerActivation({
      profiles: profiles(),
      outcomes: outcomes({ checkoutStartAccounts: 41 }),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.observation).toBeUndefined();
    expect(verdict.issues.join(' ')).toContain('outcomes.checkoutStartAccounts exceeds outcomes.leadAccounts');
  });

  it('rejects a paid ledger without an attested profile scope', () => {
    const { inventoryScope: _ignored, ...withoutScope } = outcomes();
    const verdict = validateEmployerActivation({ profiles: profiles(), outcomes: withoutScope }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.issues.join(' ')).toContain('inventoryScope is missing');
  });

  it('rejects a ledger that claims an unsafe external mutation', () => {
    const verdict = validateEmployerActivation({
      profiles: profiles(),
      outcomes: outcomes({ export: { ...outcomes().export, pricesUntouched: false } }),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.issues.join(' ')).toContain('outcomes.export.pricesUntouched');
  });

  it('rejects a stale cross-source join and conflicting metric copies', () => {
    const verdict = validateEmployerActivation({
      profiles: profiles(),
      outcomes: outcomes({
        generatedAt: '2026-09-10T11:30:00.000Z',
        metrics: { paidActivations: 11 },
      }),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.issues.join(' ')).toContain('profile/outcome snapshots are');
    expect(verdict.issues.join(' ')).toContain('conflicting duplicate representations');
  });

  it('keeps stale employer evidence out of the paid metric', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l9-test-'));
    const profilesPath = writeJson(dir, 'profiles.json', profiles({
      ...profile(),
      // Profile facts are valid; only the source timestamp is stale.
    }));
    const outcomePath = writeJson(dir, 'outcomes.json', outcomes({ generatedAt: '2026-08-01T12:00:00.000Z' }));
    const result = await runL9({
      now: NOW,
      profilesPath,
      outcomePath,
      reportDir: path.join(dir, 'report'),
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('stale');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('writes draft-only actions and the result after a finding issue is created', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l9-test-'));
    const profilesPath = writeJson(dir, 'profiles.json', profiles());
    const reportDir = path.join(dir, 'report');
    const issues: unknown[] = [];
    const result = await runL9({
      now: NOW,
      profilesPath,
      outcomePath: path.join(dir, 'missing-outcomes.json'),
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload) => { issues.push(payload); },
      logger: { log() {} },
    });
    expect(result).toMatchObject({ issued: true, actionsWritten: true });
    expect(issues).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l9-actions.json'), 'utf8')))
      .toMatchObject({ realOutreachSent: false, inventoryUntouched: true, pricesUntouched: true });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l9-result.json'), 'utf8')))
      .toMatchObject({ ok: false, issued: true, actionsWritten: true, outcomeLedgerMissing: true, profileInventoryComplete: true });
  });

  it('does not persist a result when issue creation fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l9-test-'));
    const profilesPath = writeJson(dir, 'profiles.json', profiles());
    const reportDir = path.join(dir, 'report');
    await expect(runL9({
      now: NOW,
      profilesPath,
      outcomePath: path.join(dir, 'missing-outcomes.json'),
      reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue service unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l9-result.json'))).toBe(false);
  });
});
