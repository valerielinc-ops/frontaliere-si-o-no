import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(new URL('../.github/workflows/stale-pr-rescuer.yml', import.meta.url), 'utf8');

function decisionBlock(): string {
  const start = WORKFLOW.indexOf('            IMPORTANT_MARKER_STATUS=1');
  const end = WORKFLOW.indexOf('            echo "::warning::PR #$N STALLED', start);
  expect(start, 'stale-pr-rescuer marker guard not found').toBeGreaterThanOrEqual(0);
  expect(end, 'stale-pr-rescuer class decision block not found').toBeGreaterThan(start);
  return WORKFLOW.slice(start, end)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

function runDecision({ tests, lastCid }: { tests: string; lastCid: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-pr-rescuer-marker-error-'));
  try {
    const grep = join(dir, 'grep');
    writeFileSync(grep, '#!/bin/sh\nexit 2\n');
    chmodSync(grep, 0o755);
    const script = [
      'set -uo pipefail',
      'for item in 1; do',
      decisionBlock(),
      'done',
      'printf \'CLASS=%s\\n\' "${CLASS:-}"',
    ].join('\n');
    const output = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH || ''}`,
        LAST_BODY: '🔴 Important: marker fixture',
        TESTS_CONCL: tests,
        TESTS_PENDING: '0',
        LAST_CID: lastCid,
        HEAD: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        BRANCH: 'fix/fixture',
      },
    });
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('stale-pr-rescuer — un errore PCRE non spegne le classi indipendenti (#8015)', () => {
  it('mantiene raggiungibile la Classe A quando il guard marker esce 2', () => {
    expect(runDecision({
      tests: 'success',
      lastCid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })).toContain('CLASS=A');
  });

  it('mantiene raggiungibile la Classe C quando il guard marker esce 2', () => {
    expect(runDecision({
      tests: 'failure',
      lastCid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })).toContain('CLASS=C');
  });
});
