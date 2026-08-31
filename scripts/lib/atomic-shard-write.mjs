/**
 * Atomic write primitive shared by the three `part-NN.json` shard stores
 * (`compat-paths-store.mjs`, `orphan-enriched-store.mjs`,
 * `all-known-job-slugs-store.mjs` — issue #6696 item 2/2, follow-up to #6682).
 *
 * Before this module each store wrote a shard with a plain
 * `fs.writeFileSync(file, content)`. That is not atomic: a process killed
 * mid-syscall (OOM, CI job timeout, SIGKILL) can leave the shard truncated on
 * disk. Every reader of these three accumulators treats an unparseable shard
 * as "skip it" rather than throwing — by design, so one corrupt shard doesn't
 * take down the whole accumulator — which means a torn write would silently
 * drop that shard's paths/records instead of surfacing an error. Writing to a
 * temp file in the SAME directory and renaming it over the destination closes
 * that gap: a same-filesystem rename is a single atomic syscall (true for the
 * CI runner and local dev), so the destination is always either the old
 * content or the new content, never a partial write.
 *
 * This does NOT need to guard against concurrent writers on the same
 * directory: within a process these stores are called synchronously once per
 * run, and across processes each CI job writes in its own checkout — the
 * actual multi-writer case (two workflows committing to the same shard files)
 * is a git-level 3-way merge, already handled by the registered
 * `merge=compat-shard`/`merge=known-slugs-shard`/`merge=orphan-enriched-shard`
 * drivers (`scripts/ci/merge-*-shard.mjs`) plus the in-place rebase resolvers
 * (`resolve-404-compat-conflict.mjs` and siblings) — not by a lock at write
 * time in a single checkout.
 */
import fs from 'node:fs';

// Monotonic counter so two temp files minted in the same millisecond by the
// same process (same pid) still get distinct names.
let tmpSeq = 0;

/**
 * Write `content` to `file` iff it differs from what's on disk, atomically
 * (temp file in the same directory + rename). Returns `true` if a write
 * happened, `false` if the existing content already matched.
 *
 * @param {string} file absolute path of the shard file
 * @param {string} content new file content (already serialized)
 * @returns {boolean}
 */
export function writeShardFileIfChanged(file, content) {
  let existing;
  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    /* shard doesn't exist yet on disk — must write */
  }
  if (existing === content) return false;
  writeFileAtomic(file, content);
  return true;
}

/**
 * Atomically write `content` to `file` (temp file in the same directory,
 * then rename over the destination). Use for files without a
 * skip-if-unchanged optimization, e.g. the manifest, whose counts change on
 * (almost) every run.
 *
 * @param {string} file absolute destination path
 * @param {string} content file content (already serialized)
 */
export function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
