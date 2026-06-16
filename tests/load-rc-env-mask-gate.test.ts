import { describe, it, expect } from 'vitest';
import { isTrivialSecret } from '../scripts/load-rc-env.mjs';

// Gate that decides whether an RC value is masked in CI logs.
// Trivial (short/common) values must NOT be masked — masking them poisons
// unrelated output, because GitHub redacts every literal occurrence. Real
// secrets must be masked.
describe('load-rc-env isTrivialSecret', () => {
  it('treats short / common values as trivial (not masked)', () => {
    for (const v of ['0', '1', '36', '12345', 'true', 'false', 'no']) {
      expect(isTrivialSecret(v), `${v} should be trivial`).toBe(true);
    }
  });

  it('treats real secrets (>= 6 chars) as non-trivial (masked)', () => {
    for (const v of [
      'AIzaSyAbcdEfGhExampleKey123', // Google API key
      're_xxxxxxxxxxxx',            // Resend key
      'ghp_aaaaaaaaaaaa',           // GitHub PAT
      'G-XXXXXXX',                  // GA measurement id
      '123456',                     // 6-digit id (e.g. long FB_PAGE_ID)
    ]) {
      expect(isTrivialSecret(v), `${v} should be masked`).toBe(false);
    }
  });

  it('treats non-string / nullish values as trivial (nothing to mask)', () => {
    expect(isTrivialSecret(null as unknown as string)).toBe(true);
    expect(isTrivialSecret(undefined as unknown as string)).toBe(true);
    expect(isTrivialSecret(42 as unknown as string)).toBe(true);
  });

  it('uses a strict length boundary at 6 chars', () => {
    expect(isTrivialSecret('abcde')).toBe(true);  // 5 chars → trivial
    expect(isTrivialSecret('abcdef')).toBe(false); // 6 chars → masked
  });
});
