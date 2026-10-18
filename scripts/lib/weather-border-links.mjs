import { buildBorderWaitTodayPath } from './borderWaitSections.mjs';

/** The existing weather-city crossing choices, shared with their legacy URLs.
 * @type {Readonly<Record<string, readonly {slug: import('../../build-plugins/borderWaitData').BorderCrossingSlug, name: string}[]>>}
 */
export const NEAREST_WEATHER_CROSSINGS = {
  lugano: [{ slug: 'chiasso-brogeda', name: 'Chiasso-Brogeda' }, { slug: 'oria-gandria', name: 'Gandria' }],
  bellinzona: [{ slug: 'chiasso-brogeda', name: 'Chiasso-Brogeda' }],
  mendrisio: [{ slug: 'rodero-stabio', name: 'Stabio' }, { slug: 'gaggiolo', name: 'Gaggiolo' }],
  locarno: [{ slug: 'ponte-tresa', name: 'Ponte Tresa' }],
  chiasso: [{ slug: 'chiasso-brogeda', name: 'Brogeda' }],
  como: [{ slug: 'chiasso-brogeda', name: 'Brogeda' }, { slug: 'gaggiolo', name: 'Gaggiolo' }],
  varese: [{ slug: 'rodero-stabio', name: 'Stabio' }, { slug: 'gaggiolo', name: 'Gaggiolo' }],
  lecco: [{ slug: 'oria-gandria', name: 'Gandria' }],
};

const LEGACY_WEATHER_BASES = {
  en: '/en/border-traffic', de: '/de/grenze-verkehr', fr: '/fr/trafic-frontalier',
};
const crossings = new Set(Object.values(NEAREST_WEATHER_CROSSINGS).flat().map(crossing => crossing.slug));
/** @type {Record<string, string>} */
const redirects = {};
// These are precisely the five crossings emitted by the weather producer,
// not every crossing or every nearby path with a plausible route shape.
for (const locale of /** @type {const} */ (['en', 'de', 'fr'])) {
  for (const crossing of crossings) {
    redirects[`${LEGACY_WEATHER_BASES[locale]}/${crossing}/oggi/`] = buildBorderWaitTodayPath(locale, crossing);
  }
}
export const WEATHER_BORDER_LEGACY_REDIRECTS = Object.freeze(redirects);
