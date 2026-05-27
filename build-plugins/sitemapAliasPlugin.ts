/**
 * Post-build sitemap tasks:
 * 1. Keep backward compatibility with the legacy sitemap_news.xml filename
 * 2. Regenerate `dist/sitemap.xml` as a sitemap index containing EVERY
 *    `dist/sitemap-*.xml` file present after the build. This turns the
 *    index into an auto-discovered manifest so future feature plugins
 *    don't have to manually patch the index — they just write their
 *    own `sitemap-*.xml` at `closeBundle` and this plugin picks it up.
 *
 * Ordering:
 *   - `enforce: 'post'` + `closeBundle.order: 'post'` ensure this plugin
 *     runs AFTER every SEO plugin that emits a sub-sitemap. Vite's closeBundle
 *     order across plugins is preserved (declaration order) but `post`
 *     guarantees we run in the last batch.
 *
 * Legacy entries (sitemap-pages.xml, sitemap-blog.xml, …) are preserved
 * because those files are seeded by `public/` and copied into `dist/` by
 * Vite, so they appear in the `readdirSync(distDir)` listing exactly like
 * the dynamic ones.
 */

import path from 'path';
import type { Plugin } from 'vite';
import { BASE_URL } from './constants';

/**
 * Filenames that must NEVER appear in the sitemap index itself:
 *  - `sitemap.xml` — the index we're regenerating
 *  - `sitemap_news.xml` — legacy alias of sitemap-news.xml (same content;
 *    listing both would be a duplicate entry)
 */
const EXCLUDED_SITEMAP_FILES = new Set<string>([
  'sitemap.xml',
  'sitemap_news.xml',
]);

/** Match `sitemap-<name>.xml` — underscore separator is reserved for legacy. */
const SITEMAP_FILE_PATTERN = /^sitemap-[a-z0-9][a-z0-9-]*\.xml$/i;

export interface DiscoveredSitemap {
  file: string;
  lastmod: string; // YYYY-MM-DD
}

/**
 * Discover every `sitemap-*.xml` in `distDir` and return a de-duplicated,
 * alphabetically sorted list with each file's last-modified date (YYYY-MM-DD).
 * `sitemap.xml` itself and `sitemap_news.xml` are excluded.
 *
 * The function is pure (no writes) so unit tests can exercise it with a
 * seeded tmpdir.
 */
export async function discoverSitemapFiles(distDir: string): Promise<DiscoveredSitemap[]> {
  const fs = await import('node:fs');
  if (!fs.existsSync(distDir)) return [];
  const entries = fs.readdirSync(distDir);
  const seen = new Set<string>();
  const discovered: DiscoveredSitemap[] = [];
  for (const file of entries) {
    if (EXCLUDED_SITEMAP_FILES.has(file)) continue;
    if (!SITEMAP_FILE_PATTERN.test(file)) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    let lastmod: string;
    try {
      const stat = fs.statSync(path.join(distDir, file));
      lastmod = stat.mtime.toISOString().slice(0, 10);
    } catch {
      // If stat fails, fall back to today — keeps the index valid rather
      // than crashing the build over a transient filesystem hiccup.
      lastmod = new Date().toISOString().slice(0, 10);
    }
    discovered.push({ file, lastmod });
  }
  // Alphabetical sort — stable, deterministic output across builds.
  discovered.sort((a, b) => a.file.localeCompare(b.file));
  return discovered;
}

/**
 * Build a complete sitemap-index XML from a list of discovered entries.
 * Callers pass the base URL explicitly so tests can pin it without relying
 * on the `BASE_URL` constant.
 */
export function buildSitemapIndexXml(
  sitemaps: readonly DiscoveredSitemap[],
  baseUrl: string,
): string {
  const entries = sitemaps
    .map(
      (s) =>
        `  <sitemap>\n    <loc>${baseUrl}/${s.file}</loc>\n    <lastmod>${s.lastmod}</lastmod>\n  </sitemap>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>
`;
}

export function sitemapAliasPlugin(rootDir: string): Plugin {
  return {
    name: 'sitemap-alias',
    apply: 'build',
    // `enforce: 'post'` ensures this plugin is ordered after plugins without
    // an `enforce` flag. Combined with `closeBundle.order: 'post'`, this
    // guarantees the sitemap index is regenerated after every other plugin
    // has written its sub-sitemap.
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        const fs = await import('node:fs');
        const distDir = path.resolve(rootDir, 'dist');
        if (!fs.existsSync(distDir)) return;

        // 1. Legacy alias: sitemap-news.xml → sitemap_news.xml
        //    Must run BEFORE discovery so the alias file exists when the
        //    discovery step runs (the alias is excluded from the index, but
        //    we still need it on disk for legacy consumers).
        const source = path.join(distDir, 'sitemap-news.xml');
        const target = path.join(distDir, 'sitemap_news.xml');
        if (fs.existsSync(source)) {
          fs.copyFileSync(source, target);
          console.log('\x1b[36m[sitemap-alias]\x1b[0m Created sitemap_news.xml alias');
        }

        // 2. Auto-discover all sitemap-*.xml in dist/ and regenerate the index
        const discovered = await discoverSitemapFiles(distDir);
        const indexPath = path.join(distDir, 'sitemap.xml');
        const xml = buildSitemapIndexXml(discovered, BASE_URL);
        fs.writeFileSync(indexPath, xml, 'utf-8');

        const fileNames = discovered.map((s) => s.file).join(', ');
        console.log(
          `\x1b[36m[sitemap-alias]\x1b[0m Regenerated sitemap.xml with ${discovered.length} sub-sitemap(s): ${fileNames || '(none)'}`,
        );
      },
    },
  };
}
