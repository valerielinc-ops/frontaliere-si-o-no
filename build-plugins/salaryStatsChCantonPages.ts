/**
 * salaryStatsChCantonPages.ts — per-canton salary statistics SEO landings.
 *
 * Emits one static page per (canton, locale) at e.g. `/stipendi-zurigo/`,
 * `/en/salaries-zurich/`, … Each page presents the canton's salary level from
 * the official BFS LSE Grossregion median (data/swiss-canton-salary-index.json,
 * via build-plugins/shared/cantonSalaryIndex) plus sector/net bands scaled to
 * that canton, the canton-aware SEO prose + FAQ, and a CTA to the net-salary
 * calculator.
 *
 * Plugin contract: apply 'build', enforce 'post', emit in closeBundle(),
 * distDir passed through. Pure/deterministic so output is stable.
 */
import type { Plugin } from 'vite';

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { CALC_HREF } from './shared/calcHref';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import {
  renderCantonSeoProse,
  buildCantonSeoProseFaqItems,
  type CantonSeoLocale,
} from './shared/cantonSeoProse';
import {
  GROSSREGION_MEDIAN_MONTHLY,
  NATIONAL_MEDIAN_MONTHLY,
  CANTON_TO_GROSSREGION,
  cantonGrossSalaryBand,
  cantonFaqMedianAnnual,
} from './shared/cantonSalaryIndex';
import {
  SALARY_STATS_LOCALES,
  SALARY_STATS_CANTON_KEYS,
  SALARY_STATS_CANTON_SLUGS,
  SALARY_STATS_FACTOR_CODE,
  SALARY_STATS_LOCALE_PREFIX,
  buildSalaryStatsPath,
  type SalaryStatsLocale,
} from './salaryStatsData';
import {
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
} from './shared/seoContentTokens';

const OG_LOCALE: Record<SalaryStatsLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

interface Copy {
  eyebrow: string;
  h1: (canton: string) => string;
  lede: (canton: string, median: string) => string;
  tileMedianMonth: string;
  tileMedianYear: string;
  tileVsNational: string;
  tileProfBand: string;
  sectorHeading: string;
  sectorCol: string;
  sectorAnnual: string;
  netHeading: string;
  netSingle: string;
  netCouple: string;
  methodologyHeading: string;
  methodology: (canton: string) => string;
  cta: string;
  breadcrumbHome: string;
  breadcrumbCh: string;
  metaTitle: (canton: string) => string;
  metaDesc: (canton: string, median: string) => string;
  sectorIt: string;
  sectorFinance: string;
  sectorPharma: string;
  sectorRetail: string;
}

const COPY: Record<SalaryStatsLocale, Copy> = {
  it: {
    eyebrow: 'Statistiche salariali',
    h1: (c) => `Stipendi nel Canton ${c}`,
    lede: (c, m) => `Stipendio mediano lordo in ${c}: ${m}/mese (fonte BFS, rilevazione struttura salari).`,
    tileMedianMonth: 'Mediana lorda / mese',
    tileMedianYear: 'Mediana lorda / anno',
    tileVsNational: 'vs media svizzera',
    tileProfBand: 'Ruolo professionale (lordo/anno)',
    sectorHeading: 'Stipendi per settore (stima per cantone)',
    sectorCol: 'Settore',
    sectorAnnual: 'Lordo annuo indicativo',
    netHeading: 'Netto mensile stimato',
    netSingle: 'Single senza figli',
    netCouple: 'Coppia, due figli',
    methodologyHeading: 'Metodologia e fonti',
    methodology: (c) => `Le cifre per il Canton ${c} derivano dalla mediana salariale ufficiale della Grossregion BFS (Rilevazione svizzera della struttura dei salari, LSE 2024) a cui appartiene il cantone, scalata sui livelli settoriali. La mediana mensile lorda è standardizzata a tempo pieno (4⅓ settimane). Le stime settoriali e nette sono indicative; il netto reale dipende da imposta alla fonte cantonale, contributi sociali e accordo fiscale Italia-Svizzera 2024.`,
    cta: 'Calcola il tuo netto frontaliere',
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Svizzera',
    metaTitle: (c) => `Stipendi Canton ${c} 2026 — mediana e settori (dati BFS)`,
    metaDesc: (c, m) => `Stipendi nel Canton ${c}: mediana lorda ${m}/mese, lordo annuo per settore e netto mensile stimato per frontalieri. Fonte BFS.`,
    sectorIt: 'IT / Software',
    sectorFinance: 'Banca / Finanza',
    sectorPharma: 'Pharma',
    sectorRetail: 'Commercio',
  },
  en: {
    eyebrow: 'Salary statistics',
    h1: (c) => `Salaries in Canton ${c}`,
    lede: (c, m) => `Median gross salary in ${c}: ${m}/month (source: BFS earnings structure survey).`,
    tileMedianMonth: 'Median gross / month',
    tileMedianYear: 'Median gross / year',
    tileVsNational: 'vs Swiss average',
    tileProfBand: 'Professional role (gross/year)',
    sectorHeading: 'Salaries by sector (canton estimate)',
    sectorCol: 'Sector',
    sectorAnnual: 'Indicative annual gross',
    netHeading: 'Estimated monthly net',
    netSingle: 'Single, no children',
    netCouple: 'Couple, two children',
    methodologyHeading: 'Methodology and sources',
    methodology: (c) => `Figures for Canton ${c} derive from the official BFS Grossregion salary median (Swiss earnings structure survey, LSE 2024) of the region the canton belongs to, scaled across sector levels. The monthly gross median is full-time standardized (4⅓ weeks). Sector and net estimates are indicative; the real net depends on cantonal source tax, social charges and the 2024 Italy-Switzerland tax agreement.`,
    cta: 'Calculate your cross-border net',
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Switzerland',
    metaTitle: (c) => `Canton ${c} salaries 2026 — median and sectors (BFS data)`,
    metaDesc: (c, m) => `Salaries in Canton ${c}: median gross ${m}/month, annual gross by sector and estimated monthly net for cross-border workers. Source BFS.`,
    sectorIt: 'IT / Software',
    sectorFinance: 'Banking / Finance',
    sectorPharma: 'Pharma',
    sectorRetail: 'Retail',
  },
  de: {
    eyebrow: 'Lohnstatistik',
    h1: (c) => `Löhne im Kanton ${c}`,
    lede: (c, m) => `Medianlohn brutto im Kanton ${c}: ${m}/Monat (Quelle: BFS-Lohnstrukturerhebung).`,
    tileMedianMonth: 'Median brutto / Monat',
    tileMedianYear: 'Median brutto / Jahr',
    tileVsNational: 'vs Schweizer Schnitt',
    tileProfBand: 'Fachrolle (brutto/Jahr)',
    sectorHeading: 'Löhne nach Branche (Kantonsschätzung)',
    sectorCol: 'Branche',
    sectorAnnual: 'Indikativer Jahresbruttolohn',
    netHeading: 'Geschätztes Monatsnetto',
    netSingle: 'Alleinstehend, keine Kinder',
    netCouple: 'Paar, zwei Kinder',
    methodologyHeading: 'Methodik und Quellen',
    methodology: (c) => `Die Werte für den Kanton ${c} leiten sich vom offiziellen BFS-Grossregion-Medianlohn (Lohnstrukturerhebung, LSE 2024) der Region ab, der der Kanton angehört, skaliert über die Branchenniveaus. Der monatliche Bruttomedian ist vollzeitstandardisiert (4⅓ Wochen). Branchen- und Nettoschätzungen sind indikativ; das reale Netto hängt von kantonaler Quellensteuer, Sozialabgaben und dem Steuerabkommen Italien-Schweiz 2024 ab.`,
    cta: 'Grenzgänger-Netto berechnen',
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Schweiz',
    metaTitle: (c) => `Löhne Kanton ${c} 2026 — Median und Branchen (BFS-Daten)`,
    metaDesc: (c, m) => `Löhne im Kanton ${c}: Medianbrutto ${m}/Monat, Jahresbrutto nach Branche und geschätztes Monatsnetto für Grenzgänger. Quelle BFS.`,
    sectorIt: 'IT / Software',
    sectorFinance: 'Bank / Finanzen',
    sectorPharma: 'Pharma',
    sectorRetail: 'Handel',
  },
  fr: {
    eyebrow: 'Statistiques salariales',
    h1: (c) => `Salaires dans le canton ${c}`,
    lede: (c, m) => `Salaire médian brut dans le canton ${c} : ${m}/mois (source : OFS, enquête structure des salaires).`,
    tileMedianMonth: 'Médian brut / mois',
    tileMedianYear: 'Médian brut / an',
    tileVsNational: 'vs moyenne suisse',
    tileProfBand: 'Poste professionnel (brut/an)',
    sectorHeading: 'Salaires par secteur (estimation cantonale)',
    sectorCol: 'Secteur',
    sectorAnnual: 'Brut annuel indicatif',
    netHeading: 'Net mensuel estimé',
    netSingle: 'Célibataire, sans enfants',
    netCouple: 'Couple, deux enfants',
    methodologyHeading: 'Méthodologie et sources',
    methodology: (c) => `Les chiffres du canton ${c} dérivent du salaire médian officiel OFS de la grande région (enquête sur la structure des salaires, LSE 2024) à laquelle appartient le canton, mis à l'échelle des niveaux sectoriels. Le médian mensuel brut est standardisé à plein temps (4⅓ semaines). Les estimations sectorielles et nettes sont indicatives ; le net réel dépend de l'impôt à la source cantonal, des charges sociales et de l'accord fiscal Italie-Suisse 2024.`,
    cta: 'Calculez votre net frontalier',
    breadcrumbHome: 'Accueil',
    breadcrumbCh: 'Suisse',
    metaTitle: (c) => `Salaires canton ${c} 2026 — médian et secteurs (données OFS)`,
    metaDesc: (c, m) => `Salaires dans le canton ${c} : médian brut ${m}/mois, brut annuel par secteur et net mensuel estimé pour frontaliers. Source OFS.`,
    sectorIt: 'IT / Software',
    sectorFinance: 'Banque / Finance',
    sectorPharma: 'Pharma',
    sectorRetail: 'Commerce',
  },
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtChf(n: number, locale: SalaryStatsLocale): string {
  const sep = locale === 'en' ? ',' : locale === 'fr' ? ' ' : "'";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function localeFactorCode(cantonKey: string): string {
  return SALARY_STATS_FACTOR_CODE[cantonKey] ?? cantonKey;
}

function cantonMonthlyMedian(cantonKey: string): number {
  const region = CANTON_TO_GROSSREGION[localeFactorCode(cantonKey)];
  return region ? GROSSREGION_MEDIAN_MONTHLY[region] : NATIONAL_MEDIAN_MONTHLY;
}

export function renderSalaryStatsPage(opts: {
  locale: SalaryStatsLocale;
  cantonKey: string;
  cantonSlug: string;
  distDir: string;
}): { html: string; words: number } {
  const { locale, cantonKey, cantonSlug, distDir } = opts;
  const c = COPY[locale];
  const cantonName = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
  const canonicalPath = buildSalaryStatsPath(locale, cantonSlug);
  const homeHref = locale === 'it' ? '/' : `${SALARY_STATS_LOCALE_PREFIX[locale]}/`;

  const monthly = cantonMonthlyMedian(cantonKey);
  const annual = monthly * 12;
  const vsNational = Math.round((monthly / NATIONAL_MEDIAN_MONTHLY) * 100);
  const monthlyStr = `CHF ${fmtChf(monthly, locale)}`;

  const band = cantonGrossSalaryBand(cantonName);
  const faq = cantonFaqMedianAnnual(cantonName);

  const breadcrumb = `<nav aria-label="breadcrumb" class="${BREADCRUMB_STYLE}">
  <a href="${homeHref}" class="${BREADCRUMB_LINK_STYLE}">${esc(c.breadcrumbHome)}</a>
  <span aria-hidden="true">›</span>
  <a href="${homeHref}" class="${BREADCRUMB_LINK_STYLE}">${esc(c.breadcrumbCh)}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${esc(cantonName)}</span>
</nav>`;

  const tiles = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
  <div class="rounded-xl bg-surface-alt p-3"><div class="text-2xl font-bold text-heading">${esc(monthlyStr)}</div><div class="text-xs text-subtle">${esc(c.tileMedianMonth)}</div></div>
  <div class="rounded-xl bg-surface-alt p-3"><div class="text-2xl font-bold text-heading">CHF ${fmtChf(annual, locale)}</div><div class="text-xs text-subtle">${esc(c.tileMedianYear)}</div></div>
  <div class="rounded-xl bg-surface-alt p-3"><div class="text-2xl font-bold text-heading">${vsNational}%</div><div class="text-xs text-subtle">${esc(c.tileVsNational)}</div></div>
  <div class="rounded-xl bg-surface-alt p-3"><div class="text-2xl font-bold text-heading">CHF ${fmtChf(band.grossLow, locale)}–${fmtChf(band.grossHigh, locale)}</div><div class="text-xs text-subtle">${esc(c.tileProfBand)}</div></div>
</div>`;

  const sectorRows = [
    [c.sectorIt, faq.it],
    [c.sectorFinance, faq.finance],
    [c.sectorPharma, faq.pharma],
    [c.sectorRetail, faq.retail],
  ]
    .map(
      ([label, val]) =>
        `<tr><td class="py-1 pr-4">${esc(label)}</td><td class="py-1 font-semibold text-heading">CHF ${fmtChf(Number(val), locale)}+</td></tr>`,
    )
    .join('');

  const sectorTable = `<h2 class="${H2_STYLE}">${esc(c.sectorHeading)}</h2>
<table class="w-full text-sm my-2"><thead><tr class="text-subtle text-left"><th class="font-medium">${esc(c.sectorCol)}</th><th class="font-medium">${esc(c.sectorAnnual)}</th></tr></thead><tbody>${sectorRows}</tbody></table>`;

  const netBlock = `<h2 class="${H2_STYLE}">${esc(c.netHeading)}</h2>
<table class="w-full text-sm my-2"><tbody>
<tr><td class="py-1 pr-4">${esc(c.netSingle)}</td><td class="py-1 font-semibold text-heading">CHF ${fmtChf(band.netSingleLow, locale)}–${fmtChf(band.netSingleHigh, locale)}/${locale === 'de' ? 'Mt.' : locale === 'it' ? 'mese' : locale === 'fr' ? 'mois' : 'mo'}</td></tr>
<tr><td class="py-1 pr-4">${esc(c.netCouple)}</td><td class="py-1 font-semibold text-heading">CHF ${fmtChf(band.netCoupleLow, locale)}–${fmtChf(band.netCoupleHigh, locale)}</td></tr>
</tbody></table>`;

  const methodology = `<h2 class="${H2_STYLE}">${esc(c.methodologyHeading)}</h2><p class="${BODY_STYLE}">${esc(c.methodology(cantonName))}</p>`;

  const calcHref = CALC_HREF[locale as CantonSeoLocale];
  const cta = `<p class="my-4"><a href="${esc(calcHref)}" class="inline-block rounded-lg bg-info text-white px-4 py-2 font-medium">${esc(c.cta)} →</a></p>`;

  // Reuse the canton-aware SEO prose (already carries per-canton salary copy +
  // FAQ) so the page comfortably clears the indexable-words gate and shares one
  // FAQ source with the rest of the cathedral.
  const prose = renderCantonSeoProse({
    locale: locale as CantonSeoLocale,
    cantonDisplay: cantonName,
    slot: 'canton-hub',
    ctaHref: canonicalPath,
    ctaLabel: c.cta,
  });

  const main = `${breadcrumb}
<header><p class="${HERO_EYEBROW_STYLE}">${esc(c.eyebrow)}</p><h1 class="${H1_STYLE}">${esc(c.h1(cantonName))}</h1><p class="${LEDE_STYLE}">${esc(c.lede(cantonName, monthlyStr))}</p></header>
${tiles}
${sectorTable}
${netBlock}
${cta}
${methodology}
${prose}`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.breadcrumbHome, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 2, name: c.breadcrumbCh, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 3, name: c.h1(cantonName), item: `${BASE_URL}${canonicalPath}` },
    ],
  };

  const datasetLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: c.metaTitle(cantonName),
    description: c.metaDesc(cantonName, monthlyStr),
    creator: { '@type': 'GovernmentOrganization', name: 'Bundesamt für Statistik (BFS)', url: 'https://www.bfs.admin.ch' },
    spatialCoverage: { '@type': 'AdministrativeArea', name: `Canton ${cantonName}, Switzerland` },
    variableMeasured: 'Gross monthly salary (median)',
    measurementTechnique: 'BFS Lohnstrukturerhebung (LSE) 2024, Grossregion median',
    url: `${BASE_URL}${canonicalPath}`,
  };

  const faqItems = buildCantonSeoProseFaqItems({
    locale: locale as CantonSeoLocale,
    cantonDisplay: cantonName,
    slot: 'canton-hub',
  });
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems,
  };

  const html = buildSeoPageHtml({
    locale,
    title: c.metaTitle(cantonName),
    description: c.metaDesc(cantonName, monthlyStr),
    canonicalUrl: `${BASE_URL}${canonicalPath}`,
    bodyHtml: main,
    jsonLdScripts: [JSON.stringify(breadcrumbLd), JSON.stringify(datasetLd), JSON.stringify(faqLd)],
    ogLocale: OG_LOCALE[locale],
    robots: 'index,follow',
    distDir,
  });

  return { html, words: countHtmlBodyWords(html) };
}

export interface SalaryStatsEmitResult {
  pagesWritten: number;
  pagesSkippedForWordCount: number;
}

export async function emitChCantonSalaryStatsPages(opts: {
  distDir: string;
}): Promise<SalaryStatsEmitResult> {
  const result: SalaryStatsEmitResult = { pagesWritten: 0, pagesSkippedForWordCount: 0 };
  const collector = new WriteCollector({ distDir: opts.distDir, pluginName: 'salaryStatsChCantonPages' });
  const npMod = await import('node:path');

  for (const locale of SALARY_STATS_LOCALES) {
    for (const cantonKey of SALARY_STATS_CANTON_KEYS) {
      const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
      const { html, words } = renderSalaryStatsPage({ locale, cantonKey, cantonSlug, distDir: opts.distDir });
      if (words < MIN_INDEXABLE_WORDS) {
        result.pagesSkippedForWordCount++;
        continue;
      }
      const canonicalPath = buildSalaryStatsPath(locale, cantonSlug);
      const outDir = npMod.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
      collector.add(npMod.join(outDir, 'index.html'), html);
      result.pagesWritten++;
    }
  }

  await collector.flush();
  return result;
}

export function salaryStatsChCantonPages(rootDir: string): Plugin {
  return {
    name: 'salary-stats-ch-canton-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_SALARY_STATS === '1') return;
      const npMod = await import('node:path');
      const distDir = npMod.resolve(rootDir, 'dist');
      const res = await emitChCantonSalaryStatsPages({ distDir });
      // eslint-disable-next-line no-console
      console.log(`[salary-stats] emitted ${res.pagesWritten} pages (${res.pagesSkippedForWordCount} skipped for word count)`);
    },
  };
}
