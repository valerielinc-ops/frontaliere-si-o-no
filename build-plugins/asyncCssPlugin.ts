/**
 * Root entry tuning for the home page.
 *
 * The loading shell uses inline `style=""` attributes for layout and only
 * `sh-*` classes which are already in the inline `<style>` block in
 * index.html. The Vite-emitted main stylesheet is therefore safe to
 * async-load — first paint is stable from the inline critical CSS alone,
 * and the React render that needs the full stylesheet only kicks in after
 * hydration anyway. `index.tsx#waitForAsyncStylesheet` already waits for
 * the `media="print"` async link to flip to `media="all"` on non-home
 * paths before doing the loading-shell fade-out, so there is no FOUC.
 *
 * Also adds data-clarity-unmask="true" to stylesheet links so that
 * Microsoft Clarity's masking algorithm does not strip the href attribute,
 * which would cause session recordings to render without any CSS.
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

 // Async-load the Vite-emitted main stylesheet using the `media="print"`
 // swap trick. The loading shell in index.html is fully self-contained
 // (inline styles + inline `sh-*` rules + inline CSS custom properties),
 // so first paint is rendered from inline critical CSS alone — no FOUC.
 // The <noscript> fallback keeps non-JS clients (and crawlers) on the
 // synchronous path.
 //
 // We also add data-clarity-unmask="true" so Microsoft Clarity does not
 // strip href attributes from session recordings. The same async pattern
 // is already used in jobsSeoPagesPlugin.ts for SPA-shell SEO pages.
 html = html.replace(
 /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/g,
 '<link rel="preload" as="style" crossorigin href="$1" data-clarity-unmask="true">' +
 '<link rel="stylesheet" crossorigin href="$1" media="print" onload="this.media=\'all\'" data-clarity-unmask="true">' +
 '<noscript><link rel="stylesheet" crossorigin href="$1" data-clarity-unmask="true"></noscript>'
 );

 return html;
 },
 };
}
