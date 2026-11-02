/**
 * Worker thread for jobOgImagesPlugin: renders one satori card → SVG →
 * PNG → WebP and posts the resulting buffer back to the main thread.
 *
 * Why workers: satori (CPU-bound layout via opentype.js) plus resvg
 * (WASM SVG raster) takes ~1.5-2s per card. With ~2100 jobs that's
 * ~50 min single-threaded. Pooling 4 workers cuts cold-start build
 * time to ~12-15 min.
 *
 * Why WebP: quality 72 + effort 6 keeps photo detail while limiting the
 * storage cost of thousands of 1080×1350 social cards.
 *
 * Lifecycle: main thread spawns N workers (one per CPU, capped at 4),
 * each receives the font buffers + four shared job photos once via
 * `workerData`, then loops on `parentPort.on('message')` rendering
 * each `{ tree, jobId }` payload. Worker exits when main calls
 * `worker.terminate()` after all jobs are done.
 */

import { parentPort, workerData } from 'node:worker_threads';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const { fontRegular, fontBold, brandBgFrom, photoDataUrls, width, height } = workerData;

const fonts = [
  { name: 'Roboto', data: fontRegular, weight: 400, style: 'normal' },
  { name: 'Roboto', data: fontBold, weight: 700, style: 'normal' },
];

const WEBP_QUALITY = 72;
const WEBP_EFFORT = 6;

if (!parentPort) {
  throw new Error('og-render-worker: no parentPort (not running as worker)');
}

function resolveJobPhotoSources(node) {
  if (Array.isArray(node)) {
    for (const child of node) resolveJobPhotoSources(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.type === 'img' && typeof node.props?.src === 'string' && node.props.src.startsWith('job-photo:')) {
    const photoKey = node.props.src.slice('job-photo:'.length);
    const source = photoDataUrls?.[photoKey];
    if (!source) throw new Error(`missing generated job photo: ${photoKey}`);
    node.props.src = source;
  }
  resolveJobPhotoSources(node.props?.children);
}

parentPort.on('message', async (msg) => {
  if (msg === 'shutdown') {
    process.exit(0);
  }
  const { jobId, tree } = msg;
  try {
    resolveJobPhotoSources(tree);
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
