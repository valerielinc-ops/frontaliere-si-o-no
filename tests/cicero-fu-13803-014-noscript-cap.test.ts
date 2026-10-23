import { describe, expect, it } from 'vitest';
import { capExtractedText } from '../scripts/lib/extract-article-text.mjs';

describe('noscript extraction cap contract (#13803 FU-014)', () => {
  it('applies the caller budget before fallback paragraphs are joined', () => {
    expect(capExtractedText('0123456789', 4.9)).toBe('0123');
    expect(capExtractedText('0123456789', 0)).toBe('');
    expect(capExtractedText('0123456789', -4)).toBe('');
  });

  it('uses the safe default for invalid budgets while preserving an explicit unlimited budget', () => {
    const source = 'x'.repeat(8_100);
    expect(capExtractedText(source, Number.NaN)).toHaveLength(8_000);
    expect(capExtractedText(source, Number.POSITIVE_INFINITY)).toHaveLength(source.length);
    expect(capExtractedText('short', 100)).toBe('short');
  });
});
