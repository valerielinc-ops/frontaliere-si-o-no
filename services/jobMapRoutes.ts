import { normalizeCitySlug } from '@/build-plugins/shared/cantonCities';
import { TI_LEGACY_CITY_HUB_KEYS } from '@/build-plugins/cityJobsHub';
import { buildPath } from '@/services/router';
import type { Locale } from '@/services/i18n';

/** Build an indexable destination when one exists for a locality on the Swiss map. */
export function buildSwissCityMapHref(cantonCode: string, cityName: string, locale: Locale): string | null {
  const citySlug = normalizeCitySlug(cityName);
  if (cantonCode === 'TI' && !TI_LEGACY_CITY_HUB_KEYS.includes(citySlug)) {
    return null;
  }

  return buildPath({
    activeTab: 'job-board',
    jobBoardCanton: cantonCode,
    jobBoardCity: citySlug,
  }, locale);
}
