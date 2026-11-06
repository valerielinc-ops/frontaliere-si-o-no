#!/usr/bin/env node
/**
 * resize-blog-images.mjs — One-shot batch upscale of undersized blog images
 *
 * WHY 1200px MINIMUM?
 * ───────────────────
 * Google enforces strict minimum image dimensions across its surfaces:
 *
 *  • Google News: images must be ≥1200px wide to appear as article thumbnails.
 *    Smaller images are silently dropped, making articles look unpolished next
 *    to competitors with proper images.
 *
 *  • Google Discover: the "max-image-preview:large" robots directive only works
 *    if the image is ≥1200px wide. Below that, Google shows a tiny thumbnail
 *    or no image at all — dramatically reducing click-through rate.
 *
 *  • Open Graph / Social Sharing: Facebook and LinkedIn recommend ≥1200×630 for
 *    "summary_large_image" cards. Undersized images get cropped or replaced with
 *    a generic placeholder.
 *
 *  • Core Web Vitals (CLS): specifying exact og:image:width/height in meta tags
 *    requires knowing the real dimensions. Lying about dimensions (e.g. claiming
 *    1200 when the image is 800) causes layout shifts and validator warnings.
 *
 * This script finds all blog images below 1200px wide and upscales them using
 * sharp's Lanczos3 resampler (the highest quality upscaler available). Images
 * that are already ≥1200px are left untouched.
 *
 * Usage:
 *   node scripts/resize-blog-images.mjs              # dry-run (default)
 *   node scripts/resize-blog-images.mjs --apply       # actually resize
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const DIR = 'public/images/blog';
const MIN_WIDTH = 1200;
const TARGET_WIDTH = 1200;
const JPEG_QUALITY = 82; // Good balance: sharp enough for news, small enough for CDN

const dryRun = !process.argv.includes('--apply');

async function main() {
  if (dryRun) {
    console.log('🔍 DRY RUN — pass --apply to actually resize\n');
  }

  const files = (await readdir(DIR)).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  let resized = 0, skipped = 0, errors = 0;

  for (const file of files) {
    const filePath = join(DIR, file);
    try {
      const meta = await sharp(filePath).metadata();
      if (!meta.width || meta.width >= MIN_WIDTH) {
        skipped++;
        continue;
      }

      const newHeight = Math.round((meta.height / meta.width) * TARGET_WIDTH);

      if (dryRun) {
        console.log(`  📐 ${file}: ${meta.width}×${meta.height} → ${TARGET_WIDTH}×${newHeight}`);
        resized++;
        continue;
      }

      // Upscale with Lanczos3 (highest quality), re-encode as progressive JPEG
      const buffer = await sharp(filePath)
        .resize({
          width: TARGET_WIDTH,
          height: newHeight,
          kernel: 'lanczos3',
          withoutEnlargement: false, // we WANT enlargement here
        })
        .jpeg({
          quality: JPEG_QUALITY,
          progressive: true,
          mozjpeg: true,
          chromaSubsampling: '4:2:0',
        })
        .toBuffer();

      const beforeSize = (await stat(filePath)).size;
      await sharp(buffer).toFile(filePath);
      const afterSize = (await stat(filePath)).size;

      const beforeKB = (beforeSize / 1024).toFixed(0);
      const afterKB = (afterSize / 1024).toFixed(0);
      console.log(`  ✅ ${file}: ${meta.width}×${meta.height} → ${TARGET_WIDTH}×${newHeight} (${beforeKB}KB → ${afterKB}KB)`);
      resized++;
    } catch (e) {
      console.error(`  ❌ ${file}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n📊 ${resized} resized, ${skipped} already OK, ${errors} errors (of ${files.length} total)`);
  if (dryRun && resized > 0) {
    console.log('\n💡 Run with --apply to resize these images.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
