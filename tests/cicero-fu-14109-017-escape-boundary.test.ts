import { describe, expect, it } from 'vitest';

import {
  decodeTsStringEscapeSequence,
  decodeTsStringEscapes,
} from '../packages/articles/engine/shared/tsStringEscapes';

describe('FU-2026-10-20-017 TypeScript string escape boundary', () => {
  it('preserves invalid code-point escapes instead of emitting a replacement character', () => {
    expect(decodeTsStringEscapeSequence('u{110000}')).toBeUndefined();
    expect(decodeTsStringEscapes(String.raw`prefix\u{110000}suffix`))
      .toBe(String.raw`prefix\u{110000}suffix`);
  });
});
