import { describe, expect, it } from 'vitest';
import { jobsSeoHtmlCacheKey } from '../../build-plugins/shared/jobsSeoHtmlCache';

describe('Jobs SEO HTML cache keys', () => {
  it('keeps equal localized slugs in different canton paths separate', () => {
    const zurich = jobsSeoHtmlCacheKey('it', '/cerca-lavoro-zurigo/shared-role/');
    const ticino = jobsSeoHtmlCacheKey('it', 'cerca-lavoro-ticino/shared-role/');
    expect(zurich).not.toBe(ticino);
  });

  it('normalizes leading and trailing slashes consistently', () => {
    expect(jobsSeoHtmlCacheKey('it', '/cerca-lavoro-ticino/role/'))
      .toBe(jobsSeoHtmlCacheKey('it', 'cerca-lavoro-ticino/role'));
  });
});
