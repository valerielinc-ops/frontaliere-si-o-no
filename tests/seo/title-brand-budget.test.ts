import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('budget dei title', () => {
  it('le pagine scritte a mano non superano 60 caratteri col brand', () => {
    const source = readFileSync(new URL('../../services/seo/seo-pages.ts', import.meta.url), 'utf8');
    const long = [...source.matchAll(/\n title: '([^'\n]+ \| Frontaliere Ticino)'/g)].map(m => m[1]).filter(t => t.length > 60);
    expect(long).toEqual([]);
  });
});
