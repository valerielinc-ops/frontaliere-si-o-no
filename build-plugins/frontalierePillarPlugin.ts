/**
 * Pillar hub "frontaliere" (#3393) — Vite build plugin.
 *
 * Emits 4 static HTML pages (IT canonical /frontaliere/ + en/de/fr
 * variants) via buildSeoPageHtml (static-overlay contract). Mobile-first
 * layout per CLAUDE.md: breadcrumb → header (eyebrow · H1 · dense lede)
 * → 3 stat tiles → primary CTA → orchestration sections → per-profession
 * link grid → FAQ → related → sources.
 *
 * The pillar orchestrates the "frontaliere" topic cluster and hands off
 * to the deep pages; content lives in frontalierePillarCopy.ts.
 *
 * JSON-LD: BreadcrumbList + FAQPage + Article (locale-tagged).
 * Sitemap: writes sitemap-frontaliere-pillar.xml and patches the
 * sitemap.xml index (same pattern as careerLandingsPlugin).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import {
  FRONTALIERE_PILLAR_LOCALES,
  buildFrontalierePillarPath,
  type FrontalierePillarLocale,
} from './frontalierePillarData';
import { FRONTALIERE_PILLAR_COPY, PILLAR_PROFESSION_IDS } from './frontalierePillarCopy';
import { buildProfessionLandingPath } from './professionLandingsData';
import { PROFESSION_FACTS } from './professionLandingsData';
import { getProfessionAnchorLabel } from './professionLandingsLinksPlugin';
import {
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  LINK_ACCENT_STYLE,
  HERO_EYEBROW_STYLE,
  STAT_TILE_ACCENT,
  STAT_TILE_SUCCESS,
  STAT_TILE_BASE,
} from './shared/seoContentTokens';
import { buildTitleWithBrand } from './shared/titleSuffix';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<FrontalierePillarLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const TILE_STYLES = [STAT_TILE_ACCENT, STAT_TILE_SUCCESS, STAT_TILE_BASE] as const;

function renderPage(locale: FrontalierePillarLocale, dateStamp: string, distDir: string) {
  const copy = FRONTALIERE_PILLAR_COPY[locale];
  const urlPath = buildFrontalierePillarPath(locale);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;

  const hreflangLines = FRONTALIERE_PILLAR_LOCALES.map(
    (alt) => `  <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${buildFrontalierePillarPath(alt)}">`,
  );
  hreflangLines.push(
    `  <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildFrontalierePillarPath('it')}">`,
  );

  const breadcrumbHtml = `<nav aria-label="breadcrumb" class="text-sm mb-4"><ol class="flex flex-wrap gap-1 list-none p-0 m-0">
  <li><a href="${esc(homeUrl)}" style="${LINK_ACCENT_STYLE}">${esc(copy.breadcrumbHome)}</a><span aria-hidden="true"> › </span></li>
  <li><a href="${esc(copy.guideHubHref)}" style="${LINK_ACCENT_STYLE}">${esc(copy.breadcrumbGuide)}</a><span aria-hidden="true"> › </span></li>
  <li aria-current="page">${esc(copy.h1)}</li>
</ol></nav>`;

  const tilesHtml = copy.statTiles
    .map(
      (t, i) => `<div style="${TILE_STYLES[i % TILE_STYLES.length]}">
  <div class="text-2xl font-bold">${esc(t.value)}</div>
  <div class="text-sm">${esc(t.label)}</div>
</div>`,
    )
    .join('\n');

  const sectionsHtml = copy.sections
    .map(
      (s) => `<section class="mt-8">
  <h2 style="${H2_STYLE}">${esc(s.heading)}</h2>
  ${s.paragraphsHtml.map((p) => `<p style="${BODY_STYLE}">${p}</p>`).join('\n  ')}
</section>`,
    )
    .join('\n');

  // Per-profession link grid: locale-correct paths by construction, live
  // jobs count from the same frozen snapshot the landings render.
  const professionCards = PILLAR_PROFESSION_IDS.map((id) => {
    const href = buildProfessionLandingPath(locale, id);
    const label = getProfessionAnchorLabel(locale, id);
    const count = PROFESSION_FACTS[id].jobsCount;
    return `  <li><a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(label)}</a> <span class="text-subtle text-sm">(${count}+)</span></li>`;
  }).join('\n');

  const professionsHtml = `<section class="mt-8">
  <h2 style="${H2_STYLE}">${esc(copy.professionsHeading)}</h2>
  <p style="${BODY_STYLE}">${copy.professionsIntro}</p>
  <ul class="mt-3 grid gap-2 sm:grid-cols-2 list-none p-0">
${professionCards}
  </ul>
</section>`;

  const faqHtml = `<section class="mt-8">
  <h2 style="${H2_STYLE}">${esc(copy.faqHeading)}</h2>
  ${copy.faqs
    .map(
      (f) => `<details class="mt-2 rounded-lg border border-edge p-3"><summary class="font-semibold cursor-pointer">${esc(f.question)}</summary><p style="${BODY_STYLE}" class="mt-2">${esc(f.answer)}</p></details>`,
    )
    .join('\n  ')}
</section>`;

  const relatedHtml = `<section class="mt-8">
  <h2 style="${H2_STYLE}">${esc(copy.relatedHeading)}</h2>
  <ul class="mt-3 grid gap-2 sm:grid-cols-2 list-none p-0">
  ${copy.related.map((l) => `<li><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`).join('\n  ')}
  </ul>
</section>`;

  const sourcesHtml = `<section class="mt-8 text-sm">
  <h2 style="${H2_STYLE}">${esc(copy.sourcesLabel)}</h2>
  <ul class="mt-2 list-disc pl-5">
  ${copy.sources
    .map(
      (s) => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank" style="${LINK_ACCENT_STYLE}">${esc(s.label)}</a></li>`,
    )
    .join('\n  ')}
  </ul>
</section>`;

  const bodyHtml = `<div class="max-w-3xl mx-auto px-4 py-6">
${breadcrumbHtml}
<p style="${HERO_EYEBROW_STYLE}">${esc(copy.eyebrow)}</p>
<h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
<p style="${LEDE_STYLE}">${esc(copy.lede)}</p>
<div class="mt-4 grid gap-3 sm:grid-cols-3">
${tilesHtml}
</div>
<div class="s-KZc0LQ"><a href="${esc(copy.primaryCtaHref)}" class="s-cta">${esc(copy.primaryCtaLabel)} →</a></div>
${sectionsHtml}
${professionsHtml}
${faqHtml}
${relatedHtml}
${sourcesHtml}
</div>`;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbGuide, item: `${BASE_URL}${copy.guideHubHref}` },
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
      logo: imageObjectLd({ url: `${BASE_URL}/icons/icon-512x512.png`, width: 512, height: 512 }),
    },
  });

  const wordCount = countHtmlBodyWords(bodyHtml);
  const html = buildSeoPageHtml({
    locale,
    title: buildTitleWithBrand(copy.title),
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: hreflangLines.join('\n'),
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'guida', activeSubTab: 'pillar' },
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ────────────────────────────────────────────────────────────────

function buildSitemapXml(today: string): string {
  const alternates = FRONTALIERE_PILLAR_LOCALES.map(
    (alt) => `    <xhtml:link rel="alternate" hreflang="${alt}" href="${BASE_URL}${buildFrontalierePillarPath(alt)}" />`,
  );
  alternates.push(
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildFrontalierePillarPath('it')}" />`,
  );
  const urls = FRONTALIERE_PILLAR_LOCALES.map(
    (loc) => `  <url>
    <loc>${BASE_URL}${buildFrontalierePillarPath(loc)}</loc>
${alternates.join('\n')}
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-frontaliere-pillar.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-frontaliere-pillar.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-frontaliere-pillar\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn(`\x1b[33m[frontaliere-pillar]\x1b[0m sitemap index patch failed: ${String(err)}`);
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export function frontalierePillarPlugin(rootDir: string): Plugin {
  return {
    name: 'frontaliere-pillar',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_FRONTALIERE_PILLAR === '1') {
        console.log('\x1b[33m[frontaliere-pillar]\x1b[0m Skipped (SKIP_FRONTALIERE_PILLAR=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;
      const dateStamp = new Date().toISOString().slice(0, 10);

      const collector = new WriteCollector({ distDir, pluginName: 'frontalierePillarPlugin' });
      let pagesWritten = 0;
      for (const locale of FRONTALIERE_PILLAR_LOCALES) {
        const rendered = renderPage(locale, dateStamp, distDir);
        if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
          console.warn(
            `\x1b[33m[frontaliere-pillar]\x1b[0m ${locale} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — emitted noindex`,
          );
        }
        collector.add(np.join(distDir, rendered.urlPath, 'index.html'), rendered.html);
        pagesWritten++;
      }
      await collector.flush();

      fs.writeFileSync(np.join(distDir, 'sitemap-frontaliere-pillar.xml'), buildSitemapXml(dateStamp), 'utf-8');
      patchSitemapIndex(distDir, dateStamp);
      console.log(`\x1b[32m[frontaliere-pillar]\x1b[0m ${pagesWritten} pages + sitemap written`);
    },
  };
}
