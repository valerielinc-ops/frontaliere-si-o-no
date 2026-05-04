/**
 * Salary Hub SEO — Vite build plugin.
 *
 * Generates ~500 static salary calculation pages at build time.
 * Each page has pre-computed results, 14 AdSense slots, structured data,
 * and localized content in 4 locales (it/en/de/fr).
 *
 * Also generates sitemap-salary-hub.xml and patches it into the main
 * sitemap.xml index.
 *
 * Caching (`shared/buildCache.ts`): the heavy work (scenario generation,
 * simulation results, HTML emission, sitemap-salary-hub.xml) is wrapped in
 * `runCached`. The cache key is derived automatically from the esbuild
 * bundle of THIS file — every transitive import (salaryHubScenarios,
 * salaryHubContent, salaryHubArticles, salaryHubIndex, calculationService,
 * shared seo helpers) is included by esbuild's import tracer, so editing
 * any of them invalidates the cache without any manual hash list. There
 * are NO runtime data file inputs; the salary scenario matrix is purely
 * code-driven. The "always-run" portion (sitemap.xml index lastmod patch
 * + downstream signal) executes on every build regardless of cache state.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import { declareSharedPath } from './sharedWriteRegistry';
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
import { runCached } from './shared/buildCache';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];

/**
 * Declare salaryHubPlugin as the canonical owner of every salary-scenario path
 * it emits, so writes from staticPagesPlugin (which iterates its seoMap and
 * happens to cover the same locale-prefixed scenario URLs) don't collide on
 * the same target file.
 *
 * Without this declaration, both plugins' parallel `WriteCollector.add` calls
 * targeted /(en|de|fr)/(calculate-salary|gehalt-berechnen|calculer-salaire)/
 * (net-salary|nettogehalt|salaire-net)-{N}-chf/index.html and the
 * non-deterministic flush race resolved between salaryHubPlugin's richer
 * 14 KB content and staticPagesPlugin's simpler 13 KB shell. Declaring the
 * winner makes the registry skip-write the loser's add() — same outcome
 * every build, no race.
 *
 * The pattern matches both the directory-form (.../net-salary-NN-chf/index.html)
 * and the flat-form (.../net-salary-NN-chf.html) so flatHtmlRedirectPlugin's
 * later post-processing into a redirect bridge is unaffected.
 *
 * Module-load registration: declareSharedPath is idempotent for matching
 * (pattern, winner) pairs, so vite watch-mode rebuilds re-importing this
 * module never accumulate stale entries.
 */
declareSharedPath({
  pattern:
    /\/(stipendio-netto|net-salary|nettogehalt|salaire-net)-\d+-chf(\/index\.html|\.html)$/,
  winner: 'salaryHubPlugin',
  reason:
    'salaryHubPlugin emits ~500 pre-computed salary scenarios across 4 locales with full simulation data + AdSense slots. staticPagesPlugin reaches the same paths via its seoMap loop and would race-overwrite with a less-rich shell. Winner is salaryHubPlugin.',
});

export function salaryHubPlugin(rootDir: string): Plugin {
  return {
    name: 'salary-hub-seo',
    apply: 'build',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');

      // ── Cacheable section ───────────────────────────────────────
      // The scenario matrix and HTML rendering are pure functions of the
      // plugin's source code (no runtime data files). The cache restores
      // the exact same outputs whenever the source bundle hash matches.
      await runCached({
        pluginName: 'salary-hub-seo',
        rootDir,
        distDir,
        bundleEntry: path.resolve(rootDir, 'build-plugins/salaryHubPlugin.ts'),
        work: async ({ recordWrite }) => {
          const collector = new WriteCollector({
            distDir,
            pluginName: 'salaryHubPlugin',
            pathRecorder: recordWrite,
          });

          // ── Generate all scenarios ────────────────────────────
          const scenarios = generateAllScenarios();
          console.log(
            `\x1b[35m[salary-hub]\x1b[0m Generating pages for ${scenarios.length} scenarios x ${LOCALES.length} locales...`,
          );

          // ── Pre-compute simulation results for every scenario ──
          const results = new Map<SalaryHubScenario, ReturnType<typeof calculateSimulation>>();
          for (const scenario of scenarios) {
            const inputs = scenarioToInputs(scenario);
            results.set(scenario, calculateSimulation(inputs));
          }

          // ── Generate HTML pages for every scenario x locale ───
          const sitemapEntries: string[] = [];
          let pageCount = 0;

          for (const scenario of scenarios) {
            const result = results.get(scenario)!;

            // Build hreflang alternates for sitemap
            const hreflangAlts = LOCALES.map((loc) => {
              const href = `${BASE_URL}${buildFullPath(scenario, loc)}`;
              return `    <xhtml:link rel="alternate" hreflang="${loc}" href="${href}"/>`;
            });
            const xDefaultHref = `${BASE_URL}${buildFullPath(scenario, 'it')}`;
            hreflangAlts.push(
              `    <xhtml:link rel="alternate" hreflang="x-default" href="${xDefaultHref}"/>`,
            );
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
                `  <url>\n    <loc>${fullUrl}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n${hreflangBlock}\n  </url>`,
              );

              pageCount++;
            }
          }

          // ── Generate evergreen blog articles ──────────────────
          const scenarioData = { scenarios, results };
          let articleCount = 0;
          const ARTICLE_PREFIX: Record<Locale, string> = {
            it: '/guida-frontaliere',
            en: '/en/cross-border-guide',
            de: '/de/grenzgaenger-ratgeber',
            fr: '/fr/guide-frontalier',
          };

          for (const article of EVERGREEN_ARTICLES) {
            const articleHreflangAlts = LOCALES.map((loc) => {
              const href = `${BASE_URL}${ARTICLE_PREFIX[loc]}/${article.slugs[loc]}/`;
              return `    <xhtml:link rel="alternate" hreflang="${loc}" href="${href}"/>`;
            });
            articleHreflangAlts.push(
              `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${ARTICLE_PREFIX.it}/${article.slugs.it}/"/>`,
            );
            const articleHreflang = articleHreflangAlts.join('\n');

            for (const locale of LOCALES) {
              const html = generateArticleHtml(article, locale, scenarioData, distDir);
              const urlPath = `${ARTICLE_PREFIX[locale]}/${article.slugs[locale]}/`;

              collector.add(path.join(distDir, urlPath, 'index.html'), html);
              collector.add(path.join(distDir, `${urlPath.replace(/\/$/, '')}.html`), html);

              const fullUrl = `${BASE_URL}${urlPath}`;
              sitemapEntries.push(
                `  <url>\n    <loc>${fullUrl}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n${articleHreflang}\n  </url>`,
              );

              articleCount++;
            }
          }
          console.log(`\x1b[35m[salary-hub]\x1b[0m Generated ${articleCount} evergreen article pages`);

          // ── Emit browseable scenario index (eliminates 1 732 orphans)
          const indexHreflangAlts = LOCALES.map((loc) => {
            const href = `${BASE_URL}${SCENARIO_INDEX_PATH[loc]}`;
            return `    <xhtml:link rel="alternate" hreflang="${loc}" href="${href}"/>`;
          });
          indexHreflangAlts.push(
            `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${SCENARIO_INDEX_PATH.it}"/>`,
          );
          const indexHreflangBlock = indexHreflangAlts.join('\n');

          const relatedArticlesByLocale: Record<Locale, Array<{ title: string; href: string }>> = {
            it: [],
            en: [],
            de: [],
            fr: [],
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

          // ── Flush all writes ────────────────────────────────
          const t0 = Date.now();
          const written = await collector.flush();
          const skipped = collector.skippedByHash;
          console.log(
            `\x1b[35m[salary-hub]\x1b[0m Flushed ${written} files (${pageCount} pages) in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
              (skipped > 0 ? ` (${skipped} skipped by content hash)` : ''),
          );

          // ── Write sitemap-salary-hub.xml ────────────────────
          // No per-URL <lastmod> in this sitemap, so the bytes are a pure
          // function of the (deterministic) sitemapEntries — safe to cache.
          // The sitemap.xml index patch with today's date stamp lives in
          // the always-run section below.
          const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
          fs.mkdirSync(distDir, { recursive: true });
          const sitemapPath = path.join(distDir, 'sitemap-salary-hub.xml');
          fs.writeFileSync(sitemapPath, sitemapContent, 'utf-8');
          recordWrite(sitemapPath);
          console.log(
            `\x1b[35m[salary-hub]\x1b[0m Generated sitemap-salary-hub.xml with ${sitemapEntries.length} URLs`,
          );
        },
      });

      // ── Always-run: patch sitemap.xml index with today's date ────
      // Must execute on cache hits too — the sitemap.xml index file is
      // re-emitted by other plugins each build, so our entry's <lastmod>
      // would otherwise drop out. Date is intentionally today (the
      // index advertises "this submap was last touched on date X").
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapIndexPath = path.join(distDir, 'sitemap.xml');
      if (fs.existsSync(sitemapIndexPath)) {
        let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
        if (!idx.includes('sitemap-salary-hub.xml')) {
          idx = idx.replace(
            '</sitemapindex>',
            `  <sitemap>\n    <loc>${BASE_URL}/sitemap-salary-hub.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
          );
        } else {
          idx = idx.replace(
            /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-salary-hub\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
            `$1${dateStamp}$2`,
          );
        }
        fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
      }

      // ── Always-run: signal downstream linker plugins ─────────────
      // After cache restore the salary-hub HTML is on disk, so consumers
      // (salaryHubIndexLinkPlugin) can read it. Resolve unconditionally.
      resolveSalaryHubFlushed();
    },
  };
}
