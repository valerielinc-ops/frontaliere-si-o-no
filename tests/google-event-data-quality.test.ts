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
  availability?: string;
  validFrom?: string;
  url?: string;
};

type EventFixture = {
  '@context': string;
  '@type': string;
  name: string;
  startDate: string;
  endDate?: string;
  eventStatus: string;
  eventAttendanceMode: string;
  previousStartDate?: string;
  isAccessibleForFree?: boolean;
  url: string;
  description: string;
  image: string;
  location: EventLocationFixture | EventLocationFixture[];
  performer?: EntityFixture;
  organizer?: EntityFixture | EntityFixture[];
  offers: OfferFixture;
};

const COMPLETE_EVENT: EventFixture = {
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: 'Concerto di prova',
  startDate: '2026-12-01T19:00:00+01:00',
  endDate: '2026-12-01',
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

  it.each([
    ['endDate', (event) => { delete event.endDate; }],
    ['performer', (event) => { delete event.performer; }],
    ['organizer', (event) => { delete event.organizer; }],
    ['organizer URL', (event) => { delete (event.organizer as EntityFixture).url; }],
    ['location.name', (event) => { delete (event.location as EventLocationFixture).name; }],
    ['offer price', (event) => { delete event.offers.price; }],
    ['offer currency', (event) => { delete event.offers.priceCurrency; }],
    ['offer availability', (event) => { delete event.offers.availability; }],
    ['offer validFrom', (event) => { delete event.offers.validFrom; }],
    ['ticket URL', (event) => { delete event.offers.url; }],
  ])('rejects missing %s', (_field, removeField) => {
    const event = structuredClone(COMPLETE_EVENT);
    removeField(event);
    expect(hasCompleteGoogleEventData(event)).toBe(false);
  });

  it('does not infer a validFrom date or free admission', () => {
    const event = structuredClone(COMPLETE_EVENT);
    delete event.offers.validFrom;
    expect(hasCompleteGoogleEventData(event)).toBe(false);

    const freeEvent = structuredClone(COMPLETE_EVENT);
    freeEvent.offers.price = 0;
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

  it('accepts only currencies in the canonical ISO-4217 set', () => {
    const valid = structuredClone(COMPLETE_EVENT);
    valid.offers.priceCurrency = 'CHF';
    expect(hasCompleteGoogleEventData(valid)).toBe(true);

    for (const priceCurrency of ['XXX', 'ZZZ']) {
      const invalid = structuredClone(COMPLETE_EVENT);
      invalid.offers.priceCurrency = priceCurrency;
      expect(hasCompleteGoogleEventData(invalid)).toBe(false);
    }
  });
});
