/**
 * Career quick-win SEO landings — Vite build plugin (AE-2).
 *
 * Emits 16 static HTML pages (4 IT canonicals × 4 locales):
 *
 *   IT canonical                        EN / DE / FR variants
 *   /agenzie-del-lavoro-lugano/         /en/staffing-agencies-lugano/ …
 *   /concorsi-pubblici-lugano/          /en/public-sector-jobs-lugano/ …
 *   /stage-lugano/                      /en/internships-lugano/ …
 *   /contratti-lavoro-frontalieri/      /en/cross-border-work-contracts/ …
 *
 * Each IT page is ≥800 words and covers the quick-win keyword cluster with
 * real cited data from concorsi.ti.ch (snapshot in `data/seo/concorsi-ti.json`)
 * and the SECO AVG agency registry (`data/seco-staffing-registry.json`).
 * EN/DE/FR variants are ≥400 words and follow the same structure with inline
 * citations to the primary sources.
 *
 * JSON-LD emitted: BreadcrumbList + FAQPage + Article (Article carries
 * `inLanguage` so Google indexes the correct locale variant).
 *
 * Routing: paths are registered as `staticOverlay` routes in
 * `services/router.ts` so the SPA doesn't replace the SEO content with a
 * NotFoundSuggestions UI on hydrate (content lives outside `#root` via
 * `seoContentOutsideRoot: true`, same trick used by nursing + F2-F8 plugins).
 *
 * Hub chrome: every page wraps its body in the canonical job-board sub-nav
 * via `hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' }`, so the
 * first-paint static HTML matches the SPA chrome of the rest of the site
 * (same contract enforced by BUG-2 / tests/e2e/hub-chrome-parity.spec.ts).
 *
 * Sitemap: writes `dist/sitemap-career-landings.xml` and patches
 * `sitemap.xml` index. `sitemapAliasPlugin` auto-discovers the file so no
 * extra wiring is needed in `sitemapAliasPlugin.ts`.
 *
 * Gate: SKIP_CAREER_LANDINGS=1 fast-exits the plugin for local builds only.
 * CI (`npm run build:ci`) always exercises it — exit 0 required.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import {
  CAREER_LOCALES,
  CAREER_LANDING_IDS,
  buildCareerLandingPath,
  type CareerLocale,
  type CareerLandingId,
} from './careerLandingsData';
import {
  CAREER_LANDING_COPY,
  type CareerLandingCopy,
} from './careerLandingsCopy';
import {
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  CARD_STYLE,
  LINK_ACCENT_STYLE,
  CTA_PRIMARY_STYLE,
  HERO_EYEBROW_STYLE,
} from './shared/seoContentTokens';

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
 * services/router.ts slug tables. Keeps every career landing connected to
 * the main job-board hub + salary calculator + existing nursing landings
 * (inter-vertical link equity).
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
        `<p style="${BODY_STYLE};max-width:860px">${esc(p)}</p>`,
    )
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

function renderPage(opts: {
  locale: CareerLocale;
  id: CareerLandingId;
  dateStamp: string;
  distDir?: string;
}): RenderResult {
  const { locale, id, dateStamp, distDir } = opts;
  const copy = CAREER_LANDING_COPY[locale][id];
  const urlPath = buildCareerLandingPath(locale, id);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  // Hreflang — all 4 locales + x-default → IT canonical.
  const hreflangLines = CAREER_LOCALES.map((alt) => {
    const altPath = buildCareerLandingPath(alt, id);
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
  });
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildCareerLandingPath('it', id)}">`,
  );
  const alternates = hreflangLines.join('\n');

  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const jobBoardUrl = `${BASE_URL}${
    locale === 'it'
      ? '/cerca-lavoro-ticino/'
      : locale === 'en'
        ? '/en/find-jobs-ticino/'
        : locale === 'de'
          ? '/de/jobs-im-tessin/'
          : '/fr/trouver-emploi-tessin/'
  }`;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: copy.breadcrumbHome,
        item: homeUrl,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: copy.breadcrumbJobs,
        item: jobBoardUrl,
      },
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
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.answer,
      },
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

  const sections = copy.sections.map((s) => renderSection(s.title, s.paragraphs)).join('');
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
    <header style="margin-bottom:24px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.updatedLabel)} · ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE};max-width:860px">${esc(copy.lede)}</p>
    </header>
    ${sections}
    <section style="margin:0 0 28px">
      <h2 style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${sourcesHtml}
    ${relatedHtml}
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobBoardUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.ctaJobs)}</a>
      <a href="${esc(homeUrl)}" style="${CARD_STYLE};padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">${esc(copy.ctaSimulator)}</a>
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
    title: copy.title,
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

      const collector = new WriteCollector({ distDir });
      const dateStamp = new Date().toISOString().slice(0, 10);
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
          const rendered = renderPage({ locale, id, dateStamp, distDir });

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
          fs.writeFileSync(
            np.join(distDir, 'sitemap-career-landings.xml'),
            xml,
            'utf-8',
          );
          patchSitemapIndex(distDir, dateStamp);
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
    },
  };
}
