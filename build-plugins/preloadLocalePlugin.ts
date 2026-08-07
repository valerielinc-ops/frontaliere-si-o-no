/**
 * Preload the Italian locale chunk in index.html to reduce LCP.
 * The i18n module loads Italian via dynamic import(), which means the browser
 * doesn't discover it until entry JS parses. This plugin adds a modulepreload
 * hint so the browser fetches it in parallel with the entry bundle.
 *
 * Static pages already get their own route-specific preloads at build time.
 * Keep index.html lean and avoid injecting a large runtime preload map script
 * that the homepage does not need.
 */

// Import statici, NON `await import()` dentro closeBundle (#5001): closeBundle e'
// un hook Rollup async/parallelo, quindi quell'await sospende il plugin e un
// altro plugin `enforce:'post'` puo' girare per intero prima che questo
// riprenda. E' gia' costato due bug silenziosi (pdfWhitepapersPlugin,
// staticPagesPlugin): le hero card venivano drenate prima di essere registrate.
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { stableChunkFiles } from './shared/chunkFiles';

export function preloadLocalePlugin(rootDir: string): Plugin {
 return {
 name: 'preload-locale',
 apply: 'build',
 enforce: 'post',
 async closeBundle() {
 const distDir = np.resolve(rootDir, 'dist');
 const indexPath = np.join(distDir, 'index.html');
 try {
 // Critical Italian chunks + the App chunk — App is dynamically imported
 // from the entry point, so the browser doesn't discover it until entry
 // JS executes. Stable-name resolution, no disk I/O (shared/chunkFiles.ts
 // — closeBundle-time fs.readdirSync(dist/assets) can race Rollup's write
 // phase, #4762).
 const criticalChunks = stableChunkFiles(['it-core', 'it-calculator', 'App']);
 let html = fs.readFileSync(indexPath, 'utf-8');
 let added = 0;
 for (const chunk of criticalChunks) {
 const tag = `<link rel="modulepreload" href="/assets/${chunk}">`;
 if (!html.includes(tag)) {
 html = html.replace('</head>', ` ${tag}\n </head>`);
 added++;
 }
 }
 if (added) {
 fs.writeFileSync(indexPath, html);
 console.log(`\x1b[36m[preload-locale]\x1b[0m Added modulepreload for ${criticalChunks.join(', ')}`);
 }

 } catch { /* non-fatal */ }
 },
 };
}
