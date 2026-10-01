import { describe, expect, it } from 'vitest';
import metadata from '../../services/seo/seo-pages';

describe('holiday Event optional fields reported by GSC', () => {
  it.each(['holidays', 'holidaysDe'])('completes every event in %s', (key) => {
    const schemas = metadata[key].structuredData as Array<Record<string, any>>;
    const list = schemas.find((schema) => schema['@type'] === 'ItemList');
    expect(list?.itemListElement).toHaveLength(15);
    for (const { item } of list!.itemListElement) {
      expect(item['@type']).toBe('Event');
      expect(item.image).toBe('https://frontaliereticino.ch/og-image.png');
      expect(item.organizer.name).toBe(item.location.name);
      expect(item.organizer.url).toBe('https://www.ti.ch/');
      expect(item.performer.name).toBeTruthy();
      expect(item.offers.price).toBe('0');
      expect(item.offers.priceCurrency).toBe('CHF');
      expect(item.offers.availability).toBe('https://schema.org/InStock');
      expect(Number.isNaN(Date.parse(item.offers.validFrom))).toBe(false);
      expect(item.offers.url).toBe(item.url.split('#')[0]);
      expect(item.offers.url).toMatch(/\/$/);
    }
  });
});
