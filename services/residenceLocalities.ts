import manifest from '@/data/residence-localities/manifest.json';

const countries = manifest.countries as Record<string, string>;
const catalogues = import.meta.glob<string[]>('../data/residence-localities/[A-Z][A-Z].json', { import: 'default' });
const cache = new Map<string, Promise<string[]>>();
export const foldResidenceText = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase().trim();

export function residenceCountries(locale: string) {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  return Object.entries(countries).map(([code, name]) => ({ code, label: names.of(code) || name }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

const countryNames = new Map<string, string | null>();
function addCountryName(label: string, code: string) {
  const key = foldResidenceText(label);
  countryNames.set(key, countryNames.has(key) && countryNames.get(key) !== code ? null : code);
}
for (const [code, name] of Object.entries(countries)) {
  addCountryName(name, code);
}
for (const locale of ['it', 'en', 'de', 'fr']) {
  for (const { code, label } of residenceCountries(locale)) addCountryName(label, code);
}

/** Only an explicit country suffix counts: a town or postal code proves no country. */
export function parseResidenceLocation(value: string) {
  const split = value.lastIndexOf(',');
  if (split < 0) return { country: '', town: value };
  const suffix = value.slice(split + 1).trim();
  // Two-letter province/canton abbreviations (CO, CH, GE…) are not countries.
  // Georgia is also a US state: require the explicit name-plus-country marker.
  const encoded = suffix.match(/^(.+) \(([A-Z]{2})\)$/);
  const named = countryNames.get(foldResidenceText(encoded?.[1] || suffix));
  const country = encoded ? (named === encoded[2] ? named : null) : named === 'GE' ? null : named;
  return country ? { country, town: value.slice(0, split).trim() } : { country: '', town: value };
}

export function formatResidenceLocation(town: string, country: string, locale: string) {
  const clean = town.trim();
  if (!clean) return '';
  const label = countries[country] ? new Intl.DisplayNames([locale], { type: 'region' }).of(country) : '';
  return label ? `${clean}, ${label}${country === 'GE' ? ' (GE)' : ''}` : clean;
}

/** Load only the selected country. Typing never sends residence text to a geocoder. */
export function loadResidenceLocalities(country: string): Promise<string[]> {
  if (!Object.hasOwn(countries, country)) return Promise.resolve([]);
  if (!cache.has(country)) {
    const loader = catalogues[`../data/residence-localities/${country}.json`];
    if (!loader) return Promise.resolve([]);
    const request = loader().then(values => values.filter(value => typeof value === 'string'))
      .catch(error => { cache.delete(country); throw error; });
    cache.set(country, request);
  }
  return cache.get(country)!;
}
