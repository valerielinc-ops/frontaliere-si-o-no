/**
 * MySwitzerland nationwide events crawler (#3125): pure parsing/mapping logic
 * only — no live network calls here (see scripts/crawl-myswitzerland-events.mjs
 * header for the live Algolia + detail-page research this is built from).
 */
import { describe, it, expect } from 'vitest';
import {
  parseCompactUtc,
  zurichParts,
  extractDateInfo,
  humanizeCategory,
  extractPrice,
  extractAddress,
  extractEventJsonLd,
  mapEventRecord,
} from '../scripts/crawl-myswitzerland-events.mjs';

describe('parseCompactUtc', () => {
  it('parses Algolia compact UTC timestamps', () => {
    const d = parseCompactUtc('20260704T173000Z');
    expect(d?.toISOString()).toBe('2026-07-04T17:30:00.000Z');
  });

  it('returns null for malformed or missing input', () => {
    expect(parseCompactUtc('')).toBeNull();
    expect(parseCompactUtc(undefined)).toBeNull();
    expect(parseCompactUtc('2026-07-04')).toBeNull();
  });
});

describe('zurichParts', () => {
  it('converts a UTC instant to Europe/Zurich local date+time (summer, UTC+2)', () => {
    const parts = zurichParts(new Date('2026-07-04T17:30:00.000Z'));
    expect(parts).toEqual({ date: '2026-07-04', time: '19:30' });
  });

  it('converts a UTC instant to Europe/Zurich local date+time (winter, UTC+1)', () => {
    const parts = zurichParts(new Date('2026-01-10T09:00:00.000Z'));
    expect(parts).toEqual({ date: '2026-01-10', time: '10:00' });
  });
});

describe('extractDateInfo', () => {
  it('derives start/end date+time from applicableDates.rules', () => {
    const hit = {
      applicableDates: {
        rules: [{ conditions: { from: '20260704T170000Z', to: '20260704T200000Z' } }],
      },
    };
    const info = extractDateInfo(hit);
    expect(info).toEqual({ startDate: '2026-07-04', startTime: '19:00', endDate: '2026-07-04', recurring: false });
  });

  it('flags recurring:true for multiple rules and spans first→last', () => {
    const hit = {
      applicableDates: {
        rules: [
          { conditions: { from: '20260704T170000Z', to: '20260704T200000Z' } },
          { conditions: { from: '20260711T170000Z', to: '20260711T200000Z' } },
        ],
      },
    };
    const info = extractDateInfo(hit);
    expect(info?.startDate).toBe('2026-07-04');
    expect(info?.endDate).toBe('2026-07-11');
    expect(info?.recurring).toBe(true);
  });

  it('falls back to executionDates (unix seconds) when there are no rules', () => {
    const hit = { executionDates: [1783260600] }; // 2026-07-04T05:30:00Z-ish
    const info = extractDateInfo(hit);
    expect(info?.startDate).toBeTruthy();
    expect(info?.recurring).toBe(false);
  });

  it('returns null when no usable date exists at all', () => {
    expect(extractDateInfo({})).toBeNull();
    expect(extractDateInfo({ applicableDates: { rules: [] }, executionDates: [] })).toBeNull();
  });
});

describe('humanizeCategory', () => {
  it('strips the trailing "Event" and inserts spaces between words', () => {
    expect(humanizeCategory('MusicEvent')).toBe('Music');
    expect(humanizeCategory('Festival')).toBe('Festival');
    expect(humanizeCategory('SportsActivityLocation')).toBe('Sports Activity Location');
  });

  it('returns undefined for missing/blank type', () => {
    expect(humanizeCategory(undefined)).toBeUndefined();
    expect(humanizeCategory('')).toBeUndefined();
  });
});

describe('extractPrice', () => {
  it('returns undefined when there is no offers/isAccessibleForFree info', () => {
    expect(extractPrice({})).toBeUndefined();
    expect(extractPrice(undefined)).toBeUndefined();
  });

  it('reads a single offers object', () => {
    expect(extractPrice({ offers: { price: '25', priceCurrency: 'CHF' } })).toEqual({
      amount: 25,
      currency: 'CHF',
      isFree: false,
    });
  });

  it('takes the cheapest of multiple offers', () => {
    expect(
      extractPrice({
        offers: [
          { price: '40', priceCurrency: 'CHF' },
          { price: '15', priceCurrency: 'CHF' },
        ],
      }),
    ).toEqual({ amount: 15, currency: 'CHF', isFree: false });
  });

  it('flags isAccessibleForFree as a free event', () => {
    expect(extractPrice({ isAccessibleForFree: true })).toEqual({ amount: 0, currency: 'CHF', isFree: true });
  });
});

describe('extractAddress', () => {
  it('reads street + postalCode from location.address', () => {
    expect(
      extractAddress({ location: { address: { streetAddress: 'Piazza Grande 1', postalCode: '6600' } } }),
    ).toEqual({ street: 'Piazza Grande 1', postalCode: '6600' });
  });

  it('returns undefined when address is absent or empty', () => {
    expect(extractAddress({})).toBeUndefined();
    expect(extractAddress({ location: {} })).toBeUndefined();
    expect(extractAddress({ location: { address: {} } })).toBeUndefined();
  });
});

describe('extractEventJsonLd', () => {
  it('picks the Event(-subtype) JSON-LD block and skips unrelated ones', () => {
    const html = `
      <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
      <script type="application/ld+json">{"@type":"MusicEvent","name":"Test","startDate":"2026-07-04T19:00:00+02:00"}</script>
    `;
    const ld = extractEventJsonLd(html);
    expect(ld?.['@type']).toBe('MusicEvent');
    expect(ld?.name).toBe('Test');
  });

  it('returns null when there is no matching block or malformed JSON', () => {
    expect(extractEventJsonLd('')).toBeNull();
    expect(extractEventJsonLd('<html></html>')).toBeNull();
    expect(extractEventJsonLd('<script type="application/ld+json">{not json</script>')).toBeNull();
  });
});

describe('mapEventRecord', () => {
  const hitIt = {
    objectID: 'abc123',
    title: 'Festival della Musica',
    leadText: 'Un grande festival di musica dal vivo.',
    url: '/eventi/festival-della-musica',
    place: 'Lugano',
    image: 'https://cdn.myswitzerland.com/images/abc.jpg',
    _geoloc: { lat: 46.005, lng: 8.951 },
    applicableDates: { rules: [{ conditions: { from: '20260704T170000Z', to: '20260704T200000Z' } }] },
  };
  const hitEn = { ...hitIt, title: 'Music Festival', leadText: 'A great live music festival.' };

  it('returns null when there is no primary-locale hit', () => {
    expect(mapEventRecord('abc123', {})).toBeNull();
  });

  it('returns null when the primary hit has no usable date', () => {
    expect(mapEventRecord('abc123', { it: { ...hitIt, applicableDates: undefined } })).toBeNull();
  });

  it('returns null when there is no title in any locale', () => {
    expect(mapEventRecord('abc123', { it: { ...hitIt, title: '' } })).toBeNull();
  });

  it('maps a single-locale hit to a SiteEvent-shaped record with index-only fields', () => {
    const mapped = mapEventRecord('abc123', { it: hitIt });
    expect(mapped).not.toBeNull();
    const { event, imageSourceUrl, place } = mapped as never as {
      event: Record<string, unknown>;
      imageSourceUrl: string;
      place: string;
    };
    expect(event.id).toBe('myswitzerland:abc123');
    expect(event.title).toBe('Festival della Musica');
    expect(event.titleByLocale).toEqual({ it: 'Festival della Musica' });
    expect(event.description).toBe('Un grande festival di musica dal vivo.');
    expect(event.startDate).toBe('2026-07-04');
    expect(event.startTime).toBe('19:00');
    expect(event.endDate).toBe('2026-07-04');
    expect(event.category).toBe('Event'); // no detail-page enrichment supplied
    expect(event.venue).toBe('Lugano'); // falls back to the index `place`
    expect(event.canton).toBe('');
    expect(event.geo).toEqual({ lat: 46.005, lng: 8.951 });
    expect(event.recurring).toBe(false);
    expect(event.price).toBeUndefined();
    expect(event.address).toBeUndefined();
    expect(imageSourceUrl).toBe('https://cdn.myswitzerland.com/images/abc.jpg');
    expect(place).toBe('Lugano');
    expect(event.url).toBe('https://www.myswitzerland.com/it-ch/eventi/festival-della-musica');
  });

  it('merges it+en hits into titleByLocale/descriptionByLocale, prefers it as canonical title', () => {
    const mapped = mapEventRecord('abc123', { it: hitIt, en: hitEn });
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.title).toBe('Festival della Musica');
    expect(event.titleByLocale).toEqual({ it: 'Festival della Musica', en: 'Music Festival' });
    expect(event.descriptionByLocale).toEqual({
      it: 'Un grande festival di musica dal vivo.',
      en: 'A great live music festival.',
    });
  });

  it('enriches category/price/address/venue from detail-page JSON-LD when available', () => {
    const detailLd = {
      '@type': 'MusicEvent',
      location: {
        name: 'LAC Lugano Arte e Cultura',
        address: { streetAddress: 'Piazza Bernardino Luini 6', postalCode: '6900' },
      },
      offers: { price: '25', priceCurrency: 'CHF' },
    };
    const mapped = mapEventRecord('abc123', { it: hitIt }, { detailLd, detailUrl: 'https://www.myswitzerland.com/it-ch/eventi/festival-della-musica' });
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.category).toBe('Music');
    expect(event.venue).toBe('LAC Lugano Arte e Cultura');
    expect(event.address).toEqual({ street: 'Piazza Bernardino Luini 6', postalCode: '6900' });
    expect(event.price).toEqual({ amount: 25, currency: 'CHF', isFree: false });
    expect(event.url).toBe('https://www.myswitzerland.com/it-ch/eventi/festival-della-musica');
  });
});
