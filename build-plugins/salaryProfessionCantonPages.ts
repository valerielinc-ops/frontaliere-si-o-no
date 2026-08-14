/**
 * salaryProfessionCantonPages.ts — salary-intent profession×canton landings.
 *
 * Emits `/stipendio-{professione}-{cantone}/` (+ /en/salary-, /de/gehalt-,
 * /fr/salaire-) for every (canton, profession) pair — among the 8 professions
 * that carry a real TI-scoped median preset (data/profession-salary-medians.json)
 * — that has at least MIN_JOBS real active jobs in the corpus. Ticino is excluded
 * (its salary-intent need is already served by the TI profession landings, see
 * docs/SALARY-INTENT-CANONICAL-PLAN.md §2).
 *
 * Each page's unique value vs the sibling job-intent `/lavoro-{canton}-{role}/`
 * page (plan §4.3) is the NET-salary estimate (data/swiss-canton-tax-burden.json
 * via cantonNetSalaryBandForCode) and cross-canton context for the same
 * profession — not a re-print of the gross median already shown on the jobs page.
 * The gross median is `medianTi × cantonSalaryFactor` (same scaling mechanism as
 * salaryStatsChCantonPages), the jobs come from the same corpus aggregation.
 *
 * Below-floor pairs get a noindex,follow bridge to the canton salary-stats hub
 * (renderSalaryStatsBridge) instead of a silent skip / hard 404, and the family
 * self-maps in searchConsoleCompat.ts (AGENTS.md → Static SEO Pages).
 *
 * Plugin contract: apply 'build', enforce 'post', emit in closeBundle(),
 * distDir passed through. Pure/deterministic so output is stable.
 */
import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { WriteCollector } from './batchWrite';
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { buildDayStampIso } from './shared/buildDayStamp';
import { cleanSitemapFiles } from './shared/distNamespaceCleanup';
import { CALC_HREF } from './shared/calcHref';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import { normalizeCantonCode } from '../scripts/lib/target-swiss-locations.mjs';
import {
  renderCantonSeoProse,
  buildCantonSeoProseFaqItems,
  type CantonSeoLocale,
} from './shared/cantonSeoProse';
import { renderSalaryStatsBridge } from './shared/salaryStatsBridge';
import { renderAuthoritativeSourcesHtml } from './shared/authoritativeSources';
import {
  GROSSREGION_MEDIAN_MONTHLY,
  TICINO_MEDIAN_MONTHLY,
  CANTON_TO_GROSSREGION,
  cantonSalaryFactor,
  cantonNetSalaryBandForCode,
  type Grossregion,
} from './shared/cantonSalaryIndex';
import { resolveCantonSection } from './shared/cantonSection';
import { buildListItemJobPosting } from './shared/jobPostingListItem';
import { stripLiteralMarkdown } from './shared/stripLiteralMarkdown';
import {
  aggregateProfessionJobsByCanton,
  type ProfessionJobsSnapshot,
  type FeaturedJob,
} from './professionJobsAggregate';
import {
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  buildProfessionLandingPath,
  type AnyProfessionId,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import { SALARY_STATS_CANTON_SLUGS, SALARY_STATS_FACTOR_CODE, buildSalaryStatsPath } from './salaryStatsData';
import { buildProfessionCantonPath, PROFESSION_CANTON_KEYS } from './professionCantonData';
import {
  SALARY_PROFESSION_ELIGIBLE_IDS,
  buildSalaryProfessionCantonPath,
} from './salaryProfessionCantonData';
import { resolveSalaryProfessionCantonsFlushed } from './shared/buildSignals';
import {
  H2_STYLE,
  BODY_STYLE,
  BREADCRUMB_CLASS,
  BREADCRUMB_LINK_CLASS,
  CTA_PRIMARY_CLASS,
  CARD_CLASS,
  STAT_TILE_LABEL_CLASS,
  STAT_TILE_VALUE_CLASS,
  TABLE_CLASS,
  TABLE_HEAD_CLASS,
  TABLE_CELL_CLASS,
  renderStatGrid,
  differentiateH1FromTitle,
} from './shared/seoContentTokens';

/** Minimum real active jobs for a (canton, profession) salary page to be emitted. */
const MIN_JOBS = 3;
const SITEMAP_FILE = 'sitemap-salary-profession-cantons.xml';

const OG_LOCALE: Record<ProfessionLocale, string> = {
  it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH',
};

/** One representative single-canton per Grossregion — the cross-canton table
 * shows the same profession scaled to each region (BFS granularity is regional,
 * so one canton per region avoids repeating identical numbers). All keys are
 * valid canton codes / URL keys for getCantonDisplayName + cantonSalaryFactor. */
const REGION_REPRESENTATIVE: Record<Grossregion, string> = {
  zurich: 'ZH',
  nordwest: 'AG',
  zentral: 'ZG',
  lemanique: 'GE',
  mittelland: 'BE',
  ostschweiz: 'SG',
  ticino: 'TI',
};

interface MedianPreset {
  id: string;
  label: Partial<Record<ProfessionLocale, string>>;
  medianSalaryChf: number;
}

let _presetCache: Map<string, MedianPreset> | null = null;
let _presetCacheRoot: string | null = null;

/** Load the profession median presets from data/profession-salary-medians.json
 * via fs (build side — never a top-level JSON import, to stay out of the Vite
 * config-eval graph, same reason cantonSalaryIndex inlines its tables). */
function loadMedianPresets(rootDir: string): Map<string, MedianPreset> {
  if (_presetCache && _presetCacheRoot === rootDir) return _presetCache;
  const out = new Map<string, MedianPreset>();
  try {
    const p = np.join(rootDir, 'data', 'profession-salary-medians.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { presets?: MedianPreset[] };
    for (const preset of parsed.presets ?? []) {
      if (preset && typeof preset.id === 'string' && Number.isFinite(preset.medianSalaryChf)) {
        out.set(preset.id, preset);
      }
    }
  } catch (err) {
    console.warn('[salary-profession-cantons] failed to read profession-salary-medians.json:', err);
  }
  _presetCache = out;
  _presetCacheRoot = rootDir;
  return out;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtChf(n: number, locale: ProfessionLocale): string {
  const sep = locale === 'en' ? ',' : locale === 'fr' ? ' ' : "'";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

const round500 = (n: number): number => Math.round(n / 500) * 500;
const round1000 = (n: number): number => Math.round(n / 1000) * 1000;

/** Real canton code behind a URL key (half-canton groups collapse to one member). */
function factorCode(cantonKey: string): string {
  return SALARY_STATS_FACTOR_CODE[cantonKey] ?? cantonKey;
}

/** Scaled gross annual median for a profession in a canton code. */
function scaledGrossAnnual(medianTi: number, code: string): number {
  return round500(medianTi * cantonSalaryFactor(code));
}

/** Estimated single net monthly pay for an annual gross at a canton code. */
function netMonthly(grossAnnual: number, code: string): number {
  return cantonNetSalaryBandForCode(code, grossAnnual, grossAnnual).netSingleLow;
}

/** Localised profession label — prefer the preset's own label, else Title-cased role. */
function professionLabel(locale: ProfessionLocale, preset: MedianPreset | undefined, id: AnyProfessionId): string {
  const fromPreset = preset?.label?.[locale];
  if (fromPreset && fromPreset.trim()) return fromPreset.trim();
  // Fallback (should not happen for eligible ids): Title-case the id.
  const words = String(id).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Copy {
  eyebrow: string;
  h1: (role: string, canton: string) => string;
  lede: (role: string, canton: string, gross: string, net: string) => string;
  tileGrossYear: string;
  tileGrossMonth: string;
  tileNetMonth: string;
  tileRange: string;
  netHeading: string;
  netExplain: (role: string, canton: string, net: string) => string;
  compareHeading: (role: string) => string;
  compareColRegion: string;
  compareColGross: string;
  compareColNet: string;
  thisCanton: (canton: string) => string;
  jobsHeading: (role: string, canton: string) => string;
  jobsIntro: (n: number, role: string, canton: string) => string;
  jobPostedDays: (d: number) => string;
  jobsCta: (role: string, canton: string) => string;
  hubsHeading: string;
  hubCanton: (canton: string) => string;
  hubProfession: (role: string) => string;
  hubCalc: string;
  methodologyHeading: string;
  methodology: (role: string, canton: string) => string;
  perYear: string;
  perMonth: string;
  breadcrumbHome: string;
  breadcrumbSalary: string;
  metaTitle: (role: string, canton: string, gross: string) => string;
  metaDesc: (role: string, canton: string, gross: string, net: string) => string;
}

const COPY: Record<ProfessionLocale, Copy> = {
  it: {
    eyebrow: 'Stipendio per professione e cantone',
    h1: (r, c) => `Stipendio ${r} nel Canton ${c}`,
    lede: (r, c, g, n) => `Stipendio mediano lordo di ${r} nel Canton ${c}: ${g}/anno, circa ${n}/mese netto stimato per un frontaliere single.`,
    tileGrossYear: 'Mediana lorda / anno',
    tileGrossMonth: 'Mediana lorda / mese',
    tileNetMonth: 'Netto mensile stimato',
    tileRange: 'Fascia indicativa (junior–senior)',
    netHeading: 'Quanto resta netto',
    netExplain: (r, c, n) => `Su una mediana lorda per ${r} nel Canton ${c}, il netto mensile stimato per un frontaliere single è circa ${n}, dopo imposta alla fonte cantonale (dati ESTV) e contributi sociali svizzeri. Il netto reale dipende da situazione familiare, comune e accordo fiscale Italia-Svizzera 2024.`,
    compareHeading: (r) => `Stipendio ${r}: confronto tra regioni svizzere`,
    compareColRegion: 'Cantone di riferimento',
    compareColGross: 'Lordo / anno',
    compareColNet: 'Netto / mese (stima)',
    thisCanton: (c) => `Canton ${c} (questa pagina)`,
    jobsHeading: (r, c) => `Offerte attive per ${r} nel Canton ${c}`,
    jobsIntro: (n, r, c) => `${n} offerte reali per ${r} nel Canton ${c}, da datori di lavoro svizzeri.`,
    jobPostedDays: (d) => (d <= 0 ? 'oggi' : d === 1 ? '1 giorno fa' : `${d} giorni fa`),
    jobsCta: (r, c) => `Vedi tutte le offerte di ${r} nel Canton ${c}`,
    hubsHeading: 'Approfondisci',
    hubCanton: (c) => `Tutti gli stipendi nel Canton ${c}`,
    hubProfession: (r) => `Guida alla professione: ${r}`,
    hubCalc: 'Calcola il tuo netto frontaliere',
    methodologyHeading: 'Metodologia e fonti',
    methodology: (r, c) => `La mediana lorda per ${r} deriva dalla mediana reale del corpus di offerte in Ticino, scalata sul livello salariale del Canton ${c} (mediana BFS della Grossregion, LSE 2024). Il netto usa la curva d'imposta alla fonte cantonale ESTV 2024 più i contributi sociali svizzeri. Le cifre sono stime indicative aggiornate a ogni build sui dati reali.`,
    perYear: '/anno',
    perMonth: '/mese',
    breadcrumbHome: 'Home',
    breadcrumbSalary: 'Stipendi',
    metaTitle: (r, c, g) => `Stipendio ${r} Canton ${c} — lordo ${g} e netto`,
    metaDesc: (r, c, g, n) => `Quanto guadagna ${r} nel Canton ${c}: mediana lorda ${g}/anno, netto mensile stimato ${n}, confronto tra regioni e offerte attive. Fonti BFS ed ESTV.`,
  },
  en: {
    eyebrow: 'Salary by profession and canton',
    h1: (r, c) => `${r} salary in Canton ${c}`,
    lede: (r, c, g, n) => `Median gross ${r} salary in Canton ${c}: ${g}/year, around ${n}/month estimated net for a single cross-border worker.`,
    tileGrossYear: 'Median gross / year',
    tileGrossMonth: 'Median gross / month',
    tileNetMonth: 'Estimated net / month',
    tileRange: 'Indicative range (junior–senior)',
    netHeading: 'What is left net',
    netExplain: (r, c, n) => `On a median gross ${r} salary in Canton ${c}, the estimated monthly net for a single cross-border worker is around ${n}, after cantonal withholding tax (ESTV data) and Swiss social charges. Real net depends on family situation, commune and the 2024 Italy-Switzerland tax agreement.`,
    compareHeading: (r) => `${r} salary: comparison across Swiss regions`,
    compareColRegion: 'Reference canton',
    compareColGross: 'Gross / year',
    compareColNet: 'Net / month (est.)',
    thisCanton: (c) => `Canton ${c} (this page)`,
    jobsHeading: (r, c) => `Active ${r} openings in Canton ${c}`,
    jobsIntro: (n, r, c) => `${n} real ${r} openings in Canton ${c}, from Swiss employers.`,
    jobPostedDays: (d) => (d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`),
    jobsCta: (r, c) => `See all ${r} openings in Canton ${c}`,
    hubsHeading: 'Go deeper',
    hubCanton: (c) => `All salaries in Canton ${c}`,
    hubProfession: (r) => `Profession guide: ${r}`,
    hubCalc: 'Calculate your cross-border net',
    methodologyHeading: 'Methodology and sources',
    methodology: (r, c) => `The median gross for ${r} derives from the real median of the Ticino job corpus, scaled to the wage level of Canton ${c} (BFS Grossregion median, LSE 2024). Net uses the ESTV 2024 cantonal withholding-tax curve plus Swiss social charges. Figures are indicative estimates refreshed on every build from real data.`,
    perYear: '/yr',
    perMonth: '/mo',
    breadcrumbHome: 'Home',
    breadcrumbSalary: 'Salaries',
    metaTitle: (r, c, g) => `${r} salary Canton ${c} — gross ${g} and net`,
    metaDesc: (r, c, g, n) => `How much a ${r} earns in Canton ${c}: median gross ${g}/year, estimated net ${n}/month, regional comparison and active openings. BFS and ESTV sources.`,
  },
  de: {
    eyebrow: 'Lohn nach Beruf und Kanton',
    h1: (r, c) => `${r}-Lohn im Kanton ${c}`,
    lede: (r, c, g, n) => `Medianer Bruttolohn für ${r} im Kanton ${c}: ${g}/Jahr, rund ${n}/Monat geschätztes Netto für einen alleinstehenden Grenzgänger.`,
    tileGrossYear: 'Median brutto / Jahr',
    tileGrossMonth: 'Median brutto / Monat',
    tileNetMonth: 'Geschätztes Netto / Monat',
    tileRange: 'Richtwert-Spanne (Junior–Senior)',
    netHeading: 'Was netto bleibt',
    netExplain: (r, c, n) => `Bei einem medianen Bruttolohn für ${r} im Kanton ${c} liegt das geschätzte Monatsnetto für einen alleinstehenden Grenzgänger bei rund ${n}, nach kantonaler Quellensteuer (ESTV-Daten) und Schweizer Sozialabgaben. Das reale Netto hängt von Familiensituation, Gemeinde und dem Steuerabkommen Italien-Schweiz 2024 ab.`,
    compareHeading: (r) => `${r}-Lohn: Vergleich der Schweizer Regionen`,
    compareColRegion: 'Referenzkanton',
    compareColGross: 'Brutto / Jahr',
    compareColNet: 'Netto / Monat (Schätzung)',
    thisCanton: (c) => `Kanton ${c} (diese Seite)`,
    jobsHeading: (r, c) => `Aktive ${r}-Stellen im Kanton ${c}`,
    jobsIntro: (n, r, c) => `${n} echte ${r}-Stellen im Kanton ${c}, von Schweizer Arbeitgebern.`,
    jobPostedDays: (d) => (d <= 0 ? 'heute' : d === 1 ? 'vor 1 Tag' : `vor ${d} Tagen`),
    jobsCta: (r, c) => `Alle ${r}-Stellen im Kanton ${c} ansehen`,
    hubsHeading: 'Mehr erfahren',
    hubCanton: (c) => `Alle Löhne im Kanton ${c}`,
    hubProfession: (r) => `Berufsratgeber: ${r}`,
    hubCalc: 'Berechne dein Grenzgänger-Netto',
    methodologyHeading: 'Methodik und Quellen',
    methodology: (r, c) => `Der Bruttomedian für ${r} stammt aus dem realen Median des Tessiner Stellenkorpus, skaliert auf das Lohnniveau des Kantons ${c} (BFS-Grossregion-Median, LSE 2024). Das Netto nutzt die ESTV-Quellensteuerkurve 2024 plus Schweizer Sozialabgaben. Die Zahlen sind indikative Schätzungen, bei jedem Build aus realen Daten aktualisiert.`,
    perYear: '/Jahr',
    perMonth: '/Monat',
    breadcrumbHome: 'Home',
    breadcrumbSalary: 'Löhne',
    metaTitle: (r, c, g) => `${r}-Lohn Kanton ${c} — brutto ${g} und netto`,
    metaDesc: (r, c, g, n) => `Wie viel ${r} im Kanton ${c} verdient: Bruttomedian ${g}/Jahr, geschätztes Netto ${n}/Monat, Regionenvergleich und offene Stellen. Quellen BFS und ESTV.`,
  },
  fr: {
    eyebrow: 'Salaire par métier et canton',
    h1: (r, c) => `Salaire ${r} dans le canton ${c}`,
    lede: (r, c, g, n) => `Salaire médian brut de ${r} dans le canton ${c} : ${g}/an, environ ${n}/mois net estimé pour un frontalier célibataire.`,
    tileGrossYear: 'Médian brut / an',
    tileGrossMonth: 'Médian brut / mois',
    tileNetMonth: 'Net mensuel estimé',
    tileRange: 'Fourchette indicative (junior–senior)',
    netHeading: 'Ce qu’il reste net',
    netExplain: (r, c, n) => `Sur un salaire médian brut de ${r} dans le canton ${c}, le net mensuel estimé pour un frontalier célibataire est d’environ ${n}, après impôt à la source cantonal (données ESTV) et charges sociales suisses. Le net réel dépend de la situation familiale, de la commune et de l’accord fiscal Italie-Suisse 2024.`,
    compareHeading: (r) => `Salaire ${r} : comparaison entre régions suisses`,
    compareColRegion: 'Canton de référence',
    compareColGross: 'Brut / an',
    compareColNet: 'Net / mois (est.)',
    thisCanton: (c) => `Canton ${c} (cette page)`,
    jobsHeading: (r, c) => `Offres actives pour ${r} dans le canton ${c}`,
    jobsIntro: (n, r, c) => `${n} offres réelles pour ${r} dans le canton ${c}, d’employeurs suisses.`,
    jobPostedDays: (d) => (d <= 0 ? 'aujourd’hui' : d === 1 ? 'il y a 1 jour' : `il y a ${d} jours`),
    jobsCta: (r, c) => `Voir toutes les offres de ${r} dans le canton ${c}`,
    hubsHeading: 'Aller plus loin',
    hubCanton: (c) => `Tous les salaires dans le canton ${c}`,
    hubProfession: (r) => `Guide du métier : ${r}`,
    hubCalc: 'Calculez votre net frontalier',
    methodologyHeading: 'Méthodologie et sources',
    methodology: (r, c) => `Le médian brut pour ${r} dérive du médian réel du corpus d’offres tessinois, mis à l’échelle du niveau salarial du canton ${c} (médian OFS de la grande région, LSE 2024). Le net utilise la courbe d’impôt à la source cantonal ESTV 2024 plus les charges sociales suisses. Les chiffres sont des estimations indicatives, actualisées à chaque build sur des données réelles.`,
    perYear: '/an',
    perMonth: '/mois',
    breadcrumbHome: 'Accueil',
    breadcrumbSalary: 'Salaires',
    metaTitle: (r, c, g) => `Salaire ${r} canton ${c} — brut ${g} et net`,
    metaDesc: (r, c, g, n) => `Combien gagne ${r} dans le canton ${c} : médian brut ${g}/an, net estimé ${n}/mois, comparaison régionale et offres actives. Sources OFS et ESTV.`,
  },
};

interface BridgeCopy {
  title: (role: string, canton: string) => string;
  body: (role: string, canton: string) => string;
  cta: (canton: string) => string;
}

const BRIDGE_COPY: Record<ProfessionLocale, BridgeCopy> = {
  it: {
    title: (r, c) => `Stipendio ${r} Canton ${c}`,
    body: (r, c) => `Al momento non ci sono abbastanza dati sulle offerte per ${r} nel Canton ${c} da mostrare una pagina di stipendio dedicata. Consulta gli stipendi nel Canton ${c}.`,
    cta: (c) => `Vai agli stipendi del Canton ${c}`,
  },
  en: {
    title: (r, c) => `${r} salary in Canton ${c}`,
    body: (r, c) => `There isn't enough ${r} job data in Canton ${c} right now for a dedicated salary page. See salaries for Canton ${c}.`,
    cta: (c) => `Go to Canton ${c} salaries`,
  },
  de: {
    title: (r, c) => `${r}-Lohn im Kanton ${c}`,
    body: (r, c) => `Im Kanton ${c} gibt es derzeit nicht genug ${r}-Stellendaten fur eine eigene Lohnseite. Lohne im Kanton ${c} ansehen.`,
    cta: (c) => `Zu den Lohnen im Kanton ${c}`,
  },
  fr: {
    title: (r, c) => `Salaire ${r} dans le canton ${c}`,
    body: (r, c) => `Il n'y a pas assez de donnees d'offres pour ${r} dans le canton ${c} pour une page de salaire dediee actuellement. Consultez les salaires du canton ${c}.`,
    cta: (c) => `Voir les salaires du canton ${c}`,
  },
};

/**
 * Below-floor bridge: a (canton, profession) pair below MIN_JOBS this build gets
 * a noindex,follow bridge to the always-live canton salary-stats hub instead of
 * a hard 404 (a prior build may have emitted+indexed this exact URL when it met
 * the floor). Same shared-bridge mechanism as professionCantonLandings.
 */
function renderBelowFloorBridge(locale: ProfessionLocale, cantonKey: string, id: AnyProfessionId, preset: MedianPreset | undefined): string {
  const cantonName = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
  const role = professionLabel(locale, preset, id);
  const copy = BRIDGE_COPY[locale];
  return renderSalaryStatsBridge(locale, cantonKey, {
    title: copy.title(role, cantonName),
    description: copy.body(role, cantonName),
    ctaLabel: copy.cta(cantonName),
  });
}

/** Map a corpus FeaturedJob into the permissive JobInput shape for JSON-LD. */
function featuredToJobInput(job: FeaturedJob) {
  return {
    id: job.id,
    slug: job.slug,
    title: job.title,
    titleByLocale: job.titleByLocale,
    company: job.company,
    companyKey: job.companyKey,
    companyDomain: job.companyDomain,
    addressLocality: job.addressLocality ?? job.city ?? null,
    canton: job.canton,
    postedDate: job.postedDate,
    employmentType: job.employmentType,
    contract: job.contract,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    url: job.url,
  };
}

/** Canonical detail-page URL for a featured job in the target locale. */
function jobDetailUrl(job: FeaturedJob, locale: ProfessionLocale, cantonKey: string): string {
  const code = normalizeCantonCode(job.canton) || factorCode(cantonKey);
  const section = resolveCantonSection(locale as CantonSeoLocale, code);
  const slug = job.slugByLocale[locale] ?? job.slug;
  const rel = `${PROFESSION_LOCALE_PREFIX[locale]}/${section}/${slug}/`.replace(/\/+/g, '/');
  return `${BASE_URL}${rel}`;
}

export function renderSalaryProfessionCantonPage(opts: {
  locale: ProfessionLocale;
  cantonKey: string;
  id: AnyProfessionId;
  preset: MedianPreset;
  snapshot: ProfessionJobsSnapshot;
  distDir: string;
}): { html: string; words: number } {
  const { locale, cantonKey, id, preset, snapshot, distDir } = opts;
  const c = COPY[locale];
  const cantonName = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
  const role = professionLabel(locale, preset, id);
  const canonicalPath = buildSalaryProfessionCantonPath(locale, cantonKey, id);
  const homeHref = locale === 'it' ? '/' : `${PROFESSION_LOCALE_PREFIX[locale]}/`;
  const code = factorCode(cantonKey);

  const grossAnnual = scaledGrossAnnual(preset.medianSalaryChf, code);
  const netMonth = netMonthly(grossAnnual, code);
  const rangeLow = round1000(grossAnnual * 0.85);
  const rangeHigh = round1000(grossAnnual * 1.18);

  const grossYearStr = `CHF ${fmtChf(grossAnnual, locale)}`;
  const grossMonthStr = `CHF ${fmtChf(Math.round(grossAnnual / 12), locale)}`;
  const netMonthStr = `CHF ${fmtChf(netMonth, locale)}`;

  const calcHref = CALC_HREF[locale];
  const jobIntentHref = buildProfessionCantonPath(locale, cantonKey, id);
  const cantonSalaryHref = buildSalaryStatsPath(locale, SALARY_STATS_CANTON_SLUGS[cantonKey][locale]);
  const professionHref = buildProfessionLandingPath(locale, id as ProfessionId);

  const breadcrumb = `<nav aria-label="breadcrumb" class="${BREADCRUMB_CLASS}">
  <a href="${homeHref}" class="${BREADCRUMB_LINK_CLASS}">${esc(c.breadcrumbHome)}</a>
  <span aria-hidden="true">›</span>
  <a href="${esc(cantonSalaryHref)}" class="${BREADCRUMB_LINK_CLASS}">${esc(c.breadcrumbSalary)}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${esc(role)} · ${esc(cantonName)}</span>
</nav>`;

  // ── Terza istanza della stessa collisione, trovata dal sibling-check ───
  //
  // Identica a professionCantonLandings.ts / professionCityLandings.ts: il
  // secondo candidato del `<title>` e' `BRIDGE_COPY[locale].title`, e qui
  // coincide con `COPY[locale].h1` su TRE locali su quattro, non due:
  //
  //   en   `${r} salary in Canton ${c}`        ==  bridge title
  //   de   `${r}-Lohn im Kanton ${c}`          ==  bridge title
  //   fr   `Salaire ${r} dans le canton ${c}`  ==  bridge title
  //   it   `Stipendio ${r} nel Canton ${c}`    vs  `Stipendio ${r} Canton ${c}`
  //
  // E il `metaTitle` di questa famiglia e' il piu' lungo di tutte
  // («— lordo {grossYear} e netto»), quindi e' anche quella che raggiunge il
  // fallback piu' spesso. Il gemello `salaryStatsChCantonPages.ts` la stessa
  // trappola l'aveva gia' chiusa a modo suo (candidato `${h1} · 2026`);
  // questo file era rimasto indietro.
  //
  // Stesso rimedio degli altri due: titolo prima, H1 differenziato dopo, e
  // solo sull'elemento `<h1>` (breadcrumb e JSON-LD tengono l'headline nudo).
  const pageTitle = composePlaceTitle(
    [c.metaTitle(role, cantonName, grossYearStr), BRIDGE_COPY[locale].title(role, cantonName)],
    TITLE_MAX_CHARS,
    (s) => esc(s).length,
  );
  const h1Display = differentiateH1FromTitle(c.h1(role, cantonName), pageTitle, locale);

  const header = `<header class="sx-hero"><p class="sx-kick text-sm font-semibold text-accent"><span class="lh-emoji" aria-hidden="true">\u{1F4B0}</span>${esc(c.eyebrow)} · ${esc(cantonName)}</p><h1 class="text-2xl sm:text-3xl font-display font-bold text-heading mt-2">${esc(h1Display)}</h1><p class="text-base text-body mt-2 max-w-prose">${esc(c.lede(role, cantonName, grossYearStr, netMonthStr))}</p></header>`;

  const tiles = renderStatGrid([
    { label: c.tileGrossYear, value: grossYearStr, tone: 'accent', href: calcHref },
    { label: c.tileGrossMonth, value: grossMonthStr, tone: 'neutral' },
    { label: c.tileNetMonth, value: `${netMonthStr}${c.perMonth}`, tone: 'success' },
    { label: c.tileRange, value: `CHF ${fmtChf(rangeLow, locale)}–${fmtChf(rangeHigh, locale)}`, tone: 'neutral' },
  ]);

  // Net explanation — the page's unique value vs the job-intent stat tile.
  const netBlock = `<h2 style="${H2_STYLE}">${esc(c.netHeading)}</h2><p style="${BODY_STYLE}">${esc(c.netExplain(role, cantonName, netMonthStr))}</p>`;

  // Cross-canton context — the same profession scaled to one canton per region.
  const currentRegion = CANTON_TO_GROSSREGION[code];
  const compareRows = (Object.keys(REGION_REPRESENTATIVE) as Grossregion[])
    .map((region) => {
      const repKey = REGION_REPRESENTATIVE[region];
      const g = scaledGrossAnnual(preset.medianSalaryChf, repKey);
      const n = netMonthly(g, repKey);
      const isCurrent = region === currentRegion;
      const label = isCurrent ? c.thisCanton(cantonName) : getCantonDisplayName(repKey, locale as CantonDisplayLocale);
      return { g, n, label, isCurrent };
    })
    .sort((a, b) => b.g - a.g);
  const compareBody = compareRows
    .map((row) => `<tr${row.isCurrent ? ' class="font-semibold"' : ''}><td class="${TABLE_CELL_CLASS}">${esc(row.label)}</td><td class="${TABLE_CELL_CLASS}">CHF ${fmtChf(row.g, locale)}</td><td class="${TABLE_CELL_CLASS}">CHF ${fmtChf(row.n, locale)}</td></tr>`)
    .join('');
  const compareTable = `<h2 style="${H2_STYLE}">${esc(c.compareHeading(role))}</h2>
<div class="overflow-x-auto"><table class="${TABLE_CLASS}"><thead><tr><th class="${TABLE_HEAD_CLASS}">${esc(c.compareColRegion)}</th><th class="${TABLE_HEAD_CLASS}">${esc(c.compareColGross)}</th><th class="${TABLE_HEAD_CLASS}">${esc(c.compareColNet)}</th></tr></thead><tbody>${compareBody}</tbody></table></div>`;

  // Active jobs — up to 3 featured, cards linking to their detail pages + an
  // ItemList of complete JobPosting structured data (Non-Negotiable #3).
  const jobItems = snapshot.featured.slice(0, 3);
  const jobLdItems: Record<string, unknown>[] = [];
  const jobCards: string[] = [];
  for (const job of jobItems) {
    const detailUrl = jobDetailUrl(job, locale, cantonKey);
    const posting = buildListItemJobPosting(featuredToJobInput(job), { locale, url: detailUrl, baseUrl: BASE_URL });
    if (posting) jobLdItems.push(posting);
    const title = stripLiteralMarkdown(job.titleByLocale[locale] ?? job.title ?? '');
    const cityBit = job.city ? ` · ${esc(job.city)}` : '';
    jobCards.push(
      `<li class="${CARD_CLASS}"><a href="${esc(detailUrl)}" class="font-semibold text-heading">${esc(title)}</a><div class="text-sm text-subtle">${esc(job.company)}${cityBit} · ${esc(c.jobPostedDays(job.daysAgo))}</div></li>`,
    );
  }
  const jobsSection = jobCards.length > 0
    ? `<h2 style="${H2_STYLE}">${esc(c.jobsHeading(role, cantonName))}</h2><p style="${BODY_STYLE}">${esc(c.jobsIntro(snapshot.liveCount, role, cantonName))}</p><ul class="grid gap-2 my-3">${jobCards.join('')}</ul>`
    : '';

  const primaryCta = `<p class="my-4"><a href="${esc(jobIntentHref)}" class="${CTA_PRIMARY_CLASS}">${esc(c.jobsCta(role, cantonName))} →</a></p>`;

  const hubs = `<h2 style="${H2_STYLE}">${esc(c.hubsHeading)}</h2>
<ul class="grid gap-2 my-3">
<li class="${CARD_CLASS}"><a href="${esc(cantonSalaryHref)}" class="font-semibold text-heading">${esc(c.hubCanton(cantonName))}</a></li>
<li class="${CARD_CLASS}"><a href="${esc(professionHref)}" class="font-semibold text-heading">${esc(c.hubProfession(role))}</a></li>
<li class="${CARD_CLASS}"><a href="${esc(calcHref)}" class="font-semibold text-heading">${esc(c.hubCalc)}</a></li>
</ul>`;

  const methodology = `<h2 style="${H2_STYLE}">${esc(c.methodologyHeading)}</h2><p style="${BODY_STYLE}">${esc(c.methodology(role, cantonName))}</p>`;
  const sourcesBlock = renderAuthoritativeSourcesHtml(locale, undefined, {
    headingStyle: H2_STYLE,
    list: 'my-2.5 ml-5 list-disc space-y-1.5 text-body',
  });

  // Reuse canton-aware SEO prose (salary-flavoured for slot 'canton-hub') so the
  // page comfortably clears the indexable-words gate and shares one FAQ source.
  const prose = renderCantonSeoProse({
    locale: locale as CantonSeoLocale,
    cantonDisplay: cantonName,
    slot: 'canton-hub',
    entityName: role,
    countHint: snapshot.liveCount,
    ctaHref: cantonSalaryHref,
    ctaLabel: c.hubCanton(cantonName),
  });

  const main = `<div class="cl-fun">${breadcrumb}
${header}
${tiles}
${netBlock}
${compareTable}
${jobsSection}
${primaryCta}
${hubs}
${methodology}
${sourcesBlock}
${prose}${endOfContentMultiplexHtml({ indexable: true })}</div>`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.breadcrumbHome, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 2, name: c.breadcrumbSalary, item: `${BASE_URL}${cantonSalaryHref}` },
      { '@type': 'ListItem', position: 3, name: c.h1(role, cantonName), item: `${BASE_URL}${canonicalPath}` },
    ],
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: buildCantonSeoProseFaqItems({ locale: locale as CantonSeoLocale, cantonDisplay: cantonName, slot: 'canton-hub', entityName: role }),
  };
  const jsonLdScripts = [JSON.stringify(breadcrumbLd), JSON.stringify(faqLd)];
  if (jobLdItems.length > 0) {
    jsonLdScripts.push(JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: jobLdItems.map((item, i) => ({ '@type': 'ListItem', position: i + 1, item })),
    }));
  }

  const hreflangPaths = {
    it: buildSalaryProfessionCantonPath('it', cantonKey, id),
    en: buildSalaryProfessionCantonPath('en', cantonKey, id),
    de: buildSalaryProfessionCantonPath('de', cantonKey, id),
    fr: buildSalaryProfessionCantonPath('fr', cantonKey, id),
  } as HreflangPaths;

  // Budget-aware cascade — sibling of the fix in professionCityLandings.ts /
  // professionCantonLandings.ts / employerProfilePagesPlugin.ts /
  // fiscalMunicipalityPagesPlugin.ts (audit:title-length regression #4593,
  // missed in the original PR pass — surfaced by PR review). `metaTitle`
  // carries the longest suffix of any profession-landing template
  // ("— lordo {g} e netto" / "— gross {g} and net" etc); falls back to the
  // shorter BRIDGE_COPY title (no gross-salary clause) when it would overflow.
  // Calcolato sopra come `pageTitle`, prima dell'header: l'H1 deve confrontarsi
  // con la stringa ESATTA che finisce nel `<title>`.
  const html = buildSeoPageHtml({
    locale,
    title: pageTitle,
    description: c.metaDesc(role, cantonName, grossYearStr, netMonthStr),
    canonicalUrl: `${BASE_URL}${canonicalPath}`,
    hreflangHtml: renderHreflangTags(hreflangPaths),
    bodyHtml: main,
    jsonLdScripts,
    ogLocale: OG_LOCALE[locale],
    robots: 'index,follow',
    distDir,
  });

  return { html, words: countHtmlBodyWords(html) };
}

export interface SalaryProfessionCantonEmitResult {
  pagesWritten: number;
  pagesSkippedForJobs: number;
  pagesSkippedForWordCount: number;
  bridgesWritten: number;
  emittedPaths: string[];
}

function buildSitemap(paths: readonly string[], dateStamp: string): string {
  const entries = paths
    .map((p) => `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILE)) {
      idx = idx.replace('</sitemapindex>', `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_FILE}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`);
    } else {
      idx = idx.replace(
        new RegExp(`(<loc>${BASE_URL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/${SITEMAP_FILE}</loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(</lastmod>)`),
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[salary-profession-cantons] failed to patch sitemap index', err);
  }
}

function removeSitemapFromIndex(distDir: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    const idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILE)) return;
    const cleaned = idx.replace(
      new RegExp(`\\s*<sitemap>\\s*<loc>[^<]*${SITEMAP_FILE}</loc>\\s*<lastmod>[^<]*</lastmod>\\s*</sitemap>`),
      '',
    );
    fs.writeFileSync(indexPath, cleaned, 'utf-8');
  } catch (err) {
    console.warn('[salary-profession-cantons] failed to prune sitemap index', err);
  }
}

export async function emitSalaryProfessionCantonPages(opts: { rootDir: string; distDir: string }): Promise<SalaryProfessionCantonEmitResult> {
  const result: SalaryProfessionCantonEmitResult = { pagesWritten: 0, pagesSkippedForJobs: 0, pagesSkippedForWordCount: 0, bridgesWritten: 0, emittedPaths: [] };
  const byCanton = aggregateProfessionJobsByCanton(opts.rootDir);
  const presets = loadMedianPresets(opts.rootDir);
  const collector = new WriteCollector({ distDir: opts.distDir, pluginName: 'salaryProfessionCantonPages' });

  for (const cantonKey of PROFESSION_CANTON_KEYS) {
    const perProfession = byCanton[cantonKey];
    for (const id of SALARY_PROFESSION_ELIGIBLE_IDS) {
      const preset = presets.get(id);
      const snapshot = perProfession?.[id];
      // Below-floor (no preset / no jobs / under MIN_JOBS): emit a noindex bridge
      // for every locale so a previously-live URL never 404s.
      if (!preset || !snapshot || snapshot.liveCount < MIN_JOBS) {
        result.pagesSkippedForJobs++;
        for (const locale of PROFESSION_LOCALES) {
          const canonicalPath = buildSalaryProfessionCantonPath(locale, cantonKey, id);
          const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderBelowFloorBridge(locale, cantonKey, id, preset));
          result.bridgesWritten++;
        }
        continue;
      }
      // All-or-nothing across the 4-locale hreflang cluster (same guard as the
      // job-intent family): if any locale dips below the words gate, ship none.
      const rendered = PROFESSION_LOCALES.map((locale) => ({
        locale,
        ...renderSalaryProfessionCantonPage({ locale, cantonKey, id, preset, snapshot, distDir: opts.distDir }),
      }));
      if (rendered.some((r) => r.words < MIN_INDEXABLE_WORDS)) {
        result.pagesSkippedForWordCount += PROFESSION_LOCALES.length;
        // Still bridge below the word gate so the URL cluster resolves.
        for (const locale of PROFESSION_LOCALES) {
          const canonicalPath = buildSalaryProfessionCantonPath(locale, cantonKey, id);
          const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderBelowFloorBridge(locale, cantonKey, id, preset));
          result.bridgesWritten++;
        }
        continue;
      }
      for (const r of rendered) {
        const canonicalPath = buildSalaryProfessionCantonPath(r.locale, cantonKey, id);
        const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), r.html);
        result.pagesWritten++;
        result.emittedPaths.push(canonicalPath);
      }
    }
  }

  await collector.flush();

  cleanSitemapFiles(opts.distDir, [SITEMAP_FILE]);
  const dateStamp = buildDayStampIso();
  if (result.emittedPaths.length > 0) {
    fs.writeFileSync(np.join(opts.distDir, SITEMAP_FILE), buildSitemap(result.emittedPaths, dateStamp), 'utf-8');
    patchSitemapIndex(opts.distDir, dateStamp);
  } else {
    removeSitemapFromIndex(opts.distDir);
  }
  return result;
}

export function salaryProfessionCantonPages(rootDir: string): Plugin {
  return {
    name: 'salary-profession-canton-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_SALARY_PROFESSION_CANTONS === '1') {
        resolveSalaryProfessionCantonsFlushed([]);
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      const res = await emitSalaryProfessionCantonPages({ rootDir, distDir });
      // eslint-disable-next-line no-console
      console.log(`[salary-profession-cantons] emitted ${res.pagesWritten} pages, ${res.bridgesWritten} below-floor bridges (${res.pagesSkippedForJobs} pairs below job floor, ${res.pagesSkippedForWordCount} below word gate)`);
      resolveSalaryProfessionCantonsFlushed(res.emittedPaths);
    },
  };
}
