import type { Locale } from '../i18n';
import { PHARMACY_DUTY_HUB_PATH, type PharmacyCountry } from './types';

export type PharmacyPageKind = 'hub' | 'canton' | 'city' | 'duty-hub' | 'duty-city' | 'duty-week' | 'italy-duty-hub' | 'italy-duty-week' | 'country' | 'area' | 'pharmacy';

export interface PharmacyPath {
  kind: PharmacyPageKind;
  locale: Locale;
  country?: PharmacyCountry;
  areaSlug?: string;
  citySlug?: string;
  pharmacySlug?: string;
  weekStart?: string;
}

const LOCALE_BASES: Record<Locale, {
  hub: string;
  canton: string;
  italy: string;
  dutyHub: string;
  dutySegment: string;
  dutyWeekSegment: string;
}> = {
  it: { hub: '/farmacie/', canton: '/farmacie/ticino/', italy: '/farmacie/italia/', dutyHub: PHARMACY_DUTY_HUB_PATH.it, dutySegment: 'di-turno', dutyWeekSegment: 'settimana' },
  en: { hub: '/en/pharmacies/', canton: '/en/pharmacies/ticino/', italy: '/en/pharmacies/italy/', dutyHub: PHARMACY_DUTY_HUB_PATH.en, dutySegment: 'on-duty', dutyWeekSegment: 'week' },
  de: { hub: '/de/apotheken/', canton: '/de/apotheken/ticino/', italy: '/de/apotheken/italien/', dutyHub: PHARMACY_DUTY_HUB_PATH.de, dutySegment: 'notdienst', dutyWeekSegment: 'woche' },
  fr: { hub: '/fr/pharmacies/', canton: '/fr/pharmacies/ticino/', italy: '/fr/pharmacies/italie/', dutyHub: PHARMACY_DUTY_HUB_PATH.fr, dutySegment: 'de-garde', dutyWeekSegment: 'semaine' },
};

// The router only needs to recognise the stable route shape. Full city and
// pharmacy identity validation stays in the lazy pharmacy page/runtime chunk.
const ITALY_BORDER_AREA_SLUGS = new Set(['como', 'varese', 'verbano-cusio-ossola']);

function normalized(pathname: string): string {
  const clean = String(pathname || '').split('?')[0].split('#')[0];
  if (clean === '/') return '/';
  return `${clean.replace(/\/+$/, '')}/`;
}

function isIsoMonday(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    && date.getUTCDay() === 1;
}

function italyDutyHubPath(locale: Locale): string {
  const bases = LOCALE_BASES[locale];
  return `${bases.italy}${bases.dutySegment}/`;
}

export function buildPharmacyPath(path: PharmacyPath, locale: Locale = path.locale): string {
  const bases = LOCALE_BASES[locale];
  if (path.kind === 'hub') return bases.hub;
  if (path.kind === 'duty-hub') return bases.dutyHub;
  if (path.kind === 'duty-week') {
    return path.weekStart && isIsoMonday(path.weekStart)
      ? `${bases.dutyHub}${bases.dutyWeekSegment}/${path.weekStart}/`
      : bases.dutyHub;
  }
  if (path.kind === 'italy-duty-hub') return italyDutyHubPath(locale);
  if (path.kind === 'italy-duty-week') {
    return path.weekStart && isIsoMonday(path.weekStart)
      ? `${italyDutyHubPath(locale)}${bases.dutyWeekSegment}/${path.weekStart}/`
      : italyDutyHubPath(locale);
  }
  if (path.kind === 'country') return path.country === 'IT' ? bases.italy : bases.canton;
  if (path.kind === 'canton') return bases.canton;

  const country = path.country || (path.areaSlug ? 'IT' : undefined);
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

function parseItalianRoute(path: string, locale: Locale, bases: (typeof LOCALE_BASES)[Locale]): PharmacyPath | null {
  if (path === bases.italy) return { kind: 'country', country: 'IT', locale };
  if (!path.startsWith(bases.italy)) return null;
  const remainder = path.slice(bases.italy.length).split('/').filter(Boolean);
  if (!remainder.length || !ITALY_BORDER_AREA_SLUGS.has(remainder[0])) return null;
  const areaSlug = remainder[0];
  if (remainder.length === 1) return { kind: 'area', country: 'IT', areaSlug, locale };
  const citySlug = remainder[1];
  if (remainder.length === 2) return { kind: 'city', country: 'IT', areaSlug, citySlug, locale };
  if (remainder.length === 3) {
    return { kind: 'pharmacy', country: 'IT', areaSlug, citySlug, pharmacySlug: remainder[2], locale };
  }
  return null;
}

/**
 * Parse only the route grammar needed by the generic router. The pharmacy
 * catalogue itself is deliberately not imported here: page and SEO details
 * validate names/records after their route-specific lazy chunk loads.
 */
export function parsePharmacyRoute(pathname: string): PharmacyPath | null {
  const path = normalized(pathname);
  for (const locale of ['it', 'en', 'de', 'fr'] as Locale[]) {
    const bases = LOCALE_BASES[locale];
    if (path === bases.hub) return { kind: 'hub', locale };
    if (path === bases.dutyHub) return { kind: 'duty-hub', locale };
    if (path.startsWith(bases.dutyHub)) {
      const remainder = path.slice(bases.dutyHub.length).split('/').filter(Boolean);
      if (remainder.length === 2 && remainder[0] === bases.dutyWeekSegment && isIsoMonday(remainder[1])) {
        return { kind: 'duty-week', locale, weekStart: remainder[1] };
      }
    }

    const italyDutyHub = italyDutyHubPath(locale);
    if (path === italyDutyHub) return { kind: 'italy-duty-hub', country: 'IT', locale };
    if (path.startsWith(italyDutyHub)) {
      const remainder = path.slice(italyDutyHub.length).split('/').filter(Boolean);
      if (remainder.length === 2 && remainder[0] === bases.dutyWeekSegment && isIsoMonday(remainder[1])) {
        return { kind: 'italy-duty-week', country: 'IT', locale, weekStart: remainder[1] };
      }
    }

    const italy = parseItalianRoute(path, locale, bases);
    if (italy) return italy;

    if (path === bases.canton) return { kind: 'canton', locale };
    if (!path.startsWith(bases.canton)) continue;
    const remainder = path.slice(bases.canton.length).split('/').filter(Boolean);
    if (remainder.length === 1) return { kind: 'city', citySlug: remainder[0], locale };
    if (remainder.length === 2 && remainder[1] === bases.dutySegment) {
      return { kind: 'duty-city', citySlug: remainder[0], locale };
    }
    if (remainder.length === 2) {
      return { kind: 'pharmacy', country: 'CH', citySlug: remainder[0], pharmacySlug: remainder[1], locale };
    }
  }
  return null;
}
