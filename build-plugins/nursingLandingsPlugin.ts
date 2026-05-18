/**
 * Nursing / healthcare evergreen SEO landings — Vite build plugin (P2).
 *
 * Emits 12 static HTML pages (3 IT canonicals × 4 locales):
 *
 *   IT canonical                             EN / DE / FR variants
 *   /lavoro-infermieri-svizzera/             /en/nursing-jobs-switzerland/ …
 *   /lavoro-oss-svizzera/                    /en/healthcare-assistant-jobs-switzerland/ …
 *   /lavoro-sanitario-ticino/                /en/healthcare-jobs-ticino/ …
 *
 * 2026-05 redesign (template B, mobile-first per CLAUDE.md regola #17):
 * the live signal — open positions, median salary, freshness, featured
 * jobs and employer grid — sits above the fold; the long-form hand-written
 * prose lives below an "Approfondisci" divider where it preserves the
 * text-to-HTML ratio gate without pushing the meaty content off the first
 * mobile viewport.
 *
 * Body order:
 *   1. breadcrumb
 *   2. <header>: eyebrow + H1 + dense lede (≤120 char, 1 line)
 *   3. 3 stat tiles (open positions · median salary · fresh in 30 days)
 *   4. primary CTA → salary calculator
 *   5. featured live jobs (top 3) + "see all" link
 *   6. employer grid (top 6 employers)
 *   7. ─── "Approfondisci" divider ───
 *   8. lede paragraph + hand-written H2 sections + FAQ + related
 *   9. final CTA row (sector hub + simulator)
 *
 * Live signal comes from `nursingJobsAggregate` (build-time read of
 * data/jobs.json). The hand-written editorial copy lives in
 * `nursingLandingsCopy.ts` and is untouched by the template B redesign.
 *
 * JSON-LD emitted: BreadcrumbList + FAQPage + Article + ItemList.
 *
 * Routing: paths are registered as `staticOverlay` routes in
 * `services/router.ts` so the SPA doesn't replace the SEO content with a
 * NotFoundSuggestions UI on hydrate.
 *
 * Sitemap: writes `dist/sitemap-nursing.xml` and patches `sitemap.xml`
 * index. `sitemapAliasPlugin` auto-discovers the file.
 *
 * Gate: SKIP_NURSING=1 fast-exits the plugin for local builds only. CI
 * (`npm run build:ci`) always exercises it — exit 0 required.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CTA_PRIMARY_STYLE,
  CARD_STYLE,
  CARD_BODY_STYLE,
  CARD_PADDING_STYLE,
  LINK_ACCENT_STYLE,
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  SMALL_HEADING_STYLE,
  renderStatGrid,
  ICON_BUILDING_SVG,
} from './shared/seoContentTokens';
import {
  NURSING_LOCALES,
  NURSING_LANDING_IDS,
  buildNursingLandingPath,
  type NursingLocale,
  type NursingLandingId,
} from './nursingLandingsData';
import {
  buildNursingLandingCopy,
  type NursingLandingComposedCopy,
} from './nursingLandingsCopy';
import { buildSectorHubPath, type SectorHubKey } from './jobSectorLanding';
import {
  aggregateNursingJobs,
  buildFeaturedJobUrl,
  buildJobBoardUrl,
  type NursingFeaturedJob,
  type NursingJobsSnapshot,
} from './nursingJobsAggregate';

// CTA target sector for each landing id — null means "fall back to the
// unfiltered job-board hub" (used by `healthcare-ticino`, whose CTA copy
// explicitly says "all openings"). The other two landings target a
// concrete sector so the final-row CTA lands on a filtered list.
const CTA_SECTOR: Record<NursingLandingId, SectorHubKey | null> = {
  nurses: 'infermieri',
  oss: 'case-anziani',
  'healthcare-ticino': null,
};

// Salary-calculator URL per locale — the primary CTA's killer-hook target.
const CALCULATOR_URL: Record<NursingLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── Helpers ──────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<NursingLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/**
 * Related internal links per locale. IT canonicals are verified against
 * `services/router.ts`.
 */
const RELATED_LINKS: Record<NursingLocale, Array<{ href: string; label: string }>> = {
  it: [
    { href: buildSectorHubPath('it', 'infermieri'), label: 'Offerte infermieri in Ticino' },
    { href: buildSectorHubPath('it', 'case-anziani'), label: 'Lavoro nelle case anziani' },
    { href: '/concorsi-pubblici-lugano/', label: 'Concorsi pubblici OSC e EOC aperti' },
    { href: '/contratti-lavoro-frontalieri/', label: 'Contratti lavoro frontalieri: CCL e accordo fiscale' },
    { href: '/calcola-stipendio/', label: 'Calcolatore stipendio frontaliero' },
    { href: '/statistiche/confronta-stipendi/', label: 'Confronto stipendi Italia vs Svizzera' },
    { href: '/cerca-lavoro-ticino/', label: 'Tutte le offerte lavoro in Ticino' },
  ],
  en: [
    { href: buildSectorHubPath('en', 'infermieri'), label: 'Nursing jobs in Ticino' },
    { href: buildSectorHubPath('en', 'case-anziani'), label: 'Elderly-care jobs' },
    { href: '/en/public-sector-jobs-lugano/', label: 'Open public-sector jobs (OSC, EOC)' },
    { href: '/en/cross-border-work-contracts/', label: 'Cross-border employment contracts' },
    { href: '/en/calculate-salary/', label: 'Cross-border salary calculator' },
    { href: '/en/statistics/compare-salaries/', label: 'Italy vs Switzerland salary comparison' },
    { href: '/en/find-jobs-ticino/', label: 'All Ticino job openings' },
  ],
  de: [
    { href: buildSectorHubPath('de', 'infermieri'), label: 'Pflegestellen im Tessin' },
    { href: buildSectorHubPath('de', 'case-anziani'), label: 'Altenpflegestellen' },
    { href: '/de/oeffentliche-stellen-lugano/', label: 'Offene öffentliche Stellen (OSC, EOC)' },
    { href: '/de/grenzgaenger-arbeitsvertraege/', label: 'Grenzgänger-Arbeitsverträge' },
    { href: '/de/gehalt-berechnen/', label: 'Grenzgänger-Gehaltsrechner' },
    { href: '/de/statistiken/gehaelter-vergleichen/', label: 'Lohnvergleich Italien vs Schweiz' },
    { href: '/de/jobs-im-tessin/', label: 'Alle Tessin-Stellenangebote' },
  ],
  fr: [
    { href: buildSectorHubPath('fr', 'infermieri'), label: 'Emplois infirmiers au Tessin' },
    { href: buildSectorHubPath('fr', 'case-anziani'), label: 'Emplois en EMS' },
    { href: '/fr/concours-publics-lugano/', label: 'Concours publics ouverts (OSC, EOC)' },
    { href: '/fr/contrats-travail-frontaliers/', label: 'Contrats de travail frontaliers' },
    { href: '/fr/calculer-salaire/', label: 'Calculateur salaire frontalier' },
    { href: '/fr/statistiques/comparer-salaires/', label: 'Comparaison salaires Italie vs Suisse' },
    { href: '/fr/trouver-emploi-tessin/', label: 'Toutes les offres Tessin' },
  ],
};

// ── Rendering ─────────────────────────────────────────────────────

interface RenderResult {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderSection(title: string, paragraphs: string[]): string {
  const ps = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:62ch">${esc(p)}</p>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:24px;color:var(--color-heading);font-weight:600">${esc(title)}</h2>${ps}</section>`;
}

function renderFaqBlock(faqs: NursingLandingComposedCopy['faqs']): string {
  return faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45">${esc(f.question)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.65">${esc(f.answer)}</p>
      </details>`,
    )
    .join('');
}

function renderRelatedLinks(locale: NursingLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li style="margin:0 0 8px"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:600">${esc(label)}</h2><ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55;max-width:860px">${items}</ul></section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div role="separator" aria-label="${esc(label)}" style="margin:36px 0 28px;display:flex;align-items:center;gap:14px;color:var(--color-subtle)">
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
  </div>`;
}

// ── Featured-jobs + employer-grid renderers (template B) ─────────────────────

function pickJobTitle(job: NursingFeaturedJob, locale: NursingLocale): string {
  return (
    (job.titleByLocale as Partial<Record<NursingLocale, string>>)[locale] ?? job.title
  );
}

function renderFeaturedJobCard(
  job: NursingFeaturedJob,
  locale: NursingLocale,
  copy: NursingLandingComposedCopy,
): string {
  const href = buildFeaturedJobUrl(job, locale);
  const title = pickJobTitle(job, locale);
  const subtitleParts: string[] = [];
  if (job.company) subtitleParts.push(job.company);
  if (job.city) subtitleParts.push(job.city);
  const subtitle = subtitleParts.join(' · ');
  const salary = copy.shell.jobSalaryFmt(job.salaryMin, job.salaryMax);
  const posted = copy.shell.jobPostedLabel(job.daysAgo);

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
  locale: NursingLocale,
  snapshot: NursingJobsSnapshot,
  copy: NursingLandingComposedCopy,
): string {
  if (snapshot.featured.length === 0) {
    return `<section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(copy.shell.featuredJobsTitle)}</h2>
      <p style="${CARD_STYLE};color:var(--color-subtle);font-size:14px;margin:0">${esc(copy.shell.featuredJobsEmpty)}</p>
    </section>`;
  }
  const cards = snapshot.featured.map((j) => renderFeaturedJobCard(j, locale, copy)).join('');
  const ctaHref = buildJobBoardUrl(locale);
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(copy.shell.featuredJobsTitle)}</h2>
    <div style="display:grid;gap:12px;margin-bottom:14px">${cards}</div>
    <a href="${esc(ctaHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px">${esc(copy.featuredJobsCtaAllLabel)}</a>
  </section>`;
}

function renderEmployerGrid(
  snapshot: NursingJobsSnapshot,
  copy: NursingLandingComposedCopy,
): string {
  if (snapshot.topEmployers.length === 0) return '';
  const cells = snapshot.topEmployers
    .map(
      (e) => `<div style="display:flex;align-items:center;gap:10px;${CARD_PADDING_STYLE};${CARD_BODY_STYLE}">
        <span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:var(--color-surface-alt);color:var(--color-subtle);flex-shrink:0">${ICON_BUILDING_SVG}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;color:var(--color-heading);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</div>
        </div>
        <div style="flex-shrink:0;font-weight:700;color:var(--color-accent);font-variant-numeric:tabular-nums">${e.count}</div>
      </div>`,
    )
    .join('');
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(copy.shell.employerGridTitle)}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${cells}</div>
  </section>`;
}

// ── Page assembly ────────────────────────────────────────────────────────────

function renderPage(opts: {
  locale: NursingLocale;
  id: NursingLandingId;
  dateStamp: string;
  distDir?: string;
  snapshot: NursingJobsSnapshot;
}): RenderResult {
  const { locale, id, dateStamp, distDir, snapshot } = opts;
  const copy = buildNursingLandingCopy(locale, id, {
    liveCount: snapshot.liveCount,
    fresh30Count: snapshot.fresh30Count,
    medianSalaryChf: snapshot.medianSalaryChf,
  });
  const urlPath = buildNursingLandingPath(locale, id);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  // Hreflang — all 4 locales + x-default → IT canonical.
  const hreflangLines = NURSING_LOCALES.map((alt) => {
    const altPath = buildNursingLandingPath(alt, id);
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
  });
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildNursingLandingPath('it', id)}">`,
  );
  const alternates = hreflangLines.join('\n');

  // Breadcrumbs + downstream URLs
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const jobBoardUrl = `${BASE_URL}${buildJobBoardUrl(locale)}`;
  const ctaSector = CTA_SECTOR[id];
  const ctaJobsUrl = ctaSector
    ? `${BASE_URL}${buildSectorHubPath(locale, ctaSector)}`
    : jobBoardUrl;
  const calculatorUrl = `${BASE_URL}${CALCULATOR_URL[locale]}`;

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

  // ItemList — top employers from the live aggregate. Empty featured grid =
  // skip the JSON-LD entry (rather than emit an empty list, which Google
  // flags as a structured-data warning).
  const itemListLd =
    snapshot.topEmployers.length > 0
      ? JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: copy.shell.employerGridTitle,
          itemListOrder: 'https://schema.org/ItemListOrderAscending',
          numberOfItems: snapshot.topEmployers.length,
          itemListElement: snapshot.topEmployers.map((e, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            item: { '@type': 'Organization', name: e.name },
          })),
        })
      : null;

  // ── Template B body ──────────────────────────────────────────────────────

  const statTilesHtml = renderStatGrid([
    { label: copy.shell.statTileLiveLabel, value: copy.statLiveValue, tone: 'success' },
    { label: copy.shell.statTileSalaryLabel, value: copy.statSalaryValue, tone: 'accent' },
    { label: copy.shell.statTileFreshLabel, value: copy.statFreshValue, tone: 'warning' },
  ]);

  const primaryCtaHtml = `<div style="margin:0 0 28px"><a href="${esc(calculatorUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.shell.primaryCtaLabel)} →</a></div>`;

  const featuredHtml = renderFeaturedJobs(locale, snapshot, copy);
  const employerGridHtml = renderEmployerGrid(snapshot, copy);
  const dividerHtml = renderApprofondisciDivider(copy.shell.approfondisciHeading);

  const sectionsHtml = copy.sections.map((s) => renderSection(s.title, s.paragraphs)).join('');
  const faqHtml = renderFaqBlock(copy.faqs);
  const relatedHtml = renderRelatedLinks(locale, copy.relatedLabel);

  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(jobBoardUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbJobs)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header style="margin-bottom:20px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.shell.eyebrow)} · ${esc(copy.updatedLabel)} ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.denseLede)}</p>
    </header>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${featuredHtml}
    ${employerGridHtml}
    ${dividerHtml}
    <section style="margin:0 0 28px">
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:62ch;font-size:17px;font-style:italic">${esc(copy.lede)}</p>
    </section>
    ${sectionsHtml}
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:24px;color:var(--color-heading);font-weight:600">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${relatedHtml}
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(ctaJobsUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.ctaJobs)}</a>
      <a href="${esc(calculatorUrl)}" style="padding:12px 18px;border-radius:12px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:700">${esc(copy.ctaSimulator)}</a>
    </section>`;

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">${body}</main>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.h1)}">
    <meta name="twitter:description" content="${esc(copy.description)}">`;

  const wordCount = countHtmlBodyWords(body);

  const jsonLdScripts = [breadcrumbLd, faqLd, articleLd];
  if (itemListLd) jsonLdScripts.push(itemListLd);

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
    jsonLdScripts,
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ───────────────────────────────────────────────────────

function buildSitemapXml(entries: Array<{ canonical: string; alternates: string[] }>, today: string): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`).join('\n');
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
    if (!idx.includes('sitemap-nursing.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-nursing.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-nursing\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[nursing-landings] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ──────────────────────────────────────────────────

export function nursingLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'nursing-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_NURSING === '1') {
        console.log('\x1b[33m[nursing-landings]\x1b[0m Skipped (SKIP_NURSING=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);

      // Aggregate live jobs per nursing landing once. Module-level cached.
      const snapshots = aggregateNursingJobs(rootDir);

      const collector = new WriteCollector({
        distDir,
        pluginName: 'nursingLandingsPlugin',
      });
      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];

      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const id of NURSING_LANDING_IDS) {
        const alternates = NURSING_LOCALES.map((alt) => `${alt}|${BASE_URL}${buildNursingLandingPath(alt, id)}`);
        alternates.push(`x-default|${BASE_URL}${buildNursingLandingPath('it', id)}`);

        for (const locale of NURSING_LOCALES) {
          const rendered = renderPage({
            locale,
            id,
            dateStamp,
            distDir,
            snapshot: snapshots[id],
          });

          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            thinSkipped++;
            console.warn(
              `\x1b[33m[nursing-landings]\x1b[0m ${locale}/${id} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
            );
            continue;
          }

          const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
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
          const sitemapPath = np.join(distDir, 'sitemap-nursing.xml');
          fs.writeFileSync(sitemapPath, xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[nursing-landings]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[nursing-landings]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Always-run: patch sitemap.xml index lastmod (regenerated each build).
      if (fs.existsSync(np.join(distDir, 'sitemap-nursing.xml'))) {
        try {
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[nursing-landings]\x1b[0m sitemap-index patch failed:', err);
        }
      }
    },
  };
}
