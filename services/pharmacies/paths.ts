import type { Locale } from '../i18n';
import {
  ITALY_CITY_BY_PROVINCE_AND_SLUG,
  ITALY_PROVINCE_BY_SLUG,
  TICINO_CITY_BY_SLUG,
  pharmacyBySlug,
} from './data';
import type { PharmacyCountry } from './types';

export type PharmacyPageKind = 'hub' | 'canton' | 'city' | 'duty-hub' | 'duty-city' | 'country' | 'area' | 'pharmacy';

export interface PharmacyPath {
  kind: PharmacyPageKind;
  locale: Locale;
  country?: PharmacyCountry;
  areaSlug?: string;
  citySlug?: string;
  pharmacySlug?: string;
}

const LOCALE_BASES: Record<Locale, {
  hub: string;
  canton: string;
  italy: string;
  dutyHub: string;
  dutySegment: string;
}> = {
  it: { hub: '/farmacie/', canton: '/farmacie/ticino/', italy: '/farmacie/italia/', dutyHub: '/farmacie-di-turno/', dutySegment: 'di-turno' },
  en: { hub: '/en/pharmacies/', canton: '/en/pharmacies/ticino/', italy: '/en/pharmacies/italy/', dutyHub: '/en/on-duty-pharmacies/', dutySegment: 'on-duty' },
  de: { hub: '/de/apotheken/', canton: '/de/apotheken/ticino/', italy: '/de/apotheken/italien/', dutyHub: '/de/notdienst-apotheken/', dutySegment: 'notdienst' },
  fr: { hub: '/fr/pharmacies/', canton: '/fr/pharmacies/ticino/', italy: '/fr/pharmacies/italie/', dutyHub: '/fr/pharmacies-de-garde/', dutySegment: 'de-garde' },
};

function normalized(pathname: string): string {
  const clean = String(pathname || '').split('?')[0].split('#')[0];
  if (clean === '/') return '/';
  return `${clean.replace(/\/+$/, '')}/`;
}

function slugify(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function pharmacyBases(locale: Locale): (typeof LOCALE_BASES)[Locale] {
  return LOCALE_BASES[locale];
}

function pharmacyCountryForPath(path: PharmacyPath): PharmacyCountry | undefined {
  return path.country || (path.areaSlug ? 'IT' : undefined);
}

export function buildPharmacyPath(path: PharmacyPath, locale: Locale = path.locale): string {
  const bases = LOCALE_BASES[locale];
  if (path.kind === 'hub') return bases.hub;
  if (path.kind === 'duty-hub') return bases.dutyHub;
  if (path.kind === 'country') return path.country === 'IT' ? bases.italy : bases.canton;
  if (path.kind === 'canton') return bases.canton;

  const country = pharmacyCountryForPath(path);
  if (country === 'IT') {
    if (!path.areaSlug) return bases.italy;
    const areaPath = `${bases.italy}${path.areaSlug}/`;
    if (path.kind === 'area') return areaPath;
    if (!path.citySlug) return areaPath;
    const cityPath = `${areaPath}${path.citySlug}/`;
    return path.kind === 'pharmacy' && path.pharmacySlug ? `${cityPath}${path.pharmacySlug}/` : cityPath;
  }

  if (!path.citySlug) return bases.canton;
  const cityPath = `${bases.canton}${path.citySlug}/`;
  if (path.kind === 'duty-city') return `${cityPath}${bases.dutySegment}/`;
  return path.kind === 'pharmacy' && path.pharmacySlug ? `${cityPath}${path.pharmacySlug}/` : cityPath;
}

function areaSlugToCode(areaSlug: string): string | undefined {
  return ITALY_PROVINCE_BY_SLUG.get(areaSlug)?.code;
}

function parseItalianPath(path: string, locale: Locale, bases: (typeof LOCALE_BASES)[Locale]): PharmacyPath | null {
  if (path === bases.italy) return { kind: 'country', country: 'IT', locale };
  if (!path.startsWith(bases.italy)) return null;
  const remainder = path.slice(bases.italy.length).split('/').filter(Boolean);
  if (!remainder.length || !ITALY_PROVINCE_BY_SLUG.has(remainder[0])) return null;
  const areaSlug = remainder[0];
  const provinceCode = areaSlugToCode(areaSlug);
  if (remainder.length === 1) return { kind: 'area', country: 'IT', areaSlug, locale };
  const citySlug = remainder[1];
  if (!provinceCode || !ITALY_CITY_BY_PROVINCE_AND_SLUG.has(`${provinceCode}:${citySlug}`)) return null;
  if (remainder.length === 2) return { kind: 'city', country: 'IT', areaSlug, citySlug, locale };
  if (remainder.length === 3) {
    const pharmacy = pharmacyBySlug(remainder[2]);
    if (pharmacy?.country === 'IT' && pharmacy.province === provinceCode && slugify(pharmacy.city) === citySlug) {
      return { kind: 'pharmacy', country: 'IT', areaSlug, citySlug, pharmacySlug: remainder[2], locale };
    }
  }
  return null;
}

export function parsePharmacyPath(pathname: string): PharmacyPath | null {
  const path = normalized(pathname);
  for (const locale of ['it', 'en', 'de', 'fr'] as Locale[]) {
    const bases = LOCALE_BASES[locale];
    if (path === bases.hub) return { kind: 'hub', locale };
    if (path === bases.dutyHub) return { kind: 'duty-hub', locale };

    const italy = parseItalianPath(path, locale, bases);
    if (italy) return italy;

    // Keep the legacy Ticino objects byte-compatible: callers and existing
    // deep-equality tests intentionally do not need a `country` field here.
    if (path === bases.canton) return { kind: 'canton', locale };
    if (!path.startsWith(bases.canton)) continue;
    const remainder = path.slice(bases.canton.length).split('/').filter(Boolean);
    if (remainder.length === 1 && TICINO_CITY_BY_SLUG.has(remainder[0])) {
      return { kind: 'city', citySlug: remainder[0], locale };
    }
    if (remainder.length === 2 && remainder[1] === bases.dutySegment && TICINO_CITY_BY_SLUG.has(remainder[0])) {
      return { kind: 'duty-city', citySlug: remainder[0], locale };
    }
    if (remainder.length === 2) {
      const pharmacy = pharmacyBySlug(remainder[1]);
      if (pharmacy?.country === 'CH' && slugify(pharmacy.city) === remainder[0]) {
        return { kind: 'pharmacy', country: 'CH', citySlug: remainder[0], pharmacySlug: remainder[1], locale };
      }
    }
  }
  return null;
}

export const PHARMACY_CANONICAL_HUB_PATHS: Readonly<Record<Locale, string>> = Object.freeze({
  it: LOCALE_BASES.it.hub,
  en: LOCALE_BASES.en.hub,
  de: LOCALE_BASES.de.hub,
  fr: LOCALE_BASES.fr.hub,
});
