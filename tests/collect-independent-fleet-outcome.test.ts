import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the collector is a dependency-free ESM CI script.
import {
  collectIndependentFleetOutcome,
  listCompletedRuns,
  summarizeIndependentFleetOutcome,
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

  it('nomina nel log le classi di errore per file di workflow ed evento, ordinate per conteggio', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-oracle-collector-classes-'));
    const runsByWorkflow: Record<string, Array<Record<string, unknown>>> = {
      'loop-l1-reliability.yml': ['36928805843', '36928805844', '36928805845'].map((databaseId) => ({
        databaseId,
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-09-16T00:30:00.000Z',
        headSha: SHA,
        workflowName: 'Loop L1 reliability',
        event: 'schedule',
      })),
      'loop-l3-job-quality.yml': [{
        databaseId: '37130952288',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-09-16T00:30:00.000Z',
        headSha: SHA,
        workflowName: 'Loop L3 job quality',
        event: 'workflow_run',
      }],
    };
    const result = collectIndependentFleetOutcome({
      healthPath: writeHealth(dir),
      repo: 'owner/repo',
      now: NOW,
      listRunsImpl: ({ workflow }: { workflow: string }) => ({ runs: runsByWorkflow[workflow] || [], error: null }),
    });

    // The all-or-nothing join is unchanged: classification never promotes it.
    expect(result.outcome).toMatchObject({ status: 'partial', independent: false, numerator: null, denominator: null });

    const summary = summarizeIndependentFleetOutcome(result);
    const keys = Object.keys(summary.errorClasses);
    // Every run-side error carries the workflow file it was listed under and
    // the event GitHub reported: an unclassified error turns this red.
    for (const key of keys.filter((candidate) => candidate.startsWith('GitHub run'))) {
      expect(key).not.toMatch(/\|unknown/u);
    }
    expect(keys[0]).toBe('GitHub run <id> has no canonical health row|loop-l1-reliability.yml|schedule');
    expect(summary.errorClasses[keys[0]]).toBe(runsByWorkflow['loop-l1-reliability.yml'].length);
    expect(summary.errorClasses['GitHub run <id> has no canonical health row|loop-l3-job-quality.yml|workflow_run']).toBe(1);
    const counts = Object.values(summary.errorClasses) as number[];
    expect(counts).toEqual([...counts].sort((left, right) => right - left));
    expect(counts.reduce((sum, count) => sum + count, 0) + summary.errorsInOmittedClasses)
      .toBe(summary.reconciliationErrors);
    expect(keys.join('\n')).not.toMatch(/36928805|37130952/u);

    const line = JSON.stringify(summary);
    expect(line).toContain('"errorClasses"');
    expect(line).toContain('"reconciliationErrors"');
  });

  it('chiede a GitHub nome del workflow ed evento di ogni run', () => {
    let command: string[] = [];
    listCompletedRuns({
      repo: 'owner/repo',
      workflow: 'loop-l1-reliability.yml',
      execFileSyncImpl: (_binary: string, args: string[]) => {
        command = args;
        return '[]';
      },
    });

    const fields = command[command.indexOf('--json') + 1].split(',');
    expect(fields).toEqual(expect.arrayContaining(['databaseId', 'headSha', 'workflowName', 'event']));
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

  it('ritenta anche il timeout restituito dal coordinatore GitHub locale', () => {
    let calls = 0;
    const delays: number[] = [];
    const result = listCompletedRuns({
      repo: 'owner/repo',
      workflow: 'technical-operations-supervisor.yml',
      execFileSyncImpl: () => {
        calls += 1;
        if (calls < 2) throw new Error('github-coordinator: github_coordinator_timeout: socket');
        return '[]';
      },
      sleep: (delay: number) => delays.push(delay),
    });

    expect(result).toEqual({ runs: [], error: null });
    expect(calls).toBe(2);
    expect(delays).toEqual([250]);
  });
});
