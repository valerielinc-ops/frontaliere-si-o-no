import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the collector is a dependency-free ESM CI script.
import {
  collectIndependentFleetOutcome,
  listCompletedRuns,
} from '../scripts/ci/collect-independent-fleet-outcome.mjs';

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

  it('ritenta soltanto una lettura GitHub transitoria e conserva il limite bounded', () => {
    let calls = 0;
    const delays: number[] = [];
    let command: string[] = [];
    const result = listCompletedRuns({
      repo: 'owner/repo',
      workflow: 'technical-operations-supervisor.yml',
      maxRecords: 7,
      execFileSyncImpl: (_binary: string, args: string[]) => {
        command = args;
        calls += 1;
        if (calls < 3) {
          const error = new Error('gh: HTTP 503 service unavailable');
          throw error;
        }
        return '[]';
      },
      sleep: (delay: number) => delays.push(delay),
    });

    expect(result).toEqual({ runs: [], error: null });
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 750]);
    expect(command).toContain('--limit');
    expect(command[command.indexOf('--limit') + 1]).toBe('7');
  });

  it('non ritenta errori GitHub non transitori', () => {
    let calls = 0;
    const delays: number[] = [];
    const result = listCompletedRuns({
      repo: 'owner/repo',
      workflow: 'technical-operations-supervisor.yml',
      maxRecords: 7,
      execFileSyncImpl: () => {
        calls += 1;
        throw new Error('gh: HTTP 404 workflow not found');
      },
      sleep: (delay: number) => delays.push(delay),
    });

    expect(result).toMatchObject({ runs: [], error: expect.stringContaining('unavailable') });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
});
