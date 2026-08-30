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
