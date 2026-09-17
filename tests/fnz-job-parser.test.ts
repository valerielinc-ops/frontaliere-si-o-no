import { describe, expect, it } from 'vitest';
import { resolveFnzSwissLocation } from '../scripts/lib/fnz-job-parser.mjs';

describe('fnz-job-parser / resolveFnzSwissLocation', () => {
  it('prefers a later specific Swiss candidate over a country-only value', () => {
    expect(resolveFnzSwissLocation(['Switzerland', 'Zurich'])).toEqual({
      raw: 'Zurich',
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('uses the richer requisition location when the listing says only Switzerland', () => {
    expect(resolveFnzSwissLocation([
      'Switzerland',
      {
        descriptor: 'CH Zurich',
        country: { descriptor: 'Switzerland', alpha2Code: 'CH' },
      },
    ])).toEqual({
      raw: 'CH Zurich',
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('uses address and CAP fields when the location descriptor is only Switzerland', () => {
    expect(resolveFnzSwissLocation([{
      descriptor: 'Switzerland',
      address: '8001 Zürich',
      postalCode: '8001',
    }])).toEqual({
      raw: 'Switzerland',
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('rejects a city and richer address signal that point to different cantons', () => {
    expect(resolveFnzSwissLocation([{
      descriptor: 'CH Zurich',
      addressLocality: 'Chiasso',
      postalCode: '8001',
    }])).toBeNull();
  });

  it('rejects an unresolved country-only candidate instead of inventing Chiasso', () => {
    const resolved = resolveFnzSwissLocation(['Switzerland']);

    expect(resolved).toBeNull();
    expect(resolved?.location).not.toBe('Chiasso');
  });

  it('rejects foreign-only candidates', () => {
    expect(resolveFnzSwissLocation(['London, United Kingdom'])).toBeNull();
  });
});
