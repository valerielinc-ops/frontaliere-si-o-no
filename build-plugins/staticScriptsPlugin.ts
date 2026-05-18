/**
 * Emits the previously-inline analytics / SPA bootstrap scripts as standalone
 * .js files under dist/assets/ at the end of the build. Used by:
 *
 *   GTAG_SNIPPET                  → /assets/gtag-init.js
 *   ADSENSE_SNIPPET               → /assets/adsense-loader.js
 *   SPA_ACTION_REDIRECT_SCRIPT    → /assets/spa-action-redirect.js
 *
 * Each SEO-static HTML page (per-job, soft-landing, bridge, hub, etc.) used to
 * inline all three constants directly. That duplicated ~2.5 KB per page × ~200k
 * pages → ~500 MB across dist. After this plugin runs, each page only references
 * the small <script src="/assets/..."> tag and the browser caches the JS file
 * once globally.
 *
 * Cache-busting via ?v=${BUILD_ID} query string appended in constants.ts.
 */

import path from 'path';
import type { Plugin } from 'vite';
import {
  GTAG_INIT_CONTENT,
  ADSENSE_LOADER_CONTENT,
  SPA_ACTION_REDIRECT_SCRIPT_CONTENT,
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
        ['gtag-init.js', GTAG_INIT_CONTENT],
        ['adsense-loader.js', ADSENSE_LOADER_CONTENT],
        ['spa-action-redirect.js', SPA_ACTION_REDIRECT_SCRIPT_CONTENT],
      ];

      let totalBytes = 0;
      for (const [name, content] of files) {
        fs.writeFileSync(path.join(outDir, name), content, 'utf-8');
        totalBytes += content.length;
      }

      // eslint-disable-next-line no-console
      console.log(
        `\x1b[36m[static-scripts]\x1b[0m Emitted ${files.length} script(s) ` +
          `→ dist/assets/ (${totalBytes} bytes total)`,
      );
    },
  };
}
