/**
 * Ticino school-calendar landings — one page per DECS school year × 4 locales.
 *
 * Data: build-plugins/schoolCalendarData.ts (official DECS PDFs, one record
 * per school year). Every record from FIRST_GENERATED_START_YEAR on gets a
 * landing; the 2026/27 year keeps its hand-written page and is only linked.
 * Adding the next DECS record is the whole yearly rollover: route, sitemap,
 * hreflang and the cross-links between years follow from the data. Nothing
 * is estimated — a year the DECS has not published yet has no page, and every
 * page says up to which year official dates exist.
 *
 * Status labels («in corso», «in arrivo», «concluso») derive from the build
 * date, so the same page moves on by itself as the school year passes.
 *
 * No floor/threshold loop — the page set is the curated DECS record list, so
 * no below-floor bridge / searchConsoleCompat self-map is required (same
 * reasoning as holidaysLandingsPlugin).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { CALC_HREF } from './shared/calcHref';
import { formatPageGenerationDate } from './shared/pageGenerationDate';
import { WriteCollector } from './batchWrite';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import { buildHolidaysLandingPath } from './holidaysLandingsData';
import {
  H1_STYLE,
  H2_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  HERO_EYEBROW_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  renderStatGrid,
} from './shared/seoContentTokens';
import {
  GENERATED_SCHOOL_YEARS,
  SCHOOL_CALENDAR_SOURCE_INDEX,
  SCHOOL_HOLIDAY_NAMES,
  SCHOOL_LOCALES,
  buildSchoolCalendarPath,
  schoolCalendarFor,
  schoolYearLabel,
  schoolYearStatus,
  type SchoolDateRange,
  type SchoolLocale,
  type SchoolYearCalendar,
} from './schoolCalendarData';
import { renderSchoolYearLinks } from './schoolCalendarLinks';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<SchoolLocale, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };

const DAY_MS = 86_400_000;
const isoDate = (iso: string): Date => new Date(`${iso}T12:00:00Z`);
const addDays = (iso: string, days: number): string =>
  new Date(isoDate(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10);
/** Inclusive calendar days of a DECS range («dal – al compresi»). */
const rangeDays = (r: SchoolDateRange): number => Math.round((isoDate(r.to).getTime() - isoDate(r.from).getTime()) / DAY_MS) + 1;

function longDate(iso: string, locale: SchoolLocale): string {
  return new Intl.DateTimeFormat(`${locale}-CH`, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(isoDate(iso));
}
function shortDate(iso: string, locale: SchoolLocale): string {
  return new Intl.DateTimeFormat(`${locale}-CH`, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(isoDate(iso));
}
function rangeText(r: SchoolDateRange, locale: SchoolLocale): string {
  return `${longDate(r.from, locale)} – ${longDate(r.to, locale)}`;
}

interface SchoolCopy {
  readonly breadcrumbHome: string;
  readonly title: (label: string) => string;
  readonly h1: (label: string) => string;
  readonly eyebrow: string;
  readonly lede: (label: string) => string;
  readonly description: (label: string, c: SchoolYearCalendar) => string;
  readonly status: Record<'upcoming' | 'current' | 'past', string>;
  readonly tiles: { first: string; last: string; breakDays: string; closedDays: string };
  readonly tableTitle: (label: string) => string;
  readonly colPeriod: string;
  readonly colDates: string;
  readonly colLength: string;
  readonly rows: { first: string; autumn: string; christmas: string; carnival: string; easter: string; last: string; summer: string };
  readonly days: (n: number) => string;
  readonly closedTitle: string;
  readonly closedIntro: string;
  readonly extraDayOff: string;
  readonly summerUntil: (from: string, to: string) => string;
  readonly summerUnknown: (from: string, nextLabel: string) => string;
  readonly frontalieri: string;
  readonly exceptions: string;
  readonly source: (label: string) => string;
  readonly related: string;
  readonly holidaysLink: string;
  readonly calcLink: string;
  readonly faqTitle: string;
  readonly faqs: (label: string, c: SchoolYearCalendar, locale: SchoolLocale) => ReadonlyArray<{ q: string; a: string }>;
}

const COPY: Record<SchoolLocale, SchoolCopy> = {
  it: {
    breadcrumbHome: 'Home',
    title: (l) => `Calendario scolastico Ticino ${l}: vacanze e date DECS`,
    h1: (l) => `Vacanze scolastiche Ticino ${l}: calendario ufficiale DECS`,
    eyebrow: 'Calendario scolastico · Canton Ticino',
    lede: (l) => `Le date dell’anno scolastico ${l} nelle scuole del Canton Ticino, dal calendario pubblicato dal DECS: inizio, vacanze, festivi a scuola chiusa e ultimo giorno.`,
    description: (l, c) => `Calendario scolastico Ticino ${l} (DECS): inizio ${shortDate(c.firstDay, 'it')}, Natale dal ${shortDate(c.christmas.from, 'it')}, Carnevale dal ${shortDate(c.carnival.from, 'it')}, Pasqua dal ${shortDate(c.easter.from, 'it')}, fine scuola ${shortDate(c.lastDay, 'it')}.`,
    status: { upcoming: 'Anno scolastico in arrivo', current: 'Anno scolastico in corso', past: 'Anno scolastico concluso' },
    tiles: { first: 'Primo giorno di scuola', last: 'Ultimo giorno di scuola', breakDays: 'Giorni di vacanza (autunno, Natale, Carnevale, Pasqua)', closedDays: 'Festivi e ponti a scuola chiusa' },
    tableTitle: (l) => `Vacanze scolastiche ${l}`,
    colPeriod: 'Periodo', colDates: 'Date (comprese)', colLength: 'Durata',
    rows: { first: 'Inizio delle lezioni', autumn: 'Vacanze autunnali', christmas: 'Vacanze di Natale', carnival: 'Vacanze di Carnevale', easter: 'Vacanze di Pasqua', last: 'Fine delle lezioni', summer: 'Vacanze estive' },
    days: (n) => `${n} giorni`,
    closedTitle: 'Festivi e giorni di vacanza durante l’anno',
    closedIntro: 'Oltre alle vacanze, il calendario DECS indica questi giorni senza lezioni:',
    extraDayOff: 'giorno di vacanza (ponte)',
    summerUntil: (from, to) => `dal ${from} fino al ${to}`,
    summerUnknown: (from, next) => `dal ${from}; la data di rientro dipende dal calendario ${next}, che il DECS non ha ancora pubblicato`,
    frontalieri: 'Per le famiglie di frontalieri: le scuole italiane di confine seguono il calendario regionale lombardo, con inizio e vacanze diversi da quelli ticinesi. Confronta le due date prima di pianificare ferie e custodia dei figli.',
    exceptions: 'Le date valgono per tutte le scuole del Cantone; sono riservate le disposizioni delle scuole professionali e delle scuole specializzate superiori del settore sanitario.',
    source: (l) => `Fonte ufficiale: DECS, Calendario scolastico ${l} (PDF)`,
    related: 'Approfondisci',
    holidaysLink: 'Giorni festivi ufficiali in Ticino',
    calcLink: 'Calcola il tuo stipendio netto da frontaliere',
    faqTitle: 'Domande frequenti',
    faqs: (l, c, loc) => [
      { q: `Quando inizia la scuola in Ticino nell’anno scolastico ${l}?`, a: `Le lezioni dell’anno scolastico ${l} iniziano ${longDate(c.firstDay, loc)} in tutte le scuole del Canton Ticino, secondo il calendario ufficiale del DECS.` },
      { q: `Quando finisce la scuola in Ticino nel ${c.startYear + 1}?`, a: `Le lezioni terminano ${longDate(c.lastDay, loc)}; le vacanze estive iniziano il giorno successivo.` },
      { q: `Quando sono le vacanze di Carnevale ${c.startYear + 1} in Ticino?`, a: `Le vacanze di Carnevale vanno da ${longDate(c.carnival.from, loc)} a ${longDate(c.carnival.to, loc)} (${rangeDays(c.carnival)} giorni).` },
    ],
  },
  en: {
    breadcrumbHome: 'Home',
    title: (l) => `Ticino school calendar ${l}: holidays and DECS dates`,
    h1: (l) => `Ticino school holidays ${l}: official DECS calendar`,
    eyebrow: 'School calendar · Canton Ticino',
    lede: (l) => `The dates of the ${l} school year in Canton Ticino schools, from the calendar published by the DECS: first day, holidays, school-closed public holidays and last day.`,
    description: (l, c) => `Ticino school calendar ${l} (DECS): first day ${shortDate(c.firstDay, 'en')}, Christmas from ${shortDate(c.christmas.from, 'en')}, Carnival from ${shortDate(c.carnival.from, 'en')}, Easter from ${shortDate(c.easter.from, 'en')}, last day ${shortDate(c.lastDay, 'en')}.`,
    status: { upcoming: 'Upcoming school year', current: 'Current school year', past: 'Past school year' },
    tiles: { first: 'First day of school', last: 'Last day of school', breakDays: 'Holiday days (autumn, Christmas, Carnival, Easter)', closedDays: 'Public holidays and bridges with school closed' },
    tableTitle: (l) => `School holidays ${l}`,
    colPeriod: 'Period', colDates: 'Dates (inclusive)', colLength: 'Length',
    rows: { first: 'First day of lessons', autumn: 'Autumn holidays', christmas: 'Christmas holidays', carnival: 'Carnival holidays', easter: 'Easter holidays', last: 'Last day of lessons', summer: 'Summer holidays' },
    days: (n) => `${n} days`,
    closedTitle: 'Public holidays and days off during the year',
    closedIntro: 'Besides the holidays, the DECS calendar lists these days without lessons:',
    extraDayOff: 'day off (bridge)',
    summerUntil: (from, to) => `from ${from} until ${to}`,
    summerUnknown: (from, next) => `from ${from}; the return date depends on the ${next} calendar, which the DECS has not published yet`,
    frontalieri: 'For cross-border families: Italian border schools follow the Lombardy regional calendar, with a different start and different holidays. Compare both before planning leave and childcare.',
    exceptions: 'The dates apply to all schools in the canton; vocational schools and higher professional schools in healthcare may follow their own rules.',
    source: (l) => `Official source: DECS, School calendar ${l} (PDF)`,
    related: 'Read more',
    holidaysLink: 'Official public holidays in Ticino',
    calcLink: 'Calculate your cross-border net salary',
    faqTitle: 'Frequently asked questions',
    faqs: (l, c, loc) => [
      { q: `When does school start in Ticino in the ${l} school year?`, a: `Lessons of the ${l} school year start on ${longDate(c.firstDay, loc)} in all Canton Ticino schools, according to the official DECS calendar.` },
      { q: `When does school end in Ticino in ${c.startYear + 1}?`, a: `Lessons end on ${longDate(c.lastDay, loc)}; summer holidays start the following day.` },
      { q: `When are the ${c.startYear + 1} Carnival holidays in Ticino?`, a: `Carnival holidays run from ${longDate(c.carnival.from, loc)} to ${longDate(c.carnival.to, loc)} (${rangeDays(c.carnival)} days).` },
    ],
  },
  de: {
    breadcrumbHome: 'Startseite',
    title: (l) => `Schulkalender Tessin ${l}: Schulferien und Daten`,
    h1: (l) => `Schulferien Tessin ${l}: offizieller DECS-Kalender`,
    eyebrow: 'Schulkalender · Kanton Tessin',
    lede: (l) => `Die Daten des Schuljahres ${l} an den Schulen des Kantons Tessin, aus dem vom DECS veröffentlichten Kalender: Schulbeginn, Ferien, schulfreie Feiertage und letzter Schultag.`,
    description: (l, c) => `Schulkalender Tessin ${l} (DECS): Schulbeginn ${shortDate(c.firstDay, 'de')}, Weihnachten ab ${shortDate(c.christmas.from, 'de')}, Fasnacht ab ${shortDate(c.carnival.from, 'de')}, Ostern ab ${shortDate(c.easter.from, 'de')}, Schulende ${shortDate(c.lastDay, 'de')}.`,
    status: { upcoming: 'Kommendes Schuljahr', current: 'Laufendes Schuljahr', past: 'Abgeschlossenes Schuljahr' },
    tiles: { first: 'Erster Schultag', last: 'Letzter Schultag', breakDays: 'Ferientage (Herbst, Weihnachten, Fasnacht, Ostern)', closedDays: 'Schulfreie Feiertage und Brücken' },
    tableTitle: (l) => `Schulferien ${l}`,
    colPeriod: 'Zeitraum', colDates: 'Daten (inklusive)', colLength: 'Dauer',
    rows: { first: 'Schulbeginn', autumn: 'Herbstferien', christmas: 'Weihnachtsferien', carnival: 'Fasnachtsferien', easter: 'Osterferien', last: 'Letzter Schultag', summer: 'Sommerferien' },
    days: (n) => `${n} Tage`,
    closedTitle: 'Feiertage und freie Tage im Schuljahr',
    closedIntro: 'Neben den Ferien nennt der DECS-Kalender diese unterrichtsfreien Tage:',
    extraDayOff: 'freier Tag (Brücke)',
    summerUntil: (from, to) => `vom ${from} bis ${to}`,
    summerUnknown: (from, next) => `ab ${from}; das Ende hängt vom Kalender ${next} ab, den das DECS noch nicht veröffentlicht hat`,
    frontalieri: 'Für Grenzgängerfamilien: Italienische Grenzschulen folgen dem lombardischen Regionalkalender mit anderem Schulbeginn und anderen Ferien. Vergleichen Sie beide Daten, bevor Sie Urlaub und Kinderbetreuung planen.',
    exceptions: 'Die Daten gelten für alle Schulen des Kantons; vorbehalten bleiben die Regeln der Berufsfachschulen und der höheren Fachschulen im Gesundheitswesen.',
    source: (l) => `Offizielle Quelle: DECS, Schulkalender ${l} (PDF)`,
    related: 'Mehr erfahren',
    holidaysLink: 'Offizielle Feiertage im Tessin',
    calcLink: 'Grenzgänger-Nettolohn berechnen',
    faqTitle: 'Häufige Fragen',
    faqs: (l, c, loc) => [
      { q: `Wann beginnt die Schule im Tessin im Schuljahr ${l}?`, a: `Der Unterricht des Schuljahres ${l} beginnt am ${longDate(c.firstDay, loc)} an allen Schulen des Kantons Tessin, gemäss offiziellem DECS-Kalender.` },
      { q: `Wann endet die Schule im Tessin ${c.startYear + 1}?`, a: `Der Unterricht endet am ${longDate(c.lastDay, loc)}; die Sommerferien beginnen am Tag danach.` },
      { q: `Wann sind die Fasnachtsferien ${c.startYear + 1} im Tessin?`, a: `Die Fasnachtsferien dauern vom ${longDate(c.carnival.from, loc)} bis ${longDate(c.carnival.to, loc)} (${rangeDays(c.carnival)} Tage).` },
    ],
  },
  fr: {
    breadcrumbHome: 'Accueil',
    title: (l) => `Calendrier scolaire Tessin ${l} : vacances et dates`,
    h1: (l) => `Vacances scolaires Tessin ${l} : calendrier officiel du DECS`,
    eyebrow: 'Calendrier scolaire · Canton du Tessin',
    lede: (l) => `Les dates de l’année scolaire ${l} dans les écoles du Canton du Tessin, d’après le calendrier publié par le DECS : rentrée, vacances, jours fériés sans école et dernier jour.`,
    description: (l, c) => `Calendrier scolaire Tessin ${l} (DECS) : rentrée ${shortDate(c.firstDay, 'fr')}, Noël dès le ${shortDate(c.christmas.from, 'fr')}, Carnaval dès le ${shortDate(c.carnival.from, 'fr')}, Pâques dès le ${shortDate(c.easter.from, 'fr')}, fin ${shortDate(c.lastDay, 'fr')}.`,
    status: { upcoming: 'Année scolaire à venir', current: 'Année scolaire en cours', past: 'Année scolaire terminée' },
    tiles: { first: 'Rentrée scolaire', last: 'Dernier jour d’école', breakDays: 'Jours de vacances (automne, Noël, Carnaval, Pâques)', closedDays: 'Jours fériés et ponts sans école' },
    tableTitle: (l) => `Vacances scolaires ${l}`,
    colPeriod: 'Période', colDates: 'Dates (incluses)', colLength: 'Durée',
    rows: { first: 'Rentrée', autumn: 'Vacances d’automne', christmas: 'Vacances de Noël', carnival: 'Vacances de Carnaval', easter: 'Vacances de Pâques', last: 'Dernier jour de cours', summer: 'Vacances d’été' },
    days: (n) => `${n} jours`,
    closedTitle: 'Jours fériés et jours de congé pendant l’année',
    closedIntro: 'En plus des vacances, le calendrier du DECS indique ces jours sans cours :',
    extraDayOff: 'jour de congé (pont)',
    summerUntil: (from, to) => `du ${from} au ${to}`,
    summerUnknown: (from, next) => `dès le ${from} ; la date de reprise dépend du calendrier ${next}, que le DECS n’a pas encore publié`,
    frontalieri: 'Pour les familles frontalières : les écoles italiennes de la frontière suivent le calendrier régional lombard, avec une rentrée et des vacances différentes. Comparez les deux avant de planifier congés et garde des enfants.',
    exceptions: 'Les dates valent pour toutes les écoles du canton ; les écoles professionnelles et les écoles supérieures du domaine de la santé peuvent suivre leurs propres règles.',
    source: (l) => `Source officielle : DECS, Calendrier scolaire ${l} (PDF)`,
    related: 'Pour aller plus loin',
    holidaysLink: 'Jours fériés officiels au Tessin',
    calcLink: 'Calculer votre salaire net de frontalier',
    faqTitle: 'Questions fréquentes',
    faqs: (l, c, loc) => [
      { q: `Quand commence l’école au Tessin pour l’année scolaire ${l} ?`, a: `Les cours de l’année scolaire ${l} commencent le ${longDate(c.firstDay, loc)} dans toutes les écoles du Canton du Tessin, selon le calendrier officiel du DECS.` },
      { q: `Quand finit l’école au Tessin en ${c.startYear + 1} ?`, a: `Les cours se terminent le ${longDate(c.lastDay, loc)} ; les vacances d’été commencent le lendemain.` },
      { q: `Quand sont les vacances de Carnaval ${c.startYear + 1} au Tessin ?`, a: `Les vacances de Carnaval vont du ${longDate(c.carnival.from, loc)} au ${longDate(c.carnival.to, loc)} (${rangeDays(c.carnival)} jours).` },
    ],
  },
};

interface RenderResult {
  readonly urlPath: string;
  readonly html: string;
  readonly wordCount: number;
}

function renderPage(opts: {
  locale: SchoolLocale;
  startYear: number;
  dateStamp: string;
  distDir?: string;
  /** Locales the build will actually write for this year (see holidaysLandingsPlugin #5114). */
  eligibleLocales?: ReadonlySet<string>;
}): RenderResult {
  const { locale, startYear, dateStamp, distDir, eligibleLocales = new Set<string>() } = opts;
  const cal = schoolCalendarFor(startYear);
  if (!cal) throw new Error(`[school-calendar] no DECS record for ${startYear}`);
  const L = COPY[locale];
  const label = schoolYearLabel(startYear);
  const next = schoolCalendarFor(startYear + 1);
  const status = schoolYearStatus(cal, new Date(`${dateStamp}T12:00:00Z`));

  const urlPath = buildSchoolCalendarPath(locale, startYear);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const title = L.title(label);
  const h1 = L.h1(label);
  const description = L.description(label, cal);

  const breaks = [cal.autumn, cal.christmas, cal.carnival, cal.easter];
  const breakDays = breaks.reduce((n, r) => n + rangeDays(r), 0);
  const isWeekday = (iso: string): boolean => { const d = isoDate(iso).getUTCDay(); return d !== 0 && d !== 6; };
  const closedDays = cal.closedHolidays.filter((h) => isWeekday(h.date)).length + cal.extraDaysOff.length;
  const summerFrom = addDays(cal.lastDay, 1);
  const summerText = next
    ? L.summerUntil(longDate(summerFrom, locale), longDate(addDays(next.firstDay, -1), locale))
    : L.summerUnknown(longDate(summerFrom, locale), schoolYearLabel(startYear + 1));

  const alternates = buildLocaleAlternateBlock({
    eligibleLocales,
    hrefFor: (alt) => `${BASE_URL}${buildSchoolCalendarPath(alt as SchoolLocale, startYear)}`,
    indent: '    ',
  });

  const row = (name: string, dates: string, length: string): string =>
    `<tr><td class="sc">${esc(name)}</td><td class="sc">${esc(dates)}</td><td class="sc">${esc(length)}</td></tr>`;
  const tableRows = [
    row(L.rows.first, longDate(cal.firstDay, locale), ''),
    row(L.rows.autumn, rangeText(cal.autumn, locale), L.days(rangeDays(cal.autumn))),
    row(L.rows.christmas, rangeText(cal.christmas, locale), L.days(rangeDays(cal.christmas))),
    row(L.rows.carnival, rangeText(cal.carnival, locale), L.days(rangeDays(cal.carnival))),
    row(L.rows.easter, rangeText(cal.easter, locale), L.days(rangeDays(cal.easter))),
    row(L.rows.last, longDate(cal.lastDay, locale), ''),
    row(L.rows.summer, summerText, ''),
  ].join('');
  const table = `<div class="s-card" style="overflow-x:auto;padding:0;border-radius:14px"><table aria-label="${esc(L.tableTitle(label))}" style="width:100%;border-collapse:collapse"><caption style="text-align:left;padding:12px 14px;font-weight:700">${esc(L.tableTitle(label))}</caption><thead><tr><th class="sh">${esc(L.colPeriod)}</th><th class="sh">${esc(L.colDates)}</th><th class="sh">${esc(L.colLength)}</th></tr></thead><tbody>${tableRows}</tbody></table></div>`;

  const closedItems = [
    ...cal.closedHolidays.map((h) => ({ date: h.date, name: SCHOOL_HOLIDAY_NAMES[h.id][locale] })),
    ...cal.extraDaysOff.map((d) => ({ date: d, name: L.extraDayOff })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((i) => `<li><strong>${esc(longDate(i.date, locale))}</strong> — ${esc(i.name)}</li>`)
    .join('');

  const faqs = L.faqs(label, cal, locale);
  const faqHtml = faqs
    .map((f) => `<details class="sf"><summary class="sfs">${esc(f.q)}</summary><p class="sfa">${esc(f.a)}</p></details>`)
    .join('');

  const relatedHtml = [
    { href: `${BASE_URL}${buildHolidaysLandingPath(locale, 'ticino')}`, label: L.holidaysLink },
    { href: `${BASE_URL}${CALC_HREF[locale]}`, label: L.calcLink },
  ]
    .map((r) => `<li style="margin:4px 0"><a href="${esc(r.href)}" style="${LINK_ACCENT_STYLE}">${esc(r.label)}</a></li>`)
    .join('');

  const styleBlock = `<style>.sh{${TABLE_HEAD_STYLE}}.sc{${TABLE_CELL_STYLE}}.sf{margin:0 0 10px;padding:14px 16px;background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:12px}.sfs{font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45}.sfa{margin:10px 0 0;color:var(--color-body);line-height:1.65}</style>`;

  const body = `
    ${styleBlock}
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">${esc(L.breadcrumbHome)}</a>
      <span> / </span>
      <span>${esc(h1)}</span>
    </nav>
    <header>
      <p style="${HERO_EYEBROW_STYLE}">${esc(L.eyebrow)} · ${esc(L.status[status])}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(L.lede(label))}</p>
    </header>
    <p class="text-sm font-medium text-accent mt-1">${esc(formatPageGenerationDate(dateStamp, locale))}</p>
    ${renderStatGrid([
      { label: L.tiles.first, value: shortDate(cal.firstDay, locale), tone: 'accent' },
      { label: L.tiles.last, value: shortDate(cal.lastDay, locale), tone: 'accent' },
      { label: L.tiles.breakDays, value: String(breakDays), tone: 'success' },
      { label: L.tiles.closedDays, value: String(closedDays), tone: 'warning' },
    ])}
    <section class="s-KZc0LQ">${table}</section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(L.closedTitle)}</h2>
      <p style="${BODY_STYLE};max-width:780px">${esc(L.closedIntro)}</p>
      <ul style="margin:8px 0 0;padding-left:20px;line-height:1.7">${closedItems}</ul>
    </section>
    <section class="s-KZc0LQ">
      <p style="${BODY_STYLE};max-width:820px">${esc(L.frontalieri)}</p>
      <p style="${BODY_STYLE};max-width:820px">${esc(L.exceptions)}</p>
      <p class="text-sm text-muted"><a href="${esc(cal.sourcePdf)}" rel="noopener" target="_blank" style="${LINK_ACCENT_STYLE}">${esc(L.source(label))}</a> · <a href="${esc(SCHOOL_CALENDAR_SOURCE_INDEX)}" rel="noopener" target="_blank" style="${LINK_ACCENT_STYLE}">ti.ch/decs</a></p>
    </section>
    ${renderSchoolYearLinks(locale, startYear)}
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(L.faqTitle)}</h2>
      ${faqHtml}
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(L.related)}</h2>
      <ul style="list-style:none;padding:0;margin:0">${relatedHtml}</ul>
    </section>`;

  const bodyHtml = `<div class="s-xzWvwM">${body}</div>`;
  const wordCount = countHtmlBodyWords(body);

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: L.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: h1, item: canonicalUrl },
    ],
  };
  const pageLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    description: guardArticleJsonLdDescription(description),
    inLanguage: locale,
    url: canonicalUrl,
    isBasedOn: cal.sourcePdf,
    publisher: { '@type': 'Organization', '@id': `${BASE_URL}/#organization`, name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    jsonLdScripts: [JSON.stringify(breadcrumbLd), JSON.stringify(pageLd), JSON.stringify(faqLd)],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

function buildSitemapXml(entries: ReadonlyArray<{ canonical: string; alternates: readonly string[] }>): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map((a) => {
          const [lang, ...rest] = a.split('|');
          return `    <xhtml:link rel="alternate" hreflang="${lang}" href="${rest.join('|')}" />`;
        })
        .join('\n');
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

const SITEMAP_NAME = 'sitemap-school-calendar.xml';

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_NAME)) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_NAME}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
      fs.writeFileSync(indexPath, idx, 'utf-8');
    }
  } catch (err) {
    console.warn('[school-calendar] failed to patch sitemap index', err);
  }
}

export function schoolCalendarLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'school-calendar-landings',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;
      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'schoolCalendarLandingsPlugin' });
      const sitemapEntries: Array<{ canonical: string; alternates: readonly string[] }> = [];
      let pagesWritten = 0;

      for (const startYear of GENERATED_SCHOOL_YEARS) {
        // Pass 1: settle which locales clear the floor before advertising them (#5114).
        const eligibleLocales = new Set<string>(
          SCHOOL_LOCALES.filter((locale) => renderPage({ locale, startYear, dateStamp, distDir }).wordCount >= MIN_INDEXABLE_WORDS),
        );
        const altLinks = SCHOOL_LOCALES.filter((alt) => eligibleLocales.has(alt)).map(
          (alt) => `${alt}|${BASE_URL}${buildSchoolCalendarPath(alt, startYear)}`,
        );
        if (eligibleLocales.has('it')) altLinks.push(`x-default|${BASE_URL}${buildSchoolCalendarPath('it', startYear)}`);

        for (const locale of SCHOOL_LOCALES) {
          if (!eligibleLocales.has(locale)) {
            console.warn(`[school-calendar] ${locale}/${startYear} below MIN_INDEXABLE_WORDS — skipping`);
            continue;
          }
          const rendered = renderPage({ locale, startYear, dateStamp, distDir, eligibleLocales });
          collector.add(np.join(distDir, rendered.urlPath, 'index.html'), rendered.html);
          collector.add(np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html'), rendered.html);
          sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
          pagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        fs.writeFileSync(np.join(distDir, SITEMAP_NAME), buildSitemapXml(sitemapEntries), 'utf-8');
      }
      const written = await collector.flush();
      console.log(`\x1b[36m[school-calendar]\x1b[0m Generated ${pagesWritten} pages — flushed ${written} files`);
      if (sitemapEntries.length > 0) patchSitemapIndex(distDir, dateStamp);
    },
  };
}

export { renderPage as __renderSchoolCalendarPageForTest };
