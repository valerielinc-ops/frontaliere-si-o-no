/**
 * Salary Hub SEO — Vite build plugin.
 *
 * Generates ~500 static salary calculation pages at build time.
 * Each page has pre-computed results, 14 AdSense slots, structured data,
 * and localized content in 4 locales (it/en/de/fr).
 *
 * Also generates sitemap-salary-hub.xml and patches it into the main
 * sitemap.xml index.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { BASE_URL } from './constants';
import {
  generateAllScenarios,
  scenarioToInputs,
  buildFullPath,
  type SalaryHubScenario,
} from './salaryHubScenarios';
import { generatePageHtml } from './salaryHubContent';
import { EVERGREEN_ARTICLES, generateArticleHtml } from './salaryHubArticles';
import { calculateSimulation } from '../services/calculationService';
import { buildScenarioIndexHtml, SCENARIO_INDEX_PATH } from './salaryHubIndex';
import { resolveSalaryHubFlushed } from './shared/buildSignals';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];

export function salaryHubPlugin(rootDir: string): Plugin {
  return {
    name: 'salary-hub-seo',
    apply: 'build',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const collector = new WriteCollector({ distDir });

      // ── Generate all scenarios ──────────────────────────────────
      const scenarios = generateAllScenarios();
      console.log(`\x1b[35m[salary-hub]\x1b[0m Generating pages for ${scenarios.length} scenarios x ${LOCALES.length} locales...`);

      // ── Pre-compute simulation results for every scenario ───────
      const results = new Map<SalaryHubScenario, ReturnType<typeof calculateSimulation>>();
      for (const scenario of scenarios) {
        const inputs = scenarioToInputs(scenario);
        results.set(scenario, calculateSimulation(inputs));
      }

      // ── Generate HTML pages for every scenario x locale ─────────
      const sitemapEntries: string[] = [];
      let pageCount = 0;

      for (const scenario of scenarios) {
        const result = results.get(scenario)!;

        // Build hreflang alternates for sitemap
        const hreflangAlts = LOCALES.map(loc => {
          const href = `${BASE_URL}${buildFullPath(scenario, loc)}`;
          return `    <xhtml:link rel="alternate" hreflang="${loc}" href="${href}"/>`;
        });
        const xDefaultHref = `${BASE_URL}${buildFullPath(scenario, 'it')}`;
        hreflangAlts.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${xDefaultHref}"/>`);
        const hreflangBlock = hreflangAlts.join('\n');

        for (const locale of LOCALES) {
          const html = generatePageHtml(scenario, result, locale, scenarios, distDir);
          const urlPath = buildFullPath(scenario, locale);

          // Write /calcola-stipendio/slug/index.html
          const indexPath = path.join(distDir, urlPath, 'index.html');
          collector.add(indexPath, html);

          // Write flat /calcola-stipendio/slug.html (for GitHub Pages compatibility)
          const flatSlug = urlPath.replace(/\/$/, '');
          const flatPath = path.join(distDir, `${flatSlug}.html`);
          collector.add(flatPath, html);

          // Sitemap entry
          const fullUrl = `${BASE_URL}${urlPath}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${fullUrl}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n${hreflangBlock}\n  </url>`
          );

          pageCount++;
        }
      }

      // ── Generate evergreen blog articles ────────────────────────
      const scenarioData = { scenarios, results };
      let articleCount = 0;
      const ARTICLE_PREFIX: Record<Locale, string> = {
        it: '/guida-frontaliere',
        en: '/en/cross-border-guide',
        de: '/de/grenzgaenger-ratgeber',
        fr: '/fr/guide-frontalier',
      };

      for (const article of EVERGREEN_ARTICLES) {
        const articleHreflangAlts = LOCALES.map(loc => {
          const href = `${BASE_URL}${ARTICLE_PREFIX[loc]}/${article.slugs[loc]}/`;
          return `    <xhtml:link rel="alternate" hreflang="${loc}" href="${href}"/>`;
        });
        articleHreflangAlts.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${ARTICLE_PREFIX.it}/${article.slugs.it}/"/>`);
        const articleHreflang = articleHreflangAlts.join('\n');

        for (const locale of LOCALES) {
          const html = generateArticleHtml(article, locale, scenarioData, distDir);
          const urlPath = `${ARTICLE_PREFIX[locale]}/${article.slugs[locale]}/`;

          collector.add(path.join(distDir, urlPath, 'index.html'), html);
          collector.add(path.join(distDir, `${urlPath.replace(/\/$/, '')}.html`), html);

          const fullUrl = `${BASE_URL}${urlPath}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${fullUrl}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n${articleHreflang}\n  </url>`
          );

          articleCount++;
        }
      }
      console.log(`\x1b[35m[salary-hub]\x1b[0m Generated ${articleCount} evergreen article pages`);

      // ── Emit browseable scenario index (eliminates 1 732 orphans) ─
      // The scenario-hub sitemap previously had 100 % orphan rate because no
      // page on the site linked to any of the 1 732 scenario URLs. Adding
      // an index per locale (linked from the calculator hub by
      // salaryHubIndexLinkPlugin) closes the gap: BFS from `/` reaches
      //   /  →  /calcola-stipendio/  →  /calcola-stipendio/scenari/
      //          → every scenario page in this locale.
      const indexHreflangAlts = LOCALES.map(loc => {
        const href = `${BASE_URL}${SCENARIO_INDEX_PATH[loc]}`;
        return `    <xhtml:link rel="alternate" hreflang="${loc}" href="${href}"/>`;
      });
      indexHreflangAlts.push(
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${SCENARIO_INDEX_PATH.it}"/>`,
      );
      const indexHreflangBlock = indexHreflangAlts.join('\n');

      // Build per-locale article-link lists so the scenario index can wire
      // every salary-hub evergreen article into the BFS reachable graph.
      const relatedArticlesByLocale: Record<Locale, Array<{ title: string; href: string }>> = {
        it: [], en: [], de: [], fr: [],
      };
      for (const article of EVERGREEN_ARTICLES) {
        for (const loc of LOCALES) {
          relatedArticlesByLocale[loc].push({
            title: article.titles[loc],
            href: `${ARTICLE_PREFIX[loc]}/${article.slugs[loc]}/`,
          });
        }
      }

      let indexCount = 0;
      for (const locale of LOCALES) {
        // Filter scenarios to those visible in this locale (currently all
        // scenarios apply to every locale — buildSlug just renders different
        // tokens — but kept as a slice in case future locales prune).
        const indexHtml = buildScenarioIndexHtml({
          locale,
          allScenarios: scenarios,
          relatedArticles: relatedArticlesByLocale[locale],
          distDir,
        });
        const indexPath = SCENARIO_INDEX_PATH[locale];
        collector.add(path.join(distDir, indexPath, 'index.html'), indexHtml);
        const flatSlug = indexPath.replace(/\/$/, '');
        collector.add(path.join(distDir, `${flatSlug}.html`), indexHtml);

        const fullUrl = `${BASE_URL}${indexPath}`;
        sitemapEntries.push(
          `  <url>\n    <loc>${fullUrl}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n${indexHreflangBlock}\n  </url>`,
        );
        indexCount++;
      }
      console.log(
        `\x1b[35m[salary-hub]\x1b[0m Generated ${indexCount} scenario index pages (one per locale)`,
      );

      // ── Write sitemap-salary-hub.xml ────────────────────────────
      const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'sitemap-salary-hub.xml'), sitemapContent, 'utf-8');

      // ── Patch sitemap.xml index ─────────────────────────────────
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapIndexPath = path.join(distDir, 'sitemap.xml');
      if (fs.existsSync(sitemapIndexPath)) {
        let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
        if (!idx.includes('sitemap-salary-hub.xml')) {
          idx = idx.replace(
            '</sitemapindex>',
            `  <sitemap>\n    <loc>${BASE_URL}/sitemap-salary-hub.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`
          );
        } else {
          idx = idx.replace(
            /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-salary-hub\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
            `$1${dateStamp}$2`
          );
        }
        fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
      }

      // ── Flush all writes ────────────────────────────────────────
      const t0 = Date.now();
      const written = await collector.flush();
      const skipped = collector.skippedByHash;
      console.log(
        `\x1b[35m[salary-hub]\x1b[0m Flushed ${written} files (${pageCount} pages) in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (skipped > 0 ? ` (${skipped} skipped by content hash)` : '')
      );
      console.log(`\x1b[35m[salary-hub]\x1b[0m Generated sitemap-salary-hub.xml with ${sitemapEntries.length} URLs`);

      // Signal downstream linker plugins that the index pages are on disk.
      // This MUST come after `collector.flush()` so the index HTML is fully
      // persisted before salaryHubIndexLinkPlugin reads the calculator-hub
      // HTML from staticPagesPlugin and patches in the index link.
      resolveSalaryHubFlushed();
    },
  };
}
