import { describe, expect, it } from 'vitest';
import { compareTreeEntries, parseTreeListing } from '../scripts/ci/shard-push-verify.mjs';

describe('shard-push-verify tree comparison', () => {
  it('counts add/modify/delete and reports injected path/blob mismatches', () => {
    const base = new Map([
      ['keep.txt', '1111111111111111111111111111111111111111'],
      ['modify.txt', '2222222222222222222222222222222222222222'],
      ['delete.txt', '3333333333333333333333333333333333333333'],
    ]);
    const plan = new Map([
      ['keep.txt', '1111111111111111111111111111111111111111'],
      ['modify.txt', '4444444444444444444444444444444444444444'],
      ['add.txt', '5555555555555555555555555555555555555555'],
    ]);
    const actual = new Map([
      ['keep.txt', '1111111111111111111111111111111111111111'],
      ['modify.txt', '9999999999999999999999999999999999999999'],
      ['delete.txt', '3333333333333333333333333333333333333333'],
    ]);

    expect(compareTreeEntries(base, plan, actual)).toEqual({
      files: 3,
      adds: 1,
      mods: 1,
      dels: 1,
      mismatchCount: 3,
      mismatches: [
        {
          kind: 'missing',
          path: 'add.txt',
          expected: '5555555555555555555555555555555555555555',
          actual: null,
        },
        {
          kind: 'extra',
          path: 'delete.txt',
          expected: null,
          actual: '3333333333333333333333333333333333333333',
        },
        {
          kind: 'blob',
          path: 'modify.txt',
          expected: '4444444444444444444444444444444444444444',
          actual: '9999999999999999999999999999999999999999',
        },
      ],
    });
  });

  it('parses nul-terminated git ls-tree records and accepts a matching tree', () => {
    const listing = Buffer.from([
      '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tassets/a.txt\0',
      '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tpages/b/index.html\0',
    ].join(''));
    const parsed = parseTreeListing(listing);
    expect(parsed).toEqual(new Map([
      ['assets/a.txt', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['pages/b/index.html', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ]));
    expect(compareTreeEntries(parsed, parsed, new Map(parsed))).toMatchObject({
      files: 2,
      adds: 0,
      mods: 0,
      dels: 0,
      mismatchCount: 0,
      mismatches: [],
    });
  });

  it('keeps the exact mismatch count while capping diagnostics at 50 paths', () => {
    const plan = new Map(Array.from({ length: 51 }, (_, index) => [
      `page-${index}.html`,
      `${index.toString(16).padStart(40, '0')}`,
    ]));
    const result = compareTreeEntries(new Map(), plan, new Map());
    expect(result.mismatchCount).toBe(51);
    expect(result.mismatches).toHaveLength(50);
  });
});
