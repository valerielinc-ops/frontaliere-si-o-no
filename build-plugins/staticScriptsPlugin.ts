/**
 * Emits the previously-inline analytics / SPA bootstrap scripts (and, since
 * the critical-CSS externalization, one stylesheet) as standalone files under
 * dist/assets/ at the end of the build. Used by:
 *
 *   GTAG_SNIPPET                  → /assets/gtag-init.js
 *   ADSENSE_SNIPPET               → /assets/adsense-loader.js
 *   EARLY_BOOT_SCRIPT             → /assets/early-boot.js
 *                                   (concat of dark-mode-init + spa-action-redirect)
 *   POSTHOG_SNIPPET               → /assets/posthog-init.js
 *   FUEL_CHART_SCRIPT             → /assets/fuel-chart.js
 *   CRITICAL_CSS                  → /assets/critical.css (CRITICAL_CSS_LINK)
 *
 * critical.css used to be a per-page inline `<style>` block (~4.3 KB ×
 * 55k+ static SEO pages); it is written here from the same
 * `shared/criticalCss.ts` constant so there is exactly one source, and
 * referenced via a render-BLOCKING `<link>` (CRITICAL_CSS_LINK) — not the
 * media=print async-swap the other externalised stylesheets below use —
 * because it must still be in effect before first paint.
 *
 * The two async-swapped stylesheets (SEO_STATIC_CSS_LINK → /assets/seo-static.css,
 * BRIDGE_CSS_LINK → /assets/bridge.css) need no step here: Vite copies them
 * verbatim from public/assets/ to dist/assets/ under the same STABLE name the
 * page tags reference (constants.ts). They used to be renamed to a hashed copy
 * by this plugin; stable names (vite.config.ts rationale) made that rename —
 * and the dev-server middleware that shimmed the hashed URLs — redundant.
 *
 * Each SEO-static HTML page (per-job, soft-landing, bridge, hub, etc.) used to
 * inline all four constants directly. That duplicated ~2.5 KB per page × ~200k
 * pages → ~500 MB across dist. After this plugin runs, each page only references
 * the small <script src="/assets/..."> tag and the browser caches the JS file
 * once globally.
 *
 * Filenames are STABLE (no content hash) like every other bundler asset — see
 * vite.config.ts `chunkFileNames`/`assetFileNames` for the rationale. A content
 * change propagates via the serving stack's max-age=600 revalidation, not via
 * a rename (the legacy `?v=${BUILD_ID}` query string stays dropped — saves
 * ~75 B/page across ~822k SEO pages).
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
  FUEL_CHART_SCRIPT_CONTENT,
  FUEL_CHART_SCRIPT_FILENAME,
} from './constants';
import { CRITICAL_CSS, CRITICAL_CSS_FILENAME } from './shared/criticalCss';

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
        [FUEL_CHART_SCRIPT_FILENAME, FUEL_CHART_SCRIPT_CONTENT],
        [CRITICAL_CSS_FILENAME, CRITICAL_CSS],
      ];

      let totalBytes = 0;
      for (const [name, content] of files) {
        fs.writeFileSync(path.join(outDir, name), content, 'utf-8');
        totalBytes += content.length;
      }

      // eslint-disable-next-line no-console
      console.log(
        `\x1b[36m[static-scripts]\x1b[0m Emitted ${files.length} script(s) ` +
          `→ dist/assets/ (${totalBytes} bytes)`,
      );
    },
  };
}
