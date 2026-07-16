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
import { formatUpdatedDate } from './shared/humanDate';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import {
  LINK_ACCENT_STYLE,
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  SMALL_HEADING_STYLE,
  renderStatGrid,
  pickStatTileTone,
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
import { renderLandingHero, HERO_BADGES } from './shared/landingHeroPersonality';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';

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
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
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
        `<p class="s-Poj6T0">${esc(p)}</p>`,
    )
    .join('');
  return `<section class="s-KZc0LQ"><h2 class="s-BEjFo9">${esc(title)}</h2>${ps}</section>`;
}

function renderFaqBlock(faqs: NursingLandingComposedCopy['faqs']): string {
  return faqs
    .map(
      (f) => `
      <details class="s-RTovxW">
        <summary class="s-ZAbW3N">${esc(f.question)}</summary>
        <p class="s-XXXebZ">${esc(f.answer)}</p>
      </details>`,
    )
    .join('');
}

function renderRelatedLinks(locale: NursingLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li class="s-Pkexk_"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section class="s-KZc0LQ"><h2 class="s-zlWKhs">${esc(label)}</h2><ul class="s-Bidr8Y">${items}</ul></section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div class="s-7V0OIo" role="separator" aria-label="${esc(label)}">
    <span class="s-EIg6N7" aria-hidden="true"></span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span class="s-EIg6N7" aria-hidden="true"></span>
  </div>`;
}

// ── Featured-jobs + employer-grid renderers (template B) ─────────────────────

function renderFeaturedJobs(
  id: NursingLandingId,
  locale: NursingLocale,
  snapshot: NursingJobsSnapshot,
  copy: NursingLandingComposedCopy,
): string {
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
    href: buildFeaturedJobUrl(j, locale),
  }));
  const emptyHtml = `<p class="s-card" style="color:var(--color-subtle);font-size:14px;margin:0">${esc(pickEmptyState(id, locale))}</p>`;
  const listHtml = renderJobCardListHtml(items, {
    locale,
    emptyStateHtml: emptyHtml,
  });
  // "See all N offers" CTA → the landing's sector hub (e.g. nurses →
  // /cerca-lavoro-ticino/infermieri/) so the visitor lands on a filtered
  // search, not the generic root. Reuses CTA_SECTOR; null (healthcare-ticino,
  // whose copy says "all openings") falls back to the unfiltered hub.
  const ctaSector = CTA_SECTOR[id];
  const ctaHref = ctaSector ? buildSectorHubPath(locale, ctaSector) : buildJobBoardUrl(locale);
  const ctaLabel = snapshot.featured.length > 0 && snapshot.liveCount > 0
    ? pickCtaAllJobs(id, locale, snapshot.liveCount)
    : (copy.featuredJobsCtaAllLabel ?? 'Vedi tutti gli annunci →');
  return `<section class="s-KZc0LQ">
    <h2 class="s-8dKmAe">${esc(copy.shell.featuredJobsTitle)}</h2>
    ${listHtml}
    ${snapshot.featured.length > 0 ? `<a href="${esc(ctaHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px;display:inline-block;margin-top:14px">${esc(ctaLabel)}</a>` : ''}
  </section>`;
}

function renderEmployerGrid(
  snapshot: NursingJobsSnapshot,
  copy: NursingLandingComposedCopy,
  locale: NursingLocale,
): string {
  if (snapshot.topEmployers.length === 0) return '';

  const items = snapshot.topEmployers.map((e) => ({
    employer: {
      name: e.name,
      openings: e.count ?? undefined,
    } satisfies EmployerCardEmployer,
    // Crawlable job-board root, never a robots-disallowed `?q=` URL
    // (rel="nofollow" banned on internal links — see no-internal-nofollow test).
    href: buildJobBoardUrl(locale),
  }));

  const listHtml = renderEmployerCardListHtml(items, {
    locale,
    variant: 'compact',
  });

  return `<section class="s-KZc0LQ">
    <h2 class="s-8dKmAe">${esc(copy.shell.employerGridTitle)}</h2>
    ${listHtml}
  </section>`;
}

/** Exported for unit tests — builds minimal copy and delegates to renderEmployerGrid. */
export function renderNursingEmployerGridForTest(
  id: NursingLandingId,
  locale: NursingLocale,
  snapshot: { topEmployers: ReadonlyArray<{ name: string; count: number }> },
): string {
  const copy = buildNursingLandingCopy(locale, id, {
    liveCount: snapshot.topEmployers.length,
    fresh30Count: 0,
    medianSalaryChf: null,
  });
  return renderEmployerGrid(snapshot as NursingJobsSnapshot, copy, locale);
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

  const statTilesHtml = `<div class="seo-fade-in">${renderStatGrid([
    { label: copy.shell.statTileLiveLabel, value: copy.statLiveValue, tone: pickStatTileTone('openings', snapshot.liveCount) },
    { label: copy.shell.statTileSalaryLabel, value: copy.statSalaryValue, tone: pickStatTileTone('salary', snapshot.medianSalaryChf ?? 0) },
    { label: copy.shell.statTileFreshLabel, value: copy.statFreshValue, tone: pickStatTileTone('fresh', snapshot.fresh30Count) },
  ])}</div>`;

  const primaryCtaHtml = `<div class="s-KZc0LQ"><a href="${esc(calculatorUrl)}" class="s-cta">${esc(copy.shell.primaryCtaLabel)} →</a></div>`;

  const featuredHtml = renderFeaturedJobs(id, locale, snapshot, copy);
  const employerGridHtml = renderEmployerGrid(snapshot, copy, locale);
  const dividerHtml = renderApprofondisciDivider(copy.shell.approfondisciHeading);

  const sectionsHtml = copy.sections.map((s) => renderSection(s.title, s.paragraphs)).join('');
  const faqHtml = renderFaqBlock(copy.faqs);
  const relatedHtml = renderRelatedLinks(locale, copy.relatedLabel);

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
        }, copy.h1, copy.denseLede)
      : `<header class="s-YcUNX5">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.shell.eyebrow)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.denseLede)}</p>
    </header>`}
    <p class="text-sm font-medium text-accent mt-1">${esc(copy.updatedLabel)} ${esc(formatUpdatedDate(dateStamp, locale))}</p>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${featuredHtml}
    ${employerGridHtml}
    ${dividerHtml}
    ${sectionsHtml}
    <section class="s-KZc0LQ">
      <h2 class="s-BEjFo9">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${relatedHtml}
    <section class="s-p1QaOi">
      <a href="${esc(ctaJobsUrl)}" class="s-cta">${esc(copy.ctaJobs)}</a>
      <a class="s-bX1C8q" href="${esc(calculatorUrl)}">${esc(copy.ctaSimulator)}</a>
    </section>
    <section class="s-GCEyQg" aria-label="${esc(copy.h1)}">
      <p class="s-y8VKoI">${esc(copy.lede)}</p>
    </section>`;

  const bodyHtml = `<main class="s-it71Rt">${body}</main>`;

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

        let itWasWritten = false;

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

          // Every locale gets its own reciprocal <loc> entry (all 4 carry the
          // same alternates set) — an IT-only push here would leave en/de/fr
          // as one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
          // Non-IT pushes require the IT anchor itself to have been written
          // this run (NURSING_LOCALES starts with 'it', so itWasWritten is
          // settled before en/de/fr) — an unconditional push would leave a
          // dangling IT alternate when the IT render is itself thin-skipped.
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

// Test-only export: allows tests/build-plugins/job-card-canonical-adoption.test.ts
// to verify the migrated renderer emits canonical job-card markers.
export function renderNursingFeaturedJobsForTest(
  id: NursingLandingId,
  locale: NursingLocale,
  snapshot: NursingJobsSnapshot,
): string {
  const copy = buildNursingLandingCopy(locale, id, {
    liveCount: snapshot.liveCount,
    fresh30Count: snapshot.fresh30Count,
    medianSalaryChf: snapshot.medianSalaryChf,
  });
  return renderFeaturedJobs(id, locale, snapshot, copy);
}
