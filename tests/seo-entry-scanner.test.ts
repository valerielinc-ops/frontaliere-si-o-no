import { describe, expect, it } from 'vitest';
import { findAllSeoEntryMatches } from '../packages/articles/engine/shared/seo-entry.mjs';

describe('SEO entry lexical resolver', () => {
  it('keeps a regex after object spread opaque', () => {
    const source = [
      'const seo = {',
      "  'blog-demo': { value: {.../foo[}]/ } },",
      "  'blog-next': { value: 'ok' },",
      '};',
    ].join('\n');
    const matches = findAllSeoEntryMatches(source, 'fixture');

    expect(matches.map(({ id }) => id)).toEqual(['demo', 'next']);
    expect(source.slice(matches[0].openIdx, matches[0].closeIdx + 1))
      .toContain('.../foo[}]/');
    expect(matches[0].closeIdx).toBe(source.indexOf("},\n  'blog-next'"));
  });
});
