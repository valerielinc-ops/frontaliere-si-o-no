#!/usr/bin/env node
/**
 * One-shot backfill: generates the missing .webp sidecars for every raster
 * blog/places/publisher image under public/images/, so the build can skip the
 * (now opt-in) webpPlugin closeBundle pass and still ship the same dist/.
 *
 * Walks:
 *   - public/images/blog/
 *   - public/images/places/
 *   - public/images/publisher/
 *
 * Skips:
 *   - public/images/brands/  (never consumed as .webp by the SPA — confirmed
 *     via grep across services/ and components/)
 *   - public/images/icons/   (PWA manifests require PNG)
 *
 * Quality 82 (sharp's default for visually-lossless photographs) — exact same
 * setting webpPlugin used, so the dist/ output remains byte-equivalent to the
 * pre-change state.
 *
 * Usage:
 *   node scripts/backfill-blog-webp.mjs
 *   node scripts/backfill-blog-webp.mjs --force   # re-encode even if .webp exists
 *
 * Idempotent. Re-running with no flags is a near no-op (just stat checks).
 */
import { resolve, join, relative, dirname, basename } from 'node:path';
import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), '..');

const TARGETS = [
  'public/images/blog',
  'public/images/places',
  'public/images/publisher',
];

// Lowered 82 → 72 + effort=6 to match prebuild-webp.mjs (artifact size win,
// ~25 % bytes per blog hero image).
const QUALITY = 72;
const EFFORT = 6;
const RASTER_RE = /\.(png|jpe?g)$/i;
// When --recompress-webp is set, also walks .webp files and re-encodes them
// at the current QUALITY+EFFORT. Use this after the global quality knob is
// lowered to claw back size on the existing committed sidecars (JPG sources
// were dropped in PR #158, so there's no raster to re-derive from).
const WEBP_RE = /\.webp$/i;

const force = process.argv.includes('--force');
const recompressWebp = process.argv.includes('--recompress-webp');

function findRasterImages(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden and thumbnail subdirs (thumbnails are SPA-runtime
        // generated and not part of the published asset graph).
        if (entry.name.startsWith('.') || entry.name === 'thumbnails') continue;
        walk(full);
      } else if (RASTER_RE.test(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out;
}

function findWebpImages(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'thumbnails') continue;
        walk(full);
      } else if (WEBP_RE.test(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out;
}

function isWebpFresh(srcPath, webpPath) {
  try {
    const s = statSync(srcPath);
    const w = statSync(webpPath);
    return w.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

async function main() {
  let sharp;
  try {
    const mod = await import('sharp');
    sharp = mod.default || mod;
  } catch (err) {
    console.error('sharp module not available — run `npm install` first.');
    console.error(err?.message || err);
    process.exit(1);
  }

  const startTotal = Date.now();
  let totalScanned = 0;
  let generated = 0;
  let freshSkipped = 0;
  let errors = 0;
  let recompressedBytes = 0;
  let recompressedSavings = 0;

  for (const rel of TARGETS) {
    const dir = resolve(PROJECT_ROOT, rel);
    if (!existsSync(dir)) {
      console.log(`[backfill-webp] skip missing dir: ${rel}`);
      continue;
    }
    const images = findRasterImages(dir);
    totalScanned += images.length;
    console.log(`[backfill-webp] scanning ${rel}: ${images.length} raster files`);

    const BATCH_SIZE = 32;
    for (let i = 0; i < images.length; i += BATCH_SIZE) {
      const batch = images.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (imgPath) => {
          const webpPath = imgPath.replace(RASTER_RE, '.webp');
          if (!force && existsSync(webpPath) && isWebpFresh(imgPath, webpPath)) {
            return { skipped: true };
          }
          const buf = await sharp(imgPath).webp({ quality: QUALITY, effort: EFFORT }).toBuffer();
          writeFileSync(webpPath, buf);
          return { skipped: false };
        }),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === 'rejected') {
          errors++;
          console.warn(
            `  ❌ ${relative(PROJECT_ROOT, batch[j])} — ${r.reason?.message || r.reason}`,
          );
        } else if (r.value.skipped) {
          freshSkipped++;
        } else {
          generated++;
          if (generated <= 5 || generated % 50 === 0) {
            console.log(`  ✓ ${relative(PROJECT_ROOT, batch[j].replace(RASTER_RE, '.webp'))}`);
          }
        }
      }
    }

    // --recompress-webp: walk existing .webp files and re-encode at the
    // current QUALITY+EFFORT. Used after a global quality knob change to
    // shrink committed sidecars without needing raster sources. Only
    // re-writes if the new payload is strictly smaller (skips no-op or
    // counter-productive re-encodings).
    if (recompressWebp) {
      const webps = findWebpImages(dir);
      console.log(`[backfill-webp] re-compressing ${rel}: ${webps.length} webp files`);
      for (let i = 0; i < webps.length; i += BATCH_SIZE) {
        const batch = webps.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (webpPath) => {
            const orig = statSync(webpPath).size;
            const buf = await sharp(webpPath).webp({ quality: QUALITY, effort: EFFORT }).toBuffer();
            if (buf.length >= orig) return { skipped: true, orig, after: buf.length };
            writeFileSync(webpPath, buf);
            return { skipped: false, orig, after: buf.length };
          }),
        );
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.status === 'rejected') {
            errors++;
            console.warn(`  ❌ ${relative(PROJECT_ROOT, batch[j])} — ${r.reason?.message || r.reason}`);
          } else if (r.value.skipped) {
            freshSkipped++;
          } else {
            generated++;
            recompressedBytes += r.value.orig;
            recompressedSavings += r.value.orig - r.value.after;
            if (generated <= 5 || generated % 100 === 0) {
              console.log(`  ✓ ${relative(PROJECT_ROOT, batch[j])} ${r.value.orig} → ${r.value.after}`);
            }
          }
        }
      }
    }
  }

  const dur = ((Date.now() - startTotal) / 1000).toFixed(2);
  console.log(
    `\n[backfill-webp] done in ${dur}s | scanned ${totalScanned} | generated ${generated} | already fresh ${freshSkipped} | errors ${errors}`,
  );
  if (recompressedBytes > 0) {
    const savedMB = (recompressedSavings / 1024 / 1024).toFixed(1);
    const pct = ((recompressedSavings / recompressedBytes) * 100).toFixed(1);
    console.log(`[backfill-webp] recompress saved ${savedMB} MB (${pct} %) on existing webp sidecars`);
  }
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[backfill-webp] fatal:', err);
  process.exit(1);
});
