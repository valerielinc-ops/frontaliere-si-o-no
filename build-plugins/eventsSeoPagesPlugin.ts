/**
 * Static SEO pages for events, nationwide (#3125), grouped by canton then comune.
 *
 * Emits:
 *   - Swiss-wide index →  /eventi/                            (+ /en|/de|/fr)
 *   - canton hub       →  /eventi/ticino/                     (+ /en|/de|/fr, one per canton with events)
 *   - per comune       →  /eventi/ticino/{comune}/             (+ /en|/de|/fr)
 *   - weekend/week digest, per canton, and per-event detail pages (see below)
 *
 * Data source: data/events.json (assembled from per-source crawler slices by
 * scripts/assemble-events-dataset.mjs; MVP source = scripts/crawl-tio-agenda.mjs,
 * canton-scoped to TI; nationwide sources — guidle, myswitzerland, ge-agenda —
 * carry their own resolved canton). Each event carries a comune resolved by
 * scripts/lib/events-utils.mjs; events without a confident comune still appear
 * on their canton hub but never invent a comune page (see the "other events"
 * bucket page below).
 *
 * SEO contract (mirrors borderMunicipalityPagesPlugin + docs/SEO-GATES.md):
 *   - buildSeoPageHtml shell, hubKey 'vita' chrome, seoContentOutsideRoot
 *   - complete schema.org/Event JSON-LD per event (name/startDate/eventStatus/
 *     eventAttendanceMode/location.address.addressLocality/description≥30/
 *     image/organizer{name,url}/performer{name}/offers{…}) — deploy-blocking
 *     validate-structured-data-completeness.mjs requires every field
 *   - BreadcrumbList + FAQPage JSON-LD, full hreflang (it/en/de/fr + x-default)
 *   - own sitemap-eventi.xml (picked up automatically by sitemapAliasPlugin) —
 *     single un-sharded file; see the size-evaluation comment on buildSitemap
 *   - BFS reachability: inbound links injected into the /vivere-in-ticino/ and
 *     /vivere-in-ticino/comuni-di-frontiera/ hubs (TI, always present) point
 *     to the TI canton hub (unchanged, pre-#3645 link) — every OTHER canton
 *     hub is one further hop from there via the (always-rendered, #3645)
 *     `cantonSwitcher` pills, so hub depth stays 1, comune depth 2, same as
 *     before this change. The Swiss-wide index itself is reached the other
 *     way — every canton hub's `cantonSwitcher` now also links UP to it —
 *     so it sits at depth 2 (one hop past the TI hub), well inside budget.
 *   - MIN_INDEXABLE_WORDS gate → thin pages get noindex,follow (never dropped)
 *
 * Default-on. Escape hatch: SKIP_EVENTS_PAGES=1.
 */

import fs from 'node:fs';
import { SLUG_TABLES } from '../services/routeSlugs.data';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { shouldEmitLocale, EMIT_ALL_LOCALES } from './shared/localeEmitFilter';
import { BASE_URL, BUILD_DATE_STAMP, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { truncateHeadline, TITLE_MAX_CHARS, composePlaceTitle } from './shared/titleSuffix';
import { staticPagesFlushed } from './shared/buildSignals';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { dedupeUrlsetXmlByLoc } from './shared/sitemapUrlsetDedupe';
// Shared with the crawler + assembler + tests (AGENTS.md §6 — one source of truth).
import {
  loadEventsDataset,
  upcomingEvents,
  groupByComune,
  slugifyComune,
  slugifyEvent,
  EVENT_SOURCES,
  eventsBasePathForCanton,
  EVENTS_INDEX_PATH,
  germanCantonPreposition,
  EVENTS_DIGEST_SLUGS,
  weekendWindow,
  weekWindow,
  overlapsWindow,
  hasConfidentPrice,
  OTHER_EVENTS_SEGMENT,
  OTHER_EVENTS_COMUNE_KEY,
  eventReferralUrl,
  recentlyEndedEvents,
  resolveCantonUrlKey,
  UNRESOLVED_CANTON_KEY,
  UNRESOLVED_CANTON_LABEL,
  normalizeText,
} from '../scripts/lib/events-utils.mjs';
import { getCantonLabel, type CantonLocale } from '../services/cantonList';
import { imageObjectLd, type ImageObjectLd } from '../services/seo/imageObjectLd';
import { osmEmbedSrc, CTA_PRIMARY_CLASS } from './shared/seoContentTokens';

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

// Localized base segment per canton+locale — shared with the FB poster and
// the weekend-digest article generator (AGENTS.md §6, one source of truth).
// `eventsBasePathForCanton('TI')` is byte-identical to the legacy TI-only
// constant it replaces (see tests/events-nationwide-sources.test.ts).
const basePathCache = new Map<string, Record<Locale, string>>();
function basePathFor(canton: string): Record<Locale, string> {
  // #3739: internal callers already resolve `canton` before reaching here
  // (never blank) — this default only fires if that ever regresses, so it
  // must degrade to the canton-neutral bucket, not silently mislabel Ticino.
  const code = String(canton || UNRESOLVED_CANTON_KEY).toUpperCase();
  let cached = basePathCache.get(code);
  if (!cached) {
    cached = eventsBasePathForCanton(code) as Record<Locale, string>;
    basePathCache.set(code, cached);
  }
  return cached;
}

const LOCALE_OG: Record<Locale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
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

// Notice banner for the short noindex,follow grace-window bridge page kept
// for events that already ended (see `recentlyEndedEvents` in
// scripts/lib/events-utils.mjs). Page stays live briefly for anyone who
// still lands on the URL, but is deliberately unlinked and out of the
// sitemap/Event JSON-LD — see closeBundle()'s past-events emission pass.
const PAST_EVENT_NOTICE: Record<Locale, string> = {
  it: 'Questo evento si è già svolto: le informazioni restano visibili solo per consultazione.',
  en: 'This event has already taken place — the details below are kept for reference only.',
  de: 'Diese Veranstaltung hat bereits stattgefunden — die Angaben dienen nur noch zur Information.',
  fr: 'Cet événement a déjà eu lieu — les informations ci-dessous ne sont conservées qu\'à titre de référence.',
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
    // Per-locale job-board slug — derived from shared SLUG_TABLES[locale].jobBoard
    // (#4315). Naively locale-prefixing the IT slug (e.g. /en/cerca-lavoro-ticino/)
    // 404s — router.ts only matches the CURRENT locale's own jobBoard slug (see
    // parseRoute() ~line 3191).
    href: (['it', 'en', 'de', 'fr'] as const).reduce((acc, locale) => {
      const prefix = locale === 'it' ? '' : `/${locale}`;
      acc[locale] = `${prefix}/${SLUG_TABLES[locale].jobBoard}/`;
      return acc;
    }, {} as Record<Locale, string>),
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
  // #4414: data-driven 3rd FAQ pair (hub = canton-scoped, comune = per-comune)
  // — real weekly event count + soonest upcoming event, computed at render
  // time from already-available data, instead of reusing generic boilerplate
  // on every page. Hub fields mention the canton name so they go through the
  // same `sub()` substitution as faqHubQ1/faqHubA2 above; comune fields take
  // the comune name as a parameter and never mention "Ticino", so they need
  // no substitution (same split as faqComuneQ1/A1 vs faqComuneQ2/A2).
  faqHubDynamicQ: string;
  faqHubDynamicAHasEvents: (weekCount: number, title: string, date: string) => string;
  faqHubDynamicAEmpty: string;
  faqComuneDynamicQ: (c: string) => string;
  faqComuneDynamicAHasEvents: (c: string, weekCount: number, title: string, date: string) => string;
  faqComuneDynamicAEmpty: (c: string) => string;
}

const COPY: Record<Locale, Copy> = {
  it: {
    hubTitle: 'Eventi in Ticino: agenda per comune aggiornata',
    hubH1: 'Eventi in Ticino, comune per comune',
    hubLede: 'Concerti, mostre, feste e appuntamenti in Ticino raccolti dalle agende ufficiali e raggruppati per comune.',
    comuneTitle: (c) => composePlaceTitle([
      `Eventi a ${c}: cosa fare e agenda aggiornata`,
      `Eventi a ${c}: agenda aggiornata`,
      `Eventi a ${c}`,
    ], TITLE_MAX_CHARS, (s) => esc(s).length),
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
    faqHubDynamicQ: 'Quanti eventi ci sono in Ticino questa settimana?',
    faqHubDynamicAHasEvents: (weekCount, title, date) =>
      `${weekCount} event${weekCount === 1 ? 'o' : 'i'} in programma in Ticino nei prossimi 7 giorni: il prossimo è "${title}" il ${date}${sentenceEndAfterDate(date)}`,
    faqHubDynamicAEmpty: 'Al momento non risultano eventi in programma in Ticino: l\'agenda si aggiorna ogni giorno, torna a controllare presto.',
    faqComuneDynamicQ: (c) => `Quanti eventi ci sono a ${c} questa settimana?`,
    faqComuneDynamicAHasEvents: (c, weekCount, title, date) =>
      `${weekCount} event${weekCount === 1 ? 'o' : 'i'} in programma a ${c} nei prossimi 7 giorni: il prossimo è "${title}" il ${date}${sentenceEndAfterDate(date)}`,
    faqComuneDynamicAEmpty: (c) => `Al momento non risultano eventi in programma a ${c}: l'agenda si aggiorna ogni giorno, torna a controllare presto.`,
  },
  en: {
    hubTitle: 'Events in Ticino: an agenda by municipality',
    hubH1: 'Events in Ticino, municipality by municipality',
    hubLede: 'Concerts, exhibitions, festivals and happenings across Ticino, collected from official agendas and grouped by municipality.',
    comuneTitle: (c) => composePlaceTitle([
      `Events in ${c}: what to do and the latest agenda`,
      `Events in ${c}: latest agenda`,
      `Events in ${c}`,
    ], TITLE_MAX_CHARS, (s) => esc(s).length),
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
    faqHubDynamicQ: 'How many events are on in Ticino this week?',
    faqHubDynamicAHasEvents: (weekCount, title, date) =>
      `${weekCount} event${weekCount === 1 ? '' : 's'} coming up in Ticino in the next 7 days: the next one is "${title}" on ${date}${sentenceEndAfterDate(date)}`,
    faqHubDynamicAEmpty: 'There are currently no events scheduled in Ticino: the agenda refreshes daily, check back soon.',
    faqComuneDynamicQ: (c) => `How many events are on in ${c} this week?`,
    faqComuneDynamicAHasEvents: (c, weekCount, title, date) =>
      `${weekCount} event${weekCount === 1 ? '' : 's'} coming up in ${c} in the next 7 days: the next one is "${title}" on ${date}${sentenceEndAfterDate(date)}`,
    faqComuneDynamicAEmpty: (c) => `There are currently no events scheduled in ${c}: the agenda refreshes daily, check back soon.`,
  },
  de: {
    hubTitle: 'Veranstaltungen im Tessin: Agenda nach Gemeinde',
    hubH1: 'Veranstaltungen im Tessin, Gemeinde für Gemeinde',
    hubLede: 'Konzerte, Ausstellungen, Feste und Anlässe im Tessin, aus offiziellen Agenden gesammelt und nach Gemeinde gruppiert.',
    comuneTitle: (c) => composePlaceTitle([
      `Veranstaltungen in ${c}: Programm und aktuelle Agenda`,
      `Veranstaltungen in ${c}: aktuelle Agenda`,
      `Veranstaltungen in ${c}`,
    ], TITLE_MAX_CHARS, (s) => esc(s).length),
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
    faqHubDynamicQ: 'Wie viele Veranstaltungen gibt es diese Woche im Tessin?',
    faqHubDynamicAHasEvents: (weekCount, title, date) =>
      `${weekCount} Veranstaltung${weekCount === 1 ? '' : 'en'} in den nächsten 7 Tagen im Tessin: die nächste ist „${title}" am ${date}${sentenceEndAfterDate(date)}`,
    faqHubDynamicAEmpty: 'Aktuell sind im Tessin keine Veranstaltungen geplant: Die Agenda wird täglich aktualisiert, schau bald wieder vorbei.',
    faqComuneDynamicQ: (c) => `Wie viele Veranstaltungen gibt es diese Woche in ${c}?`,
    faqComuneDynamicAHasEvents: (c, weekCount, title, date) =>
      `${weekCount} Veranstaltung${weekCount === 1 ? '' : 'en'} in den nächsten 7 Tagen in ${c}: die nächste ist „${title}" am ${date}${sentenceEndAfterDate(date)}`,
    faqComuneDynamicAEmpty: (c) => `Aktuell sind in ${c} keine Veranstaltungen geplant: Die Agenda wird täglich aktualisiert, schau bald wieder vorbei.`,
  },
  fr: {
    hubTitle: 'Événements au Tessin: agenda par commune',
    hubH1: 'Événements au Tessin, commune par commune',
    hubLede: 'Concerts, expositions, fêtes et rendez-vous au Tessin, recueillis dans les agendas officiels et regroupés par commune.',
    comuneTitle: (c) => composePlaceTitle([
      `Événements à ${c}: que faire et agenda à jour`,
      `Événements à ${c}: agenda à jour`,
      `Événements à ${c}`,
    ], TITLE_MAX_CHARS, (s) => esc(s).length),
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
    faqHubDynamicQ: 'Combien d\'événements y a-t-il au Tessin cette semaine?',
    faqHubDynamicAHasEvents: (weekCount, title, date) =>
      `${weekCount} événement${weekCount === 1 ? '' : 's'} prévu${weekCount === 1 ? '' : 's'} au Tessin dans les 7 prochains jours: le prochain est « ${title} » le ${date}${sentenceEndAfterDate(date)}`,
    faqHubDynamicAEmpty: 'Aucun événement n\'est actuellement prévu au Tessin: l\'agenda se met à jour chaque jour, revenez bientôt.',
    faqComuneDynamicQ: (c) => `Combien d'événements y a-t-il à ${c} cette semaine?`,
    faqComuneDynamicAHasEvents: (c, weekCount, title, date) =>
      `${weekCount} événement${weekCount === 1 ? '' : 's'} prévu${weekCount === 1 ? '' : 's'} à ${c} dans les 7 prochains jours: le prochain est « ${title} » le ${date}${sentenceEndAfterDate(date)}`,
    faqComuneDynamicAEmpty: (c) => `Aucun événement n'est actuellement prévu à ${c}: l'agenda se met à jour chaque jour, revenez bientôt.`,
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
// #3739: display copy for the canton-neutral bucket (`UNRESOLVED_CANTON_KEY`)
// — `getCantonLabel` only knows the 26 real BFS codes, so it would otherwise
// echo the raw sentinel string back into rendered HTML/copy. Label copy
// itself lives in events-utils.mjs (`UNRESOLVED_CANTON_LABEL`), shared with
// the FB events poster (AGENTS.md §6 — single source, no copy-paste).

/** `getCantonLabel`, but canton-neutral-bucket-aware (see `UNRESOLVED_CANTON_KEY`). */
function cantonDisplayLabel(canton: string, locale: Locale): string {
  if (canton.toUpperCase() === UNRESOLVED_CANTON_KEY) return UNRESOLVED_CANTON_LABEL[locale];
  return getCantonLabel(canton, locale as CantonLocale);
}

function cantonSubstitutionRules(canton: string, locale: Locale): Array<[RegExp, string]> {
  const display = cantonDisplayLabel(canton, locale);
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

/** Short, budget-safe fallback `hubTitle` per locale — `sub(base.hubTitle)`
 * substitutes the real canton name into a title budgeted for TI's short
 * "Ticino"/"Tessin" with no re-check, so a long canton name (e.g. German
 * "Appenzell Ausserrhoden") can push it past TITLE_MAX_CHARS. Composed via
 * {@link composePlaceTitle} like `comuneTitle`, never emitted verbatim. */
const HUB_TITLE_FALLBACK: Record<Locale, (display: string) => string> = {
  it: (d) => `Eventi in ${d}: agenda aggiornata`,
  en: (d) => `Events in ${d}: an updated agenda`,
  de: (d) => `Veranstaltungen in ${d}: aktuelle Agenda`,
  fr: (d) => `Événements à ${d} : agenda à jour`,
};

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
  const display = cantonDisplayLabel(canton, locale);
  const out: Copy = {
    ...base,
    hubTitle: composePlaceTitle(
      [sub(base.hubTitle), HUB_TITLE_FALLBACK[locale](display)],
      TITLE_MAX_CHARS,
      (s) => esc(s).length,
    ),
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
    // #4414: hub-scoped dynamic FAQ pair mentions the canton name (base text
    // is TI-hardcoded, e.g. "in Ticino"/"im Tessin") — same sub() treatment
    // as faqHubQ1/faqHubA2 above. Comune-scoped dynamic fields need no
    // substitution (no canton name in their template) so they pass through
    // via the `...base` spread untouched.
    faqHubDynamicQ: sub(base.faqHubDynamicQ),
    faqHubDynamicAHasEvents: (weekCount: number, title: string, date: string) =>
      sub(base.faqHubDynamicAHasEvents(weekCount, title, date)),
    faqHubDynamicAEmpty: sub(base.faqHubDynamicAEmpty),
  };
  copyCache.set(cacheKey, out);
  return out;
}

// ── Swiss-wide events index hub (issue #3645, F3) ───────────────────────────
// Canton-less landing page one level above every canton hub above
// (`/eventi/` + locale variants, from EVENTS_INDEX_PATH — §6, no second copy
// of the segment strings). Own copy object (own literal per-locale text, no
// canton to substitute) — same pattern as OTHER_EVENTS_COPY below rather than
// COPY/copyFor, since there is no single canton name to plug into it.
interface NationalCopy {
  metaTitle: string;
  metaDesc: string;
  h1: string;
  lede: string;
  breadcrumbLabel: string;
  statEvents: string;
  statCantons: string;
  statComuni: string;
  statWeekend: string;
  upcoming: string;
  byCanton: string;
  byCantonText: string;
  faqTitle: string;
  faqQ1: string;
  faqA1: string;
  faqQ2: string;
  faqA2: string;
  methodologyTitle: string;
  methodology: string;
  // Pill label on every per-canton hub linking back up to this index page.
  allCantonsLabel: string;
}

const NATIONAL_COPY: Record<Locale, NationalCopy> = {
  it: {
    metaTitle: 'Eventi in Svizzera: agenda per cantone aggiornata',
    metaDesc:
      'Tutti gli eventi in Svizzera raccolti dalle agende ufficiali e divisi per cantone: concerti, mostre, feste e appuntamenti, aggiornati ogni giorno.',
    h1: 'Eventi in Svizzera, cantone per cantone',
    lede: 'Concerti, mostre, feste e appuntamenti in tutta la Svizzera, raccolti dalle agende ufficiali e raggruppati per cantone.',
    breadcrumbLabel: 'Eventi Svizzera',
    statEvents: 'Eventi in arrivo',
    statCantons: 'Cantoni coperti',
    statComuni: 'Comuni coperti',
    statWeekend: 'Questo weekend',
    upcoming: 'Prossimi eventi in Svizzera',
    byCanton: 'Eventi per cantone',
    byCantonText: 'Scegli il tuo cantone per vedere gli eventi più vicini a te.',
    faqTitle: 'FAQ',
    faqQ1: "Con che frequenza si aggiorna l'agenda eventi Svizzera?",
    faqA1: "L'agenda si aggiorna automaticamente ogni giorno, raccogliendo i nuovi appuntamenti pubblicati dalle fonti ufficiali di ogni cantone.",
    faqQ2: 'Posso vedere gli eventi di un singolo cantone?',
    faqA2: "Sì. Scegli il cantone dalla lista qui sopra per vedere l'agenda completa di quella regione, comune per comune.",
    methodologyTitle: 'Come raccogliamo gli eventi',
    methodology:
      "Gli eventi sono raccolti automaticamente dalle agende pubbliche di ogni cantone e aggiornati ogni giorno. Ogni evento è attribuito a un cantone e, quando possibile, a un comune preciso. Verifica sempre data, orario e luogo sulla pagina originale dell'organizzatore prima di spostarti: orari e disponibilità possono cambiare.",
    allCantonsLabel: 'Tutta la Svizzera',
  },
  en: {
    metaTitle: 'Events in Switzerland: agenda by canton',
    metaDesc:
      "Every event in Switzerland, collected from official agendas and grouped by canton: concerts, exhibitions, festivals and happenings, refreshed daily.",
    h1: 'Events in Switzerland, canton by canton',
    lede: 'Concerts, exhibitions, festivals and happenings across Switzerland, collected from official agendas and grouped by canton.',
    breadcrumbLabel: 'Switzerland Events',
    statEvents: 'Upcoming events',
    statCantons: 'Cantons covered',
    statComuni: 'Municipalities covered',
    statWeekend: 'This weekend',
    upcoming: 'Upcoming events in Switzerland',
    byCanton: 'Events by canton',
    byCantonText: 'Choose your canton to see the events closest to you.',
    faqTitle: 'FAQ',
    faqQ1: 'How often is the Switzerland events agenda updated?',
    faqA1: "The agenda refreshes automatically every day, collecting new happenings published by each canton's official sources.",
    faqQ2: 'Can I see events for a single canton?',
    faqA2: "Yes. Pick a canton from the list above to see that region's full agenda, municipality by municipality.",
    methodologyTitle: 'How we collect events',
    methodology:
      "Events are collected automatically from each canton's public agendas and refreshed every day. Every event is attributed to a canton and, where possible, to a specific municipality. Always check date, time and venue on the organiser's original page before travelling: times and availability can change.",
    allCantonsLabel: 'All of Switzerland',
  },
  de: {
    metaTitle: 'Veranstaltungen in der Schweiz: Agenda nach Kanton',
    metaDesc:
      'Alle Veranstaltungen in der Schweiz, gesammelt aus offiziellen Agenden und nach Kanton gruppiert: Konzerte, Ausstellungen, Feste und Anlässe, täglich aktualisiert.',
    h1: 'Veranstaltungen in der Schweiz, Kanton für Kanton',
    lede: 'Konzerte, Ausstellungen, Feste und Anlässe in der ganzen Schweiz, aus offiziellen Agenden gesammelt und nach Kanton gruppiert.',
    breadcrumbLabel: 'Veranstaltungen Schweiz',
    statEvents: 'Kommende Veranstaltungen',
    statCantons: 'Abgedeckte Kantone',
    statComuni: 'Abgedeckte Gemeinden',
    statWeekend: 'Dieses Wochenende',
    upcoming: 'Kommende Veranstaltungen in der Schweiz',
    byCanton: 'Veranstaltungen nach Kanton',
    byCantonText: 'Wähle deinen Kanton, um die Anlässe in deiner Nähe zu sehen.',
    faqTitle: 'FAQ',
    faqQ1: 'Wie oft wird die Schweizer Veranstaltungsagenda aktualisiert?',
    faqA1: 'Die Agenda wird automatisch täglich aktualisiert und sammelt neue Anlässe aus den offiziellen Quellen jedes Kantons.',
    faqQ2: 'Kann ich die Veranstaltungen eines einzelnen Kantons sehen?',
    faqA2: 'Ja. Wähle einen Kanton aus der Liste oben, um die vollständige Agenda dieser Region zu sehen, Gemeinde für Gemeinde.',
    methodologyTitle: 'Wie wir Veranstaltungen sammeln',
    methodology:
      'Die Veranstaltungen werden automatisch aus den öffentlichen Agenden jedes Kantons gesammelt und täglich aktualisiert. Jeder Anlass wird einem Kanton und, wenn möglich, einer genauen Gemeinde zugeordnet. Prüfe Datum, Zeit und Ort immer auf der Originalseite des Veranstalters, bevor du losfährst: Zeiten und Verfügbarkeit können sich ändern.',
    allCantonsLabel: 'Ganze Schweiz',
  },
  fr: {
    metaTitle: 'Événements en Suisse: agenda par canton',
    metaDesc:
      'Tous les événements en Suisse, recueillis dans les agendas officiels et regroupés par canton: concerts, expositions, fêtes et rendez-vous, mis à jour chaque jour.',
    h1: 'Événements en Suisse, canton par canton',
    lede: 'Concerts, expositions, fêtes et rendez-vous dans toute la Suisse, recueillis dans les agendas officiels et regroupés par canton.',
    breadcrumbLabel: 'Événements Suisse',
    statEvents: 'Événements à venir',
    statCantons: 'Cantons couverts',
    statComuni: 'Communes couvertes',
    statWeekend: 'Ce week-end',
    upcoming: 'Prochains événements en Suisse',
    byCanton: 'Événements par canton',
    byCantonText: 'Choisissez votre canton pour voir les événements les plus proches de vous.',
    faqTitle: 'FAQ',
    faqQ1: "À quelle fréquence l'agenda des événements Suisse est-il mis à jour?",
    faqA1: "L'agenda est actualisé automatiquement chaque jour, en recueillant les nouveaux rendez-vous publiés par les sources officielles de chaque canton.",
    faqQ2: "Puis-je voir les événements d'un seul canton?",
    faqA2: "Oui. Choisissez un canton dans la liste ci-dessus pour voir l'agenda complet de cette région, commune par commune.",
    methodologyTitle: 'Comment nous recueillons les événements',
    methodology:
      "Les événements sont recueillis automatiquement dans les agendas publics de chaque canton et actualisés chaque jour. Chaque événement est attribué à un canton et, si possible, à une commune précise. Vérifiez toujours la date, l'horaire et le lieu sur la page d'origine de l'organisateur avant de vous déplacer: horaires et disponibilités peuvent changer.",
    allCantonsLabel: 'Toute la Suisse',
  },
};

/** Canonical path for the Swiss-wide index hub (`EVENTS_INDEX_PATH` + trailing slash). */
function nationalIndexPath(locale: Locale): string {
  return `${EVENTS_INDEX_PATH[locale]}/`;
}

function buildNationalAlternates(): string {
  return LOCALES.map((locale) => `  <link rel="alternate" hreflang="${locale}" href="${BASE_URL}${nationalIndexPath(locale)}">`)
    .concat(`  <link rel="alternate" hreflang="x-default" href="${BASE_URL}${nationalIndexPath('it')}">`)
    .join('\n');
}

type DigestCopy = { title: string; h1: string; lede: string; desc: string; faqQ: string; faqA: string };
const digestCopyCache = new Map<string, DigestCopy>();

/** Short, budget-safe fallback `title` per digest key + locale — same
 * overflow risk as `HUB_TITLE_FALLBACK` (canton substituted into a title
 * budgeted for TI's short name, no re-check). Keeps the weekend/week
 * distinction so the two digest pages for one canton never end up with an
 * identical (or near-identical) truncated `<title>`. */
const DIGEST_TITLE_FALLBACK: Record<string, Record<Locale, (display: string) => string>> = {
  weekend: {
    it: (d) => `Eventi nel weekend a ${d}`,
    en: (d) => `Events this weekend in ${d}`,
    de: (d) => `Veranstaltungen am Wochenende: ${d}`,
    fr: (d) => `Événements ce week-end à ${d}`,
  },
  week: {
    it: (d) => `Eventi questa settimana a ${d}`,
    en: (d) => `Events this week in ${d}`,
    de: (d) => `Veranstaltungen diese Woche: ${d}`,
    fr: (d) => `Événements cette semaine à ${d}`,
  },
};

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
  const display = cantonDisplayLabel(canton, locale);
  const fallbackTitle = DIGEST_TITLE_FALLBACK[def.key]?.[locale];
  const out: DigestCopy = {
    title: fallbackTitle
      ? composePlaceTitle([sub(base.title), fallbackTitle(display)], TITLE_MAX_CHARS, (s) => esc(s).length)
      : sub(base.title),
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

// Source→taxonomy normalization (issue #3742): tio-agenda's own categories
// already ARE the taxonomy keys above (verified live: every tio-agenda
// event.category is one of arte/musica/teatro/cinema/feste/musei/conferenze/
// sport/appuntamenti/sociale/altro), so the lookup below is a no-op for that
// source. The two nationwide sources are not: myswitzerland derives its
// category from a humanized schema.org Event `@type` (English — "Music",
// "Sports", "Theater", "Food", "Exhibition", "Festival", or the generic
// "Event" for 77% of its events), and guidle scrapes a free-text German/
// Italian sub-genre from its "Kategorie" accordion (e.g. "Rock generalmente",
// "Teatro: improvisazione", "Ambient / Electronica" — 47 distinct values,
// none of them a taxonomy key). Left as-is, BOTH fell through to the raw
// title-cased passthrough below, showing the wrong language on non-source
// locales and, for the "Event" default alone, misclassifying 667/1084 (61.5%)
// of ALL crawled events into the generic bucket under the literal English
// word "Event". Normalizing HERE (at label-lookup time, not crawl time) fixes
// every already-crawled event retroactively, not just future crawls.
const SOURCE_CATEGORY_ALIASES: Record<string, string> = {
  // myswitzerland: `humanizeCategory()` output (scripts/crawl-myswitzerland-events.mjs)
  // — one entry per schema.org Event `@type` actually seen live in
  // data/events/by-source/myswitzerland.json (verified 2026-07-07: Event 778,
  // Music 98, Sports 50, Theater 43, Food 22, Exhibition 8, Festival 7).
  event: 'altro',
  music: 'musica',
  sports: 'sport',
  theater: 'teatro',
  food: 'feste',
  exhibition: 'musei',
  festival: 'feste',
};

// guidle: free-text sub-genre keyword rules, checked in order (most specific
// first) so an overlapping word (e.g. "Musical" containing "music") resolves
// to the intended bucket. Matched against the accent-stripped/lowercased
// category (see `normalizeCategoryKey`), so accented variants need no
// duplicate entry. Deliberately conservative: a handful of genuinely
// ambiguous long-tail categories (e.g. "Contemplazione / Meditazione",
// "Salute / Medicina", "Danza libera", "Assistanza nella vita quotidiana")
// are NOT covered and fall through to the `altro` default below — same
// "no confident signal, don't guess" policy as everywhere else in this file.
const CATEGORY_KEYWORD_RULES: Array<[RegExp, string]> = [
  [/teatro|theater|theatre|comm?edia|improvisazion|musical/, 'teatro'],
  [/cinema|\bfilm\b|kino/, 'cinema'],
  [
    /\brock\b|\bpop\b|jazz|classica|klassik|\bfolk\b|\bmusic\w*|musik|ambient|electronica|elettronica|barocco|cantautore|sperimentale|hip.?hop|\blatin\b|metal|hardcore|salsa|reggae|dancehall|industrial|\bnoise\b/,
    'musica',
  ],
  [/festa|festival|\bparty\b|\bcibo\b|sagra/, 'feste'],
  [/\barte\b|kunst|mostra|esposizione|ausstellung/, 'arte'],
  [/museo|museum/, 'musei'],
  [/\bsport\w*|escursionismo|equestre|nautic/, 'sport'],
  [/conferenza|vortrag|\btalk\b/, 'conferenze'],
];

/**
 * Resolve a raw source category to one of `CATEGORY_LABEL`'s taxonomy keys,
 * or `undefined` when nothing matches (caller falls back to the raw
 * passthrough, same as before this normalization existed). Pure, no i18n —
 * exported for direct unit testing.
 */
export function normalizeCategoryKey(category: string | undefined): string | undefined {
  if (!category) return undefined;
  const trimmed = category.trim();
  if (!trimmed) return undefined;
  if (CATEGORY_LABEL[trimmed]) return trimmed; // already a valid taxonomy key
  const normalized = normalizeText(trimmed);
  if (SOURCE_CATEGORY_ALIASES[normalized]) return SOURCE_CATEGORY_ALIASES[normalized];
  for (const [rx, key] of CATEGORY_KEYWORD_RULES) {
    if (rx.test(normalized)) return key;
  }
  return undefined;
}

export function categoryLabel(category: string | undefined, locale: Locale): string {
  if (!category) return CATEGORY_LABEL.altro[locale];
  const normalized = normalizeCategoryKey(category);
  if (normalized) return CATEGORY_LABEL[normalized][locale];
  return category.charAt(0).toUpperCase() + category.slice(1);
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

/**
 * Category-tone chip classes, one `.ev-tone-*` atom per tone (index.css,
 * `@layer components`). Each atom expands — via `@apply`, at CSS build time —
 * to exactly the border/background/text triple it replaced
 * (`border-accent-border bg-accent-subtle text-accent`, and so on), so the
 * chip renders identically while ~55 B of repeated utility string per chip
 * leaves the HTML. Kept as an explicit map rather than a template on the key
 * so both halves are greppable; the pairing is pinned by
 * tests/events-card-atoms.test.ts.
 */
const TONE_CHIP_ATOM: Record<CategoryTone, string> = {
  accent: 'ev-tone-accent',
  info: 'ev-tone-info',
  success: 'ev-tone-success',
  warning: 'ev-tone-warning',
  neutral: 'ev-tone-neutral',
};

const TONE_GRADIENT_CLASSES: Record<CategoryTone, string> = {
  accent: 'from-accent-subtle to-surface-raised',
  info: 'from-info-subtle to-surface-raised',
  success: 'from-success-subtle to-surface-raised',
  warning: 'from-warning-subtle to-surface-raised',
  neutral: 'from-neutral-subtle to-surface-raised',
};

// ── Per-category "catalog" fallback image ───────────────────────
// Real event photos only exist once mirrorEventImage() succeeds (source
// had a usable image AND the download/CDN-mirror step worked). Many
// sources 403 hotlinks or carry no image at all — until now those events
// rendered a *decorative* gradient <div> (emoji, no real <img>), so the
// visible card/hero and the Event JSON-LD `image` field had no bytes to
// point to (JSON-LD fell back to the sitewide og-image, card had nothing
// with width/height/alt). Below: a tiny set of static, site-owned SVG
// "catalog" images — one per CATEGORY_VISUAL entry, reusing the exact
// same emoji/tone tokens already defined above (no new design language) —
// so every event, image or not, resolves to a real fetchable, same-origin
// <img> with width/height/alt (never a third-party hotlink).
const CATALOG_TONE_HEX: Record<CategoryTone, string> = {
  accent: '#f5f3ff', // --_accent-subtle
  info: '#f0fdfa', // --_info-subtle
  success: '#ecfdf5', // --_success-subtle
  warning: '#fffbeb', // --_warning-subtle
  neutral: '#fafaf9', // --_neutral-subtle
};
const CATALOG_SURFACE_RAISED_HEX = '#f1f5f9'; // --_surface-raised, gradient end (light mode)
const CATALOG_IMAGE_WIDTH = 1200;
const CATALOG_IMAGE_HEIGHT = 675; // 16:9, matches detail-page hero + Google Images min-width guidance

/** Category key used for the catalog image, defaulting unknown/missing
 * categories to `altro` same fallback categoryVisual()/categoryLabel() use. */
function catalogCategorySlug(category: string | undefined): string {
  return category && CATEGORY_VISUAL[category] ? category : 'altro';
}

function catalogImagePath(category: string | undefined): string {
  return `/images/events/catalog/${catalogCategorySlug(category)}.svg`;
}

/** Deterministic SVG markup for one category's catalog image. Locale-free
 * by design (only the emoji is drawn) so a single file per category is
 * reused across it/en/de/fr — the translated label lives in the calling
 * page's own `alt` attribute, not baked into the asset. */
function catalogImageSvgMarkup(category: string): string {
  const visual = CATEGORY_VISUAL[category];
  const bg = CATALOG_TONE_HEX[visual.tone];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CATALOG_IMAGE_WIDTH} ${CATALOG_IMAGE_HEIGHT}" width="${CATALOG_IMAGE_WIDTH}" height="${CATALOG_IMAGE_HEIGHT}" role="img">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${CATALOG_SURFACE_RAISED_HEX}"/>
    </linearGradient>
  </defs>
  <rect width="${CATALOG_IMAGE_WIDTH}" height="${CATALOG_IMAGE_HEIGHT}" fill="url(#g)"/>
  <text x="${CATALOG_IMAGE_WIDTH / 2}" y="${CATALOG_IMAGE_HEIGHT / 2}" font-size="220" text-anchor="middle" dominant-baseline="central">${visual.emoji}</text>
</svg>
`;
}

/** Writes the fixed set of per-category catalog SVGs once per build
 * (content is deterministic — no need to scan the dataset for which
 * categories are actually used, the whole set is tiny). */
function writeCatalogImages(writeFile: (relPath: string, contents: string) => void): void {
  for (const category of Object.keys(CATEGORY_VISUAL)) {
    writeFile(`images/events/catalog/${category}.svg`, catalogImageSvgMarkup(category));
  }
}

/** ImageObject JSON-LD for the catalog fallback. Unlike mirrored source
 * photos (which credit the source via `creditText`), this is a site-owned
 * asset, so the `imageObjectLd()` defaults (site Organization as creator,
 * site license page) are already correct — no overrides needed. */
function catalogImageObjectLd(category: string | undefined, locale: Locale): ImageObjectLd {
  return imageObjectLd({
    contentUrl: `${BASE_URL}${catalogImagePath(category)}`,
    caption: categoryLabel(category, locale),
    width: CATALOG_IMAGE_WIDTH,
    height: CATALOG_IMAGE_HEIGHT,
  });
}

/**
 * Shared presentation-only CSS for every events page (hub, comune, "other
 * events", detail, digest). Pure visual layer — no data/JSON-LD impact:
 *   - `.ev-grid` — breakpoint-free responsive card grid.
 *   - `.ev-card` / `.ev-in` — a single tasteful entrance rise on load,
 *     staggered per grid position; fully disabled under
 *     prefers-reduced-motion (both the animation itself and its resting
 *     opacity/transform are reset so content is never stuck hidden).
 *   - `.ev-featured` — opt-in wrapper (hub/comune/other-events/digest only,
 *     never the detail page's secondary "more events" list) that gives the
 *     soonest event (always `events[0]`, see `upcomingEvents()` sort order
 *     in scripts/lib/events-utils.mjs) a wider, image-forward treatment
 *     from `sm:` up.
 * Emitted once per page body; safe to duplicate across independently
 * generated static HTML documents.
 */
const EVENTS_STYLE_BLOCK = `<style>.ev-grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}.ev-card,.ev-in{animation:ev-rise .5s cubic-bezier(.16,1,.3,1) both}.ev-grid>.ev-card:nth-child(2){animation-delay:70ms}.ev-grid>.ev-card:nth-child(3){animation-delay:140ms}.ev-grid>.ev-card:nth-child(4){animation-delay:210ms}.ev-grid>.ev-card:nth-child(5){animation-delay:280ms}.ev-grid>.ev-card:nth-child(n+6){animation-delay:350ms}.ev-featured .ev-grid>.ev-card:first-child{grid-column:1/-1}@media(min-width:640px){.ev-featured .ev-grid>.ev-card:first-child{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:stretch}.ev-featured .ev-grid>.ev-card:first-child .ev-media{aspect-ratio:auto;height:100%;min-height:220px}.ev-featured .ev-grid>.ev-card:first-child h3{font-size:1.375rem;line-height:1.3}}@keyframes ev-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}@media (prefers-reduced-motion:reduce){.ev-card,.ev-in{animation:none;opacity:1;transform:none}}</style>`;

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
  if (!comune) return `${base}/`;
  const segment = comune === OTHER_EVENTS_COMUNE_KEY ? OTHER_EVENTS_SEGMENT[locale] : slugifyComune(comune);
  return `${base}/${segment}/`;
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
  const segment = comune === OTHER_EVENTS_COMUNE_KEY ? OTHER_EVENTS_SEGMENT[locale] : slugifyComune(comune);
  return `${basePathFor(canton)[locale]}/${segment}/${eventSlug}/`;
}

function buildEventAlternates(canton: string, comune: string, eventSlug: string): string {
  return LOCALES.map(
    (locale) => ` <link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathForEventDetail(locale, comune, eventSlug, canton)}">`,
  )
    .concat(` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathForEventDetail('it', comune, eventSlug, canton)}">`)
    .join('\n');
}

function renderMetric(label: string, value: string, detail?: string): string {
  return `<div class="ev-metric">
    <dt class="ev-metric-t">${esc(label)}</dt>
    <dd class="ev-metric-v">${esc(value)}</dd>
    ${detail ? `<p class="ev-metric-d">${esc(detail)}</p>` : ''}
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
  // Real location only (#3508): nationwide sources (guidle, myswitzerland)
  // can ship events with an unresolved canton (''). Never stamp Ticino/TI
  // on those — addressLocality falls back to the crawled venue (a town
  // name for those sources) and addressRegion is omitted when unknown.
  const cantonName = event.canton ? getCantonLabel(event.canton, locale as CantonLocale) : '';
  const locality = event.comune || (event.canton ? cantonName : event.venue || 'Svizzera');
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
    `${title} — ${cat} ${COPY[locale].at} ${venueName} (${[locality, cantonName].filter(Boolean).join(', ')}), ${when}` +
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
        ...(event.canton ? { addressRegion: event.canton } : {}),
        addressCountry: 'CH',
      },
      ...(event.geo
        ? { geo: { '@type': 'GeoCoordinates', latitude: event.geo.lat, longitude: event.geo.lng } }
        : {}),
    },
    description: description.length >= 30 ? description : `${description} Evento in ${cantonName || 'Svizzera'}.`,
    image: mirroredEventImageObject(event) ?? catalogImageObjectLd(event.category, locale),
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
 * Light aggregate-list variant of {@link eventLd} — same field VALUES (built
 * via the full builder, so the description/date/locality edge cases never
 * drift into a second copy), but strips the heaviest OPTIONAL-per-
 * `validate-structured-data-completeness.mjs` weight before embedding into a
 * canton/digest-hub `ItemList`: full `ImageObject` (with the GSC
 * licensable-image quintet) collapses to its bare `url` string — the
 * completeness gate's `hasImage` check accepts a plain string, only `image`
 * itself is mandatory, not the license metadata — `geo`/`streetAddress`/
 * `postalCode` drop off `location.address` (only `addressLocality` is
 * required), and `offers`/`sameAs` are omitted entirely (both optional,
 * `offers` is only validated *when present*). The authoritative FULL
 * `eventLd()` still ships on every event's own detail page (`isPast` guard,
 * line ~2579) — only the supplementary aggregate-list copy is lightened.
 * Cuts ~1-1.3 KB/event; at the 100-event hub/digest cap that's the
 * difference between a large canton (e.g. Bern, whose nationwide-source
 * events already carry more real fields than Ticino's thin tio-agenda MVP
 * feed) clearing or blowing the 260 KB page-weight budget
 * (audit:page-weight regression #4593 — verified: BE's 12 oversized pages
 * were all canton-hub/digest, never a per-event detail page).
 */
function lightEventLd(event: SiteEvent, locale: Locale): Record<string, unknown> {
  const full = eventLd(event, locale);
  const { offers: _offers, sameAs: _sameAs, image: fullImage, location, ...rest } = full as Record<string, unknown> & {
    location: { '@type': string; name: string; address: Record<string, unknown>; geo?: unknown };
  };
  const { streetAddress: _street, postalCode: _postal, ...addressRest } = location.address;
  const imageUrl = typeof fullImage === 'string' ? fullImage : (fullImage as { url?: string } | undefined)?.url;
  return {
    ...rest,
    location: { ...location, address: addressRest, geo: undefined },
    image: imageUrl,
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
 * the per-category catalogImageObjectLd() at the call site) rather than
 * ever being embedded as a hotlink in production JSON-LD.
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
 * Character cap for {@link cardExcerpt}. 160 is above the dataset's p50
 * description length (104 chars) and just under its p90 (187), so the typical
 * event shows its whole summary and only the long tail is cut — a cap that
 * mostly does nothing is what keeps the excerpt a real summary rather than a
 * uniform stub. Word-aware via `truncateHeadline` (never a mid-word cut), and
 * `.ev-x`'s `line-clamp-3` bounds the card height regardless of what a source
 * ships.
 */
const CARD_EXCERPT_CHARS = 160;

/**
 * How many events a comune hub (and the comune-less `altri-eventi` sentinel)
 * renders as full CARDS. Was an inline `80` literal duplicated at both render
 * sites; named here because `renderOverflowIndex()` has to slice at exactly the
 * same offset — an overflow index computed against a different cap would either
 * skip events (re-orphaning them, the #5434 bug) or repeat carded ones.
 *
 * Raising it is a page-weight decision, not a reachability one any more: every
 * event past the cap is still linked, just as a text row.
 */
const EVENT_CARD_CAP = 80;

/**
 * The same budget for the comune-less `altri-eventi` sentinel bucket, which is
 * the LARGEST page in the dataset (1235 upcoming events measured 2026-09-04)
 * and therefore the one where 80 cards cost the most: a full card is ~1.4 KB of
 * markup (480x270 `<img>`, category chip, meta line, excerpt up to
 * `CARD_EXCERPT_CHARS`, comune), so the card block alone weighed ~111 KB of the
 * 311.8 KB `fr` page — over `MAX_HTML_BYTES`.
 *
 * Why the sentinel gets its own number instead of lowering `EVENT_CARD_CAP` for
 * everyone: on a comune hub the cards ARE the discovery surface for a short,
 * coherent list, while this bucket is a heterogeneous nationwide dump where the
 * cards past the first couple dozen add no discovery value proportional to
 * their bytes. Nothing is dropped — `renderOverflowIndex()` still links every
 * event past the cap as a text row (~150 B each), so trading 56 cards for 56
 * rows is about -70 KB with the #5434 reachability invariant untouched.
 *
 * Same contract as `EVENT_CARD_CAP`: the card slice and `renderOverflowIndex()`
 * MUST be handed this very constant, never a different number.
 */
const OTHER_EVENTS_CARD_CAP = 24;

/**
 * The event's own summary, shown on every card in every listing (canton hub,
 * comune page, digest, and the "more events" grid on a detail page).
 *
 * Why the card carries prose at all. Before this, a card showed title + date +
 * venue + comune — ~90 B of text inside 1 423 B of markup. A reader scanning
 * "altri eventi a Lugano" had no way to tell a chamber concert from a
 * children's workshop without opening each one; the summary that answers that
 * is already in the dataset (94.1 % of upcoming events carry a description,
 * with per-locale translations from guidle/myswitzerland) and was simply not
 * rendered outside the detail page. Same correction shape as the FAQ-hub
 * per-question pages, where each sibling link grew the opening of its own
 * answer.
 *
 * Returns '' for the ~6 % of events with no description (tio-agenda ships
 * none — see the `venue` note on DetailCopy.about) and the card degrades to
 * exactly its previous shape.
 */
function cardExcerpt(event: SiteEvent, locale: Locale): string {
  const raw = localizedDescription(event, locale);
  if (!raw) return '';
  // Sources ship newlines/tabs and runs of spaces inside descriptions; collapse
  // before measuring so the cap counts real characters, not layout whitespace.
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return truncateHeadline(flat, CARD_EXCERPT_CHARS);
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
  const cardTitle = localizedTitle(event, locale);
  const excerpt = cardExcerpt(event, locale);
  // `after:absolute after:inset-0` (`.ev-a`) makes the whole card clickable
  // (stretched link) while the visible accessible name/href/rel/target stay
  // exactly the same as before — `article.relative` (`.ev-card`) below is its
  // positioning context.
  const titleLink = detailHref
    ? `<a class="ev-a" href="${esc(detailHref)}">${esc(cardTitle)}</a>`
    : `<a class="ev-a" href="${esc(eventReferralUrl(event.url, event))}" rel="nofollow noopener" target="_blank">${esc(cardTitle)}</a>`;
  // `imageUrl` only ever holds a mirrored site-relative path (see
  // `mirrorEventImage()`); a raw third-party URL is never rendered here
  // (defense-in-depth, mirrors the same guard in `mirroredEventImageObject`).
  // No direct photo → per-category catalog SVG (real, site-owned, same-origin
  // <img> with width/height/alt) instead of a decorative div with no <img> at
  // all — see writeCatalogImages()/catalogImagePath() above.
  const media =
    event.imageUrl && event.imageUrl.startsWith('/')
      ? `<img class="ev-img ev-imgz" src="${esc(event.imageUrl)}" width="480" height="270" loading="lazy" alt="${esc(cardTitle)}">`
      : `<img class="ev-img" src="${esc(catalogImagePath(event.category))}" width="480" height="270" loading="lazy" alt="${esc(cat)}">`;
  // `group` stays inline: it is a variant MARKER with no declarations of its
  // own (`@apply group` is not expressible), and `.ev-imgz`'s
  // `group-hover:scale-105` needs it on the ancestor.
  return `<article class="ev-card group">
    <div class="ev-media">
      ${media}
      <span class="ev-chip ${TONE_CHIP_ATOM[visual.tone]}">${visual.emoji} ${esc(cat)}</span>
    </div>
    <div class="p-4">
      <h3 class="ev-t">
        ${titleLink}
      </h3>
      <p class="ev-meta">
        <span class="ev-mi ev-when"><span aria-hidden="true">🕒</span>${esc(when)}${time}</span>
        ${place ? `<span class="ev-mi"><span aria-hidden="true">📍</span>${esc(COPY[locale].at)} ${place}</span>` : ''}
      </p>
      ${excerpt ? `<p class="ev-x">${esc(excerpt)}</p>` : ''}
      ${event.comune ? `<p class="ev-com">${esc(event.comune)}</p>` : ''}
    </div>
  </article>`;
}

/** `detailHref` maps an event to its internal detail-page URL (or null → external). */
type DetailHref = (event: SiteEvent) => string | null;

function renderEventList(events: SiteEvent[], locale: Locale, detailHref?: DetailHref): string {
  if (events.length === 0) {
    return `<p class="rounded-md border border-edge bg-surface p-4 text-sm text-body">${esc(COPY[locale].noEventsSoon)}</p>`;
  }
  return `<div class="ev-grid">${events
    .map((e) => renderEventCard(e, locale, detailHref ? detailHref(e) : null))
    .join('')}</div>`;
}

/**
 * Copy for `renderOverflowIndex()`. Standalone `Record<Locale, …>` rather than a
 * field on `Copy`/`OtherEventsCopy`: there is no canton name to substitute, so
 * it would only ever ride `copyFor()`'s `...base` spread untouched — same
 * reasoning as `OTHER_EVENTS_TITLE_FALLBACK` above.
 */
const OVERFLOW_INDEX_COPY: Record<Locale, { title: string; text: (n: number) => string }> = {
  it: { title: 'Tutti gli altri eventi', text: (n) => `Altri ${n} eventi in programma, in ordine di data.` },
  en: { title: 'All the other events', text: (n) => `${n} more scheduled events, in date order.` },
  de: { title: 'Alle weiteren Veranstaltungen', text: (n) => `${n} weitere geplante Veranstaltungen, nach Datum.` },
  fr: { title: 'Tous les autres événements', text: (n) => `${n} autres événements programmés, par date.` },
};

/**
 * Text index of the events the card grid's `slice(0, cap)` left out — the hub's
 * crawl surface for its own overflow (issue #5434, Causa B).
 *
 * WHY IT EXISTS. The cap is a page-weight measure, but it was also silently a
 * REACHABILITY cap: an event whose only inbound link is its comune hub's card
 * grid has no inbound link at all once it falls past the cap, so
 * `audit:max-bfs-depth` counted it as unreachable. Measured on the live graph:
 * 689 of the 819 `sitemap-eventi.xml` offenders were exactly this, and only in
 * the two buckets that exceed the cap.
 *
 * WHY NOT JUST RAISE THE CAP. A card carries an <img>, a chip, meta and an
 * excerpt (~650 B measured); a row here is an <a> and a title (~150 B measured).
 * Rendering the same overflow as cards would cost ~390 KB on the largest bucket
 * against `scripts/audit-page-weight.mjs`'s 260 KB budget.
 *
 * MEASURED HEADROOM (live pages, 2026-08-09, `curl | wc -c`). Only two buckets
 * in the whole dataset are over the cap, so only two pages per locale grow:
 *   /eventi/altri-cantoni/altri-eventi/  76.4 KB + 90.1 KB (603 rows) = 167 KB
 *   /eventi/ginevra/geneve/             115.2 KB + 16.3 KB (111 rows) = 132 KB
 * Both inside the 260 KB budget. That headroom is not unbounded: at ~150 B per
 * row the largest bucket has room for roughly 600 more events before it needs a
 * real pagination ladder. If `audit:page-weight` ever flags an `/eventi/` path,
 * this is the block to bound — do NOT fix it by dropping rows, that silently
 * re-orphans them.
 *
 * Only events WITH a detail page are listed: `detailHref` returns null for an
 * event that has none, and linking its external source URL instead would add a
 * `nofollow` outbound without making our page reachable.
 */
function renderOverflowIndex(
  events: SiteEvent[],
  cap: number,
  locale: Locale,
  detailHref?: DetailHref,
): string {
  if (!detailHref || events.length <= cap) return '';
  const rows = events
    .slice(cap)
    .map((event) => ({ event, href: detailHref(event) }))
    .filter((row): row is { event: SiteEvent; href: string } => Boolean(row.href));
  if (rows.length === 0) return '';
  const copy = OVERFLOW_INDEX_COPY[locale];
  const items = rows
    .map(({ event, href }) => `<li><a class="ev-lnk" href="${esc(href)}">${esc(localizedTitle(event, locale))}</a></li>`)
    .join('');
  return `<section data-events-overflow-index="1" class="ev-panel">
      <h2 class="ev-h2">${esc(copy.title)}</h2>
      <p class="mt-2 text-sm leading-6 text-body">${esc(copy.text(rows.length))}</p>
      <ul class="mt-3 columns-1 gap-6 text-sm leading-7 sm:columns-2 lg:columns-3">${items}</ul>
    </section>`;
}

function renderCrosslinks(locale: Locale): string {
  const copy = COPY[locale];
  return `<section class="ev-panel">
    <h2 class="ev-h2">${esc(copy.exploreMore)}</h2>
    <div class="ev-xgrid">
      ${CROSSLINKS.map((l) => `<a class="ev-xlink" href="${l.href[locale]}">${esc(l.label[locale])}</a>`).join('')}
    </div>
  </section>`;
}

function renderFaq(items: Array<{ q: string; a: string }>, title: string): string {
  return `<section class="ev-panel">
    <h2 class="ev-h2">${esc(title)}</h2>
    <div class="ev-faq">
      ${items
        .map(
          (it, i) =>
            `<details class="py-3"${i === 0 ? ' open' : ''}><summary class="ev-faq-q">${esc(it.q)}</summary><p class="ev-faq-a">${esc(it.a)}</p></details>`,
        )
        .join('')}
    </div>
  </section>`;
}

function distinctCategories(events: SiteEvent[]): number {
  return new Set(events.map((e) => e.category).filter(Boolean)).size;
}

/** Count of `events` overlapping the [today, today+7) window — same window
 * as the `week` DIGESTS entry above (weekWindow/overlapsWindow, §6 shared
 * date math), reused here for issue #4414's data-driven FAQ pair. */
function weekEventCount(events: SiteEvent[], dateStamp: string): number {
  const { start, end } = weekWindow(dateStamp);
  return events.filter((e) => overlapsWindow(e, start, end)).length;
}

/**
 * Sentence-ending period to append right after a `humanDate()` string,
 * skipped when the date itself already ends in one — `fr-CH` abbreviated
 * months ("juil.", "déc.") already carry a trailing period, so a template
 * that naively appended "." produced a visible/JSON-LD-visible ".." in the
 * French dynamic-FAQ answer below (issue #4414 review fix).
 */
function sentenceEndAfterDate(date: string): string {
  return date.endsWith('.') ? '' : '.';
}

/**
 * Issue #4414: a 3rd FAQ pair, generated from real per-page data instead of
 * reused boilerplate — real weekly event count + the soonest upcoming event
 * (always `events[0]`, see `upcomingEvents()` sort order). `events` must
 * already be scoped to the page (comune list or canton list) and sorted
 * ascending by startDate, exactly as `renderHubPage`/`renderComunePage`
 * already receive it. Falls back to the `aEmpty` answer when the page has
 * zero upcoming events at all.
 */
function dynamicFaqPair(
  locale: Locale,
  events: SiteEvent[],
  dateStamp: string,
  q: string,
  aHasEvents: (weekCount: number, title: string, date: string) => string,
  aEmpty: string,
): { q: string; a: string } {
  if (events.length === 0) return { q, a: aEmpty };
  const next = events[0];
  const weekCount = weekEventCount(events, dateStamp);
  return { q, a: aHasEvents(weekCount, localizedTitle(next, locale), humanDate(next.startDate, locale)) };
}

// Cap on ItemList JSON-LD entries per aggregate page (canton/national/comune/
// digest hubs) — deliberately SMALLER than the visible card-list caps (80/100
// items, see the `upcoming`/`list` comments above each render* function).
// Those caps were raised 40/60→80/100 to fix audit:max-bfs-depth (every event
// needs a real <a href> within crawl depth ≤2); this cap is unrelated to that
// and stays independent. `lightEventLd()` already strips optional fields, but
// even the "light" per-event JSON-LD entry for the busiest canton hub (Bern —
// the most-crawled canton) pushed 2 pages ~1 KB over the 260 KB audit:page-
// weight budget (validate-dist run 29794187475). Google's rich-result
// eligibility already only surfaces a handful of ItemList entries regardless
// of how many are marked up, so trimming the JSON-LD tail (while every event
// keeps its real visible <a href> card, so BFS reachability is untouched) is
// a real byte reduction rather than a page-weight-only patch.
const EVENT_JSONLD_ITEM_CAP = 50;

/**
 * Events eligible for Event JSON-LD markup on aggregate ItemList pages
 * (#3508): Google's event structured-data guidelines say not to mark up
 * already-started/expired events as EventScheduled, but some crawler
 * sources ship stale startDates (e.g. a recurring series stored as one
 * year-long start→end span). Markup-only filter — the visible HTML list
 * is NOT affected (no page/content cut): keep events whose startDate is
 * today or later, with a 1-day grace window for timezone skew.
 * ISO yyyy-mm-dd strings compare lexicographically. Also caps the result at
 * {@link EVENT_JSONLD_ITEM_CAP} — see that constant for why.
 */
function markupEligibleEvents(events: SiteEvent[], dateStamp: string): SiteEvent[] {
  const cutoff = new Date(`${dateStamp}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return events.filter((e) => e.startDate >= cutoffIso).slice(0, EVENT_JSONLD_ITEM_CAP);
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
  /** Events for this canton with no `comune` (see the "other events" bucket
   * page above) — adds one extra tile to the comune grid so that page stays
   * BFS-reachable from the hub, same as every real comune tile. */
  otherEvents?: SiteEvent[];
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, canton, events, byComune, dateStamp, weekendDays, distDir, detailHref, otherCantons = [], otherEvents = [] } = params;
  const copy = copyFor(canton, locale);
  const canonicalPath = pathFor(locale, canton);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;
  // Was 60 — the date-sorted tail beyond the cap never got a link anywhere,
  // contributing to sitemap-eventi.xml's 14.99% BFS-depth orphan rate
  // (audit:max-bfs-depth). Raised so canton/digest hubs surface more of the
  // family within depth budget; see build-plugins/eventsSeoPagesPlugin.ts
  // header for the depth ≤2 hub design this caps still nest under.
  const upcoming = events.slice(0, 100);

  const comuneEntries = [...byComune.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const comuneGrid =
    comuneEntries
      .map(
        ([comune, list]) =>
          `<a class="group flex items-center justify-between gap-2 rounded-lg border border-edge bg-surface p-4 shadow-stripe-sm transition-all hover:-translate-y-0.5 hover:border-accent-border hover:shadow-stripe-md" href="${pathFor(locale, canton, comune)}">
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-heading">${esc(comune)}</span>
            <span class="mt-1 block text-xs text-muted">${list.length} ${esc(copy.eventsWord)}</span>
          </span>
          <span class="shrink-0 text-lg text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden="true">→</span>
        </a>`,
      )
      .join('') +
    (otherEvents.length > 0
      ? `<a class="group flex items-center justify-between gap-2 rounded-lg border border-edge bg-surface p-4 shadow-stripe-sm transition-all hover:-translate-y-0.5 hover:border-accent-border hover:shadow-stripe-md" href="${pathFor(locale, canton, OTHER_EVENTS_COMUNE_KEY)}">
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-heading">${esc(otherEventsCopyFor(canton, locale).tileLabel)}</span>
            <span class="mt-1 block text-xs text-muted">${otherEvents.length} ${esc(copy.eventsWord)}</span>
          </span>
          <span class="shrink-0 text-lg text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden="true">→</span>
        </a>`
      : '');

  // Issue #3645 (F3): always render, with a first pill back up to the
  // Swiss-wide index hub — previously this section was skipped entirely
  // when no other canton had hubbed yet, leaving the canton hub with no
  // upward link. Now it's never empty, since the national index always
  // exists once this plugin runs at all.
  const cantonSwitcher = `<section class="mt-6 flex flex-wrap gap-2">
      <a class="rounded-full border border-accent-border bg-accent-subtle px-3 py-1 text-xs font-semibold text-heading hover:border-accent-border" href="${nationalIndexPath(locale)}">${esc(NATIONAL_COPY[locale].allCantonsLabel)}</a>
      ${otherCantons
        .map(
          (c) =>
            `<a class="rounded-full border border-edge bg-surface-raised px-3 py-1 text-xs font-semibold text-heading hover:border-accent-border" href="${pathFor(locale, c)}">${esc(cantonDisplayLabel(c, locale))}</a>`,
        )
        .join('')}
    </section>`;

  // #4414: real weekly count + soonest upcoming event, computed once and
  // reused for both the visible <details> markup and the FAQPage JSON-LD
  // below so the two never drift.
  const dynamicFaq = dynamicFaqPair(locale, events, dateStamp, copy.faqHubDynamicQ, copy.faqHubDynamicAHasEvents, copy.faqHubDynamicAEmpty);

  const body = `${EVENTS_STYLE_BLOCK}<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${nationalIndexPath(locale)}">${esc(NATIONAL_COPY[locale].breadcrumbLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(copy.hubLabel)}</span>
    </nav>

    <header class="ev-in relative overflow-hidden rounded-lg border border-edge bg-gradient-to-br from-accent-subtle via-surface to-info-subtle p-5 shadow-stripe-sm sm:p-8" data-speakable>
      <div class="pointer-events-none absolute -right-4 -top-4 select-none text-8xl opacity-20 sm:text-9xl" aria-hidden="true">🎉</div>
      <h1 class="relative max-w-4xl font-display text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.hubH1)}</h1>
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

    <section class="mt-8 ev-featured">
      <h2 class="font-display text-2xl font-bold text-heading">${esc(copy.upcoming)}</h2>
      <div class="mt-4">${renderEventList(upcoming, locale, detailHref)}</div>
    </section>

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <h2 class="font-display text-2xl font-bold text-heading">${esc(copy.byComune)}</h2>
      <p class="mt-2 max-w-3xl text-sm leading-6 text-body">${esc(copy.byComuneText)}</p>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${comuneGrid}</div>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: copy.faqHubQ1, a: copy.faqHubA1 },
        { q: copy.faqHubQ2, a: copy.faqHubA2 },
        dynamicFaq,
      ],
      copy.faqTitle,
    )}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <h2 class="font-display text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: copy.hubTitle,
    itemListElement: markupEligibleEvents(upcoming, dateStamp).map((event, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: lightEventLd(event, locale),
    })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: NATIONAL_COPY[locale].breadcrumbLabel, item: `${BASE_URL}${nationalIndexPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: copy.hubLabel, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: copy.faqHubQ1, acceptedAnswer: { '@type': 'Answer', text: copy.faqHubA1 } },
      { '@type': 'Question', name: copy.faqHubQ2, acceptedAnswer: { '@type': 'Answer', text: copy.faqHubA2 } },
      { '@type': 'Question', name: dynamicFaq.q, acceptedAnswer: { '@type': 'Answer', text: dynamicFaq.a } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;
  const html = buildSeoPageHtml({
    locale,
    title: copy.hubTitle,
    description: copy.hubDesc,
    canonicalUrl,
    hreflangHtml: buildAlternates(canton),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml,
    jsonLdScripts: [itemListLd, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

// ── Swiss-wide events index hub (issue #3645, F3) ───────────────────────────
// Canton-less landing page, one level above every `renderHubPage()` above —
// same structural template (breadcrumb / header / stat tiles / grid /
// upcoming list / crosslinks / FAQ / methodology) but the grid links out to
// cantons instead of comuni, and stats are aggregated across the whole
// dataset. Kept as its own function (not a `canton: 'CH'` special-case of
// `renderHubPage`) since the grid tile shape differs (canton label + count,
// no comune drill-down) and NATIONAL_COPY has no per-canton substitution.
export function renderEventsIndexPage(params: {
  locale: Locale;
  cantonStats: Array<{ canton: string; eventCount: number; comuneCount: number }>;
  events: SiteEvent[];
  dateStamp: string;
  weekendDays: Set<string>;
  distDir: string;
  detailHref?: DetailHref;
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, cantonStats, events, dateStamp, weekendDays, distDir, detailHref } = params;
  const copy = NATIONAL_COPY[locale];
  const canonicalPath = nationalIndexPath(locale);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;
  const totalComuni = cantonStats.reduce((sum, c) => sum + c.comuneCount, 0);
  // Was 60 — the date-sorted tail beyond the cap never got a link anywhere,
  // contributing to sitemap-eventi.xml's 14.99% BFS-depth orphan rate
  // (audit:max-bfs-depth). Raised so canton/digest hubs surface more of the
  // family within depth budget; see build-plugins/eventsSeoPagesPlugin.ts
  // header for the depth ≤2 hub design this caps still nest under.
  const upcoming = events.slice(0, 100);

  const cantonGrid = cantonStats
    .map(
      ({ canton, eventCount }) =>
        `<a class="group flex items-center justify-between gap-2 rounded-lg border border-edge bg-surface p-4 shadow-stripe-sm transition-all hover:-translate-y-0.5 hover:border-accent-border hover:shadow-stripe-md" href="${pathFor(locale, canton)}">
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-heading">${esc(cantonDisplayLabel(canton, locale))}</span>
            <span class="mt-1 block text-xs text-muted">${eventCount} ${esc(COPY[locale].eventsWord)}</span>
          </span>
          <span class="shrink-0 text-lg text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden="true">→</span>
        </a>`,
    )
    .join('');

  const body = `${EVENTS_STYLE_BLOCK}<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <span>${esc(copy.breadcrumbLabel)}</span>
    </nav>

    <header class="ev-in relative overflow-hidden rounded-lg border border-edge bg-gradient-to-br from-accent-subtle via-surface to-info-subtle p-5 shadow-stripe-sm sm:p-8" data-speakable>
      <div class="pointer-events-none absolute -right-4 -top-4 select-none text-8xl opacity-20 sm:text-9xl" aria-hidden="true">🇨🇭</div>
      <h1 class="relative max-w-4xl font-display text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.h1)}</h1>
      <p class="relative mt-3 max-w-3xl text-base leading-7 text-body">${esc(copy.lede)}</p>
      <p class="relative mt-3 text-sm text-muted">${renderSourceAttribution(events, COPY[locale], dateStamp)}</p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statCantons, String(cantonStats.length))}
      ${renderMetric(copy.statComuni, String(totalComuni))}
      ${renderMetric(copy.statWeekend, String(weekendCount))}
    </dl>

    <section class="mt-8 ev-featured">
      <h2 class="font-display text-2xl font-bold text-heading">${esc(copy.upcoming)}</h2>
      <div class="mt-4">${renderEventList(upcoming, locale, detailHref)}</div>
    </section>

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <h2 class="font-display text-2xl font-bold text-heading">${esc(copy.byCanton)}</h2>
      <p class="mt-2 max-w-3xl text-sm leading-6 text-body">${esc(copy.byCantonText)}</p>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${cantonGrid}</div>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: copy.faqQ1, a: copy.faqA1 },
        { q: copy.faqQ2, a: copy.faqA2 },
      ],
      copy.faqTitle,
    )}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <h2 class="font-display text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: copy.metaTitle,
    itemListElement: markupEligibleEvents(upcoming, dateStamp).map((event, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: lightEventLd(event, locale),
    })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` }, { '@type': 'ListItem', position: 2, name: copy.breadcrumbLabel, item: canonicalUrl }],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: copy.faqQ1, acceptedAnswer: { '@type': 'Answer', text: copy.faqA1 } },
      { '@type': 'Question', name: copy.faqQ2, acceptedAnswer: { '@type': 'Answer', text: copy.faqA2 } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;
  const html = buildSeoPageHtml({
    locale,
    title: copy.metaTitle,
    description: copy.metaDesc,
    canonicalUrl,
    hreflangHtml: buildNationalAlternates(),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml,
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
  // Was 40 — see the `upcoming` cap above for why this was raised (same
  // audit:max-bfs-depth orphan-tail fix). The tail past the cap is NOT dropped
  // any more: `renderOverflowIndex()` below links it as text rows (#5434).
  const list = events.slice(0, EVENT_CARD_CAP);
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;
  // #4414: real weekly count + soonest upcoming event for this comune —
  // scoped to the FULL comune `events` list (not the 40-item display slice)
  // so weekCount/next stay accurate even on comuni with >40 upcoming events.
  const dynamicFaq = dynamicFaqPair(locale, events, dateStamp, copy.faqComuneDynamicQ(comune), (weekCount, title, date) => copy.faqComuneDynamicAHasEvents(comune, weekCount, title, date), copy.faqComuneDynamicAEmpty(comune));

  const body = `${EVENTS_STYLE_BLOCK}<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${nationalIndexPath(locale)}">${esc(NATIONAL_COPY[locale].breadcrumbLabel)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(comune)}</span>
    </nav>

    <header class="ev-in relative overflow-hidden rounded-lg border border-edge bg-gradient-to-br from-accent-subtle via-surface to-success-subtle p-5 shadow-stripe-sm sm:p-8" data-speakable>
      <div class="pointer-events-none absolute -right-4 -top-4 select-none text-8xl opacity-20 sm:text-9xl" aria-hidden="true">📍</div>
      <h1 class="relative max-w-4xl font-display text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.comuneH1(comune))}</h1>
      <p class="relative mt-3 max-w-3xl text-base leading-7 text-body">${esc(copy.comuneLede(comune))}</p>
      <p class="relative mt-3 text-sm text-muted">${renderSourceAttribution(events, copy, dateStamp)}</p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-3">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statWeekend, String(weekendCount))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    <section class="mt-8 ev-featured">
      <h2 class="font-display text-2xl font-bold text-heading">${esc(copy.eventsIn(comune))}</h2>
      <div class="mt-4">${renderEventList(list, locale, detailHref)}</div>
    </section>

    ${renderOverflowIndex(events, EVENT_CARD_CAP, locale, detailHref)}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <a class="inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.allEvents)} →</a>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: copy.faqComuneQ1(comune), a: copy.faqComuneA1(comune) },
        { q: copy.faqComuneQ2, a: copy.faqComuneA2 },
        dynamicFaq,
      ],
      copy.faqTitle,
    )}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <h2 class="font-display text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: copy.comuneTitle(comune),
    itemListElement: markupEligibleEvents(list, dateStamp).map((event, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: lightEventLd(event, locale),
    })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: NATIONAL_COPY[locale].breadcrumbLabel, item: `${BASE_URL}${nationalIndexPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale, canton)}` },
      { '@type': 'ListItem', position: 4, name: comune, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: copy.faqComuneQ1(comune), acceptedAnswer: { '@type': 'Answer', text: copy.faqComuneA1(comune) } },
      { '@type': 'Question', name: copy.faqComuneQ2, acceptedAnswer: { '@type': 'Answer', text: copy.faqComuneA2 } },
      { '@type': 'Question', name: dynamicFaq.q, acceptedAnswer: { '@type': 'Answer', text: dynamicFaq.a } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;
  const html = buildSeoPageHtml({
    locale,
    title: copy.comuneTitle(comune),
    description: copy.comuneDesc(comune),
    canonicalUrl,
    hreflangHtml: buildAlternates(canton, comune),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml,
    jsonLdScripts: [itemListLd, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

// ── "Other events" bucket page (comune-less events) ─────────────────────────
// `groupByComune()` (scripts/lib/events-utils.mjs) intentionally DROPS events
// with `comune == null` — that contract is protected by
// tests/events-pipeline.test.ts and untouched here. Without this bucket page
// those events had no internal detail page to link to, so their card fell
// back to the raw crawled URL instead of our SEO detail page. This page
// collects them under the `OTHER_EVENTS_COMUNE_KEY` sentinel (routing only,
// see events-utils.mjs) so they get exactly the same detail-page treatment as
// every other event.
//
// Copy is its own literal TI text run through the SAME
// cantonSubstitutionRules/applyCantonSubstitution pass every other copy
// object in this file uses for non-TI cantons (copyFor/digestCopyFor/
// detailCopyFor) — deliberately NOT `copy.comuneH1`/`copy.comuneLede`/etc.,
// which interpolate a *comune* name with hardcoded prepositions that don't
// apply here (this bucket is per-canton, not per-comune, so plugging a
// canton name or the raw sentinel into those templates would read wrong).
interface OtherEventsCopy {
  metaTitle: string;
  metaDesc: string;
  h1: string;
  lede: string;
  tileLabel: string;
  breadcrumbLabel: string;
  faqQ1: string;
  faqA1: string;
  faqQ2: string;
  faqA2: string;
}

const OTHER_EVENTS_COPY: Record<Locale, OtherEventsCopy> = {
  it: {
    metaTitle: 'Altri eventi in Ticino | Eventi',
    metaDesc:
      "Eventi in Ticino per cui non abbiamo ancora identificato con certezza il comune: data, luogo (quando disponibile) e link al sito ufficiale.",
    h1: 'Altri eventi in Ticino',
    lede:
      "Eventi dall'agenda del Ticino per cui non abbiamo ancora identificato con certezza il comune. Li trovi comunque con data, luogo (quando disponibile) e link ufficiale.",
    tileLabel: 'Altri eventi',
    breadcrumbLabel: 'Altri eventi',
    faqQ1: 'Perché questi eventi non hanno un comune?',
    faqA1:
      'La fonte non indica un comune preciso per questi eventi in Ticino. Restano comunque raggiungibili con data, orario (quando noto) e link al sito ufficiale.',
    faqQ2: 'Le informazioni sugli eventi sono ufficiali?',
    faqA2:
      "Riprendiamo i dati dalle agende pubbliche. Per orari definitivi, biglietti e dettagli consulta sempre la pagina dell'organizzatore collegata a ogni evento.",
  },
  en: {
    metaTitle: 'Other events in Ticino | Events',
    metaDesc:
      'Events in Ticino we could not yet confidently attribute to a municipality: date, venue (when available) and a link to the official site.',
    h1: 'Other events in Ticino',
    lede:
      'Events from the Ticino agenda we could not yet confidently attribute to a municipality. You can still find them here with date, venue (when available) and the official link.',
    tileLabel: 'Other events',
    breadcrumbLabel: 'Other events',
    faqQ1: "Why don't these events have a municipality?",
    faqA1:
      'The source does not give a precise municipality for these events in Ticino. They stay reachable here with date, time (when known) and a link to the official site.',
    faqQ2: 'Is the event information official?',
    faqA2:
      "We mirror data from public agendas. For final times, tickets and details always check the organiser's page linked on each event.",
  },
  de: {
    metaTitle: 'Weitere Veranstaltungen im Tessin | Veranstaltungen',
    metaDesc:
      'Veranstaltungen im Tessin, denen wir noch keine Gemeinde sicher zuordnen konnten: Datum, Ort (falls bekannt) und Link zur offiziellen Website.',
    h1: 'Weitere Veranstaltungen im Tessin',
    lede:
      'Veranstaltungen aus der Tessiner Agenda, die wir noch keiner Gemeinde sicher zuordnen konnten. Du findest sie hier trotzdem mit Datum, Ort (falls bekannt) und offiziellem Link.',
    tileLabel: 'Weitere Veranstaltungen',
    breadcrumbLabel: 'Weitere Veranstaltungen',
    faqQ1: 'Warum haben diese Veranstaltungen keine Gemeinde?',
    faqA1:
      'Die Quelle nennt für diese Veranstaltungen im Tessin keine genaue Gemeinde. Sie bleiben trotzdem hier auffindbar, mit Datum, Uhrzeit (falls bekannt) und Link zur offiziellen Website.',
    faqQ2: 'Sind die Veranstaltungsinfos offiziell?',
    faqA2:
      'Wir spiegeln Daten aus öffentlichen Agenden. Für endgültige Zeiten, Tickets und Details prüfe immer die verlinkte Veranstalterseite.',
  },
  fr: {
    metaTitle: 'Autres événements au Tessin | Événements',
    metaDesc:
      "Événements au Tessin que nous n'avons pas encore pu attribuer avec certitude à une commune : date, lieu (si disponible) et lien vers le site officiel.",
    h1: 'Autres événements au Tessin',
    lede:
      "Événements de l'agenda du Tessin que nous n'avons pas encore pu attribuer avec certitude à une commune. Vous les trouvez ici avec date, lieu (si disponible) et lien officiel.",
    tileLabel: 'Autres événements',
    breadcrumbLabel: 'Autres événements',
    faqQ1: "Pourquoi ces événements n'ont-ils pas de commune ?",
    faqA1:
      "La source n'indique pas de commune précise pour ces événements au Tessin. Ils restent accessibles ici avec date, heure (si connue) et lien vers le site officiel.",
    faqQ2: 'Les informations sur les événements sont-elles officielles ?',
    faqA2:
      "Nous reprenons les données des agendas publics. Pour les horaires définitifs, billets et détails, consultez toujours la page de l'organisateur liée à chaque événement.",
  },
};

/** Short, budget-safe fallback `metaTitle` per locale — same overflow risk
 * as `HUB_TITLE_FALLBACK`/`DIGEST_TITLE_FALLBACK`. */
const OTHER_EVENTS_TITLE_FALLBACK: Record<Locale, (display: string) => string> = {
  it: (d) => `Altri eventi in ${d}`,
  en: (d) => `Other events in ${d}`,
  de: (d) => `Weitere Veranstaltungen in ${d}`,
  fr: (d) => `Autres événements à ${d}`,
};

const otherEventsCopyCache = new Map<string, OtherEventsCopy>();
/** Same TI-verbatim / non-TI-substituted split as `copyFor`/`detailCopyFor`. */
function otherEventsCopyFor(canton: string, locale: Locale): OtherEventsCopy {
  if (canton.toUpperCase() === 'TI') return OTHER_EVENTS_COPY[locale];
  const cacheKey = `${canton}|${locale}`;
  const cached = otherEventsCopyCache.get(cacheKey);
  if (cached) return cached;
  const rules = cantonSubstitutionRules(canton, locale);
  const base = OTHER_EVENTS_COPY[locale];
  const sub = (s: string) => applyCantonSubstitution(s, rules);
  const display = cantonDisplayLabel(canton, locale);
  const out: OtherEventsCopy = {
    ...base,
    metaTitle: composePlaceTitle(
      [sub(base.metaTitle), OTHER_EVENTS_TITLE_FALLBACK[locale](display)],
      TITLE_MAX_CHARS,
      (s) => esc(s).length,
    ),
    metaDesc: sub(base.metaDesc),
    h1: sub(base.h1),
    lede: sub(base.lede),
    faqQ1: sub(base.faqQ1),
    faqA1: sub(base.faqA1),
  };
  otherEventsCopyCache.set(cacheKey, out);
  return out;
}

/** Bucket page for events whose source gave no `comune` — see the block
 * comment above. Same SEO contract as `renderComunePage` (ItemList +
 * BreadcrumbList + FAQPage JSON-LD, hreflang, MIN_INDEXABLE_WORDS gate), own
 * copy (`otherEventsCopyFor`), canonical path via
 * `pathFor(locale, canton, OTHER_EVENTS_COMUNE_KEY)` (routes through
 * `OTHER_EVENTS_SEGMENT`, never the raw sentinel). */
export function renderOtherEventsPage(params: {
  locale: Locale;
  canton: string;
  events: SiteEvent[];
  dateStamp: string;
  weekendDays: Set<string>;
  distDir: string;
  detailHref?: DetailHref;
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, canton, events, dateStamp, weekendDays, distDir, detailHref } = params;
  const copy = copyFor(canton, locale);
  const oeCopy = otherEventsCopyFor(canton, locale);
  const canonicalPath = pathFor(locale, canton, OTHER_EVENTS_COMUNE_KEY);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  // Was 40 — see the `upcoming` cap above for why this was raised (same
  // audit:max-bfs-depth orphan-tail fix). The tail past the cap is NOT dropped
  // any more: `renderOverflowIndex()` below links it as text rows (#5434). This
  // sentinel bucket is the LARGEST one in the dataset (683 upcoming events
  // measured 2026-08-09), so it is also the page that block weighs most on —
  // hence its own, lower `OTHER_EVENTS_CARD_CAP` rather than the hub number.
  const list = events.slice(0, OTHER_EVENTS_CARD_CAP);
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;

  const body = `${EVENTS_STYLE_BLOCK}<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${nationalIndexPath(locale)}">${esc(NATIONAL_COPY[locale].breadcrumbLabel)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(oeCopy.breadcrumbLabel)}</span>
    </nav>

    <header class="ev-in relative overflow-hidden rounded-lg border border-edge bg-gradient-to-br from-accent-subtle via-surface to-success-subtle p-5 shadow-stripe-sm sm:p-8" data-speakable>
      <div class="pointer-events-none absolute -right-4 -top-4 select-none text-8xl opacity-20 sm:text-9xl" aria-hidden="true">📍</div>
      <h1 class="relative max-w-4xl font-display text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(oeCopy.h1)}</h1>
      <p class="relative mt-3 max-w-3xl text-base leading-7 text-body">${esc(oeCopy.lede)}</p>
      <p class="relative mt-3 text-sm text-muted">${renderSourceAttribution(events, copy, dateStamp)}</p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-3">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statWeekend, String(weekendCount))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    <section class="mt-8 ev-featured">
      <h2 class="font-display text-2xl font-bold text-heading">${esc(oeCopy.h1)}</h2>
      <div class="mt-4">${renderEventList(list, locale, detailHref)}</div>
    </section>

    ${renderOverflowIndex(events, OTHER_EVENTS_CARD_CAP, locale, detailHref)}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <a class="inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.allEvents)} →</a>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: oeCopy.faqQ1, a: oeCopy.faqA1 },
        { q: oeCopy.faqQ2, a: oeCopy.faqA2 },
      ],
      copy.faqTitle,
    )}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <h2 class="font-display text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: oeCopy.h1,
    itemListElement: markupEligibleEvents(list, dateStamp).map((event, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: lightEventLd(event, locale),
    })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: NATIONAL_COPY[locale].breadcrumbLabel, item: `${BASE_URL}${nationalIndexPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale, canton)}` },
      { '@type': 'ListItem', position: 4, name: oeCopy.breadcrumbLabel, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: oeCopy.faqQ1, acceptedAnswer: { '@type': 'Answer', text: oeCopy.faqA1 } },
      { '@type': 'Question', name: oeCopy.faqQ2, acceptedAnswer: { '@type': 'Answer', text: oeCopy.faqA2 } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}`;
  const html = buildSeoPageHtml({
    locale,
    title: oeCopy.metaTitle,
    description: oeCopy.metaDesc,
    canonicalUrl,
    hreflangHtml: buildAlternates(canton, OTHER_EVENTS_COMUNE_KEY),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml,
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

/**
 * Minimum escaped-char budget the chosen suffix candidate must leave for the
 * event title before {@link eventDetailMetaTitle} degrades to a shorter
 * suffix. 12 mirrors `composeSerpJobTitle`'s "meaningful role fragment"
 * floor (`roleBudget >= 12`, build-plugins/shared/titleSuffix.ts) — below
 * it the title collapses to a useless `…`/2-3 word stub while 20+ chars of
 * region boilerplate squat in the SERP. 12 also exactly preserves the
 * pre-#3799 output for every previously-healthy combo: the worst full-suffix
 * case that shipped correctly (fr/AR + "Herisau", 54-char suffix) leaves
 * precisely 12.
 */
const MIN_DETAIL_TITLE_BUDGET = 12;

/**
 * Event-detail <title>: "{event title} {suffix}" where suffix carries
 * comune + region + brand (` — Lugano (Ticino) | Eventi`). Event titles are
 * crawled third-party text (tio.ch agenda) of uncontrolled length — fixing
 * "at source" isn't actionable the way it is for owned-copy headlines, so
 * (like {@link composeSerpJobTitle}'s role/city cascade) the title itself is
 * the truncatable token: word-aware {@link truncateHeadline}, never a naive
 * mid-string cut. The comune is always preserved — it's the local-SEO
 * signal, analogous to city in job titles; region/brand are droppable
 * boilerplate under budget pressure (#3799, cascade below).
 *
 * Budget and overflow check are computed on the ESCAPED length, not the raw
 * length: `audit-title-length.mjs` measures the raw HTML source of `<title>`,
 * which `htmlTemplate.ts` renders as `esc(title)` (one escape pass) — mirrors
 * the `measureLength` pattern in {@link buildTitleWithBrand} /
 * {@link composeSerpJobTitle} (`titleSuffix.ts`). A raw `&`/`<`/`>`/`"` in a
 * crawled title (e.g. "Rock & Blues Night") expands on escape, so a title
 * that looks in-budget pre-escape can still overflow the 66-char cap
 * post-escape. `truncateHeadline` itself truncates on RAW code units, so an
 * already-in-raw-budget title can still escape-overflow (a retained `&`
 * survives truncation) — shrink the raw ceiling and retry until the escaped
 * result fits; bounded by `budget` iterations (`truncateHeadline` degrades to
 * `'…'` once `max` hits 0, which always measures within any budget >= 1).
 * `Math.max(1, …)` guards a comune suffix long enough to push the budget
 * negative, which would otherwise make `truncateHeadline` emit an empty/
 * broken title.
 *
 * #3799 (deferred from PR #3796): the suffix is now a CASCADE of candidates,
 * longest/most-descriptive first (full comune+region+brand → comune+brand →
 * comune only, see {@link DETAIL_TITLE_SUFFIXES}) — same "never drop the
 * place, shrink the boilerplate around it" policy as
 * {@link composePlaceTitle} / {@link composeSerpJobTitle}. A degenerate
 * comune+canton combo (worst dataset case: the comune-less "other events"
 * bucket, where the comune IS the canton display label — fr/AR ` — Appenzell
 * Rhodes-Extérieures (Appenzell Rhodes-Extérieures) | Événements` is 75
 * chars, 9 past the cap on its own) previously clamped the budget to 1 and
 * emitted `'…' + suffix`, silently past TITLE_MAX_CHARS. Now the first
 * candidate leaving at least {@link MIN_DETAIL_TITLE_BUDGET} escaped chars
 * for the event title wins: region and brand are boilerplate (brand is
 * droppable per the `buildTitleWithBrand` policy, region is recoverable from
 * breadcrumb/H1/JSON-LD), the comune is the local-SEO signal and is always
 * kept. The final whole-string shrink loop is a last-resort cap guarantee
 * (mirrors `composePlaceTitle`'s `truncateHeadline` fallback) for a
 * pathological place name that overflows the cap even bare — the emitted
 * <title> can never exceed TITLE_MAX_CHARS.
 */
function eventDetailMetaTitle(rawTitle: string, suffixes: readonly string[]): string {
  // First suffix candidate that leaves a meaningful title budget wins; when
  // even the bare-comune candidate is squeezed, still use it (the shortest).
  const suffix = suffixes.find((s) => TITLE_MAX_CHARS - esc(s).length >= MIN_DETAIL_TITLE_BUDGET)
    ?? suffixes[suffixes.length - 1] ?? '';
  const budget = Math.max(1, TITLE_MAX_CHARS - esc(suffix).length);
  let title = rawTitle;
  for (let max = budget; esc(title).length > budget && max > 0; max -= 1) {
    title = truncateHeadline(rawTitle, max);
  }
  const composed = `${title}${suffix}`;
  if (esc(composed).length <= TITLE_MAX_CHARS) return composed;
  // Unreachable for gazetteer/canton-label comuni (the bare ` — ${comune}`
  // candidate always leaves budget); guards pathological place names so the
  // deploy-blocking audit:title-length gate can never trip on this page type.
  let out = composed;
  for (let max = TITLE_MAX_CHARS; esc(out).length > TITLE_MAX_CHARS && max > 0; max -= 1) {
    out = truncateHeadline(composed, max);
  }
  return out;
}

/** Per-locale event-detail `<title>` suffix templates (comune + region +
 * brand), extracted out of `DETAIL_COPY[locale].metaTitle` so
 * `detailCopyFor` can canton-substitute the suffix itself and re-run it
 * through {@link eventDetailMetaTitle} for non-TI cantons. The pre-#3796
 * code substituted the canton name into the ALREADY-budgeted/truncated
 * string `eventDetailMetaTitle` returned (assuming TI's short
 * "Ticino"/"Tessin"), with no re-check — a long canton display name (e.g.
 * "Appenzell Rhodes-Extérieures", 28 chars vs "Tessin"'s 6) silently pushed
 * the final `<title>` past TITLE_MAX_CHARS for every affected event-detail
 * page.
 *
 * #3799: each locale now returns a candidate CASCADE, longest first —
 * full (comune + region + brand) → drop the region parenthetical → bare
 * comune — consumed by {@link eventDetailMetaTitle}, which picks the first
 * candidate leaving at least {@link MIN_DETAIL_TITLE_BUDGET} chars for the
 * event title. Every candidate embeds the comune (the never-dropped
 * local-SEO token), mirroring the `composePlaceTitle` candidate contract. */
const DETAIL_TITLE_SUFFIXES: Record<Locale, (comune: string) => string[]> = {
  it: (c) => [` — ${c} (Ticino) | Eventi`, ` — ${c} | Eventi`, ` — ${c}`],
  en: (c) => [` — ${c} (Ticino) | Events`, ` — ${c} | Events`, ` — ${c}`],
  de: (c) => [` — ${c} (Tessin) | Veranstaltungen`, ` — ${c} | Veranstaltungen`, ` — ${c}`],
  fr: (c) => [` — ${c} (Tessin) | Événements`, ` — ${c} | Événements`, ` — ${c}`],
};

const DETAIL_COPY: Record<Locale, DetailCopy> = {
  it: {
    metaTitle: (t, c) => eventDetailMetaTitle(t, DETAIL_TITLE_SUFFIXES.it(c)),
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
    metaTitle: (t, c) => eventDetailMetaTitle(t, DETAIL_TITLE_SUFFIXES.en(c)),
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
    metaTitle: (t, c) => eventDetailMetaTitle(t, DETAIL_TITLE_SUFFIXES.de(c)),
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
    metaTitle: (t, c) => eventDetailMetaTitle(t, DETAIL_TITLE_SUFFIXES.fr(c)),
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
    // Root-cause fix (recurrence of #3772): re-run the escape/budget-aware
    // truncation against the REAL (canton-substituted) suffix, instead of
    // substituting into `base.metaTitle`'s already-truncated output — see
    // `DETAIL_TITLE_SUFFIXES` doc comment above. #3799: every candidate in
    // the cascade is substituted, so the min-budget check runs against the
    // real canton name at each degradation step too.
    metaTitle: (t: string, c: string) => eventDetailMetaTitle(t, DETAIL_TITLE_SUFFIXES[locale](c).map(sub)),
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
    ? `<div class="ev-locmap"><iframe src="${esc(osmEmbedSrc(event.geo.lat, event.geo.lng))}" width="100%" height="100%" style="border:0;display:block;width:100%;height:100%" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="${esc(dc.mapLinkLabel(map.place))}" aria-label="${esc(dc.mapLinkLabel(map.place))}"></iframe></div>`
    : '';
  return `<section class="ev-loc">
    ${embed}
    <div class="p-5">
      <h2 class="ev-loc-h"><span aria-hidden="true">📍</span> ${esc(dc.whereLabel)}</h2>
      <p class="ev-p-sm">${esc(venueOrComune)}${addressText ? ` · ${esc(addressText)}` : ''}</p>
      <a class="ev-btn" href="${esc(map.href)}" rel="nofollow noopener" target="_blank" aria-label="${esc(dc.mapLinkLabel(map.place))}">${esc(dc.mapLinkLabel(map.place))} →</a>
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
  /**
   * Set for the short grace-window bridge page emitted for events that
   * already ended (`recentlyEndedEvents`). Forces `noindex,follow`, shows a
   * "this already took place" notice, and drops Event JSON-LD — Google
   * guidance is to avoid rich-result markup for past events (unlike
   * JobPosting, which explicitly supports a past `validThrough`).
   */
  isPast?: boolean;
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, event, comune, eventSlug, sameComuneEvents, dateStamp, distDir, detailHref, isPast = false } = params;
  // #3739: an unresolved canton must route to the canton-neutral bucket, not
  // silently mislabel the event as Ticino.
  const canton = (event.canton || UNRESOLVED_CANTON_KEY).toUpperCase();
  const title = localizedTitle(event, locale);
  const copy = copyFor(canton, locale);
  const dc = detailCopyFor(canton, locale);
  const canonicalPath = pathForEventDetail(locale, comune, eventSlug, canton);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const comunePath = pathFor(locale, canton, comune);
  // Comune-less events (`comune === OTHER_EVENTS_COMUNE_KEY`, see
  // scripts/lib/events-utils.mjs) still ROUTE through the sentinel
  // (OTHER_EVENTS_SEGMENT, via pathFor/pathForEventDetail above), but every
  // user-visible string below must show an honest label — the canton's
  // display name — never the raw internal sentinel string.
  const displayComune = comune === OTHER_EVENTS_COMUNE_KEY ? cantonDisplayLabel(canton, locale) : comune;
  const when = humanDate(event.startDate, locale);
  const time = event.startTime ? ` · ${esc(event.startTime)}` : '';
  const cat = categoryLabel(event.category, locale);
  // Was 6 — raised alongside the hub/digest list caps above (same
  // audit:max-bfs-depth orphan-tail fix): more sibling cross-links per
  // detail page means more paths into the date-sorted tail.
  const others = sameComuneEvents.filter((e) => e.id !== event.id).slice(0, 10);
  const map = osmLink(event, displayComune);
  const description = localizedDescription(event, locale);
  const visual = categoryVisual(event.category);
  // `imageUrl` only ever holds a mirrored site-relative path — see the same
  // guard in `renderEventCard`/`mirroredEventImageObject`. No direct photo →
  // per-category catalog SVG (real, site-owned image, never absent) instead
  // of no hero image at all.
  const heroImage = event.imageUrl && event.imageUrl.startsWith('/')
    ? `<div class="ev-in ev-hero"><img class="ev-heroimg" src="${esc(event.imageUrl)}" width="1200" height="675" loading="eager" fetchpriority="high" alt="${esc(title)}"></div>`
    : `<div class="ev-in ev-hero"><img class="ev-heroimg" src="${esc(catalogImagePath(event.category))}" width="1200" height="675" loading="eager" fetchpriority="high" alt="${esc(cat)}"></div>`;

  const body = `${EVENTS_STYLE_BLOCK}<div class="ev-wrap3">
    <nav class="ev-crumb" aria-label="Breadcrumb">
      <a class="ev-lnk" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="ev-lnk" href="${nationalIndexPath(locale)}">${esc(NATIONAL_COPY[locale].breadcrumbLabel)}</a>
      <span class="mx-2">/</span>
      <a class="ev-lnk" href="${pathFor(locale, canton)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <a class="ev-lnk" href="${comunePath}">${esc(displayComune)}</a>
      <span class="mx-2">/</span>
      <span>${esc(title)}</span>
    </nav>

    ${heroImage}

    <header class="${heroImage ? '' : 'ev-in '}ev-head" data-speakable>
      <span class="ev-tag ${TONE_CHIP_ATOM[visual.tone]}">${visual.emoji} ${esc(cat)}</span>
      ${event.recurring ? `<span class="ev-tag2">${esc(dc.recurringLabel)}</span>` : ''}
      <h1 class="ev-h1">${esc(title)}</h1>
      <p class="ev-lede">${esc(dc.lede(when, time, event.venue ? event.venue : '', displayComune))}</p>
      ${description ? `<p class="ev-p-sm3">${esc(description)}</p>` : ''}
    </header>

    ${isPast ? `<p class="ev-past">${esc(PAST_EVENT_NOTICE[locale])}</p>` : ''}

    <dl class="ev-dl">
      ${renderMetric(dc.whenLabel, `${esc(when)}${time}`)}
      ${renderMetric(dc.whereLabel, esc(event.venue || displayComune))}
      ${renderMetric(dc.catLabel, esc(cat))}
      ${renderMetric(dc.comuneLabel, esc(displayComune))}
      ${priceLine(event, dc)}
      ${addressLine(event, dc)}
    </dl>

    ${renderLocationCard(event, displayComune, dc, map)}

    <section class="ev-cta">
      <a class="${CTA_PRIMARY_CLASS}" href="${esc(eventReferralUrl(event.url, event))}" rel="nofollow noopener" target="_blank">${esc(dc.officialSite)} →</a>
      <a class="ev-btn2" href="${comunePath}">${esc(dc.allInComune(displayComune))} →</a>
    </section>

    <section class="mt-8">
      <h2 class="ev-h2b">${esc(dc.aboutTitle)}</h2>
      <p class="ev-lede">${esc(dc.about(title, displayComune, `${when}${event.startTime ? ` (${event.startTime})` : ''}`, cat, event.venue))}</p>
      ${description ? `<h3 class="ev-h3">${esc(dc.descriptionTitle)}</h3><p class="ev-p">${esc(description)}</p>` : ''}
    </section>

    <section class="ev-panel">
      <h2 class="ev-h2">${esc(dc.practicalTitle)}</h2>
      <p class="ev-p-sm3">${esc(dc.practical(displayComune))}</p>
    </section>

    ${
      others.length > 0
        ? `<section class="mt-8">
      <h2 class="ev-h2b">${esc(dc.moreTitle(displayComune))}</h2>
      <div class="mt-4">${renderEventList(others, locale, detailHref)}</div>
    </section>`
        : ''
    }

    ${renderCrosslinks(locale)}

    ${renderFaq(
      [
        { q: dc.faqQ1(title), a: dc.faqA1(displayComune, when) },
        { q: dc.faqQ2(displayComune), a: dc.faqA2(displayComune) },
      ],
      copy.faqTitle,
    )}
  </div>`;

  // Past events: drop Event JSON-LD entirely (Google recommends against rich
  // results for events that already happened) rather than keep it with a
  // stale date, unlike JobPosting which explicitly supports a past
  // `validThrough` — see comment on `isPast` above.
  const eventLdScript = isPast ? null : inlineScriptJson(eventLd(event, locale, canonicalUrl));
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: NATIONAL_COPY[locale].breadcrumbLabel, item: `${BASE_URL}${nationalIndexPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale, canton)}` },
      { '@type': 'ListItem', position: 4, name: displayComune, item: `${BASE_URL}${comunePath}` },
      { '@type': 'ListItem', position: 5, name: title, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: dc.faqQ1(title), acceptedAnswer: { '@type': 'Answer', text: dc.faqA1(displayComune, when) } },
      { '@type': 'Question', name: dc.faqQ2(displayComune), acceptedAnswer: { '@type': 'Answer', text: dc.faqA2(displayComune) } },
    ],
  });

  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable: !isPast && wordCount >= MIN_INDEXABLE_WORDS })}`;
  const html = buildSeoPageHtml({
    locale,
    title: dc.metaTitle(title, displayComune),
    description: dc.metaDesc(title, displayComune, when),
    canonicalUrl,
    hreflangHtml: buildEventAlternates(canton, comune, eventSlug),
    robots: !isPast && wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml,
    jsonLdScripts: eventLdScript ? [eventLdScript, breadcrumbLd, faqLd] : [breadcrumbLd, faqLd],
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
      `<a class="rounded-md border border-edge bg-surface-raised p-4 text-sm font-semibold text-heading shadow-stripe-sm transition-colors hover:border-accent-border hover:text-accent" href="${pathForDigest(locale, canton, d.slug)}">${esc(digestCopyFor(d, canton, locale).h1)}</a>`,
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
  // Was 60 — see the `upcoming` cap above for why this was raised (same
  // audit:max-bfs-depth orphan-tail fix).
  const list = events.slice(0, 100);
  const byComune = groupByComune(events) as Map<string, SiteEvent[]>;

  const comuneGrid = [...byComune.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(
      ([comune, l]) =>
        `<a class="rounded-md border border-edge bg-surface p-4 shadow-stripe-sm transition-colors hover:border-accent-border" href="${pathFor(locale, canton, comune)}"><span class="block text-sm font-semibold text-heading">${esc(comune)}</span><span class="mt-1 block text-xs text-muted">${l.length} ${esc(copy.eventsWord)}</span></a>`,
    )
    .join('');

  const body = `${EVENTS_STYLE_BLOCK}<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${nationalIndexPath(locale)}">${esc(NATIONAL_COPY[locale].breadcrumbLabel)}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(dc.h1)}</span>
    </nav>

    <header class="ev-in rounded-md border border-edge bg-surface p-5 shadow-stripe-sm sm:p-7" data-speakable>
      <h1 class="max-w-4xl font-display text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(dc.h1)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(dc.lede)}</p>
      <p class="mt-3 text-sm text-muted">${renderSourceAttribution(events, copy, dateStamp)}</p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-3">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statComuni, String(byComune.size))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    <section class="mt-8 ev-featured">
      <h2 class="font-display text-2xl font-bold text-heading">${esc(dc.h1)}</h2>
      <div class="mt-4">${renderEventList(list, locale, detailHref)}</div>
    </section>

    ${
      comuneGrid
        ? `<section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm"><h2 class="font-display text-2xl font-bold text-heading">${esc(copy.byComune)}</h2><div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${comuneGrid}</div></section>`
        : ''
    }

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <a class="inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale, canton)}">${esc(copy.allEvents)} →</a>
    </section>

    ${renderCrosslinks(locale)}

    ${renderFaq([{ q: dc.faqQ, a: dc.faqA }], copy.faqTitle)}

    <section class="mt-8 rounded-md border border-edge bg-surface p-5 shadow-stripe-sm">
      <h2 class="font-display text-xl font-bold text-heading">${esc(copy.methodologyTitle)}</h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-body">${esc(copy.methodology)}</p>
    </section>
  </div>`;

  const itemListLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: dc.title,
    itemListElement: markupEligibleEvents(list, dateStamp).map((event, i) => ({ '@type': 'ListItem', position: i + 1, item: lightEventLd(event, locale) })),
  });
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: NATIONAL_COPY[locale].breadcrumbLabel, item: `${BASE_URL}${nationalIndexPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale, canton)}` },
      { '@type': 'ListItem', position: 4, name: dc.h1, item: canonicalUrl },
    ],
  });
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [{ '@type': 'Question', name: dc.faqQ, acceptedAnswer: { '@type': 'Answer', text: dc.faqA } }],
  });

  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `${body}${endOfContentMultiplexHtml({ indexable: events.length > 0 && wordCount >= MIN_INDEXABLE_WORDS })}`;
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
    bodyHtml,
    jsonLdScripts: [itemListLd, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

// Issue #3645 (F3) sitemap-sharding evaluation: a single `sitemap-eventi.xml`
// (this function's return value) holds every hub/comune/digest/detail URL
// for every hubbed canton, across all 4 locales' hreflang alternates — but
// alternates are child <xhtml:link> nodes, not separate <url> entries, so
// the relevant cap is the sitemap protocol's 50,000 <url> ELEMENTS per file
// (50MB uncompressed), not a locale multiple.
//
// Measured against the live `data/events.json` (2026-07-06, all 26 canton
// groups already crawled post-F1/F2): 1 national index + ~24 distinct hub
// URLs (AI/AR and BL/BS collapse to one URL each, deduped by
// `dedupeUrlsetXmlByLoc`) + up to 48 digest entries (2 digests × 24 groups)
// + ~239 comune entries + ~6 comune-less "other events" bucket pages + 1084
// event-detail entries ≈ 1,400 <url> elements total — under 3% of the 50k
// cap. Even a 10x growth in crawled events (same canton count) lands
// ~14,000; a 30x growth (~42,000) is the point this stops being
// comfortable. Conclusion: per-canton sharding is NOT needed yet. Revisit
// once this file's own <url> count approaches ~40,000 (buffer before the
// hard cap) — at that point shard by canton (one
// `sitemap-eventi-<canton>.xml` per group, indexed from a sitemap index),
// mirroring the existing `data/seo-404-compat/part-*.json` sharding pattern
// used elsewhere in this codebase for the same class of problem.
function buildSitemap(
  perCanton: Array<{ canton: string; comuni: string[]; digests: DigestDef[]; hasOtherEvents?: boolean }>,
  dateStamp: string,
  detailEntries: Array<{ canton: string; comune: string; slug: string }> = [],
): string {
  // National index hub (issue #3645, F3) — always included: this function
  // only runs when the plugin's own `all.length === 0` early-return in
  // `closeBundle()` already let execution through, at which point the
  // Swiss-wide index page is always emitted too (see the `renderEventsIndexPage`
  // loop there), so it always belongs in the sitemap.
  const entries: string[] = [nationalIndexSitemapUrl(dateStamp)];
  for (const { canton, comuni, digests, hasOtherEvents } of perCanton) {
    // Hub
    entries.push(sitemapUrl(canton, undefined, dateStamp, '0.7'));
    // Time-window digests (only the indexable ones)
    for (const d of digests) entries.push(digestSitemapUrl(canton, d.slug, dateStamp));
    for (const comune of comuni) entries.push(sitemapUrl(canton, comune, dateStamp, '0.5'));
    // "Other events" bucket page (comune-less events, see renderOtherEventsPage)
    if (hasOtherEvents) entries.push(sitemapUrl(canton, OTHER_EVENTS_COMUNE_KEY, dateStamp, '0.5'));
  }
  // Per-event detail pages
  for (const e of detailEntries) entries.push(eventDetailSitemapUrl(e.canton, e.comune, e.slug, dateStamp));
  // #3516: half-canton merges (BS/BL → /eventi/basilea/) can push the same
  // hub <loc> twice within this one file — dedupe keep-first at assembly.
  return dedupeUrlsetXmlByLoc(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`);
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

// Priority 0.8: higher than a per-canton hub (0.7) — this is the single
// entry point one hop above all of them (issue #3645, F3).
function nationalIndexSitemapUrl(dateStamp: string): string {
  const alternates = LOCALES.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${nationalIndexPath(locale)}" />`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${nationalIndexPath('it')}" />`)
    .join('\n');
  return `  <url>\n    <loc>${BASE_URL}${nationalIndexPath('it')}</loc>\n${alternates}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`;
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

/**
 * Assign a stable, collision-free detail slug to every event in `list`
 * (already scoped to one canton+comune peer group). `slugifyEvent(ev)` is
 * the base; ties (same title+date) are broken with a plain incrementing
 * suffix (`-2`, `-3`, ...) in list order. `list` must already be
 * deterministically ordered on ties — both `upcomingEvents` and
 * `recentlyEndedEvents` (scripts/lib/events-utils.mjs) sort ties on
 * `.title` then `.id`, so two colliding events always land in the same
 * relative order regardless of crawl/dataset insertion order or which of
 * the two functions produced `list`.
 *
 * `reservedBaseSlugs` marks base slugs already claimed by a sibling OUTSIDE
 * `list` — used so a "recently ended" bridge-page slug can never silently
 * reuse a base slug that is still the CURRENT live/indexed slug for a
 * same-title+date sibling in the same comune (issue #3700: a multi-day
 * event sharing the exact title+startDate as one that already ended keeps
 * its live bare slug; the ending one gets the decorated fallback instead of
 * fighting over the same URL).
 */
export function assignEventSlugs(list: SiteEvent[], reservedBaseSlugs: ReadonlySet<string> = new Set()): Map<string, string> {
  const used = new Set<string>(reservedBaseSlugs);
  const slugFor = new Map<string, string>();
  for (const ev of list) {
    const base = slugifyEvent(ev);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    slugFor.set(ev.id, slug);
  }
  return slugFor;
}

/**
 * Build the `reservedBaseSlugs` set for a past-bridge `assignEventSlugs` call:
 * the ACTUAL assigned slug (post-dedup, e.g. `base-2` for a second
 * same-title+date sibling) for every still-live event in the same comune —
 * never the raw `slugifyEvent(ev)` base. Two live siblings sharing
 * title+date collapse to the same raw base, so reserving the raw base only
 * ever protects the FIRST one and leaves the disambiguated sibling's real
 * URL unprotected against a past-bridge page landing on it (issue #3715).
 */
export function reserveLiveSiblingSlugs(
  liveSameComune: readonly SiteEvent[],
  detailSlugs: ReadonlyMap<string, { slug: string }>,
): Set<string> {
  return new Set(liveSameComune.map((ev) => detailSlugs.get(ev.id)!.slug));
}

export function eventsSeoPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'events-seo-pages',
    apply: 'build',
    enforce: 'post',
    // Issue #4263 item 4: this plugin is a pure PRODUCER (its closeBundle body has
    // no fs.existsSync gap-fill check against any sibling plugin's output). The
    // CONSUMERS that gap-fill against ITS dist output (legacyRedirectsPlugin,
    // cantonOrphanRedirectsPlugin, jobOrphanBridgePlugin, locationHubBridgePlugin,
    // companyHubBridgePlugin, legacyAliasPlugin, cfHot404BridgePlugin) are the ones
    // that need `order:'post'` + `sequential:true` to await this handler before
    // running theirs. Adding the same wrapper here too was tried and reverted:
    // Rollup's getSortedValidatedPlugins buckets closeBundle hooks by hook-level
    // `order`, independently of Vite's plugin-level `enforce` — giving BOTH this
    // producer and its consumers the identical `order:'post'` moves them into the
    // SAME hook bucket, where relative position is inherited from the incoming
    // (Vite enforce-sorted) plugin array, i.e. unchanged from today — so it adds a
    // spurious `sequential:true` wait here (nothing depends on this plugin running
    // LATE) without fixing anything. Verified via an isolated reproduction against
    // the installed rollup package. Left as a plain closeBundle.
    async closeBundle() {
      if (process.env.SKIP_EVENTS_PAGES === '1') {
        console.log('\x1b[36m[events-pages]\x1b[0m skipped (SKIP_EVENTS_PAGES=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      // #5911: BUILD_DATE_STAMP (derived from the deploy-wide BUILD_ID), NOT a
      // fresh `new Date()` — this "today" gates which comuni get event pages
      // (upcomingEvents/digest/recentlyEndedEvents below), and on the matrix
      // deploy the it/en/de/fr shards are 4 independent multi-hour processes.
      // A per-shard `new Date()` could cross a UTC-midnight boundary between
      // shards, so the same event flips upcoming/past differently per shard —
      // the comune page exists on one shard but not its siblings, while the
      // (locale-filter-blind-by-design) hreflang alternates below still point
      // at all 4. See build-plugins/constants.ts BUILD_DATE_STAMP doc.
      const dateStamp = BUILD_DATE_STAMP;
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
        // #3715: resolve to the shared URL group key (BL/BS -> BASILEA,
        // AI/AR -> APPENZELLO) BEFORE grouping — otherwise both halves of a
        // half-canton pair render at the identical hub URL and the second
        // one silently clobbers the first via WriteCollector's last-write-
        // wins dedup (raw canton codes differ, but their emitted path does
        // not).
        // #3739: an unresolved canton must route to the canton-neutral
        // bucket, not silently mislabel the event as Ticino.
        const canton = ev.canton ? resolveCantonUrlKey(ev.canton) : UNRESOLVED_CANTON_KEY;
        const arr = byCanton.get(canton) ?? [];
        arr.push(ev);
        byCanton.set(canton, arr);
      }
      // #3739: keep the canton-neutral bucket last regardless of locale
      // collation of its sentinel string (deterministic sitemap/hub order).
      const cantons = [...byCanton.keys()].sort((a, b) =>
        a === 'TI' ? -1 : b === 'TI' ? 1 : a === UNRESOLVED_CANTON_KEY ? 1 : b === UNRESOLVED_CANTON_KEY ? -1 : a.localeCompare(b),
      );

      // Stable, collision-free detail slug per event, scoped to (canton, comune)
      // so two different cantons sharing a comune name never share a dedup
      // bucket. Built once (locale-independent), then resolved per locale into
      // a full href for the event cards.
      const detailSlugs = new Map<string, { canton: string; comune: string; slug: string }>();
      const byCantonComune = new Map<string, Map<string, SiteEvent[]>>();
      // `groupByComune()` drops events with `comune == null` (intentional,
      // protected by tests/events-pipeline.test.ts) — collect them separately
      // per canton and dedup-slug them the same way as real comuni, under the
      // OTHER_EVENTS_COMUNE_KEY sentinel, so they still get a working detail
      // page instead of falling back to the raw crawled URL (see the "other
      // events" bucket page above).
      const otherEventsByCanton = new Map<string, SiteEvent[]>();
      for (const canton of cantons) {
        const byComune = groupByComune(byCanton.get(canton)!) as Map<string, SiteEvent[]>;
        byCantonComune.set(canton, byComune);
        for (const [comune, list] of byComune) {
          const slugs = assignEventSlugs(list);
          for (const ev of list) {
            detailSlugs.set(ev.id, { canton, comune, slug: slugs.get(ev.id)! });
          }
        }

        const otherEvents = byCanton.get(canton)!.filter((e) => !e.comune);
        if (otherEvents.length > 0) {
          otherEventsByCanton.set(canton, otherEvents);
          const slugs = assignEventSlugs(otherEvents);
          for (const ev of otherEvents) {
            detailSlugs.set(ev.id, { canton, comune: OTHER_EVENTS_COMUNE_KEY, slug: slugs.get(ev.id)! });
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
      writeCatalogImages((relPath, contents) => collector.add(path.join(distDir, relPath), contents));
      let pagesWritten = 0;
      let thinPages = 0;
      let totalComuni = 0;
      let skippedLocaleRenders = 0;

      const emit = (rendered: { urlPath: string; html: string; wordCount: number }) => {
        if (rendered.wordCount < MIN_INDEXABLE_WORDS) thinPages += 1;
        const indexPath = path.join(distDir, rendered.urlPath, 'index.html');
        const flatPath = path.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, rendered.html);
        collector.add(flatPath, rendered.html);
        pagesWritten += 1;
      };

      const perCantonSitemap: Array<{ canton: string; comuni: string[]; digests: DigestDef[]; hasOtherEvents: boolean }> = [];
      // Per-canton aggregates for the Swiss-wide index hub (issue #3645, F3)
      // — filled alongside `perCantonSitemap` in the same loop below so both
      // stay derived from the identical per-canton data, never a second pass
      // that could drift.
      const cantonStats: Array<{ canton: string; eventCount: number; comuneCount: number }> = [];

      for (const canton of cantons) {
        const events = byCanton.get(canton)!;
        const byComune = byCantonComune.get(canton)!;
        const comuni = [...byComune.keys()].sort((a, b) => a.localeCompare(b));
        totalComuni += comuni.length;
        const otherCantons = cantons.filter((c) => c !== canton);
        const otherEvents = otherEventsByCanton.get(canton) ?? [];

        // The digest filter is locale-independent (it only reads the date), so
        // compute each window's events ONCE per canton. A digest is indexed +
        // sitemapped ONLY when it actually lists events — an empty window
        // renders noindex,follow and is left out of the sitemap (gated on
        // events.length, since the static chrome alone always clears
        // MIN_INDEXABLE_WORDS). Shared across locales, so all 4 hreflang
        // alternates stay consistent (no noindex straddle).
        const digestEvents = new Map(DIGESTS.map((d) => [d.key, d.filter(events, { todayIso: dateStamp })]));

        for (const locale of LOCALES) {
          // Per-locale matrix shard (BUILD_LOCALE): render nothing for a locale
          // this shard does not own. `WriteCollector.add()` already DISCARDS
          // those writes as its very first action (batchWrite.ts:196
          // `_skippedByLocale++; return;`), so the HTML was being built and
          // thrown away — on the `it` shard, 3 of every 4 rendered pages.
          // Skipping the render therefore cannot change a single byte that
          // ships: the chokepoint that decides what ships already rejects them.
          //
          // This is the documented purpose of shouldEmitLocale ("Hot emit loops
          // call shouldEmitLocale to `continue` past the expensive render/minify
          // work for non-target locales — the CPU win", localeEmitFilter.ts).
          //
          // MEMORY, which is why this is urgent (#5130 follow-up): this plugin
          // is the largest single memory event in the build. Run 31062047677
          // (`it`) went 10,145 → 12,281 MB RSS across it and was OOM-killed;
          // the same spike in run 31036546298 was 9,891 → 11,839 and survived,
          // then fell back to 11,496 — so it is ~2 GB of TRANSIENT allocation,
          // three quarters of which is rendered-then-discarded HTML. heapUsed
          // moved +10 MB across the spike, which is why no --max-old-space-size
          // ever helped: the bulk is outside V8.
          //
          // The sitemap and the cross-locale hreflang alternates are built
          // OUTSIDE these loops (perCantonSitemap / detailSlugs / buildSitemap),
          // so they stay complete for all four locales — the shard still
          // publishes correct alternates pointing at the other shards' URLs.
          // No-op on the default all-locale build (EMIT_ALL_LOCALES).
          if (!shouldEmitLocale(locale)) { skippedLocaleRenders += 1; continue; }
          const detailHref = detailHrefFor(locale);
          emit(renderHubPage({ locale, canton, events, byComune, dateStamp, weekendDays, distDir, detailHref, otherCantons, otherEvents }));
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
          // Comune-less events: one bucket listing page + one detail page per
          // event, same treatment as a real comune (see the "other events"
          // bucket page above / detailSlugs population above).
          if (otherEvents.length > 0) {
            emit(renderOtherEventsPage({ locale, canton, events: otherEvents, dateStamp, weekendDays, distDir, detailHref }));
            for (const ev of otherEvents) {
              const eventSlug = detailSlugs.get(ev.id)!.slug;
              emit(
                renderEventDetailPage({
                  locale,
                  event: ev,
                  comune: OTHER_EVENTS_COMUNE_KEY,
                  eventSlug,
                  sameComuneEvents: otherEvents,
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
          hasOtherEvents: otherEvents.length > 0,
        });
        cantonStats.push({ canton, eventCount: events.length, comuneCount: byComune.size });
      }

      // Recently-ended events (issue #3646, F4 "indexability": noindex,follow
      // on events that already took place). `upcomingEvents` drops a past
      // event outright — without this pass the URL just 404s on the next
      // rebuild. Emits a short grace-window bridge page instead (own slug
      // dedup namespace, own comune grouping — kept fully separate from
      // `detailSlugs`/`perCantonSitemap`/`cantonStats`/the sitemap on
      // purpose: these pages are deliberately orphaned, no indexed page
      // links to them, so they cannot affect BFS crawl depth and never
      // reappear in Event JSON-LD or the sitemap). Outbound links from the
      // page itself (to whatever is currently live in the same comune) are
      // still fine — same idea as the jobs expired-soft-landing pattern.
      const pastEvents = recentlyEndedEvents(dataset.events, dateStamp) as SiteEvent[];
      const pastEventsByCanton = new Map<string, SiteEvent[]>();
      for (const ev of pastEvents) {
        // #3715: same group-key resolution as the live `byCanton` pass above
        // — keeps this bridge-page grouping keyed identically to
        // `byCantonComune` (used just below for `liveSameComune`), otherwise
        // a half-canton pair's past events would fail to look up their live
        // siblings entirely.
        // #3739: an unresolved canton must route to the canton-neutral
        // bucket, not silently mislabel the event as Ticino.
        const canton = ev.canton ? resolveCantonUrlKey(ev.canton) : UNRESOLVED_CANTON_KEY;
        if (!ev.comune) continue; // comune-less past events: not worth a bridge page (rare, no stable bucket to land on)
        pastEventsByCanton.set(canton, [...(pastEventsByCanton.get(canton) ?? []), ev]);
      }
      for (const [canton, events] of pastEventsByCanton) {
        const byComune = groupByComune(events) as Map<string, SiteEvent[]>;
        const liveByComune = byCantonComune.get(canton);
        for (const [comune, list] of byComune) {
          const liveSameComune = liveByComune?.get(comune) ?? [];
          // #3700/#3715: reserve base slugs already claimed by a still-live
          // sibling in this comune (e.g. a multi-day event sharing the
          // exact same title+startDate as a now-past one, still "upcoming"
          // via a later endDate). Without this, the past-bridge slug is
          // assigned from `list` alone and can collide with — or even
          // reuse — the slug that is still the CURRENT live/indexed URL
          // for that sibling. See reserveLiveSiblingSlugs() doc for why this
          // must use the actual assigned slug, not the raw base.
          const reservedBaseSlugs = reserveLiveSiblingSlugs(liveSameComune, detailSlugs);
          const pastSlugFor = assignEventSlugs(list, reservedBaseSlugs);
          for (const locale of LOCALES) {
            // Same shard gate as the main render loop above.
            if (!shouldEmitLocale(locale)) { skippedLocaleRenders += 1; continue; }
            const detailHref = detailHrefFor(locale);
            for (const ev of list) {
              emit(
                renderEventDetailPage({
                  locale,
                  event: ev,
                  comune,
                  eventSlug: pastSlugFor.get(ev.id)!,
                  sameComuneEvents: liveSameComune,
                  dateStamp,
                  distDir,
                  detailHref,
                  isPast: true,
                }),
              );
            }
          }
        }
      }

      // Swiss-wide index hub (issue #3645, F3) — one per locale, always
      // emitted alongside the per-canton hubs above: the `all.length === 0`
      // early return near the top of this function already guards the whole
      // plugin, so once we're here the national hub always belongs too.
      for (const locale of LOCALES) {
        // Same shard gate as the render loops above.
        if (!shouldEmitLocale(locale)) { skippedLocaleRenders += 1; continue; }
        const detailHref = detailHrefFor(locale);
        emit(renderEventsIndexPage({ locale, cantonStats, events: all, dateStamp, weekendDays, distDir, detailHref }));
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
        `\x1b[36m[events-pages]\x1b[0m Generated ${pagesWritten} pages (${totalComuni} comuni × ${cantons.length} canton(s) × ${LOCALES.length} locales + hubs) from ${all.length} events — flushed ${flushed} files in ${((Date.now() - t0) / 1000).toFixed(1)}s${thinPages ? ` (${thinPages} thin → noindex)` : ''} — inbound link locales: ${reached.join(',') || 'none'}${EMIT_ALL_LOCALES ? '' : `, ${skippedLocaleRenders} non-owned-locale renders skipped`}`,
      );
    },
  };
}
