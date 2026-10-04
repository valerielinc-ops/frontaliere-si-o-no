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
 * by sector, explicitly unavailable year-over-year comparisons, a regional breakdown (Lugano /
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
import {
  renderSeoHeroImage,
  seoHeroImageObject,
  seoHeroImageUrl,
  SEO_HERO_WIDTH,
  SEO_HERO_HEIGHT,
  type SeoHeroImageOpts,
} from './shared/seoHeroImage';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { resolveCantonSection, type CantonLocale } from './shared/cantonSection';
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import {
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { buildTitleWithBrand } from './shared/titleSuffix';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import { jobSalaryMidpoint } from './shared/realSalaryMedian';
import { isReportSalaryJob, loadReportJobPanel, type ReportJob } from './shared/reportJobPanel';

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
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

type RawJob = ReportJob;

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
  salaryCoverageCount: number | null;
  overallMedian: number;
  overallAvg: number;
  topSectors: SectorBucket[];
  regions: RegionBucket[];
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
  if (n == null || !Number.isFinite(n)) return 'N/D';
  return Math.round(n).toLocaleString('de-CH');
}

/**
 * Normalise a canton + city string into one of our four report regions.
 * Returns null when the job is outside the Ticino catchment we cover.
 */
function normaliseRegion(job: RawJob): string | null {
  const loc = (job.location ?? '').toLowerCase();
  if (job.canton !== 'TI') return null;
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
function aggregate(jobs: readonly RawJob[] | null): AnnualAggregate {
  const generatedAt = new Date().toISOString().slice(0, 10);

  // A year-labelled Ticino report must not silently mix other cantons,
  // undated listings, inferred ranges, currencies or monthly pay periods.
  const withSalary: Array<RawJob & { mid: number }> = [];
  for (const j of jobs ?? []) {
    if (!isReportSalaryJob(j)) continue;
    const mid = jobSalaryMidpoint(j);
    if (mid === null) continue;
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
    salaryCoverageCount: jobs === null ? null : withSalary.length,
    overallMedian,
    overallAvg,
    topSectors,
    regions,
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
    `overall,All sectors,${agg.salaryCoverageCount ?? ''},${agg.salaryCoverageCount ? agg.overallMedian : ''},${agg.salaryCoverageCount ? agg.overallAvg : ''},,`,
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
  // Functions (not literal strings) — interpolate the panel median at
  // render time from the same `agg.overallMedian` source of truth used by
  // the stat tile and Dataset JSON-LD, so this copy can never drift into a
  // stale hardcoded figure again (#4394: was a hardcoded "CHF 73 000").
  findingsBullet1: (agg: AnnualAggregate) => string;
  findingsBullet2: string;
  findingsBullet3: string;
  sectorH2: string;
  sectorP: string;
  regionH2: string;
  regionP: string;
  pppH2: string;
  pppP: string;
  pppBullet1: (agg: AnnualAggregate) => string;
  pppBullet2: string;
  pppBullet3: string;
  methodologyH2: string;
  methodologyP: string;
  methodologySourcesLabel: string;
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
  unavailableLabel: string;
  medianLabel: string;
  observationsLabel: string;
}

const COPY: Record<Locale, Copy> = {
  it: {
    title: buildTitleWithBrand(`Report Frontalieri ${REPORT_YEAR} — Stipendi per settore e regione`),
    description: `Report ${REPORT_YEAR} degli annunci del Ticino: salari dichiarati per settore e regione, numerosità del campione e limiti dei confronti annuali e del potere d’acquisto.`,
    h1: `Report Frontalieri ${REPORT_YEAR}: stipendi, settori, regioni`,
    kicker: 'Studio originale · dati aggregati dal panel Frontaliere Ticino',
    updatedLabel: 'Aggiornato',
    introP: `Questo report descrive il campione disponibile di annunci del Ticino pubblicati nel ${REPORT_YEAR}, non tutti i salari percepiti dai frontalieri. Le osservazioni salariali ammissibili sono contate nella scheda e nel CSV: includono solo importi annuali in CHF con provenienza dichiarata. Le tabelle mostrano i settori e le località presenti nel campione; un dato assente non viene sostituito con una stima. Il confronto anno-su-anno non è disponibile senza due snapshot annuali comparabili.`,
    findingsH2: 'I dati in sintesi',
    findingsP: `Come leggere il campione:`,
    findingsBullet1: (agg: AnnualAggregate) => `Mediana dei punti medi dei range annuali dichiarati: ${formatCHF(agg.overallMedian)}. Osservazioni ammissibili: ${formatNumber(agg.salaryCoverageCount)}. Non è una misura dei salari effettivamente versati né una mediana rappresentativa di tutti i frontalieri.`,
    findingsBullet2: `Le differenze fra località dipendono anche dalle professioni e dalle aziende presenti negli annunci. Confrontare la numerosità di ogni gruppo prima di interpretare le mediane; un gruppo piccolo non dimostra un vantaggio territoriale.`,
    findingsBullet3: `Il panel non contiene un campione italiano abbinato per ruolo, anzianità e orario. Non permette quindi di quantificare il vantaggio salariale Italia–Svizzera o la sua evoluzione.`,
    sectorH2: 'Stipendio mediano per settore — top 10',
    sectorP:
      'La tabella mostra la mediana salariale (non la media: meno sensibile ai valori estremi) per i dieci settori con maggiore numero di osservazioni nel nostro panel. Sono inclusi solo i settori con almeno dieci annunci con range salariale dichiarato. Ordinamento: numero di posizioni, decrescente.',
    regionH2: 'Ripartizione regionale — Ticino',
    regionP: `Gli annunci del Canton Ticino sono raggruppati per località indicata: Lugano, Chiasso, Mendrisio, Bellinzona, Locarno e altre località ticinesi. La tabella descrive le osservazioni disponibili, non la copertura del mercato del lavoro cantonale. Le località senza osservazioni ammissibili non hanno una mediana pubblicabile.`,
    pppH2: 'Potere d\'acquisto: Italia vs Svizzera',
    pppP: `La parità di potere d’acquisto confronta beni e servizi fra paesi; il cambio converte valute. Non sono la stessa misura. Questo panel di annunci non contiene prezzi comparabili o una serie PPP documentata, quindi non viene pubblicato un coefficiente di conversione del potere d’acquisto.`,
    pppBullet1: (agg: AnnualAggregate) => `Il dato di partenza disponibile è il salario annuo lordo del panel: mediana ${formatCHF(agg.overallMedian)}. Per confrontarlo con un’offerta italiana servono ruolo, orario, anzianità e componenti retributive equivalenti.`,
    pppBullet2: `Il budget personale deve distinguere le spese nel paese di residenza e in quello di lavoro: abitazione, trasporti, assicurazioni e servizi possono incidere diversamente. Il report non stima un reddito italiano equivalente.`,
    pppBullet3: `Il netto dipende dalla situazione fiscale e familiare individuale e dai contributi applicabili. Usa il simulatore e la guida fiscale collegati per uno scenario esplicito: non applicare una percentuale unica al salario lordo.`,
    methodologyH2: 'Metodologia',
    methodologyP: `Si selezionano dal panel gli annunci del Ticino datati nell’anno del report. Si includono solo range con provenienza reported, valuta CHF e periodo annuale espliciti, estremi finiti positivi e ordinati. Non si convertono importi mensili o valute mancanti. Il punto medio è (min+max)/2; si escludono estremi inferiori a CHF 20 000 o superiori a CHF 300 000. La mediana e la media complessive usano tutte le osservazioni ammissibili; la tabella settoriale richiede almeno dieci osservazioni per settore. Le stime e le provenienze mancanti o ambigue sono escluse. Senza snapshot comparabili di due anni non si calcola una variazione annuale. Senza osservazioni, la mediana è non disponibile e il CSV lascia vuoti i valori salariali.`,
    methodologySourcesLabel: 'Confronto con fonti statistiche ufficiali:',
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
    relatedCalloutBody: `Salari dichiarati per settore e località, numerosità del campione e limiti metodologici. Dataset aggregato con licenza CC BY 4.0.`,
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
    unavailableLabel: `Non disponibile`,
    yoyLabel: 'Var. YoY',
    medianLabel: 'Mediana panel',
    observationsLabel: 'Annunci con salario',
  },
  en: {
    title: buildTitleWithBrand(`Frontalieri Salary Report ${REPORT_YEAR} — by sector and region`),
    description: `${REPORT_YEAR} Ticino job-listing report: reported salaries by sector and location, sample sizes and limitations of annual and purchasing-power comparisons.`,
    h1: `Cross-Border Workers Report ${REPORT_YEAR}: salaries, sectors, regions`,
    kicker: 'Original research · aggregated from the Frontaliere Ticino panel',
    updatedLabel: 'Updated',
    introP: `This report describes the available sample of Ticino listings published in ${REPORT_YEAR}, not all salaries earned by cross-border workers. Eligible salary observations are counted in the card and CSV: only explicitly annual CHF amounts with reported provenance are included. Tables describe the sectors and locations in the sample; missing data is not replaced with an estimate. Year-over-year change is unavailable without two comparable annual snapshots.`,
    findingsH2: 'Key findings',
    findingsP: `How to read the sample:`,
    findingsBullet1: (agg: AnnualAggregate) => `Median of the midpoints of reported annual ranges: ${formatCHF(agg.overallMedian)}. Eligible observations: ${formatNumber(agg.salaryCoverageCount)}. This does not measure salaries actually paid or represent all cross-border workers.`,
    findingsBullet2: `Differences between locations also reflect the occupations and employers represented in the listings. Compare group sizes before interpreting medians; a small group does not establish a geographic pay advantage.`,
    findingsBullet3: `The panel contains no Italian sample matched by role, seniority and working hours. It therefore cannot quantify the Italy–Switzerland salary advantage or its evolution.`,
    sectorH2: 'Median salary by sector — top 10',
    sectorP:
      'The table shows the median salary (not the mean: less sensitive to outliers) for the ten sectors with the most observations in our panel. Only sectors with at least ten listings with a declared salary range are included. Sorted by number of openings, descending.',
    regionH2: 'Regional breakdown — Ticino',
    regionP: `Ticino listings are grouped by their stated location: Lugano, Chiasso, Mendrisio, Bellinzona, Locarno and other Ticino locations. The table describes available observations, not coverage of the cantonal labour market. Locations without eligible observations have no publishable median.`,
    pppH2: 'Purchasing power: Italy vs Switzerland',
    pppP: `Purchasing-power parity compares goods and services between countries; exchange rates convert currencies. These are different measures. This listing panel contains neither comparable prices nor a documented PPP series, so no purchasing-power conversion coefficient is published.`,
    pppBullet1: (agg: AnnualAggregate) => `The available starting point is annual gross pay in the panel: median ${formatCHF(agg.overallMedian)}. Comparing this with an Italian offer requires equivalent roles, hours, seniority and compensation components.`,
    pppBullet2: `A personal budget must distinguish spending in the country of residence from spending in the country of work: housing, transport, insurance and services may affect each differently. This report does not estimate an equivalent Italian income.`,
    pppBullet3: `Net income depends on individual tax and family circumstances and applicable contributions. Use the linked calculator and tax guide for an explicit scenario; do not apply one universal percentage to gross salary.`,
    methodologyH2: 'Methodology',
    methodologyP: `The panel is filtered to Ticino listings dated in the report year. Only ranges with reported provenance, explicit CHF currency and annual period, and finite positive ordered bounds are included. Monthly amounts and missing currencies are not converted. The midpoint is (min+max)/2; salary bounds below CHF 20,000 or above CHF 300,000 are excluded. Overall median and mean use all eligible observations; the sector table requires at least ten observations per sector. Estimates and missing or ambiguous provenance are excluded. No annual change is calculated without comparable snapshots for two years. With no observations, the median is unavailable and salary values in the CSV remain empty.`,
    methodologySourcesLabel: 'Comparison with official statistical sources:',
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
    relatedCalloutBody: `Reported salaries by sector and location, sample sizes and methodological limitations. Aggregate dataset licensed under CC BY 4.0.`,
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
    unavailableLabel: `Not available`,
    yoyLabel: 'YoY change',
    medianLabel: 'Panel median',
    observationsLabel: 'Listings with salary',
  },
  de: {
    title: buildTitleWithBrand(`Grenzgänger-Lohnreport ${REPORT_YEAR} — nach Branche und Region`),
    description: `Tessiner Stellenanzeigen ${REPORT_YEAR}: deklarierte Löhne nach Branche und Ort, Stichprobengrössen und Grenzen von Jahres- und Kaufkraftvergleichen.`,
    h1: `Grenzgänger-Report ${REPORT_YEAR}: Löhne, Branchen, Regionen`,
    kicker: 'Originalstudie · aggregiert aus dem Frontaliere-Ticino-Panel',
    updatedLabel: 'Aktualisiert',
    introP: `Dieser Bericht beschreibt die verfügbare Stichprobe der ${REPORT_YEAR} veröffentlichten Tessiner Stellenanzeigen, nicht sämtliche Löhne der Grenzgänger. Die zulässigen Lohnbeobachtungen werden in der Kennzahl und im CSV gezählt: nur ausdrücklich jährliche CHF-Beträge mit deklarierter Herkunft. Tabellen zeigen die vertretenen Branchen und Orte; fehlende Daten werden nicht durch Schätzungen ersetzt. Ohne zwei vergleichbare Jahresstichproben ist keine Jahresveränderung verfügbar.`,
    findingsH2: 'Kernergebnisse',
    findingsP: `So ist die Stichprobe zu lesen:`,
    findingsBullet1: (agg: AnnualAggregate) => `Median der Mittelpunkte deklarierter Jahreslohnspannen: ${formatCHF(agg.overallMedian)}. Zulässige Beobachtungen: ${formatNumber(agg.salaryCoverageCount)}. Dies misst weder tatsächlich ausbezahlte Löhne noch repräsentiert es alle Grenzgänger.`,
    findingsBullet2: `Unterschiede zwischen Orten spiegeln auch die vertretenen Berufe und Arbeitgeber wider. Vergleichen Sie zuerst die Gruppengrössen; eine kleine Gruppe belegt keinen geografischen Lohnvorteil.`,
    findingsBullet3: `Das Panel enthält keine nach Funktion, Erfahrung und Arbeitszeit vergleichbare italienische Stichprobe. Es erlaubt daher keine Quantifizierung des Lohnvorteils Italien–Schweiz oder seiner Entwicklung.`,
    sectorH2: 'Medianlohn nach Branche — Top 10',
    sectorP:
      'Die Tabelle zeigt den Medianlohn (nicht den Durchschnitt: weniger empfindlich gegenüber Ausreissern) für die zehn Branchen mit den meisten Beobachtungen in unserem Panel. Enthalten sind nur Branchen mit mindestens zehn Anzeigen mit ausgewiesenem Lohnband. Sortierung: absteigende Stellenzahl.',
    regionH2: 'Regionale Aufschlüsselung — Tessin',
    regionP: `Tessiner Anzeigen werden nach ihrem angegebenen Ort gruppiert: Lugano, Chiasso, Mendrisio, Bellinzona, Locarno und weitere Tessiner Orte. Die Tabelle beschreibt verfügbare Beobachtungen, nicht die Abdeckung des kantonalen Arbeitsmarkts. Orte ohne zulässige Beobachtungen haben keinen publizierbaren Median.`,
    pppH2: 'Kaufkraft: Italien vs. Schweiz',
    pppP: `Kaufkraftparitäten vergleichen Güter und Dienstleistungen zwischen Ländern; Wechselkurse rechnen Währungen um. Es sind unterschiedliche Grössen. Dieses Stellenpanel enthält weder vergleichbare Preise noch eine dokumentierte Kaufkraftreihe. Deshalb wird kein Kaufkraft-Umrechnungsfaktor veröffentlicht.`,
    pppBullet1: (agg: AnnualAggregate) => `Ausgangspunkt ist der jährliche Bruttolohn im Panel: Median ${formatCHF(agg.overallMedian)}. Für einen Vergleich mit einem italienischen Angebot müssen Funktion, Arbeitszeit, Erfahrung und Lohnbestandteile vergleichbar sein.`,
    pppBullet2: `Ein persönliches Budget unterscheidet Ausgaben im Wohn- und Arbeitsland: Wohnen, Verkehr, Versicherungen und Dienstleistungen wirken unterschiedlich. Der Bericht schätzt kein gleichwertiges italienisches Einkommen.`,
    pppBullet3: `Der Nettolohn hängt von der individuellen Steuer- und Familiensituation sowie den anwendbaren Beiträgen ab. Nutzen Sie Rechner und Steuerleitfaden für ein ausdrückliches Szenario statt eines pauschalen Prozentsatzes auf den Bruttolohn.`,
    methodologyH2: 'Methodik',
    methodologyP: `Ausgewählt werden Tessiner Anzeigen mit Datum im Berichtsjahr. Zulässig sind nur Spannen mit Herkunft reported, ausdrücklicher CHF-Währung und Jahresperiode sowie endlichen, positiven und geordneten Grenzen. Monatsbeträge und fehlende Währungen werden nicht umgerechnet. Der Mittelpunkt ist (min+max)/2; Spannengrenzen unter CHF 20 000 oder über CHF 300 000 werden ausgeschlossen. Gesamtmedian und Durchschnitt verwenden alle zulässigen Beobachtungen; die Branchentabelle verlangt mindestens zehn je Branche. Schätzungen und fehlende oder unklare Herkunft sind ausgeschlossen. Ohne vergleichbare Stichproben aus zwei Jahren wird keine Jahresveränderung berechnet. Ohne Beobachtungen ist der Median nicht verfügbar; Lohnwerte im CSV bleiben leer.`,
    methodologySourcesLabel: 'Vergleich mit offiziellen Statistikquellen:',
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
    relatedCalloutBody: `Deklarierte Löhne nach Branche und Ort, Stichprobengrössen und methodische Grenzen. Aggregierter Datensatz unter CC BY 4.0.`,
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
    unavailableLabel: `Nicht verfügbar`,
    yoyLabel: 'YoY',
    medianLabel: 'Panel-Median',
    observationsLabel: 'Stellen mit Lohnband',
  },
  fr: {
    title: buildTitleWithBrand(`Rapport Frontaliers ${REPORT_YEAR} — par secteur et région`),
    description: `Annonces tessinoises ${REPORT_YEAR} : salaires déclarés par secteur et lieu, tailles des échantillons et limites des comparaisons annuelles et de pouvoir d’achat.`,
    h1: `Rapport Frontaliers ${REPORT_YEAR} : salaires, secteurs, régions`,
    kicker: 'Étude originale · agrégée depuis le panel Frontaliere Ticino',
    updatedLabel: 'Mis à jour',
    introP: `Ce rapport décrit les annonces tessinoises disponibles publiées en ${REPORT_YEAR}, et non tous les salaires perçus par les frontaliers. Les observations admissibles sont comptées dans la fiche et le CSV : seuls les montants annuels explicites en CHF de provenance déclarée sont retenus. Les tableaux décrivent les secteurs et lieux représentés ; une donnée absente n’est pas remplacée par une estimation. La variation annuelle est indisponible sans deux instantanés annuels comparables.`,
    findingsH2: 'Constats clés',
    findingsP: `Comment lire l’échantillon :`,
    findingsBullet1: (agg: AnnualAggregate) => `Médiane des milieux des fourchettes annuelles déclarées : ${formatCHF(agg.overallMedian)}. Observations admissibles : ${formatNumber(agg.salaryCoverageCount)}. Ce chiffre ne mesure pas les salaires effectivement versés et ne représente pas tous les frontaliers.`,
    findingsBullet2: `Les différences entre lieux reflètent aussi les métiers et employeurs présents dans les annonces. Comparez les effectifs avant les médianes ; un petit groupe ne démontre pas un avantage géographique.`,
    findingsBullet3: `Le panel ne contient pas d’échantillon italien comparable par rôle, ancienneté et horaire. Il ne permet donc pas de quantifier l’avantage salarial Italie–Suisse ou son évolution.`,
    sectorH2: 'Salaire médian par secteur — top 10',
    sectorP:
      'Le tableau montre le salaire médian (non la moyenne : moins sensible aux valeurs extrêmes) pour les dix secteurs avec le plus d\'observations dans notre panel. Seuls les secteurs avec au moins dix annonces à fourchette salariale déclarée sont inclus. Classement : nombre de postes, décroissant.',
    regionH2: 'Répartition régionale — Tessin',
    regionP: `Les annonces tessinoises sont regroupées par lieu déclaré : Lugano, Chiasso, Mendrisio, Bellinzone, Locarno et autres lieux tessinois. Le tableau décrit les observations disponibles, non la couverture du marché cantonal. Un lieu sans observation admissible n’a pas de médiane publiable.`,
    pppH2: 'Pouvoir d\'achat : Italie vs Suisse',
    pppP: `La parité de pouvoir d’achat compare les biens et services entre pays ; le taux de change convertit les devises. Ces mesures sont différentes. Le panel ne contient ni prix comparables ni série PPA documentée ; aucun coefficient de conversion du pouvoir d’achat n’est donc publié.`,
    pppBullet1: (agg: AnnualAggregate) => `Le point de départ disponible est le salaire brut annuel du panel : médiane ${formatCHF(agg.overallMedian)}. Une comparaison avec une offre italienne exige des rôles, horaires, anciennetés et composantes salariales équivalents.`,
    pppBullet2: `Le budget personnel distingue les dépenses dans le pays de résidence et dans le pays de travail : logement, transport, assurances et services ont des effets différents. Le rapport n’estime pas de revenu italien équivalent.`,
    pppBullet3: `Le revenu net dépend de la situation fiscale et familiale et des cotisations applicables. Utilisez le simulateur et le guide fiscal liés pour un scénario explicite plutôt qu’un pourcentage universel du salaire brut.`,
    methodologyH2: 'Méthodologie',
    methodologyP: `Le panel est filtré sur les annonces tessinoises datées de l’année du rapport. Seules les fourchettes de provenance reported, en CHF et à période annuelle explicites, avec bornes finies positives et ordonnées, sont retenues. Les montants mensuels et devises manquantes ne sont pas convertis. Le milieu est (min+max)/2 ; les bornes inférieures à CHF 20 000 ou supérieures à CHF 300 000 sont exclues. Médiane et moyenne globales utilisent toutes les observations admissibles ; le tableau sectoriel exige au moins dix observations par secteur. Les estimations et provenances absentes ou ambiguës sont exclues. Aucune variation annuelle n’est calculée sans deux instantanés comparables. Sans observation, la médiane est indisponible et les valeurs salariales du CSV restent vides.`,
    methodologySourcesLabel: 'Comparaison avec des sources statistiques officielles :',
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
    relatedCalloutBody: `Salaires déclarés par secteur et lieu, effectifs et limites méthodologiques. Jeu agrégé sous licence CC BY 4.0.`,
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
    unavailableLabel: `Non disponible`,
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
        `<th class="s-thd">${esc(x)}</th>`,
    )
    .join('');
  const body = rows
    .map((r) => {
      const tds = r
        .map(
          (c, idx) =>
            `<td class="s-tcl"${idx === 0 ? ' style="font-weight:600"' : ''}>${c}</td>`,
        )
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<div class="s-Itl8IE"><table class="s-wkGd-4"><thead><tr>${h}</tr></thead><tbody>${body}</tbody></table></div>`;
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
    <section class="s-oLqKsI">
      <div class="s-tbase">
        <div class="s-tlbl">${esc(copy.medianLabel)}</div>
        <div class="s-tval">${esc(formatCHF(agg.overallMedian))}</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">${esc(copy.observationsLabel)}</div>
        <div class="s-tval">${formatNumber(agg.salaryCoverageCount)}</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">${esc(copy.yoyLabel)}</div>
        <div class="s-tval">${esc(copy.unavailableLabel)}</div>
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
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbReport, item: canonicalUrl },
    ],
  });

  // One description of the hero, used three times: the <img>, `Article.image`
  // and `og:image`, all deriving their URL from this single triple.
  const hero: SeoHeroImageOpts = {
    family: 'annual-report', key: 'report', locale, headline: copy.h1, eyebrow: copy.kicker, alt: copy.h1,
  };

  // generatedAt records report generation, not publication or a panel change.
  // Optional publication dates stay absent until an editorial history exists.
  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: guardArticleJsonLdDescription(copy.description),
    image: seoHeroImageObject(hero),
    inLanguage: locale,
    url: canonicalUrl,
    author: { '@type': 'Organization', '@id': `${BASE_URL}/#organization`, name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
    publisher: {
      '@type': 'Organization',
      '@id': `${BASE_URL}/#organization`,
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
      logo: imageObjectLd({
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  });

  const datasetLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: copy.h1,
    description: copy.description,
    url: canonicalUrl,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: { '@type': 'Organization', '@id': `${BASE_URL}/#organization`, name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
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
      ...(agg.salaryCoverageCount ? [{ '@type': 'PropertyValue', name: copy.medianLabel, unitCode: 'CHF', value: agg.overallMedian }] : []),
      ...(agg.salaryCoverageCount !== null ? [{ '@type': 'PropertyValue', name: copy.observationsLabel, value: agg.salaryCoverageCount }] : []),
    ],
    distribution: {
      '@type': 'DataDownload',
      encodingFormat: 'text/csv',
      contentUrl: `${BASE_URL}/data/jobs-salary-aggregate.csv`,
    },
  });

  // Body.
  const body = `
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <span>${esc(copy.breadcrumbReport)}</span>
    </nav>
    <header class="s-sy52lX">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.kicker)} · ${esc(copy.updatedLabel)} ${esc(agg.generatedAt)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.introP)}</p>
    </header>
    ${renderSeoHeroImage(hero)}
    ${statCards}
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.findingsH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.findingsP)}</p>
      <ol class="s-hSOSUV">
        <li class="s-U2-lJ-">${esc(copy.findingsBullet1(agg))}</li>
        <li class="s-U2-lJ-">${esc(copy.findingsBullet2)}</li>
        <li class="s-q3nqK4">${esc(copy.findingsBullet3)}</li>
      </ol>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.sectorH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.sectorP)}</p>
      ${sectorTable}
      <p class="s-XLkmUf">[infographic placeholder — alt=${esc(copy.infographicAlt)}]</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.regionH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.regionP)}</p>
      ${regionTable}
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.pppH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.pppP)}</p>
      <ul class="s-hSOSUV">
        <li class="s-U2-lJ-">${esc(copy.pppBullet1(agg))}</li>
        <li class="s-U2-lJ-">${esc(copy.pppBullet2)}</li>
        <li class="s-q3nqK4">${esc(copy.pppBullet3)}</li>
      </ul>
    </section>
    <section class="s-AV5A4S">
      <h2 style="${H2_STYLE}">${esc(copy.downloadH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.downloadP)}</p>
      <a href="/data/jobs-salary-aggregate.csv" download class="s-cta">${esc(copy.downloadCsvLabel)}</a>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.shareH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.shareP)}</p>
      <h3 class="s-FoC0jz">${esc(copy.citationH3)}</h3>
      <p class="s-pz9soM">${esc(copy.citationText)}</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.methodologyH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.methodologyP)}</p>
      <p style="${BODY_STYLE}">${esc(copy.methodologySourcesLabel)} <a href="https://www.bfs.admin.ch/" rel="nofollow noopener" target="_blank" style="${LINK_ACCENT_STYLE}">BFS/UST</a> · <a href="https://www.istat.it/" rel="nofollow noopener" target="_blank" style="${LINK_ACCENT_STYLE}">ISTAT</a></p>
    </section>
    <section class="s-ixDYj7">
      <h2 style="${H2_STYLE}">${esc(copy.relatedH2)}</h2>
      <ul class="s-zayQ-B">
        <li><a href="${esc(related.report)}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinkReport)}</a></li>
        <li><a href="${esc(related.fiscal)}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinkFiscal)}</a></li>
        <li><a href="${esc(related.jobs)}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinkJobs)}</a></li>
      </ul>
    </section>
  `;

  const wordCount = countHtmlBodyWords(body);
  const heroImageUrl = seoHeroImageUrl(hero);
  // buildSeoPageHtml emits the canonical outer <main class="seo-static-content">
  // wrapper. Keep the report body a div so every report has one main landmark.
  const bodyHtml = `<div class="s-xzWvwM">${body}${endOfContentMultiplexHtml({ indexable: wordCount >= MIN_INDEXABLE_WORDS })}</div>`;

  const html = buildSeoPageHtml({
    locale,
    title: copy.title,
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    ogImage: heroImageUrl,
    ogImageWidth: SEO_HERO_WIDTH,
    ogImageHeight: SEO_HERO_HEIGHT,
    ogImageType: 'image/webp',
    ogImageAlt: copy.h1,
    extraHeadHtml: `<link rel="preload" as="image" href="${heroImageUrl}" type="image/webp" fetchpriority="high">`,
    hreflangHtml: buildHreflang(),
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
<aside class="s-PvJP35" aria-labelledby="annualReportCallout">
  <h2 class="s-8pnpWY" id="annualReportCallout">${esc(copy.relatedCalloutTitle)}</h2>
  <p class="s-Qeytrn">${esc(copy.relatedCalloutBody)}</p>
  <a href="${esc(reportUrl)}" class="s-cta">${esc(copy.relatedCalloutCta)}</a>
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

      const jobs = loadReportJobPanel(rootDir, REPORT_YEAR);
      if (!jobs?.length) {
        console.warn('\x1b[33m[annual-report]\x1b[0m data/jobs.json missing or empty — salary observations unavailable');
      }
      const agg = aggregate(jobs);

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
          `  <url>\n    <loc>${BASE_URL}${render.urlPath}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`,
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
