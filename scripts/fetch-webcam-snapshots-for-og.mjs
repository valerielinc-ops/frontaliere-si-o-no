/**
 * fetch-webcam-snapshots-for-og.mjs — F8 Open-Graph image refresh
 *
 * WHY?
 * ────
 * Each border-wait landing page (`/traffico-dogane/{crossing}/oggi/`) embeds a
 * live PolCa / ASTRA webcam GIF. When users share the URL on WhatsApp, Telegram
 * or Facebook, the preview currently shows the generic site OG image
 * (`/og-image.png`). The goal of this script is to capture the FIRST webcam
 * frame at build-time and save it as a 640×360 JPEG to
 * `dist/og/border-wait/{crossing-slug}.jpg`, so the border-wait plugin can use
 * it as a per-page `og:image`. Sharing a page now previews the REAL traffic
 * state at the crossing → viral social shares + higher CTR.
 *
 * Safety / ToS
 * ────────────
 * - Identifies itself with `User-Agent: FrontaliereTicino-OGBot` and a 10s
 *   timeout so the script never blocks a production build beyond that.
 * - Resizes to 640×360 (most social previews max at 600–1200 px wide; 640 is a
 *   safe upper-bound for WhatsApp / Telegram, well under the 8MB Facebook cap).
 * - JPEG quality 80 keeps the output ≤200 KB per file.
 * - Stores provenance in `{slug}.jpg.meta.json` with source URL + fetched
 *   timestamp so we can attribute correctly.
 * - On any error (403, 404, timeout, invalid bytes) we SKIP that crossing and
 *   the page falls back to the site default OG image. Build is never blocked.
 *
 * Usage:
 *   node scripts/fetch-webcam-snapshots-for-og.mjs              # dist/og/border-wait/
 *   node scripts/fetch-webcam-snapshots-for-og.mjs --out-dir=X  # custom dir
 *
 * Exit code: always 0 unless a hard filesystem error (mkdir) fails.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

// ── Config ────────────────────────────────────────────────────
const DEFAULT_OUT_SUBDIR = path.join('og', 'border-wait');
const USER_AGENT = 'FrontaliereTicino-OGBot';
const FETCH_TIMEOUT_MS = 10_000;
const TARGET_WIDTH = 640;
const TARGET_HEIGHT = 360;
const JPEG_QUALITY = 80;
const MAX_BYTES = 200 * 1024; // 200 KB per file

// Mirror of borderWaitPagesPlugin.ts#slugifyName — MUST stay in sync.
function slugifyName(name) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Fetch a URL with a User-Agent header and a timeout. Returns a Buffer or
 * throws. Uses Node 20+ global fetch (no node-fetch dependency).
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<Buffer>}
 */
export async function fetchImageBytes(url, timeoutMs = FETCH_TIMEOUT_MS, fetchFn = globalThis.fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resize a raw image buffer to 640×360 JPEG at quality 80.
 *
 * @param {Buffer} buf
 * @returns {Promise<Buffer>}
 */
export async function resizeToOgJpeg(buf) {
  let quality = JPEG_QUALITY;
  let out = await sharp(buf, { animated: false })
    .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'cover', position: 'centre' })
    .jpeg({ quality, progressive: true })
    .toBuffer();
  // Belt-and-suspenders: if the output still exceeds 200 KB (shouldn't at 640×360
  // Q80, but webcam frames with heavy noise can balloon), step quality down.
  while (out.byteLength > MAX_BYTES && quality > 50) {
    quality -= 10;
    out = await sharp(buf, { animated: false })
      .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'cover', position: 'centre' })
      .jpeg({ quality, progressive: true })
      .toBuffer();
  }
  return out;
}

/**
 * Parse CLI args of the form `--key=value`.
 */
function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

/**
 * Core orchestration: iterates the borderCrossings registry and snapshots the
 * first webcam of each crossing that has one.
 *
 * @param {Object} opts
 * @param {Array}  opts.crossings    registry array (borderCrossings)
 * @param {string} opts.outDir       output directory, absolute
 * @param {typeof globalThis.fetch} [opts.fetchFn]  injected for tests
 * @param {(msg: string) => void}    [opts.log]
 * @returns {Promise<{ snapshotted: number, skipped: number, total: number, results: Array }>}
 */
export async function snapshotWebcamsForOg({ crossings, outDir, fetchFn, log }) {
  const logger = log ?? ((m) => console.log(m));
  const fn = fetchFn ?? globalThis.fetch;
  await fs.mkdir(outDir, { recursive: true });

  const withWebcams = crossings.filter((c) => Array.isArray(c.webcams) && c.webcams.length > 0);
  const results = [];
  let snapshotted = 0;
  let skipped = 0;

  // Deduplicate by slug: the registry can theoretically have duplicates (same
  // underlying Firestore doc id). We only need one snapshot per slug.
  const seen = new Set();
  for (const c of withWebcams) {
    const slug = slugifyName(c.name);
    if (seen.has(slug)) continue;
    seen.add(slug);

    const webcam = c.webcams[0];
    const imageUrl = webcam?.imageUrl;
    if (!imageUrl) {
      skipped++;
      continue;
    }

    try {
      const buf = await fetchImageBytes(imageUrl, FETCH_TIMEOUT_MS, fn);
      const jpeg = await resizeToOgJpeg(buf);
      const outPath = path.join(outDir, `${slug}.jpg`);
      await fs.writeFile(outPath, jpeg);
      const meta = {
        slug,
        sourceUrl: imageUrl,
        sourceName: webcam.sourceName ?? '',
        sourceLabel: webcam.label ?? '',
        fetchedAt: new Date().toISOString(),
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        bytes: jpeg.byteLength,
        userAgent: USER_AGENT,
      };
      await fs.writeFile(`${outPath}.meta.json`, JSON.stringify(meta, null, 2) + '\n');
      snapshotted++;
      results.push({ slug, ok: true, bytes: jpeg.byteLength });
    } catch (err) {
      skipped++;
      results.push({ slug, ok: false, error: err?.message ?? String(err) });
      logger(`\x1b[33m[og-webcam]\x1b[0m ${slug} skipped: ${err?.message ?? err}`);
    }
  }

  logger(
    `\x1b[36m[og-webcam]\x1b[0m snapshotted ${snapshotted} of ${withWebcams.length} crossings (${skipped} skipped).`,
  );

  return { snapshotted, skipped, total: withWebcams.length, results };
}

// ── CLI entry ─────────────────────────────────────────────────

async function loadRegistryForCli() {
  // Import the TS registry via tsx / ts-node at runtime would be heavy; at CLI
  // time we load from the compiled dist or a JSON snapshot. The script is
  // primarily invoked PROGRAMMATICALLY from borderWaitPagesPlugin.ts which
  // imports the TS registry directly. CLI is for local debugging only.
  try {
    // tsx is available in devDependencies — allow direct TS import when running
    // via `npx tsx scripts/fetch-webcam-snapshots-for-og.mjs`.
    const mod = await import('../data/borderCrossings.ts');
    return mod.borderCrossings;
  } catch {
    throw new Error(
      'CLI invocation requires `npx tsx scripts/fetch-webcam-snapshots-for-og.mjs`. ' +
        'For build-time integration, import {snapshotWebcamsForOg} programmatically.',
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const distDir = path.resolve(args['dist-dir'] ?? 'dist');
  const outDir = args['out-dir']
    ? path.resolve(args['out-dir'])
    : path.join(distDir, DEFAULT_OUT_SUBDIR);

  const crossings = await loadRegistryForCli();
  const { snapshotted, skipped, total } = await snapshotWebcamsForOg({
    crossings,
    outDir,
  });

  console.log(
    `\x1b[32m[og-webcam]\x1b[0m done — ${snapshotted}/${total} written to ${outDir} (${skipped} skipped).`,
  );
}

// Only run main() when invoked as a script, not when imported.
const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('\x1b[31m[og-webcam]\x1b[0m fatal:', err);
    process.exit(1);
  });
}

// Export for tests + plugin integration.
export { slugifyName, DEFAULT_OUT_SUBDIR, TARGET_WIDTH, TARGET_HEIGHT };
