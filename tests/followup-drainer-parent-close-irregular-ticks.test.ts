import { describe, expect, it } from 'vitest';
import { rotateForScan } from '../scripts/ci/followup-drainer.mjs';

const PERIOD = 20 * 60_000;
const CAP = 5;
const TICKS = [0, 2, 3, 5, 6, 8, 9, 11];

describe('parent-close — conta le scansioni, non i bucket temporali', () => {
  it('copre il pool dopo otto scansioni con tick di parete non consecutivi', () => {
    const pool = Array.from({ length: 39 }, (_, index) => ({ number: index + 1 }));
    let cursor: string | null = null;
    const seen = new Set<number>();

    for (const tick of TICKS) {
      const ordered = rotateForScan(pool, {
        scanMax: CAP,
        now: tick * PERIOD,
        periodMs: PERIOD,
        cursor,
        getKey: (parent) => parent.number,
      });
      const examined = ordered.slice(0, CAP);
      for (const parent of examined) seen.add(parent.number);
      cursor = String(examined.at(-1)?.number ?? cursor);
    }

    expect(seen.size).toBe(pool.length);
  });

  it('avanza anche quando due scansioni cadono nello stesso bucket temporale', () => {
    const pool = Array.from({ length: 12 }, (_, index) => ({ number: index + 1 }));
    let cursor: string | null = null;
    const windows: number[][] = [];

    for (const now of [0, 1, 2].map((tick) => tick * PERIOD)) {
      const examined = rotateForScan(pool, {
        scanMax: CAP,
        now,
        periodMs: PERIOD,
        cursor,
        getKey: (parent) => parent.number,
      }).slice(0, CAP);
      windows.push(examined.map((parent) => parent.number));
      cursor = String(examined.at(-1)?.number ?? cursor);
    }

    expect(windows).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 1, 2, 3]]);
  });
});
