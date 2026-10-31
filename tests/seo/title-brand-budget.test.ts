import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TITLE_BRAND_SUFFIX, buildTitleWithBrand } from '../../build-plugins/shared/titleSuffix';

describe('budget dei title', () => {
  it('il brand entra solo se il title resta entro 60 caratteri', () => {
    const fits = 'x'.repeat(60 - TITLE_BRAND_SUFFIX.length);
    expect(buildTitleWithBrand(fits)).toBe(fits + TITLE_BRAND_SUFFIX);
    const over = `${fits}y`;
    expect(buildTitleWithBrand(over)).toBe(over);
  });

  it('le pagine scritte a mano non superano 60 caratteri col brand', () => {
    const source = readFileSync(new URL('../../services/seo/seo-pages.ts', import.meta.url), 'utf8');
    const long = [...source.matchAll(/\n title: '([^'\n]+ \| Frontaliere Ticino)'/g)].map(m => m[1]).filter(t => t.length > 60);
    expect(long).toEqual([]);
  });
});
