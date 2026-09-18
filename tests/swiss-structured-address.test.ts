import { describe, expect, it } from 'vitest';
import { resolveSwissStructuredAddress } from '../scripts/lib/swiss-structured-address.mjs';

describe('resolveSwissStructuredAddress', () => {
  it('keeps the real municipality when its Swiss postal code is known', () => {
    const address = resolveSwissStructuredAddress({ city: 'Bioggio', canton: 'TI' });

    expect(address).toMatchObject({
      city: 'Bioggio',
      canton: 'TI',
      postalCode: '6934',
      streetAddress: 'Bioggio',
    });
    expect(address.city).not.toBe('Bellinzona');
  });

  it('uses a complete canton-capital fallback when the municipality CAP is unknown', () => {
    expect(resolveSwissStructuredAddress({ city: 'Küsnacht', canton: 'ZH' })).toEqual({
      city: 'Zürich',
      canton: 'ZH',
      postalCode: '8001',
      streetAddress: 'Zürich',
    });
  });
});
