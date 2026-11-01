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
// Older Intl/CLDR releases serialize the long territory name; newer ones
// shorten it to St. Helena. Both identify the same explicit country suffix.
addCountryName('Saint Helena, Ascension and Tristan da Cunha', 'SH');

/** Only an explicit country suffix counts: a town or postal code proves no country. */
export function parseResidenceLocation(value: string) {
  // A country name can contain commas too. Match the complete known suffix,
  // starting with the longest, rather than assuming the final token is a name.
  for (let split = value.indexOf(','); split >= 0; split = value.indexOf(',', split + 1)) {
    const suffix = value.slice(split + 1).trim();
    // Two-letter province/canton abbreviations (CO, CH, GE…) are not countries.
    // Georgia is also a US state: require the explicit name-plus-country marker.
    const encoded = suffix.match(/^(.+) \(([A-Z]{2})\)$/);
    const named = countryNames.get(foldResidenceText(encoded?.[1] || suffix));
    const country = encoded ? (named === encoded[2] ? named : null) : named === 'GE' ? null : named;
    if (country) return { country, town: value.slice(0, split).trim() };
  }
  return { country: '', town: value };
}

export function formatResidenceLocation(town: string, country: string, locale: string) {
  const clean = town.trim();
  if (!clean) return '';
  const label = countries[country] ? new Intl.DisplayNames([locale], { type: 'region' }).of(country) : '';
  return label ? `${clean}, ${label}${country === 'GE' ? ' (GE)' : ''}` : clean;
}

/** Save a country-qualified applicant location only when its country was selected explicitly. */
export function residenceLocationForApplication(value: string, selectedCountry: string) {
  const clean = value.trim();
  if (!clean) return '';
  const parsed = parseResidenceLocation(clean);
  if (selectedCountry) return parsed.country === selectedCountry ? clean : '';
  // Preserve an ambiguous legacy town, but discard a typed country suffix so
  // downstream consumers cannot mistake it for an explicit selection.
  return parsed.country ? parsed.town : clean;
}

export function residenceApplicationFields(value: string, selectedCountry: string) {
  const applicantLocation = residenceLocationForApplication(value, selectedCountry);
  return {
    applicantLocation,
    applicantLocationCountry: applicantLocation ? selectedCountry : '',
  };
}

/** A legacy service string has no confirmed country unless it stored the selector code separately. */
export function residenceLocationForEditor(value: string, storedCountry: string) {
  const clean = value.trim();
  const parsed = clean ? parseResidenceLocation(clean) : null;
  if (storedCountry && parsed?.country === storedCountry) return { location: clean, countryCode: storedCountry };
  return { location: parsed?.country ? parsed.town : clean, countryCode: '' };
}

/** Prefer a private residence only when its stored selector code confirms its suffix. */
export function residenceProfilePrefill(confirmedLocation: string, confirmedCountry: string, legacyMunicipality: string) {
  const parsed = confirmedLocation ? parseResidenceLocation(confirmedLocation) : null;
  if (confirmedCountry && parsed?.country === confirmedCountry) {
    return { location: confirmedLocation, countryCode: confirmedCountry };
  }
  return { location: residenceLocationForApplication(legacyMunicipality, ''), countryCode: '' };
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
