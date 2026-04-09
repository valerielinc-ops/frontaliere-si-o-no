/**
 * flatContentPlugin — Post-build plugin that ensures flat .html files serve
 * the same content as their corresponding directory index.html files.
 *
 * Problem: Previously, flat `.html` files (e.g., `articoli-frontaliere/slug.html`)
 * contained a `location.replace()` JS redirect to the trailing-slash canonical
 * (e.g., `articoli-frontaliere/slug/index.html`).  Google classified these as
 * "Pagina con reindirizzamento" (Page with redirect) and refused to index them.
 * Bing classified them as "Blocked" due to the `noindex` meta tag, causing
 * 48-56% of all URLs to be invisible on Bing Search.
 *
 * Fix: This plugin runs AFTER all other build plugins (using `sequential: true`
 * on the `closeBundle` hook) and replaces every flat .html file that has a
 * matching `path/index.html` with a copy of that index.html.  Both URLs now
 * serve identical content with the same `<link rel="canonical">` pointing to
 * the trailing-slash version.
 *
 * Strategy: replace ALL flat files that have a matching directory index.html,
 * EXCEPT those that are intentionally different (legacy redirects, bridge pages
 * with __BRIDGE_TARGET_SLUG__, archived soft-landing pages). This ensures no
 * flat alias file accidentally serves noindex/redirect content that search
 * engines classify as "Blocked".
 *
 * CRITICAL: `closeBundle` is a PARALLEL hook in Rollup/Vite. Without
 * `sequential: true`, this plugin races with jobsSeoPagesPlugin and
 * staticPagesPlugin, seeing 0 files to replace because they haven't been
 * flushed yet. The `sequential: true` flag ensures this runs after all
 * parallel plugins complete their closeBundle hooks.
 */

import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

export function flatContentPlugin(): Plugin {
  return {
    name: 'flat-content-duplicator',
    apply: 'build',
    closeBundle: {
      sequential: true,
      order: 'post' as const,
      async handler() {
        const distDir = path.resolve('dist');
        if (!fs.existsSync(distDir)) return;

        let replaced = 0;
        let skipped = 0;
        let noIndexHtml = 0;

        const walk = (dir: string) => {
          let entries: import('node:fs').Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
          catch { return; /* directory may have been removed by another plugin */ }
          for (const entry of entries) {
            if (entry.isDirectory()) {
              walk(path.join(dir, entry.name));
              continue;
            }

            // Only process flat .html files (not index.html, 404.html, or non-html)
            if (
              !entry.name.endsWith('.html') ||
              entry.name === 'index.html' ||
              entry.name === '404.html'
            ) continue;

            const flatPath = path.join(dir, entry.name);

            // Find the corresponding directory index.html
            const baseName = entry.name.replace(/\.html$/, '');
            const indexPath = path.join(dir, baseName, 'index.html');

            // If there's no matching index.html, skip — this flat file IS the
            // canonical (e.g. legacy redirect pages that only exist as flat files)
            if (!fs.existsSync(indexPath)) {
              skipped++;
              continue;
            }

            // Read flat file to check if it should be preserved as-is
            let content: string;
            try { content = fs.readFileSync(flatPath, 'utf-8'); }
            catch { continue; /* file removed between readdir and read */ }

            // Preserve intentionally different flat files:
            // - Bridge pages with __BRIDGE_TARGET_SLUG__ (old slug → current slug redirects)
            // - Legacy redirect pages ("Pagina spostata" / "Page moved")
            // - Archived/expired soft-landing pages with unique content
            // These are generated as flat files WITH a matching index.html that has
            // different content, so we must not overwrite them.
            const isBridgePage = content.includes('__BRIDGE_TARGET_SLUG__');
            const isLegacyRedirect =
              content.includes('Pagina spostata') ||
              content.includes('Page moved') ||
              content.includes('Seite verschoben') ||
              content.includes('Page déplacée');

            if (isBridgePage || isLegacyRedirect) {
              skipped++;
              continue;
            }

            // Replace flat file with the directory index.html content
            // Skip 0-byte source files to avoid propagating I/O failures
            try {
              if (fs.statSync(indexPath).size === 0) { skipped++; continue; }
            } catch { continue; }
            fs.copyFileSync(indexPath, flatPath);
            replaced++;
          }
        };

        walk(distDir);
        console.log(
          `\x1b[36m[flat-content]\x1b[0m Replaced ${replaced} flat redirect files with content copies` +
          ` (${skipped} skipped, ${noIndexHtml} without matching index.html)`,
        );
      },
    },
  };
}
