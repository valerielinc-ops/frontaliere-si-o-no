import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  l9FindingKind,
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
    independent: true,
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

  it('does not promote a well-shaped ledger without an explicit independent attestation', () => {
    const { independent: _ignored, ...withoutAttestation } = outcomes();
    const verdict = validateEmployerActivation({ profiles: profiles(), outcomes: withoutAttestation }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'partial' });
    expect(verdict.snapshot.outcomes).toMatchObject({ independent: false });
    expect(verdict.issues.join(' ')).toContain('outcomes.independent must be explicitly true');
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

  it('rejects a join on a different profile cohort and conflicting metric copies', () => {
    const verdict = validateEmployerActivation({
      profiles: profiles(),
      outcomes: outcomes({
        inventoryScope: { ...outcomes().inventoryScope, profileGeneratedAt: '2026-09-08T04:40:00.000Z' },
        metrics: { paidActivations: 11 },
      }),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.issues.join(' ')).toContain('does not match the profile snapshot');
    expect(verdict.issues.join(' ')).toContain('conflicting duplicate representations');
  });

  // I profili si rigenerano lunedi' e giovedi' (refresh-employer-profiles.yml),
  // il ledger si esporta a ogni run: fra i due orologi ci sono fino a 96 h con
  // un sistema sano. La coerenza fra i due lati e' l'uguaglianza esatta della
  // coorte (inventoryScope.profileGeneratedAt), la freschezza e' per lato.
  describe('cross-source coherence is the exact cohort, not a clock skew', () => {
    // Run push del sabato: profili di giovedi' 11:00Z, ledger esportato 51,5 h dopo.
    const PROFILES_AT = '2026-09-12T11:00:00.000Z';
    const LEDGER_AT = '2026-09-14T14:30:00.000Z';
    const LATE_NOW = new Date('2026-09-14T14:35:00.000Z');

    function profilesAt(generatedAt: string) {
      const base = profiles();
      return { ...base, _meta: { ...base._meta, generatedAt } };
    }

    it('accepts profiles 51.5h older than the ledger when the ledger attests that exact cohort', () => {
      const verdict = validateEmployerActivation({
        profiles: profilesAt(PROFILES_AT),
        outcomes: outcomes({ generatedAt: LEDGER_AT }),
      }, { now: LATE_NOW });
      expect(verdict.issues.join(' ')).not.toMatch(/apart/);
      expect(verdict).toMatchObject({ ok: true, quality: 'observed', issues: [] });
      expect(verdict.snapshot.crossSourceSkewHours).toBe(51.5);
    });

    it('still rejects the same clocks when the ledger attests a different profile cohort', () => {
      const verdict = validateEmployerActivation({
        profiles: profilesAt(PROFILES_AT),
        outcomes: outcomes({
          generatedAt: LEDGER_AT,
          inventoryScope: { ...outcomes().inventoryScope, profileGeneratedAt: '2026-09-08T04:40:00.000Z' },
        }),
      }, { now: LATE_NOW });
      expect(verdict).toMatchObject({ ok: false, quality: 'partial' });
      expect(verdict.issues).toContain('outcomes.inventoryScope.profileGeneratedAt does not match the profile snapshot');
      expect(verdict.snapshot.crossSourceSkewHours).toBe(51.5);
    });

    it('still rejects profiles older than maxAgeHours on their own side', () => {
      const staleAt = '2026-09-03T11:00:00.000Z';
      const verdict = validateEmployerActivation({
        profiles: profilesAt(staleAt),
        outcomes: outcomes({
          generatedAt: LEDGER_AT,
          inventoryScope: { ...outcomes().inventoryScope, profileGeneratedAt: staleAt },
        }),
      }, { now: LATE_NOW });
      expect(verdict).toMatchObject({ ok: false, quality: 'stale' });
      expect(verdict.issues.join(' ')).toMatch(/employer profiles are [\d.]+h old \(max 240h\)/);
      expect(verdict.issues.join(' ')).not.toMatch(/apart/);
    });
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
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l9-outcome.json'), 'utf8')))
      .toMatchObject({ loopId: 'L9', safeToAct: false, realOutreachSent: false, inventoryUntouched: true, subscriptionStateUntouched: true, pricesUntouched: true });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l9-result.json'), 'utf8')))
      .toMatchObject({ ok: false, issued: true, actionsWritten: true, outcomeLedgerMissing: true, profileInventoryComplete: true });
  });

  it('keeps a partial ledger in the safe draft-only path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l9-test-'));
    const profilesPath = writeJson(dir, 'profiles.json', profiles());
    const outcomePath = writeJson(dir, 'outcomes.json', outcomes({ eligibleEmployerAccounts: 3 }));
    const reportDir = path.join(dir, 'report');
    const result = await runL9({
      now: NOW,
      profilesPath,
      outcomePath,
      reportDir,
      apply: true,
      logger: { log() {} },
    });

    expect(result).toMatchObject({ issued: false, actionsWritten: true, verdict: { ok: false, quality: 'partial' } });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l9-actions.json'), 'utf8')))
      .toMatchObject({ realOutreachSent: false, inventoryUntouched: true, subscriptionStateUntouched: true, pricesUntouched: true });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l9-result.json'), 'utf8')))
      .toMatchObject({
        ok: false,
        quality: 'partial',
        issued: false,
        actionsWritten: true,
        safeDraftOnly: true,
        realOutreachSent: false,
        inventoryUntouched: true,
        subscriptionStateUntouched: true,
        pricesUntouched: true,
        outcomeLedgerMissing: false,
        profileInventoryComplete: true,
      });
  });

  describe('awaiting-sample', () => {
    const ZERO_FUNNEL = {
      eligibleEmployerAccounts: 0,
      profileViewAccounts: 0,
      leadAccounts: 0,
      checkoutStartAccounts: 0,
      paidActivations: 0,
      activeSubscriptions: 0,
      attachedJobs: 0,
      renewals: 0,
      freeProfiles: 0,
      sponsoredProfiles: 0,
      mrrRecognizedChf: 0,
    };
    const SMALL_FUNNEL = {
      ...ZERO_FUNNEL,
      eligibleEmployerAccounts: 3,
      profileViewAccounts: 0,
      leadAccounts: 0,
      checkoutStartAccounts: 2,
      paidActivations: 1,
      activeSubscriptions: 1,
      mrrRecognizedChf: 98,
      export: { ...outcomes().export, anonymousFunnelExcluded: true, anonymousFunnelReason: 'no publisherUid on CTA events' },
    };

    async function reported(ledger: Record<string, unknown>) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l9-test-'));
      const issues: any[] = [];
      const profilesPath = writeJson(dir, 'profiles.json', profiles());
      const result = await runL9({
        now: NOW,
        profilesPath,
        // Lo scope del ledger deve attestare lo STESSO file di inventario letto dalla run.
        outcomePath: writeJson(dir, 'outcomes.json', outcomes({
          inventoryScope: { ...outcomes().inventoryScope, profileSource: profilesPath },
          ...ledger,
        })),
        issue: true,
        createIssueImpl: async (payload) => { issues.push(payload); },
        logger: { log() {} },
      });
      return { result, issues };
    }

    it('passes awaiting-sample when zero eligible accounts is the only finding', async () => {
      const { result, issues } = await reported(ZERO_FUNNEL);
      expect(result.verdict).toMatchObject({ ok: false, quality: 'zero', issues: [] });
      expect(l9FindingKind(result.verdict)).toBe('underpowered-sample');
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        state: 'awaiting-sample',
        sample: { current: 0, minimum: 20, windowDays: null },
      });
    });

    it('passes awaiting-sample when the sample is under minimum and nothing else fails', async () => {
      const { result, issues } = await reported(SMALL_FUNNEL);
      expect(result.verdict.issues).toEqual(['eligibleEmployerAccounts is below minimum sample (3 < 20)']);
      expect(issues[0]).toMatchObject({ state: 'awaiting-sample', sample: { current: 3, minimum: 20 } });
    });

    it('keeps an undersized sample a failure when another check fails with it', async () => {
      const otherCohort = await reported({
        ...SMALL_FUNNEL,
        inventoryScope: { ...outcomes().inventoryScope, profileGeneratedAt: '2026-09-08T04:40:00.000Z' },
      });
      expect(otherCohort.result.verdict.issues.join(' ')).toContain('does not match the profile snapshot');
      expect(l9FindingKind(otherCohort.result.verdict)).toBe('ledger-failure');
      expect(otherCohort.issues[0].state).toBeUndefined();

      const unattested = await reported({ ...ZERO_FUNNEL, independent: false });
      expect(l9FindingKind(unattested.result.verdict)).toBe('ledger-failure');
      expect(unattested.issues[0].state).toBeUndefined();

      const broken = await reported({ ...ZERO_FUNNEL, paidActivations: 1 });
      expect(l9FindingKind(broken.result.verdict)).toBe('ledger-failure');
      expect(broken.issues[0].state).toBeUndefined();
    });
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
