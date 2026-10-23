import { describe, expect, it } from 'vitest';

import { decodeTsStringEscapes } from '../packages/articles/engine/shared/tsStringEscapes';

describe('FU-2026-10-20-017 — TypeScript escape runtime parity', () => {
  it('decodes adjacent extended escapes once without rescanning their output', () => {
    const decoded = decodeTsStringEscapes(String.raw`hex=\x41 codepoint=\u{1F600} nul=\0 literal=\x5c\u006e`);

    expect(decoded).toBe(`hex=A codepoint=😀 nul=${String.fromCharCode(0)} literal=\\n`);
  });
});
