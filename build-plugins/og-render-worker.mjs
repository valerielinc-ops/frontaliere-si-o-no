/**
 * Worker thread for jobOgImagesPlugin: renders one satori card → SVG →
 * PNG → WebP and posts the resulting buffer back to the main thread.
 *
 * Why workers: satori (CPU-bound layout via opentype.js) plus resvg
 * (WASM SVG raster) takes ~1.5-2s per card. With ~2100 jobs that's
 * ~50 min single-threaded. Pooling 4 workers cuts cold-start build
 * time to ~12-15 min.
 *
 * Why WebP: at quality 65 + effort 6 each card is ~20 KB vs ~160 KB for
 * PNG (−87%). FB/X/LinkedIn have supported WebP og:image since 2021 and
 * accept the lower quality with no visible degradation on social cards
 * (1200×630 is downscaled to ~600×315 in feed previews). The q80 → q65
 * step trims ~10 KB per card → ~60 MB across the active job set.
 *
 * Lifecycle: main thread spawns N workers (one per CPU, capped at 4),
 * each receives the font buffers + brand background once via
 * `workerData`, then loops on `parentPort.on('message')` rendering
 * each `{ tree, jobId }` payload. Worker exits when main calls
 * `worker.terminate()` after all jobs are done.
 */

import { parentPort, workerData } from 'node:worker_threads';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const { fontRegular, fontBold, brandBgFrom, width, height } = workerData;

const fonts = [
  { name: 'Roboto', data: fontRegular, weight: 400, style: 'normal' },
  { name: 'Roboto', data: fontBold, weight: 700, style: 'normal' },
];

const WEBP_QUALITY = 65;
const WEBP_EFFORT = 6;

if (!parentPort) {
  throw new Error('og-render-worker: no parentPort (not running as worker)');
}

parentPort.on('message', async (msg) => {
  if (msg === 'shutdown') {
    process.exit(0);
  }
  const { jobId, tree } = msg;
  try {
    const svg = await satori(tree, { width, height, fonts });
    const png = new Resvg(svg, {
      background: brandBgFrom,
      fitTo: { mode: 'width', value: width },
    })
      .render()
      .asPng();
    const webp = await sharp(png)
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer();
    parentPort.postMessage({ jobId, ok: true, webp });
  } catch (err) {
    parentPort.postMessage({
      jobId,
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
});
