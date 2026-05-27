/**
 * WebP Conversion Build Plugin
 *
 * Opt-in only: runs solely when `BUILD_WEBP=1` is set in the environment.
 * The default deploy pipeline relies on .webp sidecars committed alongside
 * each source image — generated at article-creation time by
 * `scripts/create-article.mjs` (sharp, quality 72) and backfilled in bulk by
 * `scripts/backfill-blog-webp.mjs`. Skipping this plugin on the hot path
 * removes ~41s per CI build (5% of the build phase) without changing
 * dist/ output.
 *
 * Re-enable for one-off rebuilds when:
 *   - sharp's webp encoder version changes and we want to re-encode at parity
 *   - the global QUALITY/EFFORT constants change
 *   - a backfill audit reveals missing .webp sidecars
 *
 * Behavior when enabled:
 *   - Walks dist/ for PNG/JPG/JPEG, skipping `icons/` (PWA manifests require PNG).
 *   - Quality 72 + effort 6 (~25 % bytes saved vs old quality 82 default).
 *   - Skip-if-fresh: each .webp is only re-encoded when missing or older
 *     than its raster source.
 */

import type { Plugin } from 'vite';

const ENABLED = process.env.BUILD_WEBP === '1';

export function webpPlugin(rootDir: string): Plugin {
 return {
 name: 'webp-conversion',
 apply: 'build',
 enforce: 'post',

 async closeBundle() {
 if (!ENABLED) {
 // Opt-in via BUILD_WEBP=1. Default builds rely on .webp sidecars
 // committed at article-creation time (create-article.mjs) and the
 // backfill script (scripts/backfill-blog-webp.mjs).
 return;
 }
 const fs = await import('node:fs');
 const path = await import('node:path');

 // Dynamic import — sharp is a native module, must be loaded at runtime
 let sharp: typeof import('sharp');
 try {
 sharp = (await import('sharp')).default as unknown as typeof import('sharp');
 } catch {
 console.warn('[webp-plugin] sharp not available — skipping WebP conversion');
 return;
 }

 const distDir = path.resolve(rootDir, 'dist');
 if (!fs.existsSync(distDir)) {
 console.warn('[webp-plugin] dist/ not found — skipping');
 return;
 }

 // Lowered 82 → 72 + effort=6 to match prebuild-webp.mjs (artifact size win).
 const WEBP_QUALITY = 72;
 const WEBP_EFFORT = 6;
 const SKIP_DIRS = new Set(['icons']); // Icons must stay PNG

 /** Recursively find PNG/JPG files, skipping excluded directories. */
 function findImages(dir: string): string[] {
 const results: string[] = [];
 let entries: import('node:fs').Dirent[];
 try {
 entries = fs.readdirSync(dir, { withFileTypes: true });
 } catch {
 return results;
 }
 for (const entry of entries) {
 if (entry.isDirectory()) {
 if (SKIP_DIRS.has(entry.name)) continue;
 results.push(...findImages(path.join(dir, entry.name)));
 } else if (/\.(png|jpe?g)$/i.test(entry.name)) {
 results.push(path.join(dir, entry.name));
 }
 }
 return results;
 }

 /**
  * Skip-if-fresh: existing .webp counts as fresh when its mtime is
  * greater than or equal to the source file's mtime. Returns `true` if
  * the conversion should be skipped (file is up to date), `false` if
  * it must run.
  */
 function isWebpFresh(srcPath: string, webpPath: string): boolean {
 try {
 const srcStat = fs.statSync(srcPath);
 const webpStat = fs.statSync(webpPath);
 return webpStat.mtimeMs >= srcStat.mtimeMs;
 } catch {
 return false;
 }
 }

 const images = findImages(distDir);
 if (images.length === 0) {
 console.log('[webp-plugin] No PNG/JPG images found in dist/');
 return;
 }

 const startTotal = Date.now();
 let converted = 0;
 let skipped = 0;
 let errors = 0;

 const BATCH_SIZE = 50;
 for (let i = 0; i < images.length; i += BATCH_SIZE) {
 const batch = images.slice(i, i + BATCH_SIZE);
 const results = await Promise.allSettled(
 batch.map(async (imgPath) => {
 const webpPath = imgPath.replace(/\.(png|jpe?g)$/i, '.webp');
 if (fs.existsSync(webpPath) && isWebpFresh(imgPath, webpPath)) {
 skipped++;
 return;
 }
 await (sharp as any)(imgPath).webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT }).toFile(webpPath);
 converted++;
 }),
 );
 for (let j = 0; j < results.length; j++) {
 const r = results[j];
 if (r.status === 'rejected') {
 const failedPath = batch[j].replace(distDir + '/', '');
 console.warn(`[webp-plugin] ❌ Failed: ${failedPath} — ${r.reason?.message || r.reason}`);
 errors++;
 }
 }
 }

 const dur = ((Date.now() - startTotal) / 1000).toFixed(2);
 console.log(
 `[webp-conversion] converted ${converted} | skipped ${skipped} | errors ${errors} | total time ${dur}s (from ${images.length} images)`,
 );
 },
 };
}
