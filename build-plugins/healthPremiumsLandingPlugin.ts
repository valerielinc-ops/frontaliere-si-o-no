/**
 * Vite build plugin — emits evergreen SEO landing pages for LAMal premiums.
 *
 * F2 — LAMal per canton × age (moat play).
 *
 * Data source: `data/health-premiums.json` (48k lines, refreshed annually
 * from BAG/UFSP open data via scripts/fetch-health-premiums.mjs).
 *
 * Page shape (4 locales × 36 pages = 144 static HTML files):
 *   - 1 root hub per locale (canton overview)
 *   - 5 canton hubs per locale (age-bracket overview)
 *   - 30 leaves per locale (canton × age)
 *
 * Each page:
 *   - ≥50 words hard gate (shared MIN_INDEXABLE_WORDS)
 *   - Leaf target ≥400 words, hub target ≥300
 *   - JSON-LD: WebPage + BreadcrumbList + FAQPage (leaves); WebPage + Breadcrumb (hubs)
 *   - Self-referencing canonical + hreflang alternates for all 4 locales
 *   - Product/Offer LD with priceCurrency CHF on leaf pages
 *   - WriteCollector with skipExisting (preserves prior builds on incremental CI)
 *   - Default-off gate: SKIP_HEALTH_PREMIUMS=1
 *
 * Kept standalone so parallel SEO worktrees merge cleanly.
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
import { WriteCollector } from './batchWrite';
import {
  HEALTH_PREMIUM_AGE_BRACKETS,
  HEALTH_PREMIUM_AGE_LABEL,
  HEALTH_PREMIUM_AGE_MULTIPLIER,
  HEALTH_PREMIUM_BRACKET_RISK_CLASS,
  HEALTH_PREMIUM_CANTON_BAG_CODE,
  HEALTH_PREMIUM_CANTON_DISPLAY,
  HEALTH_PREMIUM_CANTON_SLUG,
  HEALTH_PREMIUM_CANTONS,
  HEALTH_PREMIUM_COMPARATOR_PATH,
  HEALTH_PREMIUM_LOCALES,
  buildHealthPremiumsCantonPath,
  buildHealthPremiumsLeafPath,
  buildHealthPremiumsRootPath,
  computeYoyDelta,
  computeTriYearDelta,
  loadPremiumsForYear,
  type HealthPremiumAgeBracket,
  type HealthPremiumCanton,
  type HealthPremiumLocale,
  type HealthPremiumRiskClass,
  type YoyCantonDelta,
  type TriYearCantonDelta,
  type BracketTrend,
} from './healthPremiumsData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { cleanNamespaces, cleanSitemapFiles } from './shared/distNamespaceCleanup';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CARD_STYLE,
  CTA_PRIMARY_STYLE,
  H1_STYLE,
  H2_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  STAT_TILE_ACCENT,
  STAT_TILE_BASE,
  STAT_TILE_DANGER,
  STAT_TILE_LABEL,
  STAT_TILE_SUCCESS,
  STAT_TILE_VALUE,
  STAT_TILE_WARNING,
  TABLE_CELL_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_STYLE,
} from './shared/seoContentTokens';

// ── Types (dataset shape) ──────────────────────────────────────

export interface InsurerEntry {
  id: string;
  name: string;
  website?: string;
}

type ModelType = 'standard' | 'hausarzt' | 'telmed' | 'hmo';
type ModelPremiums = Partial<Record<ModelType, number>>;

/**
 * Insurer entry under `block.insurers[id]`. The dataset exposes both:
 *  - flat model keys (`standard`, `hausarzt`, ...) which alias the AKL-ERW
 *    (adult 26+) premium — preserved for backward compatibility with the
 *    pre-F2-KIN/JUG schema.
 *  - `byAgeClass.{KIN|JUG|ERW}.{standard|hausarzt|...}` which holds the real
 *    BAG-published premium per risk class. Consumers that want
 *    bracket-specific values must read `byAgeClass`.
 */
export type PremiumByModel = ModelPremiums & {
  byAgeClass?: Partial<Record<HealthPremiumRiskClass, ModelPremiums>>;
};

type PremiumByInsurer = Record<string, PremiumByModel>;

interface CantonPremiumBlock {
  type?: 'canton';
  canton?: string;
  region?: number | null;
  insurers: PremiumByInsurer;
  bfsNr?: number;
}

export interface HealthPremiumsDataset {
  fetchedAt?: string;
  year?: number;
  insurers?: InsurerEntry[];
  premiums?: Record<string, CantonPremiumBlock>;
}

// ── Helpers ────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function roundCHF(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatCHF(n: number | null, locale: HealthPremiumLocale): string {
  if (n === null || Number.isNaN(n)) return '—';
  const sep = locale === 'it' || locale === 'fr' ? ',' : '.';
  return n.toFixed(2).replace('.', sep);
}

/**
 * Format a YoY delta percentage for display. Always include the sign so the
 * direction is visible at a glance; returns '—' when the value is null.
 */
function formatPct(n: number | null, locale: HealthPremiumLocale): string {
  if (n === null || Number.isNaN(n)) return '—';
  const sep = locale === 'it' || locale === 'fr' ? ',' : '.';
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}${n.toFixed(2).replace('.', sep)}%`;
}

/**
 * Render a small inline SVG sparkline plotting the bracket median across the
 * 2- or 3-year window. Returns an empty string when fewer than 2 points are
 * available (no curve to draw).
 *
 * The sparkline is fully self-contained (no external CSS, no `dark:` prefix
 * because dark-mode tokens come from `index.css`) and uses semantic `aria-*`
 * markup so screen readers narrate the trend.
 */
function renderSparkline(
  trend: BracketTrend,
  locale: HealthPremiumLocale,
  ariaLabel: string,
): string {
  const pts = trend.points.filter((p) => p.median !== null) as Array<{
    year: number;
    median: number;
    insurers: number;
  }>;
  if (pts.length < 2) return '';
  const W = 220;
  const H = 60;
  const PAD = 12;
  const minY = Math.min(...pts.map((p) => p.median));
  const maxY = Math.max(...pts.map((p) => p.median));
  const span = maxY - minY || 1;
  const stepX = (W - 2 * PAD) / (pts.length - 1);
  const coords = pts.map((p, i) => {
    const x = PAD + i * stepX;
    // Higher CHF → lower y so the chart reads "up = more expensive".
    const y = H - PAD - ((p.median - minY) / span) * (H - 2 * PAD);
    return { x, y, p };
  });
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const dots = coords
    .map(
      (c) =>
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="#1d4ed8" stroke="#ffffff" stroke-width="1.5" />`,
    )
    .join('');
  const labels = coords
    .map((c, i) => {
      const isFirst = i === 0;
      const isLast = i === coords.length - 1;
      const anchor = isFirst ? 'start' : isLast ? 'end' : 'middle';
      const dx = isFirst ? -2 : isLast ? 2 : 0;
      return `<text x="${(c.x + dx).toFixed(1)}" y="${H - 1}" font-size="9" fill="#475569" text-anchor="${anchor}">${c.p.year}</text>`;
    })
    .join('');
  const tooltips = coords
    .map((c) => {
      const valueLabel = `${c.p.year}: ${formatCHF(roundCHF(c.p.median), locale)} CHF`;
      return `<title>${esc(valueLabel)}</title>`;
    })
    .join('');
  return `<svg role="img" aria-label="${esc(ariaLabel)}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;margin-top:6px">
    ${tooltips}
    <path d="${linePath}" stroke="#1d4ed8" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
    ${dots}
    ${labels}
  </svg>`;
}

const LOCALE_OG: Record<HealthPremiumLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

// ── Data extraction ────────────────────────────────────────────

/**
 * Given the dataset, return all premium blocks that belong to a given BAG
 * canton code. For canton-level-only cantons (UR, ZH, AG, ...) there is one
 * block keyed by canton code. For commune-level cantons (TI, GR, VS) there
 * are many blocks keyed by "{plz}-{commune}". Missing canton → empty array.
 */
function blocksForCanton(
  dataset: HealthPremiumsDataset,
  cantonCode: string,
): CantonPremiumBlock[] {
  const out: CantonPremiumBlock[] = [];
  const all = dataset.premiums ?? {};
  // Canton-level block: key equals canton code, type === 'canton'
  const cantonBlock = all[cantonCode];
  if (cantonBlock && cantonBlock.type === 'canton' && cantonBlock.canton === cantonCode) {
    out.push(cantonBlock);
  }
  // Commune-level blocks: iterate, pick where block.canton matches.
  for (const [key, block] of Object.entries(all)) {
    if (key === cantonCode) continue;
    if (!block || typeof block !== 'object') continue;
    if (block.canton === cantonCode) {
      out.push(block);
    }
  }
  return out;
}

/**
 * Aggregate per-insurer standard premium for a given risk class across all
 * provided blocks. Returns a map keyed by insurer id → average standard
 * premium (CHF/month), plus a `sourceByInsurer` marker that records whether
 * the value came from a real `byAgeClass[riskClass]` entry ('real') or
 * was back-filled from the flat ERW alias ('ambiguous' — for ERW this is
 * identical to 'real'). An insurer appears in the output only when at
 * least one block contributed a usable premium.
 */
interface AggregatedPremiums {
  byInsurer: Record<string, number>;
  sourceByInsurer: Record<string, 'real' | 'derived'>;
}

function aggregatePremiumsByRiskClass(
  blocks: CantonPremiumBlock[],
  riskClass: HealthPremiumRiskClass,
): AggregatedPremiums {
  const sums: Record<string, { sum: number; count: number; realCount: number }> = {};
  for (const block of blocks) {
    for (const [insurerId, models] of Object.entries(block.insurers || {})) {
      // Prefer real per-risk-class value when present.
      const bac = models.byAgeClass?.[riskClass];
      let price: number | null = null;
      let isReal = false;
      if (bac && typeof bac.standard === 'number') {
        price = bac.standard;
        isReal = true;
      } else if (riskClass === 'ERW' && typeof models.standard === 'number') {
        // Back-compat: legacy dataset exposes flat fields that alias ERW.
        price = models.standard;
        isReal = true;
      } else if (typeof models.standard === 'number') {
        // Fallback for KIN / JUG when real data is missing: apply the
        // statutory multiplier. Marked as 'derived' so downstream UI can
        // caveat the leaf page.
        const mult = riskClass === 'KIN' ? 0.25 : riskClass === 'JUG' ? 0.80 : 1.0;
        price = models.standard * mult;
        isReal = false;
      }
      if (price === null) continue;
      if (!sums[insurerId]) sums[insurerId] = { sum: 0, count: 0, realCount: 0 };
      sums[insurerId].sum += price;
      sums[insurerId].count += 1;
      if (isReal) sums[insurerId].realCount += 1;
    }
  }
  const byInsurer: Record<string, number> = {};
  const sourceByInsurer: Record<string, 'real' | 'derived'> = {};
  for (const [id, { sum, count, realCount }] of Object.entries(sums)) {
    if (count === 0) continue;
    byInsurer[id] = roundCHF(sum / count);
    // 'real' iff every contributing block provided a real BAG KIN/JUG/ERW
    // premium — otherwise at least one value was multiplier-derived and we
    // surface that to the consumer.
    sourceByInsurer[id] = realCount === count ? 'real' : 'derived';
  }
  return { byInsurer, sourceByInsurer };
}

export interface BracketPremiumStats {
  bracket: HealthPremiumAgeBracket;
  riskClass: HealthPremiumRiskClass;
  /** Per-insurer standard premium (CHF/month) for this risk class. */
  byInsurer: Record<string, number>;
  /** 'real' = every block exposed byAgeClass data; 'derived' = multiplier fallback. */
  sourceByInsurer: Record<string, 'real' | 'derived'>;
  /** Ranked ascending. */
  ranked: Array<{ insurerId: string; price: number; source: 'real' | 'derived' }>;
  min: number | null;
  max: number | null;
  medianPrice: number | null;
  /** True when every insurer's price came from real BAG byAgeClass data. */
  allReal: boolean;
}

function buildBracketStats(
  blocks: CantonPremiumBlock[],
  bracket: HealthPremiumAgeBracket,
): BracketPremiumStats | null {
  const riskClass = HEALTH_PREMIUM_BRACKET_RISK_CLASS[bracket];
  const { byInsurer, sourceByInsurer } = aggregatePremiumsByRiskClass(blocks, riskClass);
  const ids = Object.keys(byInsurer);
  if (ids.length === 0) return null;
  const ranked = ids
    .map((id) => ({ insurerId: id, price: byInsurer[id], source: sourceByInsurer[id] }))
    .sort((a, b) => a.price - b.price);
  const prices = ranked.map((r) => r.price);
  const allReal = ranked.every((r) => r.source === 'real');
  return {
    bracket,
    riskClass,
    byInsurer,
    sourceByInsurer,
    ranked,
    min: Math.min(...prices),
    max: Math.max(...prices),
    medianPrice: median(prices),
    allReal,
  };
}

export interface CantonPremiumStats {
  canton: HealthPremiumCanton;
  cantonBagCode: string;
  /** Number of source blocks (1 for canton-level, N for commune-level). */
  sourceBlocks: number;
  /** Per-insurer adult standard premium (CHF/month), averaged if commune-level. */
  adultByInsurer: Record<string, number>;
  /** Ranked list of (insurerId, price) ascending. */
  ranked: Array<{ insurerId: string; price: number }>;
  adultMin: number | null;
  adultMax: number | null;
  adultMedian: number | null;
  /**
   * Pre-computed bracket stats for every LAMal age bracket. Leaf pages use
   * the entry for their own bracket; the canton hub uses the medians to
   * populate its age-grid.
   */
  bracketStats: Record<HealthPremiumAgeBracket, BracketPremiumStats | null>;
}

export function computeCantonStats(
  dataset: HealthPremiumsDataset,
  canton: HealthPremiumCanton,
): CantonPremiumStats | null {
  const cantonBagCode = HEALTH_PREMIUM_CANTON_BAG_CODE[canton];
  const blocks = blocksForCanton(dataset, cantonBagCode);
  if (blocks.length === 0) return null;
  const erw = aggregatePremiumsByRiskClass(blocks, 'ERW');
  const adultByInsurer = erw.byInsurer;
  const prices = Object.values(adultByInsurer);
  if (prices.length === 0) return null;
  const ranked = Object.entries(adultByInsurer)
    .map(([id, price]) => ({ insurerId: id, price }))
    .sort((a, b) => a.price - b.price);
  const bracketStats = {} as Record<HealthPremiumAgeBracket, BracketPremiumStats | null>;
  for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
    bracketStats[ab.id] = buildBracketStats(blocks, ab.id);
  }
  return {
    canton,
    cantonBagCode,
    sourceBlocks: blocks.length,
    adultByInsurer,
    ranked,
    adultMin: Math.min(...prices),
    adultMax: Math.max(...prices),
    adultMedian: median(prices),
    bracketStats,
  };
}

/**
 * Resolve the insurer display name from the dataset's insurer directory.
 * Falls back to the raw ID if not found.
 */
function resolveInsurerName(dataset: HealthPremiumsDataset, id: string): string {
  const match = (dataset.insurers ?? []).find((ins) => ins.id === id);
  return match?.name ?? `Cassa #${id}`;
}

// ── Localised copy ─────────────────────────────────────────────

interface LeafCopy {
  breadcrumbHome: string;
  breadcrumbRoot: string;
  h1: (canton: string, age: string) => string;
  intro: (canton: string, age: string, median: string, min: string, max: string, year: number) => string;
  tableHeaders: { rank: string; insurer: string; premium: string };
  top20Title: (canton: string, age: string) => string;
  rankingTitle: string;
  editorialTitle: string;
  editorial: (canton: string, age: string, median: string, year: number) => string;
  derivationNote: string;
  comparatorCTA: string;
  comparatorCTAText: string;
  statsLabels: { median: string; min: string; max: string; insurers: string };
  faqTitle: string;
  faq: Array<{ q: (canton: string, age: string) => string; a: (canton: string, age: string, median: string, min: string, max: string) => string }>;
  priceUnit: string;
  rankingIntro: (canton: string) => string;
  /** Localised copy for the "Variazione vs {priorYear}" section (F2 A3). */
  yoy: {
    sectionTitle: (priorYear: number) => string;
    summary: (canton: string, age: string, medianPct: string, priorYear: number, insurersCount: number) => string;
    tableCaption: (priorYear: number) => string;
    tableHeaders: { rank: string; insurer: string; delta: string };
    emptyPriorNote: (priorYear: number) => string;
  };
  /**
   * Localised copy for the tri-year trend section (B-cont-4). Renders only
   * when 2024 + 2025 + current data are all available. Falls back silently
   * when 2024 is missing (the YoY block above already covers the 2-year case).
   */
  triYear: {
    sectionTitle: (oldestYear: number, currentYear: number) => string;
    summary: (
      canton: string,
      age: string,
      oldestYear: number,
      priorYear: number,
      currentYear: number,
      yoyOlder: string,
      yoyRecent: string,
      cumulative: string,
    ) => string;
    sparklineLabel: (canton: string, age: string) => string;
  };
}

interface HubCopy {
  breadcrumbHome: string;
  h1Root: (year: number) => string;
  h1Canton: (canton: string, year: number) => string;
  introRoot: (year: number) => string;
  introCanton: (canton: string, median: string, min: string, max: string, year: number) => string;
  ageGridTitle: (canton: string) => string;
  cantonGridTitle: string;
  cantonGridHeaders: { canton: string; median: string; min: string; max: string };
  ageGridHeaders: { age: string; median: string; slug: string };
  comparatorCTA: string;
  comparatorCTAText: string;
  viewCantonCTA: (canton: string) => string;
  openLeafCTA: string;
  rootBackgroundTitle: string;
  rootBackground: string;
  faqTitle: string;
  rootFaq: Array<{ q: string; a: (year: number) => string }>;
  cantonFaq: Array<{ q: (canton: string) => string; a: (canton: string, median: string, year: number) => string }>;
  priceUnit: string;
  updatedLabel: string;
  /** Canton-hub YoY summary copy (F2 A3). */
  yoy: {
    sectionTitle: (priorYear: number) => string;
    cantonSummary: (canton: string, adultMedianPct: string, priorYear: number) => string;
    gridCaption: (priorYear: number) => string;
    gridHeaders: { age: string; delta: string };
  };
  /** Canton-hub tri-year trend copy (B-cont-4). */
  triYear: {
    sectionTitle: (oldestYear: number, currentYear: number) => string;
    cantonSummary: (
      canton: string,
      oldestYear: number,
      currentYear: number,
      cumulative: string,
    ) => string;
  };
}

const LEAF_COPY: Record<HealthPremiumLocale, LeafCopy> = {
  it: {
    breadcrumbHome: 'Home',
    breadcrumbRoot: 'Premi Cassa Malati',
    h1: (c, a) => `Premi Cassa Malati ${c} 2026 — fascia ${a}`,
    intro: (c, a, median, min, max, year) =>
      `Premi LAMal ${year} in ${c} per ${a}: mediana ${median} CHF/mese, range da ${min} a ${max} CHF. Dati ufficiali UFSP/BAG con franchigia minima (CHF 300 adulti, CHF 0 bambini), senza copertura infortuni. Confronta le principali casse malati e trova l'assicurazione più conveniente per la tua situazione familiare.`,
    tableHeaders: { rank: 'Posizione', insurer: 'Cassa Malati', premium: 'Premio mensile' },
    top20Title: (c, a) => `Top 20 casse malati in ${c} — ${a}`,
    rankingTitle: 'Confronto con i cantoni limitrofi',
    editorialTitle: 'Come funziona il premio LAMal in questa fascia',
    editorial: (c, a, median, year) =>
      `Sotto la legge LAMal svizzera, tutti i residenti devono stipulare un'assicurazione malattia di base. Il premio varia per cantone, regione premi e cassa, ma è uniforme tra tutti gli adulti dai 26 anni in su: non esistono aumenti legati all'età in senso stretto come nelle assicurazioni complementari. Per ${c} nel ${year}, la mediana della fascia ${a} si attesta su ${median} CHF/mese. I frontalieri residenti in Italia che lavorano in Svizzera possono scegliere il regime sanitario tra LAMal svizzera o SSN italiano (diritto di opzione), un passaggio che va valutato con un consulente autorizzato. Chi opta per la LAMal paga il premio indicato e riceve le prestazioni di base in Svizzera; chi sceglie il SSN italiano resta coperto in Italia ma perde la rete di fornitori svizzeri. La scelta dipende dall'età, dallo stato di salute, dal luogo di residenza e dalla famiglia. Le casse più economiche nella fascia di età che ti interessa variano ogni anno: usa la tabella sopra per identificarle e confrontale con il nostro strumento.`,
    derivationNote:
      "Nota: i premi per bambini (0-18) e giovani adulti (19-25) sono stimati applicando i massimali statutari BAG 2026 (25% e 80% del premio adulto); per valori esatti per singola cassa consulta il comparatore.",
    comparatorCTA: 'Vai al comparatore',
    comparatorCTAText: 'Apri il comparatore pre-filtrato su questo cantone e fascia d\'età per vedere tutte le casse con preventivi personalizzati.',
    statsLabels: { median: 'Mediana', min: 'Premio minimo', max: 'Premio massimo', insurers: 'Casse considerate' },
    faqTitle: 'Domande frequenti',
    faq: [
      {
        q: (c, a) => `Quanto costa la cassa malati in ${c} per la fascia ${a}?`,
        a: (c, a, m, min, max) =>
          `Nel ${c} la fascia ${a} paga in media ${m} CHF al mese di premio LAMal di base (franchigia 300, senza infortuni). Il range tra le casse va da ${min} a ${max} CHF/mese. Le differenze dipendono dal modello assicurativo (standard, medico di base, telmed, HMO).`,
      },
      {
        q: () => 'Quale cassa malati è più economica?',
        a: (_, __, ___, min) =>
          `La cassa più economica varia ogni anno — nel 2026 il premio minimo mensile per la fascia indicata è di ${min} CHF. Consulta la tabella completa per vedere il ranking aggiornato di tutte le casse nel cantone selezionato.`,
      },
      {
        q: () => 'Come risparmio sul premio?',
        a: () =>
          "Tre leve principali: (1) scegli un modello alternativo — medico di base, HMO o telemedicina risparmia tipicamente 10-20% rispetto allo standard; (2) alza la franchigia fino a CHF 2 500 se sei in salute (risparmio fino al 50%); (3) confronta ogni ottobre le nuove tariffe dell'anno seguente e cambia cassa entro il 30 novembre se trovi un'offerta migliore.",
      },
      {
        q: () => 'I frontalieri pagano la LAMal?',
        a: () =>
          'I frontalieri che lavorano in Svizzera hanno il diritto di opzione tra LAMal svizzera e SSN italiano (o assicurazione privata in Francia/Germania/Austria). Chi sceglie la LAMal paga il premio pieno come un residente svizzero; chi opta per il SSN italiano resta coperto in Italia. La scelta va esercitata entro 3 mesi dall\'inizio dell\'attività e va valutata caso per caso.',
      },
      {
        q: () => 'Il premio cambia con l\'età?',
        a: () =>
          "Sotto la LAMal il premio è uniforme per tutti gli adulti dai 26 anni in su: non aumenta con l'età. Bambini (0-18) e giovani adulti (19-25) pagano meno per legge. Nelle assicurazioni complementari (LCA), invece, il premio cresce progressivamente con l'età.",
      },
    ],
    priceUnit: 'CHF/mese',
    rankingIntro: (c) =>
      `Ecco come si posiziona ${c} rispetto agli altri cantoni target per la stessa fascia di età. I premi LAMal variano significativamente tra cantoni anche all'interno della stessa regione linguistica.`,
    yoy: {
      sectionTitle: (py) => `Variazione rispetto al ${py}`,
      summary: (c, a, medPct, py, n) =>
        `Rispetto al ${py}, il premio mediano in ${c} per la fascia ${a} è variato di ${medPct} (${n} casse confrontate). Questa variazione riflette la revisione annuale delle tariffe approvata dal Consiglio federale e pubblicata a fine settembre. Nelle tabelle qui sotto confrontiamo, per ogni cassa con dati in entrambi gli anni, il premio attuale con quello dell'anno precedente per evidenziare gli aumenti e le riduzioni più significative.`,
      tableCaption: (py) => `Top 20 casse per variazione percentuale rispetto al ${py}, dalla riduzione più marcata all'aumento più alto`,
      tableHeaders: { rank: 'Posizione', insurer: 'Cassa malati', delta: `Δ vs anno prec.` },
      emptyPriorNote: (py) =>
        `I dati ${py} non sono disponibili per questa combinazione: la sezione di variazione verrà popolata al prossimo refresh dell'archivio BAG.`,
    },
    triYear: {
      sectionTitle: (oy, cy) => `Trend triennale ${oy} → ${cy}`,
      summary: (c, a, oy, py, cy, yoyOlder, yoyRecent, cum) =>
        `Andamento dei premi LAMal in ${c} per la fascia ${a} negli ultimi tre anni: ${oy} → ${py} → ${cy}, con variazioni ${yoyOlder} e ${yoyRecent}, per un totale cumulato di ${cum} sul biennio. La traiettoria mostra come la revisione tariffaria annuale del Consiglio federale si sia stratificata: un singolo aumento può sembrare contenuto, ma la somma su due esercizi è la lettura corretta per pianificare il budget familiare.`,
      sparklineLabel: (c, a) => `Mediana dei premi mensili in ${c} per la fascia ${a} negli ultimi tre anni (CHF/mese)`,
    },
  },
  en: {
    breadcrumbHome: 'Home',
    breadcrumbRoot: 'Health Insurance Premiums',
    h1: (c, a) => `Health insurance premiums ${c} 2026 — ${a}`,
    intro: (c, a, m, min, max, year) =>
      `LAMal health insurance premiums ${year} in ${c} for ${a}: median ${m} CHF/month, range from ${min} to ${max} CHF. Official FOPH/BAG data with the minimum deductible (CHF 300 for adults, CHF 0 for children) and no accident cover. Compare the main health funds and find the most affordable insurer for your situation.`,
    tableHeaders: { rank: 'Rank', insurer: 'Health fund', premium: 'Monthly premium' },
    top20Title: (c, a) => `Top 20 health funds in ${c} — ${a}`,
    rankingTitle: 'Benchmark vs neighbouring cantons',
    editorialTitle: 'How the LAMal premium works in this bracket',
    editorial: (c, a, m, year) =>
      `Under Swiss LAMal law, every resident must hold a basic health insurance. The premium varies by canton, premium region and health fund, but it is flat across all adults aged 26 and over — there is no age-based increase inside LAMal itself (unlike supplementary LCA cover). In ${c} for ${year}, the median for bracket ${a} is ${m} CHF/month. Cross-border workers living in Italy can elect either the Swiss LAMal or the Italian SSN under the "right of option" — this choice depends on age, health status, residence and family situation and should be evaluated with a licensed adviser. Use the table above to identify the cheapest funds in the age bracket and compare them using our interactive comparator below.`,
    derivationNote:
      "Note: premiums for children (0-18) and young adults (19-25) are estimated by applying BAG 2026 statutory caps (25% and 80% of the adult premium); for exact per-insurer figures use the comparator.",
    comparatorCTA: 'Open the comparator',
    comparatorCTAText: 'Pre-filtered on this canton and age bracket — see every fund with a personalised quote.',
    statsLabels: { median: 'Median', min: 'Lowest premium', max: 'Highest premium', insurers: 'Funds surveyed' },
    faqTitle: 'Frequently asked questions',
    faq: [
      {
        q: (c, a) => `How much does health insurance cost in ${c} for ${a}?`,
        a: (c, a, m, min, max) =>
          `In ${c}, bracket ${a} pays ${m} CHF per month on average for basic LAMal cover (CHF 300 deductible, no accident cover). The range across health funds goes from ${min} to ${max} CHF/month. Differences depend on the insurance model (standard, family doctor, telmed, HMO).`,
      },
      {
        q: () => 'Which health fund is cheapest?',
        a: (_, __, ___, min) =>
          `The cheapest fund changes every year — in 2026 the lowest monthly premium for this bracket is ${min} CHF. Check the full table for the live ranking of all funds in the selected canton.`,
      },
      {
        q: () => 'How can I save on my premium?',
        a: () =>
          'Three main levers: (1) pick an alternative model — family doctor, HMO or telemedicine typically saves 10-20% vs standard; (2) raise the annual deductible up to CHF 2,500 if you are healthy (savings up to ~50%); (3) compare rates every October for the following year and switch by 30 November if a better offer appears.',
      },
      {
        q: () => 'Do cross-border workers pay LAMal?',
        a: () =>
          'Cross-border workers in Switzerland have the "right of option" — they can choose Swiss LAMal or stay on the Italian SSN (or the German/French/Austrian system). LAMal choosers pay the same premium as a Swiss resident; SSN choosers stay covered in Italy. The option must be exercised within 3 months of starting work.',
      },
      {
        q: () => 'Does the premium change with age?',
        a: () =>
          'Under LAMal the premium is flat for all adults from 26 onwards — it does not rise with age. Children (0-18) and young adults (19-25) pay less by law. Supplementary LCA cover, on the other hand, does rise with age.',
      },
    ],
    priceUnit: 'CHF/month',
    rankingIntro: (c) =>
      `Here is how ${c} ranks against the other target cantons for the same age bracket. LAMal premiums vary significantly across cantons even within the same language region.`,
    yoy: {
      sectionTitle: (py) => `Change vs ${py}`,
      summary: (c, a, medPct, py, n) =>
        `Compared with ${py}, the median premium in ${c} for bracket ${a} moved by ${medPct} (${n} funds compared). This change reflects the annual tariff review approved by the Federal Council and published in late September. The tables below compare every fund with data in both years to highlight the largest rises and falls.`,
      tableCaption: (py) => `Top 20 funds by percentage change vs ${py}, from biggest drop to biggest rise`,
      tableHeaders: { rank: 'Rank', insurer: 'Health fund', delta: `Δ vs prior year` },
      emptyPriorNote: (py) =>
        `${py} data is not available for this combination: the change section will populate on the next BAG archive refresh.`,
    },
    triYear: {
      sectionTitle: (oy, cy) => `Three-year trend ${oy} → ${cy}`,
      summary: (c, a, oy, py, cy, yoyOlder, yoyRecent, cum) =>
        `LAMal premium trajectory in ${c} for ${a} over the last three years: ${oy} → ${py} → ${cy}, with consecutive year-over-year changes of ${yoyOlder} and ${yoyRecent} for a cumulative ${cum} over the two-year window. Looking at a single annual revision can mask the picture — the two-step compound is the right reading for planning a household budget.`,
      sparklineLabel: (c, a) => `Median monthly premium in ${c} for ${a} over the last three years (CHF/month)`,
    },
  },
  de: {
    breadcrumbHome: 'Startseite',
    breadcrumbRoot: 'Krankenkassenprämien',
    h1: (c, a) => `Krankenkassenprämien ${c} 2026 — ${a}`,
    intro: (c, a, m, min, max, year) =>
      `KVG-Prämien ${year} in ${c} für ${a}: Median ${m} CHF/Monat, Spannweite von ${min} bis ${max} CHF. Offizielle BAG/UFSP-Daten mit Mindestfranchise (CHF 300 Erwachsene, CHF 0 Kinder) und ohne Unfalldeckung. Vergleichen Sie die wichtigsten Krankenkassen und finden Sie den günstigsten Versicherer für Ihre Situation.`,
    tableHeaders: { rank: 'Rang', insurer: 'Krankenkasse', premium: 'Monatsprämie' },
    top20Title: (c, a) => `Top 20 Krankenkassen in ${c} — ${a}`,
    rankingTitle: 'Vergleich mit Nachbarkantonen',
    editorialTitle: 'Wie die KVG-Prämie in dieser Gruppe funktioniert',
    editorial: (c, a, m, year) =>
      `Nach dem Schweizer KVG müssen alle Einwohner eine Grundversicherung abschliessen. Die Prämie variiert nach Kanton, Prämienregion und Krankenkasse, ist aber für alle Erwachsenen ab 26 Jahren einheitlich — innerhalb des KVG selbst gibt es keinen altersbedingten Prämienanstieg (im Gegensatz zur Zusatzversicherung VVG). In ${c} beträgt der Median für die Kategorie ${a} im Jahr ${year} ${m} CHF/Monat. Grenzgänger mit Wohnsitz in Italien können zwischen Schweizer KVG und italienischem SSN wählen (Optionsrecht). Nutzen Sie die Tabelle oben, um die günstigsten Kassen für Ihre Altersgruppe zu identifizieren, und vergleichen Sie sie über unser interaktives Tool.`,
    derivationNote:
      'Hinweis: Prämien für Kinder (0-18) und junge Erwachsene (19-25) werden durch Anwendung der gesetzlichen BAG-Maxima 2026 geschätzt (25% bzw. 80% der Erwachsenenprämie); genaue Werte pro Versicherer liefert der Vergleich.',
    comparatorCTA: 'Zum Prämienvergleich',
    comparatorCTAText: 'Vorgefiltert auf diesen Kanton und Altersbereich — sehen Sie alle Kassen mit personalisiertem Angebot.',
    statsLabels: { median: 'Median', min: 'Tiefste Prämie', max: 'Höchste Prämie', insurers: 'Berücksichtigte Kassen' },
    faqTitle: 'Häufige Fragen',
    faq: [
      {
        q: (c, a) => `Was kostet die Krankenkasse in ${c} für ${a}?`,
        a: (c, a, m, min, max) =>
          `In ${c} zahlt die Gruppe ${a} im Durchschnitt ${m} CHF pro Monat für die KVG-Grundversicherung (Franchise 300, ohne Unfall). Die Spanne zwischen den Kassen reicht von ${min} bis ${max} CHF/Monat. Unterschiede kommen vom gewählten Modell (Standard, Hausarzt, Telmed, HMO).`,
      },
      {
        q: () => 'Welche Krankenkasse ist am günstigsten?',
        a: (_, __, ___, min) =>
          `Die günstigste Kasse wechselt jährlich — 2026 liegt die Mindestprämie für diese Gruppe bei ${min} CHF/Monat. Die vollständige Tabelle zeigt das aktuelle Ranking aller Kassen im gewählten Kanton.`,
      },
      {
        q: () => 'Wie kann ich Prämie sparen?',
        a: () =>
          'Drei Hebel: (1) Alternativmodell — Hausarzt, HMO oder Telmed sparen typisch 10-20% gegenüber Standard; (2) Jahresfranchise bis CHF 2 500 erhöhen, wenn Sie gesund sind (bis ~50% Ersparnis); (3) im Oktober die Tarife fürs Folgejahr vergleichen und bis 30. November wechseln.',
      },
      {
        q: () => 'Zahlen Grenzgänger KVG?',
        a: () =>
          'Grenzgänger haben das Optionsrecht zwischen Schweizer KVG und dem SSN im Wohnsitzstaat (IT/FR/DE/AT). Wer KVG wählt, zahlt dieselbe Prämie wie ein Schweizer Einwohner. Die Entscheidung muss innerhalb von 3 Monaten ab Arbeitsbeginn getroffen werden.',
      },
      {
        q: () => 'Ändert sich die Prämie mit dem Alter?',
        a: () =>
          'Unter KVG ist die Prämie für alle Erwachsenen ab 26 einheitlich — sie steigt nicht mit dem Alter. Kinder (0-18) und junge Erwachsene (19-25) zahlen gesetzlich weniger. Zusatzversicherungen (VVG) hingegen werden mit dem Alter teurer.',
      },
    ],
    priceUnit: 'CHF/Monat',
    rankingIntro: (c) =>
      `So positioniert sich ${c} gegenüber den anderen Zielkantonen für dieselbe Altersgruppe. KVG-Prämien unterscheiden sich auch innerhalb derselben Sprachregion erheblich zwischen den Kantonen.`,
    yoy: {
      sectionTitle: (py) => `Veränderung gegenüber ${py}`,
      summary: (c, a, medPct, py, n) =>
        `Im Vergleich zu ${py} hat sich die Medianprämie in ${c} für die Gruppe ${a} um ${medPct} verändert (${n} Kassen verglichen). Diese Veränderung spiegelt die jährliche Tarifrevision wider, die der Bundesrat Ende September genehmigt. Die Tabellen unten vergleichen für jede Kasse mit Daten in beiden Jahren die aktuelle und die Vorjahresprämie und heben so die grössten Zunahmen und Abnahmen hervor.`,
      tableCaption: (py) => `Top 20 Kassen nach prozentualer Veränderung vs ${py}, vom grössten Rückgang bis zur grössten Erhöhung`,
      tableHeaders: { rank: 'Rang', insurer: 'Krankenkasse', delta: `Δ vs Vorjahr` },
      emptyPriorNote: (py) =>
        `${py}-Daten sind für diese Kombination nicht verfügbar: Der Veränderungsabschnitt wird beim nächsten BAG-Archiv-Refresh befüllt.`,
    },
    triYear: {
      sectionTitle: (oy, cy) => `Dreijahres-Trend ${oy} → ${cy}`,
      summary: (c, a, oy, py, cy, yoyOlder, yoyRecent, cum) =>
        `KVG-Prämienverlauf in ${c} für ${a} in den letzten drei Jahren: ${oy} → ${py} → ${cy}, mit Veränderungen ${yoyOlder} und ${yoyRecent}, kumuliert ${cum} über das Zweijahresfenster. Die jährliche Revision allein vermittelt nicht das Gesamtbild — die zweistufige Summation ist die richtige Grösse für die Budgetplanung eines Haushalts.`,
      sparklineLabel: (c, a) => `Medianprämie pro Monat in ${c} für ${a} in den letzten drei Jahren (CHF/Monat)`,
    },
  },
  fr: {
    breadcrumbHome: 'Accueil',
    breadcrumbRoot: 'Primes assurance maladie',
    h1: (c, a) => `Primes assurance maladie ${c} 2026 — ${a}`,
    intro: (c, a, m, min, max, year) =>
      `Primes LAMal ${year} à ${c} pour ${a} : médiane ${m} CHF/mois, plage de ${min} à ${max} CHF. Données officielles OFSP/BAG avec franchise minimale (CHF 300 adultes, CHF 0 enfants) et sans couverture accident. Comparez les principales caisses maladie et trouvez l'assureur le plus avantageux pour votre situation.`,
    tableHeaders: { rank: 'Rang', insurer: 'Caisse maladie', premium: 'Prime mensuelle' },
    top20Title: (c, a) => `Top 20 caisses maladie à ${c} — ${a}`,
    rankingTitle: 'Comparatif avec les cantons voisins',
    editorialTitle: 'Comment la prime LAMal fonctionne dans cette tranche',
    editorial: (c, a, m, year) =>
      `Selon la loi suisse LAMal, tout résident doit souscrire une assurance maladie de base. La prime varie selon le canton, la région de prime et la caisse, mais elle est forfaitaire pour tous les adultes dès 26 ans — aucune hausse liée à l'âge dans la LAMal elle-même (contrairement à la LCA complémentaire). À ${c} en ${year}, la médiane pour la tranche ${a} s'établit à ${m} CHF/mois. Les frontaliers résidant en Italie peuvent choisir entre la LAMal suisse et le SSN italien (droit d'option). Utilisez le tableau ci-dessus pour repérer les caisses les moins chères dans votre tranche d'âge, puis comparez-les avec notre outil interactif.`,
    derivationNote:
      "Note : les primes pour enfants (0-18) et jeunes adultes (19-25) sont estimées en appliquant les maxima statutaires BAG 2026 (25 % et 80 % de la prime adulte) ; pour les valeurs exactes par caisse, consultez le comparateur.",
    comparatorCTA: 'Ouvrir le comparateur',
    comparatorCTAText: 'Pré-filtré sur ce canton et cette tranche d\'âge — voir toutes les caisses avec devis personnalisé.',
    statsLabels: { median: 'Médiane', min: 'Prime la plus basse', max: 'Prime la plus élevée', insurers: 'Caisses analysées' },
    faqTitle: 'Questions fréquentes',
    faq: [
      {
        q: (c, a) => `Combien coûte l'assurance maladie à ${c} pour ${a} ?`,
        a: (c, a, m, min, max) =>
          `À ${c}, la tranche ${a} paie en moyenne ${m} CHF par mois pour la LAMal de base (franchise 300, sans accident). La plage entre les caisses va de ${min} à ${max} CHF/mois. Les différences dépendent du modèle (standard, médecin de famille, telmed, HMO).`,
      },
      {
        q: () => 'Quelle caisse maladie est la moins chère ?',
        a: (_, __, ___, min) =>
          `La caisse la moins chère change chaque année — en 2026 la prime mensuelle minimum pour cette tranche est de ${min} CHF. Consultez le tableau complet pour le classement à jour de toutes les caisses dans le canton sélectionné.`,
      },
      {
        q: () => 'Comment économiser sur la prime ?',
        a: () =>
          "Trois leviers : (1) choisir un modèle alternatif — médecin de famille, HMO ou télémédecine économise typiquement 10-20 % par rapport au standard ; (2) augmenter la franchise annuelle jusqu'à CHF 2 500 si vous êtes en bonne santé (économie jusqu'à ~50 %) ; (3) comparer les tarifs chaque octobre pour l'année suivante et changer de caisse d'ici le 30 novembre.",
      },
      {
        q: () => 'Les frontaliers paient-ils la LAMal ?',
        a: () =>
          "Les frontaliers qui travaillent en Suisse bénéficient du droit d'option entre LAMal suisse et système de l'État de résidence (SSN italien, CPAM français, etc.). Ceux qui choisissent la LAMal paient la prime complète comme un résident suisse. Le choix doit être exercé dans les 3 mois suivant le début de l'activité.",
      },
      {
        q: () => "La prime change-t-elle avec l'âge ?",
        a: () =>
          "Sous LAMal la prime est forfaitaire pour tous les adultes à partir de 26 ans — elle n'augmente pas avec l'âge. Enfants (0-18) et jeunes adultes (19-25) paient moins par la loi. La LCA complémentaire, elle, augmente avec l'âge.",
      },
    ],
    priceUnit: 'CHF/mois',
    rankingIntro: (c) =>
      `Voici comment ${c} se positionne par rapport aux autres cantons cibles pour la même tranche d'âge. Les primes LAMal varient sensiblement d'un canton à l'autre, même au sein d'une même région linguistique.`,
    yoy: {
      sectionTitle: (py) => `Variation par rapport à ${py}`,
      summary: (c, a, medPct, py, n) =>
        `Par rapport à ${py}, la prime médiane à ${c} pour la tranche ${a} a varié de ${medPct} (${n} caisses comparées). Cette évolution reflète la révision tarifaire annuelle approuvée par le Conseil fédéral et publiée fin septembre. Les tableaux ci-dessous comparent, pour chaque caisse disposant de données dans les deux années, la prime actuelle avec celle de l'année précédente afin de mettre en évidence les hausses et les baisses les plus significatives.`,
      tableCaption: (py) => `Top 20 caisses par variation en pourcentage vs ${py}, de la plus forte baisse à la plus forte hausse`,
      tableHeaders: { rank: 'Rang', insurer: 'Caisse maladie', delta: `Δ vs année préc.` },
      emptyPriorNote: (py) =>
        `Les données ${py} ne sont pas disponibles pour cette combinaison : la section variation sera remplie au prochain rafraîchissement de l'archive BAG.`,
    },
    triYear: {
      sectionTitle: (oy, cy) => `Tendance triennale ${oy} → ${cy}`,
      summary: (c, a, oy, py, cy, yoyOlder, yoyRecent, cum) =>
        `Trajectoire des primes LAMal à ${c} pour la tranche ${a} sur les trois dernières années : ${oy} → ${py} → ${cy}, avec des variations consécutives ${yoyOlder} puis ${yoyRecent}, soit un total cumulé de ${cum} sur la fenêtre biennale. Une seule révision annuelle peut paraître modeste, mais la somme composée sur deux exercices reste la lecture pertinente pour planifier le budget familial.`,
      sparklineLabel: (c, a) => `Prime mensuelle médiane à ${c} pour ${a} sur les trois dernières années (CHF/mois)`,
    },
  },
};

const HUB_COPY: Record<HealthPremiumLocale, HubCopy> = {
  it: {
    breadcrumbHome: 'Home',
    h1Root: (y) => `Premi Cassa Malati ${y} per cantone e fascia d'età`,
    h1Canton: (c, y) => `Premi Cassa Malati ${c} ${y}`,
    introRoot: (y) =>
      `Il sistema LAMal svizzero impone a ogni residente un'assicurazione malattia di base. I premi ${y} variano in modo significativo fra cantoni, regioni premio e fasce d'età: questa è la pagina hub del nostro monitor dei premi, con dati ufficiali UFSP/BAG aggiornati ogni anno. Per ogni cantone target (Ticino, Grigioni, Uri, Vallese, Zurigo come benchmark) forniamo una vista dettagliata della mediana, del minimo e del massimo premio mensile, suddivisi in 6 fasce d'età. I frontalieri che lavorano in Svizzera possono scegliere tra LAMal svizzera e SSN italiano grazie al diritto d'opzione: la pagina del cantone che abiti (o del cantone della tua sede di lavoro) è il punto di partenza per confrontare le casse. Ogni landing si collega al comparatore pre-filtrato dove puoi ottenere un preventivo personalizzato.`,
    introCanton: (c, m, min, max, y) =>
      `Panoramica dei premi LAMal ${y} nel ${c} per tutte le fasce d'età: mediana ${m} CHF/mese, range da ${min} a ${max} CHF fra le casse ufficialmente attive. I valori provengono da UFSP/BAG (franchigia 300 adulti, senza infortuni). Usa la griglia sotto per aprire la pagina della fascia d'età che ti interessa e vedere il ranking completo delle casse e le offerte alternative (medico di famiglia, telmed, HMO).`,
    ageGridTitle: (c) => `Mediane per fascia di età in ${c}`,
    cantonGridTitle: 'Mediane per cantone — fascia adulti (26+)',
    cantonGridHeaders: { canton: 'Cantone', median: 'Mediana', min: 'Minimo', max: 'Massimo' },
    ageGridHeaders: { age: 'Fascia', median: 'Mediana', slug: 'Apri' },
    comparatorCTA: 'Apri il comparatore',
    comparatorCTAText: 'Trova la cassa più conveniente per la tua situazione',
    viewCantonCTA: (c) => `Apri la pagina ${c}`,
    openLeafCTA: 'Apri',
    rootBackgroundTitle: 'Cosa copre la LAMal',
    rootBackground:
      "La legge federale sull'assicurazione malattia (LAMal) garantisce a tutti i residenti in Svizzera — e ai frontalieri che scelgono il sistema svizzero — le prestazioni mediche di base: visite mediche, ricoveri in reparto comune, farmaci della lista positiva, maternità, psichiatria di base, fisioterapia prescritta. Non copre cure dentali di routine, stanze private, medicina alternativa non riconosciuta, lenti a contatto: per questi serve una complementare (LCA).",
    faqTitle: 'Domande frequenti',
    rootFaq: [
      {
        q: 'Come sono stabiliti i premi LAMal?',
        a: (y) =>
          `Ogni cassa presenta le proprie tariffe al Consiglio federale, che le approva a fine settembre. Entro il 31 ottobre ${y - 1} gli assicurati ricevono la comunicazione per l'anno successivo e hanno tempo fino al 30 novembre per cambiare cassa.`,
      },
      {
        q: 'Quali cantoni hanno i premi più bassi?',
        a: () =>
          'In generale Svizzera interna e orientale hanno premi più bassi; Ginevra, Basilea Città e Ticino hanno premi più alti. La variazione è significativa anche all\'interno dello stesso cantone (3 regioni premio in molti cantoni).',
      },
      {
        q: 'Posso cambiare cassa durante l\'anno?',
        a: () =>
          'Solo in casi particolari (aumento straordinario di premio, cambio di cantone). Il momento standard per cambiare cassa è entro il 30 novembre per la polizza dell\'anno successivo.',
      },
    ],
    cantonFaq: [
      {
        q: (c) => `Quanto costa la cassa malati in ${c} nel 2026?`,
        a: (c, m, y) =>
          `Il premio mediano per adulti nel ${c} nel ${y} è di ${m} CHF/mese (franchigia 300, senza infortuni). La variazione tra casse è significativa: apri la fascia d'età che ti interessa per il ranking completo.`,
      },
      {
        q: () => 'Le regioni premio fanno differenza?',
        a: () =>
          "Sì. Molti cantoni sono divisi in 2-3 regioni premio con differenze di 20-30 CHF/mese. Il Ticino ha una sola regione premio; Grigioni e Vallese ne hanno tre, con premi più bassi nelle zone periferiche.",
      },
    ],
    priceUnit: 'CHF/mese',
    updatedLabel: 'Aggiornato',
    yoy: {
      sectionTitle: (py) => `Variazione rispetto al ${py}`,
      cantonSummary: (c, adultPct, py) =>
        `La mediana dei premi adulti (26+) in ${c} è variata di ${adultPct} rispetto al ${py}. Nella tabella sotto vedi la variazione per ogni fascia di età, basata sulle casse con dati pubblicati in entrambi gli anni (fonte: archivio storico BAG/UFSP).`,
      gridCaption: (py) => `Variazione mediana per fascia di età (${py} → anno corrente)`,
      gridHeaders: { age: 'Fascia', delta: 'Δ vs anno precedente' },
    },
    triYear: {
      sectionTitle: (oy, cy) => `Trend triennale ${oy} → ${cy}`,
      cantonSummary: (c, oy, cy, cum) =>
        `Sul biennio ${oy} → ${cy} la mediana adulti (26+) in ${c} è cresciuta complessivamente di ${cum}. Il dato cumulato è il riferimento corretto per stimare l'impatto sul budget familiare a 24 mesi, perché smorza la volatilità della singola revisione tariffaria annuale.`,
    },
  },
  en: {
    breadcrumbHome: 'Home',
    h1Root: (y) => `Swiss health insurance premiums ${y} by canton and age`,
    h1Canton: (c, y) => `Health insurance premiums ${c} ${y}`,
    introRoot: (y) =>
      `The Swiss LAMal system requires every resident to hold basic health insurance. ${y} premiums vary substantially by canton, premium region and age bracket: this hub is the entry point to our premium tracker, with official FOPH/BAG data refreshed annually. For each target canton (Ticino, Graubünden, Uri, Valais, Zurich as benchmark) we expose median, minimum and maximum monthly premium across 6 age brackets. Cross-border workers employed in Switzerland can choose between the Swiss LAMal and their home-country system under the "right of option" — the canton of your employer (or your residence canton) is the right starting point. Every landing links to the pre-filtered comparator where you can obtain a personalised quote.`,
    introCanton: (c, m, min, max, y) =>
      `${y} LAMal premium overview in ${c} across all age brackets: median ${m} CHF/month, range from ${min} to ${max} CHF across active health funds. Data from FOPH/BAG (CHF 300 deductible for adults, no accident cover). Use the grid below to open the age bracket you need and see the full ranking of funds with alternative models (family doctor, telmed, HMO).`,
    ageGridTitle: (c) => `Median by age bracket in ${c}`,
    cantonGridTitle: 'Median by canton — adult bracket (26+)',
    cantonGridHeaders: { canton: 'Canton', median: 'Median', min: 'Min', max: 'Max' },
    ageGridHeaders: { age: 'Bracket', median: 'Median', slug: 'Open' },
    comparatorCTA: 'Open the comparator',
    comparatorCTAText: 'Find the most affordable fund for your situation',
    viewCantonCTA: (c) => `Open ${c}`,
    openLeafCTA: 'Open',
    rootBackgroundTitle: 'What LAMal covers',
    rootBackground:
      'The Swiss Federal Health Insurance Act (LAMal) guarantees every resident — and cross-border workers electing the Swiss system — basic medical care: doctor visits, ward-level hospital stays, prescription drugs on the positive list, maternity, basic psychiatry, prescribed physiotherapy. It does not cover routine dental care, private rooms, non-recognised alternative medicine, contact lenses: for these you need supplementary cover (LCA/VVG).',
    faqTitle: 'Frequently asked questions',
    rootFaq: [
      {
        q: 'How are LAMal premiums set?',
        a: (y) =>
          `Each fund submits its tariffs to the Federal Council, which approves them by late September. By 31 October ${y - 1} insured members receive the next-year quote and have until 30 November to switch funds.`,
      },
      {
        q: 'Which cantons have the lowest premiums?',
        a: () =>
          "Central and eastern Switzerland usually have the lowest premiums; Geneva, Basel-City and Ticino are at the high end. Variation within a single canton is also significant (many cantons have 2-3 premium regions).",
      },
      {
        q: 'Can I switch funds during the year?',
        a: () =>
          "Only in special cases (extraordinary premium increase, change of canton). The standard switching window is by 30 November for the following year's cover.",
      },
    ],
    cantonFaq: [
      {
        q: (c) => `How much does health insurance cost in ${c} in 2026?`,
        a: (c, m, y) =>
          `The ${y} adult median in ${c} is ${m} CHF/month (CHF 300 deductible, no accident cover). Variation between funds is substantial: open the age bracket that matches you for the full ranking.`,
      },
      {
        q: () => 'Do premium regions matter?',
        a: () =>
          'Yes. Many cantons are split into 2-3 premium regions with 20-30 CHF/month differences. Ticino has one region; Graubünden and Valais have three, with lower premiums in peripheral zones.',
      },
    ],
    priceUnit: 'CHF/month',
    updatedLabel: 'Updated',
    yoy: {
      sectionTitle: (py) => `Change vs ${py}`,
      cantonSummary: (c, adultPct, py) =>
        `The adult (26+) median premium in ${c} moved by ${adultPct} vs ${py}. The table below breaks the change down by age bracket, using only funds that published data in both years (source: BAG/FOPH historical archive).`,
      gridCaption: (py) => `Median change by age bracket (${py} → current year)`,
      gridHeaders: { age: 'Bracket', delta: 'Δ vs prior year' },
    },
    triYear: {
      sectionTitle: (oy, cy) => `Three-year trend ${oy} → ${cy}`,
      cantonSummary: (c, oy, cy, cum) =>
        `Across the ${oy} → ${cy} window the adult (26+) median in ${c} compounded by ${cum}. The two-year cumulative is the right reference to size the budget impact, because it smooths the noise of a single annual tariff revision.`,
    },
  },
  de: {
    breadcrumbHome: 'Startseite',
    h1Root: (y) => `Krankenkassenprämien ${y} nach Kanton und Altersgruppe`,
    h1Canton: (c, y) => `Krankenkassenprämien ${c} ${y}`,
    introRoot: (y) =>
      `Das Schweizer KVG verpflichtet jeden Einwohner zu einer Grundversicherung. Die Prämien ${y} variieren deutlich nach Kanton, Prämienregion und Altersgruppe: Diese Hub-Seite ist der Einstieg zu unserem Prämienmonitor mit amtlichen BAG/UFSP-Daten, jährlich aktualisiert. Für jeden Zielkanton (Tessin, Graubünden, Uri, Wallis, Zürich als Benchmark) zeigen wir Median, Minimum und Maximum der Monatsprämie in 6 Altersgruppen. Grenzgänger in der Schweiz können dank Optionsrecht zwischen Schweizer KVG und dem System ihres Wohnlandes wählen — der Kanton des Arbeitgebers (oder Ihr Wohnkanton) ist der beste Einstiegspunkt. Jede Seite verlinkt den vorgefilterten Vergleich für ein persönliches Angebot.`,
    introCanton: (c, m, min, max, y) =>
      `Übersicht der KVG-Prämien ${y} in ${c} für alle Altersgruppen: Median ${m} CHF/Monat, Spanne von ${min} bis ${max} CHF bei den aktiven Krankenkassen. Daten aus BAG/UFSP (Franchise 300 Erwachsene, ohne Unfall). Wählen Sie in der Tabelle die gewünschte Altersgruppe, um das vollständige Ranking mit alternativen Modellen (Hausarzt, Telmed, HMO) zu sehen.`,
    ageGridTitle: (c) => `Median nach Altersgruppe in ${c}`,
    cantonGridTitle: 'Median nach Kanton — Erwachsene (26+)',
    cantonGridHeaders: { canton: 'Kanton', median: 'Median', min: 'Min', max: 'Max' },
    ageGridHeaders: { age: 'Gruppe', median: 'Median', slug: 'Öffnen' },
    comparatorCTA: 'Prämienvergleich öffnen',
    comparatorCTAText: 'Finden Sie die günstigste Kasse für Ihre Situation',
    viewCantonCTA: (c) => `${c} öffnen`,
    openLeafCTA: 'Öffnen',
    rootBackgroundTitle: 'Was das KVG abdeckt',
    rootBackground:
      'Das Bundesgesetz über die Krankenversicherung (KVG) garantiert allen Einwohnern — und Grenzgängern, die sich für das Schweizer System entscheiden — die medizinische Grundversorgung: Arztbesuche, Spitalaufenthalte in allgemeiner Abteilung, Medikamente auf der Spezialitätenliste, Mutterschaft, psychiatrische Grundversorgung, ärztlich verordnete Physiotherapie. Nicht abgedeckt sind Routinezahnbehandlungen, Privatzimmer, nicht anerkannte Alternativmedizin, Kontaktlinsen: dafür braucht es eine Zusatzversicherung (VVG).',
    faqTitle: 'Häufige Fragen',
    rootFaq: [
      {
        q: 'Wie werden KVG-Prämien festgelegt?',
        a: (y) =>
          `Jede Kasse reicht ihre Tarife dem Bundesrat ein, der sie Ende September genehmigt. Bis 31. Oktober ${y - 1} erhalten die Versicherten die Mitteilung fürs Folgejahr und können bis 30. November die Kasse wechseln.`,
      },
      {
        q: 'Welche Kantone haben die tiefsten Prämien?',
        a: () =>
          'Zentral- und Ostschweiz haben meist die tiefsten Prämien; Genf, Basel-Stadt und Tessin liegen am oberen Rand. Auch innerhalb eines Kantons ist die Variation gross (viele Kantone haben 2-3 Prämienregionen).',
      },
      {
        q: 'Kann ich die Kasse unterjährig wechseln?',
        a: () =>
          'Nur in Sonderfällen (ausserordentliche Prämienerhöhung, Kantonswechsel). Der Standard-Wechseltermin ist der 30. November für das Folgejahr.',
      },
    ],
    cantonFaq: [
      {
        q: (c) => `Was kostet die Krankenkasse in ${c} 2026?`,
        a: (c, m, y) =>
          `Der Erwachsenen-Median in ${c} ${y} liegt bei ${m} CHF/Monat (Franchise 300, ohne Unfall). Die Variation zwischen Kassen ist erheblich — öffnen Sie Ihre Altersgruppe für das vollständige Ranking.`,
      },
      {
        q: () => 'Spielen Prämienregionen eine Rolle?',
        a: () =>
          'Ja. Viele Kantone sind in 2-3 Prämienregionen unterteilt mit Unterschieden von 20-30 CHF/Monat. Tessin hat eine Region; Graubünden und Wallis haben drei, mit tieferen Prämien in Randregionen.',
      },
    ],
    priceUnit: 'CHF/Monat',
    updatedLabel: 'Aktualisiert',
    yoy: {
      sectionTitle: (py) => `Veränderung gegenüber ${py}`,
      cantonSummary: (c, adultPct, py) =>
        `Die Erwachsenen-Medianprämie (26+) in ${c} hat sich gegenüber ${py} um ${adultPct} verändert. Die Tabelle unten schlüsselt die Veränderung nach Altersgruppe auf, basierend nur auf Kassen mit Daten in beiden Jahren (Quelle: historisches BAG/UFSP-Archiv).`,
      gridCaption: (py) => `Mediane Veränderung nach Altersgruppe (${py} → laufendes Jahr)`,
      gridHeaders: { age: 'Gruppe', delta: 'Δ vs Vorjahr' },
    },
    triYear: {
      sectionTitle: (oy, cy) => `Dreijahres-Trend ${oy} → ${cy}`,
      cantonSummary: (c, oy, cy, cum) =>
        `Im Zeitraum ${oy} → ${cy} hat sich der Erwachsenen-Median (26+) in ${c} kumuliert um ${cum} verändert. Der Zweijahres-Saldo ist der richtige Massstab für die Budgetplanung, weil er die Schwankung einer einzelnen jährlichen Tarifrevision glättet.`,
    },
  },
  fr: {
    breadcrumbHome: 'Accueil',
    h1Root: (y) => `Primes d'assurance maladie ${y} par canton et tranche d'âge`,
    h1Canton: (c, y) => `Primes assurance maladie ${c} ${y}`,
    introRoot: (y) =>
      `Le système LAMal suisse oblige tout résident à souscrire une assurance maladie de base. Les primes ${y} varient sensiblement selon le canton, la région de prime et la tranche d'âge : cette page hub est le point d'entrée de notre moniteur des primes, avec des données officielles OFSP/BAG mises à jour chaque année. Pour chaque canton cible (Tessin, Grisons, Uri, Valais, Zurich comme référence) nous affichons la médiane, le minimum et le maximum de prime mensuelle pour 6 tranches d'âge. Les frontaliers travaillant en Suisse peuvent choisir entre la LAMal suisse et le système de leur État de résidence grâce au droit d'option — le canton de l'employeur (ou votre canton de résidence) est le bon point de départ. Chaque page renvoie au comparateur pré-filtré pour obtenir un devis personnalisé.`,
    introCanton: (c, m, min, max, y) =>
      `Aperçu des primes LAMal ${y} à ${c} pour toutes les tranches d'âge : médiane ${m} CHF/mois, plage de ${min} à ${max} CHF entre les caisses actives. Données OFSP/BAG (franchise 300 adultes, sans accident). Utilisez la grille ci-dessous pour ouvrir la tranche d'âge souhaitée et voir le classement complet des caisses avec modèles alternatifs (médecin de famille, telmed, HMO).`,
    ageGridTitle: (c) => `Médiane par tranche d'âge à ${c}`,
    cantonGridTitle: 'Médiane par canton — adultes (26+)',
    cantonGridHeaders: { canton: 'Canton', median: 'Médiane', min: 'Min', max: 'Max' },
    ageGridHeaders: { age: 'Tranche', median: 'Médiane', slug: 'Ouvrir' },
    comparatorCTA: 'Ouvrir le comparateur',
    comparatorCTAText: 'Trouvez la caisse la plus avantageuse pour votre situation',
    viewCantonCTA: (c) => `Ouvrir ${c}`,
    openLeafCTA: 'Ouvrir',
    rootBackgroundTitle: 'Ce que couvre la LAMal',
    rootBackground:
      "La loi fédérale sur l'assurance maladie (LAMal) garantit à tout résident — et aux frontaliers ayant choisi le système suisse — les soins médicaux de base : consultations, hospitalisation en division commune, médicaments de la liste des spécialités, maternité, psychiatrie de base, physiothérapie prescrite. Elle ne couvre pas les soins dentaires de routine, la chambre privée, les médecines alternatives non reconnues, les lentilles de contact : il faut pour cela une complémentaire (LCA).",
    faqTitle: 'Questions fréquentes',
    rootFaq: [
      {
        q: 'Comment les primes LAMal sont-elles fixées ?',
        a: (y) =>
          `Chaque caisse soumet ses tarifs au Conseil fédéral qui les approuve fin septembre. Jusqu'au 31 octobre ${y - 1} les assurés reçoivent la notification pour l'année suivante et ont jusqu'au 30 novembre pour changer de caisse.`,
      },
      {
        q: 'Quels cantons ont les primes les plus basses ?',
        a: () =>
          'La Suisse centrale et orientale a généralement les primes les plus basses ; Genève, Bâle-Ville et le Tessin sont en haut de fourchette. La variation au sein même d\'un canton est aussi importante (2-3 régions de prime dans beaucoup de cantons).',
      },
      {
        q: 'Puis-je changer de caisse en cours d\'année ?',
        a: () =>
          "Seulement dans des cas particuliers (hausse extraordinaire, changement de canton). La fenêtre standard de changement est avant le 30 novembre pour la couverture de l'année suivante.",
      },
    ],
    cantonFaq: [
      {
        q: (c) => `Combien coûte l'assurance maladie à ${c} en 2026 ?`,
        a: (c, m, y) =>
          `La médiane adulte à ${c} en ${y} est de ${m} CHF/mois (franchise 300, sans accident). La variation entre caisses est importante : ouvrez la tranche d'âge qui vous concerne pour le classement complet.`,
      },
      {
        q: () => 'Les régions de prime font-elles une différence ?',
        a: () =>
          "Oui. Beaucoup de cantons sont divisés en 2-3 régions de prime avec 20-30 CHF/mois de différence. Le Tessin n'a qu'une région ; Grisons et Valais en ont trois, avec des primes plus basses en périphérie.",
      },
    ],
    priceUnit: 'CHF/mois',
    updatedLabel: 'Mis à jour',
    yoy: {
      sectionTitle: (py) => `Variation par rapport à ${py}`,
      cantonSummary: (c, adultPct, py) =>
        `La prime médiane adulte (26+) à ${c} a varié de ${adultPct} par rapport à ${py}. Le tableau ci-dessous détaille la variation par tranche d'âge, en ne retenant que les caisses avec des données publiées dans les deux années (source : archive historique BAG/OFSP).`,
      gridCaption: (py) => `Variation médiane par tranche d'âge (${py} → année courante)`,
      gridHeaders: { age: 'Tranche', delta: 'Δ vs année préc.' },
    },
    triYear: {
      sectionTitle: (oy, cy) => `Tendance triennale ${oy} → ${cy}`,
      cantonSummary: (c, oy, cy, cum) =>
        `Sur la fenêtre ${oy} → ${cy}, la prime médiane adulte (26+) à ${c} a évolué cumulativement de ${cum}. Le cumul biennal est la bonne référence pour anticiper l'impact sur le budget familial : il lisse la volatilité d'une révision tarifaire annuelle isolée.`,
    },
  },
};

// ── Page builders ─────────────────────────────────────────────

interface LeafInputs {
  locale: HealthPremiumLocale;
  canton: HealthPremiumCanton;
  age: HealthPremiumAgeBracket;
  dataset: HealthPremiumsDataset;
  stats: CantonPremiumStats;
  allCantonStats: Record<HealthPremiumCanton, CantonPremiumStats | null>;
  canonicalPath: string;
  alternates: Record<HealthPremiumLocale, string>;
  today: Date;
  /** Year-over-year delta for this canton; null when prior-year data absent. */
  yoy: YoyCantonDelta | null;
  /** Tri-year trend (oldest→prior→current); null when no archive available. */
  triYear: TriYearCantonDelta | null;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

function renderLeafPage(inp: LeafInputs): string {
  const { locale, canton, age, dataset, stats, allCantonStats, canonicalPath, alternates, today, yoy, triYear, distDir } = inp;
  const copy = LEAF_COPY[locale];
  const cantonLabel = HEALTH_PREMIUM_CANTON_DISPLAY[locale][canton];
  const ageLabel = HEALTH_PREMIUM_AGE_LABEL[locale][age];
  const multiplier = HEALTH_PREMIUM_AGE_MULTIPLIER[age];
  const year = dataset.year ?? today.getUTCFullYear();

  // Prefer real BAG KIN/JUG/ERW per-insurer premiums when the dataset
  // publishes them; otherwise fall back to multiplier-derived values so
  // legacy datasets keep rendering. The `bracketSource` flag drives the
  // editorial note shown below the ranking table.
  const bracketStats = stats.bracketStats[age];
  const bracketIsReal = bracketStats?.allReal === true;
  const perInsurer = (bracketStats?.ranked ?? stats.ranked.map((r) => ({
    insurerId: r.insurerId,
    price: roundCHF(r.price * multiplier),
    source: 'derived' as const,
  }))).map((r) => ({
    insurerId: r.insurerId,
    insurerName: resolveInsurerName(dataset, r.insurerId),
    price: r.price,
    source: 'source' in r ? r.source : ('derived' as 'real' | 'derived'),
  }));
  const top20 = perInsurer.slice(0, 20);
  const prices = perInsurer.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const med = median(prices) ?? 0;

  const medFmt = formatCHF(med, locale);
  const minFmt = formatCHF(min, locale);
  const maxFmt = formatCHF(max, locale);

  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const h1 = copy.h1(cantonLabel, ageLabel);
  const intro = copy.intro(cantonLabel, ageLabel, medFmt, minFmt, maxFmt, year);

  // Top-20 table
  const tableHtml = `<table style="${TABLE_STYLE};font-size:14px">
    <thead><tr>
      <th style="${TABLE_HEAD_STYLE}">${esc(copy.tableHeaders.rank)}</th>
      <th style="${TABLE_HEAD_STYLE}">${esc(copy.tableHeaders.insurer)}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tableHeaders.premium)}</th>
    </tr></thead>
    <tbody>${top20
      .map(
        (r, i) => `<tr>
        <td style="${TABLE_CELL_STYLE};font-variant-numeric:tabular-nums">${i + 1}</td>
        <td style="${TABLE_CELL_STYLE}">${esc(r.insurerName)}</td>
        <td style="${TABLE_CELL_STYLE};color:var(--color-link);font-weight:700;text-align:right;font-variant-numeric:tabular-nums">${formatCHF(r.price, locale)} ${esc(copy.priceUnit)}</td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>`;

  // Canton ranking comparison — use real per-bracket medians when the
  // dataset exposes them, else fall back to the adult median × multiplier.
  const rankingRows: Array<{ canton: HealthPremiumCanton; price: number | null }> = [];
  for (const c of HEALTH_PREMIUM_CANTONS) {
    const s = allCantonStats[c];
    if (!s) {
      rankingRows.push({ canton: c, price: null });
      continue;
    }
    const bs = s.bracketStats[age];
    if (bs && bs.medianPrice !== null && bs.allReal) {
      rankingRows.push({ canton: c, price: roundCHF(bs.medianPrice) });
    } else {
      const adultMed = s.adultMedian ?? 0;
      rankingRows.push({ canton: c, price: roundCHF(adultMed * multiplier) });
    }
  }
  // Sort by price ascending, missing last
  rankingRows.sort((a, b) => {
    if (a.price === null && b.price === null) return 0;
    if (a.price === null) return 1;
    if (b.price === null) return -1;
    return a.price - b.price;
  });
  const rankingHtml = `<table style="${TABLE_STYLE};font-size:14px">
    <thead><tr>
      <th style="${TABLE_HEAD_STYLE}">#</th>
      <th style="${TABLE_HEAD_STYLE}">${esc(LEAF_COPY[locale].tableHeaders.insurer === 'Cassa Malati' ? 'Cantone' : locale === 'en' ? 'Canton' : locale === 'de' ? 'Kanton' : 'Canton')}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(LEAF_COPY[locale].statsLabels.median)}</th>
    </tr></thead>
    <tbody>${rankingRows
      .map(
        (r, i) => `<tr${r.canton === canton ? ' style="background:var(--color-accent-subtle)"' : ''}>
        <td style="${TABLE_CELL_STYLE};font-variant-numeric:tabular-nums">${i + 1}</td>
        <td style="${TABLE_CELL_STYLE}${r.canton === canton ? ';font-weight:700' : ''}">${esc(HEALTH_PREMIUM_CANTON_DISPLAY[locale][r.canton])}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${r.price === null ? '—' : formatCHF(r.price, locale) + ' ' + esc(copy.priceUnit)}</td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>`;

  // Stats cards — when YoY data is available for the current bracket we
  // append a fifth tile showing the median delta. Only rendered when the
  // prior-year dataset exposes ≥ 3 overlapping insurers so the median is not
  // dominated by noise.
  const bracketYoy = yoy?.byBracket[age] ?? null;
  const showYoyTile = bracketYoy !== null && bracketYoy.medianPct !== null && bracketYoy.sourceInsurers >= 3;
  const yoyTileHtml = showYoyTile && bracketYoy
    ? `<div style="${STAT_TILE_DANGER}">
      <div style="${STAT_TILE_LABEL}">Δ vs ${yoy?.priorYear ?? ''}</div>
      <div style="${STAT_TILE_VALUE};font-size:24px;color:${(bracketYoy.medianPct ?? 0) >= 0 ? 'var(--color-danger-border)' : 'var(--color-success-border)'}">${esc(formatPct(bracketYoy.medianPct, locale))}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${bracketYoy.sourceInsurers} casse</div>
    </div>`
    : '';
  const statsHtml = `<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">
    <div style="${STAT_TILE_ACCENT}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.statsLabels.median)}</div>
      <div style="${STAT_TILE_VALUE};font-size:32px;font-weight:800">${medFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.priceUnit)}</div>
    </div>
    <div style="${STAT_TILE_SUCCESS}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.statsLabels.min)}</div>
      <div style="${STAT_TILE_VALUE};font-size:24px">${minFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.priceUnit)}</div>
    </div>
    <div style="${STAT_TILE_WARNING}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.statsLabels.max)}</div>
      <div style="${STAT_TILE_VALUE};font-size:24px">${maxFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.priceUnit)}</div>
    </div>
    <div style="${STAT_TILE_BASE}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.statsLabels.insurers)}</div>
      <div style="${STAT_TILE_VALUE};font-size:24px">${perInsurer.length}</div>
    </div>
    ${yoyTileHtml}
  </section>`;

  // YoY section — ranked table of top-20 insurers by absolute delta, plus an
  // editorial summary. Rendered only when we have real prior-year data so
  // A3's "no fake data" rule is honoured.
  const yoyHtml = (() => {
    if (!yoy || !bracketYoy || bracketYoy.medianPct === null) return '';
    const rows = Object.entries(bracketYoy.perInsurer)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([insurerId, delta]) => ({
        insurerId,
        insurerName: resolveInsurerName(dataset, insurerId),
        delta,
      }))
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 20);
    if (rows.length === 0) return '';
    const medPctFmt = formatPct(bracketYoy.medianPct, locale);
    const table = `<table style="${TABLE_STYLE};font-size:14px">
      <thead><tr>
        <th style="${TABLE_HEAD_STYLE}">${esc(copy.yoy.tableHeaders.rank)}</th>
        <th style="${TABLE_HEAD_STYLE}">${esc(copy.yoy.tableHeaders.insurer)}</th>
        <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.yoy.tableHeaders.delta)}</th>
      </tr></thead>
      <tbody>${rows
        .map((r, i) => {
          const positive = r.delta > 0;
          const neutral = r.delta === 0;
          const deltaColor = neutral ? 'var(--color-subtle)' : positive ? 'var(--color-danger-border)' : 'var(--color-success-border)';
          return `<tr>
          <td style="${TABLE_CELL_STYLE};font-variant-numeric:tabular-nums">${i + 1}</td>
          <td style="${TABLE_CELL_STYLE}">${esc(r.insurerName)}</td>
          <td style="${TABLE_CELL_STYLE};color:${deltaColor};font-weight:700;text-align:right;font-variant-numeric:tabular-nums">${esc(formatPct(r.delta, locale))}</td>
        </tr>`;
        })
        .join('')}</tbody>
    </table>`;
    return `<section style="margin:0 0 24px" aria-labelledby="yoy">
      <h2 id="yoy" style="${H2_STYLE}">${esc(copy.yoy.sectionTitle(yoy.priorYear))}</h2>
      <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.yoy.summary(cantonLabel, ageLabel, medPctFmt, yoy.priorYear, bracketYoy.sourceInsurers))}</p>
      <p style="margin:0 0 12px;color:var(--color-subtle);font-size:13px;line-height:1.5">${esc(copy.yoy.tableCaption(yoy.priorYear))}</p>
      ${table}
    </section>`;
  })();

  // Tri-year trend section (B-cont-4) — renders only when 3 years of data
  // are available for this bracket; falls back to silence (the YoY section
  // above already covers the 2-year case) when 2024 is missing. Per
  // CLAUDE.md rule #6: no fake data, no fabricated values.
  const triYearHtml = (() => {
    if (!triYear) return '';
    const trend = triYear.byBracket[age];
    if (!trend) return '';
    if (trend.points.length < 3) return '';
    const oldestYear = trend.points[0].year;
    const priorYear = trend.points[trend.points.length - 2].year;
    const currentYear = trend.points[trend.points.length - 1].year;
    const yoyOlderFmt = formatPct(trend.yoyPct[0] ?? null, locale);
    const yoyRecentFmt = formatPct(trend.yoyPct[trend.yoyPct.length - 1] ?? null, locale);
    const cumFmt = formatPct(trend.cumulativePct, locale);
    const sparkAria = copy.triYear.sparklineLabel(cantonLabel, ageLabel);
    const sparkHtml = renderSparkline(trend, locale, sparkAria);
    const sequence = `${oldestYear} → ${priorYear} → ${currentYear}`;
    return `<section style="margin:0 0 24px" aria-labelledby="triYear">
      <h2 id="triYear" style="${H2_STYLE}">${esc(copy.triYear.sectionTitle(oldestYear, currentYear))}</h2>
      <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.triYear.summary(cantonLabel, ageLabel, oldestYear, priorYear, currentYear, yoyOlderFmt, yoyRecentFmt, cumFmt))}</p>
      <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;margin:6px 0 0">
        <div style="${STAT_TILE_ACCENT};padding:14px 18px;border-radius:14px">
          <div style="${STAT_TILE_LABEL};font-size:11px">${esc(sequence)}</div>
          <div style="margin-top:6px;font-size:20px;font-weight:700;color:var(--color-heading);font-variant-numeric:tabular-nums">${esc(yoyOlderFmt)} · ${esc(yoyRecentFmt)}</div>
          <div style="margin-top:2px;font-size:13px;color:var(--color-subtle);font-variant-numeric:tabular-nums">${esc(cumFmt)}</div>
        </div>
        ${sparkHtml}
      </div>
    </section>`;
  })();

  // FAQ
  const faqItems = copy.faq;
  const faqHtml = `<section style="margin:32px 0 0" aria-labelledby="hpFaq">
    <h2 id="hpFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    ${faqItems
      .map(
        (f) => `<details style="${CARD_STYLE};margin-bottom:8px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q(cantonLabel, ageLabel))}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a(cantonLabel, ageLabel, medFmt, minFmt, maxFmt))}</p>
      </details>`,
      )
      .join('')}
  </section>`;

  // hreflang alternates
  const alternatesHtml = (Object.keys(alternates) as HealthPremiumLocale[])
    .map((alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${alternates[alt]}">`)
    .join('\n');

  // Comparator CTA with pre-filter query
  const comparatorHref = `${HEALTH_PREMIUM_COMPARATOR_PATH[locale]}?canton=${stats.cantonBagCode}&age=${age}`;

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbRoot, item: `${BASE_URL}${buildHealthPremiumsRootPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: cantonLabel, item: `${BASE_URL}${buildHealthPremiumsCantonPath(locale, canton)}` },
      { '@type': 'ListItem', position: 4, name: ageLabel, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro.slice(0, 200),
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqItems.map((f) => ({
      '@type': 'Question',
      name: f.q(cantonLabel, ageLabel),
      acceptedAnswer: { '@type': 'Answer', text: f.a(cantonLabel, ageLabel, medFmt, minFmt, maxFmt) },
    })),
  });

  const productLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `LAMal premium ${cantonLabel} ${ageLabel}`,
    description: intro.slice(0, 200),
    category: 'HealthInsurance',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'CHF',
      lowPrice: min.toFixed(2),
      highPrice: max.toFixed(2),
      offerCount: perInsurer.length,
      url: canonicalUrl,
      availability: 'https://schema.org/InStock',
    },
  });

  const title = `${h1} | Frontaliere Ticino`;
  const description = intro.slice(0, 180);

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${BASE_URL}${buildHealthPremiumsRootPath(locale)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbRoot)}</a>
    <span> / </span>
    <a href="${BASE_URL}${buildHealthPremiumsCantonPath(locale, canton)}" style="${BREADCRUMB_LINK_STYLE}">${esc(cantonLabel)}</a>
    <span> / </span>
    <span>${esc(ageLabel)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">LAMal ${year}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  ${statsHtml}
  <section style="margin:0 0 24px" aria-labelledby="top20">
    <h2 id="top20" style="${H2_STYLE}">${esc(copy.top20Title(cantonLabel, ageLabel))}</h2>
    ${tableHtml}
    ${(age === '0-18' || age === '19-25') && !bracketIsReal ? `<p style="margin:12px 0 0;color:var(--color-warning-border);font-size:13px;line-height:1.5;padding:12px;background:var(--color-warning-subtle);border-radius:8px">${esc(copy.derivationNote)}</p>` : ''}
  </section>
  <section style="margin:0 0 24px" aria-labelledby="ranking">
    <h2 id="ranking" style="${H2_STYLE}">${esc(copy.rankingTitle)}</h2>
    <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.rankingIntro(cantonLabel))}</p>
    ${rankingHtml}
  </section>
  ${yoyHtml}
  ${triYearHtml}
  <section style="margin:0 0 24px" aria-labelledby="editorial">
    <h2 id="editorial" style="${H2_STYLE}">${esc(copy.editorialTitle)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.editorial(cantonLabel, ageLabel, medFmt, year))}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="comparatorCta">
    <h2 id="comparatorCta" style="${H2_STYLE}">${esc(copy.comparatorCTA)}</h2>
    <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.comparatorCTAText)}</p>
    <a href="${esc(comparatorHref)}" style="${CTA_PRIMARY_STYLE};font-size:15px">${esc(copy.comparatorCTA)}</a>
  </section>
  ${faqHtml}
  ${generateRelatedLinksBlock(locale, 'health_premiums', { cantonSlug: canton, age })}
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

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
    jsonLdScripts: [breadcrumbLd, webPageLd, faqLd, productLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'confronti', activeSubTab: 'health' },
  });
}

interface CantonHubInputs {
  locale: HealthPremiumLocale;
  canton: HealthPremiumCanton;
  dataset: HealthPremiumsDataset;
  stats: CantonPremiumStats;
  canonicalPath: string;
  alternates: Record<HealthPremiumLocale, string>;
  today: Date;
  yoy: YoyCantonDelta | null;
  /** Tri-year trend (oldest→prior→current); null when no archive available. */
  triYear: TriYearCantonDelta | null;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

function renderCantonHubPage(inp: CantonHubInputs): string {
  const { locale, canton, dataset, stats, canonicalPath, alternates, today, yoy, triYear, distDir } = inp;
  const copy = HUB_COPY[locale];
  const leafCopy = LEAF_COPY[locale];
  const cantonLabel = HEALTH_PREMIUM_CANTON_DISPLAY[locale][canton];
  const year = dataset.year ?? today.getUTCFullYear();

  const adultMed = stats.adultMedian ?? 0;
  const adultMin = stats.adultMin ?? 0;
  const adultMax = stats.adultMax ?? 0;
  const medFmt = formatCHF(adultMed, locale);
  const minFmt = formatCHF(adultMin, locale);
  const maxFmt = formatCHF(adultMax, locale);

  // Age grid — prefer real BAG KIN/JUG/ERW median when dataset exposes it,
  // else fall back to adult median × multiplier.
  const ageGridRows = HEALTH_PREMIUM_AGE_BRACKETS.map((ab) => {
    const bs = stats.bracketStats[ab.id];
    const mult = HEALTH_PREMIUM_AGE_MULTIPLIER[ab.id];
    const med = bs && bs.medianPrice !== null && bs.allReal
      ? roundCHF(bs.medianPrice)
      : roundCHF(adultMed * mult);
    const leafPath = buildHealthPremiumsLeafPath(locale, canton, ab.id);
    return { ab, med, leafPath };
  });
  const ageGridHtml = `<table style="${TABLE_STYLE};font-size:14px">
    <thead><tr>
      <th style="${TABLE_HEAD_STYLE}">${esc(copy.ageGridHeaders.age)}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.ageGridHeaders.median)}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.ageGridHeaders.slug)}</th>
    </tr></thead>
    <tbody>${ageGridRows
      .map(
        (r) => `<tr>
        <td style="${TABLE_CELL_STYLE}">${esc(HEALTH_PREMIUM_AGE_LABEL[locale][r.ab.id])}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${formatCHF(r.med, locale)} ${esc(copy.priceUnit)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right"><a href="${esc(r.leafPath)}" style="${LINK_ACCENT_STYLE};font-weight:700">${esc(copy.openLeafCTA)} →</a></td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>`;

  // Stats cards
  const statsHtml = `<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">
    <div style="${STAT_TILE_ACCENT}">
      <div style="${STAT_TILE_LABEL}">${esc(leafCopy.statsLabels.median)}</div>
      <div style="${STAT_TILE_VALUE};font-size:32px;font-weight:800">${medFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.priceUnit)}</div>
    </div>
    <div style="${STAT_TILE_SUCCESS}">
      <div style="${STAT_TILE_LABEL}">${esc(leafCopy.statsLabels.min)}</div>
      <div style="${STAT_TILE_VALUE};font-size:24px">${minFmt}</div>
    </div>
    <div style="${STAT_TILE_WARNING}">
      <div style="${STAT_TILE_LABEL}">${esc(leafCopy.statsLabels.max)}</div>
      <div style="${STAT_TILE_VALUE};font-size:24px">${maxFmt}</div>
    </div>
    <div style="${STAT_TILE_BASE}">
      <div style="${STAT_TILE_LABEL}">${esc(leafCopy.statsLabels.insurers)}</div>
      <div style="${STAT_TILE_VALUE};font-size:24px">${stats.ranked.length}</div>
    </div>
  </section>`;

  // Canton-level YoY grid — one row per age bracket with the bracket's
  // median percent change. Rendered only when prior-year data is available.
  const yoyHubHtml = (() => {
    if (!yoy) return '';
    const rows = HEALTH_PREMIUM_AGE_BRACKETS.map((ab) => {
      const slice = yoy.byBracket[ab.id];
      return {
        ab,
        pct: slice?.medianPct ?? null,
        n: slice?.sourceInsurers ?? 0,
      };
    }).filter((r) => r.pct !== null);
    if (rows.length === 0) return '';
    const adultPctFmt = formatPct(yoy.adultMedianPct, locale);
    const gridTable = `<table style="${TABLE_STYLE};font-size:14px">
      <thead><tr>
        <th style="${TABLE_HEAD_STYLE}">${esc(copy.yoy.gridHeaders.age)}</th>
        <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.yoy.gridHeaders.delta)}</th>
      </tr></thead>
      <tbody>${rows
        .map((r) => {
          const color = (r.pct ?? 0) > 0 ? 'var(--color-danger-border)' : (r.pct ?? 0) < 0 ? 'var(--color-success-border)' : 'var(--color-subtle)';
          return `<tr>
          <td style="${TABLE_CELL_STYLE}">${esc(HEALTH_PREMIUM_AGE_LABEL[locale][r.ab.id])}</td>
          <td style="${TABLE_CELL_STYLE};color:${color};font-weight:700;text-align:right;font-variant-numeric:tabular-nums">${esc(formatPct(r.pct, locale))}</td>
        </tr>`;
        })
        .join('')}</tbody>
    </table>`;
    return `<section style="margin:0 0 24px" aria-labelledby="yoy">
      <h2 id="yoy" style="${H2_STYLE}">${esc(copy.yoy.sectionTitle(yoy.priorYear))}</h2>
      <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.yoy.cantonSummary(cantonLabel, adultPctFmt, yoy.priorYear))}</p>
      <p style="margin:0 0 12px;color:var(--color-subtle);font-size:13px;line-height:1.5">${esc(copy.yoy.gridCaption(yoy.priorYear))}</p>
      ${gridTable}
    </section>`;
  })();

  // Tri-year trend on the canton hub — short headline + adult sparkline.
  // Renders only when 3 distinct years feed the adult bracket; falls back to
  // silence when 2024 archive is missing for this canton.
  const triYearHubHtml = (() => {
    if (!triYear) return '';
    const adult = triYear.byBracket['31-45'];
    if (!adult || adult.points.length < 3) return '';
    const oldestYear = adult.points[0].year;
    const currentYear = adult.points[adult.points.length - 1].year;
    const cumFmt = formatPct(adult.cumulativePct, locale);
    const sparkAria = HUB_COPY[locale].triYear.cantonSummary(cantonLabel, oldestYear, currentYear, cumFmt);
    const sparkHtml = renderSparkline(adult, locale, sparkAria);
    return `<section style="margin:0 0 24px" aria-labelledby="triYearHub">
      <h2 id="triYearHub" style="${H2_STYLE}">${esc(copy.triYear.sectionTitle(oldestYear, currentYear))}</h2>
      <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.triYear.cantonSummary(cantonLabel, oldestYear, currentYear, cumFmt))}</p>
      ${sparkHtml}
    </section>`;
  })();

  // Canton FAQ
  const faqItems = copy.cantonFaq;
  const faqHtml = `<section style="margin:32px 0 0" aria-labelledby="hpFaq">
    <h2 id="hpFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    ${faqItems
      .map(
        (f) => `<details style="${CARD_STYLE};margin-bottom:8px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q(cantonLabel))}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a(cantonLabel, medFmt, year))}</p>
      </details>`,
      )
      .join('')}
  </section>`;

  const alternatesHtml = (Object.keys(alternates) as HealthPremiumLocale[])
    .map((alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${alternates[alt]}">`)
    .join('\n');

  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const h1 = copy.h1Canton(cantonLabel, year);
  const intro = copy.introCanton(cantonLabel, medFmt, minFmt, maxFmt, year);
  const comparatorHref = `${HEALTH_PREMIUM_COMPARATOR_PATH[locale]}?canton=${stats.cantonBagCode}`;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: leafCopy.breadcrumbRoot, item: `${BASE_URL}${buildHealthPremiumsRootPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: cantonLabel, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro.slice(0, 200),
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqItems.map((f) => ({
      '@type': 'Question',
      name: f.q(cantonLabel),
      acceptedAnswer: { '@type': 'Answer', text: f.a(cantonLabel, medFmt, year) },
    })),
  });

  const title = `${h1} | Frontaliere Ticino`;
  const description = intro.slice(0, 180);

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${BASE_URL}${buildHealthPremiumsRootPath(locale)}" style="${BREADCRUMB_LINK_STYLE}">${esc(leafCopy.breadcrumbRoot)}</a>
    <span> / </span>
    <span>${esc(cantonLabel)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">LAMal ${year} · ${esc(copy.updatedLabel)}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  ${statsHtml}
  <section style="margin:0 0 24px" aria-labelledby="ageGrid">
    <h2 id="ageGrid" style="${H2_STYLE}">${esc(copy.ageGridTitle(cantonLabel))}</h2>
    ${ageGridHtml}
  </section>
  ${yoyHubHtml}
  ${triYearHubHtml}
  <section style="margin:0 0 24px" aria-labelledby="cantonComparatorCta">
    <h2 id="cantonComparatorCta" style="${H2_STYLE}">${esc(copy.comparatorCTA)}</h2>
    <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.comparatorCTAText)}</p>
    <a href="${esc(comparatorHref)}" style="${CTA_PRIMARY_STYLE};font-size:15px">${esc(copy.comparatorCTA)}</a>
  </section>
  ${faqHtml}
  ${generateRelatedLinksBlock(locale, 'health_premiums', { cantonSlug: canton })}
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

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
    jsonLdScripts: [breadcrumbLd, webPageLd, faqLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'confronti', activeSubTab: 'health' },
  });
}

interface RootHubInputs {
  locale: HealthPremiumLocale;
  dataset: HealthPremiumsDataset;
  cantonStats: Record<HealthPremiumCanton, CantonPremiumStats | null>;
  canonicalPath: string;
  alternates: Record<HealthPremiumLocale, string>;
  today: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

function renderRootHubPage(inp: RootHubInputs): string {
  const { locale, dataset, cantonStats, canonicalPath, alternates, today, distDir } = inp;
  const copy = HUB_COPY[locale];
  const leafCopy = LEAF_COPY[locale];
  const year = dataset.year ?? today.getUTCFullYear();

  // Canton grid with adult median/min/max
  const cantonRows = HEALTH_PREMIUM_CANTONS.map((c) => {
    const s = cantonStats[c];
    if (!s) return { canton: c, med: null, min: null, max: null };
    return {
      canton: c,
      med: s.adultMedian,
      min: s.adultMin,
      max: s.adultMax,
    };
  });
  const cantonGridHtml = `<table style="${TABLE_STYLE};font-size:14px">
    <thead><tr>
      <th style="${TABLE_HEAD_STYLE}">${esc(copy.cantonGridHeaders.canton)}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.cantonGridHeaders.median)}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.cantonGridHeaders.min)}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.cantonGridHeaders.max)}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">&nbsp;</th>
    </tr></thead>
    <tbody>${cantonRows
      .map((r) => {
        const cantonPath = buildHealthPremiumsCantonPath(locale, r.canton);
        const name = HEALTH_PREMIUM_CANTON_DISPLAY[locale][r.canton];
        return `<tr>
        <td style="${TABLE_CELL_STYLE};font-weight:700"><a href="${esc(cantonPath)}" style="${LINK_ACCENT_STYLE}">${esc(name)}</a></td>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${r.med === null ? '—' : formatCHF(r.med, locale) + ' ' + esc(copy.priceUnit)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${r.min === null ? '—' : formatCHF(r.min, locale)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${r.max === null ? '—' : formatCHF(r.max, locale)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right"><a href="${esc(cantonPath)}" style="${LINK_ACCENT_STYLE};font-weight:700">${esc(copy.viewCantonCTA(name))} →</a></td>
      </tr>`;
      })
      .join('')}</tbody>
  </table>`;

  const faqItems = copy.rootFaq;
  const faqHtml = `<section style="margin:32px 0 0" aria-labelledby="hpFaq">
    <h2 id="hpFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    ${faqItems
      .map(
        (f) => `<details style="${CARD_STYLE};margin-bottom:8px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a(year))}</p>
      </details>`,
      )
      .join('')}
  </section>`;

  const alternatesHtml = (Object.keys(alternates) as HealthPremiumLocale[])
    .map((alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${alternates[alt]}">`)
    .join('\n');

  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const h1 = copy.h1Root(year);
  const intro = copy.introRoot(year);

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: leafCopy.breadcrumbRoot, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro.slice(0, 200),
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqItems.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a(year) },
    })),
  });

  const title = `${h1} | Frontaliere Ticino`;
  const description = intro.slice(0, 180);

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(leafCopy.breadcrumbRoot)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">LAMal ${year}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  <section style="margin:0 0 24px" aria-labelledby="cantonGrid">
    <h2 id="cantonGrid" style="${H2_STYLE}">${esc(copy.cantonGridTitle)}</h2>
    ${cantonGridHtml}
  </section>
  <section style="margin:0 0 24px" aria-labelledby="background">
    <h2 id="background" style="${H2_STYLE}">${esc(copy.rootBackgroundTitle)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.rootBackground)}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="rootComparatorCta">
    <h2 id="rootComparatorCta" style="${H2_STYLE}">${esc(copy.comparatorCTA)}</h2>
    <p style="margin:0 0 12px;color:var(--color-body);line-height:1.6;max-width:860px">${esc(copy.comparatorCTAText)}</p>
    <a href="${esc(HEALTH_PREMIUM_COMPARATOR_PATH[locale])}" style="${CTA_PRIMARY_STYLE};font-size:15px">${esc(copy.comparatorCTA)}</a>
  </section>
  ${faqHtml}
  ${generateRelatedLinksBlock(locale, 'health_premiums', { cantonSlug: 'ticino' })}
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

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
    jsonLdScripts: [breadcrumbLd, webPageLd, faqLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'confronti', activeSubTab: 'health' },
  });
}

// ── Pure generator ─────────────────────────────────────────────

/**
 * Pure generator — used by both the Vite plugin (closeBundle) and tests.
 * Produces a map of canonical path → HTML string and a summary of cantons
 * that had to be skipped for missing data.
 */
export interface GenerateHealthPremiumsResult {
  pages: Record<string, string>;
  skippedCantons: HealthPremiumCanton[];
  /**
   * Per-canton YoY delta computed against the optional `priorDataset`.
   * Empty record when no prior-year data was provided — the plugin then
   * renders leaves and hubs without the "Variazione vs {priorYear}" section.
   */
  yoyByCanton: Record<HealthPremiumCanton, YoyCantonDelta | null>;
  /**
   * Per-canton tri-year trend computed against the optional `oldestDataset`
   * (e.g. 2024) plus `priorDataset` (e.g. 2025). Empty record when neither
   * archive was provided — leaves and hubs then skip the tri-year block.
   */
  triYearByCanton: Record<HealthPremiumCanton, TriYearCantonDelta | null>;
}

export function generateHealthPremiumsPages(opts: {
  dataset: HealthPremiumsDataset;
  /** Optional prior-year dataset (same schema) for YoY computation. */
  priorDataset?: HealthPremiumsDataset | null;
  /**
   * Optional oldest dataset (typically 2024) used together with
   * `priorDataset` to render the tri-year trend (B-cont-4). When absent the
   * tri-year block is omitted but the YoY block still renders.
   */
  oldestDataset?: HealthPremiumsDataset | null;
  today?: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}): GenerateHealthPremiumsResult {
  const dataset = opts.dataset;
  const priorDataset = opts.priorDataset ?? null;
  const oldestDataset = opts.oldestDataset ?? null;
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;

  // Precompute per-canton stats once. Records are initialised from the
  // canonical canton list so adding new cantons in healthPremiumsData.ts
  // automatically lights up the full pipeline (no hand-maintained partial
  // record to keep in sync).
  const makeNullCantonRecord = <T>(): Record<HealthPremiumCanton, T | null> =>
    HEALTH_PREMIUM_CANTONS.reduce(
      (acc, c) => {
        acc[c] = null;
        return acc;
      },
      {} as Record<HealthPremiumCanton, T | null>,
    );
  const cantonStats = makeNullCantonRecord<CantonPremiumStats>();
  const yoyByCanton = makeNullCantonRecord<YoyCantonDelta>();
  const triYearByCanton = makeNullCantonRecord<TriYearCantonDelta>();
  const skippedCantons: HealthPremiumCanton[] = [];
  for (const c of HEALTH_PREMIUM_CANTONS) {
    const stats = computeCantonStats(dataset, c);
    cantonStats[c] = stats;
    if (!stats) {
      skippedCantons.push(c);
      console.warn(
        `[health-premiums] no premium data for canton ${c} (BAG code ${HEALTH_PREMIUM_CANTON_BAG_CODE[c]}) — skipping its pages`,
      );
      continue;
    }
    if (priorDataset) {
      yoyByCanton[c] = computeYoyDelta({
        current: dataset,
        prior: priorDataset,
        cantonBagCode: HEALTH_PREMIUM_CANTON_BAG_CODE[c],
      });
    }
    // Tri-year trend: needs at least the current dataset; oldestDataset and
    // priorDataset are optional. When only the current dataset is available
    // computeTriYearDelta returns null because no consecutive YoY can
    // be computed — keeping the leaf rendering clean.
    if (priorDataset || oldestDataset) {
      triYearByCanton[c] = computeTriYearDelta({
        current: dataset,
        prior: priorDataset,
        oldest: oldestDataset,
        cantonBagCode: HEALTH_PREMIUM_CANTON_BAG_CODE[c],
      });
    }
  }

  const pages: Record<string, string> = {};

  for (const locale of HEALTH_PREMIUM_LOCALES) {
    // Root hub
    const rootPath = buildHealthPremiumsRootPath(locale);
    const rootAlternates: Record<HealthPremiumLocale, string> = {
      it: buildHealthPremiumsRootPath('it'),
      en: buildHealthPremiumsRootPath('en'),
      de: buildHealthPremiumsRootPath('de'),
      fr: buildHealthPremiumsRootPath('fr'),
    };
    pages[rootPath] = renderRootHubPage({
      locale,
      dataset,
      cantonStats,
      canonicalPath: rootPath,
      alternates: rootAlternates,
      today,
      distDir,
    });

    for (const canton of HEALTH_PREMIUM_CANTONS) {
      const stats = cantonStats[canton];
      if (!stats) continue;

      const cantonPath = buildHealthPremiumsCantonPath(locale, canton);
      const cantonAlternates: Record<HealthPremiumLocale, string> = {
        it: buildHealthPremiumsCantonPath('it', canton),
        en: buildHealthPremiumsCantonPath('en', canton),
        de: buildHealthPremiumsCantonPath('de', canton),
        fr: buildHealthPremiumsCantonPath('fr', canton),
      };
      pages[cantonPath] = renderCantonHubPage({
        locale,
        canton,
        dataset,
        stats,
        canonicalPath: cantonPath,
        alternates: cantonAlternates,
        today,
        yoy: yoyByCanton[canton],
        triYear: triYearByCanton[canton],
        distDir,
      });

      for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
        const leafPath = buildHealthPremiumsLeafPath(locale, canton, ab.id);
        const leafAlternates: Record<HealthPremiumLocale, string> = {
          it: buildHealthPremiumsLeafPath('it', canton, ab.id),
          en: buildHealthPremiumsLeafPath('en', canton, ab.id),
          de: buildHealthPremiumsLeafPath('de', canton, ab.id),
          fr: buildHealthPremiumsLeafPath('fr', canton, ab.id),
        };
        pages[leafPath] = renderLeafPage({
          locale,
          canton,
          age: ab.id,
          dataset,
          stats,
          allCantonStats: cantonStats,
          canonicalPath: leafPath,
          alternates: leafAlternates,
          today,
          yoy: yoyByCanton[canton],
          triYear: triYearByCanton[canton],
          distDir,
        });
      }
    }
  }

  return { pages, skippedCantons, yoyByCanton, triYearByCanton };
}

// ── Sitemap ────────────────────────────────────────────────────

function buildSitemapXml(
  paths: string[],
  today: Date,
  pathsByCanonical: Record<string, { alternates: string[] }>,
): string {
  const date = today.toISOString().slice(0, 10);
  const entries = paths
    .filter((p) => !p.startsWith('/en/') && !p.startsWith('/de/') && !p.startsWith('/fr/'))
    .map((canonical) => {
      const meta = pathsByCanonical[canonical];
      const alt = meta
        ? meta.alternates
            .map((h) => `    <xhtml:link rel="alternate" hreflang="${h.split(':')[0]}" href="${h.split(':').slice(1).join(':')}" />`)
            .join('\n')
        : '';
      return `  <url>
    <loc>${BASE_URL}${canonical}</loc>
${alt}
    <lastmod>${date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
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
    if (!idx.includes('sitemap-health-premiums.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-health-premiums.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-health-premiums\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[health-premiums] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ───────────────────────────────────────────────

export function healthPremiumsLandingPlugin(rootDir: string): Plugin {
  return {
    name: 'health-premiums-landing',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_HEALTH_PREMIUMS === '1') {
        console.log('\x1b[33m[health-premiums]\x1b[0m Skipped (SKIP_HEALTH_PREMIUMS=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // Ext3 task 3 — wipe owned namespaces before regen so per-canton /
      // per-age pages that drop out of the dataset don't linger.
      cleanNamespaces(distDir, [
        'premi-cassa-malati',
        'en/health-insurance-premiums',
        'de/krankenkassenpraemien',
        'fr/primes-assurance-maladie',
      ]);
      cleanSitemapFiles(distDir, ['sitemap-health-premiums.xml']);

      // Locate the canonical current-year dataset. Preferred path is the
      // F2-A3 multi-year directory (`data/health-premiums/{year}.json`); we
      // fall back to the legacy flat file when the directory is not present
      // so older deployments keep working.
      const today = new Date();
      const preferredYear = today.getUTCFullYear();
      const dirCandidate = np.resolve(rootDir, 'data', 'health-premiums', `${preferredYear}.json`);
      const legacyCandidate = np.resolve(rootDir, 'data', 'health-premiums.json');
      let dataPath: string | null = null;
      if (fs.existsSync(dirCandidate)) dataPath = dirCandidate;
      else if (fs.existsSync(legacyCandidate)) dataPath = legacyCandidate;

      let dataset: HealthPremiumsDataset = {};
      if (!dataPath) {
        console.warn(`[health-premiums] no dataset found at ${dirCandidate} or ${legacyCandidate} — skipping plugin`);
        return;
      }
      try {
        const raw = fs.readFileSync(dataPath, 'utf-8');
        dataset = JSON.parse(raw) as HealthPremiumsDataset;
      } catch (err) {
        console.warn(`[health-premiums] failed to read ${dataPath}`, err);
        return;
      }

      // Optional prior-year dataset for YoY rendering (F2 A3). When absent
      // the generator silently skips the "Variazione vs {priorYear}"
      // section — never fabricates data.
      let priorDataset: HealthPremiumsDataset | null = null;
      const currentYear = dataset.year ?? preferredYear;
      const priorYear = currentYear - 1;
      const priorLoaded = loadPremiumsForYear(rootDir, priorYear);
      if (priorLoaded) {
        priorDataset = priorLoaded as HealthPremiumsDataset;
        console.log(`[health-premiums] loaded prior-year dataset ${priorYear} for YoY`);
      } else {
        console.log(`[health-premiums] no ${priorYear}.json archive — YoY section will be skipped`);
      }

      // Optional oldest-year dataset for tri-year trend (B-cont-4). Same
      // graceful-degradation contract: missing archive → silent skip of the
      // tri-year block, YoY block still renders.
      let oldestDataset: HealthPremiumsDataset | null = null;
      const oldestYear = currentYear - 2;
      const oldestLoaded = loadPremiumsForYear(rootDir, oldestYear);
      if (oldestLoaded) {
        oldestDataset = oldestLoaded as HealthPremiumsDataset;
        console.log(`[health-premiums] loaded oldest-year dataset ${oldestYear} for tri-year trend`);
      } else {
        console.log(`[health-premiums] no ${oldestYear}.json archive — tri-year trend section will be skipped`);
      }

      const { pages, skippedCantons, yoyByCanton, triYearByCanton } = generateHealthPremiumsPages({
        dataset,
        priorDataset,
        oldestDataset,
        today,
        distDir,
      });
      const yoyActive = Object.values(yoyByCanton).filter((y) => y !== null).length;
      const triYearActive = Object.values(triYearByCanton).filter((y) => y !== null).length;

      const collector = new WriteCollector({ distDir, skipExisting: false });
      let pagesWritten = 0;
      let skippedForWordCount = 0;
      const writtenPaths: string[] = [];

      for (const [path, html] of Object.entries(pages)) {
        const words = countHtmlBodyWords(html);
        if (words < MIN_INDEXABLE_WORDS) {
          skippedForWordCount++;
          console.warn(`[health-premiums] thin content (${words} words) for ${path} — skipping`);
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        pagesWritten++;
        writtenPaths.push(path);
      }

      await collector.flush();

      // Sitemap — emit only IT canonicals, with hreflang alternates pointing to each localised path.
      try {
        const pathsByCanonical: Record<string, { alternates: string[] }> = {};
        for (const path of writtenPaths) {
          if (path.startsWith('/en/') || path.startsWith('/de/') || path.startsWith('/fr/')) continue;
          // Build list of hreflang alternates: find corresponding entries in other locales.
          const alts: string[] = [];
          for (const alt of HEALTH_PREMIUM_LOCALES) {
            const altPath = deriveAltPath(path, alt);
            if (altPath && writtenPaths.includes(altPath)) {
              alts.push(`${alt}:${BASE_URL}${altPath}`);
            }
          }
          alts.push(`x-default:${BASE_URL}${path}`);
          pathsByCanonical[path] = { alternates: alts };
        }
        const xml = buildSitemapXml(writtenPaths, today, pathsByCanonical);
        fs.writeFileSync(np.join(distDir, 'sitemap-health-premiums.xml'), xml, 'utf-8');
        patchSitemapIndex(distDir, today.toISOString().slice(0, 10));
      } catch (err) {
        console.warn('[health-premiums] failed to write sitemap', err);
      }

      console.log(
        `\x1b[36m[health-premiums]\x1b[0m Generated ${pagesWritten} pages (skipped ${skippedForWordCount} thin; missing cantons: ${skippedCantons.length > 0 ? skippedCantons.join(',') : 'none'}; YoY active on ${yoyActive}/${HEALTH_PREMIUM_CANTONS.length} cantons; tri-year trend active on ${triYearActive}/${HEALTH_PREMIUM_CANTONS.length} cantons)`,
      );
    },
  };
}

/**
 * Given an Italian canonical path like `/premi-cassa-malati/ticino/adulto-31-45/`,
 * derive the equivalent path in the target locale by re-mapping the section,
 * canton and age slugs. Returns `null` when the path does not match the
 * expected shape.
 */
function deriveAltPath(itPath: string, targetLocale: HealthPremiumLocale): string | null {
  if (targetLocale === 'it') return itPath;
  const parts = itPath.split('/').filter(Boolean);
  if (parts.length < 1) return null;
  // Expected: [section] or [section, canton] or [section, canton, age]
  const section = parts[0];
  // Validate IT section slug
  if (section !== 'premi-cassa-malati') return null;
  // Import slug maps from the data module to avoid duplicating them here
  // (we keep this inline to prevent a circular import).
  const ageMap: Record<string, HealthPremiumAgeBracket> = {
    'bambini-0-18': '0-18',
    'giovani-adulti-19-25': '19-25',
    'adulto-26-30': '26-30',
    'adulto-31-45': '31-45',
    'adulto-46-55': '46-55',
    'adulto-56-piu': '56-plus',
  };
  // Build the IT-slug → canton identifier lookup dynamically from the
  // canonical slug table so new cantons added to healthPremiumsData.ts are
  // recognised here without a hand-edit. The IT slug is used because this
  // function only consumes IT-locale canonical paths (the sitemap emits IT
  // canonicals and derives alternates from them).
  const cantonMap: Record<string, HealthPremiumCanton> = {};
  for (const c of Object.keys(HEALTH_PREMIUM_CANTON_SLUG.it) as HealthPremiumCanton[]) {
    cantonMap[HEALTH_PREMIUM_CANTON_SLUG.it[c]] = c;
  }
  if (parts.length === 1) return buildHealthPremiumsRootPath(targetLocale);
  const canton = cantonMap[parts[1]];
  if (!canton) return null;
  if (parts.length === 2) return buildHealthPremiumsCantonPath(targetLocale, canton);
  const age = ageMap[parts[2]];
  if (!age) return null;
  return buildHealthPremiumsLeafPath(targetLocale, canton, age);
}
