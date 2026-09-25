/**
 * Frontaliere public-holiday landings (#4480) — Vite build plugin.
 *
 * Emits 8 static HTML pages (2 page types × 4 locales):
 *   'ticino'   — official Ticino / Switzerland holiday calendar (this year + next)
 *   'ch-vs-it' — Switzerland (Ticino) vs Italy: the non-coinciding days (the
 *                frontaliere differentiator) + bridge-day planning
 *
 * All content is derived from data/seo/frontaliere-holidays.json (refreshed by
 * scripts/update-holidays-dataset.mjs). No floor/threshold loop — the page set
 * is fixed and curated, so no below-floor bridge / searchConsoleCompat self-map
 * is required.
 *
 * Pattern mirrors costOfLivingLandingsPlugin: buildSeoPageHtml shell,
 * seoContentOutsideRoot, WriteCollector, sitemap-holidays.xml + index patch.
 * Env gate: SKIP_HOLIDAYS=1 fast-exits (local builds only; CI always runs).
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const __dirname_holidays = np.dirname(fileURLToPath(import.meta.url));

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  renderSeoHeroImage,
  seoHeroImageObject,
  seoHeroImageUrl,
  SEO_HERO_WIDTH,
  SEO_HERO_HEIGHT,
  type SeoHeroImageOpts,
} from './shared/seoHeroImage';
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { CALC_HREF } from './shared/calcHref';
import { COMPLETE_WORK_GUIDE_HREF } from './shared/pillarGuideHrefs';
import { formatUpdatedDate } from './shared/humanDate';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import {
  HOLIDAY_LOCALES,
  HOLIDAY_PAGE_IDS,
  buildHolidaysLandingPath,
  type HolidayLocale,
  type HolidayPageId,
  type HolidaysDataset,
  type HolidayRecord,
} from './holidaysLandingsData';
import {
  H1_STYLE,
  H2_STYLE,
  H3_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  HERO_EYEBROW_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  renderStatGrid,
} from './shared/seoContentTokens';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<HolidayLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

// Net-salary calculator path per locale — shared single source of truth
// (build-plugins/shared/calcHref.ts), not a local duplicate.
const CALCULATOR_URL = CALC_HREF;

// Work/permits guide URL per locale (satisfies the "linking da guide
// permessi/lavoro" acceptance criterion via a reciprocal in-page link) —
// shared single source of truth (build-plugins/shared/pillarGuideHrefs.ts),
// not a local duplicate. The local copy this replaced pointed EN at
// /en/cross-border-worker-guide/… (404) and DE at /de/grenzgaenger-leitfaden/…
// (200 but noindex,follow, i.e. a wall for the BFS-depth gate) — #5428.
const PERMITS_GUIDE_URL: Record<HolidayLocale, string> = COMPLETE_WORK_GUIDE_HREF;

const WEEKDAY_ABBR: Record<HolidayLocale, readonly string[]> = {
  it: ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  fr: ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'],
};

// ── Dataset load (module-cached) ──────────────────────────────────────────

let _dataset: HolidaysDataset | null = null;
function loadDataset(): HolidaysDataset {
  if (_dataset) return _dataset;
  const dataPath = np.resolve(__dirname_holidays, '..', 'data', 'seo', 'frontaliere-holidays.json');
  const raw = fs.readFileSync(dataPath, 'utf-8');
  _dataset = JSON.parse(raw) as HolidaysDataset;
  return _dataset;
}

function formatDate(iso: string, locale: HolidayLocale): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = WEEKDAY_ABBR[locale][d.getUTCDay()];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${wd} ${dd}.${mm}.${d.getUTCFullYear()}`;
}

/** Compute bridge (ponte) opportunities for the given year's Ticino holidays. */
interface Bridge {
  readonly holiday: string;
  readonly holidayDate: string;
  readonly bridgeDay: string; // ISO of the bridge day
  readonly direction: 'before' | 'after';
}
function computeBridges(
  holidays: readonly HolidayRecord[],
  year: number,
  locale: HolidayLocale,
): Bridge[] {
  const out: Bridge[] = [];
  for (const h of holidays) {
    if (!h.ticino) continue;
    const iso = h.dates[String(year)];
    if (!iso) continue;
    const d = new Date(`${iso}T00:00:00Z`);
    const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 2) {
      // Tuesday → bridge the Monday before
      const b = new Date(d);
      b.setUTCDate(b.getUTCDate() - 1);
      out.push({
        holiday: h.name[locale],
        holidayDate: formatDate(iso, locale),
        bridgeDay: b.toISOString().slice(0, 10),
        direction: 'before',
      });
    } else if (dow === 4) {
      // Thursday → bridge the Friday after
      const b = new Date(d);
      b.setUTCDate(b.getUTCDate() + 1);
      out.push({
        holiday: h.name[locale],
        holidayDate: formatDate(iso, locale),
        bridgeDay: b.toISOString().slice(0, 10),
        direction: 'after',
      });
    }
  }
  return out;
}

// ── Locale copy ───────────────────────────────────────────────────────────

interface HolidayCopy {
  readonly breadcrumbHome: string;
  readonly breadcrumbHub: string;
  readonly breadcrumbHubPath: string;
  readonly updatedLabel: string;
  readonly ctaCalc: string;
  readonly ctaGuide: string;
  readonly relatedLabel: string;
  readonly tableHeadDate: string;
  readonly tableHeadHoliday: string;
  readonly tableHeadTicino: string;
  readonly tableHeadItaly: string;
  readonly bridgesTitle: string;
  readonly bridgesIntro: string;
  readonly faqTitle: string;
  readonly nonCoincTitle: string;
  // page-specific
  readonly ticino: {
    title: (y1: number, y2: number) => string;
    description: (y1: number) => string;
    eyebrow: string;
    h1: (y1: number, y2: number) => string;
    lede: (n: number, y1: number) => string;
    calendarTitle: (y: number) => string;
    intro: string;
    statFestiviLabel: string;
    statBridgesLabel: string;
    statNonCoincLabel: string;
  };
  readonly chVsIt: {
    title: (y1: number) => string;
    description: string;
    eyebrow: string;
    h1: string;
    lede: (tiOnly: number, itOnly: number) => string;
    intro: string;
    tiOnlyHeading: string;
    tiOnlyIntro: string;
    itOnlyHeading: string;
    itOnlyIntro: string;
    statBothLabel: string;
    statTiOnlyLabel: string;
    statItOnlyLabel: string;
    worksInCh: string;
    closedLabel: string;
    openLabel: string;
  };
  readonly faqs: ReadonlyArray<{ q: string; a: string }>;
}

const COPY: Record<HolidayLocale, HolidayCopy> = {
  it: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Guida frontaliere',
    breadcrumbHubPath: COMPLETE_WORK_GUIDE_HREF.it,
    updatedLabel: 'Aggiornato il',
    ctaCalc: 'Calcola il tuo stipendio netto →',
    ctaGuide: 'Guida completa al lavoro frontaliere',
    relatedLabel: 'Approfondisci',
    tableHeadDate: 'Data',
    tableHeadHoliday: 'Festività',
    tableHeadTicino: 'Ticino',
    tableHeadItaly: 'Italia',
    bridgesTitle: 'Ponti e pianificazione delle ferie',
    bridgesIntro:
      'Quando un giorno festivo cade di martedì o giovedì, prendendo un solo giorno di ferie (il lunedì o il venerdì) ottieni un ponte di quattro giorni. Ecco i ponti più convenienti dell’anno in corso in Ticino.',
    faqTitle: 'Domande frequenti',
    nonCoincTitle: 'I festivi che NON coincidono',
    ticino: {
      title: (y1, y2) => `Giorni festivi Ticino ${y1} e ${y2}`,
      description: (y1) =>
        `Calendario completo dei giorni festivi ufficiali del Canton Ticino ${y1} e ${y1 + 1}: date, ponti e differenze con l’Italia per i frontalieri.`,
      eyebrow: 'Calendario frontalieri',
      h1: (y1, y2) => `Giorni festivi in Ticino ${y1}–${y2}`,
      lede: (n, y1) =>
        `Il Canton Ticino osserva ${n} giorni festivi ufficiali nel ${y1}: ecco tutte le date, i ponti e i festivi che non coincidono con l’Italia.`,
      calendarTitle: (y) => `Calendario festivi ${y}`,
      intro:
        'Il Canton Ticino è il cantone svizzero con il maggior numero di giorni festivi, molti dei quali di tradizione cattolica. Per un frontaliere che vive in Italia e lavora in Ticino questi giorni valgono come giorni non lavorativi in Svizzera, ma alcuni non corrispondono alle festività italiane: nei giorni festivi italiani non riconosciuti in Ticino si lavora regolarmente, mentre nei festivi ticinesi non riconosciuti in Italia si resta a casa. Conoscere in anticipo il calendario aiuta a pianificare ferie, viaggi e spostamenti al valico.',
      statFestiviLabel: 'Festivi in Ticino',
      statBridgesLabel: 'Ponti convenienti',
      statNonCoincLabel: 'Non coincidono con l’Italia',
    },
    chVsIt: {
      title: (y1) => `Giorni festivi Svizzera vs Italia ${y1}`,
      description:
        'Confronto dei giorni festivi tra Ticino/Svizzera e Italia: quali giorni non coincidono e cosa significano per il frontaliere che lavora in Svizzera.',
      eyebrow: 'Confronto frontalieri',
      h1: 'Giorni festivi: Svizzera (Ticino) vs Italia',
      lede: (tiOnly, itOnly) =>
        `${tiOnly} festivi valgono solo in Ticino e ${itOnly} solo in Italia: ecco il confronto completo per chi vive in Italia e lavora in Svizzera.`,
      intro:
        'Il vero interesse per il frontaliere non è l’elenco dei festivi, ma il confronto: nei giorni in cui il Ticino chiude e l’Italia lavora il frontaliere resta a casa, mentre nei giorni in cui l’Italia chiude ma il Ticino lavora deve comunque presentarsi al lavoro in Svizzera. La tabella qui sotto segna per ogni festività se è riconosciuta in Ticino, in Italia o in entrambi.',
      tiOnlyHeading: 'Festivi solo in Ticino (l’Italia lavora)',
      tiOnlyIntro:
        'In questi giorni il frontaliere NON lavora in Svizzera, mentre in Italia è una normale giornata lavorativa:',
      itOnlyHeading: 'Festivi solo in Italia (in Ticino si lavora)',
      itOnlyIntro:
        'In questi giorni l’Italia è chiusa ma il frontaliere lavora regolarmente in Svizzera:',
      statBothLabel: 'Comuni ai due Paesi',
      statTiOnlyLabel: 'Solo Ticino',
      statItOnlyLabel: 'Solo Italia',
      worksInCh: 'Il frontaliere lavora in Svizzera',
      closedLabel: 'Festivo',
      openLabel: 'Lavorativo',
    },
    faqs: [
      {
        q: 'Quali giorni festivi ha il Ticino che non ha l’Italia?',
        a: 'In Ticino sono festivi ma in Italia no: Venerdì Santo, Ascensione, Lunedì di Pentecoste, Corpus Domini, Santi Pietro e Paolo (29 giugno) e la Festa nazionale svizzera (1° agosto). In questi giorni il frontaliere non lavora in Svizzera.',
      },
      {
        q: 'Quali festività italiane non valgono in Ticino?',
        a: 'L’Anniversario della Liberazione (25 aprile) e la Festa della Repubblica (2 giugno) sono festivi in Italia ma non in Ticino: in questi giorni il frontaliere lavora regolarmente in Svizzera.',
      },
      {
        q: 'Il frontaliere è pagato nei giorni festivi svizzeri?',
        a: 'Sì. I giorni festivi cantonali riconosciuti sono giorni non lavorativi retribuiti secondo il contratto svizzero, esattamente come per i lavoratori residenti in Ticino.',
      },
    ],
  },
  en: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Cross-border guide',
    breadcrumbHubPath: COMPLETE_WORK_GUIDE_HREF.en,
    updatedLabel: 'Updated on',
    ctaCalc: 'Calculate your net salary →',
    ctaGuide: 'Complete cross-border work guide',
    relatedLabel: 'Read more',
    tableHeadDate: 'Date',
    tableHeadHoliday: 'Holiday',
    tableHeadTicino: 'Ticino',
    tableHeadItaly: 'Italy',
    bridgesTitle: 'Bridge days and leave planning',
    bridgesIntro:
      'When a public holiday falls on a Tuesday or Thursday, taking a single day off (the Monday or the Friday) gives you a four-day break. These are the best bridge days in Ticino this year.',
    faqTitle: 'Frequently asked questions',
    nonCoincTitle: 'The holidays that do NOT coincide',
    ticino: {
      title: (y1, y2) => `Ticino public holidays ${y1} and ${y2}`,
      description: (y1) =>
        `Full calendar of official public holidays in Canton Ticino for ${y1} and ${y1 + 1}: dates, bridge days and differences with Italy for cross-border workers.`,
      eyebrow: 'Cross-border calendar',
      h1: (y1, y2) => `Public holidays in Ticino ${y1}–${y2}`,
      lede: (n, y1) =>
        `Canton Ticino observes ${n} official public holidays in ${y1}: here are all the dates, the bridge days and the holidays that do not coincide with Italy.`,
      calendarTitle: (y) => `Holiday calendar ${y}`,
      intro:
        'Canton Ticino has the most public holidays of any Swiss canton, many of them of Catholic tradition. For a cross-border worker who lives in Italy and works in Ticino, these days count as non-working days in Switzerland — but some do not match the Italian holidays: on Italian holidays that Ticino does not recognise you work as normal, while on Ticino holidays that Italy does not recognise you stay home. Knowing the calendar in advance helps plan leave, trips and border crossings.',
      statFestiviLabel: 'Holidays in Ticino',
      statBridgesLabel: 'Useful bridge days',
      statNonCoincLabel: 'Do not match Italy',
    },
    chVsIt: {
      title: (y1) => `Public holidays: Switzerland vs Italy ${y1}`,
      description:
        'Comparison of public holidays between Ticino/Switzerland and Italy: which days do not coincide and what they mean for the cross-border worker employed in Switzerland.',
      eyebrow: 'Cross-border comparison',
      h1: 'Public holidays: Switzerland (Ticino) vs Italy',
      lede: (tiOnly, itOnly) =>
        `${tiOnly} holidays apply only in Ticino and ${itOnly} only in Italy: here is the full comparison for people who live in Italy and work in Switzerland.`,
      intro:
        'What matters to a cross-border worker is not the list itself but the comparison: on days when Ticino closes and Italy works, the frontaliere stays home; on days when Italy closes but Ticino works, they still have to show up in Switzerland. The table below marks, for each holiday, whether it is recognised in Ticino, in Italy or in both.',
      tiOnlyHeading: 'Holidays only in Ticino (Italy works)',
      tiOnlyIntro:
        'On these days the cross-border worker does NOT work in Switzerland, while in Italy it is a normal working day:',
      itOnlyHeading: 'Holidays only in Italy (Ticino works)',
      itOnlyIntro: 'On these days Italy is closed but the cross-border worker works as usual in Switzerland:',
      statBothLabel: 'Shared by both countries',
      statTiOnlyLabel: 'Ticino only',
      statItOnlyLabel: 'Italy only',
      worksInCh: 'The frontaliere works in Switzerland',
      closedLabel: 'Holiday',
      openLabel: 'Working day',
    },
    faqs: [
      {
        q: 'Which Ticino holidays does Italy not have?',
        a: 'Public holidays in Ticino but not in Italy: Good Friday, Ascension Day, Whit Monday, Corpus Christi, Saints Peter and Paul (29 June) and the Swiss National Day (1 August). On these days the cross-border worker does not work in Switzerland.',
      },
      {
        q: 'Which Italian holidays do not apply in Ticino?',
        a: 'Liberation Day (25 April) and Republic Day (2 June) are holidays in Italy but not in Ticino: on these days the cross-border worker works as usual in Switzerland.',
      },
      {
        q: 'Is the cross-border worker paid on Swiss public holidays?',
        a: 'Yes. Recognised cantonal holidays are paid non-working days under the Swiss contract, exactly as for workers resident in Ticino.',
      },
    ],
  },
  de: {
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Grenzgänger-Leitfaden',
    breadcrumbHubPath: COMPLETE_WORK_GUIDE_HREF.de,
    updatedLabel: 'Aktualisiert am',
    ctaCalc: 'Nettolohn berechnen →',
    ctaGuide: 'Vollständiger Grenzgänger-Leitfaden',
    relatedLabel: 'Mehr erfahren',
    tableHeadDate: 'Datum',
    tableHeadHoliday: 'Feiertag',
    tableHeadTicino: 'Tessin',
    tableHeadItaly: 'Italien',
    bridgesTitle: 'Brückentage und Urlaubsplanung',
    bridgesIntro:
      'Fällt ein Feiertag auf einen Dienstag oder Donnerstag, ergibt ein einziger Urlaubstag (Montag oder Freitag) ein verlängertes Wochenende von vier Tagen. Das sind die besten Brückentage im Tessin in diesem Jahr.',
    faqTitle: 'Häufige Fragen',
    nonCoincTitle: 'Die Feiertage, die NICHT übereinstimmen',
    ticino: {
      title: (y1, y2) => `Feiertage Tessin ${y1} und ${y2}`,
      description: (y1) =>
        `Vollständiger Kalender der offiziellen Feiertage im Kanton Tessin ${y1} und ${y1 + 1}: Daten, Brückentage und Unterschiede zu Italien für Grenzgänger.`,
      eyebrow: 'Grenzgänger-Kalender',
      h1: (y1, y2) => `Feiertage im Tessin ${y1}–${y2}`,
      lede: (n, y1) =>
        `Der Kanton Tessin hat ${n} offizielle Feiertage im Jahr ${y1}: hier alle Daten, die Brückentage und die Feiertage, die nicht mit Italien übereinstimmen.`,
      calendarTitle: (y) => `Feiertagskalender ${y}`,
      intro:
        'Der Kanton Tessin hat die meisten Feiertage aller Schweizer Kantone, viele davon katholischer Tradition. Für einen Grenzgänger, der in Italien wohnt und im Tessin arbeitet, gelten diese Tage als arbeitsfreie Tage in der Schweiz — einige stimmen jedoch nicht mit den italienischen Feiertagen überein: an italienischen Feiertagen, die das Tessin nicht kennt, wird normal gearbeitet, während man an Tessiner Feiertagen, die Italien nicht kennt, zu Hause bleibt. Wer den Kalender im Voraus kennt, plant Urlaub, Reisen und Grenzübertritte leichter.',
      statFestiviLabel: 'Feiertage im Tessin',
      statBridgesLabel: 'Nützliche Brückentage',
      statNonCoincLabel: 'Weichen von Italien ab',
    },
    chVsIt: {
      title: (y1) => `Feiertage: Schweiz vs. Italien ${y1}`,
      description:
        'Vergleich der Feiertage zwischen Tessin/Schweiz und Italien: welche Tage nicht übereinstimmen und was das für den in der Schweiz beschäftigten Grenzgänger bedeutet.',
      eyebrow: 'Grenzgänger-Vergleich',
      h1: 'Feiertage: Schweiz (Tessin) vs. Italien',
      lede: (tiOnly, itOnly) =>
        `${tiOnly} Feiertage gelten nur im Tessin und ${itOnly} nur in Italien: hier der vollständige Vergleich für alle, die in Italien wohnen und in der Schweiz arbeiten.`,
      intro:
        'Für einen Grenzgänger zählt nicht die Liste, sondern der Vergleich: an Tagen, an denen das Tessin schliesst und Italien arbeitet, bleibt der Grenzgänger zu Hause; an Tagen, an denen Italien schliesst, das Tessin aber arbeitet, muss er trotzdem in der Schweiz erscheinen. Die Tabelle unten zeigt für jeden Feiertag, ob er im Tessin, in Italien oder in beiden anerkannt ist.',
      tiOnlyHeading: 'Feiertage nur im Tessin (Italien arbeitet)',
      tiOnlyIntro:
        'An diesen Tagen arbeitet der Grenzgänger NICHT in der Schweiz, während es in Italien ein normaler Arbeitstag ist:',
      itOnlyHeading: 'Feiertage nur in Italien (im Tessin wird gearbeitet)',
      itOnlyIntro: 'An diesen Tagen ist Italien geschlossen, der Grenzgänger arbeitet aber normal in der Schweiz:',
      statBothLabel: 'In beiden Ländern',
      statTiOnlyLabel: 'Nur Tessin',
      statItOnlyLabel: 'Nur Italien',
      worksInCh: 'Der Grenzgänger arbeitet in der Schweiz',
      closedLabel: 'Feiertag',
      openLabel: 'Arbeitstag',
    },
    faqs: [
      {
        q: 'Welche Tessiner Feiertage hat Italien nicht?',
        a: 'Im Tessin, aber nicht in Italien Feiertag: Karfreitag, Auffahrt, Pfingstmontag, Fronleichnam, Peter und Paul (29. Juni) und der Schweizer Bundesfeiertag (1. August). An diesen Tagen arbeitet der Grenzgänger nicht in der Schweiz.',
      },
      {
        q: 'Welche italienischen Feiertage gelten im Tessin nicht?',
        a: 'Der Tag der Befreiung (25. April) und der Tag der Republik (2. Juni) sind in Italien Feiertag, im Tessin aber nicht: an diesen Tagen arbeitet der Grenzgänger normal in der Schweiz.',
      },
      {
        q: 'Wird der Grenzgänger an Schweizer Feiertagen bezahlt?',
        a: 'Ja. Anerkannte kantonale Feiertage sind bezahlte arbeitsfreie Tage nach dem Schweizer Vertrag, genau wie für die im Tessin wohnhaften Arbeitnehmer.',
      },
    ],
  },
  fr: {
    breadcrumbHome: 'Accueil',
    breadcrumbHub: 'Guide frontalier',
    breadcrumbHubPath: COMPLETE_WORK_GUIDE_HREF.fr,
    updatedLabel: 'Mis à jour le',
    ctaCalc: 'Calculez votre salaire net →',
    ctaGuide: 'Guide complet du travail frontalier',
    relatedLabel: 'Pour aller plus loin',
    tableHeadDate: 'Date',
    tableHeadHoliday: 'Jour férié',
    tableHeadTicino: 'Tessin',
    tableHeadItaly: 'Italie',
    bridgesTitle: 'Ponts et planification des congés',
    bridgesIntro:
      'Lorsqu’un jour férié tombe un mardi ou un jeudi, poser un seul jour de congé (le lundi ou le vendredi) offre un pont de quatre jours. Voici les meilleurs ponts au Tessin cette année.',
    faqTitle: 'Questions fréquentes',
    nonCoincTitle: 'Les jours fériés qui NE coïncident PAS',
    ticino: {
      title: (y1, y2) => `Jours fériés Tessin ${y1} et ${y2}`,
      description: (y1) =>
        `Calendrier complet des jours fériés officiels du Canton du Tessin ${y1} et ${y1 + 1} : dates, ponts et différences avec l’Italie pour les frontaliers.`,
      eyebrow: 'Calendrier frontalier',
      h1: (y1, y2) => `Jours fériés au Tessin ${y1}–${y2}`,
      lede: (n, y1) =>
        `Le Canton du Tessin observe ${n} jours fériés officiels en ${y1} : voici toutes les dates, les ponts et les jours fériés qui ne coïncident pas avec l’Italie.`,
      calendarTitle: (y) => `Calendrier des jours fériés ${y}`,
      intro:
        'Le Canton du Tessin est le canton suisse qui compte le plus de jours fériés, beaucoup de tradition catholique. Pour un frontalier qui vit en Italie et travaille au Tessin, ces jours comptent comme jours non travaillés en Suisse — mais certains ne correspondent pas aux fêtes italiennes : les jours fériés italiens non reconnus au Tessin sont travaillés normalement, tandis que les jours fériés tessinois non reconnus en Italie sont chômés. Connaître le calendrier à l’avance aide à planifier les congés, les voyages et les passages à la frontière.',
      statFestiviLabel: 'Jours fériés au Tessin',
      statBridgesLabel: 'Ponts utiles',
      statNonCoincLabel: 'Ne coïncident pas avec l’Italie',
    },
    chVsIt: {
      title: (y1) => `Jours fériés : Suisse vs Italie ${y1}`,
      description:
        'Comparaison des jours fériés entre le Tessin/la Suisse et l’Italie : quels jours ne coïncident pas et ce que cela signifie pour le frontalier employé en Suisse.',
      eyebrow: 'Comparaison frontalier',
      h1: 'Jours fériés : Suisse (Tessin) vs Italie',
      lede: (tiOnly, itOnly) =>
        `${tiOnly} jours fériés ne valent qu’au Tessin et ${itOnly} qu’en Italie : voici la comparaison complète pour ceux qui vivent en Italie et travaillent en Suisse.`,
      intro:
        'Ce qui intéresse le frontalier n’est pas la liste mais la comparaison : les jours où le Tessin ferme et où l’Italie travaille, le frontalier reste chez lui ; les jours où l’Italie ferme mais où le Tessin travaille, il doit tout de même se présenter en Suisse. Le tableau ci-dessous indique, pour chaque jour férié, s’il est reconnu au Tessin, en Italie ou dans les deux.',
      tiOnlyHeading: 'Jours fériés uniquement au Tessin (l’Italie travaille)',
      tiOnlyIntro:
        'Ces jours-là, le frontalier NE travaille PAS en Suisse, alors qu’en Italie c’est un jour ouvré normal :',
      itOnlyHeading: 'Jours fériés uniquement en Italie (le Tessin travaille)',
      itOnlyIntro: 'Ces jours-là, l’Italie est fermée mais le frontalier travaille normalement en Suisse :',
      statBothLabel: 'Communs aux deux pays',
      statTiOnlyLabel: 'Tessin seulement',
      statItOnlyLabel: 'Italie seulement',
      worksInCh: 'Le frontalier travaille en Suisse',
      closedLabel: 'Férié',
      openLabel: 'Ouvré',
    },
    faqs: [
      {
        q: 'Quels jours fériés le Tessin a-t-il que l’Italie n’a pas ?',
        a: 'Fériés au Tessin mais pas en Italie : Vendredi Saint, Ascension, Lundi de Pentecôte, Fête-Dieu, Saints Pierre et Paul (29 juin) et la Fête nationale suisse (1er août). Ces jours-là le frontalier ne travaille pas en Suisse.',
      },
      {
        q: 'Quelles fêtes italiennes ne valent pas au Tessin ?',
        a: 'La Fête de la Libération (25 avril) et la Fête de la République (2 juin) sont fériées en Italie mais pas au Tessin : ces jours-là le frontalier travaille normalement en Suisse.',
      },
      {
        q: 'Le frontalier est-il payé les jours fériés suisses ?',
        a: 'Oui. Les jours fériés cantonaux reconnus sont des jours chômés payés selon le contrat suisse, exactement comme pour les travailleurs résidant au Tessin.',
      },
    ],
  },
};

// ── Render ────────────────────────────────────────────────────────────────

interface RenderResult {
  readonly urlPath: string;
  readonly html: string;
  readonly wordCount: number;
}

function checkMark(on: boolean, label: string): string {
  return on
    ? `<span aria-label="${esc(label)}" style="color:var(--color-success,#16a34a);font-weight:700">✓</span>`
    : `<span aria-label="—" style="color:var(--color-body);opacity:.5">—</span>`;
}

function renderPage(opts: {
  locale: HolidayLocale;
  page: HolidayPageId;
  dateStamp: string;
  distDir?: string;
  /**
   * Locales whose page for THIS `page` id the build will actually write. The
   * `MIN_INDEXABLE_WORDS` floor below is evaluated per locale (and per page
   * id), so it can drop DE while keeping IT — and an hreflang block built
   * from the full `HOLIDAY_LOCALES` list would then advertise a page nothing
   * wrote (the #5114 `missingTarget` class). Pass 1 of the caller's two-pass
   * render leaves this at the empty default: it only reads `wordCount`, which
   * is derived from the body and does not depend on the hreflang block.
   */
  eligibleLocales?: ReadonlySet<string>;
}): RenderResult {
  const { locale, page, dateStamp, distDir, eligibleLocales = new Set<string>() } = opts;
  const L = COPY[locale];
  const ds = loadDataset();
  const years = [...ds.meta.years].sort((a, b) => a - b);
  const y1 = years[0];
  const y2 = years[years.length - 1];
  const holidays = ds.holidays;

  const urlPath = buildHolidaysLandingPath(locale, page);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubUrl = `${BASE_URL}${L.breadcrumbHubPath}`;
  const calcUrl = `${BASE_URL}${CALCULATOR_URL[locale]}`;
  const guideUrl = `${BASE_URL}${PERMITS_GUIDE_URL[locale]}`;

  const tiOnly = holidays.filter((h) => h.coincidence === 'ticino-only');
  const itOnly = holidays.filter((h) => h.coincidence === 'italy-only');
  const both = holidays.filter((h) => h.coincidence === 'both');
  const tiCount = holidays.filter((h) => h.ticino).length;
  const bridges = computeBridges(holidays, y1, locale);

  // hreflang (4 locales + x-default IT), emitted only when every locale's
  // page for this `page` id is actually written this build — otherwise
  // nothing, since a partial set only trades audit-hreflang's [missingTarget]
  // for [tooFew] (#5114).
  const alternates = buildLocaleAlternateBlock({
    eligibleLocales,
    hrefFor: (alt) => `${BASE_URL}${buildHolidaysLandingPath(alt as HolidayLocale, page)}`,
    indent: '    ',
  });

  const isTicino = page === 'ticino';
  const title = isTicino ? L.ticino.title(y1, y2) : L.chVsIt.title(y1);
  const description = isTicino ? L.ticino.description(y1) : L.chVsIt.description;
  const eyebrow = isTicino ? L.ticino.eyebrow : L.chVsIt.eyebrow;
  const h1 = isTicino ? L.ticino.h1(y1, y2) : L.chVsIt.h1;
  const lede = isTicino ? L.ticino.lede(tiCount, y1) : L.chVsIt.lede(tiOnly.length, itOnly.length);

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: L.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: L.breadcrumbHub, item: hubUrl },
      { '@type': 'ListItem', position: 3, name: h1, item: canonicalUrl },
    ],
  };

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: L.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  // One description of the hero, used three times: the <img>, `Article.image`
  // and `og:image`. Declared once so the JSON-LD and the OG tag cannot end up
  // naming a different card than the one on the page — they all derive their
  // URL from this single (family, key, locale).
  const hero: SeoHeroImageOpts = { family: 'holidays', key: page, locale, headline: h1, eyebrow, alt: h1 };

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: h1,
    description: guardArticleJsonLdDescription(description),
    image: seoHeroImageObject(hero),
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
      logo: imageObjectLd({ url: `${BASE_URL}/icons/icon-512x512.png`, width: 512, height: 512 }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  };

  // Shared style block for table + FAQ (byte-thrifty, avoids inline dup).
  const styleBlock = `<style>.hd{${TABLE_HEAD_STYLE}}.hc{${TABLE_CELL_STYLE}}.hf{margin:0 0 10px;padding:14px 16px;background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:12px}.hfs{font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45}.hfa{margin:10px 0 0;color:var(--color-body);line-height:1.65}</style>`;

  // Statistics tiles differ per page.
  const statTilesHtml = isTicino
    ? renderStatGrid([
        { label: L.ticino.statFestiviLabel, value: String(tiCount), tone: 'accent' },
        { label: L.ticino.statBridgesLabel, value: String(bridges.length), tone: 'success' },
        { label: L.ticino.statNonCoincLabel, value: String(tiOnly.length + itOnly.length), tone: 'warning' },
      ])
    : renderStatGrid([
        { label: L.chVsIt.statBothLabel, value: String(both.length), tone: 'accent' },
        { label: L.chVsIt.statTiOnlyLabel, value: String(tiOnly.length), tone: 'success' },
        { label: L.chVsIt.statItOnlyLabel, value: String(itOnly.length), tone: 'warning' },
      ]);

  // Calendar table (ticino page): TI holidays for y1 + y2.
  function calendarTable(year: number): string {
    const rows = holidays
      .filter((h) => h.ticino && h.dates[String(year)])
      .sort((a, b) => a.dates[String(year)].localeCompare(b.dates[String(year)]))
      .map((h) => {
        const coincClass =
          h.coincidence === 'ticino-only'
            ? ' style="background:var(--color-surface-alt)"'
            : '';
        return `<tr${coincClass}><td class="hc">${esc(formatDate(h.dates[String(year)], locale))}</td><td class="hc">${esc(h.name[locale])}</td><td class="hc" style="text-align:center">${checkMark(h.ticino, L.tableHeadTicino)}</td><td class="hc" style="text-align:center">${checkMark(h.italy, L.tableHeadItaly)}</td></tr>`;
      })
      .join('');
    return `<div class="s-card" style="overflow-x:auto;padding:0;border-radius:14px"><table style="width:100%;border-collapse:collapse"><caption style="text-align:left;padding:12px 14px;font-weight:700">${esc(L.ticino.calendarTitle(year))}</caption><thead><tr><th class="hd">${esc(L.tableHeadDate)}</th><th class="hd">${esc(L.tableHeadHoliday)}</th><th class="hd" style="text-align:center">${esc(L.tableHeadTicino)}</th><th class="hd" style="text-align:center">${esc(L.tableHeadItaly)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // Comparison table (ch-vs-it page): all holidays y1 with TI/IT flags.
  function comparisonTable(): string {
    const rows = holidays
      .filter((h) => h.dates[String(y1)])
      .sort((a, b) => a.dates[String(y1)].localeCompare(b.dates[String(y1)]))
      .map((h) => {
        const rowStyle =
          h.coincidence !== 'both' ? ' style="background:var(--color-surface-alt)"' : '';
        return `<tr${rowStyle}><td class="hc">${esc(formatDate(h.dates[String(y1)], locale))}</td><td class="hc">${esc(h.name[locale])}</td><td class="hc" style="text-align:center">${checkMark(h.ticino, L.tableHeadTicino)}</td><td class="hc" style="text-align:center">${checkMark(h.italy, L.tableHeadItaly)}</td></tr>`;
      })
      .join('');
    return `<div class="s-card" style="overflow-x:auto;padding:0;border-radius:14px"><table style="width:100%;border-collapse:collapse"><thead><tr><th class="hd">${esc(L.tableHeadDate)}</th><th class="hd">${esc(L.tableHeadHoliday)}</th><th class="hd" style="text-align:center">${esc(L.tableHeadTicino)}</th><th class="hd" style="text-align:center">${esc(L.tableHeadItaly)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function nonCoincList(items: readonly HolidayRecord[]): string {
    return `<ul style="margin:8px 0 0;padding-left:20px;line-height:1.7">${items
      .map((h) => `<li><strong>${esc(h.name[locale])}</strong> — ${esc(formatDate(h.dates[String(y1)], locale))}</li>`)
      .join('')}</ul>`;
  }

  function bridgesBlock(): string {
    if (bridges.length === 0) return '';
    const items = bridges
      .map(
        (b) =>
          `<li><strong>${esc(b.holiday)}</strong> (${esc(b.holidayDate)}) → ${esc(formatDate(b.bridgeDay, locale))}</li>`,
      )
      .join('');
    return `<section class="s-KZc0LQ"><h2 style="${H2_STYLE}">${esc(L.bridgesTitle)}</h2><p style="${BODY_STYLE};max-width:780px">${esc(L.bridgesIntro)}</p><ul style="margin:8px 0 0;padding-left:20px;line-height:1.7">${items}</ul></section>`;
  }

  const faqHtml = L.faqs
    .map((f) => `<details class="hf"><summary class="hfs">${esc(f.q)}</summary><p class="hfa">${esc(f.a)}</p></details>`)
    .join('');

  // Related links — cross-link the sibling page + calculator + guide.
  const siblingPage: HolidayPageId = isTicino ? 'ch-vs-it' : 'ticino';
  const siblingUrl = `${BASE_URL}${buildHolidaysLandingPath(locale, siblingPage)}`;
  const siblingLabel = isTicino ? L.chVsIt.h1 : L.ticino.h1(y1, y2);
  const relatedHtml = [
    { href: siblingUrl, label: siblingLabel },
    { href: guideUrl, label: L.ctaGuide },
    { href: calcUrl, label: L.ctaCalc.replace(' →', '') },
  ]
    .map((r) => `<li style="margin:4px 0"><a href="${esc(r.href)}" style="${LINK_ACCENT_STYLE}">${esc(r.label)}</a></li>`)
    .join('');

  const body = `
    ${styleBlock}
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">${esc(L.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(hubUrl)}" class="s-bcl">${esc(L.breadcrumbHub)}</a>
      <span> / </span>
      <span>${esc(h1)}</span>
    </nav>
    <header>
      <p style="${HERO_EYEBROW_STYLE}">${esc(eyebrow)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(lede)}</p>
    </header>
    ${renderSeoHeroImage(hero)}
    <p class="text-sm font-medium text-accent mt-1">${esc(L.updatedLabel)} ${esc(formatUpdatedDate(dateStamp, locale))}</p>
    ${statTilesHtml}
    <div class="s-KZc0LQ"><a href="${esc(calcUrl)}" class="s-cta">${esc(L.ctaCalc)}</a></div>
    <section class="s-KZc0LQ">
      <p style="${BODY_STYLE};max-width:820px">${esc(isTicino ? L.ticino.intro : L.chVsIt.intro)}</p>
    </section>
    ${
      isTicino
        ? `<section class="s-KZc0LQ">${calendarTable(y1)}</section>
           <section class="s-KZc0LQ">${calendarTable(y2)}</section>
           ${bridgesBlock()}
           <section class="s-KZc0LQ">
             <h2 style="${H2_STYLE}">${esc(L.nonCoincTitle)}</h2>
             <h3 style="${H3_STYLE}">${esc(L.chVsIt.tiOnlyHeading)}</h3>
             <p style="${BODY_STYLE};max-width:780px">${esc(L.chVsIt.tiOnlyIntro)}</p>
             ${nonCoincList(tiOnly)}
             <h3 style="${H3_STYLE}">${esc(L.chVsIt.itOnlyHeading)}</h3>
             <p style="${BODY_STYLE};max-width:780px">${esc(L.chVsIt.itOnlyIntro)}</p>
             ${nonCoincList(itOnly)}
           </section>`
        : `<section class="s-KZc0LQ">${comparisonTable()}</section>
           <section class="s-KZc0LQ">
             <h2 style="${H2_STYLE}">${esc(L.chVsIt.tiOnlyHeading)}</h2>
             <p style="${BODY_STYLE};max-width:780px">${esc(L.chVsIt.tiOnlyIntro)}</p>
             ${nonCoincList(tiOnly)}
             <h3 style="${H3_STYLE}">${esc(L.chVsIt.itOnlyHeading)}</h3>
             <p style="${BODY_STYLE};max-width:780px">${esc(L.chVsIt.itOnlyIntro)}</p>
             ${nonCoincList(itOnly)}
           </section>
           ${bridgesBlock()}`
    }
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(L.faqTitle)}</h2>
      ${faqHtml}
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(L.relatedLabel)}</h2>
      <ul style="list-style:none;padding:0;margin:0">${relatedHtml}</ul>
    </section>`;

  const bodyHtml = `<main class="s-xzWvwM">${body}</main>`;
  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    // Without this the page shared the site-wide /og-image.png with every
    // other page on the site. The card carries this page's own headline.
    ogImage: seoHeroImageUrl(hero),
    ogImageWidth: SEO_HERO_WIDTH,
    ogImageHeight: SEO_HERO_HEIGHT,
    ogImageType: 'image/webp',
    ogImageAlt: h1,
    hreflangHtml: alternates,
    jsonLdScripts: [
      JSON.stringify(breadcrumbLd),
      JSON.stringify(articleLd),
      JSON.stringify(faqLd),
    ],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ───────────────────────────────────────────────────────────────

function buildSitemapXml(
  entries: ReadonlyArray<{ canonical: string; alternates: readonly string[] }>,
  today: string,
): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map((a) => {
          const [lang, ...rest] = a.split('|');
          return `    <xhtml:link rel="alternate" hreflang="${lang}" href="${rest.join('|')}" />`;
        })
        .join('\n');
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-holidays.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-holidays.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-holidays\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[holidays] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ────────────────────────────────────────────────────────────

export function holidaysLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'holidays-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_HOLIDAYS === '1') {
        console.log('\x1b[33m[holidays]\x1b[0m Skipped (SKIP_HOLIDAYS=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'holidaysLandingsPlugin' });
      const sitemapEntries: Array<{ canonical: string; alternates: readonly string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const pageId of HOLIDAY_PAGE_IDS) {
        // ── Pass 1: which locales clear the indexability floor? ────────────
        // The floor is per-locale AND per page id, so it can drop DE while
        // keeping IT for the same page. Settling the set BEFORE any page is
        // rendered for real is what makes it impossible to advertise a
        // landing that never gets written (#5114 class). `wordCount` derives
        // from the body alone, so this pass is unaffected by the empty
        // hreflang block it renders with.
        const eligibleLocales = new Set<string>(
          HOLIDAY_LOCALES.filter(
            (locale) =>
              renderPage({ locale, page: pageId, dateStamp, distDir }).wordCount >=
              MIN_INDEXABLE_WORDS,
          ),
        );

        // Sitemap alternates track the same set: an ineligible locale has no
        // page, so advertising it would point the crawler at a 404.
        const altLinks = HOLIDAY_LOCALES.filter((alt) => eligibleLocales.has(alt)).map(
          (alt) => `${alt}|${BASE_URL}${buildHolidaysLandingPath(alt, pageId)}`,
        );
        if (eligibleLocales.has('it')) {
          altLinks.push(`x-default|${BASE_URL}${buildHolidaysLandingPath('it', pageId)}`);
        }

        // ── Pass 2: render for real, with the settled alternate set ────────
        let itWasWritten = false;
        for (const locale of HOLIDAY_LOCALES) {
          const rendered = renderPage({ locale, page: pageId, dateStamp, distDir, eligibleLocales });
          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            thinSkipped++;
            console.warn(
              `\x1b[33m[holidays]\x1b[0m ${locale}/${pageId} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
            );
            continue;
          }
          const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, rendered.html);
          collector.add(flatPath, rendered.html);

          if (locale === 'it') {
            itWasWritten = true;
            sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
          } else if (itWasWritten) {
            sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
          }
          pagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          fs.writeFileSync(
            np.join(distDir, 'sitemap-holidays.xml'),
            buildSitemapXml(sitemapEntries, dateStamp),
            'utf-8',
          );
        } catch (err) {
          console.warn('\x1b[33m[holidays]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[holidays]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} thin-skipped) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      if (fs.existsSync(np.join(distDir, 'sitemap-holidays.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
    },
  };
}

// Test-only export.
export { renderPage as __renderHolidayPageForTest, computeBridges as __computeBridgesForTest };
