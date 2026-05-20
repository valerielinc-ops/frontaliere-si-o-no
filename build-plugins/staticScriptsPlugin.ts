/**
 * Emits the previously-inline analytics / SPA bootstrap scripts as standalone
 * .js files under dist/assets/ at the end of the build. Used by:
 *
 *   GTAG_SNIPPET                  → /assets/gtag-init-{hash}.js
 *   ADSENSE_SNIPPET               → /assets/adsense-loader-{hash}.js
 *   EARLY_BOOT_SCRIPT             → /assets/early-boot-{hash}.js
 *                                   (concat of dark-mode-init + spa-action-redirect)
 *   POSTHOG_SNIPPET               → /assets/posthog-init-{hash}.js
 *
 * Also rehashes two stylesheets that Vite copies verbatim from public/assets/:
 *
 *   SEO_STATIC_CSS_LINK           → /assets/seo-static-{hash}.css
 *   BRIDGE_CSS_LINK               → /assets/bridge-{hash}.css
 *
 * Each SEO-static HTML page (per-job, soft-landing, bridge, hub, etc.) used to
 * inline all four constants directly. That duplicated ~2.5 KB per page × ~200k
 * pages → ~500 MB across dist. After this plugin runs, each page only references
 * the small <script src="/assets/..."> tag and the browser caches the JS file
 * once globally.
 *
 * Cache-busting is via the short content hash embedded in the filename (see
 * constants.ts). The legacy `?v=${BUILD_ID}` query string was dropped because
 * the hashed filename already guarantees the URL changes whenever the script
 * body changes — saves ~75 B/page across ~822k SEO pages (~62 MB dist for the
 * scripts + ~17 MB for the stylesheets).
 *
 * The dark-mode + spa-action-redirect merge collapses two synchronous <script>
 * tags into one, saving another ~80 B/page (~65 MB dist) — dark-mode still
 * runs first because it is concatenated first into the bundle (the constants
 * `EARLY_BOOT_CONTENT` enforces that order at build time).
 */

import path from 'path';
import type { Plugin } from 'vite';
import {
  GTAG_INIT_CONTENT,
  GTAG_INIT_FILENAME,
  ADSENSE_LOADER_CONTENT,
  ADSENSE_LOADER_FILENAME,
  EARLY_BOOT_CONTENT,
  EARLY_BOOT_FILENAME,
  POSTHOG_INIT_CONTENT,
  POSTHOG_INIT_FILENAME,
  SEO_STATIC_CSS_FILENAME,
  BRIDGE_CSS_FILENAME,
} from './constants';

export function staticScriptsPlugin(rootDir: string): Plugin {
  return {
    name: 'static-scripts',
    apply: 'build',
    async closeBundle() {
      const fs = await import('fs');
      const outDir = path.resolve(rootDir, 'dist', 'assets');
      fs.mkdirSync(outDir, { recursive: true });

      const files: Array<readonly [string, string]> = [
        [GTAG_INIT_FILENAME, GTAG_INIT_CONTENT],
        [ADSENSE_LOADER_FILENAME, ADSENSE_LOADER_CONTENT],
        [EARLY_BOOT_FILENAME, EARLY_BOOT_CONTENT],
        [POSTHOG_INIT_FILENAME, POSTHOG_INIT_CONTENT],
      ];

      let totalBytes = 0;
      for (const [name, content] of files) {
        fs.writeFileSync(path.join(outDir, name), content, 'utf-8');
        totalBytes += content.length;
      }

      // Rehash the two externalised stylesheets that Vite already copied
      // verbatim from public/assets/{name}.css. Both are referenced from
      // ~822k (seo-static) and ~30k (bridge) SEO pages via the
      // SEO_STATIC_CSS_LINK / BRIDGE_CSS_LINK constants in constants.ts.
      // Renaming to the hashed filename (computed at module-load time
      // from the source content) lets the per-page tag drop its
      // `?v=${BUILD_ID}` query string — the filename change itself is
      // the cache invalidation signal. Saves ~12 MB (seo-static) +
      // ~5 MB (bridge) across dist. The source path is removed after
      // rename so dist contains exactly one copy of each file.
      const cssRehashes: Array<readonly [string, string]> = [
        ['seo-static.css', SEO_STATIC_CSS_FILENAME],
        ['bridge.css', BRIDGE_CSS_FILENAME],
      ];
      for (const [src, dst] of cssRehashes) {
        const srcPath = path.join(outDir, src);
        const dstPath = path.join(outDir, dst);
        if (!fs.existsSync(srcPath)) continue;
        // Use rename (atomic on the same FS). If the destination already
        // exists from a prior closeBundle pass in the same run, overwrite
        // it — content hash is deterministic, so this is a no-op.
        try { fs.unlinkSync(dstPath); } catch { /* dst missing, fine */ }
        fs.renameSync(srcPath, dstPath);
      }

      // eslint-disable-next-line no-console
      console.log(
        `\x1b[36m[static-scripts]\x1b[0m Emitted ${files.length} hashed script(s) ` +
          `+ rehashed ${cssRehashes.length} CSS file(s) ` +
          `→ dist/assets/ (${totalBytes} bytes scripts)`,
      );
    },
    /**
     * Dev-mode middleware: serve `/assets/seo-static-{hash}.css` and
     * `/assets/bridge-{hash}.css` by streaming the unhashed source file
     * from public/assets/. Vite's built-in publicDir middleware serves
     * the unhashed paths automatically, but the SEO templates emit
     * references to the hashed paths even in dev — without this shim the
     * dev server would 404 on those URLs. Production reads the file from
     * the renamed copy in dist/assets/ and never hits this middleware.
     */
    configureServer(server) {
      const publicDir = path.resolve(rootDir, 'public', 'assets');
      const map: Record<string, string> = {
        [`/assets/${SEO_STATIC_CSS_FILENAME}`]: path.join(publicDir, 'seo-static.css'),
        [`/assets/${BRIDGE_CSS_FILENAME}`]: path.join(publicDir, 'bridge.css'),
      };
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const filePath = map[url];
        if (!filePath) return next();
        import('fs').then(({ readFile }) => {
          readFile(filePath, (err, data) => {
            if (err) return next(err);
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.end(data);
          });
        });
      });
    },
  };
}
