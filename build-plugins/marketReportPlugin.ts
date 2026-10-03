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
 *   - data/jobs-stats.json  (source processing timestamp only)
 *   - data/jobs.json        (Ticino 2026 observation panel; no estimated fallback)
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
import { loadReportJobPanel, isReportSalaryJob, type ReportJob } from './shared/reportJobPanel';
import { jobSalaryMidpoint } from './shared/realSalaryMedian';
import { formatSourceDate, sourceDateIso } from '../services/dataFreshness';
import { formatUpdatedDate } from './shared/humanDate';
import {
  BASE_URL,
  countHtmlBodyWords,
  MIN_INDEXABLE_WORDS,
  DRIVEBY_AD_SNIPPET,
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
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { CITY_HUB_KEYS } from './cityJobsHub';
import { adSlotHtml } from './lib/adSlotHtml';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import {
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';
import { SECTION_LEGACY_TI_PATH, SECTION_LEGACY_TI_ROOT } from './shared/cantonSection';

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
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
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
  const panel = loadReportJobPanel(rootDir, 2026);
  if (panel === null) return null;
  let generatedAt: string | undefined;
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(rootDir, 'data/jobs-stats.json'), 'utf8'));
    generatedAt = sourceDateIso(metadata?.generatedAt);
  } catch { /* Missing metadata does not justify manufacturing a source date. */ }
  const reported = panel.filter(isReportSalaryJob);
  const mean = (rows: readonly ReportJob[]): number | undefined => rows.length
    ? Math.round(rows.reduce((sum, job) => sum + jobSalaryMidpoint(job)!, 0) / rows.length) : undefined;
  const groups = (rows: readonly ReportJob[], field: 'company' | 'location', salary = false): JobsStatsLeader[] => {
    const buckets = new Map<string, ReportJob[]>();
    for (const job of rows) {
      const name = job[field]?.trim();
      if (!name) continue;
      const bucket = buckets.get(name) ?? [];
      bucket.push(job);
      buckets.set(name, bucket);
    }
    return [...buckets].map(([name, jobs]) => ({
      key: name.toLowerCase(), name, count: jobs.length,
      ...(salary ? { avgMid: mean(jobs) } : {}),
    })).sort((a, b) => salary ? (b.avgMid ?? 0) - (a.avgMid ?? 0) : b.count - a.count);
  };
  const companies = groups(panel, 'company');
  const locations = groups(panel, 'location');
  // Current listings do not provide historical removals or comparable annual
  // snapshots. Do not infer hiring growth from this single surviving panel.
  return {
    generatedAt,
    totals: { activeJobs: panel.length, activeCompanies: companies.length, activeLocations: locations.length },
    leaders: { topCompaniesActive: companies, topLocationsActive: locations },
    salary: {
      coverage: { jobsWithSalary: reported.length, coveragePct: panel.length ? reported.length / panel.length * 100 : 0, avgMid: mean(reported) },
      leaders: { topSalaryCompanies: groups(reported, 'company', true), topSalaryLocations: groups(reported, 'location', true) },
    },
  };
}

function formatCHF(n: number | undefined | null): string {
  if (!n || !Number.isFinite(n)) return 'N/D';
  return `CHF ${Math.round(n).toLocaleString('de-CH')}`;
}

function formatNumber(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return 'N/D';
  return Math.round(n).toLocaleString('de-CH');
}

// ── Localized copy ────────────────────────────────────────────────

interface Copy {
  title: string;
  description: string;
  h1: string;
  updatedLabel: string;
  generatedLabel: string;
  unknownDateLabel: string;
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
  // Function (not a literal string) — interpolate the average salary at
  // render time from the same `avgMid` source of truth used by the stat
  // tile / embed snippet / Dataset JSON-LD, so this copy can't drift into
  // a stale hardcoded figure (sibling of #4394 — was a hardcoded "CHF 73 000").
  salaryP: (avgMid: number | null, salaryCount: number | undefined, totalCount: number | undefined) => string;
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
    description: "Report 2026 sul mercato del lavoro frontalieri in Ticino: stipendi medi per azienda e città, top datori di lavoro, limiti del campione. Dati aggregati dai job board svizzeri.",
    h1: 'Mercato del lavoro frontalieri Ticino 2026',
    updatedLabel: 'Dati elaborati',
    generatedLabel: 'Pagina generata',
    unknownDateLabel: 'Data di elaborazione non disponibile',
    sourceLabel: 'Fonte',
    ledeIntro: `Il report descrive gli annunci del Ticino pubblicati nel 2026 e ancora presenti nel panel disponibile. I conteggi indicano annunci osservati, non assunzioni concluse o posti dell’intero mercato. Le tabelle permettono di esplorare aziende e località rappresentate. Le statistiche salariali usano soltanto range annuali in CHF con provenienza dichiarata: le stime automatiche non sono salari offerti misurati. In assenza di dati il report indica N/D. Per valutare un’offerta, verifica sempre requisiti, orario e retribuzione nella fonte originale.`,
    headlineActiveJobsLabel: 'Posizioni attive',
    headlineCompaniesLabel: 'Aziende che assumono',
    headlineMedianSalaryLabel: 'Stipendio medio annuo',
    headlineAddedLast7dLabel: 'Nuove offerte ultimi 7 giorni',
    topEmployersH2: 'Top 10 aziende che assumono frontalieri',
    topEmployersP: `La classifica ordina le aziende per numero di annunci presenti nel panel selezionato. Non misura assunzioni concluse, dimensione aziendale o qualità del datore di lavoro. Verifica la disponibilità nella pagina originale prima di candidarti: il panel può risentire dei tempi di raccolta e rimozione.`,
    topCitiesH2: 'Top 10 città con più offerte per frontalieri',
    topCitiesP: `La tabella ordina le località per numero di annunci osservati. Le differenze possono dipendere dalla copertura delle fonti e dalla composizione delle offerte; non indicano crescita nel tempo o probabilità di assunzione.`,
    salaryH2: 'Stipendi frontalieri: chi paga di più',
    salaryP: (avgMid, salaryCount, totalCount) => `Nei range annuali dichiarati ammissibili, lo stipendio medio annuo si attesta intorno a ${formatCHF(avgMid)} lordi. Osservazioni salariali ammissibili: ${formatNumber(salaryCount)} su ${formatNumber(totalCount)} annunci del panel. È la media dei punti medi dei range, non dei salari effettivamente pagati. Le tabelle salariali richiedono almeno tre osservazioni per azienda o località; non rappresentano tutti i dipendenti o tutti gli annunci.`,
    topSalaryCompaniesH3: 'Aziende con lo stipendio medio più alto',
    topSalaryLocationsH3: 'Città con lo stipendio medio più alto',
    sectorsH2: 'Come confrontare i settori',
    sectorsP: `Le professioni rappresentate dipendono dalle fonti presenti nel panel. Un volume elevato di annunci in un settore può riflettere copertura dei crawler, ripubblicazioni o stagionalità. Questo snapshot non misura crescita annuale, carenza di candidati o premio salariale d’ingresso. Per confrontare settori occorrono definizioni e copertura coerenti in più periodi.`,
    methodologyH2: 'Metodologia',
    methodologyP: `Il panel è filtrato sul Canton Ticino e sull’anno di pubblicazione 2026. Aziende e località sono raggruppate usando i nomi disponibili negli annunci; varianti di denominazione possono rimanere separate. Gli annunci senza nome restano nel conteggio totale ma non nelle rispettive classifiche. Per i salari si richiedono provenienza reported, valuta CHF, periodo annuale esplicito ed estremi finiti ordinati tra CHF 20 000 e CHF 300 000. Importi stimati, ambigui o mensili sono esclusi. Non si applicano conversioni valutarie né tredicesime presunte. Le classifiche salariali mostrano gruppi con almeno tre osservazioni. I conteggi non provano che ogni annuncio corrisponda a un’assunzione distinta. Senza una serie storica comparabile non vengono calcolati crescita o nuovi annunci settimanali.`,
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
    analysisP1: `Il totale descrive il panel osservato. Per dimostrare un record storico, una contrazione o un saldo positivo servono snapshot comparabili e dati sulle rimozioni. Queste misure non sono disponibili nel report; non si deducono dal solo numero di annunci presenti.`,
    analysisP2: `La media salariale dipende dalla composizione del campione: professioni, esperienza, orario e aziende. Non dimostra una polarizzazione o l’aumento del divario tra decili. Confronta range riferiti a ruoli e condizioni equivalenti prima di trarre conclusioni sul tuo reddito.`,
    analysisP3: `Le tabelle geografiche riguardano gli annunci classificati nel Canton Ticino. Il luogo di lavoro non dimostra da solo l’idoneità a un permesso o a un regime fiscale. Per i requisiti personali consulta le guide e le autorità competenti.`,
    trendsH2: 'Trend da tenere d\'occhio',
    trendsP: `Per monitorare i prossimi periodi occorre confrontare dati omogenei:`,
    trendsBullet1: `Conservare per ogni rilevazione data, elenco delle fonti e regole di inclusione: aggiungere un crawler può aumentare il panel senza indicare crescita economica.`,
    trendsBullet2: `Distinguere la retribuzione dichiarata dalle stime e verificare componenti variabili, mensilità e percentuale di impiego. Un bonus presente in una singola offerta non misura la frequenza di quel beneficio nel mercato.`,
    trendsBullet3: `Separare nuove pubblicazioni, ripubblicazioni e annunci rimossi. La scomparsa di un annuncio non prova un’assunzione, così come la sua permanenza non dimostra una carenza di candidati.`,
    cautionP: `La pagina mostra un campione aggiornabile, non un censimento. Per citare i risultati conserva la data della consultazione e specifica anno, cantone, fonti e limiti del campione. La data di elaborazione, quando disponibile, non è una prova di revisione individuale di ogni annuncio.`,
  },
  en: {
    title: 'Ticino Cross-Border Job Market Report 2026 — Original Data | Frontaliere Ticino',
    description: "2026 report on the Ticino cross-border (frontaliere) job market: average salaries by company and city, top employers, sample limitations. Data aggregated from Swiss job boards.",
    h1: 'Ticino cross-border job market 2026',
    updatedLabel: 'Data compiled',
    generatedLabel: 'Page generated',
    unknownDateLabel: 'Compilation date unavailable',
    sourceLabel: 'Source',
    ledeIntro: `This report describes Ticino listings published in 2026 and still present in the available panel. Counts measure observed listings, not completed hires or the entire labour market. Tables identify represented employers and locations. Salary statistics use only explicitly annual CHF ranges with reported provenance; automated estimates are not measured offers. Missing values appear as N/D. Before evaluating an offer, check its requirements, working hours and pay in the original source.`,
    headlineActiveJobsLabel: 'Active openings',
    headlineCompaniesLabel: 'Hiring companies',
    headlineMedianSalaryLabel: 'Average annual salary',
    headlineAddedLast7dLabel: 'New listings (last 7 days)',
    topEmployersH2: 'Top 10 employers hiring cross-border workers',
    topEmployersP: `The ranking orders employers by listings present in the selected panel. It does not measure completed hires, company size or employer quality. Check availability on the original page before applying: collection and removal delays can affect the panel.`,
    topCitiesH2: 'Top 10 cities with the most cross-border openings',
    topCitiesP: `The table ranks locations by observed listing counts. Differences may reflect source coverage and offer composition; they do not establish growth over time or hiring probability.`,
    salaryH2: 'Cross-border salaries: who pays the most',
    salaryP: (avgMid, salaryCount, totalCount) => `Among eligible reported annual ranges, the average annual salary sits around ${formatCHF(avgMid)} gross. Eligible salary observations: ${formatNumber(salaryCount)} of ${formatNumber(totalCount)} panel listings. This averages range midpoints, not salaries actually paid. Salary tables require at least three observations per employer or location and do not represent all employees or listings.`,
    topSalaryCompaniesH3: 'Companies with the highest average salary',
    topSalaryLocationsH3: 'Cities with the highest average salary',
    sectorsH2: 'How to compare sectors',
    sectorsP: `Represented occupations depend on the sources included in the panel. A large listing count can reflect crawler coverage, republication or seasonality. This snapshot does not measure annual growth, candidate shortages or entry-pay premiums. Comparing sectors requires consistent definitions and coverage over several periods.`,
    methodologyH2: 'Methodology',
    methodologyP: `The panel is filtered to Canton Ticino and publication year 2026. Employers and locations are grouped by the names available in listings; naming variants may remain separate. Unnamed listings remain in total counts but not the corresponding rankings. Salaries require reported provenance, explicit CHF currency and annual period, and finite ordered bounds from CHF 20,000 to CHF 300,000. Estimated, ambiguous and monthly amounts are excluded. No currency conversion or assumed thirteenth payment is applied. Salary rankings require three observations per group. Counts do not establish that every listing represents a distinct hire. Without comparable historical snapshots, neither growth nor weekly new-listing counts are calculated.`,
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
    analysisP1: `The total describes the observed panel. Proving a historic record, contraction or positive balance requires comparable snapshots and removal data. These measurements are unavailable here and cannot be inferred from the current listing total.`,
    analysisP2: `Average pay depends on sample composition: occupations, experience, working hours and employers. It does not establish polarisation or a widening decile gap. Compare equivalent roles and conditions before drawing conclusions about personal income.`,
    analysisP3: `Geographic tables cover listings classified in Canton Ticino. A workplace alone does not establish eligibility for a permit or tax treatment. Consult the relevant guides and authorities for individual requirements.`,
    trendsH2: 'Trends to watch',
    trendsP: `Monitoring subsequent periods requires comparable data:`,
    trendsBullet1: `Preserve the observation date, source list and inclusion rules. Adding a crawler may enlarge the panel without indicating economic growth.`,
    trendsBullet2: `Distinguish reported pay from estimates and check variable components, payment frequency and employment percentage. A bonus in one offer does not measure how common that benefit is across the market.`,
    trendsBullet3: `Separate new publications, republications and removed listings. A disappearing listing does not prove a hire, just as continued publication does not prove a candidate shortage.`,
    cautionP: `This page is an updateable sample, not a census. When citing results, preserve your access date and state the year, canton, sources and sample limitations. A processing date, where available, does not prove individual review of every listing.`,
  },
  de: {
    title: 'Tessiner Grenzgänger-Arbeitsmarkt 2026 — Originaldaten | Frontaliere Ticino',
    description: "Bericht 2026 zum Tessiner Grenzgänger-Arbeitsmarkt: Durchschnittslöhne nach Unternehmen und Stadt, Top-Arbeitgeber, Grenzen der Stichprobe. Daten aggregiert aus Schweizer Jobbörsen.",
    h1: 'Tessiner Grenzgänger-Arbeitsmarkt 2026',
    updatedLabel: 'Daten aufbereitet',
    generatedLabel: 'Seite erstellt',
    unknownDateLabel: 'Aufbereitungsdatum nicht verfügbar',
    sourceLabel: 'Quelle',
    ledeIntro: `Der Bericht beschreibt Tessiner Anzeigen aus dem Jahr 2026, die im verfügbaren Panel enthalten sind. Gezählt werden beobachtete Anzeigen, keine abgeschlossenen Einstellungen oder Stellen des gesamten Arbeitsmarkts. Die Tabellen zeigen vertretene Arbeitgeber und Orte. Lohnstatistiken verwenden nur ausdrücklich jährliche CHF-Spannen mit deklarierter Herkunft; automatische Schätzungen sind keine gemessenen Angebote. Fehlende Werte erscheinen als N/D. Prüfen Sie Anforderungen, Arbeitszeit und Vergütung in der Originalquelle.`,
    headlineActiveJobsLabel: 'Aktive Stellen',
    headlineCompaniesLabel: 'Einstellende Firmen',
    headlineMedianSalaryLabel: 'Durchschnittliches Jahresgehalt',
    headlineAddedLast7dLabel: 'Neue Anzeigen (letzte 7 Tage)',
    topEmployersH2: 'Top 10 Arbeitgeber für Grenzgänger',
    topEmployersP: `Die Rangliste ordnet Arbeitgeber nach Anzeigen im ausgewählten Panel. Sie misst weder abgeschlossene Einstellungen noch Unternehmensgrösse oder Arbeitgeberqualität. Prüfen Sie die Verfügbarkeit auf der Originalseite: Erfassungs- und Entfernungslaufzeiten können den Datenstand beeinflussen.`,
    topCitiesH2: 'Top 10 Städte mit den meisten Grenzgänger-Stellen',
    topCitiesP: `Die Tabelle ordnet Orte nach beobachteten Anzeigenzahlen. Unterschiede können Quellenabdeckung und Zusammensetzung widerspiegeln; sie belegen weder zeitliches Wachstum noch Einstellungschancen.`,
    salaryH2: 'Grenzgänger-Löhne: Wer zahlt am meisten',
    salaryP: (avgMid, salaryCount, totalCount) => `Unter den zulässigen deklarierten Jahresspannen beträgt der mittlere Jahreslohn rund ${formatCHF(avgMid)} brutto. Zulässige Lohnbeobachtungen: ${formatNumber(salaryCount)} von ${formatNumber(totalCount)} Panel-Anzeigen. Gemittelt werden Spannenmittelpunkte, nicht ausbezahlte Löhne. Die Lohntabellen verlangen mindestens drei Beobachtungen je Arbeitgeber oder Ort und vertreten nicht alle Beschäftigten oder Anzeigen.`,
    topSalaryCompaniesH3: 'Unternehmen mit höchstem Durchschnittslohn',
    topSalaryLocationsH3: 'Städte mit höchstem Durchschnittslohn',
    sectorsH2: 'Branchen vergleichen',
    sectorsP: `Die vertretenen Berufe hängen von den Quellen im Panel ab. Hohe Anzeigenzahlen können Abdeckung, Wiederveröffentlichung oder Saisonalität widerspiegeln. Dieser Datenstand misst weder Jahreswachstum noch Bewerbermangel oder Einstiegslohnprämien. Branchenvergleiche brauchen einheitliche Definitionen und Abdeckung über mehrere Perioden.`,
    methodologyH2: 'Methodik',
    methodologyP: `Das Panel wird auf Kanton Tessin und Publikationsjahr 2026 gefiltert. Arbeitgeber und Orte werden nach den verfügbaren Namen gruppiert; Namensvarianten können getrennt bleiben. Anzeigen ohne Namen zählen zum Gesamtbestand, aber nicht zur jeweiligen Rangliste. Löhne benötigen Herkunft reported, ausdrückliche CHF-Währung und Jahresperiode sowie endliche geordnete Grenzen zwischen CHF 20 000 und CHF 300 000. Geschätzte, unklare und monatliche Beträge werden ausgeschlossen. Keine Währungsumrechnung oder vermutete dreizehnte Zahlung wird verwendet. Lohnranglisten verlangen drei Beobachtungen je Gruppe. Anzeigenzahlen belegen keine einzelnen Einstellungen. Ohne vergleichbare historische Daten werden weder Wachstum noch wöchentliche Neuanzeigen berechnet.`,
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
    analysisP1: `Der Gesamtbestand beschreibt das beobachtete Panel. Historische Rekorde, Rückgänge oder positive Salden erfordern vergleichbare Datenstände und entfernte Anzeigen. Diese Messungen fehlen hier und lassen sich nicht aus dem aktuellen Bestand ableiten.`,
    analysisP2: `Der Durchschnittslohn hängt von Berufen, Erfahrung, Arbeitszeit und Arbeitgebern im Sample ab. Er belegt weder Polarisierung noch wachsende Dezilabstände. Vergleichen Sie gleichwertige Funktionen und Bedingungen vor Rückschlüssen auf Ihr Einkommen.`,
    analysisP3: `Die Ortstabellen umfassen Anzeigen, die dem Kanton Tessin zugeordnet sind. Ein Arbeitsort allein belegt keine Bewilligungs- oder Steuerberechtigung. Beachten Sie die Leitfäden und zuständigen Behörden für persönliche Voraussetzungen.`,
    trendsH2: 'Zu beobachtende Trends',
    trendsP: `Für die Beobachtung weiterer Perioden braucht es vergleichbare Daten:`,
    trendsBullet1: `Bewahren Sie Beobachtungsdatum, Quellen und Einschlussregeln auf. Ein zusätzlicher Crawler kann das Panel ohne wirtschaftliches Wachstum vergrössern.`,
    trendsBullet2: `Trennen Sie deklarierte Löhne von Schätzungen und prüfen Sie variable Bestandteile, Zahlungsfrequenz und Beschäftigungsgrad. Ein Bonus in einem Angebot misst nicht dessen Häufigkeit im Markt.`,
    trendsBullet3: `Unterscheiden Sie neue, erneut veröffentlichte und entfernte Anzeigen. Eine verschwundene Anzeige beweist keine Einstellung; eine fortbestehende beweist keinen Bewerbermangel.`,
    cautionP: `Die Seite zeigt eine aktualisierbare Stichprobe, keine Vollerhebung. Nennen Sie beim Zitieren Abrufdatum, Jahr, Kanton, Quellen und Grenzen. Ein Verarbeitungsdatum belegt keine individuelle Prüfung jeder Anzeige.`,
  },
  fr: {
    title: "Marché de l'emploi frontaliers Tessin 2026 — Rapport de données | Frontaliere Ticino",
    description: "Rapport 2026 sur le marché de l'emploi frontalier au Tessin : salaires moyens par entreprise et par ville, principaux employeurs, limites du panel. Données agrégées depuis les plateformes suisses.",
    h1: "Marché de l'emploi frontaliers au Tessin en 2026",
    updatedLabel: 'Données compilées',
    generatedLabel: 'Page générée',
    unknownDateLabel: 'Date de compilation indisponible',
    sourceLabel: 'Source',
    ledeIntro: `Ce rapport décrit les annonces tessinoises publiées en 2026 et encore présentes dans le panel disponible. Les effectifs mesurent des annonces observées, non des recrutements conclus ou tout le marché du travail. Les tableaux identifient les employeurs et lieux représentés. Les statistiques salariales retiennent uniquement des fourchettes annuelles explicites en CHF de provenance déclarée ; les estimations automatiques ne sont pas des offres mesurées. Les valeurs absentes apparaissent N/D. Vérifiez exigences, horaire et rémunération dans la source originale.`,
    headlineActiveJobsLabel: 'Postes ouverts',
    headlineCompaniesLabel: 'Entreprises qui recrutent',
    headlineMedianSalaryLabel: 'Salaire annuel moyen',
    headlineAddedLast7dLabel: 'Nouvelles annonces (7 derniers jours)',
    topEmployersH2: 'Top 10 employeurs recrutant des frontaliers',
    topEmployersP: `Le classement ordonne les employeurs selon les annonces du panel sélectionné. Il ne mesure ni recrutements conclus, ni taille, ni qualité de l’employeur. Vérifiez la disponibilité sur la page originale : les délais de collecte et de retrait peuvent affecter le panel.`,
    topCitiesH2: 'Top 10 villes avec le plus d\'offres frontaliers',
    topCitiesP: `Le tableau classe les lieux selon le nombre d’annonces observées. Les écarts peuvent refléter la couverture des sources et la composition des offres ; ils ne démontrent ni croissance dans le temps ni probabilité de recrutement.`,
    salaryH2: 'Salaires frontaliers : qui paie le plus',
    salaryP: (avgMid, salaryCount, totalCount) => `Parmi les fourchettes annuelles déclarées admissibles, le salaire annuel moyen se situe autour de ${formatCHF(avgMid)} brut. Observations salariales admissibles : ${formatNumber(salaryCount)} sur ${formatNumber(totalCount)} annonces du panel. Il s’agit de la moyenne des milieux de fourchettes, non des salaires versés. Les tableaux exigent trois observations par employeur ou lieu et ne représentent pas tous les salariés ou annonces.`,
    topSalaryCompaniesH3: 'Entreprises avec le salaire moyen le plus élevé',
    topSalaryLocationsH3: 'Villes avec le salaire moyen le plus élevé',
    sectorsH2: 'Comment comparer les secteurs',
    sectorsP: `Les métiers représentés dépendent des sources du panel. Un nombre élevé d’annonces peut refléter la couverture, les republications ou la saisonnalité. Cet instantané ne mesure ni croissance annuelle, ni pénurie de candidats, ni prime salariale d’entrée. La comparaison exige des définitions et une couverture cohérentes sur plusieurs périodes.`,
    methodologyH2: 'Méthodologie',
    methodologyP: `Le panel est filtré sur le Canton du Tessin et l’année de publication 2026. Employeurs et lieux sont regroupés selon les noms disponibles ; des variantes peuvent rester séparées. Les annonces sans nom comptent dans le total mais pas dans le classement correspondant. Les salaires exigent une provenance reported, une devise CHF et une période annuelle explicites, ainsi que des bornes finies ordonnées entre CHF 20 000 et CHF 300 000. Les montants estimés, ambigus ou mensuels sont exclus. Aucune conversion ni treizième versement supposé n’est appliqué. Les classements salariaux exigent trois observations par groupe. Les effectifs ne prouvent pas des recrutements distincts. Sans historique comparable, ni croissance ni nouvelles annonces hebdomadaires ne sont calculées.`,
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
    analysisP1: `Le total décrit le panel observé. Un record historique, une contraction ou un solde positif exige des instantanés comparables et des données de retrait. Ces mesures sont indisponibles ici et ne se déduisent pas du seul effectif actuel.`,
    analysisP2: `Le salaire moyen dépend des métiers, expériences, horaires et employeurs de l’échantillon. Il ne démontre ni polarisation ni écart croissant entre déciles. Comparez des rôles et conditions équivalents avant de conclure sur votre revenu.`,
    analysisP3: `Les tableaux géographiques concernent les annonces classées dans le Canton du Tessin. Le lieu de travail ne suffit pas à démontrer un droit au permis ou à un régime fiscal. Consultez les guides et autorités compétentes pour les conditions individuelles.`,
    trendsH2: 'Tendances à surveiller',
    trendsP: `Le suivi des périodes suivantes exige des données comparables :`,
    trendsBullet1: `Conservez la date d’observation, les sources et les règles d’inclusion. Ajouter un crawler peut agrandir le panel sans indiquer une croissance économique.`,
    trendsBullet2: `Distinguez salaires déclarés et estimations ; vérifiez composantes variables, fréquence des versements et taux d’activité. Un bonus dans une offre ne mesure pas sa fréquence sur le marché.`,
    trendsBullet3: `Séparez nouvelles publications, republications et annonces retirées. Une disparition ne prouve pas un recrutement ; une publication persistante ne prouve pas une pénurie de candidats.`,
    cautionP: `Cette page présente un échantillon actualisable, non un recensement. Lors d’une citation, conservez la date de consultation et précisez année, canton, sources et limites. Une date de traitement ne prouve pas la révision individuelle de chaque annonce.`,
  },
};

// ── Rendering ─────────────────────────────────────────────────────

interface RenderedReport {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderTable(headers: string[], rows: string[][]): string {
  const h = headers.map((x) => `<th class="s-thd">${esc(x)}</th>`).join('');
  const body = rows.map((r) => {
    const tds = r.map((c, idx) => `<td class="s-tcl"${idx === 0 ? ' style="font-weight:600"' : ''}>${c}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<div class="s-Itl8IE"><table class="s-wkGd-4"><thead><tr>${h}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderReport(opts: {
  locale: Locale;
  stats: JobsStatsFile | null;
  dateStamp: string;
  distDir?: string;
}): RenderedReport {
  const { locale, stats, dateStamp, distDir } = opts;
  const copy = COPY[locale];
  const dataUpdatedAt = sourceDateIso(stats?.generatedAt);
  const dataUpdatedLabel = formatSourceDate(stats?.generatedAt, locale) ?? copy.unknownDateLabel;
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
  const activeJobs = stats?.totals?.activeJobs;
  const activeCompanies = stats?.totals?.activeCompanies;
  const added7d = stats?.totals?.last7d?.added;
  const salaryCoverage = stats?.salary?.coverage;
  // No hardcoded fallback here (was `?? 73000`, a stale figure that made
  // the tile/embed/JSON-LD confidently assert a fabricated number whenever
  // jobs-stats.json's salary coverage was missing) — formatCHF(null)
  // degrades to 'N/D', and the Dataset JSON-LD PropertyValue below is
  // omitted entirely rather than emitting a false `value: null`.
  const avgMid = salaryCoverage?.avgMid ?? null;

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
    <section class="s-epjKYm">
      <div class="s-tbase">
        <div class="s-tlbl">${esc(copy.headlineActiveJobsLabel)}</div>
        <div class="s-tval">${formatNumber(activeJobs)}</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">${esc(copy.headlineCompaniesLabel)}</div>
        <div class="s-tval">${formatNumber(activeCompanies)}</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">${esc(copy.headlineMedianSalaryLabel)}</div>
        <div class="s-tval">${esc(formatCHF(avgMid))}</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">${esc(copy.headlineAddedLast7dLabel)}</div>
        <div class="s-tval">${formatNumber(added7d)}</div>
      </div>
    </section>`;

  // Tables
  const topEmployersRows = topEmployers.map((e, i) => [
    `#${i + 1}`,
    e.url ? `<a href="${esc(e.url)}" style="${LINK_ACCENT_STYLE}">${esc(e.name)}</a>` : esc(e.name),
    formatNumber(e.count),
  ]);
  const cityHubSet = new Set<string>(CITY_HUB_KEYS as readonly string[]);
  const cityHubBase: Record<Locale, string> = SECTION_LEGACY_TI_ROOT;
  const cityHubHref = (key: string): string | null => cityHubSet.has(key) ? `${cityHubBase[locale]}/${key}/` : null;
  const topCitiesRows = topCities.map((c, i) => {
    const href = cityHubHref(c.key);
    const cell = href
      ? `<a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(c.name)}</a>`
      : `<span class="s-F2VOFC">${esc(c.name)}</span>`;
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
    e.url ? `<a href="${esc(e.url)}" style="${LINK_ACCENT_STYLE}">${esc(e.name)}</a>` : esc(e.name),
    esc(formatCHF(e.avgMid)),
  ]);
  const topSalaryLocationsRows = topSalaryLocations.map((l, i) => {
    const href = cityHubHref(l.key);
    const cell = href
      ? `<a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(l.name)}</a>`
      : `<span class="s-F2VOFC">${esc(l.name)}</span>`;
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

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.h1, item: canonicalUrl },
    ],
  });

  // One description of the hero, used three times: the <img>, `Article.image`
  // and `og:image`, all deriving their URL from this single triple.
  const hero: SeoHeroImageOpts = {
    family: 'market-report', key: 'report', locale, headline: copy.h1, eyebrow: copy.updatedLabel, alt: copy.h1,
  };

  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: guardArticleJsonLdDescription(copy.description),
    image: seoHeroImageObject(hero),
    inLanguage: locale,
    url: canonicalUrl,
    ...(dataUpdatedAt ? { dateModified: dataUpdatedAt } : {}),
    author: {
      '@type': 'Organization',
      '@id': `${BASE_URL}/#organization`,
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
    },
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
    creator: {
      '@type': 'Organization',
      '@id': `${BASE_URL}/#organization`,
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
    },
    ...(dataUpdatedAt ? { dateModified: dataUpdatedAt } : {}),
    inLanguage: locale,
    keywords:
      locale === 'en' ? ['cross-border workers', 'Ticino', 'salaries', 'job market', 'Swiss salaries']
      : locale === 'de' ? ['Grenzgänger', 'Tessin', 'Gehälter', 'Arbeitsmarkt', 'Schweizer Löhne']
      : locale === 'fr' ? ['frontaliers', 'Tessin', 'salaires', 'marché du travail', 'salaires suisses']
      : ['frontalieri', 'Ticino', 'stipendi', 'mercato del lavoro', 'salari svizzeri'],
    variableMeasured: [
      ...(activeJobs != null ? [{ '@type': 'PropertyValue', name: copy.headlineActiveJobsLabel, value: activeJobs }] : []),
      ...(activeCompanies != null ? [{ '@type': 'PropertyValue', name: copy.headlineCompaniesLabel, value: activeCompanies }] : []),
      // Omitted (not emitted as `value: null`) when the source panel has no
      // salary coverage — see the avgMid fallback comment above.
      ...(avgMid !== null
        ? [{ '@type': 'PropertyValue', name: copy.headlineMedianSalaryLabel, unitCode: 'CHF', value: avgMid }]
        : []),
    ],
    distribution: {
      '@type': 'DataDownload',
      encodingFormat: 'text/html',
      contentUrl: canonicalUrl,
    },
  });

  const jobsRoot: Record<Locale, string> = SECTION_LEGACY_TI_PATH;

  const body = `
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header class="s-sy52lX">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.updatedLabel)} · ${esc(dataUpdatedLabel)} · ${esc(copy.sourceLabel)}: data/jobs.json<br>${esc(copy.generatedLabel)}: ${esc(formatUpdatedDate(dateStamp, locale))}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.ledeIntro)}</p>
    </header>
    ${renderSeoHeroImage(hero)}
    ${statCards}
    ${DRIVEBY_AD_SNIPPET}
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.topEmployersH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.topEmployersP)}</p>
      ${topEmployersTable}
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.topCitiesH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.topCitiesP)}</p>
      ${topCitiesTable}
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.salaryH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.salaryP(avgMid, salaryCoverage?.jobsWithSalary, activeJobs))}</p>
      ${topSalaryCompaniesTable ? `<h3 class="s-QiTCCv">${esc(copy.topSalaryCompaniesH3)}</h3>${topSalaryCompaniesTable}` : ''}
      ${topSalaryLocationsTable ? `<h3 class="s-QiTCCv">${esc(copy.topSalaryLocationsH3)}</h3>${topSalaryLocationsTable}` : ''}
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.sectorsH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.sectorsP)}</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.analysisH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.analysisP1)}</p>
      <p style="${BODY_STYLE}">${esc(copy.analysisP2)}</p>
      <p style="${BODY_STYLE}">${esc(copy.analysisP3)}</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.trendsH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.trendsP)}</p>
      <ol class="s-C1hMlw">
        <li class="s-U2-lJ-">${esc(copy.trendsBullet1)}</li>
        <li class="s-U2-lJ-">${esc(copy.trendsBullet2)}</li>
        <li class="s-q3nqK4">${esc(copy.trendsBullet3)}</li>
      </ol>
    </section>
    <section class="s-AV5A4S">
      <h2 style="${H2_STYLE}">${esc(copy.embedH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.embedP)}</p>
      <p class="s-d2yCXP">${esc(copy.embedSnippetLabel)}</p>
      <pre class="s-7jSP06"><code>${embedSnippet}</code></pre>
      <h3 class="s-8qAk8z">${esc(copy.citationH3)}</h3>
      <p class="s-pz9soM">${esc(copy.citationText)}</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.methodologyH2)}</h2>
      <p style="${BODY_STYLE}">${esc(copy.methodologyP)}</p>
    </section>
    <p class="s-80ZfUb">${esc(copy.cautionP)}</p>
    <section class="s-p1QaOi">
      <a href="${esc(jobsRoot[locale])}" class="s-cta">${esc(copy.ctaJobs)}</a>
      <a class="s-bX1C8q" href="${esc(homeUrl)}">${esc(copy.ctaSimulator)}</a>
    </section>
  `;

  const adSection = `<section class="s-U5Q4dL" aria-label="advertisement">${adSlotHtml('ARTICLE_END_MULTIPLEX')}</section>`;
  const bodyHtml = `<main class="s-xzWvwM">${body}</main>${adSection}`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: copy.title,
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    ogImage: seoHeroImageUrl(hero),
    ogImageWidth: SEO_HERO_WIDTH,
    ogImageHeight: SEO_HERO_HEIGHT,
    ogImageType: 'image/webp',
    ogImageAlt: copy.h1,
    hreflangHtml: alternates,
    jsonLdScripts: [breadcrumbLd, articleLd, datasetLd],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

// ── Plugin ────────────────────────────────────────────────────────

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const masterSitemap = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(masterSitemap)) return;
  try {
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
  } catch (err) {
    console.warn('\x1b[33m[market-report]\x1b[0m sitemap-index patch failed:', err);
  }
}

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
      const dateStamp = new Date().toISOString().slice(0, 10);

      const stats = loadJobsStats(rootDir);
      if (!stats) {
        console.warn('\x1b[33m[market-report]\x1b[0m data/jobs.json unavailable — emitting report with unavailable observations');
      }

      const collector = new WriteCollector({
        distDir,
        pluginName: 'marketReportPlugin',
      });
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

      // Dedicated sitemap (master-index patch is applied as always-run
      // below so it survives when other plugins regenerate sitemap.xml).
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
        try {
          fs.mkdirSync(distDir, { recursive: true });
          const sitemapPath = path.join(distDir, 'sitemap-market-report.xml');
          fs.writeFileSync(sitemapPath, sitemapXml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[market-report]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(`\x1b[36m[market-report]\x1b[0m Generated ${LOCALES.length} locale reports — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      // Always-run: patch sitemap.xml index `<lastmod>` for the
      // sitemap-market-report.xml entry. Only when our sitemap exists in
      // dist (either freshly written or restored from cache).
      if (fs.existsSync(path.join(distDir, 'sitemap-market-report.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
    },
  };
}
