import { describe, expect, it } from 'vitest';
import { resolveFnzSwissLocation } from '../scripts/lib/fnz-job-parser.mjs';

describe('fnz-job-parser / resolveFnzSwissLocation', () => {
  it('skips a generic country candidate and resolves a later Zurich office', () => {
    expect(resolveFnzSwissLocation(['Switzerland', 'Zurich'])).toEqual({
      raw: 'Zurich',
      location: 'Zurich',
      canton: 'ZH',
    });
  });

  it('does not invent a city for a country-only candidate', () => {
    expect(resolveFnzSwissLocation(['Switzerland'])).toBeNull();
  });

  it('rejects foreign-only candidates', () => {
    expect(resolveFnzSwissLocation(['London, United Kingdom'])).toBeNull();
  });
});
