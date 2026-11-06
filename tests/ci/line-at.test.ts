import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs CI helper, no type declarations.
import { lineAt } from '../../scripts/ci/line-at.mjs';

describe('lineAt', () => {
  it('preserves one-based line semantics at LF and CRLF boundaries', () => {
    const source = 'zero\r\none\ntwo';
    const lfOffsets = [...source].flatMap((character, index) => character === '\n' ? [index] : []);

    expect(lineAt(source, 0)).toBe(1);
    expect(lineAt(source, lfOffsets[0])).toBe(1);
    expect(lineAt(source, lfOffsets[0] + 1)).toBe(2);
    expect(lineAt(source, lfOffsets[1])).toBe(2);
    expect(lineAt(source, lfOffsets[1] + 1)).toBe(3);
  });

  it('rebuilds the index when the source changes', () => {
    expect(lineAt('first\nsecond', 8)).toBe(2);
    expect(lineAt('first\nsecond\nthird', 14)).toBe(3);
  });
});
