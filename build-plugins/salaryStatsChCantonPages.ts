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
import fs from 'node:fs';
import np from 'node:path';

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { buildDayStampIso } from './shared/buildDayStamp';
import { cleanSitemapFiles } from './shared/distNamespaceCleanup';
import { CALC_HREF } from './shared/calcHref';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import {
  renderCantonSeoProse,
  buildCantonSeoProseFaqItems,
  type CantonSeoLocale,
} from './shared/cantonSeoProse';
import { renderAuthoritativeSourcesHtml } from './shared/authoritativeSources';
import {
  GROSSREGION_MEDIAN_MONTHLY,
  NATIONAL_MEDIAN_MONTHLY,
  CANTON_TO_GROSSREGION,
  cantonNetSalaryBandForCode,
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
  BODY_STYLE,
  H2_STYLE,
  BREADCRUMB_CLASS,
  BREADCRUMB_LINK_CLASS,
  CTA_PRIMARY_CLASS,
  CARD_CLASS,
  STAT_TILE_LABEL_CLASS,
  STAT_TILE_VALUE_CLASS,
  renderStatGrid,
  type StatTileTone,
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

  // Derive the gross band + sector figures from the SAME region median as
  // the headline tile (via cantonKey → BFS code → Grossregion), NOT from the
  // localized display name — the half-canton groups (APPENZELLO/BASILEA) have
  // no bare display form in the index's display→region table, which would
  // silently fall back to national figures and make a single page show
  // inconsistent numbers. Net figures use the real ESTV per-canton
  // withholding curve via cantonNetSalaryBandForCode (see
  // cantonSalaryIndex.cantonGrossSalaryBand for the shared formula and
  // cantonTaxBurdenPct in services/cantonSalary.ts for the SPA-side twin).
  const natScale = monthly / NATIONAL_MEDIAN_MONTHLY;
  const r5000 = (n: number) => Math.round((n * natScale) / 5000) * 5000;
  const r1000 = (n: number) => Math.round((n * natScale) / 1000) * 1000;
  const grossLow = r5000(85000);
  const grossHigh = r5000(110000);
  const band = {
    grossLow,
    grossHigh,
    ...cantonNetSalaryBandForCode(localeFactorCode(cantonKey), grossLow, grossHigh),
  };
  const faq = { it: r1000(95000), finance: r1000(110000), pharma: r1000(105000), retail: r1000(55000) };

  const calcHref = CALC_HREF[locale as CantonSeoLocale];

  const breadcrumb = `<nav aria-label="breadcrumb" class="${BREADCRUMB_CLASS}">
  <a href="${homeHref}" class="${BREADCRUMB_LINK_CLASS}">${esc(c.breadcrumbHome)}</a>
  <span aria-hidden="true">›</span>
  <a href="${homeHref}" class="${BREADCRUMB_LINK_CLASS}">${esc(c.breadcrumbCh)}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${esc(cantonName)}</span>
</nav>`;

  // Hero: soft accent gradient band (`sx-hero`) + animated emoji pill
  // (`sx-kick` + `lh-emoji`, waves under `cl-fun`), mirroring the polished
  // career/profession landings. Replaces the previous unstyled header (the old
  // `class="${H1_STYLE}"` passed a CSS-declaration string into `class=`, which
  // the browser ignored → bare browser-default header).
  const header = `<header class="sx-hero"><p class="sx-kick text-sm font-semibold text-accent"><span class="lh-emoji" aria-hidden="true">📊</span>${esc(c.eyebrow)} · ${esc(cantonName)}</p><h1 class="text-2xl sm:text-3xl font-display font-bold text-heading mt-2">${esc(c.h1(cantonName))}</h1><p class="text-base text-body mt-2 max-w-prose">${esc(c.lede(cantonName, monthlyStr))}</p></header>`;

  // Headline stat tiles via the shared `renderStatGrid` (styled `s-XENO3U`
  // grid + tone classes — dark-mode safe, and staggered-rise + hover-pop
  // animated under `cl-fun`). The headline median tile is a tap target to the
  // net-salary calculator (absorbs $dead_click on the most prominent tile);
  // `vs Swiss average` is colored by meaning (green ≥100%, amber below).
  const vsTone: StatTileTone = vsNational >= 100 ? 'success' : 'warning';
  const tiles = renderStatGrid([
    { label: c.tileMedianMonth, value: monthlyStr, tone: 'accent', href: calcHref },
    { label: c.tileMedianYear, value: `CHF ${fmtChf(annual, locale)}`, tone: 'neutral' },
    { label: c.tileVsNational, value: `${vsNational}%`, tone: vsTone },
    { label: c.tileProfBand, value: `CHF ${fmtChf(band.grossLow, locale)}–${fmtChf(band.grossHigh, locale)}`, tone: 'neutral' },
  ]);

  // Sector salaries: a horizontal bar chart (bar width ∝ annual gross, scaled
  // to the top sector) replaces the flat two-column table — instantly readable
  // ranking + a "wow" visual. Bars use the `.s-salbar` atoms (accent gradient,
  // grow-in animation under `cl-fun`) defined in seo-static.css.
  const sectorRows: ReadonlyArray<readonly [string, number, string]> = [
    [c.sectorIt, faq.it, '💻'],
    [c.sectorFinance, faq.finance, '🏦'],
    [c.sectorPharma, faq.pharma, '💊'],
    [c.sectorRetail, faq.retail, '🛍️'],
  ];
  const sectorMax = Math.max(...sectorRows.map(([, val]) => val));
  const sectorBars = sectorRows
    .map(([label, val, emoji]) => {
      const pct = Math.max(10, Math.round((val / sectorMax) * 100));
      return `<div class="my-3">
  <div class="flex items-baseline justify-between gap-3 mb-1"><span class="text-sm font-medium text-body"><span aria-hidden="true">${emoji}</span> ${esc(label)}</span><span class="text-sm font-bold text-heading">CHF ${fmtChf(val, locale)}+</span></div>
  <div class="s-salbar"><span style="width:${pct}%"></span></div>
</div>`;
    })
    .join('');
  const sectorTable = `<h2 style="${H2_STYLE}">${esc(c.sectorHeading)}</h2>
<div class="${CARD_CLASS}" style="margin:0 0 8px">${sectorBars}</div>`;

  // Net salary: two side-by-side metric cards (label + range) instead of a
  // bare table row pair.
  const netSuffix = locale === 'de' ? 'Mt.' : locale === 'it' ? 'mese' : locale === 'fr' ? 'mois' : 'mo';
  const netBlock = `<h2 style="${H2_STYLE}">${esc(c.netHeading)}</h2>
<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 my-2">
  <div class="${CARD_CLASS}"><div class="${STAT_TILE_LABEL_CLASS}"><span aria-hidden="true">👤</span> ${esc(c.netSingle)}</div><div class="${STAT_TILE_VALUE_CLASS}">CHF ${fmtChf(band.netSingleLow, locale)}–${fmtChf(band.netSingleHigh, locale)}<span class="text-sm text-subtle font-semibold">/${netSuffix}</span></div></div>
  <div class="${CARD_CLASS}"><div class="${STAT_TILE_LABEL_CLASS}"><span aria-hidden="true">👨‍👩‍👧</span> ${esc(c.netCouple)}</div><div class="${STAT_TILE_VALUE_CLASS}">CHF ${fmtChf(band.netCoupleLow, locale)}–${fmtChf(band.netCoupleHigh, locale)}<span class="text-sm text-subtle font-semibold">/${netSuffix}</span></div></div>
</div>`;

  const methodology = `<h2 style="${H2_STYLE}">${esc(c.methodologyHeading)}</h2><p style="${BODY_STYLE}">${esc(c.methodology(cantonName))}</p>`;

  // EEAT (#3515): the methodology paragraph cites BFS/LSE and the 2024 tax
  // agreement textually — link the actual primary sources right below it.
  const sourcesBlock = renderAuthoritativeSourcesHtml(locale, undefined, {
    headingStyle: H2_STYLE,
    list: 'my-2.5 ml-5 list-disc space-y-1.5 text-body',
  });

  const cta = `<p class="my-4"><a href="${esc(calcHref)}" class="${CTA_PRIMARY_CLASS}">${esc(c.cta)} →</a></p>`;

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

  // `cl-fun` wrapper turns on the shared micro-interaction layer (tile rise +
  // hover pop, CTA glow, emoji wave, FAQ chevron) — all gated behind
  // `prefers-reduced-motion: reduce` in seo-static.css.
  const main = `<div class="cl-fun">${breadcrumb}
${header}
${tiles}
${sectorTable}
${netBlock}
${cta}
${methodology}
${sourcesBlock}
${prose}</div>`;

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
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: { '@type': 'Organization', name: 'Bundesamt für Statistik (BFS)', url: 'https://www.bfs.admin.ch' },
    spatialCoverage: { '@type': 'Place', name: `${cantonName}, ${c.breadcrumbCh}`, address: { '@type': 'PostalAddress', addressCountry: 'CH' } },
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

  // hreflang cluster: this canton's 4 locale variants + x-default (it).
  const hreflangPaths = {
    it: buildSalaryStatsPath('it', SALARY_STATS_CANTON_SLUGS[cantonKey].it),
    en: buildSalaryStatsPath('en', SALARY_STATS_CANTON_SLUGS[cantonKey].en),
    de: buildSalaryStatsPath('de', SALARY_STATS_CANTON_SLUGS[cantonKey].de),
    fr: buildSalaryStatsPath('fr', SALARY_STATS_CANTON_SLUGS[cantonKey].fr),
  } as HreflangPaths;

  const html = buildSeoPageHtml({
    locale,
    title: c.metaTitle(cantonName),
    description: c.metaDesc(cantonName, monthlyStr),
    canonicalUrl: `${BASE_URL}${canonicalPath}`,
    hreflangHtml: renderHreflangTags(hreflangPaths),
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
  /** Canonical paths actually written (index,follow) — feed the sitemap. */
  emittedPaths: string[];
}

const SITEMAP_FILE = 'sitemap-salary-stats.xml';

/** Build the sitemap-salary-stats.xml body from the emitted canonical paths. */
function buildSalaryStatsSitemap(paths: readonly string[], dateStamp: string): string {
  const entries = paths
    .map(
      (p) =>
        `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

/** Add (or refresh the lastmod of) sitemap-salary-stats.xml in the sitemap index. */
function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILE)) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_FILE}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        new RegExp(`(<loc>${BASE_URL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/${SITEMAP_FILE}</loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(</lastmod>)`),
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[salary-stats] failed to patch sitemap index', err);
  }
}

export async function emitChCantonSalaryStatsPages(opts: {
  distDir: string;
}): Promise<SalaryStatsEmitResult> {
  const result: SalaryStatsEmitResult = { pagesWritten: 0, pagesSkippedForWordCount: 0, emittedPaths: [] };
  const collector = new WriteCollector({ distDir: opts.distDir, pluginName: 'salaryStatsChCantonPages' });

  for (const locale of SALARY_STATS_LOCALES) {
    for (const cantonKey of SALARY_STATS_CANTON_KEYS) {
      const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
      const { html, words } = renderSalaryStatsPage({ locale, cantonKey, cantonSlug, distDir: opts.distDir });
      if (words < MIN_INDEXABLE_WORDS) {
        result.pagesSkippedForWordCount++;
        continue;
      }
      const canonicalPath = buildSalaryStatsPath(locale, cantonSlug);
      const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
      collector.add(np.join(outDir, 'index.html'), html);
      result.pagesWritten++;
      result.emittedPaths.push(canonicalPath);
    }
  }

  await collector.flush();

  // Sitemap: write sitemap-salary-stats.xml + register it in the index, like
  // the sibling canton-landing families (jobMarketSnapshot / healthPremiums /
  // fuelDaily). Without this the index,follow pages never enter any sitemap.
  cleanSitemapFiles(opts.distDir, [SITEMAP_FILE]);
  if (result.emittedPaths.length > 0) {
    const dateStamp = buildDayStampIso();
    fs.writeFileSync(
      np.join(opts.distDir, SITEMAP_FILE),
      buildSalaryStatsSitemap(result.emittedPaths, dateStamp),
      'utf-8',
    );
    patchSitemapIndex(opts.distDir, dateStamp);
  }

  return result;
}

export function salaryStatsChCantonPages(rootDir: string): Plugin {
  return {
    name: 'salary-stats-ch-canton-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_SALARY_STATS === '1') return;
      const distDir = np.resolve(rootDir, 'dist');
      const res = await emitChCantonSalaryStatsPages({ distDir });
      // eslint-disable-next-line no-console
      console.log(`[salary-stats] emitted ${res.pagesWritten} pages (${res.pagesSkippedForWordCount} skipped for word count)`);
    },
  };
}
