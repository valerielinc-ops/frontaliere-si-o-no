/**
 * Enumerate every `.html` file under a dist tree, skipping the top-of-tree
 * static-asset directories.
 *
 * Extracted from postWalkCoordinatorPlugin (issue #5130) so the enumeration can
 * be unit-tested against its reference implementation without importing the
 * coordinator's whole plugin graph (data/, services/, packages/articles/…).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Walk every `.html` file under `dir`, skipping static-asset directories.
 *
 * Reverted from the async BFS variant (PR #802) back to a sync recursive walk.
 * Run 26608004451 [post-walk-profile]:
 *   walk-dist  PR #802 → 85.7 s   (vs 65.3 s sync baseline, +31%)
 * The 8-way `fs.promises.readdir` BFS contended with the post-walk worker pool
 * (each worker also issues `fs.promises.readFile` through libuv's default
 * 4-thread pool) and ended up paying Promise scheduling overhead + thread-pool
 * serialization that the C-runtime sync recursion avoided. Re-investigate when
 * the worker pool moves to io_uring native ops or `UV_THREADPOOL_SIZE` is
 * bumped repo-wide.
 *
 * Perf (2026-08-05, issue #5130): this used to be a `function*` generator
 * consumed with `yield*` delegation, and built each path with `path.join`. On
 * the `it` shard of run 31036546298 the tree is 1,308,502 HTML files and
 * `walk-dist` measured **202.3 s** of the coordinator's 344.6 s wall — a single
 * thread, before any worker is dispatched. Two costs, both pure overhead:
 *  - `yield*` re-enters every generator frame on the delegation chain for EVERY
 *    file, so a file at depth d costs d generator resumes;
 *  - `path.join` runs full path normalization per dirent (a dirent name can
 *    never contain a separator or a `..` segment, so joining with `path.sep` is
 *    byte-identical here).
 * Same traversal order (DFS, readdir order), same predicate, same skip list —
 * the returned array is element-for-element what the generator yielded.
 * Pinned by tests/build-perf-output-invariance-5130.test.ts against the
 * original generator.
 *
 * NOTE the skip list applies at EVERY depth, matching the pre-#5130 behaviour
 * (unlike blogImageCdnFinalizePlugin's `dir === root` gate). Do not "fix" that
 * here without a measurement: a nested `data/` slug carrying HTML would then
 * start being read on every build.
 */
export function collectHtml(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      collectHtml(dir + path.sep + entry.name, out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(dir + path.sep + entry.name);
    }
  }
  return out;
}
