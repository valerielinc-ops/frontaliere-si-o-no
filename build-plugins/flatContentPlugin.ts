/**
 * flatContentPlugin — Post-build plugin that ensures flat .html files serve
 * the same content as their corresponding directory index.html files.
 *
 * Problem: Previously, flat `.html` files (e.g., `articoli-frontaliere/slug.html`)
 * contained a `location.replace()` JS redirect to the trailing-slash canonical
 * (e.g., `articoli-frontaliere/slug/index.html`).  Google classified these as
 * "Pagina con reindirizzamento" (Page with redirect) and refused to index them.
 *
 * Fix: This plugin runs AFTER all other build plugins and replaces every flat
 * redirect file with a copy of the corresponding `path/index.html`.  Both URLs
 * now serve identical content with the same  `<link rel="canonical">`  pointing
 * to the trailing-slash version.  Google sees content (not a redirect) and
 * consolidates via canonical — reporting "Alternate page with proper canonical
 * tag" instead of "Page with redirect".
 */

import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

export function flatContentPlugin(): Plugin {
  return {
    name: 'flat-content-duplicator',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve('dist');
      if (!fs.existsSync(distDir)) return;

      let replaced = 0;
      let skipped = 0;

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
          let content: string;
          try { content = fs.readFileSync(flatPath, 'utf-8'); }
          catch { continue; /* file removed between readdir and read */ }

          // Replace files that contain our redirect markers:
          // - Old pattern: location.replace() JS redirect
          // - Current pattern: "Versione canonica" bridge page
          const isRedirect =
            content.includes('location.replace(') ||
            content.includes('Versione canonica disponibile');
          if (!isRedirect) {
            skipped++;
            continue;
          }

          // Find the corresponding directory index.html
          const baseName = entry.name.replace(/\.html$/, '');
          const indexPath = path.join(dir, baseName, 'index.html');

          if (fs.existsSync(indexPath)) {
            fs.copyFileSync(indexPath, flatPath);
            replaced++;
          } else {
            skipped++;
          }
        }
      };

      walk(distDir);
      console.log(
        `\x1b[36m[flat-content]\x1b[0m Replaced ${replaced} flat redirect files with content copies (${skipped} skipped)`,
      );
    },
  };
}
