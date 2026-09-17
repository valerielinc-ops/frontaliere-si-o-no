import { describe, it, expect } from 'vitest';
import { selectMaxWorkers } from '../../scripts/ci/lib/select-max-workers.mjs';

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
