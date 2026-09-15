import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, BUILD_DATE_STAMP, MIN_INDEXABLE_WORDS, SPA_ACTION_REDIRECT_SCRIPT, buildCanonicalBridgePage, countHtmlBodyWords } from './constants';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { differentiateH1FromTitle, esc, H1_STYLE, H2_STYLE, H3_STYLE, LEDE_STYLE, BODY_STYLE, CARD_CLASS } from './shared/seoContentTokens';
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
import { buildDutyWeekModel, currentDutyWeekStart, DUTY_WEEK_SOURCE_URL, formatDutyDateTime, type DutyWeekModel } from '../services/pharmacies/dutyWeek';
import { currentDutyForRegion } from '../services/pharmacies/duties';
import type { Locale } from '../services/i18n';
import { safePharmacyUrl, type Pharmacy, type PharmacyCatalogueDataset, type PharmacyDuty, type PharmacyDutiesDataset, type PharmacyFieldSource, type PharmacyUrlAlias } from '../services/pharmacies/types';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import completeTicinoJson from '../data/pharmacies-ticino-complete.json';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { buildPharmacyTitle } from '../services/pharmacies/title';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];
const dutiesDataset = dutiesJson as PharmacyDutiesDataset;
const completeTicinoSnapshot = completeTicinoJson as unknown as PharmacyCatalogueDataset;
const dutySource = 'https://www.ofct.ch/farmacieturno/';
const osmLicense = 'OpenStreetMap contributors, ODbL 1.0';

type DutyWeekCopy = {
  title: (weekStart: string) => string;
  lede: string;
  coverage: string;
  unavailable: string;
  source: string;
  fetched: string;
  interval: string;
  date: string;
  hours: string;
  pharmacy: string;
  verify: string;
};

const DUTY_WEEK_COPY: Record<Locale, DutyWeekCopy> = {
  it: {
    title: (weekStart) => `Farmacie di turno in Ticino: settimana del ${weekStart}`,
    lede: 'Calendario settimanale delle aree ticinesi con intervalli verificati. Non è una copertura di tutti i cantoni né delle farmacie italiane di confine.',
    coverage: 'Questa edizione copre cinque regioni ticinesi: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese.',
    unavailable: 'Questa settimana non supera il controllo di pubblicazione: il contenuto resta visibile per trasparenza ma non è una fonte valida per un turno attivo.',
    source: 'Fonte verificata',
    fetched: 'Ultimo recupero',
    interval: 'Intervallo',
    date: 'Data',
    hours: 'Orario',
    pharmacy: 'Farmacia',
    verify: 'Turni e orari possono cambiare. Chiama sempre la farmacia o controlla la fonte ufficiale prima di partire, soprattutto in caso di urgenza.',
  },
  en: {
    title: (weekStart) => `On-duty pharmacies in Ticino: week of ${weekStart}`,
    lede: 'Weekly schedule for Ticino areas with verified intervals only. This is not coverage for every Swiss canton or for Italian border pharmacies.',
    coverage: 'This edition covers five Ticino regions: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese.',
    unavailable: 'This week did not pass the publication check: it remains visible for transparency but is not a valid source for an active duty.',
    source: 'Verified source',
    fetched: 'Last retrieved',
    interval: 'Interval',
    date: 'Date',
    hours: 'Hours',
    pharmacy: 'Pharmacy',
    verify: 'Duties and opening hours can change. Always call the pharmacy or check the official source before travelling, especially in an emergency.',
  },
  de: {
    title: (weekStart) => `Notdienst-Apotheken im Tessin: Woche ab ${weekStart}`,
    lede: 'Wochenplan nur für Tessiner Gebiete mit verifizierten Zeiträumen. Dies ist keine Abdeckung aller Schweizer Kantone oder der italienischen Grenzapotheken.',
    coverage: 'Diese Ausgabe deckt fünf Tessiner Regionen ab: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese.',
    unavailable: 'Diese Woche hat die Veröffentlichungskontrolle nicht bestanden: Sie bleibt aus Transparenzgründen sichtbar, ist aber keine gültige Quelle für einen aktiven Notdienst.',
    source: 'Verifizierte Quelle',
    fetched: 'Letzter Abruf',
    interval: 'Zeitraum',
    date: 'Datum',
    hours: 'Uhrzeit',
    pharmacy: 'Apotheke',
    verify: 'Notdienste und Öffnungszeiten können sich ändern. Vor der Fahrt immer telefonisch oder bei der offiziellen Quelle prüfen, besonders im Notfall.',
  },
  fr: {
    title: (weekStart) => `Pharmacies de garde au Tessin : semaine du ${weekStart}`,
    lede: 'Planning hebdomadaire limité aux zones tessinoises dont les intervalles sont vérifiés. Il ne couvre pas tous les cantons suisses ni les pharmacies italiennes de la frontière.',
    coverage: 'Cette édition couvre cinq régions tessinoises : Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli et Locarnese.',
    unavailable: 'Cette semaine n’a pas passé le contrôle de publication : elle reste visible par transparence mais ne constitue pas une source valide pour une garde active.',
    source: 'Source vérifiée',
    fetched: 'Dernière collecte',
    interval: 'Intervalle',
    date: 'Date',
    hours: 'Horaires',
    pharmacy: 'Pharmacie',
    verify: 'Les gardes et les horaires peuvent changer. Appelez toujours la pharmacie ou consultez la source officielle avant de partir, surtout en cas d’urgence.',
  },
};

type Copy = {
  hubTitle: string;
  ticinoTitle: string;
  italyTitle: string;
  italyAreaTitle: (area: string) => string;
  countryDirectoryNote: string;
  provinceCount: (count: number) => string;
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
    hubTitle: 'Farmacie in Ticino e al confine italiano: elenco e fonti', ticinoTitle: 'Farmacie in Ticino', italyTitle: 'Farmacie italiane al confine con il Ticino', italyAreaTitle: (area) => `Farmacie in provincia di ${area}`, countryDirectoryNote: 'Gli hub di provincia portano alle schede complete organizzate per località, con indirizzo, contatti, fonte e ultimo recupero quando pubblicati. Il conteggio indica le sedi presenti nel dataset corrente: non è una stima delle farmacie aperte né dei turni attivi. Per orari e disponibilità verifica sempre la fonte indicata. Le pagine provinciali permettono di filtrare l’elenco per località e aprire ogni scheda completa. Ogni scheda mantiene il collegamento alla fonte e, quando disponibile, alla data del recupero.', provinceCount: (count) => `${count} farmacie censite`, cityTitle: (city, country) => country === 'CH' ? `Farmacie a ${city}, Ticino` : `Farmacie a ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'Farmacie di turno in Ticino', dutyCityTitle: (city) => `Farmacia di turno: informazioni per ${city}`,
    hubLede: 'Elenco verificato delle farmacie del Ticino e delle province italiane di Como, Varese e Verbano-Cusio-Ossola. Ogni scheda distingue anagrafica, orari, servizi, fonte e data dell’ultimo recupero.', ticinoLede: 'Anagrafica ufficiale delle farmacie aperte al pubblico in Ticino, integrata con l’elenco cantonale e con dati cartografici OSM quando la corrispondenza è certa.', italyLede: 'Anagrafica del Ministero della Salute italiano filtrata per le province di Como, Varese e Verbano-Cusio-Ossola. La presenza nell’elenco non significa apertura in questo momento.', areaLede: 'Sedi censite dal dataset ufficiale italiano per questa provincia. Orari, telefono e servizi sono mostrati solo quando una fonte secondaria tracciata li pubblica.', cityLede: 'Sedi censite nella località selezionata, con collegamento alla scheda individuale e alla fonte del dato. L’elenco riflette il dataset disponibile e non deduce aperture, turni o servizi non pubblicati. Ogni scheda collega la fonte e indica l’ultimo controllo quando disponibile; nomi, indirizzi e disponibilità possono cambiare tra un aggiornamento e l’altro. Per un’informazione urgente verifica la fonte e contatta direttamente la sede.', detailLede: 'Scheda della sede con indirizzo, contatti, coordinate, orari e servizi disponibili nella fonte indicata. Verifica sempre prima di partire. I campi mancanti restano indicati come non disponibili e non vengono stimati. La data di recupero aiuta a valutare l’attualità del dato.', dutyHubLede: 'Turni regionali pubblicati dall’Ordine dei Farmacisti del Cantone Ticino. Un turno regionale non implica apertura continua né sostituisce una conferma telefonica. Il dataset mostra soltanto intervalli pubblicati e non costruisce un calendario per sede. Le date sono quelle della fonte: controlla sempre prima di partire, perché la situazione può cambiare dopo l’ultimo recupero.', dutyCityLede: 'La città è collegata alla relativa area regionale di turno. La copertura non è una promessa di servizio per ogni comune: verifica farmacia e intervallo direttamente.', directoryHeading: 'Elenco farmacie', contactHeading: 'Contatti e posizione', hoursHeading: 'Orari pubblicati', servicesHeading: 'Servizi pubblicati', sourcesHeading: 'Fonti e aggiornamento', source: 'Fonte', checked: 'Recuperato il', address: 'Indirizzo', phone: 'Telefono', website: 'Sito web', hoursUnavailable: 'La fonte primaria non pubblica orari verificabili per questa sede.', servicesUnavailable: 'La fonte primaria non pubblica servizi verificabili per questa sede.', sourceOfficial: 'Fonte ufficiale', sourceOsm: 'Dati cartografici OpenStreetMap', sourceLink: 'Apri fonte', map: 'Posizione', openMap: 'Apri mappa OpenStreetMap', detail: 'Apri scheda completa', viewDuties: 'Vedi turni regionali', duties: 'Turni regionali', coverage: 'Area', interval: 'Intervallo', noDuty: 'Nessun turno verificato per questa città o area nel dataset corrente.', disclaimerHeading: 'Verifica prima di partire', disclaimer: 'Verifica sempre telefonicamente con la farmacia prima di recarti sul posto: orari e turni possono cambiare. I dati OSM sono contributi della comunità e vanno verificati.', osmNote: 'Orari, contatti o servizi derivati da OpenStreetMap sono indicati con la loro fonte e licenza ODbL; non rappresentano un turno ufficiale.', locarneseNote: 'I turni verificati del Locarnese sono inclusi quando la tabella dell’associazione e il catalogo cantonale trovano una corrispondenza univoca.',
  },
  en: {
    hubTitle: 'Pharmacies in Ticino and across the Italian border: directory and sources', ticinoTitle: 'Pharmacies in Ticino', italyTitle: 'Italian pharmacies near the Ticino border', italyAreaTitle: (area) => `Pharmacies in ${area} province`, countryDirectoryNote: 'Each province hub leads to full location pages with address, contacts, source and latest retrieval when published. The count describes locations in the current dataset: it is not an estimate of pharmacies open now or of active duty schedules. Check the cited source for hours and availability. Province pages let you browse the directory by locality and open each full record. Each record keeps its source link and, when available, its retrieval date.', provinceCount: (count) => `${count} listed pharmacies`, cityTitle: (city, country) => country === 'CH' ? `Pharmacies in ${city}, Ticino` : `Pharmacies in ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'On-duty pharmacies in Ticino', dutyCityTitle: (city) => `On-duty pharmacy information for ${city}`,
    hubLede: 'Verified directory of pharmacies in Ticino and the Italian provinces of Como, Varese and Verbano-Cusio-Ossola. Each page distinguishes identity, hours, services, source and retrieval date.', ticinoLede: 'Official public-pharmacy directory for Ticino, completed with the cantonal list and OSM map data when the match is unambiguous.', italyLede: 'Italian Ministry of Health directory filtered to Como, Varese and Verbano-Cusio-Ossola. Being listed does not mean being open now.', areaLede: 'Locations listed by the official Italian dataset for this province. Hours, phone and services appear only when a traceable secondary source publishes them.', cityLede: 'Locations listed for the selected locality, with a link to each individual page and its data source. This page reflects the available dataset and does not infer opening, duty or service information that a source does not publish. Each entry links its source and shows the latest check when available; names, addresses and availability can change between updates. For urgent information, check the source and contact the location directly.', detailLede: 'Location page with address, contacts, coordinates, hours and services available from the cited source. Check before travelling. Missing fields remain marked as unavailable rather than being estimated. Use the retrieval date to judge how current the information is.', dutyHubLede: 'Regional duty schedules published by the Ticino Pharmacists’ Association. A regional duty does not imply continuous opening and does not replace a phone confirmation. The dataset shows published intervals only and does not construct a schedule for each location. Dates come from the cited source: check before travelling because circumstances can change after the latest retrieval.', dutyCityLede: 'The city is linked to its regional duty area. Coverage is not a promise of service in every municipality: confirm the pharmacy and interval directly.', directoryHeading: 'Pharmacy directory', contactHeading: 'Contact and location', hoursHeading: 'Published hours', servicesHeading: 'Published services', sourcesHeading: 'Sources and update', source: 'Source', checked: 'Retrieved on', address: 'Address', phone: 'Phone', website: 'Website', hoursUnavailable: 'The primary source does not publish verifiable hours for this location.', servicesUnavailable: 'The primary source does not publish verifiable services for this location.', sourceOfficial: 'Official source', sourceOsm: 'OpenStreetMap map data', sourceLink: 'Open source', map: 'Location', openMap: 'Open OpenStreetMap', detail: 'Open full page', viewDuties: 'View regional duties', duties: 'Regional duties', coverage: 'Area', interval: 'Interval', noDuty: 'No verified interval is available for this area in the current dataset.', disclaimerHeading: 'Check before travelling', disclaimer: 'Hours and duties can change. Call the pharmacy or check the cited source, especially in an emergency. OSM data is community-contributed and must be checked.', osmNote: 'Hours, contacts or services derived from OpenStreetMap show their source and ODbL licence; they are not an official duty schedule.', locarneseNote: 'Verified Locarnese duties are included when the association table and cantonal catalogue resolve to one identity.',
  },
  de: {
    hubTitle: 'Apotheken im Tessin und an der italienischen Grenze: Verzeichnis und Quellen', ticinoTitle: 'Apotheken im Tessin', italyTitle: 'Italienische Apotheken an der Tessiner Grenze', italyAreaTitle: (area) => `Apotheken in der Provinz ${area}`, countryDirectoryNote: 'Jeder Provinzhub führt zu vollständigen Standortseiten mit Adresse, Kontakt, Quelle und letztem Abruf, sofern veröffentlicht. Die Zahl beschreibt Standorte im aktuellen Datensatz: Sie ist keine Schätzung der jetzt geöffneten Apotheken oder aktiver Notdienste. Öffnungszeiten und Verfügbarkeit bitte bei der Quelle prüfen. Die Provinzseiten ordnen das Verzeichnis nach Ort und öffnen jede vollständige Karte. Jede Karte enthält den Quellenlink und, sofern vorhanden, das Abrufdatum.', provinceCount: (count) => `${count} gelistete Apotheken`, cityTitle: (city, country) => country === 'CH' ? `Apotheken in ${city}, Tessin` : `Apotheken in ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'Notdienst-Apotheken im Tessin', dutyCityTitle: (city) => `Informationen zum Apotheken-Notdienst in ${city}`,
    hubLede: 'Verifiziertes Verzeichnis für Apotheken im Tessin sowie in den italienischen Provinzen Como, Varese und Verbano-Cusio-Ossola. Jede Seite trennt Identität, Zeiten, Leistungen, Quelle und Abrufdatum.', ticinoLede: 'Offizielles Verzeichnis der öffentlichen Apotheken im Tessin, ergänzt durch die kantonale Liste und OSM-Kartendaten bei eindeutiger Zuordnung.', italyLede: 'Verzeichnis des italienischen Gesundheitsministeriums, gefiltert nach Como, Varese und Verbano-Cusio-Ossola. Ein Eintrag bedeutet nicht, dass die Apotheke jetzt geöffnet ist.', areaLede: 'Standorte des offiziellen italienischen Datensatzes für diese Provinz. Zeiten, Telefon und Leistungen werden nur mit nachvollziehbarer Zweitquelle gezeigt.', cityLede: 'Standorte der ausgewählten Ortschaft mit Link zur Einzelseite und Datenquelle. Diese Seite bildet den verfügbaren Datensatz ab und leitet keine Öffnungszeiten, Notdienste oder Leistungen ab, die eine Quelle nicht veröffentlicht. Jede Karte verknüpft ihre Quelle und nennt den letzten Abruf, wenn verfügbar; Namen, Adressen und Verfügbarkeit können sich zwischen Aktualisierungen ändern. Bei dringenden Informationen bitte die Quelle prüfen und den Standort direkt kontaktieren.', detailLede: 'Einzelseite mit Adresse, Kontakt, Koordinaten, Öffnungszeiten und Leistungen aus der angegebenen Quelle. Vor der Fahrt prüfen. Fehlende Felder bleiben als nicht verfügbar gekennzeichnet und werden nicht geschätzt. Das Abrufdatum hilft bei der Bewertung der Aktualität.', dutyHubLede: 'Regionale Notdienstpläne des Tessiner Apothekerverbands. Ein regionaler Notdienst bedeutet keine durchgehende Öffnung und ersetzt keine telefonische Bestätigung. Der Datensatz zeigt nur veröffentlichte Zeiträume und erstellt keinen Kalender für jeden Standort. Die Daten stammen aus der angegebenen Quelle: Vor der Fahrt prüfen, da sich die Lage nach dem letzten Abruf ändern kann.', dutyCityLede: 'Die Stadt wird dem regionalen Notdienstgebiet zugeordnet. Das Gebiet ist keine Zusage für jede Gemeinde: Apotheke und Zeitraum direkt bestätigen.', directoryHeading: 'Apothekenverzeichnis', contactHeading: 'Kontakt und Standort', hoursHeading: 'Veröffentlichte Öffnungszeiten', servicesHeading: 'Veröffentlichte Leistungen', sourcesHeading: 'Quellen und Aktualisierung', source: 'Quelle', checked: 'Abgerufen am', address: 'Adresse', phone: 'Telefon', website: 'Website', hoursUnavailable: 'Die Primärquelle veröffentlicht für diesen Standort keine überprüfbaren Öffnungszeiten.', servicesUnavailable: 'Die Primärquelle veröffentlicht für diesen Standort keine überprüfbaren Leistungen.', sourceOfficial: 'Offizielle Quelle', sourceOsm: 'OpenStreetMap-Kartendaten', sourceLink: 'Quelle öffnen', map: 'Standort', openMap: 'OpenStreetMap öffnen', detail: 'Vollständige Seite öffnen', viewDuties: 'Regionale Notdienste', duties: 'Regionale Notdienste', coverage: 'Gebiet', interval: 'Zeitraum', noDuty: 'Für dieses Gebiet ist im aktuellen Datensatz kein verifizierter Zeitraum verfügbar.', disclaimerHeading: 'Vor der Fahrt prüfen', disclaimer: 'Öffnungszeiten und Notdienste können sich ändern. Besonders im Notfall telefonisch oder bei der Quelle prüfen. OSM-Daten stammen aus der Community und müssen geprüft werden.', osmNote: 'Aus OpenStreetMap abgeleitete Zeiten, Kontakte oder Leistungen nennen Quelle und ODbL-Lizenz; sie sind kein offizieller Notdienstplan.', locarneseNote: 'Verifizierte Locarnese-Notdienste erscheinen, wenn die Tabelle des Verbands und das kantonale Verzeichnis genau eine Identität ergeben.',
  },
  fr: {
    hubTitle: 'Pharmacies au Tessin et à la frontière italienne : répertoire et sources', ticinoTitle: 'Pharmacies au Tessin', italyTitle: 'Pharmacies italiennes près de la frontière du Tessin', italyAreaTitle: (area) => `Pharmacies dans la province de ${area}`, countryDirectoryNote: 'Chaque hub provincial mène aux fiches complètes des sites avec adresse, contacts, source et dernière collecte lorsqu’ils sont publiés. Le nombre indique les sites du jeu actuel : ce n’est pas une estimation des pharmacies ouvertes ni des gardes actives. Vérifiez les horaires et la disponibilité dans la source citée. Les pages provinciales classent le répertoire par localité et ouvrent chaque fiche complète. Chaque fiche conserve son lien source et, lorsqu’elle est disponible, sa date de collecte.', provinceCount: (count) => `${count} pharmacies recensées`, cityTitle: (city, country) => country === 'CH' ? `Pharmacies à ${city}, Tessin` : `Pharmacies à ${city}`, pharmacyTitle: (pharmacy) => `${pharmacy.name} — ${pharmacy.city}`, dutyHubTitle: 'Pharmacies de garde au Tessin', dutyCityTitle: (city) => `Informations de garde pour ${city}`,
    hubLede: 'Répertoire vérifié des pharmacies du Tessin et des provinces italiennes de Côme, Varèse et Verbano-Cusio-Ossola. Chaque page distingue identité, horaires, services, source et date de collecte.', ticinoLede: 'Répertoire officiel des pharmacies ouvertes au public au Tessin, complété par la liste cantonale et les données cartographiques OSM lorsque la correspondance est certaine.', italyLede: 'Répertoire du ministère italien de la Santé filtré sur Côme, Varèse et Verbano-Cusio-Ossola. Être listé ne signifie pas être ouvert maintenant.', areaLede: 'Sites recensés par le jeu officiel italien pour cette province. Horaires, téléphone et services apparaissent uniquement avec une source secondaire traçable.', cityLede: 'Sites recensés dans la localité sélectionnée, avec un lien vers chaque fiche et sa source. Cette page reflète le jeu de données disponible et ne déduit pas les ouvertures, gardes ou services qu’une source ne publie pas. Chaque fiche indique sa source et le dernier contrôle lorsqu’il est disponible; noms, adresses et disponibilité peuvent changer entre deux mises à jour. Pour une information urgente, vérifiez la source et contactez directement le site.', detailLede: 'Fiche avec adresse, contacts, coordonnées, horaires et services disponibles dans la source citée. Vérifiez avant de partir. Les champs manquants restent signalés comme indisponibles et ne sont pas estimés. La date de collecte aide à évaluer l’actualité de l’information.', dutyHubLede: 'Gardes régionales publiées par l’association des pharmaciens du Tessin. Une garde régionale ne signifie pas une ouverture continue et ne remplace pas une confirmation téléphonique. Le jeu montre uniquement les intervalles publiés et ne construit pas un calendrier pour chaque site. Les dates viennent de la source citée : vérifiez avant de partir, car la situation peut changer après la dernière collecte.', dutyCityLede: 'La ville est reliée à sa zone régionale de garde. La zone ne garantit pas un service dans chaque commune : confirmez directement la pharmacie et l’intervalle.', directoryHeading: 'Répertoire des pharmacies', contactHeading: 'Contact et localisation', hoursHeading: 'Horaires publiés', servicesHeading: 'Services publiés', sourcesHeading: 'Sources et mise à jour', source: 'Source', checked: 'Collecté le', address: 'Adresse', phone: 'Téléphone', website: 'Site web', hoursUnavailable: 'La source primaire ne publie pas d’horaires vérifiables pour ce site.', servicesUnavailable: 'La source primaire ne publie pas de services vérifiables pour ce site.', sourceOfficial: 'Source officielle', sourceOsm: 'Données cartographiques OpenStreetMap', sourceLink: 'Ouvrir la source', map: 'Localisation', openMap: 'Ouvrir OpenStreetMap', detail: 'Ouvrir la fiche complète', viewDuties: 'Voir les gardes régionales', duties: 'Gardes régionales', coverage: 'Zone', interval: 'Intervalle', noDuty: 'Aucun intervalle vérifié n’est disponible pour cette zone dans le jeu actuel.', disclaimerHeading: 'Vérifiez avant de partir', disclaimer: 'Les horaires et gardes peuvent changer. Appelez la pharmacie ou consultez la source citée, surtout en cas d’urgence. Les données OSM sont communautaires et doivent être vérifiées.', osmNote: 'Les horaires, contacts ou services dérivés d’OpenStreetMap indiquent leur source et la licence ODbL; ils ne constituent pas une garde officielle.', locarneseNote: 'Les gardes vérifiées du Locarnese sont incluses lorsque la table de l’association et le répertoire cantonal résolvent une identité unique.',
  },
};

interface CityFaqItem {
  question: string;
  answer: string;
}

function cityFaqItems(locale: Locale, cityName: string, count: number): CityFaqItem[] {
  if (locale === 'it') {
    return [
      { question: 'Quante farmacie sono censite a ' + cityName + '?', answer: 'Il dataset corrente riporta ' + count + ' ' + (count === 1 ? 'sede' : 'sedi') + ' per ' + cityName + '. Il conteggio descrive le registrazioni pubblicate e può cambiare con il prossimo aggiornamento.' },
      { question: 'Gli orari mostrano se una farmacia è aperta adesso?', answer: 'No. La pagina non deduce l’apertura attuale né un turno dai dati anagrafici. Controlla la fonte della scheda e chiama la sede prima di partire.' },
      { question: 'Come posso verificare una scheda?', answer: 'Apri la scheda della farmacia e usa il collegamento alla fonte e la data dell’ultimo recupero. I campi opzionali sono mostrati solo quando presenti nel dataset; per un’urgenza serve una conferma diretta.' },
    ];
  }
  if (locale === 'en') {
    return [
      { question: 'How many pharmacies are listed in ' + cityName + '?', answer: 'The current dataset lists ' + count + ' ' + (count === 1 ? 'location' : 'locations') + ' in ' + cityName + '. This count describes published records and may change with the next update.' },
      { question: 'Do the hours show whether a pharmacy is open now?', answer: 'No. This page does not infer current opening or duty status from directory records. Check the source on the pharmacy page and call before travelling.' },
      { question: 'How can I verify a pharmacy record?', answer: 'Open the pharmacy page and use its source link and latest retrieval date. Optional fields are shown only when present in the dataset; urgent needs require direct confirmation.' },
    ];
  }
  if (locale === 'de') {
    return [
      { question: 'Wie viele Apotheken sind in ' + cityName + ' gelistet?', answer: 'Der aktuelle Datensatz enthält ' + count + ' ' + (count === 1 ? 'Standort' : 'Standorte') + ' in ' + cityName + '. Die Zahl beschreibt veröffentlichte Einträge und kann sich mit der nächsten Aktualisierung ändern.' },
      { question: 'Zeigen die Öffnungszeiten, ob eine Apotheke jetzt geöffnet ist?', answer: 'Nein. Diese Seite leitet die aktuelle Öffnung oder einen Notdienst nicht aus den Verzeichniseinträgen ab. Bitte Quelle prüfen und vor der Fahrt anrufen.' },
      { question: 'Wie kann ich einen Apothekeneintrag prüfen?', answer: 'Öffne die Apothekenseite und nutze den Quellenlink sowie das Datum des letzten Abrufs. Optionale Felder erscheinen nur, wenn sie im Datensatz vorhanden sind; bei dringenden Anliegen direkt bestätigen.' },
    ];
  }
  return [
    { question: 'Combien de pharmacies sont recensées à ' + cityName + ' ?', answer: 'Le jeu de données actuel recense ' + count + ' ' + (count === 1 ? 'site' : 'sites') + ' à ' + cityName + '. Ce nombre décrit les fiches publiées et peut changer lors de la prochaine mise à jour.' },
    { question: 'Les horaires indiquent-ils si une pharmacie est ouverte maintenant ?', answer: 'Non. Cette page ne déduit pas l’ouverture actuelle ni une garde à partir des données du répertoire. Consultez la source de la fiche et appelez avant de partir.' },
    { question: 'Comment vérifier une fiche de pharmacie ?', answer: 'Ouvrez la fiche et utilisez son lien source ainsi que la date de dernière collecte. Les champs optionnels apparaissent uniquement lorsqu’ils sont présents dans le jeu de données; en cas d’urgence, confirmez directement.' },
  ];
}

function cityFaqHeading(locale: Locale): string {
  return locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Häufige Fragen' : 'Questions fréquentes';
}

function renderCityFaq(locale: Locale, cityName: string, count: number): string {
  const itemsHtml = cityFaqItems(locale, cityName, count)
    .map((item) => '<details style="' + BODY_STYLE + '"><summary>' + esc(item.question) + '</summary><p style="' + BODY_STYLE + '">' + esc(item.answer) + '</p></details>')
    .join('');
  return '<section aria-label="' + esc(cityFaqHeading(locale)) + '"><h2 style="' + H2_STYLE + '">' + esc(cityFaqHeading(locale)) + '</h2>' + itemsHtml + '</section>';
}

// These short explanations keep indexable directory templates substantive
// even when a locality has only one or two verified records. They describe
// the data boundary; they are not filler and never invent pharmacy facts.
const RATIO_QUALITY_COPY: Record<Locale, Partial<Record<PharmacyPageKind, string>>> = {
  it: {
    hub: 'Il catalogo è organizzato per cantone, provincia, località e singola sede: i collegamenti aiutano a verificare ogni dato senza trasformare l’elenco in una promessa di apertura. La scheda non sostituisce una conferma della farmacia e non indica da sola che la sede sia aperta in questo momento.',
    city: 'La navigazione separa le località del Ticino dalle province di confine, così puoi confrontare solo le sedi del perimetro corretto.',
    pharmacy: 'Per mantenere il dato verificabile, valori, orari e servizi vengono mostrati solo quando la fonte li pubblica.',
    'duty-hub': 'Le regioni e gli intervalli restano separati dalle schede anagrafiche, così il lettore può distinguere un turno regionale da una sede specifica.',
  },
  en: {
    hub: 'The catalogue is organised by canton, province, locality and individual location: links help you verify each record without treating the directory as a promise that a pharmacy is open. A page does not replace confirmation from the pharmacy and does not by itself show that the location is open now.',
    city: 'Navigation separates Ticino localities from the neighbouring provinces, so you can compare only locations within the intended geographic scope.',
    pharmacy: 'To keep the record verifiable, values, hours and services are shown only when they are published by the cited source.',
    'duty-hub': 'Regions and intervals stay separate from directory records, so readers can distinguish a regional duty period from an individual location.',
  },
  de: {
    hub: 'Der Katalog ist nach Kanton, Provinz, Ortschaft und Standort gegliedert: Die Links helfen bei der Prüfung jedes Eintrags, ohne eine Öffnung zu versprechen. Eine Seite ersetzt keine Bestätigung durch die Apotheke und zeigt nicht allein, dass der Standort jetzt geöffnet ist.',
    city: 'Die Navigation trennt Tessiner Ortschaften von den Nachbarprovinzen, damit nur Standorte im vorgesehenen geografischen Bereich verglichen werden.',
    pharmacy: 'Für eine nachvollziehbare Karte werden Angaben, Zeiten und Leistungen nur angezeigt, wenn die angegebene Quelle sie veröffentlicht.',
    'duty-hub': 'Regionen und Zeiträume bleiben von den Verzeichniseinträgen getrennt, damit ein regionaler Notdienst von einem einzelnen Standort unterschieden werden kann.',
  },
  fr: {
    hub: 'Le catalogue est organisé par canton, province, localité et site individuel : les liens facilitent la vérification de chaque fiche sans promettre une ouverture. Une page ne remplace pas la confirmation de la pharmacie et ne prouve pas à elle seule que le site est ouvert maintenant.',
    city: 'La navigation sépare les localités du Tessin des provinces voisines, afin de comparer uniquement les sites du périmètre géographique prévu.',
    pharmacy: 'Pour garder une fiche vérifiable, les valeurs, horaires et services sont affichés uniquement lorsque la source citée les publie.',
    'duty-hub': 'Les régions et intervalles restent séparés des fiches du répertoire, afin de distinguer une garde régionale d’un site individuel.',
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

function pharmacyAliasPath(alias: PharmacyUrlAlias, locale: Locale): PharmacyPath | null {
  if (alias.country !== 'IT') return null;
  const areaSlug = ITALY_BORDER_PROVINCES.find((area) => area.code === alias.province)?.slug;
  if (!areaSlug || !alias.city || !alias.slug) return null;
  return { kind: 'pharmacy', locale, country: 'IT', areaSlug, citySlug: pharmacyCitySlug(alias.city), pharmacySlug: alias.slug };
}

export interface PharmacyUrlAliasDescriptor {
  pharmacy: Pharmacy;
  alias: PharmacyUrlAlias;
  locale: Locale;
  from: string;
  to: string;
}

/**
 * Return every old Italian detail URL retained by the importer. The old
 * province/city are part of the alias because a Ministry correction can move
 * a record between localities as well as changing its display name.
 */
export function pharmacyUrlAliasDescriptors(): PharmacyUrlAliasDescriptor[] {
  const canonicalPaths = new Set<string>();
  for (const pharmacy of BORDER_PHARMACIES) {
    for (const locale of LOCALES) canonicalPaths.add(buildPharmacyPath(pharmacyPath(pharmacy, locale), locale));
  }
  const seen = new Map<string, string>();
  const descriptors: PharmacyUrlAliasDescriptor[] = [];
  for (const pharmacy of ITALY_BORDER_PHARMACIES) {
    for (const alias of pharmacy.urlAliases || []) {
      for (const locale of LOCALES) {
        const oldPath = pharmacyAliasPath(alias, locale);
        if (!oldPath) continue;
        const from = buildPharmacyPath(oldPath, locale);
        const to = buildPharmacyPath(pharmacyPath(pharmacy, locale), locale);
        if (from === to || canonicalPaths.has(from)) continue;
        const previousTarget = seen.get(from);
        if (previousTarget && previousTarget !== to) {
          throw new Error(`Conflicting pharmacy URL aliases for ${from}: ${previousTarget} and ${to}`);
        }
        if (previousTarget) continue;
        seen.set(from, to);
        descriptors.push({ pharmacy, alias, locale, from, to });
      }
    }
  }
  return descriptors;
}

const ALIAS_COPY: Record<Locale, { title: string; description: string; body: string; cta: string }> = {
  it: { title: 'Scheda farmacia aggiornata | Frontaliere Ticino', description: 'Questa scheda ha un URL canonico aggiornato.', body: 'La scheda della farmacia è stata aggiornata. Ti portiamo alla pagina canonica.', cta: 'Apri la scheda aggiornata' },
  en: { title: 'Updated pharmacy page | Frontaliere Ticino', description: 'This pharmacy page has an updated canonical URL.', body: 'This pharmacy page was updated. We are taking you to its canonical page.', cta: 'Open the updated page' },
  de: { title: 'Aktualisierte Apothekenseite | Frontaliere Ticino', description: 'Diese Apothekenseite hat eine aktualisierte kanonische URL.', body: 'Diese Apothekenseite wurde aktualisiert. Wir führen Sie zur kanonischen Seite.', cta: 'Aktualisierte Seite öffnen' },
  fr: { title: 'Page pharmacie mise à jour | Frontaliere Ticino', description: 'Cette page pharmacie possède une URL canonique mise à jour.', body: 'Cette page pharmacie a été mise à jour. Nous vous dirigeons vers la page canonique.', cta: 'Ouvrir la page mise à jour' },
};

export function buildPharmacyAliasBridge(descriptor: PharmacyUrlAliasDescriptor): string {
  const copy = ALIAS_COPY[descriptor.locale];
  const targetUrl = `${BASE_URL}${descriptor.to}`;
  return buildCanonicalBridgePage({
    canonicalUrl: targetUrl,
    pathLabel: descriptor.to,
    title: copy.title,
    description: copy.description,
    body: copy.body,
    ctaLabel: copy.cta,
    lang: descriptor.locale,
    noindex: true,
  }).replace('</head>', ` <meta http-equiv="refresh" content="0; url=${targetUrl}">
 </head>`);
}

/**
 * Replace both static forms of a historical detail URL. Vite is configured
 * with `emptyOutDir: false`, so an old canonical page can still be present in
 * dist when the importer turns it into an alias; existence is not evidence
 * that the file should be preserved.
 */
export function emitPharmacyAliasBridge(distDir: string, descriptor: PharmacyUrlAliasDescriptor): void {
  const relativePath = descriptor.from.replace(/^\/+/, '').replace(/\/+$/, '');
  const outDir = path.join(distDir, relativePath);
  const html = buildPharmacyAliasBridge(descriptor);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(distDir, `${relativePath}.html`), html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''), 'utf8');
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

function renderCompactPharmacyListItem(pharmacy: Pharmacy, locale: Locale): string {
  const copy = COPY[locale];
  const detailPath = pharmacyPath(pharmacy, locale);
  const source = '<a href="' + esc(pharmacy.sourceUrl) + '" rel="nofollow noopener">' + esc(copy.sourceLink) + '</a>';
  return '<li><a href="' + esc(buildPharmacyPath(detailPath, locale)) + '">' + esc(pharmacy.name) + '</a> — ' + esc(pharmacy.address) + ', ' + esc(pharmacy.postalCode) + ' ' + esc(pharmacy.city) + ' · ' + source + '</li>';
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

function dutyWeekModel(descriptor: PageDescriptor, dataset: PharmacyDutiesDataset = dutiesDataset, now = new Date()): DutyWeekModel {
  return buildDutyWeekModel(dataset, descriptor.weekStart || '', {
    catalogue: completeTicinoSnapshot,
    now,
  });
}

function dutyWeekDateRange(model: DutyWeekModel, locale: Locale): string {
  if (!model.weekEnd) return model.weekStart;
  const formatter = new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, {
    dateStyle: 'medium',
    timeZone: 'Europe/Zurich',
  });
  const end = new Date(`${model.weekEnd}T00:00:00+01:00`);
  return `${model.weekStart} – ${formatter.format(end)}`;
}

function renderDutyWeek(
  descriptor: PageDescriptor,
  locale: Locale,
  h1 = pageTitle(descriptor.kind, locale, descriptor),
  dataset: PharmacyDutiesDataset = dutiesDataset,
  now = new Date(),
): string {
  const copy = DUTY_WEEK_COPY[locale];
  const model = dutyWeekModel(descriptor, dataset, now);
  const status = model.indexable
    ? `<p style="${LEDE_STYLE}">${esc(copy.coverage)}</p>`
    : `<aside style="${BODY_STYLE}"><strong>${esc(copy.unavailable)}</strong><br>${esc(model.reason)}</aside>`;
  const regions = model.regions.map((region) => {
    const rows = region.duties.length > 0
      ? region.duties.map((duty) => {
        const pharmacy = pharmacyById(duty.pharmacyId);
        const link = pharmacy ? `<a href="${esc(buildPharmacyPath(pharmacyPath(pharmacy, locale), locale))}">${esc(pharmacy.name)}</a>` : esc(duty.pharmacyId);
        const startsAt = formatDutyDateTime(duty.startsAt);
        return `<tr><td>${esc(startsAt.slice(0, 10))}</td><td>${esc(`${startsAt.slice(11)} – ${formatDutyDateTime(duty.endsAt)}`)}</td><td><strong>${link}</strong></td><td><a href="${esc(duty.sourceUrl || DUTY_WEEK_SOURCE_URL)}" rel="nofollow noopener">${esc(copy.source)}</a></td></tr>`;
      }).join('')
      : `<tr><td colspan="4">${esc(copy.unavailable)}</td></tr>`;
    return `<section><h2 style="${H2_STYLE}">${esc(region.name)}</h2><table style="${BODY_STYLE}"><thead><tr><th>${esc(copy.date)}</th><th>${esc(copy.hours)}</th><th>${esc(copy.pharmacy)}</th><th>${esc(copy.source)}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join('');
  const source = model.sourceUrl || DUTY_WEEK_SOURCE_URL;
  const fetched = model.fetchedAt ? formatDate(model.fetchedAt, locale) : copy.unavailable;
  return `<header><h1 style="${H1_STYLE}">${esc(h1)}</h1><p style="${LEDE_STYLE}">${esc(copy.lede)}</p><p style="${BODY_STYLE}"><strong>${esc(copy.interval)}:</strong> ${esc(dutyWeekDateRange(model, locale))}<br><strong>${esc(copy.fetched)}:</strong> ${esc(fetched)}<br><strong>${esc(copy.source)}:</strong> <a href="${esc(source)}" rel="nofollow noopener">${esc(source)}</a></p>${status}</header>${regions}<section><h2 style="${H2_STYLE}">${esc(COPY[locale].disclaimerHeading)}</h2><p style="${BODY_STYLE}">${esc(copy.verify)}</p></section>`;
}

function dutyWeekCollectionJsonLd(pathValue: PharmacyPath, title: string, model: DutyWeekModel): string {
  const duties = model.regions.flatMap((region) => region.duties);
  const itemListElement = duties.slice(0, MAX_COLLECTION_SCHEMA_ITEMS).flatMap((duty, index) => {
    const pharmacy = pharmacyById(duty.pharmacyId);
    if (!pharmacy) return [];
    return [{
      '@type': 'ListItem',
      position: index + 1,
      name: `${pharmacy.name} — ${duty.coverageName}`,
      url: `${BASE_URL}${buildPharmacyPath(pharmacyPath(pharmacy, pathValue.locale), pathValue.locale)}`,
    }];
  });
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(pathValue, pathValue.locale)}`,
    mainEntity: { '@type': 'ItemList', numberOfItems: duties.length, itemListElement },
  });
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

const MAX_COLLECTION_SCHEMA_ITEMS = 10;

function collectionJsonLd(pathValue: PharmacyPath, title: string, pharmacies: Pharmacy[]): string {
  // Keep aggregate structured data useful without serialising hundreds of
  // invisible URLs into every collection page. `numberOfItems` preserves the
  // full collection size and the first ten entries provide a representative
  // ItemList sample.
  const schemaPharmacies = pharmacies.slice(0, MAX_COLLECTION_SCHEMA_ITEMS);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(pathValue, pathValue.locale)}`,
    mainEntity: { '@type': 'ItemList', numberOfItems: pharmacies.length, itemListElement: schemaPharmacies.map((pharmacy, index) => ({ '@type': 'ListItem', position: index + 1, name: pharmacy.name, url: `${BASE_URL}${buildPharmacyPath(pharmacyPath(pharmacy, pathValue.locale), pathValue.locale)}` })) },
  });
}

function countryCollectionJsonLd(pathValue: PharmacyPath, title: string): string {
  const itemListElement = ITALY_BORDER_PROVINCES.map((area, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: area.name,
    url: `${BASE_URL}${buildPharmacyPath({ kind: 'area', country: 'IT', areaSlug: area.slug, locale: pathValue.locale }, pathValue.locale)}`,
  }));
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(pathValue, pathValue.locale)}`,
    mainEntity: { '@type': 'ItemList', numberOfItems: itemListElement.length, itemListElement },
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
  if (kind === 'duty-week') return DUTY_WEEK_COPY[locale].title(descriptor.weekStart || '');
  if (kind === 'pharmacy') return buildPharmacyTitle(descriptor.pharmacy!, BORDER_PHARMACIES);
  return copy.cityTitle(descriptor.cityName || '', descriptor.country || 'CH');
}

function pageLede(kind: PharmacyPageKind, locale: Locale): string {
  const copy = COPY[locale];
  const base = kind === 'hub'
    ? copy.hubLede
    : kind === 'canton'
      ? copy.ticinoLede
      : kind === 'country'
        ? copy.italyLede
        : kind === 'area'
          ? copy.areaLede
          : kind === 'duty-hub'
      ? copy.dutyHubLede
      : kind === 'duty-city'
        ? copy.dutyCityLede
        : kind === 'duty-week'
          ? DUTY_WEEK_COPY[locale].lede
          : kind === 'pharmacy'
                ? copy.detailLede
                : copy.cityLede;
  const supplement = RATIO_QUALITY_COPY[locale][kind];
  return supplement ? `${base} ${supplement}` : base;
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
    return `${buildPharmacyTitle(descriptor.pharmacy, BORDER_PHARMACIES)}: ${copy.detailLede}`;
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
  weekStart?: string;
}

function descriptorPath(descriptor: PageDescriptor, locale: Locale): PharmacyPath {
  if (descriptor.kind === 'hub' || descriptor.kind === 'canton' || descriptor.kind === 'country' || descriptor.kind === 'duty-hub') return { kind: descriptor.kind, locale, country: descriptor.country };
  if (descriptor.kind === 'pharmacy') return pharmacyPath(descriptor.pharmacy!, locale);
  if (descriptor.kind === 'duty-city') return { kind: 'duty-city', locale, citySlug: descriptor.citySlug };
  if (descriptor.kind === 'duty-week') return { kind: 'duty-week', locale, weekStart: descriptor.weekStart };
  return cityPath(descriptor.country || 'CH', locale, descriptor.citySlug || '', descriptor.areaSlug);
}

interface CantonCityEntry {
  name: string;
  count: number;
  path: PharmacyPath;
}

function emittedPathsForLocale(locale: Locale, allDescriptors: PageDescriptor[] = descriptors()): ReadonlySet<string> {
  return new Set(allDescriptors.map((descriptor) => buildPharmacyPath(descriptorPath(descriptor, locale), locale)));
}

function cantonCityEntries(locale: Locale, emittedPaths: ReadonlySet<string> = emittedPathsForLocale(locale)): CantonCityEntry[] {
  return TICINO_CITIES
    .map((city) => ({
      name: city.name,
      count: pharmaciesForCity(city.name).length,
      path: { kind: 'city' as const, locale, citySlug: city.slug },
    }))
    .filter((entry) => emittedPaths.has(buildPharmacyPath(entry.path, locale)));
}

function missingCantonCityPaths(locale: Locale, emittedPaths: ReadonlySet<string>): string[] {
  return TICINO_CITIES
    .map((city) => buildPharmacyPath({ kind: 'city', locale, citySlug: city.slug }, locale))
    .filter((cityPath) => !emittedPaths.has(cityPath));
}

function cantonSourceSummary(locale: Locale): string {
  const copy = COPY[locale];
  const sourceUrls = [...new Set(TICINO_PHARMACIES.map((pharmacy) => pharmacy.sourceUrl))];
  const latest = TICINO_PHARMACIES
    .map((pharmacy) => pharmacy.lastVerifiedAt)
    .sort()
    .at(-1);
  const sources = sourceUrls
    .map((sourceUrl) => `<a href="${esc(sourceUrl)}" rel="nofollow noopener">${esc(copy.sourceLink)}</a>`)
    .join(' · ');
  const verified = latest ? '<br><strong>' + esc(copy.checked) + ':</strong> ' + esc(formatDate(latest, locale)) : '';
  return '<p style="' + BODY_STYLE + '"><strong>' + esc(copy.sourcesHeading) + ':</strong> ' + sources + verified + '</p>';
}

function currentDutyRows(dataset: PharmacyDutiesDataset = dutiesDataset, now = new Date()): PharmacyDuty[] {
  if (!Array.isArray(dataset.duties)) return [];
  return [...new Set(dataset.duties.map((duty) => duty.coverageName))]
    .map((coverageName) => currentDutyForRegion(dataset, coverageName, now))
    .filter((duty): duty is PharmacyDuty => Boolean(duty));
}

function pagePharmacies(descriptor: PageDescriptor, dataset: PharmacyDutiesDataset = dutiesDataset, now = new Date()): Pharmacy[] {
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
    return [...new Set(currentDutyRows(dataset, now).map((duty) => duty.pharmacyId))]
      .map((id) => pharmacyById(id))
      .filter((pharmacy): pharmacy is Pharmacy => Boolean(pharmacy));
  }
  if (descriptor.kind === 'duty-city') {
    const ids = new Set(TICINO_PHARMACIES.filter((pharmacy) => pharmacy.city === descriptor.cityName).map((pharmacy) => pharmacy.id));
    return currentDutyRows(dataset, now).filter((duty) => ids.has(duty.pharmacyId)).map((duty) => pharmacyById(duty.pharmacyId)).filter((pharmacy): pharmacy is Pharmacy => Boolean(pharmacy));
  }
  return [];
}

function renderBody(
  descriptor: PageDescriptor,
  locale: Locale,
  h1 = pageTitle(descriptor.kind, locale, descriptor),
  dataset: PharmacyDutiesDataset = dutiesDataset,
  now = new Date(),
  emittedPaths: ReadonlySet<string> = emittedPathsForLocale(locale),
): string {
  const copy = COPY[locale];
  if (descriptor.kind === 'duty-week') return renderDutyWeek(descriptor, locale, h1, dataset, now);
  const datasetDuties = Array.isArray(dataset.duties) ? dataset.duties : [];
  let sections = '';
  if (descriptor.kind === 'hub') {
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2><p style="${BODY_STYLE}">${href({ kind: 'canton', locale }, copy.ticinoTitle)} · ${href({ kind: 'country', country: 'IT', locale }, copy.italyTitle)} · ${href({ kind: 'duty-hub', locale }, copy.duties)}</p><p style="${BODY_STYLE}">${ITALY_BORDER_PROVINCES.map((area) => href({ kind: 'area', country: 'IT', areaSlug: area.slug, locale }, area.name)).join(' · ')}</p><p style="${BODY_STYLE}">${esc(copy.locarneseNote)}</p></section>`;
  } else if (descriptor.kind === 'duty-hub') {
    const currentRows = currentDutyRows(dataset, now);
    const regions = [...new Set(currentRows.map((duty) => duty.coverageName))];
    const dutyCards = regions.map((region) => renderDuty(currentDutyForRegion(dataset, region, now), locale)).join('');
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.duties)}</h2>${regions.length > 0 ? `<div class="s-XENO3U">${dutyCards}</div>` : `<p style="${BODY_STYLE}">${esc(copy.noDuty)}</p>`}<p style="${BODY_STYLE}">${esc(copy.locarneseNote)}</p></section>`;
  } else if (descriptor.kind === 'duty-city') {
    const region = TICINO_PHARMACIES.find((pharmacy) => pharmacy.city === descriptor.cityName && datasetDuties.some((duty) => duty.pharmacyId === pharmacy.id))?.id;
    const coverage = region ? datasetDuties.find((duty) => duty.pharmacyId === region)?.coverageName : undefined;
    const currentDuty = coverage ? currentDutyForRegion(dataset, coverage, now) : undefined;
    const duties = currentDuty ? [currentDuty] : [];
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.duties)}</h2>${esc(copy.dutyCityLede)}${duties.length > 0 ? `<div class="s-XENO3U">${duties.map((duty) => renderDuty(duty, locale)).join('')}</div>` : `<p style="${BODY_STYLE}">${esc(copy.noDuty)}</p>`}</section>`;
  } else if (descriptor.kind === 'canton') {
    const cities = cantonCityEntries(locale, emittedPaths);
    sections = '<section><h2 style="' + H2_STYLE + '">' + esc(copy.directoryHeading) + '</h2><nav aria-label="' + esc(copy.directoryHeading) + '"><ul style="' + BODY_STYLE + '">' + cities.map((city) => '<li>' + href(city.path, city.name) + ' — ' + esc(copy.provinceCount(city.count)) + '</li>').join('') + '</ul></nav>' + cantonSourceSummary(locale) + '<p style="' + BODY_STYLE + '">' + esc(copy.locarneseNote) + '</p></section>';
  } else if (descriptor.kind === 'country') {
    const provinces = ITALY_BORDER_PROVINCES.map((area) => {
      const count = pharmaciesForProvince(area.code).length;
      const areaPath: PharmacyPath = { kind: 'area', country: 'IT', areaSlug: area.slug, locale };
      return `<li>${href(areaPath, area.name)} — ${esc(copy.provinceCount(count))}</li>`;
    }).join('');
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2><nav aria-label="${esc(copy.directoryHeading)}"><ul style="${BODY_STYLE}">${provinces}</ul></nav><p style="${BODY_STYLE}">${esc(copy.countryDirectoryNote)}</p></section>`;
  } else if (descriptor.kind === 'pharmacy') {
    const pharmacy = descriptor.pharmacy!;
    const website = safePharmacyUrl(pharmacy.website);
    const maps = pharmacy.latitude !== undefined && pharmacy.longitude !== undefined ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(String(pharmacy.latitude))}&mlon=${encodeURIComponent(String(pharmacy.longitude))}#map=18/${encodeURIComponent(String(pharmacy.latitude))}/${encodeURIComponent(String(pharmacy.longitude))}` : undefined;
    const parent = pharmacy.country === 'IT' ? cityPath('IT', locale, pharmacyCitySlug(pharmacy.city), ITALY_BORDER_PROVINCES.find((area) => area.code === pharmacy.province)?.slug) : cityPath('CH', locale, pharmacyCitySlug(pharmacy.city));
    sections = `<p style="${BODY_STYLE}">${href(parent, `${copy.directoryHeading}: ${pharmacy.city}`)}</p><section><h2 style="${H2_STYLE}">${esc(copy.contactHeading)}</h2><p style="${BODY_STYLE}"><strong>${esc(copy.address)}:</strong> ${esc(pharmacy.address)}, ${esc(pharmacy.postalCode)} ${esc(pharmacy.city)}</p>${pharmacy.phone ? `<p style="${BODY_STYLE}"><strong>${esc(copy.phone)}:</strong> <a href="tel:${esc(pharmacy.phone)}">${esc(pharmacy.phone)}</a></p>` : ''}${website ? `<p style="${BODY_STYLE}"><strong>${esc(copy.website)}:</strong> <a href="${esc(website)}" rel="nofollow noopener">${esc(website)}</a></p>` : ''}${maps ? `<p style="${BODY_STYLE}"><strong>${esc(copy.map)}:</strong> <a href="${esc(maps)}" rel="nofollow noopener">${esc(copy.openMap)}</a></p>` : ''}</section><section><h2 style="${H2_STYLE}">${esc(copy.hoursHeading)}</h2>${renderHours(pharmacy, locale)}</section><section><h2 style="${H2_STYLE}">${esc(copy.servicesHeading)}</h2>${renderServices(pharmacy, locale)}</section><section><h2 style="${H2_STYLE}">${esc(copy.sourcesHeading)}</h2>${sourceLine(pharmacy, locale)}<p style="${BODY_STYLE}">${esc(copy.osmNote)}</p></section>`;
  } else {
    const pharmacies = pagePharmacies(descriptor, dataset, now);
    const directory = descriptor.kind === 'area'
      ? '<ul style="' + BODY_STYLE + '">' + pharmacies.map((pharmacy) => renderCompactPharmacyListItem(pharmacy, locale)).join('') + '</ul>'
      : `<div class="s-XENO3U">${pharmacies.map((pharmacy) => renderPharmacyCard(pharmacy, locale)).join('')}</div>`;
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2>${directory}${descriptor.kind === 'city' && descriptor.country === 'CH' ? `<p style="${BODY_STYLE}">${href({ kind: 'duty-city', locale, citySlug: descriptor.citySlug }, copy.viewDuties)}</p>` : ''}</section>`;
  }
  const faq = descriptor.kind === 'city' && descriptor.country === 'CH'
    ? renderCityFaq(locale, descriptor.cityName || '', pharmaciesForCity(descriptor.cityName || '').length)
    : '';
  return `<header><h1 style="${H1_STYLE}">${esc(h1)}</h1><p style="${LEDE_STYLE}">${esc(pageLede(descriptor.kind, locale))}</p></header>${sections}${faq}<section><h2 style="${H2_STYLE}">${esc(copy.disclaimerHeading)}</h2><p style="${BODY_STYLE}">${esc(copy.disclaimer)}</p></section>`;
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
    if (descriptor.kind === 'duty-week') items.push({ name: pageTitle(descriptor.kind, locale, descriptor), path: descriptorPath(descriptor, locale) });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: `${BASE_URL}${buildPharmacyPath(item.path, locale)}` })) });
}

function cityFaqJsonLd(locale: Locale, pathValue: PharmacyPath, cityName: string, count: number): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${BASE_URL}${buildPharmacyPath(pathValue, locale)}#faq`,
    mainEntity: cityFaqItems(locale, cityName, count).map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  });
}

function cantonCollectionJsonLd(pathValue: PharmacyPath, title: string, cities: CantonCityEntry[]): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: BASE_URL + buildPharmacyPath(pathValue, pathValue.locale),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: cities.length,
      itemListElement: cities.map((city, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: city.name,
        url: BASE_URL + buildPharmacyPath(city.path, city.path.locale),
      })),
    },
  });
}

function jsonLd(
  descriptor: PageDescriptor,
  locale: Locale,
  dataset: PharmacyDutiesDataset = dutiesDataset,
  now = new Date(),
  emittedPaths: ReadonlySet<string> = emittedPathsForLocale(locale),
): string[] {
  const pathValue = descriptorPath(descriptor, locale);
  const title = pageTitle(descriptor.kind, locale, descriptor);
  if (descriptor.kind === 'pharmacy') return [detailJsonLd(descriptor.pharmacy!, locale), breadcrumbJsonLd(descriptor, locale)];
  if (descriptor.kind === 'duty-city') return [breadcrumbJsonLd(descriptor, locale)];
  if (descriptor.kind === 'duty-week') {
    const model = dutyWeekModel(descriptor, dataset, now);
    return model.indexable
      ? [dutyWeekCollectionJsonLd(pathValue, title, model), breadcrumbJsonLd(descriptor, locale)]
      : [breadcrumbJsonLd(descriptor, locale)];
  }
  if (descriptor.kind === 'city' && descriptor.country === 'CH') {
    const cityName = descriptor.cityName || '';
    const pharmacies = pharmaciesForCity(cityName);
    return [collectionJsonLd(pathValue, title, pharmacies), cityFaqJsonLd(locale, pathValue, cityName, pharmacies.length), breadcrumbJsonLd(descriptor, locale)];
  }
  if (descriptor.kind === 'canton') return [cantonCollectionJsonLd(pathValue, title, cantonCityEntries(locale, emittedPaths)), breadcrumbJsonLd(descriptor, locale)];
  if (descriptor.kind === 'country') return [countryCollectionJsonLd(pathValue, title), breadcrumbJsonLd(descriptor, locale)];
  return [collectionJsonLd(pathValue, title, pagePharmacies(descriptor, dataset, now)), breadcrumbJsonLd(descriptor, locale)];
}

function hreflang(descriptor: PageDescriptor): string {
  return [...LOCALES.map((locale) => `<link rel="alternate" hreflang="${locale}" href="${esc(`${BASE_URL}${buildPharmacyPath(descriptorPath(descriptor, locale), locale)}`)}" />`), `<link rel="alternate" hreflang="x-default" href="${esc(`${BASE_URL}${buildPharmacyPath(descriptorPath(descriptor, 'it'), 'it')}`)}" />`].join('\n');
}

function descriptors(): PageDescriptor[] {
  return [
    { kind: 'hub' },
    { kind: 'canton', country: 'CH' },
    { kind: 'duty-hub' },
    { kind: 'duty-week', weekStart: currentDutyWeekStart(new Date()) },
    { kind: 'country', country: 'IT' },
    ...ITALY_BORDER_PROVINCES.map((area) => ({ kind: 'area' as const, country: 'IT' as const, areaSlug: area.slug, areaName: area.name })),
    ...TICINO_CITIES.map((city) => ({ kind: 'city' as const, country: 'CH' as const, citySlug: city.slug, cityName: city.name })),
    ...TICINO_CITIES.map((city) => ({ kind: 'duty-city' as const, country: 'CH' as const, citySlug: city.slug, cityName: city.name })),
    ...ITALY_CITIES.map((city) => ({ kind: 'city' as const, country: 'IT' as const, areaSlug: ITALY_BORDER_PROVINCES.find((area) => area.code === city.province)?.slug, citySlug: city.slug, cityName: city.name })),
    ...BORDER_PHARMACIES.map((pharmacy) => ({ kind: 'pharmacy' as const, country: pharmacy.country, pharmacy })),
  ];
}

function buildPage(
  descriptor: PageDescriptor,
  locale: Locale,
  distDir: string,
  dataset: PharmacyDutiesDataset = dutiesDataset,
  // This is a build-time snapshot by design. The duty workflow checks known
  // start/end transitions every 15 minutes and commits a status marker, so a
  // static build is requested before its crawlable card can become stale.
  now = new Date(),
  emittedPaths: ReadonlySet<string> = emittedPathsForLocale(locale),
) {
  const title = pageTitle(descriptor.kind, locale, descriptor);
  const emittedTitle = shellTitle(descriptor, locale);
  const body = renderBody(descriptor, locale, differentiateH1FromTitle(title, emittedTitle, locale), dataset, now, emittedPaths);
  const wordCount = countHtmlBodyWords(body);
  // City duty URLs are useful navigation aliases, but their body repeats the
  // regional OFCT schedule. Keep them crawlable for users without creating
  // duplicate indexable pages or an ItemList with a different visible scope.
  const dutyWeek = descriptor.kind === 'duty-week' ? dutyWeekModel(descriptor, dataset, now) : null;
  const indexable = descriptor.kind === 'duty-week'
    ? Boolean(dutyWeek?.indexable && wordCount >= MIN_INDEXABLE_WORDS)
    : descriptor.kind !== 'duty-city' && wordCount >= MIN_INDEXABLE_WORDS;
  const pathValue = descriptorPath(descriptor, locale);
  const description = pageDescription(descriptor, locale);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable })}`;
  return {
    path: buildPharmacyPath(pathValue, locale),
    wordCount,
    indexable,
    html: buildSeoPageHtml({ locale, title: emittedTitle, description, canonicalUrl: `${BASE_URL}${buildPharmacyPath(pathValue, locale)}`, hreflangHtml: hreflang(descriptor), robots: indexable ? 'index,follow' : 'noindex,follow', jsonLdScripts: jsonLd(descriptor, locale, dataset, now, emittedPaths), bodyHtml, seoContentOutsideRoot: true, seoMainClass: 'seo-static-content', distDir }),
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
      const emittedPathsByLocale = new Map<Locale, ReadonlySet<string>>();
      for (const locale of LOCALES) {
        const emittedPaths = emittedPathsForLocale(locale, allDescriptors);
        const missing = missingCantonCityPaths(locale, emittedPaths);
        if (missing.length > 0) {
          throw new Error(`Ticino canton page has ${missing.length} city links without an emitted destination (${locale}): ${missing.slice(0, 5).join(', ')}`);
        }
        emittedPathsByLocale.set(locale, emittedPaths);
      }
      let excludedNoindexRoutes = 0;
      for (const locale of LOCALES) {
        for (const descriptor of allDescriptors) {
          const built = buildPage(descriptor, locale, distDir, dutiesDataset, new Date(), emittedPathsByLocale.get(locale)!);
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
      let aliasRedirects = 0;
      for (const alias of pharmacyUrlAliasDescriptors()) {
        emitPharmacyAliasBridge(distDir, alias);
        aliasRedirects += 1;
      }
      if (shouldEmitLocale('it')) fs.writeFileSync(path.join(distDir, 'sitemap-farmacie.xml'), sitemap, 'utf8');
      const master = path.join(distDir, 'sitemap.xml');
      if (fs.existsSync(master)) {
        let xml = fs.readFileSync(master, 'utf8');
        if (!xml.includes('sitemap-farmacie.xml')) xml = xml.replace('</sitemapindex>', `  <sitemap><loc>${BASE_URL}/sitemap-farmacie.xml</loc><lastmod>${dateStamp}</lastmod></sitemap>\n</sitemapindex>`);
        fs.writeFileSync(master, xml, 'utf8');
      }
      console.log(`\x1b[36m[pharmacy-directory-pages]\x1b[0m Emitted ${written} pages, ${aliasRedirects} pharmacy URL redirects and ${urls.length} sitemap URLs (${excludedNoindexRoutes} noindex routes excluded from sitemap)`);
    },
  };
}

export { buildPage as buildPharmacyDirectoryPage, descriptors as pharmacyPageDescriptors };
