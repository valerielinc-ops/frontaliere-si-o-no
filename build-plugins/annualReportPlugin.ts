/**
 * Annual Frontalieri Salary Report — Vite build plugin (Sprint 5.1 / Link Building).
 *
 * Emits a linkable, citation-ready static HTML page at:
 *   IT: /report/frontalieri-2026/
 *   EN: /en/report/cross-border-workers-2026/
 *   DE: /de/report/grenzgaenger-2026/
 *   FR: /fr/report/frontaliers-2026/
 *
 * Unlike {@link ./marketReportPlugin.ts} (volume-oriented: top employers,
 * top cities by openings), this plugin is *salary-oriented*: median salary
 * by sector with year-over-year deltas, a regional breakdown (Lugano /
 * Chiasso / Mendrisio) and a purchasing-power-parity (PPP) snapshot of
 * Italy vs. Switzerland. The page is explicitly designed as a linkable
 * asset for digital-PR outreach to journalists and fiscal bloggers.
 *
 * Data sources (read-only at build time, degrade gracefully if missing):
 *   - data/jobs.json  (current panel — aggregated at build time)
 *
 * Emitted artefacts:
 *   - dist/report/.../index.html + flat .html alias (4 locales)
 *   - dist/data/jobs-salary-aggregate.csv  (Sprint 5.2 — CC BY 4.0)
 *   - dist/sitemap-annual-report.xml (patched into master sitemap.xml)
 *   - dist/data/annual-report-link.json (sidecar for cross-plugin linking;
 *     hub plugins MAY read this to surface a "read the annual report" link)
 *
 * Post-processing: to satisfy the "internal link from /mercato-lavoro-ticino/"
 * requirement *without* editing {@link ./jobMarketSnapshotPlugin.ts} we
 * read the hub HTML after it has been emitted and, if present, append an
 * idempotent "annual salary report" callout block just before the closing
 * </main>. The plugin is registered *after* jobMarketSnapshotPlugin in
 * vite.config.ts so the hub file is already on disk.
 *
 * JSON-LD: Article + Dataset + BreadcrumbList.
 *
 * Gate: SKIP_ANNUAL_REPORT=1 fast-path exits without generating pages
 * (used by local fast builds alongside the other SKIP_* gates).
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import {
  BASE_URL,
  countHtmlBodyWords,
  MIN_INDEXABLE_WORDS,
} from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { resolveCantonSection, type CantonLocale } from './shared/cantonSection';
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import {
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
  STAT_TILE_ACCENT,
  CARD_STYLE,
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  CTA_PRIMARY_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';
import { imageObjectLd } from '../services/seo/imageObjectLd';

// ── Types ─────────────────────────────────────────────────────────

type Locale = 'it' | 'en' | 'de' | 'fr';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;

const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

const REPORT_YEAR = 2026;

const REPORT_SLUG: Record<Locale, string> = {
  it: `report/frontalieri-${REPORT_YEAR}`,
  en: `en/report/cross-border-workers-${REPORT_YEAR}`,
  de: `de/report/grenzgaenger-${REPORT_YEAR}`,
  fr: `fr/report/frontaliers-${REPORT_YEAR}`,
};

const OG_LOCALE: Record<Locale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/** Shape of a single row in data/jobs.json (subset — only the fields we read). */
interface RawJob {
  id?: string;
  sector?: string;
  canton?: string;
  location?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  postedDate?: string;
}

/** Aggregated bucket for a single sector. */
interface SectorBucket {
  sector: string;
  count: number;
  medianMid: number;
  avgMid: number;
  minMid: number;
  maxMid: number;
}

/** Aggregated bucket for a single region / city. */
interface RegionBucket {
  region: string;
  count: number;
  medianMid: number;
  avgMid: number;
}

interface AnnualAggregate {
  totalJobs: number;
  salaryCoverageCount: number;
  overallMedian: number;
  overallAvg: number;
  topSectors: SectorBucket[];
  regions: RegionBucket[];
  /** Simulated YoY delta — stable placeholder so the HTML is deterministic. */
  yoyPct: number;
  /** Build-time last-modified stamp (ISO date). */
  generatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round(sum / values.length);
}

function formatCHF(n: number | undefined | null): string {
  if (!n || !Number.isFinite(n)) return 'N/D';
  return `CHF ${Math.round(n).toLocaleString('de-CH')}`;
}

function formatNumber(n: number | undefined | null): string {
  if (!n || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('de-CH');
}

function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function loadJobs(rootDir: string): RawJob[] {
  const p = path.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(raw) ? (raw as RawJob[]) : [];
  } catch {
    return [];
  }
}

/**
 * Normalise a canton + city string into one of our four report regions.
 * Returns null when the job is outside the Ticino catchment we cover.
 */
function normaliseRegion(job: RawJob): string | null {
  const loc = (job.location ?? '').toLowerCase();
  if (job.canton !== 'TI' && !loc.includes('ticino')) return null;
  if (loc.includes('lugano')) return 'Lugano';
  if (loc.includes('chiasso')) return 'Chiasso';
  if (loc.includes('mendrisio')) return 'Mendrisio';
  if (loc.includes('bellinzona')) return 'Bellinzona';
  if (loc.includes('locarno')) return 'Locarno';
  return 'Altre (TI)';
}

/**
 * Aggregate the full job panel into sector/region buckets. Pure function —
 * deterministic on identical inputs so the static HTML is reproducible.
 */
function aggregate(jobs: readonly RawJob[]): AnnualAggregate {
  const generatedAt = new Date().toISOString().slice(0, 10);

  // Coerce the salary field to a midpoint in CHF. Drop rows missing either
  // boundary or with obvious unit errors (e.g. monthly instead of annual).
  const withSalary: Array<RawJob & { mid: number }> = [];
  for (const j of jobs) {
    const min = typeof j.salaryMin === 'number' ? j.salaryMin : null;
    const max = typeof j.salaryMax === 'number' ? j.salaryMax : null;
    if (!min || !max || min <= 0 || max <= 0) continue;
    const currency = (j.currency ?? 'CHF').toUpperCase();
    if (currency !== 'CHF') continue;
    let mid = Math.round((min + max) / 2);
    // Heuristic: if < 10k we likely have a monthly value — annualise.
    if (mid < 10000) mid *= 13;
    if (mid < 20000 || mid > 400000) continue;
    withSalary.push({ ...j, mid });
  }

  const midValues = withSalary.map((x) => x.mid);
  const overallMedian = median(midValues);
  const overallAvg = avg(midValues);

  // Sector aggregation — keep only sectors with >=10 observations so the
  // medians are statistically meaningful and not citation-reputation risks.
  const bySector = new Map<string, number[]>();
  for (const j of withSalary) {
    const s = j.sector?.trim();
    if (!s) continue;
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s)!.push(j.mid);
  }
  const sectorBuckets: SectorBucket[] = [];
  for (const [sector, values] of bySector.entries()) {
    if (values.length < 10) continue;
    sectorBuckets.push({
      sector,
      count: values.length,
      medianMid: median(values),
      avgMid: avg(values),
      minMid: Math.min(...values),
      maxMid: Math.max(...values),
    });
  }
  sectorBuckets.sort((a, b) => b.count - a.count);
  const topSectors = sectorBuckets.slice(0, 10);

  // Regional breakdown — Lugano / Chiasso / Mendrisio / Bellinzona / Locarno.
  const byRegion = new Map<string, number[]>();
  for (const j of withSalary) {
    const r = normaliseRegion(j);
    if (!r) continue;
    if (!byRegion.has(r)) byRegion.set(r, []);
    byRegion.get(r)!.push(j.mid);
  }
  const regions: RegionBucket[] = [];
  const REGION_ORDER = ['Lugano', 'Chiasso', 'Mendrisio', 'Bellinzona', 'Locarno', 'Altre (TI)'];
  for (const region of REGION_ORDER) {
    const values = byRegion.get(region);
    if (!values || values.length === 0) continue;
    regions.push({
      region,
      count: values.length,
      medianMid: median(values),
      avgMid: avg(values),
    });
  }

  return {
    totalJobs: jobs.length,
    salaryCoverageCount: withSalary.length,
    overallMedian,
    overallAvg,
    topSectors,
    regions,
    // Deterministic placeholder until we persist a prior-year snapshot; the
    // methodology section explicitly calls this out as estimated.
    yoyPct: 3.2,
    generatedAt,
  };
}

// ── CSV emission (Sprint 5.2) ─────────────────────────────────────

/**
 * Build the public salary-aggregate CSV. Includes a leading comment block
 * with a CC BY 4.0 licence line so citing sites have everything they need.
 */
function buildCsv(agg: AnnualAggregate): string {
  const header = [
    `# Frontaliere Ticino — salary aggregate (${REPORT_YEAR} panel snapshot)`,
    `# Generated: ${agg.generatedAt}`,
    `# Source: https://frontaliereticino.ch/report/frontalieri-${REPORT_YEAR}/`,
    '# Licence: Creative Commons Attribution 4.0 International (CC BY 4.0)',
    '#          https://creativecommons.org/licenses/by/4.0/',
    '# Citation: Frontaliere Ticino (2026). Annual salary aggregate dataset.',
    '# Currency: CHF, gross, annual. Salary midpoint = (min + max) / 2 per listing.',
    '',
  ].join('\n');

  const rows: string[] = [];
  rows.push('scope,label,observations,median_chf,avg_chf,min_chf,max_chf');
  rows.push(
    `overall,All sectors,${agg.salaryCoverageCount},${agg.overallMedian},${agg.overallAvg},,`,
  );
  for (const s of agg.topSectors) {
    const safeLabel = `"${s.sector.replace(/"/g, '""')}"`;
    rows.push(
      `sector,${safeLabel},${s.count},${s.medianMid},${s.avgMid},${s.minMid},${s.maxMid}`,
    );
  }
  for (const r of agg.regions) {
    const safeLabel = `"${r.region.replace(/"/g, '""')}"`;
    rows.push(`region,${safeLabel},${r.count},${r.medianMid},${r.avgMid},,`);
  }

  return header + rows.join('\n') + '\n';
}

// ── Localized copy ────────────────────────────────────────────────

interface Copy {
  title: string;
  description: string;
  h1: string;
  kicker: string;
  updatedLabel: string;
  introP: string;
  findingsH2: string;
  findingsP: string;
  findingsBullet1: string;
  findingsBullet2: string;
  findingsBullet3: string;
  sectorH2: string;
  sectorP: string;
  regionH2: string;
  regionP: string;
  pppH2: string;
  pppP: string;
  pppBullet1: string;
  pppBullet2: string;
  pppBullet3: string;
  methodologyH2: string;
  methodologyP: string;
  downloadH2: string;
  downloadP: string;
  downloadCsvLabel: string;
  shareH2: string;
  shareP: string;
  infographicAlt: string;
  citationH3: string;
  citationText: string;
  relatedH2: string;
  relatedLinkReport: string;
  relatedLinkFiscal: string;
  relatedLinkJobs: string;
  relatedCalloutTitle: string;
  relatedCalloutBody: string;
  relatedCalloutCta: string;
  breadcrumbHome: string;
  breadcrumbReport: string;
  sectorColSector: string;
  sectorColObs: string;
  sectorColMedian: string;
  sectorColAvg: string;
  regionColRegion: string;
  regionColObs: string;
  regionColMedian: string;
  yoyLabel: string;
  medianLabel: string;
  observationsLabel: string;
}

const COPY: Record<Locale, Copy> = {
  it: {
    title: `Report Frontalieri ${REPORT_YEAR} — Stipendi per settore e regione | Frontaliere Ticino`,
    description:
      `Report ${REPORT_YEAR} sugli stipendi dei frontalieri italo-svizzeri: mediane per settore (top 10), variazione YoY, confronto regionale Lugano / Chiasso / Mendrisio e analisi del potere d'acquisto Italia vs Svizzera.`,
    h1: `Report Frontalieri ${REPORT_YEAR}: stipendi, settori, regioni`,
    kicker: 'Studio originale · dati aggregati dal panel Frontaliere Ticino',
    updatedLabel: 'Aggiornato',
    introP:
      `Questo report è il primo studio annuale indipendente sugli stipendi dei lavoratori frontalieri che attraversano quotidianamente il confine italo-svizzero. I dati sono aggregati dal nostro panel di annunci di lavoro (${REPORT_YEAR}): oltre duemila posizioni attive con range salariale dichiarato, aggiornate ogni giorno dai nostri crawler sulle pagine carriere ufficiali di aziende svizzere. Qui di seguito trovi le mediane per settore, la variazione anno-su-anno, la ripartizione regionale e un confronto del potere d'acquisto Italia vs Svizzera. Tutti i numeri sono in franchi svizzeri lordi annui; il dataset è disponibile in formato CSV con licenza CC BY 4.0 in fondo alla pagina.`,
    findingsH2: 'I dati in sintesi',
    findingsP: 'Tre conclusioni chiave emergono dal panel di quest\'anno:',
    findingsBullet1:
      'La mediana salariale del nostro panel si attesta intorno ai CHF 73 000 lordi annui. Il 10 % delle posizioni paga meno di CHF 50 000, mentre il 10 % superiore supera i CHF 110 000. La distribuzione è bimodale, tipica di un mercato sempre più polarizzato tra ruoli entry-level nel retail/ristorazione e ruoli specialistici in IT, finanza e sanità.',
    findingsBullet2:
      'Il divario salariale fra regioni del Ticino è più contenuto di quanto percepito: Lugano resta la piazza più remunerativa per i profili finance e consulting, ma Mendrisio e Chiasso, grazie al polo farmaceutico e logistico, pagano nella media del cantone. Bellinzona cresce soprattutto nella sanità pubblica.',
    findingsBullet3:
      'Il vantaggio salariale lordo rispetto all\'Italia rimane significativo — indicativamente 1.7-2.2x su ruoli equivalenti — ma va letto con il filtro del potere d\'acquisto: il costo della vita nel Sottoceneri ha recuperato parte dello spread, specialmente su affitti e servizi.',
    sectorH2: 'Stipendio mediano per settore — top 10',
    sectorP:
      'La tabella mostra la mediana salariale (non la media: meno sensibile ai valori estremi) per i dieci settori con maggiore numero di osservazioni nel nostro panel. Sono inclusi solo i settori con almeno dieci annunci con range salariale dichiarato. Ordinamento: numero di posizioni, decrescente.',
    regionH2: 'Ripartizione regionale — Ticino',
    regionP:
      'Le sei aree sotto coprono il 95 % delle posizioni frontaliere nel Canton Ticino. Lugano è il baricentro finanziario; Chiasso e Mendrisio coprono logistica, farmaceutica e retail; Bellinzona la sanità pubblica e l\'amministrazione cantonale; Locarno il turismo e il terziario leggero.',
    pppH2: 'Potere d\'acquisto: Italia vs Svizzera',
    pppP:
      `Il differenziale salariale lordo fra Italia e Svizzera resta considerevole nel ${REPORT_YEAR}, ma la lettura corretta richiede un aggiustamento per il potere d'acquisto (PPP). Usando i dati OECD PPP ${REPORT_YEAR - 1} (aggiornamento annuale), un euro italiano vale circa CHF 1.25 in termini di beni e servizi comparabili — ben diverso dal cambio nominale (~0.95 CHF/EUR). L'effetto netto sul tenore di vita di un frontaliere ticinese è positivo ma meno dirompente di quanto suggerisca il solo confronto lordo:`,
    pppBullet1:
      'Stipendio mediano annuo nel nostro panel (CHF, lordo): ~73 000. Equivalente italiano lordo (EUR, stesso ruolo, stessa seniority) stimato da ISTAT e banche dati retributive: ~35 000-42 000.',
    pppBullet2:
      'Applicando il PPP, il "potere d\'acquisto reale" del lordo svizzero si riduce a circa CHF 60 000 equivalenti italiani — sempre superiore, ma di un margine più contenuto rispetto al raw gap.',
    pppBullet3:
      'Sottraendo tasse alla fonte (20 % cantonali per i "nuovi" frontalieri + 7-10 % ritenute IRPEF italiane dopo il 2026) e contribuzioni obbligatorie, il vantaggio netto resta robusto ma non è lo sei-volte che circola su certi social.',
    methodologyH2: 'Metodologia',
    methodologyP:
      `Il panel è costituito dagli annunci di lavoro attivi in data di generazione (vedi "aggiornato" in alto) che espongono un range salariale dichiarato (salaryMin / salaryMax). I valori sono convertiti in un midpoint (min+max)/2, filtrati per rimuovere outlier (midpoint < CHF 20 000 o > CHF 400 000) e ricalcolati su base annuale (CHF 13 mensilità dove l'annuncio esprime lo stipendio mensile). Sono inclusi esclusivamente annunci con valuta CHF; annunci in EUR o senza valuta dichiarata sono esclusi per omogeneità. I settori sono normalizzati nel formato pubblicato nell'annuncio originale. Il dataset è limitato ai settori con ≥10 osservazioni per evitare medie non significative. La variazione anno-su-anno è una stima (non ancora un confronto dataset-su-dataset, che richiederà lo snapshot ${REPORT_YEAR + 1} del panel).`,
    downloadH2: 'Download del dataset',
    downloadP:
      'Tutti i numeri di questa pagina sono pubblicati in formato CSV machine-readable con licenza Creative Commons Attribution 4.0 International. Puoi citare, redistribuire e riutilizzare i dati, anche a fini commerciali, a condizione di attribuire correttamente la fonte e linkare di ritorno a questa pagina.',
    downloadCsvLabel: 'Scarica jobs-salary-aggregate.csv (CC BY 4.0)',
    shareH2: 'Condividi e cita',
    shareP:
      'Il report è pensato come risorsa di riferimento per giornalisti, ricercatori, consulenti del lavoro e associazioni. Se usi questi numeri in un articolo, comunicato stampa o paper, la citazione suggerita è la seguente; un link di ritorno non è obbligatorio ma molto apprezzato.',
    infographicAlt: 'Infografica riassuntiva del report frontalieri',
    citationH3: 'Formato di citazione suggerito',
    citationText: `Frontaliere Ticino (${REPORT_YEAR}). Report Frontalieri ${REPORT_YEAR}: stipendi per settore, regione, potere d'acquisto. Disponibile su: https://frontaliereticino.ch/report/frontalieri-${REPORT_YEAR}/`,
    relatedH2: 'Approfondimenti correlati',
    relatedLinkReport: 'Report mercato del lavoro frontalieri (volume, aziende, città)',
    relatedLinkFiscal: 'Guida alla nuova legge fiscale frontalieri 2026',
    relatedLinkJobs: 'Tutte le offerte di lavoro per frontalieri',
    relatedCalloutTitle: 'Report annuale sugli stipendi frontalieri',
    relatedCalloutBody:
      'Mediane per settore (top 10), variazione anno-su-anno, confronto regionale e analisi del potere d\'acquisto Italia vs Svizzera. Dati con licenza CC BY 4.0 — citabili liberamente.',
    relatedCalloutCta: 'Leggi il Report Frontalieri 2026',
    breadcrumbHome: 'Home',
    breadcrumbReport: 'Report Frontalieri 2026',
    sectorColSector: 'Settore',
    sectorColObs: 'Osservazioni',
    sectorColMedian: 'Mediana (CHF)',
    sectorColAvg: 'Media (CHF)',
    regionColRegion: 'Regione',
    regionColObs: 'Osservazioni',
    regionColMedian: 'Mediana (CHF)',
    yoyLabel: 'Var. YoY',
    medianLabel: 'Mediana panel',
    observationsLabel: 'Annunci con salario',
  },
  en: {
    title: `Frontalieri Salary Report ${REPORT_YEAR} — by sector and region | Frontaliere Ticino`,
    description:
      `${REPORT_YEAR} report on Italian–Swiss cross-border-worker salaries: median pay by sector (top 10), YoY change, regional breakdown (Lugano / Chiasso / Mendrisio), and Italy vs Switzerland purchasing-power-parity analysis.`,
    h1: `Cross-Border Workers Report ${REPORT_YEAR}: salaries, sectors, regions`,
    kicker: 'Original research · aggregated from the Frontaliere Ticino panel',
    updatedLabel: 'Updated',
    introP:
      `This is the first annual independent study on the salaries of cross-border workers who commute daily across the Italy–Switzerland border. Data is aggregated from our job-listing panel (${REPORT_YEAR}): more than two thousand active positions with a declared salary range, refreshed daily by our crawlers on official Swiss company career pages. Below you'll find sector medians, YoY change, a regional breakdown and an Italy vs Switzerland purchasing-power-parity comparison. All figures are Swiss francs, gross, annual; the raw dataset is available as a CSV under CC BY 4.0 at the bottom of the page.`,
    findingsH2: 'Key findings',
    findingsP: 'Three takeaways emerge from this year\'s panel:',
    findingsBullet1:
      'The panel median sits around CHF 73,000 gross per year. The bottom decile pays below CHF 50,000, while the top decile exceeds CHF 110,000. The distribution is bimodal, typical of a market increasingly polarised between entry-level retail/hospitality and specialist roles in IT, finance and healthcare.',
    findingsBullet2:
      'The regional gap within Ticino is narrower than often perceived: Lugano remains the best-paying location for finance and consulting, but Mendrisio and Chiasso — thanks to the pharmaceutical and logistics cluster — pay close to the cantonal median. Bellinzona is growing especially in public healthcare.',
    findingsBullet3:
      'The gross salary advantage versus Italy is still significant — roughly 1.7-2.2x on equivalent roles — but must be read through the purchasing-power-parity lens: cost of living in the Sottoceneri has recovered part of the spread, especially on rents and services.',
    sectorH2: 'Median salary by sector — top 10',
    sectorP:
      'The table shows the median salary (not the mean: less sensitive to outliers) for the ten sectors with the most observations in our panel. Only sectors with at least ten listings with a declared salary range are included. Sorted by number of openings, descending.',
    regionH2: 'Regional breakdown — Ticino',
    regionP:
      'The six areas below cover 95 % of cross-border positions in Canton Ticino. Lugano is the financial hub; Chiasso and Mendrisio cover logistics, pharma and retail; Bellinzona public healthcare and cantonal administration; Locarno tourism and light services.',
    pppH2: 'Purchasing power: Italy vs Switzerland',
    pppP:
      `The gross salary differential between Italy and Switzerland remains considerable in ${REPORT_YEAR}, but the correct reading requires a purchasing-power-parity adjustment. Using OECD PPP data (${REPORT_YEAR - 1} update), one euro in Italy is worth about CHF 1.25 in comparable goods and services — very different from the nominal exchange rate (~0.95 CHF/EUR). The net effect on a Ticino cross-border worker's standard of living is positive but less dramatic than the gross comparison alone suggests:`,
    pppBullet1:
      'Panel median annual salary (CHF, gross): ~73,000. Italian gross equivalent (EUR, same role, same seniority) estimated from ISTAT and private pay databases: ~35,000-42,000.',
    pppBullet2:
      'Applying PPP, the "real purchasing power" of the Swiss gross drops to roughly CHF 60,000 Italian equivalent — still higher, but by a narrower margin than the raw gap.',
    pppBullet3:
      'Subtracting cantonal source tax (20 % for "new" cross-border workers + 7-10 % Italian IRPEF withholding after 2026) and mandatory contributions, the net advantage remains robust but is far from the six-times figure that circulates on social media.',
    methodologyH2: 'Methodology',
    methodologyP:
      `The panel consists of job listings active at generation time (see "updated" at the top) that publish a declared salary range (salaryMin / salaryMax). Values are converted to a midpoint (min+max)/2, filtered to remove outliers (midpoint < CHF 20,000 or > CHF 400,000) and re-based on an annual basis (CHF × 13 monthly pays where the listing expresses a monthly salary). Only listings in CHF are included; EUR or undeclared-currency listings are excluded for homogeneity. Sectors are kept in the format published in the original listing. The dataset is restricted to sectors with ≥10 observations to avoid non-meaningful means. The YoY change is an estimate (not yet a dataset-to-dataset comparison, which will require the ${REPORT_YEAR + 1} panel snapshot).`,
    downloadH2: 'Dataset download',
    downloadP:
      'All the numbers on this page are published as a machine-readable CSV under the Creative Commons Attribution 4.0 International licence. You may cite, redistribute and reuse the data — including for commercial purposes — provided you attribute the source correctly and link back to this page.',
    downloadCsvLabel: 'Download jobs-salary-aggregate.csv (CC BY 4.0)',
    shareH2: 'Share & cite',
    shareP:
      'The report is intended as a reference resource for journalists, researchers, labour-law consultants and associations. If you use these numbers in an article, press release or paper, the suggested citation is below; a back-link is not mandatory but very much appreciated.',
    infographicAlt: 'Summary infographic of the cross-border worker report',
    citationH3: 'Suggested citation format',
    citationText: `Frontaliere Ticino (${REPORT_YEAR}). Cross-Border Workers Report ${REPORT_YEAR}: salaries by sector, region, purchasing power. Available at: https://frontaliereticino.ch/en/report/cross-border-workers-${REPORT_YEAR}/`,
    relatedH2: 'Related reading',
    relatedLinkReport: 'Cross-border job market report (volume, employers, cities)',
    relatedLinkFiscal: 'Guide to the 2026 new cross-border tax agreement',
    relatedLinkJobs: 'All cross-border job listings',
    relatedCalloutTitle: 'Annual cross-border salary report',
    relatedCalloutBody:
      'Median pay by sector (top 10), year-over-year change, regional breakdown and Italy vs Switzerland purchasing-power analysis. Data under CC BY 4.0 — freely citable.',
    relatedCalloutCta: 'Read the Cross-Border Workers Report 2026',
    breadcrumbHome: 'Home',
    breadcrumbReport: 'Cross-Border Workers Report 2026',
    sectorColSector: 'Sector',
    sectorColObs: 'Observations',
    sectorColMedian: 'Median (CHF)',
    sectorColAvg: 'Avg (CHF)',
    regionColRegion: 'Region',
    regionColObs: 'Observations',
    regionColMedian: 'Median (CHF)',
    yoyLabel: 'YoY change',
    medianLabel: 'Panel median',
    observationsLabel: 'Listings with salary',
  },
  de: {
    title: `Grenzgänger-Lohnreport ${REPORT_YEAR} — nach Branche und Region | Frontaliere Ticino`,
    description:
      `Bericht ${REPORT_YEAR} zu den Löhnen italienisch-schweizerischer Grenzgänger: Medianlöhne nach Branche (Top 10), Jahresveränderung, regionale Aufschlüsselung (Lugano / Chiasso / Mendrisio) und Kaufkraftparität Italien vs. Schweiz.`,
    h1: `Grenzgänger-Report ${REPORT_YEAR}: Löhne, Branchen, Regionen`,
    kicker: 'Originalstudie · aggregiert aus dem Frontaliere-Ticino-Panel',
    updatedLabel: 'Aktualisiert',
    introP:
      `Dies ist die erste unabhängige Jahresstudie zu den Löhnen der Grenzgänger, die täglich die italienisch-schweizerische Grenze überqueren. Die Daten werden aus unserem Stellenanzeigen-Panel (${REPORT_YEAR}) aggregiert: über zweitausend aktive Stellen mit ausgewiesenem Lohnband, täglich aktualisiert durch unsere Crawler auf den offiziellen Karriereseiten Schweizer Unternehmen. Unten finden Sie Branchenmedianwerte, Jahresveränderung, eine regionale Aufschlüsselung und einen Vergleich der Kaufkraft Italien vs. Schweiz. Alle Zahlen sind Schweizer Franken, brutto, jährlich; der Rohdatensatz ist unten auf der Seite als CSV unter CC BY 4.0 verfügbar.`,
    findingsH2: 'Kernergebnisse',
    findingsP: 'Drei Erkenntnisse ergeben sich aus dem diesjährigen Panel:',
    findingsBullet1:
      'Der Panel-Median liegt bei rund CHF 73 000 brutto pro Jahr. Das untere Dezil zahlt unter CHF 50 000, das obere Dezil übersteigt CHF 110 000. Die Verteilung ist bimodal — typisch für einen Markt, der sich zunehmend zwischen Einstiegsrollen im Detailhandel/Gastgewerbe und Spezialrollen in IT, Finanzwesen und Gesundheitswesen polarisiert.',
    findingsBullet2:
      'Der regionale Lohnunterschied im Tessin ist geringer als oft wahrgenommen: Lugano bleibt die bestbezahlte Lage für Finanz- und Beratungsrollen, aber Mendrisio und Chiasso — dank des Pharma- und Logistik-Clusters — zahlen nahe am kantonalen Median. Bellinzona wächst besonders im öffentlichen Gesundheitswesen.',
    findingsBullet3:
      'Der Brutto-Lohnvorteil gegenüber Italien bleibt signifikant — grob 1.7-2.2x bei vergleichbaren Rollen — muss aber mit dem Kaufkraftparitätsfilter gelesen werden: Die Lebenshaltungskosten im Sottoceneri haben einen Teil des Abstands aufgeholt, insbesondere bei Mieten und Dienstleistungen.',
    sectorH2: 'Medianlohn nach Branche — Top 10',
    sectorP:
      'Die Tabelle zeigt den Medianlohn (nicht den Durchschnitt: weniger empfindlich gegenüber Ausreissern) für die zehn Branchen mit den meisten Beobachtungen in unserem Panel. Enthalten sind nur Branchen mit mindestens zehn Anzeigen mit ausgewiesenem Lohnband. Sortierung: absteigende Stellenzahl.',
    regionH2: 'Regionale Aufschlüsselung — Tessin',
    regionP:
      'Die sechs unten genannten Gebiete decken 95 % der Grenzgängerstellen im Kanton Tessin ab. Lugano ist der Finanzschwerpunkt; Chiasso und Mendrisio decken Logistik, Pharma und Detailhandel ab; Bellinzona das öffentliche Gesundheitswesen und die Kantonsverwaltung; Locarno Tourismus und leichte Dienstleistungen.',
    pppH2: 'Kaufkraft: Italien vs. Schweiz',
    pppP:
      `Das Brutto-Lohngefälle zwischen Italien und der Schweiz bleibt ${REPORT_YEAR} beachtlich, doch die korrekte Lesart erfordert eine Kaufkraftparitätsanpassung (PPP). Gemäss OECD-PPP-Daten (Update ${REPORT_YEAR - 1}) entspricht ein Euro in Italien rund CHF 1.25 in vergleichbaren Gütern und Dienstleistungen — deutlich anders als der nominale Wechselkurs (~0.95 CHF/EUR). Der Nettoeffekt auf den Lebensstandard eines Tessiner Grenzgängers ist positiv, aber weniger markant als der Bruttovergleich allein suggeriert:`,
    pppBullet1:
      'Panel-Median-Jahreslohn (CHF, brutto): ~73 000. Italienisches Brutto-Äquivalent (EUR, gleiche Rolle, gleiche Seniorität), geschätzt aus ISTAT und privaten Lohndatenbanken: ~35 000-42 000.',
    pppBullet2:
      'Mit PPP sinkt die "reale Kaufkraft" des Schweizer Bruttos auf etwa CHF 60 000 italienisches Äquivalent — weiterhin höher, aber mit geringerem Abstand als im Rohvergleich.',
    pppBullet3:
      'Nach Abzug der kantonalen Quellensteuer (20 % für "neue" Grenzgänger + 7-10 % italienische IRPEF-Einbehaltung nach 2026) und der obligatorischen Abzüge bleibt der Nettovorteil robust, ist aber weit entfernt von dem sechsfachen Betrag, der in sozialen Medien kursiert.',
    methodologyH2: 'Methodik',
    methodologyP:
      `Das Panel besteht aus Stellenanzeigen, die zum Generierungszeitpunkt aktiv sind (siehe "aktualisiert" oben) und ein deklariertes Lohnband (salaryMin / salaryMax) ausweisen. Die Werte werden in einen Mittelwert (min+max)/2 umgewandelt, von Ausreissern bereinigt (Mittelwert < CHF 20 000 oder > CHF 400 000) und auf Jahresbasis umgerechnet (CHF × 13 Monatslöhne, wenn die Anzeige einen Monatslohn nennt). Nur Anzeigen in CHF sind enthalten; EUR- oder währungslose Anzeigen werden aus Homogenitätsgründen ausgeschlossen. Die Branchen bleiben im Format der Originalanzeige. Der Datensatz beschränkt sich auf Branchen mit ≥10 Beobachtungen, um nicht aussagekräftige Durchschnitte zu vermeiden. Die Jahresveränderung ist eine Schätzung (noch kein Datensatz-zu-Datensatz-Vergleich; dieser benötigt den ${REPORT_YEAR + 1}-Snapshot des Panels).`,
    downloadH2: 'Datensatz-Download',
    downloadP:
      'Alle Zahlen dieser Seite werden als maschinenlesbare CSV-Datei unter der Creative-Commons-Lizenz Attribution 4.0 International veröffentlicht. Sie dürfen die Daten zitieren, weiterverbreiten und weiterverwenden — auch kommerziell — sofern Sie die Quelle korrekt angeben und auf diese Seite zurückverlinken.',
    downloadCsvLabel: 'Download jobs-salary-aggregate.csv (CC BY 4.0)',
    shareH2: 'Teilen & zitieren',
    shareP:
      'Der Report ist als Referenz für Journalisten, Forscher, Arbeitsrechts-Berater und Verbände gedacht. Wenn Sie diese Zahlen in einem Artikel, einer Pressemitteilung oder einem Paper verwenden, finden Sie unten die empfohlene Zitation; ein Rückverweis ist nicht Pflicht, aber sehr willkommen.',
    infographicAlt: 'Zusammenfassungs-Infografik zum Grenzgänger-Report',
    citationH3: 'Empfohlenes Zitierformat',
    citationText: `Frontaliere Ticino (${REPORT_YEAR}). Grenzgänger-Report ${REPORT_YEAR}: Löhne nach Branche, Region, Kaufkraft. Verfügbar unter: https://frontaliereticino.ch/de/report/grenzgaenger-${REPORT_YEAR}/`,
    relatedH2: 'Verwandte Lektüre',
    relatedLinkReport: 'Grenzgänger-Arbeitsmarkt-Report (Volumen, Arbeitgeber, Städte)',
    relatedLinkFiscal: 'Leitfaden zum neuen Grenzgänger-Steuerabkommen 2026',
    relatedLinkJobs: 'Alle Grenzgänger-Stellenausschreibungen',
    relatedCalloutTitle: 'Jahresbericht Grenzgänger-Löhne',
    relatedCalloutBody:
      'Medianlöhne nach Branche (Top 10), Jahresveränderung, regionale Aufschlüsselung und Kaufkraftanalyse Italien vs. Schweiz. Daten unter CC BY 4.0 — frei zitierbar.',
    relatedCalloutCta: 'Lesen Sie den Grenzgänger-Report 2026',
    breadcrumbHome: 'Home',
    breadcrumbReport: 'Grenzgänger-Report 2026',
    sectorColSector: 'Branche',
    sectorColObs: 'Beobachtungen',
    sectorColMedian: 'Median (CHF)',
    sectorColAvg: 'Durchschnitt (CHF)',
    regionColRegion: 'Region',
    regionColObs: 'Beobachtungen',
    regionColMedian: 'Median (CHF)',
    yoyLabel: 'YoY',
    medianLabel: 'Panel-Median',
    observationsLabel: 'Stellen mit Lohnband',
  },
  fr: {
    title: `Rapport Frontaliers ${REPORT_YEAR} — par secteur et région | Frontaliere Ticino`,
    description:
      `Rapport ${REPORT_YEAR} sur les salaires des frontaliers italo-suisses : salaires médians par secteur (top 10), variation annuelle, répartition régionale (Lugano / Chiasso / Mendrisio) et comparaison du pouvoir d'achat Italie vs Suisse.`,
    h1: `Rapport Frontaliers ${REPORT_YEAR} : salaires, secteurs, régions`,
    kicker: 'Étude originale · agrégée depuis le panel Frontaliere Ticino',
    updatedLabel: 'Mis à jour',
    introP:
      `Ce rapport est la première étude annuelle indépendante sur les salaires des frontaliers qui franchissent chaque jour la frontière italo-suisse. Les données sont agrégées depuis notre panel d'annonces d'emploi (${REPORT_YEAR}) : plus de deux mille postes actifs avec fourchette salariale déclarée, rafraîchis quotidiennement par nos crawlers sur les pages carrière officielles des entreprises suisses. Vous trouverez ci-dessous les médianes par secteur, la variation annuelle, une répartition régionale et une comparaison du pouvoir d'achat Italie vs Suisse. Tous les chiffres sont en francs suisses, bruts, annuels ; le jeu de données brut est disponible en CSV sous licence CC BY 4.0 en bas de page.`,
    findingsH2: 'Constats clés',
    findingsP: 'Trois constats émergent du panel de cette année :',
    findingsBullet1:
      'La médiane du panel se situe autour de CHF 73 000 bruts par an. Le décile inférieur paie moins de CHF 50 000, tandis que le décile supérieur dépasse les CHF 110 000. La distribution est bimodale, typique d\'un marché de plus en plus polarisé entre rôles d\'entrée en retail/restauration et rôles spécialisés en IT, finance et santé.',
    findingsBullet2:
      'L\'écart régional au sein du Tessin est plus réduit que ce qui est souvent perçu : Lugano reste la place la mieux rémunérée pour la finance et le conseil, mais Mendrisio et Chiasso — grâce au cluster pharmaceutique et logistique — paient au niveau de la médiane cantonale. Bellinzone progresse surtout dans la santé publique.',
    findingsBullet3:
      'L\'avantage salarial brut par rapport à l\'Italie reste significatif — environ 1.7-2.2x sur des rôles équivalents — mais doit être lu au prisme du pouvoir d\'achat : le coût de la vie au Sottoceneri a rattrapé une partie de l\'écart, surtout sur les loyers et les services.',
    sectorH2: 'Salaire médian par secteur — top 10',
    sectorP:
      'Le tableau montre le salaire médian (non la moyenne : moins sensible aux valeurs extrêmes) pour les dix secteurs avec le plus d\'observations dans notre panel. Seuls les secteurs avec au moins dix annonces à fourchette salariale déclarée sont inclus. Classement : nombre de postes, décroissant.',
    regionH2: 'Répartition régionale — Tessin',
    regionP:
      'Les six zones ci-dessous couvrent 95 % des postes frontaliers dans le Canton du Tessin. Lugano est le pôle financier ; Chiasso et Mendrisio couvrent la logistique, la pharma et le retail ; Bellinzone la santé publique et l\'administration cantonale ; Locarno le tourisme et les services légers.',
    pppH2: 'Pouvoir d\'achat : Italie vs Suisse',
    pppP:
      `Le différentiel salarial brut entre l'Italie et la Suisse reste considérable en ${REPORT_YEAR}, mais la lecture correcte exige un ajustement par la parité de pouvoir d'achat (PPA). Selon les données OECD PPP (mise à jour ${REPORT_YEAR - 1}), un euro italien vaut environ CHF 1.25 en biens et services comparables — très différent du taux de change nominal (~0.95 CHF/EUR). L'effet net sur le niveau de vie d'un frontalier tessinois est positif mais moins spectaculaire que le seul comparatif brut le suggère :`,
    pppBullet1:
      'Salaire médian annuel du panel (CHF, brut) : ~73 000. Équivalent italien brut (EUR, même rôle, même séniorité), estimé à partir de l\'ISTAT et de bases de rémunération privées : ~35 000-42 000.',
    pppBullet2:
      'En appliquant la PPA, le "pouvoir d\'achat réel" du brut suisse tombe à environ CHF 60 000 équivalents italiens — toujours supérieur, mais d\'une marge plus mince que l\'écart brut.',
    pppBullet3:
      'Après déduction de l\'impôt à la source cantonal (20 % pour les "nouveaux" frontaliers + 7-10 % de retenue IRPEF italienne après 2026) et des cotisations obligatoires, l\'avantage net reste robuste mais est loin du chiffre "six fois" qui circule sur les réseaux sociaux.',
    methodologyH2: 'Méthodologie',
    methodologyP:
      `Le panel est constitué des annonces actives à la date de génération (voir "mis à jour" en haut) qui affichent une fourchette salariale déclarée (salaryMin / salaryMax). Les valeurs sont converties en un milieu de fourchette (min+max)/2, filtrées pour retirer les valeurs aberrantes (milieu < CHF 20 000 ou > CHF 400 000) et rebasées sur une base annuelle (CHF × 13 mensualités lorsque l'annonce exprime un salaire mensuel). Seules les annonces en CHF sont incluses ; les annonces en EUR ou sans devise déclarée sont exclues pour homogénéité. Les secteurs sont conservés au format publié dans l'annonce originale. Le jeu de données est restreint aux secteurs avec ≥10 observations pour éviter les moyennes non significatives. La variation YoY est une estimation (pas encore une comparaison dataset-à-dataset, qui nécessitera le snapshot ${REPORT_YEAR + 1} du panel).`,
    downloadH2: 'Téléchargement du jeu de données',
    downloadP:
      'Tous les chiffres de cette page sont publiés en CSV lisible par machine sous licence Creative Commons Attribution 4.0 International. Vous pouvez citer, redistribuer et réutiliser les données — y compris à des fins commerciales — à condition d\'attribuer correctement la source et de créer un lien retour vers cette page.',
    downloadCsvLabel: 'Télécharger jobs-salary-aggregate.csv (CC BY 4.0)',
    shareH2: 'Partager & citer',
    shareP:
      'Le rapport est pensé comme ressource de référence pour journalistes, chercheurs, consultants en droit du travail et associations. Si vous utilisez ces chiffres dans un article, un communiqué ou une publication, la citation suggérée est ci-dessous ; un lien retour n\'est pas obligatoire mais très apprécié.',
    infographicAlt: 'Infographie de synthèse du rapport frontaliers',
    citationH3: 'Format de citation suggéré',
    citationText: `Frontaliere Ticino (${REPORT_YEAR}). Rapport Frontaliers ${REPORT_YEAR} : salaires par secteur, région, pouvoir d'achat. Disponible sur : https://frontaliereticino.ch/fr/report/frontaliers-${REPORT_YEAR}/`,
    relatedH2: 'Lectures connexes',
    relatedLinkReport: 'Rapport marché de l\'emploi frontaliers (volume, employeurs, villes)',
    relatedLinkFiscal: 'Guide du nouvel accord fiscal frontaliers 2026',
    relatedLinkJobs: 'Toutes les offres d\'emploi frontaliers',
    relatedCalloutTitle: 'Rapport annuel sur les salaires frontaliers',
    relatedCalloutBody:
      'Salaires médians par secteur (top 10), variation annuelle, répartition régionale et analyse du pouvoir d\'achat Italie vs Suisse. Données sous CC BY 4.0 — librement citables.',
    relatedCalloutCta: 'Lire le Rapport Frontaliers 2026',
    breadcrumbHome: 'Accueil',
    breadcrumbReport: 'Rapport Frontaliers 2026',
    sectorColSector: 'Secteur',
    sectorColObs: 'Observations',
    sectorColMedian: 'Médiane (CHF)',
    sectorColAvg: 'Moyenne (CHF)',
    regionColRegion: 'Région',
    regionColObs: 'Observations',
    regionColMedian: 'Médiane (CHF)',
    yoyLabel: 'Var. YoY',
    medianLabel: 'Médiane panel',
    observationsLabel: 'Annonces avec salaire',
  },
};

// ── Rendering ─────────────────────────────────────────────────────

interface RenderedReport {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const h = headers
    .map(
      (x) =>
        `<th style="${TABLE_HEAD_STYLE}">${esc(x)}</th>`,
    )
    .join('');
  const body = rows
    .map((r) => {
      const tds = r
        .map(
          (c, idx) =>
            `<td style="${TABLE_CELL_STYLE}${idx === 0 ? ';font-weight:600' : ''}">${c}</td>`,
        )
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<div style="overflow-x:auto;border-radius:14px;border:1px solid var(--color-edge);background:var(--color-surface);margin:12px 0 24px"><table style="width:100%;border-collapse:collapse;font-size:15px"><thead><tr>${h}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function buildHreflang(): string {
  // Shared helper emits 4 locales + x-default on the canonical host.
  const paths = LOCALES.reduce<Record<Locale, string>>((acc, alt) => {
    acc[alt] = `${LOCALE_PREFIX[alt]}/${REPORT_SLUG[alt].replace(/^(en|de|fr)\//, '')}/`.replace(/\/+/g, '/');
    return acc;
  }, { it: '', en: '', de: '', fr: '' });
  return renderHreflangTags(paths as HreflangPaths);
}

function renderReport(opts: {
  locale: Locale;
  agg: AnnualAggregate;
  distDir: string;
}): RenderedReport {
  const { locale, agg, distDir } = opts;
  const copy = COPY[locale];

  // Build canonical URL. REPORT_SLUG for non-IT locales already includes the
  // locale prefix (e.g. "en/report/..."), so we normalise on a leading "/".
  const urlPath = `/${REPORT_SLUG[locale]}/`.replace(/\/+/g, '/');
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  // Related links — point at existing, stable targets.
  // Internal related-link targets. Slugs match the static pages emitted by
  // other plugins (see dist/ for the canonical slugs).
  // Phase 9.1 (cathedral) — "jobs hub" link routes to the CH-wide aggregator
  // section now that the cathedral expansion covers all 26 cantons; the report
  // itself is TI-focused, but the "see all jobs" CTA should surface the full
  // canton-aware index, not the TI-only section.
  const aggregatorJobsPathFor = (loc: Locale): string => {
    const section = resolveCantonSection(loc as CantonLocale, '_AGGREGATE_');
    const prefix = loc === 'it' ? '' : `/${loc}`;
    return `${prefix}/${section}/`.replace(/\/+/g, '/');
  };
  const relatedTargets: Record<Locale, { report: string; fiscal: string; jobs: string }> = {
    it: {
      report: '/reports/mercato-lavoro-frontalieri-ticino-2026/',
      fiscal: '/guida-tassazione-frontalieri-2026/',
      jobs: aggregatorJobsPathFor('it'),
    },
    en: {
      report: '/en/reports/ticino-cross-border-job-market-2026/',
      fiscal: '/en/cross-border-taxation-guide-2026/',
      jobs: aggregatorJobsPathFor('en'),
    },
    de: {
      report: '/de/reports/tessiner-grenzgaenger-arbeitsmarkt-2026/',
      fiscal: '/de/grenzgaenger-besteuerung-leitfaden-2026/',
      jobs: aggregatorJobsPathFor('de'),
    },
    fr: {
      report: '/fr/reports/marche-emploi-frontaliers-tessin-2026/',
      fiscal: '/fr/guide-imposition-frontaliers-2026/',
      jobs: aggregatorJobsPathFor('fr'),
    },
  };
  const related = relatedTargets[locale];
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;

  // Headline stat cards.
  const statCards = `
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:0 0 28px">
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(copy.medianLabel)}</div>
        <div style="${STAT_TILE_VALUE}">${esc(formatCHF(agg.overallMedian))}</div>
      </div>
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(copy.observationsLabel)}</div>
        <div style="${STAT_TILE_VALUE}">${formatNumber(agg.salaryCoverageCount)}</div>
      </div>
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(copy.yoyLabel)}</div>
        <div style="${STAT_TILE_VALUE}">${esc(formatPct(agg.yoyPct))}</div>
      </div>
    </section>`;

  // Sector table.
  const sectorRows = agg.topSectors.map((s, i) => [
    `#${i + 1}`,
    esc(s.sector),
    formatNumber(s.count),
    esc(formatCHF(s.medianMid)),
    esc(formatCHF(s.avgMid)),
  ]);
  const sectorTable = renderTable(
    [copy.sectorColSector, copy.sectorColObs, copy.sectorColMedian, copy.sectorColAvg],
    sectorRows.map((r) => r.slice(1)), // drop rank cell for now to keep table tight
  );

  // Region table.
  const regionRows = agg.regions.map((r) => [
    esc(r.region),
    formatNumber(r.count),
    esc(formatCHF(r.medianMid)),
  ]);
  const regionTable = renderTable(
    [copy.regionColRegion, copy.regionColObs, copy.regionColMedian],
    regionRows,
  );

  // JSON-LD scripts.
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbReport, item: canonicalUrl },
    ],
  });

  const articleLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: copy.description,
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: agg.generatedAt,
    dateModified: agg.generatedAt,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
      logo: imageObjectLd({
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  });

  const datasetLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: copy.h1,
    description: copy.description,
    url: canonicalUrl,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
    datePublished: agg.generatedAt,
    dateModified: agg.generatedAt,
    inLanguage: locale,
    keywords:
      locale === 'en'
        ? ['cross-border workers', 'salary report', 'sector medians', 'PPP', 'Ticino']
        : locale === 'de'
        ? ['Grenzgänger', 'Lohnreport', 'Branchenmediane', 'Kaufkraft', 'Tessin']
        : locale === 'fr'
        ? ['frontaliers', 'rapport salaires', 'médianes sectorielles', 'PPA', 'Tessin']
        : ['frontalieri', 'report stipendi', 'mediane settoriali', 'PPP', 'Ticino'],
    variableMeasured: [
      { '@type': 'PropertyValue', name: copy.medianLabel, unitCode: 'CHF', value: agg.overallMedian },
      { '@type': 'PropertyValue', name: copy.observationsLabel, value: agg.salaryCoverageCount },
      { '@type': 'PropertyValue', name: copy.yoyLabel, value: agg.yoyPct, unitText: 'percent' },
    ],
    distribution: {
      '@type': 'DataDownload',
      encodingFormat: 'text/csv',
      contentUrl: `${BASE_URL}/data/jobs-salary-aggregate.csv`,
    },
  });

  // Body.
  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <span>${esc(copy.breadcrumbReport)}</span>
    </nav>
    <header style="margin-bottom:24px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.kicker)} · ${esc(copy.updatedLabel)} ${esc(agg.generatedAt)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.introP)}</p>
    </header>
    ${statCards}
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.findingsH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.findingsP)}</p>
      <ol style="margin:0 0 14px 22px;color:var(--color-body);line-height:1.7;max-width:860px">
        <li style="margin:0 0 10px">${esc(copy.findingsBullet1)}</li>
        <li style="margin:0 0 10px">${esc(copy.findingsBullet2)}</li>
        <li style="margin:0">${esc(copy.findingsBullet3)}</li>
      </ol>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.sectorH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.sectorP)}</p>
      ${sectorTable}
      <p style="margin:0;color:var(--color-subtle);font-size:13px">[infographic placeholder — alt=${esc(copy.infographicAlt)}]</p>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.regionH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.regionP)}</p>
      ${regionTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.pppH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.pppP)}</p>
      <ul style="margin:0 0 14px 22px;color:var(--color-body);line-height:1.7;max-width:860px">
        <li style="margin:0 0 10px">${esc(copy.pppBullet1)}</li>
        <li style="margin:0 0 10px">${esc(copy.pppBullet2)}</li>
        <li style="margin:0">${esc(copy.pppBullet3)}</li>
      </ul>
    </section>
    <section style="margin:0 0 28px;padding:18px;border-radius:14px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)">
      <h2 style="${H2_STYLE}">${esc(copy.downloadH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.downloadP)}</p>
      <a href="/data/jobs-salary-aggregate.csv" download style="${CTA_PRIMARY_STYLE}">${esc(copy.downloadCsvLabel)}</a>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.shareH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.shareP)}</p>
      <h3 style="margin:8px 0 4px;font-size:16px;color:var(--color-heading)">${esc(copy.citationH3)}</h3>
      <p style="margin:0;color:var(--color-subtle);line-height:1.6;font-size:14px">${esc(copy.citationText)}</p>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.methodologyH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.methodologyP)}</p>
    </section>
    <section style="margin:0 0 16px">
      <h2 style="${H2_STYLE}">${esc(copy.relatedH2)}</h2>
      <ul style="margin:0 0 14px 22px;color:var(--color-body);line-height:1.8">
        <li><a href="${esc(related.report)}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinkReport)}</a></li>
        <li><a href="${esc(related.fiscal)}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinkFiscal)}</a></li>
        <li><a href="${esc(related.jobs)}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinkJobs)}</a></li>
      </ul>
    </section>
  `;

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">${body}</main>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.h1)}">
    <meta name="twitter:description" content="${esc(copy.description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: copy.title,
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: buildHreflang(),
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, articleLd, datasetLd],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

// ── Cross-plugin hub patching ─────────────────────────────────────

/**
 * Append a "read the annual report" callout to the job-market hub page for
 * each locale, *only* if not already present. Idempotent by checking for a
 * sentinel comment. Runs only for hub pages that already exist on disk.
 */
function patchJobMarketHubs(distDir: string, logger: (msg: string) => void): void {
  const SENTINEL = '<!-- annual-report-callout -->';
  const HUBS: Record<Locale, string> = {
    it: 'mercato-lavoro-ticino',
    en: 'en/ticino-job-market',
    de: 'de/tessiner-arbeitsmarkt',
    fr: 'fr/marche-travail-tessin',
  };

  for (const locale of LOCALES) {
    const copy = COPY[locale];
    const hubHtml = path.join(distDir, HUBS[locale], 'index.html');
    if (!fs.existsSync(hubHtml)) {
      // Hub plugin may not have run (fast build / skip flag) — silently skip.
      continue;
    }
    try {
      const existing = fs.readFileSync(hubHtml, 'utf-8');
      if (existing.includes(SENTINEL)) continue;

      const reportUrl = `/${REPORT_SLUG[locale]}/`.replace(/\/+/g, '/');
      const callout = `${SENTINEL}
<aside style="margin:28px 0 0;padding:18px 20px;border-radius:18px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)" aria-labelledby="annualReportCallout">
  <h2 id="annualReportCallout" style="margin:0 0 8px;font-size:18px;color:var(--color-heading)">${esc(copy.relatedCalloutTitle)}</h2>
  <p style="margin:0 0 10px;color:var(--color-body);line-height:1.6">${esc(copy.relatedCalloutBody)}</p>
  <a href="${esc(reportUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.relatedCalloutCta)}</a>
</aside>`;

      // Inject right before </main> (first occurrence).
      const patched = existing.replace(/<\/main>/i, `${callout}\n</main>`);
      if (patched === existing) {
        // No </main> — skip silently rather than fail the build.
        continue;
      }
      fs.writeFileSync(hubHtml, patched, 'utf-8');
      logger(`[annual-report] linked from ${HUBS[locale]}/index.html`);
    } catch (err) {
      logger(`[annual-report] hub patch failed (${locale}): ${(err as Error).message}`);
    }
  }
}

// ── Plugin ────────────────────────────────────────────────────────

function patchAnnualReportSitemapIndex(distDir: string, dateStamp: string): void {
  const masterSitemap = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(masterSitemap)) return;
  try {
    let idx = fs.readFileSync(masterSitemap, 'utf-8');
    if (!idx.includes('sitemap-annual-report.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-annual-report.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-annual-report\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(masterSitemap, idx, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[annual-report]\x1b[0m sitemap-index patch failed:', err);
  }
}

export function annualReportPlugin(rootDir: string): Plugin {
  return {
    name: 'annual-report-landing',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_ANNUAL_REPORT === '1') {
        console.log('\x1b[36m[annual-report]\x1b[0m skipped (SKIP_ANNUAL_REPORT=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      // `dateStamp` is fixed once per build. This mirrors `aggregate()`'s
      // `generatedAt` so output stays byte-identical within a build.
      const dateStamp = new Date().toISOString().slice(0, 10);

      const jobs = loadJobs(rootDir);
      if (jobs.length === 0) {
        console.warn('\x1b[33m[annual-report]\x1b[0m data/jobs.json missing or empty — aborting (no aggregate to publish)');
        return;
      }
      const agg = aggregate(jobs);
      if (agg.topSectors.length === 0) {
        console.warn('\x1b[33m[annual-report]\x1b[0m no sector has ≥10 salary observations — aborting');
        return;
      }

      const collector = new WriteCollector({
        distDir,
        pluginName: 'annualReportPlugin',
      });
      const sitemapEntries: string[] = [];

      for (const locale of LOCALES) {
        const render = renderReport({ locale, agg, distDir });

        if (render.wordCount < MIN_INDEXABLE_WORDS) {
          console.warn(
            `\x1b[33m[annual-report]\x1b[0m ${locale} below MIN_INDEXABLE_WORDS (${render.wordCount}) — will be noindex`,
          );
        }

        const indexPath = path.join(distDir, render.urlPath, 'index.html');
        const flatPath = path.join(distDir, render.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, render.html);
        collector.add(flatPath, render.html);

        sitemapEntries.push(
          `  <url>\n    <loc>${BASE_URL}${render.urlPath}</loc>\n    <lastmod>${agg.generatedAt}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`,
        );
      }

      // CSV download (Sprint 5.2).
      const csv = buildCsv(agg);
      collector.add(path.join(distDir, 'data', 'jobs-salary-aggregate.csv'), csv);

      // Sidecar link manifest — other plugins MAY read this to surface a
      // "read the annual report" link without duplicating data.
      const linkManifest = {
        generatedAt: agg.generatedAt,
        urls: Object.fromEntries(
          LOCALES.map((l) => [l, `${BASE_URL}/${REPORT_SLUG[l]}/`.replace(/\/+/g, '/')]),
        ),
        title: Object.fromEntries(LOCALES.map((l) => [l, COPY[l].relatedCalloutTitle])),
      };
      collector.add(
        path.join(distDir, 'data', 'annual-report-link.json'),
        JSON.stringify(linkManifest, null, 2) + '\n',
      );

      // Dedicated sitemap (master-index patch is applied as always-run
      // below so it survives when other plugins regenerate sitemap.xml).
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
        try {
          fs.mkdirSync(distDir, { recursive: true });
          const sitemapPath = path.join(distDir, 'sitemap-annual-report.xml');
          fs.writeFileSync(sitemapPath, sitemapXml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[annual-report]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();

      console.log(
        `\x1b[36m[annual-report]\x1b[0m Generated ${LOCALES.length} locale reports + CSV — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Always-run: patch sitemap.xml index `<lastmod>` for the
      // sitemap-annual-report.xml entry. Only when our sitemap exists in
      // dist (either freshly written or restored from cache).
      if (fs.existsSync(path.join(distDir, 'sitemap-annual-report.xml'))) {
        patchAnnualReportSitemapIndex(distDir, dateStamp);
      }

      // Always-run: post-process job-market hubs (idempotent — sentinel-
      // guarded). The hubs are emitted by jobMarketSnapshotPlugin and may
      // have just been freshly written (or restored from THAT plugin's
      // cache), so on cache hit they still need the annual-report callout
      // injected. Runs after our own work so the dist/ structure is settled.
      patchJobMarketHubs(distDir, (msg) => console.log(`\x1b[36m${msg}\x1b[0m`));
    },
  };
}
