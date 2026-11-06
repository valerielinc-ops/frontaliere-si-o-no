#!/usr/bin/env node
/**
 * Pre-build WebP conversion with mtime-based caching.
 *
 * Converts PNG/JPG images in public/ to WebP format. Vite copies them
 * to dist/ during the bundle phase, so no closeBundle conversion needed.
 *
 * Mtime caching: if .webp already exists and is newer than the source,
 * the image is skipped. Matches the pattern in generate-image-thumbnails.mjs.
 *
 * Orphan cleanup: removes .webp files whose source image no longer exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// Lowered 82 → 72 + effort=6 (was effort=4 default) saves ~25 % bytes per
// hero image (~28 KB/img × ~2400 images = ~65 MB off public/images/blog/).
// effort=6 doubles encoding time per image but mtime cache means only
// freshly-added images re-encode each build.
const WEBP_QUALITY = 72;
const WEBP_EFFORT = 6;
const SKIP_DIRS = new Set(['icons']); // iOS/Android manifests require PNG

/** Recursively find PNG/JPG files, skipping excluded directories. */
function findImages(dir) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
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

/** Find orphan .webp files (no matching source image). */
function findOrphanWebps(dir) {
  const orphans = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return orphans; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      orphans.push(...findOrphanWebps(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.webp')) {
      const webpPath = path.join(dir, entry.name);
      const baseName = entry.name.replace(/\.webp$/, '');
      const hasPng = fs.existsSync(path.join(dir, baseName + '.png'));
      const hasJpg = fs.existsSync(path.join(dir, baseName + '.jpg'));
      const hasJpeg = fs.existsSync(path.join(dir, baseName + '.jpeg'));
      if (!hasPng && !hasJpg && !hasJpeg) {
        orphans.push(webpPath);
      }
    }
  }
  return orphans;
}

async function main() {
  // Dynamic import — sharp is a native module
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('[prebuild-webp] sharp not available — skipping WebP conversion');
    return;
  }

  // Cleanup orphan .webp files
  const orphans = findOrphanWebps(PUBLIC_DIR);
  if (orphans.length > 0) {
    for (const orphan of orphans) fs.unlinkSync(orphan);
    console.log(`[prebuild-webp] Removed ${orphans.length} orphan .webp files`);
  }

  const images = findImages(PUBLIC_DIR);
  if (images.length === 0) {
    console.log('[prebuild-webp] No images found in public/');
    return;
  }

  let converted = 0;
  let skipped = 0;
  let errors = 0;

  const BATCH_SIZE = 50;
  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (imgPath) => {
        const webpPath = imgPath.replace(/\.(png|jpe?g)$/i, '.webp');
        // Mtime-based caching: skip if .webp exists and is newer than source
        if (fs.existsSync(webpPath)) {
          try {
            const srcStat = fs.statSync(imgPath);
            const dstStat = fs.statSync(webpPath);
            if (dstStat.mtimeMs >= srcStat.mtimeMs) {
              skipped++;
              return;
            }
          } catch { /* stat failed, reconvert */ }
        }
        await sharp(imgPath).webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT }).toFile(webpPath);
        converted++;
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') errors++;
    }
  }

  console.log(
    `[prebuild-webp] Done: ${converted} converted, ${skipped} cached, ${errors} errors (from ${images.length} source images)`,
  );
}

main().catch(e => { console.error('[prebuild-webp]', e); process.exit(1); });
