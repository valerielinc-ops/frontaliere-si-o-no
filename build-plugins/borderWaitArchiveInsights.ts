/**
 * Monthly archive insights — what one crossing did in one month, said in words.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * `/traffico-dogane/<valico>/<YYYY-MM>/` (and `/en/border-wait/`,
 * `/de/wartezeit-grenze/`, `/fr/temps-attente-douane/`) is a cell of a grid —
 * one crossing × one month — and until now everything that told a cell apart
 * from its siblings was a FIGURE: the 24 hourly averages, the monthly mean, the
 * day count. Mask no. 1 of `scripts/lib/informationGain.mjs` folds every figure
 * to `#`, so after masking half the cells of the family carried not one
 * sentence of their own: `audit:information-gain` on run 36977215802
 * (2026-10-02) measured the four locale cohorts at 4,2-4,6 % median, 6 pages out
 * of 12 at zero gain, under the 5 % floor.
 *
 * The month's own facts were already in `data/border-wait-history/`, one file
 * per day; the archive page only ever averaged them by HOUR. This module reads
 * the same days by WEEKDAY and by DATE, and compares the cell with its two real
 * neighbours — the same crossing in the previous month, and the other archived
 * crossings in the same month:
 *
 *   1. the seven weekdays ordered from busiest to quietest — the order is the
 *      information, and it is a different order on every cell;
 *   2. the busiest and the quietest single day of the month, named by weekday
 *      and date;
 *   3. the change against the previous archived month, named;
 *   4. the other archived crossings of the same month, ranked on the monthly
 *      mean with their names (`shared/peerCohortComparison.ts`).
 *
 * Nothing is editorial and nothing is invented: every sentence is computed from
 * the day files the page already aggregates, and a fact without data (a month
 * with no previous archive, a weekday with no observation) is left out rather
 * than filled. Weekday and month names survive both masks of the audit — they
 * are words, and they are not the page's own identity tokens — which is exactly
 * why they carry the cell's identity here instead of the figures.
 */

import { renderPeerComparison, type PeerRow, type PeerLocale } from './shared/peerCohortComparison';
import {
  BORDER_CROSSING_DISPLAY,
  TOP_5_CROSSINGS,
  buildArchivePath,
  type BorderCrossingSlug,
  type BorderWaitLocale,
} from './borderWaitData';

/** Structural subset of `BorderWaitHistoryDay` (kept local: no import cycle with the plugin). */
export interface ArchiveHistoryDay {
  date: string;
  perCrossing: Partial<Record<string, Array<null | { avg: number; max?: number }>>>;
}

interface DayStat {
  date: string;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  mean: number;
  /** Sum and count of the hourly averages, so a month can be pooled exactly like the page's own mean. */
  sum: number;
  count: number;
  peak: number;
  peakHour: number;
}

const INTL_LOCALE: Record<BorderWaitLocale, string> = {
  it: 'it-CH',
  en: 'en-GB',
  de: 'de-CH',
  fr: 'fr-CH',
};

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** `YYYY-MM-DD` read as a calendar date (UTC), so the weekday never shifts with the build host's zone. */
function utcDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function weekdayIndex(date: string): number {
  return (utcDate(date).getUTCDay() + 6) % 7;
}

/** One number per observed day: mean of the hourly averages that have data, plus the worst hour. */
export function dayStatsForMonth(
  history: readonly ArchiveHistoryDay[],
  crossing: string,
  monthKey: string,
): DayStat[] {
  const out: DayStat[] = [];
  for (const day of history) {
    if (!day.date.startsWith(monthKey)) continue;
    const series = day.perCrossing[crossing];
    if (!Array.isArray(series)) continue;
    let sum = 0;
    let count = 0;
    let peak = -1;
    let peakHour = -1;
    series.forEach((cell, hour) => {
      if (!cell || !Number.isFinite(cell.avg)) return;
      sum += cell.avg;
      count += 1;
      if (cell.avg > peak) {
        peak = cell.avg;
        peakHour = hour;
      }
    });
    if (count === 0) continue;
    out.push({ date: day.date, weekday: weekdayIndex(day.date), mean: sum / count, sum, count, peak, peakHour });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The month pooled over every hourly cell, rounded to the minute — the SAME
 * definition and rounding as the archive page's own «media mensile» tile
 * (`overallAvg` in `renderArchivePage`), so the page never shows two different
 * monthly means for the same crossing.
 */
function monthlyMean(days: readonly DayStat[]): number | null {
  const count = days.reduce((acc, d) => acc + d.count, 0);
  if (count === 0) return null;
  return Math.round(days.reduce((acc, d) => acc + d.sum, 0) / count);
}

function previousMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function weekdayName(weekday: number, locale: BorderWaitLocale): string {
  // 2024-01-01 was a Monday: offsetting from it gives the localized name of any index.
  const ref = new Date(Date.UTC(2024, 0, 1 + weekday, 12));
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { weekday: 'long', timeZone: 'UTC' }).format(ref);
}

function longDate(date: string, locale: BorderWaitLocale): string {
  const formatted = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(utcDate(date));
  // French writes the first of the month as an ordinal («samedi 1er août»).
  return locale === 'fr' ? formatted.replace(/(^|\s)1(\s)/, '$11er$2') : formatted;
}

function monthName(monthKey: string, locale: BorderWaitLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    utcDate(`${monthKey}-15`),
  );
}

const fmtMin = (n: number, locale: BorderWaitLocale): string => {
  const v = round1(n);
  const s = Number.isInteger(v) ? String(v) : String(v).replace('.', locale === 'en' ? '.' : ',');
  return `${s} min`;
};

const fmtHour = (h: number): string => `${String(h).padStart(2, '0')}:00`;

const COPY = {
  heading: {
    it: 'Il mese giorno per giorno',
    en: 'The month, day by day',
    de: 'Der Monat Tag für Tag',
    fr: 'Le mois, jour par jour',
  },
  weekdayOrder: {
    it: (list: string) => `Giorni della settimana dal più carico al più scorrevole, in media sul mese: ${list}.`,
    en: (list: string) => `Weekdays from busiest to quietest, averaged over the month: ${list}.`,
    de: (list: string) => `Wochentage vom stärksten zum ruhigsten, im Monatsmittel: ${list}.`,
    fr: (list: string) => `Jours de la semaine du plus chargé au plus fluide, en moyenne sur le mois : ${list}.`,
  },
  worstDay: {
    it: (d: string, mean: string, peak: string, hour: string) => `Il giorno con l’attesa media più alta è stato ${d}: ${mean} di media, con il picco di ${peak} alle ${hour}.`,
    en: (d: string, mean: string, peak: string, hour: string) => `The day with the highest average wait was ${d}: ${mean} on average, peaking at ${peak} at ${hour}.`,
    de: (d: string, mean: string, peak: string, hour: string) => `Der Tag mit der höchsten mittleren Wartezeit war ${d}: im Mittel ${mean}, Spitze ${peak} um ${hour}.`,
    fr: (d: string, mean: string, peak: string, hour: string) => `Le jour à l’attente moyenne la plus élevée a été ${d} : ${mean} en moyenne, avec un pic de ${peak} à ${hour}.`,
  },
  bestDay: {
    it: (d: string, mean: string) => `Il più scorrevole è stato ${d}, con ${mean} di media.`,
    en: (d: string, mean: string) => `The quietest was ${d}, at ${mean} on average.`,
    de: (d: string, mean: string) => `Am ruhigsten war es am ${d}, mit im Mittel ${mean}.`,
    fr: (d: string, mean: string) => `Le plus fluide a été ${d}, avec ${mean} en moyenne.`,
  },
  vsPrevious: {
    it: (prev: string, from: string, to: string, dir: 'up' | 'down' | 'flat') =>
      dir === 'flat'
        ? `Rispetto a ${prev} la media mensile è rimasta invariata (${to}).`
        : `Rispetto a ${prev} la media mensile è ${dir === 'up' ? 'salita' : 'scesa'} da ${from} a ${to}.`,
    en: (prev: string, from: string, to: string, dir: 'up' | 'down' | 'flat') =>
      dir === 'flat'
        ? `Compared with ${prev} the monthly average was unchanged (${to}).`
        : `Compared with ${prev} the monthly average ${dir === 'up' ? 'rose' : 'fell'} from ${from} to ${to}.`,
    de: (prev: string, from: string, to: string, dir: 'up' | 'down' | 'flat') =>
      dir === 'flat'
        ? `Gegenüber ${prev} blieb der Monatsdurchschnitt unverändert (${to}).`
        : `Gegenüber ${prev} ist der Monatsdurchschnitt von ${from} auf ${to} ${dir === 'up' ? 'gestiegen' : 'gesunken'}.`,
    fr: (prev: string, from: string, to: string, dir: 'up' | 'down' | 'flat') =>
      dir === 'flat'
        ? `Par rapport à ${prev}, la moyenne mensuelle est restée stable (${to}).`
        : `Par rapport à ${prev}, la moyenne mensuelle est ${dir === 'up' ? 'montée' : 'descendue'} de ${from} à ${to}.`,
  },
  peerHeading: {
    it: (month: string) => `Gli altri valichi principali in ${month}`,
    en: (month: string) => `The other main crossings in ${month}`,
    de: (month: string) => `Die anderen Hauptübergänge im ${month}`,
    fr: (month: string) => `Les autres passages principaux en ${month}`,
  },
  peerMetric: {
    it: 'attesa media del mese',
    en: 'monthly average wait',
    de: 'mittlere Wartezeit im Monat',
    fr: 'attente moyenne du mois',
  },
  // In `de` the module wants the dative plural (see PeerComparisonLabels.peerNoun).
  peerNoun: { it: 'valichi', en: 'crossings', de: 'Übergängen', fr: 'passages' },
  peerSource: {
    it: 'Medie calcolate sugli stessi file giornalieri TomTom di questo archivio.',
    en: 'Averages computed from the same daily TomTom files as this archive.',
    de: 'Mittelwerte aus denselben täglichen TomTom-Dateien wie dieses Archiv.',
    fr: 'Moyennes calculées sur les mêmes fichiers quotidiens TomTom que cette archive.',
  },
} as const;

/**
 * The prose sentences, without markup — exported so the tests can assert on
 * what a reader sees rather than on HTML.
 */
export function buildArchiveInsightSentences(params: {
  locale: BorderWaitLocale;
  crossing: BorderCrossingSlug;
  monthKey: string;
  history: readonly ArchiveHistoryDay[];
}): string[] {
  const { locale, crossing, monthKey, history } = params;
  const days = dayStatsForMonth(history, crossing, monthKey);
  if (days.length === 0) return [];
  const sentences: string[] = [];

  // 1. Weekday order. Ties keep calendar order (Monday first), so the HTML is
  //    deterministic whatever order the day files were read in.
  const byWeekday = new Map<number, number[]>();
  for (const d of days) {
    const list = byWeekday.get(d.weekday) ?? [];
    list.push(d.mean);
    byWeekday.set(d.weekday, list);
  }
  const weekdayMeans = [...byWeekday.entries()]
    .map(([weekday, means]) => ({ weekday, mean: means.reduce((a, b) => a + b, 0) / means.length }))
    .sort((a, b) => round1(b.mean) - round1(a.mean) || a.weekday - b.weekday);
  if (weekdayMeans.length >= 3) {
    const list = weekdayMeans.map((w) => `${weekdayName(w.weekday, locale)} (${fmtMin(w.mean, locale)})`).join(', ');
    sentences.push(COPY.weekdayOrder[locale](list));
  }

  // 2. Busiest and quietest single day.
  const byMean = [...days].sort((a, b) => b.mean - a.mean || a.date.localeCompare(b.date));
  const worst = byMean[0];
  const best = byMean[byMean.length - 1];
  if (worst && best && worst.date !== best.date && round1(worst.mean) !== round1(best.mean)) {
    sentences.push(
      COPY.worstDay[locale](longDate(worst.date, locale), fmtMin(worst.mean, locale), fmtMin(worst.peak, locale), fmtHour(worst.peakHour)),
    );
    sentences.push(COPY.bestDay[locale](longDate(best.date, locale), fmtMin(best.mean, locale)));
  }

  // 3. Against the previous month of the same crossing, when the archive has it.
  const prevKey = previousMonthKey(monthKey);
  const prevMean = monthlyMean(dayStatsForMonth(history, crossing, prevKey));
  const mean = monthlyMean(days);
  if (prevMean !== null && mean !== null) {
    const from = prevMean;
    const to = mean;
    const dir = to > from ? 'up' : to < from ? 'down' : 'flat';
    sentences.push(COPY.vsPrevious[locale](monthName(prevKey, locale), fmtMin(from, locale), fmtMin(to, locale), dir));
  }

  return sentences;
}

/**
 * The whole block: the month in words, then the same-month peer ranking of the
 * archived crossings. Returns `''` when the month has no observed day — the
 * page then keeps its table and methodology and promises nothing more.
 */
export function renderArchiveMonthInsights(params: {
  locale: BorderWaitLocale;
  crossing: BorderCrossingSlug;
  monthKey: string;
  history: readonly ArchiveHistoryDay[];
  headingStyle?: string;
}): string {
  const { locale, crossing, monthKey, history, headingStyle = '' } = params;
  const sentences = buildArchiveInsightSentences({ locale, crossing, monthKey, history });
  if (sentences.length === 0) return '';

  // The cohort is the set of crossings that HAVE an archive page for this
  // month, so every linked peer resolves to a real page.
  const rows: PeerRow[] = TOP_5_CROSSINGS.map((slug) => {
    const value = monthlyMean(dayStatsForMonth(history, slug, monthKey));
    return {
      key: slug,
      name: BORDER_CROSSING_DISPLAY[slug],
      href: buildArchivePath(locale, slug, monthKey),
      value,
    };
  });
  const peers = renderPeerComparison({
    locale: locale as PeerLocale,
    currentKey: crossing,
    rows,
    labels: {
      heading: COPY.peerHeading[locale](monthName(monthKey, locale)),
      metricLabel: COPY.peerMetric[locale],
      peerNoun: COPY.peerNoun[locale],
    },
    formatValue: (value) => fmtMin(value, locale),
    // Shortest wait first.
    higherIsBetter: false,
    sourceNote: COPY.peerSource[locale],
  });

  return `<section data-archive-insights="1" aria-labelledby="archiveInsights">
    <h2 id="archiveInsights" style="${headingStyle}">${esc(COPY.heading[locale])}</h2>
    ${sentences.map((s) => `<p class="s-KwuhOL">${esc(s)}</p>`).join('\n    ')}
  </section>${peers}`;
}
