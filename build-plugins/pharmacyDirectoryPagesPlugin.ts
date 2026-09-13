import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, BUILD_DATE_STAMP, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { esc, H1_STYLE, H2_STYLE, H3_STYLE, LEDE_STYLE, BODY_STYLE, CARD_CLASS } from './shared/seoContentTokens';
import {
  BORDER_PHARMACIES,
  ITALY_BORDER_PHARMACIES,
  ITALY_BORDER_PROVINCES,
  ITALY_CITIES,
  TICINO_CITIES,
  TICINO_PHARMACIES,
  pharmacyById,
  pharmacyBySlug,
  pharmacyCitySlug,
  pharmaciesForCity,
  pharmaciesForProvince,
} from '../services/pharmacies/data';
import { buildPharmacyPath, type PharmacyPageKind, type PharmacyPath } from '../services/pharmacies/paths';
import { publicDutiesForRegion } from '../services/pharmacies/duties';
import type { Locale } from '../services/i18n';
import { safePharmacyUrl, type Pharmacy, type PharmacyDuty, type PharmacyDutiesDataset, type PharmacyFieldSource } from '../services/pharmacies/types';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import { shouldEmitLocale } from './shared/localeEmitFilter';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];
const dutiesDataset = dutiesJson as PharmacyDutiesDataset;
const dutySource = 'https://www.ofct.ch/farmacieturno/';
const osmLicense = 'OpenStreetMap contributors, ODbL 1.0';
const PHARMACY_TITLE_DUPLICATES = new Set(
  BORDER_PHARMACIES
    .map((pharmacy) => `${pharmacy.name}\u0000${pharmacy.city}`)
    .filter((key, index, keys) => keys.indexOf(key) !== index),
);

type Copy = {
  hubTitle: string;
  ticinoTitle: string;
  italyTitle: string;
  italyAreaTitle: (area: string) => string;
  cityTitle: (city: string, country: 'CH' | 'IT') => string;
  pharmacyTitle: (pharmacy: Pharmacy) => string;
  dutyHubTitle: string;
  dutyCityTitle: (city: string) => string;
  hubLede: string;
  ticinoLede: string;
  italyLede: string;
  areaLede: string;
  cityLede: string;
  detailLede: string;
  dutyHubLede: string;
  dutyCityLede: string;
  directoryHeading: string;
  contactHeading: string;
  hoursHeading: string;
  servicesHeading: string;
  sourcesHeading: string;
  source: string;
  checked: string;
  address: string;
  phone: string;
  website: string;
  hoursUnavailable: string;
  servicesUnavailable: string;
  sourceOfficial: string;
  sourceOsm: string;
  sourceLink: string;
  map: string;
  openMap: string;
  detail: string;
  viewDuties: string;
  duties: string;
  coverage: string;
  interval: string;
  noDuty: string;
  disclaimerHeading: string;
  disclaimer: string;
  osmNote: string;
  locarneseNote: string;
};

const COPY: Record<Locale, Copy> = {
  it: {
    hubTitle: 'Farmacie in Ticino e al confine italiano: elenco e fonti', ticinoTitle: 'Farmacie in Ticino', italyTitle: 'Farmacie italiane al confine con il Ticino', italyAreaTitle: (area) => `Farmacie in provincia di ${area}`, cityTitle: (city, country) => country === 'CH' ? `Farmacie a ${city}, Ticino` : `Farmacie a ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'Farmacie di turno in Ticino', dutyCityTitle: (city) => `Farmacia di turno: informazioni per ${city}`,
    hubLede: 'Elenco verificato delle farmacie del Ticino e delle province italiane di Como, Varese e Verbano-Cusio-Ossola. Ogni scheda distingue anagrafica, orari, servizi, fonte e data dell’ultimo recupero.', ticinoLede: 'Anagrafica ufficiale delle farmacie aperte al pubblico in Ticino, integrata con l’elenco cantonale e con dati cartografici OSM quando la corrispondenza è certa.', italyLede: 'Anagrafica del Ministero della Salute italiano filtrata per le province di Como, Varese e Verbano-Cusio-Ossola. La presenza nell’elenco non significa apertura in questo momento.', areaLede: 'Sedi censite dal dataset ufficiale italiano per questa provincia. Orari, telefono e servizi sono mostrati solo quando una fonte secondaria tracciata li pubblica.', cityLede: 'Sedi censite nella località selezionata, con collegamento alla scheda individuale e alla fonte del dato.', detailLede: 'Scheda della sede con indirizzo, contatti, coordinate, orari e servizi disponibili nella fonte indicata. Verifica sempre prima di partire.', dutyHubLede: 'Turni regionali pubblicati dall’Ordine dei Farmacisti del Cantone Ticino. Un turno regionale non implica apertura continua né sostituisce una conferma telefonica.', dutyCityLede: 'La città è collegata alla relativa area regionale di turno. La copertura non è una promessa di servizio per ogni comune: verifica farmacia e intervallo direttamente.', directoryHeading: 'Elenco farmacie', contactHeading: 'Contatti e posizione', hoursHeading: 'Orari pubblicati', servicesHeading: 'Servizi pubblicati', sourcesHeading: 'Fonti e aggiornamento', source: 'Fonte', checked: 'Recuperato il', address: 'Indirizzo', phone: 'Telefono', website: 'Sito web', hoursUnavailable: 'La fonte primaria non pubblica orari verificabili per questa sede.', servicesUnavailable: 'La fonte primaria non pubblica servizi verificabili per questa sede.', sourceOfficial: 'Fonte ufficiale', sourceOsm: 'Dati cartografici OpenStreetMap', sourceLink: 'Apri fonte', map: 'Posizione', openMap: 'Apri mappa OpenStreetMap', detail: 'Apri scheda completa', viewDuties: 'Vedi turni regionali', duties: 'Turni regionali', coverage: 'Area', interval: 'Intervallo', noDuty: 'Nessun intervallo verificato disponibile per questa area nel dataset corrente.', disclaimerHeading: 'Verifica prima di partire', disclaimer: 'Orari e turni possono cambiare. Chiama la farmacia o controlla la fonte indicata, soprattutto in caso di urgenza. I dati OSM sono contributi della comunità e vanno verificati.', osmNote: 'Orari, contatti o servizi derivati da OpenStreetMap sono indicati con la loro fonte e licenza ODbL; non rappresentano un turno ufficiale.', locarneseNote: 'Il Locarnese è incluso nell’anagrafica cantonale quando presente nell’elenco ufficiale; i turni pubblicati qui coprono soltanto le regioni OFCT disponibili nel dataset.',
  },
  en: {
    hubTitle: 'Pharmacies in Ticino and across the Italian border: directory and sources', ticinoTitle: 'Pharmacies in Ticino', italyTitle: 'Italian pharmacies near the Ticino border', italyAreaTitle: (area) => `Pharmacies in ${area} province`, cityTitle: (city, country) => country === 'CH' ? `Pharmacies in ${city}, Ticino` : `Pharmacies in ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'On-duty pharmacies in Ticino', dutyCityTitle: (city) => `On-duty pharmacy information for ${city}`,
    hubLede: 'Verified directory of pharmacies in Ticino and the Italian provinces of Como, Varese and Verbano-Cusio-Ossola. Each page distinguishes identity, hours, services, source and retrieval date.', ticinoLede: 'Official public-pharmacy directory for Ticino, completed with the cantonal list and OSM map data when the match is unambiguous.', italyLede: 'Italian Ministry of Health directory filtered to Como, Varese and Verbano-Cusio-Ossola. Being listed does not mean being open now.', areaLede: 'Locations listed by the official Italian dataset for this province. Hours, phone and services appear only when a traceable secondary source publishes them.', cityLede: 'Locations listed for the selected locality, with a link to each individual page and its data source.', detailLede: 'Location page with address, contacts, coordinates, hours and services available from the cited source. Check before travelling.', dutyHubLede: 'Regional duty schedules published by the Ticino Pharmacists’ Association. A regional duty does not imply continuous opening and does not replace a phone confirmation.', dutyCityLede: 'The city is linked to its regional duty area. Coverage is not a promise of service in every municipality: confirm the pharmacy and interval directly.', directoryHeading: 'Pharmacy directory', contactHeading: 'Contact and location', hoursHeading: 'Published hours', servicesHeading: 'Published services', sourcesHeading: 'Sources and update', source: 'Source', checked: 'Retrieved on', address: 'Address', phone: 'Phone', website: 'Website', hoursUnavailable: 'The primary source does not publish verifiable hours for this location.', servicesUnavailable: 'The primary source does not publish verifiable services for this location.', sourceOfficial: 'Official source', sourceOsm: 'OpenStreetMap map data', sourceLink: 'Open source', map: 'Location', openMap: 'Open OpenStreetMap', detail: 'Open full page', viewDuties: 'View regional duties', duties: 'Regional duties', coverage: 'Area', interval: 'Interval', noDuty: 'No verified interval is available for this area in the current dataset.', disclaimerHeading: 'Check before travelling', disclaimer: 'Hours and duties can change. Call the pharmacy or check the cited source, especially in an emergency. OSM data is community-contributed and must be checked.', osmNote: 'Hours, contacts or services derived from OpenStreetMap show their source and ODbL licence; they are not an official duty schedule.', locarneseNote: 'Locarnese is included in the cantonal directory when present in the official list; duty pages cover only the OFCT regions available in the dataset.',
  },
  de: {
    hubTitle: 'Apotheken im Tessin und an der italienischen Grenze: Verzeichnis und Quellen', ticinoTitle: 'Apotheken im Tessin', italyTitle: 'Italienische Apotheken an der Tessiner Grenze', italyAreaTitle: (area) => `Apotheken in der Provinz ${area}`, cityTitle: (city, country) => country === 'CH' ? `Apotheken in ${city}, Tessin` : `Apotheken in ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'Notdienst-Apotheken im Tessin', dutyCityTitle: (city) => `Informationen zum Apotheken-Notdienst in ${city}`,
    hubLede: 'Verifiziertes Verzeichnis für Apotheken im Tessin sowie in den italienischen Provinzen Como, Varese und Verbano-Cusio-Ossola. Jede Seite trennt Identität, Zeiten, Leistungen, Quelle und Abrufdatum.', ticinoLede: 'Offizielles Verzeichnis der öffentlichen Apotheken im Tessin, ergänzt durch die kantonale Liste und OSM-Kartendaten bei eindeutiger Zuordnung.', italyLede: 'Verzeichnis des italienischen Gesundheitsministeriums, gefiltert nach Como, Varese und Verbano-Cusio-Ossola. Ein Eintrag bedeutet nicht, dass die Apotheke jetzt geöffnet ist.', areaLede: 'Standorte des offiziellen italienischen Datensatzes für diese Provinz. Zeiten, Telefon und Leistungen werden nur mit nachvollziehbarer Zweitquelle gezeigt.', cityLede: 'Standorte der ausgewählten Ortschaft mit Link zur Einzelseite und Datenquelle.', detailLede: 'Einzelseite mit Adresse, Kontakt, Koordinaten, Öffnungszeiten und Leistungen aus der angegebenen Quelle. Vor der Fahrt prüfen.', dutyHubLede: 'Regionale Notdienstpläne des Tessiner Apothekerverbands. Ein regionaler Notdienst bedeutet keine durchgehende Öffnung und ersetzt keine telefonische Bestätigung.', dutyCityLede: 'Die Stadt wird dem regionalen Notdienstgebiet zugeordnet. Das Gebiet ist keine Zusage für jede Gemeinde: Apotheke und Zeitraum direkt bestätigen.', directoryHeading: 'Apothekenverzeichnis', contactHeading: 'Kontakt und Standort', hoursHeading: 'Veröffentlichte Öffnungszeiten', servicesHeading: 'Veröffentlichte Leistungen', sourcesHeading: 'Quellen und Aktualisierung', source: 'Quelle', checked: 'Abgerufen am', address: 'Adresse', phone: 'Telefon', website: 'Website', hoursUnavailable: 'Die Primärquelle veröffentlicht für diesen Standort keine überprüfbaren Öffnungszeiten.', servicesUnavailable: 'Die Primärquelle veröffentlicht für diesen Standort keine überprüfbaren Leistungen.', sourceOfficial: 'Offizielle Quelle', sourceOsm: 'OpenStreetMap-Kartendaten', sourceLink: 'Quelle öffnen', map: 'Standort', openMap: 'OpenStreetMap öffnen', detail: 'Vollständige Seite öffnen', viewDuties: 'Regionale Notdienste', duties: 'Regionale Notdienste', coverage: 'Gebiet', interval: 'Zeitraum', noDuty: 'Für dieses Gebiet ist im aktuellen Datensatz kein verifizierter Zeitraum verfügbar.', disclaimerHeading: 'Vor der Fahrt prüfen', disclaimer: 'Öffnungszeiten und Notdienste können sich ändern. Besonders im Notfall telefonisch oder bei der Quelle prüfen. OSM-Daten stammen aus der Community und müssen geprüft werden.', osmNote: 'Aus OpenStreetMap abgeleitete Zeiten, Kontakte oder Leistungen nennen Quelle und ODbL-Lizenz; sie sind kein offizieller Notdienstplan.', locarneseNote: 'Locarnese ist im kantonalen Verzeichnis enthalten, wenn es in der offiziellen Liste steht; Notdienstseiten decken nur die verfügbaren OFCT-Regionen ab.',
  },
  fr: {
    hubTitle: 'Pharmacies au Tessin et à la frontière italienne : répertoire et sources', ticinoTitle: 'Pharmacies au Tessin', italyTitle: 'Pharmacies italiennes près de la frontière du Tessin', italyAreaTitle: (area) => `Pharmacies dans la province de ${area}`, cityTitle: (city, country) => country === 'CH' ? `Pharmacies à ${city}, Tessin` : `Pharmacies à ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'Pharmacies de garde au Tessin', dutyCityTitle: (city) => `Informations de garde pour ${city}`,
    hubLede: 'Répertoire vérifié des pharmacies du Tessin et des provinces italiennes de Côme, Varèse et Verbano-Cusio-Ossola. Chaque page distingue identité, horaires, services, source et date de collecte.', ticinoLede: 'Répertoire officiel des pharmacies ouvertes au public au Tessin, complété par la liste cantonale et les données cartographiques OSM lorsque la correspondance est certaine.', italyLede: 'Répertoire du ministère italien de la Santé filtré sur Côme, Varèse et Verbano-Cusio-Ossola. Être listé ne signifie pas être ouvert maintenant.', areaLede: 'Sites recensés par le jeu officiel italien pour cette province. Horaires, téléphone et services apparaissent uniquement avec une source secondaire traçable.', cityLede: 'Sites recensés dans la localité sélectionnée, avec un lien vers chaque fiche et sa source.', detailLede: 'Fiche avec adresse, contacts, coordonnées, horaires et services disponibles dans la source citée. Vérifiez avant de partir.', dutyHubLede: 'Gardes régionales publiées par l’association des pharmaciens du Tessin. Une garde régionale ne signifie pas une ouverture continue et ne remplace pas une confirmation téléphonique.', dutyCityLede: 'La ville est reliée à sa zone régionale de garde. La zone ne garantit pas un service dans chaque commune : confirmez directement la pharmacie et l’intervalle.', directoryHeading: 'Répertoire des pharmacies', contactHeading: 'Contact et localisation', hoursHeading: 'Horaires publiés', servicesHeading: 'Services publiés', sourcesHeading: 'Sources et mise à jour', source: 'Source', checked: 'Collecté le', address: 'Adresse', phone: 'Téléphone', website: 'Site web', hoursUnavailable: 'La source primaire ne publie pas d’horaires vérifiables pour ce site.', servicesUnavailable: 'La source primaire ne publie pas de services vérifiables pour ce site.', sourceOfficial: 'Source officielle', sourceOsm: 'Données cartographiques OpenStreetMap', sourceLink: 'Ouvrir la source', map: 'Localisation', openMap: 'Ouvrir OpenStreetMap', detail: 'Ouvrir la fiche complète', viewDuties: 'Voir les gardes régionales', duties: 'Gardes régionales', coverage: 'Zone', interval: 'Intervalle', noDuty: 'Aucun intervalle vérifié n’est disponible pour cette zone dans le jeu actuel.', disclaimerHeading: 'Vérifiez avant de partir', disclaimer: 'Les horaires et gardes peuvent changer. Appelez la pharmacie ou consultez la source citée, surtout en cas d’urgence. Les données OSM sont communautaires et doivent être vérifiées.', osmNote: 'Les horaires, contacts ou services dérivés d’OpenStreetMap indiquent leur source et la licence ODbL; ils ne constituent pas une garde officielle.', locarneseNote: 'Le Locarnese est inclus dans le répertoire cantonal lorsqu’il figure dans la liste officielle; les gardes couvrent uniquement les régions OFCT disponibles.',
  },
};

function formatDate(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(date);
}

function pharmacyPath(pharmacy: Pharmacy, locale: Locale): PharmacyPath {
  if (pharmacy.country === 'IT') {
    const areaSlug = ITALY_BORDER_PROVINCES.find((area) => area.code === pharmacy.province)?.slug;
    return { kind: 'pharmacy', locale, country: 'IT', areaSlug, citySlug: pharmacyCitySlug(pharmacy.city), pharmacySlug: pharmacy.slug };
  }
  return { kind: 'pharmacy', locale, country: 'CH', citySlug: pharmacyCitySlug(pharmacy.city), pharmacySlug: pharmacy.slug };
}

function cityPath(country: Pharmacy['country'], locale: Locale, citySlug: string, areaSlug?: string): PharmacyPath {
  return country === 'IT'
    ? { kind: 'city', locale, country, areaSlug, citySlug }
    : { kind: 'city', locale, citySlug };
}

function href(pathValue: PharmacyPath, label: string): string {
  return `<a href="${esc(buildPharmacyPath(pathValue, pathValue.locale))}">${esc(label)}</a>`;
}

function sourceLine(pharmacy: Pharmacy, locale: Locale): string {
  const copy = COPY[locale];
  const fieldSources = Object.entries(pharmacy.fieldSources || {}) as Array<[string, PharmacyFieldSource | undefined]>;
  const secondary = fieldSources
    .filter(([, source]) => Boolean(source))
    .map(([field, source]) => `<br><strong>${esc(source!.sourceType === 'directory' ? copy.sourceOsm : copy.sourceOfficial)} (${esc(field)}):</strong> <a href="${esc(source!.url)}" rel="nofollow noopener">${esc(copy.sourceLink)}</a>${source!.license ? ` (${esc(source!.license)})` : ''}`)
    .join('');
  return `<p style="${BODY_STYLE}"><strong>${esc(copy.sourceOfficial)}:</strong> <a href="${esc(pharmacy.sourceUrl)}" rel="nofollow noopener">${esc(copy.sourceLink)}</a><br><strong>${esc(copy.checked)}:</strong> ${esc(formatDate(pharmacy.lastVerifiedAt, locale))}${secondary}</p>`;
}

function renderPharmacyCard(pharmacy: Pharmacy, locale: Locale): string {
  const copy = COPY[locale];
  const countryPath = pharmacyPath(pharmacy, locale);
  const city = pharmacyCitySlug(pharmacy.city);
  const cityUrl = pharmacy.country === 'IT'
    ? cityPath('IT', locale, city, ITALY_BORDER_PROVINCES.find((area) => area.code === pharmacy.province)?.slug)
    : cityPath('CH', locale, city);
  const badges = [pharmacy.openingHours?.length ? copy.hoursHeading : '', pharmacy.services?.length ? copy.servicesHeading : ''].filter(Boolean);
  return `<article class="${CARD_CLASS}"><h3 style="${H3_STYLE}"><a href="${esc(buildPharmacyPath(countryPath, locale))}">${esc(pharmacy.name)}</a></h3><p style="${BODY_STYLE}"><strong>${esc(copy.address)}:</strong> ${esc(pharmacy.address)}, ${href(cityUrl, `${pharmacy.postalCode} ${pharmacy.city}`)}${pharmacy.phone ? `<br><strong>${esc(copy.phone)}:</strong> <a href="tel:${esc(pharmacy.phone)}">${esc(pharmacy.phone)}</a>` : ''}</p>${badges.length ? `<p style="${BODY_STYLE}">${badges.map(esc).join(' · ')}</p>` : ''}${sourceLine(pharmacy, locale)}</article>`;
}

function renderHours(pharmacy: Pharmacy, locale: Locale): string {
  const copy = COPY[locale];
  if (!pharmacy.openingHours?.length) return `<p style="${BODY_STYLE}">${esc(copy.hoursUnavailable)}</p>`;
  return `<ul style="${BODY_STYLE}">${pharmacy.openingHours.map((hour) => `<li><strong>${esc(hour.dayOfWeek)}:</strong> ${esc(hour.opens)}–${esc(hour.closes)}</li>`).join('')}</ul>`;
}

function renderServices(pharmacy: Pharmacy, locale: Locale): string {
  const copy = COPY[locale];
  if (!pharmacy.services?.length) return `<p style="${BODY_STYLE}">${esc(copy.servicesUnavailable)}</p>`;
  return `<ul style="${BODY_STYLE}">${pharmacy.services.map((service) => `<li>${esc(service)}</li>`).join('')}</ul>`;
}

function renderDuty(duty: PharmacyDuty | undefined, locale: Locale): string {
  const copy = COPY[locale];
  if (!duty) return `<p style="${BODY_STYLE}">${esc(copy.noDuty)}</p>`;
  const pharmacy = pharmacyById(duty.pharmacyId) || pharmacyBySlug(duty.pharmacyId);
  return `<article class="${CARD_CLASS}"><h3 style="${H3_STYLE}">${esc(pharmacy?.name || duty.pharmacyId)}</h3><p style="${BODY_STYLE}"><strong>${esc(copy.coverage)}:</strong> ${esc(duty.coverageName)}<br><strong>${esc(copy.interval)}:</strong> ${esc(formatDate(duty.startsAt, locale))} – ${esc(formatDate(duty.endsAt, locale))}<br><strong>${esc(copy.checked)}:</strong> ${esc(formatDate(duty.fetchedAt, locale))}</p>${pharmacy ? `<p style="${BODY_STYLE}">${esc(pharmacy.address)}, ${esc(pharmacy.postalCode)} ${esc(pharmacy.city)}${pharmacy.phone ? ` · <a href="tel:${esc(pharmacy.phone)}">${esc(pharmacy.phone)}</a>` : ''}</p>` : ''}<p style="${BODY_STYLE}"><a href="${esc(duty.sourceUrl || dutySource)}" rel="nofollow noopener">${esc(copy.sourceLink)}</a></p></article>`;
}

function detailJsonLd(pharmacy: Pharmacy, locale: Locale): string {
  const pathValue = pharmacyPath(pharmacy, locale);
  const website = safePharmacyUrl(pharmacy.website);
  const payload: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Pharmacy',
    name: pharmacy.name,
    url: `${BASE_URL}${buildPharmacyPath(pathValue, locale)}`,
    address: { '@type': 'PostalAddress', streetAddress: pharmacy.address, postalCode: pharmacy.postalCode, addressLocality: pharmacy.city, addressCountry: pharmacy.country },
    ...(pharmacy.phone ? { telephone: pharmacy.phone } : {}),
    ...(website ? { sameAs: website } : {}),
    ...(pharmacy.latitude !== undefined && pharmacy.longitude !== undefined ? { geo: { '@type': 'GeoCoordinates', latitude: pharmacy.latitude, longitude: pharmacy.longitude } } : {}),
  };
  if (pharmacy.openingHours?.length) {
    payload.openingHoursSpecification = pharmacy.openingHours.map((hour) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${hour.dayOfWeek.charAt(0).toUpperCase()}${hour.dayOfWeek.slice(1)}`, opens: hour.opens, closes: hour.closes }));
  }
  return JSON.stringify(payload);
}

function collectionJsonLd(pathValue: PharmacyPath, title: string, pharmacies: Pharmacy[]): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(pathValue, pathValue.locale)}`,
    mainEntity: { '@type': 'ItemList', numberOfItems: pharmacies.length, itemListElement: pharmacies.map((pharmacy, index) => ({ '@type': 'ListItem', position: index + 1, name: pharmacy.name, url: `${BASE_URL}${buildPharmacyPath(pharmacyPath(pharmacy, pathValue.locale), pathValue.locale)}` })) },
  });
}

function pageTitle(kind: PharmacyPageKind, locale: Locale, descriptor: PageDescriptor): string {
  const copy = COPY[locale];
  if (kind === 'hub') return copy.hubTitle;
  if (kind === 'canton') return copy.ticinoTitle;
  if (kind === 'country') return copy.italyTitle;
  if (kind === 'area') return copy.italyAreaTitle(descriptor.areaName || descriptor.areaSlug || '');
  if (kind === 'duty-hub') return copy.dutyHubTitle;
  if (kind === 'duty-city') return copy.dutyCityTitle(descriptor.cityName || '');
  if (kind === 'pharmacy') return pharmacyTitle(descriptor.pharmacy!);
  return copy.cityTitle(descriptor.cityName || '', descriptor.country || 'CH');
}

function pharmacyTitleBase(pharmacy: Pharmacy, discriminator: string): string {
  const citySuffix = ` — ${pharmacy.city}`;
  // Keep the locality visible even when an official name is unusually long;
  // otherwise two different cities sharing a long chain name collapse to the
  // same truncated <title>. Reserve the optional discriminator as well so
  // same-name/same-city records remain unique after shell compaction.
  const nameBudget = Math.max(1, 52 - citySuffix.length - discriminator.length);
  const name = pharmacy.name.length > nameBudget
    ? `${pharmacy.name.slice(0, Math.max(1, nameBudget - 1)).replace(/[\s,:;–—-]+$/, '')}…`
    : pharmacy.name;
  return `${name}${citySuffix}${discriminator}`;
}

function pharmacyDiscriminator(pharmacy: Pharmacy): string {
  if (!PHARMACY_TITLE_DUPLICATES.has(`${pharmacy.name}\u0000${pharmacy.city}`)) return '';
  const compactAddress = pharmacy.address
    .replace(/^(via|viale|piazza|corso|largo|vicolo|strada)\s+/i, '')
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` · ${pharmacy.ministryId ? `#${pharmacy.ministryId}` : `${pharmacy.postalCode} ${compactAddress}`}`;
}

const pharmacyTitleGroups = new Map<string, string[]>();
for (const pharmacy of BORDER_PHARMACIES) {
  const title = pharmacyTitleBase(pharmacy, pharmacyDiscriminator(pharmacy));
  pharmacyTitleGroups.set(title, [...(pharmacyTitleGroups.get(title) || []), pharmacy.id]);
}
const PHARMACY_TITLE_COLLISION_RANKS = new Map<string, number>();
for (const ids of pharmacyTitleGroups.values()) {
  if (ids.length < 2) continue;
  ids.forEach((id, index) => PHARMACY_TITLE_COLLISION_RANKS.set(id, index + 1));
}

function pharmacyTitle(pharmacy: Pharmacy): string {
  const rank = PHARMACY_TITLE_COLLISION_RANKS.get(pharmacy.id);
  const discriminator = rank ? ` · #${rank}` : pharmacyDiscriminator(pharmacy);
  return pharmacyTitleBase(pharmacy, discriminator);
}

function pageLede(kind: PharmacyPageKind, locale: Locale): string {
  const copy = COPY[locale];
  if (kind === 'hub') return copy.hubLede;
  if (kind === 'canton') return copy.ticinoLede;
  if (kind === 'country') return copy.italyLede;
  if (kind === 'area') return copy.areaLede;
  if (kind === 'duty-hub') return copy.dutyHubLede;
  if (kind === 'duty-city') return copy.dutyCityLede;
  if (kind === 'pharmacy') return copy.detailLede;
  return copy.cityLede;
}

function compactTitle(value: string, max = 52): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/[\s,:;–—-]+$/, '')}…`;
}

function shellTitle(descriptor: PageDescriptor, locale: Locale): string {
  return compactTitle(pageTitle(descriptor.kind, locale, descriptor));
}

function pageDescription(descriptor: PageDescriptor, locale: Locale): string {
  const copy = COPY[locale];
  if (descriptor.kind === 'pharmacy' && descriptor.pharmacy) {
    return `${pharmacyTitle(descriptor.pharmacy)}: ${copy.detailLede}`;
  }
  if (descriptor.kind === 'city' || descriptor.kind === 'area' || descriptor.kind === 'duty-city') {
    return `${descriptor.cityName || descriptor.areaName || ''}: ${pageLede(descriptor.kind, locale)}`;
  }
  return pageLede(descriptor.kind, locale);
}

interface PageDescriptor {
  kind: PharmacyPageKind;
  country?: 'CH' | 'IT';
  areaSlug?: string;
  areaName?: string;
  citySlug?: string;
  cityName?: string;
  pharmacy?: Pharmacy;
}

function descriptorPath(descriptor: PageDescriptor, locale: Locale): PharmacyPath {
  if (descriptor.kind === 'hub' || descriptor.kind === 'canton' || descriptor.kind === 'country' || descriptor.kind === 'duty-hub') return { kind: descriptor.kind, locale, country: descriptor.country };
  if (descriptor.kind === 'pharmacy') return pharmacyPath(descriptor.pharmacy!, locale);
  if (descriptor.kind === 'duty-city') return { kind: 'duty-city', locale, citySlug: descriptor.citySlug };
  return cityPath(descriptor.country || 'CH', locale, descriptor.citySlug || '', descriptor.areaSlug);
}

function publicDutyRows(now = new Date()): PharmacyDuty[] {
  return dutiesDataset.duties.filter((duty) => publicDutiesForRegion(dutiesDataset, duty.coverageName, now).some((candidate) => candidate.id === duty.id));
}

function pagePharmacies(descriptor: PageDescriptor): Pharmacy[] {
  if (descriptor.kind === 'hub') return BORDER_PHARMACIES;
  if (descriptor.kind === 'canton') return TICINO_PHARMACIES;
  if (descriptor.kind === 'country') return ITALY_BORDER_PHARMACIES;
  if (descriptor.kind === 'area') return pharmaciesForProvince(ITALY_BORDER_PROVINCES.find((area) => area.slug === descriptor.areaSlug)?.code || '');
  if (descriptor.kind === 'city') {
    return descriptor.country === 'IT'
      ? ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === ITALY_BORDER_PROVINCES.find((area) => area.slug === descriptor.areaSlug)?.code && pharmacy.city === descriptor.cityName)
      : pharmaciesForCity(descriptor.cityName || '');
  }
  if (descriptor.kind === 'duty-hub') {
    return [...new Set(publicDutyRows().map((duty) => duty.pharmacyId))]
      .map((id) => pharmacyById(id))
      .filter((pharmacy): pharmacy is Pharmacy => Boolean(pharmacy));
  }
  if (descriptor.kind === 'duty-city') {
    const ids = new Set(TICINO_PHARMACIES.filter((pharmacy) => pharmacy.city === descriptor.cityName).map((pharmacy) => pharmacy.id));
    return publicDutyRows().filter((duty) => ids.has(duty.pharmacyId)).map((duty) => pharmacyById(duty.pharmacyId)).filter((pharmacy): pharmacy is Pharmacy => Boolean(pharmacy));
  }
  return [];
}

function renderBody(descriptor: PageDescriptor, locale: Locale): string {
  const copy = COPY[locale];
  const title = pageTitle(descriptor.kind, locale, descriptor);
  let sections = '';
  if (descriptor.kind === 'hub') {
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2><p style="${BODY_STYLE}">${href({ kind: 'canton', locale }, copy.ticinoTitle)} · ${href({ kind: 'country', country: 'IT', locale }, copy.italyTitle)} · ${href({ kind: 'duty-hub', locale }, copy.duties)}</p><p style="${BODY_STYLE}">${ITALY_BORDER_PROVINCES.map((area) => href({ kind: 'area', country: 'IT', areaSlug: area.slug, locale }, area.name)).join(' · ')}</p><p style="${BODY_STYLE}">${esc(copy.locarneseNote)}</p></section>`;
  } else if (descriptor.kind === 'duty-hub') {
    const regions = [...new Set(dutiesDataset.duties.map((duty) => duty.coverageName))];
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.duties)}</h2><div class="s-XENO3U">${regions.map((region) => renderDuty(publicDutiesForRegion(dutiesDataset, region, new Date())[0], locale)).join('')}</div><p style="${BODY_STYLE}">${esc(copy.locarneseNote)}</p></section>`;
  } else if (descriptor.kind === 'duty-city') {
    const region = TICINO_PHARMACIES.find((pharmacy) => pharmacy.city === descriptor.cityName && dutiesDataset.duties.some((duty) => duty.pharmacyId === pharmacy.id))?.id;
    const coverage = region ? dutiesDataset.duties.find((duty) => duty.pharmacyId === region)?.coverageName : undefined;
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.duties)}</h2>${esc(copy.dutyCityLede)}${coverage ? `<div class="s-XENO3U">${publicDutiesForRegion(dutiesDataset, coverage, new Date()).map((duty) => renderDuty(duty, locale)).join('')}</div>` : `<p style="${BODY_STYLE}">${esc(copy.noDuty)}</p>`}</section>`;
  } else if (descriptor.kind === 'pharmacy') {
    const pharmacy = descriptor.pharmacy!;
    const website = safePharmacyUrl(pharmacy.website);
    const maps = pharmacy.latitude !== undefined && pharmacy.longitude !== undefined ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(String(pharmacy.latitude))}&mlon=${encodeURIComponent(String(pharmacy.longitude))}#map=18/${encodeURIComponent(String(pharmacy.latitude))}/${encodeURIComponent(String(pharmacy.longitude))}` : undefined;
    const parent = pharmacy.country === 'IT' ? cityPath('IT', locale, pharmacyCitySlug(pharmacy.city), ITALY_BORDER_PROVINCES.find((area) => area.code === pharmacy.province)?.slug) : cityPath('CH', locale, pharmacyCitySlug(pharmacy.city));
    sections = `<p style="${BODY_STYLE}">${href(parent, `${copy.directoryHeading}: ${pharmacy.city}`)}</p><section><h2 style="${H2_STYLE}">${esc(copy.contactHeading)}</h2><p style="${BODY_STYLE}"><strong>${esc(copy.address)}:</strong> ${esc(pharmacy.address)}, ${esc(pharmacy.postalCode)} ${esc(pharmacy.city)}</p>${pharmacy.phone ? `<p style="${BODY_STYLE}"><strong>${esc(copy.phone)}:</strong> <a href="tel:${esc(pharmacy.phone)}">${esc(pharmacy.phone)}</a></p>` : ''}${website ? `<p style="${BODY_STYLE}"><strong>${esc(copy.website)}:</strong> <a href="${esc(website)}" rel="nofollow noopener">${esc(website)}</a></p>` : ''}${maps ? `<p style="${BODY_STYLE}"><strong>${esc(copy.map)}:</strong> <a href="${esc(maps)}" rel="nofollow noopener">${esc(copy.openMap)}</a></p>` : ''}</section><section><h2 style="${H2_STYLE}">${esc(copy.hoursHeading)}</h2>${renderHours(pharmacy, locale)}</section><section><h2 style="${H2_STYLE}">${esc(copy.servicesHeading)}</h2>${renderServices(pharmacy, locale)}</section><section><h2 style="${H2_STYLE}">${esc(copy.sourcesHeading)}</h2>${sourceLine(pharmacy, locale)}<p style="${BODY_STYLE}">${esc(copy.osmNote)}</p></section>`;
  } else {
    const pharmacies = pagePharmacies(descriptor);
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2><div class="s-XENO3U">${pharmacies.map((pharmacy) => renderPharmacyCard(pharmacy, locale)).join('')}</div>${descriptor.kind === 'city' && descriptor.country === 'CH' ? `<p style="${BODY_STYLE}">${href({ kind: 'duty-city', locale, citySlug: descriptor.citySlug }, copy.viewDuties)}</p>` : ''}</section>`;
  }
  return `<header><h1 style="${H1_STYLE}">${esc(title)}</h1><p style="${LEDE_STYLE}">${esc(pageLede(descriptor.kind, locale))}</p></header>${sections}<section><h2 style="${H2_STYLE}">${esc(copy.disclaimerHeading)}</h2><p style="${BODY_STYLE}">${esc(copy.disclaimer)}</p></section>`;
}

function breadcrumbJsonLd(descriptor: PageDescriptor, locale: Locale): string {
  const items: Array<{ name: string; path: PharmacyPath }> = [{ name: COPY[locale].directoryHeading, path: { kind: 'hub', locale } }];
  if (descriptor.kind === 'pharmacy' && descriptor.pharmacy) {
    const pharmacy = descriptor.pharmacy;
    if (pharmacy.country === 'IT') {
      const area = ITALY_BORDER_PROVINCES.find((candidate) => candidate.code === pharmacy.province);
      items.push({ name: COPY[locale].italyTitle, path: { kind: 'country', country: 'IT', locale } });
      if (area) items.push({ name: area.name, path: { kind: 'area', country: 'IT', areaSlug: area.slug, locale } });
      items.push({ name: pharmacy.city, path: cityPath('IT', locale, pharmacyCitySlug(pharmacy.city), area?.slug) });
    } else {
      items.push({ name: COPY[locale].ticinoTitle, path: { kind: 'canton', locale } });
      items.push({ name: pharmacy.city, path: cityPath('CH', locale, pharmacyCitySlug(pharmacy.city)) });
    }
    items.push({ name: pharmacy.name, path: descriptorPath(descriptor, locale) });
  } else {
    if (descriptor.kind === 'canton' || descriptor.country === 'CH') items.push({ name: COPY[locale].ticinoTitle, path: { kind: 'canton', locale } });
    if (descriptor.kind === 'country' || descriptor.country === 'IT') items.push({ name: COPY[locale].italyTitle, path: { kind: 'country', country: 'IT', locale } });
    if (descriptor.kind === 'area') items.push({ name: descriptor.areaName || descriptor.areaSlug || '', path: descriptorPath(descriptor, locale) });
    if (descriptor.kind === 'city' && descriptor.country === 'IT') {
      const area = ITALY_BORDER_PROVINCES.find((candidate) => candidate.slug === descriptor.areaSlug);
      if (area) items.push({ name: area.name, path: { kind: 'area', country: 'IT', areaSlug: area.slug, locale } });
    }
    if (descriptor.kind === 'city' || descriptor.kind === 'duty-city') items.push({ name: descriptor.cityName || '', path: descriptorPath(descriptor, locale) });
    if (descriptor.kind === 'duty-hub') items.push({ name: COPY[locale].duties, path: descriptorPath(descriptor, locale) });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: `${BASE_URL}${buildPharmacyPath(item.path, locale)}` })) });
}

function jsonLd(descriptor: PageDescriptor, locale: Locale): string[] {
  const pathValue = descriptorPath(descriptor, locale);
  const title = pageTitle(descriptor.kind, locale, descriptor);
  if (descriptor.kind === 'pharmacy') return [detailJsonLd(descriptor.pharmacy!, locale), breadcrumbJsonLd(descriptor, locale)];
  if (descriptor.kind === 'duty-city') return [breadcrumbJsonLd(descriptor, locale)];
  return [collectionJsonLd(pathValue, title, pagePharmacies(descriptor)), breadcrumbJsonLd(descriptor, locale)];
}

function hreflang(descriptor: PageDescriptor): string {
  return [...LOCALES.map((locale) => `<link rel="alternate" hreflang="${locale}" href="${esc(`${BASE_URL}${buildPharmacyPath(descriptorPath(descriptor, locale), locale)}`)}" />`), `<link rel="alternate" hreflang="x-default" href="${esc(`${BASE_URL}${buildPharmacyPath(descriptorPath(descriptor, 'it'), 'it')}`)}" />`].join('\n');
}

function descriptors(): PageDescriptor[] {
  return [
    { kind: 'hub' },
    { kind: 'canton', country: 'CH' },
    { kind: 'duty-hub' },
    { kind: 'country', country: 'IT' },
    ...ITALY_BORDER_PROVINCES.map((area) => ({ kind: 'area' as const, country: 'IT' as const, areaSlug: area.slug, areaName: area.name })),
    ...TICINO_CITIES.map((city) => ({ kind: 'city' as const, country: 'CH' as const, citySlug: city.slug, cityName: city.name })),
    ...TICINO_CITIES.map((city) => ({ kind: 'duty-city' as const, country: 'CH' as const, citySlug: city.slug, cityName: city.name })),
    ...ITALY_CITIES.map((city) => ({ kind: 'city' as const, country: 'IT' as const, areaSlug: ITALY_BORDER_PROVINCES.find((area) => area.code === city.province)?.slug, citySlug: city.slug, cityName: city.name })),
    ...BORDER_PHARMACIES.map((pharmacy) => ({ kind: 'pharmacy' as const, country: pharmacy.country, pharmacy })),
  ];
}

function buildPage(descriptor: PageDescriptor, locale: Locale, distDir: string) {
  const body = renderBody(descriptor, locale);
  const wordCount = countHtmlBodyWords(body);
  // City duty URLs are useful navigation aliases, but their body repeats the
  // regional OFCT schedule. Keep them crawlable for users without creating
  // duplicate indexable pages or an ItemList with a different visible scope.
  const indexable = descriptor.kind !== 'duty-city' && wordCount >= MIN_INDEXABLE_WORDS;
  const pathValue = descriptorPath(descriptor, locale);
  const title = pageTitle(descriptor.kind, locale, descriptor);
  const description = pageDescription(descriptor, locale);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable })}`;
  return {
    path: buildPharmacyPath(pathValue, locale),
    wordCount,
    indexable,
    html: buildSeoPageHtml({ locale, title: shellTitle(descriptor, locale), description, canonicalUrl: `${BASE_URL}${buildPharmacyPath(pathValue, locale)}`, hreflangHtml: hreflang(descriptor), robots: indexable ? 'index,follow' : 'noindex,follow', jsonLdScripts: jsonLd(descriptor, locale), bodyHtml, seoContentOutsideRoot: true, seoMainClass: 'seo-static-content', distDir }),
  };
}

export function pharmacyDirectoryPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'pharmacy-directory-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const collector = new WriteCollector({ distDir, pluginName: 'pharmacyDirectoryPagesPlugin' });
      const urls: string[] = [];
      const allDescriptors = descriptors();
      let excludedNoindexRoutes = 0;
      for (const locale of LOCALES) {
        for (const descriptor of allDescriptors) {
          const built = buildPage(descriptor, locale, distDir);
          collector.add(path.join(distDir, `${built.path.replace(/^\/+/, '').replace(/\/+$/, '')}/index.html`), built.html);
          // The IT/main shard owns the shared sitemap and must list every
          // locale URL, even though its collector writes only its own pages.
          if (built.indexable) urls.push(built.path);
          else excludedNoindexRoutes += 1;
        }
      }
      const dateStamp = BUILD_DATE_STAMP;
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${BASE_URL}${url}</loc><lastmod>${dateStamp}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>\n`).join('')}</urlset>\n`;
      const written = await collector.flush();
      if (shouldEmitLocale('it')) fs.writeFileSync(path.join(distDir, 'sitemap-farmacie.xml'), sitemap, 'utf8');
      const master = path.join(distDir, 'sitemap.xml');
      if (fs.existsSync(master)) {
        let xml = fs.readFileSync(master, 'utf8');
        if (!xml.includes('sitemap-farmacie.xml')) xml = xml.replace('</sitemapindex>', `  <sitemap><loc>${BASE_URL}/sitemap-farmacie.xml</loc><lastmod>${dateStamp}</lastmod></sitemap>\n</sitemapindex>`);
        fs.writeFileSync(master, xml, 'utf8');
      }
      console.log(`\x1b[36m[pharmacy-directory-pages]\x1b[0m Emitted ${written} pages and ${urls.length} sitemap URLs (${excludedNoindexRoutes} noindex routes excluded from sitemap)`);
    },
  };
}

export { buildPage as buildPharmacyDirectoryPage, descriptors as pharmacyPageDescriptors };
