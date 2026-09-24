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

  // #9609 FU-034: exact output on every boundary shape, compared with an
  // independent regex oracle (lone high at the end, lone low at the start,
  // reversed pair, adjacent lone units, pairs next to lone units).
  it('matches an independent oracle on boundary shapes', () => {
    const oracle = (s: string): string =>
      s.replace(/([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g, (_m, pair: string | undefined) => pair ?? '');
    const shapes = [
      '', 'plain', '\uD83E', '\uDD1D', `\uDD1D${HANDSHAKE}`, `${HANDSHAKE}\uD83E`,
      '\uDD1D\uD83E', '\uD83E\uD83E\uDD1D', `x\uD83E\uD83Ey${HANDSHAKE}\uDD1D\uDD1Dz`,
    ];
    for (const shape of shapes) expect(stripLoneSurrogates(shape)).toBe(oracle(shape));
  });

  // #9609 FU-034: the helper is the defensive pass for text of unknown
  // provenance, so it must stay linear on large inputs. The old
  // per-code-unit `output +=` loop took ~7-14 s on 10M units (one rope node
  // per character); copying clean runs with `slice` takes well under a second.
  it('stays linear on a 10M-unit input with sparse lone surrogates', () => {
    const block = `${'x'.repeat(995)}${HANDSHAKE}\uD83Eyy`;
    const input = block.repeat(10_000);
    const expected = `${'x'.repeat(995)}${HANDSHAKE}yy`.repeat(10_000);
    const started = performance.now();
    const output = stripLoneSurrogates(input);
    const elapsed = performance.now() - started;
    expect(output.length).toBe(expected.length);
    expect(output === expected).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  }, 30_000);
});
