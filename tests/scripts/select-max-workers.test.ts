import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { selectMaxWorkers, vitestChildEnv } from '../../scripts/ci/lib/select-max-workers.mjs';

describe('selectMaxWorkers', () => {
  it('uses the fallback cap when the full-suite fallback ran and one is set', () => {
    expect(
      selectMaxWorkers({ usedFullFallback: true, maxWorkers: '1', maxWorkersFallback: '3' }),
    ).toBe('3');
  });

  it('uses the ordinary cap when the full-suite fallback did not run', () => {
    expect(
      selectMaxWorkers({ usedFullFallback: false, maxWorkers: '1', maxWorkersFallback: '3' }),
    ).toBe('1');
  });

  it('raises the ordinary cap to two workers for a large related selection', () => {
    expect(
      selectMaxWorkers({
        usedFullFallback: false,
        maxWorkers: '1',
        maxWorkersFallback: '3',
        relatedTestCount: 100,
      }),
    ).toBe('2');
  });

  it('keeps the serial cap below the large-selection threshold', () => {
    expect(
      selectMaxWorkers({
        usedFullFallback: false,
        maxWorkers: '1',
        maxWorkersFallback: '3',
        relatedTestCount: 99,
      }),
    ).toBe('1');
  });

  it('preserves an explicitly higher ordinary cap', () => {
    expect(
      selectMaxWorkers({
        usedFullFallback: false,
        maxWorkers: '3',
        maxWorkersFallback: '4',
        relatedTestCount: 100,
      }),
    ).toBe('3');
  });

  it('keeps the full-suite fallback cap authoritative', () => {
    expect(
      selectMaxWorkers({
        usedFullFallback: true,
        maxWorkers: '1',
        maxWorkersFallback: '3',
        relatedTestCount: 100,
      }),
    ).toBe('3');
  });

  it('does not reinterpret the ordinary cap when the fallback cap is absent', () => {
    expect(
      selectMaxWorkers({
        usedFullFallback: true,
        maxWorkers: '1',
        maxWorkersFallback: undefined,
        relatedTestCount: 100,
      }),
    ).toBe('1');
  });

  it('falls back to the ordinary cap when no fallback cap is configured', () => {
    expect(
      selectMaxWorkers({ usedFullFallback: true, maxWorkers: '1', maxWorkersFallback: undefined }),
    ).toBe('1');
  });

  it('passes through undefined when neither cap is set', () => {
    expect(
      selectMaxWorkers({ usedFullFallback: true, maxWorkers: undefined, maxWorkersFallback: undefined }),
    ).toBeUndefined();
  });
});

// Vitest applica `process.env.VITEST_MAX_WORKERS` sopra `--maxWorkers`: il
// figlio non deve ereditare l'input di tests.yml (1) al posto del valore scelto.
describe('vitestChildEnv', () => {
  it('overrides the inherited cap with the selected worker count', () => {
    const child = vitestChildEnv({ VITEST_MAX_WORKERS: '1', PATH: '/bin' }, '2');
    expect(child.VITEST_MAX_WORKERS).toBe('2');
    expect(child.PATH).toBe('/bin');
  });

  it('removes the variable when no worker count was selected', () => {
    const child = vitestChildEnv({ VITEST_MAX_WORKERS: '1' }, undefined);
    expect('VITEST_MAX_WORKERS' in child).toBe(false);
  });

  it('does not mutate the parent environment', () => {
    const parent = { VITEST_MAX_WORKERS: '1' };
    vitestChildEnv(parent, '3');
    expect(parent.VITEST_MAX_WORKERS).toBe('1');
  });

  it('is the environment run-related-tests.mjs spawns Vitest with', () => {
    const runner = readFileSync(join(__dirname, '../../scripts/ci/run-related-tests.mjs'), 'utf8');
    const spawn = runner.slice(runner.indexOf('spawnSync(process.execPath, args'));
    expect(spawn.slice(0, 200)).toMatch(/env:\s*vitestChildEnv\(process\.env,\s*maxWorkers\)/);
  });
});
