import dutiesJson from '../../data/pharmacy-duties-ticino.json';
import registryJson from '../../data/pharmacy-sources-registry.json';
import catalogueJson from '../../data/pharmacies-ticino-complete.json';
import type { Locale } from '../i18n';
import {
  buildDutyWeekModel,
  currentDutyWeekStart,
  DUTY_WEEK_REGIONS,
  formatDutyDateTime,
  type DutyWeekStatus,
} from './dutyWeek';
import { SWISS_CANTONS, type SwissCanton } from './swissCantons';
import type {
  PharmacyCatalogueDataset,
  PharmacyDutiesDataset,
  PharmacyDuty,
  PharmacySourceStatus,
  PharmacySourceType,
  PharmacySourcesRegistry,
} from './types';

const DEFAULT_DUTIES = dutiesJson as unknown as PharmacyDutiesDataset;
const DEFAULT_CATALOGUE = catalogueJson as unknown as PharmacyCatalogueDataset;
const DEFAULT_REGISTRY = registryJson as unknown as PharmacySourcesRegistry;

export interface DutyCoverageRegion {
  readonly key: string;
  readonly name: string;
  readonly duties: readonly PharmacyDuty[];
  readonly sourceUrl: string | null;
}

/**
 * A non-Ticino canton is deliberately represented as source metadata only.
 * Do not add pharmacy, duty, opening-hours or schedule fields here: this is
 * the boundary that prevents the coverage matrix from implying unsupported
 * operational coverage.
 */
export interface DutyCoverageSourceOnlyCanton {
  readonly code: string;
  readonly key: string;
  readonly name: string;
  readonly status: PharmacySourceStatus | null;
  readonly sourceType: PharmacySourceType | null;
  readonly lastVerifiedAt: string | null;
  readonly officialSourceUrl: string | null;
}

export interface DutyCoverageMatrixModel {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly fetchedAt: string | null;
  readonly status: DutyWeekStatus;
  readonly releaseReady: boolean;
  readonly reason: string;
  readonly regions: readonly DutyCoverageRegion[];
  readonly sourceOnlyCantons: readonly DutyCoverageSourceOnlyCanton[];
}

export interface BuildDutyCoverageMatrixOptions {
  locale?: Locale;
  now?: Date;
  weekStart?: string;
  duties?: PharmacyDutiesDataset;
  catalogue?: PharmacyCatalogueDataset;
  registry?: PharmacySourcesRegistry;
}

export interface DutyCoverageMatrixCopy {
  heading: string;
  lede: string;
  ticinoHeading: string;
  readyNotice: string;
  unavailableNotice: (status: DutyWeekStatus) => string;
  sourceOnlyHeading: string;
  sourceOnlyLede: string;
  sourceOnlyLabel: string;
  status: string;
  sourceType: string;
  lastVerifiedAt: string;
  officialSource: string;
  openOfficialSource: string;
  source: string;
  openSource: string;
  interval: string;
  pharmacy: string;
  noIntervals: string;
  notAvailable: string;
  notResolved: string;
  statusLabel: (status: PharmacySourceStatus | null) => string;
  sourceTypeLabel: (sourceType: PharmacySourceType | null) => string;
}

const SOURCE_ONLY_CANTONS = SWISS_CANTONS.filter((canton) => canton.code !== 'TI');

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? value.trim() : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceOnlyCanton(canton: SwissCanton, registry: PharmacySourcesRegistry, locale: Locale): DutyCoverageSourceOnlyCanton {
  const source = registry.sources?.[canton.key];
  return Object.freeze({
    code: canton.code,
    key: canton.key,
    name: canton.names[locale],
    status: source?.status ?? null,
    sourceType: source?.sourceType ?? null,
    lastVerifiedAt: nonEmptyString(source?.lastVerifiedAt),
    officialSourceUrl: httpsUrl(source?.officialSourceUrl),
  });
}

function regionSourceUrl(
  regionKey: string,
  duties: readonly PharmacyDuty[],
  dataset: PharmacyDutiesDataset,
  fallback: string | null,
): string | null {
  const releaseRegion = dataset._release?.regions?.[regionKey as keyof typeof dataset._release.regions];
  return httpsUrl(releaseRegion?.sourceUrl) ?? httpsUrl(duties[0]?.sourceUrl) ?? httpsUrl(fallback);
}

export function buildDutyCoverageMatrix(options: BuildDutyCoverageMatrixOptions = {}): DutyCoverageMatrixModel {
  const now = options.now ?? new Date();
  const locale = options.locale ?? 'it';
  const dataset = options.duties ?? DEFAULT_DUTIES;
  const catalogue = options.catalogue ?? DEFAULT_CATALOGUE;
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const weekStart = options.weekStart ?? currentDutyWeekStart(now);
  const week = buildDutyWeekModel(dataset, weekStart, { now, catalogue });
  const releaseReady = week.status === 'ready' && week.indexable;

  const regions = DUTY_WEEK_REGIONS.map((region) => {
    const weekRegion = week.regions.find((candidate) => candidate.key === region.key);
    const duties = releaseReady ? weekRegion?.duties ?? [] : [];
    return Object.freeze({
      key: region.key,
      name: region.name,
      duties,
      sourceUrl: releaseReady ? regionSourceUrl(region.key, duties, dataset, week.sourceUrl) : null,
    });
  });

  return Object.freeze({
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    fetchedAt: week.fetchedAt,
    status: week.status,
    releaseReady,
    reason: week.reason,
    regions: Object.freeze(regions),
    sourceOnlyCantons: Object.freeze(SOURCE_ONLY_CANTONS.map((canton) => sourceOnlyCanton(canton, registry, locale))),
  });
}

export function formatDutyCoverageDate(value: string | null, locale: Locale): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, {
    dateStyle: 'medium',
    timeZone: 'Europe/Zurich',
  }).format(date);
}

export function getDutyCoverageMatrixCopy(locale: Locale): DutyCoverageMatrixCopy {
  const copies: Record<Locale, DutyCoverageMatrixCopy> = {
    it: {
      heading: 'Matrice di copertura delle farmacie di turno',
      lede: 'Il calendario operativo verificato riguarda cinque regioni del Ticino. Gli altri 25 cantoni sono presenti solo come riferimenti alle fonti.',
      ticinoHeading: 'Ticino · cinque regioni con turni pubblicati',
      readyNotice: 'Release completa e fresca: gli intervalli verificati sono mostrati per la settimana corrente.',
      unavailableNotice: (status) => `Turni non mostrati: la release non è pronta per la pubblicazione (${status}).`,
      sourceOnlyHeading: 'Altri 25 cantoni · solo fonte',
      sourceOnlyLede: 'Per questi cantoni mostriamo soltanto stato, tipo di fonte, ultima verifica e collegamento ufficiale. Non pubblichiamo farmacie, date, orari o turni.',
      sourceOnlyLabel: 'Solo fonte',
      status: 'Stato',
      sourceType: 'Tipo di fonte',
      lastVerifiedAt: 'Ultima verifica',
      officialSource: 'Fonte ufficiale',
      openOfficialSource: 'Apri la fonte ufficiale',
      source: 'Fonte del turno',
      openSource: 'Apri la fonte del turno',
      interval: 'Intervallo',
      pharmacy: 'Farmacia',
      noIntervals: 'Nessun intervallo verificato per questa regione.',
      notAvailable: 'Non disponibile',
      notResolved: 'Identità non risolta',
      statusLabel: (status) => ({ unverified: 'non verificata', active: 'attiva', blocked: 'bloccata', degraded: 'degradata' }[status || ''] || 'non disponibile'),
      sourceTypeLabel: (sourceType) => ({ official: 'ufficiale', association: 'associazione', pharmacy: 'farmacia', verified_partner: 'partner verificato', directory: 'directory' }[sourceType || ''] || 'non disponibile'),
    },
    en: {
      heading: 'On-duty pharmacy coverage matrix',
      lede: 'Verified operational coverage covers five Ticino regions. The other 25 cantons appear only as source references.',
      ticinoHeading: 'Ticino · five regions with published duties',
      readyNotice: 'Complete and fresh release: verified intervals are shown for the current week.',
      unavailableNotice: (status) => `Duties are hidden: the release is not ready for publication (${status}).`,
      sourceOnlyHeading: 'Other 25 cantons · source only',
      sourceOnlyLede: 'For these cantons we show only source status, source type, last verification and the official link. No pharmacies, dates, hours or duties are published.',
      sourceOnlyLabel: 'Source only',
      status: 'Status',
      sourceType: 'Source type',
      lastVerifiedAt: 'Last verified',
      officialSource: 'Official source',
      openOfficialSource: 'Open official source',
      source: 'Duty source',
      openSource: 'Open duty source',
      interval: 'Interval',
      pharmacy: 'Pharmacy',
      noIntervals: 'No verified interval for this region.',
      notAvailable: 'Not available',
      notResolved: 'Identity not resolved',
      statusLabel: (status) => ({ unverified: 'unverified', active: 'active', blocked: 'blocked', degraded: 'degraded' }[status || ''] || 'not available'),
      sourceTypeLabel: (sourceType) => ({ official: 'official', association: 'association', pharmacy: 'pharmacy', verified_partner: 'verified partner', directory: 'directory' }[sourceType || ''] || 'not available'),
    },
    de: {
      heading: 'Abdeckungsmatrix für Notdienst-Apotheken',
      lede: 'Die verifizierte operative Abdeckung umfasst fünf Tessiner Regionen. Die anderen 25 Kantone erscheinen nur als Quellenreferenzen.',
      ticinoHeading: 'Tessin · fünf Regionen mit veröffentlichtem Notdienst',
      readyNotice: 'Vollständige und aktuelle Veröffentlichung: Verifizierte Zeiträume der laufenden Woche werden angezeigt.',
      unavailableNotice: (status) => `Notdienste werden nicht angezeigt: Die Veröffentlichung ist nicht bereit (${status}).`,
      sourceOnlyHeading: 'Andere 25 Kantone · nur Quelle',
      sourceOnlyLede: 'Für diese Kantone zeigen wir nur Quellenstatus, Quellentyp, letzte Prüfung und den offiziellen Link. Apotheken, Daten, Uhrzeiten und Notdienste werden nicht veröffentlicht.',
      sourceOnlyLabel: 'Nur Quelle',
      status: 'Status',
      sourceType: 'Quellentyp',
      lastVerifiedAt: 'Zuletzt geprüft',
      officialSource: 'Offizielle Quelle',
      openOfficialSource: 'Offizielle Quelle öffnen',
      source: 'Notdienstquelle',
      openSource: 'Notdienstquelle öffnen',
      interval: 'Zeitraum',
      pharmacy: 'Apotheke',
      noIntervals: 'Kein verifizierter Zeitraum für diese Region.',
      notAvailable: 'Nicht verfügbar',
      notResolved: 'Identität nicht aufgelöst',
      statusLabel: (status) => ({ unverified: 'nicht verifiziert', active: 'aktiv', blocked: 'blockiert', degraded: 'eingeschränkt' }[status || ''] || 'nicht verfügbar'),
      sourceTypeLabel: (sourceType) => ({ official: 'offiziell', association: 'Verband', pharmacy: 'Apotheke', verified_partner: 'verifizierter Partner', directory: 'Verzeichnis' }[sourceType || ''] || 'nicht verfügbar'),
    },
    fr: {
      heading: 'Matrice de couverture des pharmacies de garde',
      lede: 'La couverture opérationnelle vérifiée concerne cinq régions tessinoises. Les 25 autres cantons apparaissent uniquement comme références de sources.',
      ticinoHeading: 'Tessin · cinq régions avec gardes publiées',
      readyNotice: 'Publication complète et récente : les intervalles vérifiés de la semaine en cours sont affichés.',
      unavailableNotice: (status) => `Les gardes sont masquées : la publication n’est pas prête (${status}).`,
      sourceOnlyHeading: '25 autres cantons · source uniquement',
      sourceOnlyLede: 'Pour ces cantons, nous affichons uniquement le statut, le type de source, la dernière vérification et le lien officiel. Aucune pharmacie, date, heure ou garde n’est publiée.',
      sourceOnlyLabel: 'Source uniquement',
      status: 'Statut',
      sourceType: 'Type de source',
      lastVerifiedAt: 'Dernière vérification',
      officialSource: 'Source officielle',
      openOfficialSource: 'Ouvrir la source officielle',
      source: 'Source de la garde',
      openSource: 'Ouvrir la source de la garde',
      interval: 'Intervalle',
      pharmacy: 'Pharmacie',
      noIntervals: 'Aucun intervalle vérifié pour cette région.',
      notAvailable: 'Indisponible',
      notResolved: 'Identité non résolue',
      statusLabel: (status) => ({ unverified: 'non vérifiée', active: 'active', blocked: 'bloquée', degraded: 'dégradée' }[status || ''] || 'indisponible'),
      sourceTypeLabel: (sourceType) => ({ official: 'officielle', association: 'association', pharmacy: 'pharmacie', verified_partner: 'partenaire vérifié', directory: 'annuaire' }[sourceType || ''] || 'indisponible'),
    },
  };
  return copies[locale];
}

export { formatDutyDateTime };
