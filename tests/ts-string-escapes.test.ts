import { describe, expect, it } from 'vitest';

import {
  decodeTsStringEscapeSequence,
  decodeTsStringEscapes,
} from '../packages/articles/engine/shared/tsStringEscapes';

describe('decodeTsStringEscapeSequence', () => {
  it('decodes TypeScript control escapes instead of preserving a source backslash', () => {
    expect(decodeTsStringEscapeSequence('0')).toBe('\0');
    expect(decodeTsStringEscapeSequence('b')).toBe('\b');
    expect(decodeTsStringEscapeSequence('f')).toBe('\f');
    expect(decodeTsStringEscapeSequence('v')).toBe('\v');
  });

  it('does not reinterpret legacy octal escapes as NUL plus a digit', () => {
    expect(decodeTsStringEscapeSequence('01')).toBeUndefined();
    expect(decodeTsStringEscapes(String.raw`a\01z`)).toBe(String.raw`a\01z`);
  });

  it('keeps unknown escapes available to downstream JSON parsing', () => {
    expect(decodeTsStringEscapeSequence('a')).toBeUndefined();
    expect(decodeTsStringEscapes(String.raw`\\0`)).toBe('\\0');
    expect(decodeTsStringEscapes(String.raw`\\b`)).toBe('\\b');
  });

  it('preserves the existing code-point and newline policies', () => {
    expect(decodeTsStringEscapes(String.raw`\x41\u{1F600}\u0042`)).toBe('A😀B');
    expect(decodeTsStringEscapes(String.raw`a\nb`, { newlineAs: ' ' })).toBe('a b');
  });
});
