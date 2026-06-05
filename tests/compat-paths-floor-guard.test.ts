import { describe, it, expect } from 'vitest';
import {
  assertCompatFloor,
  COMPAT_PATHS_SANITY_FLOOR,
} from '../scripts/lib/compat-paths-floor-guard.mjs';

describe('assertCompatFloor', () => {
  it('exports a 150_000 floor (matches search-console-compat test invariant)', () => {
    expect(COMPAT_PATHS_SANITY_FLOOR).toBe(150_000);
  });

  it('throws when a large accumulator would be truncated below the floor', () => {
    // prev huge, next tiny → catastrophic truncation (the prod-killing case)
    expect(() => assertCompatFloor(657_594, 0)).toThrow(/ABORT write/);
    expect(() => assertCompatFloor(338_164, 5_000)).toThrow(/ABORT write/);
  });

  it('does NOT throw when the existing file is already below the floor', () => {
    // genuine bootstrap / legitimately-small accumulator must still grow/shrink
    expect(() => assertCompatFloor(0, 0)).not.toThrow();
    expect(() => assertCompatFloor(10_000, 50)).not.toThrow();
    expect(() => assertCompatFloor(149_999, 100)).not.toThrow();
  });

  it('does NOT throw when the write keeps the file at or above the floor', () => {
    expect(() => assertCompatFloor(338_164, 338_200)).not.toThrow();
    expect(() => assertCompatFloor(200_000, 150_000)).not.toThrow();
  });

  it('fires exactly at the boundary (next just under floor, prev at/above)', () => {
    expect(() => assertCompatFloor(150_000, 149_999)).toThrow(/ABORT write/);
    // prev exactly at floor, next exactly at floor → allowed (not < floor)
    expect(() => assertCompatFloor(150_000, 150_000)).not.toThrow();
  });

  it('honors a custom floor and includes the label in the message', () => {
    expect(() => assertCompatFloor(100, 1, { floor: 50, label: 'my-file.json' })).toThrow(
      /my-file\.json/,
    );
    expect(() => assertCompatFloor(40, 1, { floor: 50 })).not.toThrow();
  });

  it('coerces non-numeric counts to 0 (defensive)', () => {
    // @ts-expect-error testing defensive coercion
    expect(() => assertCompatFloor(undefined, undefined)).not.toThrow();
    // @ts-expect-error testing defensive coercion
    expect(() => assertCompatFloor(NaN, NaN)).not.toThrow();
  });
});
