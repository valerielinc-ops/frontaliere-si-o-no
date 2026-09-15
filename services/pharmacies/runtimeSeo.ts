import type { Locale } from '../i18n';
import type { SEOMetadata } from '../seoService';
import {
  ITALY_CITY_BY_PROVINCE_AND_SLUG,
  ITALY_BORDER_PROVINCES,
  ITALY_PROVINCE_BY_SLUG,
  BORDER_PHARMACIES,
  ITALY_BORDER_PHARMACIES,
  TICINO_CITY_BY_SLUG,
  TICINO_PHARMACIES,
  pharmacyById,
  pharmacyBySlug,
  pharmacyCitySlug,
  pharmaciesForCity,
  pharmaciesForProvince,
  provinceSlugForPharmacy,
} from './data';
import { buildPharmacyPath, type PharmacyPath } from './paths';
import { buildDutyWeekModel } from './dutyWeek';
import { currentDutyForRegion } from './duties';
import { buildPharmacyTitle } from './title';
import { safePharmacyUrl, type Pharmacy, type PharmacyCatalogueDataset, type PharmacyDutiesDataset } from './types';
import dutiesJson from '../../data/pharmacy-duties-ticino.json';
import completeTicinoJson from '../../data/pharmacies-ticino-complete.json';

const BASE_URL = 'https://frontaliereticino.ch';

type PharmacyRuntimeSeoMetadata = SEOMetadata & {
  robots: 'index,follow' | 'noindex,follow';
};

const RUNTIME_PHARMACY_DUTIES = dutiesJson as PharmacyDutiesDataset;
const RUNTIME_PHARMACY_CATALOGUE = completeTicinoJson as unknown as PharmacyCatalogueDataset;

/**
 * Runtime copy for the route-driven pharmacy surface. The static pharmacy
 * pages already carry their own HTML head; this small mirror is only used
 * after SPA navigation, when the document head must follow the parsed route.
 */
const RUNTIME_PHARMACY_COPY: Record<Locale, {
  hubTitle: string;
  cantonTitle: string;
  italyTitle: string;
  dutyHubTitle: string;
  dutyCityTitle: (city: string) => string;
  dutyWeekTitle: (weekStart: string) => string;
  dutyWeekDescription: string;
  directoryDescription: string;
  breadcrumbLabel: string;
  keywords: string;
}> = {
  it: {
    hubTitle: 'Farmacie in Ticino e al confine italiano: elenco e fonti',
    cantonTitle: 'Farmacie in Ticino',
    italyTitle: 'Farmacie italiane al confine con il Ticino',
    dutyHubTitle: 'Farmacie di turno in Ticino',
    dutyCityTitle: (city) => `Farmacia di turno: informazioni per ${city}`,
    dutyWeekTitle: (weekStart) => `Farmacie di turno in Ticino: settimana del ${weekStart}`,
    dutyWeekDescription: 'Calendario settimanale delle regioni ticinesi con intervalli verificati. Non è una copertura di tutti i cantoni né delle farmacie italiane di confine.',
    directoryDescription: 'Directory transfrontaliera di Ticino e province italiane vicine. Ogni sede mostra la fonte, la data di recupero e separa i dati anagrafici dagli orari e dai servizi opzionali.',
    breadcrumbLabel: 'Farmacie',
    keywords: 'farmacie Ticino, farmacie di turno, farmacie confine Italia',
  },
  en: {
    hubTitle: 'Pharmacies in Ticino and across the Italian border: directory and sources',
    cantonTitle: 'Pharmacies in Ticino',
    italyTitle: 'Italian pharmacies near the Ticino border',
    dutyHubTitle: 'On-duty pharmacies in Ticino',
    dutyCityTitle: (city) => `On-duty pharmacy information for ${city}`,
    dutyWeekTitle: (weekStart) => `On-duty pharmacies in Ticino: week of ${weekStart}`,
    dutyWeekDescription: 'Weekly schedule for Ticino areas with verified intervals only. This is not coverage for every Swiss canton or for Italian border pharmacies.',
    directoryDescription: 'Cross-border directory for Ticino and nearby Italian provinces. Each location shows its source, retrieval date and the distinction between identity, hours and optional services.',
    breadcrumbLabel: 'Pharmacies',
    keywords: 'pharmacies Ticino, on-duty pharmacies, Italian border pharmacies',
  },
  de: {
    hubTitle: 'Apotheken im Tessin und an der italienischen Grenze: Verzeichnis und Quellen',
    cantonTitle: 'Apotheken im Tessin',
    italyTitle: 'Italienische Apotheken an der Tessiner Grenze',
    dutyHubTitle: 'Notdienst-Apotheken im Tessin',
    dutyCityTitle: (city) => `Informationen zum Apotheken-Notdienst in ${city}`,
    dutyWeekTitle: (weekStart) => `Notdienst-Apotheken im Tessin: Woche ab ${weekStart}`,
    dutyWeekDescription: 'Wochenplan für Tessiner Regionen mit verifizierten Zeiträumen. Dies ist keine Abdeckung aller Schweizer Kantone oder der italienischen Grenzapotheken.',
    directoryDescription: 'Grenzüberschreitendes Verzeichnis für das Tessin und nahe italienische Provinzen. Jede Seite zeigt Quelle, Abrufdatum und die Trennung von Identität, Zeiten und optionalen Leistungen.',
    breadcrumbLabel: 'Apotheken',
    keywords: 'Apotheken Tessin, Notdienst-Apotheken, italienische Grenzapotheken',
  },
  fr: {
    hubTitle: 'Pharmacies au Tessin et à la frontière italienne : répertoire et sources',
    cantonTitle: 'Pharmacies au Tessin',
    italyTitle: 'Pharmacies italiennes près de la frontière du Tessin',
    dutyHubTitle: 'Pharmacies de garde au Tessin',
    dutyCityTitle: (city) => `Informations de garde pour ${city}`,
    dutyWeekTitle: (weekStart) => `Pharmacies de garde au Tessin : semaine du ${weekStart}`,
    dutyWeekDescription: 'Planning hebdomadaire des régions tessinoises dont les intervalles sont vérifiés. Il ne couvre pas tous les cantons suisses ni les pharmacies italiennes de la frontière.',
    directoryDescription: 'Répertoire transfrontalier du Tessin et des provinces italiennes voisines. Chaque site montre sa source, sa date de collecte et distingue identité, horaires et services optionnels.',
    breadcrumbLabel: 'Pharmacies',
    keywords: 'pharmacies Tessin, pharmacies de garde, pharmacies frontière italienne',
  },
};

function pharmacyCityName(path: PharmacyPath): string | null {
  if (!path.citySlug) return null;
  if (path.country === 'IT' || path.areaSlug) {
    const area = path.areaSlug ? ITALY_PROVINCE_BY_SLUG.get(path.areaSlug) : undefined;
    return area ? ITALY_CITY_BY_PROVINCE_AND_SLUG.get(`${area.code}:${path.citySlug}`) || null : null;
  }
  return TICINO_CITY_BY_SLUG.get(path.citySlug) || null;
}

function pharmacyPathForRecord(pharmacy: Pharmacy, locale: Locale): PharmacyPath {
  return pharmacy.country === 'IT'
    ? {
      kind: 'pharmacy',
      country: 'IT',
      areaSlug: provinceSlugForPharmacy(pharmacy),
      citySlug: pharmacyCitySlug(pharmacy.city),
      pharmacySlug: pharmacy.slug,
      locale,
    }
    : {
      kind: 'pharmacy',
      country: 'CH',
      citySlug: pharmacyCitySlug(pharmacy.city),
      pharmacySlug: pharmacy.slug,
      locale,
    };
}

function pharmacyRuntimeTitle(path: PharmacyPath, locale: Locale): { title: string; resolved: boolean; pharmacy?: Pharmacy } {
  const copy = RUNTIME_PHARMACY_COPY[locale];
  if (path.kind === 'hub') return { title: copy.hubTitle, resolved: true };
  if (path.kind === 'canton') return { title: copy.cantonTitle, resolved: true };
  if (path.kind === 'country') return { title: copy.italyTitle, resolved: true };
  if (path.kind === 'duty-hub') return { title: copy.dutyHubTitle, resolved: true };
  if (path.kind === 'duty-week') {
    return path.weekStart
      ? { title: copy.dutyWeekTitle(path.weekStart), resolved: true }
      : { title: copy.dutyHubTitle, resolved: false };
  }
  if (path.kind === 'duty-city') {
    const city = pharmacyCityName(path);
    return city ? { title: copy.dutyCityTitle(city), resolved: true } : { title: copy.dutyHubTitle, resolved: false };
  }
  if (path.kind === 'area') {
    const area = path.areaSlug ? ITALY_PROVINCE_BY_SLUG.get(path.areaSlug) : undefined;
    return area
      ? { title: locale === 'it' ? `Farmacie in provincia di ${area.name}` : locale === 'en' ? `Pharmacies in ${area.name} province` : locale === 'de' ? `Apotheken in der Provinz ${area.name}` : `Pharmacies dans la province de ${area.name}`, resolved: true }
      : { title: copy.italyTitle, resolved: false };
  }
  if (path.kind === 'city') {
    const city = pharmacyCityName(path);
    if (!city) return { title: path.country === 'IT' ? copy.italyTitle : copy.cantonTitle, resolved: false };
    return {
      title: path.country === 'IT'
        ? (locale === 'de' ? `Apotheken in ${city}` : locale === 'fr' ? `Pharmacies à ${city}` : locale === 'en' ? `Pharmacies in ${city}` : `Farmacie a ${city}`)
        : (locale === 'de' ? `Apotheken in ${city}, Tessin` : locale === 'fr' ? `Pharmacies à ${city}, Tessin` : locale === 'en' ? `Pharmacies in ${city}, Ticino` : `Farmacie a ${city}, Ticino`),
      resolved: true,
    };
  }
  if (path.kind === 'pharmacy') {
    const pharmacy = path.pharmacySlug ? pharmacyBySlug(path.pharmacySlug) : undefined;
    const expectedCountry = path.country || (path.areaSlug ? 'IT' : 'CH');
    const matchesRoute = Boolean(pharmacy)
      && pharmacy!.country === expectedCountry
      && pharmacyCitySlug(pharmacy!.city) === path.citySlug
      && (expectedCountry !== 'IT' || provinceSlugForPharmacy(pharmacy!) === path.areaSlug);
    return matchesRoute
      ? { title: buildPharmacyTitle(pharmacy!, BORDER_PHARMACIES), resolved: true, pharmacy }
      : { title: expectedCountry === 'IT' ? copy.italyTitle : copy.cantonTitle, resolved: false };
  }
  return { title: copy.hubTitle, resolved: false };
}

function pharmaciesForCollection(path: PharmacyPath): Pharmacy[] | null {
  if (path.kind === 'hub') return BORDER_PHARMACIES;
  if (path.kind === 'canton') return TICINO_PHARMACIES;
  if (path.kind === 'country' && path.country === 'IT') return ITALY_BORDER_PHARMACIES;
  if (path.kind === 'area' && path.areaSlug) {
    const province = ITALY_PROVINCE_BY_SLUG.get(path.areaSlug);
    return province ? pharmaciesForProvince(province.code) : null;
  }
  if (path.kind === 'city') {
    const city = pharmacyCityName(path);
    if (!city) return null;
    if (path.country === 'IT' && path.areaSlug) {
      const province = ITALY_PROVINCE_BY_SLUG.get(path.areaSlug);
      return province
        ? ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === province.code && pharmacy.city === city)
        : null;
    }
    return pharmaciesForCity(city);
  }
  if (path.kind === 'duty-hub') {
    const duties = Array.isArray(RUNTIME_PHARMACY_DUTIES.duties) ? RUNTIME_PHARMACY_DUTIES.duties : [];
    const regions = [...new Set(duties.map((duty) => duty.coverageName))];
    return regions
      .map((region) => currentDutyForRegion(RUNTIME_PHARMACY_DUTIES, region))
      .filter((duty): duty is NonNullable<typeof duty> => Boolean(duty))
      .map((duty) => pharmacyById(duty.pharmacyId))
      .filter((pharmacy): pharmacy is Pharmacy => Boolean(pharmacy));
  }
  return null;
}

const MAX_COLLECTION_SCHEMA_ITEMS = 10;

function pharmacyDetailStructuredData(pharmacy: Pharmacy, locale: Locale): Record<string, any> {
  const path = pharmacyPathForRecord(pharmacy, locale);
  const website = safePharmacyUrl(pharmacy.website);
  return {
    '@context': 'https://schema.org',
    '@type': 'Pharmacy',
    name: pharmacy.name,
    url: `${BASE_URL}${buildPharmacyPath(path, locale)}`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: pharmacy.address,
      postalCode: pharmacy.postalCode,
      addressLocality: pharmacy.city,
      addressCountry: pharmacy.country,
    },
    ...(pharmacy.phone ? { telephone: pharmacy.phone } : {}),
    ...(website ? { sameAs: website } : {}),
    ...(pharmacy.latitude !== undefined && pharmacy.longitude !== undefined
      ? { geo: { '@type': 'GeoCoordinates', latitude: pharmacy.latitude, longitude: pharmacy.longitude } }
      : {}),
    ...(pharmacy.openingHours?.length
      ? {
        openingHoursSpecification: pharmacy.openingHours.map((hour) => ({
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: `https://schema.org/${hour.dayOfWeek.charAt(0).toUpperCase()}${hour.dayOfWeek.slice(1)}`,
          opens: hour.opens,
          closes: hour.closes,
        })),
      }
      : {}),
  };
}

function collectionStructuredData(path: PharmacyPath, title: string, pharmacies: Pharmacy[]): Record<string, any> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(path, path.locale)}`,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: pharmacies.length,
      itemListElement: pharmacies.slice(0, MAX_COLLECTION_SCHEMA_ITEMS).map((pharmacy, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: pharmacy.name,
        url: `${BASE_URL}${buildPharmacyPath(pharmacyPathForRecord(pharmacy, path.locale), path.locale)}`,
      })),
    },
  };
}

function countryCollectionStructuredData(path: PharmacyPath, title: string): Record<string, any> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(path, path.locale)}`,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: ITALY_BORDER_PROVINCES.length,
      itemListElement: ITALY_BORDER_PROVINCES.map((province, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: province.name,
        url: `${BASE_URL}${buildPharmacyPath({ kind: 'area', country: 'IT', areaSlug: province.slug, locale: path.locale }, path.locale)}`,
      })),
    },
  };
}

function dutyWeekStructuredData(path: PharmacyPath, title: string, model: ReturnType<typeof buildDutyWeekModel>): Record<string, any> | undefined {
  if (!model.indexable) return undefined;
  const duties = model.regions.flatMap((region) => region.duties);
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(path, path.locale)}`,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: duties.length,
      itemListElement: duties.slice(0, MAX_COLLECTION_SCHEMA_ITEMS).flatMap((duty, index) => {
        const pharmacy = pharmacyById(duty.pharmacyId);
        return pharmacy
          ? [{
            '@type': 'ListItem',
            position: index + 1,
            name: `${pharmacy.name} — ${duty.coverageName}`,
            url: `${BASE_URL}${buildPharmacyPath(pharmacyPathForRecord(pharmacy, path.locale), path.locale)}`,
          }]
          : [];
      }),
    },
  };
}

function pharmacyBreadcrumbStructuredData(path: PharmacyPath, title: string): Record<string, any> {
  const copy = RUNTIME_PHARMACY_COPY[path.locale];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbLabel, item: `${BASE_URL}${buildPharmacyPath({ kind: 'hub', locale: path.locale }, path.locale)}` },
      { '@type': 'ListItem', position: 2, name: title, item: `${BASE_URL}${buildPharmacyPath(path, path.locale)}` },
    ],
  };
}

/**
 * Resolve the metadata that must survive a route-driven SPA transition.
 * Weekly indexability is deliberately delegated to the same read model used
 * by the static page; any unknown, stale, conflicting or unsupported payload
 * therefore remains `noindex,follow`.
 */
export function resolvePharmacySeoMetadata(
  path: PharmacyPath,
  options: {
    now?: Date;
    duties?: PharmacyDutiesDataset;
    catalogue?: PharmacyCatalogueDataset;
  } = {},
): PharmacyRuntimeSeoMetadata {
  const locale = path.locale;
  const copy = RUNTIME_PHARMACY_COPY[locale];
  const { title, resolved, pharmacy } = pharmacyRuntimeTitle(path, locale);
  const model = path.kind === 'duty-week' && path.weekStart
    ? buildDutyWeekModel(options.duties ?? RUNTIME_PHARMACY_DUTIES, path.weekStart, {
      now: options.now,
      catalogue: options.catalogue ?? RUNTIME_PHARMACY_CATALOGUE,
    })
    : null;
  const indexable = resolved && path.kind !== 'duty-city' && (model ? model.indexable : true);
  const description = model
    ? copy.dutyWeekDescription
    : `${title}. ${copy.directoryDescription}`;
  const canonicalPath = buildPharmacyPath(path, locale);
  const collectionPharmacies = pharmaciesForCollection(path);
  const primaryStructuredData = pharmacy
    ? pharmacyDetailStructuredData(pharmacy, locale)
    : model
      ? dutyWeekStructuredData(path, title, model)
      : collectionPharmacies
        ? path.kind === 'country'
          ? countryCollectionStructuredData(path, title)
          : collectionStructuredData(path, title, collectionPharmacies)
        : undefined;
  const breadcrumb = indexable ? pharmacyBreadcrumbStructuredData(path, title) : undefined;
  const structuredData = primaryStructuredData && breadcrumb
    ? [primaryStructuredData, breadcrumb]
    : primaryStructuredData || breadcrumb;
  return {
    title,
    description,
    keywords: copy.keywords,
    ogTitle: title,
    ogDescription: description,
    canonicalPath,
    robots: indexable ? 'index,follow' : 'noindex,follow',
    ...(structuredData ? { structuredData } : {}),
  };
}
