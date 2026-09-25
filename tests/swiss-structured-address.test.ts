import { describe, expect, it } from 'vitest';
import { resolveLocalityAddress, resolveSwissStructuredAddress } from '../scripts/lib/swiss-structured-address.mjs';

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

describe('resolveLocalityAddress (issue 5253)', () => {
  it('keeps the vacancy municipality instead of the canton-capital tuple', () => {
    const pully = resolveLocalityAddress({ city: 'Pully', canton: 'VD' });
    expect(pully.addressLocality).toBe('Pully');
    // Mai la via o l'NPA di Lausanne accanto a Pully.
    expect(pully.streetAddress).toBe('');
    expect(pully.postalCode).not.toBe('1003');
    expect(resolveLocalityAddress({ city: 'Buchs SG', canton: 'SG' }).addressLocality).toBe('Buchs SG');
    expect(resolveLocalityAddress({ city: 'St Moritz', canton: 'GR' })).toEqual({
      addressLocality: 'St Moritz',
      postalCode: '7500',
      streetAddress: '',
    });
  });

  it('returns the coherent fallback when it names the same locality or the value is no municipality', () => {
    expect(resolveLocalityAddress({ city: 'Lausanne', canton: 'VD' }).streetAddress).toBe('Place de la Palud 2');
    expect(resolveLocalityAddress({ city: 'Geneva', canton: 'GE' }).addressLocality).toBe('Genève');
    // Un'etichetta d'agenzia non è una località da pubblicare.
    expect(resolveLocalityAddress({ city: 'GA Wil', canton: 'SG' }).addressLocality).toBe('St. Gallen');
  });
});
