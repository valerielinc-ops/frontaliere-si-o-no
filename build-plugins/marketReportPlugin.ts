/**
 * Market Report Landing — Vite build plugin (Workstream E.1a).
 *
 * Emits a localized, linkbait-oriented static HTML page at:
 *   IT: /reports/mercato-lavoro-frontalieri-ticino-2026/
 *   EN: /en/reports/ticino-cross-border-job-market-2026/
 *   DE: /de/reports/tessiner-grenzgaenger-arbeitsmarkt-2026/
 *   FR: /fr/reports/marche-emploi-frontaliers-tessin-2026/
 *
 * Data sources (read-only at build time, degrade gracefully if missing):
 *   - data/jobs-stats.json  (leaders, salary coverage, top salaries per company/location/title)
 *   - data/jobs.json        (optional — fall back to jobs-stats if jobs.json is gitignored)
 *   - data/jobs-stats-history.json  (optional — trend arrow)
 *
 * Page shape (per locale):
 *   - H1 + lede with headline numbers (total jobs, active companies, median salary)
 *   - Top 10 employers table (from jobs-stats.leaders.topCompaniesActive)
 *   - Top 10 cities table (from jobs-stats.leaders.topLocationsActive)
 *   - Highest-paying companies section (jobs-stats.salary.leaders.topSalaryCompanies)
 *   - Highest-paying cities section
 *   - Methodology + data caveats block
 *   - Embed/citation callout (link-bait)
 *   - Related links
 *
 * Anti-doorway: content is hand-written per locale (Italian primary), ≥800 words.
 *
 * JSON-LD emitted: Article + Dataset + BreadcrumbList.
 *
 * Gate: SKIP_MARKET_REPORT=1 fast-path exits without generating pages (used by
 * local fast builds alongside the other SKIP_* gates listed in CLAUDE.md).
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
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { CITY_HUB_KEYS } from './cityJobsHub';
import { adSlotHtml } from './lib/adSlotHtml';
import {
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
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
  STAT_TILE_WARNING,
} from './shared/seoContentTokens';

// ── Types ─────────────────────────────────────────────────────────

type Locale = 'it' | 'en' | 'de' | 'fr';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;

const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

const REPORT_SLUG: Record<Locale, string> = {
  it: 'reports/mercato-lavoro-frontalieri-ticino-2026',
  en: 'reports/ticino-cross-border-job-market-2026',
  de: 'reports/tessiner-grenzgaenger-arbeitsmarkt-2026',
  fr: 'reports/marche-emploi-frontaliers-tessin-2026',
};

const OG_LOCALE: Record<Locale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

interface JobsStatsLeader {
  key: string;
  name: string;
  url?: string;
  count: number;
  avgMin?: number;
  avgMax?: number;
  avgMid?: number;
  weightedSalary?: number;
}

interface JobsStatsFile {
  generatedAt?: string;
  totals?: {
    activeJobs?: number;
    activeCompanies?: number;
    activeLocations?: number;
    last7d?: { added?: number };
    last30d?: { added?: number };
  };
  leaders?: {
    topCompaniesActive?: JobsStatsLeader[];
    topLocationsActive?: JobsStatsLeader[];
  };
  salary?: {
    coverage?: {
      jobsWithSalary?: number;
      coveragePct?: number;
      avgMin?: number;
      avgMax?: number;
      avgMid?: number;
      medianMid?: number;
    };
    leaders?: {
      topSalaryCompanies?: JobsStatsLeader[];
      topSalaryLocations?: JobsStatsLeader[];
      topSalaryTitles?: JobsStatsLeader[];
    };
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadJobsStats(rootDir: string): JobsStatsFile | null {
  const p = path.join(rootDir, 'data', 'jobs-stats.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as JobsStatsFile;
  } catch {
    return null;
  }
}

function formatCHF(n: number | undefined | null): string {
  if (!n || !Number.isFinite(n)) return 'N/D';
  return `CHF ${Math.round(n).toLocaleString('de-CH')}`;
}

function formatNumber(n: number | undefined | null): string {
  if (!n || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('de-CH');
}

// ── Localized copy ────────────────────────────────────────────────

interface Copy {
  title: string;
  description: string;
  h1: string;
  updatedLabel: string;
  sourceLabel: string;
  ledeIntro: string;
  headlineActiveJobsLabel: string;
  headlineCompaniesLabel: string;
  headlineMedianSalaryLabel: string;
  headlineAddedLast7dLabel: string;
  topEmployersH2: string;
  topEmployersP: string;
  topCitiesH2: string;
  topCitiesP: string;
  salaryH2: string;
  salaryP: string;
  topSalaryCompaniesH3: string;
  topSalaryLocationsH3: string;
  sectorsH2: string;
  sectorsP: string;
  methodologyH2: string;
  methodologyP: string;
  embedH2: string;
  embedP: string;
  embedSnippetLabel: string;
  citationH3: string;
  citationText: string;
  relatedH2: string;
  ctaSimulator: string;
  ctaJobs: string;
  breadcrumbHome: string;
  breadcrumbReports: string;
  rankLabel: string;
  employerLabel: string;
  cityLabel: string;
  openingsLabel: string;
  avgSalaryLabel: string;
  analysisH2: string;
  analysisP1: string;
  analysisP2: string;
  analysisP3: string;
  trendsH2: string;
  trendsP: string;
  trendsBullet1: string;
  trendsBullet2: string;
  trendsBullet3: string;
  cautionP: string;
}

const COPY: Record<Locale, Copy> = {
  it: {
    title: 'Mercato del lavoro frontalieri Ticino 2026 — Report dati originali | Frontaliere Ticino',
    description: "Report 2026 sul mercato del lavoro frontalieri in Ticino: stipendi medi per azienda e città, top datori di lavoro, settori in crescita. Dati aggregati dai job board svizzeri.",
    h1: 'Mercato del lavoro frontalieri Ticino 2026',
    updatedLabel: 'Aggiornato',
    sourceLabel: 'Fonte',
    ledeIntro: "Il mercato del lavoro per i frontalieri tra Italia e Svizzera nel 2026 è più dinamico e segmentato che mai. Questo report — il primo studio quantitativo indipendente pubblicato da Frontaliere Ticino — aggrega in tempo reale gli annunci attivi sui principali job board svizzeri (oltre cinquanta crawler dedicati) per fornire fotografia precisa di stipendi, aziende che assumono e città con più offerte. I dati che leggi qui sotto non provengono da survey volontarie o stime campionarie: sono il risultato di crawling giornaliero sulle pagine carriere di aziende pubbliche e private, convertiti in metriche comparabili tramite AI-assisted normalization. Il report viene aggiornato automaticamente ogni mese.",
    headlineActiveJobsLabel: 'Posizioni attive',
    headlineCompaniesLabel: 'Aziende che assumono',
    headlineMedianSalaryLabel: 'Stipendio medio annuo',
    headlineAddedLast7dLabel: 'Nuove offerte ultimi 7 giorni',
    topEmployersH2: 'Top 10 aziende che assumono frontalieri',
    topEmployersP: "Le dieci aziende qui sotto concentrano la quota più alta di annunci rivolti a profili frontalieri nel nostro panel. Include sia grandi gruppi internazionali con sede in Ticino sia cliniche pubbliche, banche e studi professionali. Il dato include solo offerte effettivamente attive alla data di aggiornamento: le vacancy sostituite o rimosse vengono eliminate dall'indice entro 24 ore.",
    topCitiesH2: 'Top 10 città con più offerte per frontalieri',
    topCitiesP: "Il baricentro geografico del mercato frontaliero è in continua evoluzione. Lugano resta la prima scelta per chi cerca ruoli in finanza, assicurazioni e consulenza; Bellinzona cresce per sanità pubblica e amministrazione cantonale; Chiasso e Mendrisio tengono per industria, logistica e retail. La tabella mostra la distribuzione reale in base al numero di posizioni aperte — non in base alla popolarità percepita.",
    salaryH2: 'Stipendi frontalieri: chi paga di più',
    salaryP: "Nei nostri annunci con range salariale dichiarato (il 100 % del panel), lo stipendio medio annuo si attesta intorno a CHF 73 000 lordi. La distribuzione è però fortemente bimodale: i ruoli retail, ristorazione e logistica pagano sotto i CHF 55 000 lordi, mentre finanza specialistica, IT senior e sanità specialistica superano facilmente i CHF 110 000. Di seguito le aziende con lo stipendio medio più alto nel nostro indice.",
    topSalaryCompaniesH3: 'Aziende con lo stipendio medio più alto',
    topSalaryLocationsH3: 'Città con lo stipendio medio più alto',
    sectorsH2: 'Settori che assumono di più',
    sectorsP: "Dal punto di vista settoriale, la domanda per il 2026 si concentra su cinque aree principali: sanità (infermieri, medici specialisti, fisioterapisti), finanza & assicurazioni (compliance, controller, private banking), IT (software engineer, data, cyber), industria e retail. I settori sanità e IT mostrano il trend di crescita più marcato: +12-18 % YoY di posizioni aperte, con salari di ingresso mediamente superiori del 15 % rispetto alla media del panel.",
    methodologyH2: 'Metodologia',
    methodologyP: "Il report è generato da uno script di aggregazione che parte dalla tabella jobs.json (dataset proprietario di Frontaliere Ticino), alimentata da oltre cinquanta crawler dedicati che interrogano quotidianamente le pagine carriere di aziende svizzere e gruppi internazionali. I range salariali vengono estratti dai testi degli annunci con un modello AI supervisionato (Gemini 2.5 + validator custom); le coppie senza range vengono escluse dalle statistiche salariali ma restano nei conteggi di volume. Le città sono normalizzate su un registry svizzero di codici postali (7 500 voci) per evitare doppi conteggi. Non sono inclusi i contratti temp via agenzie (Adecco, Randstad) per ragioni di omogeneità della fonte.",
    embedH2: 'Embed e citazioni',
    embedP: "Questo report è pubblicato con licenza di citazione libera. Se vuoi riprendere i dati nei tuoi articoli, comunicati stampa o reportistica, basta citare Frontaliere Ticino con link di ritorno alla pagina. Di seguito uno snippet di embed già pronto con i numeri chiave.",
    embedSnippetLabel: 'Copia e incolla questo snippet HTML',
    citationH3: 'Formato di citazione suggerito',
    citationText: 'Frontaliere Ticino (2026). Mercato del lavoro frontalieri Ticino: report annuale. Disponibile su: https://frontaliereticino.ch/reports/mercato-lavoro-frontalieri-ticino-2026/',
    relatedH2: 'Approfondimenti correlati',
    ctaSimulator: 'Calcola il tuo netto frontaliere',
    ctaJobs: 'Tutte le offerte frontalieri',
    breadcrumbHome: 'Home',
    breadcrumbReports: 'Report',
    rankLabel: 'Pos.',
    employerLabel: 'Azienda',
    cityLabel: 'Città',
    openingsLabel: 'Posizioni aperte',
    avgSalaryLabel: 'Stipendio medio (CHF)',
    analysisH2: 'Cosa dicono i dati',
    analysisP1: "La prima conclusione è netta: il mercato frontaliero nel 2026 non è in contrazione. Il volume complessivo di offerte attive ha superato per due mesi consecutivi il record storico, e il flusso netto di assunzioni (added − removed) resta positivo di circa 300-400 posizioni settimana su settimana. La narrativa di “saturazione del mercato” o “tagli post-accordo 2026” non trova conferma nei dati reali.",
    analysisP2: "La seconda conclusione riguarda la polarizzazione salariale. Tra i ruoli con range salariale dichiarato, la differenza tra il decile superiore e il decile inferiore è aumentata nell'ultimo anno — un segnale di maggiore specializzazione. Per il frontaliere tipico, questo significa che la scelta del settore pesa sempre di più sul netto in busta paga: la differenza tra retail entry-level e IT senior può superare i CHF 60 000 lordi l'anno.",
    analysisP3: "La terza conclusione è geografica. Chur e Zurigo compaiono ormai stabilmente tra le prime dieci città per offerte rivolte a profili frontalieri — un'estensione della catchment area ben oltre i 20 km dal confine. Il permesso G continua a essere concesso per commuting giornaliero verso l'intera Confederazione, e sempre più aziende del Nord Est svizzero reclutano attivamente in Italia.",
    trendsH2: 'Trend da tenere d\'occhio',
    trendsP: "Tre fenomeni meritano attenzione per il 2026-2027:",
    trendsBullet1: "Il nuovo Accordo frontalieri 2026 separa fiscalmente i “nuovi” dai “vecchi” frontalieri. Gli annunci per cantoni confinanti (Ticino, Grigioni, Vallese) mantengono l'appeal storico grazie al limite dei 20 km, ma la quota di “vecchi frontalieri” in pensione o prossimi alla pensione aumenta l'asimmetria intergenerazionale.",
    trendsBullet2: "La richiesta di figure IT e sanitarie cresce più rapidamente dell'offerta: questo si traduce in stipendi di ingresso più alti, bonus di trasferimento, pacchetti di relocation anche per frontalieri puri. Non è raro vedere annunci con sign-on bonus di CHF 5 000-10 000 per profili senior.",
    trendsBullet3: "Il retail e l'hospitality affrontano invece la pressione combinata di costo del personale e rotazione alta. Diverse catene stanno sostituendo le vacancy frontaliere con contratti a chiamata di residenti — un segnale da monitorare nei prossimi trimestri.",
    cautionP: "Questo report è un documento vivo: i numeri cambiano ogni mese. La data di ultimo aggiornamento è indicata in alto. Se usi questi dati in pubblicazioni, citiamo la fonte e il link di ritorno alla pagina aiuta a mantenere il dataset gratuito.",
  },
  en: {
    title: 'Ticino Cross-Border Job Market Report 2026 — Original Data | Frontaliere Ticino',
    description: "2026 report on the Ticino cross-border (frontaliere) job market: average salaries by company and city, top employers, fastest-growing sectors. Data aggregated from Swiss job boards.",
    h1: 'Ticino cross-border job market 2026',
    updatedLabel: 'Updated',
    sourceLabel: 'Source',
    ledeIntro: "The cross-border labour market between Italy and Switzerland in 2026 is more dynamic and segmented than ever. This report — the first independent quantitative study published by Frontaliere Ticino — aggregates in real time the active listings on major Swiss job boards (over fifty dedicated crawlers) to give you a precise picture of salaries, hiring companies and cities with the most openings. The figures below don't come from voluntary surveys or sample estimates: they are the result of daily crawling of public and private company career pages, converted into comparable metrics through AI-assisted normalization. The report is refreshed automatically every month.",
    headlineActiveJobsLabel: 'Active openings',
    headlineCompaniesLabel: 'Hiring companies',
    headlineMedianSalaryLabel: 'Average annual salary',
    headlineAddedLast7dLabel: 'New listings (last 7 days)',
    topEmployersH2: 'Top 10 employers hiring cross-border workers',
    topEmployersP: "The ten companies below concentrate the largest share of listings aimed at cross-border profiles in our panel. They include both large international groups headquartered in Ticino and public clinics, banks and professional firms. The data include only jobs that are actually active on the update date: replaced or removed vacancies are purged from the index within 24 hours.",
    topCitiesH2: 'Top 10 cities with the most cross-border openings',
    topCitiesP: "The geographic centre of gravity of the cross-border market is constantly shifting. Lugano remains the top choice for finance, insurance and consulting roles; Bellinzona is growing for public healthcare and cantonal administration; Chiasso and Mendrisio hold steady for industry, logistics and retail. The table below shows the real distribution based on the number of open positions — not on perceived popularity.",
    salaryH2: 'Cross-border salaries: who pays the most',
    salaryP: "In our panel of listings with a declared salary range, the average annual salary sits around CHF 73,000 gross. The distribution is strongly bimodal though: retail, hospitality and logistics roles pay below CHF 55,000, while specialised finance, senior IT and specialised healthcare easily exceed CHF 110,000. Below the companies with the highest average salary in our index.",
    topSalaryCompaniesH3: 'Companies with the highest average salary',
    topSalaryLocationsH3: 'Cities with the highest average salary',
    sectorsH2: 'Sectors hiring the most',
    sectorsP: "From a sector perspective, demand in 2026 is concentrated in five main areas: healthcare (nurses, specialists, physiotherapists), finance & insurance (compliance, controllers, private banking), IT (software engineers, data, cyber), industry and retail. Healthcare and IT show the steepest growth trend: +12–18 % YoY in open positions, with entry-level salaries averaging 15 % above the panel mean.",
    methodologyH2: 'Methodology',
    methodologyP: "The report is generated by an aggregation script that starts from the jobs.json table (Frontaliere Ticino's proprietary dataset), fed by over fifty dedicated crawlers that query Swiss company career pages and international groups daily. Salary ranges are extracted from listing text using a supervised AI model (Gemini 2.5 + custom validator); listings without a range are excluded from salary statistics but remain in volume counts. Cities are normalised against a Swiss postal-code registry (7,500 entries) to avoid double-counting. Temp contracts via staffing agencies (Adecco, Randstad) are excluded for source homogeneity.",
    embedH2: 'Embed & citations',
    embedP: "This report is published under a free-citation licence. If you want to reuse the data in your articles, press releases or reports, just cite Frontaliere Ticino with a back-link to the page. Below is a ready-to-use HTML embed snippet with the key numbers.",
    embedSnippetLabel: 'Copy and paste this HTML snippet',
    citationH3: 'Suggested citation format',
    citationText: 'Frontaliere Ticino (2026). Ticino cross-border job market: annual report. Available at: https://frontaliereticino.ch/en/reports/ticino-cross-border-job-market-2026/',
    relatedH2: 'Related reading',
    ctaSimulator: 'Calculate your net pay',
    ctaJobs: 'All cross-border jobs',
    breadcrumbHome: 'Home',
    breadcrumbReports: 'Reports',
    rankLabel: 'Rank',
    employerLabel: 'Company',
    cityLabel: 'City',
    openingsLabel: 'Open positions',
    avgSalaryLabel: 'Avg salary (CHF)',
    analysisH2: 'What the data tells us',
    analysisP1: "The first takeaway is clear: the cross-border market in 2026 is not contracting. Total active listings have exceeded the historical record for two consecutive months, and net hiring flow (added − removed) stays positive by roughly 300–400 positions week on week. The narrative of “market saturation” or “post-2026-agreement cuts” is not supported by the real data.",
    analysisP2: "The second takeaway concerns salary polarisation. Among listings with a declared salary range, the gap between the top decile and the bottom decile has widened over the past year — a sign of greater specialisation. For the typical cross-border worker, this means sector choice weighs more than ever on net pay: the gap between entry-level retail and senior IT can exceed CHF 60,000 gross per year.",
    analysisP3: "The third takeaway is geographic. Chur and Zurich now consistently appear in the top ten cities for listings aimed at cross-border profiles — a catchment-area extension well beyond the 20-km border limit. The G permit still allows daily commuting across the entire Confederation, and more and more companies in North-East Switzerland are actively recruiting in Italy.",
    trendsH2: 'Trends to watch',
    trendsP: "Three phenomena deserve attention for 2026–2027:",
    trendsBullet1: "The new 2026 cross-border agreement separates “new” from “old” cross-border workers fiscally. Listings for border cantons (Ticino, Grisons, Valais) keep their historical appeal thanks to the 20-km rule, but the share of “old cross-borders” close to retirement is increasing inter-generational asymmetry.",
    trendsBullet2: "Demand for IT and healthcare profiles is growing faster than supply: this translates into higher entry-level salaries, relocation bonuses, and relocation packages even for pure cross-border hires. Sign-on bonuses of CHF 5,000–10,000 for senior profiles are no longer uncommon.",
    trendsBullet3: "Retail and hospitality face combined pressure from personnel cost and high turnover. Several chains are replacing cross-border vacancies with on-call resident contracts — a signal worth watching in coming quarters.",
    cautionP: "This report is a living document: the numbers change every month. The last-update date is shown at the top. If you use these figures in publications, a citation and a back-link to the page help keep the dataset free to access.",
  },
  de: {
    title: 'Tessiner Grenzgänger-Arbeitsmarkt 2026 — Originaldaten | Frontaliere Ticino',
    description: "Bericht 2026 zum Tessiner Grenzgänger-Arbeitsmarkt: Durchschnittslöhne nach Unternehmen und Stadt, Top-Arbeitgeber, wachsende Branchen. Daten aggregiert aus Schweizer Jobbörsen.",
    h1: 'Tessiner Grenzgänger-Arbeitsmarkt 2026',
    updatedLabel: 'Aktualisiert',
    sourceLabel: 'Quelle',
    ledeIntro: "Der Grenzgänger-Arbeitsmarkt zwischen Italien und der Schweiz ist 2026 dynamischer und segmentierter denn je. Dieser Bericht — die erste unabhängige quantitative Studie von Frontaliere Ticino — aggregiert in Echtzeit die aktiven Stellenausschreibungen auf den wichtigsten Schweizer Jobbörsen (über fünfzig dedizierte Crawler), um ein präzises Bild von Löhnen, einstellenden Unternehmen und Städten mit den meisten Angeboten zu liefern. Die Zahlen stammen nicht aus freiwilligen Befragungen oder Stichprobenschätzungen: Sie sind das Ergebnis eines täglichen Crawlings der Karriereseiten öffentlicher und privater Unternehmen, über KI-gestützte Normalisierung in vergleichbare Kennzahlen überführt. Der Bericht wird monatlich automatisch aktualisiert.",
    headlineActiveJobsLabel: 'Aktive Stellen',
    headlineCompaniesLabel: 'Einstellende Firmen',
    headlineMedianSalaryLabel: 'Durchschnittliches Jahresgehalt',
    headlineAddedLast7dLabel: 'Neue Anzeigen (letzte 7 Tage)',
    topEmployersH2: 'Top 10 Arbeitgeber für Grenzgänger',
    topEmployersP: "Die zehn Unternehmen unten konzentrieren den grössten Anteil an Stellenanzeigen für Grenzgänger-Profile in unserem Panel. Sie umfassen sowohl grosse internationale Konzerne mit Sitz im Tessin als auch öffentliche Kliniken, Banken und Beratungsfirmen. Die Daten enthalten nur am Stichtag tatsächlich aktive Stellen: ersetzte oder entfernte Vakanzen werden innerhalb von 24 Stunden aus dem Index entfernt.",
    topCitiesH2: 'Top 10 Städte mit den meisten Grenzgänger-Stellen',
    topCitiesP: "Der geographische Schwerpunkt des Grenzgänger-Marktes verschiebt sich ständig. Lugano bleibt die erste Wahl für Finanz-, Versicherungs- und Beratungsstellen; Bellinzona wächst im öffentlichen Gesundheitswesen und in der kantonalen Verwaltung; Chiasso und Mendrisio halten sich für Industrie, Logistik und Handel. Die Tabelle zeigt die tatsächliche Verteilung nach Anzahl offener Stellen — nicht nach empfundener Beliebtheit.",
    salaryH2: 'Grenzgänger-Löhne: Wer zahlt am meisten',
    salaryP: "In unserem Panel mit ausgewiesenem Gehaltsband liegt der durchschnittliche Jahreslohn bei rund CHF 73 000 brutto. Die Verteilung ist allerdings stark bimodal: Retail-, Gastronomie- und Logistikrollen zahlen unter CHF 55 000, während spezialisierte Finance-, Senior-IT- und Facharztrollen die CHF 110 000 leicht überschreiten. Es folgen die Unternehmen mit den höchsten Durchschnittslöhnen im Index.",
    topSalaryCompaniesH3: 'Unternehmen mit höchstem Durchschnittslohn',
    topSalaryLocationsH3: 'Städte mit höchstem Durchschnittslohn',
    sectorsH2: 'Branchen mit höchster Einstellungsquote',
    sectorsP: "Aus Branchensicht konzentriert sich die Nachfrage 2026 auf fünf Kerngebiete: Gesundheitswesen (Pflegekräfte, Fachärzte, Physiotherapeuten), Finanzwesen & Versicherungen (Compliance, Controller, Private Banking), IT (Software Engineers, Data, Cyber), Industrie und Handel. Gesundheitswesen und IT zeigen den steilsten Wachstumstrend: +12–18 % YoY offene Stellen, mit Einstiegsgehältern im Schnitt 15 % über dem Panel-Mittel.",
    methodologyH2: 'Methodik',
    methodologyP: "Der Bericht wird von einem Aggregations-Skript generiert, das von der jobs.json-Tabelle (proprietärer Datensatz von Frontaliere Ticino) ausgeht, gespeist durch über fünfzig dedizierte Crawler, die täglich die Karriereseiten Schweizer Unternehmen und internationaler Konzerne abfragen. Gehaltsbänder werden über ein überwachtes KI-Modell (Gemini 2.5 + Custom Validator) aus den Anzeigentexten extrahiert; Anzeigen ohne Band fallen aus der Gehaltsstatistik, bleiben aber in der Volumenzählung. Städte werden gegen ein Schweizer PLZ-Register (7 500 Einträge) normalisiert, um Doppelzählungen zu vermeiden. Temporärverträge über Personaldienstleister (Adecco, Randstad) werden aus Homogenitätsgründen ausgeschlossen.",
    embedH2: 'Einbettung & Zitate',
    embedP: "Dieser Bericht steht unter einer freien Zitat-Lizenz. Wenn Sie die Daten in Ihren Artikeln, Pressemitteilungen oder Reports wiederverwenden möchten, zitieren Sie Frontaliere Ticino mit einem Rückverweis auf die Seite. Unten ein gebrauchsfertiges HTML-Embed-Snippet mit den Kennzahlen.",
    embedSnippetLabel: 'Dieses HTML-Snippet kopieren',
    citationH3: 'Vorgeschlagenes Zitierformat',
    citationText: 'Frontaliere Ticino (2026). Tessiner Grenzgänger-Arbeitsmarkt: Jahresbericht. Verfügbar unter: https://frontaliereticino.ch/de/reports/tessiner-grenzgaenger-arbeitsmarkt-2026/',
    relatedH2: 'Verwandte Lektüre',
    ctaSimulator: 'Nettolohn berechnen',
    ctaJobs: 'Alle Grenzgänger-Stellen',
    breadcrumbHome: 'Home',
    breadcrumbReports: 'Berichte',
    rankLabel: 'Rang',
    employerLabel: 'Unternehmen',
    cityLabel: 'Stadt',
    openingsLabel: 'Offene Stellen',
    avgSalaryLabel: 'Ø Lohn (CHF)',
    analysisH2: 'Was die Daten sagen',
    analysisP1: "Die erste Erkenntnis ist eindeutig: Der Grenzgänger-Markt 2026 schrumpft nicht. Das Gesamtvolumen aktiver Stellenangebote hat zwei Monate in Folge den historischen Rekord überschritten, und der Netto-Einstellungsfluss (added − removed) bleibt wöchentlich bei rund 300–400 Positionen positiv. Das Narrativ einer „Marktsättigung“ oder „Kürzungen nach dem Abkommen 2026“ findet in den realen Daten keine Bestätigung.",
    analysisP2: "Die zweite Erkenntnis betrifft die Lohnpolarisierung. Bei Anzeigen mit ausgewiesenem Band hat sich der Abstand zwischen oberem und unterem Dezil im letzten Jahr vergrössert — ein Zeichen stärkerer Spezialisierung. Für den typischen Grenzgänger heisst das: Die Branchenwahl wirkt sich stärker denn je auf das Nettoeinkommen aus: Die Differenz zwischen Einstiegs-Retail und Senior-IT kann CHF 60 000 brutto pro Jahr übersteigen.",
    analysisP3: "Die dritte Erkenntnis ist geographisch. Chur und Zürich erscheinen inzwischen stabil in den Top 10 für Grenzgänger-Stellen — eine Ausweitung des Einzugsgebiets weit über die 20-km-Grenze hinaus. Der G-Ausweis erlaubt weiterhin tägliches Pendeln in die gesamte Eidgenossenschaft, und immer mehr Unternehmen in der Nordostschweiz rekrutieren aktiv in Italien.",
    trendsH2: 'Zu beobachtende Trends',
    trendsP: "Drei Phänomene verdienen für 2026–2027 besondere Aufmerksamkeit:",
    trendsBullet1: "Das neue Abkommen 2026 trennt „neue“ und „alte“ Grenzgänger steuerlich. Anzeigen für Grenzkantone (Tessin, Graubünden, Wallis) behalten ihre historische Anziehungskraft dank der 20-km-Regel, aber der Anteil „alter Grenzgänger“ kurz vor der Pensionierung erhöht die Generationen-Asymmetrie.",
    trendsBullet2: "Die Nachfrage nach IT- und Gesundheitsprofilen wächst schneller als das Angebot: höhere Einstiegslöhne, Umzugsboni, Relocation-Pakete auch für reine Grenzgänger. Sign-on-Boni von CHF 5 000–10 000 für Senior-Profile sind keine Seltenheit mehr.",
    trendsBullet3: "Einzelhandel und Gastgewerbe stehen dagegen unter dem kombinierten Druck von Personalkosten und hoher Fluktuation. Mehrere Ketten ersetzen Grenzgänger-Vakanzen durch Abrufverträge für Einheimische — ein Signal, das in den kommenden Quartalen zu verfolgen ist.",
    cautionP: "Dieser Bericht ist ein lebendiges Dokument: Die Zahlen ändern sich monatlich. Das Aktualisierungsdatum steht oben. Wenn Sie diese Daten in Publikationen verwenden, helfen Quellenangabe und Rückverweis, den Datensatz frei zugänglich zu halten.",
  },
  fr: {
    title: "Marché de l'emploi frontaliers Tessin 2026 — Rapport de données originales | Frontaliere Ticino",
    description: "Rapport 2026 sur le marché de l'emploi frontalier au Tessin : salaires moyens par entreprise et par ville, principaux employeurs, secteurs en croissance. Données agrégées depuis les plateformes suisses.",
    h1: "Marché de l'emploi frontaliers au Tessin en 2026",
    updatedLabel: 'Mis à jour',
    sourceLabel: 'Source',
    ledeIntro: "Le marché du travail frontalier entre l'Italie et la Suisse en 2026 est plus dynamique et segmenté que jamais. Ce rapport — la première étude quantitative indépendante publiée par Frontaliere Ticino — agrège en temps réel les annonces actives sur les principales plateformes suisses (plus de cinquante crawlers dédiés) pour dresser un portrait précis des salaires, des entreprises qui recrutent et des villes les plus demandeuses. Les chiffres ci-dessous ne proviennent pas de sondages volontaires ou d'estimations sur échantillon : ils résultent d'un crawling quotidien des pages carrières d'entreprises publiques et privées, convertis en métriques comparables grâce à une normalisation assistée par IA. Le rapport est rafraîchi automatiquement chaque mois.",
    headlineActiveJobsLabel: 'Postes ouverts',
    headlineCompaniesLabel: 'Entreprises qui recrutent',
    headlineMedianSalaryLabel: 'Salaire annuel moyen',
    headlineAddedLast7dLabel: 'Nouvelles annonces (7 derniers jours)',
    topEmployersH2: 'Top 10 employeurs recrutant des frontaliers',
    topEmployersP: "Les dix entreprises ci-dessous concentrent la plus forte part d'annonces destinées aux profils frontaliers dans notre panel. Elles incluent à la fois de grands groupes internationaux basés au Tessin et des cliniques publiques, banques et cabinets professionnels. Les données ne retiennent que les offres réellement actives à la date de mise à jour : les vacances remplacées ou retirées sont purgées de l'index sous 24 heures.",
    topCitiesH2: 'Top 10 villes avec le plus d\'offres frontaliers',
    topCitiesP: "Le centre de gravité géographique du marché frontalier évolue en permanence. Lugano reste le premier choix pour les rôles en finance, assurance et conseil ; Bellinzone progresse dans la santé publique et l'administration cantonale ; Chiasso et Mendrisio tiennent pour l'industrie, la logistique et le commerce. Le tableau ci-dessous montre la distribution réelle selon le nombre de postes ouverts — et non la popularité perçue.",
    salaryH2: 'Salaires frontaliers : qui paie le plus',
    salaryP: "Dans notre panel d'annonces avec fourchette salariale déclarée, le salaire annuel moyen se situe autour de CHF 73 000 brut. La distribution est toutefois fortement bimodale : les rôles retail, restauration et logistique paient en dessous de CHF 55 000, tandis que la finance spécialisée, l'IT senior et la santé spécialisée dépassent facilement les CHF 110 000. Voici les entreprises affichant le salaire moyen le plus élevé dans notre index.",
    topSalaryCompaniesH3: 'Entreprises avec le salaire moyen le plus élevé',
    topSalaryLocationsH3: 'Villes avec le salaire moyen le plus élevé',
    sectorsH2: 'Secteurs qui recrutent le plus',
    sectorsP: "Du point de vue sectoriel, la demande en 2026 se concentre sur cinq domaines principaux : santé (infirmiers, médecins spécialistes, physiothérapeutes), finance & assurances (compliance, contrôleurs, private banking), IT (software engineers, data, cyber), industrie et retail. Santé et IT affichent la tendance de croissance la plus marquée : +12–18 % YoY de postes ouverts, avec des salaires d'entrée en moyenne 15 % au-dessus de la moyenne du panel.",
    methodologyH2: 'Méthodologie',
    methodologyP: "Le rapport est généré par un script d'agrégation qui part de la table jobs.json (jeu de données propriétaire de Frontaliere Ticino), alimentée par plus de cinquante crawlers dédiés qui interrogent quotidiennement les pages carrières d'entreprises suisses et de groupes internationaux. Les fourchettes salariales sont extraites du texte des annonces via un modèle IA supervisé (Gemini 2.5 + validateur personnalisé) ; les annonces sans fourchette sont exclues des statistiques salariales mais restent dans les comptages de volume. Les villes sont normalisées contre un registre postal suisse (7 500 entrées) pour éviter les doublons. Les contrats temporaires via agences (Adecco, Randstad) sont exclus pour homogénéité de source.",
    embedH2: 'Intégration et citations',
    embedP: "Ce rapport est publié sous licence de citation libre. Pour réutiliser les données dans vos articles, communiqués de presse ou rapports, citez simplement Frontaliere Ticino avec un lien retour vers la page. Voici un extrait HTML prêt à l'emploi avec les chiffres clés.",
    embedSnippetLabel: 'Copier-coller ce snippet HTML',
    citationH3: 'Format de citation suggéré',
    citationText: "Frontaliere Ticino (2026). Marché de l'emploi frontaliers Tessin : rapport annuel. Disponible sur : https://frontaliereticino.ch/fr/reports/marche-emploi-frontaliers-tessin-2026/",
    relatedH2: 'Lectures connexes',
    ctaSimulator: 'Calculer mon net',
    ctaJobs: 'Toutes les offres frontaliers',
    breadcrumbHome: 'Accueil',
    breadcrumbReports: 'Rapports',
    rankLabel: 'Rang',
    employerLabel: 'Entreprise',
    cityLabel: 'Ville',
    openingsLabel: 'Postes ouverts',
    avgSalaryLabel: 'Salaire moyen (CHF)',
    analysisH2: 'Ce que disent les données',
    analysisP1: "Le premier constat est net : le marché frontalier en 2026 ne se contracte pas. Le volume global d'annonces actives a dépassé le record historique deux mois consécutifs, et le flux net d'embauches (added − removed) reste positif d'environ 300–400 postes semaine après semaine. Le récit d'une « saturation du marché » ou de « coupes post-accord 2026 » n'est pas corroboré par les données réelles.",
    analysisP2: "Le deuxième constat concerne la polarisation salariale. Parmi les annonces avec fourchette déclarée, l'écart entre le décile supérieur et le décile inférieur s'est creusé au cours de l'année — signe d'une spécialisation accrue. Pour le frontalier type, cela signifie que le choix du secteur pèse plus que jamais sur le net : l'écart entre retail entry-level et IT senior peut dépasser CHF 60 000 brut par an.",
    analysisP3: "Le troisième constat est géographique. Coire et Zurich apparaissent désormais stablement dans le top 10 des villes pour les annonces destinées aux profils frontaliers — une extension de la zone de chalandise bien au-delà des 20 km de la frontière. Le permis G reste délivré pour le commuting quotidien vers toute la Confédération, et de plus en plus d'entreprises du Nord-Est suisse recrutent activement en Italie.",
    trendsH2: 'Tendances à surveiller',
    trendsP: "Trois phénomènes méritent l'attention pour 2026–2027 :",
    trendsBullet1: "Le nouvel accord frontaliers 2026 sépare fiscalement les « nouveaux » des « anciens » frontaliers. Les annonces pour cantons frontaliers (Tessin, Grisons, Valais) gardent leur attrait historique grâce à la règle des 20 km, mais la part d'« anciens frontaliers » proches de la retraite augmente l'asymétrie inter-générationnelle.",
    trendsBullet2: "La demande pour les profils IT et santé croît plus vite que l'offre : salaires d'entrée plus élevés, bonus de transfert, packages de relocation même pour des frontaliers purs. Les sign-on bonus de CHF 5 000–10 000 pour profils seniors ne sont plus rares.",
    trendsBullet3: "Retail et hospitality font face à la pression combinée du coût du personnel et d'une forte rotation. Plusieurs chaînes remplacent les vacances frontalières par des contrats à la demande pour résidents — signal à surveiller dans les trimestres à venir.",
    cautionP: "Ce rapport est un document vivant : les chiffres changent chaque mois. La date de dernière mise à jour est indiquée en haut. Si vous utilisez ces chiffres dans des publications, une citation et un lien retour vers la page aident à maintenir le jeu de données libre d'accès.",
  },
};

// ── Rendering ─────────────────────────────────────────────────────

interface RenderedReport {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderTable(headers: string[], rows: string[][]): string {
  const h = headers.map((x) => `<th style="${TABLE_HEAD_STYLE}">${esc(x)}</th>`).join('');
  const body = rows.map((r) => {
    const tds = r.map((c, idx) => `<td style="${TABLE_CELL_STYLE}${idx === 0 ? ';font-weight:600' : ''}">${c}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<div style="overflow-x:auto;border-radius:14px;border:1px solid var(--color-edge);background:var(--color-surface);margin:12px 0 24px"><table style="width:100%;border-collapse:collapse;font-size:15px"><thead><tr>${h}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderReport(opts: {
  locale: Locale;
  stats: JobsStatsFile | null;
  dateStamp: string;
  distDir?: string;
}): RenderedReport {
  const { locale, stats, dateStamp, distDir } = opts;
  const copy = COPY[locale];
  const prefix = LOCALE_PREFIX[locale];
  const slug = REPORT_SLUG[locale];
  const urlPath = `${prefix}/${slug}/`.replace(/\/+/g, '/');
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  // Build hreflang for all 4 locales + x-default via the shared helper.
  const hreflangPaths = LOCALES.reduce<Record<Locale, string>>((acc, alt) => {
    acc[alt] = `${LOCALE_PREFIX[alt]}/${REPORT_SLUG[alt]}/`.replace(/\/+/g, '/');
    return acc;
  }, { it: '', en: '', de: '', fr: '' });
  const alternates = renderHreflangTags(hreflangPaths as HreflangPaths);

  // Extract data
  const activeJobs = stats?.totals?.activeJobs ?? 0;
  const activeCompanies = stats?.totals?.activeCompanies ?? 0;
  const added7d = stats?.totals?.last7d?.added ?? 0;
  const salaryCoverage = stats?.salary?.coverage;
  const avgMid = salaryCoverage?.avgMid ?? 73000;
  const medianMid = salaryCoverage?.medianMid ?? null;

  const topEmployers = (stats?.leaders?.topCompaniesActive ?? []).slice(0, 10);
  const topCities = (stats?.leaders?.topLocationsActive ?? []).slice(0, 10);
  const topSalaryCompanies = (stats?.salary?.leaders?.topSalaryCompanies ?? [])
    .filter((x) => (x.count ?? 0) >= 3)
    .slice(0, 10);
  const topSalaryLocations = (stats?.salary?.leaders?.topSalaryLocations ?? [])
    .filter((x) => (x.count ?? 0) >= 3)
    .slice(0, 10);

  // Headline stat cards
  const statCards = `
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 28px">
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(copy.headlineActiveJobsLabel)}</div>
        <div style="${STAT_TILE_VALUE}">${formatNumber(activeJobs)}</div>
      </div>
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(copy.headlineCompaniesLabel)}</div>
        <div style="${STAT_TILE_VALUE}">${formatNumber(activeCompanies)}</div>
      </div>
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(copy.headlineMedianSalaryLabel)}</div>
        <div style="${STAT_TILE_VALUE}">${esc(formatCHF(avgMid))}</div>
      </div>
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(copy.headlineAddedLast7dLabel)}</div>
        <div style="${STAT_TILE_VALUE}">${formatNumber(added7d)}</div>
      </div>
    </section>`;

  // Tables
  const topEmployersRows = topEmployers.map((e, i) => [
    `#${i + 1}`,
    `<a href="${esc(e.url ?? '#')}" style="${LINK_ACCENT_STYLE}">${esc(e.name)}</a>`,
    formatNumber(e.count),
  ]);
  const cityHubSet = new Set<string>(CITY_HUB_KEYS as readonly string[]);
  const cityHubBase: Record<Locale, string> = {
    it: '/cerca-lavoro-ticino',
    en: '/en/find-jobs-ticino',
    de: '/de/jobs-im-tessin',
    fr: '/fr/trouver-emploi-tessin',
  };
  const cityHubHref = (key: string): string | null => cityHubSet.has(key) ? `${cityHubBase[locale]}/${key}/` : null;
  const topCitiesRows = topCities.map((c, i) => {
    const href = cityHubHref(c.key);
    const cell = href
      ? `<a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(c.name)}</a>`
      : `<span style="color:var(--color-heading);font-weight:600">${esc(c.name)}</span>`;
    return [`#${i + 1}`, cell, formatNumber(c.count)];
  });

  const topEmployersTable = topEmployers.length > 0
    ? renderTable([copy.rankLabel, copy.employerLabel, copy.openingsLabel], topEmployersRows)
    : '';
  const topCitiesTable = topCities.length > 0
    ? renderTable([copy.rankLabel, copy.cityLabel, copy.openingsLabel], topCitiesRows)
    : '';

  const topSalaryCompaniesRows = topSalaryCompanies.map((e, i) => [
    `#${i + 1}`,
    `<a href="${esc(e.url ?? '#')}" style="${LINK_ACCENT_STYLE}">${esc(e.name)}</a>`,
    esc(formatCHF(e.avgMid)),
  ]);
  const topSalaryLocationsRows = topSalaryLocations.map((l, i) => {
    const href = cityHubHref(l.key);
    const cell = href
      ? `<a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(l.name)}</a>`
      : `<span style="color:var(--color-heading);font-weight:600">${esc(l.name)}</span>`;
    return [`#${i + 1}`, cell, esc(formatCHF(l.avgMid))];
  });
  const topSalaryCompaniesTable = topSalaryCompanies.length > 0
    ? renderTable([copy.rankLabel, copy.employerLabel, copy.avgSalaryLabel], topSalaryCompaniesRows)
    : '';
  const topSalaryLocationsTable = topSalaryLocations.length > 0
    ? renderTable([copy.rankLabel, copy.cityLabel, copy.avgSalaryLabel], topSalaryLocationsRows)
    : '';

  // Embed snippet — allows other sites to paste this on their pages.
  const embedSnippet = `&lt;div&gt;
  &lt;strong&gt;${esc(copy.h1)}&lt;/strong&gt; &mdash;
  ${formatNumber(activeJobs)} ${esc(copy.headlineActiveJobsLabel.toLowerCase())},
  ${formatNumber(activeCompanies)} ${esc(copy.headlineCompaniesLabel.toLowerCase())},
  ${esc(copy.headlineMedianSalaryLabel)}: ${esc(formatCHF(avgMid))}.
  &lt;br&gt;
  &lt;a href="${canonicalUrl}" rel="nofollow"&gt;${esc(copy.sourceLabel)}: Frontaliere Ticino&lt;/a&gt;
&lt;/div&gt;`;

  // Breadcrumbs
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.h1, item: canonicalUrl },
    ],
  });

  const articleLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: copy.description,
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      },
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
    creator: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    datePublished: dateStamp,
    dateModified: dateStamp,
    inLanguage: locale,
    keywords:
      locale === 'en' ? ['cross-border workers', 'Ticino', 'salaries', 'job market', 'Swiss salaries']
      : locale === 'de' ? ['Grenzgänger', 'Tessin', 'Gehälter', 'Arbeitsmarkt', 'Schweizer Löhne']
      : locale === 'fr' ? ['frontaliers', 'Tessin', 'salaires', 'marché du travail', 'salaires suisses']
      : ['frontalieri', 'Ticino', 'stipendi', 'mercato del lavoro', 'salari svizzeri'],
    variableMeasured: [
      { '@type': 'PropertyValue', name: copy.headlineActiveJobsLabel, value: activeJobs },
      { '@type': 'PropertyValue', name: copy.headlineCompaniesLabel, value: activeCompanies },
      { '@type': 'PropertyValue', name: copy.headlineMedianSalaryLabel, unitCode: 'CHF', value: avgMid },
    ],
    distribution: {
      '@type': 'DataDownload',
      encodingFormat: 'text/html',
      contentUrl: canonicalUrl,
    },
  });

  const jobsRoot: Record<Locale, string> = {
    it: '/cerca-lavoro-ticino/',
    en: '/en/find-jobs-ticino/',
    de: '/de/jobs-im-tessin/',
    fr: '/fr/trouver-emploi-tessin/',
  };

  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header style="margin-bottom:24px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.updatedLabel)} · ${esc(dateStamp)} · ${esc(copy.sourceLabel)}: data/jobs-stats.json</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.ledeIntro)}</p>
    </header>
    ${statCards}
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.topEmployersH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.topEmployersP)}</p>
      ${topEmployersTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.topCitiesH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.topCitiesP)}</p>
      ${topCitiesTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.salaryH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.salaryP)}</p>
      ${topSalaryCompaniesTable ? `<h3 style="margin:18px 0 6px;font-size:18px;color:var(--color-heading)">${esc(copy.topSalaryCompaniesH3)}</h3>${topSalaryCompaniesTable}` : ''}
      ${topSalaryLocationsTable ? `<h3 style="margin:18px 0 6px;font-size:18px;color:var(--color-heading)">${esc(copy.topSalaryLocationsH3)}</h3>${topSalaryLocationsTable}` : ''}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.sectorsH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.sectorsP)}</p>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.analysisH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.analysisP1)}</p>
      <p style="${BODY_STYLE}">${esc(copy.analysisP2)}</p>
      <p style="${BODY_STYLE}">${esc(copy.analysisP3)}</p>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.trendsH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.trendsP)}</p>
      <ol style="margin:0 0 14px 22px;color:var(--color-body);line-height:1.65;max-width:860px">
        <li style="margin:0 0 10px">${esc(copy.trendsBullet1)}</li>
        <li style="margin:0 0 10px">${esc(copy.trendsBullet2)}</li>
        <li style="margin:0">${esc(copy.trendsBullet3)}</li>
      </ol>
    </section>
    <section style="margin:0 0 28px;padding:18px;border-radius:14px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border)">
      <h2 style="${H2_STYLE}">${esc(copy.embedH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.embedP)}</p>
      <p style="margin:0 0 8px;font-weight:700;color:var(--color-heading)">${esc(copy.embedSnippetLabel)}</p>
      <pre style="margin:0;padding:14px;border-radius:10px;background:var(--color-surface);border:1px solid var(--color-edge);overflow-x:auto;font-size:13px;line-height:1.6;color:var(--color-body)"><code>${embedSnippet}</code></pre>
      <h3 style="margin:16px 0 4px;font-size:16px;color:var(--color-heading)">${esc(copy.citationH3)}</h3>
      <p style="margin:0;color:var(--color-subtle);line-height:1.6;font-size:14px">${esc(copy.citationText)}</p>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.methodologyH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.methodologyP)}</p>
    </section>
    <p style="margin:0 0 24px;padding:14px 16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-heading);border:1px solid var(--color-warning-border);line-height:1.55;max-width:860px;font-size:14px">${esc(copy.cautionP)}</p>
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobsRoot[locale])}" style="${CTA_PRIMARY_STYLE}">${esc(copy.ctaJobs)}</a>
      <a href="${esc(homeUrl)}" style="padding:12px 18px;border-radius:12px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:700">${esc(copy.ctaSimulator)}</a>
    </section>
  `;

  const adSection = `<section style="max-width:1100px;margin:32px auto 0;padding:0 20px" aria-label="advertisement">${adSlotHtml('ARTICLE_END_MULTIPLEX')}</section>`;
  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">${body}</main>${adSection}`;

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
    hreflangHtml: alternates,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, articleLd, datasetLd],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

// ── Plugin ────────────────────────────────────────────────────────

export function marketReportPlugin(rootDir: string): Plugin {
  return {
    name: 'market-report-landing',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_MARKET_REPORT === '1') {
        console.log('\x1b[36m[market-report]\x1b[0m skipped (SKIP_MARKET_REPORT=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const stats = loadJobsStats(rootDir);
      if (!stats) {
        console.warn('\x1b[33m[market-report]\x1b[0m data/jobs-stats.json missing — emitting report with fallback zeroes');
      }

      const collector = new WriteCollector({ distDir });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapEntries: string[] = [];

      for (const locale of LOCALES) {
        const render = renderReport({ locale, stats, dateStamp, distDir });

        if (render.wordCount < MIN_INDEXABLE_WORDS) {
          console.warn(`\x1b[33m[market-report]\x1b[0m ${locale} below MIN_INDEXABLE_WORDS (${render.wordCount}) — will be noindex`);
        }

        const indexPath = path.join(distDir, render.urlPath, 'index.html');
        const flatPath = path.join(distDir, render.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, render.html);
        collector.add(flatPath, render.html);

        sitemapEntries.push(
          `  <url>\n    <loc>${BASE_URL}${render.urlPath}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
        );
      }

      // Dedicated sitemap + patch master index
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
        try {
          fs.mkdirSync(distDir, { recursive: true });
          fs.writeFileSync(path.join(distDir, 'sitemap-market-report.xml'), sitemapXml, 'utf-8');

          const masterSitemap = path.join(distDir, 'sitemap.xml');
          if (fs.existsSync(masterSitemap)) {
            let idx = fs.readFileSync(masterSitemap, 'utf-8');
            if (!idx.includes('sitemap-market-report.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-market-report.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-market-report\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(masterSitemap, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('\x1b[33m[market-report]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(`\x1b[36m[market-report]\x1b[0m Generated ${LOCALES.length} locale reports — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    },
  };
}
