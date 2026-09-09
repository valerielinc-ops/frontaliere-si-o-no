import type { Locale } from '../i18n';
import { TICINO_CITY_BY_SLUG } from './data';

export type PharmacyPageKind = 'hub' | 'canton' | 'city' | 'duty-hub' | 'duty-city';

export interface PharmacyPath {
  kind: PharmacyPageKind;
  citySlug?: string;
  locale: Locale;
}

const LOCALE_BASES: Record<Locale, {
  hub: string;
  canton: string;
  dutyHub: string;
  dutySegment: string;
}> = {
  it: { hub: '/farmacie/', canton: '/farmacie/ticino/', dutyHub: '/farmacie-di-turno/', dutySegment: 'di-turno' },
  en: { hub: '/en/pharmacies/', canton: '/en/pharmacies/ticino/', dutyHub: '/en/on-duty-pharmacies/', dutySegment: 'on-duty' },
  de: { hub: '/de/apotheken/', canton: '/de/apotheken/ticino/', dutyHub: '/de/notdienst-apotheken/', dutySegment: 'notdienst' },
  fr: { hub: '/fr/pharmacies/', canton: '/fr/pharmacies/ticino/', dutyHub: '/fr/pharmacies-de-garde/', dutySegment: 'de-garde' },
};

function normalized(pathname: string): string {
  const clean = String(pathname || '').split('?')[0].split('#')[0];
  if (clean === '/') return '/';
  return `${clean.replace(/\/+$/, '')}/`;
}

export function pharmacyBases(locale: Locale): (typeof LOCALE_BASES)[Locale] {
  return LOCALE_BASES[locale];
}

export function buildPharmacyPath(path: PharmacyPath, locale: Locale = path.locale): string {
  const bases = LOCALE_BASES[locale];
  if (path.kind === 'hub') return bases.hub;
  if (path.kind === 'duty-hub') return bases.dutyHub;
  if (path.kind === 'canton') return bases.canton;
  if (!path.citySlug) return bases.canton;
  const cityPath = `${bases.canton}${path.citySlug}/`;
  return path.kind === 'duty-city' ? `${cityPath}${bases.dutySegment}/` : cityPath;
}

export function parsePharmacyPath(pathname: string): PharmacyPath | null {
  const path = normalized(pathname);
  for (const locale of ['it', 'en', 'de', 'fr'] as Locale[]) {
    const bases = LOCALE_BASES[locale];
    if (path === bases.hub) return { kind: 'hub', locale };
    if (path === bases.dutyHub) return { kind: 'duty-hub', locale };
    if (path === bases.canton) return { kind: 'canton', locale };
    if (!path.startsWith(bases.canton)) continue;
    const remainder = path.slice(bases.canton.length).split('/').filter(Boolean);
    if (remainder.length === 1 && TICINO_CITY_BY_SLUG.has(remainder[0])) {
      return { kind: 'city', citySlug: remainder[0], locale };
    }
    if (remainder.length === 2 && remainder[1] === bases.dutySegment && TICINO_CITY_BY_SLUG.has(remainder[0])) {
      return { kind: 'duty-city', citySlug: remainder[0], locale };
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
