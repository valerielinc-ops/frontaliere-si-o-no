/**
 * WebP Conversion Build Plugin
 *
 * During build, converts all PNG/JPG/JPEG images in dist/ to WebP format
 * using sharp. Places WebP versions alongside the originals so both formats
 * are available (originals kept as fallback for older browsers, structured
 * data, and OG meta tags that require PNG/JPG).
 *
 * Icon files (public/icons/) are excluded because iOS/Android manifests
 * require PNG.
 *
 * Quality: 82 (visually lossless for photographs, good compression).
 *
 * Skip-if-fresh (perf optimization 2026-04-28): each source image is only
 * re-converted when:
 *   1. the corresponding `.webp` does not exist, OR
 *   2. the existing `.webp` mtime is older than the source file mtime.
 *
 * Combined with the GitHub Actions cache step (`actions/cache@v5` keyed on
 * the hash of `public/images/**\/*.{jpg,png,jpeg}`), this drops a 500s
 * conversion cost down to a few seconds on cache-hit builds. When source
 * images change, the cache key rotates and conversion runs in full.
 */

import type { Plugin } from 'vite';

export function webpPlugin(rootDir: string): Plugin {
 return {
 name: 'webp-conversion',
 apply: 'build',
 enforce: 'post',

 async closeBundle() {
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

 const WEBP_QUALITY = 82;
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
 await (sharp as any)(imgPath).webp({ quality: WEBP_QUALITY }).toFile(webpPath);
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
