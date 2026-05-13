/**
 * Worker thread for jobOgImagesPlugin: renders one satori card → SVG →
 * PNG → WebP and posts the resulting buffer back to the main thread.
 *
 * Why workers: satori (CPU-bound layout via opentype.js) plus resvg
 * (WASM SVG raster) takes ~1.5-2s per card. With ~2100 jobs that's
 * ~50 min single-threaded. Pooling 4 workers cuts cold-start build
 * time to ~12-15 min.
 *
 * Why WebP: at quality 80 each card is ~30 KB vs ~160 KB for PNG (−80%).
 * FB/X/LinkedIn have supported WebP og:image since 2021. Saves ~390 MB
 * across 3000+ cards in dist/.
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

const WEBP_QUALITY = 80;
const WEBP_EFFORT = 4;

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
