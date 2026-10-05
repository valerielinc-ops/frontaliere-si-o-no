/**
 * Deterministic, quota-free content builder for the weekly "weekend events"
 * digest blog article (chained feature on issue #2963).
 *
 * Turns this weekend's events (grouped by comune) into a 4-locale article
 * payload — title / excerpt / body1-3 / FAQ / imageAlt — using TEMPLATED prose
 * (no LLM, no API quota). The article is EVERGREEN: a single stable id/slug
 * whose body is regenerated weekly, so the repo never floods with one new
 * article per week (issue #2963: "avoid flooding the repo").
 *
 * Pure string/data logic, importable from both `.mjs` scripts and the vitest
 * suite. Re-uses the shared event helpers (AGENTS.md §6 — one source of truth).
 */

import {
  slugifyComune,
  weekendWindow,
  weekendEvents,
  groupByComune,
  EVENTS_BASE_PATH,
  EVENTS_DIGEST_SLUGS,
  eventsBasePathForCanton,
  resolveCantonUrlKey,
  UNRESOLVED_CANTON_KEY,
  UNRESOLVED_CANTON_LABEL,
} from './events-utils.mjs';
import { hasUsableContentText } from './usable-content-text.mjs';

/** Stable, evergreen identity — never changes (no date in id/slug → no flooding). */
export const DIGEST_ARTICLE_ID = 'eventi-weekend-ticino';
export const DIGEST_ARTICLE_SLUGS = {
  it: 'eventi-weekend-ticino',
  en: 'weekend-events-ticino',
  de: 'wochenend-veranstaltungen-tessin',
  fr: 'evenements-week-end-tessin',
};

/**
 * Evergreen identity and place phrase of the weekend digest of every OTHER
 * canton URL group (P9a, sezioni cantonali): one stable article per group,
 * `eventi-weekend-<it slug>`, with the per-locale slugs built on the same
 * pattern as Ticino's from `data/canton-url-slugs.json` (a test pins the
 * correspondence). Literal strings on purpose: no slug here comes from a
 * model or from a runtime interpolation (prompt-placeholder guard, corpus
 * issue 382). `place` is the "in <canton>" phrase each locale's copy uses —
 * written per canton because the preposition and article are not derivable
 * (nei Grigioni / im Aargau / in der Waadt / aux Grisons / dans le canton
 * d'Uri). Ticino is NOT in this table: its digest keeps the original copy
 * and identity above, byte for byte.
 */
export const CANTON_DIGEST_ARTICLES = {
  AG: { id: 'eventi-weekend-argovia', slugs: { it: 'eventi-weekend-argovia', en: 'weekend-events-aargau', de: 'wochenend-veranstaltungen-aargau', fr: 'evenements-week-end-argovie' }, place: { it: 'in Argovia', en: 'in Aargau', de: 'im Aargau', fr: 'en Argovie' } },
  APPENZELLO: { id: 'eventi-weekend-appenzello', slugs: { it: 'eventi-weekend-appenzello', en: 'weekend-events-appenzell', de: 'wochenend-veranstaltungen-appenzell', fr: 'evenements-week-end-appenzell' }, place: { it: 'in Appenzello', en: 'in Appenzell', de: 'im Appenzellerland', fr: 'en Appenzell' } },
  BE: { id: 'eventi-weekend-berna', slugs: { it: 'eventi-weekend-berna', en: 'weekend-events-bern', de: 'wochenend-veranstaltungen-bern', fr: 'evenements-week-end-berne' }, place: { it: 'nel Canton Berna', en: 'in the canton of Bern', de: 'im Kanton Bern', fr: 'dans le canton de Berne' } },
  BASILEA: { id: 'eventi-weekend-basilea', slugs: { it: 'eventi-weekend-basilea', en: 'weekend-events-basel', de: 'wochenend-veranstaltungen-basel', fr: 'evenements-week-end-bale' }, place: { it: 'nella regione di Basilea', en: 'in the Basel region', de: 'in der Region Basel', fr: 'dans la région bâloise' } },
  FR: { id: 'eventi-weekend-friburgo', slugs: { it: 'eventi-weekend-friburgo', en: 'weekend-events-fribourg', de: 'wochenend-veranstaltungen-freiburg', fr: 'evenements-week-end-fribourg' }, place: { it: 'nel Canton Friburgo', en: 'in the canton of Fribourg', de: 'im Kanton Freiburg', fr: 'dans le canton de Fribourg' } },
  GE: { id: 'eventi-weekend-ginevra', slugs: { it: 'eventi-weekend-ginevra', en: 'weekend-events-geneva', de: 'wochenend-veranstaltungen-genf', fr: 'evenements-week-end-geneve' }, place: { it: 'nel Canton Ginevra', en: 'in the canton of Geneva', de: 'im Kanton Genf', fr: 'dans le canton de Genève' } },
  GL: { id: 'eventi-weekend-glarona', slugs: { it: 'eventi-weekend-glarona', en: 'weekend-events-glarus', de: 'wochenend-veranstaltungen-glarus', fr: 'evenements-week-end-glaris' }, place: { it: 'nel Canton Glarona', en: 'in the canton of Glarus', de: 'im Glarnerland', fr: 'dans le canton de Glaris' } },
  GR: { id: 'eventi-weekend-grigioni', slugs: { it: 'eventi-weekend-grigioni', en: 'weekend-events-graubunden', de: 'wochenend-veranstaltungen-graubunden', fr: 'evenements-week-end-grisons' }, place: { it: 'nei Grigioni', en: 'in Graubünden', de: 'in Graubünden', fr: 'aux Grisons' } },
  JU: { id: 'eventi-weekend-giura', slugs: { it: 'eventi-weekend-giura', en: 'weekend-events-jura', de: 'wochenend-veranstaltungen-jura', fr: 'evenements-week-end-jura' }, place: { it: 'nel Canton Giura', en: 'in the canton of Jura', de: 'im Kanton Jura', fr: 'dans le canton du Jura' } },
  LU: { id: 'eventi-weekend-lucerna', slugs: { it: 'eventi-weekend-lucerna', en: 'weekend-events-lucerne', de: 'wochenend-veranstaltungen-luzern', fr: 'evenements-week-end-lucerne' }, place: { it: 'nel Canton Lucerna', en: 'in the canton of Lucerne', de: 'im Kanton Luzern', fr: 'dans le canton de Lucerne' } },
  NE: { id: 'eventi-weekend-neuchatel', slugs: { it: 'eventi-weekend-neuchatel', en: 'weekend-events-neuchatel', de: 'wochenend-veranstaltungen-neuenburg', fr: 'evenements-week-end-neuchatel' }, place: { it: 'nel Canton Neuchâtel', en: 'in the canton of Neuchâtel', de: 'im Kanton Neuenburg', fr: 'dans le canton de Neuchâtel' } },
  NW: { id: 'eventi-weekend-nidvaldo', slugs: { it: 'eventi-weekend-nidvaldo', en: 'weekend-events-nidwalden', de: 'wochenend-veranstaltungen-nidwalden', fr: 'evenements-week-end-nidwald' }, place: { it: 'nel Canton Nidvaldo', en: 'in Nidwalden', de: 'in Nidwalden', fr: 'à Nidwald' } },
  OW: { id: 'eventi-weekend-obvaldo', slugs: { it: 'eventi-weekend-obvaldo', en: 'weekend-events-obwalden', de: 'wochenend-veranstaltungen-obwalden', fr: 'evenements-week-end-obwald' }, place: { it: 'nel Canton Obvaldo', en: 'in Obwalden', de: 'in Obwalden', fr: 'à Obwald' } },
  SG: { id: 'eventi-weekend-san-gallo', slugs: { it: 'eventi-weekend-san-gallo', en: 'weekend-events-st-gallen', de: 'wochenend-veranstaltungen-st-gallen', fr: 'evenements-week-end-saint-gall' }, place: { it: 'nel Canton San Gallo', en: 'in the canton of St. Gallen', de: 'im Kanton St. Gallen', fr: 'dans le canton de Saint-Gall' } },
  SH: { id: 'eventi-weekend-sciaffusa', slugs: { it: 'eventi-weekend-sciaffusa', en: 'weekend-events-schaffhausen', de: 'wochenend-veranstaltungen-schaffhausen', fr: 'evenements-week-end-schaffhouse' }, place: { it: 'nel Canton Sciaffusa', en: 'in the canton of Schaffhausen', de: 'im Kanton Schaffhausen', fr: 'dans le canton de Schaffhouse' } },
  SO: { id: 'eventi-weekend-soletta', slugs: { it: 'eventi-weekend-soletta', en: 'weekend-events-solothurn', de: 'wochenend-veranstaltungen-solothurn', fr: 'evenements-week-end-soleure' }, place: { it: 'nel Canton Soletta', en: 'in the canton of Solothurn', de: 'im Kanton Solothurn', fr: 'dans le canton de Soleure' } },
  SZ: { id: 'eventi-weekend-svitto', slugs: { it: 'eventi-weekend-svitto', en: 'weekend-events-schwyz', de: 'wochenend-veranstaltungen-schwyz', fr: 'evenements-week-end-schwytz' }, place: { it: 'nel Canton Svitto', en: 'in the canton of Schwyz', de: 'im Kanton Schwyz', fr: 'dans le canton de Schwytz' } },
  TG: { id: 'eventi-weekend-turgovia', slugs: { it: 'eventi-weekend-turgovia', en: 'weekend-events-thurgau', de: 'wochenend-veranstaltungen-thurgau', fr: 'evenements-week-end-thurgovie' }, place: { it: 'in Turgovia', en: 'in Thurgau', de: 'im Thurgau', fr: 'en Thurgovie' } },
  UR: { id: 'eventi-weekend-uri', slugs: { it: 'eventi-weekend-uri', en: 'weekend-events-uri', de: 'wochenend-veranstaltungen-uri', fr: 'evenements-week-end-uri' }, place: { it: 'nel Canton Uri', en: 'in the canton of Uri', de: 'im Kanton Uri', fr: "dans le canton d'Uri" } },
  VD: { id: 'eventi-weekend-vaud', slugs: { it: 'eventi-weekend-vaud', en: 'weekend-events-vaud', de: 'wochenend-veranstaltungen-waadt', fr: 'evenements-week-end-vaud' }, place: { it: 'nel Canton Vaud', en: 'in the canton of Vaud', de: 'in der Waadt', fr: 'dans le canton de Vaud' } },
  VS: { id: 'eventi-weekend-vallese', slugs: { it: 'eventi-weekend-vallese', en: 'weekend-events-valais', de: 'wochenend-veranstaltungen-wallis', fr: 'evenements-week-end-valais' }, place: { it: 'in Vallese', en: 'in Valais', de: 'im Wallis', fr: 'en Valais' } },
  ZG: { id: 'eventi-weekend-zugo', slugs: { it: 'eventi-weekend-zugo', en: 'weekend-events-zug', de: 'wochenend-veranstaltungen-zug', fr: 'evenements-week-end-zoug' }, place: { it: 'nel Canton Zugo', en: 'in the canton of Zug', de: 'im Kanton Zug', fr: 'dans le canton de Zoug' } },
  ZH: { id: 'eventi-weekend-zurigo', slugs: { it: 'eventi-weekend-zurigo', en: 'weekend-events-zurich', de: 'wochenend-veranstaltungen-zurich', fr: 'evenements-week-end-zurich' }, place: { it: 'nel Canton Zurigo', en: 'in the canton of Zurich', de: 'im Kanton Zürich', fr: 'dans le canton de Zurich' } },
};

/**
 * Canton URL group of a digest request: `undefined`/`'TI'` is the original
 * Ticino digest; any other value must be a known group (half-cantons map onto
 * theirs, `BL` → `BASILEA`). An unknown value throws: a typo must never
 * silently publish the Ticino article under another canton's name.
 */
export function resolveDigestCanton(canton = 'TI') {
  const groupKey = resolveCantonUrlKey(canton);
  if (groupKey === 'TI' || CANTON_DIGEST_ARTICLES[groupKey]) return groupKey;
  throw new Error(`events digest: unknown canton "${canton}"`);
}
/** Caps keep the body reasonable regardless of how busy a weekend is. */
const MAX_COMUNI = 15;
const MAX_EVENTS_PER_COMUNE = 6;
/** Cap on how many OTHER cantons (non-TI) get their own section (#3647, F5/5). */
const MAX_OTHER_CANTONS = 8;

const MONTHS = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

const LOCALES = ['it', 'en', 'de', 'fr'];
// Localized path segments come from the SHARED config so the article's deep links
// match the SSG plugin's emitted URLs exactly (en/de/fr translate the segment —
// /en/events/ticino, /de/veranstaltungen/tessin, /fr/evenements/tessin). A local
// copy drifted and produced /en/eventi/ticino → 404 (PR #3088 review).
const BASE_PATH = EVENTS_BASE_PATH;
const WEEKEND_SLUG = EVENTS_DIGEST_SLUGS.weekend;
const WEEK_SLUG = EVENTS_DIGEST_SLUGS.week;

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]) } : null;
}

/** "2 gennaio" / "2 January" / "2. Januar" / "2 janvier". */
function humanDay(iso, locale) {
  const p = parseIso(iso);
  if (!p) return '';
  const month = MONTHS[locale][p.mo];
  return locale === 'de' ? `${p.d}. ${month}` : `${p.d} ${month}`;
}

/** "sabato 2 e domenica 3 gennaio" style range for the weekend window. */
function humanRange(startIso, endIso, locale) {
  const s = parseIso(startIso);
  const e = parseIso(endIso);
  if (!s) return '';
  if (!e || (s.y === e.y && s.mo === e.mo && s.d === e.d)) return humanDay(startIso, locale);
  const sameMonth = s.mo === e.mo && s.y === e.y;
  const sep = { it: ' – ', en: ' – ', de: ' – ', fr: ' – ' }[locale];
  if (sameMonth) return `${s.d}${sep}${humanDay(endIso, locale)}`;
  return `${humanDay(startIso, locale)}${sep}${humanDay(endIso, locale)}`;
}

function eventTime(ev) {
  return ev?.startTime ? ` · ${ev.startTime}` : '';
}

// Title-case a URL slug ("san-gallo" → "San Gallo"). Mirrors
// services/cantonList.ts's private `slugToLabel` — that module can't be
// imported here: its top-level `import ... from '../data/canton-url-slugs.json'`
// (no `with { type: 'json' }` assertion) only resolves under Vite/bundler
// semantics, not plain-Node ESM (this file runs as a bare `.mjs` script in CI,
// no bundler, no tree-shaking of an unused named export at runtime).
function slugToLabel(slug) {
  return String(slug || '')
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

/** Locale-correct display label for a canton, derived from its URL slug (§6 — one source, `eventsBasePathForCanton`, no second canton-name table here). */
function cantonLabelForLocale(canton, locale) {
  // #3739 round-2: the canton-neutral bucket's sentinel isn't a real BFS code
  // — its slug ("altri-cantoni") would title-case into a plausible-looking
  // but undeclared label, so route it through the shared copy instead, same
  // as build-plugins/eventsSeoPagesPlugin.ts's `cantonDisplayLabel`.
  if (canton === UNRESOLVED_CANTON_KEY) return UNRESOLVED_CANTON_LABEL[locale];
  const path = eventsBasePathForCanton(canton)[locale] || '';
  const slug = path.split('/').filter(Boolean).pop() || '';
  return slugToLabel(slug);
}

const T = {
  it: {
    title: (range) => `Eventi del weekend in Ticino: cosa fare ${range ? `(${range})` : 'sabato e domenica'}`,
    excerpt: () => 'Eventi in Ticino ogni weekend: concerti, mostre, feste e mercati, comune per comune. Agenda aggiornata ogni giorno.',
    imageAlt: 'Eventi del weekend in Ticino',
    h1: 'Cosa fare questo weekend in Ticino',
    intro: (n, range) => `Questo weekend${range ? ` (${range})` : ''} in Ticino ci ${n === 1 ? "è un evento" : `sono ${n} eventi`} tra concerti, mostre, feste di paese e mercati. Qui sotto trovi l'agenda completa, comune per comune, con data e orario. La pagina viva e sempre aggiornata è [Eventi questo weekend in Ticino](${BASE_PATH.it}/${WEEKEND_SLUG.it}/).`,
    none: `Questo weekend non risultano eventi pubblicati nelle agende che monitoriamo. Riprova tra qualche giorno: l'[agenda del weekend](${BASE_PATH.it}/${WEEKEND_SLUG.it}/) e quella [della settimana](${BASE_PATH.it}/${WEEK_SLUG.it}/) si aggiornano ogni giorno.`,
    byComuneH: 'Gli eventi, comune per comune',
    otherCantonsH: 'Eventi anche in altri cantoni',
    howH: 'Come usare questa agenda',
    how: `Questa agenda raccoglie gli eventi dalle agende ufficiali del territorio e si aggiorna ogni giorno. Per il quadro completo consulta [gli eventi di questo weekend](${BASE_PATH.it}/${WEEKEND_SLUG.it}/) o [tutta la settimana](${BASE_PATH.it}/${WEEK_SLUG.it}/). Se sei un frontaliere, dai un'occhiata anche ai [comuni di frontiera](/vivere-in-ticino/comuni-di-frontiera/) e alle [offerte di lavoro in Ticino](/cerca-lavoro-ticino/).`,
    faq: (n, range) => [
      { q: 'Quali eventi ci sono questo weekend in Ticino?', a: `Questo weekend${range ? ` (${range})` : ''} in Ticino ci ${n === 1 ? 'è un evento' : `sono ${n} eventi`} tra concerti, mostre, feste e mercati, elencati qui sopra comune per comune e aggiornati ogni giorno.` },
      { q: 'Con che frequenza viene aggiornata l’agenda?', a: 'Ogni giorno: i nuovi eventi pubblicati dalle agende ufficiali entrano automaticamente nell’agenda del weekend e della settimana.' },
    ],
  },
  en: {
    title: (range) => `Weekend events in Ticino: what to do ${range ? `(${range})` : 'Saturday & Sunday'}`,
    excerpt: () => 'Events in Ticino every weekend: concerts, exhibitions, festivals and markets, municipality by municipality. Refreshed daily.',
    imageAlt: 'Weekend events in Ticino',
    h1: 'What to do this weekend in Ticino',
    intro: (n, range) => `This weekend${range ? ` (${range})` : ''} there ${n === 1 ? 'is one event' : `are ${n} events`} across Ticino — concerts, exhibitions, village festivals and markets. The full agenda, municipality by municipality with date and time, is below. The always-current page is [Events this weekend in Ticino](${BASE_PATH.en}/${WEEKEND_SLUG.en}/).`,
    none: `No events are currently published for this weekend in the agendas we track. Check back in a few days: the [weekend agenda](${BASE_PATH.en}/${WEEKEND_SLUG.en}/) and the [week agenda](${BASE_PATH.en}/${WEEK_SLUG.en}/) refresh daily.`,
    byComuneH: 'Events, municipality by municipality',
    otherCantonsH: 'Events in other cantons too',
    howH: 'How to use this agenda',
    how: `This agenda gathers events from the territory's official agendas and refreshes daily. For the full picture see [this weekend's events](${BASE_PATH.en}/${WEEKEND_SLUG.en}/) or [the whole week](${BASE_PATH.en}/${WEEK_SLUG.en}/). If you are a cross-border worker, also check the [border municipalities](/en/living-in-ticino/border-municipalities/) and [jobs in Ticino](/en/find-jobs-ticino/).`,
    faq: (n, range) => [
      { q: 'What events are on this weekend in Ticino?', a: `This weekend${range ? ` (${range})` : ''} there ${n === 1 ? 'is one event' : `are ${n} events`} across Ticino — concerts, exhibitions, festivals and markets, listed above municipality by municipality and refreshed daily.` },
      { q: 'How often is the agenda updated?', a: 'Daily: new events published by the official agendas automatically flow into the weekend and week agendas.' },
    ],
  },
  de: {
    title: (range) => `Veranstaltungen am Wochenende im Tessin: was tun ${range ? `(${range})` : 'Sa & So'}`,
    excerpt: () => 'Veranstaltungen im Tessin an jedem Wochenende: Konzerte, Ausstellungen, Feste und Märkte, Gemeinde für Gemeinde. Täglich aktualisiert.',
    imageAlt: 'Veranstaltungen am Wochenende im Tessin',
    h1: 'Was am Wochenende im Tessin tun',
    intro: (n, range) => `An diesem Wochenende${range ? ` (${range})` : ''} ${n === 1 ? 'gibt es eine Veranstaltung' : `gibt es ${n} Veranstaltungen`} im ganzen Tessin — Konzerte, Ausstellungen, Dorffeste und Märkte. Die vollständige Agenda, Gemeinde für Gemeinde mit Datum und Uhrzeit, steht unten. Die stets aktuelle Seite ist [Veranstaltungen am Wochenende im Tessin](${BASE_PATH.de}/${WEEKEND_SLUG.de}/).`,
    none: `Für dieses Wochenende sind in den von uns beobachteten Agenden derzeit keine Veranstaltungen veröffentlicht. Schauen Sie in ein paar Tagen wieder vorbei: Die [Wochenend-Agenda](${BASE_PATH.de}/${WEEKEND_SLUG.de}/) und die [Wochen-Agenda](${BASE_PATH.de}/${WEEK_SLUG.de}/) werden täglich aktualisiert.`,
    byComuneH: 'Veranstaltungen, Gemeinde für Gemeinde',
    otherCantonsH: 'Veranstaltungen auch in anderen Kantonen',
    howH: 'So nutzen Sie diese Agenda',
    how: `Diese Agenda sammelt Veranstaltungen aus den offiziellen Agenden der Region und wird täglich aktualisiert. Für den vollen Überblick siehe [die Veranstaltungen dieses Wochenendes](${BASE_PATH.de}/${WEEKEND_SLUG.de}/) oder [die ganze Woche](${BASE_PATH.de}/${WEEK_SLUG.de}/). Als Grenzgänger lohnt sich auch ein Blick auf die [Grenzgemeinden](/de/leben-im-tessin/grenzgemeinden/) und die [Stellen im Tessin](/de/jobs-im-tessin/).`,
    faq: (n, range) => [
      { q: 'Welche Veranstaltungen gibt es am Wochenende im Tessin?', a: `An diesem Wochenende${range ? ` (${range})` : ''} ${n === 1 ? 'gibt es eine Veranstaltung' : `gibt es ${n} Veranstaltungen`} im Tessin — Konzerte, Ausstellungen, Feste und Märkte, oben Gemeinde für Gemeinde aufgelistet und täglich aktualisiert.` },
      { q: 'Wie oft wird die Agenda aktualisiert?', a: 'Täglich: neue von den offiziellen Agenden veröffentlichte Veranstaltungen fliessen automatisch in die Wochenend- und Wochen-Agenda ein.' },
    ],
  },
  fr: {
    title: (range) => `Événements du week-end au Tessin : que faire ${range ? `(${range})` : 'samedi & dimanche'}`,
    excerpt: () => 'Événements au Tessin chaque week-end : concerts, expositions, fêtes et marchés, commune par commune. Mis à jour chaque jour.',
    imageAlt: 'Événements du week-end au Tessin',
    h1: 'Que faire ce week-end au Tessin',
    intro: (n, range) => `Ce week-end${range ? ` (${range})` : ''}, il y a ${n === 1 ? 'un événement' : `${n} événements`} dans tout le Tessin — concerts, expositions, fêtes de village et marchés. L'agenda complet, commune par commune avec date et heure, est ci-dessous. La page toujours à jour est [Événements ce week-end au Tessin](${BASE_PATH.fr}/${WEEKEND_SLUG.fr}/).`,
    none: `Aucun événement n'est actuellement publié pour ce week-end dans les agendas que nous suivons. Revenez dans quelques jours : l'[agenda du week-end](${BASE_PATH.fr}/${WEEKEND_SLUG.fr}/) et celui [de la semaine](${BASE_PATH.fr}/${WEEK_SLUG.fr}/) sont mis à jour chaque jour.`,
    byComuneH: 'Les événements, commune par commune',
    otherCantonsH: 'Événements aussi dans d’autres cantons',
    howH: 'Comment utiliser cet agenda',
    how: `Cet agenda rassemble les événements depuis les agendas officiels du territoire et se met à jour chaque jour. Pour le panorama complet, voir [les événements de ce week-end](${BASE_PATH.fr}/${WEEKEND_SLUG.fr}/) ou [toute la semaine](${BASE_PATH.fr}/${WEEK_SLUG.fr}/). Si vous êtes frontalier, jetez aussi un œil aux [communes frontalières](/fr/vivre-au-tessin/communes-frontiere/) et aux [emplois au Tessin](/fr/trouver-emploi-tessin/).`,
    faq: (n, range) => [
      { q: 'Quels événements ce week-end au Tessin ?', a: `Ce week-end${range ? ` (${range})` : ''}, il y a ${n === 1 ? 'un événement' : `${n} événements`} au Tessin — concerts, expositions, fêtes et marchés, listés ci-dessus commune par commune et mis à jour chaque jour.` },
      { q: 'À quelle fréquence l’agenda est-il mis à jour ?', a: 'Chaque jour : les nouveaux événements publiés par les agendas officiels alimentent automatiquement l’agenda du week-end et de la semaine.' },
    ],
  },
};

/**
 * Copy of the digest of a non-Ticino canton group: same structure and the
 * same facts as the Ticino copy above (count, weekend range, per-comune
 * list, links to the live weekend/week pages of THAT canton), without the
 * Ticino-only frontaliere links. `place` is the canton's "in <canton>"
 * phrase, `base` its localized events base path.
 */
function cantonCopy(locale, place, base) {
  const weekend = `${base}/${WEEKEND_SLUG[locale]}/`;
  const week = `${base}/${WEEK_SLUG[locale]}/`;
  const copy = {
    it: {
      title: (range) => `Eventi del weekend ${place}: cosa fare ${range ? `(${range})` : 'sabato e domenica'}`,
      excerpt: () => `Eventi ${place} ogni weekend: concerti, mostre, feste e mercati, comune per comune. Agenda aggiornata ogni giorno.`,
      imageAlt: `Eventi del weekend ${place}`,
      h1: `Cosa fare questo weekend ${place}`,
      intro: (n, range) => `Questo weekend${range ? ` (${range})` : ''} ${place} ci ${n === 1 ? 'è un evento' : `sono ${n} eventi`} tra concerti, mostre, feste e mercati. Qui sotto trovi l'agenda, comune per comune, con data e orario. La pagina viva e sempre aggiornata è [Eventi questo weekend ${place}](${weekend}).`,
      none: `Questo weekend non risultano eventi pubblicati ${place} nelle agende che monitoriamo. Riprova tra qualche giorno: l'[agenda del weekend](${weekend}) e quella [della settimana](${week}) si aggiornano ogni giorno.`,
      byComuneH: 'Gli eventi, comune per comune',
      otherCantonsH: 'Eventi anche in altri cantoni',
      howH: 'Come usare questa agenda',
      how: `Questa agenda raccoglie gli eventi dalle agende ufficiali e turistiche del territorio e si aggiorna ogni giorno. Per il quadro completo consulta [gli eventi di questo weekend](${weekend}) o [tutta la settimana](${week}).`,
      faq: (n, range) => [
        { q: `Quali eventi ci sono questo weekend ${place}?`, a: `Questo weekend${range ? ` (${range})` : ''} ${place} ci ${n === 1 ? 'è un evento' : `sono ${n} eventi`} tra concerti, mostre, feste e mercati, elencati qui sopra comune per comune e aggiornati ogni giorno.` },
        { q: 'Con che frequenza viene aggiornata l’agenda?', a: 'Ogni giorno: i nuovi eventi pubblicati dalle agende ufficiali entrano automaticamente nell’agenda del weekend e della settimana.' },
      ],
    },
    en: {
      title: (range) => `Weekend events ${place}: what to do ${range ? `(${range})` : 'Saturday & Sunday'}`,
      excerpt: () => `Events ${place} every weekend: concerts, exhibitions, festivals and markets, municipality by municipality. Refreshed daily.`,
      imageAlt: `Weekend events ${place}`,
      h1: `What to do this weekend ${place}`,
      intro: (n, range) => `This weekend${range ? ` (${range})` : ''} there ${n === 1 ? 'is one event' : `are ${n} events`} ${place} — concerts, exhibitions, festivals and markets. The agenda, municipality by municipality with date and time, is below. The always-current page is [Events this weekend ${place}](${weekend}).`,
      none: `No events are currently published for this weekend ${place} in the agendas we track. Check back in a few days: the [weekend agenda](${weekend}) and the [week agenda](${week}) refresh daily.`,
      byComuneH: 'Events, municipality by municipality',
      otherCantonsH: 'Events in other cantons too',
      howH: 'How to use this agenda',
      how: `This agenda gathers events from the official and tourism agendas of the territory and refreshes daily. For the full picture see [this weekend's events](${weekend}) or [the whole week](${week}).`,
      faq: (n, range) => [
        { q: `What events are on this weekend ${place}?`, a: `This weekend${range ? ` (${range})` : ''} there ${n === 1 ? 'is one event' : `are ${n} events`} ${place} — concerts, exhibitions, festivals and markets, listed above municipality by municipality and refreshed daily.` },
        { q: 'How often is the agenda updated?', a: 'Daily: new events published by the official agendas automatically flow into the weekend and week agendas.' },
      ],
    },
    de: {
      title: (range) => `Veranstaltungen am Wochenende ${place}: was tun ${range ? `(${range})` : 'Sa & So'}`,
      excerpt: () => `Veranstaltungen ${place} an jedem Wochenende: Konzerte, Ausstellungen, Feste und Märkte, Gemeinde für Gemeinde. Täglich aktualisiert.`,
      imageAlt: `Veranstaltungen am Wochenende ${place}`,
      h1: `Was am Wochenende ${place} tun`,
      intro: (n, range) => `An diesem Wochenende${range ? ` (${range})` : ''} ${n === 1 ? 'gibt es eine Veranstaltung' : `gibt es ${n} Veranstaltungen`} ${place} — Konzerte, Ausstellungen, Feste und Märkte. Die Agenda, Gemeinde für Gemeinde mit Datum und Uhrzeit, steht unten. Die stets aktuelle Seite ist [Veranstaltungen am Wochenende ${place}](${weekend}).`,
      none: `Für dieses Wochenende sind ${place} in den von uns beobachteten Agenden derzeit keine Veranstaltungen veröffentlicht. Schauen Sie in ein paar Tagen wieder vorbei: Die [Wochenend-Agenda](${weekend}) und die [Wochen-Agenda](${week}) werden täglich aktualisiert.`,
      byComuneH: 'Veranstaltungen, Gemeinde für Gemeinde',
      otherCantonsH: 'Veranstaltungen auch in anderen Kantonen',
      howH: 'So nutzen Sie diese Agenda',
      how: `Diese Agenda sammelt Veranstaltungen aus den offiziellen und touristischen Agenden der Region und wird täglich aktualisiert. Für den vollen Überblick siehe [die Veranstaltungen dieses Wochenendes](${weekend}) oder [die ganze Woche](${week}).`,
      faq: (n, range) => [
        { q: `Welche Veranstaltungen gibt es am Wochenende ${place}?`, a: `An diesem Wochenende${range ? ` (${range})` : ''} ${n === 1 ? 'gibt es eine Veranstaltung' : `gibt es ${n} Veranstaltungen`} ${place} — Konzerte, Ausstellungen, Feste und Märkte, oben Gemeinde für Gemeinde aufgelistet und täglich aktualisiert.` },
        { q: 'Wie oft wird die Agenda aktualisiert?', a: 'Täglich: neue von den offiziellen Agenden veröffentlichte Veranstaltungen fliessen automatisch in die Wochenend- und Wochen-Agenda ein.' },
      ],
    },
    fr: {
      title: (range) => `Événements du week-end ${place} : que faire ${range ? `(${range})` : 'samedi & dimanche'}`,
      excerpt: () => `Événements ${place} chaque week-end : concerts, expositions, fêtes et marchés, commune par commune. Mis à jour chaque jour.`,
      imageAlt: `Événements du week-end ${place}`,
      h1: `Que faire ce week-end ${place}`,
      intro: (n, range) => `Ce week-end${range ? ` (${range})` : ''}, il y a ${n === 1 ? 'un événement' : `${n} événements`} ${place} — concerts, expositions, fêtes et marchés. L'agenda, commune par commune avec date et heure, est ci-dessous. La page toujours à jour est [Événements ce week-end ${place}](${weekend}).`,
      none: `Aucun événement n'est actuellement publié pour ce week-end ${place} dans les agendas que nous suivons. Revenez dans quelques jours : l'[agenda du week-end](${weekend}) et celui [de la semaine](${week}) sont mis à jour chaque jour.`,
      byComuneH: 'Les événements, commune par commune',
      otherCantonsH: 'Événements aussi dans d’autres cantons',
      howH: 'Comment utiliser cet agenda',
      how: `Cet agenda rassemble les événements depuis les agendas officiels et touristiques du territoire et se met à jour chaque jour. Pour le panorama complet, voir [les événements de ce week-end](${weekend}) ou [toute la semaine](${week}).`,
      faq: (n, range) => [
        { q: `Quels événements ce week-end ${place} ?`, a: `Ce week-end${range ? ` (${range})` : ''}, il y a ${n === 1 ? 'un événement' : `${n} événements`} ${place} — concerts, expositions, fêtes et marchés, listés ci-dessus commune par commune et mis à jour chaque jour.` },
        { q: 'À quelle fréquence l’agenda est-il mis à jour ?', a: 'Chaque jour : les nouveaux événements publiés par les agendas officiels alimentent automatiquement l’agenda du week-end et de la semaine.' },
      ],
    },
  };
  return copy[locale];
}

/**
 * Render the per-comune section body (markdown) for one locale, deep-linking
 * each comune heading under `basePath` (the caller's canton, e.g. Ticino's
 * `BASE_PATH.it` or another canton's `eventsBasePathForCanton(canton)[locale]`
 * — parametrized so this renderer serves both the Ticino section and the
 * per-canton "other cantons" section below, §6, one loop, no copy-paste).
 */
function renderComuneBlocks(byComune, locale, basePath) {
  const comuni = [...byComune.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_COMUNI);
  const blocks = comuni.map(([comune, evs]) => {
    const slug = slugifyComune(comune);
    const lines = evs
      .slice(0, MAX_EVENTS_PER_COMUNE)
      .map((ev) => {
        const localizedTitle = ev?.titleByLocale?.[locale];
        const title = hasUsableContentText(localizedTitle) ? localizedTitle : ev.title;
        return `- **${humanDay(ev.startDate, locale)}${eventTime(ev)}** — ${String(title || '').trim()}`;
      })
      .join('\n');
    return `### [${comune}](${basePath}/${slug}/)\n${lines}`;
  });
  return blocks.join('\n\n');
}

/**
 * Render one section per non-TI canton that has weekend events, each grouped
 * by comune via `renderComuneBlocks` and deep-linked under that canton's own
 * base path (never Ticino's — a Zürich event must not link under /eventi/ticino/).
 * Capped at `MAX_OTHER_CANTONS`, busiest canton first.
 */
function renderOtherCantons(otherWeekend, locale) {
  const byCanton = new Map();
  for (const e of otherWeekend) {
    const canton = String(e?.canton || '').toUpperCase().trim();
    // Collapse half-cantons (AI/AR, BL/BS) onto their shared URL group key —
    // eventsBasePathForCanton('BL') and ('BS') resolve to the SAME landing
    // page, so grouping by the raw code would render two duplicate sections
    // linking to that one page. Same resolver eventsBasePathForCanton uses
    // internally, so the grouping key always matches the link it renders.
    // A blank/unresolved canton (#3739 round-2) gets its own canton-neutral
    // bucket instead of being dropped — matching eventsSeoPagesPlugin.ts's
    // byCanton/pastEventsByCanton grouping and selectWeekendDigests above.
    const groupKey = canton ? resolveCantonUrlKey(canton) : UNRESOLVED_CANTON_KEY;
    if (!byCanton.has(groupKey)) byCanton.set(groupKey, []);
    byCanton.get(groupKey).push(e);
  }
  const cantons = [...byCanton.entries()]
    .map(([groupKey, evs]) => [groupKey, evs, groupByComune(evs)])
    // An event with no comune contributes nothing renderable — drop the
    // canton entirely rather than emit an empty "### Canton" heading.
    .filter(([, , byComune]) => byComune.size > 0)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_OTHER_CANTONS);
  const blocks = cantons.map(([groupKey, , byComune]) => {
    const label = cantonLabelForLocale(groupKey, locale);
    const basePath = eventsBasePathForCanton(groupKey)[locale];
    return `### ${label}\n\n${renderComuneBlocks(byComune, locale, basePath)}`;
  });
  return blocks.join('\n\n');
}

/**
 * Build the full 4-locale article payload for the weekend digest.
 *
 * `canton` (P9a) selects whose digest: omitted or `'TI'` is the original
 * Ticino article (id, slugs and copy unchanged); any other canton code or URL
 * group builds that group's digest from `CANTON_DIGEST_ARTICLES`, counting
 * only its own events (half-cantons included in their group) and listing the
 * rest under "other cantons", exactly like the Ticino one does.
 * @param {{ events: Array<object>, todayIso?: string, canton?: string }} params
 */
export function buildWeekendDigestArticle({ events, todayIso, canton }) {
  const groupKey = resolveDigestCanton(canton);
  if (groupKey !== 'TI') return buildCantonWeekendDigestArticle({ events, todayIso, groupKey });
  const { start, end } = weekendWindow(todayIso);
  const weekend = weekendEvents(events, todayIso);
  // The article's headline/FAQ/count stay Ticino-scoped (its original, still
  // primary, audience) — only Ticino events feed `n`/`byComune`. Non-TI
  // weekend events (nationwide sourcing, #3644/#3645) get their own "other
  // cantons" section below instead of silently inflating the Ticino count or
  // leaking non-TI comuni into the Ticino by-comune grouping (both were bugs
  // in the pre-#3647 nationwide-unfiltered version). A blank/unresolved
  // canton (#3739 round-2) is NOT Ticino either — it now falls into
  // `otherWeekend`'s canton-neutral bucket (`renderOtherCantons` above)
  // instead of folding into `tiWeekend` and inflating the Ticino headline
  // count/by-comune grouping with events that were never confirmed local.
  const tiWeekend = weekend.filter((e) => String(e?.canton || '').toUpperCase() === 'TI');
  const otherWeekend = weekend.filter((e) => String(e?.canton || '').toUpperCase() !== 'TI');
  const byComune = groupByComune(tiWeekend);
  const n = tiWeekend.length;

  // Shaped to match create-article.mjs's registration `data` contract:
  //   content[locale] = { title, excerpt, body1, body2, body3, faq: Array<{q,a}> }
  //   imageAlt = { it, en, de, fr }   (top-level, per buildMetaBlock)
  //
  // title/excerpt/imageAlt are EVERGREEN (no date or count) so they survive a
  // weekly body refresh untouched; only body1-3/faq carry the live weekend.
  const content = {};
  const imageAlt = {};
  for (const locale of LOCALES) {
    const t = T[locale];
    const range = humanRange(start, end, locale);
    const parts2 = [];
    if (n > 0) parts2.push(`## ${t.byComuneH}\n\n${renderComuneBlocks(byComune, locale, BASE_PATH[locale])}`);
    if (otherWeekend.length > 0) parts2.push(`## ${t.otherCantonsH}\n\n${renderOtherCantons(otherWeekend, locale)}`);
    const body2 = parts2.join('\n\n');
    content[locale] = {
      title: t.title(''),
      excerpt: t.excerpt(0, ''),
      body1: `## ${t.h1}\n\n${n > 0 ? t.intro(n, range) : t.none}`,
      body2,
      body3: `## ${t.howH}\n\n${t.how}`,
      faq: t.faq(n, range).map(({ q, a }) => ({ q, a })),
    };
    imageAlt[locale] = t.imageAlt;
  }

  return {
    id: DIGEST_ARTICLE_ID,
    slugs: { ...DIGEST_ARTICLE_SLUGS },
    imageAlt,
    weekendStart: start,
    weekendEnd: end,
    eventCount: n,
    content,
  };
}

/** The non-Ticino digest (see `buildWeekendDigestArticle`). */
function buildCantonWeekendDigestArticle({ events, todayIso, groupKey }) {
  const identity = CANTON_DIGEST_ARTICLES[groupKey];
  const basePaths = eventsBasePathForCanton(groupKey);
  const { start, end } = weekendWindow(todayIso);
  const weekend = weekendEvents(events, todayIso);
  const inCanton = (e) => {
    const code = String(e?.canton || '').trim();
    return code !== '' && resolveCantonUrlKey(code) === groupKey;
  };
  const cantonWeekend = weekend.filter(inCanton);
  const otherWeekend = weekend.filter((e) => !inCanton(e));
  const byComune = groupByComune(cantonWeekend);
  const n = cantonWeekend.length;

  const content = {};
  const imageAlt = {};
  for (const locale of LOCALES) {
    const t = cantonCopy(locale, identity.place[locale], basePaths[locale]);
    const range = humanRange(start, end, locale);
    const parts2 = [];
    if (byComune.size > 0) parts2.push(`## ${t.byComuneH}\n\n${renderComuneBlocks(byComune, locale, basePaths[locale])}`);
    if (otherWeekend.length > 0) {
      const others = renderOtherCantons(otherWeekend, locale);
      if (others) parts2.push(`## ${t.otherCantonsH}\n\n${others}`);
    }
    content[locale] = {
      title: t.title(''),
      excerpt: t.excerpt(),
      body1: `## ${t.h1}\n\n${n > 0 ? t.intro(n, range) : t.none}`,
      body2: parts2.join('\n\n'),
      body3: `## ${t.howH}\n\n${t.how}`,
      faq: t.faq(n, range).map(({ q, a }) => ({ q, a })),
    };
    imageAlt[locale] = t.imageAlt;
  }

  return {
    id: identity.id,
    slugs: { ...identity.slugs },
    imageAlt,
    weekendStart: start,
    weekendEnd: end,
    eventCount: n,
    content,
  };
}
