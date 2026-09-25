/**
 * Vite build plugin — CHF/EUR exchange SSG vertical (epic #4452, F1).
 *
 * Emits (all 4 locales, trailing slash, self-canonical, hreflang ×5):
 *   - 1 hub per locale        → /cambio-franco-euro/ (+ EN/DE/FR twins)
 *   - 20 amount pages per locale → /cambio-franco-euro/4000-franchi-in-euro/ …
 *   = 84 static HTML pages per build.
 *
 * Data source: data/exchange-rate-snapshot.json — committed snapshot refreshed
 * daily by .github/workflows/update-exchange-history.yml (pattern:
 * borderWaitPagesPlugin). The build NEVER hits Firestore. Missing/invalid
 * snapshot → plugin logs a warning and emits nothing (graceful degrade; the
 * committed snapshot makes this path unreachable in practice).
 *
 * Every page is emitted UNCONDITIONALLY (static curated amount set, no
 * data-driven floor → no `continue`-on-threshold → no below-floor bridge
 * needed). searchConsoleCompat.ts still self-maps the whole family via
 * isExchangeSsgPath (precompiled Set) so stale GSC 404 snapshots resolve.
 *
 * Contract: apply 'build', enforce 'post', emit in closeBundle(), pages via
 * buildSeoPageHtml (SPA shell + hydration), Tailwind utilities / semantic
 * tokens only, ≥50 indexable words hard-gated (static copy is ~400+ words).
 */

import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords, replaceRobotsMeta } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { buildDayStampIso } from './shared/buildDayStamp';
import { renderHreflangTags, renderSitemapHreflangTags } from './shared/hreflang';
import { WriteCollector } from './batchWrite';
import { cleanNamespaces, cleanSitemapFiles } from './shared/distNamespaceCleanup';
import { inlineScriptJson } from './shared/inlineJsonScript';
import {
  esc,
  H1_STYLE,
  LEDE_STYLE,
  H2_STYLE,
  BODY_STYLE,
  LINK_ACCENT_STYLE,
  SMALL_HEADING_STYLE,
  CARD_BODY_CLASS,
  CTA_PRIMARY_CLASS,
  TABLE_CLASS,
  TABLE_HEAD_CLASS,
  TABLE_CELL_CLASS,
  renderBreadcrumb,
  renderStatGrid,
  renderDiscoverMore,
  renderSparklineChart,
} from './shared/seoContentTokens';
import {
  EXCHANGE_LOCALES,
  EXCHANGE_AMOUNTS,
  EXCHANGE_SECTION_SLUG,
  buildExchangeHubPath,
  buildExchangeAmountPath,
  loadExchangeSnapshot,
  type ExchangeLocale,
  type ExchangeSnapshot,
} from './exchangeRateSsgData';
import { EXCHANGE_REFERRAL_PARTNERS } from '../services/exchangePartners';
import { SLUG_TABLES } from '../services/routeSlugs.data';

// ── Cross-feature paths (derived from shared SLUG_TABLES, #4315) ─

const CALCULATOR_PATH: Record<ExchangeLocale, string> = (['it', 'en', 'de', 'fr'] as const).reduce(
  (acc, locale) => {
    const prefix = locale === 'it' ? '' : `/${locale}`;
    acc[locale] = `${prefix}/${SLUG_TABLES[locale].calcolatore}/`;
    return acc;
  },
  {} as Record<ExchangeLocale, string>,
);

const SPA_COMPARATOR_PATH: Record<ExchangeLocale, string> = (['it', 'en', 'de', 'fr'] as const).reduce(
  (acc, locale) => {
    const prefix = locale === 'it' ? '' : `/${locale}`;
    acc[locale] = `${prefix}/${SLUG_TABLES[locale].confronti}/${SLUG_TABLES[locale].exchange}/`;
    return acc;
  },
  {} as Record<ExchangeLocale, string>,
);

// 'scenari'/'scenarios'/'szenarien' suffix is local to this exchange
// vertical (no SLUG_TABLES entry); only the calcolatore prefix is shared.
const SCENARIO_INDEX_PATH: Record<ExchangeLocale, string> = {
  it: `${CALCULATOR_PATH.it}scenari/`,
  en: `${CALCULATOR_PATH.en}scenarios/`,
  de: `${CALCULATOR_PATH.de}szenarien/`,
  fr: `${CALCULATOR_PATH.fr}scenarios/`,
};

const HOME_PATH: Record<ExchangeLocale, string> = {
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
};

const LOCALE_OG: Record<ExchangeLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const LOCALE_INTL: Record<ExchangeLocale, string> = {
  it: 'it-CH',
  en: 'en-GB',
  de: 'de-CH',
  fr: 'fr-CH',
};

// Indicative traditional-bank all-in cost used for the "hidden spread" scenario
// (matches the ~2.5–3% + flat fee band documented in CurrencyExchange.tsx's
// provider table for UBS/PostFinance/Intesa et al.).
const BANK_SPREAD_PCT = 2.8;
const BANK_FLAT_CHF = 5;
// Best low-cost partner all-in cost (Wise-band, see services/exchangePartners.ts).
const LOW_COST_PCT = Math.min(...EXCHANGE_REFERRAL_PARTNERS.map(p => p.typicalCostPct));

// Indicative net-salary band for a cross-border worker (source-tax + social
// contributions vary by canton / marital status / children — the page always
// links the real calculator instead of pretending precision).
const NET_BAND_LOW = 0.76;
const NET_BAND_HIGH = 0.84;

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtNum(locale: ExchangeLocale, n: number, digits = 0): string {
  return new Intl.NumberFormat(LOCALE_INTL[locale], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function fmtRate(locale: ExchangeLocale, n: number): string {
  return new Intl.NumberFormat(LOCALE_INTL[locale], {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(n);
}

function fmtPct(locale: ExchangeLocale, n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${new Intl.NumberFormat(LOCALE_INTL[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)}%`;
}

function fmtDate(locale: ExchangeLocale, iso: string): string {
  try {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString(LOCALE_INTL[locale], {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ── Localised copy ───────────────────────────────────────────────────────────

interface ExchangeCopy {
  breadcrumbHome: string;
  hubBreadcrumb: string;
  hubTitle: (rate: string) => string;
  hubDescription: (rate: string, date: string) => string;
  hubH1: string;
  hubLede: (rate: string) => string;
  tiles: {
    current: string;
    d30: string;
    d90: string;
    d365: string;
  };
  historyTitle: string;
  historyIntro: (min365: string, max365: string) => string;
  windowsTable: {
    caption: string;
    period: string;
    start: string;
    min: string;
    max: string;
    avg: string;
    change: string;
    p30: string;
    p90: string;
    p365: string;
  };
  monthlyTable: { caption: string; month: string; rate: string };
  sparklineLabel: string;
  salaryTitle: string;
  salaryBody: (rate: string) => string;
  salaryTips: ReadonlyArray<{ heading: string; body: string }>;
  feesTitle: string;
  feesIntro: (bankPct: string, lowPct: string) => string;
  feesTable: {
    provider: string;
    typicalCost: string;
    net4000: string;
    bankRow: string;
  };
  feesCtaText: string;
  feesCta: string;
  widgetNote: string;
  amountsTitle: string;
  amountsIntro: string;
  faqTitle: string;
  hubFaq: ReadonlyArray<{ q: string; a: string }>;
  // Amount pages
  amountBreadcrumb: (amount: string) => string;
  amountTitle: (amount: string, eur: string) => string;
  amountDescription: (amount: string, eur: string, rate: string, date: string) => string;
  amountH1: (amount: string) => string;
  amountLede: (amount: string, eur: string, rate: string) => string;
  amountTiles: {
    eurNow: string;
    rate: string;
    lowCostNet: string;
    bankNet: string;
  };
  conversionTitle: (amount: string) => string;
  conversionBody: (amount: string, eur: string, rate: string, date: string, eurMin: string, eurMax: string) => string;
  conversionTable: {
    caption: string;
    scenario: string;
    rate: string;
    eur: string;
    now: string;
    min365: string;
    max365: string;
    avg365: string;
  };
  feeScenarioTitle: string;
  feeScenarioBody: (
    amount: string,
    lowNet: string,
    bankNet: string,
    monthlyLoss: string,
    yearlyLoss: string,
  ) => string;
  netScenarioTitle: string;
  netScenarioBody: (amount: string, netLow: string, netHigh: string, netLowEur: string, netHighEur: string) => string;
  netScenarioCta: string;
  amountFaq: (
    amount: string,
    eur: string,
    rate: string,
    lowNet: string,
    bankNet: string,
    netLow: string,
    netHigh: string,
  ) => ReadonlyArray<{ q: string; a: string }>;
  otherAmountsTitle: string;
  backToHub: string;
  discoverCtas: ReadonlyArray<{ title: string; href: string }>;
  updatedLabel: string;
  sourceNote: string;
}

const COPY: Record<ExchangeLocale, ExchangeCopy> = {
  it: {
    breadcrumbHome: 'Home',
    hubBreadcrumb: 'Cambio franco euro',
    hubTitle: (rate) => `Cambio franco svizzero euro oggi: 1 CHF = ${rate} EUR`,
    hubDescription: (rate, date) =>
      `Tasso di cambio CHF/EUR aggiornato al ${date}: 1 franco = ${rate} euro. Storico 30/90/365 giorni, quando conviene cambiare lo stipendio da frontaliere e come evitare le commissioni nascoste.`,
    hubH1: 'Cambio franco svizzero → euro: tasso di oggi e storico',
    hubLede: (rate) => `Oggi 1 franco svizzero vale ${rate} euro (tasso interbancario BCE).`,
    tiles: { current: 'Tasso attuale', d30: 'Variazione 30 giorni', d90: 'Variazione 90 giorni', d365: 'Variazione 12 mesi' },
    historyTitle: 'Storico del cambio CHF/EUR',
    historyIntro: (min365, max365) =>
      `Negli ultimi 12 mesi il cambio franco-euro si è mosso tra un minimo di ${min365} e un massimo di ${max365}. La tabella riporta apertura, minimo, massimo e media per le tre finestre di osservazione più utili a chi riceve lo stipendio in franchi.`,
    windowsTable: {
      caption: 'Andamento del tasso CHF/EUR per finestra temporale',
      period: 'Periodo',
      start: 'Tasso iniziale',
      min: 'Minimo',
      max: 'Massimo',
      avg: 'Media',
      change: 'Variazione',
      p30: 'Ultimi 30 giorni',
      p90: 'Ultimi 90 giorni',
      p365: 'Ultimi 12 mesi',
    },
    monthlyTable: { caption: 'Tasso CHF/EUR a fine mese (ultimi 12 mesi)', month: 'Mese', rate: '1 CHF in EUR' },
    sparklineLabel: 'Andamento del cambio franco svizzero euro negli ultimi 12 mesi',
    salaryTitle: 'Quando cambiare lo stipendio da frontaliere',
    salaryBody: (rate) =>
      `Chi lavora in Svizzera e vive in Italia converte ogni mese una parte dello stipendio da franchi a euro: con un tasso a ${rate}, la scelta del momento e del canale di cambio incide sul bilancio familiare più di quanto sembri. Il tasso interbancario che vedi in questa pagina è il riferimento «reale»: nessun operatore te lo applica al 100%, ma i servizi specializzati si fermano a pochi decimi di punto, mentre gli sportelli bancari tradizionali trattengono il 2–3% tra spread e commissioni.`,
    salaryTips: [
      {
        heading: 'Non cambiare tutto lo stipendio',
        body: 'Converti solo la quota che spendi davvero in euro (mutuo, bollette, spesa). Quello che resta in franchi non paga commissioni e ti protegge se il franco si rafforza.',
      },
      {
        heading: 'Spalma le conversioni',
        body: 'Cambiare una cifra fissa ogni mese («piano di accumulo inverso») media il tasso nel tempo ed evita di concentrare il rischio in un singolo giorno sbagliato.',
      },
      {
        heading: 'Guarda lo spread, non solo il tasso',
        body: 'Il costo vero è la differenza tra il tasso interbancario e quello applicato, più le commissioni fisse. Un «cambio senza commissioni» con spread al 2% costa più di una commissione dichiarata dello 0,4%.',
      },
    ],
    feesTitle: 'Commissioni a confronto: dove si perde meno',
    feesIntro: (bankPct, lowPct) =>
      `Su un bonifico CHF→EUR una banca tradizionale trattiene in media il ${bankPct} tra spread e commissioni; i servizi specializzati scendono sotto lo ${lowPct}. La differenza, su uno stipendio convertito ogni mese, vale centinaia di euro l'anno.`,
    feesTable: {
      provider: 'Canale',
      typicalCost: 'Costo tipico',
      net4000: 'Netto su 4.000 CHF',
      bankRow: 'Banca tradizionale (sportello)',
    },
    feesCtaText:
      'Il comparatore calcola in tempo reale quanto ricevi con ogni operatore — spread, commissioni fisse e scaglioni inclusi — sull\'importo esatto che devi cambiare.',
    feesCta: 'Confronta tutti gli operatori',
    widgetNote:
      'Vuoi il tasso CHF/EUR sempre aggiornato sul tuo sito? Incorpora gratuitamente il nostro widget di cambio.',
    amountsTitle: 'Conversioni rapide: stipendi tipici in franchi',
    amountsIntro:
      'Le pagine dedicate mostrano per ogni importo la conversione al tasso di oggi, lo storico annuale e una stima del netto da frontaliere.',
    faqTitle: 'Domande frequenti',
    hubFaq: [
      {
        q: 'Quanto vale un franco svizzero in euro oggi?',
        a: 'Il valore aggiornato è indicato in cima a questa pagina: è il tasso interbancario di riferimento BCE, rinfrescato ogni giorno con il cron che alimenta anche il comparatore. Gli operatori applicano poi il proprio spread su questo valore.',
      },
      {
        q: 'Quando conviene cambiare i franchi in euro?',
        a: 'Nessuno può prevedere il cambio: la strategia più solida per un frontaliere è convertire una quota fissa ogni mese, così il tasso si media nel tempo. Le finestre di 30/90/365 giorni in questa pagina servono a capire se il momento attuale è sopra o sotto la media recente.',
      },
      {
        q: 'Qual è il modo più economico di convertire lo stipendio?',
        a: 'I servizi specializzati (Wise, Cambiavalute.ch, Revolut) applicano costi totali tra lo 0,3% e lo 0,5%, contro il 2–3% degli sportelli bancari tradizionali. Su 4.000 CHF al mese la differenza supera i 1.000 euro l\'anno.',
      },
      {
        q: 'Il tasso di questa pagina è quello che ricevo davvero?',
        a: 'No: è il tasso interbancario («mid-market»), il riferimento neutro tra domanda e offerta. Ogni operatore applica uno spread e/o commissioni. Usa il comparatore per vedere l\'importo netto reale con ciascun canale.',
      },
    ],
    amountBreadcrumb: (amount) => `${amount} franchi in euro`,
    amountTitle: (amount, eur) => `${amount} franchi svizzeri in euro: oggi ${eur} EUR`,
    amountDescription: (amount, eur, rate, date) =>
      `${amount} CHF equivalgono a ${eur} euro al tasso interbancario di oggi (${rate}, ${date}). Storico 12 mesi, costo reale del cambio e stima del netto per un frontaliere con questo stipendio.`,
    amountH1: (amount) => `${amount} franchi svizzeri in euro`,
    amountLede: (amount, eur, rate) => `${amount} CHF = ${eur} EUR al tasso interbancario di oggi (${rate}).`,
    amountTiles: {
      eurNow: 'Valore in euro oggi',
      rate: 'Tasso applicato',
      lowCostNet: 'Netto con servizio low-cost',
      bankNet: 'Netto in banca tradizionale',
    },
    conversionTitle: (amount) => `Quanto valgono ${amount} franchi in euro`,
    conversionBody: (amount, eur, rate, date, eurMin, eurMax) =>
      `Al tasso interbancario di oggi (${rate}, aggiornato al ${date}) ${amount} franchi svizzeri equivalgono a ${eur} euro. Nell'ultimo anno lo stesso importo sarebbe valso da un minimo di ${eurMin} a un massimo di ${eurMax} euro: una forbice che mostra quanto il momento della conversione pesi sul risultato finale.`,
    conversionTable: {
      caption: 'Controvalore ai tassi degli ultimi 12 mesi',
      scenario: 'Scenario',
      rate: 'Tasso',
      eur: 'Controvalore',
      now: 'Tasso di oggi',
      min365: 'Minimo 12 mesi',
      max365: 'Massimo 12 mesi',
      avg365: 'Media 12 mesi',
    },
    feeScenarioTitle: 'Quanto ricevi davvero: commissioni a confronto',
    feeScenarioBody: (amount, lowNet, bankNet, monthlyLoss, yearlyLoss) =>
      `Il tasso interbancario è solo il punto di partenza: contano spread e commissioni del canale scelto. Convertendo ${amount} CHF con un servizio specializzato ricevi circa ${lowNet} euro; allo sportello di una banca tradizionale circa ${bankNet} euro. Sono ${monthlyLoss} euro di differenza a operazione: se è il tuo stipendio mensile, oltre ${yearlyLoss} euro l'anno lasciati in commissioni.`,
    netScenarioTitle: 'Stipendio lordo o netto? Lo scenario frontaliere',
    netScenarioBody: (amount, netLow, netHigh, netLowEur, netHighEur) =>
      `Se ${amount} CHF è il tuo stipendio lordo mensile in Svizzera, il netto tipico di un frontaliere — dopo imposta alla fonte, AVS/AI/IPG, disoccupazione e cassa pensione — si colloca tra ${netLow} e ${netHigh} franchi, cioè tra circa ${netLowEur} e ${netHighEur} euro al tasso attuale. La forbice dipende da cantone, stato civile, figli a carico e franchigia: il calcolatore la restringe alla tua situazione reale in un minuto.`,
    netScenarioCta: 'Calcola il tuo netto esatto',
    amountFaq: (amount, eur, rate, lowNet, bankNet, netLow, netHigh) => [
      {
        q: `Quanto valgono ${amount} franchi svizzeri in euro?`,
        a: `Al tasso interbancario di oggi (${rate}) ${amount} CHF valgono ${eur} euro. Il valore si aggiorna ogni giorno con i tassi di riferimento BCE.`,
      },
      {
        q: `Quanti euro ricevo davvero cambiando ${amount} CHF?`,
        a: `Dipende dal canale: con un servizio specializzato circa ${lowNet} euro, allo sportello di una banca tradizionale circa ${bankNet} euro. La differenza è il costo nascosto dello spread.`,
      },
      {
        q: `${amount} CHF lordi al mese: quanto resta in tasca a un frontaliere?`,
        a: `Indicativamente tra ${netLow} e ${netHigh} franchi netti, a seconda di cantone di lavoro, stato civile e figli. Usa il calcolatore per la stima puntuale sulla tua busta paga.`,
      },
    ],
    otherAmountsTitle: 'Altri importi',
    backToHub: 'Torna al cambio franco euro',
    discoverCtas: [
      { title: 'Calcola lo stipendio netto', href: CALCULATOR_PATH.it },
      { title: 'Confronta i servizi di cambio', href: SPA_COMPARATOR_PATH.it },
      { title: 'Scenari stipendio frontaliere', href: SCENARIO_INDEX_PATH.it },
      { title: 'Offerte di lavoro in Ticino', href: '/cerca-lavoro-ticino/' },
    ],
    updatedLabel: 'Aggiornato al',
    sourceNote: 'Fonte: tassi di riferimento BCE (via Frankfurter/Firestore), aggiornamento giornaliero automatico.',
  },
  en: {
    breadcrumbHome: 'Home',
    hubBreadcrumb: 'CHF/EUR exchange',
    hubTitle: (rate) => `Swiss franc to euro today: 1 CHF = ${rate} EUR`,
    hubDescription: (rate, date) =>
      `CHF/EUR exchange rate updated ${date}: 1 Swiss franc = ${rate} euro. 30/90/365-day history, when cross-border workers should convert their salary, and how to avoid hidden fees.`,
    hubH1: 'Swiss franc → euro: today\'s rate and history',
    hubLede: (rate) => `Today 1 Swiss franc is worth ${rate} euro (ECB mid-market rate).`,
    tiles: { current: 'Current rate', d30: '30-day change', d90: '90-day change', d365: '12-month change' },
    historyTitle: 'CHF/EUR rate history',
    historyIntro: (min365, max365) =>
      `Over the last 12 months the franc-euro rate moved between a low of ${min365} and a high of ${max365}. The table shows opening, low, high and average for the three windows most useful to anyone paid in francs.`,
    windowsTable: {
      caption: 'CHF/EUR rate by observation window',
      period: 'Period',
      start: 'Opening rate',
      min: 'Low',
      max: 'High',
      avg: 'Average',
      change: 'Change',
      p30: 'Last 30 days',
      p90: 'Last 90 days',
      p365: 'Last 12 months',
    },
    monthlyTable: { caption: 'Month-end CHF/EUR rate (last 12 months)', month: 'Month', rate: '1 CHF in EUR' },
    sparklineLabel: 'Swiss franc to euro exchange rate over the last 12 months',
    salaryTitle: 'When should a cross-border worker convert their salary?',
    salaryBody: (rate) =>
      `Anyone working in Switzerland and living in Italy converts part of their salary from francs to euro every month: at ${rate}, the timing and the channel you pick affect your family budget more than most people think. The mid-market rate on this page is the neutral benchmark: no provider gives it to you in full, but specialised services stay within a few tenths of a percent, while traditional bank counters keep 2–3% between spread and fees.`,
    salaryTips: [
      {
        heading: 'Don\'t convert the whole salary',
        body: 'Exchange only what you actually spend in euro (mortgage, bills, groceries). What stays in francs pays no fees and protects you if the franc strengthens.',
      },
      {
        heading: 'Spread your conversions',
        body: 'Converting a fixed amount every month averages the rate over time and avoids concentrating the risk on a single bad day.',
      },
      {
        heading: 'Watch the spread, not just the rate',
        body: 'The real cost is the gap between the mid-market rate and the one applied, plus flat fees. A "zero-commission" exchange with a 2% spread costs more than a declared 0.4% fee.',
      },
    ],
    feesTitle: 'Fees compared: where you lose the least',
    feesIntro: (bankPct, lowPct) =>
      `On a CHF→EUR transfer a traditional bank keeps on average ${bankPct} between spread and fees; specialised services stay under ${lowPct}. On a salary converted every month, that difference is worth hundreds of euro a year.`,
    feesTable: {
      provider: 'Channel',
      typicalCost: 'Typical cost',
      net4000: 'Net on 4,000 CHF',
      bankRow: 'Traditional bank (counter)',
    },
    feesCtaText:
      'The comparator computes in real time what you receive with each provider — spread, flat fees and volume brackets included — on the exact amount you need to convert.',
    feesCta: 'Compare all providers',
    widgetNote: 'Want the live CHF/EUR rate on your website? Embed our free exchange-rate widget.',
    amountsTitle: 'Quick conversions: typical salaries in francs',
    amountsIntro:
      'Each dedicated page shows the conversion at today\'s rate, the yearly history and an estimated cross-border net for that amount.',
    faqTitle: 'Frequently asked questions',
    hubFaq: [
      {
        q: 'How much is one Swiss franc worth in euro today?',
        a: 'The updated value is at the top of this page: it is the ECB mid-market reference rate, refreshed daily by the same cron that feeds the interactive comparator. Providers then apply their own spread on top of it.',
      },
      {
        q: 'When is the best moment to convert francs to euro?',
        a: 'Nobody can predict the exchange rate: the most robust strategy for a cross-border worker is converting a fixed amount every month, averaging the rate over time. The 30/90/365-day windows on this page tell you whether today sits above or below the recent average.',
      },
      {
        q: 'What is the cheapest way to convert a salary?',
        a: 'Specialised services (Wise, Cambiavalute.ch, Revolut) charge an all-in 0.3–0.5%, against 2–3% at traditional bank counters. On 4,000 CHF a month the gap exceeds 1,000 euro a year.',
      },
      {
        q: 'Is the rate on this page what I actually get?',
        a: 'No: it is the mid-market rate, the neutral midpoint between buy and sell. Every provider applies a spread and/or fees. Use the comparator to see the real net amount per channel.',
      },
    ],
    amountBreadcrumb: (amount) => `${amount} CHF to EUR`,
    amountTitle: (amount, eur) => `${amount} Swiss francs to euro: ${eur} EUR today`,
    amountDescription: (amount, eur, rate, date) =>
      `${amount} CHF equals ${eur} euro at today's mid-market rate (${rate}, ${date}). 12-month history, real conversion cost and estimated cross-border net for this salary.`,
    amountH1: (amount) => `${amount} Swiss francs in euro`,
    amountLede: (amount, eur, rate) => `${amount} CHF = ${eur} EUR at today's mid-market rate (${rate}).`,
    amountTiles: {
      eurNow: 'Euro value today',
      rate: 'Applied rate',
      lowCostNet: 'Net via low-cost service',
      bankNet: 'Net via traditional bank',
    },
    conversionTitle: (amount) => `What ${amount} francs are worth in euro`,
    conversionBody: (amount, eur, rate, date, eurMin, eurMax) =>
      `At today's mid-market rate (${rate}, updated ${date}) ${amount} Swiss francs equal ${eur} euro. Over the last year the same amount would have been worth from ${eurMin} to ${eurMax} euro — a range that shows how much conversion timing matters.`,
    conversionTable: {
      caption: 'Countervalue at the last 12 months\' rates',
      scenario: 'Scenario',
      rate: 'Rate',
      eur: 'Countervalue',
      now: 'Today\'s rate',
      min365: '12-month low',
      max365: '12-month high',
      avg365: '12-month average',
    },
    feeScenarioTitle: 'What you actually receive: fees compared',
    feeScenarioBody: (amount, lowNet, bankNet, monthlyLoss, yearlyLoss) =>
      `The mid-market rate is only the starting point: the channel's spread and fees decide the outcome. Converting ${amount} CHF through a specialised service yields about ${lowNet} euro; at a traditional bank counter about ${bankNet} euro. That is ${monthlyLoss} euro per transfer — if this is your monthly salary, over ${yearlyLoss} euro a year left in fees.`,
    netScenarioTitle: 'Gross or net? The cross-border scenario',
    netScenarioBody: (amount, netLow, netHigh, netLowEur, netHighEur) =>
      `If ${amount} CHF is your gross monthly Swiss salary, the typical cross-border net — after source tax, AHV/IV/EO, unemployment insurance and pension fund — lands between ${netLow} and ${netHigh} francs, i.e. roughly ${netLowEur} to ${netHighEur} euro at today's rate. The band depends on canton, marital status, children and deductible: the calculator narrows it to your real situation in a minute.`,
    netScenarioCta: 'Compute your exact net salary',
    amountFaq: (amount, eur, rate, lowNet, bankNet, netLow, netHigh) => [
      {
        q: `How much is ${amount} Swiss francs in euro?`,
        a: `At today's mid-market rate (${rate}) ${amount} CHF is worth ${eur} euro. The value refreshes daily with ECB reference rates.`,
      },
      {
        q: `How many euro do I actually receive converting ${amount} CHF?`,
        a: `It depends on the channel: about ${lowNet} euro with a specialised service, about ${bankNet} euro at a traditional bank counter. The gap is the hidden cost of the spread.`,
      },
      {
        q: `${amount} CHF gross per month: what does a cross-border worker take home?`,
        a: `Roughly between ${netLow} and ${netHigh} francs net, depending on the canton, marital status and children. Use the calculator for a precise estimate on your payslip.`,
      },
    ],
    otherAmountsTitle: 'Other amounts',
    backToHub: 'Back to CHF/EUR exchange',
    discoverCtas: [
      { title: 'Calculate your net salary', href: CALCULATOR_PATH.en },
      { title: 'Compare exchange services', href: SPA_COMPARATOR_PATH.en },
      { title: 'Cross-border salary scenarios', href: SCENARIO_INDEX_PATH.en },
      { title: 'Job openings in Ticino', href: '/en/find-jobs-ticino/' },
    ],
    updatedLabel: 'Updated',
    sourceNote: 'Source: ECB reference rates (via Frankfurter/Firestore), refreshed automatically every day.',
  },
  de: {
    breadcrumbHome: 'Home',
    hubBreadcrumb: 'Franken-Euro-Kurs',
    hubTitle: (rate) => `Schweizer Franken in Euro heute: 1 CHF = ${rate} EUR`,
    hubDescription: (rate, date) =>
      `CHF/EUR-Wechselkurs, aktualisiert am ${date}: 1 Franken = ${rate} Euro. Verlauf über 30/90/365 Tage, wann Grenzgänger den Lohn wechseln sollten und wie man versteckte Gebühren vermeidet.`,
    hubH1: 'Schweizer Franken → Euro: aktueller Kurs und Verlauf',
    hubLede: (rate) => `Heute ist 1 Schweizer Franken ${rate} Euro wert (EZB-Interbankenkurs).`,
    tiles: { current: 'Aktueller Kurs', d30: 'Veränderung 30 Tage', d90: 'Veränderung 90 Tage', d365: 'Veränderung 12 Monate' },
    historyTitle: 'Kursverlauf CHF/EUR',
    historyIntro: (min365, max365) =>
      `In den letzten 12 Monaten bewegte sich der Franken-Euro-Kurs zwischen einem Tief von ${min365} und einem Hoch von ${max365}. Die Tabelle zeigt Eröffnung, Tief, Hoch und Durchschnitt für die drei wichtigsten Beobachtungsfenster.`,
    windowsTable: {
      caption: 'CHF/EUR-Kurs nach Beobachtungsfenster',
      period: 'Zeitraum',
      start: 'Anfangskurs',
      min: 'Tief',
      max: 'Hoch',
      avg: 'Durchschnitt',
      change: 'Veränderung',
      p30: 'Letzte 30 Tage',
      p90: 'Letzte 90 Tage',
      p365: 'Letzte 12 Monate',
    },
    monthlyTable: { caption: 'CHF/EUR-Kurs zum Monatsende (letzte 12 Monate)', month: 'Monat', rate: '1 CHF in EUR' },
    sparklineLabel: 'Wechselkurs Schweizer Franken zu Euro in den letzten 12 Monaten',
    salaryTitle: 'Wann sollten Grenzgänger den Lohn wechseln?',
    salaryBody: (rate) =>
      `Wer in der Schweiz arbeitet und in Italien lebt, wechselt jeden Monat einen Teil des Lohns von Franken in Euro: Bei einem Kurs von ${rate} beeinflussen Zeitpunkt und Kanal das Familienbudget stärker als gedacht. Der Interbankenkurs auf dieser Seite ist die neutrale Referenz: Kein Anbieter gibt ihn vollständig weiter, aber spezialisierte Dienste bleiben wenige Zehntelprozent darunter, während traditionelle Bankschalter 2–3% zwischen Spread und Gebühren einbehalten.`,
    salaryTips: [
      {
        heading: 'Nicht den ganzen Lohn wechseln',
        body: 'Wechseln Sie nur den Betrag, den Sie tatsächlich in Euro ausgeben (Hypothek, Rechnungen, Einkäufe). Was in Franken bleibt, zahlt keine Gebühren und schützt Sie, wenn der Franken erstarkt.',
      },
      {
        heading: 'Wechsel über die Zeit verteilen',
        body: 'Jeden Monat einen festen Betrag zu wechseln mittelt den Kurs über die Zeit und vermeidet das Risiko eines einzelnen schlechten Tages.',
      },
      {
        heading: 'Auf den Spread achten, nicht nur auf den Kurs',
        body: 'Die echten Kosten sind die Differenz zwischen Interbankenkurs und angewandtem Kurs plus Fixgebühren. Ein «gebührenfreier» Wechsel mit 2% Spread kostet mehr als eine deklarierte Gebühr von 0,4%.',
      },
    ],
    feesTitle: 'Gebühren im Vergleich: wo Sie am wenigsten verlieren',
    feesIntro: (bankPct, lowPct) =>
      `Bei einer CHF→EUR-Überweisung behält eine traditionelle Bank im Schnitt ${bankPct} zwischen Spread und Gebühren ein; spezialisierte Dienste bleiben unter ${lowPct}. Bei einem monatlich gewechselten Lohn sind das Hunderte Euro pro Jahr.`,
    feesTable: {
      provider: 'Kanal',
      typicalCost: 'Typische Kosten',
      net4000: 'Netto auf 4.000 CHF',
      bankRow: 'Traditionelle Bank (Schalter)',
    },
    feesCtaText:
      'Der Vergleichsrechner berechnet in Echtzeit, wie viel Sie bei jedem Anbieter erhalten — inklusive Spread, Fixgebühren und Mengenstaffeln — für den exakten Betrag, den Sie wechseln möchten.',
    feesCta: 'Alle Anbieter vergleichen',
    widgetNote: 'Möchten Sie den aktuellen CHF/EUR-Kurs auf Ihrer Website? Binden Sie unser kostenloses Kurs-Widget ein.',
    amountsTitle: 'Schnellumrechnung: typische Löhne in Franken',
    amountsIntro:
      'Jede Detailseite zeigt für den Betrag die Umrechnung zum heutigen Kurs, den Jahresverlauf und eine Netto-Schätzung für Grenzgänger.',
    faqTitle: 'Häufige Fragen',
    hubFaq: [
      {
        q: 'Wie viel ist ein Schweizer Franken heute in Euro wert?',
        a: 'Der aktuelle Wert steht oben auf dieser Seite: Es ist der EZB-Interbanken-Referenzkurs, täglich aktualisiert durch denselben Cron, der auch den interaktiven Vergleichsrechner speist. Anbieter schlagen darauf ihren eigenen Spread auf.',
      },
      {
        q: 'Wann ist der beste Zeitpunkt, Franken in Euro zu wechseln?',
        a: 'Niemand kann den Wechselkurs vorhersagen: Die robusteste Strategie für Grenzgänger ist, jeden Monat einen festen Betrag zu wechseln und so den Kurs zu mitteln. Die 30/90/365-Tage-Fenster zeigen, ob der heutige Kurs über oder unter dem jüngsten Durchschnitt liegt.',
      },
      {
        q: 'Was ist der günstigste Weg, den Lohn zu wechseln?',
        a: 'Spezialisierte Dienste (Wise, Cambiavalute.ch, Revolut) kosten insgesamt 0,3–0,5%, gegenüber 2–3% am traditionellen Bankschalter. Bei 4.000 CHF pro Monat übersteigt die Differenz 1.000 Euro pro Jahr.',
      },
      {
        q: 'Ist der Kurs auf dieser Seite der, den ich wirklich erhalte?',
        a: 'Nein: Es ist der Interbankenkurs, der neutrale Mittelwert zwischen Kauf und Verkauf. Jeder Anbieter wendet Spread und/oder Gebühren an. Nutzen Sie den Vergleichsrechner für den realen Nettobetrag pro Kanal.',
      },
    ],
    amountBreadcrumb: (amount) => `${amount} Franken in Euro`,
    amountTitle: (amount, eur) => `${amount} Schweizer Franken in Euro: heute ${eur} EUR`,
    amountDescription: (amount, eur, rate, date) =>
      `${amount} CHF entsprechen ${eur} Euro zum heutigen Interbankenkurs (${rate}, ${date}). 12-Monats-Verlauf, echte Wechselkosten und Netto-Schätzung für Grenzgänger mit diesem Lohn.`,
    amountH1: (amount) => `${amount} Schweizer Franken in Euro`,
    amountLede: (amount, eur, rate) => `${amount} CHF = ${eur} EUR zum heutigen Interbankenkurs (${rate}).`,
    amountTiles: {
      eurNow: 'Euro-Wert heute',
      rate: 'Angewandter Kurs',
      lowCostNet: 'Netto mit Low-Cost-Dienst',
      bankNet: 'Netto bei traditioneller Bank',
    },
    conversionTitle: (amount) => `Was ${amount} Franken in Euro wert sind`,
    conversionBody: (amount, eur, rate, date, eurMin, eurMax) =>
      `Zum heutigen Interbankenkurs (${rate}, aktualisiert am ${date}) entsprechen ${amount} Schweizer Franken ${eur} Euro. Im letzten Jahr wäre derselbe Betrag zwischen ${eurMin} und ${eurMax} Euro wert gewesen — eine Spanne, die zeigt, wie stark der Zeitpunkt des Wechsels zählt.`,
    conversionTable: {
      caption: 'Gegenwert zu den Kursen der letzten 12 Monate',
      scenario: 'Szenario',
      rate: 'Kurs',
      eur: 'Gegenwert',
      now: 'Heutiger Kurs',
      min365: '12-Monats-Tief',
      max365: '12-Monats-Hoch',
      avg365: '12-Monats-Durchschnitt',
    },
    feeScenarioTitle: 'Was Sie wirklich erhalten: Gebühren im Vergleich',
    feeScenarioBody: (amount, lowNet, bankNet, monthlyLoss, yearlyLoss) =>
      `Der Interbankenkurs ist nur der Ausgangspunkt: Spread und Gebühren des Kanals entscheiden. Beim Wechsel von ${amount} CHF über einen spezialisierten Dienst erhalten Sie rund ${lowNet} Euro; am Schalter einer traditionellen Bank rund ${bankNet} Euro. Das sind ${monthlyLoss} Euro Unterschied pro Transaktion — beim Monatslohn über ${yearlyLoss} Euro pro Jahr, die in Gebühren bleiben.`,
    netScenarioTitle: 'Brutto oder netto? Das Grenzgänger-Szenario',
    netScenarioBody: (amount, netLow, netHigh, netLowEur, netHighEur) =>
      `Wenn ${amount} CHF Ihr Schweizer Bruttomonatslohn ist, liegt das typische Grenzgänger-Netto — nach Quellensteuer, AHV/IV/EO, Arbeitslosenversicherung und Pensionskasse — zwischen ${netLow} und ${netHigh} Franken, also etwa ${netLowEur} bis ${netHighEur} Euro zum aktuellen Kurs. Die Spanne hängt von Kanton, Zivilstand, Kindern und Franchise ab: Der Rechner grenzt sie in einer Minute auf Ihre reale Situation ein.`,
    netScenarioCta: 'Ihr exaktes Netto berechnen',
    amountFaq: (amount, eur, rate, lowNet, bankNet, netLow, netHigh) => [
      {
        q: `Wie viel sind ${amount} Schweizer Franken in Euro?`,
        a: `Zum heutigen Interbankenkurs (${rate}) sind ${amount} CHF ${eur} Euro wert. Der Wert wird täglich mit den EZB-Referenzkursen aktualisiert.`,
      },
      {
        q: `Wie viele Euro erhalte ich wirklich beim Wechsel von ${amount} CHF?`,
        a: `Das hängt vom Kanal ab: rund ${lowNet} Euro mit einem spezialisierten Dienst, rund ${bankNet} Euro am traditionellen Bankschalter. Die Differenz sind die versteckten Spread-Kosten.`,
      },
      {
        q: `${amount} CHF brutto pro Monat: Was bleibt einem Grenzgänger netto?`,
        a: `Ungefähr zwischen ${netLow} und ${netHigh} Franken netto, je nach Arbeitskanton, Zivilstand und Kindern. Nutzen Sie den Rechner für die genaue Schätzung Ihrer Lohnabrechnung.`,
      },
    ],
    otherAmountsTitle: 'Weitere Beträge',
    backToHub: 'Zurück zum Franken-Euro-Kurs',
    discoverCtas: [
      { title: 'Nettolohn berechnen', href: CALCULATOR_PATH.de },
      { title: 'Wechseldienste vergleichen', href: SPA_COMPARATOR_PATH.de },
      { title: 'Grenzgänger-Lohnszenarien', href: SCENARIO_INDEX_PATH.de },
      { title: 'Stellenangebote im Tessin', href: '/de/jobs-im-tessin/' },
    ],
    updatedLabel: 'Aktualisiert am',
    sourceNote: 'Quelle: EZB-Referenzkurse (via Frankfurter/Firestore), automatische tägliche Aktualisierung.',
  },
  fr: {
    breadcrumbHome: 'Home',
    hubBreadcrumb: 'Change franc-euro',
    hubTitle: (rate) => `Franc suisse en euro aujourd'hui : 1 CHF = ${rate} EUR`,
    hubDescription: (rate, date) =>
      `Taux de change CHF/EUR mis à jour le ${date} : 1 franc = ${rate} euro. Historique 30/90/365 jours, quand les frontaliers devraient changer leur salaire et comment éviter les frais cachés.`,
    hubH1: 'Franc suisse → euro : taux du jour et historique',
    hubLede: (rate) => `Aujourd'hui 1 franc suisse vaut ${rate} euro (taux interbancaire BCE).`,
    tiles: { current: 'Taux actuel', d30: 'Variation 30 jours', d90: 'Variation 90 jours', d365: 'Variation 12 mois' },
    historyTitle: 'Historique du taux CHF/EUR',
    historyIntro: (min365, max365) =>
      `Sur les 12 derniers mois, le taux franc-euro a oscillé entre un minimum de ${min365} et un maximum de ${max365}. Le tableau montre l'ouverture, le minimum, le maximum et la moyenne pour les trois fenêtres les plus utiles à qui est payé en francs.`,
    windowsTable: {
      caption: 'Taux CHF/EUR par fenêtre d\'observation',
      period: 'Période',
      start: 'Taux initial',
      min: 'Minimum',
      max: 'Maximum',
      avg: 'Moyenne',
      change: 'Variation',
      p30: '30 derniers jours',
      p90: '90 derniers jours',
      p365: '12 derniers mois',
    },
    monthlyTable: { caption: 'Taux CHF/EUR en fin de mois (12 derniers mois)', month: 'Mois', rate: '1 CHF en EUR' },
    sparklineLabel: 'Taux de change franc suisse-euro sur les 12 derniers mois',
    salaryTitle: 'Quand un frontalier devrait-il changer son salaire ?',
    salaryBody: (rate) =>
      `Qui travaille en Suisse et vit en Italie convertit chaque mois une partie de son salaire de francs en euros : à ${rate}, le moment et le canal choisis pèsent sur le budget familial plus qu'on ne le croit. Le taux interbancaire de cette page est la référence neutre : aucun opérateur ne l'applique à 100%, mais les services spécialisés restent à quelques dixièmes de point, tandis que les guichets bancaires traditionnels retiennent 2–3% entre spread et commissions.`,
    salaryTips: [
      {
        heading: 'Ne changez pas tout le salaire',
        body: 'Convertissez seulement ce que vous dépensez réellement en euros (crédit, factures, courses). Ce qui reste en francs ne paie pas de frais et vous protège si le franc se renforce.',
      },
      {
        heading: 'Étalez vos conversions',
        body: 'Changer un montant fixe chaque mois lisse le taux dans le temps et évite de concentrer le risque sur un seul mauvais jour.',
      },
      {
        heading: 'Regardez le spread, pas seulement le taux',
        body: 'Le vrai coût est l\'écart entre le taux interbancaire et celui appliqué, plus les frais fixes. Un change «sans commission» avec 2% de spread coûte plus qu\'une commission déclarée de 0,4%.',
      },
    ],
    feesTitle: 'Frais comparés : où perd-on le moins',
    feesIntro: (bankPct, lowPct) =>
      `Sur un virement CHF→EUR, une banque traditionnelle retient en moyenne ${bankPct} entre spread et commissions ; les services spécialisés restent sous ${lowPct}. Sur un salaire converti chaque mois, la différence vaut des centaines d'euros par an.`,
    feesTable: {
      provider: 'Canal',
      typicalCost: 'Coût typique',
      net4000: 'Net sur 4 000 CHF',
      bankRow: 'Banque traditionnelle (guichet)',
    },
    feesCtaText:
      'Le comparateur calcule en temps réel ce que vous recevez avec chaque opérateur — spread, frais fixes et paliers inclus — sur le montant exact à convertir.',
    feesCta: 'Comparer tous les opérateurs',
    widgetNote: 'Envie du taux CHF/EUR en direct sur votre site ? Intégrez gratuitement notre widget de change.',
    amountsTitle: 'Conversions rapides : salaires typiques en francs',
    amountsIntro:
      'Chaque page dédiée montre la conversion au taux du jour, l\'historique annuel et une estimation du net frontalier pour ce montant.',
    faqTitle: 'Questions fréquentes',
    hubFaq: [
      {
        q: 'Combien vaut un franc suisse en euro aujourd\'hui ?',
        a: 'La valeur à jour figure en haut de cette page : c\'est le taux interbancaire de référence BCE, rafraîchi chaque jour par le même cron qui alimente le comparateur interactif. Les opérateurs y ajoutent ensuite leur propre spread.',
      },
      {
        q: 'Quel est le meilleur moment pour changer des francs en euros ?',
        a: 'Personne ne peut prédire le taux de change : la stratégie la plus solide pour un frontalier est de convertir un montant fixe chaque mois, en lissant le taux dans le temps. Les fenêtres 30/90/365 jours indiquent si le taux du jour est au-dessus ou en dessous de la moyenne récente.',
      },
      {
        q: 'Quel est le moyen le moins cher de convertir un salaire ?',
        a: 'Les services spécialisés (Wise, Cambiavalute.ch, Revolut) coûtent au total 0,3–0,5%, contre 2–3% aux guichets bancaires traditionnels. Sur 4 000 CHF par mois, l\'écart dépasse 1 000 euros par an.',
      },
      {
        q: 'Le taux de cette page est-il celui que je reçois vraiment ?',
        a: 'Non : c\'est le taux interbancaire («mid-market»), le point médian neutre entre achat et vente. Chaque opérateur applique un spread et/ou des frais. Utilisez le comparateur pour voir le montant net réel par canal.',
      },
    ],
    amountBreadcrumb: (amount) => `${amount} francs en euros`,
    amountTitle: (amount, eur) => `${amount} francs suisses en euros : ${eur} EUR aujourd'hui`,
    amountDescription: (amount, eur, rate, date) =>
      `${amount} CHF équivalent à ${eur} euros au taux interbancaire du jour (${rate}, ${date}). Historique 12 mois, coût réel du change et estimation du net frontalier pour ce salaire.`,
    amountH1: (amount) => `${amount} francs suisses en euros`,
    amountLede: (amount, eur, rate) => `${amount} CHF = ${eur} EUR au taux interbancaire du jour (${rate}).`,
    amountTiles: {
      eurNow: 'Valeur en euros aujourd\'hui',
      rate: 'Taux appliqué',
      lowCostNet: 'Net via service low-cost',
      bankNet: 'Net via banque traditionnelle',
    },
    conversionTitle: (amount) => `Ce que valent ${amount} francs en euros`,
    conversionBody: (amount, eur, rate, date, eurMin, eurMax) =>
      `Au taux interbancaire du jour (${rate}, mis à jour le ${date}), ${amount} francs suisses équivalent à ${eur} euros. Sur la dernière année, le même montant aurait valu de ${eurMin} à ${eurMax} euros — une fourchette qui montre combien le moment de la conversion compte.`,
    conversionTable: {
      caption: 'Contre-valeur aux taux des 12 derniers mois',
      scenario: 'Scénario',
      rate: 'Taux',
      eur: 'Contre-valeur',
      now: 'Taux du jour',
      min365: 'Minimum 12 mois',
      max365: 'Maximum 12 mois',
      avg365: 'Moyenne 12 mois',
    },
    feeScenarioTitle: 'Ce que vous recevez vraiment : frais comparés',
    feeScenarioBody: (amount, lowNet, bankNet, monthlyLoss, yearlyLoss) =>
      `Le taux interbancaire n'est que le point de départ : le spread et les frais du canal décident du résultat. En convertissant ${amount} CHF via un service spécialisé, vous recevez environ ${lowNet} euros ; au guichet d'une banque traditionnelle, environ ${bankNet} euros. Soit ${monthlyLoss} euros d'écart par opération — si c'est votre salaire mensuel, plus de ${yearlyLoss} euros par an laissés en frais.`,
    netScenarioTitle: 'Brut ou net ? Le scénario frontalier',
    netScenarioBody: (amount, netLow, netHigh, netLowEur, netHighEur) =>
      `Si ${amount} CHF est votre salaire brut mensuel suisse, le net typique d'un frontalier — après impôt à la source, AVS/AI/APG, assurance chômage et caisse de pension — se situe entre ${netLow} et ${netHigh} francs, soit environ ${netLowEur} à ${netHighEur} euros au taux actuel. La fourchette dépend du canton, de l'état civil, des enfants et de la franchise : le calculateur la resserre sur votre situation réelle en une minute.`,
    netScenarioCta: 'Calculer votre net exact',
    amountFaq: (amount, eur, rate, lowNet, bankNet, netLow, netHigh) => [
      {
        q: `Combien valent ${amount} francs suisses en euros ?`,
        a: `Au taux interbancaire du jour (${rate}), ${amount} CHF valent ${eur} euros. La valeur est actualisée chaque jour avec les taux de référence BCE.`,
      },
      {
        q: `Combien d'euros vais-je vraiment recevoir en changeant ${amount} CHF ?`,
        a: `Cela dépend du canal : environ ${lowNet} euros avec un service spécialisé, environ ${bankNet} euros au guichet d'une banque traditionnelle. L'écart est le coût caché du spread.`,
      },
      {
        q: `${amount} CHF bruts par mois : que reste-t-il à un frontalier ?`,
        a: `Indicativement entre ${netLow} et ${netHigh} francs nets, selon le canton de travail, l'état civil et les enfants. Utilisez le calculateur pour l'estimation précise de votre fiche de paie.`,
      },
    ],
    otherAmountsTitle: 'Autres montants',
    backToHub: 'Retour au change franc-euro',
    discoverCtas: [
      { title: 'Calculer le salaire net', href: CALCULATOR_PATH.fr },
      { title: 'Comparer les services de change', href: SPA_COMPARATOR_PATH.fr },
      { title: 'Scénarios de salaire frontalier', href: SCENARIO_INDEX_PATH.fr },
      { title: 'Offres d\'emploi au Tessin', href: '/fr/trouver-emploi-tessin/' },
    ],
    updatedLabel: 'Mis à jour le',
    sourceNote: 'Source : taux de référence BCE (via Frankfurter/Firestore), mise à jour automatique quotidienne.',
  },
};

// ── Shared render helpers ────────────────────────────────────────────────────

function hreflangFor(paths: Record<ExchangeLocale, string>): string {
  return renderHreflangTags({ it: paths.it, en: paths.en, de: paths.de, fr: paths.fr });
}

function breadcrumbLd(locale: ExchangeLocale, items: Array<{ name: string; path?: string }>): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.path ? { item: `${BASE_URL}${item.path}` } : {}),
    })),
  });
}

function webPageLd(
  locale: ExchangeLocale,
  canonicalUrl: string,
  title: string,
  description: string,
  dayStamp: string,
): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    url: canonicalUrl,
    name: title,
    description,
    inLanguage: locale,
    dateModified: dayStamp,
    isPartOf: { '@type': 'WebSite', url: BASE_URL, name: 'Frontaliere Ticino' },
  });
}

function faqLd(faq: ReadonlyArray<{ q: string; a: string }>): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });
}

function exchangeRateLd(snapshot: ExchangeSnapshot): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'ExchangeRateSpecification',
    currency: 'CHF',
    currentExchangeRate: {
      '@type': 'UnitPriceSpecification',
      price: snapshot.currentRate,
      priceCurrency: 'EUR',
    },
  });
}

function renderFaqSection(copy: ExchangeCopy, faq: ReadonlyArray<{ q: string; a: string }>): string {
  const items = faq
    .map(
      (f) => `<details class="${CARD_BODY_CLASS}" style="padding:12px 16px;margin:0 0 10px">
  <summary style="font-weight:600;cursor:pointer">${esc(f.q)}</summary>
  <p style="${BODY_STYLE};margin:10px 0 2px">${esc(f.a)}</p>
</details>`,
    )
    .join('\n');
  return `<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
  ${items}
</section>`;
}

function renderFeesTable(locale: ExchangeLocale, copy: ExchangeCopy, snapshot: ExchangeSnapshot): string {
  const ref = 4000;
  const gross = ref * snapshot.currentRate;
  const rows = EXCHANGE_REFERRAL_PARTNERS.map((p) => {
    const net = gross * (1 - p.typicalCostPct / 100);
    return `<tr>
      <td class="${TABLE_CELL_CLASS}"><a href="${esc(p.referralUrl)}" rel="sponsored nofollow noopener" target="_blank" style="${LINK_ACCENT_STYLE}">${esc(p.name)}</a></td>
      <td class="${TABLE_CELL_CLASS}">~${fmtNum(locale, p.typicalCostPct, 2)}%</td>
      <td class="${TABLE_CELL_CLASS}">≈ ${fmtNum(locale, net)} EUR</td>
    </tr>`;
  }).join('\n');
  const bankNet = gross * (1 - BANK_SPREAD_PCT / 100) - BANK_FLAT_CHF * snapshot.currentRate;
  return `<div style="overflow-x:auto">
<table class="${TABLE_CLASS}">
  <caption class="sr-only">${esc(copy.feesTable.provider)}</caption>
  <thead><tr>
    <th class="${TABLE_HEAD_CLASS}">${esc(copy.feesTable.provider)}</th>
    <th class="${TABLE_HEAD_CLASS}">${esc(copy.feesTable.typicalCost)}</th>
    <th class="${TABLE_HEAD_CLASS}">${esc(copy.feesTable.net4000)}</th>
  </tr></thead>
  <tbody>
${rows}
    <tr>
      <td class="${TABLE_CELL_CLASS}">${esc(copy.feesTable.bankRow)}</td>
      <td class="${TABLE_CELL_CLASS}">~${fmtNum(locale, BANK_SPREAD_PCT, 1)}% + ${BANK_FLAT_CHF} CHF</td>
      <td class="${TABLE_CELL_CLASS}">≈ ${fmtNum(locale, bankNet)} EUR</td>
    </tr>
  </tbody>
</table>
</div>`;
}

// ── Page generators ──────────────────────────────────────────────────────────

interface PageOut {
  relPath: string;
  html: string;
}

function generateHubPage(
  locale: ExchangeLocale,
  snapshot: ExchangeSnapshot,
  distDir: string,
  dayStamp: string,
): PageOut {
  const copy = COPY[locale];
  const canonicalPath = buildExchangeHubPath(locale);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const rate = fmtRate(locale, snapshot.currentRate);
  const dateStr = fmtDate(locale, snapshot.rateDate);
  const w = snapshot.windows;

  const title = copy.hubTitle(rate);
  const description = copy.hubDescription(rate, dateStr);

  const breadcrumbHtml = renderBreadcrumb([
    { label: copy.breadcrumbHome, href: HOME_PATH[locale] },
    { label: copy.hubBreadcrumb },
  ]);

  const tiles = renderStatGrid([
    { label: copy.tiles.current, value: `1 CHF = ${rate} EUR`, tone: 'accent', href: SPA_COMPARATOR_PATH[locale] },
    { label: copy.tiles.d30, value: fmtPct(locale, w['30'].changePct), tone: w['30'].changePct >= 0 ? 'success' : 'warning' },
    { label: copy.tiles.d90, value: fmtPct(locale, w['90'].changePct), tone: w['90'].changePct >= 0 ? 'success' : 'warning' },
    { label: copy.tiles.d365, value: fmtPct(locale, w['365'].changePct), tone: w['365'].changePct >= 0 ? 'success' : 'warning' },
  ]);

  const windowRows = (
    [
      [copy.windowsTable.p30, w['30']],
      [copy.windowsTable.p90, w['90']],
      [copy.windowsTable.p365, w['365']],
    ] as const
  )
    .map(
      ([label, win]) => `<tr>
      <td class="${TABLE_CELL_CLASS}">${esc(label)}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtRate(locale, win.startRate)}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtRate(locale, win.min)}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtRate(locale, win.max)}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtRate(locale, win.avg)}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtPct(locale, win.changePct)}</td>
    </tr>`,
    )
    .join('\n');

  const monthlyRows = snapshot.monthly
    .map(
      (p) => `<tr>
      <td class="${TABLE_CELL_CLASS}">${esc(p.date.slice(0, 7))}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtRate(locale, p.rate)}</td>
    </tr>`,
    )
    .join('\n');

  const sparkline = renderSparklineChart(
    snapshot.sparkline.map((p) => ({ date: p.date, value: p.rate })),
    { ariaLabel: copy.sparklineLabel, formatValue: (v) => fmtRate(locale, v) },
  );

  const tips = copy.salaryTips
    .map(
      (tip) => `<div class="${CARD_BODY_CLASS}" style="padding:14px 16px">
  <p style="${SMALL_HEADING_STYLE}">${esc(tip.heading)}</p>
  <p style="${BODY_STYLE};margin:6px 0 0">${esc(tip.body)}</p>
</div>`,
    )
    .join('\n');

  const amountLinks = EXCHANGE_AMOUNTS.map(
    (amount) =>
      `<li style="display:inline-block;margin:0 8px 8px 0"><a href="${buildExchangeAmountPath(locale, amount)}" class="${CARD_BODY_CLASS}" style="display:inline-block;padding:8px 14px;text-decoration:none;font-weight:600">${fmtNum(locale, amount)} CHF</a></li>`,
  ).join('');

  const contentHtml = `<article class="max-w-5xl mx-auto px-4 py-6">
${breadcrumbHtml}
<header>
  <h1 style="${H1_STYLE}">${esc(copy.hubH1)}</h1>
  <p style="${LEDE_STYLE}">${esc(copy.hubLede(rate))}</p>
</header>
${tiles}
<p style="${BODY_STYLE};margin:8px 0 0;font-size:13px;color:var(--color-muted)">${esc(copy.updatedLabel)} ${esc(dateStr)} · ${esc(copy.sourceNote)}</p>

<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.historyTitle)}</h2>
  <p style="${BODY_STYLE}">${esc(copy.historyIntro(fmtRate(locale, w['365'].min), fmtRate(locale, w['365'].max)))}</p>
  ${sparkline}
  <div style="overflow-x:auto;margin-top:16px">
  <table class="${TABLE_CLASS}">
    <caption class="sr-only">${esc(copy.windowsTable.caption)}</caption>
    <thead><tr>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.windowsTable.period)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.windowsTable.start)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.windowsTable.min)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.windowsTable.max)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.windowsTable.avg)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.windowsTable.change)}</th>
    </tr></thead>
    <tbody>
${windowRows}
    </tbody>
  </table>
  </div>
  <div style="overflow-x:auto;margin-top:16px">
  <table class="${TABLE_CLASS}">
    <caption style="${SMALL_HEADING_STYLE};text-align:left;padding:4px 0">${esc(copy.monthlyTable.caption)}</caption>
    <thead><tr>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.monthlyTable.month)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.monthlyTable.rate)}</th>
    </tr></thead>
    <tbody>
${monthlyRows}
    </tbody>
  </table>
  </div>
</section>

<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.salaryTitle)}</h2>
  <p style="${BODY_STYLE}">${esc(copy.salaryBody(rate))}</p>
  <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:14px">
${tips}
  </div>
</section>

<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.feesTitle)}</h2>
  <p style="${BODY_STYLE}">${esc(copy.feesIntro(`${fmtNum(locale, BANK_SPREAD_PCT, 1)}%`, `${fmtNum(locale, 0.5, 1)}%`))}</p>
  ${renderFeesTable(locale, copy, snapshot)}
  <p style="${BODY_STYLE};margin-top:12px">${esc(copy.feesCtaText)}</p>
  <p style="margin:14px 0 0"><a href="${SPA_COMPARATOR_PATH[locale]}" class="${CTA_PRIMARY_CLASS}">${esc(copy.feesCta)}</a></p>
  <p style="${BODY_STYLE};margin-top:14px;font-size:13px;color:var(--color-muted)">${esc(copy.widgetNote)} <a href="/embed/currency-widget.html" style="${LINK_ACCENT_STYLE}">Widget</a></p>
</section>

<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.amountsTitle)}</h2>
  <p style="${BODY_STYLE}">${esc(copy.amountsIntro)}</p>
  <ul style="list-style:none;margin:14px 0 0;padding:0">${amountLinks}</ul>
</section>

${renderFaqSection(copy, copy.hubFaq)}
${renderDiscoverMore(locale, copy.discoverCtas)}`;

  const indexable = countHtmlBodyWords(contentHtml) >= MIN_INDEXABLE_WORDS;
  const bodyHtml = `${contentHtml}
${endOfContentMultiplexHtml({ indexable })}
</article>`;

  const alternates: Record<ExchangeLocale, string> = {
    it: buildExchangeHubPath('it'),
    en: buildExchangeHubPath('en'),
    de: buildExchangeHubPath('de'),
    fr: buildExchangeHubPath('fr'),
  };

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    hreflangHtml: hreflangFor(alternates),
    bodyHtml,
    jsonLdScripts: [
      webPageLd(locale, canonicalUrl, title, description, dayStamp),
      breadcrumbLd(locale, [
        { name: copy.breadcrumbHome, path: HOME_PATH[locale] },
        { name: copy.hubBreadcrumb, path: canonicalPath },
      ]),
      faqLd(copy.hubFaq),
      exchangeRateLd(snapshot),
    ],
    ogLocale: LOCALE_OG[locale],
    robots: 'index,follow',
    distDir,
  });

  return { relPath: canonicalPath, html };
}

function generateAmountPage(
  locale: ExchangeLocale,
  amount: number,
  snapshot: ExchangeSnapshot,
  distDir: string,
  dayStamp: string,
): PageOut {
  const copy = COPY[locale];
  const canonicalPath = buildExchangeAmountPath(locale, amount);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const w = snapshot.windows;
  const rate = snapshot.currentRate;

  const amountStr = fmtNum(locale, amount);
  const rateStr = fmtRate(locale, rate);
  const dateStr = fmtDate(locale, snapshot.rateDate);
  const eurNow = amount * rate;
  const eurNowStr = fmtNum(locale, eurNow);
  const eurMinStr = fmtNum(locale, amount * w['365'].min);
  const eurMaxStr = fmtNum(locale, amount * w['365'].max);
  const eurAvgStr = fmtNum(locale, amount * w['365'].avg);

  const lowNet = eurNow * (1 - LOW_COST_PCT / 100);
  const bankNet = eurNow * (1 - BANK_SPREAD_PCT / 100) - BANK_FLAT_CHF * rate;
  const monthlyLoss = lowNet - bankNet;
  const lowNetStr = fmtNum(locale, lowNet);
  const bankNetStr = fmtNum(locale, bankNet);
  const monthlyLossStr = fmtNum(locale, monthlyLoss);
  const yearlyLossStr = fmtNum(locale, monthlyLoss * 12);

  const netLowChf = amount * NET_BAND_LOW;
  const netHighChf = amount * NET_BAND_HIGH;
  const netLowStr = fmtNum(locale, netLowChf);
  const netHighStr = fmtNum(locale, netHighChf);
  const netLowEurStr = fmtNum(locale, netLowChf * rate);
  const netHighEurStr = fmtNum(locale, netHighChf * rate);

  const title = copy.amountTitle(amountStr, eurNowStr);
  const description = copy.amountDescription(amountStr, eurNowStr, rateStr, dateStr);
  const faq = copy.amountFaq(amountStr, eurNowStr, rateStr, lowNetStr, bankNetStr, netLowStr, netHighStr);

  const breadcrumbHtml = renderBreadcrumb([
    { label: copy.breadcrumbHome, href: HOME_PATH[locale] },
    { label: copy.hubBreadcrumb, href: buildExchangeHubPath(locale) },
    { label: copy.amountBreadcrumb(amountStr) },
  ]);

  const tiles = renderStatGrid([
    { label: copy.amountTiles.eurNow, value: `${eurNowStr} EUR`, tone: 'accent', href: SPA_COMPARATOR_PATH[locale] },
    { label: copy.amountTiles.rate, value: rateStr, tone: 'neutral' },
    { label: copy.amountTiles.lowCostNet, value: `≈ ${lowNetStr} EUR`, tone: 'success' },
    { label: copy.amountTiles.bankNet, value: `≈ ${bankNetStr} EUR`, tone: 'warning' },
  ]);

  const conversionRows = (
    [
      [copy.conversionTable.now, rate],
      [copy.conversionTable.min365, w['365'].min],
      [copy.conversionTable.max365, w['365'].max],
      [copy.conversionTable.avg365, w['365'].avg],
    ] as const
  )
    .map(
      ([label, r]) => `<tr>
      <td class="${TABLE_CELL_CLASS}">${esc(label)}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtRate(locale, r)}</td>
      <td class="${TABLE_CELL_CLASS}">${fmtNum(locale, amount * r)} EUR</td>
    </tr>`,
    )
    .join('\n');

  // Neighbour navigation: previous / next amount in the curated set.
  const idx = EXCHANGE_AMOUNTS.indexOf(amount);
  const neighbours = [
    ...(idx > 0 ? [EXCHANGE_AMOUNTS[idx - 1]] : []),
    ...(idx < EXCHANGE_AMOUNTS.length - 1 ? [EXCHANGE_AMOUNTS[idx + 1]] : []),
  ];
  const neighbourLinks = neighbours
    .map(
      (a) =>
        `<li style="display:inline-block;margin:0 8px 8px 0"><a href="${buildExchangeAmountPath(locale, a)}" class="${CARD_BODY_CLASS}" style="display:inline-block;padding:8px 14px;text-decoration:none;font-weight:600">${fmtNum(locale, a)} CHF</a></li>`,
    )
    .join('');

  const calcPrefill = `${CALCULATOR_PATH[locale]}?reddito=${amount}`;

  const contentHtml = `<article class="max-w-5xl mx-auto px-4 py-6">
${breadcrumbHtml}
<header>
  <h1 style="${H1_STYLE}">${esc(copy.amountH1(amountStr))}</h1>
  <p style="${LEDE_STYLE}">${esc(copy.amountLede(amountStr, eurNowStr, rateStr))}</p>
</header>
${tiles}
<p style="${BODY_STYLE};margin:8px 0 0;font-size:13px;color:var(--color-muted)">${esc(copy.updatedLabel)} ${esc(dateStr)} · ${esc(copy.sourceNote)}</p>

<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.conversionTitle(amountStr))}</h2>
  <p style="${BODY_STYLE}">${esc(copy.conversionBody(amountStr, eurNowStr, rateStr, dateStr, eurMinStr, eurMaxStr))}</p>
  <div style="overflow-x:auto;margin-top:14px">
  <table class="${TABLE_CLASS}">
    <caption class="sr-only">${esc(copy.conversionTable.caption)}</caption>
    <thead><tr>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.conversionTable.scenario)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.conversionTable.rate)}</th>
      <th class="${TABLE_HEAD_CLASS}">${esc(copy.conversionTable.eur)}</th>
    </tr></thead>
    <tbody>
${conversionRows}
    </tbody>
  </table>
  </div>
</section>

<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.feeScenarioTitle)}</h2>
  <p style="${BODY_STYLE}">${esc(copy.feeScenarioBody(amountStr, lowNetStr, bankNetStr, monthlyLossStr, yearlyLossStr))}</p>
  ${renderFeesTable(locale, copy, snapshot)}
  <p style="margin:14px 0 0"><a href="${SPA_COMPARATOR_PATH[locale]}" class="${CTA_PRIMARY_CLASS}">${esc(copy.feesCta)}</a></p>
</section>

<section style="margin:32px 0 0">
  <h2 style="${H2_STYLE}">${esc(copy.netScenarioTitle)}</h2>
  <p style="${BODY_STYLE}">${esc(copy.netScenarioBody(amountStr, netLowStr, netHighStr, netLowEurStr, netHighEurStr))}</p>
  <p style="margin:14px 0 0"><a href="${calcPrefill}" class="${CTA_PRIMARY_CLASS}">${esc(copy.netScenarioCta)}</a></p>
</section>

${renderFaqSection(copy, faq)}

<section style="margin:32px 0 0">
  <p style="${SMALL_HEADING_STYLE}">${esc(copy.otherAmountsTitle)}</p>
  <ul style="list-style:none;margin:10px 0 0;padding:0">${neighbourLinks}</ul>
  <p style="margin:10px 0 0"><a href="${buildExchangeHubPath(locale)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.backToHub)} →</a></p>
</section>
${renderDiscoverMore(locale, copy.discoverCtas)}`;

  const indexable = countHtmlBodyWords(contentHtml) >= MIN_INDEXABLE_WORDS;
  const bodyHtml = `${contentHtml}
${endOfContentMultiplexHtml({ indexable })}
</article>`;

  const alternates: Record<ExchangeLocale, string> = {
    it: buildExchangeAmountPath('it', amount),
    en: buildExchangeAmountPath('en', amount),
    de: buildExchangeAmountPath('de', amount),
    fr: buildExchangeAmountPath('fr', amount),
  };

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    hreflangHtml: hreflangFor(alternates),
    bodyHtml,
    jsonLdScripts: [
      webPageLd(locale, canonicalUrl, title, description, dayStamp),
      breadcrumbLd(locale, [
        { name: copy.breadcrumbHome, path: HOME_PATH[locale] },
        { name: copy.hubBreadcrumb, path: buildExchangeHubPath(locale) },
        { name: copy.amountBreadcrumb(amountStr), path: canonicalPath },
      ]),
      faqLd(faq),
    ],
    ogLocale: LOCALE_OG[locale],
    robots: 'index,follow',
    distDir,
  });

  return { relPath: canonicalPath, html };
}

// ── Pure generator (plugin + tests) ──────────────────────────────────────────

export interface GenerateExchangePagesResult {
  pages: PageOut[];
  itCanonicalPaths: string[];
}

export function generateExchangePages(opts: {
  snapshot: ExchangeSnapshot;
  distDir?: string;
}): GenerateExchangePagesResult {
  const { snapshot } = opts;
  const distDir = opts.distDir ?? '';
  const dayStamp = buildDayStampIso();
  const pages: PageOut[] = [];
  const itCanonicalPaths: string[] = [];

  for (const locale of EXCHANGE_LOCALES) {
    pages.push(generateHubPage(locale, snapshot, distDir, dayStamp));
    for (const amount of EXCHANGE_AMOUNTS) {
      pages.push(generateAmountPage(locale, amount, snapshot, distDir, dayStamp));
    }
  }
  itCanonicalPaths.push(buildExchangeHubPath('it'));
  for (const amount of EXCHANGE_AMOUNTS) {
    itCanonicalPaths.push(buildExchangeAmountPath('it', amount));
  }
  return { pages, itCanonicalPaths };
}

// ── Sitemap ──────────────────────────────────────────────────────────────────

const SITEMAP_FILENAME = 'sitemap-exchange.xml';

function buildSitemapXml(itPaths: string[], dateStamp: string): string {
  const entries = itPaths
    .map((itPath) => {
      const isHub = itPath === buildExchangeHubPath('it');
      const amount = isHub
        ? null
        : EXCHANGE_AMOUNTS.find((a) => buildExchangeAmountPath('it', a) === itPath) ?? null;
      const paths: Record<ExchangeLocale, string> = isHub || amount === null
        ? {
            it: buildExchangeHubPath('it'),
            en: buildExchangeHubPath('en'),
            de: buildExchangeHubPath('de'),
            fr: buildExchangeHubPath('fr'),
          }
        : {
            it: buildExchangeAmountPath('it', amount),
            en: buildExchangeAmountPath('en', amount),
            de: buildExchangeAmountPath('de', amount),
            fr: buildExchangeAmountPath('fr', amount),
          };
      const alt = renderSitemapHreflangTags(paths);
      return `  <url>
    <loc>${BASE_URL}${itPath}</loc>
${alt}
    <lastmod>${dateStamp}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${isHub ? '0.8' : '0.6'}</priority>
  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries}
</urlset>
`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILENAME)) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_FILENAME}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        new RegExp(`(<loc>${BASE_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\/${SITEMAP_FILENAME}<\\/loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(<\\/lastmod>)`),
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[exchange-ssg] failed to patch sitemap index', err);
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function exchangeRatePagesPlugin(rootDir: string): Plugin {
  return {
    name: 'exchange-rate-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_EXCHANGE_PAGES === '1') {
        console.log('\x1b[33m[exchange-ssg]\x1b[0m Skipped (SKIP_EXCHANGE_PAGES=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const snapshot = loadExchangeSnapshot(rootDir);
      if (!snapshot) {
        console.warn(
          '\x1b[33m[exchange-ssg]\x1b[0m data/exchange-rate-snapshot.json missing or invalid — no pages emitted',
        );
        return;
      }

      // Wipe owned namespaces so renamed/dropped amounts don't linger.
      cleanNamespaces(
        distDir,
        EXCHANGE_LOCALES.map((l) => buildExchangeHubPath(l).replace(/^\/+|\/+$/g, '')),
      );
      cleanSitemapFiles(distDir, [SITEMAP_FILENAME]);

      const dayKey = new Date().toISOString().slice(0, 10);
      const { pages, itCanonicalPaths } = generateExchangePages({ snapshot, distDir });

      const collector = new WriteCollector({
        distDir,
        skipExisting: false,
        pluginName: 'exchangeRatePagesPlugin',
      });

      let written = 0;
      let thin = 0;
      for (const page of pages) {
        const words = countHtmlBodyWords(page.html);
        if (words < MIN_INDEXABLE_WORDS) {
          // Never expected (static copy is ~400+ words) — hard guard per
          // Non-Negotiable #4: never let thin content go out indexable.
          thin += 1;
          console.warn(`[exchange-ssg] ${page.relPath} below ${MIN_INDEXABLE_WORDS} words (${words}) — noindex applied`);
          // Match the robots tag by NAME, not by its indexable `content` value:
          // the shell's indexable directive is normalised centrally now, and a
          // value-coupled regex would silently stop matching and let a thin
          // page ship indexable (Non-Negotiable #4).
          const noindexed = replaceRobotsMeta(page.html, 'noindex,follow');
          collector.add(np.join(distDir, page.relPath.replace(/^\/+/, ''), 'index.html'), noindexed);
          continue;
        }
        collector.add(np.join(distDir, page.relPath.replace(/^\/+/, ''), 'index.html'), page.html);
        written += 1;
      }
      await collector.flush();

      try {
        fs.writeFileSync(np.join(distDir, SITEMAP_FILENAME), buildSitemapXml(itCanonicalPaths, dayKey), 'utf-8');
      } catch (err) {
        console.warn('[exchange-ssg] failed to write sitemap', err);
      }
      if (fs.existsSync(np.join(distDir, SITEMAP_FILENAME))) {
        patchSitemapIndex(distDir, dayKey);
      }

      console.log(
        `\x1b[36m[exchange-ssg]\x1b[0m Generated ${written} pages (${thin} noindexed-thin) — rate ${snapshot.currentRate} @ ${snapshot.rateDate} (${snapshot.source})`,
      );
    },
  };
}
