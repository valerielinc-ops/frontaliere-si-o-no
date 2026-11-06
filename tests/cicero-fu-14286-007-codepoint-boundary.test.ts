import { describe, expect, it } from 'vitest';

import { decodeTypeScriptCodePointEscape } from '../packages/articles/engine/shared/tsStringEscapes';

describe('FU-2026-10-21-007 TypeScript code-point escape boundary', () => {
  it('consumes the full hexadecimal token and rejects incomplete tokens', () => {
    expect(decodeTypeScriptCodePointEscape('x41')).toEqual({ value: 'A', length: 3 });
    expect(decodeTypeScriptCodePointEscape('u{1F600}')).toEqual({ value: '😀', length: 8 });
    expect(decodeTypeScriptCodePointEscape('u{1F60}tail')).toEqual({ value: 'ὠ', length: 7 });
    expect(decodeTypeScriptCodePointEscape('u{')).toBeUndefined();
  });
});
