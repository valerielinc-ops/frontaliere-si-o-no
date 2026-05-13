#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE_DIRS = [
  path.join(ROOT, 'public', 'images', 'blog'),
  path.join(ROOT, 'public', 'images', 'places'),
];
const WIDTH = 480;
const WEBP_QUALITY = 68;
const AVIF_QUALITY = 50;
const VALID_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const MANIFEST_NAME = '.thumbcache.json';
// v3: dropped JPG thumbnail emission. The <picture> in BlogArticles.tsx
// already serves AVIF → WebP via <source>, and the <img> fallback now uses
// the hero (WebP) directly. Browsers that don't grok WebP (<1% in 2026)
// see no image; that's acceptable. Bumping the manifest version forces a
// one-time regen so cached JPG thumbnails get cleaned up on next build.
const MANIFEST_VERSION = 3;

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

async function sha1File(filePath) {
  const buf = await readFile(filePath);
  return createHash('sha1').update(buf).digest('hex');
}

async function loadManifest(thumbDir) {
  try {
    const raw = await readFile(path.join(thumbDir, MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === MANIFEST_VERSION && parsed?.entries) {
      return parsed.entries;
    }
  } catch {
    // missing or unreadable — start fresh
  }
  return {};
}

async function saveManifest(thumbDir, entries) {
  const payload = JSON.stringify({ version: MANIFEST_VERSION, entries }, null, 0);
  await writeFile(path.join(thumbDir, MANIFEST_NAME), payload, 'utf8');
}

async function outputsExist(outputs) {
  for (const target of outputs) {
    try {
      await stat(target);
    } catch {
      return false;
    }
  }
  return true;
}

async function processSourceDir(sourceDir) {
  const files = await walk(sourceDir).catch(() => []);
  if (files.length === 0) return { scanned: 0, generated: 0, skipped: 0 };

  const thumbDir = path.join(sourceDir, 'thumbnails');
  await mkdir(thumbDir, { recursive: true });
  const manifest = await loadManifest(thumbDir);
  const nextManifest = {};

  let generated = 0;
  let skipped = 0;

  for (const inputPath of files) {
    const ext = path.extname(inputPath);
    const stem = path.basename(inputPath, ext);
    const relKey = path.relative(sourceDir, inputPath);
    const outWebp = path.join(thumbDir, `${stem}-${WIDTH}w.webp`);
    const outAvif = path.join(thumbDir, `${stem}-${WIDTH}w.avif`);
    const outputs = [outWebp, outAvif];

    const sha = await sha1File(inputPath);
    const cached = manifest[relKey];

    if (cached === sha && (await outputsExist(outputs))) {
      nextManifest[relKey] = sha;
      skipped += 1;
      continue;
    }

    const base = sharp(inputPath).rotate().resize({ width: WIDTH, withoutEnlargement: true });
    await Promise.all([
      base.clone().webp({ quality: WEBP_QUALITY }).toFile(outWebp),
      base.clone().avif({ quality: AVIF_QUALITY }).toFile(outAvif),
    ]);

    nextManifest[relKey] = sha;
    generated += 1;
  }

  await saveManifest(thumbDir, nextManifest);
  return { scanned: files.length, generated, skipped };
}

async function main() {
  let scanned = 0;
  let generated = 0;
  let skipped = 0;

  for (const dir of SOURCE_DIRS) {
    const result = await processSourceDir(dir);
    scanned += result.scanned;
    generated += result.generated;
    skipped += result.skipped;
  }

  console.error(`🖼️  Thumbnail generation complete`);
  console.error(`   Source images scanned: ${scanned}`);
  console.error(`   Generated/updated: ${generated}`);
  console.error(`   Up-to-date skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(`❌ Failed to generate thumbnails: ${err?.message || err}`);
  process.exit(1);
});
