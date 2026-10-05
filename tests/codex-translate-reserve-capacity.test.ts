import { describe, expect, it } from 'vitest';

import {
  calculateCodexReserveCapacity,
  compareCodexReserve,
  CODEX_RESERVE_BENCHMARK_CONFIG,
  formatCodexReserveBenchmark,
} from '@/scripts/measure-codex-translate-tier.mjs';

describe('Codex reserve benchmark', () => {
  it('compares the baseline and branch for one and five texts deterministically', () => {
    const rows = compareCodexReserve();

    expect(rows.map((row) => row.texts)).toEqual([1, 5]);
    expect(rows.map((row) => row.baseline)).toEqual([
      { requests: 0, simulatedSeconds: 0, translated: 0 },
      { requests: 0, simulatedSeconds: 0, translated: 0 },
    ]);
    expect(rows.map((row) => row.branch)).toEqual([
      { requests: 1, simulatedSeconds: 7.1, translated: 1 },
      { requests: 1, simulatedSeconds: 36.8, translated: 5 },
    ]);
  });

  it('calculates the 30-call capacity and identifies calls as the bottleneck', () => {
    const capacity = calculateCodexReserveCapacity(CODEX_RESERVE_BENCHMARK_CONFIG);

    expect(capacity).toMatchObject({
      texts: 150,
      calls: CODEX_RESERVE_BENCHMARK_CONFIG.maxCalls,
      elapsedSeconds: 552,
      limitingResource: 'calls',
    });
    expect(capacity.timeCapacityTexts).toBeGreaterThan(capacity.texts);
  });

  it('renders the compact table used by the reproducible command', () => {
    const output = formatCodexReserveBenchmark();

    expect(output).toContain('| 1 | 0.0s (0/1) | 7.1s (1/1) |');
    expect(output).toContain('| 5 | 0.0s (0/5) | 36.8s (5/5) |');
    expect(output).toContain('150 testi; 30 chiamate; 552.0s/900.0s; limite: chiamate');
  });
});
