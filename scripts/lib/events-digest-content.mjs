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
} from './events-utils.mjs';

/** Stable, evergreen identity — never changes (no date in id/slug → no flooding). */
export const DIGEST_ARTICLE_ID = 'eventi-weekend-ticino';
export const DIGEST_ARTICLE_SLUGS = {
  it: 'eventi-weekend-ticino',
  en: 'weekend-events-ticino',
  de: 'wochenend-veranstaltungen-tessin',
  fr: 'evenements-week-end-tessin',
};
/** Caps keep the body reasonable regardless of how busy a weekend is. */
const MAX_COMUNI = 15;
const MAX_EVENTS_PER_COMUNE = 6;

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

const T = {
  it: {
    title: (range) => `Eventi del weekend in Ticino: cosa fare ${range ? `(${range})` : 'sabato e domenica'}`,
    excerpt: () => 'Eventi in Ticino ogni weekend: concerti, mostre, feste e mercati, comune per comune. Agenda aggiornata ogni giorno.',
    imageAlt: 'Eventi del weekend in Ticino',
    h1: 'Cosa fare questo weekend in Ticino',
    intro: (n, range) => `Questo weekend${range ? ` (${range})` : ''} in Ticino ci ${n === 1 ? "è un evento" : `sono ${n} eventi`} tra concerti, mostre, feste di paese e mercati. Qui sotto trovi l'agenda completa, comune per comune, con data e orario. La pagina viva e sempre aggiornata è [Eventi questo weekend in Ticino](${BASE_PATH.it}/${WEEKEND_SLUG.it}/).`,
    none: `Questo weekend non risultano eventi pubblicati nelle agende che monitoriamo. Riprova tra qualche giorno: l'[agenda del weekend](${BASE_PATH.it}/${WEEKEND_SLUG.it}/) e quella [della settimana](${BASE_PATH.it}/${WEEK_SLUG.it}/) si aggiornano ogni giorno.`,
    byComuneH: 'Gli eventi, comune per comune',
    inComune: (c, slug) => `[${c}](${BASE_PATH.it}/${slug}/)`,
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
    inComune: (c, slug) => `[${c}](${BASE_PATH.en}/${slug}/)`,
    howH: 'How to use this agenda',
    how: `This agenda gathers events from the territory's official agendas and refreshes daily. For the full picture see [this weekend's events](${BASE_PATH.en}/${WEEKEND_SLUG.en}/) or [the whole week](${BASE_PATH.en}/${WEEK_SLUG.en}/). If you are a cross-border worker, also check the [border municipalities](/en/living-in-ticino/border-municipalities/) and [jobs in Ticino](/en/cerca-lavoro-ticino/).`,
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
    inComune: (c, slug) => `[${c}](${BASE_PATH.de}/${slug}/)`,
    howH: 'So nutzen Sie diese Agenda',
    how: `Diese Agenda sammelt Veranstaltungen aus den offiziellen Agenden der Region und wird täglich aktualisiert. Für den vollen Überblick siehe [die Veranstaltungen dieses Wochenendes](${BASE_PATH.de}/${WEEKEND_SLUG.de}/) oder [die ganze Woche](${BASE_PATH.de}/${WEEK_SLUG.de}/). Als Grenzgänger lohnt sich auch ein Blick auf die [Grenzgemeinden](/de/leben-im-tessin/grenzgemeinden/) und die [Stellen im Tessin](/de/cerca-lavoro-ticino/).`,
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
    inComune: (c, slug) => `[${c}](${BASE_PATH.fr}/${slug}/)`,
    howH: 'Comment utiliser cet agenda',
    how: `Cet agenda rassemble les événements depuis les agendas officiels du territoire et se met à jour chaque jour. Pour le panorama complet, voir [les événements de ce week-end](${BASE_PATH.fr}/${WEEKEND_SLUG.fr}/) ou [toute la semaine](${BASE_PATH.fr}/${WEEK_SLUG.fr}/). Si vous êtes frontalier, jetez aussi un œil aux [communes frontalières](/fr/vivre-au-tessin/communes-frontiere/) et aux [emplois au Tessin](/fr/cerca-lavoro-ticino/).`,
    faq: (n, range) => [
      { q: 'Quels événements ce week-end au Tessin ?', a: `Ce week-end${range ? ` (${range})` : ''}, il y a ${n === 1 ? 'un événement' : `${n} événements`} au Tessin — concerts, expositions, fêtes et marchés, listés ci-dessus commune par commune et mis à jour chaque jour.` },
      { q: 'À quelle fréquence l’agenda est-il mis à jour ?', a: 'Chaque jour : les nouveaux événements publiés par les agendas officiels alimentent automatiquement l’agenda du week-end et de la semaine.' },
    ],
  },
};

/** Render the per-comune section body (markdown) for one locale. */
function renderByComune(byComune, locale) {
  const t = T[locale];
  const comuni = [...byComune.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_COMUNI);
  const blocks = comuni.map(([comune, evs]) => {
    const slug = slugifyComune(comune);
    const lines = evs
      .slice(0, MAX_EVENTS_PER_COMUNE)
      .map((ev) => `- **${humanDay(ev.startDate, locale)}${eventTime(ev)}** — ${String(ev.title || '').trim()}`)
      .join('\n');
    return `### ${t.inComune(comune, slug)}\n${lines}`;
  });
  return blocks.join('\n\n');
}

/**
 * Build the full 4-locale article payload for the weekend digest.
 * @param {{ events: Array<object>, todayIso?: string }} params
 */
export function buildWeekendDigestArticle({ events, todayIso }) {
  const { start, end } = weekendWindow(todayIso);
  const weekend = weekendEvents(events, todayIso);
  const byComune = groupByComune(weekend);
  const n = weekend.length;

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
    const body2 = n > 0 ? `## ${t.byComuneH}\n\n${renderByComune(byComune, locale)}` : '';
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
