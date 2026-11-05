import { describe, expect, it } from 'vitest';
import { hasCompleteGoogleEventData } from '../packages/articles/engine/shared/googleEventDataQuality.mjs';

type AddressFixture = {
  '@type': string | string[];
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
};

type EventLocationFixture = {
  '@type': string | string[];
  name?: string;
  address?: AddressFixture;
  url?: string;
};

type EntityFixture = { '@type': string; name: string; url?: string };

type OfferFixture = {
  '@type': string;
  price?: number;
  priceCurrency?: string;
  availability?: string | string[];
  validFrom?: string;
  url?: string;
};

type EventFixture = {
  '@context': string;
  '@type': string;
  name: string;
  startDate: string;
  endDate?: string;
  eventStatus: string | string[];
  eventAttendanceMode: string;
  previousStartDate?: string | string[];
  isAccessibleForFree?: boolean;
  url: string;
  description: string;
  image: string;
  location: EventLocationFixture | EventLocationFixture[];
  performer?: EntityFixture;
  organizer?: EntityFixture | EntityFixture[];
  offers: OfferFixture | OfferFixture[];
};

function singleOffer(event: EventFixture): OfferFixture {
  const offer = Array.isArray(event.offers) ? event.offers[0] : event.offers;
  if (!offer) throw new Error('Expected an event fixture with one offer');
  return offer;
}

const COMPLETE_EVENT: EventFixture = {
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: 'Concerto di prova',
  startDate: '2026-12-01T19:00:00+01:00',
  endDate: '2026-12-01T21:00:00+01:00',
  eventStatus: 'https://schema.org/EventScheduled',
  eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  url: 'https://example.test/events/concerto/',
  description: 'Un concerto di prova con informazioni complete sulla serata.',
  image: 'https://example.test/images/concerto.webp',
  location: {
    '@type': 'Place',
    name: 'Sala di prova',
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Via della Prova 1',
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      postalCode: '6900',
      addressCountry: 'CH',
    },
  },
  performer: { '@type': 'Person', name: 'Artista di prova' },
  organizer: { '@type': 'Organization', name: 'Organizzatore di prova', url: 'https://example.test/organizer/' },
  offers: {
    '@type': 'Offer',
    price: 25,
    priceCurrency: 'CHF',
    availability: 'https://schema.org/InStock',
    validFrom: '2026-10-01',
    url: 'https://tickets.example.test/concerto/',
  },
};

describe('Google Event data quality publication gate', () => {
  it('accepts complete Event data with source-backed ticket details', () => {
    expect(hasCompleteGoogleEventData(COMPLETE_EVENT)).toBe(true);
  });

  it('validates every offer in an offers array', () => {
    const event = structuredClone(COMPLETE_EVENT);
    const offer = singleOffer(event);
    event.offers = [offer, { ...offer, price: 35, url: 'https://tickets.example.test/concerto-vip/' }];
    expect(hasCompleteGoogleEventData(event)).toBe(true);

    const offers = event.offers;
    if (!Array.isArray(offers)) throw new Error('Expected an offers array');
    delete offers[1].url;
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('accepts physical locations with locality and country when street and postal code are unavailable', () => {
    const event = structuredClone(COMPLETE_EVENT);
    const address = (event.location as EventLocationFixture).address as AddressFixture;
    delete address.streetAddress;
    delete address.postalCode;
    expect(hasCompleteGoogleEventData(event)).toBe(true);
  });

  it('compares event dates as instants after normalizing timezone offsets', () => {
    const event = structuredClone(COMPLETE_EVENT);
    event.startDate = '2026-12-01T19:00:00+01:00';
    event.endDate = '2026-12-01T19:30:00+02:00';
    expect(hasCompleteGoogleEventData(event)).toBe(false);

    event.endDate = '2026-12-01T20:30:00+02:00';
    expect(hasCompleteGoogleEventData(event)).toBe(true);
  });

  it('compares timezone-free ISO dates as UTC consistently across host timezones', () => {
    const event = structuredClone(COMPLETE_EVENT);
    event.startDate = '2025-07-21T00:15';
    event.endDate = '2025-07-21';
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it.each([
    ['endDate', (event) => { delete event.endDate; }],
    ['performer', (event) => { delete event.performer; }],
    ['organizer', (event) => { delete event.organizer; }],
    ['organizer URL', (event) => { delete (event.organizer as EntityFixture).url; }],
    ['location.name', (event) => { delete (event.location as EventLocationFixture).name; }],
    ['offer price', (event) => { delete singleOffer(event).price; }],
    ['offer currency', (event) => { delete singleOffer(event).priceCurrency; }],
    ['offer availability', (event) => { delete singleOffer(event).availability; }],
    ['ticket URL', (event) => { delete singleOffer(event).url; }],
  ])('rejects missing %s', (_field, removeField) => {
    const event = structuredClone(COMPLETE_EVENT);
    removeField(event);
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('does not infer a validFrom date or free admission', () => {
    const event = structuredClone(COMPLETE_EVENT);
    delete singleOffer(event).validFrom;
    expect(hasCompleteGoogleEventData(event)).toBe(true);

    const invalidValidFrom = structuredClone(COMPLETE_EVENT);
    singleOffer(invalidValidFrom).validFrom = '2026-02-31';
    expect(hasCompleteGoogleEventData(invalidValidFrom)).toBe(false);

    const freeEvent = structuredClone(COMPLETE_EVENT);
    singleOffer(freeEvent).price = 0;
    expect(hasCompleteGoogleEventData(freeEvent)).toBe(false);

    freeEvent.isAccessibleForFree = true;
    expect(hasCompleteGoogleEventData(freeEvent)).toBe(true);
  });

  it('requires the previous date when an event is rescheduled', () => {
    const event = structuredClone(COMPLETE_EVENT);
    event.eventStatus = 'https://schema.org/EventRescheduled';
    expect(hasCompleteGoogleEventData(event)).toBe(false);

    event.previousStartDate = '2026-11-30';
    expect(hasCompleteGoogleEventData(event)).toBe(true);

    event.previousStartDate = ['2026-11-30', '2026-11-29'];
    expect(hasCompleteGoogleEventData(event)).toBe(true);

    event.previousStartDate = ['2026-11-30', '2026-02-31'];
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('rejects an empty previousStartDate on a non-rescheduled event', () => {
    const event = structuredClone(COMPLETE_EVENT);
    event.previousStartDate = '';
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('accepts valid ISO local datetimes without a timezone offset', () => {
    const event = structuredClone(COMPLETE_EVENT);
    event.startDate = '2025-07-21T19:00';
    event.endDate = '2025-07-21T21:30';
    expect(hasCompleteGoogleEventData(event)).toBe(true);

    event.startDate = '2025-07-21T25:00';
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('rejects impossible calendar dates and accepts complete organizer arrays', () => {
    const invalidDate = structuredClone(COMPLETE_EVENT);
    invalidDate.startDate = '2026-02-31';
    expect(hasCompleteGoogleEventData(invalidDate)).toBe(false);

    const organizers = structuredClone(COMPLETE_EVENT);
    organizers.organizer = [
      organizers.organizer as EntityFixture,
      { '@type': 'Organization', name: 'Second organizer', url: 'https://example.test/second-organizer/' },
    ];
    expect(hasCompleteGoogleEventData(organizers)).toBe(true);
  });

  it('accepts complete online and mixed attendance locations', () => {
    const online = structuredClone(COMPLETE_EVENT);
    online.eventAttendanceMode = 'https://schema.org/OnlineEventAttendanceMode';
    online.location = {
      '@type': 'VirtualLocation',
      url: 'https://example.test/events/concerto/stream/',
    };
    expect(hasCompleteGoogleEventData(online)).toBe(true);

    const mixed = structuredClone(COMPLETE_EVENT);
    mixed.eventAttendanceMode = 'https://schema.org/MixedEventAttendanceMode';
    mixed.location = [
      mixed.location as EventLocationFixture,
      { '@type': 'VirtualLocation', url: 'https://example.test/events/concerto/stream/' },
    ];
    expect(hasCompleteGoogleEventData(mixed)).toBe(true);

    const incompleteMixed = structuredClone(COMPLETE_EVENT);
    incompleteMixed.eventAttendanceMode = 'https://schema.org/MixedEventAttendanceMode';
    expect(hasCompleteGoogleEventData(incompleteMixed)).toBe(false);
  });

  it('accepts events moved online when their location matches the attendance mode', () => {
    const event = structuredClone(COMPLETE_EVENT);
    event.eventStatus = 'https://schema.org/EventMovedOnline';
    event.eventAttendanceMode = 'https://schema.org/OnlineEventAttendanceMode';
    event.location = {
      '@type': 'VirtualLocation',
      url: 'https://example.test/events/concerto/stream/',
    };
    expect(hasCompleteGoogleEventData(event)).toBe(true);
  });

  it('requires every Event status to be supported and availability to be scalar', () => {
    const validStatuses = structuredClone(COMPLETE_EVENT);
    validStatuses.eventStatus = [
      'https://schema.org/EventScheduled',
      'https://schema.org/EventPostponed',
    ];
    expect(hasCompleteGoogleEventData(validStatuses)).toBe(true);

    const mixedStatuses = structuredClone(validStatuses);
    mixedStatuses.eventStatus = [
      ...validStatuses.eventStatus as string[],
      'https://schema.org/EventUnknown',
    ];
    expect(hasCompleteGoogleEventData(mixedStatuses)).toBe(false);

    const mixedAvailability = structuredClone(COMPLETE_EVENT);
    singleOffer(mixedAvailability).availability = [
      'https://schema.org/InStock',
      'https://example.test/Unknown',
    ];
    expect(hasCompleteGoogleEventData(mixedAvailability)).toBe(false);

    const foreignAvailability = structuredClone(COMPLETE_EVENT);
    singleOffer(foreignAvailability).availability = 'https://example.test/InStock';
    expect(hasCompleteGoogleEventData(foreignAvailability)).toBe(false);
  });

  it('rejects EventMovedOnline with an offline attendance mode', () => {
    const event = structuredClone(COMPLETE_EVENT);
    event.eventStatus = 'https://schema.org/EventMovedOnline';
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('rejects location types that do not match the attendance mode', () => {
    const virtualLocation = {
      '@type': 'VirtualLocation',
      url: 'https://example.test/events/concerto/stream/',
    };

    const offlineWithVirtual = structuredClone(COMPLETE_EVENT);
    offlineWithVirtual.location = [offlineWithVirtual.location as EventLocationFixture, virtualLocation];
    expect(hasCompleteGoogleEventData(offlineWithVirtual)).toBe(false);

    const onlineWithPhysical = structuredClone(COMPLETE_EVENT);
    onlineWithPhysical.eventAttendanceMode = 'https://schema.org/OnlineEventAttendanceMode';
    expect(hasCompleteGoogleEventData(onlineWithPhysical)).toBe(false);

    const onlineWithMixedLocations = structuredClone(onlineWithPhysical);
    onlineWithMixedLocations.location = [onlineWithMixedLocations.location as EventLocationFixture, virtualLocation];
    expect(hasCompleteGoogleEventData(onlineWithMixedLocations)).toBe(false);
  });

  it('rejects @type arrays containing non-string members', () => {
    const event = structuredClone(COMPLETE_EVENT);
    (event.location as unknown as Record<string, unknown>)['@type'] = [null, 'Place'];
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('accepts only currencies in the canonical ISO-4217 set', () => {
    const valid = structuredClone(COMPLETE_EVENT);
    singleOffer(valid).priceCurrency = 'CHF';
    expect(hasCompleteGoogleEventData(valid)).toBe(true);

    for (const priceCurrency of ['XXX', 'ZZZ']) {
      const invalid = structuredClone(COMPLETE_EVENT);
      singleOffer(invalid).priceCurrency = priceCurrency;
      expect(hasCompleteGoogleEventData(invalid)).toBe(false);
    }
  });
});
