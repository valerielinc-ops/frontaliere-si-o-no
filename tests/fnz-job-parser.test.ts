import { describe, expect, it } from 'vitest';
import { resolveFnzSwissLocation } from '../scripts/lib/fnz-job-parser.mjs';

describe('fnz-job-parser / resolveFnzSwissLocation', () => {
  it('prefers a later specific Swiss candidate over a country-only value', () => {
    expect(resolveFnzSwissLocation(['Switzerland', 'Zurich'])).toEqual({
      raw: 'Zurich',
      location: 'Zurich',
      canton: 'ZH',
    });
  });

  it('preserves a country-only candidate without inventing a city', () => {
    expect(resolveFnzSwissLocation(['Switzerland'])).toEqual({
      raw: 'Switzerland',
      location: 'Switzerland',
      canton: '',
    });
  });

  it('rejects foreign-only candidates', () => {
    expect(resolveFnzSwissLocation(['London, United Kingdom'])).toBeNull();
  });
});
