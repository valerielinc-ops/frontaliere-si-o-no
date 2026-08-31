/**
 * Which files in `data/jobs/by-crawler/` are actually crawler slices.
 *
 * The predicate lived in three copies that had drifted apart, and the drift was
 * not cosmetic — it was the bug the fullest copy documents in its own comment:
 *
 *   - `assemble-jobs-dataset.mjs`      excluded `.gitkeep`, `-locale-cache`, `.cleanup-tmp`
 *   - `repair-job-locales.mjs`         excluded only `.gitkeep`
 *   - `backfill-expired-from-history.mjs`  excluded nothing
 *
 * A housekeeping run killed mid-write (OOM) leaves `<key>.json.cleanup-tmp.json`
 * behind, and a crawler's `-locale-cache.json` companion is scratch, not a
 * second employer. The two thinner copies would happily read both as slices —
 * `lidl-svizzera.json.cleanup-tmp.json` is exactly what hard-failed assembly in
 * run 28783188549 before the exclusion was added to the copy that has it.
 *
 * One predicate, so the next copy cannot drift again. Callers keep their own
 * wrappers because they legitimately want different SHAPES (full paths vs bare
 * basenames) and some add their own filters on top — what they must not
 * disagree about is what counts as a slice at all.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} file  a bare filename, not a path
 * @returns {boolean}
 */
export function isSliceFile(file) {
  return (
    file.endsWith('.json') &&
    file !== '.gitkeep' &&
    !file.endsWith('-locale-cache.json') &&
    !file.includes('.cleanup-tmp')
  );
}

/**
 * Slice files in a directory, as full paths, lexicographic (deterministic).
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSliceFilePaths(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isSliceFile).map((f) => path.join(dir, f)).sort();
}

/**
 * Slice files in a directory, as bare filenames, lexicographic.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSliceFileNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isSliceFile).sort();
}
