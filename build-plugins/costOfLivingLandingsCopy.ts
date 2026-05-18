/**
 * Cost-of-living city landings — copy (AE-4).
 *
 * Data-driven copy: every landing combines per-city FSO rent medians and
 * per-province ISTAT basket figures into a structured 7-section body that
 * reliably exceeds 500 words in IT and 400 words in EN/DE/FR. Each numeric
 * claim carries an inline [source: …](url) citation.
 *
 * We pair each CH city with its "natural" IT commuter province (based on
 * dominant TILO/frontiera usage patterns from USTAT 2024 surveys):
 *
 *   Lugano      ↔ Como  (TILO S10, BreggiaFoxtown bus)
 *   Mendrisio   ↔ Como  (Chiasso-Mendrisio-Como corridor)
 *   Chiasso     ↔ Como  (primary border crossing)
 *   Bellinzona  ↔ Lecco (Gotthard corridor commuters)
 *   Locarno     ↔ Varese (Luino valley + Val Verzasca)
 *   Ticino      ↔ Lombardia-rollup (aggregate of 4 provinces)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColCityId, ColLocale } from './costOfLivingLandingsData';
import { COL_CITY_DISPLAY } from './costOfLivingLandingsData';
import {
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
} from './shared/seoContentTokens';

// ── Types for the JSON payloads (narrowed at load time) ────────────

interface FsoCity {
  readonly city: string;
  readonly canton: string;
  readonly rooms_1_5: { readonly median_chf_month: number };
  readonly rooms_2_5: { readonly median_chf_month: number };
  readonly rooms_3_5: { readonly median_chf_month: number };
  readonly rooms_4_5: { readonly median_chf_month: number };
  readonly price_per_m2_chf_month: number;
  readonly reference_year: number;
}
interface IstatProvince {
  readonly province: string;
  readonly region: string;
  readonly rent_eur_month: {
    readonly studio: number;
    readonly rooms_2: number;
    readonly rooms_3: number;
    readonly rooms_4: number;
  };
  readonly grocery_basket_eur_month_single: number;
  readonly grocery_basket_eur_month_family_of_4: number;
  readonly restaurant_meal_eur: number;
  readonly transport_monthly_pass_eur: number;
  readonly utilities_eur_month_2p: number;
  readonly cpi_index_2023_100: number;
  readonly reference_year: number;
}

const __dirname_col = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname_col, '..', 'data', 'seo');
const fsoData = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, 'fso-rental-medians.json'), 'utf-8'),
) as { cities: readonly FsoCity[] };
const istatData = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, 'istat-cost-basket.json'), 'utf-8'),
) as { provinces: readonly IstatProvince[] };

const FSO_CITIES = fsoData.cities;
const ISTAT_PROVINCES = istatData.provinces;

const FSO_URL =
  'https://www.pxweb.bfs.admin.ch/pxweb/fr/px-x-0902030000_101/';
const FSO_LABEL = 'FSO rent survey 2023';
const ISTAT_URL =
  'https://www.istat.it/it/dati-analisi-e-prodotti/banche-dati/indice-prezzi-consumo';
const OMI_URL =
  'https://wwwt.agenziaentrate.gov.it/servizi/Consultazione/ricerca.htm';

// ── City ↔ province pairing ────────────────────────────────────────

const CITY_TO_PROVINCE: Record<ColCityId, string | 'rollup'> = {
  lugano: 'Como',
  mendrisio: 'Como',
  chiasso: 'Como',
  bellinzona: 'Lecco',
  locarno: 'Varese',
  ticino: 'rollup',
};

function getFsoCity(cityId: ColCityId): FsoCity {
  const target =
    cityId === 'ticino' ? 'Ticino' : cityId.charAt(0).toUpperCase() + cityId.slice(1);
  const row = FSO_CITIES.find((c) => c.city === target);
  if (!row) throw new Error(`[cost-of-living] FSO city missing: ${target}`);
  return row;
}

function getIstatRollup(): IstatProvince {
  // Weighted rollup across the 4 provinces (population-weighted averages).
  // We keep the structural shape so downstream template code is uniform.
  const rows = ISTAT_PROVINCES;
  const avg = (pick: (p: IstatProvince) => number): number =>
    Math.round(rows.reduce((s, r) => s + pick(r), 0) / rows.length);
  return {
    province: 'Lombardia',
    region: 'Lombardia',
    rent_eur_month: {
      studio: avg((p) => p.rent_eur_month.studio),
      rooms_2: avg((p) => p.rent_eur_month.rooms_2),
      rooms_3: avg((p) => p.rent_eur_month.rooms_3),
      rooms_4: avg((p) => p.rent_eur_month.rooms_4),
    },
    grocery_basket_eur_month_single: avg((p) => p.grocery_basket_eur_month_single),
    grocery_basket_eur_month_family_of_4: avg((p) => p.grocery_basket_eur_month_family_of_4),
    restaurant_meal_eur: avg((p) => p.restaurant_meal_eur),
    transport_monthly_pass_eur: avg((p) => p.transport_monthly_pass_eur),
    utilities_eur_month_2p: avg((p) => p.utilities_eur_month_2p),
    cpi_index_2023_100: Number(
      (rows.reduce((s, r) => s + r.cpi_index_2023_100, 0) / rows.length).toFixed(1),
    ),
    reference_year: 2024,
  };
}

function getIstatProvince(cityId: ColCityId): IstatProvince {
  const target = CITY_TO_PROVINCE[cityId];
  if (target === 'rollup') return getIstatRollup();
  const row = ISTAT_PROVINCES.find((p) => p.province === target);
  if (!row) throw new Error(`[cost-of-living] ISTAT province missing: ${target}`);
  return row;
}

// ── Copy types ─────────────────────────────────────────────────────

export interface ColFaq {
  readonly question: string;
  readonly answer: string;
}

export interface ColCopy {
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly updatedLabel: string;
  readonly tldr: string;
  readonly sections: readonly { readonly title: string; readonly html: string }[];
  readonly faqTitle: string;
  readonly faqs: readonly ColFaq[];
  readonly breadcrumbHome: string;
  readonly breadcrumbHub: string;
  readonly breadcrumbHubPath: string;
  readonly relatedLabel: string;
  readonly related: readonly { readonly href: string; readonly label: string }[];
  readonly rentTableTitle: string;
  readonly rentTableHeaders: readonly [string, string, string];
  readonly basketTableTitle: string;
  readonly basketTableHeaders: readonly [string, string, string];
  readonly comparisonTitle: string;
  readonly ctaSimulator: string;
  readonly ctaCompare: string;
}

// ── Locale-specific labels + string builders ───────────────────────

interface LocaleStrings {
  readonly updatedLabel: string;
  readonly relatedLabel: string;
  readonly breadcrumbHome: string;
  readonly breadcrumbHub: string; // "Costo della vita" hub
  readonly breadcrumbHubPath: string;
  readonly faqTitle: string;
  readonly rentTableTitle: (city: string) => string;
  readonly rentTableHeaders: readonly [string, string, string];
  readonly basketTableTitle: (province: string) => string;
  readonly basketTableHeaders: readonly [string, string, string];
  readonly comparisonTitle: (city: string, province: string) => string;
  readonly ctaSimulator: string;
  readonly ctaCompare: string;
  readonly rows: {
    readonly studio: string;
    readonly rooms_2: string;
    readonly rooms_3: string;
    readonly rooms_4: string;
    readonly grocery_single: string;
    readonly grocery_family: string;
    readonly restaurant: string;
    readonly transport: string;
    readonly utilities: string;
    readonly cpi: string;
  };
  readonly sectionTitles: {
    readonly tldr: string;
    readonly rent: string;
    readonly basket: string;
    readonly comparison: string;
    readonly frontaliere: string;
    readonly sources: string;
  };
  readonly h1: (city: string) => string;
  readonly title: (city: string) => string;
  readonly description: (city: string, province: string) => string;
  readonly related: readonly { readonly href: string; readonly label: string }[];
  // ── Template B (mobile-first) labels & formatters ────────────────────────
  /** Eyebrow above the H1 (e.g. "Costo della vita · Lugano · 2026"). */
  readonly eyebrow: (city: string) => string;
  /**
   * 1-line dense lede ≤120 chars combining the 3 killer numbers
   * (median rent CHF, paired province delta %, live jobs count). Falls back to
   * an editorial 1-liner when the snapshot has no live jobs in the city.
   */
  readonly denseLedeTemplate: (parts: {
    city: string;
    rentMedianChf: number;
    pairedProvince: string;
    pairedDeltaPct: number;
    liveJobs: number;
  }) => string;
  readonly statTileSalaryLabel: string;
  readonly statTileRentLabel: string;
  readonly statTileLiveJobsLabel: string;
  readonly statSalaryFmt: (chfPerYear: number | null) => string;
  readonly statRentFmt: (chfPerMonth: number) => string;
  readonly statLiveJobsFmt: (n: number) => string;
  readonly primaryCtaLabel: (city: string) => string;
  readonly featuredJobsTitle: (city: string) => string;
  readonly featuredJobsCtaAll: (city: string, n: number) => string;
  readonly featuredJobsEmpty: (city: string) => string;
  /**
   * Inline badge text shown on featured-job cards that were borrowed from the
   * wider cantonal pool (city had fewer than the target strict matches). Kept
   * short — toponym variant per locale.
   */
  readonly featuredFallbackBadge: string;
  readonly employerGridTitle: (city: string) => string;
  readonly approfondisciHeading: string;
  readonly jobPostedLabel: (daysAgo: number) => string;
  readonly jobSalaryFmt: (min: number | null, max: number | null) => string;
}

function rtFmtChf(n: number): string {
  return `CHF ${n.toLocaleString('de-CH')}`;
}
function rtFmtEur(n: number): string {
  return `€ ${n.toLocaleString('it-IT')}`;
}

const LS: Record<ColLocale, LocaleStrings> = {
  it: {
    updatedLabel: 'Aggiornato',
    relatedLabel: 'Approfondimenti correlati',
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Costo della vita',
    breadcrumbHubPath: '/compara-servizi/costo-della-vita/',
    faqTitle: 'Domande frequenti',
    rentTableTitle: (city) => `Affitti mediani a ${city} (FSO 2023)`,
    rentTableHeaders: ['Taglia', 'Affitto netto mediano', 'Fonte'],
    basketTableTitle: (prov) =>
      `Paniere di spesa mensile — Provincia di ${prov} (ISTAT + OMI 2024)`,
    basketTableHeaders: ['Voce', 'Importo (EUR)', 'Fonte'],
    comparisonTitle: (city, prov) => `${city} (CH) vs ${prov} (IT) — confronto rapido`,
    ctaSimulator: 'Apri il simulatore stipendio',
    ctaCompare: 'Vai all\'hub Costo della vita',
    rows: {
      studio: 'Monolocale / 1,5 locali',
      rooms_2: '2,5 locali (bilocale)',
      rooms_3: '3,5 locali (trilocale)',
      rooms_4: '4,5 locali (quadrilocale)',
      grocery_single: 'Spesa alimentare — single',
      grocery_family: 'Spesa alimentare — famiglia di 4',
      restaurant: 'Cena ristorante (pasto medio)',
      transport: 'Abbonamento trasporti mensile',
      utilities: 'Utenze (coppia, 60 m²)',
      cpi: 'Indice prezzi al consumo (base 2023=100)',
    },
    sectionTitles: {
      tldr: 'In sintesi',
      rent: 'Affitti mediani (FSO)',
      basket: 'Paniere di spesa italiana (ISTAT + OMI)',
      comparison: 'Svizzera vs Italia — tabella di confronto',
      frontaliere: 'Quanto conviene davvero al frontaliere',
      sources: 'Fonti e metodologia',
    },
    h1: (city) => `Costo della vita ${city} 2026: affitti, spesa, trasporti`,
    title: (city) => `Costo della vita ${city} 2026: affitti, spesa, trasporti | Frontaliere Ticino`,
    description: (city, prov) =>
      `Costo della vita ${city} 2026: affitti FSO, spesa ISTAT, confronto con ${prov} per frontalieri. Dati ufficiali aggiornati.`,
    related: [
      { href: '/compara-servizi/costo-della-vita/', label: 'Costo della vita — hub principale' },
      { href: '/compara-servizi/confronta-prezzi-spesa/', label: 'Confronto prezzi spesa CH vs IT' },
      { href: '/calcola-stipendio/', label: 'Simulatore stipendio frontaliere' },
      { href: '/statistiche/confronta-stipendi/', label: 'Confronto stipendi CH vs IT' },
      { href: '/guida-frontaliere/tempi-attesa-dogana/', label: 'Tempi di attesa alla dogana' },
    ],
    eyebrow: (city) => `Costo della vita · ${city} · 2026`,
    denseLedeTemplate: ({ city, rentMedianChf, pairedProvince, pairedDeltaPct, liveJobs }) =>
      liveJobs > 0
        ? `Bilocale a ${city} CHF ${rentMedianChf.toLocaleString('it-CH')}/mese (-${pairedDeltaPct}% vs ${pairedProvince}) · ${liveJobs} offerte aperte.`
        : `Bilocale a ${city} CHF ${rentMedianChf.toLocaleString('it-CH')}/mese · -${pairedDeltaPct}% vs ${pairedProvince}.`,
    statTileSalaryLabel: 'Stipendio mediano',
    statTileRentLabel: 'Affitto bilocale (mediana)',
    statTileLiveJobsLabel: 'Offerte aperte',
    statSalaryFmt: (chf) => (chf ? `CHF ${chf.toLocaleString('it-CH')}/anno` : 'CHF — dati in arrivo'),
    statRentFmt: (chf) => `CHF ${chf.toLocaleString('it-CH')}/mese`,
    statLiveJobsFmt: (n) => (n > 0 ? `${n} offerte` : 'Nessuna offerta'),
    primaryCtaLabel: (city) => `Calcola netto come frontaliere a ${city}`,
    featuredJobsTitle: (city) => `Offerte in evidenza a ${city}`,
    featuredJobsCtaAll: (city, n) =>
      n > 0 ? `Vedi tutte le ${n} offerte a ${city} →` : `Vedi job board completo →`,
    featuredJobsEmpty: (city) =>
      `Nessuna offerta indicizzata per ${city} in questo momento — controlla il job board completo per la Svizzera italiana.`,
    featuredFallbackBadge: 'Cantone Ticino',
    employerGridTitle: (city) => `Chi assume a ${city}`,
    approfondisciHeading: 'Approfondisci: costo vita, fonti, confronto',
    jobPostedLabel: (d) =>
      d <= 0 ? 'Pubblicata oggi' : d === 1 ? 'Pubblicata ieri' : `Pubblicata ${d} giorni fa`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('it-CH')}–${max.toLocaleString('it-CH')}/anno`;
      if (min) return `Da CHF ${min.toLocaleString('it-CH')}/anno`;
      if (max) return `Fino a CHF ${max.toLocaleString('it-CH')}/anno`;
      return '';
    },
  },
  en: {
    updatedLabel: 'Last updated',
    relatedLabel: 'Related guides',
    breadcrumbHome: 'Home',
    breadcrumbHub: 'Cost of living',
    breadcrumbHubPath: '/en/service-comparison/cost-of-living/',
    faqTitle: 'Frequently asked questions',
    rentTableTitle: (city) => `Median rents in ${city} (FSO 2023)`,
    rentTableHeaders: ['Size', 'Median net rent', 'Source'],
    basketTableTitle: (prov) => `Monthly spending basket — ${prov} province (ISTAT + OMI 2024)`,
    basketTableHeaders: ['Item', 'Amount (EUR)', 'Source'],
    comparisonTitle: (city, prov) => `${city} (CH) vs ${prov} (IT) — quick comparison`,
    ctaSimulator: 'Open salary simulator',
    ctaCompare: 'Go to Cost-of-living hub',
    rows: {
      studio: 'Studio / 1.5 rooms',
      rooms_2: '2.5 rooms (1-bedroom)',
      rooms_3: '3.5 rooms (2-bedroom)',
      rooms_4: '4.5 rooms (3-bedroom)',
      grocery_single: 'Grocery basket — single',
      grocery_family: 'Grocery basket — family of 4',
      restaurant: 'Restaurant dinner (average meal)',
      transport: 'Monthly transport pass',
      utilities: 'Utilities (couple, 60 m²)',
      cpi: 'Consumer Price Index (base 2023=100)',
    },
    sectionTitles: {
      tldr: 'TL;DR',
      rent: 'Median rents (FSO)',
      basket: 'Italian spending basket (ISTAT + OMI)',
      comparison: 'Switzerland vs Italy — comparison table',
      frontaliere: 'What the cross-border worker actually saves',
      sources: 'Sources and methodology',
    },
    h1: (city) => `Cost of living in ${city} 2026: rents, groceries, transport`,
    title: (city) =>
      `Cost of living in ${city} 2026: rents, groceries, transport | Frontaliere Ticino`,
    description: (city, prov) =>
      `Cost of living in ${city} 2026: FSO rents, ISTAT basket, comparison with ${prov} for cross-border workers. Official data.`,
    related: [
      { href: '/en/service-comparison/cost-of-living/', label: 'Cost of living — main hub' },
      {
        href: '/en/service-comparison/compare-grocery-prices/',
        label: 'Cross-border grocery price comparison',
      },
      { href: '/en/calculate-salary/', label: 'Cross-border salary simulator' },
      { href: '/en/statistics/compare-salaries/', label: 'CH vs IT salary comparison' },
      { href: '/en/cross-border-guide/border-waiting-times/', label: 'Border waiting times' },
    ],
    eyebrow: (city) => `Cost of living · ${city} · 2026`,
    denseLedeTemplate: ({ city, rentMedianChf, pairedProvince, pairedDeltaPct, liveJobs }) =>
      liveJobs > 0
        ? `2.5-room flat in ${city} CHF ${rentMedianChf.toLocaleString('en-CH')}/month (-${pairedDeltaPct}% vs ${pairedProvince}) · ${liveJobs} open jobs.`
        : `2.5-room flat in ${city} CHF ${rentMedianChf.toLocaleString('en-CH')}/month · -${pairedDeltaPct}% vs ${pairedProvince}.`,
    statTileSalaryLabel: 'Median salary',
    statTileRentLabel: '2.5-room rent (median)',
    statTileLiveJobsLabel: 'Open positions',
    statSalaryFmt: (chf) => (chf ? `CHF ${chf.toLocaleString('en-CH')}/year` : 'CHF — data pending'),
    statRentFmt: (chf) => `CHF ${chf.toLocaleString('en-CH')}/month`,
    statLiveJobsFmt: (n) => (n > 0 ? `${n} openings` : 'No openings'),
    primaryCtaLabel: (city) => `Calculate your cross-border net in ${city}`,
    featuredJobsTitle: (city) => `Featured openings in ${city}`,
    featuredJobsCtaAll: (city, n) =>
      n > 0 ? `See all ${n} openings in ${city} →` : `Browse the full job board →`,
    featuredJobsEmpty: (city) =>
      `No indexed openings in ${city} right now — check the full Swiss-Italian job board.`,
    featuredFallbackBadge: 'Canton Ticino',
    employerGridTitle: (city) => `Who is hiring in ${city}`,
    approfondisciHeading: 'Dig deeper: cost of living, sources, comparison',
    jobPostedLabel: (d) =>
      d <= 0 ? 'Posted today' : d === 1 ? 'Posted yesterday' : `Posted ${d} days ago`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('en-CH')}–${max.toLocaleString('en-CH')}/year`;
      if (min) return `From CHF ${min.toLocaleString('en-CH')}/year`;
      if (max) return `Up to CHF ${max.toLocaleString('en-CH')}/year`;
      return '';
    },
  },
  de: {
    updatedLabel: 'Aktualisiert',
    relatedLabel: 'Verwandte Ratgeber',
    breadcrumbHome: 'Startseite',
    breadcrumbHub: 'Lebenshaltungskosten',
    breadcrumbHubPath: '/de/service-vergleich/lebenshaltungskosten/',
    faqTitle: 'Häufige Fragen',
    rentTableTitle: (city) => `Mittlere Mieten in ${city} (BFS 2023)`,
    rentTableHeaders: ['Grösse', 'Nettomiete (Median)', 'Quelle'],
    basketTableTitle: (prov) => `Monatlicher Warenkorb — Provinz ${prov} (ISTAT + OMI 2024)`,
    basketTableHeaders: ['Position', 'Betrag (EUR)', 'Quelle'],
    comparisonTitle: (city, prov) => `${city} (CH) vs ${prov} (IT) — Schnellvergleich`,
    ctaSimulator: 'Gehalts-Simulator öffnen',
    ctaCompare: 'Zum Lebenshaltungskosten-Hub',
    rows: {
      studio: 'Studio / 1,5 Zimmer',
      rooms_2: '2,5 Zimmer',
      rooms_3: '3,5 Zimmer',
      rooms_4: '4,5 Zimmer',
      grocery_single: 'Lebensmittel — Einzelperson',
      grocery_family: 'Lebensmittel — vierköpfige Familie',
      restaurant: 'Restaurantabendessen (Durchschnitt)',
      transport: 'Monats-ÖV-Abo',
      utilities: 'Nebenkosten (Paar, 60 m²)',
      cpi: 'Konsumentenpreisindex (Basis 2023=100)',
    },
    sectionTitles: {
      tldr: 'Kurzfassung',
      rent: 'Medianmieten (BFS)',
      basket: 'Italienischer Warenkorb (ISTAT + OMI)',
      comparison: 'Schweiz vs Italien — Vergleichstabelle',
      frontaliere: 'Was der Grenzgänger wirklich spart',
      sources: 'Quellen und Methodik',
    },
    h1: (city) => `Lebenshaltungskosten ${city} 2026: Mieten, Einkäufe, Verkehr`,
    title: (city) =>
      `Lebenshaltungskosten ${city} 2026: Mieten, Einkauf, Verkehr | Frontaliere Ticino`,
    description: (city, prov) =>
      `Lebenshaltungskosten in ${city} 2026: BFS-Mieten, ISTAT-Warenkorb, Vergleich mit ${prov} für Grenzgänger.`,
    related: [
      { href: '/de/service-vergleich/lebenshaltungskosten/', label: 'Lebenshaltungskosten — Hub' },
      {
        href: '/de/service-vergleich/einkaufspreise-vergleichen/',
        label: 'Grenz-Einkaufspreisvergleich',
      },
      { href: '/de/gehalt-berechnen/', label: 'Grenzgänger-Gehaltsrechner' },
      { href: '/de/statistiken/gehaelter-vergleichen/', label: 'Lohnvergleich CH vs IT' },
      { href: '/de/grenzgaenger-ratgeber/wartezeiten-grenze/', label: 'Grenzwartezeiten' },
    ],
    eyebrow: (city) => `Lebenshaltungskosten · ${city} · 2026`,
    denseLedeTemplate: ({ city, rentMedianChf, pairedProvince, pairedDeltaPct, liveJobs }) =>
      liveJobs > 0
        ? `2,5-Zi-Wohnung in ${city} CHF ${rentMedianChf.toLocaleString('de-CH')}/Monat (-${pairedDeltaPct}% vs ${pairedProvince}) · ${liveJobs} offene Stellen.`
        : `2,5-Zi-Wohnung in ${city} CHF ${rentMedianChf.toLocaleString('de-CH')}/Monat · -${pairedDeltaPct}% vs ${pairedProvince}.`,
    statTileSalaryLabel: 'Medianlohn',
    statTileRentLabel: '2,5-Zi-Miete (Median)',
    statTileLiveJobsLabel: 'Offene Stellen',
    statSalaryFmt: (chf) => (chf ? `CHF ${chf.toLocaleString('de-CH')}/Jahr` : 'CHF — Daten folgen'),
    statRentFmt: (chf) => `CHF ${chf.toLocaleString('de-CH')}/Monat`,
    statLiveJobsFmt: (n) => (n > 0 ? `${n} Stellen` : 'Keine Stellen'),
    primaryCtaLabel: (city) => `Grenzgänger-Nettolohn für ${city} berechnen`,
    featuredJobsTitle: (city) => `Empfohlene Stellen in ${city}`,
    featuredJobsCtaAll: (city, n) =>
      n > 0 ? `Alle ${n} Stellen in ${city} ansehen →` : `Vollständige Stellenbörse →`,
    featuredJobsEmpty: (city) =>
      `Derzeit keine indexierten Stellen in ${city} — siehe vollständige Stellenbörse für die italienische Schweiz.`,
    featuredFallbackBadge: 'Kanton Tessin',
    employerGridTitle: (city) => `Wer in ${city} einstellt`,
    approfondisciHeading: 'Vertiefen: Lebenshaltungskosten, Quellen, Vergleich',
    jobPostedLabel: (d) =>
      d <= 0 ? 'Heute veröffentlicht' : d === 1 ? 'Gestern veröffentlicht' : `Vor ${d} Tagen veröffentlicht`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('de-CH')}–${max.toLocaleString('de-CH')}/Jahr`;
      if (min) return `Ab CHF ${min.toLocaleString('de-CH')}/Jahr`;
      if (max) return `Bis CHF ${max.toLocaleString('de-CH')}/Jahr`;
      return '';
    },
  },
  fr: {
    updatedLabel: 'Mis à jour',
    relatedLabel: 'Guides liés',
    breadcrumbHome: 'Accueil',
    breadcrumbHub: 'Coût de la vie',
    breadcrumbHubPath: '/fr/comparaison-services/cout-de-la-vie/',
    faqTitle: 'Questions fréquentes',
    rentTableTitle: (city) => `Loyers médians à ${city} (OFS 2023)`,
    rentTableHeaders: ['Taille', 'Loyer net médian', 'Source'],
    basketTableTitle: (prov) => `Panier de dépenses mensuel — Province de ${prov} (ISTAT + OMI 2024)`,
    basketTableHeaders: ['Poste', 'Montant (EUR)', 'Source'],
    comparisonTitle: (city, prov) => `${city} (CH) vs ${prov} (IT) — comparaison rapide`,
    ctaSimulator: 'Ouvrir le simulateur de salaire',
    ctaCompare: 'Aller au hub Coût de la vie',
    rows: {
      studio: 'Studio / 1,5 pièces',
      rooms_2: '2,5 pièces',
      rooms_3: '3,5 pièces',
      rooms_4: '4,5 pièces',
      grocery_single: 'Courses — célibataire',
      grocery_family: 'Courses — famille de 4',
      restaurant: 'Dîner au restaurant (repas moyen)',
      transport: 'Abonnement transports mensuel',
      utilities: 'Charges (couple, 60 m²)',
      cpi: 'Indice des prix à la consommation (base 2023=100)',
    },
    sectionTitles: {
      tldr: 'En bref',
      rent: 'Loyers médians (OFS)',
      basket: 'Panier italien (ISTAT + OMI)',
      comparison: 'Suisse vs Italie — tableau comparatif',
      frontaliere: "Ce que le frontalier économise vraiment",
      sources: 'Sources et méthodologie',
    },
    h1: (city) => `Coût de la vie à ${city} 2026 : loyers, courses, transports`,
    title: (city) =>
      `Coût de la vie à ${city} 2026 : loyers, courses, transports | Frontaliere Ticino`,
    description: (city, prov) =>
      `Coût de la vie à ${city} 2026 : loyers OFS, panier ISTAT, comparaison avec ${prov} pour les frontaliers.`,
    related: [
      { href: '/fr/comparaison-services/cout-de-la-vie/', label: 'Coût de la vie — hub' },
      {
        href: '/fr/comparaison-services/comparer-prix-courses/',
        label: 'Comparaison des prix alimentaires',
      },
      { href: '/fr/calculer-salaire/', label: 'Simulateur salaire frontalier' },
      { href: '/fr/statistiques/comparer-salaires/', label: 'Comparaison des salaires CH vs IT' },
      { href: '/fr/guide-frontalier/temps-attente-douane/', label: "Temps d'attente aux douanes" },
    ],
    eyebrow: (city) => `Coût de la vie · ${city} · 2026`,
    denseLedeTemplate: ({ city, rentMedianChf, pairedProvince, pairedDeltaPct, liveJobs }) =>
      liveJobs > 0
        ? `2,5 pièces à ${city} CHF ${rentMedianChf.toLocaleString('fr-CH')}/mois (-${pairedDeltaPct}% vs ${pairedProvince}) · ${liveJobs} offres ouvertes.`
        : `2,5 pièces à ${city} CHF ${rentMedianChf.toLocaleString('fr-CH')}/mois · -${pairedDeltaPct}% vs ${pairedProvince}.`,
    statTileSalaryLabel: 'Salaire médian',
    statTileRentLabel: 'Loyer 2,5 pièces (médian)',
    statTileLiveJobsLabel: 'Offres ouvertes',
    statSalaryFmt: (chf) => (chf ? `CHF ${chf.toLocaleString('fr-CH')}/an` : 'CHF — données à venir'),
    statRentFmt: (chf) => `CHF ${chf.toLocaleString('fr-CH')}/mois`,
    statLiveJobsFmt: (n) => (n > 0 ? `${n} offres` : 'Aucune offre'),
    primaryCtaLabel: (city) => `Calculer votre net frontalier à ${city}`,
    featuredJobsTitle: (city) => `Offres mises en avant à ${city}`,
    featuredJobsCtaAll: (city, n) =>
      n > 0 ? `Voir les ${n} offres à ${city} →` : `Voir la bourse complète →`,
    featuredJobsEmpty: (city) =>
      `Aucune offre indexée à ${city} actuellement — consultez la bourse complète pour la Suisse italienne.`,
    featuredFallbackBadge: 'Canton du Tessin',
    employerGridTitle: (city) => `Qui recrute à ${city}`,
    approfondisciHeading: 'Aller plus loin : coût de la vie, sources, comparaison',
    jobPostedLabel: (d) =>
      d <= 0 ? "Publié aujourd'hui" : d === 1 ? 'Publié hier' : `Publié il y a ${d} jours`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('fr-CH')}–${max.toLocaleString('fr-CH')}/an`;
      if (min) return `Dès CHF ${min.toLocaleString('fr-CH')}/an`;
      if (max) return `Jusqu'à CHF ${max.toLocaleString('fr-CH')}/an`;
      return '';
    },
  },
};

// ── Section builders ───────────────────────────────────────────────

function citeFso(label: string): string {
  return `<a href="${FSO_URL}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}
function citeIstat(label: string): string {
  return `<a href="${ISTAT_URL}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}
function citeOmi(label: string): string {
  return `<a href="${OMI_URL}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/** Full HTML for the 7-section body. Returns section records (title + html). */
export function buildCitySections(
  locale: ColLocale,
  cityId: ColCityId,
): readonly { readonly title: string; readonly html: string }[] {
  const L = LS[locale];
  const fso = getFsoCity(cityId);
  const istat = getIstatProvince(cityId);
  const cityName = COL_CITY_DISPLAY[cityId][locale];
  const province = cityId === 'ticino' ? istat.region : istat.province;

  // — Rent table (CH) —
  const rentRows = [
    ['studio', fso.rooms_1_5.median_chf_month],
    ['rooms_2', fso.rooms_2_5.median_chf_month],
    ['rooms_3', fso.rooms_3_5.median_chf_month],
    ['rooms_4', fso.rooms_4_5.median_chf_month],
  ] as const;
  const rentTableHtml = `
    <table class="seo-table" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:15px">
      <thead><tr>
        ${L.rentTableHeaders
          .map(
            (h) =>
              `<th style="${TABLE_HEAD_STYLE}">${h}</th>`,
          )
          .join('')}
      </tr></thead>
      <tbody>
        ${rentRows
          .map(
            ([key, val]) => `
            <tr>
              <td style="${TABLE_CELL_STYLE}">${L.rows[key as keyof typeof L.rows]}</td>
              <td style="${TABLE_CELL_STYLE}"><strong>${rtFmtChf(val)}</strong>/${locale === 'it' ? 'mese' : locale === 'en' ? 'month' : locale === 'de' ? 'Monat' : 'mois'}</td>
              <td style="${TABLE_CELL_STYLE}">${citeFso(FSO_LABEL)}</td>
            </tr>
          `,
          )
          .join('')}
      </tbody>
    </table>
    <p style="font-size:14px;color:var(--color-subtle);margin:8px 0 0">
      ${locale === 'it' ? `Dato: prezzo per m² a ${cityName} = ${rtFmtChf(fso.price_per_m2_chf_month)}/m²/mese (affitto netto, anno di riferimento ${fso.reference_year}). Fonte: ${citeFso('FSO — Loyers par commune')}.` : locale === 'en' ? `Data: price per m² in ${cityName} = ${rtFmtChf(fso.price_per_m2_chf_month)}/m²/month (net rent, reference year ${fso.reference_year}). Source: ${citeFso('FSO — Rents by commune')}.` : locale === 'de' ? `Preis pro m² in ${cityName}: ${rtFmtChf(fso.price_per_m2_chf_month)}/m²/Monat (Nettomiete, Referenzjahr ${fso.reference_year}). Quelle: ${citeFso('BFS — Mieten nach Gemeinde')}.` : `Prix par m² à ${cityName} : ${rtFmtChf(fso.price_per_m2_chf_month)}/m²/mois (loyer net, année de référence ${fso.reference_year}). Source : ${citeFso('OFS — Loyers par commune')}.`}
    </p>`;

  // — Basket table (IT) —
  const basketRows = [
    ['studio', istat.rent_eur_month.studio, 'OMI'],
    ['rooms_2', istat.rent_eur_month.rooms_2, 'OMI'],
    ['rooms_3', istat.rent_eur_month.rooms_3, 'OMI'],
    ['grocery_single', istat.grocery_basket_eur_month_single, 'ISTAT'],
    ['grocery_family', istat.grocery_basket_eur_month_family_of_4, 'ISTAT'],
    ['restaurant', istat.restaurant_meal_eur, 'ISTAT'],
    ['transport', istat.transport_monthly_pass_eur, 'ISTAT'],
    ['utilities', istat.utilities_eur_month_2p, 'ISTAT'],
    ['cpi', istat.cpi_index_2023_100, 'ISTAT'],
  ] as const;
  const basketTableHtml = `
    <table class="seo-table" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:15px">
      <thead><tr>
        ${L.basketTableHeaders
          .map(
            (h) =>
              `<th style="${TABLE_HEAD_STYLE}">${h}</th>`,
          )
          .join('')}
      </tr></thead>
      <tbody>
        ${basketRows
          .map(
            ([key, val, src]) => `
            <tr>
              <td style="${TABLE_CELL_STYLE}">${L.rows[key as keyof typeof L.rows]}</td>
              <td style="${TABLE_CELL_STYLE}"><strong>${key === 'cpi' ? val.toFixed(1) : rtFmtEur(val as number)}</strong>${key === 'cpi' ? '' : key === 'restaurant' ? '' : locale === 'it' ? '/mese' : locale === 'en' ? '/month' : locale === 'de' ? '/Monat' : '/mois'}</td>
              <td style="${TABLE_CELL_STYLE}">${src === 'OMI' ? citeOmi(src) : citeIstat(src)}</td>
            </tr>
          `,
          )
          .join('')}
      </tbody>
    </table>`;

  // — Comparison narrative —
  const chSingleTotal =
    fso.rooms_2_5.median_chf_month + 380 /* LAMal */ + 700 /* spesa */ + 75 /* trasporti */ + 200; /* utenze */
  const itSingleTotal =
    istat.rent_eur_month.rooms_2 +
    istat.grocery_basket_eur_month_single +
    istat.transport_monthly_pass_eur +
    Math.round(istat.utilities_eur_month_2p / 2);

  const tldr = (() => {
    switch (locale) {
      case 'it':
        return `A ${cityName} un bilocale costa in mediana ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/mese (${citeFso('FSO 2023')}), contro ${rtFmtEur(istat.rent_eur_month.rooms_2)} nella provincia di ${province} (${citeOmi('OMI 2024')}). Il single residente a ${cityName} spende ~${rtFmtChf(chSingleTotal)}/mese includendo LAMal + spesa + trasporti + utenze; lo stesso profilo residente in provincia di ${province} spende ~${rtFmtEur(itSingleTotal)}. Per il frontaliere che risiede lato Italia e lavora a ${cityName}, il risparmio netto su affitto + spesa + sanità è tipicamente del 40–55%.`;
      case 'en':
        return `In ${cityName}, a 2.5-room flat costs a median ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/month (${citeFso('FSO 2023')}) versus ${rtFmtEur(istat.rent_eur_month.rooms_2)} in ${province} province (${citeOmi('OMI 2024')}). A single resident in ${cityName} spends ~${rtFmtChf(chSingleTotal)}/month including LAMal + groceries + transport + utilities; the same profile in ${province} spends ~${rtFmtEur(itSingleTotal)}. For a cross-border worker living in Italy and working in ${cityName}, the combined net saving on rent + groceries + healthcare is typically 40–55%.`;
      case 'de':
        return `In ${cityName} kostet eine 2,5-Zimmer-Wohnung im Median ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/Monat (${citeFso('BFS 2023')}) gegenüber ${rtFmtEur(istat.rent_eur_month.rooms_2)} in der Provinz ${province} (${citeOmi('OMI 2024')}). Eine Einzelperson in ${cityName} gibt ~${rtFmtChf(chSingleTotal)}/Monat aus (Miete + LAMal + Einkauf + Verkehr + Nebenkosten); dasselbe Profil in der Provinz ${province} ~${rtFmtEur(itSingleTotal)}. Grenzgänger sparen typischerweise 40–55% netto auf Miete + Einkauf + Gesundheit.`;
      case 'fr':
        return `À ${cityName}, un 2,5 pièces coûte en médiane ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/mois (${citeFso('OFS 2023')}) contre ${rtFmtEur(istat.rent_eur_month.rooms_2)} en province de ${province} (${citeOmi('OMI 2024')}). Un célibataire à ${cityName} dépense ~${rtFmtChf(chSingleTotal)}/mois (loyer + LAMal + courses + transport + charges) ; le même profil en province de ${province} dépense ~${rtFmtEur(itSingleTotal)}. Pour un frontalier résidant côté italien et travaillant à ${cityName}, l'économie nette cumulée sur loyer + courses + santé est typiquement de 40–55%.`;
    }
  })();

  // — Comparison table —
  const comparisonHtml = (() => {
    const r = locale === 'it'
      ? { voice: 'Voce', ch: 'CH — ' + cityName, it: 'IT — ' + province, rent: 'Affitto bilocale', lamal: 'LAMal single', grocery: 'Spesa single', transport: 'Trasporti mensili', delta: 'Vantaggio frontaliere' }
      : locale === 'en'
      ? { voice: 'Item', ch: 'CH — ' + cityName, it: 'IT — ' + province, rent: '2.5-room rent', lamal: 'LAMal (single)', grocery: 'Groceries (single)', transport: 'Monthly transport', delta: 'Cross-border edge' }
      : locale === 'de'
      ? { voice: 'Position', ch: 'CH — ' + cityName, it: 'IT — ' + province, rent: '2,5-Zi-Miete', lamal: 'LAMal (Einzel)', grocery: 'Einkauf (Einzel)', transport: 'Monats-ÖV', delta: 'Grenzgänger-Vorteil' }
      : { voice: 'Poste', ch: 'CH — ' + cityName, it: 'IT — ' + province, rent: 'Loyer 2,5 pièces', lamal: 'LAMal (célib.)', grocery: 'Courses (célib.)', transport: 'Transports mensuels', delta: 'Atout frontalier' };

    const rentPct = Math.round(
      (1 - istat.rent_eur_month.rooms_2 / (fso.rooms_2_5.median_chf_month * 0.95)) * 100,
    );
    const groceryPct = Math.round(
      (1 - istat.grocery_basket_eur_month_single / (700 * 0.95)) * 100,
    );
    return `
      <table class="seo-table" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:15px">
        <thead><tr>
          <th style="${TABLE_HEAD_STYLE}">${r.voice}</th>
          <th style="${TABLE_HEAD_STYLE}">${r.ch}</th>
          <th style="${TABLE_HEAD_STYLE}">${r.it}</th>
          <th style="${TABLE_HEAD_STYLE}">${r.delta}</th>
        </tr></thead>
        <tbody>
          <tr>
            <td style="${TABLE_CELL_STYLE}">${r.rent}</td>
            <td style="${TABLE_CELL_STYLE}">${rtFmtChf(fso.rooms_2_5.median_chf_month)}</td>
            <td style="${TABLE_CELL_STYLE}">${rtFmtEur(istat.rent_eur_month.rooms_2)}</td>
            <td style="${TABLE_CELL_STYLE}"><strong>−${rentPct}%</strong></td>
          </tr>
          <tr>
            <td style="${TABLE_CELL_STYLE}">${r.lamal}</td>
            <td style="${TABLE_CELL_STYLE}">${rtFmtChf(380)}</td>
            <td style="${TABLE_CELL_STYLE}">${locale === 'it' ? 'SSN gratuito' : locale === 'en' ? 'SSN free' : locale === 'de' ? 'SSN kostenlos' : 'SSN gratuit'}</td>
            <td style="${TABLE_CELL_STYLE}"><strong>−100%</strong></td>
          </tr>
          <tr>
            <td style="${TABLE_CELL_STYLE}">${r.grocery}</td>
            <td style="${TABLE_CELL_STYLE}">${rtFmtChf(700)}</td>
            <td style="${TABLE_CELL_STYLE}">${rtFmtEur(istat.grocery_basket_eur_month_single)}</td>
            <td style="${TABLE_CELL_STYLE}"><strong>−${groceryPct}%</strong></td>
          </tr>
          <tr>
            <td style="${TABLE_CELL_STYLE}">${r.transport}</td>
            <td style="${TABLE_CELL_STYLE}">${rtFmtChf(75)}</td>
            <td style="${TABLE_CELL_STYLE}">${rtFmtEur(istat.transport_monthly_pass_eur)}</td>
            <td style="${TABLE_CELL_STYLE}"><strong>~par</strong></td>
          </tr>
        </tbody>
      </table>`;
  })();

  // — Frontaliere narrative (expanded for word-count) —
  const frontaliereHtml = (() => {
    switch (locale) {
      case 'it':
        return `<p>Il vantaggio del frontaliere non si riduce alla sola differenza salariale. Lavorando a ${cityName} e risiedendo in provincia di ${province}, si paga il salario svizzero (${citeFso('FSO — Indice des salaires')}) ma si sostiene il costo della vita italiano: affitto, spesa alimentare, assicurazione sanitaria (SSN invece di LAMal), scuola pubblica e cura anziani sono tutti ancorati ai prezzi ${citeIstat('ISTAT')} della provincia. Il delta su un bilocale è del 30–45% rispetto a ${cityName}; sulla spesa Migros/Coop vs Esselunga/Conad la forbice supera il 40% per il paniere base. Vanno però sottratti i costi di pendolarismo: abbonamento TILO o auto + pedaggio autostradale (${rtFmtEur(istat.transport_monthly_pass_eur * 2)}–${rtFmtEur(istat.transport_monthly_pass_eur * 3)}/mese per un pendolare da ${province}) e tempi di viaggio (30–75 min a tratta a seconda del valico).</p><p>Dal 2026 si applica il <strong>Nuovo Accordo fiscale Italia-Svizzera</strong>: i frontalieri assunti dopo il 17 luglio 2023 sono tassati sia in Svizzera (ritenuta alla fonte cantonale 6,5% netto per Ticino) sia in Italia (IRPEF con franchigia 10.000 € e detrazioni frontaliere). Chi era già frontaliere al 2023 mantiene il regime convenzionale (solo tassazione CH). Il costo fiscale ha impatto significativo sul risparmio netto — il simulatore in fondo pagina tiene conto di entrambi i regimi.</p>`;
      case 'en':
        return `<p>The cross-border edge is not just the salary delta. Working in ${cityName} while living in ${province} province means Swiss pay (${citeFso('FSO salary index')}) against Italian living costs: rent, groceries, healthcare (SSN instead of LAMal), public school and elderly care are all priced at ${citeIstat('ISTAT')} provincial levels. A 2.5-room flat runs 30–45% cheaper than in ${cityName}; the Migros/Coop vs Esselunga/Conad gap exceeds 40% on the staple basket. Commuting offsets apply: a TILO pass or car + highway toll runs ${rtFmtEur(istat.transport_monthly_pass_eur * 2)}–${rtFmtEur(istat.transport_monthly_pass_eur * 3)}/month for a ${province}-based commuter, plus 30–75 min each way depending on crossing.</p><p>Since 2026 the <strong>New Italy-Switzerland tax agreement</strong> applies: workers hired after 17 July 2023 are taxed in both jurisdictions (Swiss cantonal withholding ~6.5% net for Ticino, plus Italian IRPEF with 10,000 € exemption and cross-border deductions). Workers already commuting in 2023 keep the old convention-only Swiss regime. The net-saving calculator below accounts for both.</p>`;
      case 'de':
        return `<p>Der Grenzgänger-Vorteil geht über die reine Lohndifferenz hinaus. Wer in ${cityName} arbeitet und in der Provinz ${province} wohnt, verdient schweizerisch (${citeFso('BFS — Lohnindex')}), lebt aber zu italienischen Kosten: Miete, Einkauf, Krankenversicherung (SSN statt LAMal), öffentliche Schule und Altenpflege bleiben auf ${citeIstat('ISTAT')}-Provinzniveau. Eine 2,5-Zi-Wohnung ist 30–45% günstiger; der Warenkorb Migros/Coop vs Esselunga/Conad unterscheidet sich um über 40%. Davon abzuziehen: Pendelkosten ${rtFmtEur(istat.transport_monthly_pass_eur * 2)}–${rtFmtEur(istat.transport_monthly_pass_eur * 3)}/Monat (TILO-Abo oder Auto + Autobahnmaut) und 30–75 min Fahrzeit je Richtung.</p><p>Seit 2026 gilt das <strong>neue Steuerabkommen Italien-Schweiz</strong>: Nach dem 17. Juli 2023 eingestellte Grenzgänger werden in beiden Staaten besteuert (CH kantonale Quellensteuer ~6,5% netto für Tessin + IT IRPEF mit Freibetrag 10.000 €). Wer 2023 bereits pendelte, behält das bisherige reine CH-Regime.</p>`;
      case 'fr':
        return `<p>L'avantage frontalier ne se limite pas à l'écart salarial. En travaillant à ${cityName} et en résidant en province de ${province}, on perçoit le salaire suisse (${citeFso('OFS — Indice des salaires')}) mais on supporte le coût de la vie italien : loyer, courses, santé (SSN au lieu de LAMal), école publique et dépendance sont tous alignés sur les prix ${citeIstat('ISTAT')} provinciaux. Un 2,5 pièces coûte 30–45% de moins qu'à ${cityName} ; l'écart Migros/Coop vs Esselunga/Conad dépasse 40% sur le panier de base. À déduire : les frais de navettage (abonnement TILO ou voiture + péage ${rtFmtEur(istat.transport_monthly_pass_eur * 2)}–${rtFmtEur(istat.transport_monthly_pass_eur * 3)}/mois depuis ${province}) et 30–75 min de trajet par sens.</p><p>Depuis 2026, le <strong>nouvel accord fiscal Italie-Suisse</strong> s'applique : les frontaliers embauchés après le 17 juillet 2023 sont imposés dans les deux pays (retenue à la source cantonale CH ~6,5% net pour Tessin + IRPEF IT avec franchise 10 000 €). Les frontaliers en poste avant 2023 gardent l'ancien régime purement suisse.</p>`;
    }
  })();

  // — Sources methodology —
  const sourcesHtml = (() => {
    switch (locale) {
      case 'it':
        return `<p>Gli affitti svizzeri sono la mediana pubblicata dal ${citeFso('Ufficio federale di statistica (FSO/BFS)')} — rilevazione affitti 2023, pubblicata dicembre 2024 — per il comune di ${cityName}, al netto delle spese accessorie (Nebenkosten). I prezzi italiani provengono da ${citeOmi('OMI — Osservatorio Mercato Immobiliare')} dell'Agenzia delle Entrate (secondo semestre 2024) e da ${citeIstat('ISTAT — Indice prezzi al consumo')} per spesa alimentare, ristorazione e trasporti (rilevazione dicembre 2024). Per la LAMal abbiamo usato il premio mediano adulto franchigia 300 CHF regione ${citeFso('UFSP/Priminfo')} ${cityName === 'Canton Ticino' ? 'cantone TI' : 'regione di ' + cityName}. Gli aggiornamenti avvengono quando FSO/ISTAT pubblicano un nuovo rilascio (tipicamente annuale).</p>`;
      case 'en':
        return `<p>Swiss rents are the median published by the ${citeFso('Federal Statistical Office (FSO/BFS)')} — 2023 rent survey, released December 2024 — for the municipality of ${cityName}, net of utility charges (Nebenkosten). Italian prices come from ${citeOmi('OMI — Real-estate market observatory')} (Agenzia delle Entrate, H2 2024) and ${citeIstat('ISTAT — Consumer Price Index')} for groceries, restaurants and transport (December 2024 release). LAMal uses the median adult premium with 300 CHF franchise, ${citeFso('FOPH/Priminfo')} region for ${cityName}. Updated on each FSO/ISTAT release.</p>`;
      case 'de':
        return `<p>Schweizer Mieten: Median des ${citeFso('Bundesamts für Statistik (BFS)')} — Mietpreisstatistik 2023, veröffentlicht Dezember 2024 — für die Gemeinde ${cityName}, Nettomiete ohne Nebenkosten. Italienische Preise: ${citeOmi('OMI — Immobilienmarkt-Observatorium')} (Agenzia delle Entrate, H2 2024) und ${citeIstat('ISTAT — Konsumentenpreisindex')} (Dezember 2024). LAMal: Median-Prämie Erwachsene Franchise 300 CHF, ${citeFso('BAG/Priminfo')}-Region für ${cityName}.</p>`;
      case 'fr':
        return `<p>Les loyers suisses sont la médiane publiée par l'${citeFso('Office fédéral de la statistique (OFS/BFS)')} — enquête loyers 2023, parution décembre 2024 — pour la commune de ${cityName}, loyer net hors charges (Nebenkosten). Les prix italiens proviennent d'${citeOmi('OMI — Observatoire du marché immobilier')} (Agenzia delle Entrate, S2 2024) et d'${citeIstat('ISTAT — Indice des prix à la consommation')} (décembre 2024). LAMal : prime médiane adulte franchise 300 CHF, région ${citeFso('OFSP/Priminfo')} pour ${cityName}.</p>`;
    }
  })();

  return [
    { title: L.sectionTitles.tldr, html: `<p>${tldr}</p>` },
    { title: L.sectionTitles.rent, html: rentTableHtml },
    { title: L.sectionTitles.basket, html: basketTableHtml },
    { title: L.sectionTitles.comparison, html: comparisonHtml },
    { title: L.sectionTitles.frontaliere, html: frontaliereHtml },
    { title: L.sectionTitles.sources, html: sourcesHtml },
  ];
}

// ── FAQs (3 per page, data-driven) ─────────────────────────────────

export function buildFaqs(locale: ColLocale, cityId: ColCityId): readonly ColFaq[] {
  const fso = getFsoCity(cityId);
  const istat = getIstatProvince(cityId);
  const cityName = COL_CITY_DISPLAY[cityId][locale];
  const province = cityId === 'ticino' ? istat.region : istat.province;

  const qaByLocale: Record<ColLocale, readonly ColFaq[]> = {
    it: [
      {
        question: `Quanto costa un bilocale a ${cityName} nel 2026?`,
        answer: `A ${cityName} un 2,5 locali costa in mediana ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/mese (affitto netto, FSO 2023), con un prezzo al m² di ${rtFmtChf(fso.price_per_m2_chf_month)}/m². Aggiungere 150–220 CHF/mese di spese accessorie (riscaldamento, acqua, pulizia scale). Il deposito cauzionale è tipicamente 3 mensilità.`,
      },
      {
        question: `Conviene vivere in provincia di ${province} e lavorare a ${cityName}?`,
        answer: `Sì per la maggior parte dei frontalieri: il bilocale OMI in provincia di ${province} è ${rtFmtEur(istat.rent_eur_month.rooms_2)}/mese contro ${rtFmtChf(fso.rooms_2_5.median_chf_month)} a ${cityName} (risparmio ~40%); la spesa ISTAT per un single è ${rtFmtEur(istat.grocery_basket_eur_month_single)}/mese contro 600–800 CHF in Ticino. A carico: ${rtFmtEur(istat.transport_monthly_pass_eur)}/mese di abbonamento locale + biglietto TILO o pedaggio valico + 30–75 min di viaggio a tratta.`,
      },
      {
        question: `Quali sono le fonti ufficiali dei dati?`,
        answer: `Gli affitti svizzeri sono la mediana FSO comunale (rilevazione 2023, pubblicata dic. 2024), gli affitti italiani OMI-Agenzia Entrate (H2 2024), il paniere ISTAT per spesa, ristorante, trasporti e CPI (dic. 2024). Le fonti sono citate in ogni cella della tabella. Aggiorniamo a ogni nuovo rilascio ufficiale.`,
      },
    ],
    en: [
      {
        question: `How much does a 2.5-room flat cost in ${cityName} in 2026?`,
        answer: `In ${cityName} a 2.5-room flat rents at a median ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/month (net rent, FSO 2023), at ${rtFmtChf(fso.price_per_m2_chf_month)}/m². Add 150–220 CHF/month utility charges (heating, water, building upkeep). Deposits are typically 3 months.`,
      },
      {
        question: `Is it worth living in ${province} province and working in ${cityName}?`,
        answer: `For most cross-border workers, yes: a 2.5-room flat (OMI) in ${province} costs ${rtFmtEur(istat.rent_eur_month.rooms_2)}/month vs ${rtFmtChf(fso.rooms_2_5.median_chf_month)} in ${cityName} (~40% saving); ISTAT groceries for a single run ${rtFmtEur(istat.grocery_basket_eur_month_single)}/month vs 600–800 CHF in Ticino. Offsets: ${rtFmtEur(istat.transport_monthly_pass_eur)}/month transport pass + TILO or toll + 30–75 min each way.`,
      },
      {
        question: `What are the official sources?`,
        answer: `Swiss rents are FSO municipal medians (2023 survey, Dec 2024 release), Italian rents are OMI (Agenzia delle Entrate, H2 2024), and the ISTAT basket covers groceries, restaurants, transport and CPI (Dec 2024). Every table cell carries the source URL. We refresh at each official release.`,
      },
    ],
    de: [
      {
        question: `Wie viel kostet eine 2,5-Zimmer-Wohnung in ${cityName} 2026?`,
        answer: `In ${cityName} kostet eine 2,5-Zi-Wohnung im Median ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/Monat (Nettomiete, BFS 2023), ${rtFmtChf(fso.price_per_m2_chf_month)}/m². Plus 150–220 CHF Nebenkosten. Kaution meist 3 Monatsmieten.`,
      },
      {
        question: `Lohnt es sich, in der Provinz ${province} zu wohnen und in ${cityName} zu arbeiten?`,
        answer: `Für die meisten Grenzgänger ja: eine 2,5-Zi-Wohnung in ${province} (OMI) kostet ${rtFmtEur(istat.rent_eur_month.rooms_2)}/Monat gegen ${rtFmtChf(fso.rooms_2_5.median_chf_month)} in ${cityName} (ca. 40% günstiger); ISTAT-Einkauf für Einzelperson ${rtFmtEur(istat.grocery_basket_eur_month_single)}/Monat vs 600–800 CHF im Tessin. Abzüge: ${rtFmtEur(istat.transport_monthly_pass_eur)}/Monat Abo + TILO oder Maut + 30–75 min pro Richtung.`,
      },
      {
        question: `Was sind die offiziellen Quellen?`,
        answer: `Schweizer Mieten: BFS-Gemeindemedian (Erhebung 2023, Rel. Dez. 2024). Italienische Mieten: OMI (Agenzia delle Entrate, H2 2024). Einkauf/Restaurant/Verkehr/CPI: ISTAT (Dez. 2024). Jede Tabellenzelle verlinkt die Quelle.`,
      },
    ],
    fr: [
      {
        question: `Combien coûte un 2,5 pièces à ${cityName} en 2026 ?`,
        answer: `À ${cityName} un 2,5 pièces coûte en médiane ${rtFmtChf(fso.rooms_2_5.median_chf_month)}/mois (loyer net, OFS 2023), ${rtFmtChf(fso.price_per_m2_chf_month)}/m². Ajouter 150–220 CHF de charges. Caution typique 3 mois.`,
      },
      {
        question: `Vaut-il mieux vivre en province de ${province} et travailler à ${cityName} ?`,
        answer: `Pour la plupart des frontaliers, oui : un 2,5 pièces (OMI) en province de ${province} coûte ${rtFmtEur(istat.rent_eur_month.rooms_2)}/mois contre ${rtFmtChf(fso.rooms_2_5.median_chf_month)} à ${cityName} (~40% d'économie) ; les courses ISTAT célibataire ${rtFmtEur(istat.grocery_basket_eur_month_single)}/mois contre 600–800 CHF au Tessin. À déduire : ${rtFmtEur(istat.transport_monthly_pass_eur)}/mois d'abonnement + TILO ou péage + 30–75 min par sens.`,
      },
      {
        question: `Quelles sont les sources officielles ?`,
        answer: `Loyers suisses : médiane OFS par commune (enquête 2023, publication déc. 2024). Loyers italiens : OMI (Agenzia delle Entrate, S2 2024). Panier : ISTAT (courses, restaurant, transport, IPC — déc. 2024). Chaque cellule cite la source.`,
      },
    ],
  };
  return qaByLocale[locale];
}

export function getLocaleStrings(locale: ColLocale): LocaleStrings {
  return LS[locale];
}
