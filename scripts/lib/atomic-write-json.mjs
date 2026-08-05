import fs from 'node:fs';
import path from 'node:path';
import { preserveSlugHistory } from './slug-preservation-guard.mjs';

// Monotonic counter so two concurrent writes to the SAME target from the SAME
// process (same pid) still get distinct temp files — the pid alone would not
// disambiguate them.
let tmpSeq = 0;

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
 * @param {{compact?: boolean}} [opts] `compact` emits minified JSON (no indent)
 */
export function writeJsonAtomic(filePath, value, { compact = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Mutates `value` in place, re-capturing any slug this write would drop.
  // Never throws: slug preservation must not be able to fail a data write.
  try {
    preserveSlugHistory(filePath, value);
  } catch {
    /* best-effort — a guard bug must never block the crawl */
  }
  const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  const content = `${json}\n`;
  const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
