import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pairedRestorePaths,
  restoreDataIntegrityFiles,
  restorePathsForViolations,
} from '../scripts/ci/restore-data-integrity-files.mjs';

const SOURCE = readFileSync(
  resolve(import.meta.dirname, '../scripts/ci/restore-data-integrity-files.mjs'),
  'utf8',
);
const WORKFLOW_SOURCE = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/guard-data-integrity.yml'),
  'utf8',
);

describe('data-integrity conflict recovery', () => {
  const active = 'data/jobs/by-crawler/convit-holding.json';
  const expired = 'data/jobs/expired/by-crawler/convit-holding.json';

  it('reads the guard payload from the environment and restores every listed file', () => {
    expect(SOURCE).toContain('process.env.BEFORE');
    expect(SOURCE).toContain('process.env.VIOLATIONS');
    expect(SOURCE).toContain('pairedRestorePaths');
    expect(SOURCE).toContain('restorePathsForViolations');
    expect(SOURCE).toContain("['checkout', '--ignore-skip-worktree-bits', before, '--', file]");
    expect(SOURCE).toContain("['add', '--sparse', '--', file]");
    expect(SOURCE).toContain('Array.isArray(violations)');
  });

  it('restores sparse-excluded files in the main guard workflow', () => {
    expect(WORKFLOW_SOURCE).toContain('node scripts/ci/restore-data-integrity-files.mjs');
    expect(WORKFLOW_SOURCE).not.toContain('while IFS= read -r -u 9 f');
  });

  it('pairs both directions only for real crawler slices and deduplicates them', () => {
    expect(pairedRestorePaths(active)).toEqual([active, expired]);
    expect(pairedRestorePaths(expired)).toEqual([expired, active]);
    expect(pairedRestorePaths('data/jobs/by-crawler/convit-holding-locale-cache.json'))
      .toEqual(['data/jobs/by-crawler/convit-holding-locale-cache.json']);
    expect(restorePathsForViolations([{ file: active }, { file: expired }]))
      .toEqual([active, expired]);
  });

  it('checks out and stages the active/expired pair from BEFORE', () => {
    const calls: string[][] = [];
    const exec = (_command: string, args: string[]) => {
      calls.push(args);
      return '';
    };

    restoreDataIntegrityFiles({
      before: 'before-sha',
      violationsText: JSON.stringify([{ file: active }]),
      exec,
    });

    expect(calls.filter(([command]) => command === 'checkout')).toEqual([
      ['checkout', '--ignore-skip-worktree-bits', 'before-sha', '--', active],
      ['checkout', '--ignore-skip-worktree-bits', 'before-sha', '--', expired],
    ]);
    expect(calls.filter(([command]) => command === 'add')).toEqual([
      ['add', '--sparse', '--', active],
      ['add', '--sparse', '--', expired],
    ]);
  });

  it('does not invent a missing historical counterpart', () => {
    const calls: string[][] = [];
    const exec = (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'cat-file' && args[2] === `before-sha:${expired}`) {
        const error = new Error('missing at BEFORE');
        Object.assign(error, {
          status: 128,
          stderr: Buffer.from(`fatal: Not a valid object name before-sha:${expired}\n`),
        });
        throw error;
      }
      return '';
    };

    restoreDataIntegrityFiles({
      before: 'before-sha',
      violationsText: JSON.stringify([{ file: active }]),
      exec,
    });

    expect(calls.filter(([command]) => command === 'checkout')).toEqual([
      ['checkout', '--ignore-skip-worktree-bits', 'before-sha', '--', active],
    ]);
  });

  it('propagates non-missing historical read failures', () => {
    const readError = new Error('pack read failed');
    const exec = (_command: string, args: string[]) => {
      if (args[0] === 'cat-file' && args[2] === `before-sha:data/jobs/expired/by-crawler/acme.json`) {
        throw readError;
      }
      return '';
    };

    let thrown;
    try {
      restoreDataIntegrityFiles({
        before: 'before-sha',
        violationsText: JSON.stringify([{ file: 'data/jobs/by-crawler/acme.json' }]),
        exec,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(readError);
  });
});
