/**
 * Static pages for Italian border municipalities near Ticino.
 *
 * Emits one SEO page per municipality under:
 *   /vivere-in-ticino/comuni-di-frontiera/{comune}/
 *
 * The pages turn the existing border-municipalities hub into a decision tool:
 * local tax/rent facts, playful "cosa succede se..." scenarios, nearest
 * crossing guidance, and links into the salary, border-wait, transport and
 * tax-return surfaces.
 */

import fs from 'node:fs';
import { irpefDisplayText, irpefDisplayTitle } from '../services/irpefAddizionaleRegime';
import { rentCaptionSuffix } from '../services/avgRentEstimate';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { staticPagesFlushed } from './shared/buildSignals';
import { MUNICIPALITIES, type Municipality } from '../data/municipalities';
import {
  BORDER_MUNICIPALITY_BASE_PATH,
  borderMunicipalityPathFor,
  corridorMunicipalities,
  slugifyMunicipalityName,
} from './borderMunicipalityData';
import { borderCrossings, type BorderCrossing } from '../data/borderCrossings';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import { forceGc } from './shared/forceGc';

type Locale = 'it' | 'en' | 'de' | 'fr';
type WaitSnapshot = {
  updatedAt?: string;
  perCrossing?: Record<string, {
    waitTimeMinutes?: number;
    approachMinutes?: number;
    totalCrossingMinutes?: number;
    status?: 'green' | 'yellow' | 'red' | string;
    source?: string;
    lastUpdate?: string;
  }>;
};

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;
const SITEMAP_NAME = 'sitemap-comuni-frontiera.xml';

// Shared with searchConsoleCompat via ./borderMunicipalityData, so the
// emitted URLs and the compat self-map cannot drift apart.
const MUNICIPALITY_BASE_PATH = BORDER_MUNICIPALITY_BASE_PATH;

const LOCALE_OG: Record<Locale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const HUB_PATH = '/vivere-in-ticino/comuni-di-frontiera/';
const HUB_LABEL: Record<Locale, string> = {
  it: 'Comuni di frontiera',
  en: 'Border municipalities',
  de: 'Grenzgemeinden',
  fr: 'Communes frontalières',
};
const HOME_LABEL: Record<Locale, string> = {
  it: 'Home',
  en: 'Home',
  de: 'Startseite',
  fr: 'Accueil',
};

const METRIC_DETAIL = {
  municipalDataset: {
    it: 'dato geografico comunale',
    en: 'municipality dataset',
    de: 'Gemeindedatensatz',
    fr: 'jeu de données communal',
  },
  localRate: {
    it: 'aliquota comunale stimata',
    en: 'estimated local rate',
    de: 'geschätzter Gemeindesatz',
    fr: 'taux communal estimé',
  },
  monthlyRent: {
    it: 'bilocale mensile indicativo',
    en: 'indicative monthly rent',
    de: 'indikative Monatsmiete',
    fr: 'loyer mensuel indicatif',
  },
} satisfies Record<string, Record<Locale, string>>;

const ACTION_LINKS = [
  {
    href: '/calcola-stipendio/',
    label: {
      it: 'Calcola stipendio netto',
      en: 'Calculate net salary',
      de: 'Nettolohn berechnen',
      fr: 'Calculer le salaire net',
    },
  },
  {
    href: '/guida-frontaliere/mappa-confine/',
    label: {
      it: 'Mappa valichi',
      en: 'Border crossing map',
      de: 'Grenzübergänge Karte',
      fr: 'Carte des passages',
    },
  },
  {
    href: '/vivere-in-ticino/trasporti-frontalieri/',
    label: {
      it: 'Trasporti frontalieri',
      en: 'Cross-border transport',
      de: 'Grenzgänger Verkehr',
      fr: 'Transports frontaliers',
    },
  },
  {
    href: '/tasse-e-pensione/dichiarazione-redditi/',
    label: {
      it: 'Dichiarazione redditi',
      en: 'Italian tax return',
      de: 'Italienische Steuererklärung',
      fr: 'Déclaration fiscale italienne',
    },
  },
] satisfies Array<{ href: string; label: Record<Locale, string> }>;

const BUTTON_LABELS = {
  borderWait: {
    it: 'Vedi tempi dogana',
    en: 'View border waits',
    de: 'Wartezeiten ansehen',
    fr: 'Voir les attentes',
  },
  compareAlternative: {
    it: 'Confronta alternativa',
    en: 'Compare alternative',
    de: 'Alternative vergleichen',
    fr: 'Comparer une alternative',
  },
} satisfies Record<string, Record<Locale, string>>;

const WAIT_SOURCE_FALLBACK: Record<Locale, string> = {
  it: 'dataset interno / storico dogane',
  en: 'internal dataset / border history',
  de: 'interner Datensatz / Grenzhistorie',
  fr: 'jeu interne / historique des frontières',
};

/**
 * The comuni that get a full CARD (province, distance, nearest crossing) at the
 * top of the hub — an editorial "most searched" shortlist, NOT the crawl
 * surface.
 *
 * It used to be the ONLY thing `buildHubPatch()` emitted, and that was Causa B
 * of issue #5434: `eligibleMunicipalities()` emits and sitemaps all 320
 * corridor comuni, while the hub linked these 16, so 304 pages had no inbound
 * link inside `maxDepth` and `audit:max-bfs-depth` counted every one of them.
 * The province-grouped index `buildHubPatch()` now appends below the cards is
 * what carries reachability: it links the FULL `eligibleMunicipalities()` list,
 * so this array can be re-ordered or trimmed for editorial reasons without ever
 * orphaning a page again.
 *
 * Keep it a subset of the emitted set — a name not in `municipalities` is
 * silently dropped by the `byName` lookup below (no card, no error).
 */
const CANDIDATE_HUB_LINKS = [
  'Como',
  'Cernobbio',
  'Maslianico',
  'Bizzarone',
  'Cantù',
  'Campione d\'Italia',
  'Varese',
  'Clivio',
  'Saltrio',
  'Lavena Ponte Tresa',
  'Porto Ceresio',
  'Luino',
  'Domodossola',
  'Verbania',
  'Cannobio',
  'Villadossola',
];

interface Copy {
  updated: string;
  role: string;
  h1: (m: Municipality) => string;
  title: (m: Municipality) => string;
  /**
   * Second cascade rung for <title> (composePlaceTitle) — shorter than
   * `title` but still keyword-bearing (issue #4886: a bare-name last
   * candidate is CTR-dead, no query-intent signal).
   */
  titleMid: (m: Municipality) => string;
  /**
   * Shortest cascade rung for <title> — never the bare comune name.
   * Reuses this locale's core "frontalieri Ticino" phrase so even the
   * minimal form still carries the page's local-SEO keyword.
   */
  titleShort: (m: Municipality) => string;
  desc: (m: Municipality, c: BorderCrossing) => string;
  badgeFrontier: (m: Municipality) => string;
  distance: string;
  irpef: string;
  rent: string;
  population: string;
  playTitle: string;
  scenario1: string;
  scenario2: string;
  scenario3: string;
  customsTitle: string;
  currentWait: string;
  morning: string;
  evening: string;
  hours: string;
  traffic: string;
  customs: string;
  yes: string;
  no: string;
  webcam: string;
  noWebcam: string;
  source: string;
  simulatorTitle: string;
  simulatorText: string;
  destination: string;
  peak: string;
  now: string;
  estimate: string;
  route: string;
  monthlyCar: string;
  liveRegion: string;
  hydratedBadge: string;
  simulatorSummary: (crossing: string, destination: string, minutes: string, wait: string) => string;
  compareTitle: string;
  faqTitle: string;
  faq1: (m: Municipality) => string;
  faq1a: (m: Municipality) => string;
  faq2: (c: BorderCrossing) => string;
  faq2a: (m: Municipality, c: BorderCrossing) => string;
  faq3: string;
  faq3a: string;
  hubTitle: string;
  hubText: string;
  hubAllTitle: string;
  hubAllText: string;
  /**
   * `altCantonName`/`altCantonCode` describe whichever canton the closer
   * (non-primary) crossing actually belongs to — currently always Valais/VS
   * since that's the only alternate canton in today's data, but the copy no
   * longer bakes that assumption into the literal text.
   */
  vsAlternativeNote: (vsCrossing: string, altCantonName: string, altCantonCode: string, tiCrossing: string) => string;
}

const COPY = {
  it: {
    updated: 'Aggiornato',
    role: 'Comune di frontiera',
    h1: (m: Municipality) => `${m.name}: vivere da frontaliere e lavorare in Ticino`,
    title: (m: Municipality) => `${m.name} frontalieri Ticino: dogana, tasse e tempi`,
    titleMid: (m: Municipality) => `${m.name} frontalieri Ticino: dogana e tasse`,
    titleShort: (m: Municipality) => `${m.name}: frontalieri Ticino`,
    desc: (m: Municipality, c: BorderCrossing) => `${m.name} (${m.province}) per frontalieri: distanza dal confine, addizionale IRPEF, affitti stimati e dogana più vicina (${c.name}) con tempi medi.`,
    badgeFrontier: (m: Municipality) => `Fascia ${m.fascia}`,
    distance: 'Distanza confine',
    irpef: 'Addizionale IRPEF',
    rent: 'Affitto stimato',
    population: 'Residenti',
    playTitle: 'Cosa cambierebbe se...',
    scenario1: '...scegliessi questo comune per il pendolarismo?',
    scenario2: '...lavorassi a Lugano o Mendrisio?',
    scenario3: '...volessi ottimizzare tasse e affitto?',
    customsTitle: 'Dogana più vicina',
    currentWait: 'Snapshot attuale',
    morning: 'Mattina',
    evening: 'Sera',
    hours: 'Orari',
    traffic: 'Traffico',
    customs: 'Controllo doganale',
    yes: 'presente',
    no: 'non fisso',
    webcam: 'webcam disponibile',
    noWebcam: 'nessuna webcam diretta',
    source: 'Fonte tempi',
    simulatorTitle: 'Simula il tragitto',
    simulatorText: 'Cambia destinazione e fascia oraria: la scheda ricalcola dogana, tempo e costo auto mensile stimato.',
    destination: 'Destinazione',
    peak: 'Fascia oraria',
    now: 'Ora',
    estimate: 'Tempo stimato',
    route: 'Dogana consigliata',
    monthlyCar: 'Auto/mese',
    liveRegion: 'Stima aggiornata',
    hydratedBadge: 'interattivo',
    simulatorSummary: (crossing: string, destination: string, minutes: string, wait: string) => `Verso ${destination} conviene ${crossing}: circa ${minutes} includendo ${wait} di attesa.`,
    compareTitle: 'Azioni utili da fare ora',
    faqTitle: 'Domande frequenti',
    faq1: (m: Municipality) => `${m.name} è un comune di frontiera per lavorare in Svizzera?`,
    faq1a: (m: Municipality) => `${m.name} risulta nella fascia ${m.fascia} del dataset interno dei comuni di frontiera usato da Frontaliere Ticino. Verifica sempre il tuo caso fiscale con un consulente se stai cambiando residenza o status di frontaliere.`,
    faq2: (c: BorderCrossing) => `Quale dogana conviene da qui?`,
    faq2a: (m: Municipality, c: BorderCrossing) => `Per ${m.name} la dogana più vicina nel nostro calcolo geografico è ${c.name}. Nelle ore di punta conviene confrontarla con le alternative del corridoio prima di partire.`,
    faq3: 'Questi dati sostituiscono un parere fiscale?',
    faq3a: 'No. Servono a orientare la scelta abitativa e il pendolarismo. La tassazione dipende anche da data di assunzione, status vecchio/nuovo frontaliere, dichiarazione italiana, deduzioni e situazione familiare.',
    hubTitle: 'Esplora i comuni più cercati',
    hubText: 'Parti da un comune concreto: la scheda mostra cosa cambia su dogana, tempi, tasse locali e collegamenti utili.',
    hubAllTitle: 'Tutti i comuni di frontiera, per provincia',
    hubAllText: 'L’elenco completo dei comuni con una scheda dedicata. Se il tuo non è tra quelli in evidenza qui sopra, lo trovi qui.',
    vsAlternativeNote: (vsCrossing: string, altCantonName: string, altCantonCode: string, tiCrossing: string) => `Sei più vicino al valico ${vsCrossing} che porta verso il ${altCantonName} (cantone ${altCantonCode}). Se lavori in Ticino il passaggio TI utile resta ${tiCrossing}, usato in tutti i tempi qui sotto.`,
  },
  en: {
    updated: 'Updated',
    role: 'Border municipality',
    h1: (m: Municipality) => `${m.name}: living in Italy and commuting to Ticino`,
    title: (m: Municipality) => `${m.name} for Ticino commuters: border, tax and time`,
    titleMid: (m: Municipality) => `${m.name} for Ticino commuters: border and tax`,
    titleShort: (m: Municipality) => `${m.name} for Ticino commuters`,
    desc: (m: Municipality, c: BorderCrossing) => `${m.name} (${m.province}) for cross-border workers: border distance, local IRPEF surcharge, estimated rents and nearest crossing (${c.name}) with average waits.`,
    badgeFrontier: (m: Municipality) => `Zone ${m.fascia}`,
    distance: 'Border distance',
    irpef: 'Local IRPEF',
    rent: 'Estimated rent',
    population: 'Residents',
    playTitle: 'What would change if...',
    scenario1: '...you chose this municipality for commuting?',
    scenario2: '...you worked in Lugano or Mendrisio?',
    scenario3: '...you wanted to balance tax and rent?',
    customsTitle: 'Nearest border crossing',
    currentWait: 'Current snapshot',
    morning: 'Morning',
    evening: 'Evening',
    hours: 'Hours',
    traffic: 'Traffic',
    customs: 'Customs control',
    yes: 'present',
    no: 'not fixed',
    webcam: 'webcam available',
    noWebcam: 'no direct webcam',
    source: 'Wait source',
    simulatorTitle: 'Commute simulator',
    simulatorText: 'Switch destination and time band: the page recalculates crossing, time and estimated monthly car cost.',
    destination: 'Destination',
    peak: 'Time band',
    now: 'Now',
    estimate: 'Estimated time',
    route: 'Suggested crossing',
    monthlyCar: 'Car/month',
    liveRegion: 'Estimate updated',
    hydratedBadge: 'interactive',
    simulatorSummary: (crossing: string, destination: string, minutes: string, wait: string) => `Toward ${destination}, ${crossing} is the better option: about ${minutes} including ${wait} wait.`,
    compareTitle: 'Useful next steps',
    faqTitle: 'FAQ',
    faq1: (m: Municipality) => `Is ${m.name} a border municipality for Swiss work?`,
    faq1a: (m: Municipality) => `${m.name} appears in zone ${m.fascia} in the internal border-municipality dataset used by Frontaliere Ticino. Always verify your individual tax status before moving.`,
    faq2: (_c: BorderCrossing) => `Which border crossing should I use?`,
    faq2a: (m: Municipality, c: BorderCrossing) => `For ${m.name}, the nearest crossing in our geographic calculation is ${c.name}. During peak hours, compare it with nearby alternatives before leaving.`,
    faq3: 'Is this tax advice?',
    faq3a: 'No. These pages help with orientation. Tax treatment depends on hiring date, old/new cross-border status, Italian filing, deductions and family situation.',
    hubTitle: 'Explore popular municipalities',
    hubText: 'Start from a concrete municipality: each profile shows border crossing, timing, local taxes and useful links.',
    hubAllTitle: 'Every border municipality, by province',
    hubAllText: 'The complete list of municipalities with a dedicated profile. If yours is not among the highlights above, it is here.',
    vsAlternativeNote: (vsCrossing: string, altCantonName: string, altCantonCode: string, tiCrossing: string) => `You are closer to ${vsCrossing}, which leads into ${altCantonName} (canton ${altCantonCode}). If you commute to Ticino the useful TI crossing remains ${tiCrossing}, used in all timings below.`,
  },
  de: {
    updated: 'Aktualisiert',
    role: 'Grenzgemeinde',
    h1: (m: Municipality) => `${m.name}: in Italien wohnen und ins Tessin pendeln`,
    title: (m: Municipality) => `${m.name} für Tessin-Pendler: Grenze, Steuer und Zeit`,
    titleMid: (m: Municipality) => `${m.name} für Tessin-Pendler: Grenze und Steuer`,
    titleShort: (m: Municipality) => `${m.name} für Tessin-Pendler`,
    desc: (m: Municipality, c: BorderCrossing) => `${m.name} (${m.province}) für Grenzgänger: Distanz zur Grenze, kommunaler IRPEF-Zuschlag, geschätzte Mieten und nächster Übergang (${c.name}).`,
    badgeFrontier: (m: Municipality) => `Zone ${m.fascia}`,
    distance: 'Grenzdistance',
    irpef: 'IRPEF-Zuschlag',
    rent: 'Mietschätzung',
    population: 'Einwohner',
    playTitle: 'Was würde sich ändern, wenn...',
    scenario1: '...du diese Gemeinde fürs Pendeln wählst?',
    scenario2: '...du in Lugano oder Mendrisio arbeitest?',
    scenario3: '...du Steuern und Miete ausbalancieren willst?',
    customsTitle: 'Nächster Grenzübergang',
    currentWait: 'Aktuelle Momentaufnahme',
    morning: 'Morgen',
    evening: 'Abend',
    hours: 'Öffnung',
    traffic: 'Verkehr',
    customs: 'Zollkontrolle',
    yes: 'vorhanden',
    no: 'nicht fix',
    webcam: 'Webcam verfügbar',
    noWebcam: 'keine direkte Webcam',
    source: 'Quelle Wartezeit',
    simulatorTitle: 'Pendeln simulieren',
    simulatorText: 'Wechsle Ziel und Zeitfenster: die Seite berechnet Übergang, Dauer und geschätzte Autokosten neu.',
    destination: 'Ziel',
    peak: 'Zeitfenster',
    now: 'Jetzt',
    estimate: 'Geschätzte Zeit',
    route: 'Empfohlener Übergang',
    monthlyCar: 'Auto/Monat',
    liveRegion: 'Schätzung aktualisiert',
    hydratedBadge: 'interaktiv',
    simulatorSummary: (crossing: string, destination: string, minutes: string, wait: string) => `Richtung ${destination} passt ${crossing}: etwa ${minutes} inklusive ${wait} Wartezeit.`,
    compareTitle: 'Nützliche nächste Schritte',
    faqTitle: 'FAQ',
    faq1: (m: Municipality) => `Ist ${m.name} eine Grenzgemeinde?`,
    faq1a: (m: Municipality) => `${m.name} erscheint in Zone ${m.fascia} im internen Grenzgemeinden-Datensatz von Frontaliere Ticino. Prüfe deinen Steuerfall vor einem Umzug individuell.`,
    faq2: (_c: BorderCrossing) => `Welcher Grenzübergang passt?`,
    faq2a: (m: Municipality, c: BorderCrossing) => `Für ${m.name} ist ${c.name} der nächstgelegene Übergang in unserer geografischen Berechnung. Zu Spitzenzeiten lohnt sich der Vergleich mit Alternativen.`,
    faq3: 'Ist das Steuerberatung?',
    faq3a: 'Nein. Die Seite dient zur Orientierung. Die Besteuerung hängt von Einstellungsdatum, altem/neuem Grenzgängerstatus, italienischer Erklärung, Abzügen und Familie ab.',
    hubTitle: 'Beliebte Gemeinden erkunden',
    hubText: 'Starte bei einer konkreten Gemeinde: jede Karte zeigt Grenze, Zeiten, lokale Steuern und nützliche Links.',
    hubAllTitle: 'Alle Grenzgemeinden, nach Provinz',
    hubAllText: 'Die vollständige Liste der Gemeinden mit eigenem Profil. Fehlt deine oben unter den Hervorhebungen, findest du sie hier.',
    vsAlternativeNote: (vsCrossing: string, altCantonName: string, altCantonCode: string, tiCrossing: string) => `Du bist näher an ${vsCrossing}, das ins ${altCantonName} (Kanton ${altCantonCode}) führt. Wer ins Tessin pendelt, nutzt weiterhin den TI-Übergang ${tiCrossing} — er liegt allen Zeiten unten zugrunde.`,
  },
  fr: {
    updated: 'Mis à jour',
    role: 'Commune frontalière',
    h1: (m: Municipality) => `${m.name}: vivre en Italie et travailler au Tessin`,
    title: (m: Municipality) => `${m.name} frontaliers Tessin: douane, impôts et temps`,
    titleMid: (m: Municipality) => `${m.name} frontaliers Tessin: douane et impôts`,
    titleShort: (m: Municipality) => `${m.name} frontaliers Tessin`,
    desc: (m: Municipality, c: BorderCrossing) => `${m.name} (${m.province}) pour frontaliers: distance frontière, surtaxe IRPEF locale, loyers estimés et poste frontière le plus proche (${c.name}).`,
    badgeFrontier: (m: Municipality) => `Zone ${m.fascia}`,
    distance: 'Distance frontière',
    irpef: 'IRPEF locale',
    rent: 'Loyer estimé',
    population: 'Habitants',
    playTitle: 'Qu’est-ce qui changerait si...',
    scenario1: '...vous choisissiez cette commune pour vos trajets?',
    scenario2: '...vous travailliez à Lugano ou Mendrisio?',
    scenario3: '...vous vouliez équilibrer impôts et loyer?',
    customsTitle: 'Douane la plus proche',
    currentWait: 'Instantané actuel',
    morning: 'Matin',
    evening: 'Soir',
    hours: 'Horaires',
    traffic: 'Trafic',
    customs: 'Contrôle douanier',
    yes: 'présent',
    no: 'non fixe',
    webcam: 'webcam disponible',
    noWebcam: 'pas de webcam directe',
    source: 'Source attente',
    simulatorTitle: 'Simuler le trajet',
    simulatorText: 'Changez destination et créneau: la page recalcule douane, durée et coût voiture mensuel estimé.',
    destination: 'Destination',
    peak: 'Créneau',
    now: 'Maintenant',
    estimate: 'Temps estimé',
    route: 'Passage conseillé',
    monthlyCar: 'Voiture/mois',
    liveRegion: 'Estimation mise à jour',
    hydratedBadge: 'interactif',
    simulatorSummary: (crossing: string, destination: string, minutes: string, wait: string) => `Vers ${destination}, ${crossing} est le meilleur choix: environ ${minutes} avec ${wait} d'attente.`,
    compareTitle: 'Prochaines actions utiles',
    faqTitle: 'FAQ',
    faq1: (m: Municipality) => `${m.name} est-elle une commune frontalière?`,
    faq1a: (m: Municipality) => `${m.name} apparaît en zone ${m.fascia} dans le jeu de données interne des communes frontalières utilisé par Frontaliere Ticino. Vérifiez toujours votre cas fiscal avant un déménagement.`,
    faq2: (_c: BorderCrossing) => `Quel poste frontière choisir?`,
    faq2a: (m: Municipality, c: BorderCrossing) => `Pour ${m.name}, le poste le plus proche dans notre calcul géographique est ${c.name}. Aux heures de pointe, comparez avec les alternatives voisines.`,
    faq3: 'Est-ce un conseil fiscal?',
    faq3a: 'Non. Cette page sert d’orientation. Le traitement fiscal dépend de la date d’embauche, du statut ancien/nouveau frontalier, de la déclaration italienne, des déductions et de la famille.',
    hubTitle: 'Explorer les communes populaires',
    hubText: 'Partez d’une commune concrète: chaque fiche montre douane, temps, taxes locales et liens utiles.',
    hubAllTitle: 'Toutes les communes frontalières, par province',
    hubAllText: 'La liste complète des communes disposant d’une fiche dédiée. Si la vôtre n’est pas mise en avant ci-dessus, elle est ici.',
    vsAlternativeNote: (vsCrossing: string, altCantonName: string, altCantonCode: string, tiCrossing: string) => `Vous êtes plus proche du poste ${vsCrossing}, qui mène au ${altCantonName} (canton ${altCantonCode}). Pour le Tessin, le passage TI utile reste ${tiCrossing}, utilisé dans tous les temps ci-dessous.`,
  },
} satisfies Record<Locale, Copy>;

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const slugify = slugifyMunicipalityName;

function pathFor(locale: Locale, municipality: Municipality): string {
  return borderMunicipalityPathFor(locale, municipality.name);
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(h));
}

function crossingSlug(crossing: BorderCrossing): string {
  if (crossing.name.startsWith('Gaggiolo')) return 'gaggiolo';
  if (crossing.name.startsWith('San Pietro')) return 'san-pietro';
  return slugify(crossing.name.replace(/\s*\([^)]*\)\s*/g, ' '));
}

function readWaitSnapshot(rootDir: string): WaitSnapshot {
  try {
    const raw = fs.readFileSync(path.resolve(rootDir, 'data', 'border-wait-current.json'), 'utf-8');
    return JSON.parse(raw) as WaitSnapshot;
  } catch {
    return {};
  }
}

function eligibleMunicipalities(): Municipality[] {
  const limit = Number.parseInt(process.env.BORDER_MUNICIPALITY_PAGE_LIMIT ?? '', 10);
  const all = corridorMunicipalities();
  return Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all;
}

function nearestCrossings(municipality: Municipality): Array<{ crossing: BorderCrossing; slug: string; distanceKm: number }> {
  return borderCrossings
    .filter((crossing) => crossing.trafficLevel !== 'closed')
    .map((crossing) => ({
      crossing,
      slug: crossingSlug(crossing),
      distanceKm: haversineKm(municipality, crossing),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Canton this municipality-page generator's routes target. Every Italian
 * border municipality in the Ticino corridor provinces today commutes toward
 * Ticino, so this is the one corridor canton in scope right now — taking it
 * as a parameter (instead of a bare 'TI' literal inside the filter) is what
 * lets a future non-TI corridor reuse nearestCantonCrossings() without
 * hardcoding the canton again.
 */
const PRIMARY_CORRIDOR_CANTON = 'TI';

function nearestCantonCrossings(
  municipality: Municipality,
  canton: string = PRIMARY_CORRIDOR_CANTON,
): Array<{ crossing: BorderCrossing; slug: string; distanceKm: number }> {
  return nearestCrossings(municipality).filter((entry) => entry.crossing.canton === canton);
}

function formatInt(n: number, locale: Locale): string {
  const lang = locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(n);
}

function formatDecimal(n: number, locale: Locale): string {
  const lang = locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n);
}

function waitLabel(snapshot: WaitSnapshot, slug: string): string {
  const current = snapshot.perCrossing?.[slug];
  if (!current) return 'n.d.';
  const total = current.totalCrossingMinutes ?? current.waitTimeMinutes;
  return typeof total === 'number' ? `${Math.max(0, Math.round(total))} min` : 'n.d.';
}

function waitMinutesFromLabel(label: string, fallback = 8): number {
  const values = Array.from(label.matchAll(/\d+/g)).map((match) => Number.parseInt(match[0], 10)).filter(Number.isFinite);
  if (values.length === 0) return fallback;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function currentWaitMinutes(snapshot: WaitSnapshot, slug: string, fallbackLabel: string): number {
  const current = snapshot.perCrossing?.[slug];
  const total = current?.totalCrossingMinutes ?? current?.waitTimeMinutes;
  return typeof total === 'number' ? Math.max(0, Math.round(total)) : waitMinutesFromLabel(fallbackLabel);
}

function trafficTone(level: BorderCrossing['trafficLevel']): string {
  if (level === 'high') return 'bg-warning-subtle text-warning border-warning-border';
  if (level === 'medium') return 'bg-info-subtle text-info border-info-border';
  return 'bg-success-subtle text-success border-success-border';
}

function destinationBaseMinutes(crossing: BorderCrossing): { mendrisio: number; lugano: number; locarno: number } {
  if (crossing.province === 'VB') {
    return { mendrisio: 85, lugano: 55, locarno: 12 };
  }
  const isLuganoFast = crossing.name.includes('Ponte Tresa') || crossing.name.includes('Fornasette');
  const mendrisio = crossing.province === 'CO' ? 12 : 10;
  const lugano = isLuganoFast ? 18 : 28;
  const locarno = crossing.province === 'CO' ? 35 : isLuganoFast ? 55 : 70;
  return { mendrisio, lugano, locarno };
}

function estimateCommute(municipality: Municipality, crossingDistanceKm: number, crossing: BorderCrossing, snapshot: WaitSnapshot, slug: string): {
  mendrisio: number;
  lugano: number;
  locarno: number;
  costMonthly: number;
} {
  const current = snapshot.perCrossing?.[slug]?.totalCrossingMinutes;
  const wait = typeof current === 'number' ? current : Number.parseInt(crossing.avgWaitMorning, 10) || 8;
  const toCrossing = crossingDistanceKm * 1.7;
  const base = destinationBaseMinutes(crossing);
  const dailyKm = Math.max(18, (municipality.distanceKm + base.lugano / 2) * 2);
  return {
    mendrisio: Math.round(toCrossing + wait + base.mendrisio),
    lugano: Math.round(toCrossing + wait + base.lugano),
    locarno: Math.round(toCrossing + wait + base.locarno),
    costMonthly: Math.round(dailyKm * 22 * 0.22),
  };
}

function renderScenarioBody(params: {
  locale: Locale;
  municipality: Municipality;
  crossing: BorderCrossing;
  crossingDistanceKm: number;
  liveWait: string;
  commute: ReturnType<typeof estimateCommute>;
}): { commute: string; jobs: string; money: string } {
  const { locale, municipality, crossing, crossingDistanceKm, liveWait, commute } = params;
  const crossingKm = formatDecimal(crossingDistanceKm, locale);
  const mendrisio = formatInt(commute.mendrisio, locale);
  const lugano = formatInt(commute.lugano, locale);
  const locarno = formatInt(commute.locarno, locale);
  // Regime-aware (#4875): the 51 Valle d'Aosta comuni levy no comunal
  // surcharge — printing their 0 raw on an INDEXED page reads as "cheapest".
  const irpef = irpefDisplayText(municipality, locale, formatDecimal(municipality.irpefAddizionale, locale));
  const rent = formatInt(municipality.avgRentMonthly, locale);
  const carCost = formatInt(commute.costMonthly, locale);
  // Crossings without traffic-history data yet (e.g. future non-Ticino
  // borders) fall back to 'n.d.' rather than interpolating "undefined"
  // into the generated prose.
  const avgMorning = crossing.avgWaitMorning ?? 'n.d.';
  const avgEvening = crossing.avgWaitEvening ?? 'n.d.';

  if (locale === 'en') {
    return {
      commute: `From ${municipality.name}, the nearest crossing in the model is ${crossing.name}, about ${crossingKm} km as the crow flies from the municipal centre. With the current snapshot the crossing weighs around ${liveWait}; on ordinary days the declared historical wait is ${avgMorning} in the morning and ${avgEvening} in the evening.`,
      jobs: `For a job in Ticino, a prudent estimate is around ${mendrisio} minutes to Mendrisio, ${lugano} minutes to Lugano and ${locarno} minutes to Locarno, including the approach to the crossing and the wait. These are orientation estimates: incidents, school traffic and weather can change the result a lot.`,
      money: `The real game is adding net salary, housing and time. Here you have a local surcharge of ${irpef}%, indicative rent of EUR ${rent} and an estimated monthly car cost from EUR ${carCost}. Before moving, compare at least three municipalities in the same corridor.`,
    };
  }

  if (locale === 'de') {
    return {
      commute: `Von ${municipality.name} ist ${crossing.name} der nächste Übergang im Modell, etwa ${crossingKm} km Luftlinie vom Gemeindezentrum entfernt. Mit der aktuellen Momentaufnahme zählt der Übergang rund ${liveWait}; an normalen Tagen liegt der historische Richtwert bei ${avgMorning} am Morgen und ${avgEvening} am Abend.`,
      jobs: `Für eine Stelle im Tessin ist eine vorsichtige Schätzung etwa ${mendrisio} Minuten nach Mendrisio, ${lugano} Minuten nach Lugano und ${locarno} Minuten nach Locarno, inklusive Anfahrt zur Grenze und Wartezeit. Es sind Orientierungswerte: Unfälle, Schulverkehr und Wetter ändern das Ergebnis stark.`,
      money: `Entscheidend ist die Summe aus Nettolohn, Wohnen und Zeit. Hier stehen kommunaler Zuschlag ${irpef}%, indikative Miete EUR ${rent} und geschätzte monatliche Autokosten ab EUR ${carCost}. Vergleiche vor einem Umzug mindestens drei Gemeinden desselben Korridors.`,
    };
  }

  if (locale === 'fr') {
    return {
      commute: `Depuis ${municipality.name}, le passage le plus proche dans le modèle est ${crossing.name}, à environ ${crossingKm} km à vol d'oiseau du centre communal. Avec l'instantané actuel, le passage pèse environ ${liveWait}; les jours ordinaires, l'attente historique déclarée est ${avgMorning} le matin et ${avgEvening} le soir.`,
      jobs: `Pour un emploi au Tessin, une estimation prudente est d'environ ${mendrisio} minutes vers Mendrisio, ${lugano} minutes vers Lugano et ${locarno} minutes vers Locarno, avec l'approche de la douane et l'attente. Ce sont des repères: accidents, écoles et météo peuvent beaucoup changer le résultat.`,
      money: `Le vrai jeu consiste à additionner net, logement et temps. Ici vous avez une surtaxe communale de ${irpef}%, un loyer indicatif de EUR ${rent} et un coût voiture mensuel estimé dès EUR ${carCost}. Avant de changer de résidence, comparez au moins trois communes du même corridor.`,
    };
  }

  return {
    commute: `Da ${municipality.name} la dogana più vicina nel modello è ${crossing.name}, a circa ${crossingKm} km in linea d'aria dal centro comunale. Con lo snapshot attuale il passaggio pesa circa ${liveWait}; nei giorni ordinari il dato storico dichiarato è ${avgMorning} al mattino e ${avgEvening} alla sera.`,
    jobs: `Per un lavoro in Ticino, una stima prudente è circa ${mendrisio} minuti verso Mendrisio, ${lugano} minuti verso Lugano e ${locarno} minuti verso Locarno, includendo avvicinamento alla dogana e attesa. Sono stime orientative: incidenti, scuole e meteo cambiano molto il risultato.`,
    money: `Il gioco vero è sommare netto, casa e tempo. Qui hai addizionale comunale ${irpef}%, affitto indicativo EUR ${rent} e costo auto mensile stimato da EUR ${carCost}. Prima di cambiare residenza, confronta almeno tre comuni dello stesso corridoio.`,
  };
}

function summaryFor(locale: Locale, municipality: Municipality): string {
  if (locale === 'en') {
    return `${municipality.name} is useful for commuters who want an Italian base with daily travel to Ticino. Compare border crossing, fiscal zone, local tax, rent and peak-time waits together.`;
  }
  if (locale === 'de') {
    return `${municipality.name} eignet sich für Pendler, die in Italien wohnen und täglich ins Tessin fahren. Vergleiche Grenzübergang, Steuerzone, kommunale Steuer, Miete und Wartezeiten gemeinsam.`;
  }
  if (locale === 'fr') {
    return `${municipality.name} aide les frontaliers qui veulent vivre en Italie et se rendre chaque jour au Tessin. Comparez douane, zone fiscale, taxe locale, loyer et attentes aux heures de pointe.`;
  }
  return `${municipality.name} è adatto a chi vuole una base italiana con rientro quotidiano verso il Ticino. La scelta va letta insieme a dogana, fascia fiscale, addizionale comunale, costo dell'affitto e tempi di punta.`;
}

function buildAlternates(municipality: Municipality): string {
  return LOCALES
    .map((locale) => ` <link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathFor(locale, municipality)}">`)
    .concat(` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathFor('it', municipality)}">`)
    .join('\n');
}

function renderMetric(label: string, value: string, detail?: string): string {
  return `<div class="rounded-md border border-edge bg-surface p-4">
    <dt class="text-sm font-medium text-subtle">${esc(label)}</dt>
    <dd class="mt-1 text-2xl font-bold text-heading">${esc(value)}</dd>
    ${detail ? `<p class="mt-1 text-sm text-muted">${esc(detail)}</p>` : ''}
  </div>`;
}

function safeJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c');
}

function buildHydrationData(params: {
  locale: Locale;
  municipality: Municipality;
  routes: Array<{ crossing: BorderCrossing; slug: string; distanceKm: number }>;
  waitSnapshot: WaitSnapshot;
  copy: Copy;
}) {
  const { locale, municipality, routes, waitSnapshot, copy } = params;
  const destinationLabels = {
    mendrisio: 'Mendrisio',
    lugano: 'Lugano',
    locarno: 'Locarno',
  };
  const peakLabels = {
    now: copy.now,
    morning: copy.morning,
    evening: copy.evening,
  };
  const defaultDestination = municipality.province === 'VB' ? 'locarno' : 'lugano';

  return {
    locale,
    currencyPrefix: 'EUR',
    defaultDestination,
    defaultPeak: 'now',
    labels: {
      destination: destinationLabels,
      peak: peakLabels,
      minutesSuffix: 'min',
      monthlySuffix: locale === 'en' ? '/month' : locale === 'de' ? '/Monat' : locale === 'fr' ? '/mois' : '/mese',
      summaryTemplate: copy.simulatorSummary('{crossing}', '{destination}', '{minutes}', '{wait}'),
    },
    routes: routes.slice(0, 2).map(({ crossing, slug, distanceKm }) => {
      // Crossings without traffic-history data yet fall back to 'n.d.'
      // (matches waitLabel()'s convention) rather than crashing on
      // `undefined.matchAll(...)` inside waitMinutesFromLabel().
      const morningLabel = crossing.avgWaitMorning ?? 'n.d.';
      const eveningLabel = crossing.avgWaitEvening ?? 'n.d.';
      const nowMinutes = currentWaitMinutes(waitSnapshot, slug, morningLabel);
      const morningMinutes = waitMinutesFromLabel(morningLabel, nowMinutes);
      const eveningMinutes = waitMinutesFromLabel(eveningLabel, morningMinutes);
      const approachMinutes = Math.round(distanceKm * 1.7);
      const destinationBase = destinationBaseMinutes(crossing);
      const carCost = (baseMinutes: number) =>
        Math.round(Math.max(18, (municipality.distanceKm + baseMinutes / 2) * 2) * 22 * 0.22);
      return {
        name: crossing.name,
        slug,
        href: `/traffico-dogane/${slug}/oggi/`,
        waits: {
          now: { minutes: nowMinutes, label: waitLabel(waitSnapshot, slug) },
          morning: { minutes: morningMinutes, label: morningLabel },
          evening: { minutes: eveningMinutes, label: eveningLabel },
        },
        destinations: {
          mendrisio: {
            baseMinutes: approachMinutes + destinationBase.mendrisio,
            costMonthly: carCost(destinationBase.mendrisio),
          },
          lugano: {
            baseMinutes: approachMinutes + destinationBase.lugano,
            costMonthly: carCost(destinationBase.lugano),
          },
          locarno: {
            baseMinutes: approachMinutes + destinationBase.locarno,
            costMonthly: carCost(destinationBase.locarno),
          },
        },
      };
    }),
  };
}

function renderHydrationPanel(params: {
  locale: Locale;
  municipality: Municipality;
  routes: Array<{ crossing: BorderCrossing; slug: string; distanceKm: number }>;
  waitSnapshot: WaitSnapshot;
  copy: Copy;
}): string {
  const { locale, municipality, routes, waitSnapshot, copy } = params;
  const data = buildHydrationData({ locale, municipality, routes, waitSnapshot, copy });
  const primaryRoute = data.routes[0];
  const primaryWait = primaryRoute?.waits.now.label ?? 'n.d.';
  const defaultDest = data.defaultDestination as 'mendrisio' | 'lugano' | 'locarno';
  const defaultDestLabel = data.labels.destination[defaultDest];
  const primaryDest = primaryRoute?.destinations[defaultDest];
  const initialMinutes = primaryRoute && primaryDest ? `${primaryDest.baseMinutes + primaryRoute.waits.now.minutes} min` : 'n.d.';
  const initialCost = primaryDest ? `EUR ${formatInt(primaryDest.costMonthly, locale)}` : 'n.d.';
  const initialSummary = primaryRoute
    ? copy.simulatorSummary(primaryRoute.name, defaultDestLabel, initialMinutes, primaryWait)
    : copy.simulatorText;
  const activeBtn = 'border-accent-border bg-accent-subtle text-accent';
  const idleBtn = 'border-edge bg-surface-raised text-heading';
  const destBtnClass = (key: 'mendrisio' | 'lugano' | 'locarno') => key === defaultDest ? activeBtn : idleBtn;
  const destBtnPressed = (key: 'mendrisio' | 'lugano' | 'locarno') => key === defaultDest ? 'true' : 'false';

  return `<section class="mt-6 rounded-md border border-edge bg-surface p-5" data-border-municipality-hydrator>
    <script type="application/json" data-border-municipality-data>${safeJson(data)}</script>
    <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-bold text-heading">${esc(copy.simulatorTitle)}</h2>
          <span class="rounded-full border border-success-border bg-success-subtle px-2.5 py-1 text-xs font-semibold text-success">${esc(copy.hydratedBadge)}</span>
        </div>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-body">${esc(copy.simulatorText)}</p>
      </div>
      <a data-border-municipality-link class="inline-flex min-h-[44px] items-center justify-center rounded-md border border-edge bg-surface-raised px-4 py-2 text-sm font-semibold text-heading hover:border-accent-border" href="${primaryRoute?.href ?? '/traffico-dogane/'}">${esc(BUTTON_LABELS.borderWait[locale])}</a>
    </div>
    <div class="mt-4 grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
      <div class="grid gap-3">
        <fieldset>
          <legend class="text-sm font-semibold text-heading">${esc(copy.destination)}</legend>
          <div class="mt-2 grid grid-cols-3 gap-2">
            <button type="button" class="rounded-md border ${destBtnClass('mendrisio')} px-3 py-2 text-sm font-semibold" data-comuni-destination="mendrisio" aria-pressed="${destBtnPressed('mendrisio')}">Mendrisio</button>
            <button type="button" class="rounded-md border ${destBtnClass('lugano')} px-3 py-2 text-sm font-semibold" data-comuni-destination="lugano" aria-pressed="${destBtnPressed('lugano')}">Lugano</button>
            <button type="button" class="rounded-md border ${destBtnClass('locarno')} px-3 py-2 text-sm font-semibold" data-comuni-destination="locarno" aria-pressed="${destBtnPressed('locarno')}">Locarno</button>
          </div>
        </fieldset>
        <fieldset>
          <legend class="text-sm font-semibold text-heading">${esc(copy.peak)}</legend>
          <div class="mt-2 grid grid-cols-3 gap-2">
            <button type="button" class="rounded-md border border-accent-border bg-accent-subtle px-3 py-2 text-sm font-semibold text-accent" data-comuni-peak="now" aria-pressed="true">${esc(copy.now)}</button>
            <button type="button" class="rounded-md border border-edge bg-surface-raised px-3 py-2 text-sm font-semibold text-heading" data-comuni-peak="morning" aria-pressed="false">${esc(copy.morning)}</button>
            <button type="button" class="rounded-md border border-edge bg-surface-raised px-3 py-2 text-sm font-semibold text-heading" data-comuni-peak="evening" aria-pressed="false">${esc(copy.evening)}</button>
          </div>
        </fieldset>
      </div>
      <div class="rounded-md border border-accent-border bg-accent-subtle p-4" aria-live="polite" aria-label="${esc(copy.liveRegion)}">
        <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt class="text-xs font-semibold uppercase tracking-wide text-muted">${esc(copy.estimate)}</dt>
            <dd class="mt-1 text-2xl font-bold text-heading" data-comuni-output="minutes">${esc(initialMinutes)}</dd>
          </div>
          <div>
            <dt class="text-xs font-semibold uppercase tracking-wide text-muted">${esc(copy.route)}</dt>
            <dd class="mt-1 text-base font-bold text-heading" data-comuni-output="crossing">${esc(primaryRoute?.name ?? '')}</dd>
          </div>
          <div>
            <dt class="text-xs font-semibold uppercase tracking-wide text-muted">${esc(copy.monthlyCar)}</dt>
            <dd class="mt-1 text-2xl font-bold text-heading" data-comuni-output="cost">${esc(initialCost)}</dd>
          </div>
        </dl>
        <p class="mt-3 text-sm leading-6 text-body" data-comuni-output="summary">${esc(initialSummary)}</p>
      </div>
    </div>
  </section>`;
}

/**
 * Budget-aware, place-preserving <title> for a comune di frontiera page.
 *
 * The sibling border-municipality plugins (french / german / austrian /
 * liechtenstein) have run this `composePlaceTitle` cascade since #3772/#4886;
 * THIS one — the Italian `/vivere-in-ticino/comuni-di-frontiera/` set — was
 * missed by that sweep and still concatenated an unbounded comune name onto a
 * 42-44 char boilerplate. Multi-word comuni ("Bardello con Malgesso e
 * Bregano", "Maccagno con Pino e Veddasca", "San Bartolomeo Val Cavargna")
 * blow the 66-char cap in all four locales — 5 of the `spa-other` offenders in
 * post-deploy validation run 30974294824.
 *
 * Rungs are longest-first and each keeps the FULL comune name: the boilerplate
 * shrinks, the place name never does, and the shortest rung still carries this
 * locale's core "frontalieri Ticino" keyword rather than degrading to a
 * CTR-dead bare name (#4886 Item 1).
 *
 * Raw `.length` (composePlaceTitle's default measure) is exact here: `m.name`
 * comes from the curated `data/municipalities` gazetteer, not from crawler free
 * text, so it can never contain an `&`/`<`/`>`/`"` that would expand on escape
 * — unlike the company-name callers that must pass `(s) => esc(s).length`.
 *
 * Exported for `tests/border-municipality-title-cascade.test.ts`, which asserts
 * the cap over the FULL live gazetteer × 4 locales rather than a sample.
 */
export function buildBorderMunicipalityTitle(municipality: Municipality, locale: Locale): string {
  const copy = COPY[locale];
  return composePlaceTitle(
    [copy.title(municipality), copy.titleMid(municipality), copy.titleShort(municipality)],
    TITLE_MAX_CHARS,
  );
}

function renderPage(params: {
  municipality: Municipality;
  locale: Locale;
  dateStamp: string;
  distDir: string;
  waitSnapshot: WaitSnapshot;
}): { urlPath: string; html: string; wordCount: number } {
  const { municipality, locale, dateStamp, distDir, waitSnapshot } = params;
  const copy = COPY[locale];
  const allRoutes = nearestCrossings(municipality);
  const tiRoutes = nearestCantonCrossings(municipality);
  const routes = tiRoutes;
  const [primary, alternate] = routes;
  const crossing = primary.crossing;
  const showVsAlt = allRoutes[0]?.crossing.canton !== PRIMARY_CORRIDOR_CANTON;
  const vsAltCrossing = showVsAlt ? allRoutes[0]?.crossing.name ?? '' : '';
  const vsAltCantonCode = showVsAlt ? allRoutes[0]?.crossing.canton ?? '' : '';
  const vsAltCantonName = showVsAlt ? getCantonDisplayName(vsAltCantonCode, locale as CantonDisplayLocale) : '';
  const commute = estimateCommute(municipality, primary.distanceKm, crossing, waitSnapshot, primary.slug);
  const canonicalPath = pathFor(locale, municipality);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const borderWaitUrl = `/traffico-dogane/${primary.slug}/oggi/`;
  const altWaitUrl = alternate ? `/traffico-dogane/${alternate.slug}/oggi/` : '/traffico-dogane/';
  const liveWait = waitLabel(waitSnapshot, primary.slug);
  const hasWebcam = (crossing.webcams?.length ?? 0) > 0;
  const scenarioBody = renderScenarioBody({
    locale,
    municipality,
    crossing,
    crossingDistanceKm: primary.distanceKm,
    liveWait,
    commute,
  });
  const aiSummary = summaryFor(locale, municipality);

  const body = `<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale, municipality).replace(`${slugify(municipality.name)}/`, '')}">${esc(HUB_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <span>${esc(municipality.name)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="rounded-full border border-info-border bg-info-subtle px-3 py-1 font-semibold text-info">${esc(copy.role)}</span>
        <span class="rounded-full border border-edge bg-surface-raised px-3 py-1 text-subtle">${esc(copy.badgeFrontier(municipality))}</span>
      </div>
      <h1 class="mt-4 max-w-4xl text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.h1(municipality))}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(aiSummary)}</p>
      <p class="mt-3 text-sm text-muted">${esc(copy.updated)}: <time datetime="${dateStamp}">${dateStamp}</time></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${renderMetric(copy.distance, `${formatDecimal(municipality.distanceKm, locale)} km`, METRIC_DETAIL.municipalDataset[locale])}
      ${renderMetric(copy.irpef, irpefDisplayText(municipality, locale, `${formatDecimal(municipality.irpefAddizionale, locale)}%`), irpefDisplayTitle(municipality, locale) || METRIC_DETAIL.localRate[locale])}
      ${renderMetric(copy.rent, `EUR ${formatInt(municipality.avgRentMonthly, locale)}`, `${METRIC_DETAIL.monthlyRent[locale]} · ${rentCaptionSuffix(municipality, locale)}`)}
      ${renderMetric(copy.population, formatInt(municipality.population, locale), municipality.province)}
    </dl>

    ${renderHydrationPanel({ locale, municipality, routes, waitSnapshot, copy })}

    ${showVsAlt ? `<aside class="mt-6 rounded-md border border-warning-border bg-warning-subtle p-4 text-sm leading-6 text-body">
      <p>${esc(copy.vsAlternativeNote(vsAltCrossing, vsAltCantonName, vsAltCantonCode, crossing.name))}</p>
    </aside>` : ''}

    <section class="mt-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <div class="rounded-md border border-edge bg-surface p-5">
        <h2 class="text-xl font-bold text-heading">${esc(copy.playTitle)}</h2>
        <div class="mt-4 grid gap-3">
          <article class="rounded-md border border-accent-border bg-accent-subtle p-4">
            <h3 class="font-semibold text-heading">${esc(copy.scenario1)}</h3>
            <p class="mt-2 text-sm leading-6 text-body">${esc(scenarioBody.commute)}</p>
          </article>
          <article class="rounded-md border border-info-border bg-info-subtle p-4">
            <h3 class="font-semibold text-heading">${esc(copy.scenario2)}</h3>
            <p class="mt-2 text-sm leading-6 text-body">${esc(scenarioBody.jobs)}</p>
          </article>
          <article class="rounded-md border border-success-border bg-success-subtle p-4">
            <h3 class="font-semibold text-heading">${esc(copy.scenario3)}</h3>
            <p class="mt-2 text-sm leading-6 text-body">${esc(scenarioBody.money)}</p>
          </article>
        </div>
      </div>

      <aside class="rounded-md border border-edge bg-surface p-5">
        <h2 class="text-xl font-bold text-heading">${esc(copy.customsTitle)}</h2>
        <div class="mt-4 rounded-md border ${trafficTone(crossing.trafficLevel)} p-4">
          <p class="text-lg font-bold">${esc(crossing.name)}</p>
          <p class="mt-1 text-sm">${esc(copy.currentWait)}: <strong>${esc(liveWait)}</strong></p>
        </div>
        <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div><dt class="font-medium text-subtle">${esc(copy.morning)}</dt><dd class="text-heading">${esc(crossing.avgWaitMorning ?? 'n.d.')}</dd></div>
          <div><dt class="font-medium text-subtle">${esc(copy.evening)}</dt><dd class="text-heading">${esc(crossing.avgWaitEvening ?? 'n.d.')}</dd></div>
          <div><dt class="font-medium text-subtle">${esc(copy.hours)}</dt><dd class="text-heading">${esc(crossing.hours)}</dd></div>
          <div><dt class="font-medium text-subtle">${esc(copy.customs)}</dt><dd class="text-heading">${crossing.customsPresent ? esc(copy.yes) : esc(copy.no)}</dd></div>
        </dl>
        <p class="mt-4 text-sm leading-6 text-body">${hasWebcam ? esc(copy.webcam) : esc(copy.noWebcam)}. ${esc(copy.source)}: ${esc(waitSnapshot.perCrossing?.[primary.slug]?.source ?? WAIT_SOURCE_FALLBACK[locale])}.</p>
        <div class="mt-4 flex flex-col gap-2">
          <a class="inline-flex items-center justify-center rounded-md bg-accent-strong px-4 py-3 text-sm font-semibold text-on-accent hover:bg-accent-strong-hover" href="${borderWaitUrl}">${esc(BUTTON_LABELS.borderWait[locale])}</a>
          <a class="inline-flex items-center justify-center rounded-md border border-edge bg-surface-raised px-4 py-3 text-sm font-semibold text-heading" href="${altWaitUrl}">${esc(BUTTON_LABELS.compareAlternative[locale])}</a>
        </div>
      </aside>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(copy.compareTitle)}</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        ${ACTION_LINKS.map((link) => `<a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${link.href}">${esc(link.label[locale])}</a>`).join('')}
      </div>
    </section>

    <section class="mt-6 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(copy.faqTitle)}</h2>
      <div class="mt-4 divide-y divide-edge">
        <details class="py-3" open><summary class="cursor-pointer font-semibold text-heading">${esc(copy.faq1(municipality))}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(copy.faq1a(municipality))}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(copy.faq2(crossing))}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(copy.faq2a(municipality, crossing))}</p></details>
        <details class="py-3"><summary class="cursor-pointer font-semibold text-heading">${esc(copy.faq3)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(copy.faq3a)}</p></details>
      </div>
    </section>
    <script src="/assets/comuni-frontiera-hydrate.js" defer></script>
  </div>`;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: HUB_LABEL[locale], item: `${BASE_URL}${MUNICIPALITY_BASE_PATH[locale]}/` },
      { '@type': 'ListItem', position: 3, name: municipality.name, item: canonicalUrl },
    ],
  });

  const placeLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'City',
    name: municipality.name,
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'IT',
      addressRegion: municipality.province,
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: municipality.lat,
      longitude: municipality.lng,
    },
    subjectOf: {
      // Must be the SAME string the page ships as <title>. Before the #4828
      // cascade both read `copy.title(municipality)` and matched by accident;
      // capping only the <title> would have made them diverge for exactly the
      // long-name comuni the cap exists for ("Bardello con Malgesso e Bregano":
      // WebPage.name 73 char vs <title> ≤66). Structured-data `name` tracking a
      // different string than the rendered title is a data-quality defect in its
      // own right, so both go through the one builder.
      name: buildBorderMunicipalityTitle(municipality, locale),
      url: canonicalUrl,
    },
  });

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: copy.faq1(municipality), acceptedAnswer: { '@type': 'Answer', text: copy.faq1a(municipality) } },
      { '@type': 'Question', name: copy.faq2(crossing), acceptedAnswer: { '@type': 'Answer', text: copy.faq2a(municipality, crossing) } },
      { '@type': 'Question', name: copy.faq3, acceptedAnswer: { '@type': 'Answer', text: copy.faq3a } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const bodyHtmlWithAd = body.replace(
    /<\/div>\s*$/,
    `${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}</div>`,
  );
  const html = buildSeoPageHtml({
    locale,
    title: buildBorderMunicipalityTitle(municipality, locale),
    description: copy.desc(municipality, crossing),
    canonicalUrl,
    hreflangHtml: buildAlternates(municipality),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml: bodyHtmlWithAd,
    jsonLdScripts: [breadcrumbLd, placeLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'municipalities' },
    distDir,
  });

  return { urlPath: canonicalPath, html, wordCount };
}

function buildSitemap(entries: Array<{ municipality: Municipality; dateStamp: string }>): string {
  const urls = entries.map(({ municipality, dateStamp }) => {
    const alternates = LOCALES
      .map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathFor(locale, municipality)}" />`)
      .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathFor('it', municipality)}" />`)
      .join('\n');
    return `  <url>\n    <loc>${BASE_URL}${pathFor('it', municipality)}</loc>\n${alternates}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.55</priority>\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const sitemapPath = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return;
  let idx = fs.readFileSync(sitemapPath, 'utf-8');
  if (!idx.includes(SITEMAP_NAME)) {
    idx = idx.replace(
      '</sitemapindex>',
      `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_NAME}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
    );
  } else {
    idx = idx.replace(
      new RegExp(`(<loc>${BASE_URL.replace(/\//g, '\\/')}/${SITEMAP_NAME}<\\/loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(<\\/lastmod>)`),
      `$1${dateStamp}$2`,
    );
  }
  fs.writeFileSync(sitemapPath, idx, 'utf-8');
}

/**
 * Exported for `tests/bfs-depth-hub-link-coverage.test.ts` — the whole point of
 * the #5434 fix is a property of this function's OUTPUT (every input comune is
 * linked), and there is no other seam to assert it from without a full build.
 */
export function buildHubPatch(municipalities: Municipality[]): string {
  const byName = new Map(municipalities.map((m) => [m.name, m]));
  const links = CANDIDATE_HUB_LINKS
    .map((name) => byName.get(name))
    .filter((m): m is Municipality => Boolean(m))
    .map((m) => {
      const [nearest] = nearestCantonCrossings(m);
      return `<a class="rounded-md border border-edge bg-surface p-4 hover:border-accent-border" href="${pathFor('it', m)}">
        <span class="block text-sm font-semibold text-heading">${esc(m.name)}</span>
        <span class="mt-1 block text-xs text-muted">${esc(m.province)} · ${formatDecimal(m.distanceKm, 'it')} km · ${esc(nearest.crossing.name)}</span>
      </a>`;
    })
    .join('');

  return `<section data-border-municipality-links="1" class="my-8 rounded-md border border-edge bg-surface p-5">
    <h2 class="text-2xl font-bold text-heading">${esc(COPY.it.hubTitle)}</h2>
    <p class="mt-2 max-w-3xl text-sm leading-6 text-body">${esc(COPY.it.hubText)}</p>
    <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${links}</div>
    ${buildHubFullIndex(municipalities)}
  </section>`;
}

/**
 * Province-grouped index of EVERY comune this plugin emits — the hub's crawl
 * surface (issue #5434, Causa B).
 *
 * Deliberately a flat run of bare `<a>` separated by "·" rather than the card
 * markup above: at 320 comuni the card form costs ~76 KB of HTML on a single
 * page, this one ~30 KB, and the card's extra fields (distance, nearest
 * crossing) are already on each comune's own page one click away. Grouping by
 * province is free — `corridorMunicipalities()` already sorts by
 * `province, name`, so a single pass produces contiguous groups.
 *
 * Depth budget: the hub sits at depth 2 (home → /vivere-in-ticino/ → hub, and
 * now also home → hub directly via the shell's link section), so the comuni
 * land at 3 — inside `maxDepth: 4` with a hop to spare. That spare hop is why
 * this stays a single flat list instead of an A-Z index page in between.
 */
function buildHubFullIndex(municipalities: Municipality[]): string {
  if (municipalities.length === 0) return '';
  const byProvince = new Map<string, Municipality[]>();
  for (const m of municipalities) {
    const bucket = byProvince.get(m.province);
    if (bucket) bucket.push(m);
    else byProvince.set(m.province, [m]);
  }

  const groups = [...byProvince.entries()]
    .map(([province, list]) => {
      const items = list
        .map((m) => `<a class="text-link" href="${pathFor('it', m)}">${esc(m.name)}</a>`)
        .join(' · ');
      return `<div class="mt-4">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-muted">${esc(province)} <span class="font-normal normal-case">(${list.length})</span></h3>
        <p class="mt-1 text-sm leading-7 text-body">${items}</p>
      </div>`;
    })
    .join('');

  return `<div data-border-municipality-index="1" class="mt-8 border-t border-edge pt-6">
    <h2 class="text-xl font-bold text-heading">${esc(COPY.it.hubAllTitle)}</h2>
    <p class="mt-2 max-w-3xl text-sm leading-6 text-body">${esc(COPY.it.hubAllText)}</p>
    ${groups}
  </div>`;
}

function patchHubPage(distDir: string, municipalities: Municipality[]): void {
  const file = path.join(distDir, 'vivere-in-ticino', 'comuni-di-frontiera', 'index.html');
  if (!fs.existsSync(file)) return;
  let html = fs.readFileSync(file, 'utf-8');
  if (html.includes('data-border-municipality-links="1"')) return;
  const patch = buildHubPatch(municipalities);
  if (html.includes('<nav class="s-eazYqN">')) {
    html = html.replace('<nav class="s-eazYqN">', `${patch}<nav class="s-eazYqN">`);
  } else if (html.includes('</article>')) {
    html = html.replace('</article>', `${patch}</article>`);
  } else {
    html = html.replace('</main>', `${patch}</main>`);
  }
  fs.writeFileSync(file, html, 'utf-8');
}

export function borderMunicipalityPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'border-municipality-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_BORDER_MUNICIPALITY_PAGES === '1') {
        console.log('\x1b[36m[border-municipalities]\x1b[0m skipped (SKIP_BORDER_MUNICIPALITY_PAGES=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const dateStamp = new Date().toISOString().slice(0, 10);
      const waitSnapshot = readWaitSnapshot(rootDir);
      const municipalities = eligibleMunicipalities();
      const collector = new WriteCollector({ distDir, pluginName: 'borderMunicipalityPagesPlugin' });
      let pagesWritten = 0;
      let thinPages = 0;

      for (const municipality of municipalities) {
        for (const locale of LOCALES) {
          const rendered = renderPage({ municipality, locale, dateStamp, distDir, waitSnapshot });
          if (rendered.wordCount < MIN_INDEXABLE_WORDS) thinPages++;
          const indexPath = path.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = path.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, rendered.html);
          collector.add(flatPath, rendered.html);
          pagesWritten++;
        }
      }

      // Explicit major GC checkpoint (established pattern — see
      // jobsSeoPagesPlugin.ts's cache-clear + gc() before its own heavier
      // write/flush phases; NODE_OPTIONS=--expose-gc is set in `build:ci`,
      // see package.json). NOTE on what this actually reclaims: the final
      // `rendered.html` strings themselves are NOT garbage here — they're
      // live, referenced by `collector`'s internal Map (2560 entries,
      // `municipalities.length * LOCALES.length * 2` paths, all still below
      // WriteCollector's 5000-entry auto-flush threshold so none of them
      // have flushed yet) and stay that way until collector.flush() below
      // runs. What this gc() DOES free is the substantial *intermediate*
      // garbage renderPage() sheds per call and never retains — breadcrumb
      // arrays, `estimateCommute`/`nearestCrossings` distance-calc arrays,
      // the hydration-data object before its `safeJson()` stringify, the
      // scenario/FAQ template strings folded into the final HTML — across
      // 1280 renders that's a lot of short-lived allocation with no
      // checkpoint forcing V8 to sweep it before flush() starts its own
      // work. This plugin has been observed as the last logged plugin
      // before an OOM (build-locale(it) run 88762670606, exit 143 "runner
      // received a shutdown signal") on a run where it shares the ~11 GB
      // closeBundle RSS plateau with static-pages and other SSG plugins —
      // freeing the loop's non-retained garbage here trims the peak this
      // plugin adds on top of that shared plateau.
      forceGc();

      const sitemapXml = buildSitemap(municipalities.map((municipality) => ({ municipality, dateStamp })));
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, SITEMAP_NAME), sitemapXml, 'utf-8');

      const t0 = Date.now();
      const flushed = await collector.flush();
      patchSitemapIndex(distDir, dateStamp);

      if (process.env.BORDER_MUNICIPALITY_STANDALONE !== '1') {
        await staticPagesFlushed;
      }
      patchHubPage(distDir, municipalities);

      console.log(
        `\x1b[36m[border-municipalities]\x1b[0m Generated ${pagesWritten} pages for ${municipalities.length} municipalities — flushed ${flushed} files in ${((Date.now() - t0) / 1000).toFixed(1)}s${thinPages ? ` (${thinPages} thin)` : ''}`,
      );
    },
  };
}
