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
 * Each SEO-static HTML page (per-job, soft-landing, bridge, hub, etc.) used to
 * inline all four constants directly. That duplicated ~2.5 KB per page × ~200k
 * pages → ~500 MB across dist. After this plugin runs, each page only references
 * the small <script src="/assets/..."> tag and the browser caches the JS file
 * once globally.
 *
 * Cache-busting is via the short content hash embedded in the filename (see
 * constants.ts). The legacy `?v=${BUILD_ID}` query string was dropped because
 * the hashed filename already guarantees the URL changes whenever the script
 * body changes — saves ~75 B/page across ~822k SEO pages (~62 MB dist).
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

      // eslint-disable-next-line no-console
      console.log(
        `\x1b[36m[static-scripts]\x1b[0m Emitted ${files.length} hashed script(s) ` +
          `→ dist/assets/ (${totalBytes} bytes total)`,
      );
    },
  };
}
