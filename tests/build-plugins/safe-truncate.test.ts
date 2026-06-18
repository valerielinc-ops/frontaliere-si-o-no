/**
 * Unit tests for the surrogate-safe truncation helpers shared by every JSON-LD
 * / meta-text emitter (jobPostingSchema, jobPostingListItem, jobsSeoPagesPlugin,
 * titleSuffix, publisherAdPagesPlugin, seoService).
 */
import { describe, it, expect } from 'vitest';
import { truncateCodeUnits, stripLoneSurrogates } from '../../build-plugins/shared/safeTruncate';

const HANDSHAKE = '\u{1F91D}'; // 🤝 = 🤝 (one astral char = 2 UTF-16 code units)
const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('truncateCodeUnits', () => {
  it('returns the input unchanged when within budget', () => {
    expect(truncateCodeUnits('hello world', 50)).toBe('hello world');
    expect(truncateCodeUnits('hello', 5)).toBe('hello');
  });

  it('hard-cuts plain text exactly at the code-unit budget', () => {
    expect(truncateCodeUnits('hello world', 5)).toBe('hello');
  });

  it('never splits a surrogate pair — drops the dangling astral char whole', () => {
    // Boundary lands between the two halves of the emoji.
    const s = `${'x'.repeat(9)}${HANDSHAKE}yyy`; // emoji high surrogate at index 9, low at 10
    const out = truncateCodeUnits(s, 10); // index 10 = low surrogate → back off to 9
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe('x'.repeat(9));
  });

  it('keeps a whole emoji when the boundary lands cleanly after it', () => {
    const s = `${'x'.repeat(8)}${HANDSHAKE}yyy`; // emoji occupies indices 8-9
    const out = truncateCodeUnits(s, 10); // index 10 is past the full pair
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe(`${'x'.repeat(8)}${HANDSHAKE}`);
  });

  it('returns empty string for non-positive budgets', () => {
    expect(truncateCodeUnits('abc', 0)).toBe('');
    expect(truncateCodeUnits('abc', -5)).toBe('');
  });
});

describe('stripLoneSurrogates', () => {
  it('removes an unpaired high surrogate', () => {
    expect(hasLoneSurrogate(stripLoneSurrogates('abc\uD83Edef'))).toBe(false);
  });

  it('removes an unpaired low surrogate', () => {
    expect(hasLoneSurrogate(stripLoneSurrogates('abc\uDD1Ddef'))).toBe(false);
  });

  it('preserves valid surrogate pairs', () => {
    expect(stripLoneSurrogates(`a${HANDSHAKE}b`)).toBe(`a${HANDSHAKE}b`);
  });
});
