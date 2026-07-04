/**
 * Post-build sitemap tasks:
 * 0. Sanitize hreflang reciprocity: strip `xhtml:link` annotation groups
 *    that violate Google's sitemap-hreflang method (issue #3474). See
 *    `sanitizeSitemapHreflangReciprocity` below.
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

/** One sitemap file's name + raw XML content, as read from dist/. */
export interface SitemapXmlFile {
  file: string;
  xml: string;
}

/** A `<url>` block that carries xhtml:link hreflang annotations. */
interface AnnotatedBlock {
  file: string;
  loc: string;
  hrefs: { lang: string; href: string }[];
  alive: boolean;
}

const URL_BLOCK_RX = /<url>[\s\S]*?<\/url>/g;
const LOC_RX = /<loc>\s*([^<]+?)\s*<\/loc>/;
const XHTML_LINK_ELEMENT_RX = /<xhtml:link\b[^>]*?\/>/g;
/** Matches a whole xhtml:link line incl. leading indent + trailing newline. */
const XHTML_LINK_LINE_RX = /[ \t]*<xhtml:link\b[^>]*?\/>[ \t]*\r?\n?/g;

/**
 * Strip hreflang annotation groups that violate sitemap-hreflang reciprocity
 * (issue #3474).
 *
 * Google's sitemap-hreflang method requires every alternate URL referenced by
 * an `xhtml:link` annotation to (a) appear as its own `<url><loc>` entry in
 * one of the site's sitemaps and (b) annotate the referring URL back (return
 * tag). Incomplete groups are ignored by Google and surface as "no return
 * tag" noise in Search Console. The committed blog/blog-ch/glossario/news
 * sitemaps annotate IT-only `<loc>` entries whose EN/DE/FR alternates are
 * listed nowhere, so those annotations never had effect at the sitemap level.
 *
 * This pass removes the `xhtml:link` elements from every `<url>` block whose
 * annotation group is incomplete — including degenerate self-only groups
 * (every href equal to the block's own `<loc>`) — and keeps complete groups
 * byte-identical
 * (e.g. sitemap-salary-hub.xml, the reciprocal subsets of
 * sitemap-pages.xml). `<loc>` entries are NEVER added or removed. The
 * on-page HTML hreflang mesh — complete and reciprocal for every stripped
 * URL — remains the authoritative hreflang signal (same valid pattern as the
 * sitemap-jobs-* / sitemap-search-clusters-* shards).
 *
 * NOTE: only the emitted dist/ copies are sanitized. The `public/` sitemap
 * sources keep their annotations on purpose: they are load-bearing build
 * metadata (staticPagesPlugin locale-variant emission, legacyRedirectsPlugin
 * hreflang map, llms.txt, IndexNow locale-URL submission).
 *
 * Pure function (no I/O) so unit tests can exercise it with fixtures.
 * Returns a Map of file name → sanitized XML for the files that changed.
 */
export function sanitizeSitemapHreflangReciprocity(
  files: readonly SitemapXmlFile[],
): Map<string, string> {
  // ── Pass 1: global <loc> set + annotated blocks ──
  const locSet = new Set<string>();
  const annotated: AnnotatedBlock[] = [];
  for (const { file, xml } of files) {
    for (const blockMatch of xml.matchAll(URL_BLOCK_RX)) {
      const block = blockMatch[0];
      const loc = block.match(LOC_RX)?.[1];
      if (!loc) continue;
      locSet.add(loc);
      const hrefs: { lang: string; href: string }[] = [];
      for (const el of block.matchAll(XHTML_LINK_ELEMENT_RX)) {
        const lang = el[0].match(/hreflang="([^"]+)"/)?.[1];
        const href = el[0].match(/href="([^"]+)"/)?.[1];
        if (lang && href) hrefs.push({ lang, href });
      }
      if (hrefs.length > 0) annotated.push({ file, loc, hrefs, alive: true });
    }
  }

  // ── Pass 2: reciprocity fixpoint ──
  // A group survives iff every annotated href is a listed <loc> AND that
  // loc's own (still-alive) annotations point back. Stripping a one-sided
  // group can orphan a neighbour that relied on its return tag, so iterate
  // until stable (symmetric groups converge in one round; the loop only
  // ever strips more, so it terminates).
  for (;;) {
    const backRefs = new Map<string, Set<string>>();
    for (const b of annotated) {
      if (!b.alive) continue;
      let refs = backRefs.get(b.loc);
      if (!refs) {
        refs = new Set<string>();
        backRefs.set(b.loc, refs);
      }
      for (const a of b.hrefs) refs.add(a.href);
    }
    let changed = false;
    for (const b of annotated) {
      if (!b.alive) continue;
      // A group whose every href is the block's own <loc> (seo-hubs page-N
      // emits a single self-referential hreflang="it" link) self-satisfies
      // the reciprocity check while carrying zero hreflang information — and
      // an it-only survivor makes validate-locale-shard-build's all-locales
      // check depend on readdir order. Degenerate ⇒ strip.
      const ok =
        b.hrefs.some((a) => a.href !== b.loc) &&
        b.hrefs.every(
          (a) => locSet.has(a.href) && backRefs.get(a.href)?.has(b.loc),
        );
      if (!ok) {
        b.alive = false;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const deadByFile = new Map<string, Set<string>>();
  for (const b of annotated) {
    if (b.alive) continue;
    let dead = deadByFile.get(b.file);
    if (!dead) {
      dead = new Set<string>();
      deadByFile.set(b.file, dead);
    }
    dead.add(b.loc);
  }

  // ── Pass 3: rewrite only the files with dead groups ──
  const out = new Map<string, string>();
  for (const { file, xml } of files) {
    const dead = deadByFile.get(file);
    if (!dead || dead.size === 0) continue;
    const nextXml = xml.replace(URL_BLOCK_RX, (block) => {
      const loc = block.match(LOC_RX)?.[1];
      if (!loc || !dead.has(loc)) return block;
      return block.replace(XHTML_LINK_LINE_RX, '');
    });
    if (nextXml !== xml) out.set(file, nextXml);
  }
  return out;
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

        // 0. Hreflang-reciprocity sanitizer (issue #3474). Runs BEFORE the
        //    legacy alias copy so sitemap_news.xml inherits sanitized
        //    content, and before index regeneration.
        const sitemapFiles: SitemapXmlFile[] = fs
          .readdirSync(distDir)
          .filter(
            (f) => SITEMAP_FILE_PATTERN.test(f) && !EXCLUDED_SITEMAP_FILES.has(f),
          )
          .map((file) => ({
            file,
            xml: fs.readFileSync(path.join(distDir, file), 'utf-8'),
          }));
        const sanitized = sanitizeSitemapHreflangReciprocity(sitemapFiles);
        for (const [file, xml] of sanitized) {
          fs.writeFileSync(path.join(distDir, file), xml, 'utf-8');
        }
        if (sanitized.size > 0) {
          console.log(
            `\x1b[36m[sitemap-alias]\x1b[0m Stripped one-sided hreflang groups from ${sanitized.size} sitemap(s): ${[...sanitized.keys()].join(', ')}`,
          );
        }

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
