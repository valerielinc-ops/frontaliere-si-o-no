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
      streetAddress: 'Via della Prova 1',
      addressLocality: 'Bellinzona',
      addressRegion: 'TI',
      postalCode: '6500',
      addressCountry: 'CH',
    },
  },
};

describe('validateEventStructuredData', () => {
  it('accepts Google required Event properties without optional recommendations', () => {
    expect(validateEventStructuredData(EVENT, '/dist/event/index.html')).toEqual([]);
  });

  it('accepts supported Event status arrays and rejects arrays with unknown members', () => {
    const valid = validateEventStructuredData({
      ...EVENT,
      eventStatus: ['https://schema.org/EventScheduled', 'https://schema.org/EventPostponed'],
    }, '/dist/event/index.html');
    expect(valid).toEqual([]);

    const invalid = validateEventStructuredData({
      ...EVENT,
      eventStatus: ['https://schema.org/EventScheduled', 'https://schema.org/EventUnknown'],
    }, '/dist/event/index.html');
    expect(invalid.map(({ field }) => field)).toContain('eventStatus');

    const movedOnline = validateEventStructuredData({
      ...EVENT,
      eventStatus: ['https://schema.org/EventScheduled', 'https://schema.org/EventMovedOnline'],
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      location: { '@type': 'VirtualLocation', url: 'https://example.test/events/concerto/stream/' },
    }, '/dist/event/index.html');
    expect(movedOnline).toEqual([]);
  });

  it('accepts EventMovedOnline and rejects an end date before the start instant', () => {
    expect(validateEventStructuredData({
      ...EVENT,
      eventStatus: 'https://schema.org/EventMovedOnline',
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      location: { '@type': 'VirtualLocation', url: 'https://example.test/events/concerto/stream/' },
    }, '/dist/event/index.html')).toEqual([]);

    const errors = validateEventStructuredData({
      ...EVENT,
      endDate: '2026-07-04T19:00:00+02:00',
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('endDate');

    const offlineEvent = validateEventStructuredData({
      ...EVENT,
      eventStatus: 'https://schema.org/EventMovedOnline',
    }, '/dist/event/index.html');
    expect(offlineEvent.map(({ field }) => field)).toContain('eventAttendanceMode');
  });

  it('trims accepted date-time values before comparing timezone-free instants', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      startDate: ' 2024-01-02T01:00',
      endDate: '2024-01-02T00:30Z',
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('endDate');
  });

  it('requires a named physical location and PostalAddress details', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      location: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'CH' } },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('location.name');
    expect(errors.map(({ field }) => field)).toContain('location.address');
  });

  it('validates physical and virtual locations against the attendance mode', () => {
    const virtualLocation = {
      '@type': ['Thing', 'VirtualLocation'],
      url: 'https://example.test/events/concerto/stream/',
    };
    const physicalLocation = {
      ...EVENT.location,
      '@type': ['Thing', 'Place'],
      address: { ...EVENT.location.address, '@type': ['Thing', 'PostalAddress'] },
    };

    expect(validateEventStructuredData({
      ...EVENT,
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      location: virtualLocation,
    }, '/dist/event/index.html')).toEqual([]);

    expect(validateEventStructuredData({
      ...EVENT,
      eventAttendanceMode: 'https://schema.org/MixedEventAttendanceMode',
      location: [physicalLocation, virtualLocation],
    }, '/dist/event/index.html')).toEqual([]);

    const onlineWithPhysical = validateEventStructuredData({
      ...EVENT,
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    }, '/dist/event/index.html');
    expect(onlineWithPhysical.map(({ field }) => field)).toContain('location.@type');
    expect(onlineWithPhysical.map(({ field }) => field)).toContain('location');

    const offlineWithVirtual = validateEventStructuredData({
      ...EVENT,
      location: virtualLocation,
    }, '/dist/event/index.html');
    expect(offlineWithVirtual.map(({ field }) => field)).toContain('location.@type');

    const mixedWithoutVirtual = validateEventStructuredData({
      ...EVENT,
      eventAttendanceMode: 'https://schema.org/MixedEventAttendanceMode',
    }, '/dist/event/index.html');
    expect(mixedWithoutVirtual.map(({ field }) => field)).toContain('location');
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

  it('rejects a partial physical address that the Event renderer cannot publish', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      location: {
        ...EVENT.location,
        address: { '@type': 'PostalAddress', streetAddress: 'Via della Prova 1' },
      },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('location.address');
  });

  it('rejects non-string members in a location @type array without throwing', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      location: { ...EVENT.location, '@type': [null, 'Place'] },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('location.@type');
  });

  it('rejects well-formed but unknown currency codes', () => {
    const errors = validateEventStructuredData({
      ...EVENT,
      offers: { '@type': 'Offer', price: 25, priceCurrency: 'ZZZ' },
    }, '/dist/event/index.html');
    expect(errors.map(({ field }) => field)).toContain('offers.priceCurrency');
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
