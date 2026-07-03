/**
 * Static SEO pages for events across the canton of Ticino, grouped by comune.
 *
 * Emits:
 *   - canton hub   →  /eventi/ticino/                         (+ /en|/de|/fr)
 *   - per comune   →  /eventi/ticino/{comune}/                (+ /en|/de|/fr)
 *
 * Data source: data/events.json (assembled from per-source crawler slices by
 * scripts/assemble-events-dataset.mjs; MVP source = scripts/crawl-tio-agenda.mjs
 * which covers the whole canton). Each event carries a comune resolved by
 * scripts/lib/events-utils.mjs; events without a confident comune still appear
 * on the canton hub but never invent a comune page.
 *
 * SEO contract (mirrors borderMunicipalityPagesPlugin + docs/SEO-GATES.md):
 *   - buildSeoPageHtml shell, hubKey 'vita' chrome, seoContentOutsideRoot
 *   - complete schema.org/Event JSON-LD per event (name/startDate/eventStatus/
 *     eventAttendanceMode/location.address.addressLocality/description≥30/
 *     image/organizer{name,url}/performer{name}/offers{…}) — deploy-blocking
 *     validate-structured-data-completeness.mjs requires every field
 *   - BreadcrumbList + FAQPage JSON-LD, full hreflang (it/en/de/fr + x-default)
 *   - own sitemap-eventi.xml (picked up automatically by sitemapAliasPlugin)
 *   - BFS reachability: inbound links injected into the /vivere-in-ticino/ and
 *     /vivere-in-ticino/comuni-di-frontiera/ hubs → hub depth 2, comune depth 3
 *   - MIN_INDEXABLE_WORDS gate → thin pages get noindex,follow (never dropped)
 *
 * Default-on. Escape hatch: SKIP_EVENTS_PAGES=1.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { staticPagesFlushed } from './shared/buildSignals';
import { inlineScriptJson } from './shared/inlineJsonScript';
// Shared with the crawler + assembler + tests (AGENTS.md §6 — one source of truth).
import {
  loadEventsDataset,
  upcomingEvents,
  groupByComune,
  slugifyComune,
  slugifyEvent,
  EVENT_SOURCES,
  eventsBasePathForCanton,
  germanCantonPreposition,
  EVENTS_DIGEST_SLUGS,
  weekendWindow,
  weekWindow,
  overlapsWindow,
  hasConfidentPrice,
} from '../scripts/lib/events-utils.mjs';
import { getCantonLabel, type CantonLocale } from '../services/cantonList';
import { imageObjectLd, type ImageObjectLd } from '../services/seo/imageObjectLd';
import { osmEmbedSrc } from './shared/seoContentTokens';

type Locale = 'it' | 'en' | 'de' | 'fr';

interface SiteEvent {
  id: string;
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  category?: string;
  region?: string;
  venue?: string;
  comune?: string;
  comuneMatch?: string;
  canton: string;
  url: string;
  imageUrl?: string;
  sourceKey: string;
  sourceName: string;
  // Nationwide sources (guidle, myswitzerland — issue #3125) carry richer
  // fields the original tio-agenda MVP never had. All optional: tio-agenda
  // slices (and any future thin source) simply omit them and every render
  // path below degrades to the pre-existing MVP behavior.
  description?: string;
  price?: { amount: number | null; currency: string; isFree: boolean };
  address?: { street?: string; postalCode?: string };
  geo?: { lat: number; lng: number };
  recurring?: boolean;
  // Nearby Italian border comuni (haversine geo-link, see
  // resolveItalianFrontierComuni in events-utils.mjs) — attached at assemble
  // time so a frontaliere on the Italian side can find "eventi vicino a te".
  italianFrontierComuni?: string[];
  // Some sources (guidle, myswitzerland — #3125) expose real per-locale
  // translations instead of a single source-language string. Optional and
  // partial: any locale missing from the map falls back to `title`/
  // `description` via localizedTitle/localizedDescription below.
  titleByLocale?: Partial<Record<Locale, string>>;
  descriptionByLocale?: Partial<Record<Locale, string>>;
}

function localizedTitle(event: SiteEvent, locale: Locale): string {
  return event.titleByLocale?.[locale] || event.title;
}

function localizedDescription(event: SiteEvent, locale: Locale): string | undefined {
  return event.descriptionByLocale?.[locale] || event.description;
}

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;
const SITEMAP_NAME = 'sitemap-eventi.xml';
const SOURCE = EVENT_SOURCES['tio-agenda'];
const SITE_IMAGE = `${BASE_URL}/og-image.png`;

// Localized base segment per canton+locale — shared with the FB poster and
// the weekend-digest article generator (AGENTS.md §6, one source of truth).
// `eventsBasePathForCanton('TI')` is byte-identical to the legacy TI-only
// constant it replaces (see tests/events-nationwide-sources.test.ts).
const basePathCache = new Map<string, Record<Locale, string>>();
function basePathFor(canton: string): Record<Locale, string> {
  const code = String(canton || 'TI').toUpperCase();
  let cached = basePathCache.get(code);
  if (!cached) {
    cached = eventsBasePathForCanton(code) as Record<Locale, string>;
    basePathCache.set(code, cached);
  }
  return cached;
}

const LOCALE_OG: Record<Locale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

const INTL_LANG: Record<Locale, string> = {
  it: 'it-IT',
  en: 'en-GB',
  de: 'de-DE',
  fr: 'fr-FR',
};

const HOME_LABEL: Record<Locale, string> = {
  it: 'Home',
  en: 'Home',
  de: 'Startseite',
  fr: 'Accueil',
};

// Inbound crosslinks the issue asks for: tie event pages into the existing
// border-municipality, salary, blog and job surfaces.
const CROSSLINKS: Array<{ href: Record<Locale, string>; label: Record<Locale, string> }> = [
  {
    href: {
      it: '/vivere-in-ticino/comuni-di-frontiera/',
      en: '/en/living-in-ticino/border-municipalities/',
      de: '/de/leben-im-tessin/grenzgemeinden/',
      fr: '/fr/vivre-au-tessin/communes-frontiere/',
    },
    label: {
      it: 'Comuni di frontiera',
      en: 'Border municipalities',
      de: 'Grenzgemeinden',
      fr: 'Communes frontalières',
    },
  },
  {
    href: { it: '/articoli-frontaliere/', en: '/en/articoli-frontaliere/', de: '/de/articoli-frontaliere/', fr: '/fr/articoli-frontaliere/' },
    label: { it: 'Articoli frontalieri', en: 'Cross-border articles', de: 'Grenzgänger-Artikel', fr: 'Articles frontaliers' },
  },
  {
    href: { it: '/cerca-lavoro-ticino/', en: '/en/cerca-lavoro-ticino/', de: '/de/cerca-lavoro-ticino/', fr: '/fr/cerca-lavoro-ticino/' },
    label: { it: 'Lavoro in Ticino', en: 'Jobs in Ticino', de: 'Stellen im Tessin', fr: 'Emplois au Tessin' },
  },
  {
    href: { it: '/calcola-stipendio/', en: '/en/calcola-stipendio/', de: '/de/calcola-stipendio/', fr: '/fr/calcola-stipendio/' },
    label: { it: 'Calcola stipendio netto', en: 'Net salary calculator', de: 'Nettolohn berechnen', fr: 'Salaire net' },
  },
];

interface Copy {
  hubTitle: string;
  hubH1: string;
  hubLede: string;
  comuneTitle: (c: string) => string;
  comuneH1: (c: string) => string;
  comuneLede: (c: string) => string;
  hubDesc: string;
  comuneDesc: (c: string) => string;
  updated: string;
  source: string;
  statEvents: string;
  statComuni: string;
  statWeekend: string;
  statCategories: string;
  upcoming: string;
  byComune: string;
  byComuneText: string;
  eventsIn: (c: string) => string;
  noEventsSoon: string;
  at: string;
  exploreMore: string;
  methodologyTitle: string;
  methodology: string;
  faqTitle: string;
  faqHubQ1: string;
  faqHubA1: string;
  faqHubQ2: string;
  faqHubA2: string;
  faqComuneQ1: (c: string) => string;
  faqComuneA1: (c: string) => string;
  faqComuneQ2: string;
  faqComuneA2: string;
  hubLabel: string;
  allEvents: string;
  eventsWord: string;
}

const COPY: Record<Locale, Copy> = {
  it: {
    hubTitle: 'Eventi in Ticino: agenda per comune aggiornata',
    hubH1: 'Eventi in Ticino, comune per comune',
    hubLede: 'Concerti, mostre, feste e appuntamenti in Ticino raccolti dalle agende ufficiali e raggruppati per comune.',
    comuneTitle: (c) => `Eventi a ${c}: cosa fare e agenda aggiornata`,
    comuneH1: (c) => `Eventi a ${c} e dintorni`,
    comuneLede: (c) => `Tutti i prossimi eventi a ${c} e nella sua regione: concerti, mostre, feste e appuntamenti dall'agenda del Ticino.`,
    hubDesc: 'Agenda eventi del Canton Ticino aggiornata e divisa per comune: concerti, mostre, feste, teatro e appuntamenti utili anche per i frontalieri.',
    comuneDesc: (c) => `Prossimi eventi a ${c} (Ticino): concerti, mostre, feste e appuntamenti dall'agenda ufficiale, con data, orario e luogo.`,
    updated: 'Aggiornato',
    source: 'Fonte',
    statEvents: 'Eventi in arrivo',
    statComuni: 'Comuni coperti',
    statWeekend: 'Questo weekend',
    statCategories: 'Categorie',
    upcoming: 'Prossimi eventi',
    byComune: 'Eventi per comune',
    byComuneText: 'Scegli il tuo comune per vedere gli appuntamenti più vicini a te.',
    eventsIn: (c) => `Prossimi eventi a ${c}`,
    noEventsSoon: 'Nessun evento in agenda nei prossimi giorni. Torna a trovarci: l\'agenda si aggiorna ogni giorno.',
    at: 'presso',
    exploreMore: 'Esplora anche',
    methodologyTitle: 'Come raccogliamo gli eventi',
    methodology: 'Gli eventi sono raccolti automaticamente dalle agende pubbliche del Ticino e aggiornati ogni giorno. Ogni evento è attribuito al comune in base al luogo o alla regione indicata dalla fonte. Verifica sempre data, orario e luogo sulla pagina originale dell\'organizzatore prima di metterti in viaggio: orari e disponibilità possono cambiare.',
    faqTitle: 'Domande frequenti',
    faqHubQ1: 'Ogni quanto si aggiorna l\'agenda eventi del Ticino?',
    faqHubA1: 'L\'agenda viene aggiornata automaticamente ogni giorno raccogliendo i nuovi appuntamenti pubblicati dalle fonti ufficiali del cantone.',
    faqHubQ2: 'Gli eventi sono utili anche per i frontalieri?',
    faqHubA2: 'Sì. Molti eventi si svolgono nei comuni vicini al confine e nelle principali città del Ticino, facilmente raggiungibili da chi vive in Italia e lavora in Svizzera.',
    faqComuneQ1: (c) => `Quali eventi ci sono a ${c}?`,
    faqComuneA1: (c) => `In questa pagina trovi i prossimi eventi a ${c} e nella sua regione, con data, orario e luogo. L'elenco si aggiorna ogni giorno dalle agende ufficiali del Ticino.`,
    faqComuneQ2: 'Le informazioni sugli eventi sono ufficiali?',
    faqComuneA2: 'Riprendiamo i dati dalle agende pubbliche. Per orari definitivi, biglietti e dettagli consulta sempre la pagina dell\'organizzatore collegata a ogni evento.',
    hubLabel: 'Eventi Ticino',
    allEvents: 'Vedi tutti gli eventi del Ticino',
    eventsWord: 'eventi',
  },
  en: {
    hubTitle: 'Events in Ticino: an agenda by municipality',
    hubH1: 'Events in Ticino, municipality by municipality',
    hubLede: 'Concerts, exhibitions, festivals and happenings across Ticino, collected from official agendas and grouped by municipality.',
    comuneTitle: (c) => `Events in ${c}: what to do and the latest agenda`,
    comuneH1: (c) => `Events in ${c} and around`,
    comuneLede: (c) => `All upcoming events in ${c} and its region: concerts, exhibitions, festivals and happenings from the Ticino agenda.`,
    hubDesc: 'Up-to-date events agenda for the canton of Ticino, grouped by municipality: concerts, exhibitions, festivals, theatre and useful happenings for cross-border commuters too.',
    comuneDesc: (c) => `Upcoming events in ${c} (Ticino): concerts, exhibitions, festivals and happenings from the official agenda, with date, time and venue.`,
    updated: 'Updated',
    source: 'Source',
    statEvents: 'Upcoming events',
    statComuni: 'Municipalities',
    statWeekend: 'This weekend',
    statCategories: 'Categories',
    upcoming: 'Upcoming events',
    byComune: 'Events by municipality',
    byComuneText: 'Pick your municipality to see the happenings closest to you.',
    eventsIn: (c) => `Upcoming events in ${c}`,
    noEventsSoon: 'No events in the agenda for the coming days. Check back soon: the agenda refreshes daily.',
    at: 'at',
    exploreMore: 'Explore also',
    methodologyTitle: 'How we collect events',
    methodology: 'Events are gathered automatically from public Ticino agendas and refreshed every day. Each event is attributed to a municipality based on the venue or the region given by the source. Always verify date, time and venue on the organiser\'s original page before travelling: times and availability can change.',
    faqTitle: 'FAQ',
    faqHubQ1: 'How often is the Ticino events agenda updated?',
    faqHubA1: 'The agenda is refreshed automatically every day, collecting new happenings published by the canton\'s official sources.',
    faqHubQ2: 'Are these events useful for cross-border commuters?',
    faqHubA2: 'Yes. Many events take place in municipalities near the border and in Ticino\'s main towns, easy to reach for those who live in Italy and work in Switzerland.',
    faqComuneQ1: (c) => `What events are on in ${c}?`,
    faqComuneA1: (c) => `This page lists the upcoming events in ${c} and its region, with date, time and venue. The list refreshes daily from the official Ticino agendas.`,
    faqComuneQ2: 'Is the event information official?',
    faqComuneA2: 'We mirror data from public agendas. For final times, tickets and details always check the organiser\'s page linked on each event.',
    hubLabel: 'Ticino Events',
    allEvents: 'See all Ticino events',
    eventsWord: 'events',
  },
  de: {
    hubTitle: 'Veranstaltungen im Tessin: Agenda nach Gemeinde',
    hubH1: 'Veranstaltungen im Tessin, Gemeinde für Gemeinde',
    hubLede: 'Konzerte, Ausstellungen, Feste und Anlässe im Tessin, aus offiziellen Agenden gesammelt und nach Gemeinde gruppiert.',
    comuneTitle: (c) => `Veranstaltungen in ${c}: Programm und aktuelle Agenda`,
    comuneH1: (c) => `Veranstaltungen in ${c} und Umgebung`,
    comuneLede: (c) => `Alle kommenden Veranstaltungen in ${c} und der Region: Konzerte, Ausstellungen, Feste und Anlässe aus der Tessiner Agenda.`,
    hubDesc: 'Aktuelle Veranstaltungsagenda für den Kanton Tessin, nach Gemeinde gegliedert: Konzerte, Ausstellungen, Feste, Theater und nützliche Anlässe auch für Grenzgänger.',
    comuneDesc: (c) => `Kommende Veranstaltungen in ${c} (Tessin): Konzerte, Ausstellungen, Feste und Anlässe aus der offiziellen Agenda, mit Datum, Zeit und Ort.`,
    updated: 'Aktualisiert',
    source: 'Quelle',
    statEvents: 'Kommende Anlässe',
    statComuni: 'Gemeinden',
    statWeekend: 'Dieses Wochenende',
    statCategories: 'Kategorien',
    upcoming: 'Kommende Veranstaltungen',
    byComune: 'Veranstaltungen nach Gemeinde',
    byComuneText: 'Wähle deine Gemeinde, um die Anlässe in deiner Nähe zu sehen.',
    eventsIn: (c) => `Kommende Veranstaltungen in ${c}`,
    noEventsSoon: 'Keine Veranstaltungen in den nächsten Tagen. Schau bald wieder vorbei: Die Agenda wird täglich aktualisiert.',
    at: 'im',
    exploreMore: 'Ebenfalls entdecken',
    methodologyTitle: 'Wie wir Veranstaltungen sammeln',
    methodology: 'Die Veranstaltungen werden automatisch aus öffentlichen Tessiner Agenden gesammelt und täglich aktualisiert. Jeder Anlass wird anhand des Veranstaltungsorts oder der angegebenen Region einer Gemeinde zugeordnet. Prüfe Datum, Zeit und Ort immer auf der Originalseite des Veranstalters: Zeiten und Verfügbarkeit können sich ändern.',
    faqTitle: 'FAQ',
    faqHubQ1: 'Wie oft wird die Tessiner Veranstaltungsagenda aktualisiert?',
    faqHubA1: 'Die Agenda wird automatisch täglich aktualisiert und sammelt neue Anlässe aus den offiziellen Quellen des Kantons.',
    faqHubQ2: 'Sind diese Veranstaltungen auch für Grenzgänger nützlich?',
    faqHubA2: 'Ja. Viele Anlässe finden in grenznahen Gemeinden und in den grösseren Städten des Tessins statt, gut erreichbar für alle, die in Italien wohnen und in der Schweiz arbeiten.',
    faqComuneQ1: (c) => `Welche Veranstaltungen gibt es in ${c}?`,
    faqComuneA1: (c) => `Diese Seite listet die kommenden Veranstaltungen in ${c} und der Region mit Datum, Zeit und Ort. Die Liste wird täglich aus den offiziellen Tessiner Agenden aktualisiert.`,
    faqComuneQ2: 'Sind die Veranstaltungsinfos offiziell?',
    faqComuneA2: 'Wir spiegeln Daten aus öffentlichen Agenden. Für endgültige Zeiten, Tickets und Details prüfe immer die verlinkte Veranstalterseite.',
    hubLabel: 'Tessin Events',
    allEvents: 'Alle Tessiner Veranstaltungen ansehen',
    eventsWord: 'Anlässe',
  },
  fr: {
    hubTitle: 'Événements au Tessin: agenda par commune',
    hubH1: 'Événements au Tessin, commune par commune',
    hubLede: 'Concerts, expositions, fêtes et rendez-vous au Tessin, recueillis dans les agendas officiels et regroupés par commune.',
    comuneTitle: (c) => `Événements à ${c}: que faire et agenda à jour`,
    comuneH1: (c) => `Événements à ${c} et alentours`,
    comuneLede: (c) => `Tous les prochains événements à ${c} et dans sa région: concerts, expositions, fêtes et rendez-vous de l'agenda du Tessin.`,
    hubDesc: 'Agenda des événements du canton du Tessin à jour, classé par commune: concerts, expositions, fêtes, théâtre et rendez-vous utiles aussi pour les frontaliers.',
    comuneDesc: (c) => `Prochains événements à ${c} (Tessin): concerts, expositions, fêtes et rendez-vous de l'agenda officiel, avec date, horaire et lieu.`,
    updated: 'Mis à jour',
    source: 'Source',
    statEvents: 'Événements à venir',
    statComuni: 'Communes',
    statWeekend: 'Ce week-end',
    statCategories: 'Catégories',
    upcoming: 'Prochains événements',
    byComune: 'Événements par commune',
    byComuneText: 'Choisissez votre commune pour voir les rendez-vous les plus proches.',
    eventsIn: (c) => `Prochains événements à ${c}`,
    noEventsSoon: 'Aucun événement à l\'agenda dans les prochains jours. Revenez bientôt: l\'agenda se met à jour chaque jour.',
    at: 'à',
    exploreMore: 'À explorer aussi',
    methodologyTitle: 'Comment nous recueillons les événements',
    methodology: 'Les événements sont recueillis automatiquement dans les agendas publics du Tessin et actualisés chaque jour. Chaque événement est attribué à une commune selon le lieu ou la région indiquée par la source. Vérifiez toujours date, horaire et lieu sur la page d\'origine de l\'organisateur avant de vous déplacer: horaires et disponibilités peuvent changer.',
    faqTitle: 'FAQ',
    faqHubQ1: 'À quelle fréquence l\'agenda des événements du Tessin est-il mis à jour?',
    faqHubA1: 'L\'agenda est actualisé automatiquement chaque jour en recueillant les nouveaux rendez-vous publiés par les sources officielles du canton.',
    faqHubQ2: 'Ces événements sont-ils utiles pour les frontaliers?',
    faqHubA2: 'Oui. De nombreux événements se déroulent dans les communes proches de la frontière et dans les principales villes du Tessin, faciles d\'accès pour qui vit en Italie et travaille en Suisse.',
    faqComuneQ1: (c) => `Quels événements ont lieu à ${c}?`,
    faqComuneA1: (c) => `Cette page liste les prochains événements à ${c} et dans sa région, avec date, horaire et lieu. La liste se met à jour chaque jour depuis les agendas officiels du Tessin.`,
    faqComuneQ2: 'Les informations sur les événements sont-elles officielles?',
    faqComuneA2: 'Nous reprenons les données des agendas publics. Pour les horaires définitifs, billets et détails, consultez toujours la page de l\'organisateur liée à chaque événement.',
    hubLabel: 'Événements Tessin',
    allEvents: 'Voir tous les événements du Tessin',
    eventsWord: 'événements',
  },
};

// ── Canton-agnostic copy (any canton other than TI) ─────────────────────────
// TI keeps the COPY/DETAIL_COPY/DIGESTS objects above completely untouched —
// verbatim, hand-tuned Italian/German/French idiom (contracted articles like
// "del Ticino", the "im Tessin" preposition, "au/du Tessin") that does NOT
// generalize safely to an arbitrary canton name (see cantonHubEditorial.ts for
// the same documented tradeoff). For every other canton we derive equivalent,
// grammatically-safe copy by substituting the small set of Ticino/Tessin
// phrases with the canton's localized display name, trading a little
// idiomatic polish (irregular per-canton demonyms/genitives, e.g. German
// "Zürcher"/"Walliser", are out of scope — a full 26-canton declension table
// is not worth building) for text that is always correct.
function cantonSubstitutionRules(canton: string, locale: Locale): Array<[RegExp, string]> {
  const display = getCantonLabel(canton, locale as CantonLocale);
  switch (locale) {
    case 'it':
      return [
        [/\bin tutto il Ticino\b/g, `in ${display}`],
        [/\bdel Ticino\b/g, `di ${display}`],
        [/\(Ticino\)/g, `(${display})`],
        [/\bin Ticino\b/g, `in ${display}`],
        [/\bticinesi\b/g, 'locali'],
        [/\bTicino\b/g, display],
      ];
    case 'en':
      return [[/\bTicino\b/g, display]];
    case 'de': {
      const prep = germanCantonPreposition(canton);
      return [
        [/Tessiner öffentlichen Verkehr\b/g, 'öffentlichen Verkehrsmitteln'],
        [/\bim ganzen Tessin\b/g, `${prep} ${display}`],
        [/\bim Tessin\b/g, `${prep} ${display}`],
        [/\bdes Tessins\b/g, `von ${display}`],
        [/Tessiner /g, `${display}-`],
        [/\(Tessin\)/g, `(${display})`],
        [/\bTessin\b/g, display],
      ];
    }
    case 'fr':
      return [
        [/\bdans tout le Tessin\b/g, `à ${display}`],
        [/\bau Tessin\b/g, `à ${display}`],
        [/\bdu Tessin\b/g, `de ${display}`],
        [/\btessinois\b/g, 'locaux'],
        [/\(Tessin\)/g, `(${display})`],
        [/\bTessin\b/g, display],
      ];
  }
}

function applyCantonSubstitution(text: string, rules: Array<[RegExp, string]>): string {
  return rules.reduce((acc, [re, repl]) => acc.replace(re, repl), text);
}

const copyCache = new Map<string, Copy>();
/** TI → the literal, hand-tuned `COPY[locale]` object (byte-identical, zero
 * risk). Any other canton → a derived copy with the safe substitution rules
 * above applied to every field that mentions the canton name. */
function copyFor(canton: string, locale: Locale): Copy {
  if (canton.toUpperCase() === 'TI') return COPY[locale];
  const cacheKey = `${canton}|${locale}`;
  const cached = copyCache.get(cacheKey);
  if (cached) return cached;
  const rules = cantonSubstitutionRules(canton, locale);
  const base = COPY[locale];
  const sub = (s: string) => applyCantonSubstitution(s, rules);
  const out: Copy = {
    ...base,
    hubTitle: sub(base.hubTitle),
    hubH1: sub(base.hubH1),
    hubLede: sub(base.hubLede),
    comuneLede: (c: string) => sub(base.comuneLede(c)),
    hubDesc: sub(base.hubDesc),
    comuneDesc: (c: string) => sub(base.comuneDesc(c)),
    methodology: sub(base.methodology),
    faqHubQ1: sub(base.faqHubQ1),
    faqHubA2: sub(base.faqHubA2),
    faqComuneA1: (c: string) => sub(base.faqComuneA1(c)),
    hubLabel: sub(base.hubLabel),
    allEvents: sub(base.allEvents),
  };
  copyCache.set(cacheKey, out);
  return out;
}

type DigestCopy = { title: string; h1: string; lede: string; desc: string; faqQ: string; faqA: string };
const digestCopyCache = new Map<string, DigestCopy>();
/** Same TI-verbatim / non-TI-substituted split as `copyFor`, applied to a
 * single `DigestDef.copy[locale]` entry. */
function digestCopyFor(def: { key: string; copy: Record<Locale, DigestCopy> }, canton: string, locale: Locale): DigestCopy {
  const base = def.copy[locale];
  if (canton.toUpperCase() === 'TI') return base;
  const cacheKey = `${def.key}|${canton}|${locale}`;
  const cached = digestCopyCache.get(cacheKey);
  if (cached) return cached;
  const rules = cantonSubstitutionRules(canton, locale);
  const sub = (s: string) => applyCantonSubstitution(s, rules);
  const out: DigestCopy = {
    title: sub(base.title),
    h1: sub(base.h1),
    lede: sub(base.lede),
    desc: sub(base.desc),
    faqQ: sub(base.faqQ),
    faqA: sub(base.faqA),
  };
  digestCopyCache.set(cacheKey, out);
  return out;
}

const CATEGORY_LABEL: Record<string, Record<Locale, string>> = {
  arte: { it: 'Arte', en: 'Art', de: 'Kunst', fr: 'Art' },
  musica: { it: 'Musica', en: 'Music', de: 'Musik', fr: 'Musique' },
  teatro: { it: 'Teatro', en: 'Theatre', de: 'Theater', fr: 'Théâtre' },
  cinema: { it: 'Cinema', en: 'Cinema', de: 'Kino', fr: 'Cinéma' },
  feste: { it: 'Feste', en: 'Festivals', de: 'Feste', fr: 'Fêtes' },
  musei: { it: 'Musei', en: 'Museums', de: 'Museen', fr: 'Musées' },
  conferenze: { it: 'Conferenze', en: 'Talks', de: 'Vorträge', fr: 'Conférences' },
  sport: { it: 'Sport', en: 'Sport', de: 'Sport', fr: 'Sport' },
  appuntamenti: { it: 'Appuntamenti', en: 'Happenings', de: 'Anlässe', fr: 'Rendez-vous' },
  sociale: { it: 'Sociale', en: 'Social', de: 'Soziales', fr: 'Social' },
  altro: { it: 'Eventi', en: 'Events', de: 'Anlässe', fr: 'Événements' },
};

function categoryLabel(category: string | undefined, locale: Locale): string {
  if (!category) return CATEGORY_LABEL.altro[locale];
  return CATEGORY_LABEL[category]?.[locale] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

type CategoryTone = 'accent' | 'info' | 'success' | 'warning' | 'neutral';

/** Emoji + color tone per category — decorative only, drives the card media
 * placeholder and the category chip. `warning`/`success`/etc. here are just
 * the semantic token names reused for variety, no alert meaning implied. */
const CATEGORY_VISUAL: Record<string, { emoji: string; tone: CategoryTone }> = {
  arte: { emoji: '🎨', tone: 'accent' },
  musica: { emoji: '🎵', tone: 'info' },
  teatro: { emoji: '🎭', tone: 'warning' },
  cinema: { emoji: '🎬', tone: 'neutral' },
  feste: { emoji: '🎉', tone: 'warning' },
  musei: { emoji: '🖼️', tone: 'accent' },
  conferenze: { emoji: '🎤', tone: 'info' },
  sport: { emoji: '⚽', tone: 'success' },
  appuntamenti: { emoji: '📅', tone: 'neutral' },
  sociale: { emoji: '🤝', tone: 'success' },
  altro: { emoji: '✨', tone: 'neutral' },
};

function categoryVisual(category: string | undefined): { emoji: string; tone: CategoryTone } {
  return CATEGORY_VISUAL[category ?? ''] ?? CATEGORY_VISUAL.altro;
}

const TONE_CHIP_CLASSES: Record<CategoryTone, string> = {
  accent: 'border-accent-border bg-accent-subtle text-accent',
  info: 'border-info-border bg-info-subtle text-info',
  success: 'border-success-border bg-success-subtle text-success',
  warning: 'border-warning-border bg-warning-subtle text-warning',
  neutral: 'border-neutral-border bg-neutral-subtle text-neutral',
};

const TONE_GRADIENT_CLASSES: Record<CategoryTone, string> = {
  accent: 'from-accent-subtle to-surface-raised',
  info: 'from-info-subtle to-surface-raised',
  success: 'from-success-subtle to-surface-raised',
  warning: 'from-warning-subtle to-surface-raised',
  neutral: 'from-neutral-subtle to-surface-raised',
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Nationwide sources (guidle, myswitzerland — #3125) may mix with tio-agenda
 * on the same hub/comune/digest page. The "source" attribution footer must
 * list every DISTINCT source actually present among the events shown, not
 * just the single hardcoded tio-agenda constant — each linking to its own
 * EVENT_SOURCES homepage. For a page that (still) only has one source this
 * renders byte-identical to the previous single-link markup.
 */
function distinctEventSources(events: SiteEvent[]): Array<{ key: string; label: string; homepage: string }> {
  const seen = new Map<string, { key: string; label: string; homepage: string }>();
  for (const e of events) {
    const src = EVENT_SOURCES[e.sourceKey] || SOURCE;
    if (!seen.has(src.key)) seen.set(src.key, { key: src.key, label: src.label, homepage: src.homepage });
  }
  if (seen.size === 0) seen.set(SOURCE.key, { key: SOURCE.key, label: SOURCE.label, homepage: SOURCE.homepage });
  return [...seen.values()];
}

function renderSourceAttribution(events: SiteEvent[], copy: Copy, dateStamp: string): string {
  const links = distinctEventSources(events)
    .map(
      (s) =>
        `<a class="text-link hover:text-link-hover" href="${esc(s.homepage)}" rel="nofollow noopener" target="_blank">${esc(s.label)}</a>`,
    )
    .join(', ');
  return `${esc(copy.updated)}: <time datetime="${dateStamp}">${dateStamp}</time> · ${esc(copy.source)}: ${links}`;
}

function pathFor(locale: Locale, canton: string, comune?: string): string {
  const base = basePathFor(canton)[locale];
  return comune ? `${base}/${slugifyComune(comune)}/` : `${base}/`;
}

function humanDate(iso: string, locale: Locale): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(INTL_LANG[locale], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(d);
}

function isWeekend(iso: string, weekendDays: Set<string>): boolean {
  return weekendDays.has(iso);
}

/** Next Saturday+Sunday ISO days, relative to the build day. */
function weekendSet(todayIso: string): Set<string> {
  const today = new Date(`${todayIso}T00:00:00Z`);
  const out = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(today.getTime() + i * 86400000);
    const dow = d.getUTCDay();
    if (dow === 6 || dow === 0) out.add(d.toISOString().slice(0, 10));
  }
  return out;
}

function buildAlternates(canton: string, comune?: string): string {
  return LOCALES.map((locale) => ` <link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathFor(locale, canton, comune)}">`)
    .concat(` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathFor('it', canton, comune)}">`)
    .join('\n');
}

/** Canonical path of a per-event detail page: `<base>/<comune>/<event-slug>/`.
 * `canton` defaults to 'TI' so existing 3-arg callers (tests, the FB poster)
 * keep resolving the legacy Ticino path untouched. */
export function pathForEventDetail(locale: Locale, comune: string, eventSlug: string, canton: string = 'TI'): string {
  return `${basePathFor(canton)[locale]}/${slugifyComune(comune)}/${eventSlug}/`;
}

function buildEventAlternates(canton: string, comune: string, eventSlug: string): string {
  return LOCALES.map(
    (locale) => ` <link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathForEventDetail(locale, comune, eventSlug, canton)}">`,
  )
    .concat(` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathForEventDetail('it', comune, eventSlug, canton)}">`)
    .join('\n');
}

function renderMetric(label: string, value: string, detail?: string): string {
  return `<div class="rounded-md border border-edge bg-surface p-4">
    <dt class="text-sm font-medium text-subtle">${esc(label)}</dt>
    <dd class="mt-1 text-2xl font-bold text-heading">${esc(value)}</dd>
    ${detail ? `<p class="mt-1 text-sm text-muted">${esc(detail)}</p>` : ''}
  </div>`;
}

/** ICU-independent Central-European offset for a UTC instant — `+02:00` in CEST,
 * `+01:00` in CET. EU DST runs from 01:00 UTC on the last Sunday of March to
 * 01:00 UTC on the last Sunday of October. Deterministic fallback for when ICU
 * timezone data is unavailable (a `small-icu` Node build, where formatting
 * `Europe/Zurich` throws) — without it the offset would collapse to a fixed
 * `+01:00`, shifting every summer event in the indexed JSON-LD by an hour. */
function centralEuropeanOffset(d: Date): '+01:00' | '+02:00' {
  const year = d.getUTCFullYear();
  // Day-of-month of the last Sunday of a 0-based `month` (UTC): start from the
  // month's last day and step back by its weekday index.
  const lastSunday = (month: number): number => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    return lastDay.getUTCDate() - lastDay.getUTCDay();
  };
  const dstStart = Date.UTC(year, 2, lastSunday(2), 1); // last Sun March 01:00 UTC
  const dstEnd = Date.UTC(year, 9, lastSunday(9), 1); // last Sun October 01:00 UTC
  const t = d.getTime();
  return t >= dstStart && t < dstEnd ? '+02:00' : '+01:00';
}

/** Europe/Zurich UTC offset for a given ISO date — `+02:00` in CEST (summer),
 * `+01:00` in CET (winter). Hardcoding one of them shifts the JSON-LD time by
 * an hour for half the year. Prefers ICU `longOffset` (authoritative on the
 * historical/future rule); falls back to a computed CET/CEST when the build
 * Node ships `small-icu` and `Intl.DateTimeFormat` either throws on the unknown
 * `Europe/Zurich` zone or yields no `longOffset` — never a fixed `+01:00`. */
export function zurichOffset(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '+01:00';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', timeZoneName: 'longOffset' }).formatToParts(d);
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /([+-]\d{2}:\d{2})/.exec(tz);
    if (m) return m[1];
  } catch {
    // small-icu build: `Europe/Zurich` is unavailable and throws RangeError —
    // fall through to the deterministic CET/CEST computation below.
  }
  return centralEuropeanOffset(d);
}

/**
 * schema.org/Event object for one agenda entry.
 *
 * `offers` is emitted ONLY when `event.price` carries a confident price/free
 * signal (`hasConfidentPrice` — real parsed amount or a matched free
 * keyword); asserting `price:"0"` on a paid concert/theatre event would
 * misrepresent an indexed page (structured-data policy risk), so an event
 * with no price data on file (or an ambiguous "su richiesta"-style price
 * that couldn't be parsed to a number) still gets no `offers` block at all.
 * Google treats `offers` as recommended-not-required, and
 * validate-structured-data-completeness.mjs validates it only when present.
 * Every other Google-required/recommended Event field is emitted with a
 * safe fallback.
 */
export function eventLd(event: SiteEvent, locale: Locale, canonicalUrl?: string): Record<string, unknown> {
  const cantonName = getCantonLabel(event.canton || 'TI', locale as CantonLocale);
  const locality = event.comune || cantonName;
  const venueName = event.venue || locality;
  const offset = zurichOffset(event.startDate);
  const startIso = event.startTime ? `${event.startDate}T${event.startTime}:00${offset}` : event.startDate;
  // For a single-day timed event, endDate must NOT be the bare date (Google
  // reads it as midnight → "endDate before startDate"): mirror startIso.
  const hasMultiDay = Boolean(event.endDate && event.endDate !== event.startDate);
  const endIso = hasMultiDay ? (event.endDate as string) : startIso;
  const cat = categoryLabel(event.category, locale);
  const when = humanDate(event.startDate, locale);
  const title = localizedTitle(event, locale);
  const synthDescription =
    `${title} — ${cat} ${COPY[locale].at} ${venueName} (${locality}, ${cantonName}), ${when}` +
    `${event.startTime ? ` ${event.startTime}` : ''}. ${event.sourceName}.`;
  // Nationwide sources (guidle, myswitzerland) crawl a real description —
  // prefer it over the synthesized one when it clears the >=30 char gate
  // validate-structured-data-completeness.mjs enforces.
  const rawDescription = localizedDescription(event, locale);
  const description =
    rawDescription && rawDescription.trim().length >= 30 ? rawDescription.trim() : synthDescription;
  // organizer is per-EVENT_SOURCES entry, not the single tio-agenda constant
  // (§6 — one registry, no per-file duplicate of source metadata).
  const organizerSource = EVENT_SOURCES[event.sourceKey] || SOURCE;
  return {
    '@type': 'Event',
    name: title,
    startDate: startIso,
    endDate: endIso,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: venueName,
      address: {
        '@type': 'PostalAddress',
        ...(event.address?.street ? { streetAddress: event.address.street } : {}),
        ...(event.address?.postalCode ? { postalCode: event.address.postalCode } : {}),
        addressLocality: locality,
        addressRegion: event.canton || 'TI',
        addressCountry: 'CH',
      },
      ...(event.geo
        ? { geo: { '@type': 'GeoCoordinates', latitude: event.geo.lat, longitude: event.geo.lng } }
        : {}),
    },
    description: description.length >= 30 ? description : `${description} Evento in ${cantonName}.`,
    image: mirroredEventImageObject(event) ?? SITE_IMAGE,
    // On a detail page `url` is OUR canonical page (the page about the event);
    // the original source is then surfaced as `sameAs`. On aggregate pages
    // (no canonicalUrl) we keep the source URL.
    url: canonicalUrl || event.url,
    ...(canonicalUrl && event.url ? { sameAs: [event.url] } : {}),
    organizer: { '@type': 'Organization', name: event.sourceName, url: organizerSource.homepage },
    performer: { '@type': 'Organization', name: venueName },
    // offers is optional per validate-structured-data-completeness.mjs (many
    // sources never expose price) — emit ONLY when we have a confident
    // price/free signal, and always the FULL required shape together
    // (price+priceCurrency+availability+validFrom+url) so a partial offers
    // object never trips the "offers.field missing" gate.
    ...(hasConfidentPrice(event.price)
      ? {
          offers: {
            '@type': 'Offer',
            price: event.price!.isFree ? '0' : String(event.price!.amount),
            priceCurrency: event.price!.currency || 'CHF',
            availability: 'https://schema.org/InStock',
            validFrom: event.startDate,
            url: canonicalUrl || event.url,
          },
        }
      : {}),
  };
}

/**
 * Event flyer image → schema.org ImageObject with the GSC licensable-image
 * quintet (services/seo/imageObjectLd.ts — acquireLicensePage, copyrightNotice,
 * license, creator, creditText), or `null` when there is no image to show.
 *
 * No-hotlink guard (issue #3036 item 3): every crawler (mirrorEventImage,
 * scripts/lib/events-utils.mjs) is contracted to store `imageUrl` as EITHER a
 * site-relative `/images/events/...` mirrored path OR leave it unset — never
 * the raw third-party flyer URL. This guard is defense-in-depth against stale
 * pre-mirroring data (e.g. a `data/events.json` snapshot committed before a
 * given source crawler mirrored its images): an `imageUrl` that is NOT
 * site-relative is treated exactly like "no image at all" (falls back to
 * SITE_IMAGE at the call site) rather than ever being embedded as a hotlink
 * in production JSON-LD.
 *
 * License honesty: no per-image license is ever scraped from any event
 * source (tio.ch/biglietteria.ch flyers, Guidle, MySwitzerland all lack
 * stated reuse terms), so `license`/`acquireLicensePage`/`creator` are left
 * to imageObjectLd()'s defaults — our OWN site terms page + site
 * Organization, exactly like the third-party webcam images in
 * borderWaitPagesPlugin — never a fabricated third-party license.
 * `creditText` attributes the original source by name, which IS honestly
 * known from the crawl.
 */
function mirroredEventImageObject(event: SiteEvent): ImageObjectLd | null {
  const raw = event.imageUrl;
  if (!raw || !raw.startsWith('/')) return null;
  return imageObjectLd({
    contentUrl: `${BASE_URL}${raw}`,
    caption: event.title,
    creditText: event.sourceName,
  });
}

/**
 * One event card. When `detailHref` is provided the title links to OUR internal
 * event detail page (indexable, no nofollow); otherwise it falls back to the
 * external source URL (nofollow) — used for events without a comune that have no
 * detail page.
 */
function renderEventCard(event: SiteEvent, locale: Locale, detailHref?: string | null): string {
  const cat = categoryLabel(event.category, locale);
  const visual = categoryVisual(event.category);
  const when = humanDate(event.startDate, locale);
  const time = event.startTime ? ` · ${esc(event.startTime)}` : '';
  const place = event.venue ? `${esc(event.venue)}` : '';
  const comuneTag = event.comune ? `<span class="text-subtle">${esc(event.comune)}</span>` : '';
  const cardTitle = localizedTitle(event, locale);
  const titleLink = detailHref
    ? `<a class="text-link hover:text-link-hover" href="${esc(detailHref)}">${esc(cardTitle)}</a>`
    : `<a class="text-link hover:text-link-hover" href="${esc(event.url)}" rel="nofollow noopener" target="_blank">${esc(cardTitle)}</a>`;
  // `imageUrl` only ever holds a mirrored site-relative path (see
  // `mirrorEventImage()`); a raw third-party URL is never rendered here
  // (defense-in-depth, mirrors the same guard in `mirroredEventImageObject`).
  const media =
    event.imageUrl && event.imageUrl.startsWith('/')
      ? `<img class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" src="${esc(event.imageUrl)}" width="480" height="270" loading="lazy" alt="${esc(cardTitle)}">`
      : `<div class="flex h-full w-full items-center justify-center bg-gradient-to-br ${TONE_GRADIENT_CLASSES[visual.tone]} text-5xl" aria-hidden="true">${visual.emoji}</div>`;
  return `<article class="group overflow-hidden rounded-lg border border-edge bg-surface transition-shadow hover:shadow-lg">
    <div class="aspect-video w-full overflow-hidden bg-surface-raised">${media}</div>
    <div class="p-4">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="rounded-full border px-2.5 py-0.5 font-semibold ${TONE_CHIP_CLASSES[visual.tone]}">${visual.emoji} ${esc(cat)}</span>
        <span class="font-medium text-muted">${esc(when)}${time}</span>
        ${comuneTag}
      </div>
      <h3 class="mt-2 text-base font-bold leading-snug text-heading">
        ${titleLink}
      </h3>
      ${place ? `<p class="mt-1 text-sm text-body">${esc(COPY[locale].at)} ${place}</p>` : ''}
    </div>
  </article>`;
}

/** `detailHref` maps an event to its internal detail-page URL (or null → external). */
type DetailHref = (event: SiteEvent) => string | null;

function renderEventList(events: SiteEvent[], locale: Locale, detailHref?: DetailHref): string {
  if (events.length === 0) {
    return `<p class="rounded-md border border-edge bg-surface p-4 text-sm text-body">${esc(COPY[locale].noEventsSoon)}</p>`;
  }
  return `<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${events
    .map((e) => renderEventCard(e, locale, detailHref ? detailHref(e) : null))
    .join('')}</div>`;
}

function renderCrosslinks(locale: Locale): string {
  const copy = COPY[locale];
  return `<section class="mt-8 rounded-md border border-edge bg-surface p-5">
    <h2 class="text-xl font-bold text-heading">${esc(copy.exploreMore)}</h2>
    <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${CROSSLINKS.map((l) => `<a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${l.href[locale]}">${esc(l.label[locale])}</a>`).join('')}
    </div>
  </section>`;
}

function renderFaq(items: Array<{ q: string; a: string }>, title: string): string {
  return `<section class="mt-8 rounded-md border border-edge bg-surface p-5">
    <h2 class="text-xl font-bold text-heading">${esc(title)}</h2>
    <div class="mt-4 divide-y divide-edge">
      ${items
        .map(
          (it, i) =>
            `<details class="py-3"${i === 0 ? ' open' : ''}><summary class="cursor-pointer font-semibold text-heading">${esc(it.q)}</summary><p class="mt-2 text-sm leading-6 text-body">${esc(it.a)}</p></details>`,
        )
        .join('')}
    </div>
  </section>`;
}

function distinctCategories(events: SiteEvent[]): number {
  return new Set(events.map((e) => e.category).filter(Boolean)).size;
}

export function renderHubPage(params: {
  locale: Locale;
  canton: string;
  events: SiteEvent[];
  byComune: Map<string, SiteEvent[]>;
  dateStamp: string;
  weekendDays: Set<string>;
  distDir: string;
  detailHref?: DetailHref;
  /** Other cantons that also have a hub this build (BFS cross-link, so a
   * non-TI hub stays reachable beyond the sitemap/hreflang alternates). */
  otherCantons?: string[];
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, canton, events, byComune, dateStamp, weekendDays, distDir, detailHref, otherCantons = [] } = params;
  const copy = copyFor(canton, locale);
  const canonicalPath = pathFor(locale, canton);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;
  const upcoming = events.slice(0, 60);

  const comuneEntries = [...byComune.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const comuneGrid = comuneEntries
    .map(
      ([comune, list]) =>
        `<a class="group flex items-center justify-between gap-2 rounded-lg border border-edge bg-surface p-4 transition-all hover:-translate-y-0.5 hover:border-accent-border hover:shadow-md" href="${pathFor(locale, canton, comune)}">
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-heading">${esc(comune)}</span>
            <span class="mt-1 block text-xs text-muted">${list.length} ${esc(copy.eventsWord)}</span>
          </span>
          <span class="shrink-0 text-lg text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden="true">→</span>
        </a>`,
    )
    .join('');

  const cantonSwitcher =
    otherCantons.length > 0
      ? `<section class="mt-6 flex flex-wrap gap-2">
      ${otherCantons
        .map(
          (c) =>
            `<a class="rounded-full border border-edge bg-surface-raised px-3 py-1 text-xs font-semibold text-heading hover:border-accent-border" href="${pathFor(locale, c)}">${esc(getCantonLabel(c, locale as CantonLocale))}</a>`,
        )
        .join('')}
    </section>`
      : '';

  const body = `<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <span>${esc(copy.hubLabel)}</span>
    </nav>

    <header class="relative overflow-hidden rounded-lg border border-edge bg-gradient-to-br from-accent-subtle via-surface to-info-subtle p-5 sm:p-8" data-speakable>
      <div class="pointer-events-none absolute -right-4 -top-4 select-none text-8xl opacity-20 sm:text-9xl" aria-hidden="true">🎉</div>
      <h1 class="relative max-w-4xl text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.hubH1)}</h1>
      <p class="relative mt-3 max-w-3xl text-base leading-7 text-body">${esc(copy.hubLede)}</p>
      <p class="relative mt-3 text-sm text-muted">${renderSourceAttribution(events, copy, dateStamp)}</p>
    </header>

    ${cantonSwitcher}

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statComuni, String(byComune.size))}
      ${renderMetric(copy.statWeekend, String(weekendCount))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    ${renderDigestNav(locale, canton)}

    <section class="mt-8">
      <h2 class="text-2xl font-bold text-heading">${esc(copy.upcoming)}</h2>
      <div class="mt-4">${renderEventList(upcoming, locale, detailHref)}</div>
    </section>

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-2xl font-bold text-heading">${esc(copy.byComune)}</h2>
      <p class="mt-2 max-w-3xl text-sm leading-6 text-body">${esc(copy.byComuneText)}</p>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${comuneGrid}</div>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: copy.faqHubQ1, a: copy.faqHubA1 },
        { q: copy.faqHubQ2, a: copy.faqHubA2 },
      ],
      copy.faqTitle,
    )}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: copy.hubTitle,
    itemListElement: upcoming.map((event, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: eventLd(event, locale),
    })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.hubLabel, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: copy.faqHubQ1, acceptedAnswer: { '@type': 'Answer', text: copy.faqHubA1 } },
      { '@type': 'Question', name: copy.faqHubQ2, acceptedAnswer: { '@type': 'Answer', text: copy.faqHubA2 } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const html = buildSeoPageHtml({
    locale,
    title: copy.hubTitle,
    description: copy.hubDesc,
    canonicalUrl,
    hreflangHtml: buildAlternates(canton),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml: body,
    jsonLdScripts: [itemListLd, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

export function renderComunePage(params: {
  locale: Locale;
  canton: string;
  comune: string;
  events: SiteEvent[];
  dateStamp: string;
  weekendDays: Set<string>;
  distDir: string;
  detailHref?: DetailHref;
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, canton, comune, events, dateStamp, weekendDays, distDir, detailHref } = params;
  const copy = copyFor(canton, locale);
  const canonicalPath = pathFor(locale, canton, comune);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const list = events.slice(0, 40);
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;

  const body = `<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(comune)}</span>
    </nav>

    <header class="relative overflow-hidden rounded-lg border border-edge bg-gradient-to-br from-accent-subtle via-surface to-success-subtle p-5 sm:p-8" data-speakable>
      <div class="pointer-events-none absolute -right-4 -top-4 select-none text-8xl opacity-20 sm:text-9xl" aria-hidden="true">📍</div>
      <h1 class="relative max-w-4xl text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.comuneH1(comune))}</h1>
      <p class="relative mt-3 max-w-3xl text-base leading-7 text-body">${esc(copy.comuneLede(comune))}</p>
      <p class="relative mt-3 text-sm text-muted">${renderSourceAttribution(events, copy, dateStamp)}</p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-3">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statWeekend, String(weekendCount))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    <section class="mt-8">
      <h2 class="text-2xl font-bold text-heading">${esc(copy.eventsIn(comune))}</h2>
      <div class="mt-4">${renderEventList(list, locale, detailHref)}</div>
    </section>

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <a class="inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.allEvents)} →</a>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: copy.faqComuneQ1(comune), a: copy.faqComuneA1(comune) },
        { q: copy.faqComuneQ2, a: copy.faqComuneA2 },
      ],
      copy.faqTitle,
    )}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: copy.comuneTitle(comune),
    itemListElement: list.map((event, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: eventLd(event, locale),
    })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale, canton)}` },
      { '@type': 'ListItem', position: 3, name: comune, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: copy.faqComuneQ1(comune), acceptedAnswer: { '@type': 'Answer', text: copy.faqComuneA1(comune) } },
      { '@type': 'Question', name: copy.faqComuneQ2, acceptedAnswer: { '@type': 'Answer', text: copy.faqComuneA2 } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const html = buildSeoPageHtml({
    locale,
    title: copy.comuneTitle(comune),
    description: copy.comuneDesc(comune),
    canonicalUrl,
    hreflangHtml: buildAlternates(comune),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml: body,
    jsonLdScripts: [itemListLd, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

// ── Per-event detail pages ──────────────────────────────────────────────────
// One indexable page per event under its comune (/eventi/ticino/<comune>/<slug>/).
// The comune/hub/digest listings link here (internal) instead of straight to the
// external source, turning the agenda into a crawlable graph; the source is kept
// as an outbound "official site" CTA + JSON-LD `sameAs`.

interface DetailCopy {
  metaTitle: (title: string, comune: string) => string;
  metaDesc: (title: string, comune: string, when: string) => string;
  whenLabel: string;
  whereLabel: string;
  catLabel: string;
  comuneLabel: string;
  lede: (when: string, time: string, venue: string, comune: string) => string;
  officialSite: string;
  aboutTitle: string;
  // `venue` (item 2 of #3141): the tio-agenda MVP source never carries a real
  // per-event description (verified: 0/136 live events have one — tio.ch's
  // detail markup only exposes it behind a client-rendered widget, not in the
  // static HTML a plain fetch sees), so the "about" paragraph is otherwise
  // templated boilerplate shared by every event in the same comune+category.
  // `venue` is present on ~98% of events (133/136) and highly distinct even
  // within one comune (44 distinct venues among Lugano's 63 events) — folding
  // it into the sentence gives near-duplicate detection a real, data-backed
  // per-page differentiator without inventing content. Optional: falls back
  // to the pre-existing wording when a source ever omits venue.
  about: (title: string, comune: string, when: string, cat: string, venue?: string) => string;
  practicalTitle: string;
  practical: (comune: string) => string;
  moreTitle: (comune: string) => string;
  allInComune: (comune: string) => string;
  faqQ1: (title: string) => string;
  faqA1: (comune: string, when: string) => string;
  faqQ2: (comune: string) => string;
  faqA2: (comune: string) => string;
  // #3125 Task C: price / address / map / recurring / real description — all
  // canton-agnostic labels (no "Ticino"/"Tessin" literal), so unlike the rest
  // of DetailCopy these need no cantonSubstitutionRules pass.
  priceLabel: string;
  freeLabel: string;
  recurringLabel: string;
  addressLabel: string;
  mapLinkLabel: (place: string) => string;
  descriptionTitle: string;
}

const DETAIL_COPY: Record<Locale, DetailCopy> = {
  it: {
    metaTitle: (t, c) => `${t} — ${c} (Ticino) | Eventi`,
    metaDesc: (t, c, w) => `${t}: ${w} a ${c}, in Ticino. Data, orario, luogo e link al sito ufficiale dell'evento.`,
    whenLabel: 'Quando',
    whereLabel: 'Dove',
    catLabel: 'Categoria',
    comuneLabel: 'Comune',
    lede: (w, ti, v, c) => `${w}${ti} — ${v ? `${v}, ` : ''}${c}, in Ticino.`,
    officialSite: 'Sito ufficiale dell’evento',
    aboutTitle: 'Informazioni sull’evento',
    about: (t, c, w, cat, venue) =>
      `${t} è un evento di tipo ${cat} in programma ${w} a ${c}${venue ? ` – ${venue}` : ''}, in Ticino. In questa pagina trovi le informazioni essenziali — data, orario e luogo — raccolte dall’agenda del territorio. Per i dettagli completi, l’eventuale biglietteria e gli aggiornamenti dell’ultimo minuto, fai riferimento al sito ufficiale dell’evento.`,
    practicalTitle: 'Informazioni pratiche',
    practical: (c) =>
      `${c} è raggiungibile in auto e con i trasporti pubblici ticinesi. Pianifica l’arrivo con un po’ di anticipo, soprattutto per gli eventi serali e di fine settimana. Verifica sempre eventuali variazioni sul sito ufficiale prima di metterti in viaggio.`,
    moreTitle: (c) => `Altri eventi a ${c}`,
    allInComune: (c) => `Tutti gli eventi a ${c}`,
    faqQ1: (t) => `Quando si svolge ${t}?`,
    faqA1: (c, w) => `L’evento è in programma ${w} a ${c}, in Ticino. Controlla data e orario aggiornati sul sito ufficiale.`,
    faqQ2: (c) => `Dove trovo gli altri eventi a ${c}?`,
    faqA2: (c) => `Nella pagina dedicata a ${c} trovi l’agenda completa degli eventi del comune, aggiornata ogni giorno.`,
    priceLabel: 'Prezzo',
    freeLabel: 'Gratis',
    recurringLabel: 'Evento ricorrente',
    addressLabel: 'Indirizzo',
    mapLinkLabel: (place: string) => `Apri ${place} su OpenStreetMap`,
    descriptionTitle: 'Descrizione',
  },
  en: {
    metaTitle: (t, c) => `${t} — ${c} (Ticino) | Events`,
    metaDesc: (t, c, w) => `${t}: ${w} in ${c}, Ticino. Date, time, venue and a link to the event’s official site.`,
    whenLabel: 'When',
    whereLabel: 'Where',
    catLabel: 'Category',
    comuneLabel: 'Municipality',
    lede: (w, ti, v, c) => `${w}${ti} — ${v ? `${v}, ` : ''}${c}, Ticino.`,
    officialSite: 'Event’s official website',
    aboutTitle: 'About this event',
    about: (t, c, w, cat, venue) =>
      `${t} is a ${cat} event taking place ${w} in ${c}${venue ? ` – ${venue}` : ''}, Ticino. This page gathers the essentials — date, time and venue — collected from the local agenda. For full details, ticketing and last-minute updates, refer to the event’s official website.`,
    practicalTitle: 'Practical information',
    practical: (c) =>
      `${c} is reachable by car and by Ticino public transport. Plan to arrive a little early, especially for evening and weekend events, and always check for changes on the official site before setting off.`,
    moreTitle: (c) => `More events in ${c}`,
    allInComune: (c) => `All events in ${c}`,
    faqQ1: (t) => `When does ${t} take place?`,
    faqA1: (c, w) => `The event takes place ${w} in ${c}, Ticino. Check the current date and time on the official site.`,
    faqQ2: (c) => `Where can I find other events in ${c}?`,
    faqA2: (c) => `The ${c} page lists the full agenda of events in the municipality, refreshed daily.`,
    priceLabel: 'Price',
    freeLabel: 'Free',
    recurringLabel: 'Recurring event',
    addressLabel: 'Address',
    mapLinkLabel: (place: string) => `Open ${place} on OpenStreetMap`,
    descriptionTitle: 'Description',
  },
  de: {
    metaTitle: (t, c) => `${t} — ${c} (Tessin) | Veranstaltungen`,
    metaDesc: (t, c, w) => `${t}: ${w} in ${c}, Tessin. Datum, Uhrzeit, Ort und Link zur offiziellen Website der Veranstaltung.`,
    whenLabel: 'Wann',
    whereLabel: 'Wo',
    catLabel: 'Kategorie',
    comuneLabel: 'Gemeinde',
    lede: (w, ti, v, c) => `${w}${ti} — ${v ? `${v}, ` : ''}${c}, Tessin.`,
    officialSite: 'Offizielle Website der Veranstaltung',
    aboutTitle: 'Über diese Veranstaltung',
    about: (t, c, w, cat, venue) =>
      `${t} ist eine ${cat}-Veranstaltung am ${w} in ${c}${venue ? ` – ${venue}` : ''}, Tessin. Diese Seite fasst das Wesentliche zusammen — Datum, Uhrzeit und Ort — aus der regionalen Agenda. Für vollständige Details, Tickets und kurzfristige Änderungen konsultieren Sie die offizielle Website der Veranstaltung.`,
    practicalTitle: 'Praktische Informationen',
    practical: (c) =>
      `${c} ist mit dem Auto und mit dem Tessiner öffentlichen Verkehr erreichbar. Planen Sie etwas Vorlauf ein, besonders bei Abend- und Wochenendveranstaltungen, und prüfen Sie vor der Abreise mögliche Änderungen auf der offiziellen Website.`,
    moreTitle: (c) => `Weitere Veranstaltungen in ${c}`,
    allInComune: (c) => `Alle Veranstaltungen in ${c}`,
    faqQ1: (t) => `Wann findet ${t} statt?`,
    faqA1: (c, w) => `Die Veranstaltung findet ${w} in ${c}, Tessin, statt. Prüfen Sie Datum und Uhrzeit auf der offiziellen Website.`,
    faqQ2: (c) => `Wo finde ich weitere Veranstaltungen in ${c}?`,
    faqA2: (c) => `Auf der Seite zu ${c} finden Sie die vollständige, täglich aktualisierte Veranstaltungsagenda der Gemeinde.`,
    priceLabel: 'Preis',
    freeLabel: 'Gratis',
    recurringLabel: 'Wiederkehrende Veranstaltung',
    addressLabel: 'Adresse',
    mapLinkLabel: (place: string) => `${place} auf OpenStreetMap öffnen`,
    descriptionTitle: 'Beschreibung',
  },
  fr: {
    metaTitle: (t, c) => `${t} — ${c} (Tessin) | Événements`,
    metaDesc: (t, c, w) => `${t} : ${w} à ${c}, au Tessin. Date, heure, lieu et lien vers le site officiel de l’événement.`,
    whenLabel: 'Quand',
    whereLabel: 'Où',
    catLabel: 'Catégorie',
    comuneLabel: 'Commune',
    lede: (w, ti, v, c) => `${w}${ti} — ${v ? `${v}, ` : ''}${c}, au Tessin.`,
    officialSite: 'Site officiel de l’événement',
    aboutTitle: 'À propos de cet événement',
    about: (t, c, w, cat, venue) =>
      `${t} est un événement de type ${cat} prévu ${w} à ${c}${venue ? ` – ${venue}` : ''}, au Tessin. Cette page rassemble l’essentiel — date, heure et lieu — à partir de l’agenda régional. Pour tous les détails, la billetterie et les mises à jour de dernière minute, référez-vous au site officiel de l’événement.`,
    practicalTitle: 'Informations pratiques',
    practical: (c) =>
      `${c} est accessible en voiture et par les transports publics tessinois. Prévoyez d’arriver un peu en avance, surtout pour les événements en soirée et le week-end, et vérifiez toujours les changements sur le site officiel avant de partir.`,
    moreTitle: (c) => `Autres événements à ${c}`,
    allInComune: (c) => `Tous les événements à ${c}`,
    faqQ1: (t) => `Quand a lieu ${t} ?`,
    faqA1: (c, w) => `L’événement a lieu ${w} à ${c}, au Tessin. Vérifiez la date et l’heure sur le site officiel.`,
    faqQ2: (c) => `Où trouver d’autres événements à ${c} ?`,
    faqA2: (c) => `La page dédiée à ${c} liste l’agenda complet des événements de la commune, mis à jour chaque jour.`,
    priceLabel: 'Prix',
    freeLabel: 'Gratuit',
    recurringLabel: 'Événement récurrent',
    addressLabel: 'Adresse',
    mapLinkLabel: (place: string) => `Ouvrir ${place} sur OpenStreetMap`,
    descriptionTitle: 'Description',
  },
};

const detailCopyCache = new Map<string, DetailCopy>();
/** Same TI-verbatim / non-TI-substituted split as `copyFor`, for the
 * per-event detail page copy. The new Task C fields (priceLabel, freeLabel,
 * recurringLabel, addressLabel, mapLinkLabel, descriptionTitle) never
 * mention the canton, so they pass through unchanged for every canton. */
function detailCopyFor(canton: string, locale: Locale): DetailCopy {
  if (canton.toUpperCase() === 'TI') return DETAIL_COPY[locale];
  const cacheKey = `${canton}|${locale}`;
  const cached = detailCopyCache.get(cacheKey);
  if (cached) return cached;
  const rules = cantonSubstitutionRules(canton, locale);
  const base = DETAIL_COPY[locale];
  const sub = (s: string) => applyCantonSubstitution(s, rules);
  const out: DetailCopy = {
    ...base,
    metaTitle: (t: string, c: string) => sub(base.metaTitle(t, c)),
    metaDesc: (t: string, c: string, w: string) => sub(base.metaDesc(t, c, w)),
    lede: (w: string, ti: string, v: string, c: string) => sub(base.lede(w, ti, v, c)),
    about: (t: string, c: string, w: string, cat: string, venue?: string) => sub(base.about(t, c, w, cat, venue)),
    practical: (c: string) => sub(base.practical(c)),
    faqA1: (c: string, w: string) => sub(base.faqA1(c, w)),
  };
  detailCopyCache.set(cacheKey, out);
  return out;
}

/** Plain OpenStreetMap link — precise pin when the event has coordinates,
 * else a text search fallback from address/venue/comune. No embed script, no
 * third-party tracker/iframe: a `nofollow` outbound link, same policy as the
 * official-site CTA and the source attribution links. */
function osmLink(event: SiteEvent, comune: string): { href: string; place: string } {
  const place = event.venue || event.address?.street || comune;
  if (event.geo) {
    return { href: `https://www.openstreetmap.org/?mlat=${event.geo.lat}&mlon=${event.geo.lng}#map=16/${event.geo.lat}/${event.geo.lng}`, place };
  }
  const query = [event.address?.street, event.address?.postalCode, comune].filter(Boolean).join(', ') || `${place}, ${comune}`;
  return { href: `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`, place };
}

function priceLine(event: SiteEvent, dc: DetailCopy): string {
  // Same confidence gate as eventLd()'s `offers`: an ambiguous price (present
  // but not machine-parseable, e.g. "su richiesta") renders nothing rather
  // than a bare "CHF" with no amount.
  if (!hasConfidentPrice(event.price)) return '';
  const value = event.price!.isFree ? dc.freeLabel : `${event.price!.currency || 'CHF'} ${event.price!.amount}`.trim();
  return renderMetric(dc.priceLabel, esc(value));
}

function addressLine(event: SiteEvent, dc: DetailCopy): string {
  if (!event.address?.street && !event.address?.postalCode) return '';
  const value = [event.address.street, event.address.postalCode].filter(Boolean).join(', ');
  return renderMetric(dc.addressLabel, esc(value));
}

/** Combined address + map card ("visualizza direttamente l'indirizzo e la
 * mappa nella pagina" ask): always shows venue/address text, embeds a plain
 * OpenStreetMap iframe only when the event has real coordinates — never a
 * fabricated pin from a text search. Google Maps is never embedded (same
 * outbound-link policy as `osmLink`). */
function renderLocationCard(event: SiteEvent, comune: string, dc: DetailCopy, map: { href: string; place: string }): string {
  const addressText =
    event.address?.street || event.address?.postalCode ? [event.address.street, event.address.postalCode].filter(Boolean).join(', ') : '';
  const venueOrComune = event.venue || comune;
  const embed = event.geo
    ? `<div class="aspect-video w-full overflow-hidden bg-surface-raised"><iframe src="${esc(osmEmbedSrc(event.geo.lat, event.geo.lng))}" width="100%" height="100%" style="border:0;display:block;width:100%;height:100%" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="${esc(dc.mapLinkLabel(map.place))}" aria-label="${esc(dc.mapLinkLabel(map.place))}"></iframe></div>`
    : '';
  return `<section class="mt-6 overflow-hidden rounded-lg border border-edge bg-surface">
    ${embed}
    <div class="p-5">
      <h2 class="flex items-center gap-2 text-lg font-bold text-heading"><span aria-hidden="true">📍</span> ${esc(dc.whereLabel)}</h2>
      <p class="mt-2 text-sm leading-6 text-body">${esc(venueOrComune)}${addressText ? ` · ${esc(addressText)}` : ''}</p>
      <a class="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${esc(map.href)}" rel="nofollow noopener" target="_blank" aria-label="${esc(dc.mapLinkLabel(map.place))}">${esc(dc.mapLinkLabel(map.place))} →</a>
    </div>
  </section>`;
}

export function renderEventDetailPage(params: {
  locale: Locale;
  event: SiteEvent;
  comune: string;
  eventSlug: string;
  sameComuneEvents: SiteEvent[];
  dateStamp: string;
  distDir: string;
  detailHref: DetailHref;
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, event, comune, eventSlug, sameComuneEvents, dateStamp, distDir, detailHref } = params;
  const canton = (event.canton || 'TI').toUpperCase();
  const title = localizedTitle(event, locale);
  const copy = copyFor(canton, locale);
  const dc = detailCopyFor(canton, locale);
  const canonicalPath = pathForEventDetail(locale, comune, eventSlug, canton);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const comunePath = pathFor(locale, canton, comune);
  const when = humanDate(event.startDate, locale);
  const time = event.startTime ? ` · ${esc(event.startTime)}` : '';
  const cat = categoryLabel(event.category, locale);
  const others = sameComuneEvents.filter((e) => e.id !== event.id).slice(0, 6);
  const map = osmLink(event, comune);
  const description = localizedDescription(event, locale);
  const visual = categoryVisual(event.category);
  // `imageUrl` only ever holds a mirrored site-relative path — see the same
  // guard in `renderEventCard`/`mirroredEventImageObject`.
  const heroImage =
    event.imageUrl && event.imageUrl.startsWith('/')
      ? `<div class="mb-4 overflow-hidden rounded-lg border border-edge"><img class="aspect-[21/9] w-full object-cover" src="${esc(event.imageUrl)}" width="1200" height="514" loading="eager" fetchpriority="high" alt="${esc(title)}"></div>`
      : '';

  const body = `<div class="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${comunePath}">${esc(comune)}</a>
      <span class="mx-2">/</span>
      <span>${esc(title)}</span>
    </nav>

    ${heroImage}

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <span class="inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CHIP_CLASSES[visual.tone]}">${visual.emoji} ${esc(cat)}</span>
      ${event.recurring ? `<span class="ml-2 inline-block rounded-full border border-edge bg-surface-raised px-2.5 py-0.5 text-xs font-semibold text-heading">${esc(dc.recurringLabel)}</span>` : ''}
      <h1 class="mt-3 text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(title)}</h1>
      <p class="mt-3 text-base leading-7 text-body">${esc(dc.lede(when, time, event.venue ? event.venue : '', comune))}</p>
      ${description ? `<p class="mt-3 text-sm leading-6 text-body">${esc(description)}</p>` : ''}
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2">
      ${renderMetric(dc.whenLabel, `${esc(when)}${time}`)}
      ${renderMetric(dc.whereLabel, esc(event.venue || comune))}
      ${renderMetric(dc.catLabel, esc(cat))}
      ${renderMetric(dc.comuneLabel, esc(comune))}
      ${priceLine(event, dc)}
      ${addressLine(event, dc)}
    </dl>

    ${renderLocationCard(event, comune, dc, map)}

    <section class="mt-6 flex flex-wrap gap-3">
      <a class="inline-flex items-center gap-2 rounded-md border border-info-border bg-info-subtle px-4 py-2 text-sm font-semibold text-info hover:bg-info-subtle/80" href="${esc(event.url)}" rel="nofollow noopener" target="_blank">${esc(dc.officialSite)} →</a>
      <a class="inline-flex items-center gap-2 rounded-md border border-edge px-4 py-2 text-sm font-semibold text-link hover:text-link-hover" href="${comunePath}">${esc(dc.allInComune(comune))} →</a>
    </section>

    <section class="mt-8">
      <h2 class="text-2xl font-bold text-heading">${esc(dc.aboutTitle)}</h2>
      <p class="mt-3 text-base leading-7 text-body">${esc(dc.about(title, comune, `${when}${event.startTime ? ` (${event.startTime})` : ''}`, cat, event.venue))}</p>
      ${description ? `<h3 class="mt-4 text-lg font-semibold text-heading">${esc(dc.descriptionTitle)}</h3><p class="mt-2 text-base leading-7 text-body">${esc(description)}</p>` : ''}
    </section>

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(dc.practicalTitle)}</h2>
      <p class="mt-3 text-sm leading-6 text-body">${esc(dc.practical(comune))}</p>
    </section>

    ${
      others.length > 0
        ? `<section class="mt-8">
      <h2 class="text-2xl font-bold text-heading">${esc(dc.moreTitle(comune))}</h2>
      <div class="mt-4">${renderEventList(others, locale, detailHref)}</div>
    </section>`
        : ''
    }

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: dc.faqQ1(title), a: dc.faqA1(comune, when) },
        { q: dc.faqQ2(comune), a: dc.faqA2(comune) },
      ],
      copy.faqTitle,
    )}
  </div>`;

  const eventLdScript = inlineScriptJson(eventLd(event, locale, canonicalUrl));
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale, canton)}` },
      { '@type': 'ListItem', position: 3, name: comune, item: `${BASE_URL}${comunePath}` },
      { '@type': 'ListItem', position: 4, name: title, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: dc.faqQ1(title), acceptedAnswer: { '@type': 'Answer', text: dc.faqA1(comune, when) } },
      { '@type': 'Question', name: dc.faqQ2(comune), acceptedAnswer: { '@type': 'Answer', text: dc.faqA2(comune) } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const html = buildSeoPageHtml({
    locale,
    title: dc.metaTitle(title, comune),
    description: dc.metaDesc(title, comune, when),
    canonicalUrl,
    hreflangHtml: buildEventAlternates(canton, comune, eventSlug),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml: body,
    jsonLdScripts: [eventLdScript, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

// ── Time-window digests (weekend / this week) ───────────────────────────────
// Lightweight "what's on" roundup pages, refreshed daily with the crawler. They
// satisfy the issue's "eventi nel weekend" digest ask as fully-controlled SEO
// surfaces (no blog-monolith dependency) and feed the same Event JSON-LD.

interface DigestDef {
  key: string;
  slug: Record<Locale, string>;
  filter: (events: SiteEvent[], ctx: { todayIso: string }) => SiteEvent[];
  copy: Record<Locale, { title: string; h1: string; lede: string; desc: string; faqQ: string; faqA: string }>;
}

// `overlapsWindow` + `weekendWindow` now live in scripts/lib/events-utils.mjs so
// the SSG plugin, the FB digest poster and the weekly digest article generator
// share one definition (AGENTS.md §6 — duplicated date math caused the prior
// Sat/Sun weekend regression; one source of truth makes that drift impossible).

export const DIGESTS: DigestDef[] = [
  {
    key: 'weekend',
    slug: EVENTS_DIGEST_SLUGS.weekend,
    filter: (events, { todayIso }) => {
      const { start, end } = weekendWindow(todayIso);
      return events.filter((e) => overlapsWindow(e, start, end));
    },
    copy: {
      it: {
        title: 'Cosa fare questo weekend in Ticino: eventi sabato e domenica',
        h1: 'Eventi questo weekend in Ticino',
        lede: 'Concerti, mostre, feste e appuntamenti di sabato e domenica in tutto il Ticino, aggiornati ogni giorno.',
        desc: 'Cosa fare questo weekend in Ticino: tutti gli eventi di sabato e domenica (concerti, mostre, feste) con data, orario, luogo e comune.',
        faqQ: 'Quali eventi ci sono questo weekend in Ticino?',
        faqA: 'Questa pagina raccoglie gli eventi di sabato e domenica in tutto il Ticino, aggiornati ogni giorno dalle agende ufficiali. Filtra per comune dalle schede collegate.',
      },
      en: {
        title: 'What to do this weekend in Ticino: Saturday & Sunday events',
        h1: 'Events this weekend in Ticino',
        lede: 'Concerts, exhibitions, festivals and happenings across Ticino this Saturday and Sunday, refreshed daily.',
        desc: 'What to do this weekend in Ticino: every Saturday and Sunday event (concerts, exhibitions, festivals) with date, time, venue and municipality.',
        faqQ: 'What events are on this weekend in Ticino?',
        faqA: 'This page gathers Saturday and Sunday events across Ticino, refreshed daily from the official agendas. Filter by municipality via the linked profiles.',
      },
      de: {
        title: 'Was am Wochenende im Tessin los ist: Veranstaltungen Sa & So',
        h1: 'Veranstaltungen am Wochenende im Tessin',
        lede: 'Konzerte, Ausstellungen, Feste und Anlässe am Samstag und Sonntag im ganzen Tessin, täglich aktualisiert.',
        desc: 'Was am Wochenende im Tessin los ist: alle Anlässe von Samstag und Sonntag (Konzerte, Ausstellungen, Feste) mit Datum, Zeit, Ort und Gemeinde.',
        faqQ: 'Welche Veranstaltungen gibt es am Wochenende im Tessin?',
        faqA: 'Diese Seite sammelt die Anlässe von Samstag und Sonntag im Tessin, täglich aus den offiziellen Agenden aktualisiert. Nach Gemeinde über die verlinkten Profile filtern.',
      },
      fr: {
        title: 'Que faire ce week-end au Tessin: événements samedi & dimanche',
        h1: 'Événements ce week-end au Tessin',
        lede: 'Concerts, expositions, fêtes et rendez-vous du samedi et dimanche dans tout le Tessin, mis à jour chaque jour.',
        desc: 'Que faire ce week-end au Tessin: tous les événements du samedi et dimanche (concerts, expositions, fêtes) avec date, horaire, lieu et commune.',
        faqQ: 'Quels événements ont lieu ce week-end au Tessin?',
        faqA: 'Cette page rassemble les événements du samedi et dimanche au Tessin, mis à jour chaque jour depuis les agendas officiels. Filtrez par commune via les fiches liées.',
      },
    },
  },
  {
    key: 'week',
    slug: EVENTS_DIGEST_SLUGS.week,
    filter: (events, { todayIso }) => {
      const { start, end } = weekWindow(todayIso);
      return events.filter((e) => overlapsWindow(e, start, end));
    },
    copy: {
      it: {
        title: 'Eventi questa settimana in Ticino: agenda dei prossimi 7 giorni',
        h1: 'Eventi questa settimana in Ticino',
        lede: 'Tutti gli appuntamenti dei prossimi 7 giorni in Ticino: concerti, mostre, feste e incontri, aggiornati ogni giorno.',
        desc: 'Eventi questa settimana in Ticino: agenda dei prossimi 7 giorni con concerti, mostre, feste e appuntamenti per comune.',
        faqQ: 'Quali eventi ci sono questa settimana in Ticino?',
        faqA: 'Questa pagina elenca gli eventi dei prossimi 7 giorni in tutto il Ticino, aggiornati ogni giorno dalle agende ufficiali.',
      },
      en: {
        title: 'Events this week in Ticino: the next 7 days agenda',
        h1: 'Events this week in Ticino',
        lede: 'Everything on over the next 7 days in Ticino: concerts, exhibitions, festivals and meet-ups, refreshed daily.',
        desc: 'Events this week in Ticino: the next 7 days agenda with concerts, exhibitions, festivals and happenings by municipality.',
        faqQ: 'What events are on this week in Ticino?',
        faqA: 'This page lists events over the next 7 days across Ticino, refreshed daily from the official agendas.',
      },
      de: {
        title: 'Veranstaltungen diese Woche im Tessin: Agenda der nächsten 7 Tage',
        h1: 'Veranstaltungen diese Woche im Tessin',
        lede: 'Alle Anlässe der nächsten 7 Tage im Tessin: Konzerte, Ausstellungen, Feste und Treffen, täglich aktualisiert.',
        desc: 'Veranstaltungen diese Woche im Tessin: Agenda der nächsten 7 Tage mit Konzerten, Ausstellungen, Festen und Anlässen nach Gemeinde.',
        faqQ: 'Welche Veranstaltungen gibt es diese Woche im Tessin?',
        faqA: 'Diese Seite listet die Anlässe der nächsten 7 Tage im Tessin, täglich aus den offiziellen Agenden aktualisiert.',
      },
      fr: {
        title: 'Événements cette semaine au Tessin: agenda des 7 prochains jours',
        h1: 'Événements cette semaine au Tessin',
        lede: 'Tous les rendez-vous des 7 prochains jours au Tessin: concerts, expositions, fêtes et rencontres, mis à jour chaque jour.',
        desc: 'Événements cette semaine au Tessin: agenda des 7 prochains jours avec concerts, expositions, fêtes et rendez-vous par commune.',
        faqQ: 'Quels événements ont lieu cette semaine au Tessin?',
        faqA: 'Cette page liste les événements des 7 prochains jours au Tessin, mis à jour chaque jour depuis les agendas officiels.',
      },
    },
  },
];

function pathForDigest(locale: Locale, canton: string, slug: Record<Locale, string>): string {
  return `${basePathFor(canton)[locale]}/${slug[locale]}/`;
}

function buildDigestAlternates(canton: string, slug: Record<Locale, string>): string {
  return LOCALES.map((locale) => ` <link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathForDigest(locale, canton, slug)}">`)
    .concat(` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathForDigest('it', canton, slug)}">`)
    .join('\n');
}

/** Hub nav linking the digest pages — keeps them BFS-reachable (hub → digest). */
function renderDigestNav(locale: Locale, canton: string): string {
  const links = DIGESTS.map(
    (d) =>
      `<a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading hover:border-accent-border" href="${pathForDigest(locale, canton, d.slug)}">${esc(digestCopyFor(d, canton, locale).h1)}</a>`,
  ).join('');
  return `<section class="mt-6 grid gap-3 sm:grid-cols-2">${links}</section>`;
}

export function renderDigestPage(params: {
  def: DigestDef;
  locale: Locale;
  canton: string;
  events: SiteEvent[];
  dateStamp: string;
  distDir: string;
  detailHref?: DetailHref;
}): { urlPath: string; html: string; wordCount: number } {
  const { def, locale, canton, events, dateStamp, distDir, detailHref } = params;
  const copy = copyFor(canton, locale);
  const dc = digestCopyFor(def, canton, locale);
  const canonicalPath = pathForDigest(locale, canton, def.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const list = events.slice(0, 60);
  const byComune = groupByComune(events) as Map<string, SiteEvent[]>;

  const comuneGrid = [...byComune.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(
      ([comune, l]) =>
        `<a class="rounded-md border border-edge bg-surface p-4 hover:border-accent-border" href="${pathFor(locale, canton, comune)}"><span class="block text-sm font-semibold text-heading">${esc(comune)}</span><span class="mt-1 block text-xs text-muted">${l.length} ${esc(copy.eventsWord)}</span></a>`,
    )
    .join('');

  const body = `<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(dc.h1)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <h1 class="max-w-4xl text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(dc.h1)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(dc.lede)}</p>
      <p class="mt-3 text-sm text-muted">${renderSourceAttribution(events, copy, dateStamp)}</p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-3">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statComuni, String(byComune.size))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    <section class="mt-8">
      <h2 class="text-2xl font-bold text-heading">${esc(dc.h1)}</h2>
      <div class="mt-4">${renderEventList(list, locale, detailHref)}</div>
    </section>

    ${
      comuneGrid
        ? `<section class="mt-8 rounded-md border border-edge bg-surface p-5"><h2 class="text-2xl font-bold text-heading">${esc(copy.byComune)}</h2><div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${comuneGrid}</div></section>`
        : ''
    }

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <a class="inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.allEvents)} →</a>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq([{ q: dc.faqQ, a: dc.faqA }], copy.faqTitle)}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <h2 class="text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: dc.title,
    itemListElement: list.map((event, i) => ({ '@type': 'ListItem', position: i + 1, item: eventLd(event, locale) })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale, canton)}` },
      { '@type': 'ListItem', position: 3, name: dc.h1, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [{ '@type': 'Question', name: dc.faqQ, acceptedAnswer: { '@type': 'Answer', text: dc.faqA } }],
  });

  const wordCount = countHtmlBodyWords(body);
  const html = buildSeoPageHtml({
    locale,
    title: dc.title,
    description: dc.desc,
    canonicalUrl,
    hreflangHtml: buildDigestAlternates(canton, def.slug),
    // A digest is only worth indexing when it actually lists events: the static
    // chrome (lede + methodology + FAQ) alone always clears MIN_INDEXABLE_WORDS,
    // so an EMPTY window must be gated on events.length, not the body word count
    // (else a "no events this weekend" page gets indexed + sitemapped).
    robots: events.length > 0 && wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml: body,
    jsonLdScripts: [itemListLd, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

function buildSitemap(
  perCanton: Array<{ canton: string; comuni: string[]; digests: DigestDef[] }>,
  dateStamp: string,
  detailEntries: Array<{ canton: string; comune: string; slug: string }> = [],
): string {
  const entries: string[] = [];
  for (const { canton, comuni, digests } of perCanton) {
    // Hub
    entries.push(sitemapUrl(canton, undefined, dateStamp, '0.7'));
    // Time-window digests (only the indexable ones)
    for (const d of digests) entries.push(digestSitemapUrl(canton, d.slug, dateStamp));
    for (const comune of comuni) entries.push(sitemapUrl(canton, comune, dateStamp, '0.5'));
  }
  // Per-event detail pages
  for (const e of detailEntries) entries.push(eventDetailSitemapUrl(e.canton, e.comune, e.slug, dateStamp));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
}

function eventDetailSitemapUrl(canton: string, comune: string, slug: string, dateStamp: string): string {
  const alternates = LOCALES.map(
    (locale) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathForEventDetail(locale, comune, slug, canton)}" />`,
  )
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathForEventDetail('it', comune, slug, canton)}" />`)
    .join('\n');
  return `  <url>\n    <loc>${BASE_URL}${pathForEventDetail('it', comune, slug, canton)}</loc>\n${alternates}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.4</priority>\n  </url>`;
}

function digestSitemapUrl(canton: string, slug: Record<Locale, string>, dateStamp: string): string {
  const alternates = LOCALES.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathForDigest(locale, canton, slug)}" />`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathForDigest('it', canton, slug)}" />`)
    .join('\n');
  return `  <url>\n    <loc>${BASE_URL}${pathForDigest('it', canton, slug)}</loc>\n${alternates}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`;
}

function sitemapUrl(canton: string, comune: string | undefined, dateStamp: string, priority: string): string {
  const alternates = LOCALES.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathFor(locale, canton, comune)}" />`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathFor('it', canton, comune)}" />`)
    .join('\n');
  return `  <url>\n    <loc>${BASE_URL}${pathFor('it', canton, comune)}</loc>\n${alternates}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}

// Per-locale hub index files to patch with an inbound link to the events hub,
// so every locale's events hub is BFS-reachable from `/` (not only IT). Each
// locale gets its section landing + its border-municipality hub.
const INBOUND_HUBS: Record<Locale, string[]> = {
  it: ['vivere-in-ticino/index.html', 'vivere-in-ticino/comuni-di-frontiera/index.html'],
  en: ['en/living-in-ticino/index.html', 'en/living-in-ticino/border-municipalities/index.html'],
  de: ['de/leben-im-tessin/index.html', 'de/leben-im-tessin/grenzgemeinden/index.html'],
  fr: ['fr/vivre-au-tessin/index.html', 'fr/vivre-au-tessin/communes-frontiere/index.html'],
};

/** Inject a localized "Eventi in Ticino" inbound link into an existing hub page
 * so the events hub for `locale` is reachable by BFS from `/` (depth ≤ 2).
 * Idempotent; silently skips a hub that doesn't exist or lacks an injection
 * point. Returns true when the link was injected. */
function patchInboundLink(distDir: string, relIndex: string, locale: Locale): boolean {
  const file = path.join(distDir, relIndex);
  if (!fs.existsSync(file)) return false;
  let html = fs.readFileSync(file, 'utf-8');
  if (html.includes('data-events-hub-link="1"')) return true;
  const copy = COPY[locale];
  const block = `<section data-events-hub-link="1" class="my-8 rounded-md border border-edge bg-surface p-5">
    <h2 class="text-2xl font-bold text-heading">${esc(copy.hubH1)}</h2>
    <p class="mt-2 max-w-3xl text-sm leading-6 text-body">${esc(copy.hubLede)}</p>
    <a class="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale, 'TI')}">${esc(copy.allEvents)} →</a>
  </section>`;
  if (html.includes('</main>')) {
    html = html.replace('</main>', `${block}</main>`);
  } else if (html.includes('</article>')) {
    html = html.replace('</article>', `${block}</article>`);
  } else {
    return false;
  }
  fs.writeFileSync(file, html, 'utf-8');
  return true;
}

export function eventsSeoPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'events-seo-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_EVENTS_PAGES === '1') {
        console.log('\x1b[36m[events-pages]\x1b[0m skipped (SKIP_EVENTS_PAGES=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const dateStamp = new Date().toISOString().slice(0, 10);
      const dataset = loadEventsDataset();
      const all = upcomingEvents(dataset.events, dateStamp) as SiteEvent[];

      if (all.length === 0) {
        console.log('\x1b[36m[events-pages]\x1b[0m no upcoming events in data/events.json — skipped (run scripts/crawl-tio-agenda.mjs)');
        return;
      }

      const weekendDays = weekendSet(dateStamp);

      // #3125 nationwide rollout: group events per canton FIRST (derived from
      // the actual dataset, defaulting to TI when the field is missing — so a
      // build before any non-TI crawler has run still yields exactly today's
      // TI-only pages, zero regression), then per comune within each canton.
      // Every downstream loop iterates `cantons`, not a hardcoded 'TI'.
      const byCanton = new Map<string, SiteEvent[]>();
      for (const ev of all) {
        const canton = (ev.canton || 'TI').toUpperCase();
        const arr = byCanton.get(canton) ?? [];
        arr.push(ev);
        byCanton.set(canton, arr);
      }
      const cantons = [...byCanton.keys()].sort((a, b) => (a === 'TI' ? -1 : b === 'TI' ? 1 : a.localeCompare(b)));

      // Stable, collision-free detail slug per event, scoped to (canton, comune)
      // so two different cantons sharing a comune name never share a dedup
      // bucket. Built once (locale-independent), then resolved per locale into
      // a full href for the event cards.
      const detailSlugs = new Map<string, { canton: string; comune: string; slug: string }>();
      const byCantonComune = new Map<string, Map<string, SiteEvent[]>>();
      for (const canton of cantons) {
        const byComune = groupByComune(byCanton.get(canton)!) as Map<string, SiteEvent[]>;
        byCantonComune.set(canton, byComune);
        for (const [comune, list] of byComune) {
          const used = new Set<string>();
          for (const ev of list) {
            const base = slugifyEvent(ev);
            let slug = base;
            let n = 2;
            while (used.has(slug)) slug = `${base}-${n++}`;
            used.add(slug);
            detailSlugs.set(ev.id, { canton, comune, slug });
          }
        }
      }
      const detailHrefFor =
        (locale: Locale): DetailHref =>
        (e: SiteEvent) => {
          const m = detailSlugs.get(e.id);
          return m ? pathForEventDetail(locale, m.comune, m.slug, m.canton) : null;
        };

      const collector = new WriteCollector({ distDir, pluginName: 'eventsSeoPagesPlugin' });
      let pagesWritten = 0;
      let thinPages = 0;
      let totalComuni = 0;

      const emit = (rendered: { urlPath: string; html: string; wordCount: number }) => {
        if (rendered.wordCount < MIN_INDEXABLE_WORDS) thinPages += 1;
        const indexPath = path.join(distDir, rendered.urlPath, 'index.html');
        const flatPath = path.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, rendered.html);
        collector.add(flatPath, rendered.html);
        pagesWritten += 1;
      };

      const perCantonSitemap: Array<{ canton: string; comuni: string[]; digests: DigestDef[] }> = [];

      for (const canton of cantons) {
        const events = byCanton.get(canton)!;
        const byComune = byCantonComune.get(canton)!;
        const comuni = [...byComune.keys()].sort((a, b) => a.localeCompare(b));
        totalComuni += comuni.length;
        const otherCantons = cantons.filter((c) => c !== canton);

        // The digest filter is locale-independent (it only reads the date), so
        // compute each window's events ONCE per canton. A digest is indexed +
        // sitemapped ONLY when it actually lists events — an empty window
        // renders noindex,follow and is left out of the sitemap (gated on
        // events.length, since the static chrome alone always clears
        // MIN_INDEXABLE_WORDS). Shared across locales, so all 4 hreflang
        // alternates stay consistent (no noindex straddle).
        const digestEvents = new Map(DIGESTS.map((d) => [d.key, d.filter(events, { todayIso: dateStamp })]));

        for (const locale of LOCALES) {
          const detailHref = detailHrefFor(locale);
          emit(renderHubPage({ locale, canton, events, byComune, dateStamp, weekendDays, distDir, detailHref, otherCantons }));
          for (const comune of comuni) {
            const list = byComune.get(comune)!;
            emit(renderComunePage({ locale, canton, comune, events: list, dateStamp, weekendDays, distDir, detailHref }));
            // One indexable detail page per event under its comune.
            for (const ev of list) {
              const eventSlug = detailSlugs.get(ev.id)!.slug;
              emit(
                renderEventDetailPage({
                  locale,
                  event: ev,
                  comune,
                  eventSlug,
                  sameComuneEvents: list,
                  dateStamp,
                  distDir,
                  detailHref,
                }),
              );
            }
          }
          // Emitted even when empty (the page degrades to a "no events" notice +
          // comune links) so the URL is stable for FB linking, but noindex.
          for (const def of DIGESTS) {
            emit(renderDigestPage({ def, locale, canton, events: digestEvents.get(def.key)!, dateStamp, distDir, detailHref }));
          }
        }

        perCantonSitemap.push({
          canton,
          comuni,
          digests: DIGESTS.filter((d) => (digestEvents.get(d.key)?.length ?? 0) > 0),
        });
      }

      const detailEntries = [...detailSlugs.values()];
      const sitemapXml = buildSitemap(perCantonSitemap, dateStamp, detailEntries);
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, SITEMAP_NAME), sitemapXml, 'utf-8');

      const t0 = Date.now();
      const flushed = await collector.flush();

      // Inbound BFS links must be injected AFTER staticPagesPlugin has emitted
      // the hub index.html files (enforce:'post' + this await). Patch every
      // locale's hubs so en/de/fr event hubs are reachable by internal link,
      // not only via sitemap/hreflang.
      await staticPagesFlushed;
      const reached: Locale[] = [];
      for (const locale of LOCALES) {
        const ok = INBOUND_HUBS[locale].map((rel) => patchInboundLink(distDir, rel, locale)).some(Boolean);
        if (ok) reached.push(locale);
      }
      const missing = LOCALES.filter((l) => !reached.includes(l));
      if (missing.length) {
        console.log(`\x1b[33m[events-pages]\x1b[0m WARNING: no inbound hub link injected for locale(s) ${missing.join(',')} — events hub reachable only via sitemap`);
      }

      console.log(
        `\x1b[36m[events-pages]\x1b[0m Generated ${pagesWritten} pages (${totalComuni} comuni × ${cantons.length} canton(s) × ${LOCALES.length} locales + hubs) from ${all.length} events — flushed ${flushed} files in ${((Date.now() - t0) / 1000).toFixed(1)}s${thinPages ? ` (${thinPages} thin → noindex)` : ''} — inbound link locales: ${reached.join(',') || 'none'}`,
      );
    },
  };
}
