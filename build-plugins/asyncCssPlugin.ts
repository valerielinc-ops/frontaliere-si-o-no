/**
 * Root entry tuning for the home page.
 * Keep JS fetchpriority high, but do not async-load the main stylesheet:
 * the home route is LCP-sensitive and benefits more from stable first paint
 * than from the "media=print" trick.
 */

import type { Plugin } from 'vite';

export function asyncCssPlugin(): Plugin {
  return {
    name: 'async-css',
    enforce: 'post',
    transformIndexHtml(html) {
      // Add fetchpriority="high" to the entry script for faster JS parsing
      html = html.replace(
        /<script type="module" crossorigin src="(\/assets\/index-[^"]+\.js)">/,
        '<script type="module" crossorigin fetchpriority="high" src="$1">'
      );

      return html;
    },
  };
}
