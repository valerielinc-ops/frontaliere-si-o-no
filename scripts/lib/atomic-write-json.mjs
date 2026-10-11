import fs from 'node:fs';
import path from 'node:path';
import { preserveSlugHistory } from './slug-preservation-guard.mjs';
import { assertCrawlerSliceWriteSafe, isCrawlerSlicePath } from './crawler-slice-integrity.mjs';

// Monotonic counter so two concurrent writes to the SAME target from the SAME
// process (same pid) still get distinct temp files — the pid alone would not
// disambiguate them.
let tmpSeq = 0;

// The assembled jobs and expired-job datasets are large enough that
// JSON.stringify(array) can hit V8's maximum string length even though every
// individual entry is safely serializable. Large arrays use the incremental
// path; callers with a smaller but unusually heavy aggregate can opt in too.
const STREAMING_ARRAY_THRESHOLD = 1024;

function writeTextSync(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function stringifyArrayItem(item, compact) {
  // JSON.stringify serializes undefined/function/symbol array entries as
  // null. Preserve that array-specific behavior when writing items alone.
  const json = JSON.stringify(item, null, compact ? 0 : 2);
  return json === undefined ? 'null' : json;
}

function writeLargeArraySync(filePath, value, compact) {
  const fd = fs.openSync(filePath, 'w');
  try {
    writeTextSync(fd, '[');
    if (!compact && value.length > 0) writeTextSync(fd, '\n');
    for (let index = 0; index < value.length; index++) {
      if (index > 0) writeTextSync(fd, compact ? ',' : ',\n');
      const item = stringifyArrayItem(value[index], compact);
      if (compact) {
        writeTextSync(fd, item);
      } else {
        // JSON.stringify(array, null, 2) indents every item line by two
        // spaces relative to the array itself.
        writeTextSync(fd, item.split('\n').map((line) => `  ${line}`).join('\n'));
      }
    }
    if (!compact && value.length > 0) writeTextSync(fd, '\n');
    writeTextSync(fd, ']\n');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Atomically write `value` as pretty-printed JSON to `filePath`.
 *
 * Commits via temp+rename so a SIGKILL/OOM mid-write cannot leave the target
 * (e.g. data/jobs.json — the served/indexed dataset) truncated. `renameSync`
 * is a single POSIX syscall, atomic on the same filesystem (the Linux CI runner
 * and local dev always qualify). The temp file lives next to the target so the
 * rename never crosses a filesystem boundary.
 *
 * Single source of truth for the ~95 crawler/job-data scripts that previously
 * each duplicated a non-atomic `fs.writeFileSync` helper (issue #2805,
 * follow-up to #2803). Keeping it in one module makes the atomic guarantee
 * impossible to drift away from by copy-paste.
 *
 * Job slices additionally pass through the slug-preservation guard (see
 * ./slug-preservation-guard.mjs, issue #5157) before being serialized: a
 * write to `data/jobs/by-crawler/*.json` may never DROP a slug that the
 * on-disk version could still serve, because a dropped slug is a dropped
 * redirect and a 404 on an already-indexed URL. Enforcing it here, at the
 * boundary, is the same argument as the atomicity guarantee above — one
 * module, impossible to drift away from by copy-paste — and it is why the
 * previous convention (remember to call `addPreviousSlugForLocale`) kept
 * failing across ~40 independent call sites.
 *
 * @param {string} filePath destination path
 * @param {unknown} value JSON-serializable value
 * @param {{compact?: boolean, streamArray?: boolean, dedupReferenceJobs?: unknown[] | null, housekeepingProof?: unknown[] | null, expiredGhostProof?: object | null}} [opts]
 *   `compact` emits minified JSON; `dedupReferenceJobs` is proof supplied only
 *   by the cross-crawler dedup maintenance command; `housekeepingProof` is
 *   definitive URL evidence supplied only by the housekeeping command or a
 *   source-verified crawler shrink; `expiredGhostProof` is the in-memory
 *   reconciliation proof supplied only by the assembler when it removes
 *   expired entries that are still represented by active jobs; `streamArray`
 *   opts a top-level array into item-wise serialization even below the size
 *   threshold when its entries are unusually large.
 */
export function writeJsonAtomic(
  filePath,
  value,
  {
    compact = false,
    streamArray: streamArrayOption = false,
    dedupReferenceJobs = null,
    housekeepingProof = null,
    expiredGhostProof = null,
  } = {},
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Mutates `value` in place, re-capturing any slug this write would drop.
  // Never throws: slug preservation must not be able to fail a data write.
  try {
    preserveSlugHistory(filePath, value);
  } catch {
    /* best-effort — a guard bug must never block the crawl */
  }
  // Crawler slices are guarded against catastrophic shrink using the full
  // candidate bytes, so keep their existing path. The assembled arrays are not
  // crawler slices and can be written incrementally without first
  // materializing a second copy of the whole dataset as one JS string. A
  // custom array-level toJSON remains on the legacy path because it changes
  // the value that JSON.stringify would serialize.
  const streamArray = Array.isArray(value)
    && (streamArrayOption || value.length >= STREAMING_ARRAY_THRESHOLD)
    && !isCrawlerSlicePath(filePath)
    && typeof value.toJSON !== 'function';
  let content = null;
  if (!streamArray) {
    const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    content = `${json}\n`;
    if (isCrawlerSlicePath(filePath) && fs.existsSync(filePath)) {
      assertCrawlerSliceWriteSafe(filePath, fs.readFileSync(filePath, 'utf8'), content, {
        dedupReferenceJobs,
        housekeepingProof,
        expiredGhostProof,
      });
    }
  }
  const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    if (streamArray) writeLargeArraySync(tmp, value, compact);
    else fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
