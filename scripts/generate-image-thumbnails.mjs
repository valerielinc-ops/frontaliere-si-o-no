#!/usr/bin/env node
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE_DIRS = [
  path.join(ROOT, 'public', 'images', 'blog'),
  path.join(ROOT, 'public', 'images', 'places'),
];
const WIDTH = 480;
const JPG_QUALITY = 72;
const WEBP_QUALITY = 68;
const AVIF_QUALITY = 50;
const VALID_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'thumbnails') continue;
      const nested = await walk(full);
      out.push(...nested);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!VALID_EXT.has(ext)) continue;
    out.push(full);
  }
  return out;
}

async function generateForImage(inputPath) {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const stem = path.basename(inputPath, ext);
  const thumbDir = path.join(dir, 'thumbnails');
  const outJpg = path.join(thumbDir, `${stem}-${WIDTH}w.jpg`);
  const outWebp = path.join(thumbDir, `${stem}-${WIDTH}w.webp`);
  const outAvif = path.join(thumbDir, `${stem}-${WIDTH}w.avif`);

  await mkdir(thumbDir, { recursive: true });

  const srcStat = await stat(inputPath);
  const targets = [outJpg, outWebp, outAvif];
  let needsWork = false;
  for (const target of targets) {
    try {
      const dstStat = await stat(target);
      if (dstStat.mtimeMs < srcStat.mtimeMs) {
        needsWork = true;
        break;
      }
    } catch {
      needsWork = true;
      break;
    }
  }

  if (!needsWork) return { generated: 0, skipped: 1 };

  const base = sharp(inputPath).rotate().resize({ width: WIDTH, withoutEnlargement: true });

  await Promise.all([
    base.clone().jpeg({ quality: JPG_QUALITY, mozjpeg: true }).toFile(outJpg),
    base.clone().webp({ quality: WEBP_QUALITY }).toFile(outWebp),
    base.clone().avif({ quality: AVIF_QUALITY }).toFile(outAvif),
  ]);

  return { generated: 1, skipped: 0 };
}

async function main() {
  let generated = 0;
  let skipped = 0;
  let files = [];

  for (const dir of SOURCE_DIRS) {
    const found = await walk(dir);
    files.push(...found);
  }

  for (const file of files) {
    const result = await generateForImage(file);
    generated += result.generated;
    skipped += result.skipped;
  }

  console.error(`🖼️  Thumbnail generation complete`);
  console.error(`   Source images scanned: ${files.length}`);
  console.error(`   Generated/updated: ${generated}`);
  console.error(`   Up-to-date skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(`❌ Failed to generate thumbnails: ${err?.message || err}`);
  process.exit(1);
});

