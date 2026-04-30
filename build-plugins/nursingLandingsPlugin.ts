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
 * Each IT page is ≥1.200 words (hand-written, no placeholder) and covers:
 *   CCL OSS 2024 + infermieri, stipendi medi per esperienza, permessi G vs B,
 *   cliniche principali (EOC, Moncucco, LIS, Clinica Luganese, Ticino Cuore),
 *   concorsi ricorrenti, riconoscimento MEBEKO, differenze CH vs IT.
 *
 * Locale variants (EN/DE/FR) are ≥400 words and cover the same structure at
 * condensed length. No `needsRetranslation` placeholders — all 4 locales have
 * real content before publish.
 *
 * JSON-LD emitted: BreadcrumbList + FAQPage + Article (Article carries
 * `inLanguage` so Google indexes the correct locale variant).
 *
 * Routing: paths are registered as `staticOverlay` routes in
 * `services/router.ts` so the SPA doesn't replace the SEO content with a
 * NotFoundSuggestions UI on hydrate (content lives outside `#root` via
 * `seoContentOutsideRoot: true`, same trick used by F2-F8 plugins).
 *
 * Sitemap: writes `dist/sitemap-nursing.xml` and patches `sitemap.xml`
 * index. `sitemapAliasPlugin` auto-discovers the file so no extra wiring
 * is needed in `sitemapAliasPlugin.ts`.
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
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CTA_PRIMARY_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';
import {
  NURSING_LOCALES,
  NURSING_LANDING_IDS,
  NURSING_LOCALE_PREFIX,
  buildNursingLandingPath,
  type NursingLocale,
  type NursingLandingId,
} from './nursingLandingsData';
import { NURSING_LANDING_COPY, type NursingLandingCopy } from './nursingLandingsCopy';
import { buildSectorHubPath, type SectorHubKey } from './jobSectorLanding';

// CTA target sector for each landing id — null means "fall back to the
// unfiltered job-board hub" (used by `healthcare-ticino`, whose CTA copy
// explicitly says "all openings"). The other two landings target a
// concrete sector so the CTA lands on a filtered list, not the hub.
const CTA_SECTOR: Record<NursingLandingId, SectorHubKey | null> = {
  nurses: 'infermieri',
  oss: 'case-anziani',
  'healthcare-ticino': null,
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
 * `services/router.ts`:
 *   - `/` — root (calcolatore)
 *   - `/cerca-lavoro-ticino/` — job board hub
 *   - `/cerca-lavoro-ticino/infermieri/` — nurses sector hub (existing)
 *   - `/calcola-stipendio/` — salary hub
 *   - `/confronti/stipendi/` — confronto stipendi CH vs IT
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
        `<p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(
          p,
        )}</p>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:24px;color:var(--color-body)">${esc(title)}</h2>${ps}</section>`;
}

function renderFaqBlock(faqs: NursingLandingCopy['faqs']): string {
  const items = faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-body);line-height:1.45">${esc(f.question)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.65">${esc(f.answer)}</p>
      </details>`,
    )
    .join('');
  return items;
}

function renderRelatedLinks(locale: NursingLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li style="margin:0 0 8px"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:22px;color:var(--color-body)">${esc(label)}</h2><ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55;max-width:860px">${items}</ul></section>`;
}

function renderPage(opts: {
  locale: NursingLocale;
  id: NursingLandingId;
  dateStamp: string;
  distDir?: string;
}): RenderResult {
  const { locale, id, dateStamp, distDir } = opts;
  const copy = NURSING_LANDING_COPY[locale][id];
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

  // Breadcrumbs
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const jobBoardUrl = `${BASE_URL}${locale === 'it' ? '/cerca-lavoro-ticino/' : locale === 'en' ? '/en/find-jobs-ticino/' : locale === 'de' ? '/de/jobs-im-tessin/' : '/fr/trouver-emploi-tessin/'}`;
  // CTA must land on the filtered sector hub when the copy promises a
  // specific filter (e.g. "Vedi offerte infermieri" → /cerca-lavoro-ticino/infermieri/).
  const ctaSector = CTA_SECTOR[id];
  const ctaJobsUrl = ctaSector
    ? `${BASE_URL}${buildSectorHubPath(locale, ctaSector)}`
    : jobBoardUrl;

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
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
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

  // Sections — lede + 6–8 H2 + FAQ + related.
  const sections = copy.sections.map((s) => renderSection(s.title, s.paragraphs)).join('');

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
    <header style="margin-bottom:24px">
      <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${esc(copy.updatedLabel)} · ${esc(dateStamp)}</p>
      <h1 style="margin:0 0 16px;font-size:clamp(1.9rem,4vw,2.8rem);line-height:1.15">${esc(copy.h1)}</h1>
      <p style="margin:0;color:var(--color-body);font-size:17px;line-height:1.65;max-width:860px">${esc(copy.lede)}</p>
    </header>
    ${sections}
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:24px;color:var(--color-body)">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${relatedHtml}
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(ctaJobsUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.ctaJobs)}</a>
      <a href="${esc(homeUrl)}" style="padding:12px 18px;border-radius:12px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:700">${esc(copy.ctaSimulator)}</a>
    </section>`;

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">${body}</main>`;

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

      const collector = new WriteCollector({ distDir, pluginName: 'nursingLandingsPlugin' });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];

      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const id of NURSING_LANDING_IDS) {
        // Build hreflang alt list once per id — same 4 locales for every page.
        const alternates = NURSING_LOCALES.map((alt) => `${alt}|${BASE_URL}${buildNursingLandingPath(alt, id)}`);
        alternates.push(`x-default|${BASE_URL}${buildNursingLandingPath('it', id)}`);

        for (const locale of NURSING_LOCALES) {
          const rendered = renderPage({ locale, id, dateStamp, distDir });

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

          // Only emit IT canonicals in the sitemap; EN/DE/FR are surfaced via
          // the hreflang alternates on that IT entry.
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
          fs.writeFileSync(np.join(distDir, 'sitemap-nursing.xml'), xml, 'utf-8');
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[nursing-landings]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[nursing-landings]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    },
  };
}
