import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { machineAdmission } from '../scripts/ci/lib/machine-broken.mjs';
import { partitionMintedItems } from '../scripts/ci/gate-minted-followups.mjs';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function workflowDir(source = 'node scripts/ci/measure.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'machine-broken-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'measure.yml'), `name: Measure\non: workflow_dispatch\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${source}\n`);
  return dir;
}

function item(...paths: string[]) {
  return `- Suggested action: chiamare \`machineCheck()\` in ${paths.map((p) => `\`${p}\``).join(' e ')}`;
}

function completed(...conclusions: string[]) {
  return conclusions.map((conclusion) => ({ status: 'completed', conclusion }));
}

describe('ammissibilità degli item macchina', () => {
  it('ammette un workflow citato direttamente con due failure consecutive', () => {
    const dir = workflowDir();
    expect(machineAdmission(item('.github/workflows/measure.yml'), {
      workflowDirectory: dir,
      getRuns: () => completed('failure', 'failure'),
    })).toBe('admit');
  });

  it('ammette uno script quando il workflow che lo esegue ha due failure consecutive', () => {
    const dir = workflowDir();
    const seen: string[] = [];
    expect(machineAdmission(item('scripts/ci/measure.mjs'), {
      workflowDirectory: dir,
      getRuns: (workflow) => {
        seen.push(workflow);
        return completed('failure', 'failure');
      },
    })).toBe('admit');
    expect(seen).toEqual(['measure.yml']);
  });

  it('ammette quando il workflow risolto non ha mai prodotto una run', () => {
    const dir = workflowDir();
    expect(machineAdmission(item('scripts/ci/measure.mjs'), {
      workflowDirectory: dir,
      getRuns: () => [],
    })).toBe('admit');
  });

  it('demota dopo una sola failure', () => {
    const dir = workflowDir();
    expect(machineAdmission(item('scripts/ci/measure.mjs'), {
      workflowDirectory: dir,
      getRuns: () => completed('failure'),
    })).toBe('reject');
  });

  it('demota quando le ultime run non sono due failure consecutive', () => {
    const dir = workflowDir();
    expect(machineAdmission(item('scripts/ci/measure.mjs'), {
      workflowDirectory: dir,
      getRuns: () => completed('failure', 'success', 'failure'),
    })).toBe('reject');
  });

  it('demota uno script che nessun workflow locale esegue', () => {
    const dir = workflowDir();
    const calls: string[] = [];
    expect(machineAdmission(item('scripts/ci/not-run.mjs'), {
      workflowDirectory: dir,
      getRuns: (workflow) => {
        calls.push(workflow);
        return completed('failure', 'failure');
      },
    })).toBe('reject');
    expect(calls).toEqual([]);
  });

  it('demota un workflow citato ma assente', () => {
    const dir = workflowDir();
    const calls: string[] = [];
    expect(machineAdmission(item('.github/workflows/missing.yml'), {
      workflowDirectory: dir,
      getRuns: (workflow) => {
        calls.push(workflow);
        return completed('failure', 'failure');
      },
    })).toBe('reject');
    expect(calls).toEqual([]);
  });

  it('lascia intatto l’item se la rete o gh impediscono la diagnosi', () => {
    const dir = workflowDir();
    expect(machineAdmission(item('scripts/ci/measure.mjs'), {
      workflowDirectory: dir,
      getRuns: () => { throw new Error('network unavailable'); },
    })).toBe('unknown');
  });

  it('lascia intatto l’item se gh restituisce run malformate', () => {
    const dir = workflowDir();
    expect(machineAdmission(item('scripts/ci/measure.mjs'), {
      workflowDirectory: dir,
      getRuns: () => [{ conclusion: 'not-a-github-conclusion' }],
    })).toBe('unknown');
  });

  it('non tocca un item misto macchina e prodotto', () => {
    const dir = workflowDir();
    const calls: string[] = [];
    expect(machineAdmission(item('scripts/ci/measure.mjs', 'services/health.ts'), {
      workflowDirectory: dir,
      getRuns: (workflow) => {
        calls.push(workflow);
        return completed('failure', 'failure');
      },
    })).toBe('not-machine');
    expect(calls).toEqual([]);
  });

  it('non tocca scripts/lib, che appartiene al prodotto', () => {
    const dir = workflowDir();
    const calls: string[] = [];
    expect(machineAdmission(item('scripts/lib/crawler.mjs'), {
      workflowDirectory: dir,
      getRuns: (workflow) => {
        calls.push(workflow);
        return completed('failure', 'failure');
      },
    })).toBe('not-machine');
    expect(calls).toEqual([]);
  });

  it('il gate conserva l’item quando la diagnosi di rete è sconosciuta', () => {
    const dir = workflowDir();
    const text = item('.github/workflows/measure.yml');
    const result = partitionMintedItems(`### 1.${text}`, {
      machineOptions: {
        workflowDirectory: dir,
        getRuns: () => { throw new Error('network unavailable'); },
      },
    });
    expect(result.valid).toEqual([text]);
    expect(result.demoted).toEqual([]);
  });

  it('il gate demota l’item macchina quando lo storico è sano', () => {
    const dir = workflowDir();
    const text = item('.github/workflows/measure.yml');
    const result = partitionMintedItems(`### 1.${text}`, {
      machineOptions: {
        workflowDirectory: dir,
        getRuns: () => completed('success', 'success'),
      },
    });
    expect(result.valid).toEqual([]);
    expect(result.demoted).toEqual([text]);
  });
});
