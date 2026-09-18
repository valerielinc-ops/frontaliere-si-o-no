import { describe, expect, it } from 'vitest';
import { resolveSwissStructuredAddress } from '../scripts/lib/swiss-structured-address.mjs';

describe('resolveSwissStructuredAddress', () => {
  it('uses a coherent canton fallback when no local street is curated', () => {
    const address = resolveSwissStructuredAddress({ city: 'Bioggio', canton: 'TI' });

    expect(address).toMatchObject({
      city: 'Bellinzona',
      canton: 'TI',
      postalCode: '6500',
      streetAddress: 'Piazza Governo',
    });
    expect(address.streetAddress).not.toBe(address.city);
  });

  it('uses a complete canton-capital fallback when the municipality CAP is unknown', () => {
    expect(resolveSwissStructuredAddress({ city: 'Küsnacht', canton: 'ZH' })).toEqual({
      city: 'Zürich',
      canton: 'ZH',
      postalCode: '8001',
      streetAddress: 'Bahnhofstrasse 1',
    });
  });

  it('keeps a known municipality when no curated street fallback exists', () => {
    expect(resolveSwissStructuredAddress({ city: 'Winterthur', canton: 'ZH' })).toEqual({
      city: 'Winterthur',
      canton: 'ZH',
      postalCode: '8400',
      streetAddress: 'Stadthausstrasse 4a',
    });
  });
});
