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
  extractDetailTableValue,
  extractAddress,
  extractDetailAddress,
  extractEventJsonLd,
  mergeDetailEventMetadata,
  detailEnrichmentReady,
  mapEventRecord,
} from '../scripts/crawl-myswitzerland-events.mjs';
import {
  extractDetailContactName,
  extractEventPeopleFromText,
  extractEventPeopleFromTitle,
  extractEventOfferMetadata,
  eventOfferPriceAmount,
  firstEventImageUrl,
  firstEventImageUrlFromHtml,
  mergeEventOfferMetadata,
} from '../scripts/lib/event-metadata.mjs';

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

  it('preserves source-published Offer metadata beside the parsed price', () => {
    expect(extractPrice({
      offers: {
        price: '25',
        priceCurrency: 'CHF',
        availability: 'https://schema.org/InStock',
        validFrom: '2026-06-01T09:00:00+02:00',
        url: '/tickets/kunst-zu-mittag',
      },
    }, undefined, 'https://www.myswitzerland.com/it-ch/experiences/events/kunst-zu-mittag-2/')).toEqual({
      amount: 25,
      currency: 'CHF',
      isFree: false,
      availability: 'https://schema.org/InStock',
      validFrom: '2026-06-01T09:00:00+02:00',
      url: 'https://www.myswitzerland.com/tickets/kunst-zu-mittag',
    });
  });

  it('normalizes bare schema.org availability tokens', () => {
    expect(extractPrice({
      offers: {
        price: '20',
        priceCurrency: 'CHF',
        availability: 'InStock',
      },
    }, undefined, 'https://www.myswitzerland.com/it-ch/experiences/events/kunst-zu-mittag-2/')).toMatchObject({
      availability: 'https://schema.org/InStock',
    });
  });

  it('ignores blank Offer prices when selecting source metadata', () => {
    expect(eventOfferPriceAmount('')).toBeNaN();
    expect(extractEventOfferMetadata([
      { price: '', url: 'empty' },
      { price: '10', url: 'good' },
    ], 'https://source.example/event')).toEqual({ url: 'https://source.example/good' });
  });

  it('ignores blank Offer prices when selecting the normalized event price', () => {
    expect(extractPrice({
      offers: [
        { price: '', url: 'empty' },
        { price: '10', url: 'good' },
      ],
    }, undefined, 'https://source.example/event')).toMatchObject({
      amount: 10,
      url: 'https://source.example/good',
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

  it('falls back to the localized detail table when JSON-LD omits offers', () => {
    const html = '<table><tr><th scope="row">Prezzo</th><td><div class="richtext">Gratuito</div></td></tr></table>';
    expect(extractDetailTableValue(html, ['Prezzo', 'Preis'])).toBe('Gratuito');
    expect(extractPrice({}, html)).toEqual({ amount: 0, currency: 'CHF', isFree: true });
  });

  it('reads definition-list metadata and a structured Località address', () => {
    const html = '<dl><dt>Località</dt><dd>Hotel Pestalozzi; Via Indipendenza 9; 6900 Lugano; Switzerland</dd><dt>Prezzo</dt><dd>Gratuito</dd></dl>';
    expect(extractDetailTableValue(html, ['Prezzo'])).toBe('Gratuito');
    expect(extractDetailAddress(html)).toEqual({ street: 'Via Indipendenza 9', postalCode: '6900', locality: 'Lugano' });
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

  it('finds an Event node inside an @graph or array JSON-LD block', () => {
    const html = `
      <script type='application/ld+json'>${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'BreadcrumbList', itemListElement: [] },
          { '@type': ['Thing', 'MusicEvent'], name: 'Test', startDate: '2026-07-04T19:00:00+02:00' },
        ],
      })}</script>
    `;
    expect(extractEventJsonLd(html)).toMatchObject({ '@type': ['Thing', 'MusicEvent'], name: 'Test' });
  });
});

describe('mergeDetailEventMetadata', () => {
  it('fills missing optional fields from a later locale without replacing primary metadata', () => {
    const merged = mergeDetailEventMetadata(
      {
        '@type': 'MusicEvent',
        name: 'Evento locale principale',
        organizer: { '@type': 'Organization', name: 'Organizzatore principale' },
      },
      {
        '@type': 'MusicEvent',
        name: 'Evento locale alternativo',
        image: '/-/media/events/alternate.jpg',
        organizer: { '@type': 'Organization', name: 'Organizzatore alternativo' },
        performer: { '@type': 'Person', name: 'Artista alternativo', url: '/artist' },
      },
      'https://www.myswitzerland.com/it-ch/eventi/principale',
      'https://www.myswitzerland.com/en-ch/events/alternate',
    );
    expect(merged?.name).toBe('Evento locale principale');
    expect(merged?.organizer).toEqual({ '@type': 'Organization', name: 'Organizzatore principale' });
    expect(merged?.performer).toEqual({
      '@type': 'Person',
      name: 'Artista alternativo',
      url: 'https://www.myswitzerland.com/artist',
    });
    expect(merged?.image).toBe('https://www.myswitzerland.com/-/media/events/alternate.jpg');
  });

  it('uses a later locale organizer URL when the primary locale only has a name', () => {
    const merged = mergeDetailEventMetadata(
      {
        '@type': 'MusicEvent',
        organizer: { '@type': 'Organization', name: 'Organizzatore principale' },
      },
      {
        '@type': 'MusicEvent',
        organizer: { '@type': 'Organization', name: 'Organizzatore principale', url: '/organizer' },
      },
      'https://www.myswitzerland.com/it-ch/eventi/principale',
      'https://www.myswitzerland.com/en-ch/events/principale',
    );
    expect(merged?.organizer).toEqual({
      '@type': 'Organization',
      name: 'Organizzatore principale',
      url: 'https://www.myswitzerland.com/organizer',
    });
  });

  it('merges a later organizer URL into a matching primary entry without dropping siblings', () => {
    const merged = mergeDetailEventMetadata(
      {
        '@type': 'MusicEvent',
        organizer: [
          { '@type': 'Organization', name: 'Organizzatore A' },
          { '@type': 'Organization', name: 'Organizzatore B' },
        ],
      },
      {
        '@type': 'MusicEvent',
        organizer: [{ '@type': 'Organization', name: 'Organizzatore A', url: '/organizer-a' }],
      },
      'https://www.myswitzerland.com/it-ch/eventi/principale',
      'https://www.myswitzerland.com/en-ch/events/principale',
    );
    expect(merged?.organizer).toEqual([
      { '@type': 'Organization', name: 'Organizzatore A', url: 'https://www.myswitzerland.com/organizer-a' },
      { '@type': 'Organization', name: 'Organizzatore B' },
    ]);
  });

  it('fills missing Offer fields from a later localized JSON-LD variant', () => {
    const merged = mergeDetailEventMetadata(
      { '@type': 'Event', offers: { price: '25', priceCurrency: 'CHF' } },
      {
        '@type': 'Event',
        offers: {
          price: '25',
          priceCurrency: 'CHF',
          availability: 'https://schema.org/InStock',
          validFrom: '2026-06-01T09:00:00+02:00',
          url: '/tickets/kunst-zu-mittag',
        },
      },
      'https://www.myswitzerland.com/it-ch/experiences/events/kunst-zu-mittag-2/',
      'https://www.myswitzerland.com/en-ch/experiences/events/kunst-zu-mittag-2/',
    );
    expect(merged?.offers).toEqual({
      price: '25',
      priceCurrency: 'CHF',
      availability: 'https://schema.org/InStock',
      validFrom: '2026-06-01T09:00:00+02:00',
      url: 'https://www.myswitzerland.com/tickets/kunst-zu-mittag',
    });
  });

  it('normalizes a candidate Offer against its own locale URL when primary offers are absent', () => {
    expect(mergeEventOfferMetadata(
      undefined,
      { price: '10', url: 'tickets' },
      'https://source.example/it/event',
      'https://source.example/de/event',
    )).toEqual({ price: '10', url: 'https://source.example/de/tickets' });
  });

  it('does not merge optional metadata across different Offer price tiers', () => {
    expect(mergeEventOfferMetadata(
      [{ price: '10' }],
      [{ price: '20', url: 'ticket-20' }],
      'https://a.example/event',
      'https://b.example/event',
    )).toEqual([{ price: '10' }]);
  });
});

describe('detailEnrichmentReady', () => {
  const perLocaleHits = { it: { image: 'https://cdn.myswitzerland.com/images/event.jpg' } };
  const sourcePeople = {
    organizer: { '@type': 'Organization', name: 'Promotore', url: 'https://example.com/promotore' },
    performer: { name: 'Artista' },
  };
  const complete = {
    detailAddress: { postalCode: '6900', locality: 'Lugano' },
    detailPrice: { amount: 25, currency: 'CHF', isFree: false },
  };

  it('keeps fetching when address or price is still missing', () => {
    expect(detailEnrichmentReady({ ...complete, detailAddress: undefined }, perLocaleHits, sourcePeople)).toBe(false);
    expect(detailEnrichmentReady({ ...complete, detailPrice: undefined }, perLocaleHits, sourcePeople)).toBe(false);
  });

  it('stops only when attribution, image, address, and price are resolved', () => {
    expect(detailEnrichmentReady(complete, perLocaleHits, sourcePeople)).toBe(true);
  });

  it('accepts explicit people extracted from the detail HTML', () => {
    expect(detailEnrichmentReady({
      ...complete,
      detailPeople: {
        organizer: { '@type': 'Organization', name: 'Promotore dalla pagina', url: 'https://example.com/promotore' },
        performer: { name: 'Artista dalla pagina' },
      },
    }, perLocaleHits)).toBe(true);
  });

  it('treats a named contact as resolved when the verified detail URL can backfill it', () => {
    expect(detailEnrichmentReady({
      ...complete,
      detailUrl: 'https://www.myswitzerland.com/it-ch/eventi/promotore',
      detailContactName: 'Promotore dalla pagina',
      detailPeople: { performer: { name: 'Artista dalla pagina' } },
    }, perLocaleHits)).toBe(true);
  });

  it('keeps fetching when no organizer evidence exists in the current locale', () => {
    expect(detailEnrichmentReady({
      ...complete,
      detailUrl: 'https://www.myswitzerland.com/it-ch/eventi/senza-organizer',
      detailPeople: { performer: { name: 'Artista dalla pagina' } },
    }, perLocaleHits)).toBe(false);
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

  it('keeps source organizer/performer and falls back to detail-page image/price metadata', () => {
    const mapped = mapEventRecord(
      'metadata123',
      { it: { ...hitIt, image: undefined } },
      {
        detailUrl: 'https://www.myswitzerland.com/it-ch/eventi/metadata',
        detailLd: {
          '@type': 'MusicEvent',
          image: [{ url: '/-/media/events/metadata.jpg' }],
          organizer: { '@type': 'Organization', name: 'Organizzatore ufficiale', url: '/organizer' },
          performer: [{ '@type': 'Person', name: 'Artista principale' }],
          location: { name: 'Teatro', address: { addressLocality: 'Lugano' } },
        },
        detailHtml: '<table><tr><th>Prezzo</th><td>Gratuito</td></tr></table>',
      },
    );
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.organizer).toEqual({
      '@type': 'Organization',
      name: 'Organizzatore ufficiale',
      url: 'https://www.myswitzerland.com/organizer',
    });
    expect(event.performer).toEqual([{ '@type': 'Person', name: 'Artista principale' }]);
    expect(event.price).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect((mapped as never as { imageSourceUrl: string }).imageSourceUrl).toBe(
      'https://www.myswitzerland.com/-/media/events/metadata.jpg',
    );
  });

  it('fills optional metadata from indexed source copy and HTML fallbacks', () => {
    const mapped = mapEventRecord(
      'source-text123',
      {
        it: {
          ...hitIt,
          image: undefined,
          content: 'Präsentiert von Noise Reduction & Musikbüro Rote FabrikMitwirkende und Zusatzinformationen:Autechre',
        },
      },
      {
        detailUrl: 'https://www.myswitzerland.com/it-ch/eventi/autechre',
        detailHtml: '<meta property="og:image" content="/-/media/events/autechre.jpg">',
      },
    );
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.organizer).toEqual({
      '@type': 'Organization',
      name: 'Noise Reduction & Musikbüro Rote Fabrik',
      url: 'https://www.myswitzerland.com/it-ch/eventi/autechre',
    });
    expect(event.performer).toEqual({ name: 'Autechre' });
    expect((mapped as never as { imageSourceUrl: string }).imageSourceUrl).toBe(
      'https://www.myswitzerland.com/-/media/events/autechre.jpg',
    );
  });

  it('uses explicit quoted performer cues in the indexed title', () => {
    const mapped = mapEventRecord(
      'title-performer123',
      { it: { ...hitIt, title: 'Musik und Tanz mit „Ghörsch“', content: undefined, leadText: undefined } },
    );
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.performer).toEqual({ name: 'Ghörsch' });
  });

  it('fills people from explicit attribution in fetched detail HTML', () => {
    const mapped = mapEventRecord(
      'detail-html123',
      { it: { ...hitIt, content: undefined, leadText: undefined } },
      {
        detailUrl: 'https://www.myswitzerland.com/it-ch/eventi/autechre',
        detailHtml: '<div itemprop="description">Präsentiert von Noise Reduction &amp; Musikbüro Rote Fabrik<br>Mitwirkende und Zusatzinformationen:<br>Autechre</div>',
      },
    );
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.organizer).toEqual({
      '@type': 'Organization',
      name: 'Noise Reduction & Musikbüro Rote Fabrik',
      url: 'https://www.myswitzerland.com/it-ch/eventi/autechre',
    });
    expect(event.performer).toEqual({ name: 'Autechre' });
  });

  it('rejects venue name that matches performer.name and falls back to addressLocality', () => {
    const detailLd = {
      '@type': 'MusicEvent',
      location: {
        name: 'Khaled Madi',
        address: { streetAddress: 'Hauptstrasse 1', postalCode: '8840', addressLocality: 'Einsiedeln' },
      },
      performer: { name: 'Khaled Madi' },
    };
    const mapped = mapEventRecord('xyz999', { it: { ...hitIt, place: 'Schwyz' } }, { detailLd });
    const event = mapped?.event as never as Record<string, unknown>;
    // performer name must not leak as venue
    expect(event.venue).not.toBe('Khaled Madi');
    // addressLocality is the preferred fallback when performer collision is detected
    expect(event.venue).toBe('Einsiedeln');
  });

  it('rejects venue name that matches organizer name and falls back to index place when no addressLocality', () => {
    const detailLd = {
      '@type': 'Event',
      location: { name: 'Acme Events GmbH' },
      organizer: [{ '@type': 'Organization', name: 'Acme Events GmbH' }],
    };
    const mapped = mapEventRecord('xyz998', { it: { ...hitIt, place: 'Berna' } }, { detailLd });
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.venue).not.toBe('Acme Events GmbH');
    expect(event.venue).toBe('Berna'); // falls back to Algolia index place
  });

  it('keeps a legitimate venue name that happens to share a substring with an organizer', () => {
    const detailLd = {
      '@type': 'Event',
      location: { name: 'Kongresshaus Zürich' },
      organizer: { name: 'Zürich Events AG' },
    };
    const mapped = mapEventRecord('xyz997', { it: hitIt }, { detailLd });
    const event = mapped?.event as never as Record<string, unknown>;
    // Substring match alone must NOT discard the venue — only exact match counts
    expect(event.venue).toBe('Kongresshaus Zürich');
  });
});

describe('source optional metadata fallbacks', () => {
  it('extracts explicit organizer and performer labels from MySwitzerland copy', () => {
    expect(
      extractEventPeopleFromText(
        'Präsentiert von Noise Reduction & Musikbüro Rote FabrikMitwirkende und Zusatzinformationen:Autechre',
      ),
    ).toEqual({
      organizer: { '@type': 'Organization', name: 'Noise Reduction & Musikbüro Rote Fabrik' },
      performer: { name: 'Autechre' },
    });
    expect(extractEventPeopleFromText('Gestaltet wird der Abend von Zita Gander und Silvia Müller.')).toEqual({
      performer: [{ name: 'Zita Gander' }, { name: 'Silvia Müller' }],
    });
    expect(extractEventPeopleFromText('Auf den Spuren von Marc Chagall. Mit Kerstin Bitar. Treffpunkt ...')).toEqual({
      performer: { name: 'Kerstin Bitar' },
    });
    expect(extractEventPeopleFromText('Musik und Tanz mit „Ghörsch“')).toEqual({
      performer: { name: 'Ghörsch' },
    });
    expect(extractEventPeopleFromTitle('Gesprächsgruppe für Menschen mit Demenz')).toEqual({});
    expect(extractEventPeopleFromTitle('Konzert mit Thorsten Ahlrichs')).toEqual({
      performer: { name: 'Thorsten Ahlrichs' },
    });
  });

  it('reads event-scoped OpenGraph/itemprop images and named contact blocks', () => {
    const html = `
      <meta property="og:image" content="/-/media/events/autechre.jpg">
      <h2>Contatto</h2><div>Fabriktheater Rote Fabrik<br>Seestrasse 395<br>8038 Zürich</div>
    `;
    expect(firstEventImageUrlFromHtml(html, 'https://www.myswitzerland.com/en-ch/events/autechre')).toBe(
      'https://www.myswitzerland.com/-/media/events/autechre.jpg',
    );
    expect(extractDetailContactName(html)).toBe('Fabriktheater Rote Fabrik');
  });

  it('accepts event-scoped image object aliases emitted by source indexes', () => {
    expect(firstEventImageUrl({ src: '/-/media/events/autechre.jpg' }, 'https://www.myswitzerland.com/en-ch/events/autechre')).toBe(
      'https://www.myswitzerland.com/-/media/events/autechre.jpg',
    );
  });
});
