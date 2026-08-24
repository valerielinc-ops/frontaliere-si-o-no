/**
 * Publishes rendered carousel-slide JPEG buffers to the R2 CDN so Instagram/
 * TikTok's server-side fetchers (both APIs are pull-based: you hand them a
 * public `image_url`, they download it) have something to fetch.
 *
 * Reuses scripts/lib/upload-cdn-file.sh — the existing single-file additive
 * uploader (see push-mirrored-event-images-cdn.mjs for the same pattern) —
 * rather than a fresh S3 client, so R2 credential handling and Content-Type
 * detection live in exactly one place.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const UPLOADER = path.join(ROOT, 'scripts', 'lib', 'upload-cdn-file.sh');
const CDN_BASE = 'https://cdn.frontaliereticino.ch';
// Slides are per-post content, not evergreen — a short cache is enough and
// keeps a same-day re-render (e.g. a retried run) from serving a stale card.
const CACHE_CONTROL = 'public, max-age=3600';

/**
 * Upload each buffer under `images/social/<channel>/<keyPrefix>-<n>.jpg` and
 * return the public CDN URL for every slide that made it, in slide order.
 * A failed upload yields `null` at that index rather than throwing — the
 * caller decides whether a partial carousel (or none at all) is postable.
 *
 * @param {Buffer[]} buffers JPEG buffers, cover first
 * @param {{ channel: string, keyPrefix: string }} opts
 * @returns {Array<string|null>}
 */
export function uploadCarouselSlides(buffers, { channel, keyPrefix }) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'social-carousel-'));
  try {
    return buffers.map((buf, i) => {
      const fileName = `${keyPrefix}-${i}.jpg`;
      const localPath = path.join(tmpDir, fileName);
      writeFileSync(localPath, buf);
      const cdnKey = `images/social/${channel}/${fileName}`;
      const res = spawnSync('bash', [UPLOADER, localPath, cdnKey, CACHE_CONTROL], {
        cwd: ROOT,
        encoding: 'utf8',
        env: process.env,
      });
      const out = `${res.stdout || ''}${res.stderr || ''}`;
      // upload-cdn-file.sh always exits 0 by design; success is detected by
      // its own documented stdout marker, same as push-mirrored-event-images-cdn.mjs.
      if (res.status === 0 && out.includes('✅ uploaded')) {
        return `${CDN_BASE}/${cdnKey}`;
      }
      console.warn(`⚠️  slide upload failed for ${fileName}: ${out.trim().split('\n').slice(-1)[0] || 'no output'}`);
      return null;
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
