/**
 * `flatString` is a memory helper whose effect is invisible to `===`, so the
 * risk is not that it stops flattening (tests/seo/bfs-audit-path-retention.ts
 * and tests/seo/duplicate-meta-description-heap.ts measure that) but that it
 * quietly changes CONTENT while doing it — the round-trip goes through a utf8
 * encoder, and every caller uses its output as a lookup key.
 */
import { describe, expect, it } from 'vitest';
import { flatString } from '../scripts/lib/flat-string.mjs';

describe('flatString', () => {
  it('is content-exact for the path and URL shapes the audits feed it', () => {
    for (const s of [
      '/articoli-frontaliere/tutti/page-21',
      'https://frontaliereticino.ch/stipendi/infermiere-ticino',
      '/città-di-lugano/perché-è-così',
      '/emoji-nel-titolo-🇨🇭-ticino',
      '/tab\tnewline\nspazi   multipli',
      '',
      '/',
      '/breve',
    ]) {
      expect(flatString(s)).toBe(s);
    }
  });

  it('returns a string that is still a plain primitive, not a wrapper', () => {
    const out = flatString('/articoli-frontaliere/tutti/page-21');
    expect(typeof out).toBe('string');
    expect(out.length).toBe('/articoli-frontaliere/tutti/page-21'.length);
  });

  it('passes non-strings through untouched, so a null path stays null', () => {
    // normaliseInternalPath returns null for external/invalid hrefs and the
    // callers test for it — wrapping must not turn that into the string 'null'.
    expect(flatString(null as unknown as string)).toBeNull();
    expect(flatString(undefined as unknown as string)).toBeUndefined();
  });
});
