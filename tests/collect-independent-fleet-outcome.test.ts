import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the collector is a dependency-free ESM CI script.
import { collectIndependentFleetOutcome } from '../scripts/ci/collect-independent-fleet-outcome.mjs';

const NOW = new Date('2026-09-16T01:00:00.000Z');
const SHA = 'a'.repeat(40);

function writeHealth(dir: string) {
  const file = path.join(dir, 'health.jsonl');
  const rows = ['101', '102'].map((runId, index) => ({
    recordType: 'health',
    loopId: `L${index}`,
    execution: { runId, sha: SHA, recordedAt: '2026-09-16T00:30:00.000Z' },
    recordedAt: '2026-09-16T00:30:00.000Z',
    ok: index === 0,
    gateBypass: false,
  }));
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

describe('collect-independent-fleet-outcome', () => {
  it('reconcilia i run della flotta con il ledger health senza scrivere sorgenti', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-oracle-collector-'));
    const calls: string[] = [];
    const result = collectIndependentFleetOutcome({
      healthPath: writeHealth(dir),
      repo: 'owner/repo',
      now: NOW,
      listRunsImpl: ({ workflow }: { workflow: string }) => {
        calls.push(workflow);
        if (calls.length !== 1) return { runs: [], error: null };
        return {
          runs: ['101', '102'].map((databaseId, index) => ({
            databaseId,
            status: 'completed',
            conclusion: index === 0 ? 'success' : 'failure',
            createdAt: '2026-09-16T00:30:00.000Z',
            headSha: SHA,
          })),
          error: null,
        };
      },
    });

    expect(calls.length).toBe(12);
    expect(result.outcome).toMatchObject({ status: 'observed', independent: true, numerator: 1, denominator: 2 });
  });

  it('produce uno stato esplicito quando il repository GitHub non è configurato', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-oracle-collector-missing-'));
    const result = collectIndependentFleetOutcome({
      healthPath: writeHealth(dir),
      repo: '',
      now: NOW,
      listRunsImpl: () => ({ runs: [], error: null }),
    });

    expect(result.outcome).toMatchObject({ status: 'partial', independent: false, numerator: null, denominator: null });
    expect(result.metrics.sourceErrors).toBe(1);
  });

  it('non nasconde run GitHub duplicati durante la riconciliazione', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-oracle-collector-duplicate-'));
    const result = collectIndependentFleetOutcome({
      healthPath: writeHealth(dir),
      repo: 'owner/repo',
      now: NOW,
      listRunsImpl: ({ workflow }: { workflow: string }) => ({
        runs: workflow === 'loop-l0-data-truth.yml' ? [{
          databaseId: '101',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-09-16T00:30:00.000Z',
          headSha: SHA,
        }] : workflow === 'loop-l1-reliability.yml' ? [{
          databaseId: '101',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-09-16T00:30:00.000Z',
          headSha: SHA,
        }] : [],
        error: null,
      }),
    });

    expect(result.outcome).toMatchObject({ status: 'partial', independent: false });
    expect(result.reconciliation.errors.join(' ')).toContain('appears more than once');
  });
});
