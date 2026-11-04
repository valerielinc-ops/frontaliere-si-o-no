import { describe, expect, it } from 'vitest';
import { hasCompleteGoogleEventData } from '../packages/articles/engine/shared/googleEventDataQuality.mjs';

const COMPLETE_EVENT = {
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
    ['location.name', (event) => { delete event.location.name; }],
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
  });
});
