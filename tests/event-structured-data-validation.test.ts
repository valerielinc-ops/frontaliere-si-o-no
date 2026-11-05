import { describe, expect, it } from 'vitest';
import { validateEventStructuredData } from '../scripts/lib/event-structured-data-validation.mjs';

const EVENT = {
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: 'Concerto al teatro',
  startDate: '2026-07-04T20:00:00+02:00',
  location: {
    '@type': 'Place',
    name: 'Teatro Sociale',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Bellinzona',
      addressCountry: 'CH',
    },
  },
};

describe('validateEventStructuredData', () => {
  it('accepts Google required Event properties without optional recommendations', () => {
    expect(validateEventStructuredData(EVENT, '/dist/event/index.html')).toEqual([]);
  });

  it('requires a named physical location and PostalAddress details', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      location: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'CH' } },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('location.name');
    expect(errors.map(({ field }) => field)).toContain('location.address');
  });

  it('does not treat a venue name copied into PostalAddress.name as an address', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      location: {
        ...EVENT.location,
        address: { '@type': 'PostalAddress', name: 'Freizeitstätte Langnau', addressCountry: 'CH' },
      },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('location.address');
  });

  it('rejects an empty Offer instead of treating unknown price as complete', () => {
    const errors = validateEventStructuredData({ ...EVENT, offers: { '@type': 'Offer' } }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('offers.price');
    expect(errors.map(({ field }) => field)).toContain('offers.priceCurrency');
  });

  it('accepts a verified price without inventing availability, sale date, or ticket URL', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      offers: { '@type': 'Offer', price: 25, priceCurrency: 'CHF' },
    }, '/dist/event/index.html');
    expect(errors).toEqual([]);
  });

  it('accepts ISO timezone offsets with or without a colon', () => {
    expect(validateEventStructuredData({
      ...EVENT,
      offers: { '@type': 'Offer', price: 25, priceCurrency: 'CHF', validFrom: '2026-10-16T20:15:00+0200' },
    }, '/dist/event/index.html')).toEqual([]);
  });

  it('requires a zero-price offer to agree with the free-access claim', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      offers: { '@type': 'Offer', price: 0, priceCurrency: 'CHF' },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('offers.price');
  });

  it.each([
    'BackOrder',
    'Discontinued',
    'InStock',
    'InStoreOnly',
    'LimitedAvailability',
    'MadeToOrder',
    'OnlineOnly',
    'OutOfStock',
    'PreOrder',
    'PreSale',
    'Reserved',
    'SoldOut',
  ])('accepts Schema.org availability %s', (availability) => {
    expect(validateEventStructuredData({
      ...EVENT,
      offers: { '@type': 'Offer', price: 25, priceCurrency: 'CHF', availability: `https://schema.org/${availability}` },
    }, '/dist/event/index.html')).toEqual([]);
  });

  it('rejects an availability URL outside Schema.org', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      offers: { '@type': 'Offer', price: 25, priceCurrency: 'CHF', availability: 'https://example.test/InStock' },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('offers.availability');
  });
});
