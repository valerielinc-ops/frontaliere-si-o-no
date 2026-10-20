import { describe, expect, it } from 'vitest';
import {
  buildCostOfLivingPlaceSchema,
  renderCostOfLivingPageForTest,
} from '../../build-plugins/costOfLivingLandingsPlugin';
import {
  buildCostOfLivingLandingPath,
  COL_CITY_IDS,
} from '../../build-plugins/costOfLivingLandingsData';

const BASE_URL = 'https://frontaliereticino.ch';

const EMPTY_SNAPSHOT = {
  liveCount: 0,
  fresh30Count: 0,
  medianSalaryChf: null,
  featured: [],
  topEmployers: [],
} as const;

function parseJsonLd(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
}

describe('cost-of-living place schema', () => {
  it.each(COL_CITY_IDS)('uses a page-scoped place identity for %s', (city) => {
    const canonicalUrl = `${BASE_URL}${buildCostOfLivingLandingPath('it', city)}`;
    const schema = buildCostOfLivingPlaceSchema({ locale: 'it', city, canonicalUrl });

    expect(schema['@id']).toBe(`${canonicalUrl}#place`);
    expect(schema['@type']).toBe(city === 'ticino' ? 'AdministrativeArea' : 'City');
    expect(schema).not.toHaveProperty('streetAddress');
  });

  it('uses source-backed municipal address fields and omits an address for the roll-up', () => {
    const citySchema = buildCostOfLivingPlaceSchema({
      locale: 'it',
      city: 'bellinzona',
      canonicalUrl: `${BASE_URL}/costo-vita-bellinzona-ticino/`,
    });
    expect(citySchema.address).toEqual({
      '@type': 'PostalAddress',
      addressCountry: 'CH',
      addressRegion: 'TI',
      addressLocality: 'Bellinzona',
      postalCode: '6500',
    });

    const regionalSchema = buildCostOfLivingPlaceSchema({
      locale: 'it',
      city: 'ticino',
      canonicalUrl: `${BASE_URL}/costo-vita-ticino/`,
    });
    expect(regionalSchema).not.toHaveProperty('address');
  });

  it.each(COL_CITY_IDS)('does not emit LocalBusiness markup for the editorial %s page', (city) => {
    const locale = 'it' as const;
    const canonicalUrl = `${BASE_URL}${buildCostOfLivingLandingPath(locale, city)}`;
    const rendered = renderCostOfLivingPageForTest({
      locale,
      city,
      dateStamp: '2026-10-05',
      snapshot: EMPTY_SNAPSHOT,
    });
    const schemas = parseJsonLd(rendered.html);
    const place = schemas.find(
      (schema) => schema['@type'] === (city === 'ticino' ? 'AdministrativeArea' : 'City'),
    );

    expect(place).toBeDefined();
    expect(place?.['@id']).toBe(`${canonicalUrl}#place`);
    expect(schemas.some((schema) => schema['@type'] === 'LocalBusiness')).toBe(false);
  });
});
