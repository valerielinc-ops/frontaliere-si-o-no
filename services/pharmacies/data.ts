import pharmacyJson from '../../data/pharmacies-ticino.json';
import completeTicinoJson from '../../data/pharmacies-ticino-complete.json';
import italyBorderJson from '../../data/pharmacies-italy-border.json';
import { safePharmacyUrl, type Pharmacy } from './types';

function sanitizePharmacy(pharmacy: Pharmacy): Pharmacy {
  const website = safePharmacyUrl(pharmacy.website);
  if (pharmacy.website && !website) {
    const { website: _unsafeWebsite, ...withoutWebsite } = pharmacy;
    return withoutWebsite;
  }
  return pharmacy;
}

/** The original four-region feed remains a compatibility fallback for old builds. */
const LEGACY_TICINO_PHARMACIES = (pharmacyJson.pharmacies as unknown as Pharmacy[]).map(sanitizePharmacy);
export const TICINO_PHARMACIES = (completeTicinoJson.pharmacies?.length
  ? (completeTicinoJson.pharmacies as unknown as Pharmacy[]).map(sanitizePharmacy)
  : LEGACY_TICINO_PHARMACIES) as Pharmacy[];
export const ITALY_BORDER_PHARMACIES = (italyBorderJson.pharmacies as unknown as Pharmacy[]).map(sanitizePharmacy);
export const BORDER_PHARMACIES = [...TICINO_PHARMACIES, ...ITALY_BORDER_PHARMACIES] as Pharmacy[];

function slugifyCity(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const TICINO_CITIES = [...new Set(TICINO_PHARMACIES.map((pharmacy) => pharmacy.city))]
  .sort((a, b) => a.localeCompare(b, 'it'))
  .map((name) => ({ name, slug: slugifyCity(name) }));

export const TICINO_CITY_BY_SLUG = new Map(TICINO_CITIES.map((city) => [city.slug, city.name]));

export const ITALY_BORDER_PROVINCES = [
  { code: 'CO', name: 'Como', slug: 'como' },
  { code: 'VA', name: 'Varese', slug: 'varese' },
  { code: 'VB', name: 'Verbano-Cusio-Ossola', slug: 'verbano-cusio-ossola' },
] as const;

export const ITALY_PROVINCE_BY_SLUG: Map<string, { code: string; name: string; slug: string }> = new Map(
  ITALY_BORDER_PROVINCES.map((province) => [province.slug, province]),
);

const ITALY_CITY_ENTRIES = [...new Set(ITALY_BORDER_PHARMACIES.map((pharmacy) => `${pharmacy.province}:${pharmacy.city}`))]
  .map((key) => {
    const [province, ...cityParts] = key.split(':');
    const name = cityParts.join(':');
    return { province, name, slug: slugifyCity(name) };
  });

export const ITALY_CITIES = ITALY_CITY_ENTRIES.sort((a, b) => a.name.localeCompare(b.name, 'it'));
export const ITALY_CITY_BY_PROVINCE_AND_SLUG = new Map(
  ITALY_CITIES.map((city) => [`${city.province}:${city.slug}`, city.name]),
);

export function pharmacyCitySlug(city: string): string {
  return slugifyCity(city);
}

export function pharmaciesForCity(city: string): Pharmacy[] {
  return TICINO_PHARMACIES.filter((pharmacy) => pharmacy.city === city);
}

export function pharmaciesForProvince(province: string): Pharmacy[] {
  return ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === province);
}

export function pharmaciesForCountry(country: Pharmacy['country']): Pharmacy[] {
  return BORDER_PHARMACIES.filter((pharmacy) => pharmacy.country === country);
}

export function pharmacyById(id: string): Pharmacy | undefined {
  return BORDER_PHARMACIES.find((pharmacy) => pharmacy.id === id);
}

export function pharmacyBySlug(slug: string): Pharmacy | undefined {
  return BORDER_PHARMACIES.find((pharmacy) => pharmacy.slug === slug);
}

export function citySlugForPharmacy(pharmacy: Pharmacy): string {
  return slugifyCity(pharmacy.city);
}

export function provinceSlugForPharmacy(pharmacy: Pharmacy): string | undefined {
  return ITALY_BORDER_PROVINCES.find((province) => province.code === pharmacy.province)?.slug;
}
