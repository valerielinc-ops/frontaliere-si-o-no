import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Clock3,
  ExternalLink,
  LocateFixed,
  MapPin,
  Navigation,
  Phone,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import PharmacyMap from '@/components/pharmacies/PharmacyMap';
import PharmacyDutyCoverageMatrix from '@/components/pharmacies/PharmacyDutyCoverageMatrix';
import PharmacyItalyDutyCoverageMatrix from '@/components/pharmacies/PharmacyItalyDutyCoverageMatrix';
import PharmacyDutyWeek from '@/components/pages/PharmacyDutyWeek';
import PharmacyItalyDutyWeek from '@/components/pages/PharmacyItalyDutyWeek';
import {
  BORDER_PHARMACIES,
  ITALY_BORDER_PHARMACIES,
  ITALY_CITIES,
  ITALY_BORDER_PROVINCES,
  ITALY_PROVINCE_BY_SLUG,
  TICINO_CITIES,
  TICINO_PHARMACIES,
  pharmacyBySlug,
  pharmacyCitySlug,
  provinceSlugForPharmacy,
} from '@/services/pharmacies/data';
import { buildPharmacyPath, type PharmacyPath } from '@/services/pharmacies/paths';
import { currentDutyForRegion, isDutyCurrentlyActive, publicDutiesForRegion } from '@/services/pharmacies/duties';
import type { Locale } from '@/services/i18n';
import {
  pharmacyGoogleMapsSearchUrl,
  pharmacyGoogleMapsUrl,
  safePharmacyUrl,
  type PharmacyCatalogueDataset,
  type Pharmacy,
  type PharmacyCountry,
  type PharmacyDuty,
  type PharmacyDutiesDataset,
  type PharmacyFieldSource,
} from '@/services/pharmacies/types';
import dutiesJson from '@/data/pharmacy-duties-ticino.json';
import { pharmacyFaqHeading, pharmacyFaqItems } from '@/services/pharmacies/faq';

const DUTIES = dutiesJson as PharmacyDutiesDataset;
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DUTY_COVERAGE_BY_PHARMACY = new Map(DUTIES.duties.map((duty) => [duty.pharmacyId, duty.coverageName]));

type Copy = {
  country: string; swiss: string; italy: string; search: string; searchLabel: string; count: (n: number) => string; all: string; province: string; city: string; allProvinces: string; allCities: string; filters: string; reset: string; sort: string; sortName: string; sortDistance: string; locate: string; locating: string; locationDenied: string; locationReady: string; openNow: string; onDuty: string; hasHours: string; hasServices: string; open: string; closed: string; hoursUnknown: string; address: string; phone: string; email: string; website: string; contactHeading: string; hours: string; services: string; sources: string; source: string; checked: string; sourceLink: string; details: string; noResults: string; map: string; noMap: string; openMap: string; noHours: string; noServices: string; unavailable: string; notPublished: string; notChecked: string; verifyHeading: string; verify: string; osm: string; official: string; duty: string; dutySource: string; dutyInterval: string; dutyArea: string; dutyHub: string; noDuty: string; currentDuty: string; upcomingDuty: string; noPharmacy: string; ticinoLede: string; italyLede: string; hubLede: string; areaLede: string; cityLede: string;
};

const COPY: Record<Locale, Copy> = {
  it: {
    country: 'Paese', swiss: 'Svizzera · Ticino', italy: 'Italia · province di confine', search: 'Cerca per nome, località, indirizzo o CAP', searchLabel: 'Cerca farmacie', count: (n) => `${n} ${n === 1 ? 'farmacia' : 'farmacie'}`, all: 'Tutti i paesi', province: 'Provincia', city: 'Località', allProvinces: 'Tutte le province', allCities: 'Tutte le località', filters: 'Filtri', reset: 'Azzera filtri', sort: 'Ordina', sortName: 'Nome', sortDistance: 'Distanza', locate: 'Usa la mia posizione', locating: 'Rilevamento posizione…', locationDenied: 'Posizione non disponibile: puoi autorizzarla dal browser.', locationReady: 'Distanze calcolate dalla tua posizione.', openNow: 'Aperta ora', onDuty: 'Di turno ora', hasHours: 'Con orari pubblicati', hasServices: 'Con servizi pubblicati', open: 'Aperta secondo gli orari pubblicati', closed: 'Chiusa secondo gli orari pubblicati', hoursUnknown: 'Orario non pubblicato', address: 'Indirizzo', phone: 'Telefono', email: 'Email', website: 'Sito web', contactHeading: 'Contatti', hours: 'Orari pubblicati', services: 'Servizi pubblicati', sources: 'Fonti e aggiornamento', source: 'Fonte', checked: 'Recuperato il', sourceLink: 'Apri fonte', details: 'Apri scheda completa', noResults: 'Nessuna farmacia corrisponde ai filtri scelti.', map: 'Mappa', noMap: 'Questa fonte non pubblica coordinate verificabili per le sedi filtrate.', openMap: 'Apri in OpenStreetMap', noHours: 'La fonte non pubblica orari verificabili per questa sede.', noServices: 'La fonte non pubblica servizi verificabili per questa sede.', unavailable: 'Non disponibile', notPublished: 'non pubblicato dalla fonte', notChecked: 'non ancora controllato', verifyHeading: 'Verifica prima di partire', verify: 'Anagrafica, orari e turni hanno significati diversi. Chiama la farmacia o consulta la fonte indicata, soprattutto in caso di urgenza: i dati OSM sono contributi della comunità e non sostituiscono una conferma. Verifica sempre telefonicamente con la farmacia prima di recarti sul posto: orari e turni possono cambiare.', osm: 'OpenStreetMap, ODbL 1.0', official: 'Fonte ufficiale', duty: 'Turno', dutySource: 'Fonte del turno', dutyInterval: 'Intervallo', dutyArea: 'Area', dutyHub: 'Farmacie di turno in Ticino', noDuty: 'Nessun turno verificato per questa città o area nel dataset corrente.', currentDuty: 'Turno attivo ora secondo il dataset acquisito', upcomingDuty: 'Prossimo intervallo pubblicato', noPharmacy: 'Farmacia non trovata', ticinoLede: 'Elenco delle farmacie del Ticino ricavato dalla fonte cantonale, con dati cartografici OSM solo quando la corrispondenza è certa.', italyLede: 'Elenco del Ministero della Salute italiano per Como, Varese e Verbano-Cusio-Ossola. La presenza nell’anagrafica non significa apertura in questo momento.', hubLede: 'Directory transfrontaliera di Ticino e province italiane vicine. Ogni sede mostra la fonte, la data di recupero e separa i dati anagrafici dagli orari e dai servizi opzionali.', areaLede: 'Sedi presenti nel dataset ufficiale italiano per questa provincia. Orari, contatti e servizi compaiono soltanto quando una fonte tracciata li pubblica.', cityLede: 'Sedi censite nella località selezionata, con scheda individuale, fonte e data dell’ultimo recupero.',
  },
  en: {
    country: 'Country', swiss: 'Switzerland · Ticino', italy: 'Italy · border provinces', search: 'Search by name, locality, address or postcode', searchLabel: 'Search pharmacies', count: (n) => `${n} ${n === 1 ? 'pharmacy' : 'pharmacies'}`, all: 'All countries', province: 'Province', city: 'Locality', allProvinces: 'All provinces', allCities: 'All localities', filters: 'Filters', reset: 'Reset filters', sort: 'Sort', sortName: 'Name', sortDistance: 'Distance', locate: 'Use my location', locating: 'Finding location…', locationDenied: 'Location unavailable: you can allow it in your browser.', locationReady: 'Distances calculated from your location.', openNow: 'Open now', onDuty: 'On duty now', hasHours: 'Published hours', hasServices: 'Published services', open: 'Open according to published hours', closed: 'Closed according to published hours', hoursUnknown: 'Hours not published', address: 'Address', phone: 'Phone', email: 'Email', website: 'Website', contactHeading: 'Contact details', hours: 'Published hours', services: 'Published services', sources: 'Sources and update', source: 'Source', checked: 'Retrieved on', sourceLink: 'Open source', details: 'Open full page', noResults: 'No pharmacy matches the selected filters.', map: 'Map', noMap: 'The source does not publish verifiable coordinates for the filtered locations.', openMap: 'Open in OpenStreetMap', noHours: 'The source does not publish verifiable hours for this location.', noServices: 'The source does not publish verifiable services for this location.', unavailable: 'Unavailable', notPublished: 'not published by the source', notChecked: 'not checked yet', verifyHeading: 'Check before travelling', verify: 'Directory records, hours and duties have different meanings. Call the pharmacy or check the cited source, especially in an emergency: OSM data is community-contributed and does not replace confirmation.', osm: 'OpenStreetMap, ODbL 1.0', official: 'Official source', duty: 'Duty', dutySource: 'Duty source', dutyInterval: 'Interval', dutyArea: 'Area', dutyHub: 'On-duty pharmacies in Ticino', noDuty: 'No verified interval is available for this area.', currentDuty: 'Currently active according to the fetched dataset', upcomingDuty: 'Next published interval', noPharmacy: 'Pharmacy not found', ticinoLede: 'Directory of Ticino pharmacies from the cantonal source, with OSM map data only where the match is certain.', italyLede: 'Italian Ministry of Health directory for Como, Varese and Verbano-Cusio-Ossola. Being listed does not mean being open now.', hubLede: 'Cross-border directory for Ticino and nearby Italian provinces. Each location shows its source, retrieval date and the distinction between identity, hours and optional services.', areaLede: 'Locations in the official Italian dataset for this province. Hours, contacts and services appear only when a traceable source publishes them.', cityLede: 'Locations listed for the selected locality, with individual page, source and retrieval date.',
  },
  de: {
    country: 'Land', swiss: 'Schweiz · Tessin', italy: 'Italien · Grenzprovinzen', search: 'Nach Name, Ort, Adresse oder Postleitzahl suchen', searchLabel: 'Apotheken suchen', count: (n) => `${n} ${n === 1 ? 'Apotheke' : 'Apotheken'}`, all: 'Alle Länder', province: 'Provinz', city: 'Ort', allProvinces: 'Alle Provinzen', allCities: 'Alle Orte', filters: 'Filter', reset: 'Filter zurücksetzen', sort: 'Sortieren', sortName: 'Name', sortDistance: 'Entfernung', locate: 'Meinen Standort verwenden', locating: 'Standort wird ermittelt…', locationDenied: 'Standort nicht verfügbar: Erlaubnis kann im Browser erteilt werden.', locationReady: 'Entfernungen ab deinem Standort berechnet.', openNow: 'Jetzt geöffnet', onDuty: 'Jetzt Notdienst', hasHours: 'Mit Öffnungszeiten', hasServices: 'Mit Leistungen', open: 'Laut veröffentlichten Zeiten geöffnet', closed: 'Laut veröffentlichten Zeiten geschlossen', hoursUnknown: 'Öffnungszeiten nicht veröffentlicht', address: 'Adresse', phone: 'Telefon', email: 'E-Mail', website: 'Website', contactHeading: 'Kontaktdaten', hours: 'Veröffentlichte Öffnungszeiten', services: 'Veröffentlichte Leistungen', sources: 'Quellen und Aktualisierung', source: 'Quelle', checked: 'Abgerufen am', sourceLink: 'Quelle öffnen', details: 'Vollständige Seite öffnen', noResults: 'Keine Apotheke entspricht den Filtern.', map: 'Karte', noMap: 'Die Quelle veröffentlicht für die gefilterten Standorte keine überprüfbaren Koordinaten.', openMap: 'In OpenStreetMap öffnen', noHours: 'Die Quelle veröffentlicht für diesen Standort keine überprüfbaren Zeiten.', noServices: 'Die Quelle veröffentlicht für diesen Standort keine überprüfbaren Leistungen.', unavailable: 'Nicht verfügbar', notPublished: 'nicht von der Quelle veröffentlicht', notChecked: 'noch nicht geprüft', verifyHeading: 'Vor der Fahrt prüfen', verify: 'Verzeichnis, Öffnungszeiten und Notdienst haben unterschiedliche Bedeutungen. Besonders im Notfall telefonisch oder bei der Quelle prüfen: OSM-Daten stammen aus der Community und ersetzen keine Bestätigung.', osm: 'OpenStreetMap, ODbL 1.0', official: 'Offizielle Quelle', duty: 'Notdienst', dutySource: 'Notdienstquelle', dutyInterval: 'Zeitraum', dutyArea: 'Gebiet', dutyHub: 'Notdienst-Apotheken im Tessin', noDuty: 'Für dieses Gebiet ist kein verifizierter Zeitraum verfügbar.', currentDuty: 'Laut abgerufenem Datensatz derzeit aktiv', upcomingDuty: 'Nächster veröffentlichter Zeitraum', noPharmacy: 'Apotheke nicht gefunden', ticinoLede: 'Verzeichnis der Tessiner Apotheken aus der kantonalen Quelle, ergänzt mit OSM-Kartendaten nur bei eindeutiger Zuordnung.', italyLede: 'Verzeichnis des italienischen Gesundheitsministeriums für Como, Varese und Verbano-Cusio-Ossola. Ein Eintrag bedeutet nicht, dass die Apotheke jetzt geöffnet ist.', hubLede: 'Grenzüberschreitendes Verzeichnis für das Tessin und nahe italienische Provinzen. Jede Seite zeigt Quelle, Abrufdatum und die Trennung von Identität, Zeiten und Leistungen.', areaLede: 'Standorte des offiziellen italienischen Datensatzes für diese Provinz. Zeiten, Kontakte und Leistungen erscheinen nur mit nachvollziehbarer Quelle.', cityLede: 'Standorte des ausgewählten Ortes mit Einzelseite, Quelle und Abrufdatum.',
  },
  fr: {
    country: 'Pays', swiss: 'Suisse · Tessin', italy: 'Italie · provinces frontalières', search: 'Rechercher par nom, localité, adresse ou code postal', searchLabel: 'Rechercher des pharmacies', count: (n) => `${n} ${n === 1 ? 'pharmacie' : 'pharmacies'}`, all: 'Tous les pays', province: 'Province', city: 'Localité', allProvinces: 'Toutes les provinces', allCities: 'Toutes les localités', filters: 'Filtres', reset: 'Réinitialiser les filtres', sort: 'Trier', sortName: 'Nom', sortDistance: 'Distance', locate: 'Utiliser ma position', locating: 'Position en cours…', locationDenied: 'Position indisponible : vous pouvez l’autoriser dans le navigateur.', locationReady: 'Distances calculées depuis votre position.', openNow: 'Ouverte maintenant', onDuty: 'De garde maintenant', hasHours: 'Avec horaires publiés', hasServices: 'Avec services publiés', open: 'Ouverte selon les horaires publiés', closed: 'Fermée selon les horaires publiés', hoursUnknown: 'Horaires non publiés', address: 'Adresse', phone: 'Téléphone', email: 'E-mail', website: 'Site web', contactHeading: 'Coordonnées', hours: 'Horaires publiés', services: 'Services publiés', sources: 'Sources et mise à jour', source: 'Source', checked: 'Collecté le', sourceLink: 'Ouvrir la source', details: 'Ouvrir la fiche complète', noResults: 'Aucune pharmacie ne correspond aux filtres.', map: 'Carte', noMap: 'La source ne publie pas de coordonnées vérifiables pour les sites filtrés.', openMap: 'Ouvrir dans OpenStreetMap', noHours: 'La source primaire ne publie pas d’horaires vérifiables pour ce site.', noServices: 'La source primaire ne publie pas de services vérifiables pour ce site.', unavailable: 'Indisponible', notPublished: 'non publié par la source', notChecked: 'pas encore contrôlé', verifyHeading: 'Vérifiez avant de partir', verify: 'Répertoire, horaires et gardes ont des sens différents. Appelez la pharmacie ou consultez la source citée, surtout en cas d’urgence : les données OSM sont communautaires et ne remplacent pas une confirmation.', osm: 'OpenStreetMap, ODbL 1.0', official: 'Source officielle', duty: 'Garde', dutySource: 'Source de la garde', dutyInterval: 'Intervalle', dutyArea: 'Zone', dutyHub: 'Pharmacies de garde au Tessin', noDuty: 'Aucun intervalle vérifié n’est disponible pour cette zone.', currentDuty: 'Actif maintenant selon le jeu collecté', upcomingDuty: 'Prochain intervalle publié', noPharmacy: 'Pharmacie introuvable', ticinoLede: 'Répertoire des pharmacies du Tessin issu de la source cantonale, avec les données cartographiques OSM uniquement quand la correspondance est certaine.', italyLede: 'Répertoire du ministère italien de la Santé pour Côme, Varèse et Verbano-Cusio-Ossola. Être listé ne signifie pas être ouvert maintenant.', hubLede: 'Répertoire transfrontalier du Tessin et des provinces italiennes voisines. Chaque site montre sa source, sa date de collecte et distingue identité, horaires et services optionnels.', areaLede: 'Sites recensés par le jeu officiel italien pour cette province. Horaires, contacts et services apparaissent uniquement avec une source traçable.', cityLede: 'Sites recensés dans la localité sélectionnée, avec fiche individuelle, source et date de collecte.',
  },
};

type SortMode = 'name' | 'distance';
type CountryFilter = 'all' | PharmacyCountry;

function normalize(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function italyDutyLabel(locale: Locale): string { return locale === 'it' ? 'Turni in Italia' : locale === 'en' ? 'Duties in Italy' : locale === 'de' ? 'Notdienste in Italien' : 'Gardes en Italie'; }
function ministryIdLabel(locale: Locale): string { return locale === 'it' ? 'Codice ministeriale' : locale === 'en' ? 'Ministry code' : locale === 'de' ? 'Code des Gesundheitsministeriums' : 'Code ministériel'; }
function vatNumberLabel(locale: Locale): string { return locale === 'it' ? 'Partita IVA' : locale === 'en' ? 'VAT number' : locale === 'de' ? 'USt-IdNr.' : 'N° de TVA'; }

function formatDate(iso: string, locale: Locale, country: PharmacyCountry = 'CH'): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: country === 'IT' ? 'Europe/Rome' : 'Europe/Zurich' }).format(date);
}

function timeToMinutes(value: string): number | null {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

function isOpenNow(pharmacy: Pharmacy, now: Date): boolean | null {
  if (!pharmacy.openingHours?.length) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: pharmacy.country === 'IT' ? 'Europe/Rome' : 'Europe/Zurich' });
  const parts = formatter.formatToParts(now);
  const day = parts.find((part) => part.type === 'weekday')?.value.toLowerCase();
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const current = hour * 60 + minute;
  return pharmacy.openingHours.some((interval) => {
    if (interval.dayOfWeek !== day || interval.isClosed) return false;
    const opens = timeToMinutes(interval.opens); const closes = timeToMinutes(interval.closes);
    if (opens === null || closes === null) return false;
    return opens <= closes ? current >= opens && current < closes : current >= opens || current < closes;
  });
}

function distanceKm(latitude: number, longitude: number, userLatitude: number, userLongitude: number): number {
  const radians = (value: number) => value * Math.PI / 180;
  const earthRadius = 6371; const dLat = radians(userLatitude - latitude); const dLon = radians(userLongitude - longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latitude)) * Math.cos(radians(userLatitude)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function provinceFor(pharmacy: Pharmacy): typeof ITALY_BORDER_PROVINCES[number] | undefined { return ITALY_BORDER_PROVINCES.find((province) => province.code === pharmacy.province); }
function detailPath(pharmacy: Pharmacy, locale: Locale): PharmacyPath { return pharmacy.country === 'IT' ? { kind: 'pharmacy', locale, country: 'IT', areaSlug: provinceSlugForPharmacy(pharmacy), citySlug: pharmacyCitySlug(pharmacy.city), pharmacySlug: pharmacy.slug } : { kind: 'pharmacy', locale, country: 'CH', citySlug: pharmacyCitySlug(pharmacy.city), pharmacySlug: pharmacy.slug }; }
function cityPath(pharmacy: Pharmacy, locale: Locale): PharmacyPath { return pharmacy.country === 'IT' ? { kind: 'city', locale, country: 'IT', areaSlug: provinceSlugForPharmacy(pharmacy), citySlug: pharmacyCitySlug(pharmacy.city) } : { kind: 'city', locale, citySlug: pharmacyCitySlug(pharmacy.city) }; }
function href(path: PharmacyPath): string { return buildPharmacyPath(path, path.locale); }

function pharmacyForPage(page: PharmacyPath): Pharmacy | undefined {
  if (page.kind !== 'pharmacy' || !page.pharmacySlug) return undefined;
  const pharmacy = pharmacyBySlug(page.pharmacySlug);
  if (!pharmacy || pharmacyCitySlug(pharmacy.city) !== page.citySlug) return undefined;
  if (page.country === 'IT') { const province = page.areaSlug ? ITALY_PROVINCE_BY_SLUG.get(page.areaSlug)?.code : undefined; return pharmacy.country === 'IT' && pharmacy.province === province ? pharmacy : undefined; }
  return pharmacy.country === 'CH' ? pharmacy : undefined;
}

function scopeForPage(page: PharmacyPath): Pharmacy[] {
  if (page.kind === 'pharmacy') { const pharmacy = pharmacyForPage(page); return pharmacy ? [pharmacy] : []; }
  if (page.kind === 'canton' || page.kind === 'duty-city') {
    if (page.kind === 'duty-city' && page.citySlug) { const city = TICINO_CITIES.find((candidate) => candidate.slug === page.citySlug)?.name; return city ? TICINO_PHARMACIES.filter((pharmacy) => pharmacy.city === city) : []; }
    return TICINO_PHARMACIES;
  }
  if (page.kind === 'country') return ITALY_BORDER_PHARMACIES;
  if (page.kind === 'area') { const code = page.areaSlug ? ITALY_PROVINCE_BY_SLUG.get(page.areaSlug)?.code : undefined; return ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === code); }
  if (page.kind === 'city') {
    if (!page.citySlug) return BORDER_PHARMACIES;
    if (page.areaSlug) { const code = ITALY_PROVINCE_BY_SLUG.get(page.areaSlug)?.code; const cityName = ITALY_CITIES.find((candidate) => candidate.province === code && candidate.slug === page.citySlug)?.name; return ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === code && pharmacy.city === cityName); }
    const cityName = TICINO_CITIES.find((candidate) => candidate.slug === page.citySlug)?.name; return TICINO_PHARMACIES.filter((pharmacy) => pharmacy.city === cityName);
  }
  return BORDER_PHARMACIES;
}

export function publicDutiesForPharmacy(
  dataset: PharmacyDutiesDataset,
  pharmacyId: string,
  coverageName: string | undefined,
  now: Date,
  catalogue?: PharmacyCatalogueDataset,
): PharmacyDuty[] {
  if (!coverageName) return [];
  return publicDutiesForRegion(dataset, coverageName, now, catalogue).filter((duty) => duty.pharmacyId === pharmacyId);
}

function dutyFor(pharmacy: Pharmacy, now: Date): PharmacyDuty | undefined {
  return publicDutiesForPharmacy(DUTIES, pharmacy.id, DUTY_COVERAGE_BY_PHARMACY.get(pharmacy.id), now)
    .find((duty) => isDutyCurrentlyActive(duty, now));
}
function dayLabel(day: string, locale: Locale): string { const index = DAY_NAMES.indexOf(day as typeof DAY_NAMES[number]); if (index < 0) return day; return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, index + 1))); }
function fieldStatusLabel(status: string | undefined, copy: Copy): string { if (status === 'not_published') return copy.notPublished; if (status === 'not_checked') return copy.notChecked; return copy.unavailable; }

function cityNameForPage(page: PharmacyPath): string {
  if (page.kind !== 'city' || !page.citySlug) return 'all';
  if (page.areaSlug && page.country === 'IT') {
    const province = ITALY_PROVINCE_BY_SLUG.get(page.areaSlug)?.code;
    return ITALY_CITIES.find((candidate) => candidate.province === province && candidate.slug === page.citySlug)?.name || 'all';
  }
  return TICINO_CITIES.find((candidate) => candidate.slug === page.citySlug)?.name || 'all';
}

function SourceLine({ pharmacy, locale }: { pharmacy: Pharmacy; locale: Locale }) {
  const copy = COPY[locale]; const secondary = Object.entries(pharmacy.fieldSources || {}) as [string, PharmacyFieldSource][]; const external = (pharmacy.externalSources || []).filter((source) => source.status !== 'not_found' && source.status !== 'unavailable');
  return <div className="pharmacy-source-line space-y-2 text-sm text-muted"><p><strong className="text-body">{copy.source}:</strong>{' '}<a className="text-link underline-offset-4 hover:underline" href={pharmacy.sourceUrl} rel="nofollow noopener">{copy.official}</a></p><p><strong className="text-body">{copy.checked}:</strong> {formatDate(pharmacy.lastVerifiedAt, locale, pharmacy.country)}</p>{secondary.length > 0 && <ul className="list-disc space-y-1 pl-5">{secondary.map(([field, source]) => { const sourceLabel = source.sourceType === 'directory' ? copy.osm : copy.official; return <li key={field}>{field}:{' '}<a className="text-link underline-offset-4 hover:underline" href={source.url} rel="nofollow noopener">{copy.sourceLink}</a>{' '}({source.license || sourceLabel})</li>; })}</ul>}{external.length > 0 && <ul className="list-disc space-y-1 pl-5">{external.map((source) => { const url = pharmacyGoogleMapsUrl(source.placeId) || safePharmacyUrl(source.url); return url ? <li key={`${source.sourceType}-${source.url}`}>{source.label}:{' '}<a className="text-link underline-offset-4 hover:underline" href={url} rel="nofollow noopener">{copy.sourceLink}</a>{' '}({copy.checked}: {formatDate(source.checkedAt, locale, pharmacy.country)})</li> : null; })}</ul>}</div>;
}

function Hours({ pharmacy, locale }: { pharmacy: Pharmacy; locale: Locale }) {
  const copy = COPY[locale];
  if (!pharmacy.openingHours?.length) return <p className="text-sm text-muted">{copy.noHours}</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[18rem] text-left text-sm text-body"><tbody>{pharmacy.openingHours.map((interval, index) => <tr key={`${interval.dayOfWeek}-${interval.opens}-${interval.closes}-${index}`} className="border-b border-edge last:border-0"><th scope="row" className="py-3 pr-4 font-semibold text-heading">{dayLabel(interval.dayOfWeek, locale)}</th><td className="py-3 text-right tabular-nums">{interval.isClosed ? copy.closed : `${interval.opens}–${interval.closes}`}</td></tr>)}</tbody></table></div>;
}

function PharmacyFaq({ pharmacy, locale }: { pharmacy: Pharmacy; locale: Locale }) {
  return <section className="pharmacy-detail-card p-5" aria-label={pharmacyFaqHeading(locale)}><h2 className="font-display text-xl font-bold text-heading">{pharmacyFaqHeading(locale)}</h2><div className="mt-3 space-y-2 text-sm leading-6 text-body">{pharmacyFaqItems(pharmacy, locale).map((item) => <details key={item.question} className="border-b border-edge py-2 last:border-0"><summary className="cursor-pointer font-semibold text-heading">{item.question}</summary><p className="mt-2 pb-2">{item.answer}</p></details>)}</div></section>;
}

function PharmacyStatus({ pharmacy, locale, now }: { pharmacy: Pharmacy; locale: Locale; now: Date }) {
  const copy = COPY[locale];
  const open = isOpenNow(pharmacy, now);
  const duty = dutyFor(pharmacy, now);
  return <div className="flex flex-wrap items-center gap-2 text-xs font-semibold" aria-label={copy.hours}>
    {open === true && <span className="inline-flex items-center gap-1.5 rounded-full bg-success-subtle px-3 py-1.5 text-success"><span className="pharmacy-live-dot" aria-hidden="true" />{copy.openNow}</span>}
    {open === false && <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-subtle px-3 py-1.5 text-neutral">{copy.closed}</span>}
    {open === null && <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-subtle px-3 py-1.5 text-neutral">{copy.hoursUnknown}</span>}
    {duty && <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-subtle px-3 py-1.5 text-warning"><Clock3 aria-hidden="true" className="h-3.5 w-3.5" />{copy.onDuty}</span>}
  </div>;
}

function openStreetMapUrl(pharmacy: Pharmacy): string | undefined { if (pharmacy.latitude === undefined || pharmacy.longitude === undefined) return undefined; return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(String(pharmacy.latitude))}&mlon=${encodeURIComponent(String(pharmacy.longitude))}#map=18/${encodeURIComponent(String(pharmacy.latitude))}/${encodeURIComponent(String(pharmacy.longitude))}`; }
function googleMapUrl(pharmacy: Pharmacy): string | undefined { return pharmacyGoogleMapsUrl(pharmacy.googlePlaceId) || pharmacyGoogleMapsSearchUrl(pharmacy); }

function PharmacyCard({ pharmacy, locale, now, userLocation }: { pharmacy: Pharmacy; locale: Locale; now: Date; userLocation: { latitude: number; longitude: number } | null; key?: React.Key }) {
  const copy = COPY[locale];
  const distance = userLocation && pharmacy.latitude !== undefined && pharmacy.longitude !== undefined
    ? distanceKm(pharmacy.latitude, pharmacy.longitude, userLocation.latitude, userLocation.longitude)
    : undefined;
  const osmUrl = openStreetMapUrl(pharmacy);
  const googleUrl = googleMapUrl(pharmacy);
  return <article className="pharmacy-list-item group">
    <div className="flex items-start gap-3">
      <span className="pharmacy-list-marker" aria-hidden="true"><MapPin className="h-5 w-5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-bold leading-snug text-heading">
              <a className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href(detailPath(pharmacy, locale))}>{pharmacy.name}</a>
            </h3>
            <p className="mt-1 text-sm text-muted">{pharmacy.postalCode} {pharmacy.city}</p>
          </div>
          <PharmacyStatus pharmacy={pharmacy} locale={locale} now={now} />
        </div>
        <p className="mt-3 text-sm leading-6 text-body"><strong>{copy.address}:</strong> {pharmacy.address}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold">
          {distance !== undefined && <span className="rounded-full bg-info-subtle px-2.5 py-1 text-info">{distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`}</span>}
          {pharmacy.openingHours?.length && <span className="rounded-full bg-surface-alt px-2.5 py-1 text-muted">{copy.hasHours}</span>}
          {pharmacy.services?.length && <span className="rounded-full bg-surface-alt px-2.5 py-1 text-muted">{copy.hasServices}</span>}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {pharmacy.phone && <a className="inline-flex min-h-11 items-center gap-2 font-semibold text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={`tel:${pharmacy.phone}`}><Phone aria-hidden="true" className="h-4 w-4" />{copy.phone}</a>}
          <a className="inline-flex min-h-11 items-center gap-1 font-semibold text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href(detailPath(pharmacy, locale))}>{copy.details}<ChevronRight aria-hidden="true" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></a>
          {osmUrl && <a className="inline-flex min-h-11 items-center gap-1 text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={osmUrl} rel="nofollow noopener"><Navigation aria-hidden="true" className="h-4 w-4" />{copy.openMap}</a>}
          {googleUrl && <a className="inline-flex min-h-11 items-center gap-1 text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={googleUrl} rel="nofollow noopener">Google Maps</a>}
        </div>
        <p className="mt-3 border-t border-edge pt-3 text-xs text-muted">{copy.source}: <a className="text-link underline-offset-4 hover:underline" href={pharmacy.sourceUrl} rel="nofollow noopener">{copy.sourceLink}</a> · {copy.checked}: {formatDate(pharmacy.lastVerifiedAt, locale, pharmacy.country)}</p>
      </div>
    </div>
  </article>;
}

function DutyCard({ duty, locale, now }: { duty?: PharmacyDuty; locale: Locale; now: Date; key?: React.Key }) {
  const copy = COPY[locale]; if (!duty) return <p className="rounded-xl border border-edge bg-surface-alt p-4 text-sm text-muted">{copy.noDuty}</p>;
  const pharmacy = BORDER_PHARMACIES.find((candidate) => candidate.id === duty.pharmacyId); const active = isDutyCurrentlyActive(duty, now);
  return <article className="rounded-2xl border border-edge bg-surface p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><h3 className="font-display text-lg font-bold text-heading">{pharmacy ? <a className="underline-offset-4 hover:underline" href={href(detailPath(pharmacy, locale))}>{pharmacy.name}</a> : duty.pharmacyId}</h3><Clock3 aria-hidden="true" className="h-5 w-5 shrink-0 text-accent" /></div><dl className="mt-3 grid gap-3 text-sm text-body sm:grid-cols-2"><div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">{copy.dutyArea}</dt><dd>{duty.coverageName}</dd></div><div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">{copy.dutyInterval}</dt><dd>{formatDate(duty.startsAt, locale)} – {formatDate(duty.endsAt, locale)}</dd></div></dl><p className="mt-3 text-xs text-muted">{active ? copy.currentDuty : copy.upcomingDuty} · {copy.checked}: {formatDate(duty.fetchedAt, locale)}</p>{pharmacy?.phone && <a className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-link underline-offset-4 hover:underline" href={`tel:${pharmacy.phone}`}><Phone aria-hidden="true" className="h-4 w-4" />{copy.phone}: {pharmacy.phone}</a>}<p className="mt-3 border-t border-edge pt-3 text-xs text-muted">{copy.dutySource}: <a className="text-link underline-offset-4 hover:underline" href={duty.sourceUrl} rel="nofollow noopener">{copy.sourceLink} <ExternalLink aria-hidden="true" className="inline h-3 w-3" /></a></p></article>;
}

function DetailPage({ pharmacy, locale, now }: { pharmacy: Pharmacy; locale: Locale; now: Date }) {
  const copy = COPY[locale];
  const publicDuties = publicDutiesForPharmacy(DUTIES, pharmacy.id, DUTY_COVERAGE_BY_PHARMACY.get(pharmacy.id), now);
  const duty = publicDuties.find((candidate) => isDutyCurrentlyActive(candidate, now));
  const duties = publicDuties;
  const osmUrl = openStreetMapUrl(pharmacy);
  const googleUrl = googleMapUrl(pharmacy);
  const website = safePharmacyUrl(pharmacy.website);
  const answer = `${pharmacy.address}, ${pharmacy.postalCode} ${pharmacy.city}.${pharmacy.phone ? ` ${copy.phone}: ${pharmacy.phone}.` : ''}${pharmacy.openingHours?.length ? ` ${copy.hours}: ${pharmacy.openingHours[0].opens}–${pharmacy.openingHours[0].closes}.` : ''}`;
  const parentPath = cityPath(pharmacy, locale);
  const regionLabel = pharmacy.country === 'CH' ? copy.swiss : `${copy.italy} · ${provinceFor(pharmacy)?.name || pharmacy.province}`;
  return <div className="pharmacy-detail-shell mx-auto max-w-5xl space-y-8" data-pharmacy-detail="true">
    <header className="pharmacy-detail-hero">
      <div className="pharmacy-detail-hero-inner space-y-4">
        <a className="inline-flex min-h-10 items-center rounded-full border border-edge bg-surface px-3 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href(parentPath)}>{copy.city}: {pharmacy.city}</a>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="pharmacy-kicker">{regionLabel}</span>
          <PharmacyStatus pharmacy={pharmacy} locale={locale} now={now} />
        </div>
        <h1 className="max-w-3xl font-display text-3xl font-bold leading-tight tracking-tight text-heading sm:text-5xl">{pharmacy.name}</h1>
        <p data-pharmacy-answer="true" className="max-w-3xl text-base leading-7 text-body sm:text-lg">{answer}</p>
        <p className="max-w-3xl text-sm leading-6 text-muted">{copy.checked} {formatDate(pharmacy.lastVerifiedAt, locale, pharmacy.country)} · {copy.source}: <a className="text-link underline-offset-4 hover:underline" href={pharmacy.sourceUrl} rel="nofollow noopener">{copy.sourceLink}</a></p>
        <div className="pharmacy-detail-actions" aria-label={copy.contactHeading}>
          {pharmacy.phone && <a className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-on-accent shadow-sm hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={`tel:${pharmacy.phone}`}><Phone aria-hidden="true" className="h-4 w-4" />{copy.phone}</a>}
          {osmUrl && <a className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-edge bg-surface px-4 py-2 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={osmUrl} rel="nofollow noopener"><Navigation aria-hidden="true" className="h-4 w-4" />{copy.openMap}</a>}
          {googleUrl && <a className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-edge bg-surface px-4 py-2 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={googleUrl} rel="nofollow noopener">Google Maps</a>}
          {website && <a className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-edge bg-surface px-4 py-2 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={website} rel="nofollow noopener">{copy.website}<ExternalLink aria-hidden="true" className="h-4 w-4" /></a>}
        </div>
      </div>
    </header>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
      <section className="space-y-6" aria-labelledby="pharmacy-contact-heading">
        <div className="pharmacy-detail-card p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.contactHeading}</p><h2 id="pharmacy-contact-heading" className="mt-1 font-display text-xl font-bold text-heading">{copy.address}</h2></div>
            <span className="text-xs text-muted">{copy.city}: {pharmacy.city}</span>
          </div>
          <address className="mt-4 not-italic text-base leading-7 text-body">{pharmacy.address}<br />{pharmacy.postalCode} {pharmacy.city}</address>
          <dl className="pharmacy-fact-grid mt-5 sm:grid-cols-2">
            <div className="pharmacy-fact"><dt>{copy.phone}</dt><dd>{pharmacy.phone ? <a className="font-semibold text-link underline-offset-4 hover:underline" href={`tel:${pharmacy.phone}`}>{pharmacy.phone}</a> : copy.unavailable}</dd></div>
            <div className="pharmacy-fact"><dt>{copy.email}</dt><dd>{pharmacy.contactEmail ? <a className="text-link underline-offset-4 hover:underline" href={`mailto:${pharmacy.contactEmail}`}>{pharmacy.contactEmail}</a> : copy.unavailable}</dd></div>
            {pharmacy.country === 'IT' && pharmacy.ministryId && <div className="pharmacy-fact"><dt>{ministryIdLabel(locale)}</dt><dd className="font-mono text-sm">{pharmacy.ministryId}</dd></div>}
            {pharmacy.vatNumber && <div className="pharmacy-fact"><dt>{vatNumberLabel(locale)}</dt><dd className="font-mono text-sm">{pharmacy.vatNumber}</dd></div>}
          </dl>
        </div>
        <section className="pharmacy-detail-card p-5 sm:p-6" aria-labelledby="pharmacy-hours-heading"><div className="flex items-end justify-between gap-3"><h2 id="pharmacy-hours-heading" className="font-display text-xl font-bold text-heading">{copy.hours}</h2><span className="text-xs font-semibold text-muted">{copy.checked} {formatDate(pharmacy.lastVerifiedAt, locale, pharmacy.country)}</span></div><div className="mt-4"><Hours pharmacy={pharmacy} locale={locale} /></div></section>
        <section className="pharmacy-detail-card p-5 sm:p-6" aria-labelledby="pharmacy-services-heading"><h2 id="pharmacy-services-heading" className="font-display text-xl font-bold text-heading">{copy.services}</h2>{pharmacy.services?.length ? <ul className="mt-4 grid gap-2 text-sm leading-6 text-body sm:grid-cols-2">{pharmacy.services.map((service) => <li key={service} className="rounded-xl bg-surface-alt px-3 py-2">{service}</li>)}</ul> : <p className="mt-3 text-sm text-muted">{copy.noServices}</p>}</section>
        <PharmacyFaq pharmacy={pharmacy} locale={locale} />
        {duties.length > 0 && <section className="space-y-4" aria-labelledby="pharmacy-duty-heading"><div className="flex flex-wrap items-end justify-between gap-3"><h2 id="pharmacy-duty-heading" className="font-display text-xl font-bold text-heading">{copy.duty}</h2><span className="text-sm text-muted">{copy.checked} {formatDate(duties[0].fetchedAt, locale)}</span></div>{duty && <p className="rounded-2xl border border-warning-border bg-warning-subtle p-4 text-sm text-warning">{copy.currentDuty}: {duty.coverageName}</p>}<div className="grid gap-4 sm:grid-cols-2">{duties.slice(0, 4).map((candidate) => <DutyCard key={candidate.id} duty={candidate} locale={locale} now={now} />)}</div></section>}
      </section>
      <aside className="space-y-6">
        <section aria-labelledby="pharmacy-map-heading"><div className="mb-3 flex items-end justify-between gap-3"><h2 id="pharmacy-map-heading" className="font-display text-xl font-bold text-heading">{copy.map}</h2><span className="text-xs text-muted">{pharmacy.city}</span></div><PharmacyMap pharmacies={[pharmacy]} getHref={(candidate) => href(detailPath(candidate, locale))} openLabel={copy.details} noLocationLabel={copy.noMap} /></section>
        <section className="pharmacy-detail-card p-5" aria-labelledby="pharmacy-sources-heading"><h2 id="pharmacy-sources-heading" className="font-display text-xl font-bold text-heading">{copy.sources}</h2><div className="mt-4"><SourceLine pharmacy={pharmacy} locale={locale} /></div><p className="mt-4 rounded-xl bg-surface-alt p-3 text-xs leading-5 text-muted">{pharmacy.dataAvailability?.openingHours !== 'verified' && `${copy.hours}: ${fieldStatusLabel(pharmacy.dataAvailability?.openingHours, copy)}. `}{pharmacy.dataAvailability?.services !== 'verified' && `${copy.services}: ${fieldStatusLabel(pharmacy.dataAvailability?.services, copy)}.`}</p></section>
      </aside>
    </div>
    <aside className="rounded-2xl border border-accent-border bg-accent-subtle p-5 text-sm leading-6 text-body"><strong className="text-heading">{copy.verifyHeading}</strong><p className="mt-2 text-muted">{copy.verify}</p></aside>
  </div>;
}

function DirectoryPageRedesign({ page, locale, now }: { page: PharmacyPath; locale: Locale; now: Date }) {
  const copy = COPY[locale];
  const base = useMemo(() => scopeForPage(page), [page]);
  const fixedCountry: CountryFilter = page.kind === 'canton' || page.kind === 'duty-city'
    ? 'CH'
    : page.country || (page.areaSlug ? 'IT' : page.kind === 'city' ? 'CH' : 'all');
  const fixedCity = cityNameForPage(page);
  const [query, setQuery] = useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('q') || '');
  const [country, setCountry] = useState<CountryFilter>(fixedCountry);
  const [province, setProvince] = useState('all');
  const [city, setCity] = useState(fixedCity);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [onlyDuty, setOnlyDuty] = useState(false);
  const [onlyHours, setOnlyHours] = useState(false);
  const [onlyServices, setOnlyServices] = useState(false);
  const [sort, setSort] = useState<SortMode>('name');
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(false);

  useEffect(() => { setCountry(fixedCountry); setProvince('all'); setCity(fixedCity); }, [fixedCountry, fixedCity, page.kind, page.areaSlug, page.citySlug]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [query]);

  const provinceOptions = useMemo(() => {
    const provinceCodes = Array.from(new Set(base.filter((pharmacy) => pharmacy.country === 'IT').map((pharmacy) => pharmacy.province).filter(Boolean) as string[]));
    return provinceCodes.map((code) => ITALY_BORDER_PROVINCES.find((candidate) => candidate.code === code) || { code, name: code, slug: code.toLowerCase() }).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [base, locale]);
  const cityOptions = useMemo(() => {
    const cities = Array.from(new Set(base.filter((pharmacy) => (country === 'all' || pharmacy.country === country) && (province === 'all' || pharmacy.province === province)).map((pharmacy) => pharmacy.city))) as string[];
    return cities.sort((a, b) => a.localeCompare(b, locale));
  }, [base, country, province, locale]);
  const list = useMemo(() => {
    const needle = normalize(query.trim());
    const filtered = base.filter((pharmacy) => {
      if (country !== 'all' && pharmacy.country !== country) return false;
      if (province !== 'all' && pharmacy.province !== province) return false;
      if (city !== 'all' && pharmacy.city !== city) return false;
      if (needle && !normalize(`${pharmacy.name} ${pharmacy.city} ${pharmacy.address} ${pharmacy.postalCode}`).includes(needle)) return false;
      if (onlyHours && !pharmacy.openingHours?.length) return false;
      if (onlyServices && !pharmacy.services?.length) return false;
      if (onlyOpen && isOpenNow(pharmacy, now) !== true) return false;
      if (onlyDuty && !dutyFor(pharmacy, now)) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      if (sort === 'distance' && userLocation) {
        const da = a.latitude !== undefined && a.longitude !== undefined ? distanceKm(a.latitude, a.longitude, userLocation.latitude, userLocation.longitude) : Number.POSITIVE_INFINITY;
        const db = b.latitude !== undefined && b.longitude !== undefined ? distanceKm(b.latitude, b.longitude, userLocation.latitude, userLocation.longitude) : Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
      }
      return `${a.city} ${a.name}`.localeCompare(`${b.city} ${b.name}`, locale);
    });
  }, [base, city, country, now, onlyDuty, onlyHours, onlyOpen, onlyServices, province, query, sort, userLocation, locale]);
  const locate = () => {
    if (!navigator.geolocation) { setLocationError(true); return; }
    setLocating(true); setLocationError(false);
    navigator.geolocation.getCurrentPosition((position) => {
      setUserLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setSort('distance'); setLocating(false);
    }, () => { setLocationError(true); setLocating(false); }, { enableHighAccuracy: false, maximumAge: 300_000, timeout: 10_000 });
  };
  const reset = () => { setQuery(''); setCountry(fixedCountry); setProvince('all'); setCity(fixedCity); setOnlyOpen(false); setOnlyDuty(false); setOnlyHours(false); setOnlyServices(false); setSort('name'); };
  const title = page.kind === 'canton'
    ? copy.swiss
    : page.kind === 'country'
      ? copy.italy
      : page.kind === 'area'
        ? (ITALY_PROVINCE_BY_SLUG.get(page.areaSlug || '')?.name || copy.italy)
        : page.kind === 'city'
          ? (city === 'all' ? copy.city : city)
          : locale === 'it'
            ? 'Farmacie in Ticino e al confine italiano'
            : locale === 'en'
              ? 'Pharmacies in Ticino and across the Italian border'
              : locale === 'de'
                ? 'Apotheken im Tessin und an der italienischen Grenze'
                : 'Pharmacies au Tessin et à la frontière italienne';
  const lede = page.kind === 'canton' ? copy.ticinoLede : page.kind === 'country' ? copy.italyLede : page.kind === 'area' ? copy.areaLede : page.kind === 'city' ? copy.cityLede : copy.hubLede;
  const mapPharmacies = list.length > 300 ? list.slice(0, 300) : list;
  const italianPage = page.country === 'IT' || Boolean(page.areaSlug);
  const displayCountry = country === 'IT' ? copy.italy : country === 'CH' ? copy.swiss : copy.all;
  const dutyHubPath: PharmacyPath = italianPage ? { kind: 'duty-hub', country: 'IT', locale } : { kind: 'duty-hub', locale };
  const dutyHubLabel = italianPage ? italyDutyLabel(locale) : copy.dutyHub;
  const activeFilterCount = [country !== fixedCountry ? country : '', query.trim(), province !== 'all' ? province : '', city !== fixedCity && city !== 'all' ? city : '', onlyOpen ? 'open' : '', onlyDuty ? 'duty' : '', onlyHours ? 'hours' : '', onlyServices ? 'services' : ''].filter(Boolean).length;

  return <div className="pharmacy-directory-shell mx-auto max-w-6xl space-y-8">
    <header className="pharmacy-hero">
      <div className="pharmacy-hero-inner space-y-4 p-6 sm:p-8">
        <span className="pharmacy-kicker">{page.kind === 'canton' ? copy.swiss : page.kind === 'area' || page.kind === 'country' ? copy.italy : copy.country}</span>
        <h1 className="max-w-4xl font-display text-3xl font-bold leading-tight tracking-tight text-heading sm:text-5xl">{title}</h1>
        <p className="max-w-3xl text-base leading-7 text-body sm:text-lg">{lede}</p>
        <nav className="flex flex-wrap gap-2 pt-2" aria-label={copy.country}>
          <a className={`inline-flex min-h-11 items-center rounded-full border px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${fixedCountry === 'CH' ? 'border-accent bg-accent-subtle text-link' : 'border-edge bg-surface text-body hover:border-accent'}`} href={href({ kind: 'canton', locale })} aria-current={fixedCountry === 'CH' ? 'page' : undefined}>{copy.swiss}</a>
          <a className={`inline-flex min-h-11 items-center rounded-full border px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${fixedCountry === 'IT' ? 'border-accent bg-accent-subtle text-link' : 'border-edge bg-surface text-body hover:border-accent'}`} href={href({ kind: 'country', country: 'IT', locale })} aria-current={fixedCountry === 'IT' ? 'page' : undefined}>{copy.italy}</a>
          <a className="inline-flex min-h-11 items-center rounded-full border border-edge bg-surface px-4 py-2 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href(dutyHubPath)}>{dutyHubLabel}</a>
        </nav>
      </div>
      <div className="pharmacy-stat-strip">
        <div className="pharmacy-stat"><span className="pharmacy-stat-label">{copy.searchLabel}</span><strong className="pharmacy-stat-value">{copy.count(list.length)}</strong></div>
        <div className="pharmacy-stat"><span className="pharmacy-stat-label">{copy.country}</span><strong className="pharmacy-stat-value">{displayCountry}</strong></div>
        <div className="pharmacy-stat"><span className="pharmacy-stat-label">{copy.map}</span><strong className="pharmacy-stat-value">{copy.count(mapPharmacies.length)}</strong></div>
      </div>
    </header>
    <section className="pharmacy-search-panel" aria-labelledby="pharmacy-directory-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.filters}</p><h2 id="pharmacy-directory-heading" className="mt-1 font-display text-2xl font-bold text-heading">{copy.searchLabel}</h2></div>
        <span className="rounded-full bg-accent-subtle px-3 py-1.5 text-sm font-semibold text-link" aria-live="polite">{copy.count(list.length)}</span>
      </div>
      <div className="relative mt-5">
        <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-accent" />
        <label className="sr-only" htmlFor="pharmacy-search">{copy.searchLabel}</label>
        <input id="pharmacy-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} autoComplete="off" className="min-h-14 w-full rounded-2xl border border-edge bg-surface pl-12 pr-4 text-base text-strong shadow-sm outline-none transition focus:border-accent focus-visible:ring-2 focus-visible:ring-accent" />
      </div>
      <fieldset className="mt-5 space-y-4">
        <legend className="sr-only">{copy.filters}</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm font-semibold text-body">{copy.country}<select value={country} onChange={(event) => { setCountry(event.target.value as CountryFilter); setProvince('all'); setCity('all'); }} className="mt-1 min-h-11 w-full rounded-xl border border-edge bg-surface px-3 font-normal text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" disabled={fixedCountry !== 'all'}><option value="all">{copy.all}</option><option value="CH">{copy.swiss}</option><option value="IT">{copy.italy}</option></select></label>
          <label className="text-sm font-semibold text-body">{copy.province}<select value={province} onChange={(event) => { setProvince(event.target.value); setCity('all'); }} className="mt-1 min-h-11 w-full rounded-xl border border-edge bg-surface px-3 font-normal text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" disabled={country === 'CH' || !provinceOptions.length}><option value="all">{copy.allProvinces}</option>{provinceOptions.map((candidate) => <option key={candidate.code} value={candidate.code}>{candidate.name}</option>)}</select></label>
          <label className="text-sm font-semibold text-body">{copy.city}<select value={city} onChange={(event) => setCity(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-edge bg-surface px-3 font-normal text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><option value="all">{copy.allCities}</option>{cityOptions.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label>
          <label className="text-sm font-semibold text-body">{copy.sort}<select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} className="mt-1 min-h-11 w-full rounded-xl border border-edge bg-surface px-3 font-normal text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><option value="name">{copy.sortName}</option><option value="distance" disabled={!userLocation}>{copy.sortDistance}</option></select></label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-body">
          <label className="inline-flex min-h-11 items-center gap-2 rounded-full border border-edge bg-surface px-3"><input type="checkbox" checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />{copy.openNow}</label>
          <label className="inline-flex min-h-11 items-center gap-2 rounded-full border border-edge bg-surface px-3"><input type="checkbox" checked={onlyDuty} onChange={(event) => setOnlyDuty(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />{copy.onDuty}</label>
          <label className="inline-flex min-h-11 items-center gap-2 rounded-full border border-edge bg-surface px-3"><input type="checkbox" checked={onlyHours} onChange={(event) => setOnlyHours(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />{copy.hasHours}</label>
          <label className="inline-flex min-h-11 items-center gap-2 rounded-full border border-edge bg-surface px-3"><input type="checkbox" checked={onlyServices} onChange={(event) => setOnlyServices(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />{copy.hasServices}</label>
          <button type="button" onClick={locate} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-accent-border bg-accent-subtle px-3 font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" disabled={locating}><LocateFixed aria-hidden="true" className="h-4 w-4" />{locating ? copy.locating : copy.locate}</button>
          <button type="button" onClick={reset} className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 font-semibold text-link underline-offset-4 hover:bg-surface-alt hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" disabled={!activeFilterCount}><SlidersHorizontal aria-hidden="true" className="h-4 w-4" />{copy.reset}</button>
        </div>
      </fieldset>
      {userLocation && <p className="mt-4 text-sm text-success" role="status">{copy.locationReady}</p>}
      {locationError && <p className="mt-4 text-sm text-warning" role="status">{copy.locationDenied}</p>}
    </section>
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,0.72fr)]">
      <section className="min-w-0" aria-labelledby="pharmacy-results-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.count(list.length)}</p><h2 id="pharmacy-results-heading" className="mt-1 font-display text-2xl font-bold text-heading">{copy.details}</h2></div>{activeFilterCount > 0 && <span className="text-sm text-muted">{activeFilterCount} {copy.filters.toLowerCase()}</span>}</div>
        {list.length > 0 ? <div className="pharmacy-directory-list space-y-3">{list.map((pharmacy) => <PharmacyCard key={pharmacy.id} pharmacy={pharmacy} locale={locale} now={now} userLocation={userLocation} />)}</div> : <p className="rounded-2xl border border-edge bg-surface-alt p-5 text-sm text-muted" role="status">{copy.noResults}</p>}
      </section>
      <aside className="min-w-0 xl:sticky xl:top-24 xl:self-start" aria-labelledby="pharmacy-map-heading">
        <div className="pharmacy-detail-card p-4 sm:p-5"><div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.map}</p><h2 id="pharmacy-map-heading" className="mt-1 font-display text-xl font-bold text-heading">{copy.map}</h2></div>{mapPharmacies.length < list.length && <span className="text-xs text-muted">{copy.count(mapPharmacies.length)}</span>}</div><PharmacyMap pharmacies={mapPharmacies} getHref={(pharmacy) => href(detailPath(pharmacy, locale))} openLabel={copy.details} noLocationLabel={copy.noMap} /></div>
      </aside>
    </div>
    <aside className="rounded-2xl border border-accent-border bg-accent-subtle p-5 text-sm leading-6 text-body"><strong className="text-heading">{copy.verifyHeading}</strong><p className="mt-2 text-muted">{copy.verify}</p></aside>
  </div>;
}

function CountryDirectoryPageRedesign({ locale }: { locale: Locale }) {
  const copy = COPY[locale];
  const provinces = ITALY_BORDER_PROVINCES.map((province) => ({
    province,
    count: ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === province.code).length,
  }));
  const total = provinces.reduce((sum, entry) => sum + entry.count, 0);
  return <div className="pharmacy-directory-shell mx-auto max-w-6xl space-y-8">
    <header className="pharmacy-hero">
      <div className="pharmacy-hero-inner space-y-4 p-6 sm:p-8">
        <span className="pharmacy-kicker">{copy.italy}</span>
        <h1 className="max-w-4xl font-display text-3xl font-bold leading-tight tracking-tight text-heading sm:text-5xl">{copy.italy}</h1>
        <p className="max-w-3xl text-base leading-7 text-body sm:text-lg">{copy.italyLede}</p>
        <nav className="flex flex-wrap gap-2 pt-2" aria-label={copy.country}>
          <a className="inline-flex min-h-11 items-center rounded-full border border-edge bg-surface px-4 py-2 text-sm font-semibold text-body hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href({ kind: 'canton', locale })}>{copy.swiss}</a>
          <a className="inline-flex min-h-11 items-center rounded-full border border-accent bg-accent-subtle px-4 py-2 text-sm font-semibold text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href({ kind: 'country', country: 'IT', locale })} aria-current="page">{copy.italy}</a>
          <a className="inline-flex min-h-11 items-center rounded-full border border-edge bg-surface px-4 py-2 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href({ kind: 'duty-hub', country: 'IT', locale })}>{italyDutyLabel(locale)}</a>
        </nav>
      </div>
      <div className="pharmacy-stat-strip">
        <div className="pharmacy-stat"><span className="pharmacy-stat-label">{copy.searchLabel}</span><strong className="pharmacy-stat-value">{copy.count(total)}</strong></div>
        <div className="pharmacy-stat"><span className="pharmacy-stat-label">{copy.province}</span><strong className="pharmacy-stat-value">{provinces.length}</strong></div>
        <div className="pharmacy-stat"><span className="pharmacy-stat-label">{copy.source}</span><strong className="pharmacy-stat-value">{copy.official}</strong></div>
      </div>
    </header>
    <section aria-labelledby="pharmacy-province-heading">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.province}</p><h2 id="pharmacy-province-heading" className="mt-1 font-display text-2xl font-bold text-heading">{copy.searchLabel}</h2></div><span className="text-sm text-muted">{copy.count(total)}</span></div>
      <ul className="grid gap-3 md:grid-cols-3" aria-label={copy.province}>{provinces.map(({ province, count }) => <li key={province.code}><a className="pharmacy-province-link group" href={href({ kind: 'area', country: 'IT', areaSlug: province.slug, locale })}><span className="min-w-0"><span className="block font-display text-lg font-bold text-heading">{province.name}</span><span className="mt-1 block text-sm text-muted">{copy.count(count)}</span></span><ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-accent transition-transform group-hover:translate-x-1" /></a></li>)}</ul>
    </section>
    <aside className="rounded-2xl border border-accent-border bg-accent-subtle p-5 text-sm leading-6 text-body"><strong className="text-heading">{copy.verifyHeading}</strong><p className="mt-2 text-muted">{copy.verify}</p></aside>
  </div>;
}

function DutyPage({ page, locale, now }: { page: PharmacyPath; locale: Locale; now: Date }) {
  const copy = COPY[locale];
  const city = page.kind === 'duty-city' && page.citySlug ? TICINO_CITIES.find((candidate) => candidate.slug === page.citySlug)?.name : undefined;
  const coverage = city ? [...new Set(scopeForPage(page).map((pharmacy) => DUTY_COVERAGE_BY_PHARMACY.get(pharmacy.id)).filter(Boolean))][0] : undefined;
  const currentDuty = coverage ? currentDutyForRegion(DUTIES, coverage, now) : undefined;
  const duties = currentDuty ? [currentDuty] : [];
  return <div className="mx-auto max-w-6xl space-y-8"><header className="space-y-3"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{copy.swiss}</p><h1 className="font-display text-3xl font-bold tracking-tight text-heading sm:text-4xl">{page.kind === 'duty-city' ? `${copy.dutyHub}: ${city || ''}` : copy.dutyHub}</h1><p className="max-w-3xl text-base leading-7 text-muted">{copy.verify}</p></header>{page.kind === 'duty-city' ? <section className="space-y-4" aria-labelledby="pharmacy-duty-city-heading"><h2 id="pharmacy-duty-city-heading" className="font-display text-xl font-bold text-heading">{coverage || copy.dutyArea}</h2><div className="grid gap-4 md:grid-cols-2">{duties.slice(0, 6).map((duty) => <DutyCard key={duty.id} duty={duty} locale={locale} now={now} />)}</div>{duties.length === 0 && <p className="rounded-xl border border-edge bg-surface-alt p-4 text-sm text-muted" role="status">{copy.noDuty}</p>}</section> : <PharmacyDutyCoverageMatrix locale={locale} now={now} />}<aside className="rounded-2xl border border-accent/30 bg-accent-subtle p-5 text-sm leading-6 text-body"><strong className="text-heading">{copy.verifyHeading}</strong><p className="mt-2 text-muted">{copy.verify}</p></aside></div>;
}

export default function PharmacyDirectory({ page }: { page: PharmacyPath }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  const pharmacy = pharmacyForPage(page);
  if (page.kind === 'pharmacy') return pharmacy ? <DetailPage pharmacy={pharmacy} locale={page.locale} now={now} /> : <p className="mx-auto max-w-2xl rounded-xl border border-edge bg-surface-alt p-5 text-muted">{COPY[page.locale].noPharmacy}</p>;
  if (page.kind === 'duty-week') return page.country === 'IT'
    ? <PharmacyItalyDutyWeek page={page} now={now} />
    : <PharmacyDutyWeek page={page} />;
  if (page.kind === 'italy-duty-hub') return <PharmacyItalyDutyCoverageMatrix locale={page.locale} now={now} />;
  if (page.kind === 'italy-duty-week') return <PharmacyItalyDutyWeek page={page} now={now} />;
  if (page.kind === 'duty-hub' && page.country === 'IT') return <PharmacyItalyDutyCoverageMatrix locale={page.locale} now={now} />;
  if (page.kind === 'duty-hub' || page.kind === 'duty-city') return <DutyPage page={page} locale={page.locale} now={now} />;
  if (page.kind === 'country') return <CountryDirectoryPageRedesign locale={page.locale} />;
  if (page.kind === 'city' && !page.areaSlug && page.citySlug) {
    return <><nav className="mx-auto mb-6 max-w-6xl" aria-label={COPY[page.locale].dutyHub}><a className="inline-flex min-h-11 items-center rounded-full border border-accent/40 bg-accent-subtle px-4 py-2 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={href({ kind: 'duty-city', locale: page.locale, citySlug: page.citySlug })}>{COPY[page.locale].dutyHub}: {cityNameForPage(page)}</a></nav><DirectoryPageRedesign page={page} locale={page.locale} now={now} /></>;
  }
  return <DirectoryPageRedesign page={page} locale={page.locale} now={now} />;
}
