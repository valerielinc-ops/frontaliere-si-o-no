/**
 * Career quick-win SEO landings (AE-2) — Vite build plugin, template B.
 *
 * Emits 16 static HTML pages (4 IT canonicals × 4 locales). The 2026-05
 * redesign inverts the previous layout to match the mobile-first contract in
 * CLAUDE.md regola #17 (75% of traffic is mobile):
 *
 *   1. breadcrumb
 *   2. header (eyebrow · H1 · 1-line denseLede ≤120 chars)
 *   3. 3 stat tiles (per-id labels + snapshot-driven values)
 *   4. primary CTA → calculator / job-board
 *   5. featured live jobs (when applicable — concorsi + stage)
 *   6. employer grid (when applicable — agenzie + concorsi)
 *      OR curated editorial replacement (stage + contratti)
 *   7. ─── "Approfondisci" divider ───
 *   8. long-form lede + 7 H2 prose sections (existing copy)
 *   9. sources · FAQ · related · final CTAs
 *
 *   IT canonical                        EN / DE / FR variants
 *   /agenzie-del-lavoro-lugano/         /en/staffing-agencies-lugano/ …
 *   /concorsi-pubblici-lugano/          /en/public-sector-jobs-lugano/ …
 *   /stage-lugano/                      /en/internships-lugano/ …
 *   /contratti-lavoro-frontalieri/      /en/cross-border-work-contracts/ …
 *
 * Live signal comes from `careerJobsAggregate` (build-time read of
 * `data/jobs.json` + `data/seco-staffing-registry.json` +
 * `data/seo/concorsi-ti.json`). The editorial copy in `careerLandingsCopy`
 * stays unchanged — the long-form prose just moves below the divider.
 *
 * JSON-LD: BreadcrumbList + FAQPage + Article (locale-tagged).
 * Hub chrome: `{ hubKey: 'job-board', activeSubTab: 'jobs' }`.
 * Sitemap: writes `dist/sitemap-career-landings.xml`; `sitemapAliasPlugin`
 * auto-discovers it.
 *
 * Gate: `SKIP_CAREER_LANDINGS=1` fast-exits for local builds only. CI
 * (`npm run build:ci`) always exercises this plugin — exit 0 required.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { formatUpdatedDate } from './shared/humanDate';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import {
  CAREER_LOCALES,
  CAREER_LANDING_IDS,
  buildCareerLandingPath,
  type CareerLocale,
  type CareerLandingId,
} from './careerLandingsData';
import {
  CAREER_LANDING_COPY,
  buildCareerTemplateBCopy,
  getCareerTemplateBShell,
  getCareerCalculatorUrl,
  type CareerLandingCopy,
  type CareerTemplateBCopy,
} from './careerLandingsCopy';
import {
  aggregateCareerLandings,
  buildCareerFeaturedJobUrl,
  buildCareerJobBoardUrl,
  type CareerJobsSnapshot,
  type CareerFeaturedJob,
} from './careerJobsAggregate';
import {
  renderJobCardListHtml,
  type JobCardJob,
} from './shared/jobCardHtml';
import {
  pickEmptyState,
  pickCtaAllJobs,
} from './shared/landingMicroCopy';
import {
  renderEmployerCardListHtml,
  type EmployerCardEmployer,
} from './shared/employerCardHtml';
import {
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  LINK_ACCENT_STYLE,
  HERO_EYEBROW_STYLE,
  SMALL_HEADING_STYLE,
  STAT_TILE_ACCENT,
  STAT_TILE_SUCCESS,
  STAT_TILE_WARNING,
  STAT_TILE_DANGER,
  STAT_TILE_BASE,
  pickStatTileStyle,
} from './shared/seoContentTokens';
import { buildTitleWithBrand } from './shared/titleSuffix';
import { renderLandingHero, HERO_BADGES } from './shared/landingHeroPersonality';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';

// ── Helpers ──────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<CareerLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

/**
 * Related internal links per locale. IT canonicals verified against
 * `services/router.ts` slug tables. Keeps every career landing connected to
 * the main job-board hub + salary calculator + nursing landings (cross-
 * vertical link equity).
 */
const RELATED_LINKS: Record<
  CareerLocale,
  Array<{ href: string; label: string }>
> = {
  it: [
    { href: '/cerca-lavoro-ticino/', label: 'Tutte le offerte lavoro in Ticino' },
    { href: '/cerca-lavoro-ticino/lugano/', label: 'Offerte di lavoro a Lugano' },
    { href: '/calcola-stipendio/', label: 'Calcolatore stipendio frontaliero' },
    { href: '/lavoro-infermieri-svizzera/', label: 'Lavoro infermieri in Svizzera' },
    {
      href: '/statistiche/confronta-stipendi/',
      label: 'Confronto stipendi Italia vs Svizzera',
    },
  ],
  en: [
    { href: '/en/find-jobs-ticino/', label: 'All Ticino job openings' },
    { href: '/en/find-jobs-ticino/lugano/', label: 'Jobs in Lugano' },
    { href: '/en/calculate-salary/', label: 'Cross-border salary calculator' },
    { href: '/en/nursing-jobs-switzerland/', label: 'Nursing jobs in Switzerland' },
    {
      href: '/en/statistics/compare-salaries/',
      label: 'Italy vs Switzerland salary comparison',
    },
  ],
  de: [
    { href: '/de/jobs-im-tessin/', label: 'Alle Tessin-Stellenangebote' },
    { href: '/de/jobs-im-tessin/lugano/', label: 'Stellen in Lugano' },
    { href: '/de/gehalt-berechnen/', label: 'Grenzgänger-Gehaltsrechner' },
    { href: '/de/pflegejobs-schweiz/', label: 'Pflegestellen in der Schweiz' },
    {
      href: '/de/statistiken/gehaelter-vergleichen/',
      label: 'Lohnvergleich Italien vs Schweiz',
    },
  ],
  fr: [
    { href: '/fr/trouver-emploi-tessin/', label: 'Toutes les offres Tessin' },
    { href: '/fr/trouver-emploi-tessin/lugano/', label: 'Emplois à Lugano' },
    { href: '/fr/calculer-salaire/', label: 'Calculateur salaire frontalier' },
    { href: '/fr/emplois-infirmiers-suisse/', label: 'Emplois infirmiers en Suisse' },
    {
      href: '/fr/statistiques/comparer-salaires/',
      label: 'Comparaison salaires Italie vs Suisse',
    },
  ],
};

// ── Template B renderers ─────────────────────────────────────────────────────

function toneToStyle(tone: CareerTemplateBCopy['statTile1']['tone']): string {
  switch (tone) {
    case 'success':
      return STAT_TILE_SUCCESS;
    case 'warning':
      return STAT_TILE_WARNING;
    case 'danger':
      return STAT_TILE_DANGER;
    case 'neutral':
      return STAT_TILE_BASE;
    case 'accent':
    default:
      return STAT_TILE_ACCENT;
  }
}

function renderTile(label: string, value: string, tone: CareerTemplateBCopy['statTile1']['tone']): string {
  return `<div style="${toneToStyle(tone)}">
    <div class="s-tlbl">${esc(label)}</div>
    <div class="s-tval">${esc(value)}</div>
  </div>`;
}

function renderStatTiles(
  id: CareerLandingId,
  templateB: CareerTemplateBCopy,
  snapshot: CareerJobsSnapshot,
  agencyCount: number,
  concorsiCount: number,
): string {
  // Tile 1 count source is id-deterministic — agenzie uses the SECO registry,
  // concorsi uses the cantonal snapshot, the rest use the live jobs aggregate.
  const tile1Count =
    id === 'agenzie-lavoro-lugano'
      ? agencyCount
      : id === 'concorsi-pubblici-lugano'
        ? concorsiCount
        : snapshot.liveCount;

  const tile2Value =
    typeof templateB.statTile2.value === 'string'
      ? templateB.statTile2.value
      : templateB.statTile2.value({
          medianSalary: snapshot.medianSalaryChf,
          liveCount: snapshot.liveCount,
        });

  // Dynamic tone: tile1 tracks count (openings-style), tile3 tracks fresh.
  // tile2 is salary/accent per copy data — keep the copy-specified tone.
  const tile1DynStyle = pickStatTileStyle('openings', tile1Count);
  const tile1 = `<div style="${tile1DynStyle}">
    <div class="s-tlbl">${esc(templateB.statTile1.label)}</div>
    <div class="s-tval">${esc(templateB.statTile1.valueFromCount(tile1Count))}</div>
  </div>`;
  const tile2 = renderTile(templateB.statTile2.label, tile2Value, templateB.statTile2.tone);
  const tile3DynStyle = pickStatTileStyle('fresh', snapshot.fresh30Count);
  const tile3 = `<div style="${tile3DynStyle}">
    <div class="s-tlbl">${esc(templateB.statTile3.label)}</div>
    <div class="s-tval">${esc(templateB.statTile3.valueFromFresh(snapshot.fresh30Count))}</div>
  </div>`;

  return `<div class="s-XENO3U">${tile1}${tile2}${tile3}</div>`;
}

function renderFeaturedJobs(
  id: CareerLandingId,
  locale: CareerLocale,
  snapshot: CareerJobsSnapshot,
  templateB: CareerTemplateBCopy,
): string {
  const shell = getCareerTemplateBShell(locale);
  const title = templateB.featuredJobsTitle ?? shell.featuredJobsTitle;
  const subtitle = templateB.featuredJobsSubtitle?.trim();
  const subtitleHtml = subtitle
    ? `<p class="s-H1Nmvo">${esc(subtitle)}</p>`
    : '';
  const items = snapshot.featured.map((j) => ({
    job: {
      title: j.title,
      titleByLocale: j.titleByLocale,
      company: j.company,
      companyKey: j.companyKey ?? undefined,
      companyDomain: j.companyDomain ?? undefined,
      addressLocality: j.addressLocality ?? j.city,
      canton: j.canton ?? undefined,
      contract: j.contract ?? undefined,
      salaryMin: j.salaryMin,
      salaryMax: j.salaryMax,
      postedDate: j.postedDate,
      url: j.url ?? undefined,
    } satisfies JobCardJob,
    href: buildCareerFeaturedJobUrl(j, locale),
  }));
  const emptyHtml = `<p class="s-card" style="color:var(--color-subtle);font-size:14px;margin:0">${esc(pickEmptyState(id, locale))}</p>`;
  const listHtml = renderJobCardListHtml(items, {
    locale,
    emptyStateHtml: emptyHtml,
  });
  const ctaHref = buildCareerJobBoardUrl(locale);
  const ctaLabel = snapshot.featured.length > 0 && snapshot.liveCount > 0
    ? pickCtaAllJobs(id, locale, snapshot.liveCount)
    : (shell.featuredJobsCtaAll(snapshot.liveCount) ?? 'Vedi tutti gli annunci →');
  return `<section class="s-KZc0LQ">
    <h2 class="s-8dKmAe">${esc(title)}</h2>
    ${subtitleHtml}
    ${listHtml}
    ${snapshot.featured.length > 0 ? `<a href="${esc(ctaHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px;display:inline-block;margin-top:14px">${esc(ctaLabel)}</a>` : ''}
  </section>`;
}

function renderEmployerGrid(
  snapshot: CareerJobsSnapshot,
  templateB: CareerTemplateBCopy,
  locale: CareerLocale,
): string {
  const employers = snapshot.topEmployers;
  if (employers.length === 0) return '';
  const shell = getCareerTemplateBShell(locale);
  const title = templateB.employerGridTitle ?? shell.employerGridTitle;

  const items = employers.map((e) => ({
    employer: {
      name: e.name,
      openings: e.count ?? undefined,
    } satisfies EmployerCardEmployer,
    // Crawlable job-board root, never a robots-disallowed `?q=` URL
    // (rel="nofollow" banned on internal links — see no-internal-nofollow test).
    href: buildCareerJobBoardUrl(locale),
  }));

  const listHtml = renderEmployerCardListHtml(items, {
    locale,
    variant: 'compact',
  });

  return `<section class="s-KZc0LQ">
    <h2 class="s-8dKmAe">${esc(title)}</h2>
    ${listHtml}
  </section>`;
}

/** Exported for unit tests — builds minimal copy and delegates to renderEmployerGrid. */
export function renderCareerEmployerGridForTest(
  id: CareerLandingId,
  locale: CareerLocale,
  snapshot: { topEmployers: ReadonlyArray<{ name: string; count: number }> },
): string {
  const templateB = buildCareerTemplateBCopy(locale, id, {
    liveCount: snapshot.topEmployers.length,
    fresh30Count: 0,
    medianSalary: null,
    agencyCount: 0,
    concorsiCount: 0,
  });
  return renderEmployerGrid(snapshot as CareerJobsSnapshot, templateB, locale);
}

function renderEmployerGridReplacement(text: string): string {
  return `<section class="s-card" style="margin:0 0 28px;max-width:860px">
    <p class="s-0kQbve">${esc(text)}</p>
  </section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div class="s-7V0OIo" role="separator" aria-label="${esc(label)}">
    <span class="s-EIg6N7" aria-hidden="true"></span>
    <span class="cl-divider-mark" aria-hidden="true">🧭</span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span class="s-EIg6N7" aria-hidden="true"></span>
  </div>`;
}

// ── Long-form (below-the-fold) renderers ─────────────────────────────────────

interface RenderResult {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderSection(title: string, paragraphs: string[]): string {
  const ps = paragraphs
    .map((p) => `<p style="${BODY_STYLE}">${esc(p)}</p>`)
    .join('');
  return `<section class="s-KZc0LQ"><h2 style="${H2_STYLE}">${esc(title)}</h2>${ps}</section>`;
}

function renderFaqBlock(faqs: CareerLandingCopy['faqs']): string {
  return faqs
    .map(
      (f) => `
      <details class="s-card" style="margin:0 0 10px;border-radius:12px">
        <summary class="s-ZAbW3N">${esc(f.question)}</summary>
        <p class="s-XXXebZ">${esc(f.answer)}</p>
      </details>`,
    )
    .join('');
}

function renderRelatedLinks(locale: CareerLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li class="s-Pkexk_"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section class="s-KZc0LQ"><h2 style="${H2_STYLE}">${esc(label)}</h2><ul class="s-Bidr8Y">${items}</ul></section>`;
}

function renderSources(sources: CareerLandingCopy['sources'], label: string): string {
  const items = sources
    .map(
      (s) =>
        `<li class="s-FakRZl"><a href="${esc(s.href)}" rel="noopener" style="${LINK_ACCENT_STYLE}">${esc(s.label)}</a></li>`,
    )
    .join('');
  return `<section class="s-KZc0LQ"><h2 style="${H2_STYLE}">${esc(label)}</h2><ul class="s-T1AdGR">${items}</ul></section>`;
}

// ── Page assembly ────────────────────────────────────────────────────────────

function renderPage(opts: {
  locale: CareerLocale;
  id: CareerLandingId;
  dateStamp: string;
  distDir?: string;
  snapshot: CareerJobsSnapshot;
  agencyCount: number;
  concorsiCount: number;
}): RenderResult {
  const { locale, id, dateStamp, distDir, snapshot, agencyCount, concorsiCount } = opts;
  const copy = CAREER_LANDING_COPY[locale][id];
  const shell = getCareerTemplateBShell(locale);
  const templateB = buildCareerTemplateBCopy(locale, id, {
    liveCount: snapshot.liveCount,
    fresh30Count: snapshot.fresh30Count,
    medianSalary: snapshot.medianSalaryChf,
    agencyCount,
    concorsiCount,
  });
  const urlPath = buildCareerLandingPath(locale, id);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  // Hreflang
  const hreflangLines = CAREER_LOCALES.map((alt) => {
    const altPath = buildCareerLandingPath(alt, id);
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
  });
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildCareerLandingPath('it', id)}">`,
  );
  const alternates = hreflangLines.join('\n');

  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const jobBoardUrl = `${BASE_URL}${buildCareerJobBoardUrl(locale)}`;
  const primaryCtaUrl = `${BASE_URL}${templateB.primaryCtaHref}`;

  // The simulator / calculator URL is also referenced by the bottom CTAs.
  const calculatorUrl = `${BASE_URL}${getCareerCalculatorUrl(locale)}`;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbJobs, item: jobBoardUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: copy.faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  });

  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: guardArticleJsonLdDescription(copy.description),
    image: `${BASE_URL}/og-image.png`,
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
    publisher: {
      '@type': 'Organization',
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

  // ── Template B header → above-the-fold ─────────────────────────────────
  const statTilesHtml = `<div class="seo-fade-in">${renderStatTiles(id, templateB, snapshot, agencyCount, concorsiCount)}</div>`;

  const primaryCtaHtml = `<div class="s-KZc0LQ"><a href="${esc(primaryCtaUrl)}" class="s-cta">${esc(templateB.primaryCtaLabel)} →</a></div>`;

  const featuredHtml = templateB.showFeaturedJobs
    ? renderFeaturedJobs(id, locale, snapshot, templateB)
    : '';

  const employerHtml = templateB.showEmployerGrid
    ? renderEmployerGrid(snapshot, templateB, locale)
    : templateB.employerGridReplacement
      ? renderEmployerGridReplacement(templateB.employerGridReplacement)
      : '';

  const dividerHtml = renderApprofondisciDivider(shell.approfondisciHeading);

  // ── Below-the-fold prose (legacy) ──────────────────────────────────────
  const sectionsHtml = copy.sections
    .map((s) => renderSection(s.title, s.paragraphs))
    .join('');
  const faqHtml = renderFaqBlock(copy.faqs);
  const relatedHtml = renderRelatedLinks(locale, copy.relatedLabel);
  const sourcesHtml = renderSources(copy.sources, copy.sourcesLabel);

  const body = `
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(jobBoardUrl)}" class="s-bcl">${esc(copy.breadcrumbJobs)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    ${id in HERO_BADGES
      ? renderLandingHero(id, locale, {
          openings: snapshot.liveCount,
          medianSalary: snapshot.medianSalaryChf ?? undefined,
        }, copy.h1, templateB.denseLede)
      : `<header class="s-YcUNX5">
      <p style="${HERO_EYEBROW_STYLE}">${esc(templateB.eyebrow ?? '')}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(templateB.denseLede)}</p>
    </header>`}
    <p class="text-sm font-medium text-accent mt-1">${esc(shell.updatedLabel)} ${esc(formatUpdatedDate(dateStamp, locale))}</p>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${featuredHtml}
    ${employerHtml}
    ${dividerHtml}
    ${sectionsHtml}
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${sourcesHtml}
    ${relatedHtml}
    <section class="s-p1QaOi">
      <a href="${esc(jobBoardUrl)}" class="s-cta">${esc(copy.ctaJobs)}</a>
      <a class="s-eXgANZ" href="${esc(calculatorUrl)}">${esc(copy.ctaSimulator)}</a>
    </section>
    <section class="s-GCEyQg" aria-label="${esc(copy.h1)}">
      <p class="s-y8VKoI">${esc(copy.lede)}</p>
    </section>`;

  const bodyHtml = `<main class="s-xzWvwM cl-fun">${body}</main>`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: buildTitleWithBrand(copy.title),
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ───────────────────────────────────────────────────────

function buildSitemapXml(
  entries: Array<{ canonical: string; alternates: string[] }>,
  today: string,
): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map(
          (a) =>
            `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`,
        )
        .join('\n');
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-career-landings.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-career-landings.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-career-landings\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[career-landings] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ──────────────────────────────────────────────────

export function careerLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'career-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_CAREER_LANDINGS === '1') {
        console.log(
          '\x1b[33m[career-landings]\x1b[0m Skipped (SKIP_CAREER_LANDINGS=1)',
        );
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);

      // Aggregate live signal once per build (module-level cached).
      const snapshots = aggregateCareerLandings(rootDir);
      const agencyCount = snapshots['agenzie-lavoro-lugano'].liveCount;
      const concorsiCount = snapshots['concorsi-pubblici-lugano'].liveCount;

      const collector = new WriteCollector({
        distDir,
        pluginName: 'careerLandingsPlugin',
      });
      const sitemapEntries: Array<{
        canonical: string;
        alternates: string[];
      }> = [];

      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const id of CAREER_LANDING_IDS) {
        const alternates = CAREER_LOCALES.map(
          (alt) => `${alt}|${BASE_URL}${buildCareerLandingPath(alt, id)}`,
        );
        alternates.push(
          `x-default|${BASE_URL}${buildCareerLandingPath('it', id)}`,
        );

        let itWasWritten = false;

        for (const locale of CAREER_LOCALES) {
          const rendered = renderPage({
            locale,
            id,
            dateStamp,
            distDir,
            snapshot: snapshots[id],
            agencyCount,
            concorsiCount,
          });

          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            thinSkipped++;
            console.warn(
              `\x1b[33m[career-landings]\x1b[0m ${locale}/${id} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
            );
            continue;
          }

          const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = np.join(
            distDir,
            rendered.urlPath.replace(/\/+$/, '') + '.html',
          );
          collector.add(indexPath, rendered.html);
          collector.add(flatPath, rendered.html);

          // Per-locale push (#3499): each locale that was actually written
          // gets its own <url> entry, sharing the group's IT-anchored
          // alternates, so non-IT pages survive
          // sanitizeSitemapHreflangReciprocity instead of being
          // referenced-but-never-listed. Non-IT pushes require the IT
          // anchor itself to have been written this run (CAREER_LOCALES
          // starts with 'it', so itWasWritten is settled before en/de/fr) —
          // an unconditional push would leave a dangling IT alternate when
          // the IT render is itself thin-skipped above.
          if (locale === 'it') {
            itWasWritten = true;
            sitemapEntries.push({ canonical: rendered.urlPath, alternates });
          } else if (itWasWritten) {
            sitemapEntries.push({ canonical: rendered.urlPath, alternates });
          }

          pagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const xml = buildSitemapXml(sitemapEntries, dateStamp);
          fs.mkdirSync(distDir, { recursive: true });
          const sitemapPath = np.join(distDir, 'sitemap-career-landings.xml');
          fs.writeFileSync(sitemapPath, xml, 'utf-8');
        } catch (err) {
          console.warn(
            '\x1b[33m[career-landings]\x1b[0m sitemap write failed:',
            err,
          );
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[career-landings]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Always-run: patch sitemap.xml index lastmod (regenerated each build).
      if (fs.existsSync(np.join(distDir, 'sitemap-career-landings.xml'))) {
        try {
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn(
            '\x1b[33m[career-landings]\x1b[0m sitemap-index patch failed:',
            err,
          );
        }
      }
    },
  };
}

// Test-only export: allows tests/build-plugins/job-card-canonical-adoption.test.ts
// to verify the migrated renderer emits canonical job-card markers.
export function renderCareerFeaturedJobsForTest(
  id: CareerLandingId,
  locale: CareerLocale,
  snapshot: CareerJobsSnapshot,
): string {
  const templateB = buildCareerTemplateBCopy(locale, id, {
    liveCount: snapshot.liveCount,
    fresh30Count: snapshot.fresh30Count,
    medianSalary: snapshot.medianSalaryChf,
    agencyCount: 0,
    concorsiCount: 0,
  });
  return renderFeaturedJobs(id, locale, snapshot, templateB);
}
