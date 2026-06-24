import fs from 'node:fs';
import path from 'node:path';

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
 * @param {string} filePath destination path
 * @param {unknown} value JSON-serializable value
 * @param {{compact?: boolean}} [opts] `compact` emits minified JSON (no indent)
 */
export function writeJsonAtomic(filePath, value, { compact = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  const content = `${json}\n`;
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
