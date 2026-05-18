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
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  CARD_STYLE,
  CARD_BODY_STYLE,
  CARD_PADDING_STYLE,
  LINK_ACCENT_STYLE,
  CTA_PRIMARY_STYLE,
  HERO_EYEBROW_STYLE,
  SMALL_HEADING_STYLE,
  STAT_TILE_ACCENT,
  STAT_TILE_SUCCESS,
  STAT_TILE_WARNING,
  STAT_TILE_DANGER,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
  ICON_BUILDING_SVG,
} from './shared/seoContentTokens';
import { buildTitleWithBrand } from './shared/titleSuffix';

// ── Helpers ──────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<CareerLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
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
    <div style="${STAT_TILE_LABEL}">${esc(label)}</div>
    <div style="${STAT_TILE_VALUE}">${esc(value)}</div>
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

  const tile1 = renderTile(
    templateB.statTile1.label,
    templateB.statTile1.valueFromCount(tile1Count),
    templateB.statTile1.tone,
  );
  const tile2 = renderTile(templateB.statTile2.label, tile2Value, templateB.statTile2.tone);
  const tile3 = renderTile(
    templateB.statTile3.label,
    templateB.statTile3.valueFromFresh(snapshot.fresh30Count),
    templateB.statTile3.tone,
  );

  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">${tile1}${tile2}${tile3}</div>`;
}

function renderFeaturedJobCard(
  job: CareerFeaturedJob,
  locale: CareerLocale,
  formatPosted: (d: number) => string,
  formatSalary: (min: number | null, max: number | null) => string,
): string {
  const href = buildCareerFeaturedJobUrl(job, locale);
  const title = job.titleByLocale[locale] ?? job.title;
  const subtitleParts: string[] = [];
  if (job.company) subtitleParts.push(job.company);
  if (job.city) subtitleParts.push(job.city);
  const subtitle = subtitleParts.join(' · ');
  const salary = formatSalary(job.salaryMin, job.salaryMax);
  const posted = formatPosted(job.daysAgo);
  return `<a class="seo-card-link" href="${esc(href)}" style="${CARD_STYLE};text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:6px">
    <div style="font-weight:700;font-size:16px;line-height:1.35;color:var(--color-heading)">${esc(title)}</div>
    ${subtitle ? `<div style="font-size:14px;color:var(--color-body);line-height:1.4">${esc(subtitle)}</div>` : ''}
    <div style="display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;margin-top:4px;font-size:13px;color:var(--color-subtle)">
      ${salary ? `<span style="color:var(--color-accent);font-weight:700">${esc(salary)}</span>` : ''}
      <span>${esc(posted)}</span>
    </div>
  </a>`;
}

function renderFeaturedJobs(
  locale: CareerLocale,
  snapshot: CareerJobsSnapshot,
  templateB: CareerTemplateBCopy,
): string {
  const shell = getCareerTemplateBShell(locale);
  const title = templateB.featuredJobsTitle ?? shell.featuredJobsTitle;
  if (snapshot.featured.length === 0) {
    return `<section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(title)}</h2>
      <p style="${CARD_STYLE};color:var(--color-subtle);font-size:14px;margin:0">${esc(shell.featuredJobsEmpty)}</p>
    </section>`;
  }
  const cards = snapshot.featured
    .map((j) => renderFeaturedJobCard(j, locale, shell.jobPostedLabel, shell.jobSalaryFmt))
    .join('');
  const ctaHref = buildCareerJobBoardUrl(locale);
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(title)}</h2>
    <div style="display:grid;gap:12px;margin-bottom:14px">${cards}</div>
    <a href="${esc(ctaHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px">${esc(shell.featuredJobsCtaAll(snapshot.liveCount))}</a>
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
  const cells = employers
    .map(
      (e) => `<div style="display:flex;align-items:center;gap:10px;${CARD_PADDING_STYLE};${CARD_BODY_STYLE}">
        <span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:var(--color-surface-alt);color:var(--color-subtle);flex-shrink:0">${ICON_BUILDING_SVG}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;color:var(--color-heading);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</div>
        </div>
        ${e.count !== null ? `<div style="flex-shrink:0;font-weight:700;color:var(--color-accent);font-variant-numeric:tabular-nums">${e.count}</div>` : ''}
      </div>`,
    )
    .join('');
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(title)}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${cells}</div>
  </section>`;
}

function renderEmployerGridReplacement(text: string): string {
  return `<section style="margin:0 0 28px;${CARD_STYLE};max-width:860px">
    <p style="margin:0;color:var(--color-body);line-height:1.65">${esc(text)}</p>
  </section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div role="separator" aria-label="${esc(label)}" style="margin:36px 0 28px;display:flex;align-items:center;gap:14px;color:var(--color-subtle)">
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
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
  return `<section style="margin:0 0 28px"><h2 style="${H2_STYLE}">${esc(title)}</h2>${ps}</section>`;
}

function renderFaqBlock(faqs: CareerLandingCopy['faqs']): string {
  return faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;${CARD_STYLE};border-radius:12px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45">${esc(f.question)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.65">${esc(f.answer)}</p>
      </details>`,
    )
    .join('');
}

function renderRelatedLinks(locale: CareerLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li style="margin:0 0 8px"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="${H2_STYLE}">${esc(label)}</h2><ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55;max-width:860px">${items}</ul></section>`;
}

function renderSources(sources: CareerLandingCopy['sources'], label: string): string {
  const items = sources
    .map(
      (s) =>
        `<li style="margin:0 0 6px"><a href="${esc(s.href)}" rel="noopener" style="${LINK_ACCENT_STYLE}">${esc(s.label)}</a></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="${H2_STYLE}">${esc(label)}</h2><ul style="margin:0 0 0 20px;padding:0;color:var(--color-subtle);line-height:1.55;max-width:860px;font-size:14px">${items}</ul></section>`;
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

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbJobs, item: jobBoardUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: copy.faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
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

  // ── Template B header → above-the-fold ─────────────────────────────────
  const statTilesHtml = renderStatTiles(id, templateB, snapshot, agencyCount, concorsiCount);

  const primaryCtaHtml = `<div style="margin:0 0 28px"><a href="${esc(primaryCtaUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(templateB.primaryCtaLabel)} →</a></div>`;

  const featuredHtml = templateB.showFeaturedJobs
    ? renderFeaturedJobs(locale, snapshot, templateB)
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
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(jobBoardUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbJobs)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header style="margin-bottom:20px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(templateB.eyebrow)} · ${esc(shell.updatedLabel)} ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(templateB.denseLede)}</p>
    </header>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${featuredHtml}
    ${employerHtml}
    ${dividerHtml}
    <section style="margin:0 0 28px">
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:62ch;font-size:17px;font-style:italic">${esc(copy.lede)}</p>
    </section>
    ${sectionsHtml}
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${sourcesHtml}
    ${relatedHtml}
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobBoardUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.ctaJobs)}</a>
      <a href="${esc(calculatorUrl)}" style="padding:10px 16px;border-radius:10px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:600">${esc(copy.ctaSimulator)}</a>
    </section>`;

  const bodyHtml = `<main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">${body}</main>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.h1)}">
    <meta name="twitter:description" content="${esc(copy.description)}">`;

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
    extraHeadHtml: extraHead,
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

          if (locale === 'it') {
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
