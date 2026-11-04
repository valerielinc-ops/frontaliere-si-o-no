import { describe, expect, it } from 'vitest';
import { extractEventOfferMetadata, fillEventPeopleDefaults, normalizeEventPeople, withoutAddressPeople } from '../scripts/lib/event-metadata.mjs';

describe('event people metadata', () => {
  it('does not invent the catalog as organizer or use its homepage for a missing host', () => {
    const event = fillEventPeopleDefaults({
      id: 'myswitzerland:event-1',
      url: 'https://events.example.test/event-1',
    }, { label: 'MySwitzerland', homepage: 'https://www.myswitzerland.com/' });
    expect(event.organizer).toBeUndefined();
    expect(event.performer).toBeUndefined();
  });

  it('keeps an event page separate from a named organizer homepage', () => {
    expect(normalizeEventPeople({ '@type': 'Organization', name: 'Museo civico' }, 'https://events.example.test/event-1'))
      .toEqual({ '@type': 'Organization', name: 'Museo civico' });
  });

  it('drops a legacy event-page URL from a named organizer', () => {
    expect(normalizeEventPeople({
      '@type': 'Organization',
      name: 'Museo civico',
      url: 'https://events.example.test/event-1/?campaign=agenda',
    }, 'https://events.example.test/event-1/', 'https://events.example.test/event-1/'))
      .toEqual({ '@type': 'Organization', name: 'Museo civico' });
  });

  it('strips an address suffix despite accent, abbreviation, hyphen, and French article differences', () => {
    const cleaned = withoutAddressPeople({
      venue: 'Musée national suisse',
      address: { street: 'Av. Général Guiguer 3', locality: 'Prangins' },
      organizer: { '@type': 'Organization', name: 'Château de Prangins Avenue du Général-Guiguer 3' },
      performer: { '@type': 'Organization', name: 'Musée national suisse' },
    });
    expect(cleaned.organizer).toEqual({ '@type': 'Organization', name: 'Château de Prangins' });
    expect(cleaned.performer).toBeUndefined();
  });
});

describe('event Offer metadata', () => {
  it('normalizes every supported Schema.org ticket availability state', () => {
    const states = [
      'BackOrder', 'Discontinued', 'InStock', 'InStoreOnly', 'LimitedAvailability', 'MadeToOrder',
      'OnlineOnly', 'OutOfStock', 'PreOrder', 'PreSale', 'Reserved', 'SoldOut',
    ];
    for (const availability of states) {
      expect(extractEventOfferMetadata({
        '@type': 'Offer', price: 25, priceCurrency: 'CHF', availability,
      }, 'https://events.example.test/event/')).toMatchObject({
        availability: `https://schema.org/${availability}`,
      });
    }
  });

  it('drops unknown availability URLs instead of publishing invalid schema values', () => {
    expect(extractEventOfferMetadata({
      '@type': 'Offer', price: 25, priceCurrency: 'CHF', availability: 'https://example.test/InStock',
    }, 'https://events.example.test/event/')).toBeUndefined();
  });

  it('normalizes validFrom offsets and drops impossible source dates', () => {
    expect(extractEventOfferMetadata({
      '@type': 'Offer', price: 25, priceCurrency: 'CHF', validFrom: '2026-10-16T20:15:00+0200',
    }, 'https://events.example.test/event/')).toMatchObject({
      validFrom: '2026-10-16T20:15:00+02:00',
    });
    expect(extractEventOfferMetadata({
      '@type': 'Offer', price: 25, priceCurrency: 'CHF', validFrom: '2026-02-31T20:15:00+0100',
    }, 'https://events.example.test/event/')).toBeUndefined();
  });
});
