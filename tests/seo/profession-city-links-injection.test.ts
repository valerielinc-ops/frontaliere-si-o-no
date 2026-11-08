/**
 * Regression coverage for the profession-city link boundary: injected hrefs
 * must be rebuilt from the parsed route builder, not copied from a raw path.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCityLinkItems,
} from '../../build-plugins/professionCityLinksPlugin';
import {
  buildProfessionCityPath,
  PROFESSION_CITY_KEYS,
} from '../../build-plugins/professionCityData';
import { PROFESSION_IDS } from '../../build-plugins/professionLandingsData';

describe('buildCityLinkItems — canonical emitted hrefs', () => {
  it('rebuilds a trailing-slash href from the parsed city route', () => {
    const canonical = buildProfessionCityPath('it', PROFESSION_CITY_KEYS[0], PROFESSION_IDS[0]);
    const byLocale = buildCityLinkItems([canonical.slice(0, -1)]);

    expect(byLocale.it).toHaveLength(1);
    expect(byLocale.it[0].href).toBe(canonical);
    expect(byLocale.it[0].href.endsWith('/')).toBe(true);
  });
});
