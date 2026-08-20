#!/usr/bin/env node
/**
 * Upload the event images THIS run mirrored to the CDN, then make
 * `data/events-image-manifest.json` tell the truth about what actually landed.
 *
 * WHY THIS EXISTS (#6163). The mirrored source images used to be committed
 * (5'568 files, 4'108 MB — 59% of the tracked tree) and the deploy pushed them
 * to the CDN from the git-tracked `public/images/<dir>` copy
 * (deploy-it-pages-prep.sh step_push_cdn). They are not committed any more, so
 * a deploy checkout has no source to push from and `events` was dropped from
 * that loop. The push therefore has to happen where the bytes exist — here, in
 * the crawl run that downloaded them, before the runner is torn down.
 *
 * ORDERING IS THE WHOLE POINT, and it only goes one way. `mirrorEventImage`
 * records each new image into the manifest as it writes it (immediately, so a
 * `timeout-minutes` kill doesn't cost the whole catalogue — see its comment).
 * That means the manifest on disk already claims images that have not been
 * uploaded yet. Committing it before the upload would publish an index
 * pointing at CDN keys that 404. So: upload first, and only commit the
 * manifest afterwards (crawl-events.yml runs this step immediately before
 * "Commit dataset").
 *
 * A FAILED UPLOAD PRUNES ITS OWN ENTRY rather than failing the job. Failing
 * would skip the whole day's commit — events.json, the weekend digest article,
 * the sitemap — over one image that transiently 500'd, and the manifest would
 * still be wrong. Dropping just that id keeps the manifest honest (it now says
 * "we don't have this one"), lets everything else commit, and tomorrow's run
 * re-mirrors exactly the ones that failed. Whatever is pruned is listed in the
 * summary, never dropped silently.
 *
 * Uploads go through scripts/lib/upload-cdn-file.sh — the existing single-file
 * additive `rclone copyto` helper (explicit Content-Type table, because Go's
 * mime sniff is unreliable for .webp on GitHub runners; rclone auto-install;
 * one retry). It always exits 0 by design, so success is detected the way its
 * own header prescribes: by finding "✅ uploaded" on its stdout.
 *
 * Env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET
 *   (missing → the helper skips and every image counts as failed, so the
 *   manifest is pruned back and nothing is falsely claimed).
 * Exit: always 0 unless the manifest itself cannot be rewritten.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const IMAGE_DIR = path.join(REPO_ROOT, 'public', 'images', 'events');
const MANIFEST = path.join(REPO_ROOT, 'data', 'events-image-manifest.json');
const UPLOADER = path.join(REPO_ROOT, 'scripts', 'lib', 'upload-cdn-file.sh');
// Same class Cache-Control _r2_sync gives images/ in deploy-it-pages-prep.sh.
const CACHE_CONTROL = 'public, max-age=86400';

function log(msg) {
  console.log(`[events-cdn] ${msg}`);
}

if (!existsSync(IMAGE_DIR)) {
  log('public/images/events absent — no image was mirrored this run, nothing to push');
  process.exit(0);
}

// Only the flat files this run wrote. `catalog/` is build output emitted into
// dist/ by build-plugins/eventsSeoPagesPlugin.ts and pushed by the deploy, not
// mirrored material — skip any directory rather than assume it can't appear.
const files = readdirSync(IMAGE_DIR)
  .filter((name) => !name.startsWith('.'))
  .filter((name) => statSync(path.join(IMAGE_DIR, name)).isFile())
  .sort();

if (files.length === 0) {
  log('no mirrored image on disk — nothing to push');
  process.exit(0);
}

log(`${files.length} image(s) mirrored this run → cdn.frontaliereticino.ch/images/events/`);

const failed = [];
let uploaded = 0;
for (const name of files) {
  const res = spawnSync('bash', [UPLOADER, path.join(IMAGE_DIR, name), `images/events/${name}`, CACHE_CONTROL], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  // The helper exits 0 on every runtime failure path by design; its own header
  // says to grep stdout for this marker instead.
  if (res.status === 0 && out.includes('✅ uploaded')) {
    uploaded += 1;
  } else {
    failed.push(name);
    console.warn(`::warning::[events-cdn] upload failed for ${name}: ${out.trim().split('\n').slice(-1)[0] || 'no output'}`);
  }
}

log(`uploaded ${uploaded}/${files.length}`);

if (failed.length === 0) process.exit(0);

// Prune the failed ids so the committed manifest never claims a key that 404s.
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('not a JSON object');
} catch (err) {
  // Fail LOUD here, unlike everywhere else in this script: the manifest on disk
  // claims images that are not on the CDN and we could not correct it. Silence
  // would hand the commit step a manifest that produces broken images.
  console.error(`::error::[events-cdn] ${failed.length} upload(s) failed and the manifest could not be read to prune them (${err?.message || err})`);
  process.exit(1);
}

let pruned = 0;
for (const name of failed) {
  const id = name.slice(0, name.lastIndexOf('.'));
  if (id && Object.prototype.hasOwnProperty.call(manifest, id)) {
    delete manifest[id];
    pruned += 1;
  }
}

if (pruned > 0) {
  const sorted = {};
  for (const key of Object.keys(manifest).sort()) sorted[key] = manifest[key];
  writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);
}

console.warn(
  `::warning::[events-cdn] ${failed.length} image(s) did not reach the CDN; pruned ${pruned} entr(y/ies) from the manifest so the next run re-mirrors them: ${failed.join(', ')}`,
);
process.exit(0);
