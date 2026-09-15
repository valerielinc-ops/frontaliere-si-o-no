import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runL8,
  validateRevenueAttribution,
} from '../scripts/ci/loop-l8-revenue-attribution.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-12',
    adsense: {
      revenuePerDayCHF: 12.4,
      rpmCHF: 4.2,
      desktopRpmCHF: 2.1,
      authGateImpressions7d: 1000,
    },
    gsc: {
      clicksPerDay: 250,
      avgPosition: 8.2,
      ctrByBucket: { '/fisco/': 2.4 },
    },
    posthog: {
      clsP75Mobile: 0.2,
      clsP75Desktop: 0.15,
    },
    publisher: {
      activeAds: 1,
      sponsoredActive: 0,
      freeActive: 1,
      estMrrCHF: 0,
    },
    regressions: [],
    ...overrides,
  };
}

function history(...rows: Record<string, unknown>[]) {
  return { records: rows.length ? rows : [historyRow()], parseIssues: [] };
}

function affiliate(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-09-12T11:00:00.000Z',
    independent: true,
    evidence: {
      source: 'authorized-network-export',
      sourceRefs: ['authorised-affiliate-commercial-export'],
    },
    clicks: { web: 100, relevant: 100, total: 100 },
    amountFormat: 'decimal',
    period: { from: '2026-09-01', to: '2026-09-12' },
    exposures: { web: 100 },
    transactions: [
      {
        transactionId: 'approved-1',
        network: 'network-a',
        status: 'approved',
        currency: 'CHF',
        amount: 250,
        occurredAt: '2026-09-10T10:00:00.000Z',
      },
      {
        transactionId: 'pending-1',
        network: 'network-a',
        status: 'pending',
        currency: 'CHF',
        amount: 5,
        occurredAt: '2026-09-10T11:00:00.000Z',
      },
      {
        transactionId: 'reversed-1',
        network: 'network-a',
        status: 'reversed',
        currency: 'CHF',
        amount: 2,
        occurredAt: '2026-09-10T12:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function writeJson(dir: string, name: string, value: unknown) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

function writeHistory(dir: string, rows = [historyRow()]) {
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

describe('L8 Revenue & Attribution', () => {
  it('keeps approved, pending and reversed CHF separate even when approved money exceeds exposures', () => {
    const verdict = validateRevenueAttribution({ history: history(), affiliate: affiliate() }, { now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot.commercial).toMatchObject({
      approvedNetChf: 250,
      pendingChf: 5,
      reversedChf: 2,
      exposures: { web: 100, email: null, relevant: 100 },
      clicks: { web: 100, email: null, relevant: 100, total: 100 },
      statusCounts: { pending: 1, approved: 1, reversed: 1 },
    });
    expect(verdict.snapshot.commercial.byCurrency.CHF).toMatchObject({
      approved: 250,
      pending: 5,
      reversed: 2,
    });
  });

  it('keeps monitor clicks separate from the authorised commercial export', () => {
    const verdict = validateRevenueAttribution({
      history: history(),
      affiliate: affiliate({ clicks: undefined }),
    }, { now: NOW });
    expect(verdict.ok).toBe(true);
    expect(verdict.quality).toBe('observed');
    expect(verdict.snapshot.commercial.clicks.relevant).toBeNull();
    expect(verdict.snapshot.history.gsc.clicksPerDay).toBe(250);
  });

  it('accepts a scalar click count when the authorised export provides one', () => {
    const verdict = validateRevenueAttribution({
      history: history(),
      affiliate: affiliate({ clicks: 100 }),
    }, { now: NOW });
    expect(verdict.ok).toBe(true);
    expect(verdict.snapshot.commercial.clicks).toMatchObject({ relevant: 100, total: 100 });
  });

  it('does not count duplicate history dates as valid observations', () => {
    const verdict = validateRevenueAttribution({
      history: history(historyRow(), historyRow()),
      affiliate: affiliate(),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.history).toMatchObject({ validRows: 1, invalidRows: 1, distinctDates: 1 });
    expect(verdict.issues.join(' ')).toContain('duplicates');
  });

  it('does not accept null required monitor metrics as a fresh history row', () => {
    const verdict = validateRevenueAttribution({
      history: history(historyRow({ posthog: { clsP75Mobile: null, clsP75Desktop: 0.15 } })),
      affiliate: affiliate(),
    }, { now: NOW });
    expect(verdict.quality).toBe('unmeasurable');
    expect(verdict.snapshot.history.validRows).toBe(0);
    expect(verdict.issues.join(' ')).toContain('clsP75Mobile is missing');
  });

  it('rejects dual web/email denominators when the money ledger has no channel attribution', () => {
    const verdict = validateRevenueAttribution({
      history: history(),
      affiliate: affiliate({ exposures: { web: 100, email: 20 } }),
    }, { now: NOW });
    expect(verdict.quality).toBe('unmeasurable');
    expect(verdict.snapshot.commercial.exposures.relevant).toBeNull();
    expect(verdict.issues.join(' ')).toContain('both web and email exposures');
  });

  it('keeps missing commercial evidence unmeasurable instead of inferring zero revenue', () => {
    const verdict = validateRevenueAttribution({ history: history(), affiliate: null }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'unmeasurable' });
    expect(verdict.snapshot.commercial).toMatchObject({ approvedNetChf: null, pendingChf: null });
  });

  it('does not turn an export without transaction rows into zero approved revenue', () => {
    const verdict = validateRevenueAttribution({
      history: history(),
      affiliate: affiliate({ transactions: undefined }),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.commercial.approvedNetChf).toBeNull();
    expect(verdict.issues.join(' ')).toContain('transactions/rows is missing');
  });

  it('requires a currency conversion oracle for approved non-CHF money', () => {
    const verdict = validateRevenueAttribution({
      history: history(),
      affiliate: affiliate({
        exposures: { web: 100 },
        transactions: [{
          transactionId: 'usd-1',
          network: 'network-a',
          status: 'approved',
          currency: 'USD',
          amount: 10,
          occurredAt: '2026-09-10T10:00:00.000Z',
        }],
      }),
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.commercial.approvedNetChf).toBeNull();
    expect(verdict.issues.join(' ')).toContain('non-CHF');
  });

  it('writes reversible runner-local actions and persists the result after issue creation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l8-test-'));
    const historyPath = writeHistory(dir);
    const reportDir = path.join(dir, 'report');
    const issues: unknown[] = [];
    const result = await runL8({
      now: NOW,
      historyPath,
      affiliatePath: path.join(dir, 'missing-export.json'),
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload) => { issues.push(payload); },
      logger: { log() {} },
    });
    expect(result.issued).toBe(true);
    expect(result.actionsWritten).toBe(true);
    expect(issues).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l8-safe-actions.json'), 'utf8')))
      .toMatchObject({ externalCommercialStateUntouched: true, autoAdsUntouched: true });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l8-result.json'), 'utf8')))
      .toMatchObject({ ok: false, issued: true, actionsWritten: true });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l8-outcome.json'), 'utf8')))
      .toMatchObject({ loopId: 'L8', safeToAct: false, autoAdsUntouched: true, externalCommercialStateUntouched: true });
  });

  it('does not persist a result when issue creation fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l8-test-'));
    const historyPath = writeHistory(dir);
    const reportDir = path.join(dir, 'report');
    await expect(runL8({
      now: NOW,
      historyPath,
      affiliatePath: path.join(dir, 'missing-export.json'),
      reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue service unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l8-result.json'))).toBe(false);
  });

  it('keeps empty exposure evidence as zero and uses null observation metrics', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l8-test-'));
    const historyPath = writeHistory(dir);
    const affiliatePath = writeJson(dir, 'affiliate.json', affiliate({ exposures: { web: 0, email: 0 }, transactions: [] }));
    const result = await runL8({
      now: NOW,
      historyPath,
      affiliatePath,
      reportDir: path.join(dir, 'report'),
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('zero');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });
});
