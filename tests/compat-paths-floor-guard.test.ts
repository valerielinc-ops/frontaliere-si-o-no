import { describe, it, expect } from 'vitest';
import {
  assertCompatFloor,
  assertCompatPruneFamilySafety,
  assertCompatPruneSafety,
  compatPathFamily,
  COMPAT_PATHS_SANITY_FLOOR,
  COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT,
  COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO,
  COMPAT_PATHS_MAX_AUTO_PRUNE_FAMILY_RATIO,
  COMPAT_PATHS_MIN_AUTO_PRUNE_FAMILY_SIZE,
} from '../scripts/lib/compat-paths-floor-guard.mjs';

describe('assertCompatFloor', () => {
  it('exports the configured 150_000 writer floor', () => {
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
    expect(() => assertCompatFloor(undefined, undefined)).not.toThrow();
    expect(() => assertCompatFloor(NaN, NaN)).not.toThrow();
  });
});

describe('assertCompatPruneSafety', () => {
  it('sets bounded automatic prune limits for large accumulators', () => {
    expect(COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT).toBe(50_000);
    expect(COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO).toBe(0.10);
  });

  it('catches a destructive cohort loss even while the store stays above the floor', () => {
    expect(() => assertCompatPruneSafety(200_000, 150_000)).toThrow(/ABORT prune/);
  });

  it('catches the absolute removal limit even when the percentage is small', () => {
    expect(() => assertCompatPruneSafety(1_000_000, 949_999)).toThrow(/50000 paths/);
  });

  it('catches the percentage limit even when the removed count is small', () => {
    expect(() => assertCompatPruneSafety(200_000, 179_999)).toThrow(/10%/);
  });

  it('allows a cleanup exactly at both automatic limits', () => {
    expect(() => assertCompatPruneSafety(1_000_000, 950_000)).not.toThrow();
    expect(() => assertCompatPruneSafety(200_000, 180_000)).not.toThrow();
  });

  it('preserves bootstrap behavior for stores below the established floor', () => {
    expect(() => assertCompatPruneSafety(10_000, 0)).not.toThrow();
  });

  it('allows an explicit reviewed override for a large prune', () => {
    expect(() => assertCompatPruneSafety(657_594, 0, { allowLargePrune: true })).not.toThrow();
  });
});

describe('assertCompatPruneFamilySafety', () => {
  it('keeps locale-specific route families separate', () => {
    expect(compatPathFamily('/fr/articles-frontalier/un-article?source=gsc')).toBe('fr/articles-frontalier');
    expect(compatPathFamily('/articles-frontaliere/un-article')).toBe('articles-frontaliere');
    expect(compatPathFamily('/eventi/ticino/locarno/un-evento')).toBe('eventi');
    expect(compatPathFamily('/')).toBe('<root>');
  });

  it('sets a localized-loss threshold independent of the global accumulator size', () => {
    expect(COMPAT_PATHS_MAX_AUTO_PRUNE_FAMILY_RATIO).toBe(0.25);
    expect(COMPAT_PATHS_MIN_AUTO_PRUNE_FAMILY_SIZE).toBe(20);
  });

  it('catches a resolver regression isolated to one route family', () => {
    // 101 deletions are only 0.01% of the 1M-path store, below global limits,
    // but they are 25.25% of this established locale/section family.
    const totals = new Map([['fr/articles-frontalier', 400], ['it/articoli-frontaliere', 999_600]]);
    const removed = new Map([['fr/articles-frontalier', 101]]);
    expect(() => assertCompatPruneFamilySafety(totals, removed)).toThrow(/localized route-family loss/);
    expect(() => assertCompatPruneSafety(1_000_000, 999_899)).not.toThrow();
  });

  it('allows a family prune exactly at the configured ratio boundary', () => {
    expect(() => assertCompatPruneFamilySafety(
      new Map([['fr/articles-frontalier', 400]]),
      new Map([['fr/articles-frontalier', 100]]),
    )).not.toThrow();
  });

  it('blocks complete deletion of a smaller route family', () => {
    expect(() => assertCompatPruneFamilySafety(
      new Map([['fr/articles-frontalier', 99]]),
      new Map([['fr/articles-frontalier', 99]]),
    )).toThrow(/localized route-family loss/);
  });

  it('does not block pruning an unresolved one-off path in a novel family', () => {
    expect(() => assertCompatPruneFamilySafety(
      new Map([['totally-unknown-path', 1]]),
      new Map([['totally-unknown-path', 1]]),
    )).not.toThrow();
  });

  it('fails closed when route-family evidence is omitted', () => {
    expect(() => assertCompatPruneFamilySafety(undefined, new Map())).toThrow(/evidence is missing/);
  });

  it('allows a reviewed override after the dropped cohort has been inspected', () => {
    expect(() => assertCompatPruneFamilySafety(
      new Map([['fr/articles-frontalier', 400]]),
      new Map([['fr/articles-frontalier', 300]]),
      { allowLargePrune: true },
    )).not.toThrow();
  });
});
