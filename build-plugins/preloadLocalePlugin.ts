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

import type { Plugin } from 'vite';
import { findChunkFiles } from './shared/chunkFiles';

export function preloadLocalePlugin(rootDir: string): Plugin {
 return {
 name: 'preload-locale',
 apply: 'build',
 enforce: 'post',
 async closeBundle() {
 const fs = await import('node:fs');
 const np = await import('node:path');
 const distDir = np.resolve(rootDir, 'dist');
 const indexPath = np.join(distDir, 'index.html');
 try {
 const assetFiles = fs.readdirSync(np.join(distDir, 'assets'));
 // Critical Italian chunks + the App chunk — App is dynamically imported
 // from the entry point, so the browser doesn't discover it until entry
 // JS executes. Stable-name resolution via shared/chunkFiles.ts.
 const criticalChunks = findChunkFiles(assetFiles, ['it-core', 'it-calculator', 'App']);
 if (!criticalChunks.length) return;
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
