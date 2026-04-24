/**
 * Vite build plugin — emits static HTML for border-wait pages (F8).
 *
 * Reads a pre-snapshotted JSON state written by `scripts/snapshot-border-wait-
 * history.mjs` (cron, daily 23:30 CET) so the plugin stays deterministic and
 * doesn't hit Firestore at build time. If the snapshot files are missing, the
 * plugin degrades gracefully and emits pages with the static `avgWait*` fallback
 * from data/borderCrossings.ts plus a banner explaining that live data is
 * temporarily unavailable.
 *
 * Page set (per build):
 *   - /traffico-dogane/                                        root hub × 4 locales = 4
 *   - /traffico-dogane/{region}/                               regional hubs × 4    = 8
 *   - /traffico-dogane/{crossing}/oggi/                        24 × 4               = 96
 *   - /traffico-dogane/{crossing}/{YYYY-MM}/ (top-5 past months)                    = 0 initially,
 *                                                                                     grows progressively
 *
 * Each leaf page (≥400 words, hard-gated):
 *   - Breadcrumb
 *   - H1 + meta
 *   - Live webcam (<figure>/<img loading="lazy" data-webcam-refresh>) when
 *     data/borderCrossings.ts has a `webcams` entry for the crossing — always
 *     with attribution + rel="nofollow noopener" on the source link
 *   - Current status card with source badge (BAZG / TomTom / Google / static)
 *   - Hourly SVG chart (today's pattern)
 *   - Editorial best/worst hours paragraph auto-derived from the history
 *   - 30-day weekly-pattern SVG
 *   - Static crossing info (type, open24h, hours)
 *   - Related-links block (shared helper, includes fuel-daily + weekly-
 *     employers backlinks bidirectionally)
 *   - FAQ (3-5 Q&A with JSON-LD FAQPage)
 *   - JSON-LD: WebPage + Place (geo) + FAQPage + ImageObject when webcam present
 *
 * Env gate: `SKIP_BORDER_WAIT=1` to skip the plugin entirely (fast local builds).
 */

import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';
import {
  BASE_URL,
  MIN_INDEXABLE_WORDS,
  countHtmlBodyWords,
} from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';
import { WriteCollector } from './batchWrite';
import {
  BORDER_WAIT_CROSSINGS,
  BORDER_WAIT_LOCALES,
  BORDER_WAIT_REGIONS,
  BORDER_CROSSING_DISPLAY,
  BORDER_REGION_DISPLAY,
  BORDER_WAIT_SECTION,
  BORDER_WAIT_LOCALE_PREFIX,
  BORDER_WAIT_TODAY_SLUG,
  CROSSING_TO_REGION,
  CROSSING_TO_FUEL_ZONE,
  CROSSING_TO_WEEKLY_CITY,
  TOP_5_CROSSINGS,
  buildArchivePath,
  buildOggiPath,
  buildRegionalHubPath,
  buildRootHubPath,
  type BorderCrossingRegion,
  type BorderCrossingSlug,
  type BorderWaitLocale,
} from './borderWaitData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { borderCrossings, type BorderCrossing, type WebcamRef } from '../data/borderCrossings';
import { cleanNamespaces, cleanSitemapFiles } from './shared/distNamespaceCleanup';
import {
  FUEL_LOCALE_PREFIX,
  FUEL_SECTION_SLUG,
  FUEL_TODAY_SLUG,
} from './fuelDailyData';
import {
  JOB_MARKET_LOCALE_PREFIX,
  JOB_MARKET_SECTION_SLUG,
} from './jobMarketSnapshotData';
import {
  WEEKLY_EMPLOYERS_CURRENT_SLUG,
  WEEKLY_EMPLOYERS_LOCALE_PREFIX,
  WEEKLY_EMPLOYERS_SECTION,
} from './weeklyEmployersData';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CARD_STYLE,
  H1_STYLE,
  H2_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_CELL_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_STYLE,
  renderDiscoverMore,
} from './shared/seoContentTokens';

// ── Feature-specific "Scopri di più" CTAs ─────────────────────
// Three contextually relevant links per locale for the F8 border-wait feature.
//
// URLs are built from the canonical slug constants exported by each target
// feature's data module (fuelDailyData, jobMarketSnapshotData,
// weeklyEmployersData) so that drift between producer and consumer slugs is
// structurally impossible — change a slug in the data module and every link
// updates automatically.

type DiscoverMoreCta = { title: string; href: string };

function buildDiscoverMoreCtas(locale: BorderWaitLocale): ReadonlyArray<DiscoverMoreCta> {
  const dieselHref =
    `${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale].diesel}/${FUEL_TODAY_SLUG[locale]}/`.replace(
      /\/{2,}/g,
      '/',
    );
  const jobMarketHref =
    `${JOB_MARKET_LOCALE_PREFIX[locale]}/${JOB_MARKET_SECTION_SLUG[locale]}/`.replace(
      /\/{2,}/g,
      '/',
    );
  const hiringHref =
    `${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/ticino/${WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]}/`.replace(
      /\/{2,}/g,
      '/',
    );

  const titles: Record<BorderWaitLocale, { diesel: string; jobMarket: string; hiring: string }> = {
    it: {
      diesel: 'Prezzi diesel oggi',
      jobMarket: 'Mercato del lavoro Ticino',
      hiring: 'Aziende che assumono',
    },
    en: {
      diesel: 'Diesel prices today',
      jobMarket: 'Ticino job market',
      hiring: 'Companies hiring',
    },
    de: {
      diesel: 'Dieselpreise heute',
      jobMarket: 'Arbeitsmarkt Tessin',
      hiring: 'Einstellende Unternehmen',
    },
    fr: {
      diesel: "Prix du diesel aujourd'hui",
      jobMarket: 'Marché du travail Tessin',
      hiring: 'Entreprises qui recrutent',
    },
  };

  const t = titles[locale];
  return [
    { title: t.diesel, href: dieselHref },
    { title: t.jobMarket, href: jobMarketHref },
    { title: t.hiring, href: hiringHref },
  ];
}

const BORDER_WAIT_DISCOVER_MORE_CTAS: Record<BorderWaitLocale, ReadonlyArray<DiscoverMoreCta>> = {
  it: buildDiscoverMoreCtas('it'),
  en: buildDiscoverMoreCtas('en'),
  de: buildDiscoverMoreCtas('de'),
  fr: buildDiscoverMoreCtas('fr'),
};

// ── Types ──────────────────────────────────────────────────────

/** Source categories for a wait-time reading. */
export type WaitSource = 'bazg' | 'tomtom' | 'google' | 'google-maps' | 'static';

/** Shape of the "current snapshot" JSON written by scripts/snapshot-border-wait-history.mjs. */
export interface BorderWaitCurrent {
  updatedAt: string | null;
  perCrossing: Partial<
    Record<
      BorderCrossingSlug,
      {
        waitTimeMinutes: number;
        approachMinutes?: number;
        totalCrossingMinutes?: number;
        status?: 'green' | 'yellow' | 'red';
        source: WaitSource;
        lastUpdate: string;
      }
    >
  >;
}

/** Shape of daily history file: per-crossing hour-bucketed aggregates. */
export interface BorderWaitHistoryDay {
  date: string; // YYYY-MM-DD
  perCrossing: Partial<
    Record<
      BorderCrossingSlug,
      Array<null | { min: number; avg: number; max: number; samples: number }>
    >
  >;
}

// ── Helpers ────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Hero card helpers (exported for tests) ───────────────────────
// The hub page renders a "Valico più veloce" hero when at least one
// crossing has a measurable non-zero wait. When every scope crossing
// reports 0 min (degenerate case — either unmeasured or perfectly
// fluid), the hero collapses to empty string and `renderTrafficFluidBanner`
// takes its place to avoid visual dead space.

export interface FastestCrossingInput {
  slug: string;
  labelIt: string;
  labelEn?: string;
  labelDe?: string;
  labelFr?: string;
  waitTimeMinutes: number;
}

function getCrossingLabel(
  cr: FastestCrossingInput,
  locale: 'it' | 'en' | 'de' | 'fr',
): string {
  if (locale === 'en' && cr.labelEn) return cr.labelEn;
  if (locale === 'de' && cr.labelDe) return cr.labelDe;
  if (locale === 'fr' && cr.labelFr) return cr.labelFr;
  return cr.labelIt;
}

function getCrossingHref(
  slug: string,
  locale: 'it' | 'en' | 'de' | 'fr',
): string {
  // `buildOggiPath` is a pure path interpolator — it does not validate the
  // slug against the registry, so synthetic test slugs still produce a
  // well-formed path.
  return `${BASE_URL}${buildOggiPath(locale, slug as BorderCrossingSlug)}`;
}

export function renderFastestCrossingCard(
  crossings: ReadonlyArray<FastestCrossingInput>,
  locale: 'it' | 'en' | 'de' | 'fr',
): string {
  const hasAnyWait = crossings.some((c) => c.waitTimeMinutes > 0);
  if (!hasAnyWait) return '';

  let best: FastestCrossingInput | null = null;
  for (const c of crossings) {
    if (c.waitTimeMinutes <= 0) continue;
    if (best === null || c.waitTimeMinutes < best.waitTimeMinutes) {
      best = c;
    }
  }
  if (best === null) return '';

  const label =
    locale === 'it'
      ? 'Valico più veloce adesso'
      : locale === 'de'
        ? 'Schnellster Übergang jetzt'
        : locale === 'fr'
          ? 'Passage le plus rapide maintenant'
          : 'Fastest crossing right now';

  return `<div style="margin:0 0 20px;padding:14px 18px;border-radius:12px;background:var(--color-success-subtle);border:1px solid var(--color-success-border);border-left:4px solid var(--color-success-strong);color:var(--color-text);font-size:15px;line-height:1.5">
       <strong>${esc(label)}:</strong>
       <a href="${getCrossingHref(best.slug, locale)}" style="color:var(--color-success-strong);text-decoration:underline;font-weight:700">${esc(getCrossingLabel(best, locale))}</a>
       · <span style="color:var(--color-success-strong);font-weight:600;">${best.waitTimeMinutes} min</span>
     </div>`;
}

export function renderTrafficFluidBanner(
  allZeros: boolean,
  locale: 'it' | 'en' | 'de' | 'fr',
): string {
  if (!allZeros) return '';
  const copy = {
    it: {
      title: 'Traffico fluido su tutti i valichi',
      body: 'Nessuna coda significativa rilevata in questo momento. I tempi si aggiornano ogni 15 minuti.',
    },
    en: {
      title: 'Traffic flowing at every crossing',
      body: 'No significant queues right now. Wait times refresh every 15 minutes.',
    },
    de: {
      title: 'Flüssiger Verkehr an allen Übergängen',
      body: 'Derzeit keine nennenswerten Staus. Wartezeiten werden alle 15 Minuten aktualisiert.',
    },
    fr: {
      title: 'Circulation fluide à tous les passages',
      body: "Aucune file d'attente significative actuellement. Mise à jour toutes les 15 minutes.",
    },
  }[locale];
  return `<div style="margin:0 0 20px;padding:16px 20px;border-radius:12px;background:var(--color-success-subtle);border:1px solid var(--color-success-border);border-left:4px solid var(--color-success-strong);">
       <p style="margin:0 0 4px;font-weight:600;color:var(--color-text);">${esc(copy.title)}</p>
       <p style="margin:0;color:var(--color-text);font-size:14px;">${esc(copy.body)}</p>
     </div>`;
}

/** Look up crossing static metadata from the registry (matches on slug). */
function crossingRegistry(slug: BorderCrossingSlug): BorderCrossing | undefined {
  return borderCrossings.find(
    (c) => slugifyName(c.name) === slug,
  );
}

/**
 * Mirror of functions/src/borderCrossingsData.js#slugifyCrossingName.
 * Must stay in sync with that implementation — the Firestore document IDs
 * depend on it.
 * - Strips parentheses + their content (so "Gaggiolo (Cantello-Stabio)" → "gaggiolo")
 * - Removes combining diacritics
 * - Collapses non-alphanumerics into dashes
 */
function slugifyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// Color tokens — CSS custom properties so dark mode works automatically.
const COLOR_OK_BG = 'var(--color-success-subtle)';
const COLOR_OK_BORDER = 'var(--color-success-border)';
const COLOR_OK_TEXT = 'var(--color-success-border)';
const COLOR_WARN_BG = 'var(--color-warning-subtle)';
const COLOR_WARN_BORDER = 'var(--color-warning-border)';
const COLOR_WARN_TEXT = 'var(--color-warning-border)';
const COLOR_BAD_BG = 'var(--color-danger-subtle)';
const COLOR_BAD_BORDER = 'var(--color-danger-border)';
const COLOR_BAD_TEXT = 'var(--color-danger-border)';

function statusColor(waitMinutes: number | null): {
  bg: string;
  border: string;
  text: string;
  label: 'ok' | 'warn' | 'bad';
} {
  if (waitMinutes === null || waitMinutes < 5) {
    return { bg: COLOR_OK_BG, border: COLOR_OK_BORDER, text: COLOR_OK_TEXT, label: 'ok' };
  }
  if (waitMinutes < 15) {
    return { bg: COLOR_WARN_BG, border: COLOR_WARN_BORDER, text: COLOR_WARN_TEXT, label: 'warn' };
  }
  return { bg: COLOR_BAD_BG, border: COLOR_BAD_BORDER, text: COLOR_BAD_TEXT, label: 'bad' };
}

// ── Localised copy ─────────────────────────────────────────────

interface Copy {
  leafH1: (crossing: string, date: string) => string;
  rootH1: string;
  regionalH1: (region: string) => string;
  intro: (crossing: string, status: string, wait: string, date: string) => string;
  paragraph: (crossing: string, direction: string, bestHour: string, worstHour: string) => string;
  updatedLabel: string;
  currentStatusLabel: string;
  waitMinutesLabel: string;
  approachLabel: string;
  totalLabel: string;
  sourceLabel: string;
  sourceBazg: string;
  sourceTomtom: string;
  sourceGoogle: string;
  sourceStatic: string;
  hourlyTodayLabel: string;
  weeklyPatternLabel: string;
  bestHoursLabel: string;
  worstHoursLabel: string;
  infoValicoLabel: string;
  webcamLabel: string;
  webcamNote: string;
  webcamSource: string;
  webcamUnavailable: string;
  faqTitle: string;
  breadcrumbHome: string;
  regionalLabelTicinoComo: string;
  regionalLabelTicinoVarese: string;
  noHistory: string;
  staticFallbackBanner: string;
  crossingTypeLabel: Record<'autostrada' | 'statale' | 'locale', string>;
  open24h: string;
  hoursLabel: string;
  historicalAvg: string;
  faq: Array<{ q: (crossing: string) => string; a: (crossing: string) => string }>;
  rootIntro: string;
  regionalIntro: (region: string, count: number) => string;
}

const COPY: Record<BorderWaitLocale, Copy> = {
  it: {
    leafH1: (c, d) => `Tempi attesa alla dogana ${c} — oggi ${d}`,
    rootH1: 'Tempi di attesa alle dogane Ticino–Italia — live oggi',
    regionalH1: (r) => `Tempi attesa ai valichi ${r}`,
    intro: (c, s, w, d) =>
      `Aggiornamento del ${d}: il valico di ${c} presenta un'attesa ${s} di circa ${w}. Dati aggiornati ogni 15 minuti nelle ore di punta (06:00–10:00 e 16:00–20:00 CET) dalla nostra pipeline di monitoraggio.`,
    paragraph: (c, direction, bestHour, worstHour) =>
      `Pianifica il passaggio da ${c} consultando prima il dato corrente ed eventualmente la webcam live quando disponibile. Negli ultimi 30 giorni l'ora migliore per transitare (direzione ${direction}) è stata ${bestHour}, mentre l'ora peggiore è ${worstHour}. Questa pagina viene rigenerata automaticamente ad ogni deploy — i dati live provengono dalla collezione Firestore alimentata dal cron di traffico TomTom, gli stessi numeri usati nella mappa interattiva del sito. Se stai tornando in Italia dopo il lavoro, ricorda che il flusso serale inverte la direzione: tra le 17 e le 19 i valichi di Brogeda e Gaggiolo registrano tipicamente code nel senso opposto rispetto al mattino.`,
    updatedLabel: 'Aggiornamento',
    currentStatusLabel: 'Stato attuale',
    waitMinutesLabel: 'Minuti di attesa',
    approachLabel: 'Avvicinamento',
    totalLabel: 'Totale',
    sourceLabel: 'Fonte',
    sourceBazg: 'Dato ufficiale Dogana Svizzera',
    sourceTomtom: 'Stima TomTom (flusso veicolare)',
    sourceGoogle: 'Stima Google Maps',
    sourceStatic: 'Dati statistici — tempo reale non disponibile',
    hourlyTodayLabel: 'Andamento orario di oggi',
    weeklyPatternLabel: 'Pattern settimanale (ultimi 30 giorni)',
    bestHoursLabel: 'Orari migliori',
    worstHoursLabel: 'Orari peggiori',
    infoValicoLabel: 'Informazioni valico',
    webcamLabel: 'Webcam live',
    webcamNote:
      "Immagini aggiornate automaticamente ogni minuto quando la pagina è aperta. Usa il link \"Fonte\" per la versione ufficiale live.",
    webcamSource: 'Fonte',
    webcamUnavailable: 'Webcam non disponibile per questo valico. Il Dipartimento del territorio del Canton Ticino non pubblica immagini live per questa frontiera.',
    faqTitle: 'Domande frequenti',
    breadcrumbHome: 'Home',
    regionalLabelTicinoComo: 'Ticino–Como',
    regionalLabelTicinoVarese: 'Ticino–Varese',
    noHistory:
      'Storico in accumulo: gli archivi mensili e i pattern di 30 giorni appariranno non appena ci saranno dati sufficienti.',
    staticFallbackBanner:
      'Dati statistici — il monitoraggio real-time per questo valico non è disponibile. I valori mostrati sono medie storiche basate su rilevazioni passate.',
    crossingTypeLabel: { autostrada: 'Autostrada', statale: 'Strada statale', locale: 'Strada locale' },
    open24h: 'Aperto 24h',
    hoursLabel: 'Orari',
    historicalAvg: 'Media storica',
    faq: [
      {
        q: (c) => `A che ora passa meno coda a ${c}?`,
        a: (c) =>
          `In media a ${c} le code più brevi si registrano a metà mattina (10:00–12:00) e a metà pomeriggio (14:00–16:00). Fuori dalle fasce di punta pendolare (06:30–08:30 e 17:00–19:00), l'attesa scende spesso sotto i 5 minuti.`,
      },
      {
        q: () => "Come vengono calcolati i minuti di attesa?",
        a: () =>
          "I tempi di attesa derivano da due misure routing: il segmento di avvicinamento (≈500 m prima del valico lato italiano) e il segmento di passaggio (valico → checkpoint svizzero). Il tempo aggiuntivo rispetto alla percorrenza senza traffico è la coda. I dati vengono raccolti ogni 15 minuti nelle ore di punta e salvati in Firestore.",
      },
      {
        q: () => 'Cosa fare se la coda supera i 40 minuti?',
        a: () =>
          "Se il valico principale è congestionato, valuta un valico locale alternativo nella stessa zona (Maslianico-Pizzamiglio al posto di Chiasso Centro, Crociale dei Mulini al posto di Brogeda, Clivio-Ligornetto al posto di Gaggiolo). I valichi locali hanno capacità minore ma spesso restano fluidi quando quelli principali saturano.",
      },
      {
        q: () => 'Le webcam funzionano anche di notte?',
        a: () =>
          "Le webcam del Dipartimento del territorio del Canton Ticino sono attive 24/7 ma la visibilità notturna dipende dall'illuminazione del valico. Brogeda ha illuminazione costante, i valichi locali potrebbero risultare scuri nelle ore notturne.",
      },
    ],
    rootIntro:
      'Panoramica completa dei 24 valichi Ticino–Italia monitorati in tempo reale dalla nostra pipeline. Scegliere il valico giusto può farti risparmiare 20–30 minuti per ogni viaggio. Nei giorni feriali Chiasso-Brogeda e Gaggiolo sono i più congestionati durante i picchi pendolari 06:30–08:30 (direzione IT→CH) e 17:00–19:00 (direzione CH→IT). I valichi minori come Crociale dei Mulini, Drezzo-Pedrinate o Clivio-Ligornetto hanno capacità inferiore ma code quasi sempre inferiori ai 5 minuti — ideali per chi vuole evitare la coda autostradale.',
    regionalIntro: (r, count) =>
      `La regione ${r} raggruppa ${count} valichi di frontiera Ticino–Italia. Questo hub mostra lo stato live di ciascun passaggio e consiglia quello con attesa minore in questo momento. Ricorda che gli orari di punta pendolare concentrano i volumi sui valichi autostradali principali (Chiasso-Brogeda in zona Como, Gaggiolo in zona Varese), mentre i valichi locali restano fluidi anche nelle ore di traffico intenso.`,
  },
  en: {
    leafH1: (c, d) => `${c} border wait times — today ${d}`,
    rootH1: 'Ticino–Italy border wait times — live today',
    regionalH1: (r) => `${r} border crossings — live wait times`,
    intro: (c, s, w, d) =>
      `Updated ${d}: the ${c} crossing currently shows a ${s} wait of approximately ${w}. Data refreshes every 15 minutes during commuter peak hours (06:00–10:00 and 16:00–20:00 CET) from our monitoring pipeline.`,
    paragraph: (c, direction, bestHour, worstHour) =>
      `Plan your ${c} crossing by checking the current reading and, when available, the live webcam feed. Over the last 30 days the best hour to transit (${direction} direction) has been ${bestHour}; the worst hour is ${worstHour}. This page is regenerated on every deploy — live data comes from the Firestore collection fed by the TomTom traffic cron, the same numbers used across the site's interactive map. If you are returning to Italy after work, remember that the evening flow reverses direction: between 17:00 and 19:00 the main commercial crossings typically show queues in the opposite direction compared to the morning.`,
    updatedLabel: 'Updated',
    currentStatusLabel: 'Current status',
    waitMinutesLabel: 'Wait minutes',
    approachLabel: 'Approach delay',
    totalLabel: 'Total',
    sourceLabel: 'Source',
    sourceBazg: 'Authoritative: Swiss Customs',
    sourceTomtom: 'TomTom estimate (traffic flow)',
    sourceGoogle: 'Google Maps estimate',
    sourceStatic: 'Historical averages — live data unavailable',
    hourlyTodayLabel: "Today's hourly trend",
    weeklyPatternLabel: 'Weekly pattern (last 30 days)',
    bestHoursLabel: 'Best hours',
    worstHoursLabel: 'Worst hours',
    infoValicoLabel: 'Crossing info',
    webcamLabel: 'Live webcam',
    webcamNote:
      'Images refresh automatically every minute while the page is open. Use the "Source" link for the official live feed.',
    webcamSource: 'Source',
    webcamUnavailable: 'No webcam available for this crossing. The Canton of Ticino Territory Department does not publish live images for this border.',
    faqTitle: 'Frequently asked questions',
    breadcrumbHome: 'Home',
    regionalLabelTicinoComo: 'Ticino–Como',
    regionalLabelTicinoVarese: 'Ticino–Varese',
    noHistory:
      'History is being collected: monthly archives and 30-day weekly patterns will appear as soon as enough data is available.',
    staticFallbackBanner:
      'Historical averages — real-time monitoring for this crossing is unavailable. Values shown are averages based on past observations.',
    crossingTypeLabel: { autostrada: 'Motorway', statale: 'Main road', locale: 'Local road' },
    open24h: 'Open 24/7',
    hoursLabel: 'Hours',
    historicalAvg: 'Historical average',
    faq: [
      {
        q: (c) => `When is ${c} least congested?`,
        a: (c) =>
          `On average the ${c} crossing shows the shortest queues mid-morning (10:00–12:00) and mid-afternoon (14:00–16:00). Outside the commuter peaks (06:30–08:30 and 17:00–19:00), wait times often drop below 5 minutes.`,
      },
      {
        q: () => 'How are wait minutes calculated?',
        a: () =>
          'Wait times are derived from two routing measurements: an approach segment (~500 m before the crossing on the Italian side) and the crossing segment (crossing → Swiss checkpoint). The excess time over the traffic-free baseline is the queue. Data is collected every 15 minutes during peak hours and persisted to Firestore.',
      },
      {
        q: () => 'What should I do if the queue exceeds 40 minutes?',
        a: () =>
          "If the main crossing is congested, consider a nearby local crossing: Maslianico-Pizzamiglio instead of Chiasso Centro, Crociale dei Mulini instead of Brogeda, Clivio-Ligornetto instead of Gaggiolo. Local crossings have lower capacity but often remain fluid when the main ones saturate.",
      },
      {
        q: () => 'Do the webcams work at night?',
        a: () =>
          'The Canton of Ticino Territory Department webcams are active 24/7, but night-time visibility depends on how the crossing is lit. Brogeda has constant lighting; smaller local crossings may appear dark during night hours.',
      },
    ],
    rootIntro:
      'Complete overview of the 24 Ticino–Italy border crossings monitored in real time by our pipeline. Picking the right crossing can save you 20–30 minutes per trip. On weekdays Chiasso-Brogeda and Gaggiolo are the most congested during the commuter peaks 06:30–08:30 (IT→CH direction) and 17:00–19:00 (CH→IT direction). Smaller crossings like Crociale dei Mulini, Drezzo-Pedrinate or Clivio-Ligornetto have lower capacity but queues almost always under 5 minutes — ideal if you want to avoid the motorway backlog.',
    regionalIntro: (r, count) =>
      `The ${r} region groups ${count} Ticino–Italy border crossings. This hub shows the live status of each and recommends the one with the shortest wait right now. Keep in mind that commuter peaks concentrate traffic on the main motorway crossings (Chiasso-Brogeda in the Como area, Gaggiolo in the Varese area), while local crossings stay fluid even during heavy commute hours.`,
  },
  de: {
    leafH1: (c, d) => `Wartezeiten am Grenzübergang ${c} — heute ${d}`,
    rootH1: 'Wartezeiten an den Tessiner Grenzen zu Italien — live heute',
    regionalH1: (r) => `Grenzübergänge ${r} — Wartezeiten live`,
    intro: (c, s, w, d) =>
      `Aktualisiert am ${d}: Der Grenzübergang ${c} zeigt derzeit eine ${s} Wartezeit von rund ${w}. Daten werden während der Pendler-Stosszeiten (06:00–10:00 und 16:00–20:00 MEZ) alle 15 Minuten aktualisiert.`,
    paragraph: (c, direction, bestHour, worstHour) =>
      `Planen Sie die Überquerung bei ${c}, indem Sie zuerst den aktuellen Messwert und — falls verfügbar — die Live-Webcam prüfen. In den letzten 30 Tagen war die beste Transitzeit (Richtung ${direction}) ${bestHour}, die schlechteste ${worstHour}. Diese Seite wird bei jedem Deploy neu generiert — Live-Daten stammen aus der Firestore-Kollektion, die der TomTom-Verkehrs-Cronjob füllt, dieselben Werte wie auf der interaktiven Karte der Seite. Wer abends nach Italien zurückkehrt, sollte beachten, dass der Verkehr die Richtung wechselt: Zwischen 17:00 und 19:00 Uhr weisen die Hauptübergänge Brogeda und Gaggiolo typischerweise Rückstaus in Gegenrichtung zum Morgen auf.`,
    updatedLabel: 'Aktualisiert',
    currentStatusLabel: 'Aktueller Stand',
    waitMinutesLabel: 'Wartezeit (Min.)',
    approachLabel: 'Annäherungszeit',
    totalLabel: 'Gesamt',
    sourceLabel: 'Quelle',
    sourceBazg: 'Offizielle Daten Schweizer Zoll',
    sourceTomtom: 'TomTom-Schätzung (Verkehrsfluss)',
    sourceGoogle: 'Google-Maps-Schätzung',
    sourceStatic: 'Historischer Durchschnitt — keine Live-Daten',
    hourlyTodayLabel: 'Stundentrend heute',
    weeklyPatternLabel: 'Wochenmuster (letzte 30 Tage)',
    bestHoursLabel: 'Beste Uhrzeiten',
    worstHoursLabel: 'Schlechteste Uhrzeiten',
    infoValicoLabel: 'Grenzübergang-Info',
    webcamLabel: 'Live-Webcam',
    webcamNote:
      'Bilder aktualisieren sich automatisch jede Minute, solange die Seite geöffnet ist. Klicken Sie auf „Quelle" für den offiziellen Feed.',
    webcamSource: 'Quelle',
    webcamUnavailable: 'Keine Webcam für diesen Grenzübergang verfügbar. Das Departement für Bau, Verkehr und Umwelt des Kantons Tessin veröffentlicht für diese Grenze keine Live-Bilder.',
    faqTitle: 'Häufige Fragen',
    breadcrumbHome: 'Startseite',
    regionalLabelTicinoComo: 'Tessin–Como',
    regionalLabelTicinoVarese: 'Tessin–Varese',
    noHistory:
      'Historie wird aufgebaut: Monatliche Archive und 30-Tage-Wochenmuster erscheinen, sobald genügend Daten vorhanden sind.',
    staticFallbackBanner:
      'Historischer Durchschnitt — Echtzeit-Überwachung für diesen Übergang ist nicht verfügbar. Die angezeigten Werte sind Durchschnitte aus vergangenen Messungen.',
    crossingTypeLabel: { autostrada: 'Autobahn', statale: 'Hauptstrasse', locale: 'Lokale Strasse' },
    open24h: 'Rund um die Uhr geöffnet',
    hoursLabel: 'Öffnungszeiten',
    historicalAvg: 'Historischer Durchschnitt',
    faq: [
      {
        q: (c) => `Wann ist die Wartezeit bei ${c} am kürzesten?`,
        a: (c) =>
          `Im Durchschnitt sind die Wartezeiten bei ${c} am späten Vormittag (10:00–12:00) und am Nachmittag (14:00–16:00) am kürzesten. Ausserhalb der Pendler-Stosszeiten (06:30–08:30 und 17:00–19:00) sinken die Werte häufig unter 5 Minuten.`,
      },
      {
        q: () => 'Wie werden die Wartezeiten berechnet?',
        a: () =>
          'Die Wartezeiten stammen aus zwei Routing-Messungen: einem Annäherungssegment (~500 m vor dem Übergang auf italienischer Seite) und dem Übergangssegment (Übergang → Schweizer Kontrollpunkt). Die Mehrzeit gegenüber dem verkehrsfreien Referenzwert ist die Wartezeit. Die Daten werden während der Stosszeiten alle 15 Minuten erfasst und in Firestore persistiert.',
      },
      {
        q: () => 'Was tun, wenn die Wartezeit 40 Minuten überschreitet?',
        a: () =>
          'Bei Staus am Hauptübergang lohnt ein nahegelegener lokaler Übergang: Maslianico-Pizzamiglio statt Chiasso Centro, Crociale dei Mulini statt Brogeda, Clivio-Ligornetto statt Gaggiolo. Lokale Übergänge haben geringere Kapazität, bleiben aber oft flüssig, wenn die Hauptübergänge überlastet sind.',
      },
      {
        q: () => 'Funktionieren die Webcams auch nachts?',
        a: () =>
          'Die Webcams des Departements für Bau, Verkehr und Umwelt des Kantons Tessin sind rund um die Uhr aktiv, aber die Nachtqualität hängt von der Beleuchtung ab. Brogeda ist permanent beleuchtet, kleinere Übergänge können nachts dunkel erscheinen.',
      },
    ],
    rootIntro:
      'Vollständiger Überblick über die 24 Grenzübergänge Tessin–Italien, die unsere Pipeline in Echtzeit überwacht. Die richtige Wahl des Übergangs kann 20–30 Minuten pro Fahrt sparen. An Werktagen sind Chiasso-Brogeda und Gaggiolo während der Pendler-Stosszeiten 06:30–08:30 (Richtung IT→CH) und 17:00–19:00 (Richtung CH→IT) am stärksten belastet. Kleinere Übergänge wie Crociale dei Mulini, Drezzo-Pedrinate oder Clivio-Ligornetto haben geringere Kapazität, aber fast immer Wartezeiten unter 5 Minuten — ideal, um den Autobahnstau zu umgehen.',
    regionalIntro: (r, count) =>
      `Die Region ${r} umfasst ${count} Grenzübergänge Tessin–Italien. Dieser Hub zeigt den Live-Status jedes einzelnen und empfiehlt denjenigen mit der kürzesten Wartezeit im Moment. Beachten Sie, dass Pendlerspitzen den Verkehr auf die grossen Autobahnübergänge konzentrieren (Chiasso-Brogeda im Raum Como, Gaggiolo im Raum Varese), während lokale Übergänge auch in Stosszeiten flüssig bleiben.`,
  },
  fr: {
    leafH1: (c, d) => `Temps d'attente à la douane ${c} — aujourd'hui ${d}`,
    rootH1: "Temps d'attente aux douanes Tessin–Italie — en direct aujourd'hui",
    regionalH1: (r) => `Douanes ${r} — temps d'attente en direct`,
    intro: (c, s, w, d) =>
      `Mis à jour le ${d} : le poste de ${c} affiche actuellement une attente ${s} d'environ ${w}. Données rafraîchies toutes les 15 minutes pendant les heures de pointe pendulaire (06:00–10:00 et 16:00–20:00 CET).`,
    paragraph: (c, direction, bestHour, worstHour) =>
      `Planifiez votre passage par ${c} en consultant d'abord la valeur actuelle et, lorsqu'elle est disponible, la webcam en direct. Sur les 30 derniers jours la meilleure heure de transit (direction ${direction}) a été ${bestHour}, la pire ${worstHour}. Cette page est régénérée à chaque déploiement — les données live proviennent de la collection Firestore alimentée par le cron de trafic TomTom, les mêmes chiffres que la carte interactive du site. Si vous rentrez en Italie après le travail, notez que le flux du soir inverse la direction : entre 17h et 19h les postes principaux de Brogeda et Gaggiolo affichent généralement des files dans le sens opposé à celui du matin.`,
    updatedLabel: 'Mis à jour',
    currentStatusLabel: 'État actuel',
    waitMinutesLabel: "Minutes d'attente",
    approachLabel: 'Retard à l\'approche',
    totalLabel: 'Total',
    sourceLabel: 'Source',
    sourceBazg: 'Données officielles Douane suisse',
    sourceTomtom: 'Estimation TomTom (flux de trafic)',
    sourceGoogle: 'Estimation Google Maps',
    sourceStatic: 'Moyennes historiques — données temps réel indisponibles',
    hourlyTodayLabel: "Tendance horaire d'aujourd'hui",
    weeklyPatternLabel: 'Tendance hebdomadaire (30 derniers jours)',
    bestHoursLabel: 'Meilleures heures',
    worstHoursLabel: 'Pires heures',
    infoValicoLabel: 'Informations du poste',
    webcamLabel: 'Webcam en direct',
    webcamNote:
      "Les images se rafraîchissent automatiquement chaque minute tant que la page est ouverte. Cliquez sur « Source » pour la version officielle.",
    webcamSource: 'Source',
    webcamUnavailable: "Webcam non disponible pour ce poste frontière. Le Département du territoire du Canton du Tessin ne publie pas d'images en direct pour cette frontière.",
    faqTitle: 'Questions fréquentes',
    breadcrumbHome: 'Accueil',
    regionalLabelTicinoComo: 'Tessin–Côme',
    regionalLabelTicinoVarese: 'Tessin–Varèse',
    noHistory:
      "Historique en construction : archives mensuelles et tendances 30 jours apparaîtront dès que suffisamment de données seront collectées.",
    staticFallbackBanner:
      'Moyennes historiques — la surveillance en temps réel pour ce passage est indisponible. Les valeurs affichées sont des moyennes basées sur des observations passées.',
    crossingTypeLabel: { autostrada: 'Autoroute', statale: 'Route principale', locale: 'Route locale' },
    open24h: 'Ouvert 24h/24',
    hoursLabel: 'Horaires',
    historicalAvg: 'Moyenne historique',
    faq: [
      {
        q: (c) => `Quelle est l'heure la moins chargée à ${c} ?`,
        a: (c) =>
          `En moyenne le poste de ${c} affiche les files les plus courtes en milieu de matinée (10:00–12:00) et en milieu d'après-midi (14:00–16:00). En dehors des heures de pointe pendulaire (06:30–08:30 et 17:00–19:00), l'attente tombe souvent sous les 5 minutes.`,
      },
      {
        q: () => "Comment les minutes d'attente sont-elles calculées ?",
        a: () =>
          "Les temps d'attente dérivent de deux mesures de routage : un segment d'approche (≈500 m avant le poste côté italien) et le segment de passage (poste → point de contrôle suisse). Le temps supplémentaire par rapport à la référence sans trafic correspond à la file. Les données sont collectées toutes les 15 minutes en heures de pointe et persistées dans Firestore.",
      },
      {
        q: () => "Que faire si la file dépasse 40 minutes ?",
        a: () =>
          "Si le poste principal est congestionné, envisagez un passage local à proximité : Maslianico-Pizzamiglio au lieu de Chiasso Centro, Crociale dei Mulini au lieu de Brogeda, Clivio-Ligornetto au lieu de Gaggiolo. Les passages locaux ont une capacité moindre mais restent souvent fluides quand les grands saturent.",
      },
      {
        q: () => "Les webcams fonctionnent-elles la nuit ?",
        a: () =>
          "Les webcams du Département du territoire du Canton du Tessin sont actives 24h/24, mais la visibilité nocturne dépend de l'éclairage du poste. Brogeda est éclairé en permanence, les plus petits postes peuvent être sombres la nuit.",
      },
    ],
    rootIntro:
      "Vue d'ensemble complète des 24 passages frontière Tessin–Italie surveillés en temps réel par notre pipeline. Choisir le bon passage peut vous faire gagner 20–30 minutes par trajet. En semaine Chiasso-Brogeda et Gaggiolo sont les plus chargés pendant les pointes pendulaires 06:30–08:30 (direction IT→CH) et 17:00–19:00 (direction CH→IT). Les passages mineurs comme Crociale dei Mulini, Drezzo-Pedrinate ou Clivio-Ligornetto ont une capacité plus faible mais des files presque toujours inférieures à 5 minutes — idéaux pour éviter l'embouteillage autoroutier.",
    regionalIntro: (r, count) =>
      `La région ${r} regroupe ${count} passages frontière Tessin–Italie. Ce hub montre l'état en direct de chacun et recommande celui avec la file la plus courte en ce moment. Notez que les pointes pendulaires concentrent le trafic sur les grands postes autoroutiers (Chiasso-Brogeda dans la zone Côme, Gaggiolo dans la zone Varèse), tandis que les passages locaux restent fluides même en heures chargées.`,
  },
};

const LOCALE_OG: Record<BorderWaitLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

// ── Inline JS cache-buster for webcam refresh ──────────────────
//
// ~300 bytes, zero deps. Reads `data-webcam-refresh` (ms) and
// `data-webcam-base-url` off each <img>, refreshes `src` with a
// cache-busting query param at the configured interval. No Intersection
// Observer — the page exists specifically to show the webcam, so it's
// already in the viewport.

const WEBCAM_REFRESH_JS = `<script>(function(){var imgs=document.querySelectorAll('[data-webcam-refresh]');imgs.forEach(function(img){var base=img.getAttribute('data-webcam-base-url');var interval=parseInt(img.getAttribute('data-webcam-refresh'),10);if(!base||!interval||interval<10000)return;setInterval(function(){img.src=base+(base.indexOf('?')>-1?'&':'?')+'v='+Date.now();},interval);});})();</script>`;

// ── Section renderers ─────────────────────────────────────────

function renderWebcamSection(
  crossingLabel: string,
  webcams: readonly WebcamRef[],
  copy: Copy,
): string {
  if (!webcams || webcams.length === 0) {
    return `<section aria-label="${esc(copy.webcamLabel)} ${esc(crossingLabel)}" style="margin:0 0 28px">
    <h2 style="${H2_STYLE}">${esc(copy.webcamLabel)}</h2>
    <p style="margin:0;font-size:15px;color:var(--color-subtle);line-height:1.6">${esc(copy.webcamUnavailable)}</p>
  </section>`;
  }
  const figures = webcams
    .map((w) => {
      const refreshMs = w.refreshIntervalMs ?? 60000;
      const licenseHtml = w.license
        ? `<div style="margin-top:4px;font-size:12px;color:var(--color-subtle)">${esc(w.license)}</div>`
        : '';
      return `<figure style="margin:0 0 16px;padding:0;width:100%;max-width:640px;aspect-ratio:16/9">
    <img
      src="${esc(w.imageUrl)}"
      alt="${esc(w.label)} — ${esc(copy.updatedLabel)} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}"
      width="640"
      height="360"
      loading="lazy"
      decoding="async"
      fetchpriority="low"
      referrerpolicy="no-referrer"
      data-webcam-refresh="${refreshMs}"
      data-webcam-base-url="${esc(w.imageUrl)}"
      onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 640 360%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23f1f5f9%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 fill=%22%23475569%22 text-anchor=%22middle%22 dy=%22.3em%22 font-family=%22sans-serif%22%3EWebcam temporaneamente non disponibile%3C%2Ftext%3E%3C%2Fsvg%3E';"
      style="width:100%;height:100%;object-fit:cover;border-radius:12px;border:1px solid var(--color-edge);background:var(--color-surface-alt)"
    >
    <figcaption style="margin-top:8px;font-size:14px;color:var(--color-subtle)">
      <strong>${esc(w.label)}</strong> — ${esc(copy.webcamSource)}:
      <a href="${esc(w.sourceUrl)}" rel="nofollow noopener" target="_blank" style="${LINK_ACCENT_STYLE};text-decoration:underline">${esc(w.sourceName)}</a>
      ${licenseHtml}
    </figcaption>
  </figure>`;
    })
    .join('\n');

  return `<section aria-label="${esc(copy.webcamLabel)} ${esc(crossingLabel)}" style="margin:0 0 28px">
    <h2 style="${H2_STYLE}">${esc(copy.webcamLabel)}</h2>
    ${figures}
    <p style="margin:8px 0 0;font-size:13px;color:var(--color-subtle);line-height:1.5">${esc(copy.webcamNote)}</p>
  </section>`;
}

function sourceLabel(source: WaitSource, copy: Copy): string {
  switch (source) {
    case 'bazg':
      return copy.sourceBazg;
    case 'tomtom':
      return copy.sourceTomtom;
    case 'google':
    case 'google-maps':
      return copy.sourceGoogle;
    case 'static':
    default:
      return copy.sourceStatic;
  }
}

function renderHourlySvg(buckets: Array<null | { avg: number }>, copy: Copy): string {
  // 24-bar SVG chart, width 600, height 140
  const width = 600;
  const height = 140;
  const maxAvg = Math.max(1, ...buckets.map((b) => (b ? b.avg : 0)));
  const barWidth = width / 24 - 2;
  const bars = buckets
    .map((b, i) => {
      const x = i * (width / 24) + 1;
      const h = b ? Math.max(2, (b.avg / maxAvg) * (height - 20)) : 2;
      const y = height - h - 10;
      const fillVar = !b
        ? 'var(--color-surface-muted)'
        : b.avg < 5
          ? 'var(--color-success-border)'
          : b.avg < 15
            ? 'var(--color-warning-border)'
            : 'var(--color-danger-border)';
      const label = b ? `${b.avg} min @ ${String(i).padStart(2, '0')}:00` : `${String(i).padStart(2, '0')}:00 — no data`;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="2" style="fill: ${fillVar};"><title>${esc(label)}</title></rect>`;
    })
    .join('');
  const hourLabels = [0, 6, 12, 18, 23]
    .map(
      (h) =>
        `<text x="${h * (width / 24) + barWidth / 2}" y="${height - 2}" font-size="10" text-anchor="middle" style="fill: var(--color-subtle);">${String(h).padStart(2, '0')}</text>`,
    )
    .join('');
  return `<svg role="img" aria-label="${esc(copy.hourlyTodayLabel)}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${width}px;height:auto;display:block">
    ${bars}
    ${hourLabels}
  </svg>`;
}

function renderWeeklySvg(matrix: Array<Array<null | { avg: number }>>, copy: Copy): string {
  // 7×24 heatmap, width 600, height 200
  const width = 600;
  const height = 200;
  const cellW = width / 24;
  const cellH = (height - 24) / 7;
  let maxAvg = 1;
  for (const row of matrix) for (const c of row) if (c && c.avg > maxAvg) maxAvg = c.avg;
  const cells = matrix
    .map((row, d) =>
      row
        .map((cell, h) => {
          const x = h * cellW;
          const y = d * cellH + 16;
          let fillVar = 'var(--color-surface-muted)';
          let fillOpacity = 1;
          if (cell) {
            const intensity = Math.min(1, cell.avg / maxAvg);
            fillOpacity = 0.3 + intensity * 0.7;
            if (cell.avg < 5) fillVar = 'var(--color-success-border)';
            else if (cell.avg < 15) fillVar = 'var(--color-warning-border)';
            else fillVar = 'var(--color-danger-border)';
          }
          const label = cell
            ? `${['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'][d]} ${String(h).padStart(2, '0')}:00 — ${cell.avg} min`
            : `${['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'][d]} ${String(h).padStart(2, '0')}:00 — n/a`;
          return `<rect x="${x}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" style="fill: ${fillVar}; fill-opacity: ${fillOpacity};"><title>${esc(label)}</title></rect>`;
        })
        .join(''),
    )
    .join('');
  const hourLabels = [0, 6, 12, 18, 23]
    .map(
      (h) =>
        `<text x="${h * cellW + cellW / 2}" y="12" font-size="10" text-anchor="middle" style="fill: var(--color-subtle);">${String(h).padStart(2, '0')}</text>`,
    )
    .join('');
  return `<svg role="img" aria-label="${esc(copy.weeklyPatternLabel)}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${width}px;height:auto;display:block">
    ${cells}
    ${hourLabels}
  </svg>`;
}

// ── Aggregators ───────────────────────────────────────────────

function aggregateToday(
  crossing: BorderCrossingSlug,
  history: BorderWaitHistoryDay[],
  today?: Date,
): Array<null | { avg: number; min: number; max: number; samples: number }> {
  const todayIso = (today ?? new Date()).toISOString().slice(0, 10);
  const todayFile = history.find((h) => h.date === todayIso);
  const buckets: Array<null | { avg: number; min: number; max: number; samples: number }> =
    Array(24).fill(null);
  if (!todayFile) return buckets;
  const series = todayFile.perCrossing[crossing];
  if (!Array.isArray(series)) return buckets;
  for (let i = 0; i < 24; i++) {
    const cell = series[i];
    if (cell && typeof cell.avg === 'number') buckets[i] = cell;
  }
  return buckets;
}

function aggregateWeekly(
  crossing: BorderCrossingSlug,
  history: BorderWaitHistoryDay[],
): Array<Array<null | { avg: number }>> {
  // 7 rows (day of week 0–6, Sun–Sat), 24 cols (hour)
  const acc: Array<Array<number[]>> = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => []),
  );
  for (const day of history) {
    const series = day.perCrossing[crossing];
    if (!Array.isArray(series)) continue;
    const dow = new Date(day.date).getUTCDay();
    for (let h = 0; h < 24; h++) {
      const cell = series[h];
      if (cell && typeof cell.avg === 'number') acc[dow][h].push(cell.avg);
    }
  }
  return acc.map((row) =>
    row.map((samples) =>
      samples.length === 0
        ? null
        : { avg: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) },
    ),
  );
}

function findBestWorstHour(
  weekly: Array<Array<null | { avg: number }>>,
): { best: string; worst: string } {
  // Flatten weekdays (Mon-Fri) to find commuter-relevant best/worst
  let bestHour = -1;
  let worstHour = -1;
  let bestVal = Infinity;
  let worstVal = -Infinity;
  for (let h = 0; h < 24; h++) {
    const samples: number[] = [];
    for (let d = 1; d <= 5; d++) {
      const cell = weekly[d]?.[h];
      if (cell) samples.push(cell.avg);
    }
    if (samples.length === 0) continue;
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    if (avg < bestVal) {
      bestVal = avg;
      bestHour = h;
    }
    if (avg > worstVal) {
      worstVal = avg;
      worstHour = h;
    }
  }
  const fmt = (h: number) => (h < 0 ? '—' : `${String(h).padStart(2, '0')}:00`);
  return { best: fmt(bestHour), worst: fmt(worstHour) };
}

// ── Page renderers ─────────────────────────────────────────────

interface LeafInputs {
  locale: BorderWaitLocale;
  crossing: BorderCrossingSlug;
  current: BorderWaitCurrent;
  history: BorderWaitHistoryDay[];
  today: Date;
  alternates: Record<BorderWaitLocale, string>;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
  /**
   * Absolute URL for the per-crossing OG image (webcam snapshot). When
   * provided and the snapshot exists on disk, the page emits it as
   * `og:image` / `twitter:image` at 640×360 — a live preview of the
   * crossing traffic state that drives viral social sharing. When omitted,
   * the page falls back to the site default OG image (`/og-image.png`).
   */
  ogImageUrl?: string;
}

function renderLeafPage(inp: LeafInputs): string {
  const { locale, crossing, current, history, today, alternates, distDir, ogImageUrl } = inp;
  const copy = COPY[locale];
  const crossingDisplay = BORDER_CROSSING_DISPLAY[crossing];
  const region = CROSSING_TO_REGION[crossing];
  const regionDisplay =
    region === 'ticino-como' ? copy.regionalLabelTicinoComo : copy.regionalLabelTicinoVarese;
  const reg = crossingRegistry(crossing);
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalPath = buildOggiPath(locale, crossing);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  // Live + derived data
  const snapshot = current.perCrossing[crossing];
  const liveWait = snapshot?.waitTimeMinutes ?? null;
  const liveSource: WaitSource = snapshot?.source ?? 'static';
  const staticFallback = liveWait === null;
  const status = statusColor(liveWait);
  const statusWord =
    locale === 'it'
      ? liveWait === null
        ? 'non rilevata'
        : status.label === 'ok'
          ? 'breve'
          : status.label === 'warn'
            ? 'moderata'
            : 'lunga'
      : locale === 'en'
        ? liveWait === null
          ? 'unknown'
          : status.label === 'ok'
            ? 'short'
            : status.label === 'warn'
              ? 'moderate'
              : 'long'
        : locale === 'de'
          ? liveWait === null
            ? 'unbekannt'
            : status.label === 'ok'
              ? 'kurze'
              : status.label === 'warn'
                ? 'moderate'
                : 'lange'
          : liveWait === null
            ? 'inconnue'
            : status.label === 'ok'
              ? 'brève'
              : status.label === 'warn'
                ? 'modérée'
                : 'longue';
  const waitFmt = liveWait === null ? '—' : `${liveWait} min`;
  const direction = snapshot?.status === undefined
    ? 'IT→CH'
    : new Date().getUTCHours() < 12
      ? 'IT→CH'
      : 'CH→IT';

  const todayBuckets = aggregateToday(crossing, history, inp.today);
  const weekly = aggregateWeekly(crossing, history);
  const { best: bestHour, worst: worstHour } = findBestWorstHour(weekly);
  /** Hourly chart needs at least today's data (1 day); weekly pattern needs ≥7. */
  const hasToday = history.length >= 1 && todayBuckets.some((b) => b !== null);
  const hasWeekly = history.length >= 7;

  // Content pieces
  const h1 = copy.leafH1(crossingDisplay, dateStamp);
  const intro = copy.intro(crossingDisplay, statusWord, waitFmt, dateStamp);
  const paragraph = copy.paragraph(crossingDisplay, direction, bestHour, worstHour);

  // Webcam: prefer reg.webcams (data/borderCrossings.ts)
  const webcams = reg?.webcams ?? [];
  const webcamHtml = renderWebcamSection(crossingDisplay, webcams, copy);

  // Current-status card
  const sourceText = sourceLabel(liveSource, copy);
  const staticBannerHtml = staticFallback
    ? `<div style="margin:0 0 18px;padding:14px 18px;border-radius:12px;background:var(--color-warning-subtle);border:1px solid var(--color-warning-border);color:var(--color-warning-border);font-size:14px;line-height:1.5">${esc(copy.staticFallbackBanner)}</div>`
    : '';

  const currentCardHtml = `<section aria-labelledby="currentStatus" style="margin:0 0 24px">
    <h2 id="currentStatus" style="${H2_STYLE}">${esc(copy.currentStatusLabel)}</h2>
    ${staticBannerHtml}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px">
      <div style="padding:18px;border-radius:18px;background:${status.bg};border:1px solid ${status.border}">
        <div style="font-size:12px;color:${status.text};font-weight:700;text-transform:uppercase">${esc(copy.waitMinutesLabel)}</div>
        <div style="margin-top:8px;font-size:36px;font-weight:800;color:${status.text}">${esc(waitFmt)}</div>
      </div>
      <div style="padding:18px;border-radius:18px;background:var(--color-surface-alt);border:1px solid var(--color-edge)">
        <div style="font-size:12px;color:var(--color-subtle);font-weight:700;text-transform:uppercase">${esc(copy.sourceLabel)}</div>
        <div style="margin-top:8px;font-size:14px;color:var(--color-heading);font-weight:700;line-height:1.4">${esc(sourceText)}</div>
      </div>
      <div style="padding:18px;border-radius:18px;background:var(--color-surface-alt);border:1px solid var(--color-edge)">
        <div style="font-size:12px;color:var(--color-subtle);font-weight:700;text-transform:uppercase">${esc(copy.updatedLabel)}</div>
        <div style="margin-top:8px;font-size:14px;color:var(--color-heading);font-weight:700">${esc(dateStamp)}</div>
      </div>
    </div>
  </section>`;

  // Hourly chart (needs ≥1 day with samples)
  const hourlyHtml = hasToday
    ? `<section style="margin:0 0 24px" aria-labelledby="hourlyToday">
    <h2 id="hourlyToday" style="${H2_STYLE}">${esc(copy.hourlyTodayLabel)}</h2>
    ${renderHourlySvg(todayBuckets, copy)}
  </section>`
    : '';

  // Weekly chart (needs ≥7 days to be meaningful)
  const weeklyHtml = hasWeekly
    ? `<section style="margin:0 0 24px" aria-labelledby="weeklyPattern">
    <h2 id="weeklyPattern" style="${H2_STYLE}">${esc(copy.weeklyPatternLabel)}</h2>
    ${renderWeeklySvg(weekly, copy)}
    <p style="margin:12px 0 0;color:var(--color-body);font-size:14px;line-height:1.55">
      <strong>${esc(copy.bestHoursLabel)}:</strong> ${esc(bestHour)} &nbsp;·&nbsp;
      <strong>${esc(copy.worstHoursLabel)}:</strong> ${esc(worstHour)}
    </p>
  </section>`
    : `<p style="margin:0 0 24px;padding:14px 18px;border-radius:12px;background:var(--color-surface-alt);color:var(--color-subtle);font-size:14px;line-height:1.5">${esc(copy.noHistory)}</p>`;

  // Static crossing info
  const infoRows: string[] = [];
  if (reg) {
    infoRows.push(
      `<li style="padding:8px 0;border-bottom:1px solid var(--color-edge)"><strong>${esc(
        locale === 'it' ? 'Tipo' : locale === 'de' ? 'Typ' : locale === 'fr' ? 'Type' : 'Type',
      )}:</strong> ${esc(copy.crossingTypeLabel[reg.type])}</li>`,
    );
    infoRows.push(
      `<li style="padding:8px 0;border-bottom:1px solid var(--color-edge)"><strong>${esc(copy.hoursLabel)}:</strong> ${esc(reg.open24h ? copy.open24h : reg.hours)}</li>`,
    );
    infoRows.push(
      `<li style="padding:8px 0;border-bottom:1px solid var(--color-edge)"><strong>${esc(
        locale === 'it'
          ? 'Media mattina'
          : locale === 'de'
            ? 'Morgen-Durchschnitt'
            : locale === 'fr'
              ? 'Moyenne matin'
              : 'Morning average',
      )}:</strong> ${esc(reg.avgWaitMorning)}</li>`,
    );
    infoRows.push(
      `<li style="padding:8px 0;border-bottom:1px solid var(--color-edge)"><strong>${esc(
        locale === 'it'
          ? 'Media sera'
          : locale === 'de'
            ? 'Abend-Durchschnitt'
            : locale === 'fr'
              ? 'Moyenne soir'
              : 'Evening average',
      )}:</strong> ${esc(reg.avgWaitEvening)}</li>`,
    );
  }
  const infoHtml = infoRows.length
    ? `<section style="margin:0 0 24px" aria-labelledby="infoValico">
    <h2 id="infoValico" style="${H2_STYLE}">${esc(copy.infoValicoLabel)}</h2>
    <ul style="list-style:none;margin:0;padding:0;font-size:14px;color:var(--color-body);line-height:1.5">${infoRows.join('')}</ul>
  </section>`
    : '';

  // B.3 — Alternative routes section: suggest 2-3 nearby crossings per valico
  // to help users reroute when congested. Brogeda/Chiasso/Gaggiolo get primary
  // treatment (highest volume). Others get a generic fallback.
  const ALT_ROUTES: Record<string, BorderCrossingSlug[]> = {
    'chiasso-brogeda': ['chiasso-strada', 'bizzarone-novazzano', 'crociale-dei-mulini'],
    'chiasso-centro': ['chiasso-brogeda', 'maslianico-pizzamiglio', 'bizzarone-novazzano'],
    'chiasso-strada': ['chiasso-brogeda', 'chiasso-centro', 'bizzarone-novazzano'],
    'gaggiolo': ['san-pietro', 'clivio-ligornetto', 'saltrio-arzo'],
    'san-pietro': ['gaggiolo', 'clivio-ligornetto', 'rodero-stabio'],
    'ponte-tresa': ['porto-ceresio-brusino', 'cremenaga-ponte-cremenaga', 'luino-fornasette'],
    'luino-fornasette': ['cremenaga-ponte-cremenaga', 'ponte-tresa', 'zenna-dirinella'],
    'maslianico-pizzamiglio': ['chiasso-centro', 'maslianico-roggiana', 'chiasso-brogeda'],
    'bizzarone-novazzano': ['ronago-novazzano', 'chiasso-brogeda', 'chiasso-strada'],
  };
  const altLabelByLocale: Record<BorderWaitLocale, { h2: string; lead: string }> = {
    it: { h2: 'Percorsi alternativi', lead: 'Se questo valico è congestionato, questi passaggi vicini sono spesso più fluidi:' },
    en: { h2: 'Alternative routes', lead: 'If this crossing is congested, these nearby passages are often smoother:' },
    de: { h2: 'Alternative Routen', lead: 'Wenn dieser Übergang überlastet ist, sind diese nahegelegenen Pässe oft fliessender:' },
    fr: { h2: 'Itinéraires alternatifs', lead: "Si ce poste est congestionné, ces passages voisins sont souvent plus fluides :" },
  };
  const altSlugs = ALT_ROUTES[crossing];
  const alternativeRoutesHtml = altSlugs && altSlugs.length
    ? (() => {
        const { h2, lead } = altLabelByLocale[locale];
        const items = altSlugs
          .map((slug) => {
            const altReg = crossingRegistry(slug);
            if (!altReg) return '';
            const href = `${BASE_URL}${buildOggiPath(locale, slug)}`;
            const altDisp = BORDER_CROSSING_DISPLAY[slug];
            const detail = `${copy.crossingTypeLabel[altReg.type]} · ${altReg.open24h ? copy.open24h : esc(altReg.hours)} · ${esc(altReg.avgWaitMorning)}`;
            return `<li style="${CARD_STYLE};border-radius:10px;margin-bottom:8px"><a href="${href}" style="${LINK_ACCENT_STYLE};font-weight:700">${esc(altDisp)}</a><div style="font-size:13px;color:var(--color-subtle);margin-top:2px">${detail}</div></li>`;
          })
          .filter(Boolean)
          .join('');
        return items
          ? `<section style="margin:0 0 24px" aria-labelledby="altRoutes">
    <h2 id="altRoutes" style="${H2_STYLE}">${esc(h2)}</h2>
    <p style="margin:0 0 10px;color:var(--color-body);font-size:14px;line-height:1.55">${esc(lead)}</p>
    <ul style="list-style:none;margin:0;padding:0">${items}</ul>
  </section>`
          : '';
      })()
    : '';

  // FAQ
  const faqItems = copy.faq;
  const faqHtml = `<section style="margin:32px 0 0" aria-labelledby="bwFaq">
    <h2 id="bwFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    ${faqItems
      .map(
        (f) =>
          `<details style="${CARD_STYLE};margin-bottom:8px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q(crossingDisplay))}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a(crossingDisplay))}</p>
      </details>`,
      )
      .join('')}
  </section>`;

  // Alternates. IT is the canonical locale and serves as the x-default. The
  // shared helper emits 4 locales + x-default on the canonical host.
  const alternatesHtml = renderHreflangTags(alternates);

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: regionDisplay,
        item: `${BASE_URL}${buildRegionalHubPath(locale, region)}`,
      },
      { '@type': 'ListItem', position: 3, name: crossingDisplay, item: canonicalUrl },
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqItems.map((f) => ({
      '@type': 'Question',
      name: f.q(crossingDisplay),
      acceptedAnswer: { '@type': 'Answer', text: f.a(crossingDisplay) },
    })),
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  // B.3 — Enhanced Place + TouristAttraction (@type array) schema with
  // openingHoursSpecification, amenityFeature, publicAccess — richer signals
  // for "valico" + "dogana" queries.
  const placeLd = reg
    ? JSON.stringify({
        '@context': 'https://schema.org',
        '@type': ['Place', 'TouristAttraction'],
        '@id': `${canonicalUrl}#place`,
        name: crossingDisplay,
        description: intro,
        url: canonicalUrl,
        address: {
          '@type': 'PostalAddress',
          addressCountry: 'CH',
          addressRegion: reg.canton,
          addressLocality: reg.italianSide,
        },
        geo: {
          '@type': 'GeoCoordinates',
          latitude: reg.lat,
          longitude: reg.lng,
        },
        containedInPlace: {
          '@type': 'AdministrativeArea',
          name: locale === 'de' ? 'Kanton Tessin' : locale === 'fr' ? 'Canton du Tessin' : locale === 'en' ? 'Canton of Ticino' : 'Canton Ticino',
          address: { '@type': 'PostalAddress', addressRegion: 'TI', addressCountry: 'CH' },
        },
        openingHoursSpecification: reg.open24h
          ? {
              '@type': 'OpeningHoursSpecification',
              opens: '00:00',
              closes: '23:59',
              dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
            }
          : {
              '@type': 'OpeningHoursSpecification',
              description: reg.hours,
              dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
            },
        amenityFeature: [
          {
            '@type': 'LocationFeatureSpecification',
            name: 'Dogana presente',
            value: Boolean(reg.customsPresent),
          },
          {
            '@type': 'LocationFeatureSpecification',
            name: 'Webcam live',
            value: Array.isArray(reg.webcams) && reg.webcams.length > 0,
          },
          {
            '@type': 'LocationFeatureSpecification',
            name: 'Copertura BAZG (dati ufficiali)',
            value: Boolean(reg.bazgCoverage),
          },
          {
            '@type': 'LocationFeatureSpecification',
            name: 'Tipo strada',
            value: reg.type,
          },
        ],
        publicAccess: true,
        isAccessibleForFree: true,
      })
    : '';

  // ImageObject — the webcam subject is a still JPEG snapshot refreshed on a
  // polling interval, not a continuous video stream, so VideoObject +
  // BroadcastEvent (isLiveBroadcast: true) is inappropriate. Emit a single
  // ImageObject with the required fields. License is included when present;
  // creditText is included when the source provides it.
  const imageLd = webcams.length > 0
    ? JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'ImageObject',
        contentUrl: webcams[0].imageUrl,
        caption: `${copy.webcamLabel} — ${crossingDisplay}`,
        ...(webcams[0].sourceName ? { creditText: webcams[0].sourceName } : {}),
        ...(webcams[0].license ? { license: webcams[0].license } : {}),
        datePublished: `${dateStamp}T00:00:00Z`,
        inLanguage: locale,
      })
    : '';

  // Title — the h1 embeds an ISO date, so the raw string can easily exceed
  // ~70 chars once " | Frontaliere Ticino" is appended. Trim the h1 portion
  // at a word boundary to ~48 chars (leaves ~22 chars for the site suffix).
  const TITLE_H1_MAX = 48;
  const titleH1 =
    h1.length <= TITLE_H1_MAX
      ? h1
      : (() => {
          const sliced = h1.slice(0, TITLE_H1_MAX);
          const lastSpace = sliced.lastIndexOf(' ');
          return (lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced).replace(/[\s—–-]+$/, '');
        })();
  const title = `${titleH1} | Frontaliere Ticino`;
  const description = intro.slice(0, 180);

  // Related-links helper context
  const relatedCtx = {
    city: CROSSING_TO_WEEKLY_CITY[crossing],
    weeklyCity: CROSSING_TO_WEEKLY_CITY[crossing],
    fuelZone: CROSSING_TO_FUEL_ZONE[crossing],
  };

  // Webcam refresh script is plugin-specific behaviour — append it inside
  // bodyHtml (after the closing </main>) so it loads on the static shell
  // without bypassing buildSeoPageHtml's templating.
  const webcamRefreshScript = webcams.length > 0 ? `\n  ${WEBCAM_REFRESH_JS}` : '';

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}" aria-label="Breadcrumb">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${BASE_URL}${buildRootHubPath(locale)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.rootH1.split(' —')[0])}</a>
    <span> / </span>
    <a href="${BASE_URL}${buildRegionalHubPath(locale, region)}" style="${BREADCRUMB_LINK_STYLE}">${esc(regionDisplay)}</a>
    <span> / </span>
    <span>${esc(crossingDisplay)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(copy.updatedLabel)} · ${dateStamp}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  ${webcamHtml}
  ${currentCardHtml}
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  ${hourlyHtml}
  ${weeklyHtml}
  ${infoHtml}
  ${alternativeRoutesHtml}
  ${faqHtml}
  ${renderDiscoverMore(locale, BORDER_WAIT_DISCOVER_MORE_CTAS[locale])}
  ${generateRelatedLinksBlock(locale, 'border_wait', relatedCtx)}
</article>${webcamRefreshScript}`;

  // Per-page OG image: when the build-time webcam snapshot is available, use
  // the 640×360 JPEG so social shares show the REAL traffic state at the
  // crossing. Fallback to the generic site OG image (1200×630) otherwise.
  const hasWebcamOg = typeof ogImageUrl === 'string' && ogImageUrl.length > 0;
  const ogImageTag = hasWebcamOg ? ogImageUrl! : `${BASE_URL}/og-image.png`;
  const ogImageWidth = hasWebcamOg ? '640' : '1200';
  const ogImageHeight = hasWebcamOg ? '360' : '630';
  const ogImageAlt = hasWebcamOg
    ? (locale === 'it'
        ? `Webcam live — ${crossingDisplay}`
        : locale === 'de'
          ? `Live-Webcam — ${crossingDisplay}`
          : locale === 'fr'
            ? `Webcam en direct — ${crossingDisplay}`
            : `Live webcam — ${crossingDisplay}`)
    : title;

  const extraHead = `    <meta property="og:image" content="${esc(ogImageTag)}">
    <meta property="og:image:width" content="${ogImageWidth}">
    <meta property="og:image:height" content="${ogImageHeight}">
    <meta property="og:image:alt" content="${esc(ogImageAlt)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:image" content="${esc(ogImageTag)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const jsonLdScripts = [breadcrumbLd, webPageLd, faqLd];
  if (placeLd) jsonLdScripts.push(placeLd);
  if (imageLd) jsonLdScripts.push(imageLd);

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: LOCALE_OG[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts,
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'guida', activeSubTab: 'border' },
  });
}

// ── Regional hub + root hub ───────────────────────────────────

interface HubInputs {
  locale: BorderWaitLocale;
  region?: BorderCrossingRegion;
  current: BorderWaitCurrent;
  today: Date;
  alternates: Record<BorderWaitLocale, string>;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

function renderHubPage(inp: HubInputs): string {
  const { locale, region, current, today, alternates, distDir } = inp;
  const copy = COPY[locale];
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalPath = region ? buildRegionalHubPath(locale, region) : buildRootHubPath(locale);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const crossingsInScope = region
    ? BORDER_WAIT_CROSSINGS.filter((c) => CROSSING_TO_REGION[c] === region)
    : BORDER_WAIT_CROSSINGS;

  const regionDisplay = region
    ? region === 'ticino-como'
      ? copy.regionalLabelTicinoComo
      : copy.regionalLabelTicinoVarese
    : '';

  const h1 = region ? copy.regionalH1(regionDisplay) : copy.rootH1;
  const introParagraph = region
    ? copy.regionalIntro(regionDisplay, crossingsInScope.length)
    : copy.rootIntro;

  // Build live table of all crossings in scope
  const rows = crossingsInScope.map((c) => {
    const snap = current.perCrossing[c];
    const wait = snap?.waitTimeMinutes ?? null;
    const src: WaitSource = snap?.source ?? 'static';
    const sc = statusColor(wait);
    const waitFmt = wait === null ? '—' : `${wait} min`;
    return `<tr>
      <td style="${TABLE_CELL_STYLE}">
        <a href="${BASE_URL}${buildOggiPath(locale, c)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(BORDER_CROSSING_DISPLAY[c])}</a>
      </td>
      <td style="${TABLE_CELL_STYLE};text-align:right">
        <span style="display:inline-block;padding:4px 10px;border-radius:9999px;font-size:13px;font-weight:700;background:${sc.bg};color:${sc.text};border:1px solid ${sc.border}">${esc(waitFmt)}</span>
      </td>
      <td style="${TABLE_CELL_STYLE};font-size:12px;color:var(--color-subtle)">${esc(sourceLabel(src, copy))}</td>
    </tr>`;
  });

  const tableHtml = `<table style="${TABLE_STYLE};font-size:14px">
    <thead><tr>
      <th style="${TABLE_HEAD_STYLE}">${esc(
        locale === 'it' ? 'Valico' : locale === 'de' ? 'Grenzübergang' : locale === 'fr' ? 'Poste' : 'Crossing',
      )}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.waitMinutesLabel)}</th>
      <th style="${TABLE_HEAD_STYLE}">${esc(copy.sourceLabel)}</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;

  // "Best crossing right now" hero, with a "traffico fluido" fallback
  // banner when every crossing reports 0 min (upstream data degenerate
  // case — either unmeasured or perfectly fluid). Either the hero OR the
  // fallback renders; never both and never empty space.
  const heroInputs: ReadonlyArray<FastestCrossingInput> = crossingsInScope.map((c) => ({
    slug: c,
    labelIt: BORDER_CROSSING_DISPLAY[c],
    waitTimeMinutes: current.perCrossing[c]?.waitTimeMinutes ?? 0,
  }));
  const allZeros = heroInputs.every((c) => c.waitTimeMinutes === 0);
  const bestBannerHtml = allZeros
    ? renderTrafficFluidBanner(true, locale)
    : renderFastestCrossingCard(heroInputs, locale);

  const alternatesHtml = renderHreflangTags(alternates);

  // JSON-LD
  const breadcrumbItems = [
    { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
  ];
  if (region) {
    breadcrumbItems.push(
      {
        '@type': 'ListItem',
        position: 2,
        name: copy.rootH1.split(' —')[0],
        item: `${BASE_URL}${buildRootHubPath(locale)}`,
      } as any,
    );
    breadcrumbItems.push(
      { '@type': 'ListItem', position: 3, name: regionDisplay, item: canonicalUrl } as any,
    );
  } else {
    breadcrumbItems.push(
      { '@type': 'ListItem', position: 2, name: h1, item: canonicalUrl } as any,
    );
  }
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbItems,
  });
  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: introParagraph.slice(0, 200),
    inLanguage: locale,
    dateModified: today.toISOString(),
  });

  const title = `${h1} | Frontaliere Ticino`;
  const description = introParagraph.slice(0, 180);

  // Secondary editorial paragraph for word-count
  const secondary =
    locale === 'it'
      ? `Questa pagina si aggiorna automaticamente ad ogni deploy del sito (tipicamente 4–8 volte al giorno). Le misure live provengono dalla stessa pipeline che alimenta la mappa interattiva del sito e la sezione Guida → Traffico dogane nel nostro SPA. Per ogni valico trovi una pagina dedicata con dato corrente, pattern orario oggi, pattern settimanale degli ultimi 30 giorni, webcam live quando disponibile (Brogeda, Stabio, Mendrisio, Chiasso) e FAQ mirate sul comportamento del traffico pendolare Ticino–Italia.`
      : locale === 'en'
        ? `This page is regenerated automatically on every deploy (typically 4–8 per day). Live readings come from the same pipeline that powers the site's interactive map and the Guide → Border traffic section in our SPA. For each crossing you get a dedicated page with current data, hourly pattern for today, 30-day weekly pattern, live webcam when available (Brogeda, Stabio, Mendrisio, Chiasso) and FAQs focused on commuter traffic behaviour between Ticino and Italy.`
        : locale === 'de'
          ? `Diese Seite wird bei jedem Deploy automatisch neu generiert (typischerweise 4–8 pro Tag). Live-Messwerte stammen aus derselben Pipeline, die die interaktive Karte der Seite und den Abschnitt Guida → Grenzverkehr in unserer SPA speist. Für jeden Übergang erhalten Sie eine eigene Seite mit aktuellen Daten, Stundenmuster von heute, Wochenmuster der letzten 30 Tage, Live-Webcam wo verfügbar (Brogeda, Stabio, Mendrisio, Chiasso) und FAQs zum Pendlerverkehr zwischen dem Tessin und Italien.`
          : `Cette page est régénérée automatiquement à chaque déploiement (généralement 4–8 par jour). Les mesures live proviennent de la même pipeline qui alimente la carte interactive du site et la section Guide → Trafic douane dans notre SPA. Pour chaque passage vous obtenez une page dédiée avec les données actuelles, la tendance horaire du jour, la tendance hebdomadaire sur 30 jours, la webcam en direct quand disponible (Brogeda, Stabio, Mendrisio, Chiasso) et des FAQs centrées sur le trafic pendulaire entre le Tessin et l'Italie.`;

  // Related links context based on "primary" crossing for the region
  const primaryCrossing: BorderCrossingSlug = region === 'ticino-varese' ? 'gaggiolo' : 'chiasso-brogeda';
  const relatedCtx = {
    city: CROSSING_TO_WEEKLY_CITY[primaryCrossing],
    weeklyCity: CROSSING_TO_WEEKLY_CITY[primaryCrossing],
    fuelZone: CROSSING_TO_FUEL_ZONE[primaryCrossing],
  };

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}" aria-label="Breadcrumb">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    ${region ? `<a href="${BASE_URL}${buildRootHubPath(locale)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.rootH1.split(' —')[0])}</a><span> / </span><span>${esc(regionDisplay)}</span>` : `<span>${esc(h1)}</span>`}
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(copy.updatedLabel)} · ${dateStamp}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(introParagraph)}</p>
  </header>
  ${bestBannerHtml}
  <section style="margin:0 0 24px" aria-labelledby="crossingTable">
    <h2 id="crossingTable" style="${H2_STYLE}">${esc(
      locale === 'it'
        ? 'Tutti i valichi'
        : locale === 'de'
          ? 'Alle Übergänge'
          : locale === 'fr'
            ? 'Tous les passages'
            : 'All crossings',
    )}</h2>
    ${tableHtml}
  </section>
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(secondary)}</p>
  </section>
  ${renderDiscoverMore(locale, BORDER_WAIT_DISCOVER_MORE_CTAS[locale])}
  ${generateRelatedLinksBlock(locale, 'border_wait', relatedCtx)}
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">`;

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: LOCALE_OG[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'guida', activeSubTab: 'border' },
  });
}

// ── Monthly archive ────────────────────────────────────────────

interface ArchiveInputs {
  locale: BorderWaitLocale;
  crossing: BorderCrossingSlug;
  monthKey: string;
  history: BorderWaitHistoryDay[];
  today: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

function renderArchivePage(inp: ArchiveInputs): string {
  const { locale, crossing, monthKey, history, today, distDir } = inp;
  const copy = COPY[locale];
  const crossingDisplay = BORDER_CROSSING_DISPLAY[crossing];
  const canonicalPath = buildArchivePath(locale, crossing, monthKey);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  // Aggregate all days in the month
  const daysInMonth = history.filter((h) => h.date.startsWith(monthKey));
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const d of daysInMonth) {
    const series = d.perCrossing[crossing];
    if (!Array.isArray(series)) continue;
    for (let h = 0; h < 24; h++) {
      const cell = series[h];
      if (cell) perHour[h].push(cell.avg);
    }
  }
  const hourAvgs = perHour.map((s) =>
    s.length === 0 ? null : Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  );
  const overallAvg =
    perHour.flat().length === 0
      ? null
      : Math.round(
          perHour.flat().reduce((a, b) => a + b, 0) / perHour.flat().length,
        );

  const h1 =
    locale === 'it'
      ? `Archivio tempi attesa ${crossingDisplay} — ${monthKey}`
      : locale === 'de'
        ? `Wartezeiten-Archiv ${crossingDisplay} — ${monthKey}`
        : locale === 'fr'
          ? `Archive temps d'attente ${crossingDisplay} — ${monthKey}`
          : `${crossingDisplay} wait-time archive — ${monthKey}`;

  const intro =
    locale === 'it'
      ? `Statistiche aggregate dei tempi di attesa al valico ${crossingDisplay} nel mese ${monthKey}. Media mensile: ${overallAvg === null ? '—' : overallAvg + ' min'}. I dati derivano dal monitoraggio TomTom ogni 15 minuti nelle ore di picco pendolare. Utile per pianificare viaggi futuri in base al comportamento storico osservato.`
      : locale === 'de'
        ? `Aggregierte Statistiken zu den Wartezeiten am Grenzübergang ${crossingDisplay} im Monat ${monthKey}. Monatsdurchschnitt: ${overallAvg === null ? '—' : overallAvg + ' Min.'}. Die Daten stammen aus der TomTom-Verkehrsüberwachung alle 15 Minuten während der Pendler-Stosszeiten. Nützlich, um zukünftige Fahrten basierend auf dem beobachteten historischen Verhalten zu planen.`
        : locale === 'fr'
          ? `Statistiques agrégées sur les temps d'attente au passage ${crossingDisplay} pour le mois ${monthKey}. Moyenne mensuelle : ${overallAvg === null ? '—' : overallAvg + ' min'}. Les données proviennent de la surveillance TomTom toutes les 15 minutes pendant les heures de pointe pendulaire. Utile pour planifier les futurs trajets en fonction du comportement historique observé.`
          : `Aggregated wait-time statistics at the ${crossingDisplay} crossing for month ${monthKey}. Monthly average: ${overallAvg === null ? '—' : overallAvg + ' min'}. Data comes from TomTom traffic monitoring every 15 minutes during commuter peak hours. Useful to plan future trips based on observed historical behaviour.`;

  const rows = hourAvgs
    .map(
      (v, h) => `<tr>
      <td style="${TABLE_CELL_STYLE}">${String(h).padStart(2, '0')}:00</td>
      <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${v === null ? '—' : v + ' min'}</td>
    </tr>`,
    )
    .join('');

  const title = `${h1} | Frontaliere Ticino`;
  const description = intro.slice(0, 180);

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: crossingDisplay,
        item: `${BASE_URL}${buildOggiPath(locale, crossing)}`,
      },
      { '@type': 'ListItem', position: 3, name: monthKey, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    dateModified: today.toISOString(),
  });

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
        <nav style="${BREADCRUMB_STYLE}" aria-label="Breadcrumb">
          <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
          <span> / </span>
          <a href="${BASE_URL}${buildOggiPath(locale, crossing)}" style="${BREADCRUMB_LINK_STYLE}">${esc(crossingDisplay)}</a>
          <span> / </span>
          <span>${esc(monthKey)}</span>
        </nav>
        <header style="margin-bottom:22px">
          <h1 style="${H1_STYLE}">${esc(h1)}</h1>
          <p style="${LEDE_STYLE}">${esc(intro)}</p>
        </header>
        <section>
          <h2 style="${H2_STYLE}">${esc(copy.hourlyTodayLabel)}</h2>
          <table style="${TABLE_STYLE};font-size:14px">
            <thead><tr>
              <th style="${TABLE_HEAD_STYLE}">Ora</th>
              <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.waitMinutesLabel)}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
      </article>`;

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: LOCALE_OG[locale],
    jsonLdScripts: [breadcrumbLd, webPageLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'guida', activeSubTab: 'border' },
  });
}

// ── Data readers ──────────────────────────────────────────────

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readHistory(rootDir: string): BorderWaitHistoryDay[] {
  const dir = np.join(rootDir, 'data', 'border-wait-history');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const days: BorderWaitHistoryDay[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(np.join(dir, f), 'utf-8');
      const parsed = JSON.parse(raw) as BorderWaitHistoryDay;
      if (parsed && typeof parsed.date === 'string') days.push(parsed);
    } catch {
      // skip malformed snapshot
    }
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}

// ── Pure generator ────────────────────────────────────────────

/**
 * Resolve the per-crossing webcam OG image URL.
 *
 * Looks up `dist/og/border-wait/{slug}.jpg` — written at build time by
 * `scripts/fetch-webcam-snapshots-for-og.mjs`. Returns the absolute canonical
 * URL when the file exists, else `undefined` (page falls back to site default
 * OG image). Safe to call from tests (returns `undefined` if distDir is
 * missing or the file cannot be stat'd).
 */
export function getWebcamOgImageUrl(
  crossing: BorderCrossingSlug,
  distDir: string | undefined,
): string | undefined {
  if (!distDir) return undefined;
  try {
    const filePath = np.join(distDir, 'og', 'border-wait', `${crossing}.jpg`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return undefined;
    return `${BASE_URL}/og/border-wait/${crossing}.jpg`;
  } catch {
    return undefined;
  }
}

export function generateBorderWaitPages(opts: {
  current: BorderWaitCurrent;
  history?: BorderWaitHistoryDay[];
  today?: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
  /**
   * Optional override for the per-crossing OG image lookup. Tests can inject
   * a fake map to simulate "snapshot present" without touching the filesystem.
   * When omitted, the plugin resolves snapshots from `{distDir}/og/border-wait/`.
   */
  ogImageUrlResolver?: (crossing: BorderCrossingSlug) => string | undefined;
}): Record<string, string> {
  const current = opts.current;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const resolveOgImage =
    opts.ogImageUrlResolver ?? ((c: BorderCrossingSlug) => getWebcamOgImageUrl(c, distDir));
  const pages: Record<string, string> = {};

  for (const locale of BORDER_WAIT_LOCALES) {
    // Build alternates for root, regions, crossings
    const buildRootAlternates = (): Record<BorderWaitLocale, string> => {
      const out: Record<BorderWaitLocale, string> = { it: '', en: '', de: '', fr: '' };
      for (const alt of BORDER_WAIT_LOCALES) out[alt] = buildRootHubPath(alt);
      return out;
    };
    const buildRegionAlternates = (region: BorderCrossingRegion): Record<BorderWaitLocale, string> => {
      const out: Record<BorderWaitLocale, string> = { it: '', en: '', de: '', fr: '' };
      for (const alt of BORDER_WAIT_LOCALES) out[alt] = buildRegionalHubPath(alt, region);
      return out;
    };
    const buildCrossingAlternates = (
      crossing: BorderCrossingSlug,
    ): Record<BorderWaitLocale, string> => {
      const out: Record<BorderWaitLocale, string> = { it: '', en: '', de: '', fr: '' };
      for (const alt of BORDER_WAIT_LOCALES) out[alt] = buildOggiPath(alt, crossing);
      return out;
    };

    // Root hub
    pages[buildRootHubPath(locale)] = renderHubPage({
      locale,
      current,
      today,
      alternates: buildRootAlternates(),
      distDir,
    });

    // Regional hubs
    for (const region of BORDER_WAIT_REGIONS) {
      pages[buildRegionalHubPath(locale, region)] = renderHubPage({
        locale,
        region,
        current,
        today,
        alternates: buildRegionAlternates(region),
        distDir,
      });
    }

    // Per-crossing leaf pages
    for (const crossing of BORDER_WAIT_CROSSINGS) {
      pages[buildOggiPath(locale, crossing)] = renderLeafPage({
        locale,
        crossing,
        current,
        history,
        today,
        alternates: buildCrossingAlternates(crossing),
        distDir,
        ogImageUrl: resolveOgImage(crossing),
      });
    }
  }

  return pages;
}

export function generateBorderWaitArchives(opts: {
  history: BorderWaitHistoryDay[];
  today?: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}): Record<string, string> {
  const history = opts.history;
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const currentMonth = today.toISOString().slice(0, 7);
  const pages: Record<string, string> = {};

  const monthsInHistory = new Set<string>();
  for (const d of history) {
    if (typeof d.date === 'string' && d.date.length >= 7) {
      monthsInHistory.add(d.date.slice(0, 7));
    }
  }

  for (const monthKey of monthsInHistory) {
    if (monthKey >= currentMonth) continue; // skip current/future months
    for (const locale of BORDER_WAIT_LOCALES) {
      for (const crossing of TOP_5_CROSSINGS) {
        const path = buildArchivePath(locale, crossing, monthKey);
        pages[path] = renderArchivePage({ locale, crossing, monthKey, history, today, distDir });
      }
    }
  }

  return pages;
}

// ── Plugin ────────────────────────────────────────────────────

interface PluginResult {
  pagesWritten: number;
  archivesWritten: number;
  skippedForWordCount: number;
}

export function borderWaitPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'border-wait-pages',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_BORDER_WAIT === '1') {
        console.log('\x1b[33m[border-wait-pages]\x1b[0m Skipped (SKIP_BORDER_WAIT=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');

      // Ext3 task 3 — wipe owned namespaces before regen so archive months
      // that fall out of the top-5 window (or crossings removed from the
      // dataset) don't leave stale pages behind.
      cleanNamespaces(distDir, [
        'traffico-dogane',
        'en/border-wait',
        'de/wartezeit-grenze',
        'fr/temps-attente-douane',
      ]);
      cleanSitemapFiles(distDir, ['sitemap-border-wait.xml']);

      const currentPath = np.resolve(rootDir, 'data', 'border-wait-current.json');
      const current = readJsonSafe<BorderWaitCurrent>(currentPath, {
        updatedAt: null,
        perCrossing: {},
      });
      const history = readHistory(rootDir);
      const today = new Date();

      // ── F8 social-virality: snapshot webcam frames for per-page og:image ──
      // Runs BEFORE page generation so `renderLeafPage` can detect the
      // produced JPEGs at `dist/og/border-wait/{slug}.jpg`. Errors are
      // logged and swallowed — the site's default og-image.png is a safe
      // fallback and the build must never be blocked by a transient webcam
      // outage. See scripts/fetch-webcam-snapshots-for-og.mjs for details.
      try {
        const { snapshotWebcamsForOg } = await import(
          '../scripts/fetch-webcam-snapshots-for-og.mjs'
        );
        const ogOutDir = np.join(distDir, 'og', 'border-wait');
        await snapshotWebcamsForOg({ crossings: borderCrossings, outDir: ogOutDir });
      } catch (err) {
        console.warn(
          '\x1b[33m[border-wait-pages]\x1b[0m og-webcam snapshot step failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }

      const pages = generateBorderWaitPages({ current, history, today, distDir });
      const archives = generateBorderWaitArchives({ history, today, distDir });

      const collector = new WriteCollector({ distDir });
      let pagesWritten = 0;
      let archivesWritten = 0;
      let skipped = 0;
      const sitemapPaths: string[] = [];

      for (const [path, html] of Object.entries(pages)) {
        const words = countHtmlBodyWords(html);
        if (words < MIN_INDEXABLE_WORDS) {
          skipped++;
          console.warn(`[border-wait-pages] thin content (${words} words) for ${path} — skipping`);
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        sitemapPaths.push(path);
        pagesWritten++;
      }

      for (const [path, html] of Object.entries(archives)) {
        const words = countHtmlBodyWords(html);
        if (words < MIN_INDEXABLE_WORDS) {
          skipped++;
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        sitemapPaths.push(path);
        archivesWritten++;
      }

      await collector.flush();

      // ── Emit sitemap-border-wait.xml ───────────────────────
      if (sitemapPaths.length > 0) {
        try {
          const dateStamp = today.toISOString().slice(0, 10);
          const urlEntries = sitemapPaths
            .map(
              (p) =>
                `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>hourly</changefreq>\n    <priority>0.8</priority>\n  </url>`,
            )
            .join('\n');
          const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>
`;
          fs.writeFileSync(np.join(distDir, 'sitemap-border-wait.xml'), sitemapXml, 'utf-8');
          console.log(
            `\x1b[36m[border-wait-pages]\x1b[0m Wrote sitemap-border-wait.xml (${sitemapPaths.length} URLs)`,
          );
        } catch (err) {
          console.warn('[border-wait-pages] failed to write sitemap-border-wait.xml', err);
        }
      }

      const result: PluginResult = {
        pagesWritten,
        archivesWritten,
        skippedForWordCount: skipped,
      };
      console.log(
        `\x1b[36m[border-wait-pages]\x1b[0m Generated ${result.pagesWritten} pages + ${result.archivesWritten} archives (skipped ${result.skippedForWordCount})`,
      );
    },
  };
}
