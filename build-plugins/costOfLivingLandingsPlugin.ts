/**
 * Cost-of-living city landings — Vite build plugin (AE-4).
 *
 * Emits 24 static HTML pages (6 cities × 4 locales):
 *
 *   Cities:   Lugano, Mendrisio, Chiasso, Bellinzona, Locarno + Ticino rollup
 *   Locales:  IT canonical (/costo-vita-<city>-ticino/) + EN/DE/FR variants
 *
 * Each page renders the canonical hub sub-nav (`confronti / cost-of-living`)
 * so the static first-paint matches the SPA chrome (BUG-2 fix).
 *
 * Content structure per page:
 *   - TL;DR (≥60 w) with CH vs IT rent + single-total numbers
 *   - Median-rent table (studio/1.5 → 4.5 rooms) from FSO 2023 snapshot
 *   - Italian basket table (OMI + ISTAT) for paired commuter province
 *   - CH vs IT comparison table with % delta
 *   - Frontaliere narrative (2026 tax agreement + commuting costs)
 *   - Sources + methodology paragraph
 *   - 3 PAA FAQs with inline citations
 *
 * Every numeric claim carries `[source: FSO|ISTAT|OMI](url)` inline.
 * Word counts consistently exceed 500 w (IT) / 400 w (EN/DE/FR).
 *
 * JSON-LD emitted per page:
 *   - BreadcrumbList (Home → Cost-of-living hub → This city)
 *   - Article (with datePublished / dateModified, inLanguage)
 *   - FAQPage (3 Q&As)
 *   - Place + LocalBusiness (Place = the city, LocalBusiness = our org serving it)
 *
 * Sitemap: writes `dist/sitemap-cost-of-living.xml`, patches index.
 * `sitemapAliasPlugin` auto-discovers the file — no manual wiring.
 *
 * Env gate: SKIP_COST_OF_LIVING=1 fast-exits (local builds only; CI always runs).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import {
  COL_LOCALES,
  COL_CITY_IDS,
  COL_CITY_DISPLAY,
  COL_CITY_GEO,
  buildCostOfLivingLandingPath,
  type ColLocale,
  type ColCityId,
} from './costOfLivingLandingsData';
import {
  buildCitySections,
  buildFaqs,
  getLocaleStrings,
} from './costOfLivingLandingsCopy';
import {
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
  H1_STYLE,
  H2_STYLE,
  CARD_STYLE,
  LINK_ACCENT_STYLE,
  CTA_PRIMARY_STYLE,
  HERO_EYEBROW_STYLE,
} from './shared/seoContentTokens';

// ── Escape ─────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<ColLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

// ── Rendering ─────────────────────────────────────────────────────

interface RenderResult {
  readonly urlPath: string;
  readonly html: string;
  readonly wordCount: number;
}

function renderPage(opts: {
  locale: ColLocale;
  city: ColCityId;
  dateStamp: string;
  distDir?: string;
}): RenderResult {
  const { locale, city, dateStamp, distDir } = opts;
  const L = getLocaleStrings(locale);
  const cityName = COL_CITY_DISPLAY[city][locale];
  const geo = COL_CITY_GEO[city];
  const urlPath = buildCostOfLivingLandingPath(locale, city);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const paired =
    city === 'ticino'
      ? locale === 'it'
        ? 'Lombardia'
        : locale === 'en'
          ? 'Lombardy'
          : locale === 'de'
            ? 'Lombardei'
            : 'Lombardie'
      : city === 'bellinzona'
        ? 'Lecco'
        : city === 'locarno'
          ? 'Varese'
          : 'Como';

  const title = L.title(cityName);
  const description = L.description(cityName, paired);
  const h1 = L.h1(cityName);

  // Hreflang — 4 locales + x-default (IT canonical).
  const hreflangLines = COL_LOCALES.map(
    (alt) =>
      `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${buildCostOfLivingLandingPath(alt, city)}">`,
  );
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildCostOfLivingLandingPath('it', city)}">`,
  );
  const alternates = hreflangLines.join('\n');

  // Breadcrumbs
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubUrl = `${BASE_URL}${L.breadcrumbHubPath}`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: L.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: L.breadcrumbHub, item: hubUrl },
      { '@type': 'ListItem', position: 3, name: cityName, item: canonicalUrl },
    ],
  };

  const faqs = buildFaqs(locale, city);
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: h1,
    description,
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
  };

  // Place JSON-LD — city = AdministrativeArea (IT rollup) or City.
  const placeLd = {
    '@context': 'https://schema.org',
    '@type': city === 'ticino' ? 'AdministrativeArea' : 'City',
    name: cityName,
    ...(geo.addressLocality !== null && geo.lat !== null
      ? {
          address: {
            '@type': 'PostalAddress',
            addressCountry: 'CH',
            addressRegion: 'TI',
            addressLocality: geo.addressLocality,
            postalCode: geo.postalCode ?? undefined,
          },
          geo: { '@type': 'GeoCoordinates', latitude: geo.lat, longitude: geo.lon },
        }
      : {
          address: { '@type': 'PostalAddress', addressCountry: 'CH', addressRegion: 'TI' },
          geo:
            geo.lat !== null && geo.lon !== null
              ? { '@type': 'GeoCoordinates', latitude: geo.lat, longitude: geo.lon }
              : undefined,
        }),
    url: canonicalUrl,
  };

  // LocalBusiness JSON-LD — our org serving this area.
  const localBusinessLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: 'Frontaliere Ticino',
    url: BASE_URL,
    image: `${BASE_URL}/og-image.png`,
    areaServed: { '@type': city === 'ticino' ? 'AdministrativeArea' : 'City', name: cityName },
    description:
      locale === 'it'
        ? 'Consulenza frontalieri: simulazione stipendio, costo vita, permessi'
        : locale === 'en'
          ? 'Cross-border worker services: salary simulation, cost of living, permits'
          : locale === 'de'
            ? 'Grenzgänger-Service: Gehaltssimulation, Lebenshaltungskosten, Bewilligungen'
            : 'Services frontaliers : simulation salaire, coût de la vie, permis',
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'CH',
      addressRegion: 'TI',
      addressLocality: geo.addressLocality ?? 'Lugano',
    },
  };

  // Body sections
  const sections = buildCitySections(locale, city);
  const sectionsHtml = sections
    .map(
      (s) => `
        <section style="margin:0 0 28px;max-width:960px">
          <h2 style="${H2_STYLE}">${esc(s.title)}</h2>
          ${s.html}
        </section>`,
    )
    .join('');

  const faqHtml = faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;${CARD_STYLE};border-radius:12px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45">${esc(f.question)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.65">${esc(f.answer)}</p>
      </details>`,
    )
    .join('');

  const relatedHtml = L.related
    .map(
      (r) =>
        `<li style="margin:0 0 8px"><a href="${esc(r.href)}" style="${LINK_ACCENT_STYLE}">${esc(r.label)}</a></li>`,
    )
    .join('');

  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(L.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(hubUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(L.breadcrumbHub)}</a>
      <span> / </span>
      <span>${esc(cityName)}</span>
    </nav>
    <header style="margin-bottom:24px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(L.updatedLabel)} · ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    </header>
    ${sectionsHtml}
    <section style="margin:0 0 28px;max-width:960px">
      <h2 style="${H2_STYLE}">${esc(L.faqTitle)}</h2>
      ${faqHtml}
    </section>
    <section style="margin:0 0 28px;max-width:960px">
      <h2 style="${H2_STYLE}">${esc(L.relatedLabel)}</h2>
      <ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55">${relatedHtml}</ul>
    </section>
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(homeUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(L.ctaSimulator)}</a>
      <a href="${esc(hubUrl)}" style="${CARD_STYLE};padding:12px 18px;border-radius:12px;text-decoration:none;font-weight:700">${esc(L.ctaCompare)}</a>
    </section>`;

  const bodyHtml = `<main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">${body}</main>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(h1)}">
    <meta name="twitter:description" content="${esc(description)}">`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    extraHeadHtml: extraHead,
    jsonLdScripts: [
      JSON.stringify(breadcrumbLd),
      JSON.stringify(articleLd),
      JSON.stringify(faqLd),
      JSON.stringify(placeLd),
      JSON.stringify(localBusinessLd),
    ],
    bodyHtml,
    distDir,
    hubChrome: {
      hubKey: 'confronti',
      activeSubTab: 'cost-of-living',
    },
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ───────────────────────────────────────────────────────

function buildSitemapXml(
  entries: ReadonlyArray<{ readonly canonical: string; readonly alternates: readonly string[] }>,
  today: string,
): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map((a) => {
          const [lang, ...rest] = a.split('|');
          return `    <xhtml:link rel="alternate" hreflang="${lang}" href="${rest.join('|')}" />`;
        })
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
    if (!idx.includes('sitemap-cost-of-living.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-cost-of-living.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-cost-of-living\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[cost-of-living] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ──────────────────────────────────────────────────

export function costOfLivingLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'cost-of-living-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_COST_OF_LIVING === '1') {
        console.log(
          '\x1b[33m[cost-of-living]\x1b[0m Skipped (SKIP_COST_OF_LIVING=1)',
        );
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const collector = new WriteCollector({ distDir, pluginName: 'costOfLivingLandingsPlugin' });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapEntries: Array<{
        readonly canonical: string;
        readonly alternates: readonly string[];
      }> = [];

      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const city of COL_CITY_IDS) {
        const altLinks = COL_LOCALES.map(
          (alt) => `${alt}|${BASE_URL}${buildCostOfLivingLandingPath(alt, city)}`,
        );
        altLinks.push(`x-default|${BASE_URL}${buildCostOfLivingLandingPath('it', city)}`);

        for (const locale of COL_LOCALES) {
          const rendered = renderPage({ locale, city, dateStamp, distDir });

          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            thinSkipped++;
            console.warn(
              `\x1b[33m[cost-of-living]\x1b[0m ${locale}/${city} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
            );
            continue;
          }

          const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, rendered.html);
          collector.add(flatPath, rendered.html);

          if (locale === 'it') {
            sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
          }

          pagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const xml = buildSitemapXml(sitemapEntries, dateStamp);
          fs.mkdirSync(distDir, { recursive: true });
          fs.writeFileSync(np.join(distDir, 'sitemap-cost-of-living.xml'), xml, 'utf-8');
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[cost-of-living]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[cost-of-living]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    },
  };
}
