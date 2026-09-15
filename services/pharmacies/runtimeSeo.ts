import type { Locale } from '../i18n';
import type { SEOMetadata } from '../seoService';
import {
  ITALY_CITY_BY_PROVINCE_AND_SLUG,
  ITALY_PROVINCE_BY_SLUG,
  TICINO_CITY_BY_SLUG,
  pharmacyBySlug,
  pharmacyCitySlug,
  provinceSlugForPharmacy,
} from './data';
import { buildPharmacyPath, type PharmacyPath } from './paths';
import { buildDutyWeekModel } from './dutyWeek';
import type { PharmacyCatalogueDataset, PharmacyDutiesDataset } from './types';
import dutiesJson from '../../data/pharmacy-duties-ticino.json';
import completeTicinoJson from '../../data/pharmacies-ticino-complete.json';

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
  keywords: string;
}> = {
  it: {
    hubTitle: 'Farmacie in Ticino e al confine italiano: elenco e fonti',
    cantonTitle: 'Farmacie in Ticino',
    italyTitle: 'Farmacie italiane al confine con il Ticino',
    dutyHubTitle: 'Farmacie di turno in Ticino',
    dutyCityTitle: (city) => `Farmacia di turno: informazioni per ${city}`,
    dutyWeekTitle: (weekStart) => `Farmacie di turno in Ticino: settimana del ${weekStart}`,
    dutyWeekDescription: 'Calendario settimanale delle sole aree OFCT con intervalli verificati. Non è una copertura di tutti i cantoni né delle farmacie italiane di confine.',
    directoryDescription: 'Directory transfrontaliera di Ticino e province italiane vicine. Ogni sede mostra la fonte, la data di recupero e separa i dati anagrafici dagli orari e dai servizi opzionali.',
    keywords: 'farmacie Ticino, farmacie di turno, farmacie confine Italia',
  },
  en: {
    hubTitle: 'Pharmacies in Ticino and across the Italian border: directory and sources',
    cantonTitle: 'Pharmacies in Ticino',
    italyTitle: 'Italian pharmacies near the Ticino border',
    dutyHubTitle: 'On-duty pharmacies in Ticino',
    dutyCityTitle: (city) => `On-duty pharmacy information for ${city}`,
    dutyWeekTitle: (weekStart) => `On-duty pharmacies in Ticino: week of ${weekStart}`,
    dutyWeekDescription: 'Weekly schedule for the OFCT areas with verified intervals only. This is not coverage for every Swiss canton or for Italian border pharmacies.',
    directoryDescription: 'Cross-border directory for Ticino and nearby Italian provinces. Each location shows its source, retrieval date and the distinction between identity, hours and optional services.',
    keywords: 'pharmacies Ticino, on-duty pharmacies, Italian border pharmacies',
  },
  de: {
    hubTitle: 'Apotheken im Tessin und an der italienischen Grenze: Verzeichnis und Quellen',
    cantonTitle: 'Apotheken im Tessin',
    italyTitle: 'Italienische Apotheken an der Tessiner Grenze',
    dutyHubTitle: 'Notdienst-Apotheken im Tessin',
    dutyCityTitle: (city) => `Informationen zum Apotheken-Notdienst in ${city}`,
    dutyWeekTitle: (weekStart) => `Notdienst-Apotheken im Tessin: Woche ab ${weekStart}`,
    dutyWeekDescription: 'Wochenplan nur für OFCT-Gebiete mit verifizierten Zeiträumen. Dies ist keine Abdeckung aller Schweizer Kantone oder der italienischen Grenzapotheken.',
    directoryDescription: 'Grenzüberschreitendes Verzeichnis für das Tessin und nahe italienische Provinzen. Jede Seite zeigt Quelle, Abrufdatum und die Trennung von Identität, Zeiten und optionalen Leistungen.',
    keywords: 'Apotheken Tessin, Notdienst-Apotheken, italienische Grenzapotheken',
  },
  fr: {
    hubTitle: 'Pharmacies au Tessin et à la frontière italienne : répertoire et sources',
    cantonTitle: 'Pharmacies au Tessin',
    italyTitle: 'Pharmacies italiennes près de la frontière du Tessin',
    dutyHubTitle: 'Pharmacies de garde au Tessin',
    dutyCityTitle: (city) => `Informations de garde pour ${city}`,
    dutyWeekTitle: (weekStart) => `Pharmacies de garde au Tessin : semaine du ${weekStart}`,
    dutyWeekDescription: 'Planning hebdomadaire limité aux zones OFCT dont les intervalles sont vérifiés. Il ne couvre pas tous les cantons suisses ni les pharmacies italiennes de la frontière.',
    directoryDescription: 'Répertoire transfrontalier du Tessin et des provinces italiennes voisines. Chaque site montre sa source, sa date de collecte et distingue identité, horaires et services optionnels.',
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

function pharmacyRuntimeTitle(path: PharmacyPath, locale: Locale): { title: string; resolved: boolean } {
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
      ? { title: `${pharmacy!.name} — ${pharmacy!.city}`, resolved: true }
      : { title: expectedCountry === 'IT' ? copy.italyTitle : copy.cantonTitle, resolved: false };
  }
  return { title: copy.hubTitle, resolved: false };
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
  const { title, resolved } = pharmacyRuntimeTitle(path, locale);
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
  return {
    title,
    description,
    keywords: copy.keywords,
    ogTitle: title,
    ogDescription: description,
    canonicalPath,
    robots: indexable ? 'index,follow' : 'noindex,follow',
  };
}
