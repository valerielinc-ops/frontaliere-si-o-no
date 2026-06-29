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
  EVENT_SOURCES,
} from '../scripts/lib/events-utils.mjs';

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
}

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;
const SITEMAP_NAME = 'sitemap-eventi.xml';
const SOURCE = EVENT_SOURCES['tio-agenda'];
const SITE_IMAGE = `${BASE_URL}/og-image.png`;

const BASE_PATH: Record<Locale, string> = {
  it: '/eventi/ticino',
  en: '/en/events/ticino',
  de: '/de/veranstaltungen/tessin',
  fr: '/fr/evenements/tessin',
};

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

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pathFor(locale: Locale, comune?: string): string {
  const base = BASE_PATH[locale];
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

function buildAlternates(comune?: string): string {
  return LOCALES.map((locale) => ` <link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathFor(locale, comune)}">`)
    .concat(` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathFor('it', comune)}">`)
    .join('\n');
}

function renderMetric(label: string, value: string, detail?: string): string {
  return `<div class="rounded-md border border-edge bg-surface p-4">
    <dt class="text-sm font-medium text-subtle">${esc(label)}</dt>
    <dd class="mt-1 text-2xl font-bold text-heading">${esc(value)}</dd>
    ${detail ? `<p class="mt-1 text-sm text-muted">${esc(detail)}</p>` : ''}
  </div>`;
}

/** Europe/Zurich UTC offset for a given ISO date — `+02:00` in CEST (summer),
 * `+01:00` in CET (winter). Hardcoding one of them shifts the JSON-LD time by
 * an hour for half the year. */
function zurichOffset(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '+01:00';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', timeZoneName: 'longOffset' }).formatToParts(d);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /([+-]\d{2}:\d{2})/.exec(tz);
  return m ? m[1] : '+01:00';
}

/**
 * schema.org/Event object for one agenda entry.
 *
 * `offers` is deliberately OMITTED: the agenda never exposes a price, and
 * asserting `price:"0"` (free) on paid concerts/theatre would misrepresent an
 * indexed page (structured-data policy risk). Google treats `offers` as
 * recommended-not-required, and validate-structured-data-completeness.mjs now
 * validates it only when present. Every other Google-required/recommended
 * Event field is emitted with a safe fallback.
 */
export function eventLd(event: SiteEvent, locale: Locale): Record<string, unknown> {
  const locality = event.comune || 'Canton Ticino';
  const venueName = event.venue || locality;
  const offset = zurichOffset(event.startDate);
  const startIso = event.startTime ? `${event.startDate}T${event.startTime}:00${offset}` : event.startDate;
  // For a single-day timed event, endDate must NOT be the bare date (Google
  // reads it as midnight → "endDate before startDate"): mirror startIso.
  const hasMultiDay = Boolean(event.endDate && event.endDate !== event.startDate);
  const endIso = hasMultiDay ? (event.endDate as string) : startIso;
  const cat = categoryLabel(event.category, locale);
  const when = humanDate(event.startDate, locale);
  const description =
    `${event.title} — ${cat} ${COPY[locale].at} ${venueName} (${locality}, Ticino), ${when}` +
    `${event.startTime ? ` ${event.startTime}` : ''}. ${event.sourceName}.`;
  return {
    '@type': 'Event',
    name: event.title,
    startDate: startIso,
    endDate: endIso,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: venueName,
      address: {
        '@type': 'PostalAddress',
        addressLocality: locality,
        addressRegion: 'TI',
        addressCountry: 'CH',
      },
    },
    description: description.length >= 30 ? description : `${description} Evento in Ticino.`,
    image: SITE_IMAGE,
    url: event.url,
    organizer: { '@type': 'Organization', name: event.sourceName, url: SOURCE.homepage },
    performer: { '@type': 'Organization', name: venueName },
  };
}

function renderEventCard(event: SiteEvent, locale: Locale): string {
  const cat = categoryLabel(event.category, locale);
  const when = humanDate(event.startDate, locale);
  const time = event.startTime ? ` · ${esc(event.startTime)}` : '';
  const place = event.venue ? `${esc(event.venue)}` : '';
  const comuneTag = event.comune ? `<span class="text-subtle">${esc(event.comune)}</span>` : '';
  return `<article class="rounded-md border border-edge bg-surface p-4">
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="rounded-full border border-info-border bg-info-subtle px-2.5 py-0.5 font-semibold text-info">${esc(cat)}</span>
      <span class="font-medium text-muted">${esc(when)}${time}</span>
      ${comuneTag}
    </div>
    <h3 class="mt-2 text-base font-bold leading-snug text-heading">
      <a class="text-link hover:text-link-hover" href="${esc(event.url)}" rel="nofollow noopener" target="_blank">${esc(event.title)}</a>
    </h3>
    ${place ? `<p class="mt-1 text-sm text-body">${esc(COPY[locale].at)} ${place}</p>` : ''}
  </article>`;
}

function renderEventList(events: SiteEvent[], locale: Locale): string {
  if (events.length === 0) {
    return `<p class="rounded-md border border-edge bg-surface p-4 text-sm text-body">${esc(COPY[locale].noEventsSoon)}</p>`;
  }
  return `<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${events.map((e) => renderEventCard(e, locale)).join('')}</div>`;
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

function renderHubPage(params: {
  locale: Locale;
  events: SiteEvent[];
  byComune: Map<string, SiteEvent[]>;
  dateStamp: string;
  weekendDays: Set<string>;
  distDir: string;
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, events, byComune, dateStamp, weekendDays, distDir } = params;
  const copy = COPY[locale];
  const canonicalPath = pathFor(locale);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;
  const upcoming = events.slice(0, 60);

  const comuneEntries = [...byComune.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const comuneGrid = comuneEntries
    .map(
      ([comune, list]) =>
        `<a class="rounded-md border border-edge bg-surface p-4 hover:border-accent-border" href="${pathFor(locale, comune)}">
          <span class="block text-sm font-semibold text-heading">${esc(comune)}</span>
          <span class="mt-1 block text-xs text-muted">${list.length} ${esc(copy.eventsWord)}</span>
        </a>`,
    )
    .join('');

  const body = `<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <span>${esc(copy.hubLabel)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <h1 class="max-w-4xl text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.hubH1)}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(copy.hubLede)}</p>
      <p class="mt-3 text-sm text-muted">${esc(copy.updated)}: <time datetime="${dateStamp}">${dateStamp}</time> · ${esc(copy.source)}: <a class="text-link hover:text-link-hover" href="${esc(SOURCE.homepage)}" rel="nofollow noopener" target="_blank">${esc(SOURCE.label)}</a></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statComuni, String(byComune.size))}
      ${renderMetric(copy.statWeekend, String(weekendCount))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    <section class="mt-8">
      <h2 class="text-2xl font-bold text-heading">${esc(copy.upcoming)}</h2>
      <div class="mt-4">${renderEventList(upcoming, locale)}</div>
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
    hreflangHtml: buildAlternates(),
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogLocale: LOCALE_OG[locale],
    bodyHtml: body,
    jsonLdScripts: [itemListLd, breadcrumbLd, faqLd],
    hubChrome: { hubKey: 'vita', activeSubTab: 'places' },
    distDir,
  });
  return { urlPath: canonicalPath, html, wordCount };
}

function renderComunePage(params: {
  locale: Locale;
  comune: string;
  events: SiteEvent[];
  dateStamp: string;
  weekendDays: Set<string>;
  distDir: string;
}): { urlPath: string; html: string; wordCount: number } {
  const { locale, comune, events, dateStamp, weekendDays, distDir } = params;
  const copy = COPY[locale];
  const canonicalPath = pathFor(locale, comune);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const list = events.slice(0, 40);
  const weekendCount = events.filter((e) => isWeekend(e.startDate, weekendDays)).length;

  const body = `<div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
    <nav class="mb-4 text-sm text-muted" aria-label="Breadcrumb">
      <a class="text-link hover:text-link-hover" href="/">${esc(HOME_LABEL[locale])}</a>
      <span class="mx-2">/</span>
      <a class="text-link hover:text-link-hover" href="${pathFor(locale)}">${esc(copy.hubLabel)}</a>
      <span class="mx-2">/</span>
      <span>${esc(comune)}</span>
    </nav>

    <header class="rounded-md border border-edge bg-surface p-5 sm:p-7" data-speakable>
      <h1 class="max-w-4xl text-3xl font-bold leading-tight text-heading sm:text-4xl">${esc(copy.comuneH1(comune))}</h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-body">${esc(copy.comuneLede(comune))}</p>
      <p class="mt-3 text-sm text-muted">${esc(copy.updated)}: <time datetime="${dateStamp}">${dateStamp}</time> · ${esc(copy.source)}: <a class="text-link hover:text-link-hover" href="${esc(SOURCE.homepage)}" rel="nofollow noopener" target="_blank">${esc(SOURCE.label)}</a></p>
    </header>

    <dl class="mt-5 grid gap-3 sm:grid-cols-3">
      ${renderMetric(copy.statEvents, String(events.length))}
      ${renderMetric(copy.statWeekend, String(weekendCount))}
      ${renderMetric(copy.statCategories, String(distinctCategories(events)))}
    </dl>

    <section class="mt-8">
      <h2 class="text-2xl font-bold text-heading">${esc(copy.eventsIn(comune))}</h2>
      <div class="mt-4">${renderEventList(list, locale)}</div>
    </section>

    <section class="mt-8 rounded-md border border-edge bg-surface p-5">
      <a class="inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale)}">${esc(copy.allEvents)} →</a>
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
      { '@type': 'ListItem', position: 2, name: copy.hubLabel, item: `${BASE_URL}${pathFor(locale)}` },
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

function buildSitemap(comuni: string[], dateStamp: string): string {
  const entries: string[] = [];
  // Hub
  entries.push(sitemapUrl(undefined, dateStamp, '0.7'));
  for (const comune of comuni) entries.push(sitemapUrl(comune, dateStamp, '0.5'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
}

function sitemapUrl(comune: string | undefined, dateStamp: string, priority: string): string {
  const alternates = LOCALES.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${pathFor(locale, comune)}" />`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pathFor('it', comune)}" />`)
    .join('\n');
  return `  <url>\n    <loc>${BASE_URL}${pathFor('it', comune)}</loc>\n${alternates}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
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
    <a class="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-link hover:text-link-hover" href="${pathFor(locale)}">${esc(copy.allEvents)} →</a>
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
      const byComune = groupByComune(all) as Map<string, SiteEvent[]>;
      const comuni = [...byComune.keys()].sort((a, b) => a.localeCompare(b));

      const collector = new WriteCollector({ distDir, pluginName: 'eventsSeoPagesPlugin' });
      let pagesWritten = 0;
      let thinPages = 0;

      const emit = (rendered: { urlPath: string; html: string; wordCount: number }) => {
        if (rendered.wordCount < MIN_INDEXABLE_WORDS) thinPages += 1;
        const indexPath = path.join(distDir, rendered.urlPath, 'index.html');
        const flatPath = path.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, rendered.html);
        collector.add(flatPath, rendered.html);
        pagesWritten += 1;
      };

      for (const locale of LOCALES) {
        emit(renderHubPage({ locale, events: all, byComune, dateStamp, weekendDays, distDir }));
        for (const comune of comuni) {
          emit(renderComunePage({ locale, comune, events: byComune.get(comune)!, dateStamp, weekendDays, distDir }));
        }
      }

      const sitemapXml = buildSitemap(comuni, dateStamp);
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
        `\x1b[36m[events-pages]\x1b[0m Generated ${pagesWritten} pages (${comuni.length} comuni × ${LOCALES.length} locales + hubs) from ${all.length} events — flushed ${flushed} files in ${((Date.now() - t0) / 1000).toFixed(1)}s${thinPages ? ` (${thinPages} thin → noindex)` : ''} — inbound link locales: ${reached.join(',') || 'none'}`,
      );
    },
  };
}
