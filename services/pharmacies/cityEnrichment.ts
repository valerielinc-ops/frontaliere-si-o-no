import { BORDER_PHARMACIES } from './data';
import { publicDutiesForRegion } from './duties';
import type { Locale } from '../i18n';
import { buildItalyDutyWeekModel, currentItalyDutyWeekStart } from './italyDuty';
import type { Pharmacy, PharmacyCatalogueDataset, PharmacyDuty, PharmacyDutiesDataset } from './types';

export const NEARBY_PHARMACY_LIMIT = 3;

export const SINGLE_CITY_COPY: Record<Locale, {
  heading: string;
  nearby: string;
  noCoordinates: string;
  noNearby: string;
  hours: string;
  hoursUnavailable: string;
  hoursClosed: string;
  distance: string;
  distanceMethod: string;
  duty: string;
  dutyArea: string;
  dutyUnavailable: string;
  source: string;
}> = {
  it: {
    heading: 'Farmacie vicine, orari e turni', nearby: 'Sedi più vicine nel catalogo con coordinate pubblicate',
    noCoordinates: 'La scheda di questa località non ha coordinate verificabili: non calcoliamo distanze né ordiniamo le altre sedi come vicine.',
    noNearby: 'Il catalogo non contiene altre sedi con coordinate pubblicate da confrontare.',
    hours: 'Orari pubblicati', hoursUnavailable: 'La fonte non pubblica orari verificabili per questa sede.', hoursClosed: 'chiusa secondo gli orari pubblicati',
    distance: 'Distanza', distanceMethod: 'in linea d’aria tra le coordinate pubblicate', duty: 'Turno verificato più vicino',
    dutyArea: 'Il calendario copre l’area indicata e non garantisce un servizio nella singola località.',
    dutyUnavailable: 'Il dataset corrente non offre un intervallo di turno verificato e pubblicabile collegabile a questa località o area.',
    source: 'Fonte del turno',
  },
  en: {
    heading: 'Nearby pharmacies, hours and duty', nearby: 'Closest locations in the directory with published coordinates',
    noCoordinates: 'This locality record has no verifiable coordinates, so distances cannot be calculated and other locations are not ranked as nearby.',
    noNearby: 'The directory has no other locations with published coordinates to compare.',
    hours: 'Published hours', hoursUnavailable: 'The source does not publish verifiable hours for this location.', hoursClosed: 'closed according to published hours',
    distance: 'Distance', distanceMethod: 'straight line between published coordinates', duty: 'Nearest verified duty interval',
    dutyArea: 'The schedule covers the stated area and does not guarantee service in this individual locality.',
    dutyUnavailable: 'The current dataset has no verified, publishable duty interval that can be linked to this locality or area.',
    source: 'Duty source',
  },
  de: {
    heading: 'Apotheken in der Nähe, Öffnungszeiten und Notdienst', nearby: 'Nächstgelegene Standorte im Verzeichnis mit veröffentlichten Koordinaten',
    noCoordinates: 'Für diesen Ortseintrag liegen keine überprüfbaren Koordinaten vor. Deshalb berechnen wir keine Entfernungen und ordnen andere Standorte nicht als nahe ein.',
    noNearby: 'Das Verzeichnis enthält keine weiteren Standorte mit veröffentlichten Koordinaten zum Vergleichen.',
    hours: 'Veröffentlichte Öffnungszeiten', hoursUnavailable: 'Die Quelle veröffentlicht für diesen Standort keine überprüfbaren Öffnungszeiten.', hoursClosed: 'laut veröffentlichten Zeiten geschlossen',
    distance: 'Entfernung', distanceMethod: 'Luftlinie zwischen den veröffentlichten Koordinaten', duty: 'Nächster verifizierter Notdienstzeitraum',
    dutyArea: 'Der Plan gilt für das angegebene Gebiet und garantiert keinen Dienst in diesem einzelnen Ort.',
    dutyUnavailable: 'Der aktuelle Datensatz enthält keinen verifizierten und veröffentlichbaren Notdienstzeitraum, der diesem Ort oder Gebiet zugeordnet werden kann.',
    source: 'Quelle des Notdienstes',
  },
  fr: {
    heading: 'Pharmacies proches, horaires et garde', nearby: 'Sites les plus proches du répertoire avec des coordonnées publiées',
    noCoordinates: 'La fiche de cette localité ne contient pas de coordonnées vérifiables : nous ne calculons pas de distances et ne classons pas d’autres sites comme proches.',
    noNearby: 'Le répertoire ne contient pas d’autres sites avec des coordonnées publiées à comparer.',
    hours: 'Horaires publiés', hoursUnavailable: 'La source ne publie pas d’horaires vérifiables pour ce site.', hoursClosed: 'fermée selon les horaires publiés',
    distance: 'Distance', distanceMethod: 'à vol d’oiseau entre les coordonnées publiées', duty: 'Prochain intervalle de garde vérifié',
    dutyArea: 'Le calendrier couvre la zone indiquée et ne garantit pas un service dans cette localité.',
    dutyUnavailable: 'Le jeu actuel ne contient aucun intervalle de garde vérifié et publiable lié à cette localité ou zone.',
    source: 'Source de la garde',
  },
};

export interface NearbyPharmacy {
  readonly pharmacy: Pharmacy;
  readonly distanceKm: number;
}

export interface VerifiedCityDuty {
  readonly duty: PharmacyDuty;
  readonly sourceUrl: string;
}

const nearestCache = new WeakMap<Pharmacy, {
  readonly catalogue: readonly Pharmacy[];
  readonly nearest: NearbyPharmacy[];
}>();
const publishedHoursCache = new WeakMap<Pharmacy, Map<Locale, string>>();
const hoursDayLabelsCache = new Map<Locale, ReadonlyMap<string, string>>();
const verifiedDutyCache = new WeakMap<Pharmacy, {
  readonly dataset: PharmacyDutiesDataset;
  readonly ticinoCatalogue?: PharmacyCatalogueDataset;
  readonly at: number;
  readonly duty: VerifiedCityDuty | null;
}>();
let cachedItalyDutyModel: { at: number; model: ReturnType<typeof buildItalyDutyWeekModel> } | undefined;

export function hasValidPharmacyCoordinates(pharmacy: Pharmacy): boolean {
  return Number.isFinite(pharmacy.latitude)
    && Number.isFinite(pharmacy.longitude)
    && pharmacy.latitude! >= -90
    && pharmacy.latitude! <= 90
    && pharmacy.longitude! >= -180
    && pharmacy.longitude! <= 180;
}

function distanceKm(from: Pharmacy, to: Pharmacy): number | null {
  if (!hasValidPharmacyCoordinates(from) || !hasValidPharmacyCoordinates(to)) return null;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latDelta = radians(to.latitude! - from.latitude!);
  const lonDelta = radians(to.longitude! - from.longitude!);
  const latFrom = radians(from.latitude!);
  const latTo = radians(to.latitude!);
  const haversine = Math.sin(latDelta / 2) ** 2
    + Math.cos(latFrom) * Math.cos(latTo) * Math.sin(lonDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function nearestPharmacies(
  pharmacy: Pharmacy,
  catalogue: readonly Pharmacy[] = BORDER_PHARMACIES,
): NearbyPharmacy[] {
  if (!hasValidPharmacyCoordinates(pharmacy)) return [];
  const cached = nearestCache.get(pharmacy);
  if (cached?.catalogue === catalogue) return cached.nearest;
  const nearest = catalogue
    .filter((candidate) => candidate.id !== pharmacy.id && hasValidPharmacyCoordinates(candidate))
    .map((candidate) => ({ pharmacy: candidate, distanceKm: distanceKm(pharmacy, candidate) }))
    .filter((entry): entry is NearbyPharmacy => entry.distanceKm !== null)
    .sort((left, right) => left.distanceKm - right.distanceKm || left.pharmacy.id.localeCompare(right.pharmacy.id))
    .slice(0, NEARBY_PHARMACY_LIMIT);
  nearestCache.set(pharmacy, { catalogue, nearest });
  return nearest;
}

function currentItalyDutyModel(now: Date): ReturnType<typeof buildItalyDutyWeekModel> {
  const at = now.getTime();
  if (cachedItalyDutyModel?.at === at) return cachedItalyDutyModel.model;
  const model = buildItalyDutyWeekModel({ now, weekStart: currentItalyDutyWeekStart(now) });
  cachedItalyDutyModel = { at, model };
  return model;
}

export function nextVerifiedCityDuty(
  pharmacy: Pharmacy,
  dataset: PharmacyDutiesDataset,
  now: Date,
  ticinoCatalogue?: PharmacyCatalogueDataset,
): VerifiedCityDuty | null {
  const at = now.getTime();
  const cached = verifiedDutyCache.get(pharmacy);
  if (cached?.dataset === dataset && cached.ticinoCatalogue === ticinoCatalogue && cached.at === at) {
    return cached.duty;
  }
  const afterNow = (duty: PharmacyDuty) => Date.parse(duty.endsAt) > now.getTime();
  let result: VerifiedCityDuty | null;
  if (pharmacy.country === 'CH') {
    const coverageNames = [...new Set((Array.isArray(dataset.duties) ? dataset.duties : [])
      .filter((duty) => duty.pharmacyId === pharmacy.id && duty.coverageType === 'region')
      .map((duty) => duty.coverageName))];
    if (coverageNames.length !== 1) {
      result = null;
    } else {
      const [coverageName] = coverageNames;
      const duty = publicDutiesForRegion(dataset, coverageName, now, ticinoCatalogue)
        .find(afterNow);
      result = duty ? { duty, sourceUrl: duty.sourceUrl } : null;
    }
  } else {
    const province = currentItalyDutyModel(now).provinces.find((entry) => entry.code === pharmacy.province);
    if (!province?.publishable) result = null;
    else {
      const duty = province.duties.find(afterNow);
      result = duty ? { duty, sourceUrl: province.sourceUrl || duty.sourceUrl } : null;
    }
  }
  verifiedDutyCache.set(pharmacy, { dataset, ticinoCatalogue, at, duty: result });
  return result;
}

export function publishedHoursText(pharmacy: Pharmacy, locale: Locale): string {
  const cachedByLocale = publishedHoursCache.get(pharmacy);
  const cached = cachedByLocale?.get(locale);
  if (cached !== undefined) return cached;
  const labels = SINGLE_CITY_COPY[locale];
  if (!pharmacy.openingHours?.length) {
    const fallback = labels.hoursUnavailable;
    const localizedCache = cachedByLocale || new Map<Locale, string>();
    localizedCache.set(locale, fallback);
    if (!cachedByLocale) publishedHoursCache.set(pharmacy, localizedCache);
    return fallback;
  }
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  let dayLabels = hoursDayLabelsCache.get(locale);
  if (!dayLabels) {
    const localeTag = locale === 'it' ? 'it-CH' : locale;
    const formatter = new Intl.DateTimeFormat(localeTag, { weekday: 'long', timeZone: 'UTC' });
    dayLabels = new Map(weekdays.map((day, index) => [
      day,
      formatter.format(new Date(Date.UTC(2024, 0, index + 1))),
    ]));
    hoursDayLabelsCache.set(locale, dayLabels);
  }
  const result = pharmacy.openingHours.map((hour) => {
    const day = dayLabels.get(hour.dayOfWeek) || hour.dayOfWeek;
    const interval = hour.isClosed ? labels.hoursClosed : `${hour.opens}–${hour.closes}`;
    return `${day}: ${interval}`;
  }).join('; ');
  const localizedCache = cachedByLocale || new Map<Locale, string>();
  localizedCache.set(locale, result);
  if (!cachedByLocale) publishedHoursCache.set(pharmacy, localizedCache);
  return result;
}
