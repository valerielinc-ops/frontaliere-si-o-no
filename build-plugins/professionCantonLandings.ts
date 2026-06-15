/**
 * professionCantonLandings.ts — per-canton profession landing pages.
 *
 * Emits `/lavoro-{canton}-{role}/` (+ /en/jobs-, /de/arbeit-, /fr/travail-) for
 * each (canton, profession) pair that has at least MIN_JOBS real active jobs in
 * the corpus. Each page is data-driven from data/jobs.json via
 * aggregateProfessionJobsByCanton: REAL local top employers, real median salary
 * (corpus), live counts — plus the canton-aware SEO prose. The job-count gate
 * keeps thin/empty pages from being emitted (CLAUDE.md non-negotiable #4), so
 * only profession×canton pairs with genuine local demand ship.
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
} from './shared/cantonSalaryIndex';
import {
  aggregateProfessionJobsByCanton,
  type ProfessionJobsSnapshot,
} from './professionJobsAggregate';
import {
  PROFESSION_IDS,
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  professionRoleKeyword,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import {
  SALARY_STATS_CANTON_SLUGS,
  SALARY_STATS_FACTOR_CODE,
} from './salaryStatsData';
import { buildProfessionCantonPath, PROFESSION_CANTON_KEYS } from './professionCantonData';
import {
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
} from './shared/seoContentTokens';

/** Minimum real active jobs for a (canton, profession) page to be emitted. */
const MIN_JOBS = 3;
const SITEMAP_FILE = 'sitemap-profession-cantons.xml';

const OG_LOCALE: Record<ProfessionLocale, string> = {
  it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH',
};

/** Localised profession label (Title-cased role keyword is good enough). */
function professionLabel(locale: ProfessionLocale, id: ProfessionId): string {
  const role = professionRoleKeyword(locale, id).replace(/-/g, ' ');
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface Copy {
  eyebrow: string;
  h1: (role: string, canton: string) => string;
  lede: (count: number, role: string, canton: string) => string;
  tileLive: string;
  tileFresh: string;
  tileMedian: string;
  employersHeading: (canton: string) => string;
  noSalary: string;
  cta: (canton: string) => string;
  breadcrumbHome: string;
  breadcrumbCh: string;
  metaTitle: (role: string, canton: string) => string;
  metaDesc: (count: number, role: string, canton: string) => string;
  perYear: string;
}

const COPY: Record<ProfessionLocale, Copy> = {
  it: {
    eyebrow: 'Offerte di lavoro per professione',
    h1: (r, c) => `Lavoro come ${r} nel Canton ${c}`,
    lede: (n, r, c) => `${n} offerte attive per ${r} nel Canton ${c}, da datori di lavoro svizzeri reali.`,
    tileLive: 'Offerte attive',
    tileFresh: 'Pubblicate (30 gg)',
    tileMedian: 'Stipendio mediano lordo/anno',
    employersHeading: (c) => `Chi assume nel Canton ${c}`,
    noSalary: 'n/d',
    cta: (c) => `Vedi tutte le offerte nel Canton ${c}`,
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Svizzera',
    metaTitle: (r, c) => `Lavoro ${r} Canton ${c} — offerte e stipendio`,
    metaDesc: (n, r, c) => `${n} offerte per ${r} nel Canton ${c}: datori reali, stipendio mediano e candidatura diretta. Aggiornato ogni 12 ore.`,
    perYear: '/anno',
  },
  en: {
    eyebrow: 'Jobs by profession',
    h1: (r, c) => `${r} jobs in Canton ${c}`,
    lede: (n, r, c) => `${n} active ${r} openings in Canton ${c}, from real Swiss employers.`,
    tileLive: 'Active openings',
    tileFresh: 'Posted (30 days)',
    tileMedian: 'Median gross salary/year',
    employersHeading: (c) => `Who is hiring in Canton ${c}`,
    noSalary: 'n/a',
    cta: (c) => `See all openings in Canton ${c}`,
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Switzerland',
    metaTitle: (r, c) => `${r} jobs Canton ${c} — openings and salary`,
    metaDesc: (n, r, c) => `${n} ${r} openings in Canton ${c}: real employers, median salary and direct apply. Updated every 12 hours.`,
    perYear: '/yr',
  },
  de: {
    eyebrow: 'Stellen nach Beruf',
    h1: (r, c) => `${r}-Stellen im Kanton ${c}`,
    lede: (n, r, c) => `${n} aktive ${r}-Stellen im Kanton ${c}, von echten Schweizer Arbeitgebern.`,
    tileLive: 'Aktive Stellen',
    tileFresh: 'Veröffentlicht (30 Tage)',
    tileMedian: 'Medianlohn brutto/Jahr',
    employersHeading: (c) => `Wer im Kanton ${c} einstellt`,
    noSalary: 'k.A.',
    cta: (c) => `Alle Stellen im Kanton ${c} ansehen`,
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Schweiz',
    metaTitle: (r, c) => `${r} Stellen Kanton ${c} — Angebote und Lohn`,
    metaDesc: (n, r, c) => `${n} ${r}-Stellen im Kanton ${c}: echte Arbeitgeber, Medianlohn und Direktbewerbung. Alle 12 Stunden aktualisiert.`,
    perYear: '/Jahr',
  },
  fr: {
    eyebrow: 'Emplois par profession',
    h1: (r, c) => `Emploi ${r} dans le canton ${c}`,
    lede: (n, r, c) => `${n} offres actives pour ${r} dans le canton ${c}, d'employeurs suisses réels.`,
    tileLive: 'Offres actives',
    tileFresh: 'Publiées (30 j)',
    tileMedian: 'Salaire médian brut/an',
    employersHeading: (c) => `Qui recrute dans le canton ${c}`,
    noSalary: 'n/d',
    cta: (c) => `Voir toutes les offres dans le canton ${c}`,
    breadcrumbHome: 'Accueil',
    breadcrumbCh: 'Suisse',
    metaTitle: (r, c) => `Emploi ${r} canton ${c} — offres et salaire`,
    metaDesc: (n, r, c) => `${n} offres ${r} dans le canton ${c} : employeurs réels, salaire médian et candidature directe. Mis à jour toutes les 12 heures.`,
    perYear: '/an',
  },
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtChf(n: number, locale: ProfessionLocale): string {
  const sep = locale === 'en' ? ',' : locale === 'fr' ? ' ' : "'";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function cantonAnnualMedian(cantonKey: string): number {
  const code = SALARY_STATS_FACTOR_CODE[cantonKey] ?? cantonKey;
  const region = CANTON_TO_GROSSREGION[code];
  const monthly = region ? GROSSREGION_MEDIAN_MONTHLY[region] : NATIONAL_MEDIAN_MONTHLY;
  return monthly * 12;
}

export function renderProfessionCantonPage(opts: {
  locale: ProfessionLocale;
  cantonKey: string;
  id: ProfessionId;
  snapshot: ProfessionJobsSnapshot;
  distDir: string;
}): { html: string; words: number } {
  const { locale, cantonKey, id, snapshot, distDir } = opts;
  const c = COPY[locale];
  const cantonName = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
  const role = professionLabel(locale, id);
  const canonicalPath = buildProfessionCantonPath(locale, cantonKey, id);
  const homeHref = locale === 'it' ? '/' : `${PROFESSION_LOCALE_PREFIX[locale]}/`;

  // Real corpus median for this canton+profession; fall back to the canton's
  // BFS annual median when the matched jobs carry no salary data.
  const median = snapshot.medianSalaryChf > 0 ? snapshot.medianSalaryChf : cantonAnnualMedian(cantonKey);
  const medianStr = median > 0 ? `CHF ${fmtChf(median, locale)}` : c.noSalary;

  const breadcrumb = `<nav aria-label="breadcrumb" class="${BREADCRUMB_STYLE}">
  <a href="${homeHref}" class="${BREADCRUMB_LINK_STYLE}">${esc(c.breadcrumbHome)}</a>
  <span aria-hidden="true">›</span>
  <a href="${homeHref}" class="${BREADCRUMB_LINK_STYLE}">${esc(c.breadcrumbCh)}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${esc(role)} · ${esc(cantonName)}</span>
</nav>`;

  const tiles = `<div class="grid grid-cols-3 gap-3 my-4">
  <div class="rounded-xl bg-surface-alt p-3"><div class="text-2xl font-bold text-heading">${snapshot.liveCount}</div><div class="text-xs text-subtle">${esc(c.tileLive)}</div></div>
  <div class="rounded-xl bg-surface-alt p-3"><div class="text-2xl font-bold text-heading">${snapshot.fresh30Count}</div><div class="text-xs text-subtle">${esc(c.tileFresh)}</div></div>
  <div class="rounded-xl bg-surface-alt p-3"><div class="text-2xl font-bold text-heading">${esc(medianStr)}${median > 0 ? `<span class="text-sm">${esc(c.perYear)}</span>` : ''}</div><div class="text-xs text-subtle">${esc(c.tileMedian)}</div></div>
</div>`;

  const employers = snapshot.topEmployers.length > 0
    ? `<h2 class="${H2_STYLE}">${esc(c.employersHeading(cantonName))}</h2>
<ul class="flex flex-wrap gap-2 my-2">${snapshot.topEmployers
        .map((e) => `<li class="rounded-full bg-surface-alt px-3 py-1 text-sm">${esc(e.name)} <span class="text-subtle">(${e.count})</span></li>`)
        .join('')}</ul>`
    : '';

  const roleKw = professionRoleKeyword(locale, id);
  const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
  // Link to the per-canton salary stats landing (shipped in PR #2085) + the
  // job board filtered by this role.
  const ctaHref = `${PROFESSION_LOCALE_PREFIX[locale]}/${locale === 'it' ? 'stipendi' : locale === 'en' ? 'salaries' : locale === 'de' ? 'gehaelter' : 'salaires'}-${cantonSlug}/`.replace(/\/{2,}/g, '/');

  const prose = renderCantonSeoProse({
    locale: locale as CantonSeoLocale,
    cantonDisplay: cantonName,
    slot: 'canton-hub',
    entityName: role,
    countHint: snapshot.liveCount,
    ctaHref,
    ctaLabel: c.cta(cantonName),
  });

  const main = `${breadcrumb}
<header><p class="${HERO_EYEBROW_STYLE}">${esc(c.eyebrow)}</p><h1 class="${H1_STYLE}">${esc(c.h1(role, cantonName))}</h1><p class="${LEDE_STYLE}">${esc(c.lede(snapshot.liveCount, role, cantonName))}</p></header>
${tiles}
${employers}
<p class="${BODY_STYLE}"><a href="${esc(ctaHref)}" class="inline-block rounded-lg bg-info text-white px-4 py-2 font-medium">${esc(c.cta(cantonName))} →</a></p>
${prose}`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.breadcrumbHome, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 2, name: c.breadcrumbCh, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 3, name: c.h1(role, cantonName), item: `${BASE_URL}${canonicalPath}` },
    ],
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: buildCantonSeoProseFaqItems({ locale: locale as CantonSeoLocale, cantonDisplay: cantonName, slot: 'canton-hub' }),
  };

  const hreflangPaths = {
    it: buildProfessionCantonPath('it', cantonKey, id),
    en: buildProfessionCantonPath('en', cantonKey, id),
    de: buildProfessionCantonPath('de', cantonKey, id),
    fr: buildProfessionCantonPath('fr', cantonKey, id),
  } as HreflangPaths;

  const html = buildSeoPageHtml({
    locale,
    title: c.metaTitle(role, cantonName),
    description: c.metaDesc(snapshot.liveCount, role, cantonName),
    canonicalUrl: `${BASE_URL}${canonicalPath}`,
    hreflangHtml: renderHreflangTags(hreflangPaths),
    bodyHtml: main,
    jsonLdScripts: [JSON.stringify(breadcrumbLd), JSON.stringify(faqLd)],
    ogLocale: OG_LOCALE[locale],
    robots: 'index,follow',
    distDir,
  });

  return { html, words: countHtmlBodyWords(html) };
}

export interface ProfessionCantonEmitResult {
  pagesWritten: number;
  pagesSkippedForJobs: number;
  pagesSkippedForWordCount: number;
  emittedPaths: string[];
}

function buildSitemap(paths: readonly string[], dateStamp: string): string {
  const entries = paths
    .map((p) => `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`)
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
    console.warn('[profession-cantons] failed to patch sitemap index', err);
  }
}

export async function emitProfessionCantonPages(opts: { rootDir: string; distDir: string }): Promise<ProfessionCantonEmitResult> {
  const result: ProfessionCantonEmitResult = { pagesWritten: 0, pagesSkippedForJobs: 0, pagesSkippedForWordCount: 0, emittedPaths: [] };
  const byCanton = aggregateProfessionJobsByCanton(opts.rootDir);
  const collector = new WriteCollector({ distDir: opts.distDir, pluginName: 'professionCantonLandings' });

  for (const cantonKey of PROFESSION_CANTON_KEYS) {
    const perProfession = byCanton[cantonKey];
    if (!perProfession) continue;
    for (const id of PROFESSION_IDS) {
      const snapshot = perProfession[id];
      if (!snapshot || snapshot.liveCount < MIN_JOBS) {
        result.pagesSkippedForJobs++;
        continue;
      }
      for (const locale of PROFESSION_LOCALES) {
        const { html, words } = renderProfessionCantonPage({ locale, cantonKey, id, snapshot, distDir: opts.distDir });
        if (words < MIN_INDEXABLE_WORDS) {
          result.pagesSkippedForWordCount++;
          continue;
        }
        const canonicalPath = buildProfessionCantonPath(locale, cantonKey, id);
        const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        result.pagesWritten++;
        result.emittedPaths.push(canonicalPath);
      }
    }
  }

  await collector.flush();

  cleanSitemapFiles(opts.distDir, [SITEMAP_FILE]);
  if (result.emittedPaths.length > 0) {
    const dateStamp = buildDayStampIso();
    fs.writeFileSync(np.join(opts.distDir, SITEMAP_FILE), buildSitemap(result.emittedPaths, dateStamp), 'utf-8');
    patchSitemapIndex(opts.distDir, dateStamp);
  }
  return result;
}

export function professionCantonLandings(rootDir: string): Plugin {
  return {
    name: 'profession-canton-landings',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_PROFESSION_CANTONS === '1') return;
      const distDir = np.resolve(rootDir, 'dist');
      const res = await emitProfessionCantonPages({ rootDir, distDir });
      // eslint-disable-next-line no-console
      console.log(`[profession-cantons] emitted ${res.pagesWritten} pages (${res.pagesSkippedForJobs} pairs below job floor, ${res.pagesSkippedForWordCount} below word gate)`);
    },
  };
}
