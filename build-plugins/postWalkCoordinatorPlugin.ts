/**
 * Post-Walk Coordinator Plugin (perf optimization 2026-04-28).
 *
 * Replaces three sequential post-phase plugins that each walked
 * `dist/**\/*.html` independently:
 *
 *   1. `blogContextualLinksPlugin` — injected 1-2 contextual links per blog
 *      article HTML. Walked only blog articles (~800 files). ~9.5s.
 *   2. `flatHtmlRedirectPlugin` — converted every `<path>.html` with a sibling
 *      `<path>/index.html` into a redirect bridge. Walked all dist/ HTML
 *      (~220k files). ~52.7s.
 *   3. `hreflangPostprocessPlugin` — stripped broken
 *      `<link rel="alternate" hreflang>` tags whose target file did not exist
 *      on disk. Walked all dist/ HTML (~220k files). ~76.3s.
 *
 * Real production timings (deploy 25039504369): 138s combined for the three
 * walks. With this coordinator, dist/ is enumerated ONCE and each HTML file
 * is opened, transformed, and written at most ONCE.
 *
 * Order matters per file:
 *   1. **flat-html-redirect FIRST**: if a file qualifies as a bridge, it is
 *      replaced wholesale by a 9-line redirect. There is no point running
 *      blog-link injection or hreflang cleanup on a bridge — bridges contain
 *      no hreflang tags and never appear under blog article slugs.
 *   2. **blog-contextual-links SECOND**: only on the directory-form HTML of
 *      each blog article (the same set the legacy plugin targeted). Skipped
 *      if the file became a bridge in step 1.
 *   3. **hreflang-postprocess LAST**: walks the (possibly modified) HTML and
 *      strips broken hreflang entries. Skipped for bridges.
 *
 * Idempotency: each transform returns `null` to indicate "no change" so the
 * coordinator only writes a file when at least one transform produced new
 * HTML. Re-running the build with no source changes is a no-op for this
 * coordinator (modulo any new files emitted by upstream plugins).
 *
 * Backward compatibility: the three legacy plugin exports
 * (`blogContextualLinksPlugin`, `flatHtmlRedirectPlugin`,
 * `hreflangPostprocessPlugin`) remain available for unit tests and any
 * downstream code that imports them. They MUST NOT be registered alongside
 * this coordinator — duplicate work would cancel the perf win.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';

import {
  injectContextualLinks,
  listBlogArticleHtmlFiles,
  readBlogIndexSlugs,
  type BlogArticleHtmlFile,
} from './blogContextualLinksPlugin';
import type { BlogLinkLocale } from './blogContextualLinksData';
import { transformFlatRedirect } from './flatHtmlRedirectPlugin';
import { transformHreflang } from './hreflangPostprocessPlugin';

interface CoordinatorOptions {
  readonly baseUrl: string;
}

/**
 * Walk every `.html` file under `dir`, skipping static-asset directories.
 */
function* walkHtml(dir: string): Iterable<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      yield* walkHtml(p);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      yield p;
    }
  }
}

export function postWalkCoordinatorPlugin(
  rootDir: string,
  opts: CoordinatorOptions,
): Plugin {
  const { baseUrl } = opts;
  const trimmedBase = baseUrl.replace(/\/+$/, '');

  return {
    name: 'post-walk-coordinator',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
        const distDir = path.resolve(rootDir, 'dist');
        if (!fs.existsSync(distDir)) {
          // eslint-disable-next-line no-console
          console.warn('[post-walk-coordinator] dist/ missing — skipping');
          return;
        }

        const startTotal = Date.now();

        // ── Phase A: enumerate every emitted HTML file once ──────────
        // We collect the absolute paths in an Array (for stable iteration)
        // and a Set (for O(1) lookup by hreflang transform).
        const allHtmlPaths: string[] = [];
        const existingHtmlSet = new Set<string>();
        for (const file of walkHtml(distDir)) {
          allHtmlPaths.push(file);
          existingHtmlSet.add(file);
        }
        const filesScanned = allHtmlPaths.length;
        if (filesScanned === 0) {
          // eslint-disable-next-line no-console
          console.warn('[post-walk-coordinator] no HTML files in dist/ — skipping');
          return;
        }

        // ── Phase B: load blog-articles target map ONCE ──────────────
        // Used by step 2 to identify which directory-form HTML files are
        // blog articles (so we know to run injectContextualLinks).
        const blogIndexSlugs = readBlogIndexSlugs(rootDir);
        const blogArticles = listBlogArticleHtmlFiles(distDir, blogIndexSlugs);
        // Keep only the directory-form (`.../index.html`) variants — the
        // legacy plugin only mutated those; flat siblings are bridges.
        const blogIndexHtmlByPath = new Map<string, BlogLinkLocale>();
        for (const article of blogArticles) {
          if (article.absPath.endsWith(path.sep + 'index.html')) {
            blogIndexHtmlByPath.set(article.absPath, article.locale);
          }
        }

        // ── Phase C: for each HTML file, apply the 3 transforms in order ──
        let bridgeConverted = 0;
        let bridgeSkipped = 0;
        let blogArticlesModified = 0;
        let blogLinksInjected = 0;
        let hreflangFilesRewritten = 0;
        let hreflangLinksKept = 0;
        let hreflangLinksDropped = 0;
        let totalWrites = 0;

        // Sibling HTML reader — NO IN-MEMORY CACHE. Caching every sibling
        // would balloon to ~4 GB (145k bridges × ~30 KB sibling each) and
        // cause OOM on the 14 GB CI heap. Each sibling is read once per
        // bridge from the OS page cache (already hot since these files were
        // just written by the parallel cohort). Cost ≈ 145k syscalls,
        // negligible compared to the I/O the parallel cohort already did.
        const readSibling = (siblingPath: string): string | null => {
          if (!existingHtmlSet.has(siblingPath)) return null;
          try {
            return fs.readFileSync(siblingPath, 'utf-8');
          } catch {
            return null;
          }
        };

        for (const filePath of allHtmlPaths) {
          let html: string;
          try {
            html = fs.readFileSync(filePath, 'utf-8');
          } catch {
            continue;
          }
          const original = html;
          let mutated = false;
          let isBridge = false;

          // ── Step 1: flat-html-redirect ────────────────────────────
          if (path.basename(filePath) !== 'index.html') {
            const bridge = transformFlatRedirect({
              filePath,
              distDir,
              trimmedBase,
              readSibling,
            });
            if (bridge !== null) {
              html = bridge;
              mutated = true;
              isBridge = true;
              bridgeConverted++;
            } else {
              bridgeSkipped++;
            }
          }

          // ── Step 2: blog-contextual-links (directory-form only) ────
          if (!isBridge) {
            const locale = blogIndexHtmlByPath.get(filePath);
            if (locale !== undefined) {
              const result = injectContextualLinks(html, locale);
              if (result.injected.length > 0 && result.html !== html) {
                html = result.html;
                mutated = true;
                blogArticlesModified++;
                blogLinksInjected += result.injected.length;
              }
            }
          }

          // ── Step 3: hreflang-postprocess ──────────────────────────
          if (!isBridge) {
            const hreflangResult = transformHreflang(
              html,
              distDir,
              baseUrl,
              (absPath) => existingHtmlSet.has(absPath),
            );
            if (hreflangResult !== null) {
              html = hreflangResult.html;
              mutated = true;
              hreflangFilesRewritten++;
              hreflangLinksKept += hreflangResult.kept;
              hreflangLinksDropped += hreflangResult.dropped;
            }
          }

          // ── Single write per file ────────────────────────────────
          if (mutated && html !== original) {
            try {
              fs.writeFileSync(filePath, html, 'utf-8');
              totalWrites++;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              // eslint-disable-next-line no-console
              console.warn(`[post-walk-coordinator] failed to write ${filePath}: ${msg}`);
            }
          }
        }

        const dur = ((Date.now() - startTotal) / 1000).toFixed(2);
        // eslint-disable-next-line no-console
        console.log(
          `\x1b[36m[post-walk-coordinator]\x1b[0m scanned ${filesScanned} files in ${dur}s — ` +
            `bridges: ${bridgeConverted} converted (${bridgeSkipped} non-bridge skipped), ` +
            `blog: ${blogArticlesModified} modified / ${blogLinksInjected} links injected, ` +
            `hreflang: ${hreflangFilesRewritten} rewritten / ${hreflangLinksKept} kept / ${hreflangLinksDropped} dropped, ` +
            `total writes: ${totalWrites}`,
        );
      },
    },
  };
}
