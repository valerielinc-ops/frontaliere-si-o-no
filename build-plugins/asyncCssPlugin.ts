/**
 * Root entry tuning for the home page.
 * Keep JS fetchpriority high, but do not async-load the main stylesheet:
 * the home route is LCP-sensitive and benefits more from stable first paint
 * than from the "media=print" trick.
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

 // Add data-clarity-unmask to Vite-injected stylesheet links so Clarity
 // masking does not strip the href, which breaks session replay CSS.
 html = html.replace(
 /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/g,
 '<link rel="stylesheet" crossorigin href="$1" data-clarity-unmask="true">'
 );

 return html;
 },
 };
}
