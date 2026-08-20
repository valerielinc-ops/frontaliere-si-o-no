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
 * PRUNING THE MANIFEST IS NOT ENOUGH — the dataset has to be pruned with it.
 * `assemble-events-dataset.mjs` has already run by the time we get here
 * (crawl-events.yml orders it assemble → gate → push → commit), so the event
 * whose image failed to upload is ALREADY sitting in the slices and in
 * events.json with `imageUrl: "/images/events/<id>.<ext>"`. Cleaning only the
 * manifest would commit that reference pointing at a CDN key that 404s, and
 * nothing would ever repair it: the images are no longer in git, so the
 * deploy's idempotent re-push from `public/images/<dir>` does not exist any
 * more, and tomorrow's crawl re-mirrors the image but does not rewrite an
 * event it already emitted. So the same ids are stripped of their `imageUrl`
 * in the slices (the source of truth the next assemble reads) and in both
 * assembled copies. The event still publishes — it just publishes without a
 * picture instead of with a broken one.
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
 *
 * `pruneFailedImageRefs` is exported and takes every path as an argument so a
 * test can drive it over a temp tree; the upload flow below runs only when the
 * file is executed directly.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const IMAGE_DIR = path.join(REPO_ROOT, 'public', 'images', 'events');
const MANIFEST = path.join(REPO_ROOT, 'data', 'events-image-manifest.json');
const SLICE_DIR = path.join(REPO_ROOT, 'data', 'events', 'by-source');
// Both assembled copies assemble-events-dataset.mjs writes, in its own order.
const DATASETS = [
  path.join(REPO_ROOT, 'data', 'events.json'),
  path.join(REPO_ROOT, 'public', 'data', 'events.json'),
];
const UPLOADER = path.join(REPO_ROOT, 'scripts', 'lib', 'upload-cdn-file.sh');
// Same class Cache-Control _r2_sync gives images/ in deploy-it-pages-prep.sh.
const CACHE_CONTROL = 'public, max-age=86400';

function log(msg) {
  console.log(`[events-cdn] ${msg}`);
}

/**
 * Strip `imageUrl` from every event that points at one of `failedNames`, in
 * each of `files` (slices and assembled datasets alike — both are `{ events:
 * [] }`). Matching is on the URL string, not on a re-derivation of the id
 * from the filename: `mirrorEventImage` builds both from the same `safeId`,
 * so comparing the finished URL cannot drift from how the id was sanitised.
 *
 * A missing or malformed file is skipped, not an error: the assembled copy
 * under public/ may legitimately not exist yet, and refusing to prune the
 * others because one is unreadable would leave MORE broken references, not
 * fewer. Serialization mirrors the writers exactly
 * (`JSON.stringify(x, null, 2)` + trailing newline) so a prune that changes
 * nothing produces no diff.
 *
 * Returns the number of events cleaned, per file.
 */
export function pruneFailedImageRefs(failedNames, files) {
  const broken = new Set(failedNames.map((name) => `/images/events/${name}`));
  const cleaned = [];
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // absent or malformed → nothing to prune here
    }
    if (!doc || !Array.isArray(doc.events)) continue;
    let n = 0;
    for (const ev of doc.events) {
      if (ev && typeof ev.imageUrl === 'string' && broken.has(ev.imageUrl)) {
        delete ev.imageUrl;
        n += 1;
      }
    }
    if (n > 0) {
      try {
        writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
        cleaned.push({ file, count: n });
      } catch (err) {
        console.warn(`::warning::[events-cdn] could not rewrite ${file}: ${err?.message || err}`);
      }
    }
  }
  return cleaned;
}

/** Slices + both assembled datasets — everything that can carry an `imageUrl`. */
function datasetFilesToPrune() {
  let slices = [];
  try {
    slices = readdirSync(SLICE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(SLICE_DIR, name));
  } catch {
    slices = []; // no slice dir in this checkout → only the assembled copies
  }
  return [...slices, ...DATASETS];
}

// Executed directly? The upload flow runs. Imported (tests)? Only the exports.
const RUN_DIRECTLY =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

function main() {
  if (!existsSync(IMAGE_DIR)) {
    log('public/images/events absent — no image was mirrored this run, nothing to push');
    return;
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
    return;
  }

  log(`${files.length} image(s) mirrored this run → cdn.frontaliereticino.ch/images/events/`);

  // upload-cdn-file.sh publishes to R2 unconditionally — it has no CDN_TARGET
  // switch (read its header: it is the single-key `rclone copyto` sibling of
  // _publish_cdn_r2, not of the legacy Pages force-push). The deploy DOES
  // honour CDN_TARGET, and the repo variable is `r2` while the code default is
  // `pages`, so the two agree today and this asymmetry is invisible. It stops
  // being invisible the moment someone flips the variable back: these images
  // would keep landing in the R2 bucket while the live domain served from the
  // Pages repo, and every event photo would 404 with a green run everywhere.
  // Same warning as deploy-it-pages-prep.sh's step_push_cdn comment, from the
  // other side of the split. Say it out loud rather than silently mis-publish.
  const cdnTarget = process.env.CDN_TARGET || '';
  if (cdnTarget && cdnTarget !== 'r2' && cdnTarget !== 'both') {
    console.warn(
      `::warning::[events-cdn] CDN_TARGET=${cdnTarget} but this uploader is R2-only: the images go to R2 ` +
        'while the deploy publishes to Pages. Give the Pages path its own source for /images/events before flipping.',
    );
  }

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

  if (failed.length === 0) return;

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
    process.exitCode = 1;
    return;
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

  // …and the same ids out of the dataset, or the day's commit publishes events
  // whose `imageUrl` points at a CDN key that 404s (see the header).
  const cleaned = pruneFailedImageRefs(failed, datasetFilesToPrune());
  const cleanedTotal = cleaned.reduce((sum, c) => sum + c.count, 0);
  for (const c of cleaned) {
    log(`stripped imageUrl from ${c.count} event(s) in ${path.relative(REPO_ROOT, c.file)}`);
  }

  console.warn(
    `::warning::[events-cdn] ${failed.length} image(s) did not reach the CDN; pruned ${pruned} manifest entr(y/ies) ` +
      `and stripped ${cleanedTotal} imageUrl reference(s) from the dataset so the next run re-mirrors them: ${failed.join(', ')}`,
  );
}

if (RUN_DIRECTLY) main();
