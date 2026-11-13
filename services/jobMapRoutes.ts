import { normalizeCitySlug } from '@/build-plugins/shared/cantonCities';
import { isKnownCityHub, TI_LEGACY_CITY_HUB_KEYS } from '@/build-plugins/cityJobsHub';
import { buildPath } from '@/services/router';
import type { Locale } from '@/services/i18n';

/** Build an indexable destination only when the router has a canonical city hub for it. */
export function buildSwissCityMapHref(cantonCode: string, cityName: string, locale: Locale): string | null {
  const canton = String(cantonCode || '').toUpperCase().trim();
  if (!canton) return null;
  const citySlug = normalizeCitySlug(cityName);
  if (!citySlug) return null;
  if (canton === 'TI') {
    if (!TI_LEGACY_CITY_HUB_KEYS.includes(citySlug)) return null;
  } else if (!isKnownCityHub(citySlug, canton)) {
    return null;
  }

  return buildPath({
    activeTab: 'job-board',
    jobBoardCanton: canton,
    jobBoardCity: citySlug,
  }, locale);
}
